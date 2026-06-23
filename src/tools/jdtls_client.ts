import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadConfig } from '../config.js';

// ─── LSP Types ──────────────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message?: string;
}

// ─── State ──────────────────────────────────────────────────────

let jdtlsProcess: ChildProcess | null = null;
let messageIdCounter = 1;
let isInitialized = false;
let initializationFailed = false;

// Store pending promises for JSON-RPC requests
const pendingRequests = new Map<number, { resolve: (res: unknown) => void; reject: (err: Error) => void }>();

// Store latest diagnostics per file URI
const fileDiagnostics = new Map<string, Diagnostic[]>();

// Buffer for parsing LSP stream
let responseBuffer = '';

function sendRpcMessage(msg: Omit<JsonRpcRequest, 'jsonrpc' | 'id'>): Promise<unknown> {
  return new Promise((res, rej) => {
    if (!jdtlsProcess || !jdtlsProcess.stdin) {
      return rej(new Error('jdtls process is not running.'));
    }

    const id = messageIdCounter++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      ...msg,
    };

    const strPayload = JSON.stringify(payload);
    const framed = `Content-Length: ${Buffer.byteLength(strPayload, 'utf-8')}\r\n\r\n${strPayload}`;

    pendingRequests.set(id, { resolve: res, reject: rej });
    jdtlsProcess.stdin.write(framed, 'utf-8');
  });
}

export function sendRpcNotification(msg: Omit<JsonRpcNotification, 'jsonrpc'>): void {
  if (!jdtlsProcess || !jdtlsProcess.stdin) return;
  const payload: JsonRpcNotification = {
    jsonrpc: '2.0',
    ...msg,
  };
  const strPayload = JSON.stringify(payload);
  const framed = `Content-Length: ${Buffer.byteLength(strPayload, 'utf-8')}\r\n\r\n${strPayload}`;
  jdtlsProcess.stdin.write(framed, 'utf-8');
}

function processLspData(data: Buffer) {
  responseBuffer += data.toString('utf-8');

  while (true) {
    const headerEndIdx = responseBuffer.indexOf('\r\n\r\n');
    if (headerEndIdx === -1) break;

    const headers = responseBuffer.substring(0, headerEndIdx);
    const clMatch = headers.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) {
      // Invalid header? Try to recover by dropping it
      responseBuffer = responseBuffer.substring(headerEndIdx + 4);
      continue;
    }

    const contentLength = parseInt(clMatch[1], 10);
    const messageStartIdx = headerEndIdx + 4;

    if (Buffer.byteLength(responseBuffer, 'utf-8') < messageStartIdx + contentLength) {
      // Not enough data yet
      break;
    }

    const payloadBuffer = Buffer.from(responseBuffer, 'utf-8');
    const messageRaw = payloadBuffer.slice(messageStartIdx, messageStartIdx + contentLength).toString('utf-8');
    
    // Remove the parsed message from buffer
    const nextStart = messageStartIdx + contentLength;
    responseBuffer = payloadBuffer.slice(nextStart).toString('utf-8');

    try {
      const message = JSON.parse(messageRaw);
      handleLspMessage(message);
    } catch (e) {
      console.warn('⚠️ Failed to parse LSP message from jdtls');
    }
  }
}

function handleLspMessage(message: JsonRpcMessage): void {
  if ('id' in message && message.id !== undefined && pendingRequests.has(message.id)) {
    const { resolve, reject } = pendingRequests.get(message.id)!;
    pendingRequests.delete(message.id);

    if ('error' in message && message.error) {
      reject(new Error(message.error.message || 'LSP Error'));
    } else if ('result' in message) {
      resolve(message.result);
    }
  } else if ('method' in message && message.method === 'textDocument/publishDiagnostics') {
    const params = message.params as { uri: string; diagnostics: Diagnostic[] } | undefined;
    if (params) {
      fileDiagnostics.set(params.uri, params.diagnostics);
    }
  }
}

export async function initJdtlsIfNeeded(): Promise<void> {
  if (isInitialized) return;
  if (initializationFailed) return;

  const config = loadConfig().lsp.java;
  if (!config || !config.enabled) {
    initializationFailed = true;
    return;
  }

  const binPath = config.bin || 'jdtls';
  const workspacePath = resolve(process.cwd(), 'workspace');

  const { readRegistry } = await import('./project.js');
  const registry = readRegistry();
  const workspaceFolders = [
    { uri: `file://${workspacePath.replace(/\\/g, '/')}`, name: 'workspace' }
  ];
  for (const proj of Object.values(registry)) {
    if (proj.language === 'java') {
      workspaceFolders.push({
        uri: `file://${resolve(proj.path || '').replace(/\\/g, '/')}`,
        name: proj.name
      });
    }
  }

  try {
    jdtlsProcess = spawn(binPath, ['-data', resolve(workspacePath, '.jdtls_data')], {
      cwd: workspacePath,
      env: process.env,
      shell: process.platform === 'win32',
    });

    jdtlsProcess.on('error', (err) => {
      console.warn(`⚠️ Failed to start jdtls (${binPath}): ${err.message}. Java LSP diagnostics disabled.`);
      initializationFailed = true;
      jdtlsProcess = null;
    });

    if (!jdtlsProcess.stdout || !jdtlsProcess.stdin) {
      initializationFailed = true;
      return;
    }

    jdtlsProcess.stdout.on('data', processLspData);

    // Give it a brief moment to see if it immediately fails
    await new Promise((res) => setTimeout(res, 500));
    if (initializationFailed) return;

    // Send initialize
    await sendRpcMessage({
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: `file://${workspacePath.replace(/\\/g, '/')}`,
        workspaceFolders,
        capabilities: {
          workspace: {
            workspaceFolders: true
          }
        },
      },
    });

    sendRpcNotification({ method: 'initialized', params: {} });
    isInitialized = true;
  } catch (err) {
    console.warn(`⚠️ Failed to initialize jdtls: ${err instanceof Error ? err.message : String(err)}`);
    initializationFailed = true;
  }
  console.log(`✅ Java LSP diagnostics ${isInitialized ? 'initialized' : 'disabled'}.`);
}

export function registerJavaProjectToJdtls(path: string, name: string) {
  if (!isInitialized || !jdtlsProcess) return;
  sendRpcNotification({
    method: 'workspace/didChangeWorkspaceFolders',
    params: {
      event: {
        added: [{ uri: `file://${resolve(path || '').replace(/\\/g, '/')}`, name }],
        removed: []
      }
    }
  });
}

// Convert absolute path to file URI
function pathToFileUri(p: string): string {
  let uriPath = p.replace(/\\/g, '/');
  if (!uriPath.startsWith('/')) {
    uriPath = '/' + uriPath;
  }
  return `file://${uriPath}`;
}

export async function requestJavaDiagnostics(filePath: string): Promise<string | null> {
  await initJdtlsIfNeeded();
  if (initializationFailed || !isInitialized) return null;

  try {
    const fileUri = pathToFileUri(resolve(filePath));
    const content = readFileSync(filePath, 'utf-8');

    // Notify didOpen or didChange
    sendRpcNotification({
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: fileUri,
          languageId: 'java',
          version: 1,
          text: content,
        },
      },
    });

    // Wait up to 15 seconds for valid diagnostics
    let diags: Diagnostic[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 500));
      diags = fileDiagnostics.get(fileUri) || [];
      
      // If we got diagnostics, check if it's the temporary "non-project file" warning
      if (diags.length > 0) {
        const isNonProject = diags.some((d) => d.message && typeof d.message === 'string' && d.message.includes('non-project file'));
        if (!isNonProject) break; // We got real diagnostics!
      }
    }

    if (diags.length === 0) return null;

    return diags
      .map((d) => {
        const severity = d.severity === 1 ? 'Error' : d.severity === 2 ? 'Warning' : 'Info';
        const line = d.range.start.line + 1;
        const char = d.range.start.character + 1;
        return `[${severity}] Line ${line}:${char} - ${d.message}`;
      })
      .join('\n');
  } catch {
    return null;
  }
}
