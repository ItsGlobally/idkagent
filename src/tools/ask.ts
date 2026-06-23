import type { Tool } from './types.js';

export const askTool: Tool = {
  name: 'ask',
  description: [
    'Ask the user a question and provide multiple choice options.',
    'This tool will pause execution, send an interactive prompt to the user, and wait for their choice before continuing.',
    'Usage: ask {"question": "Should I proceed?", "options": ["Yes", "No", "Cancel"]}',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'A list of possible answers for the user to choose from. Max 5 options due to Discord button limits. Only the user can click the buttons, and the agent will wait for their response before continuing. If other users (even the owners) click the buttons, the agent will ignore their input and wait for the original user to respond.',
      },
    },
    required: ['question', 'options'],
  },

  async execute(args: Record<string, unknown>, context): Promise<string> {
    const question = args.question as string;
    const options = args.options as string[];

    if (!Array.isArray(options) || options.length === 0) {
      throw new Error('You must provide an array of at least 1 option.');
    }
    if (options.length > 5) {
      throw new Error('Discord only supports up to 5 buttons per action row. Please provide 5 or fewer options.');
    }

    // Validate that options is a non-empty array of strings
    if (typeof options !== 'object' || Array.isArray(options) === false || options.length === 0) {
      throw new Error('options must be a non-empty array of strings.');
    }
    for (const opt of options) {
      if (typeof opt !== 'string') {
        throw new Error('Each option must be a string.');
      }
    }

    // We can extract userId if the sessionId is a Discord session: "discord-channelId-userId"
    // But even if not, the gateway will handle formatting the message.
    let userId = '';
    if (context.sessionId.startsWith('discord-')) {
      const parts = context.sessionId.split('-');
      if (parts.length >= 3) {
        userId = parts[2];
      }
    }

    if (context.onEvent) {
      await context.onEvent({
        type: 'ask',
        content: question,
        metadata: {
          options,
          userId,
        },
      });
    }

    // Returning this string will become the tool_result in the agent's context.
    // The agent will likely read this and stop trying to take further actions, waiting for the user's response.
    return `[Question sent to user: "${question}"]\nI have asked the user and presented the options. I must now STOP using tools and wait for the user to reply.`;
  },
};
