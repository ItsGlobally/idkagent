import { GoogleGenAI } from '@google/genai';
import type { Tool } from './types.js';

// ─── Search Tool Options ─────────────────────────────────────

export interface SearchToolOptions {
  apiKey: string;
  model: string;
}

// ─── Create Search Tool ──────────────────────────────────────

export function createSearchTool(options: SearchToolOptions): Tool {
  const ai = new GoogleGenAI({ apiKey: options.apiKey });
  const model = options.model;

  return {
    name: 'search',
    description: 'Search the web for up-to-date information using Google Search. Use this when you need current events, recent data, or facts beyond your knowledge.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to look up on the web',
        },
      },
      required: ['query'],
    },

    async execute(args: Record<string, unknown>, _context: any): Promise<string> {
      const query = args.query as string;
      if (!query) throw new Error('Search query is required.');

      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: `Search the web for: ${query}` }] }],
          config: {
            tools: [{ googleSearch: {} }],
          },
        });

        const candidate = response.candidates?.[0];
        if (!candidate?.content?.parts) {
          return 'No search results found.';
        }

        let result = '';
        for (const part of candidate.content.parts) {
          if ((part as any).text) {
            result += (part as any).text;
          }
        }

        // Add grounding sources if available
        const grounding = (candidate as any)?.groundingMetadata;
        if (grounding?.groundingChunks) {
          const sources = grounding.groundingChunks
            .filter((chunk: any) => chunk.web?.uri)
            .map((chunk: any) => `- ${chunk.web.title || 'Source'}: ${chunk.web.uri}`);
          if (sources.length > 0) {
            result += '\n\n**Sources:**\n' + sources.join('\n');
          }
        }

        return result.trim() || 'No search results found.';
      } catch (err) {
        throw new Error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
