import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type {
  LLMProvider,
  LLMProviderOptions,
  LLMResponse,
  Message,
  ProviderEventCallback,
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

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    const wait = jitter(MIN_REQUEST_INTERVAL_MS - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}

function jitter(ms: number): number {
  return ms + Math.random() * ms * 0.5;
}

// ─── Message Conversion ─────────────────────────────────────

function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((msg): ChatCompletionMessageParam => {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: msg.content ?? '' };

      case 'user':
        return { role: 'user', content: msg.content ?? '' };

      case 'assistant': {
        const asstMsg: Record<string, unknown> = {
          role: 'assistant',
          content: msg.content ?? (msg.toolCalls && msg.toolCalls.length > 0 ? null : ''),
        };
        // DeepSeek/some providers require reasoning_content to be passed back
        if (msg.thinking) {
          asstMsg.reasoning_content = msg.thinking;
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          asstMsg.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        return asstMsg as any;
      }

      case 'tool':
        return {
          role: 'tool',
          content: msg.content ?? '',
          tool_call_id: msg.toolCallId ?? '',
        };

      default:
        return { role: 'user', content: msg.content ?? '' };
    }
  });
}

// ─── Tool Conversion ─────────────────────────────────────────

function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ─── Provider ────────────────────────────────────────────────

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible';
  readonly maxContextWindow: number;
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(options: LLMProviderOptions) {
    let baseURL = options.baseURL;
    if (baseURL) {
      // Strip trailing /chat/completions path if present, using URL parser for robustness
      try {
        const url = new URL(baseURL);
        if (url.pathname === '/chat/completions' || url.pathname === '/chat/completions/') {
          url.pathname = '';
          baseURL = url.toString().replace(/\/+$/, '');
        }
      } catch {
        // If URL parsing fails, use the legacy string-based approach
        if (baseURL.endsWith('/chat/completions')) {
          baseURL = baseURL.slice(0, -'/chat/completions'.length);
        } else if (baseURL.endsWith('/chat/completions/')) {
          baseURL = baseURL.slice(0, -'/chat/completions/'.length);
        }
      }
    }

    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: baseURL,
    });
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.temperature = options.temperature;
    this.maxContextWindow = OpenAICompatibleProvider.detectContextWindow(options.model);
  }

  private static detectContextWindow(model: string): number {
    const name = model.toLowerCase();
    if (name.includes('claude')) return 200_000;
    if (name.includes('gemini')) return 1_000_000;
    if (name.includes('gpt-4')) return 128_000;
    if (name.includes('gpt-3')) return 16_000;
    if (name.includes('deepseek')) return 128_000;
    if (name.includes('command')) return 128_000;
    return 128_000;
  }

  async chat(messages: Message[], tools: ToolDefinition[], onEvent?: ProviderEventCallback, signal?: AbortSignal): Promise<LLMResponse> {
    const openaiMessages = toOpenAIMessages(messages);
    const openaiTools = tools.length > 0 ? toOpenAITools(tools) : undefined;

    let lastError: unknown;

    await rateLimit();

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: openaiMessages,
          tools: openaiTools,
          max_completion_tokens: this.maxTokens,
          temperature: this.temperature,
        }, { signal });

        const choice = response?.choices?.[0];
        if (!choice) {
          throw new Error('No response choice returned from OpenAI-compatible API. Full response: ' + JSON.stringify(response));
        }

        const msg = choice.message;
        const result: LLMResponse = {};

        // Extract usage info
        const usage = response.usage as Record<string, any> | undefined;
        if (usage) {
          result.usage = {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
          };
        }

        // Extract reasoning / thinking content (deepseek, etc.)
        const anyMsg = msg as unknown as Record<string, unknown>;
        if (typeof anyMsg.reasoning_content === 'string' && anyMsg.reasoning_content) {
          result.thinking = anyMsg.reasoning_content;
        } else if (typeof anyMsg.reasoning === 'string' && anyMsg.reasoning) {
          result.thinking = anyMsg.reasoning;
        }

        // Extract text content
        if (msg.content) {
          result.content = msg.content;
        }

        // Extract tool calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          result.toolCalls = msg.tool_calls
            .filter((tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function')
            .map((tc): ToolCall => {
              let parsedArgs: Record<string, unknown> = {};
              try {
                parsedArgs = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
              } catch {
                parsedArgs = {};
              }
              return {
                id: tc.id,
                name: tc.function.name,
                arguments: parsedArgs,
              };
            });
        }

        return result;
      } catch (error: unknown) {
        lastError = error;

        // Check for 429 rate limit or 5xx server errors
        const status = (error as { status?: number }).status;
        if ((status === 429 || (status && status >= 500)) && attempt <= MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
          const delayWithJitter = Math.round(jitter(delay));
          const retryMsg = `⏳ API Error ${status}, retrying in ${delayWithJitter}ms... (attempt ${attempt}/${MAX_RETRIES})`;
          console.log(retryMsg);
          onEvent?.({ type: 'provider_log', content: retryMsg });
          await new Promise((resolve) => setTimeout(resolve, delayWithJitter));
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }
}
