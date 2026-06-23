import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { Tool } from './types.js';

// ─── Types ─────────────────────────────────────────────────────

export type ProjectLanguage = 'typescript' | 'java';

export interface ProjectEntry {
  name: string;
  path: string;
  language: ProjectLanguage;
  createdAt: string;
}

export type ProjectRegistry = Record<string, ProjectEntry>;

// ─── Language Normalization ─────────────────────────────────────

const LANGUAGE_ALIASES: Record<string, ProjectLanguage> = {
  ts: 'typescript',
  typescript: 'typescript',
  java: 'java',
};

function normalizeLanguage(raw: string): ProjectLanguage {
  const normalized = LANGUAGE_ALIASES[raw.toLowerCase().trim()];
  if (!normalized) {
    throw new Error(
      `Unknown language "${raw}". Supported: ts, typescript, java`,
    );
  }
  return normalized;
}

// ─── Registry I/O ──────────────────────────────────────────────

export function getProjectsFilePath(): string {
  return resolve(process.cwd(), 'projects.json');
}

export function readRegistry(): ProjectRegistry {
  const p = getProjectsFilePath();
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf-8')) as ProjectRegistry;
  } catch {
    return {};
  }
}

function writeRegistry(registry: ProjectRegistry): void {
  const p = getProjectsFilePath();
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(registry, null, 2), 'utf-8');
}

// ─── Tool ──────────────────────────────────────────────────────

export const projectTool: Tool = {
  name: 'project',
  description: [
    'Manage development projects registered in projects.json.',
    '',
    'Actions:',
    '  create <name> <language>  — Create a new project folder in workspace/ and register it.',
    '  import <name> <language>  — Register an existing folder as a project.',
    '  update <name> [language] [path] — Update an existing project registration.',
    '  remove <name>             — Unregister a project (does not delete files).',
    '  get    <name>             — Show info about a registered project.',
    '  list                      — List all registered projects.',
    '',
    'Language aliases: ts / typescript, java',
    '',
    'Examples:',
    '  project {"action": "create", "name": "TestTS", "language": "ts"}',
    '  project {"action": "import", "name": "Plugin", "language": "java", "path": "C:/projects/Plugin"}',
    '  project {"action": "get", "name": "TestTS"}',
    '  project {"action": "list"}',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'import', 'update', 'remove', 'get', 'list'],
        description: 'The operation to perform.',
      },
      name: {
        type: 'string',
        description: 'Project name. Required for create, import, update, remove, get.',
      },
      language: {
        type: 'string',
        description: 'Project language: "ts" / "typescript" or "java". Required for create and import.',
      },
      path: {
        type: 'string',
        description: 'Absolute path to project folder. Optional for create (defaults to workspace/<name>/). Optional for import (defaults to workspace/<name>/).',
      },
    },
    required: ['action'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const registry = readRegistry();

    // ── list ───────────────────────────────────────────────────
    if (action === 'list') {
      const entries = Object.values(registry);
      if (entries.length === 0) return 'No projects registered yet.';
      return entries
        .map(
          (e) =>
            `• ${e.name}  [${e.language}]  ${e.path}  (created ${e.createdAt.slice(0, 10)})`,
        )
        .join('\n');
    }

    // ── actions requiring name ─────────────────────────────────
    const name = args.name as string | undefined;
    if (!name) throw new Error('"name" is required for this action.');

    // ── get ────────────────────────────────────────────────────
    if (action === 'get') {
      const entry = registry[name];
      if (!entry) return `Project "${name}" not found. Use list to see all projects.`;
      return JSON.stringify(entry, null, 2);
    }

    // ── create / import  ───────────────────────────────────────
    if (action === 'create' || action === 'import') {
      const rawLang = args.language as string | undefined;
      if (!rawLang) throw new Error('"language" is required for create and import.');
      const language = normalizeLanguage(rawLang);

      const rawPath = args.path as string | undefined;
      const projectPath: string = rawPath
        ? isAbsolute(rawPath)
          ? rawPath
          : resolve(process.cwd(), 'workspace', rawPath)
        : resolve(process.cwd(), 'workspace', name);

      if (action === 'create') {
        mkdirSync(projectPath, { recursive: true });
      } else if (!existsSync(projectPath)) {
        throw new Error(`Path does not exist: ${projectPath}`);
      }

      if (registry[name]) {
        return `Project "${name}" already registered. Use get to see its info.`;
      }

      const entry: ProjectEntry = {
        name,
        path: projectPath,
        language,
        createdAt: new Date().toISOString(),
      };
      registry[name] = entry;
      writeRegistry(registry);

      if (language === 'java') {
        const { registerJavaProjectToJdtls } = await import('./jdtls_client.js');
        registerJavaProjectToJdtls(projectPath, name);
      }

      return `Project "${name}" ${action === 'create' ? 'created' : 'imported'} successfully.\n${JSON.stringify(entry, null, 2)}`;
    }

    // ── update ─────────────────────────────────────────────────
    if (action === 'update') {
      const entry = registry[name];
      if (!entry) return `Project "${name}" not found.`;

      const rawLang = args.language as string | undefined;
      if (rawLang) {
        entry.language = normalizeLanguage(rawLang);
      }

      const rawPath = args.path as string | undefined;
      if (rawPath) {
        entry.path = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), 'workspace', rawPath);
      }

      writeRegistry(registry);
      return `Project "${name}" updated successfully.\n${JSON.stringify(entry, null, 2)}`;
    }

    // ── remove ─────────────────────────────────────────────────
    if (action === 'remove') {
      if (!registry[name]) return `Project "${name}" not found.`;
      delete registry[name];
      writeRegistry(registry);
      return `Project "${name}" removed from registry.`;
    }

    throw new Error(`Unknown action "${action}".`);
  },
};
