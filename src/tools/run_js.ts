import vm from 'node:vm';
import type { Tool } from './types.js';

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_LENGTH = 10_000;

export const runJsTool: Tool = {
  name: 'run_js',
  description: [
    'Run JavaScript/Node.js code and return the result.',
    '',
    'WHEN TO USE: Only use this when you need to perform the same operation many times (batch processing, repetitive transformations, loops, generating many files with similar patterns).',
    'DO NOT use for simple operations that existing tools handle (reading one file, running one command, etc.).',
    '',
    'Examples of good use: "rename all .txt files to .md", "add an import to every file in src/", "generate 20 test files with incrementing IDs".',
    '',
    'The code runs in a sandboxed VM context with access to: console.log, JSON, Math, Date, Array, String, RegExp, Map, Set, Promise, parseInt, parseFloat, isNaN, setTimeout (promise-based), fetch (if available).',
    'For file I/O, use fs and path which are provided in the context.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript code to execute. Use console.log() to output results. The result of the last expression is NOT captured — use console.log().',
      },
    },
    required: ['code'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const code = args.code as string;

    const context: Record<string, unknown> = {
      console: { log: (...args: unknown[]) => logs.push(args.map(String).join(' ')) },
      JSON,
      Math,
      Date,
      Array,
      String,
      RegExp,
      Map,
      Set,
      Promise,
      parseInt,
      parseFloat,
      isNaN,
      setTimeout: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      Buffer,
      require,
      __dirname,
      __filename,
      process: { cwd: process.cwd, env: process.env, argv: process.argv },
      module,
      exports,
    };

    const logs: string[] = [];

    try {
      vm.runInNewContext(code, vm.createContext(context), { timeout: TIMEOUT_MS });
      const output = logs.join('\n');
      if (output.length > MAX_OUTPUT_LENGTH) {
        return output.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }
      return output || '(no output)';
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
