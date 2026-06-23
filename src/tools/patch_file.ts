import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
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

export const patchFileTool: Tool = {
  name: 'patch_file',
  description: 'Search for an exact string in a file and replace it with new content. Relative paths resolve inside workspace/.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to patch. Relative paths resolve inside workspace/.' },
      search: { type: 'string', description: 'The exact string to search for in the file.' },
      replace: { type: 'string', description: 'The string to replace the search match with.' },
    },
    required: ['path', 'search', 'replace'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = resolveWorkspacePath(args.path as string);
    const search = args.search as string;
    const replace = args.replace as string;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      throw new Error(`Failed to read file: ${error.message}`);
    }

    if (!content.includes(search)) {
      throw new Error(`Search string not found in ${filePath}`);
    }

    const updated = content.replace(search, replace);
    writeFileSync(filePath, updated, 'utf-8');

    let result = `Patched ${filePath}: replaced "${search.length > 60 ? search.slice(0, 60) + '...' : search}" with "${replace.length > 60 ? replace.slice(0, 60) + '...' : replace}"`;
    const diag = await runDiagnostics(filePath);
    if (diag) result += diag;
    const reindex = triggerJavaReindex(filePath);
    if (reindex) result += reindex;
    return result;
  },
};
