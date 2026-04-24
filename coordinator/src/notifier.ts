import type { ChatProvider } from './chat/provider';
import { logEvent } from './queue';

let chatProvider: ChatProvider | null = null;

/** Register the active ChatProvider at startup. */
export function setChatProvider(p: ChatProvider): void {
  chatProvider = p;
}

/** Send a text notification to the operator via the configured chat provider. */
export async function notifyOperator(message: string): Promise<void> {
  if (!chatProvider) {
    console.log('[Notification]', message);
    return;
  }
  try {
    await chatProvider.send(message);
    logEvent(null, 'notifier', 'chat_sent', message.slice(0, 100));
  } catch (err: any) {
    console.error('Chat send failed:', err.message);
    console.log('[Notification]', message);
  }
}

/**
 * Send an image or short video to the operator with a caption. Used by the
 * QA pipeline to ship pass/fail screenshots. mediaUrl must be publicly
 * reachable (signed Supabase Storage URL is fine).
 *
 * Falls back to a text notification with the media URL if the media send
 * fails — pipeline never blocks on chat availability.
 */
export async function notifyOperatorMedia(
  caption: string,
  mediaUrl: string,
  type: 'image' | 'video',
): Promise<void> {
  if (!chatProvider) {
    console.log('[Notification — media]', type, mediaUrl, caption);
    return;
  }
  try {
    await chatProvider.sendMedia(caption, mediaUrl, type);
    logEvent(null, 'notifier', 'chat_media_sent', `${type}: ${caption.slice(0, 60)}`);
  } catch (err: any) {
    console.error('Chat media send failed:', err.message);
    logEvent(null, 'notifier', 'chat_media_fallback', `${type} failed, sent text: ${err.message?.slice(0, 100)}`);
    await notifyOperator(`${caption}\nMedia: ${mediaUrl}`);
  }
}
