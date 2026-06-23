import type { Tool } from './types.js';

const MAX_SIZE = 512_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_LENGTH = 10_000;

export const fetchTool: Tool = {
  name: 'fetch',
  description: 'Fetch a URL and return its content as text. Supports HTTP and HTTPS URLs. Useful for reading API documentation, web pages, or raw text files from the internet. Optional timeout parameter controls how long to wait (in ms, default 15000).',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 15000).' },
    },
    required: ['url'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    const timeoutMs = (args.timeout as number) || DEFAULT_TIMEOUT_MS;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error('Only HTTP and HTTPS URLs are supported.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const isText = contentType.startsWith('text/') ||
        contentType.includes('json') ||
        contentType.includes('xml') ||
        contentType.includes('javascript') ||
        contentType.includes('yaml') ||
        !contentType;

      if (!isText) {
        return `Content-Type "${contentType}" is not text. Cannot display.`;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_SIZE) {
        return `Response too large (${contentLength} bytes > ${MAX_SIZE} limit).`;
      }

      const text = await response.text();
      if (text.length > MAX_OUTPUT_LENGTH) {
        return text.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }
      return text || '(empty response)';
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms.`);
      }
      throw new Error(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  },
};
