import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const apiKey = config.providers.gemini.apiKey;

const ai = new GoogleGenAI({ apiKey });

async function main() {
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite', // LSP test change - hello owl
    contents: [
      { role: 'user', parts: [{ text: 'List the files in the current directory' }] }
    ],
    config: {
      tools: [{
        functionDeclarations: [{
          name: 'list_dir',
          description: 'List directory',
          parameters: {
            type: Type.OBJECT,
            properties: { path: { type: Type.STRING } },
            required: ['path']
          }
        }]
      }]
    }
  });

  const part = response.candidates?.[0]?.content?.parts?.[0];
  console.log('Response part keys:', Object.keys(part || {}));
  console.log('Full part:', JSON.stringify(part, null, 2));

  // Now try to send it back
  const response2 = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: [
      { role: 'user', parts: [{ text: 'List the files in the current directory' }] },
      { role: 'model', parts: [
        { 
          functionCall: { name: 'list_dir', args: { path: '.' } },
          thoughtSignature: part?.thoughtSignature // Try camelCase
        }
      ] as any },
      { role: 'user', parts: [
        { functionResponse: { name: 'list_dir', response: { result: '[]' } } }
      ] }
    ]
  });
  console.log('Response 2:', response2.candidates?.[0]?.content?.parts?.[0]);
}
main().catch(console.error);
