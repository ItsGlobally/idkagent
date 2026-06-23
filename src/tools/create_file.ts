import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from './types.js';
import { runDiagnostics } from './lsp.js';
import { triggerJavaReindex } from './java_index_trigger.js';

function resolveWorkspacePath(p: string): string {
  if (p.startsWith('~')) {
    p = p.replace('~', homedir());
  }
  if (isAbsolute(p)) return p;
  return resolve(process.cwd(), 'workspace', p);
}

export const createFileTool: Tool = {
  name: 'create_file',
  description: 'Create a new file with the given content. Parent directories are created automatically. Relative paths resolve inside workspace/.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path for the new file. Relative paths resolve inside workspace/.' },
      content: { type: 'string', description: 'The text content to write to the file.' },
    },
    required: ['path', 'content'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = resolveWorkspacePath(args.path as string);
    const content = args.content as string;

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
      let result = `File created successfully: ${filePath}`;
      const diag = await runDiagnostics(filePath);
      if (diag) result += diag;
      const reindex = triggerJavaReindex(filePath);
      if (reindex) result += reindex;
      return result;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      throw new Error(`Failed to create file: ${error.message}`);
    }
  },
};
