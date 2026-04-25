import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseEnvFile } from './env-parser';
import { updateState } from './state-file';
import { help } from './brand';

type ClackModule = typeof import('@clack/prompts');

/**
 * `flockbots webhook deploy` — extracted out of `flockbots init` in v1.0.3.
 *
 * Required only when CHAT_PROVIDER=whatsapp. Reads SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, and WHATSAPP_VERIFY_TOKEN from .env, opens the
 * Vercel import for the webhook-relay project, prompts the user to paste
 * the resulting deploy URL back so we can build the Meta webhook callback,
 * and stashes the URL in state.json.
 */
export async function runWebhookDeploy(): Promise<void> {
  const home = process.env.FLOCKBOTS_HOME || join(homedir(), '.flockbots');
  const envPath = join(home, '.env');
  if (!existsSync(envPath)) {
    console.error(`No FlockBots config at ${envPath}. Run \`flockbots init\` first.`);
    process.exit(1);
  }

  const env = parseEnvFile(envPath);
  const supabaseUrl = env.SUPABASE_URL;
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN;
  const provider = env.CHAT_PROVIDER;

  if (provider !== 'whatsapp') {
    console.error(`This command is only relevant when CHAT_PROVIDER=whatsapp (current: ${provider || 'not set'}).`);
    process.exit(1);
  }
  if (!supabaseUrl || !verifyToken) {
    console.error('The webhook-relay needs SUPABASE_URL and WHATSAPP_VERIFY_TOKEN in .env. Re-run');
    console.error('`flockbots init` and pick "Reconfigure" → Supabase + Chat provider.');
    process.exit(1);
  }

  const p = await import('@clack/prompts');
  p.intro('Deploy FlockBots webhook-relay');

  p.note(
    help([
      'Deploys the webhook-relay to Vercel — required for WhatsApp inbound',
      'messages to reach the coordinator. The free Vercel tier is plenty;',
      'this function processes maybe a few dozen requests a day.',
    ].join('\n')),
    'About'
  );

  const mode = await p.select({
    message: 'How do you want to deploy?',
    options: [
      { value: 'now',   label: 'Open Vercel with the import page pre-filled', hint: 'recommended — ~2 min' },
      { value: 'later', label: "Show me how, I'll do it later" },
      { value: 'cancel', label: 'Cancel' },
    ],
    initialValue: 'now',
  });
  if (p.isCancel(mode) || mode === 'cancel') {
    p.cancel('Cancelled.');
    return;
  }

  const importUrl = buildVercelRelayImportUrl();
  const envLines = [
    `  SUPABASE_URL              = ${supabaseUrl}`,
    `  SUPABASE_SERVICE_ROLE_KEY = <your service_role key from .env>`,
    `  WHATSAPP_VERIFY_TOKEN     = ${verifyToken}`,
  ].join('\n');

  if (mode === 'later') {
    p.note(
      help([
        'When you are ready:',
        '',
        `  1. Open: ${importUrl}`,
        `  2. Paste environment variables when prompted:`,
        envLines,
        `  3. Click Deploy. Wait ~60 seconds.`,
        `  4. Copy the URL Vercel gives you (like https://...vercel.app).`,
        `  5. Your Meta webhook URL is: <that URL>/api/webhook`,
        `  6. Verify token for Meta: ${verifyToken}`,
        `  7. Full walkthrough: docs/setup/whatsapp.md`,
      ].join('\n')),
      'Webhook-relay — steps for later'
    );
    p.outro('Run `flockbots webhook deploy` again any time.');
    return;
  }

  p.note(
    help([
      'Opening the Vercel import page in your browser.',
      '',
      'Paste these environment variables when Vercel prompts:',
      '',
      envLines,
      '',
      'Then click Deploy. Wait ~60 seconds for the build. Vercel will',
      'show you a URL at the top of the project page when deploy is done.',
    ].join('\n')),
    'Deploy webhook-relay to Vercel'
  );

  openBrowser(importUrl);

  const deployedUrl = await p.text({
    message: 'Paste the Vercel deployment URL (e.g. https://flockbots-webhook-relay-xxx.vercel.app):',
    validate: (v) => (/^https:\/\/.+\.vercel\.app\/?$/.test(v.trim()) ? undefined : 'Expected https://...vercel.app'),
  });
  if (p.isCancel(deployedUrl)) {
    p.cancel('Cancelled.');
    return;
  }

  const baseUrl = (deployedUrl as string).trim().replace(/\/$/, '');
  const webhookUrl = baseUrl + '/api/webhook';

  // Copy verify token so Meta paste is one Cmd-V.
  if (process.platform === 'darwin') {
    try { execSync('pbcopy', { input: verifyToken }); } catch { /* best effort */ }
  }

  p.note(
    help([
      'Configure the webhook in your Meta app dashboard:',
      '',
      '  1. Go to https://developers.facebook.com/apps/',
      '  2. Select your WhatsApp app',
      '  3. WhatsApp → Configuration → Webhook → Edit',
      '  4. Paste:',
      `       Callback URL: ${webhookUrl}`,
      `       Verify token: ${verifyToken}${process.platform === 'darwin' ? '   (already copied to clipboard)' : ''}`,
      '  5. Click "Verify and save" — Meta sends a GET to your URL',
      '  6. Click "Manage" on Webhook fields → subscribe to "messages"',
      '',
      'Full walkthrough with screenshots: docs/setup/whatsapp.md',
    ].join('\n')),
    'Point Meta at your webhook'
  );

  openBrowser('https://developers.facebook.com/apps/');

  try {
    updateState(home, { webhookRelayUrl: baseUrl });
    p.log.success(`Saved → ${join(home, 'state.json')}`);
  } catch (err: any) {
    p.log.warn(`Could not write state.json: ${err.message}`);
  }

  const done = await p.confirm({ message: 'Webhook registered + subscribed in Meta?', initialValue: true });
  if (p.isCancel(done) || !done) {
    p.log.warn('Skipped. Inbound WhatsApp messages will not reach the coordinator until the Meta webhook is configured.');
  }

  p.outro('Webhook deploy complete.');
}

function buildVercelRelayImportUrl(): string {
  const params = new URLSearchParams({
    'repository-url': 'https://github.com/pushan-hinduja/flockbots',
    'project-name':   'flockbots-webhook-relay',
    'root-directory': 'webhook-relay',
    'env':            'SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,WHATSAPP_VERIFY_TOKEN',
    'envDescription': 'Copy from your FlockBots .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHATSAPP_VERIFY_TOKEN)',
  });
  return `https://vercel.com/new/clone?${params.toString()}`;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? `open ${JSON.stringify(url)}`
            : process.platform === 'win32'  ? `start "" ${JSON.stringify(url)}`
            :                                  `xdg-open ${JSON.stringify(url)}`;
  try { execSync(cmd, { stdio: 'ignore' }); } catch { /* user can paste the URL */ }
}
