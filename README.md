
<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-22+-green?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
</p>

<h1 align="center">🤖 idkagent</h1>
<p align="center"><em>AI Agent with Reasoning &amp; Tool Use — CLI · Discord · Extensible</em></p>

---

## ✨ Overview

**idkagent** is a TypeScript AI agent framework that connects large language models to real-world tools. It features:

- **Multi-Provider Support** — Gemini, OpenAI-compatible APIs (OpenRouter, OpenCode, etc.), with automatic fallback
- **Dual Interface** — Interactive CLI chat and full Discord bot integration (slash commands, @mentions, buttons)
- **Rich Tool System** — File I/O, git, shell commands, credentials vault, project management, LSP diagnostics, and more
- **Agentic Loop** — Autonomous reasoning, tool selection, execution, and multi-step problem solving
- **Safety** — Configurable guardrail provider, credential masking, prompt injection detection
- **Sub-Agent Delegation** — Parallel task execution with up to 5 concurrent sub-agents
- **Session Persistence** — Per-user conversation history saved to disk, with intelligent context compression
- **One-Command Install** — Automatic setup with PATH integration via `install.sh`

---

## 🚀 Quick Start

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/ItsGlobally/idkagent/main/install.sh | bash
```

This will:
1. Clone the repository to `~/idkagent`
2. Install npm dependencies
3. Build the project
4. Create a default configuration
5. Install the `idkagent` wrapper command into your PATH

After installation, **restart your shell** or run `source ~/.bashrc`, then:

```bash
idkagent help
```

### Manual Install

```bash
git clone https://github.com/ItsGlobally/idkagent.git
cd idkagent
npm install
npm run build
./install.sh
```

### Configuration

Edit `config.yml` to set your API keys:

```bash
nano config.yml
```

The configuration file supports:
- **Multiple LLM providers** (Gemini, OpenAI-compatible endpoints)
- **Main & fallback models** for redundancy
- **Guardrail provider** for content safety
- **Discord bot token** and allowed channels
- **Logging preferences** (show thinking, tool calls, results)

You can also override providers at runtime:

```bash
idkagent chat --provider gemini --model gemini-2.5-flash
```

---

## 📋 Usage

### Commands

| Command | Description |
|---------|-------------|
| `idkagent chat` | Start interactive CLI chat session |
| `idkagent gateway start` | Start Discord bot gateway |
| `idkagent config init` | Create default `config.yml` |
| `idkagent config update` | Update config with missing defaults |
| `idkagent config show` | Display current configuration |
| `idkagent help` | Show help message |

### Flags

| Flag | Description |
|------|-------------|
| `--provider <name>` | Override LLM provider |
| `--model <name>` | Override model name |
| `--gateway <name>` | Override gateway (`cli` / `discord`) |

### CLI Chat

```bash
# Start a conversation
idkagent chat

# Override provider/model
idkagent chat --provider openrouter --model deepseek/deepseek-r1

# Chat with Gemini
idkagent chat --provider gemini --model gemini-2.5-flash
```

### CLI Commands (inside chat)

| Command | Description |
|---------|-------------|
| `/reset` | Clear session context |
| `/resetmemory` | Delete permanent memory and reset |
| `/exit` / `/quit` | Exit the CLI |

### Discord Bot

1. Set `gateway: discord` in `config.yml`
2. Add your bot token under `discord.token`
3. Configure allowed channels in `discord.allowedChannels`
4. Start the bot:

```bash
idkagent gateway start
```

The bot supports:
- **Slash commands:** `/chat`, `/reset`, `/resetmemory`
- **@mentions:** Mention the bot in any message
- **Retry buttons:** Continue or restart on errors
- **Ask buttons:** Interactive questions with multiple-choice buttons

---

## 🛠️ Tools

idkagent comes with a rich set of built-in tools that the AI can autonomously invoke:

| Tool | Description |
|------|-------------|
| `read_file` | Read files (relative paths resolve inside `workspace/`) |
| `create_file` | Create files with automatic parent directory creation |
| `patch_file` | Search-and-replace within existing files |
| `list_dir` | List directory contents with file sizes |
| `run_command` | Execute shell commands (async, no event loop blocking) |
| `credential` | Securely store & retrieve API keys/tokens |
| `git` | Full git operations with automatic authentication |
| `project` | Register and manage development projects |
| `update_memory` | Write to permanent agent memory (MEMORY.md) |
| `ask` | Ask the user interactive multiple-choice questions |
| `invoke_subagents` | Delegate parallel tasks to sub-agents (max 5) |

### Credential Vault

Sensitive values (API keys, tokens) are stored encrypted at rest in `workspace/credentials/secrets.json`:

```bash
# In CLI chat, tell the agent:
"Save my GitHub token as git_token"
"Retrieve my git credentials"
```

Values retrieved via `credential` are **masked from conversation history** to prevent leakage to session files or LLM context.

---

## 🏗️ Architecture

```
idkagent/
├── src/
│   ├── index.ts              # CLI entry point & command router
│   ├── agent.ts              # Core agent loop, session management, context compression
│   ├── config.ts             # YAML config loader with deep merge
│   ├── logger.ts             # CLI & truncated loggers (for Discord)
│   ├── queue.ts              # Concurrency-limited message queue
│   ├── providers/
│   │   ├── types.ts          # LLM provider interface & message types
│   │   ├── index.ts          # Provider factory
│   │   ├── gemini.ts         # Google Gemini provider (with retry & rate limiting)
│   │   └── openai-compatible.ts  # OpenAI-compatible provider (OpenRouter, etc.)
│   ├── gateways/
│   │   ├── types.ts          # Gateway interface & event types
│   │   ├── index.ts          # Gateway factory
│   │   ├── cli.ts            # Interactive CLI gateway
│   │   └── discord.ts        # Discord bot gateway (slash commands, buttons, modals)
│   └── tools/
│       ├── types.ts          # Tool interface
│       ├── index.ts          # Tool registry
│       ├── read_file.ts      # File reading (relative to workspace/)
│       ├── create_file.ts    # File creation with LSP diagnostics
│       ├── patch_file.ts     # Search-and-replace file patching
│       ├── list_dir.ts       # Directory listing
│       ├── run_command.ts    # Async shell command execution
│       ├── credential.ts     # Secure credential vault
│       ├── git.ts            # Git operations with auth injection
│       ├── project.ts        # Project registry management
│       ├── update_memory.ts  # Permanent memory (MEMORY.md)
│       ├── ask.ts            # Interactive user questions
│       ├── lsp.ts            # Language server diagnostics runner
│       └── jdtls_client.ts   # Java LSP (jdtls) client
├── install.sh                # One-command install & PATH setup
├── idkagent-wrapper.sh       # Global wrapper script (resolves symlinks)
├── config.yml                # Configuration (API keys, models, gateways)
├── tsconfig.json
└── package.json
```

### Agent Loop Flow

```
User Message
    ↓
[Guardrail Check]  ── Blocked? → Error response
    ↓
[Context Compression]  ── Over token limit? → Summarize old messages
    ↓
[LLM Call]  ── System prompt + history + tools
    ↓
[Tool Calls?] ── Yes → Execute tool(s) → Append results → Loop
    ↓ No
[Text Response]  ── Return to user → Save session
```

---

## ⚙️ Configuration Reference

`config.yml` full schema:

```yaml
providers:
  <name>:                          # Provider identifier
    type: openai-compatible|gemini # Provider type
    apiKey: "<key>"                # API key (or leave empty for env vars)
    baseURL: "<url>"               # Base URL (optional, for OpenAI-compatible)

models:
  main:                            # Primary model
    provider: <name>               # Reference to a provider above
    model: "<model-id>"            # Model name
    temperature: 1                 # Sampling temperature (optional)
  fallback:                        # Fallback model (optional)
    provider: <name>
    model: "<model-id>"

guardrail:
  enabled: true                    # Enable content safety check
  provider: <name>                 # Provider for guardrail
  model: "<model-id>"              # Model for guardrail

context:
  maxHistoryTokens: 8000           # Token limit before compression triggers

gateway: cli|discord               # Default gateway

discord:
  token: "<bot-token>"             # Discord bot token
  allowedChannels: ["channel-id"]  # Restrict to specific channels (empty = all)

queue:
  maxRetries: 5                    # Message processing retries
  baseDelayMs: 1000                # Initial retry delay
  maxDelayMs: 60000                # Maximum retry delay
  concurrency: 1                   # Concurrent message processing

logging:
  showThinking: true               # Show AI reasoning
  showToolCalls: true              # Show tool invocations
  showToolResults: true            # Show tool outputs
  truncateAt: 500                  # Truncation length for platform messages

lsp:
  typescript:
    bin: tsc                       # TypeScript compiler path
    enabled: true
  java:
    bin: jdtls                     # Java LSP server path
    enabled: false
```

Environment variable overrides:
- `DISCORD_TOKEN` — Overrides `discord.token`

---

## 🔧 Development

```bash
# Run in development mode (tsx, no build needed)
npm run dev -- chat
npm run dev -- gateway start

# Build TypeScript
npm run build

# Run compiled version
npm start
```

### Project Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run with tsx (hot reload) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled `dist/index.js` |

---

## 🧩 Extending

### Adding a New Tool

1. Create `src/tools/my_tool.ts`
2. Export a `Tool` object with `name`, `description`, `parameters` (JSON Schema), and `execute` function
3. Register it in `src/tools/index.ts`

```typescript
// src/tools/echo.ts
import type { Tool } from './types.js';

export const echoTool: Tool = {
  name: 'echo',
  description: 'Echo back the input text',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo' },
    },
    required: ['text'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    return `Echo: ${args.text}`;
  },
};
```

### Adding a New Provider

1. Implement the `LLMProvider` interface from `src/providers/types.ts`
2. Add the case in `src/providers/index.ts`

### Adding a New Gateway

1. Implement the `Gateway` interface from `src/gateways/types.ts`
2. Add the case in `src/gateways/index.ts`

---

## 🧠 Advanced Features

### Context Compression

When conversation history exceeds the token limit, idkagent automatically summarizes older messages using the LLM itself, preserving key facts, code snippets, and user intents. If summarization fails, it falls back to dropping the oldest messages.

### Sub-Agent Delegation

The AI can spawn up to 5 parallel sub-agents for complex multi-file tasks. Sub-agents are isolated (no recursive delegation) and report back to the main agent.

### Retry Logic

Both Gemini and OpenAI-compatible providers feature exponential backoff with jitter for rate limits (429) and server errors (5xx), with configurable retry limits.

### Session Persistence

Conversation sessions are saved to `workspace/.sessions/<id>.json` and survive restarts. System prompts are never persisted — they are regenerated fresh on each load.

---

## 📁 workspace/ Directory

```
workspace/
├── .sessions/            # Session history files (auto-managed)
├── credentials/
│   └── secrets.json      # Encrypted credential vault
├── .jdtls_data/          # Java LSP workspace data
├── AGENT.md              # Injected into system prompt (optional)
├── SOUL.md               # Injected into system prompt (optional)
├── MEMORY.md             # Permanent agent memory (via update_memory tool)
└── projects.json         # Registered development projects
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run build` to verify compilation
5. Submit a PR

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<p align="center"><em>Built with ❤️ by <a href="https://github.com/ItsGlobally">ItsGlobally</a></em></p>
