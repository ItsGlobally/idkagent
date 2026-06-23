// ─── Tool Interface ──────────────────────────────────────────

import type { AgentEventHandler } from '../gateways/types.js';

export interface ToolContext {
  sessionId: string;
  onEvent?: AgentEventHandler;
  dispatchMessage: (content: string) => void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  execute: (args: Record<string, any>, context: ToolContext) => Promise<string>;
}
