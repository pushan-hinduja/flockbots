# WhatsApp Setup Guide

Full walkthrough for wiring WhatsApp as your FlockBots chat provider. Takes ~30–40 minutes start to finish for the first flock; ~5 minutes for any additional flock you add later (the relay is shared — see [Adding a second WhatsApp flock](#adding-a-second-whatsapp-flock)).

---

## Prerequisites

- A Meta/Facebook account (personal login is fine — you'll create a Business account from it)
- A mobile phone number to receive a verification SMS (Meta lets you use your own personal number for the test phase)
- Supabase project — FlockBots routes inbound WhatsApp messages through a webhook-relay that writes to Supabase, so this is required for the WhatsApp path
- Vercel account (free tier is fine)

The FlockBots `flockbots init` wizard will prompt you for everything below and `flockbots webhook deploy` ships the relay to Vercel for you. This guide is for if you want to know what's happening, or if something in the wizard failed and you want to set pieces up manually.

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

The app secret comes from your Meta app's settings. The wizard captures it for the local-webhook-server fallback path (which signs every POST with HMAC-SHA256 against the secret) and stores it in `.env`. The Supabase-relay path — what the wizard actually deploys — doesn't currently use the app secret; defense against forged inbound messages comes from the coordinator filtering by `OPERATOR_WHATSAPP_NUMBER` instead.

1. In your Meta app dashboard → **App Settings** → **Basic**.
2. Find **App Secret** → click **Show** → enter your password.
3. Copy the value. This is `WHATSAPP_APP_SECRET` in the wizard.

---

## 8. Pick a webhook verify token

You choose this one — it's an arbitrary string. Meta sends it back to verify your webhook is legit.

The wizard generates a random 16-byte hex string by default (e.g. `a3f2c9d7b1e4f8a6...`). You can keep that or type your own. This is `WHATSAPP_VERIFY_TOKEN`.

> **Multi-flock note:** the verify token is **shared across every flock on this machine** — one Vercel relay deployment, one verify token, all instance-specific URLs validated against it. If you're adding a second WhatsApp flock, the wizard pre-fills the existing token automatically; just hit enter.

---

## 9. Deploy the webhook-relay to Vercel

FlockBots ships a tiny serverless function (`webhook-relay/api/webhook/[slug].ts`) that:

- Accepts Meta's GET verification handshake (using your verify token)
- Accepts Meta's POST message deliveries
- Writes each inbound message to your Supabase `webhook_inbox` table, stamped with `instance_id=<slug>` so the right coordinator picks it up
- The matching coordinator polls that table every 3 seconds and processes new messages

Deploy with the FlockBots CLI (do this once per machine — the same relay handles every flock):

```bash
flockbots webhook deploy
```

The CLI will:

1. Pre-warm the Vercel CLI (first run downloads ~30 MB, cached after).
2. Surface your current Vercel identity and offer to switch accounts if you're signed in to the wrong one.
3. Link the local `~/.flockbots/webhook-relay/` dir to a Vercel project (defaults to `flockbots-webhook-relay` — re-runs reuse the same project).
4. Push `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `WHATSAPP_VERIFY_TOKEN` as production env vars.
5. Deploy to production via `vercel --prod`.
6. Print the per-flock callback URL you'll paste into Meta in the next step.

The deploy URL Vercel returns is the project root (e.g. `https://flockbots-webhook-relay-abc123.vercel.app`). Your Meta callback URL will be that root **plus the per-flock path**: `/api/webhook/<your-flock-slug>` (see step 10).

> **Why the slug suffix?** v1.1+ supports multiple flocks on one machine. Each flock has a unique slug (e.g. `acme-app`, `my-blog`); each gets its own URL path on the same shared relay deployment. The relay routes inbound messages by reading the slug out of the URL path. **Do not omit the slug** — without it, messages have nowhere to be filed.

---

## 10. Register the webhook with Meta

1. In your Meta app dashboard → **WhatsApp** → **Configuration**.
2. Scroll to **Webhook** → click **Edit**.
3. Paste:
   - **Callback URL**: `https://<your-relay>.vercel.app/api/webhook/<your-flock-slug>` — the URL the wizard printed at the end of `flockbots webhook deploy`. The slug at the end is essential.
   - **Verify token**: the value from step 8 (the wizard auto-copies it to your clipboard on macOS).
4. Click **Verify and save**. Meta sends a GET to your URL with your token — if the relay matches, Meta shows "verified" ✓.
5. Once verified, click **Manage** on "Webhook fields" → find **messages** → click **Subscribe**.

If the verify step fails:

- Double-check the Callback URL ends in `/api/webhook/<slug>` — not `/api/webhook` and not just `/`.
- Make sure the Verify token in Meta exactly matches the `WHATSAPP_VERIFY_TOKEN` env var on Vercel. Check at [vercel.com](https://vercel.com) → your relay project → Settings → Environment Variables. **Make sure there's no trailing newline** (a v1.2.0–v1.2.2 bug — fixed in v1.2.3 — landed env vars with `\n` appended; if you upgraded from those versions, edit the var, save the trimmed value, and redeploy).
- Check Vercel logs for the relay (your relay project → Logs tab) — you should see a GET request when Meta verifies, with `?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`.

---

## 11. Test it

1. On your phone, open WhatsApp.
2. Message the Meta test number (the "From" number from step 4).
3. Send: `hi`.
4. Watch your coordinator's logs for that flock (there's one process per flock under pm2):

   ```bash
   pm2 logs flockbots:<your-flock-slug>     # one specific flock
   pm2 logs /^flockbots:/                   # tail every flock at once
   ```

   You should see the coordinator pick up the message within a few seconds.
5. You should get a reply in WhatsApp from FlockBots.

If no reply:

- Check Vercel relay logs (Vercel dashboard → your relay project → Logs tab) — you should see the POST request.
- Check Supabase `webhook_inbox` table in the Supabase SQL editor:

  ```sql
  select * from webhook_inbox order by created_at desc limit 5;
  ```

  You should see your message with `instance_id` set to your flock's slug. If `instance_id` is wrong, your callback URL probably has the wrong slug.
- Check `pm2 logs flockbots:<slug>` for processing errors.

---

## Adding a second WhatsApp flock

Each WhatsApp flock needs its own phone number on Meta's side, but **shares the relay deployment** with every other flock on this machine. End-to-end:

### What's new vs. shared

| Thing | Per-flock | Shared |
|---|---|---|
| Meta WhatsApp phone number + Phone Number ID | ✓ | — |
| `WHATSAPP_ACCESS_TOKEN` | ✓ if new Meta app; can reuse if same app | — |
| `WHATSAPP_APP_SECRET` | ✓ if new Meta app; same if same app | — |
| `OPERATOR_WHATSAPP_NUMBER` | Whichever number messages this flock | — |
| Webhook relay (Vercel deployment) | — | ✓ one shared relay handles all flocks |
| `WHATSAPP_VERIFY_TOKEN` | — | ✓ one token validates every per-flock URL |
| Callback URL slug suffix | ✓ different `<slug>` per flock | — |

### Steps

1. **In Meta Developers**, either add a new phone number to your existing app (Business Settings → WhatsApp Accounts → Add phone number) **or** create a new Meta app entirely. Either approach works; reusing the existing app is simpler (one access token, one app secret).
2. **In your terminal**, run `flockbots init` and pick **Add a new instance**. Walk through the wizard for the new repo. Reach the WhatsApp section and enter the new phone number ID, access token, app secret, and your operator number. The wizard auto-fills `WHATSAPP_VERIFY_TOKEN` from your existing flock — just hit enter to keep it.
3. **Skip the webhook deploy step** — the relay is already live from your first flock. The wizard's "Next steps" panel will print the new flock's callback URL (`https://<relay>.vercel.app/api/webhook/<new-flock-slug>`); copy it.
4. **In Meta Developers**, configure the webhook for the *new phone number's* Meta app:
   - Callback URL: the URL from step 3 (note the new slug at the end).
   - Verify token: the **same** verify token you used for the first flock.
   - Click **Verify and save**, then subscribe to **messages**.
5. Test by sending a WhatsApp message to the new phone number — it should land in `webhook_inbox` with `instance_id=<new-flock-slug>` and the matching coordinator picks it up.

The coordinators are fully isolated: each one polls only for its own slug, so messages to flock A never trigger flock B.

If you ever **do** need to redeploy the relay (e.g. after rotating `SUPABASE_SERVICE_ROLE_KEY`), `flockbots webhook deploy` re-links to the existing Vercel project and overwrites the env vars idempotently. Same URL, no duplicate.

---

## Troubleshooting

**Meta rejects the verify:** Hit the URL with curl (substitute your slug + verify token):

```bash
curl "https://<your-relay>.vercel.app/api/webhook/<your-flock-slug>?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"
```

Should return `test`. If it returns `Forbidden`, the verify token in Vercel doesn't match what you typed. If it returns `Invalid instance slug`, the slug isn't registered or has invalid characters (must be `a-z0-9-`, 2-32 chars, can't start/end with `-`).

**"The callback URL or verify token couldn't be validated":** Almost always a verify-token mismatch. v1.2.0–v1.2.2 had a bug that pushed verify tokens to Vercel with a trailing newline — fixed in v1.2.3. If you upgraded from those versions, go to Vercel → your relay project → Settings → Environment Variables → `WHATSAPP_VERIFY_TOKEN`, edit it to remove any trailing newline, save, then redeploy the relay.

**Messages arrive in Supabase but coordinator doesn't process them:** The coordinator filters by `OPERATOR_WHATSAPP_NUMBER` and rejects messages from other senders. Confirm the `sender` column in `webhook_inbox` matches your `OPERATOR_WHATSAPP_NUMBER` exactly (digits only, no `+`, no spaces). Also confirm `instance_id` matches the slug of the coordinator you expect to handle it.

**Messages land with wrong `instance_id`:** Your callback URL has the wrong slug. Re-check Meta dashboard → WhatsApp → Configuration → Webhook → Edit, make sure the URL ends in the right `/api/webhook/<slug>`.

**Token expired unexpectedly:** You probably used a temporary token instead of a system user token. Redo step 6 — make sure "Expiration: Never" is selected when generating.

**Subscription to "messages" not showing:** Some Meta apps require you to add a "Webhook test number" before you can subscribe to message fields. In WhatsApp → API Setup, make sure there's at least one "To" number added (step 5).

---

## What the wizard does for you

`flockbots init` with WhatsApp selected:

- Prompts for all the IDs + tokens above (steps 4, 6, 7, 8)
- Enforces Supabase as required (because the relay needs it)
- Auto-applies the Supabase schema migration
- For the first WhatsApp flock: prints a `flockbots webhook deploy` command + walks you through Meta webhook config
- For subsequent WhatsApp flocks: pre-fills the existing verify token, skips the relay deploy step, prints the new per-flock callback URL

`flockbots webhook deploy`:

- Links the relay dir to a Vercel project (creating if needed, reusing if already linked)
- Pushes Supabase + verify-token env vars to Vercel
- Deploys to production
- Prints the per-flock callback URL + verify token (auto-copies the token to clipboard on macOS)

Everything in this guide is what the wizard automates. Read it if you want to know what's happening or if you're troubleshooting something that didn't auto-work.
