import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool } from './types.js';

// Credentials are stored in credentials/secrets.json
function getCredentialsPath(): string {
  return resolve(process.cwd(), '..', 'credentials', 'secrets.json');
}

function readSecrets(): Record<string, string> {
  const credPath = getCredentialsPath();
  try {
    if (!existsSync(credPath)) return {};
    const raw = readFileSync(credPath, 'utf-8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSecrets(secrets: Record<string, string>): void {
  const credPath = getCredentialsPath();
  mkdirSync(dirname(credPath), { recursive: true });
  writeFileSync(credPath, JSON.stringify(secrets, null, 2), 'utf-8');
}

export const credentialTool: Tool = {
  name: 'credential',
  description: [
    'Manage named credentials (API keys, tokens, passwords) stored securely in credentials/secrets.json.',
    'Usage:',
    '  get <name>  — Retrieve the value of a stored credential.',
    '  set <name>  — Store or update a credential value.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set'],
        description: 'The operation to perform: "get" to retrieve a credential, "set" to store one.',
      },
      name: {
        type: 'string',
        description: 'The credential name/key (e.g. "github_token", "openai_key").',
      },
      value: {
        type: 'string',
        description: 'The credential value. Required when action is "set".',
      },
    },
    required: ['action', 'name'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const name = args.name as string;

    if (action === 'get') {
      const secrets = readSecrets();
      if (!(name in secrets)) {
        return `Credential "${name}" not found. Use credential set to store it first.`;
      }
      return secrets[name];
    }

    if (action === 'set') {
      const value = args.value as string | undefined;
      if (value === undefined) {
        throw new Error('value is required when action is "set".');
      }
      const secrets = readSecrets();
      if (value === '') {
        delete secrets[name];
        writeSecrets(secrets);
        return `Credential "${name}" removed successfully.`;
      }
      secrets[name] = value;
      writeSecrets(secrets);
      return `Credential "${name}" saved successfully.`;
    }

    throw new Error(`Unknown action "${action}". Use "get" or "set".`);
  },
};
