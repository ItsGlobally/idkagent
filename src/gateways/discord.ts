import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalActionRowComponentBuilder,
  type Interaction,
} from 'discord.js';
import type { Gateway, GatewayStartOptions, MessageHandler, AgentEvent } from './types.js';
import type { AgentConfig } from '../config.js';
import { saveConfig } from '../config.js';

// ─── Discord Gateway ─────────────────────────────────────────

export class DiscordGateway implements Gateway {
  private client: Client;
  private config: AgentConfig;
  /** Stored handler reference for slash commands that dispatch through the queue */
  private handler!: MessageHandler;
  /** Callback to cancel a running session (bypasses the queue) */
  private cancelSession?: (sessionId: string) => void;
  /** Per-session serial chain: each send waits for the previous one to finish */
  private sendChains: Map<string, Promise<void>> = new Map();
  /** Set to true during shutdown to prevent sends after client is destroyed */
  private destroyed = false;

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
   * During shutdown (destroyed=true), sends are silently dropped.
   */
  private enqueueSend(sessionId: string, sendFn: () => Promise<void>): Promise<void> {
    if (this.destroyed) return Promise.resolve();

    const prev = this.sendChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => {
      if (this.destroyed) return;
      return sendFn();
    }).catch((err) => {
      if (this.destroyed) return;
      return sendFn();
    });
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
    const ourCommands = [
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset the current session context'),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('Select or change the AI model')
        .addStringOption((option) =>
          option.setName('provider').setDescription('Provider name (e.g. gemini, openrouter)').setRequired(false))
        .addStringOption((option) =>
          option.setName('model').setDescription('Model name (e.g. gemini-2.5-flash)').setRequired(false)),
      new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop the current conversation'),
    ];

    const ourNames = new Set(ourCommands.map((c) => c.name));
    const commandsJson = ourCommands.map((c) => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);

    try {
      // Step 1: Fetch existing global commands
      console.log('🔍 Fetching existing global commands...');
      const existing: any[] = await rest.get(Routes.applicationCommands(clientId)) as any[];

      // Step 2: Delete commands that don't belong to us
      const toDelete = existing.filter((cmd) => !ourNames.has(cmd.name));
      if (toDelete.length > 0) {
        console.log(`🗑️  Deleting ${toDelete.length} command(s) not created by this agent...`);
        for (const cmd of toDelete) {
          console.log(`   - Deleting /${cmd.name} (${cmd.id})`);
          try {
            await rest.delete(Routes.applicationCommand(clientId, cmd.id));
          } catch (e) {
            console.warn(`   ⚠️  Failed to delete /${cmd.name}: ${e}`);
          }
        }
        console.log(`✅ Removed ${toDelete.length} foreign command(s).`);
      } else {
        console.log('✅ No foreign commands to delete.');
      }

      // Step 3: Register our commands
      console.log('⏳ Registering application (/) commands...');
      await rest.put(Routes.applicationCommands(clientId), { body: commandsJson });
      console.log(`✅ ${ourCommands.length} command(s) registered successfully.`);
    } catch (error) {
      console.error('❌ Failed to register commands:', error);
    }
  }

  async start(handler: MessageHandler, options?: GatewayStartOptions): Promise<void> {
    this.handler = handler;
    this.cancelSession = options?.cancelSession;
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
      // ── Model Selection: provider pick (dropdown) ────────
      if (interaction.isStringSelectMenu() && interaction.customId === 'cfg_prov_select') {
        const state = DiscordGateway.modelSelectionState.get(interaction.user.id);
        if (!state) {
          await interaction.reply({ content: '❌ Session expired. Please run `/model` again.', ephemeral: true });
          return;
        }

        const providerName = interaction.values[0];
        const provider = this.config.providers[providerName];
        await interaction.deferUpdate();

        // Fetch models
        let models: string[] = [];
        try {
          if (provider.type === 'gemini' && provider.apiKey) {
            models = await DiscordGateway.fetchGeminiModels(provider.apiKey);
          } else if (provider.type === 'openai-compatible' && provider.baseURL && provider.apiKey) {
            models = await DiscordGateway.fetchOpenAIModels(provider.baseURL, provider.apiKey);
          }
        } catch (e) {
          // ignore
        }

        if (models.length === 0) {
          // Show a modal for manual entry
          const cleanName = providerName.replace(/[^a-zA-Z0-9_-]/g, '');
          const modal = new ModalBuilder()
            .setCustomId(`model_manual_${cleanName}`)
            .setTitle(`Enter model name for ${providerName}`);

          const input = new TextInputBuilder()
            .setCustomId('model_name')
            .setLabel('Model name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

          modal.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(input));
          await interaction.followUp({ content: '⚙️ No models auto-detected. Please enter the model name manually.', ephemeral: true });
          await interaction.showModal(modal);
          return;
        }

        // Build model selection dropdown (max 25 options per Discord limit)
        const displayModels = models.length > 25 ? models.slice(0, 25) : models;
        const modelSelect = new StringSelectMenuBuilder()
          .setCustomId('cfg_model_select')
          .setPlaceholder('Select a model...')
          .addOptions(
            displayModels.map((m) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(m.length > 100 ? m.substring(0, 97) + '…' : m)
                .setValue(m),
            ),
          );

        state.models = models;
        state.selectedProvider = providerName;
        DiscordGateway.modelSelectionState.set(interaction.user.id, state);

        await interaction.editReply({
          content: `**Select a model from \`${providerName}\`:**${models.length > 25 ? '\n*(showing first 25 of ' + models.length + ' models)*' : ''}`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect)],
        });
        return;
      }

      // ── Model Selection: model pick (dropdown) ──────────
      if (interaction.isStringSelectMenu() && interaction.customId === 'cfg_model_select') {
        const state = DiscordGateway.modelSelectionState.get(interaction.user.id);
        if (!state || !state.selectedProvider) {
          await interaction.reply({ content: '❌ Session expired. Please run `/model` again.', ephemeral: true });
          return;
        }

        const modelName = interaction.values[0];
        const providerName = state.selectedProvider;

        // Update config
        this.config.models.main.provider = providerName;
        this.config.models.main.model = modelName;
        saveConfig(this.config);

        DiscordGateway.modelSelectionState.delete(interaction.user.id);

        await interaction.update({
          content: `✅ Model updated to **${modelName}** (via \`${providerName}\`)`,
          components: [],
        });
        return;
      }

      // ── Model Manual Modal Submit ───────────────────────
      if (interaction.isModalSubmit() && interaction.customId.startsWith('model_manual_')) {
        const cleanName = interaction.customId.replace('model_manual_', '');
        const state = DiscordGateway.modelSelectionState.get(interaction.user.id);
        if (!state || !state.selectedProvider) {
          await interaction.reply({ content: '❌ Session expired. Please run `/model` again.', ephemeral: true });
          return;
        }
        const modelName = interaction.fields.getTextInputValue('model_name').trim();
        if (!modelName) {
          await interaction.reply({ content: '❌ Model name cannot be empty.', ephemeral: true });
          return;
        }
        const providerName = state.selectedProvider;
        this.config.models.main.provider = providerName;
        this.config.models.main.model = modelName;
        saveConfig(this.config);
        DiscordGateway.modelSelectionState.delete(interaction.user.id);
        await interaction.reply({ content: `✅ Model updated to **${modelName}** (via \`${providerName}\`)`, components: [] });
        return;
      }

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
            { sessionId, userId: interaction.user.id, userName: interaction.user.username, content: '', action, gateway: 'discord' },
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
            { sessionId, userId: interactionToReply.user.id, userName: interactionToReply.user.username, content: answerText, gateway: 'discord' },
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

      if (interaction.commandName === 'model') {
        await this.handleModelCommand(interaction);
        return;
      } else if (interaction.commandName === 'reset') {
        // Handle /reset — send to agent
        await interaction.reply('⏳ 任務已收到！(Task received!)');
        const content = '/reset';
        await this.processSlashCommand(sessionId, interaction, content);
        return;
      } else if (interaction.commandName === 'stop') {
        // Handle /stop — cancel the current conversation immediately (bypass queue)
        await interaction.reply('⏹️ 正在停止對話... (Stopping conversation...)');
        if (this.cancelSession) {
          this.cancelSession(sessionId);
        } else {
          // Fallback: send through queue with stop action
          await this.handler(
            { sessionId, userId: interaction.user.id, content: '', action: 'stop', gateway: 'discord' },
            () => {},
          );
        }
        return;
      } else {
        return;
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
          { sessionId, userId: msg.author.id, userName: msg.author.username, content, gateway: 'discord' },
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

  /**
   * Create an event handler for a recovered session (gateway restart recovery).
   * Parses the channel ID from the session ID (format: "discord-{channelId}")
   * and returns an AgentEventHandler that sends messages to that channel.
   * Returns null if the channel cannot be resolved.
   */
  async createSessionEventHandler(sessionId: string): Promise<import('./types.js').AgentEventHandler | null> {
    const prefix = 'discord-';
    if (!sessionId.startsWith(prefix)) return null;
    const channelId = sessionId.substring(prefix.length);

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return null;

      const textChannel = channel as any;

      return async (event: import('./types.js').AgentEvent) => {
        if (this.destroyed) return;

        let msg = '';
        if (event.type === 'thinking' && this.config.logging.showThinking) {
          msg = event.content;
        } else if (event.type === 'provider_log') {
          msg = `📡 ${event.content}`;
        } else if (event.type === 'tool_call' && this.config.logging.showToolCalls) {
          msg = `🛠️ Tool Call: ${DiscordGateway.formatToolCall(event.content, event.metadata?.arguments as Record<string, unknown> | undefined, this.config.logging.truncateAt)}`;
        } else if (event.type === 'text') {
          msg = event.content;
        } else if (event.type === 'error') {
          msg = `❌ **Error**: ${event.content}`;
        }

        if (msg) {
          const chunks = this.splitMessage(msg);
          for (const chunk of chunks) {
            try {
              if (this.destroyed) return;
              await textChannel.send(chunk);
            } catch (e) {
              // Ignore send errors during recovery
            }
          }
        }
      };
    } catch (err) {
      console.error(`[Discord Recovery] Failed to create event handler for session ${sessionId}:`, err);
      return null;
    }
  }

  // ─── Model Selection State (keyed by userId) ─────────────
  private static modelSelectionState = new Map<string, {
    providerNames: string[];
    models?: string[];
    selectedProvider?: string;
  }>();

  /** Process a slash command through the handler (used by /reset) */
  private async processSlashCommand(
    sessionId: string,
    interaction: any,
    content: string,
  ): Promise<void> {
    let hasEditedInitialReply = false;

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
      await this.handler(
        { sessionId, userId: interaction.user.id, content, gateway: 'discord' },
        async (event: AgentEvent) => {
          let msg = '';
          let extraComps: any[] | undefined;

          if (event.type === 'thinking' && this.config.logging.showThinking) {
            msg = `💭 **Thinking...**\n\`\`\`\n${event.content}\n\`\`\``;
          } else if (event.type === 'provider_log') {
            msg = `📡 ${event.content}`;
          } else if (event.type === 'tool_call' && this.config.logging.showToolCalls) {
            msg = `🛠️ Tool Call: ${DiscordGateway.formatToolCall(event.content, event.metadata?.arguments as Record<string, unknown> | undefined, this.config.logging.truncateAt)}`;
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
  }

  /** Handle the /model slash command */
  private async handleModelCommand(interaction: any): Promise<void> {
    const provider = interaction.options.getString('provider');
    const model = interaction.options.getString('model');

    // ── Case: both provider and model provided ─────────────
    if (provider && model) {
      if (!this.config.providers[provider]) {
        await interaction.reply({ content: `❌ Provider \`${provider}\` not found in config.`, ephemeral: true });
        return;
      }
      this.config.models.main.provider = provider;
      this.config.models.main.model = model;
      saveConfig(this.config);
      await interaction.reply({ content: `✅ Model updated to **${model}** (via \`${provider}\`)`, ephemeral: false });
      return;
    }

    // ── Case: no args — show provider dropdown ──────────
    const providerNames = Object.keys(this.config.providers).filter(p => this.config.providers[p].apiKey);
    if (providerNames.length === 0) {
      await interaction.reply({ content: '❌ No providers with API keys configured. Run `idkagent setup` first.', ephemeral: true });
      return;
    }

    // Store state for this user
    DiscordGateway.modelSelectionState.set(interaction.user.id, { providerNames });

    // Build provider selection dropdown
    const select = new StringSelectMenuBuilder()
      .setCustomId('cfg_prov_select')
      .setPlaceholder('Choose a provider...')
      .addOptions(
        providerNames.map((name) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(name)
            .setValue(name)
            .setDescription(`Switch to ${name} provider`),
        ),
      );

    await interaction.reply({
      content: '**Select a provider:**',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      ephemeral: false,
    });
  }

  /** Fetch models from Gemini API */
  private static async fetchGeminiModels(apiKey: string): Promise<string[]> {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods: string[] }> };
      if (!data.models) return [];
      return data.models
        .filter((m) => m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => m.name.replace('models/', ''))
        .filter((name) => !name.includes('-thinking') && !name.includes('-flash-lite'))
        .sort();
    } catch {
      return [];
    }
  }

  /** Fetch models from an OpenAI-compatible API */
  private static async fetchOpenAIModels(baseURL: string, apiKey: string): Promise<string[]> {
    try {
      const url = baseURL.replace(/\/+$/, '') + '/models';
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { data?: Array<{ id: string }> };
      if (!data.data) return [];
      const models = data.data.map((m) => m.id).filter(Boolean).sort();
      return models.length > 50 ? models.slice(0, 50) : models;
    } catch {
      return [];
    }
  }

  async stop(): Promise<void> {
    // 1. Prevent new sends from being enqueued
    this.destroyed = true;

    // 2. Wait for all pending send chains to flush (tool calls, thinking, text chunks, etc.)
    const pendingSends = Array.from(this.sendChains.values());
    if (pendingSends.length > 0) {
      console.log(`📤 Waiting for ${pendingSends.length} pending Discord message(s) to be sent...`);
      await Promise.allSettled(pendingSends);
      console.log(`✅ All pending Discord messages flushed.`);
    }

    // 3. Now safe to clear and destroy
    this.sendChains.clear();
    await this.client.destroy();
  }
}
