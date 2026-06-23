import type { AgentConfig } from '../config.js';
import type { LLMProvider, LLMProviderOptions } from './types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { GeminiProvider } from './gemini.js';

export type { LLMProvider, LLMResponse, Message, ToolCall, ToolDefinition } from './types.js';

export function createProvider(
  config: AgentConfig,
  providerName: string,
  modelConfig: { model: string; temperature?: number }
): LLMProvider {
  const provConfig = config.providers[providerName];
  if (!provConfig) {
    throw new Error(`Provider "${providerName}" not found in config.`);
  }

  const options: LLMProviderOptions = {
    apiKey: provConfig.apiKey,
    model: modelConfig.model,
    baseURL: provConfig.baseURL,
    maxTokens: 8192,
    temperature: modelConfig.temperature ?? 1,
  };

  switch (provConfig.type) {
    case 'openai-compatible':
      return new OpenAICompatibleProvider(options);

    case 'gemini':
      return new GeminiProvider(options);

    default:
      throw new Error(`Unknown provider type: "${(provConfig as any).type}".`);
  }
}
