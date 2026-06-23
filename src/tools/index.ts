import type { Tool } from './types.js';
import { readFileTool } from './read_file.js';
import { createFileTool } from './create_file.js';
import { patchFileTool } from './patch_file.js';
import { listDirTool } from './list_dir.js';
import { runCommandTool } from './run_command.js';
import { updateMemoryTool } from './update_memory.js';
import { credentialTool } from './credential.js';
import { gitTool } from './git.js';
import { projectTool } from './project.js';
import { askTool } from './ask.js';
import { runJsTool } from './run_js.js';
import { fetchTool } from './fetch.js';
import {
  javaIndexTool,
  javaFindMethodTool,
  javaFindClassTool,
  javaShowClassTool,
  javaShowMethodTool,
  javaIndexInfoTool,
  javaIndexClearTool,
} from './java_indexer.js';
import { createSearchTool } from './search.js';

export function getAllTools(searchOptions?: { apiKey: string; model: string }): Tool[] {
  const tools: Tool[] = [
    readFileTool,
    createFileTool,
    patchFileTool,
    listDirTool,
    runCommandTool,
    updateMemoryTool,
    credentialTool,
    gitTool,
    projectTool,
    askTool,
    runJsTool,
    fetchTool,
    javaIndexTool,
    javaFindMethodTool,
    javaFindClassTool,
    javaShowClassTool,
    javaShowMethodTool,
    javaIndexInfoTool,
    javaIndexClearTool,
  ];

  if (searchOptions?.apiKey) {
    tools.push(createSearchTool(searchOptions));
  }

  return tools;
}
