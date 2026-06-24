// ─── Gateway Types ───────────────────────────────────────────

export interface GatewayStartOptions {
  /** Called when a user wants to stop/cancel the current conversation for a given session */
  cancelSession?: (sessionId: string) => void;
}

export interface GatewayMessage {
  sessionId: string;
  userId: string;
  userName?: string;
  content: string;
  action?: 'retry_continue' | 'retry_restart' | 'gateway_restarted' | 'stop';
  /** Gateway platform identifier, e.g. 'discord', 'cli' */
  gateway?: string;
}

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'error' | 'queue_status' | 'ask' | 'provider_log';
  content: string;
  metadata?: Record<string, unknown>;
}

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

export type MessageHandler = (
  message: GatewayMessage,
  eventHandler: AgentEventHandler,
) => Promise<void>;

export interface Gateway {
  start(handler: MessageHandler, options?: GatewayStartOptions): Promise<void>;
  stop(): Promise<void>;
  /**
   * Optional: Create an event handler for a recovered session.
   * Used during gateway restart recovery to route model responses
   * back through the appropriate gateway channel/platform.
   * Returns null if this gateway cannot handle the given session.
   */
  createSessionEventHandler?(sessionId: string): Promise<AgentEventHandler | null>;
}
