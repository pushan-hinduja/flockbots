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
    // Store the full message — the activity tape's expand-on-click reads
    // event.message verbatim. Previously sliced to 100 chars, which left
    // expand showing a mid-word cutoff for any non-trivial notification.
    // SQLite TEXT is unbounded; the dashboard CSS handles visual
    // truncation while the row is collapsed.
    logEvent(null, 'notifier', 'chat_sent', message);
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
    // Full caption stored — see notifyOperator for rationale.
    logEvent(null, 'notifier', 'chat_media_sent', `${type}: ${caption}`);
  } catch (err: any) {
    console.error('Chat media send failed:', err.message);
    logEvent(null, 'notifier', 'chat_media_fallback', `${type} failed, sent text: ${err.message || ''}`);
    await notifyOperator(`${caption}\nMedia: ${mediaUrl}`);
  }
}
