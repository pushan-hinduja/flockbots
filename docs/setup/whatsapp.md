# WhatsApp Setup Guide

Full walkthrough for wiring WhatsApp as your FlockBots chat provider. Takes ~30–40 minutes start to finish.

---

## Prerequisites

- A Meta/Facebook account (personal login is fine — you'll create a Business account from it)
- A mobile phone number to receive a verification SMS (Meta lets you use your own personal number for the test phase)
- Supabase project — FlockBots routes inbound WhatsApp messages through a webhook-relay that writes to Supabase, so this is required for the WhatsApp path
- Vercel account (free tier is fine)

The FlockBots `flockbots init` wizard will prompt you for everything below and auto-deploy the webhook-relay. This guide is for if you want to know what's happening, or if something in the wizard failed and you want to set pieces up manually.

---

## 1. Create a Meta Business account

1. Go to [business.facebook.com](https://business.facebook.com) and sign in.
2. Click **Create Account**.
3. Give it a name (you can call it "FlockBots Dev" or similar).
4. Add your email when prompted.

---

## 2. Create a Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps).
2. Click **Create App**.
3. Use case: **Other**.
4. App type: **Business**.
5. Name: "FlockBots WhatsApp" (or whatever).
6. Link it to your Business account from step 1.

---

## 3. Add the WhatsApp product to your app

1. From your app dashboard, in the left sidebar → **Add products to your app**.
2. Find **WhatsApp** → click **Set up**.
3. This will drop you into the WhatsApp **Getting started** panel.

---

## 4. Get your phone number ID

On the Getting Started panel, Meta gives you a free test phone number. You'll see a table with:

- **From** — Meta's test phone number (the number that will send messages to your users — don't touch this)
- **Phone number ID** — the numeric ID beside the "From" number. Copy this. This is `WHATSAPP_PHONE_NUMBER_ID` in the wizard.

You can also add your *own* phone number later from the **API Setup** page — but the test number works fine for development.

---

## 5. Add your personal number as a recipient

On the same page:

1. Click **Add phone number** under "To".
2. Enter your personal WhatsApp number in E.164 format (e.g. `+14155551234`).
3. You'll get a verification code on WhatsApp — enter it.
4. This is the number you'll message FlockBots from. In the wizard this is `OPERATOR_WHATSAPP_NUMBER` (enter digits only, no `+`).

> **Test-phase limitation:** Meta only lets you send to a few verified recipient numbers during the test phase. For production, you'd complete Meta's business verification to lift this cap — but for personal use, the test phase is enough forever.

---

## 6. Generate a permanent access token

Meta's default temporary token expires in 24 hours. You want a permanent one.

1. In your Business Manager ([business.facebook.com](https://business.facebook.com)), go to **Settings** → **Users** → **System Users**.
2. Click **Add** → create a system user. Name it "flockbots-bot", role **Admin**.
3. Click **Add Assets** on your new system user → add your Meta app.
4. Click **Generate New Token** on the system user:
   - App: your Meta app
   - Expiration: **Never**
   - Permissions: check `whatsapp_business_messaging` and `whatsapp_business_management`
5. Copy the token (starts with `EAA...`). This is `WHATSAPP_ACCESS_TOKEN` in the wizard.

Keep this token safe — anyone with it can send WhatsApp messages as your app.

---

## 7. Get your app secret

The app secret is what Meta uses to sign webhook POSTs. FlockBots verifies every inbound request with HMAC-SHA256 to reject forgeries.

1. In your Meta app dashboard → **App Settings** → **Basic**.
2. Find **App Secret** → click **Show** → enter your password.
3. Copy the value. This is `WHATSAPP_APP_SECRET` in the wizard.

---

## 8. Pick a webhook verify token

You choose this one — it's an arbitrary string. Meta sends it back to verify your webhook is legit.

The wizard generates a random 16-byte hex string by default (e.g. `a3f2c9d7b1e4f8a6...`). You can keep that or type your own. This is `WHATSAPP_VERIFY_TOKEN`.

---

## 9. Deploy the webhook-relay to Vercel

FlockBots ships a tiny serverless function (`webhook-relay/api/webhook.ts`) that:
- Accepts Meta's GET verification handshake (using your verify token)
- Accepts Meta's POST message deliveries
- Writes each inbound message to your Supabase `webhook_inbox` table
- The coordinator polls that table every 3 seconds and processes new messages

Deploy steps:

1. Go to [vercel.com/new/clone](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fpushan-hinduja%2Fflockbots&project-name=flockbots-webhook-relay&root-directory=webhook-relay&env=SUPABASE_URL%2CSUPABASE_SERVICE_ROLE_KEY%2CWHATSAPP_VERIFY_TOKEN) — this link pre-fills everything.
2. Sign in to Vercel. Authorize GitHub access.
3. When Vercel asks for environment variables, paste:
   - `SUPABASE_URL` — your Supabase project URL (from your `~/.flockbots/.env`)
   - `SUPABASE_SERVICE_ROLE_KEY` — your Supabase service_role key
   - `WHATSAPP_VERIFY_TOKEN` — the verify token from step 8
4. Click **Deploy**. Wait ~60 seconds.
5. Copy the URL Vercel gives you (something like `https://flockbots-webhook-relay-abc123.vercel.app`).

Your Meta webhook URL will be that URL + `/api/webhook`.

The wizard automates this: it opens the Vercel import page with everything pre-filled and only asks you to paste the env var values + deploy.

---

## 10. Register the webhook with Meta

1. In your Meta app dashboard → **WhatsApp** → **Configuration**.
2. Scroll to **Webhook** → click **Edit**.
3. Paste:
   - **Callback URL**: `https://your-vercel-url.vercel.app/api/webhook`
   - **Verify token**: the value from step 8
4. Click **Verify and save**. Meta sends a GET to your URL with your token — if the relay matches, Meta shows "verified" ✓.
5. Once verified, click **Manage** on "Webhook fields" → find **messages** → click **Subscribe**.

If the verify step fails:
- Double-check the Callback URL ends in `/api/webhook` (not just `/`)
- Make sure the Verify token in Meta exactly matches the `WHATSAPP_VERIFY_TOKEN` env var you set in Vercel
- Check Vercel logs for the relay — you should see a GET request when Meta verifies

---

## 11. Test it

1. On your phone, open WhatsApp
2. Message the Meta test number (the "From" number from step 4)
3. Send: `hi`
4. Watch `pm2 logs flockbots` on your machine — you should see the coordinator pick up the message within a few seconds.
5. You should get a reply in WhatsApp from FlockBots.

If no reply:
- Check Vercel relay logs (Vercel dashboard → your relay project → Logs tab) — you should see the POST request
- Check Supabase `webhook_inbox` table in the Supabase SQL editor: `select * from webhook_inbox order by created_at desc limit 5;` — you should see your message
- Check `pm2 logs flockbots` for processing errors

---

## Troubleshooting

**Meta rejects the verify:** Make sure your Vercel deployment is actually live — hit the URL with curl: `curl "https://your-vercel-url.vercel.app/api/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"` should return `test`.

**Messages arrive in Supabase but coordinator doesn't process them:** The coordinator's operator number check rejects messages from senders that don't match `OPERATOR_WHATSAPP_NUMBER`. Confirm the `sender` field in `webhook_inbox` matches exactly (digits only, no `+`, no spaces).

**HMAC signature failures in Vercel logs:** This means `WHATSAPP_APP_SECRET` in your coordinator `.env` doesn't match the app secret in Meta. Double-check in App Settings → Basic → App secret.

**Token expired unexpectedly:** You probably used a temporary token instead of a system user token. Redo step 6 — make sure "Expiration: Never" is selected when generating.

**Subscription to "messages" not showing:** Some Meta apps require you to add a "Webhook test number" before you can subscribe to message fields. In WhatsApp → API Setup, make sure there's at least one "To" number added (step 5).

---

## What the wizard does for you

`flockbots init` with WhatsApp selected:

- Prompts for all the IDs + tokens above (steps 4, 6, 7, 8)
- Enforces Supabase as required (because the relay needs it)
- Auto-applies the Supabase schema migration
- Opens Vercel with all 3 env vars pre-filled for the webhook-relay deploy
- After you paste the Vercel URL back, prints the exact callback URL + verify token to paste into Meta
- Opens the Meta app dashboard for you

Everything in this guide is what the wizard automates. Read it if you want to know what's happening or if you're troubleshooting something that didn't auto-work.
