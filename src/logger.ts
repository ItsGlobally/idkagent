import type { AgentEvent } from './gateways/types.js';

import type { LoggingConfig } from './config.js';

// ─── ANSI Color Codes ────────────────────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const WHITE = '\x1b[37m';

// ─── Logger Interface ────────────────────────────────────────

export interface Logger {
  log(event: AgentEvent): void;
}

// ─── Truncation Helper ───────────────────────────────────────

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `... (truncated, ${text.length} chars total)`;
}

// ─── CLI Logger (full output, colored) ───────────────────────

export class CLILogger implements Logger {
  private config: LoggingConfig;

  constructor(config: LoggingConfig) {
    this.config = config;
  }

  log(event: AgentEvent): void {
    switch (event.type) {
      case 'thinking':
        if (!this.config.showThinking) return;
        console.log(`${event.content.split('\n').join('\n   ')}${RESET}`);
        break;

      case 'tool_call':
        if (!this.config.showToolCalls) return;
        console.log(`\n${CYAN}${BOLD}🔧 Tool Call: ${event.content}${RESET}`);
        if (event.metadata?.arguments) {
          const args = event.metadata.arguments as Record<string, unknown>;
          for (const [key, value] of Object.entries(args)) {
            const display = typeof value === 'string' ? value : JSON.stringify(value);
            console.log(`${CYAN}   ${key}: ${DIM}${display}${RESET}`);
          }
        }
        break;

      case 'tool_result': {
        if (!this.config.showToolResults) return;
        const success = event.metadata?.success as boolean;
        const toolName = event.metadata?.toolName as string;
        const icon = success ? `${GREEN}✅` : `${RED}❌`;
        const label = success ? 'success' : 'error';
        console.log(`${icon} Tool Result: ${toolName} (${label})${RESET}`);
        const lines = event.content.split('\n');
        const preview = lines.slice(0, 10).join('\n');
        console.log(`${DIM}   ${preview.split('\n').join('\n   ')}${RESET}`);
        if (lines.length > 10) {
          console.log(`${DIM}   ... (${lines.length - 10} more lines)${RESET}`);
        }
        break;
      }

      case 'text':
        console.log(`\n${WHITE}${BOLD}💬 Response:${RESET}`);
        console.log(`${WHITE}${event.content}${RESET}`);
        break;

      case 'error':
        console.log(`\n${RED}${BOLD}❌ Error: ${event.content}${RESET}`);
        break;

      case 'queue_status':
        console.log(`${YELLOW}📋 ${event.content}${RESET}`);
        break;
    }
  }
}

// ─── Truncated Logger (for Discord / other platforms) ────────

export class TruncatedLogger implements Logger {
  private config: LoggingConfig;
  private buffer: string[] = [];

  constructor(config: LoggingConfig) {
    this.config = config;
  }

  log(event: AgentEvent): void {
    switch (event.type) {
      case 'thinking':
        if (!this.config.showThinking) return;
        this.buffer.push(`💭 *Thinking...*\n> ${truncate(event.content, this.config.truncateAt).split('\n').join('\n> ')}`);
        break;

      case 'tool_call':
        if (!this.config.showToolCalls) return;
        let toolMsg = `🔧 **Tool: ${event.content}**`;
        if (event.metadata?.arguments) {
          const args = event.metadata.arguments as Record<string, unknown>;
          const argStr = Object.entries(args)
            .map(([k, v]) => `\`${k}\`: ${truncate(String(v), this.config.truncateAt)}`)
            .join(', ');
          toolMsg += `\n   ${argStr}`;
        }
        this.buffer.push(toolMsg);
        break;

      case 'tool_result': {
        if (!this.config.showToolResults) return;
        const success = event.metadata?.success as boolean;
        const toolName = event.metadata?.toolName as string;
        const icon = success ? '✅' : '❌';
        this.buffer.push(`${icon} **${toolName}**: ${truncate(event.content, this.config.truncateAt)}`);
        break;
      }

      case 'text':
        this.buffer.push(event.content);
        break;

      case 'error':
        this.buffer.push(`❌ **Error**: ${event.content}`);
        break;

      case 'queue_status':
        this.buffer.push(`📋 ${event.content}`);
        break;
    }
  }

  /** Flush buffered messages, splitting at Discord's 2000 char limit */
  flush(): string[] {
    const MAX_LEN = 1950; // leave some margin
    const result: string[] = [];
    let current = '';

    for (const chunk of this.buffer) {
      if (current.length + chunk.length + 2 > MAX_LEN) {
        if (current) result.push(current);
        // If a single chunk exceeds limit, split it
        if (chunk.length > MAX_LEN) {
          for (let i = 0; i < chunk.length; i += MAX_LEN) {
            result.push(chunk.slice(i, i + MAX_LEN));
          }
        } else {
          current = chunk;
        }
      } else {
        current += (current ? '\n\n' : '') + chunk;
      }
    }
    if (current) result.push(current);

    this.buffer = [];
    return result.length > 0 ? result : ['(No response)'];
  }
}
