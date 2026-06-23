// ─── Unified Message Types ───────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface LLMResponse {
  thinking?: string;
  content?: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

// ─── Provider Interface ─────────────────────────────────────

export interface LLMProviderOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens: number;
  temperature: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly maxContextWindow: number;
  chat(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
}
