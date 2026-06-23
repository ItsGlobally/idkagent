import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalActionRowComponentBuilder,
  type Interaction,
} from 'discord.js';
import type { Gateway, MessageHandler, AgentEvent } from './types.js';
import type { AgentConfig } from '../config.js';

// ─── Discord Gateway ─────────────────────────────────────────

export class DiscordGateway implements Gateway {
  private client: Client;
  private config: AgentConfig;
  /** Per-session serial chain: each send waits for the previous one to finish */
  private sendChains: Map<string, Promise<void>> = new Map();

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
  }

  /**
   * Serialize all Discord messages for a given sessionId.
   * Each call waits for the previous send to fully complete before starting,
   * preventing chunk interleaving when onEvent is called fire-and-forget.
   */
  private enqueueSend(sessionId: string, sendFn: () => Promise<void>): Promise<void> {
    const prev = this.sendChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => sendFn()).catch(() => sendFn());
    this.sendChains.set(sessionId, next);
    return next;
  }

  private splitMessage(text: string, maxLength = 1900): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }
    return chunks;
  }

  /** Build a retry button row (Continue / Restart) */
  private buildRetryRow(sessionId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`retry_continue_${sessionId}`).setLabel('▶️ 繼續推理 (Continue)').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`retry_restart_${sessionId}`).setLabel('🔄 重新推理 (Restart)').setStyle(ButtonStyle.Danger)
    );
  }

  /** Build message options with components for a chunk, adding retry buttons on error */
  private buildChunkOptions(chunk: string, isLastChunk: boolean, isError: boolean, sessionId: string, extraComponents?: any[]): any {
    const comps = extraComponents ? [...extraComponents] : [];
    if (isError && isLastChunk) {
      comps.push(this.buildRetryRow(sessionId));
    }
    const options: any = { content: chunk };
    if (comps.length > 0) options.components = comps;
    return options;
  }

  /** Format a tool call for display: show key identifying arguments based on tool name */
  private static formatToolCall(name: string, args: Record<string, unknown> | undefined, truncateAt: number): string {
    const keyMap: Record<string, string[]> = {
      read_file: ['filePath', 'path'],
      write_file: ['filePath', 'path'],
      edit: ['filePath'],
      run_command: ['command'],
      bash: ['description', 'command'],
      credential: ['action', 'name'],
      websearch: ['query'],
      webfetch: ['url'],
      grep: ['pattern'],
      glob: ['pattern'],
      task: ['description'],
    };
    let detail = name;
    if (args) {
      const keys = keyMap[name] || [];
      const parts: string[] = [];
      for (const k of keys) {
        const v = args[k];
        if (v !== undefined && v !== null) parts.push(String(v));
      }
      if (parts.length === 0) {
        const values = Object.values(args).filter((v): v is string => typeof v === 'string' && v.length > 0);
        parts.push(...values.slice(0, 2));
      }
      if (parts.length > 0) detail += ' ' + parts.join(' ');
    }
    if (detail.length > truncateAt) detail = detail.slice(0, truncateAt);
    return `\`${detail}\``;
  }

  private async registerCommands(token: string, clientId: string): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Talk to the AI agent')
        .addStringOption((option) =>
          option
            .setName('prompt')
            .setDescription('Your message to the agent')
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset the current session context'),
      new SlashCommandBuilder()
        .setName('resetmemory')
        .setDescription("Delete the agent's permanent memory and reset session"),
    ].map((command) => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    try {
      console.log('⏳ Registering application (/) commands...');
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅ Successfully registered application (/) commands.');
    } catch (error) {
      console.error('❌ Failed to register commands:', error);
    }
  }

  async start(handler: MessageHandler): Promise<void> {
    const { token, allowedChannels } = this.config.discord;

    if (!token) {
      throw new Error(
        'Discord token not configured. Set it in config.json under discord.token or via DISCORD_TOKEN env.',
      );
    }

    await this.client.login(token);

    this.client.on('ready', async () => {
      console.log(`🤖 Discord bot logged in as ${this.client.user?.tag}`);
      console.log(`   Trigger: Slash Commands & @Mention`);
      if (this.client.user) {
        await this.registerCommands(token, this.client.user.id);
      }
    });

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (interaction.isButton() && interaction.customId.startsWith('retry_')) {
        const action = interaction.customId.startsWith('retry_continue_') ? 'retry_continue' : 'retry_restart';
        const sessionId = interaction.customId.replace(action + '_', '');

        await interaction.reply({ content: '⏳ 重試中！(Retrying...)', ephemeral: false });

        try {
          await interaction.message.edit({ components: [] });
        } catch(e) {}

        // Let the handler re-process with the existing sessionId but empty content
        // We dispatch this exactly like a message, but pass the retry action
        const sendDiscordMessage = async (msgText: string, isFinalText = false, isError = false) => {
          await this.enqueueSend(sessionId, async () => {
            const chunks = this.splitMessage(msgText);
            const ch = interaction.channel;
            for (let i = 0; i < chunks.length; i++) {
              const opts = this.buildChunkOptions(chunks[i], i === chunks.length - 1, isError, sessionId);
              if (ch && 'send' in ch) {
                await (ch as any).send(opts);
              }
            }
          });
        };

        try {
          await handler(
            { sessionId, userId: interaction.user.id, userName: interaction.user.username, content: '', action },
            async (event: AgentEvent) => {
              let msg = '';
              if (event.type === 'thinking' && this.config.logging.showThinking) {
              msg = event.content;
              } else if (event.type === 'provider_log') {
              msg = `📡 ${event.content}`;
            } else if (event.type === 'tool_call' && this.config.logging.showToolCalls) {
              const path = event.content;
              msg = `🛠️ Tool Call: ${DiscordGateway.formatToolCall(path, event.metadata?.arguments as Record<string, unknown> | undefined, this.config.logging.truncateAt)}`;
            } else if (event.type === 'tool_result' && this.config.logging.showToolResults) {
              // Tool results are hidden
            } else if (event.type === 'ask') {
              const expectedId = (event.metadata?.userId as string) || '';
              const userIdStr = expectedId ? `<@${expectedId}> ` : '';
              msg = `❓ ${userIdStr}**Question:**\n${event.content}`;
              const options = (event.metadata?.options as string[]) || [];
              const row = new ActionRowBuilder<ButtonBuilder>();
              options.forEach((opt, idx) => {
                row.addComponents(new ButtonBuilder().setCustomId(`answer_${sessionId}_${expectedId}_${idx}`).setLabel(opt.substring(0, 80)).setStyle(ButtonStyle.Primary));
              });
              row.addComponents(new ButtonBuilder().setCustomId(`answer_${sessionId}_${expectedId}_other`).setLabel('Other (自訂)').setStyle(ButtonStyle.Secondary));
            }
              let extraComps: any[] | undefined = undefined;
              if (event.type === 'text') {
                msg = event.content;
              } else if (event.type === 'error') {
                msg = `❌ **Error**: ${event.content}`;
              }
              if (msg) {
                const isFinal = event.type === 'text' || event.type === 'error';
                await sendDiscordMessage(msg, isFinal, event.type === 'error');
              }
            }
          );
        } catch (err) {
          if (interaction.channel && 'send' in interaction.channel) {
            await (interaction.channel as any).send(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return;
      }

      const processAnswer = async (sessionId: string, expectedUserId: string, answerText: string, interactionToReply: Interaction) => {
        const sendDiscordMessage = async (msgText: string, isFinalText = false, isError = false, extraComponents?: any[]) => {
          await this.enqueueSend(sessionId, async () => {
            const chunks = this.splitMessage(msgText);
            const ch = interactionToReply.channel;
            for (let i = 0; i < chunks.length; i++) {
              const opts = this.buildChunkOptions(chunks[i], i === chunks.length - 1, isError, sessionId, extraComponents);
              if (ch && 'send' in ch) {
                await (ch as any).send(opts);
              }
            }
          });
        };

        try {
          await handler(
            { sessionId, userId: interactionToReply.user.id, userName: interactionToReply.user.username, content: answerText },
            async (event: AgentEvent) => {
              let msg = '';
              let extraComps: any[] | undefined;
              if (event.type === 'thinking' && this.config.logging.showThinking) {
                msg = event.content;
              } else if (event.type === 'provider_log') {
                msg = `📡 ${event.content}`;
              } else if (event.type === 'tool_call' && this.config.logging.showToolCalls) {
                const path = event.content;
                msg = `🛠️ Tool Call: ${DiscordGateway.formatToolCall(path, event.metadata?.arguments as Record<string, unknown> | undefined, this.config.logging.truncateAt)}`;
              } else if (event.type === 'tool_result' && this.config.logging.showToolResults) {
                // Tool results are hidden
              } else if (event.type === 'ask') {
                const expectedId = (event.metadata?.userId as string) || '';
                const userIdStr = expectedId ? `<@${expectedId}> ` : '';
                msg = `❓ ${userIdStr}**Question:**\n${event.content}`;
                const options = (event.metadata?.options as string[]) || [];
                const row = new ActionRowBuilder<ButtonBuilder>();
                options.forEach((opt, idx) => {
                  row.addComponents(new ButtonBuilder().setCustomId(`answer_${sessionId}_${(event.metadata?.userId as string) || ''}_${idx}`).setLabel(opt).setStyle(ButtonStyle.Primary));
                });
                extraComps = [row];
              } else if (event.type === 'text') {
                msg = event.content;
              } else if (event.type === 'error') {
                msg = `❌ **Error**: ${event.content}`;
              }
              if (msg) {
                const isFinal = event.type === 'text' || event.type === 'error' || event.type === 'ask';
                await sendDiscordMessage(msg, isFinal, event.type === 'error', extraComps);
              }
            }
          );
        } catch (err) {
          if (interactionToReply.channel && 'send' in interactionToReply.channel) {
            await (interactionToReply.channel as any).send(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      };

      if (interaction.isButton() && interaction.customId.startsWith('answer_')) {
        const parts = interaction.customId.split('_');
        const sessionId = parts[1];
        const expectedUserId = parts[2];
        const btnType = parts[3];

        if (expectedUserId && interaction.user.id !== expectedUserId) {
          await interaction.reply({ content: '🚫 這是給另一位使用者的提問，您無法回答。', ephemeral: true });
          return;
        }

        if (btnType === 'other') {
          const modal = new ModalBuilder()
            .setCustomId(`ansmodal_${sessionId}_${expectedUserId}`)
            .setTitle('請輸入您的回答');

          const textInput = new TextInputBuilder()
            .setCustomId('answer_text')
            .setLabel('輸入回答')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

          modal.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(textInput));
          await interaction.showModal(modal);
          return;
        }

        const answerText = (interaction.component as any)?.label || 'Unknown';
        await interaction.reply({ content: `✅ 您選擇了：${answerText}`, ephemeral: false });
        if (interaction.message) {
          try { await interaction.message.edit({ components: [] }); } catch(e) {}
        }

        await processAnswer(sessionId, expectedUserId, answerText, interaction);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('ansmodal_')) {
        const parts = interaction.customId.split('_');
        const sessionId = parts[1];
        const expectedUserId = parts[2];

        if (expectedUserId && interaction.user.id !== expectedUserId) {
          await interaction.reply({ content: '🚫 這是給另一位使用者的提問，您無法回答。', ephemeral: true });
          return;
        }

        const answerText = interaction.fields.getTextInputValue('answer_text');
        await interaction.reply({ content: `✅ 您回答了：${answerText}`, ephemeral: false });
        if (interaction.message) {
          try { await interaction.message.edit({ components: [] }); } catch(e) {}
        }

        await processAnswer(sessionId, expectedUserId, answerText, interaction);
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      // Check allowed channels
      if (allowedChannels.length > 0 && !allowedChannels.includes(interaction.channelId)) {
        await interaction.reply({ content: 'I am not allowed to speak in this channel.', ephemeral: true });
        return;
      }

      const sessionId = `discord-${interaction.channelId}`;
      let content = '';

      if (interaction.commandName === 'chat') {
        content = interaction.options.getString('prompt', true);
      } else if (interaction.commandName === 'reset') {
        content = '/reset';
      } else if (interaction.commandName === 'resetmemory') {
        content = '/resetmemory';
      } else {
        return;
      }

      await interaction.reply('⏳ 任務已收到！(Task received!)');

      let hasEditedInitialReply = false;

      // Helper to dispatch chunks in real-time
      const sendDiscordMessage = async (msgText: string, isFinalText = false, isError = false, extraComponents?: any[]) => {
        await this.enqueueSend(sessionId, async () => {
          const chunks = this.splitMessage(msgText);
          for (let i = 0; i < chunks.length; i++) {
            const opts = this.buildChunkOptions(chunks[i], i === chunks.length - 1, isError, sessionId, extraComponents);

            if ((isFinalText) && !hasEditedInitialReply) {
              await interaction.editReply(opts);
              hasEditedInitialReply = true;
            } else {
              if (interaction.channel && 'send' in interaction.channel) {
                await (interaction.channel as any).send(opts);
              } else {
                await interaction.followUp(opts);
              }
            }
          }
        });
      };

      let typingInterval: NodeJS.Timeout | undefined;
      if (interaction.channel && 'sendTyping' in interaction.channel) {
        (interaction.channel as any).sendTyping().catch(() => {});
        typingInterval = setInterval(() => {
          (interaction.channel as any).sendTyping().catch(() => {});
        }, 8000);
      }

      try {
        await handler(
          { sessionId, userId: interaction.user.id, content },
          async (event: AgentEvent) => {
            let msg = '';
            let extraComps: any[] | undefined;

            if (event.type === 'thinking' && this.config.logging.showThinking) {
              msg = `💭 **Thinking...**\n\`\`\`\n${event.content}\n\`\`\``;
            } else if (event.type === 'provider_log') {
              msg = `📡 ${event.content}`;
            } else if (event.type === 'tool_call' && this.config.logging.showToolCalls) {
                const path = event.content;
                msg = `🛠️ Tool Call: ${DiscordGateway.formatToolCall(path, event.metadata?.arguments as Record<string, unknown> | undefined, this.config.logging.truncateAt)}`;
              } else if (event.type === 'tool_result' && this.config.logging.showToolResults) {
                // Tool results are hidden
              } else if (event.type === 'ask') {
                const expectedId = (event.metadata?.userId as string) || '';
                const options = (event.metadata?.options as string[]) || [];
              const row = new ActionRowBuilder<ButtonBuilder>();
              options.forEach((opt, idx) => {
                row.addComponents(new ButtonBuilder().setCustomId(`answer_${sessionId}_${expectedId}_${idx}`).setLabel(opt.substring(0, 80)).setStyle(ButtonStyle.Primary));
              });
              extraComps = [row];
            } else if (event.type === 'text') {
              msg = event.content;
            } else if (event.type === 'error') {
              msg = `❌ **Error**: ${event.content}`;
            }

            if (msg) {
              const isFinal = event.type === 'text' || event.type === 'error' || event.type === 'ask';
              await sendDiscordMessage(msg, isFinal, event.type === 'error', extraComps);
            }
          },
        );

        // No fallback edit needed since we replied immediately
      } catch (err) {
        const errorMsg = `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
        if (interaction.channel && 'send' in interaction.channel) {
          await (interaction.channel as any).send(errorMsg);
        } else {
          await interaction.followUp(errorMsg);
        }
      } finally {
        if (typingInterval) clearInterval(typingInterval);
      }
    });

    // Support legacy @mention
    this.client.on('messageCreate', async (msg) => {
      if (msg.author.bot) return;

      const botId = this.client.user?.id;
      if (!botId) return;

      const isMentioned = msg.mentions.has(botId);
      const isReplyToBot = msg.mentions.repliedUser?.id === botId;

      if (!isMentioned && !isReplyToBot) return;

      if (allowedChannels.length > 0 && !allowedChannels.includes(msg.channelId)) {
        return;
      }

      const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
      // If it's a reply and they didn't explicitly @mention in the text, the regex won't match, which is fine
      const content = msg.content.replace(mentionRegex, '').trim();
      if (!content) return;

      const sessionId = `discord-${msg.channelId}`;

      let hasRepliedToUser = false;

      const sendDiscordMessage = async (msgText: string, isFinalText = false, isError = false, extraComponents?: any[]) => {
        await this.enqueueSend(sessionId, async () => {
          const chunks = this.splitMessage(msgText);
          for (let i = 0; i < chunks.length; i++) {
            const opts = this.buildChunkOptions(chunks[i], i === chunks.length - 1, isError, sessionId, extraComponents);

            if ((isFinalText) && !hasRepliedToUser) {
              await msg.reply(opts);
              hasRepliedToUser = true;
            } else {
              await msg.channel.send(opts);
            }
          }
        });
      };

      let typingInterval: NodeJS.Timeout | undefined;
      if (msg.channel && 'sendTyping' in msg.channel) {
        (msg.channel as any).sendTyping().catch(() => {});
        typingInterval = setInterval(() => {
          (msg.channel as any).sendTyping().catch(() => {});
        }, 8000);
      }

      try {
        await handler(
          { sessionId, userId: msg.author.id, userName: msg.author.username, content },
          async (event: AgentEvent) => {
            let replyMsg = '';
            let extraComps: any[] | undefined;

            if (event.type === 'thinking' && this.config.logging.showThinking) {
              replyMsg = event.content;
            } else if (event.type === 'provider_log') {
              replyMsg = `📡 ${event.content}`;
            } else if (event.type === 'tool_call' && this.config.logging.showToolCalls) {
              const path = event.content;
              replyMsg = `🛠️ Tool Call: ${DiscordGateway.formatToolCall(path, event.metadata?.arguments as Record<string, unknown> | undefined, this.config.logging.truncateAt)}`;
            } else if (event.type === 'tool_result' && this.config.logging.showToolResults) {
              // Tool results are hidden
            } else if (event.type === 'ask') {
              const expectedId = (event.metadata?.userId as string) || '';
              const userIdStr = expectedId ? `<@${expectedId}> ` : '';
              replyMsg = `❓ ${userIdStr}**Question:**\n${event.content}`;
              const options = (event.metadata?.options as string[]) || [];
              const row = new ActionRowBuilder<ButtonBuilder>();
              options.forEach((opt, idx) => {
                row.addComponents(new ButtonBuilder().setCustomId(`answer_${sessionId}_${expectedId}_${idx}`).setLabel(opt.substring(0, 80)).setStyle(ButtonStyle.Primary));
              });
              row.addComponents(new ButtonBuilder().setCustomId(`answer_${sessionId}_${expectedId}_other`).setLabel('Other (自訂)').setStyle(ButtonStyle.Secondary));
              extraComps = [row];
            } else if (event.type === 'text') {
              replyMsg = event.content;
            } else if (event.type === 'error') {
              replyMsg = `❌ **Error**: ${event.content}`;
            }

            if (replyMsg) {
              const isFinal = event.type === 'text' || event.type === 'error' || event.type === 'ask';
              await sendDiscordMessage(replyMsg, isFinal, event.type === 'error', extraComps);
            }
          },
        );

        // No fallback edit needed since we replied immediately
      } catch (err) {
        const errorMsg = `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
        if (msg.channel && 'send' in msg.channel) {
          await (msg.channel as any).send(errorMsg);
        } else {
          await (msg.channel as any).send(errorMsg);
        }
      } finally {
        if (typingInterval) clearInterval(typingInterval);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const dispose = this.client.destroy();
      dispose.then(resolve).catch(resolve);
    });
  }
}
