import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readRegistry } from './project.js';
import type { ProjectLanguage } from './project.js';
import { loadConfig } from '../config.js';
import { requestJavaDiagnostics } from './jdtls_client.js';

const TIMEOUT_MS = 60_000;
const MAX_DIAG_LENGTH = 4_000;

// Find which registered project (if any) contains this file path.
function findProject(filePath: string): { language: ProjectLanguage; projectPath: string } | null {
  const registry = readRegistry();
  const abs = resolve(filePath);

  for (const entry of Object.values(registry)) {
    const projAbs = resolve(entry.path);
    if (abs.startsWith(projAbs + '\\') || abs.startsWith(projAbs + '/') || abs === projAbs) {
      return { language: entry.language, projectPath: entry.path };
    }
  }
  return null;
}

// Run TypeScript compiler diagnostics (tsc --noEmit) in the project root.
function runTscDiagnostics(projectPath: string): string | null {
  const config = loadConfig().lsp.typescript;
  if (!config || !config.enabled) return null;
  const bin = config.bin || 'tsc';

  try {
    execSync(`${bin} --noEmit`, {
      cwd: projectPath,
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null; // no errors
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    const out = ((error.stdout ?? '') + (error.stderr ?? '')).trim();
    if (!out) return null;
    return out.length > MAX_DIAG_LENGTH ? out.slice(0, MAX_DIAG_LENGTH) + '\n... (truncated)' : out;
  }
}


/**
 * Run LSP-style diagnostics for the given file path.
 * Returns a formatted diagnostic string if there are errors, or null if clean / not applicable.
 */
export async function runDiagnostics(filePath: string): Promise<string | null> {
  const project = findProject(filePath);
  if (!project) return null;

  let diag: string | null = null;

  if (project.language === 'typescript') {
    diag = runTscDiagnostics(project.projectPath);
  } else if (project.language === 'java') {
    diag = await requestJavaDiagnostics(filePath);
  }

  if (!diag) return `\n\n✅ LSP Diagnostics (${project.language}): No errors found.`;
  return `\n\n⚠️  LSP Diagnostics (${project.language}):\n${diag}`;
}
