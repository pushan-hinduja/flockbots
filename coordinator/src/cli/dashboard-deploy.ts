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
 * `flockbots dashboard deploy` — runs the local dashboard through the
 * Vercel CLI: link → set env vars → deploy. The previous v1.0.x flow
 * pointed users at vercel.com/new/clone (template-fork model), which
 * polluted the user's GitHub with a full monorepo fork and was prone to
 * hanging in Vercel's import UI. The CLI flow links a single Vercel
 * project to the local <root>/dashboard dir; subsequent deploys (incl.
 * `flockbots upgrade`) just re-run `vercel --prod` against that link.
 *
 * Reads SUPABASE_URL + SUPABASE_ANON_KEY from any instance's .env (these
 * values are shared across instances by design). With multiple flocks
 * the slug doesn't matter for these values, so we default to the first
 * one when -i isn't passed.
 */
export async function runDashboardDeploy(args: string[] = []): Promise<void> {
  const { instanceId } = extractInstanceFlag(args);
  const root = flockbotsRoot();
  const slugs = listInstanceSlugs();
  if (slugs.length === 0) {
    console.error(`No FlockBots instances at ${join(root, 'instances')}. Run \`flockbots init\` first.`);
    process.exit(1);
  }

  // SUPABASE_URL + SUPABASE_ANON_KEY are shared across every instance.
  // Default to the first slug when -i isn't given so multi-flock users
  // don't have to type a redundant flag.
  loadEnvFile(instanceId || slugs[0]);
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    console.error('The dashboard requires a Supabase project. Re-run `flockbots init`,');
    console.error('pick "Reconfigure", and select the Supabase + Dashboard admin sections.');
    process.exit(1);
  }

  const dashboardDir = join(root, 'dashboard');
  if (!existsSync(dashboardDir)) {
    console.error(`Dashboard source not found at ${dashboardDir}.`);
    console.error('Run `flockbots upgrade` to pull the dashboard into your install dir.');
    process.exit(1);
  }

  const p = await import('@clack/prompts');
  p.intro('Deploy FlockBots dashboard');

  p.note(
    help([
      'Deploys the React dashboard to Vercel via `vercel` CLI:',
      '',
      '  1. Pre-warm the Vercel CLI (first run downloads ~30s, cached after)',
      '  2. Sign in to Vercel if needed (one-time browser flow)',
      '  3. Link this dashboard dir to a Vercel project',
      '  4. Push your Supabase URL + anon key as production env vars',
      '  5. Deploy to production',
      '',
      'Subsequent runs skip 1-3; just sets env (idempotent) and deploys.',
      '`flockbots upgrade` will redeploy automatically once the project',
      'is linked, so dashboard + coordinator stay in sync.',
    ].join('\n')),
    'About',
  );

  // 1. Pre-warm CLI
  if (!(await ensureVercelCli(p))) {
    p.outro('Cancelled — Vercel CLI is not available.');
    return;
  }

  // 2. Auth
  if (!(await ensureVercelLogin(p))) {
    p.outro('Cancelled — sign in to Vercel and re-run.');
    return;
  }

  // 3. Link
  if (!(await linkVercelProject(p, dashboardDir, 'flockbots-dashboard'))) {
    p.outro('Cancelled — project link did not complete.');
    return;
  }

  // 4. Env vars (production scope)
  const envSpin = p.spinner();
  envSpin.start('Setting VITE_SUPABASE_URL on Vercel');
  const okUrl = await setVercelEnv(dashboardDir, 'VITE_SUPABASE_URL', supabaseUrl);
  envSpin.message('Setting VITE_SUPABASE_ANON_KEY on Vercel');
  const okKey = await setVercelEnv(dashboardDir, 'VITE_SUPABASE_ANON_KEY', anonKey);
  if (!okUrl || !okKey) {
    envSpin.stop('Env var setup failed');
    p.outro('Cancelled — could not set env vars on Vercel.');
    return;
  }
  envSpin.stop('Env vars set');

  // 5. Deploy
  const deployedUrl = await deployVercelProd(p, dashboardDir);
  if (deployedUrl === null) {
    p.outro('Deploy failed — see output above. Re-run `flockbots dashboard deploy` to retry.');
    return;
  }

  if (deployedUrl) {
    try {
      updateState(root, { dashboardDeployUrl: deployedUrl.replace(/\/$/, '') });
      p.log.success(`Saved → ${join(root, 'state.json')}`);
    } catch (err: any) {
      p.log.warn(`Could not write state.json: ${err.message}`);
    }
  }

  p.outro('Dashboard deploy complete.');
}
