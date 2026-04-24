import type { ChatProvider, IncomingHandler } from '../coordinator/src/chat/provider';
import { getSupabaseClient } from '../coordinator/src/supabase-sync';
import { logConversationMessage } from '../coordinator/src/queue';
import { startLocalWebhookServer } from '../coordinator/src/webhook/server';

const POLL_INTERVAL_MS = 3000;
const MAX_TEXT_LENGTH = 4000;
const DEFAULT_WEBHOOK_PORT = 3001;

/**
 * WhatsApp Cloud API provider. Outbound via Meta's Graph API. Inbound via
 * Supabase webhook_inbox polling (populated by the Vercel relay). If
 * Supabase isn't configured, outbound still works but inbound is disabled
 * — a local HTTP webhook server (Phase 1g) will close that gap.
 */
export class WhatsAppProvider implements ChatProvider {
  readonly name = 'whatsapp' as const;
  private phoneId: string;
  private token: string;
  private operatorNumber: string;

  constructor() {
    this.phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    this.token = process.env.WHATSAPP_ACCESS_TOKEN || '';
    this.operatorNumber = process.env.OPERATOR_WHATSAPP_NUMBER || '';
    if (!this.phoneId || !this.token || !this.operatorNumber) {
      throw new Error(
        'WhatsApp provider requires WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, and OPERATOR_WHATSAPP_NUMBER'
      );
    }
  }

  private messagesEndpoint(): string {
    return `https://graph.facebook.com/v21.0/${this.phoneId}/messages`;
  }

  async healthCheck(): Promise<void> {
    const res = await fetch(`https://graph.facebook.com/v21.0/${this.phoneId}?fields=id`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WhatsApp healthcheck failed (${res.status}): ${body}`);
    }
  }

  async send(text: string): Promise<void> {
    const truncated = text.length > MAX_TEXT_LENGTH
      ? text.slice(0, MAX_TEXT_LENGTH) + '\n\n[truncated — full in dashboard]'
      : text;
    const res = await fetch(this.messagesEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: this.operatorNumber,
        type: 'text',
        text: { body: truncated },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
    }
    try { logConversationMessage('out', truncated); } catch {}
  }

  async sendMedia(caption: string, mediaUrl: string, type: 'image' | 'video'): Promise<void> {
    const cap = caption.length > 1024 ? caption.slice(0, 1024) + '…' : caption;
    const payload = type === 'image'
      ? {
          messaging_product: 'whatsapp',
          to: this.operatorNumber,
          type: 'image',
          image: { link: mediaUrl, caption: cap },
        }
      : {
          messaging_product: 'whatsapp',
          to: this.operatorNumber,
          type: 'video',
          video: { link: mediaUrl, caption: cap },
        };
    const res = await fetch(this.messagesEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WhatsApp media send failed (${res.status}): ${body}`);
    }
  }

  async start(onMessage: IncomingHandler): Promise<void> {
    const supabase = getSupabaseClient();

    // Fallback path: no Supabase → stand up a local HTTP server for Meta
    // webhooks. Users expose this via ngrok / cloudflared / reverse proxy
    // and register the public URL in the Meta Business dashboard.
    if (!supabase) {
      const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
      if (!verifyToken) {
        console.warn('[whatsapp] WHATSAPP_VERIFY_TOKEN not set — local webhook server not started. Outbound only.');
        return;
      }
      const port = Number(process.env.WHATSAPP_WEBHOOK_PORT) || DEFAULT_WEBHOOK_PORT;
      const appSecret = process.env.WHATSAPP_APP_SECRET || '';
      startLocalWebhookServer({
        port,
        verifyToken,
        appSecret,
        operatorNumber: this.operatorNumber,
        onMessage,
        send: (text) => this.send(text),
      });
      console.log(`[whatsapp] inbound via local webhook server on :${port} (no Supabase)`);
      return;
    }

    const poll = async () => {
      try {
        const { data: messages, error } = await supabase
          .from('webhook_inbox')
          .select('*')
          .eq('processed', false)
          .eq('source', 'whatsapp')
          .order('created_at', { ascending: true })
          .limit(10);

        if (error || !messages) return;

        for (const msg of messages) {
          const from = msg.sender;
          const text: string = msg.payload?.text || '';
          if (from !== this.operatorNumber || !text.trim()) {
            await supabase.from('webhook_inbox').update({ processed: true }).eq('id', msg.id);
            continue;
          }
          // Mark processed BEFORE running the handler to prevent duplicate
          // execution if the handler is slow and the next poll fires.
          await supabase.from('webhook_inbox').update({ processed: true }).eq('id', msg.id);
          try { logConversationMessage('in', text.trim()); } catch {}
          try {
            const reply = await onMessage(from, text.trim());
            if (reply) await this.send(reply);
          } catch (err: any) {
            console.error('[whatsapp] message handler error:', err.message);
          }
        }
      } catch (err: any) {
        console.error('[whatsapp] poll error:', err.message);
      }
    };

    setInterval(poll, POLL_INTERVAL_MS);
    await poll();
    console.log(`WhatsApp provider started (polling Supabase every ${POLL_INTERVAL_MS / 1000}s)`);
  }
}
