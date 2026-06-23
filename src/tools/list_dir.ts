import { readdirSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from './types.js';

function resolveWorkspacePath(p: string): string {
  if (p.startsWith('~')) {
    p = p.replace('~', homedir());
  }
  if (isAbsolute(p)) return p;
  const workspace = resolve(process.cwd(), 'workspace');
  if (p === '.' || p === '') return workspace;
  return resolve(workspace, p);
}

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List the contents of a directory, showing files and subdirectories with sizes. Defaults to the workspace/ directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to list. Relative paths resolve inside workspace/. Defaults to workspace/ if omitted.' },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = (args.path as string | undefined) ?? '.';
    const dirPath = resolveWorkspacePath(rawPath);

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });

      if (entries.length === 0) {
        return `Directory is empty: ${dirPath}`;
      }

      const lines = entries.map((entry) => {
        if (entry.isDirectory()) {
          return `[DIR]  ${entry.name}/`;
        }
        try {
          const stats = statSync(join(dirPath, entry.name));
          return `[FILE] ${entry.name} (${stats.size} bytes)`;
        } catch {
          return `[FILE] ${entry.name} (size unknown)`;
        }
      });

      return `Contents of ${dirPath}:\n` + lines.join('\n');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      if (error.code === 'ENOTDIR') {
        throw new Error(`Not a directory: ${dirPath}`);
      }
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  },
};
