import readline from 'node:readline';
import type { Gateway, MessageHandler } from './types.js';
import { CLILogger } from '../logger.js';
import type { LoggingConfig } from '../config.js';

// ─── ANSI helpers ────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';
const YELLOW = '\x1b[33m';

// ─── CLI Gateway ─────────────────────────────────────────────

export class CLIGateway implements Gateway {
  private rl: readline.Interface | null = null;
  private logger: CLILogger;
  private sessionId = 'cli-session';

  constructor(loggingConfig: LoggingConfig) {
    this.logger = new CLILogger(loggingConfig);
  }

  async start(handler: MessageHandler): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Banner
    console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════╗${RESET}`);
    console.log(`${CYAN}${BOLD}║        🤖 idkagent — AI Agent       ║${RESET}`);
    console.log(`${CYAN}${BOLD}╚══════════════════════════════════════╝${RESET}`);
    console.log(`${DIM}  Type your message and press Enter.${RESET}`);
    console.log(`${DIM}  Commands: ${YELLOW}/reset${DIM} (clear session), ${YELLOW}/resetmemory${DIM} (clear memory), ${YELLOW}/exit${DIM} (quit)${RESET}\n`);

    const prompt = () => {
      this.rl!.question(`${GREEN}${BOLD}You > ${RESET}`, async (input) => {
        const trimmed = input.trim();

        if (!trimmed) {
          prompt();
          return;
        }

        // Handle commands
        if (trimmed === '/exit' || trimmed === '/quit') {
          console.log(`\n${MAGENTA}Goodbye! 👋${RESET}\n`);
          this.rl!.close();
          process.exit(0);
        }

        // Process message
        try {
          await handler(
            {
              sessionId: this.sessionId,
              userId: 'cli-user',
              content: trimmed,
            },
            (event) => this.logger.log(event),
          );
        } catch (err) {
          console.error(`\n\x1b[31m❌ Error: ${err instanceof Error ? err.message : err}\x1b[0m`);
        }

        console.log(''); // blank line
        prompt();
      });
    };

    prompt();

    // Keep alive
    return new Promise<void>((resolve) => {
      this.rl!.on('close', resolve);
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
