#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import yaml from 'yaml';
import { loadConfig, saveDefaultConfig, updateConfig, showConfig, providersToFile, getDataDir, type AgentConfig } from './config.js';
import { createProvider } from './providers/index.js';
import { getAllTools } from './tools/index.js';
import { createGateways, CLIGateway } from './gateways/index.js';
import { Agent } from './agent.js';
import { MessageQueue } from './queue.js';
import { initJdtlsIfNeeded } from './tools/jdtls_client.js';

// ─── ANSI helpers ────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

// ─── CLI Argument Parsing ────────────────────────────────────

function parseArgs(argv: string[]): { command: string; subcommand?: string; flags: Record<string, string> } {
  const args = argv.slice(2); // skip node + script
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] || 'help',
    subcommand: positional[1],
    flags,
  };
}

// ─── Commands ────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${CYAN}${BOLD}idkagent${RESET} — AI Agent with Reasoning & Tool Use

${BOLD}Usage:${RESET}
  idkagent ${GREEN}setup${RESET}                   Full guided configuration wizard
  idkagent ${GREEN}model${RESET}                   List models for a provider
  idkagent ${GREEN}chat${RESET}                    Start interactive CLI chat
  idkagent ${GREEN}gateway${RESET}                 Configure gateway (e.g. Discord)
  idkagent ${GREEN}gateway start${RESET}            Start all enabled gateways
  idkagent ${GREEN}gateway install${RESET}          Install gateway as a systemd user service
  idkagent ${GREEN}gateway stop${RESET}             Stop the gateway service
  idkagent ${GREEN}gateway restart${RESET}          Restart the gateway service
  idkagent ${GREEN}gateway status${RESET}           Show gateway service status
  idkagent ${GREEN}gateway enable${RESET}           Enable gateway to auto-start on login
  idkagent ${GREEN}gateway disable${RESET}          Disable gateway auto-start
  idkagent ${GREEN}gateway uninstall${RESET}        Uninstall gateway service
  idkagent ${GREEN}lsp list${RESET}                 List LSP servers and their status
  idkagent ${GREEN}lsp enable${RESET} <name>        Enable an LSP server
  idkagent ${GREEN}lsp disable${RESET} <name>       Disable an LSP server
  idkagent ${GREEN}lsp install${RESET} <name>       Install an LSP server
  idkagent ${GREEN}lsp uninstall${RESET} <name>     Uninstall an LSP server
  idkagent ${GREEN}config init${RESET}              Create default config.yml
  idkagent ${GREEN}config update${RESET}            Update config.yml with missing defaults
  idkagent ${GREEN}config show${RESET}              Show current configuration
  idkagent ${GREEN}help${RESET}                     Show this help message

${BOLD}Flags:${RESET}
  ${YELLOW}--provider${RESET} <name>          Override provider (openai-compatible | gemini)
  ${YELLOW}--model${RESET} <name>             Override model name

${BOLD}Examples:${RESET}
  ${DIM}# Start CLI chat with default config${RESET}
  idkagent chat

  ${DIM}# Start CLI chat with Gemini${RESET}
  idkagent chat --provider gemini --model gemini-2.5-flash

  ${DIM}# Install gateway as a systemd user service${RESET}
  idkagent gateway install

  ${DIM}# Start the gateway service${RESET}
  idkagent gateway start

  ${DIM}# Stop the gateway service${RESET}
  idkagent gateway stop

  ${DIM}# Enable auto-start on login${RESET}
  idkagent gateway enable

  ${DIM}# Disable auto-start${RESET}
  idkagent gateway disable

  ${DIM}# Uninstall the gateway service${RESET}
  idkagent gateway uninstall

  ${DIM}# Restart the gateway service${RESET}
  idkagent gateway restart

  ${DIM}# Show gateway service status${RESET}
  idkagent gateway status

  ${DIM}# Start all enabled gateways directly${RESET}
  idkagent gateway start

  ${DIM}# Enable TypeScript LSP${RESET}
  idkagent lsp enable typescript

  ${DIM}# Disable Java LSP${RESET}
  idkagent lsp disable java

  ${DIM}# Install TypeScript LSP (npm install -g typescript)${RESET}
  idkagent lsp install typescript

  ${DIM}# List all LSPs and their status${RESET}
  idkagent lsp list

  ${DIM}# Initialize config file${RESET}
  idkagent config init
`);
}

function getSearchOptions(config: AgentConfig): { apiKey: string; model: string } | undefined {
  if (!config.search?.enabled) return undefined;
  const provConfig = config.providers[config.search.provider];
  if (!provConfig || provConfig.type !== 'gemini') return undefined;
  return { apiKey: provConfig.apiKey, model: config.search.model };
}

async function runChat(config: AgentConfig): Promise<void> {
  const mainProvider = createProvider(config, config.models.main.provider, config.models.main);
  const fallbackProvider = config.models.fallback.provider ? createProvider(config, config.models.fallback.provider, config.models.fallback) : undefined;
  const guardrailProvider = config.guardrail.enabled ? createProvider(config, config.guardrail.provider, {
    model: config.guardrail.model,
    temperature: 1,
  }) : undefined;

  const tools = getAllTools(getSearchOptions(config), getImageOptions(config));
  const agent = new Agent({ main: mainProvider, fallback: fallbackProvider, guardrail: guardrailProvider }, tools, config);
  const gateway = new CLIGateway(config.logging);

  // No queue needed for CLI (single user, synchronous)
  await gateway.start((message, onEvent) => agent.handleMessage(message, onEvent));
}

function getImageOptions(config: AgentConfig): { apiKey: string; model: string } | undefined {
  if (!config.image?.enabled) return undefined;
  const provConfig = config.providers[config.image.provider];
  if (!provConfig || provConfig.type !== 'gemini') return undefined;
  return { apiKey: provConfig.apiKey, model: config.image.model };
}

async function runGatewayStart(config: AgentConfig): Promise<void> {
  const platforms = Object.entries(config.gateways || {})
    .filter(([, v]) => v)
    .map(([k]) => k);

  if (platforms.length === 0) {
    console.log(`${YELLOW}⚠️  No gateways enabled. Enable platforms in config.yml under "gateways:"${RESET}`);
    console.log(`  ${DIM}Example:${RESET}`);
    console.log(`    gateways:`);
    console.log(`      discord: true`);
    return;
  }

  const gateways = createGateways(config);
  if (gateways.length === 0) {
    console.log(`${YELLOW}⚠️  No supported gateway platforms found. Check config.yml "gateways:" section.${RESET}`);
    return;
  }

  const mainProvider = createProvider(config, config.models.main.provider, config.models.main);
  const fallbackProvider = config.models.fallback.provider ? createProvider(config, config.models.fallback.provider, config.models.fallback) : undefined;
  const guardrailProvider = config.guardrail.enabled ? createProvider(config, config.guardrail.provider, {
    model: config.guardrail.model,
    temperature: 1,
  }) : undefined;

  const tools = getAllTools(getSearchOptions(config), getImageOptions(config));
  const agent = new Agent({ main: mainProvider, fallback: fallbackProvider, guardrail: guardrailProvider }, tools, config);
  const queue = new MessageQueue(config.queue);

  console.log(`${CYAN}Starting gateway(s): ${platforms.join(', ')}...${RESET}`);
  console.log(`${CYAN}Initializing LSP servers...${RESET}`);
  await initJdtlsIfNeeded();

  // ─── Graceful Shutdown ──────────────────────────────────
  let shuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${YELLOW}⚠️  Received ${signal}. Saving sessions and shutting down gracefully...${RESET}`);

    // 1. Save all sessions to disk
    agent.saveAllSessions();

    // 2. Stop all gateways
    await Promise.all(gateways.map(gw => gw.stop().catch(err => {
      console.error(`Error stopping gateway: ${err}`);
    })));

    console.log(`${GREEN}✅ Graceful shutdown complete.${RESET}`);

    // 3. If running inside systemd, let systemd handle the exit; otherwise exit ourselves
    if (process.env.IDKAGENT_AS_SERVICE !== '1') {
      process.exit(0);
    }
    // For systemd: just let the main Promise resolve naturally so the process exits cleanly
  };

  // Only register signal handlers if not in a child process / test env
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Catch unhandled rejections as a safety net (e.g. race conditions during shutdown)
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (!msg.includes('Expected token to be set') && !msg.includes('Cannot send messages')) {
      console.error(`${RED}❌ Unhandled rejection:${RESET} ${msg}`);
    }
  });

  try {
    // Start all enabled gateways concurrently, each with the shared queue
    await Promise.all(gateways.map((gw) =>
      gw.start(
        (message, onEvent) =>
          queue.enqueue(message, (msg, ev) => agent.handleMessage(msg, ev), onEvent),
        { cancelSession: (sessionId) => agent.cancelSession(sessionId) },
      ),
    ));

    // ─── Session Recovery (after gateways are ready) ──────────
    const sessionsDir = path.resolve(process.cwd(), '..', '.sessions');
    const activePath = path.join(sessionsDir, '.active');
    let sessionIdsToRecover: string[] = [];

    if (fs.existsSync(activePath)) {
      const raw = fs.readFileSync(activePath, 'utf-8').trim();
      sessionIdsToRecover = raw ? raw.split('\n').map(s => s.trim()).filter(Boolean) : [];
      // Remove .active file after reading so subsequent restarts don't re-recover
      fs.unlinkSync(activePath);
    }

    if (sessionIdsToRecover.length > 0) {
      console.log(`♻️  Recovering ${sessionIdsToRecover.length} in-progress session(s) from disk...`);

      for (const sessionId of sessionIdsToRecover) {
        const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
        if (!fs.existsSync(sessionFile)) {
          console.log(`  ⚠️  Session ${sessionId}: session file not found, skipping.`);
          continue;
        }

        // ── Validate: only recover sessions with incomplete operations ──────
        // If the last message is a clean assistant text response (no tool calls),
        // the conversation completed normally and doesn't need recovery.
        try {
          const raw = fs.readFileSync(sessionFile, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const lastMsg = parsed[parsed.length - 1];
            const isComplete =
              lastMsg.role === 'assistant' &&
              (!lastMsg.toolCalls || lastMsg.toolCalls.length === 0);
            if (isComplete) {
              console.log(`  ⏭️  Session ${sessionId}: conversation completed normally, skipping recovery.`);
              continue;
            }
          }
        } catch (e) {
          console.log(`  ⚠️  Session ${sessionId}: unable to read session file, skipping.`);
          continue;
        }

        let recovered = false;

        for (const gw of gateways) {
          if (typeof (gw as any).createSessionEventHandler === 'function') {
            const eventHandler = await (gw as any).createSessionEventHandler(sessionId);
            if (eventHandler) {
              // Notify the channel that the session is being resumed
              eventHandler({ type: 'text', content: '♻️ **Gateway restarted** — 恢復先前的對話中...' });

              // Process through the agent with gateway_restarted action
              const prefix = sessionId.split('-')[0] || 'unknown';
              agent.handleMessage(
                { sessionId, userId: 'system', content: '', action: 'gateway_restarted', gateway: prefix },
                eventHandler,
              ).catch((err: any) => {
                console.error(`[Recovery] Error processing session ${sessionId}:`, err);
              });

              recovered = true;
              break;
            }
          }
        }

        if (!recovered) {
          console.log(`  ⚠️  Session ${sessionId}: no matching gateway found, leaving on disk.`);
        }
      }
    }
  } catch (err) {
    // If a gateway fails to start / crashes, still try to save sessions
    console.error(`${RED}❌ Gateway error:${RESET} ${err instanceof Error ? err.message : err}`);
    agent.saveAllSessions();
    throw err;
  } finally {
    // When gateways stop (e.g. Discord disconnects), ensure sessions are saved
    if (!shuttingDown) {
      agent.saveAllSessions();
    }
  }
}

// ─── Interactive Setup Wizard ───────────────────────────────

function createRL(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function promptYN(rl: readline.Interface, query: string, defaultVal = true): Promise<boolean> {
  const hint = defaultVal ? 'Y/n' : 'y/N';
  const ans = (await question(rl, `${query} [${hint}] `)).trim().toLowerCase();
  if (ans === '') return defaultVal;
  if (ans === 'y' || ans === 'yes') return true;
  return false;
}

async function promptStr(rl: readline.Interface, query: string, defaultVal = ''): Promise<string> {
  const hint = defaultVal ? ` (${defaultVal})` : '';
  const ans = (await question(rl, `${query}${hint}: `)).trim();
  return ans || defaultVal;
}

async function promptList(rl: readline.Interface, query: string, options: string[]): Promise<string> {
  console.log(`\n${query}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]}`);
  }
  while (true) {
    const ans = (await question(rl, `Enter number (1-${options.length}): `)).trim();
    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
    console.log(`  Invalid choice. Please enter 1-${options.length}.`);
  }
}

// ─── Auto-Detect Models ─────────────────────────────────────

async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods: string[] }> };
    if (!data.models) return [];
    return data.models
      .filter((m) => m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => m.name.replace('models/', ''))
      .filter((name) => !name.includes('-thinking') && !name.includes('-flash-lite'))
      .sort();
  } catch (err) {
    console.log(`  ${YELLOW}⚠ Auto-detect failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    return [];
  }
}

async function fetchOpenAIModels(baseURL: string, apiKey: string): Promise<string[]> {
  try {
    const url = baseURL.replace(/\/+$/, '') + '/models';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { data?: Array<{ id: string }> };
    if (!data.data) return [];
    // Filter out empty IDs and sort
    const models = data.data
      .map((m) => m.id)
      .filter(Boolean)
      .sort();
    // If too many, show first 50 as a reasonable selection
    return models.length > 50 ? models.slice(0, 50) : models;
  } catch (err) {
    console.log(`  ${YELLOW}⚠ Auto-detect failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    return [];
  }
}

async function pickModel(
  rl: readline.Interface,
  label: string,
  autoModels: string[],
  defaultModel: string,
): Promise<string> {
  if (autoModels.length > 0) {
    // Show detected models + manual entry option
    const options = [...autoModels];
    // Truncate list if very long
    const display = options.length > 30 ? options.slice(0, 30) : options;
    display.push('(手動輸入 / Manual entry)');
    const picked = await promptList(rl, `  ${label} — detected models:`, display);
    if (picked !== '(手動輸入 / Manual entry)') return picked;
  }
  return await promptStr(rl, `  ${label}`, defaultModel);
}

// ─── Built-in Provider Names (for quick-select) ─────────────

const BUILT_IN_NAMES = ['gemini', 'openrouter', 'opencode-zen'];

// ─── Helper: pick existing provider ─────────────────────────

async function pickProvider(rl: readline.Interface, providers: Record<string, { type: string }>, label: string): Promise<string> {
  const names = Object.keys(providers);
  if (names.length === 1) return names[0];
  const picked = await promptList(rl, `  ${label}:`, names);
  return picked;
}

// ─── Configure a single provider (quick-setup or custom) ────

async function setupOneProvider(
  rl: readline.Interface,
  config: AgentConfig,
  name?: string,
): Promise<string> {
  // If a name is given and it's built-in, just ask for API key
  if (name && BUILT_IN_NAMES.includes(name)) {
    const current = config.providers[name];
    const label = name === 'gemini' ? 'Gemini' : name;
    const apiKey = await promptStr(rl, `  API key for ${label}`, current?.apiKey || '');
    if (apiKey) {
      config.providers[name] = { ...(await import('./config.js')).BUILT_IN_PROVIDERS[name], apiKey };
    }
    return name;
  }

  // If no name given, show built-in quick options + custom
  if (!name) {
    const quickOptions = [...BUILT_IN_NAMES.map((n) => {
      const existing = config.providers[n];
      const hasKey = existing?.apiKey ? ' (已設定)' : '';
      const label = n === 'gemini' ? 'Gemini' : n;
      return `${label}${hasKey}`;
    }), '✨ 自訂提供者 / Custom provider'];
    const picked = await promptList(rl, '  Select a provider', quickOptions);
    const idx = quickOptions.indexOf(picked);
    if (idx < BUILT_IN_NAMES.length) {
      const builtInName = BUILT_IN_NAMES[idx];
      return await setupOneProvider(rl, config, builtInName);
    }
    // Fall through to custom
  }

  // Custom provider: ask name, type, URL, API key
  const provName = name || await promptStr(rl, '  Provider name (e.g. my-provider)', '');
  if (!provName) throw new Error('Provider name is required.');

  // If already configured, just return
  if (config.providers[provName]?.apiKey) {
    return provName;
  }

  const type = await promptList(rl, `  Type for "${provName}"`, [
    'Google Gemini (gemini)',
    'OpenAI-compatible (OpenRouter, OpenCode, etc.)',
  ]);

  if (type.startsWith('Google Gemini')) {
    config.providers[provName] = config.providers[provName] || { type: 'gemini', apiKey: '' };
    const apiKey = await promptStr(rl, '  Gemini API key');
    if (apiKey) config.providers[provName].apiKey = apiKey;
  } else {
    config.providers[provName] = config.providers[provName] || { type: 'openai-compatible', apiKey: '', baseURL: '' };
    const baseURL = await promptStr(rl, '  API base URL', config.providers[provName].baseURL || 'https://openrouter.ai/api/v1');
    config.providers[provName].baseURL = baseURL;
    const apiKey = await promptStr(rl, '  API key');
    if (apiKey) config.providers[provName].apiKey = apiKey;
  }

  return provName;
}

// ─── Save config to disk ────────────────────────────────────

function saveConfig(config: AgentConfig, configPath: string): void {
  const cleaned: Record<string, unknown> = {
    providers: providersToFile(config.providers),
    models: config.models,
    guardrail: config.guardrail,
    context: config.context,
    gateways: config.gateways,
    discord: config.discord,
    queue: config.queue,
    logging: config.logging,
    lsp: config.lsp,
    search: config.search,
    image: config.image,
  };
  if (config.saveWorkingDatas) cleaned.saveWorkingDatas = true;
  fs.writeFileSync(configPath, yaml.stringify(cleaned), 'utf-8');
}

function showSummary(config: AgentConfig): void {
  console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║        📋 Configuration Summary          ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════╝${RESET}`);
  for (const [name, prov] of Object.entries(config.providers)) {
    const keyDisplay = prov.apiKey ? prov.apiKey.slice(0, 8) + '...' : '(not set)';
    console.log(`  ${DIM}Provider "${name}":${RESET} ${prov.type} ${DIM}key=${keyDisplay}${RESET}${prov.baseURL ? ` url=${prov.baseURL}` : ''}`);
  }
  console.log(`  ${DIM}Main model:${RESET} ${config.models.main.model} (via ${config.models.main.provider})`);
  if (config.models.fallback.provider) {
    console.log(`  ${DIM}Fallback model:${RESET} ${config.models.fallback.model} (via ${config.models.fallback.provider})`);
  }
  const enabledGws = Object.entries(config.gateways || {}).filter(([, v]) => v).map(([k]) => k);
  console.log(`  ${DIM}Gateways:${RESET} ${enabledGws.length > 0 ? enabledGws.join(', ') : '(none enabled)'}`);
  if (config.guardrail.enabled) console.log(`  ${DIM}Guardrail:${RESET} enabled (${config.guardrail.model})`);
  else console.log(`  ${DIM}Guardrail:${RESET} disabled`);
}

// ─── Run: Gateway section ───────────────────────────────────

async function runGatewaySetup(rl: readline.Interface, config: AgentConfig): Promise<void> {
  console.log(`\n${BOLD}─── Gateway Setup ───${RESET}`);
  const gwType = await promptList(rl, '  Gateway type', ['Discord']);
  if (gwType === 'Discord') {
    if (!config.gateways) config.gateways = {};
    config.gateways.discord = true;
    config.gateways.cli = false;
    const token = await promptStr(rl, '  Discord bot token');
    if (token) config.discord.token = token;
    const channelId = await promptStr(rl, '  Allowed channel ID (leave empty for all)');
    if (channelId) {
      config.discord.allowedChannels = channelId.split(',').map((s) => s.trim()).filter(Boolean);
    }
    console.log(`  ${DIM}Gateway requires a provider for the LLM calls.${RESET}`);
    if (await promptYN(rl, '  Add another provider for the gateway?', false)) {
      await setupOneProvider(rl, config);
    }
  }
}

// ─── LSP Management ───────────────────────────────────────────

interface LspSubcommands {
  list: void;
  enable: string;
  disable: string;
  install: string;
  uninstall: string;
}

const LSP_HELP = `
${BOLD}LSP Management:${RESET}
  idkagent ${GREEN}lsp list${RESET}                  List available LSP servers and their status
  idkagent ${GREEN}lsp enable <name>${RESET}         Enable an LSP server in config
  idkagent ${GREEN}lsp disable <name>${RESET}         Disable an LSP server in config
  idkagent ${GREEN}lsp install <name>${RESET}         Install an LSP server
  idkagent ${GREEN}lsp uninstall <name>${RESET}       Uninstall an LSP server
`;

async function handleLspSubcommand(subcommand: string | undefined, extraArgs: string[], config: AgentConfig): Promise<void> {
  const { getKnownLsps, getLspByName, isLspInstalled, isLspEnabled, setLspEnabled, installLsp, uninstallLsp, getInstallScriptContent } = await import('./lsp_manager.js');

  const lsps = getKnownLsps();

  if (!subcommand || subcommand === 'list') {
    // ── List all LSPs ─────────────────────────────────────
    console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════╗${RESET}`);
    console.log(`${CYAN}${BOLD}║        🔧 LSP Server Status              ║${RESET}`);
    console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════╝${RESET}`);
    for (const lsp of lsps) {
      const installed = isLspInstalled(lsp);
      const enabled = isLspEnabled(config, lsp.name);
      const binCheck = installed ? `${GREEN}installed${RESET}` : `${RED}not found${RESET}`;
      const enabledCheck = enabled ? `${GREEN}enabled${RESET}` : `${YELLOW}disabled${RESET}`;
      console.log(`\n  ${BOLD}${lsp.displayName}${RESET}`);
      console.log(`    ${DIM}Description:${RESET} ${lsp.description}`);
      console.log(`    ${DIM}Binary:${RESET}      ${lsp.bin}`);
      console.log(`    ${DIM}Installed:${RESET}   ${binCheck}`);
      console.log(`    ${DIM}Enabled:${RESET}     ${enabledCheck}`);
      console.log(`    ${DIM}More info:${RESET}   ${lsp.url}`);
    }
    console.log(`\n  ${DIM}Use 'idkagent lsp enable <name>' or 'idkagent lsp disable <name>' to toggle.${RESET}`);
    console.log(`  ${DIM}Use 'idkagent lsp install <name>' to install.${RESET}\n`);
    return;
  }

  // ── Validate subcommand is known ──────────────────────────
  const VALID_LSP_SUBS = ['enable', 'disable', 'install', 'uninstall'];
  if (!VALID_LSP_SUBS.includes(subcommand)) {
    console.error(`${RED}❌ Unknown lsp subcommand: "${subcommand}"${RESET}`);
    console.log(`  ${DIM}Valid subcommands:${RESET} list, ${VALID_LSP_SUBS.join(', ')}`);
    process.exit(1);
  }

  // ── Subcommands that require a name argument ────────────
  const nameArg = extraArgs[0];
  if (!nameArg) {
    console.error(`${RED}❌ Missing LSP name. Usage: idkagent lsp ${subcommand} <name>${RESET}`);
    console.log(`  ${DIM}Available LSPs: ${lsps.map(l => l.name).join(', ')}${RESET}`);
    process.exit(1);
  }

  const lsp = getLspByName(nameArg);
  if (!lsp) {
    console.error(`${RED}❌ Unknown LSP: "${nameArg}"${RESET}`);
    console.log(`  ${DIM}Available LSPs: ${lsps.map(l => l.name).join(', ')}${RESET}`);
    process.exit(1);
  }

  switch (subcommand) {
    case 'enable': {
      setLspEnabled(config, lsp.name, true);
      // Save config
      const configPath = path.resolve(getDataDir(), 'config.yml');
      saveConfig(config, configPath);
      console.log(`${GREEN}✅ ${lsp.displayName} enabled.${RESET}`);
      console.log(`  ${DIM}Restart the gateway for changes to take effect.${RESET}`);
      break;
    }

    case 'disable': {
      setLspEnabled(config, lsp.name, false);
      const configPath = path.resolve(getDataDir(), 'config.yml');
      saveConfig(config, configPath);
      console.log(`${GREEN}✅ ${lsp.displayName} disabled.${RESET}`);
      console.log(`  ${DIM}Restart the gateway for changes to take effect.${RESET}`);
      break;
    }

    case 'install': {
      const installed = isLspInstalled(lsp);
      if (installed) {
        console.log(`${YELLOW}⚠  ${lsp.displayName} is already installed.${RESET}`);
        // Still enable it in config
        setLspEnabled(config, lsp.name, true);
        const configPath = path.resolve(getDataDir(), 'config.yml');
        saveConfig(config, configPath);
        console.log(`  ${GREEN}Enabled in config.${RESET}`);
        break;
      }

      console.log(`⏳ Installing ${lsp.displayName}...`);
      const result = installLsp(lsp);
      if (result.success) {
        console.log(`${GREEN}✅ ${lsp.displayName} installed.${RESET}`);
        if (result.output) console.log(`  ${result.output}`);
        setLspEnabled(config, lsp.name, true);
        const configPath = path.resolve(getDataDir(), 'config.yml');
        saveConfig(config, configPath);
        console.log(`  ${GREEN}Enabled in config.${RESET}`);
      } else {
        console.error(`${RED}❌ Installation failed:${RESET}`);
        console.error(`  ${result.output}`);
        process.exit(1);
      }
      break;
    }

    case 'uninstall': {
      const installed = isLspInstalled(lsp);
      if (!installed) {
        console.log(`${YELLOW}⚠  ${lsp.displayName} is not installed.${RESET}`);
        setLspEnabled(config, lsp.name, false);
        const configPath = path.resolve(getDataDir(), 'config.yml');
        saveConfig(config, configPath);
        console.log(`  ${GREEN}Disabled in config.${RESET}`);
        break;
      }

      console.log(`⏳ Uninstalling ${lsp.displayName}...`);
      const result = uninstallLsp(lsp);
      if (result.success) {
        console.log(`${GREEN}✅ ${lsp.displayName} uninstalled.${RESET}`);
        if (result.output) console.log(`  ${result.output}`);
        setLspEnabled(config, lsp.name, false);
        const configPath = path.resolve(getDataDir(), 'config.yml');
        saveConfig(config, configPath);
        console.log(`  ${GREEN}Disabled in config.${RESET}`);
      } else {
        console.error(`${RED}❌ Uninstallation failed:${RESET}`);
        console.error(`  ${result.output}`);
        process.exit(1);
      }
      break;
    }

  }
}

// ─── Gateway Service Management (systemd --user) ─────────────

const SERVICE_NAME = 'idkagent-gateway';

function getSystemdUserDir(): string {
  return path.resolve(os.homedir(), '.config', 'systemd', 'user');
}

function getServiceUnitPath(): string {
  return path.resolve(getSystemdUserDir(), `${SERVICE_NAME}.service`);
}

function getResourceServiceUnitPath(): string {
  // Resolve the project root relative to this file (src/index.ts → resources/)
  // In production (dist/index.js), go up one level from dist/ to project root.
  const projectRoot = path.resolve(new URL('.', import.meta.url).pathname, '..');
  return path.resolve(projectRoot, 'resources', `${SERVICE_NAME}.service`);
}

/**
 * Run a systemctl --user command and return { code, stdout, stderr }.
 */
async function systemctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execSync } = await import('node:child_process');
  try {
    const stdout = execSync(`systemctl --user ${args.join(' ')}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
    };
  }
}

async function gatewayServiceInstall(): Promise<void> {
  const srcPath = getResourceServiceUnitPath();
  const dstDir = getSystemdUserDir();
  const dstPath = getServiceUnitPath();

  // Check if resource file exists
  if (!fs.existsSync(srcPath)) {
    console.error(`${RED}❌ Service unit file not found at: ${srcPath}${RESET}`);
    process.exit(1);
  }

  // Read template and replace %h with actual home directory
  let unitContent = fs.readFileSync(srcPath, 'utf-8');
  unitContent = unitContent.replace(/%h/g, os.homedir());

  // Ensure target directory exists
  fs.mkdirSync(dstDir, { recursive: true });

  // Write the unit file
  fs.writeFileSync(dstPath, unitContent, 'utf-8');
  console.log(`${GREEN}✅ Service unit written to: ${dstPath}${RESET}`);

  // Reload systemd user daemon
  console.log(`${DIM}Reloading systemd user daemon...${RESET}`);
  const reload = await systemctl(['daemon-reload']);
  if (reload.code !== 0) {
    console.error(`${RED}❌ Failed to reload systemd: ${reload.stderr}${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✅ systemd user daemon reloaded${RESET}`);

  // Enable the service (so it starts on login)
  console.log(`${DIM}Enabling service...${RESET}`);
  const enable = await systemctl(['enable', SERVICE_NAME]);
  if (enable.code !== 0) {
    console.error(`${RED}❌ Failed to enable service: ${enable.stderr}${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✅ Service enabled (auto-start on login)${RESET}`);

  // Start the service
  console.log(`${DIM}Starting service...${RESET}`);
  const start = await systemctl(['start', SERVICE_NAME]);
  if (start.code !== 0) {
    console.error(`${RED}❌ Failed to start service: ${start.stderr}${RESET}`);
    console.log(`${YELLOW}⚠ Service installed but could not be started. Run 'idkagent gateway start' manually.${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✅ Service started${RESET}`);

  console.log(`\n${CYAN}${BOLD}Gateway service installed successfully!${RESET}`);
  console.log(`  ${DIM}Status:${RESET}     ${CYAN}systemctl --user status ${SERVICE_NAME}${RESET}`);
  console.log(`  ${DIM}Logs:${RESET}       ${CYAN}journalctl --user -u ${SERVICE_NAME} -f${RESET}`);
}

async function gatewayServiceStart(): Promise<void> {
  // Check if unit file exists
  if (!fs.existsSync(getServiceUnitPath())) {
    console.error(`${RED}❌ Gateway service is not installed. Run 'idkagent gateway install' first.${RESET}`);
    process.exit(1);
  }
  const result = await systemctl(['start', SERVICE_NAME]);
  if (result.code === 0) {
    console.log(`${GREEN}✅ Gateway service started${RESET}`);
  } else if (result.stderr.includes('Unit is already running')) {
    console.log(`${YELLOW}⚠ Gateway service is already running${RESET}`);
  } else {
    // Try to show status for more context
    const status = await systemctl(['status', SERVICE_NAME]);
    console.error(`${RED}❌ Failed to start gateway service:${RESET}`);
    console.error(`  ${result.stderr}`);
    if (status.stdout) console.error(`  ${DIM}${status.stdout.split('\n').slice(0, 3).join('\n  ')}${RESET}`);
    process.exit(1);
  }
}

async function gatewayServiceStop(): Promise<void> {
  const result = await systemctl(['stop', SERVICE_NAME]);
  if (result.code === 0) {
    console.log(`${GREEN}✅ Gateway service stopped${RESET}`);
  } else {
    console.error(`${RED}❌ Failed to stop gateway service:${RESET} ${result.stderr}`);
    process.exit(1);
  }
}

async function gatewayServiceEnable(): Promise<void> {
  if (!fs.existsSync(getServiceUnitPath())) {
    console.error(`${RED}❌ Gateway service is not installed. Run 'idkagent gateway install' first.${RESET}`);
    process.exit(1);
  }
  const result = await systemctl(['enable', SERVICE_NAME]);
  if (result.code === 0) {
    console.log(`${GREEN}✅ Gateway auto-start enabled${RESET}`);
  } else {
    console.error(`${RED}❌ Failed to enable gateway service:${RESET} ${result.stderr}`);
    process.exit(1);
  }
}

async function gatewayServiceDisable(): Promise<void> {
  if (!fs.existsSync(getServiceUnitPath())) {
    console.error(`${RED}❌ Gateway service is not installed. Run 'idkagent gateway install' first.${RESET}`);
    process.exit(1);
  }
  const result = await systemctl(['disable', SERVICE_NAME]);
  if (result.code === 0) {
    console.log(`${GREEN}✅ Gateway auto-start disabled${RESET}`);
  } else {
    console.error(`${RED}❌ Failed to disable gateway service:${RESET} ${result.stderr}`);
    process.exit(1);
  }
}

async function gatewayServiceUninstall(): Promise<void> {
  const unitPath = getServiceUnitPath();

  // Stop if running
  console.log(`${DIM}Stopping service (if running)...${RESET}`);
  await systemctl(['stop', SERVICE_NAME]).catch(() => {});

  // Disable
  console.log(`${DIM}Disabling service...${RESET}`);
  await systemctl(['disable', SERVICE_NAME]).catch(() => {});

  // Remove unit file
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
    console.log(`${GREEN}✅ Service unit removed: ${unitPath}${RESET}`);
  }

  // Reload daemon
  console.log(`${DIM}Reloading systemd user daemon...${RESET}`);
  await systemctl(['daemon-reload']);

  console.log(`${GREEN}✅ Gateway service uninstalled${RESET}`);
}

async function handleGatewaySubcommand(subcommand: string | undefined, config: AgentConfig, overrides: Partial<AgentConfig>): Promise<void> {
  switch (subcommand) {
    case 'install':
      await gatewayServiceInstall();
      break;

    case 'start': {
      // When run as a systemd service (IDKAGENT_AS_SERVICE=1), run directly
      if (process.env.IDKAGENT_AS_SERVICE === '1') {
        await runGatewayStart(config);
        break;
      }
      // Check if installed as a service → use systemctl
      const unitPath = getServiceUnitPath();
      if (fs.existsSync(unitPath)) {
        // Check if systemd says the service is active
        const status = await systemctl(['is-active', SERVICE_NAME]);
        if (status.stdout === 'active') {
          console.log(`${YELLOW}⚠ Gateway service is already running.${RESET}`);
          break;
        }
        await gatewayServiceStart();
      } else {
        // Not installed as service → run directly (original behavior)
        await runGatewayStart(config);
      }
      break;
    }

    case 'stop':
      await gatewayServiceStop();
      break;

    case 'enable':
      await gatewayServiceEnable();
      break;

    case 'disable':
      await gatewayServiceDisable();
      break;

    case 'status': {
      const unitPath = getServiceUnitPath();
      if (!fs.existsSync(unitPath)) {
        console.log(`${YELLOW}⚠ Gateway service is not installed.${RESET}`);
        break;
      }
      const status = await systemctl(['status', SERVICE_NAME]);
      console.log(status.stdout || status.stderr);
      break;
    }

    case 'restart': {
      if (process.env.IDKAGENT_AS_SERVICE === '1') {
        console.log(`${YELLOW}⚠ Cannot restart from within the service. Use systemctl --user restart ${SERVICE_NAME}${RESET}`);
        break;
      }
      const unitPath = getServiceUnitPath();
      if (!fs.existsSync(unitPath)) {
        console.error(`${RED}❌ Gateway service is not installed. Run 'idkagent gateway install' first.${RESET}`);
        process.exit(1);
      }
      const result = await systemctl(['restart', SERVICE_NAME]);
      if (result.code === 0) {
        console.log(`${GREEN}✅ Gateway service restarted${RESET}`);
      } else {
        console.error(`${RED}❌ Failed to restart gateway service:${RESET} ${result.stderr}`);
        process.exit(1);
      }
      break;
    }

    case 'uninstall':
      await gatewayServiceUninstall();
      break;

    default:
      if (subcommand) {
        // Unknown subcommand → show error with help
        console.error(`${RED}❌ Unknown gateway subcommand: "${subcommand}"${RESET}`);
        console.log(`  ${DIM}Valid subcommands:${RESET} install, start, stop, restart, status, enable, disable, uninstall`);
        console.log(`  ${DIM}Run without subcommand to configure gateway settings.${RESET}`);
        process.exit(1);
        break;
      }
      // No subcommand → interactive gateway setup wizard (original behavior)
      const rl = createRL();
      console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════╗${RESET}`);
      console.log(`${CYAN}${BOLD}║        🌐 Gateway Configuration          ║${RESET}`);
      console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════╝${RESET}`);
      const configPath = path.resolve(getDataDir(), 'config.yml');
      await runGatewaySetup(rl, config);
      showSummary(config);
      if (await promptYN(rl, `\n  Save to config.yml?`, true)) {
        saveConfig(config, configPath);
        console.log(`\n${GREEN}✅ Configuration saved to ${configPath}${RESET}`);
      }
      rl.close();
      break;
  }
}

// ─── Run: Full setup wizard ─────────────────────────────────

async function runSetup(): Promise<void> {
  const rl = createRL();
  const configPath = path.resolve(getDataDir(), 'config.yml');

  console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║     🔧 idkagent Setup Wizard v1.0       ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════╝${RESET}`);
  console.log(`\n${DIM}This wizard will help you configure idkagent step by step.${RESET}\n`);

  let config: AgentConfig = (await import('./config.js')).loadConfig();
  if (fs.existsSync(configPath)) {
    console.log(`${GREEN}✓${RESET} Existing config.yml loaded.`);
  } else {
    console.log(`Creating new config.yml...`);
  }

  // Step 1: Provider selection (with auto-detection)
  console.log(`\n${BOLD}─── Step 1: Provider Selection ───${RESET}`);
  const mainProvider = await setupOneProvider(rl, config);

  // Step 2: Model setup for selected provider
  console.log(`\n${BOLD}─── Step 2: Model Setup ───${RESET}`);
  const mainProv = config.providers[mainProvider];
  console.log(`  ${DIM}🔍 Detecting available models for "${mainProvider}"...${RESET}`);
  let mainModels: string[] = [];
  if (mainProv.type === 'gemini' && mainProv.apiKey) {
    mainModels = await fetchGeminiModels(mainProv.apiKey);
  } else if (mainProv.type === 'openai-compatible' && mainProv.baseURL && mainProv.apiKey) {
    mainModels = await fetchOpenAIModels(mainProv.baseURL, mainProv.apiKey);
  }
  config.models.main.provider = mainProvider;
  config.models.main.model = await pickModel(rl, 'Main model', mainModels, 'gemini-2.5-flash');

  // Step 3: Fallback provider
  if (await promptYN(rl, '\n  Set up a fallback model?', false)) {
    const fbProvider = await setupOneProvider(rl, config);
    const fbProv = config.providers[fbProvider];
    console.log(`  ${DIM}🔍 Detecting models for "${fbProvider}"...${RESET}`);
    let fbModels: string[] = [];
    if (fbProv.type === 'gemini' && fbProv.apiKey) {
      fbModels = await fetchGeminiModels(fbProv.apiKey);
    } else if (fbProv.type === 'openai-compatible' && fbProv.baseURL && fbProv.apiKey) {
      fbModels = await fetchOpenAIModels(fbProv.baseURL, fbProv.apiKey);
    }
    config.models.fallback.provider = fbProvider;
    config.models.fallback.model = await pickModel(rl, 'Fallback model', fbModels, 'gemini-2.0-flash');
  } else {
    config.models.fallback.provider = '';
    config.models.fallback.model = '';
  }

  // Step 4: Guardrail
  if (await promptYN(rl, '\n  Enable guardrail (content safety)?', false)) {
    const grProvider = await setupOneProvider(rl, config);
    const grProv = config.providers[grProvider];
    console.log(`  ${DIM}🔍 Detecting models for "${grProvider}"...${RESET}`);
    let grModels: string[] = [];
    if (grProv.type === 'openai-compatible' && grProv.baseURL && grProv.apiKey) {
      grModels = await fetchOpenAIModels(grProv.baseURL, grProv.apiKey);
    }
    config.guardrail.enabled = true;
    config.guardrail.provider = grProvider;
    config.guardrail.model = await pickModel(rl, 'Guardrail model', grModels, 'openai/gpt-4o-mini');
  } else {
    config.guardrail.enabled = false;
  }

  // Step 5: Gateway
  if (await promptYN(rl, '\n  Set up a gateway (e.g. Discord bot)?', false)) {
    await runGatewaySetup(rl, config);
  }

  // Summary + Save
  showSummary(config);
  if (await promptYN(rl, `\n  Save to config.yml?`, true)) {
    saveConfig(config, configPath);
    console.log(`\n${GREEN}✅ Configuration saved to ${configPath}${RESET}`);
  } else {
    console.log(`\n${YELLOW}⚠  Configuration not saved.${RESET}`);
  }

  rl.close();
  console.log(`\n${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`\n${BOLD}🚀 Next steps:${RESET}`);
  console.log(`  ${DIM}1.${RESET} Start chatting:  ${CYAN}idkagent chat${RESET}`);
  console.log(`  ${DIM}2.${RESET} Start Discord:   ${CYAN}idkagent gateway start${RESET}`);
  console.log(`  ${DIM}3.${RESET} Edit config:     ${CYAN}nano ${path.resolve(getDataDir(), 'config.yml')}${RESET}`);
  console.log(`  ${DIM}4.${RESET} View config:     ${CYAN}idkagent config show${RESET}\n`);
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, subcommand, flags } = parseArgs(process.argv);

  // Build config overrides from flags
  const overrides: Partial<AgentConfig> = {};
  if (flags.provider || flags.model) {
    overrides.models = {
      ...overrides.models,
      main: {
        provider: flags.provider || 'openrouter',
        model: flags.model || ''
      }
    } as any;
  }

  try {
    switch (command) {
      case 'chat': {
        const config = loadConfig(overrides);
        // Skip API key check here for simplicity since there are multiple providers
        await runChat(config);
        break;
      }

      case 'model': {
        const config = loadConfig(overrides);
        const rl = createRL();
        
        const providerName = await setupOneProvider(rl, config);
        const prov = config.providers[providerName];
        
        console.log(`\n${DIM}🔍 Fetching models for "${providerName}"...${RESET}`);
        let models: string[] = [];
        if (prov.type === 'gemini' && prov.apiKey) {
          models = await fetchGeminiModels(prov.apiKey);
        } else if (prov.type === 'openai-compatible' && prov.baseURL && prov.apiKey) {
          models = await fetchOpenAIModels(prov.baseURL, prov.apiKey);
        }
        
        if (models.length === 0) {
          console.log(`  ${YELLOW}No models found or error fetching models.${RESET}`);
        } else {
          const selectedModel = await pickModel(rl, 'Select model to use as main', models, config.models.main.model);
          config.models.main.provider = providerName;
          config.models.main.model = selectedModel;
          
          console.log(`\n${GREEN}✅ Updated main model to: ${selectedModel} (via ${providerName})${RESET}`);
          if (await promptYN(rl, `\n  Save to config.yml?`, true)) {
            saveConfig(config, path.resolve(getDataDir(), 'config.yml'));
          }
        }
        
        rl.close();
        break;
      }

      case 'gateway': {
        const config = loadConfig(overrides);
        await handleGatewaySubcommand(subcommand, config, overrides);
        break;
      }

      case 'lsp': {
        const config = loadConfig(overrides);
        // Extract args: node index.js lsp <subcommand> [name] ...
        const allArgs = process.argv.slice(3).filter(a => !a.startsWith('--'));
        const lspSub = allArgs[0];
        const extraArgs = allArgs.slice(1);
        await handleLspSubcommand(lspSub, extraArgs, config);
        break;
      }

      case 'config': {
        if (subcommand === 'init') {
          const path = saveDefaultConfig();
          console.log(`${GREEN}✅ Config file created at: ${path}${RESET}`);
          console.log(`${DIM}Edit this file to configure your provider, API key, and other settings.${RESET}`);
        } else if (subcommand === 'update') {
          const path = updateConfig();
          console.log(`${GREEN}✅ Config file updated with defaults at: ${path}${RESET}`);
        } else if (subcommand === 'show') {
          const config = loadConfig(overrides);
          showConfig(config);
        } else {
          console.log(`${YELLOW}Usage: idkagent config <init|update|show>${RESET}`);
        }
        break;
      }

      case 'setup':
        await runSetup();
        break;

      case 'help':
      default:
        printHelp();
        break;
    }
  } catch (err) {
    console.error(`${RED}${BOLD}❌ Fatal error:${RESET} ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
