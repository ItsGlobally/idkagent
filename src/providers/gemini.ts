import { GoogleGenAI, Type } from '@google/genai';
import type {
  LLMProvider,
  LLMProviderOptions,
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
} from './types.js';

// ─── Retry Config ────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;

// ─── Global Rate Limiter ─────────────────────────────────────

const MIN_REQUEST_INTERVAL_MS = 2000; // max ~30 req/min across all instances
let lastRequestTime = 0;

function jitter(ms: number): number {
  return ms + Math.random() * ms * 0.5;
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    const wait = jitter(MIN_REQUEST_INTERVAL_MS - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}

// ─── JSON Schema Type → Gemini Type ─────────────────────────

function toGeminiType(jsonType: string): Type {
  switch (jsonType) {
    case 'string':
      return Type.STRING;
    case 'number':
    case 'integer':
      return Type.NUMBER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'object':
      return Type.OBJECT;
    case 'array':
      return Type.ARRAY;
    default:
      return Type.STRING;
  }
}

// ─── Convert JSON Schema properties to Gemini format ─────────

function convertProperties(properties: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(properties)) {
    const prop: Record<string, any> = {
      type: toGeminiType(value.type || 'string'),
      description: value.description || '',
    };
    if (value.enum) {
      prop.enum = value.enum;
    }
    if (value.type === 'object' && value.properties) {
      prop.properties = convertProperties(value.properties);
      if (value.required) {
        prop.required = value.required;
      }
    }
    if (value.type === 'array' && value.items) {
      prop.items = {
        type: toGeminiType(value.items.type || 'string'),
        ...(value.items.description ? { description: value.items.description } : {}),
        ...(value.items.enum ? { enum: value.items.enum } : {}),
        ...(value.items.properties ? { properties: convertProperties(value.items.properties) } : {}),
      };
    }
    result[key] = prop;
  }
  return result;
}

// ─── Message Conversion ─────────────────────────────────────

interface GeminiContent {
  role: 'user' | 'model';
  parts: Record<string, any>[];
}

function toGeminiMessages(messages: Message[]): {
  systemInstruction: string | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        systemInstruction = msg.content ?? '';
        break;

      case 'user':
        contents.push({
          role: 'user',
          parts: [{ text: msg.content ?? '' }],
        });
        break;

      case 'assistant': {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          contents.push({
            role: 'model',
            parts: msg.toolCalls.map((tc) => {
              const part: any = {
                functionCall: {
                  name: tc.name,
                  args: tc.arguments,
                },
              };
              if (tc.thoughtSignature) {
                part.thoughtSignature = tc.thoughtSignature;
              }
              return part;
            }),
          });
        } else {
          contents.push({
            role: 'model',
            parts: [{ text: msg.content ?? '' }],
          });
        }
        break;
      }

      case 'tool': {
        // Tool results go as user messages with functionResponse parts
        // We need to find the tool name from the toolCallId — look back through messages
        const toolName = findToolName(messages, msg.toolCallId);
        let parsedResult: unknown;
        try {
          parsedResult = JSON.parse(msg.content ?? '""');
        } catch {
          parsedResult = msg.content ?? '';
        }
        
        // Gemini expects all tool responses for a single assistant turn to be grouped
        // together in ONE single "user" message containing multiple functionResponse parts.
        // We check if the last added content was already a tool response container.
        const lastContent = contents.length > 0 ? contents[contents.length - 1] : null;
        const newPart = {
          functionResponse: {
            name: toolName,
            response: { result: parsedResult },
          },
        };

        if (lastContent && lastContent.role === 'user' && lastContent.parts.length > 0 && ('functionResponse' in lastContent.parts[0])) {
          // Append to existing tool response group
          lastContent.parts.push(newPart);
        } else {
          // Create new tool response group
          contents.push({
            role: 'user',
            parts: [newPart],
          });
        }
        break;
      }
    }
  }

  return { systemInstruction, contents };
}

function findToolName(messages: Message[], toolCallId?: string): string {
  if (!toolCallId) return 'unknown';
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id === toolCallId) return tc.name;
      }
    }
  }
  return 'unknown';
}

// ─── Tool Conversion ─────────────────────────────────────────

function toGeminiFunctionDeclarations(tools: ToolDefinition[]): any[] {
  return tools.map((tool) => {
    const params = tool.parameters as Record<string, any>;
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: params.properties ? convertProperties(params.properties) : {},
        required: params.required || [],
      },
    };
  });
}

// ─── Provider ────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly maxContextWindow: number;
  private ai: GoogleGenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(options: LLMProviderOptions) {
    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.temperature = options.temperature;
    this.maxContextWindow = GeminiProvider.detectContextWindow(options.model);
  }

  private static detectContextWindow(model: string): number {
    const name = model.toLowerCase();
    if (name.includes('pro')) return 2_000_000;
    if (name.includes('flash')) return 1_000_000;
    return 1_000_000;
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    const { systemInstruction, contents } = toGeminiMessages(messages);

    const config: Record<string, any> = {
      maxOutputTokens: this.maxTokens,
      temperature: this.temperature,
      thinkingConfig: {
        thinkingBudget: 8192,
      },
    };

    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }

    if (tools.length > 0) {
      config.tools = [
        {
          functionDeclarations: toGeminiFunctionDeclarations(tools),
        },
      ];
    }

    let lastError: unknown;

    await throttle();

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {

        const response = await this.ai.models.generateContent({
          model: this.model,
          contents,
          config,
        });

        const result: LLMResponse = {};
        const candidate = response.candidates?.[0];
        if (!candidate?.content?.parts) {
          // Possibly an empty response
          return result;
        }

        // Extract usage metadata
        const usageMeta = response.usageMetadata as Record<string, any> | undefined;
        if (usageMeta) {
          result.usage = {
            promptTokens: usageMeta.promptTokenCount ?? 0,
            completionTokens: usageMeta.candidatesTokenCount ?? 0,
          };
        }

        const toolCalls: ToolCall[] = [];

        for (const part of candidate.content.parts) {
          const anyPart = part as Record<string, any>;

          if (anyPart.thought === true && anyPart.text) {
            // Thinking part
            result.thinking = (result.thinking || '') + anyPart.text;
          } else if (anyPart.functionCall) {
            // Function call part
            toolCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              name: anyPart.functionCall.name,
              arguments: anyPart.functionCall.args || {},
              thoughtSignature: anyPart.functionCall?.thoughtSignature || anyPart.thoughtSignature,
            });
          } else if (anyPart.text) {
            // Text content part
            result.content = (result.content || '') + anyPart.text;
          }
        }

        if (toolCalls.length > 0) {
          result.toolCalls = toolCalls;
        }

        return result;
      } catch (error: unknown) {
        lastError = error;

        // Check for 429 rate limit or 5xx server errors
        const status = (error as { status?: number }).status;
        if ((status === 429 || (status && status >= 500)) && attempt <= MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
          const delayWithJitter = Math.round(jitter(delay));
          console.log(`⏳ API Error ${status}, retrying in ${delayWithJitter}ms... (attempt ${attempt}/${MAX_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, delayWithJitter));
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }
}
