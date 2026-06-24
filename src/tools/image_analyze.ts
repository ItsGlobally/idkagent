import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import type { Tool } from './types.js';

export interface ImageAnalyzeToolOptions {
  apiKey: string;
  model: string;
}

/**
 * Analyze an image using Gemini's vision capabilities.
 * Supports two modes:
 * - URL: Downloads from a URL and sends to Gemini
 * - Local file path: Reads the local file (useful after download_attachment)
 */
export const imageAnalyzeTool = (options: ImageAnalyzeToolOptions): Tool => {
  const ai = new GoogleGenAI({ apiKey: options.apiKey });
  const model = options.model;

  // MIME type mapping from file extension
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    svg: 'image/svg+xml', tiff: 'image/tiff', ico: 'image/x-icon',
  };

  return {
    name: 'analyze_image',
    description: 'Analyze an image using Gemini\'s vision capabilities. Accepts either a URL to download from, or a local file path (e.g. after using download_attachment). Returns detailed description, text extraction (OCR), and visual analysis.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL of the image to analyze',
        },
        filePath: {
          type: 'string',
          description: 'Local file path of the image (useful after downloading attachment)',
        },
        prompt: {
          type: 'string',
          description: 'A prompt describing what to analyze or extract from the image. If not provided, Gemini will generate a general description.',
        },
      },
      required: ['url', 'filePath'],
    },

    async execute(args: Record<string, unknown>, _context: any): Promise<string> {
      let url = args.url as string;
      const filePath = args.filePath as string;
      const prompt = (args.prompt as string) || 'Describe this image in detail.';

      // Validate that at least one input is provided
      if (!url && !filePath) {
        throw new Error('Either url or filePath is required for analyze_image.');
      }

      let buffer: Buffer;
      let contentType: string;

      if (filePath) {
        // Read from local file
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }
        buffer = fs.readFileSync(filePath);
        // Determine MIME type from file extension
        const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
        contentType = mimeMap[ext] || 'image/png';
      } else {
        // Download from URL
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch image: HTTP ${res.status}`);
        }
        buffer = Buffer.from(await res.arrayBuffer());
        contentType = res.headers.get('content-type') || 'image/png';
      }

      const base64Data = buffer.toString('base64');

      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  data: base64Data,
                  mimeType: contentType,
                },
              },
            ],
          }],
        });

        const candidate = response.candidates?.[0];
        if (!candidate?.content?.parts) {
          return 'No analysis results found.';
        }

        let result = '';
        for (const part of candidate.content.parts) {
          if ((part as any).text) {
            result += (part as any).text;
          }
        }

        return result.trim() || 'Gemini returned an empty response.';
      } catch (err) {
        throw new Error(`Image analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
};
