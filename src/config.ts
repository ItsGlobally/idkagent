import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

// ─── Type Definitions ────────────────────────────────────────

export interface DiscordConfig {
  token: string;
  allowedChannels: string[];
}

export interface QueueConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  concurrency: number;
}

export interface LoggingConfig {
  showThinking: boolean;
  showToolCalls: boolean;
  showToolResults: boolean;
  truncateAt: number;
}

export interface ContextConfig {
  maxHistoryTokens: number;
}

export interface LspToolConfig {
  bin?: string;
  enabled?: boolean;
}

export interface LspConfig {
  typescript?: LspToolConfig;
  java?: LspToolConfig;
}

export interface SearchConfig {
  enabled: boolean;
  provider: string; // must reference a gemini-type provider
  model: string;
}

export interface ProviderConfig {
  type: 'openai-compatible' | 'gemini';
  apiKey: string;
  baseURL?: string;
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
}

export interface GuardrailConfig {
  enabled: boolean;
  provider: string;
  model: string;
  safeWord?: string;
  modelIsGuard?: boolean;
}

export interface AgentConfig {
  providers: Record<string, ProviderConfig>;
  models: {
    main: ModelConfig;
    fallback: ModelConfig;
  };
  guardrail: GuardrailConfig;
  context: ContextConfig;
  /** Legacy single-gateway mode (deprecated — use gateway map instead) */
  gateway?: 'cli' | 'discord';
  /** Gateway platform map: platform name → enabled */
  gateways: Record<string, boolean>;
  discord: DiscordConfig;
  queue: QueueConfig;
  logging: LoggingConfig;
  lsp: LspConfig;
  search: SearchConfig;
  /** When true, all tool calls are disabled — agent becomes a pure chat bot */
  disableTool: boolean;
}

// ─── Defaults ────────────────────────────────────────────────

// ─── Built-in Provider Definitions ────────────────────────────
// These are always available in code; users only provide API keys.

export const BUILT_IN_PROVIDERS: Record<string, ProviderConfig> = {
  gemini: { type: 'gemini', apiKey: '' },
  openrouter: { type: 'openai-compatible', apiKey: '', baseURL: 'https://openrouter.ai/api/v1' },
  'opencode-zen': { type: 'openai-compatible', apiKey: '', baseURL: 'https://opencode.ai/zen/v1' },
};

export function isBuiltInProvider(name: string): boolean {
  return name in BUILT_IN_PROVIDERS;
}

const DEFAULT_CONFIG: AgentConfig = {
  providers: { ...BUILT_IN_PROVIDERS },
  models: {
    main: {
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      temperature: 1,
    },
    fallback: {
      provider: 'openrouter',
      model: 'openrouter/owl-alpha',
      temperature: 1,
    },
  },
  guardrail: {
    enabled: true,
    provider: 'openrouter',
    model: 'openai/gpt-oss-20b',
    safeWord: 'SAFE',
    modelIsGuard: false,
  },
  context: {
    maxHistoryTokens: 8000,
  },
  gateway: undefined,
  gateways: {
    cli: true,
    discord: false,
  },
  discord: {
    token: '',
    allowedChannels: [],
  },
  queue: {
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    concurrency: 1,
  },
  logging: {
    showThinking: true,
    showToolCalls: true,
    showToolResults: true,
    truncateAt: 500,
  },
  lsp: {
    typescript: {
      bin: 'tsc',
      enabled: true,
    },
    java: {
      bin: 'jdtls',
      enabled: true,
    },
  },
  search: {
    enabled: false,
    provider: 'gemini',
    model: 'gemini-2.5-flash-lite',
  },
  disableTool: false,
};

// ─── Config File Path ────────────────────────────────────────

/** Returns the data root directory (parent of the repo root) */
export function getDataDir(): string {
  return path.resolve(process.cwd(), '..');
}

function getConfigPath(): string {
  return path.resolve(getDataDir(), 'config.yml');
}

// ─── Deep Merge Helper ───────────────────────────────────────

function isObject(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === 'object' && !Array.isArray(item);
}

function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          (output as any)[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

// ─── Load & Save ─────────────────────────────────────────────

// ─── Convert internal providers → file format ───────────────

export function providersToFile(providers: Record<string, ProviderConfig>): Record<string, any> {
  const result: Record<string, any> = {};
  const custom: Record<string, any> = {};

  for (const [name, prov] of Object.entries(providers)) {
    if (isBuiltInProvider(name)) {
      // Built-in: only save non-empty apiKey (type/url come from code)
      if (prov.apiKey) {
        result[name] = { apiKey: prov.apiKey };
      }
    } else {
      // Custom: save full entry under custom
      custom[name] = { url: prov.baseURL || '', apiKey: prov.apiKey || '' };
    }
  }

  if (Object.keys(custom).length > 0) {
    result.custom = custom;
  }

  return result;
}

// ─── Load & Save ─────────────────────────────────────────────

export function loadConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  const configPath = getConfigPath();

  // Start with built-in provider templates
  const config: AgentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.providers = {} as Record<string, ProviderConfig>;
  for (const [name, tpl] of Object.entries(BUILT_IN_PROVIDERS)) {
    config.providers[name] = { ...tpl };
  }

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const fileConfig = yaml.parse(raw) as Record<string, unknown>;

      // Handle providers: apply file values on top of built-in templates
      const fileProviders = (fileConfig.providers as Record<string, any>) || {};
      for (const name of Object.keys(BUILT_IN_PROVIDERS)) {
        if (fileProviders[name]?.apiKey) {
          config.providers[name].apiKey = fileProviders[name].apiKey;
        }
      }
      // Add custom providers
      if (fileProviders.custom) {
        for (const [name, conf] of Object.entries(fileProviders.custom as Record<string, any>)) {
          config.providers[name] = {
            type: 'openai-compatible',
            apiKey: conf.apiKey || '',
            baseURL: conf.url || '',
          };
        }
      }

      // Deep-merge non-provider fields on top
      const { providers: _, ...rest } = fileConfig;
      const merged = deepMerge(config as unknown as Record<string, unknown>, rest as unknown as Record<string, unknown>) as unknown as AgentConfig;
      Object.assign(config, merged);
    } catch {
      console.warn(`⚠️  Failed to parse config.yml, using defaults.`);
    }
  }

  if (process.env.DISCORD_TOKEN && !config.discord.token) {
    config.discord.token = process.env.DISCORD_TOKEN;
  }

  // Backward compat: migrate old single-string `gateway`
  if ((config as any).gateway) {
    if ((config as any).gateway === 'cli') config.gateways = { cli: true, discord: false };
    else if ((config as any).gateway === 'discord') config.gateways = { cli: false, discord: true };
  }
  delete (config as any).gateway;

  if (overrides) {
    return deepMerge(config as unknown as Record<string, unknown>, overrides as unknown as Record<string, unknown>) as unknown as AgentConfig;
  }
  return config;
}

export function saveDefaultConfig(): string {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) return configPath;
  const toSave = {
    ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    providers: providersToFile(DEFAULT_CONFIG.providers),
  };
  fs.writeFileSync(configPath, yaml.stringify(toSave), 'utf-8');
  return configPath;
}

export function updateConfig(): string {
  const configPath = getConfigPath();
  const mergedConfig = loadConfig();
  const toSave = {
    ...JSON.parse(JSON.stringify(mergedConfig)),
    providers: providersToFile(mergedConfig.providers),
  };
  fs.writeFileSync(configPath, yaml.stringify(toSave), 'utf-8');
  return configPath;
}

export function showConfig(config: AgentConfig): void {
  const display = JSON.parse(JSON.stringify(config)); // deep copy

  // Mask API keys
  for (const prov of Object.keys(display.providers)) {
    if (display.providers[prov].apiKey) {
      display.providers[prov].apiKey = display.providers[prov].apiKey.slice(0, 8) + '...';
    } else {
      display.providers[prov].apiKey = '(not set)';
    }
  }
  if (display.discord.token) {
    display.discord.token = display.discord.token.slice(0, 8) + '...';
  } else {
    display.discord.token = '(not set)';
  }

  // Remove legacy fields and show only enabled gateways cleanly
  delete display.gateway;
  const enabledGateways = Object.entries(display.gateways || {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  display._enabled_gateways = enabledGateways;

  console.log(yaml.stringify(display));
}

/** Return list of enabled gateway platform names */
export function getEnabledPlatforms(config: AgentConfig): string[] {
  return Object.entries(config.gateways || {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}