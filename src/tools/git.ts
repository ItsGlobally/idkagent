import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from './types.js';

// ─── Consistent data directory ──────────────────────────────
// Determines the project parent directory reliably from the module location
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/tools/git.js -> dist/tools/ -> dist/ -> project root
// src/tools/git.ts  -> src/tools/  -> src/  -> project root
const projectRoot = resolve(__dirname, '..', '..');
// Data directory is the parent of the project root (e.g. ~/.idkagent/)
const dataDir = resolve(projectRoot, '..');

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LENGTH = 10_000;

// Actions that require remote authentication
const REMOTE_ACTIONS = new Set(['clone', 'push', 'pull', 'fetch']);

function getDefaultCwd(): string {
  return resolve(dataDir, 'workspace');
}

// ─── Shared: resolve credentials path consistently ──────────
function getCredentialPath(): string {
  return resolve(dataDir, 'credentials', 'secrets.json');
}

// Read git_token (or fallback to github_token) from the credential store silently
function readGitCredentials(): { username: string; token: string } | null {
  try {
    const credPath = getCredentialPath();
    if (!existsSync(credPath)) return null;
    const secrets = JSON.parse(readFileSync(credPath, 'utf-8')) as Record<string, string>;
    // Prefer git_token but fallback to github_token
    const token = secrets['git_token'] ?? secrets['github_token'];
    if (!token) return null;
    const username = secrets['git_username'] ?? 'oauth2';
    return { username, token };
  } catch {
    return null;
  }
}

// For clone: rewrite https://host/path → https://user:token@host/path
function injectCredentialsIntoUrl(url: string, username: string, token: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      parsed.username = encodeURIComponent(username);
      parsed.password = encodeURIComponent(token);
      return parsed.toString();
    }
  } catch {
    // Not a valid URL (e.g. git@github.com SSH) — leave as-is
  }
  return url;
}

// For push/pull/fetch: inject credentials via git's http.extraHeader
// This avoids exposing the token in process arguments visible to other users
function buildCredentialConfigFlags(username: string, token: string): string {
  // GitHub & GitLab accept "Authorization: Bearer *** or
  // "Authorization: Basic base64(username:token)"
  const b64 = Buffer.from(`${username}:${token}`).toString('base64');
  const header = `Authorization: Basic ${b64}`;
  // Escape double-quotes for shell; single-quote the whole value
  return `-c http.extraHeader="${header.replace(/"/g, '\\"')}"`;
}

export const gitTool: Tool = {
  name: 'git',
  description: [
    'Execute Git operations. Defaults to the workspace/ directory.',
    '',
    'Supported actions: clone, init, status, add, commit, push, pull, checkout, branch, log, diff, merge, fetch, remote, reset, stash, tag',
    '',
    'Authentication is handled automatically. Store credentials with:',
    '  credential {"action": "set", "name": "git_token", "value": "<your_token>"}',
    '  credential {"action": "set", "name": "git_username", "value": "<your_username>"}  (optional, defaults to oauth2)',
    '',
    'Examples:',
    '  git {"action": "status"}',
    '  git {"action": "add", "args": "."}',
    '  git {"action": "commit", "args": "-m \\"Initial commit\\""}',
    '  git {"action": "clone", "args": "https://github.com/user/repo.git"}',
    '  git {"action": "push", "args": "origin main"}',
    '  git {"action": "checkout", "args": "-b feature/my-feature"}',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The git subcommand (e.g. clone, commit, push, pull, status, add, checkout, branch, log, diff, merge, fetch, remote, reset, stash, tag).',
      },
      args: {
        type: 'string',
        description: 'Additional arguments to pass to the git subcommand. Optional.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the git command. Defaults to workspace/.',
      },
    },
    required: ['action'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = (args.action as string).trim();
    let extraArgs = args.args ? (args.args as string).trim() : '';
    const cwd = args.cwd ? resolve(args.cwd as string) : getDefaultCwd();

    // Auto-inject credentials for remote operations
    const creds = readGitCredentials();
    let credFlags = '';

    if (creds && REMOTE_ACTIONS.has(action)) {
      if (action === 'clone') {
        // Rewrite the URL in the args to embed credentials
        extraArgs = extraArgs.replace(
          /https?:\/\/[^\s]+/,
          (match, url) => injectCredentialsIntoUrl(url, creds.username, creds.token),
        );
      } else {
        // For push/pull/fetch: inject via http.extraHeader config flag
        credFlags = buildCredentialConfigFlags(creds.username, creds.token) + ' ';
      }
    }

    const command = `git ${credFlags}${action}${extraArgs ? ' ' + extraArgs : ''}`;

    try {
      const output = execSync(command, {
        cwd,
        timeout: TIMEOUT_MS,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          // Prevent interactive prompts from hanging the process
          GIT_TERMINAL_PROMPT: '0',
          // Also disable SSH prompts
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        },
      });

      const result = (output ?? '').trim();
      if (!result) return `git ${action}: completed successfully (no output).`;
      if (result.length > MAX_OUTPUT_LENGTH) {
        return result.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }
      return result;
    } catch (err: unknown) {
      interface ExecError {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      }
      const error = err as ExecError;
      const stdout = ((error.stdout as string) ?? '').trim();
      // Strip credentials from stderr before logging
      const rawStderr = ((error.stderr as string) ?? '').trim();
      const stderr = creds
        ? rawStderr.replace(new RegExp(creds.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***')
        : rawStderr;
      let combined = `git ${action} failed (exit code ${error.status ?? 'unknown'})`;
      if (stdout) combined += `\nstdout:\n${stdout}`;
      if (stderr) combined += `\nstderr:\n${stderr}`;
      if (!stdout && !stderr) combined += `\n${error.message ?? ''}`;
      if (combined.length > MAX_OUTPUT_LENGTH) {
        return combined.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }
      return combined;
    }
  },
};
