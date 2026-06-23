import type { GatewayMessage, MessageHandler, AgentEventHandler } from './gateways/types.js';
import type { QueueConfig } from './config.js';

// ─── Queue Item ──────────────────────────────────────────────

interface QueueItem {
  message: GatewayMessage;
  handler: MessageHandler;
  eventHandler: AgentEventHandler;
  resolve: () => void;
  reject: (err: unknown) => void;
}

// ─── Message Queue ───────────────────────────────────────────

export class MessageQueue {
  private queue: QueueItem[] = [];
  private processing = 0;
  private config: QueueConfig;

  constructor(config: QueueConfig) {
    this.config = config;
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.processing;
  }

  enqueue(
    message: GatewayMessage,
    handler: MessageHandler,
    eventHandler: AgentEventHandler,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const position = this.queue.length + 1;

      // Notify the user of their queue position
      if (this.processing >= this.config.concurrency) {
        eventHandler({
          type: 'queue_status',
          content: `Message queued (position #${position}, ${this.processing} processing)`,
        });
      }

      this.queue.push({ message, handler, eventHandler, resolve, reject });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing >= this.config.concurrency || this.queue.length === 0) {
      return;
    }

    this.processing++;
    const item = this.queue.shift()!;

    try {
      item.eventHandler({
        type: 'queue_status',
        content: `Processing message... (${this.queue.length} remaining in queue)`,
      });

      await item.handler(item.message, item.eventHandler);
      item.resolve();
    } catch (err) {
      item.eventHandler({
        type: 'error',
        content: err instanceof Error ? err.message : String(err),
      });
      item.reject(err);
    } finally {
      this.processing--;
      this.processNext();
    }
  }
}
