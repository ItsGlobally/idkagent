import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.js';

export const updateMemoryTool: Tool = {
  name: 'update_memory',
  description: 'Update the permanent MEMORY.md file with important facts, user preferences, or project state. It appends the new information with a timestamp.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The information to remember.' },
    },
    required: ['content'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const content = args.content as string;
    const memoryPath = path.resolve(process.cwd(), 'MEMORY.md');
    
    let existing = '';
    if (fs.existsSync(memoryPath)) {
      existing = fs.readFileSync(memoryPath, 'utf-8');
    } else {
      existing = '# Agent Memory\n\nThis file contains permanent memories.\n\n';
    }

    const timestamp = new Date().toISOString();
    const newEntry = `\n## [${timestamp}]\n${content}\n`;
    
    fs.writeFileSync(memoryPath, existing + newEntry, 'utf-8');

    return `Successfully recorded into MEMORY.md`;
  },
};
