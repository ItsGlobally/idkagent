import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.js';
import { AGENT_HOME } from '../config.js';

export interface AttachmentInfo {
  url: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Download a file from a URL to the workspace attachments directory.
 */
async function downloadFile(url: string, fileName: string): Promise<string> {
  const downloadDir = path.join(AGENT_HOME, 'attachments');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const safeName = fileName.replace(/[^\w\-.]/g, '_');
  const localPath = path.join(downloadDir, safeName);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: HTTP ${res.status}`);

  const buf = await res.arrayBuffer();
  fs.writeFileSync(localPath, Buffer.from(buf));

  return localPath;
}

export const attachDownloadTool: Tool = {
  name: 'download_attachment',
  description: 'Download a Discord attachment (image, document, etc.) from its URL to the local workspace. Use this when you need to read, analyze, or manipulate a file that was attached by a user. Returns the local file path.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL of the attachment file',
      },
      fileName: {
        type: 'string',
        description: 'Desired file name for the downloaded file',
      },
    },
    required: ['url', 'fileName'],
  },

  async execute(args: Record<string, unknown>, _context: any): Promise<string> {
    const url = args.url as string;
    const fileName = args.fileName as string;

    if (!url || !fileName) {
      throw new Error('Both url and fileName are required for download_attachment.');
    }

    const localPath = await downloadFile(url, fileName);
    return `✅ Downloaded attachment to:\n\`${localPath}\`\n\nYou can now use other tools (read_file, run_command, etc.) to operate on this file.`;
  },
};

