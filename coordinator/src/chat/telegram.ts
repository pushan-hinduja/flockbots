import type { ChatProvider, IncomingHandler } from './provider';
import { db, logConversationMessage } from '../queue';

// Telegram's long-poll wait parameter (seconds). Shorter = more getUpdates
// round trips; longer = keeps the connection open waiting for messages.
const LONG_POLL_TIMEOUT_S = 25;
const POLL_BACKOFF_MS = 5_000;
const MAX_TEXT_LENGTH = 4000; // Telegram limit is 4096; leave margin for suffix

/**
 * Telegram Bot provider. Uses long-polling (getUpdates) — no webhook / public
 * URL required, which is why Telegram is the "easy" chat path vs WhatsApp.
 *
 * Offset persistence: Telegram re-delivers the last ~24h of updates on
 * restart if offset=0. We persist the last-seen update_id in the SQLite
 * system_health table so restarts don't replay stale commands.
 */
export class TelegramProvider implements ChatProvider {
  readonly name = 'telegram' as const;
  private token: string;
  private chatId: string;
  private offset = 0;
  private running = false;

  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    if (!this.token) throw new Error('TELEGRAM_BOT_TOKEN is required for CHAT_PROVIDER=telegram');
    if (!this.chatId) throw new Error('TELEGRAM_CHAT_ID is required for CHAT_PROVIDER=telegram');
  }

  private endpoint(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async healthCheck(): Promise<void> {
    const res = await fetch(this.endpoint('getMe'));
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram healthcheck failed (${res.status}): ${body}`);
    }
  }

  async send(text: string): Promise<void> {
    const truncated = text.length > MAX_TEXT_LENGTH
      ? text.slice(0, MAX_TEXT_LENGTH) + '\n\n[truncated — full in dashboard]'
      : text;
    const res = await fetch(this.endpoint('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: truncated }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram send failed (${res.status}): ${body}`);
    }
    try { logConversationMessage('out', truncated); } catch {}
  }

  async sendMedia(caption: string, mediaUrl: string, type: 'image' | 'video'): Promise<void> {
    const cap = caption.length > 1024 ? caption.slice(0, 1024) + '…' : caption;
    const method = type === 'image' ? 'sendPhoto' : 'sendVideo';
    const payload = type === 'image'
      ? { chat_id: this.chatId, photo: mediaUrl, caption: cap }
      : { chat_id: this.chatId, video: mediaUrl, caption: cap };
    const res = await fetch(this.endpoint(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram media send failed (${res.status}): ${body}`);
    }
  }

  async start(onMessage: IncomingHandler): Promise<void> {
    await this.initOffset();
    this.running = true;
    this.pollLoop(onMessage).catch(err => {
      console.error('[telegram] poll loop crashed:', err);
    });
    console.log(`Telegram provider started (chat_id=${this.chatId}, offset=${this.offset})`);
  }

  /**
   * Load persisted offset. If none, fetch the most recent update_id with
   * offset=-1 limit=1 and use update_id+1 as our high-watermark — this
   * ensures we don't replay historical messages on first boot.
   */
  private async initOffset(): Promise<void> {
    const row = db.prepare("SELECT value FROM system_health WHERE key = ?").get('telegram_offset') as { value: string } | undefined;
    if (row) {
      this.offset = Number(row.value) || 0;
      return;
    }
    try {
      const res = await fetch(`${this.endpoint('getUpdates')}?offset=-1&limit=1&timeout=0`);
      if (res.ok) {
        const data = await res.json() as { result?: Array<{ update_id: number }> };
        if (data.result && data.result.length > 0) {
          this.offset = data.result[0].update_id + 1;
        }
      }
    } catch (err: any) {
      console.warn('[telegram] failed to establish initial offset:', err.message);
    }
    this.persistOffset();
  }

  private async pollLoop(onMessage: IncomingHandler): Promise<void> {
    while (this.running) {
      try {
        const url = `${this.endpoint('getUpdates')}?offset=${this.offset}&timeout=${LONG_POLL_TIMEOUT_S}&allowed_updates=%5B%22message%22%5D`;
        const res = await fetch(url);
        if (!res.ok) {
          console.error(`[telegram] getUpdates failed: ${res.status}`);
          await sleep(POLL_BACKOFF_MS);
          continue;
        }
        const data = await res.json() as {
          result?: Array<{
            update_id: number;
            message?: { chat: { id: number }; text?: string; from?: { id: number } };
          }>;
        };
        if (!data.result || data.result.length === 0) continue;

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;
          // Only respond to messages in the configured chat
          if (String(msg.chat.id) !== this.chatId) continue;
          const text = msg.text.trim();
          if (!text) continue;
          try { logConversationMessage('in', text); } catch {}
          try {
            const reply = await onMessage(this.chatId, text);
            if (reply) await this.send(reply);
          } catch (err: any) {
            console.error('[telegram] message handler error:', err.message);
          }
        }
        this.persistOffset();
      } catch (err: any) {
        console.error('[telegram] poll error:', err.message);
        await sleep(POLL_BACKOFF_MS);
      }
    }
  }

  private persistOffset(): void {
    db.prepare(
      'INSERT INTO system_health (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run('telegram_offset', String(this.offset), Date.now());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
