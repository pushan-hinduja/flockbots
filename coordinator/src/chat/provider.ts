/** Handler invoked by a ChatProvider when an inbound message arrives. */
export type IncomingHandler = (from: string, text: string) => Promise<string | null>;

/**
 * Abstraction over the chat backend (Telegram or WhatsApp). All outbound
 * notifications flow through send() / sendMedia(). Inbound messages are
 * delivered to the handler registered via start().
 */
export interface ChatProvider {
  readonly name: 'telegram' | 'whatsapp' | 'slack';

  /** Verify credentials work. Called once at startup; throws on failure. */
  healthCheck(): Promise<void>;

  /** Send a text message to the operator. */
  send(text: string): Promise<void>;

  /** Send an image or video with caption. Falls back to text on failure. */
  sendMedia(caption: string, mediaUrl: string, type: 'image' | 'video'): Promise<void>;

  /** Start receiving messages. Non-blocking; polling runs in background. */
  start(onMessage: IncomingHandler): Promise<void>;
}
