import type { ChatProvider } from './provider';
import { TelegramProvider } from './telegram';
import { SlackProvider } from './slack';
import { WhatsAppProvider } from '../../../whatsapp/bot';

export type { ChatProvider, IncomingHandler } from './provider';

/**
 * Factory: picks the chat provider based on CHAT_PROVIDER env var.
 * Throws with a clear message if unset or invalid.
 */
export function getChatProvider(): ChatProvider {
  const raw = (process.env.CHAT_PROVIDER || '').toLowerCase().trim();
  if (!raw) {
    throw new Error('CHAT_PROVIDER is required. Set it to "telegram", "slack", or "whatsapp".');
  }
  if (raw === 'telegram') return new TelegramProvider();
  if (raw === 'slack') return new SlackProvider();
  if (raw === 'whatsapp') return new WhatsAppProvider();
  throw new Error(`Unknown CHAT_PROVIDER: "${raw}". Use "telegram", "slack", or "whatsapp".`);
}
