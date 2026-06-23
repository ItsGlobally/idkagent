import type { Gateway } from './types.js';
import type { AgentConfig } from '../config.js';
import { getEnabledPlatforms } from '../config.js';
import { CLIGateway } from './cli.js';
import { DiscordGateway } from './discord.js';

const PLATFORM_MAP: Record<string, new (config: AgentConfig) => Gateway> = {
  discord: DiscordGateway,
};

/**
 * Create gateway instances for all enabled platforms.
 * CLI is handled separately by the `chat` command.
 */
export function createGateways(config: AgentConfig): Gateway[] {
  const platforms = getEnabledPlatforms(config);
  const gateways: Gateway[] = [];

  for (const platform of platforms) {
    const Ctor = PLATFORM_MAP[platform];
    if (Ctor) {
      gateways.push(new Ctor(config));
    } else {
      console.warn(`⚠️  Unknown gateway platform: "${platform}". Skipping.`);
    }
  }

  return gateways;
}

export { CLIGateway } from './cli.js';
export { DiscordGateway } from './discord.js';
export type { Gateway, GatewayMessage, AgentEvent, AgentEventHandler, MessageHandler } from './types.js';
