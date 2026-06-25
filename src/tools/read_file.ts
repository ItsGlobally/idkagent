import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { WORKSPACE_DIR } from '../config.js';
import type { Tool } from './types.js';

function resolveWorkspacePath(p: string): string {
  if (p.startsWith('~')) {
    p = p.replace('~', homedir());
  }
  if (isAbsolute(p)) return p;
  return resolve(WORKSPACE_DIR, p);
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file at the given path. Relative paths resolve inside workspace/.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file to read. Relative paths resolve inside workspace/.' },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = resolveWorkspacePath(args.path as string);

    try {
      const content = readFileSync(filePath, 'utf-8');
      return content;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        throw new Error(`File not found: ${filePath}`);
      }
      if (error.code === 'EACCES') {
        throw new Error(`Permission denied: ${filePath}`);
      }
      throw new Error(`Failed to read file: ${error.message}`);
    }
  },
};
