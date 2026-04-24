import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingHandler } from '../chat/provider';
import { logConversationMessage } from '../queue';

export interface LocalWebhookServerOptions {
  port: number;
  verifyToken: string;
  /**
   * Meta app secret — used to HMAC-verify every inbound webhook. Required.
   * When empty, the server still listens (so the GET verification still
   * works) but every POST is rejected 503. Users must set WHATSAPP_APP_SECRET
   * in .env to enable inbound.
   */
  appSecret: string;
  operatorNumber: string;
  onMessage: IncomingHandler;
  send: (text: string) => Promise<void>;
}

/**
 * Local HTTP webhook server. Used by the WhatsApp provider when Supabase
 * isn't configured — replaces the Vercel-relay → Supabase → polling path
 * with a direct endpoint the user exposes publicly (ngrok, cloudflared,
 * own reverse proxy).
 *
 * Endpoints:
 *   GET  /health                 — liveness check (returns "ok")
 *   GET  /webhook/whatsapp       — Meta verification handshake
 *   POST /webhook/whatsapp       — incoming message payload from Meta
 *
 * All POSTs are authenticated by HMAC-SHA256 of the raw request body
 * against WHATSAPP_APP_SECRET, per Meta's X-Hub-Signature-256 spec.
 * Without this, anyone who discovers the public URL could submit crafted
 * payloads and invoke destructive slash commands (the operator phone
 * number is not a secret).
 *
 * Telegram doesn't use this — it long-polls getUpdates and needs no
 * public URL.
 */
export function startLocalWebhookServer(opts: LocalWebhookServerOptions): void {
  if (!opts.appSecret) {
    console.warn('[webhook] WHATSAPP_APP_SECRET is empty — inbound POSTs will be rejected 503 until you set it.');
  }

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) return respond(res, 400, 'bad request');
      const parsed = new URL(req.url, 'http://localhost');

      if (parsed.pathname === '/health' && req.method === 'GET') {
        return respond(res, 200, 'ok');
      }

      if (parsed.pathname === '/webhook/whatsapp' && req.method === 'GET') {
        // Meta webhook verification: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
        const mode = parsed.searchParams.get('hub.mode');
        const token = parsed.searchParams.get('hub.verify_token');
        const challenge = parsed.searchParams.get('hub.challenge');
        if (mode === 'subscribe' && token === opts.verifyToken && challenge) {
          return respond(res, 200, challenge);
        }
        return respond(res, 403, 'forbidden');
      }

      if (parsed.pathname === '/webhook/whatsapp' && req.method === 'POST') {
        const rawBody = await readBody(req);

        // If no app secret is configured, we can't verify signatures — reject
        // everything rather than accepting unauthenticated commands.
        if (!opts.appSecret) {
          return respond(res, 503, 'server misconfigured — WHATSAPP_APP_SECRET not set');
        }

        const signature = req.headers['x-hub-signature-256'];
        if (!verifyMetaSignature(rawBody, signature, opts.appSecret)) {
          return respond(res, 401, 'invalid signature');
        }

        // Always 200 quickly so Meta doesn't retry; process async.
        respond(res, 200, 'ok');
        const bodyStr = rawBody.toString('utf-8');
        handleWhatsAppWebhook(bodyStr, opts).catch((err) => {
          console.error('[webhook] handler error:', err?.message || err);
        });
        return;
      }

      return respond(res, 404, 'not found');
    } catch (err: any) {
      console.error('[webhook] request error:', err.message);
      if (!res.headersSent) respond(res, 500, 'internal error');
    }
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[webhook] port ${opts.port} in use — another process is bound. WhatsApp inbound disabled.`);
      return;
    }
    console.error('[webhook] server error:', err.message);
  });

  server.listen(opts.port, () => {
    console.log(`[webhook] listening on :${opts.port}`);
    console.log(`[webhook] WhatsApp URL: POST http://<your-public-host>:${opts.port}/webhook/whatsapp`);
  });
}

/**
 * Verify a Meta webhook's X-Hub-Signature-256 header. Returns false on
 * missing header, malformed value, hex length mismatch, or HMAC mismatch.
 * Constant-time comparison on buffers of equal length.
 */
function verifyMetaSignature(rawBody: Buffer, headerValue: string | string[] | undefined, appSecret: string): boolean {
  if (typeof headerValue !== 'string' || !headerValue.startsWith('sha256=')) return false;
  const received = headerValue.slice('sha256='.length);
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (received.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Parse a Meta WhatsApp webhook payload and dispatch any text messages
 * from the operator to the registered handler. Ignores messages from
 * non-operator senders and non-text events (reactions, status updates).
 */
async function handleWhatsAppWebhook(body: string, opts: LocalWebhookServerOptions): Promise<void> {
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return;
  }

  // Payload shape:
  // { entry: [{ changes: [{ value: { messages: [{ from, text: { body } }] }}]}]}
  const messages = data?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  for (const msg of messages) {
    const from = msg?.from;
    const text: string = msg?.text?.body || '';
    if (from !== opts.operatorNumber || !text.trim()) continue;
    try { logConversationMessage('in', text.trim()); } catch {}
    try {
      const reply = await opts.onMessage(from, text.trim());
      if (reply) await opts.send(reply);
    } catch (err: any) {
      console.error('[webhook] message handler failed:', err.message);
    }
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}
