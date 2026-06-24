import { GoogleGenAI } from '@google/genai';
import type { Tool } from './types.js';

export interface ImageAnalyzeToolOptions {
  apiKey: string;
  model: string;
}

/**
 * Analyze an image using Gemini's vision capabilities.
 * Downloads the image from the provided URL and sends it to Gemini for analysis.
 */
export const imageAnalyzeTool = (options: ImageAnalyzeToolOptions): Tool => {
  const ai = new GoogleGenAI({ apiKey: options.apiKey });
  const model = options.model;

  return {
    name: 'analyze_image',
    description: 'Analyze an image using Gemini\'s vision capabilities. Downloads the image from a URL and sends it to Gemini for analysis. Returns a detailed description, text extraction (OCR), and visual analysis of the image.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL of the image to analyze',
        },
        prompt: {
          type: 'string',
          description: 'A prompt describing what to analyze or extract from the image. If not provided, Gemini will generate a general description.',
        },
      },
      required: ['url'],
    },

    async execute(args: Record<string, unknown>, _context: any): Promise<string> {
      const url = args.url as string;
      const prompt = (args.prompt as string) || 'Describe this image in detail.';

      if (!url) {
        throw new Error('Image URL is required for analyze_image.');
      }

      // Download the image
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch image: HTTP ${res.status}`);
      }

      const buf = await res.arrayBuffer();
      const buffer = Buffer.from(buf);

      // Determine MIME type from content-type header or magic bytes
      const contentType = res.headers.get('content-type') || 'image/png';
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
