import { execSync } from 'child_process';
import { join } from 'path';
import { flockbotsRoot, listInstanceSlugs } from '../paths';
import { extractInstanceFlag, loadEnvFile } from './env';
import { updateState } from './state-file';
import { help } from './brand';

type ClackModule = typeof import('@clack/prompts');

/**
 * `flockbots dashboard deploy` — reads SUPABASE_URL + SUPABASE_ANON_KEY from
 * a configured instance's .env
 * (these values are shared across instances by design), opens the Vercel
 * one-click import page with the right repo + env-var prompts pre-filled,
 * copies the anon key to the macOS clipboard, then asks the user to paste
 * the resulting deploy URL back so we can stash it in state.json
 * (root-level, since the dashboard is shared across instances).
 */
export async function runDashboardDeploy(args: string[] = []): Promise<void> {
  const { instanceId } = extractInstanceFlag(args);
  const root = flockbotsRoot();
  if (listInstanceSlugs().length === 0) {
    console.error(`No FlockBots instances at ${join(root, 'instances')}. Run \`flockbots init\` first.`);
    process.exit(1);
  }

  loadEnvFile(instanceId);
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    console.error('The dashboard requires a Supabase project. Re-run `flockbots init`,');
    console.error('pick "Reconfigure", and select the Supabase + Dashboard admin sections.');
    process.exit(1);
  }

  const p = await import('@clack/prompts');
  p.intro('Deploy FlockBots dashboard');

  p.note(
    help([
      'The dashboard is a Vite/React app that reads from your Supabase',
      'project with row-level security. Vercel free tier is plenty — this',
      'connects to the FlockBots repo so you get auto-deploys whenever a',
      'new release ships.',
    ].join('\n')),
    'About'
  );

  const mode = await p.select({
    message: 'How do you want to deploy?',
    options: [
      { value: 'now',   label: 'Open Vercel with the import page pre-filled', hint: 'recommended — ~2 min' },
      { value: 'later', label: 'Show me the commands and links so I can do it later' },
      { value: 'cancel', label: 'Cancel' },
    ],
    initialValue: 'now',
  });
  if (p.isCancel(mode) || mode === 'cancel') {
    p.cancel('Cancelled.');
    return;
  }

  const importUrl = buildVercelImportUrl();

  // Copy anon key to clipboard on macOS so user can paste quickly when
  // Vercel prompts for env vars. The 200-char JWT would blow past any
  // terminal width if we tried to put it inline in a clack note.
  const clipboarded = process.platform === 'darwin'
    ? (() => { try { execSync('pbcopy', { input: anonKey }); return true; } catch { return false; } })()
    : false;
  const anonHint = clipboarded
    ? '(copied to your clipboard — Cmd-V when Vercel prompts)'
    : '(paste from your Supabase dashboard → Settings → API Keys)';

  if (mode === 'later') {
    p.note(
      help([
        'When you\'re ready, open this link in a browser:',
        '',
        `  ${importUrl}`,
        '',
        'When Vercel asks for environment variables, paste:',
        `  VITE_SUPABASE_URL       = ${supabaseUrl}`,
        `  VITE_SUPABASE_ANON_KEY  ${anonHint}`,
        '',
        'After deploy, Settings → Domains → Add a custom domain.',
      ].join('\n')),
      'Vercel deploy — steps for later'
    );
    p.outro('Run `flockbots dashboard deploy` again any time.');
    return;
  }

  p.note(
    help([
      'Opening the Vercel import page in your browser. You will need to:',
      '',
      '  1. Sign in to Vercel (free tier is fine)',
      '  2. Authorize GitHub access to the flockbots repo',
      '  3. Paste these environment variables when prompted:',
      '',
      `       VITE_SUPABASE_URL       = ${supabaseUrl}`,
      `       VITE_SUPABASE_ANON_KEY  ${anonHint}`,
      '',
      '  4. Click Deploy — you\'ll have a live URL in ~2 minutes.',
      '',
      'For a custom domain later: Vercel Settings → Domains → Add.',
    ].join('\n')),
    'Deploy in browser'
  );

  openBrowser(importUrl);

  // Capture the deployed URL so future `flockbots init` runs can show it
  // in the picker (and skip the "deploy?" prompt).
  const deployedUrl = await p.text({
    message: 'Paste the live dashboard URL once Vercel finishes (or leave blank to skip):',
    placeholder: 'https://flockbots-dashboard.vercel.app',
    validate: (v) => {
      const t = v.trim();
      if (!t) return undefined;
      return /^https:\/\/.+/.test(t) ? undefined : 'Expected an https:// URL';
    },
  });
  if (p.isCancel(deployedUrl)) {
    p.cancel('Cancelled — Vercel page is still open in your browser if you want to finish later.');
    return;
  }

  const url = (deployedUrl as string).trim();
  if (url) {
    try {
      updateState(root, { dashboardDeployUrl: url.replace(/\/$/, '') });
      p.log.success(`Saved → ${join(root, 'state.json')}`);
    } catch (err: any) {
      p.log.warn(`Could not write state.json: ${err.message}`);
    }
  }

  p.outro('Dashboard deploy complete.');
}

function buildVercelImportUrl(): string {
  const params = new URLSearchParams({
    'repository-url': 'https://github.com/pushan-hinduja/flockbots',
    'project-name':   'flockbots-dashboard',
    'root-directory': 'dashboard',
    'env':            'VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY',
    'envDescription': 'Copy these from your Supabase project — Settings → API Keys → Legacy tab',
    'envLink':        'https://supabase.com/dashboard',
  });
  return `https://vercel.com/new/clone?${params.toString()}`;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? `open ${JSON.stringify(url)}`
            : process.platform === 'win32'  ? `start "" ${JSON.stringify(url)}`
            :                                  `xdg-open ${JSON.stringify(url)}`;
  try { execSync(cmd, { stdio: 'ignore' }); } catch { /* user can paste the URL */ }
}
