// ─── Gateway Types ───────────────────────────────────────────

export interface GatewayMessage {
  sessionId: string;
  userId: string;
  userName?: string;
  content: string;
  action?: 'retry_continue' | 'retry_restart';
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
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
}
