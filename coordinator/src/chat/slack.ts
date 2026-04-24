import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import type { ChatProvider, IncomingHandler } from './provider';
import { logConversationMessage } from '../queue';

const MAX_TEXT_LENGTH = 3500;

/**
 * Slack provider using Socket Mode for inbound (no public URL / webhook
 * needed — like Telegram's long-polling) and the Web API for outbound.
 *
 * Messages go to a single configured channel. Anyone in that channel can
 * talk to the bot; bot messages are ignored to avoid echo loops. For v1 we
 * don't filter by user — the channel itself is the access boundary.
 */
export class SlackProvider implements ChatProvider {
  readonly name = 'slack' as const;
  private web: WebClient;
  private socket: SocketModeClient;
  private channelId: string;

  constructor() {
    const botToken = process.env.SLACK_BOT_TOKEN || '';
    const appToken = process.env.SLACK_APP_TOKEN || '';
    this.channelId = process.env.SLACK_CHANNEL_ID || '';
    if (!botToken) throw new Error('SLACK_BOT_TOKEN is required for CHAT_PROVIDER=slack');
    if (!appToken) throw new Error('SLACK_APP_TOKEN is required for CHAT_PROVIDER=slack');
    if (!this.channelId) throw new Error('SLACK_CHANNEL_ID is required for CHAT_PROVIDER=slack');
    this.web = new WebClient(botToken);
    this.socket = new SocketModeClient({ appToken });
  }

  async healthCheck(): Promise<void> {
    const res = await this.web.auth.test();
    if (!res.ok) {
      throw new Error(`Slack auth.test failed: ${res.error || 'unknown error'}`);
    }
  }

  async send(text: string): Promise<void> {
    const truncated = text.length > MAX_TEXT_LENGTH
      ? text.slice(0, MAX_TEXT_LENGTH) + '\n\n[truncated — full in dashboard]'
      : text;
    const res = await this.web.chat.postMessage({
      channel: this.channelId,
      text: truncated,
    });
    if (!res.ok) throw new Error(`Slack send failed: ${res.error || 'unknown error'}`);
    try { logConversationMessage('out', truncated); } catch {}
  }

  async sendMedia(caption: string, mediaUrl: string, _type: 'image' | 'video'): Promise<void> {
    // Slack renders inline previews for signed URLs that look like images/
    // videos, so posting link+caption is usually enough. A proper files.upload
    // path is future work.
    await this.send(`${caption}\n${mediaUrl}`);
  }

  async start(onMessage: IncomingHandler): Promise<void> {
    // Socket Mode emits events with a normalized shape. `event.type === 'message'`
    // for any channel message; we filter to our channel and ignore bot echoes.
    this.socket.on('message', async ({ event, ack }: any) => {
      try { await ack?.(); } catch {}
      if (!event || typeof event !== 'object') return;
      if (event.channel !== this.channelId) return;
      if (event.bot_id || event.subtype === 'bot_message') return;
      const text = typeof event.text === 'string' ? event.text.trim() : '';
      if (!text) return;
      try { logConversationMessage('in', text); } catch {}
      try {
        const reply = await onMessage(event.user || 'slack', text);
        if (reply) await this.send(reply);
      } catch (err: any) {
        console.error('[slack] message handler error:', err.message);
      }
    });

    this.socket.on('error', (err: any) => {
      console.error('[slack] socket error:', err?.message || err);
    });

    await this.socket.start();
    console.log(`Slack provider started (channel=${this.channelId})`);
  }
}
