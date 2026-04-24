import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // GET — Meta webhook verification
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // POST — Incoming WhatsApp message → write to Supabase for Mac Mini to poll
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
