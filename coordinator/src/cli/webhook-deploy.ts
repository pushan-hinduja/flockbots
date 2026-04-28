import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { flockbotsRoot, listInstanceSlugs } from '../paths';
import { extractInstanceFlag, loadEnvFile } from './env';
import { updateState } from './state-file';
import { help } from './brand';
import {
  ensureVercelCli,
  ensureVercelLogin,
  linkVercelProject,
  setVercelEnv,
  deployVercelProd,
} from './vercel-cli';

/**
 * `flockbots webhook deploy` — required only when CHAT_PROVIDER=whatsapp.
 *
 * Same Vercel CLI flow as dashboard-deploy: link → set env vars → deploy.
 * After the deploy, prints Meta webhook config instructions with the
 * per-instance callback URL (`<base>/api/webhook/<slug>`) so the user
 * knows what to paste into the Meta dashboard.
 *
 * Reads SUPABASE_URL + WHATSAPP_VERIFY_TOKEN from the named instance's
 * .env (or the first slug if -i isn't given). The slug also drives the
 * webhook URL path — each WhatsApp instance has its own /api/webhook/<slug>
 * path on the same shared relay deployment.
 */
export async function runWebhookDeploy(args: string[] = []): Promise<void> {
  const { instanceId } = extractInstanceFlag(args);
  const root = flockbotsRoot();
  const slugs = listInstanceSlugs();
  if (slugs.length === 0) {
    console.error(`No FlockBots instances at ${join(root, 'instances')}. Run \`flockbots init\` first.`);
    process.exit(1);
  }

  const slug = instanceId || slugs[0];
  loadEnvFile(slug);
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const provider = process.env.CHAT_PROVIDER;

  if (provider !== 'whatsapp') {
    console.error(`This command is only relevant when CHAT_PROVIDER=whatsapp (current: ${provider || 'not set'}).`);
    process.exit(1);
  }
  if (!supabaseUrl || !serviceKey || !verifyToken) {
    console.error('The webhook-relay needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and WHATSAPP_VERIFY_TOKEN');
    console.error('in .env. Re-run `flockbots init` and reconfigure Supabase + Chat provider sections.');
    process.exit(1);
  }

  const relayDir = join(root, 'webhook-relay');
  if (!existsSync(relayDir)) {
    console.error(`Webhook-relay source not found at ${relayDir}.`);
    console.error('Run `flockbots upgrade` to pull the relay into your install dir.');
    process.exit(1);
  }

  const p = await import('@clack/prompts');
  p.intro('Deploy FlockBots webhook-relay');

  p.note(
    help([
      'Deploys the WhatsApp webhook-relay to Vercel via `vercel` CLI:',
      '',
      '  1. Pre-warm the Vercel CLI (first run ~30s, cached after)',
      '  2. Sign in to Vercel if needed (one-time browser flow)',
      '  3. Link this relay dir to a Vercel project',
      '  4. Push Supabase + verify token as production env vars',
      '  5. Deploy to production',
      '  6. Print the Meta webhook callback URL for this flock',
      '',
      'The relay is shared across every WhatsApp flock on this install —',
      `each flock gets its own /api/webhook/<slug> path on the same deploy.`,
    ].join('\n')),
    'About',
  );

  if (!(await ensureVercelCli(p))) { p.outro('Cancelled — Vercel CLI not available.'); return; }
  if (!(await ensureVercelLogin(p))) { p.outro('Cancelled — sign in to Vercel and re-run.'); return; }
  if (!(await linkVercelProject(p, relayDir, 'flockbots-webhook-relay'))) {
    p.outro('Cancelled — project link did not complete.');
    return;
  }

  const envSpin = p.spinner();
  envSpin.start('Setting SUPABASE_URL on Vercel');
  const okUrl = await setVercelEnv(relayDir, 'SUPABASE_URL', supabaseUrl);
  envSpin.message('Setting SUPABASE_SERVICE_ROLE_KEY on Vercel');
  const okSrv = await setVercelEnv(relayDir, 'SUPABASE_SERVICE_ROLE_KEY', serviceKey);
  envSpin.message('Setting WHATSAPP_VERIFY_TOKEN on Vercel');
  const okTok = await setVercelEnv(relayDir, 'WHATSAPP_VERIFY_TOKEN', verifyToken);
  if (!okUrl || !okSrv || !okTok) {
    envSpin.stop('Env var setup failed');
    p.outro('Cancelled — could not set env vars on Vercel.');
    return;
  }
  envSpin.stop('Env vars set');

  const deployedUrl = await deployVercelProd(p, relayDir);
  if (deployedUrl === null) {
    p.outro('Deploy failed — see output above. Re-run `flockbots webhook deploy` to retry.');
    return;
  }

  // The deploy URL Vercel prints is for the project root. The Meta callback
  // URL appends /api/webhook/<slug> for this flock.
  const baseUrl = deployedUrl ? deployedUrl.replace(/\/$/, '') : '';
  const slugSuffix = slug ? `/${slug}` : '';
  const webhookUrl = baseUrl ? `${baseUrl}/api/webhook${slugSuffix}` : `<deploy-url>/api/webhook${slugSuffix}`;

  // Copy verify token to clipboard on macOS so Meta paste is one Cmd-V.
  if (process.platform === 'darwin') {
    try { execSync('pbcopy', { input: verifyToken }); } catch { /* best effort */ }
  }

  p.note(
    help([
      'Configure the webhook in your Meta app dashboard:',
      '',
      '  1. https://developers.facebook.com/apps/',
      '  2. Select your WhatsApp app',
      '  3. WhatsApp > Configuration > Webhook > Edit',
      '  4. Paste:',
      `       Callback URL: ${webhookUrl}`,
      `       Verify token: ${verifyToken}${process.platform === 'darwin' ? '   (already copied to clipboard)' : ''}`,
      '  5. Click "Verify and save" — Meta sends a GET to your URL',
      '  6. Click "Manage" on Webhook fields > subscribe to "messages"',
      '',
      'Full walkthrough with screenshots: docs/setup/whatsapp.md',
    ].join('\n')),
    'Point Meta at your webhook',
  );

  if (baseUrl) {
    try {
      updateState(root, { webhookRelayUrl: baseUrl });
      p.log.success(`Saved → ${join(root, 'state.json')}`);
    } catch (err: any) {
      p.log.warn(`Could not write state.json: ${err.message}`);
    }
  }

  const done = await p.confirm({ message: 'Webhook registered + subscribed in Meta?', initialValue: true });
  if (p.isCancel(done) || !done) {
    p.log.warn('Skipped. Inbound WhatsApp messages will not reach the coordinator until the Meta webhook is configured.');
  }

  p.outro('Webhook deploy complete.');
}
