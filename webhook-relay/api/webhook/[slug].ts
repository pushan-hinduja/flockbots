import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';

// Vercel filesystem routing: this file matches /api/webhook/<anything>.
// The slug is the last path segment — each FlockBots instance gets its own
// URL (e.g. /api/webhook/acme-app, /api/webhook/my-blog) and the relay
// stamps `instance_id=<slug>` on every webhook_inbox insert so the right
// coordinator picks it up.
export const config = { runtime: 'edge' };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function extractSlug(req: Request): string | null {
  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean);
  // Expected shape: ["api", "webhook", "<slug>"]
  const slug = segments[segments.length - 1];
  if (!slug || slug.length < 2 || slug.length > 32) return null;
  if (!SLUG_RE.test(slug)) return null;
  return slug;
}

export default async function handler(req: Request): Promise<Response> {
  const slug = extractSlug(req);
  if (!slug) {
    return new Response('Invalid instance slug', { status: 400 });
  }

  // GET — Meta webhook verification. The verify token is shared across all
  // instances (one relay, one Vercel project, one env var) — the slug in
  // the URL is what makes this endpoint per-instance, not the token.
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // POST — Incoming WhatsApp message → write to Supabase for the
  // matching coordinator to poll.
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const entries = body?.entry || [];

      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const messages = change?.value?.messages || [];
          for (const msg of messages) {
            if (msg.type !== 'text') continue;

            await supabase.from('webhook_inbox').insert({
              instance_id: slug,
              source: 'whatsapp',
              sender: msg.from,
              payload: { text: msg.text?.body || '', message_id: msg.id, timestamp: msg.timestamp },
            });
          }
        }
      }
    } catch (err) {
      console.error('Webhook processing error:', err);
    }

    // Always return 200 — Meta requires it within 5 seconds
    return new Response('OK', { status: 200 });
  }

  return new Response('Method not allowed', { status: 405 });
}
