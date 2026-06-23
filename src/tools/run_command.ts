import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { Tool } from './types.js';

const asyncExec = promisify(exec);

const MAX_OUTPUT_LENGTH = 10_000;
const TIMEOUT_MS = 30_000;

export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Execute a shell command and return the combined stdout and stderr output. Defaults to running inside workspace/. Note: On Windows, this runs in cmd.exe. Use `powershell -Command ...` for PowerShell.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      cwd: { type: 'string', description: 'Working directory for the command. Defaults to workspace/.' },
    },
    required: ['command'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command as string;
    const cwd = args.cwd
      ? resolve(args.cwd as string)
      : resolve(process.cwd(), 'workspace');

    try {
      const { stdout, stderr } = await asyncExec(command, {
        cwd,
        timeout: TIMEOUT_MS,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const result = (stdout ?? '') + (stderr ?? '');
      if (result.length > MAX_OUTPUT_LENGTH) {
        return result.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }
      return result || '(no output)';
    } catch (err: unknown) {
      const error = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      const stdout = error.stdout ?? '';
      const stderr = error.stderr ?? '';
      let combined = `Command exited with code ${error.code ?? 'unknown'}\n`;
      combined += stdout + stderr;

      if (combined.length > MAX_OUTPUT_LENGTH) {
        return combined.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }
      return combined;
    }
  },
};
