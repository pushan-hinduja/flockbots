import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { flockbotsRoot, instancesDir, listInstanceSlugs } from '../paths';
import { ensureSkillsFromTemplate } from './skills-sync';
import { isVercelLinked } from './vercel-cli';

/** Run a command async with a Promise — lets the caller's spinner animate. */
function runAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout?.on('data', (c: Buffer) => { output += c.toString('utf-8'); });
    proc.stderr?.on('data', (c: Buffer) => { output += c.toString('utf-8'); });
    const timer = opts.timeoutMs
      ? setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs)
      : null;
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output });
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, output: output + '\n' + err.message });
    });
  });
}

/**
 * `flockbots upgrade` — pulls latest from origin, rebuilds the coordinator,
 * and restarts via pm2 if any instances are running. Refuses to run with a
 * dirty working tree so user-tracked files don't get wiped by the git
 * reset. User-editable content (skills/) lives in a gitignored active
 * directory that's populated from skills-template/ after each upgrade;
 * edits there don't block pulls.
 */
export async function runUpgrade(): Promise<void> {
  const p = await import('@clack/prompts');
  p.intro('FlockBots upgrade');

  const home = flockbotsRoot();
  if (!existsSync(join(home, '.git'))) {
    p.cancel(`${home} is not a git checkout — can't self-upgrade. Reinstall with install.sh.`);
    return;
  }

  const spin = p.spinner();
  spin.start('Fetching latest from origin');
  const fetched = await runAsync('git', ['fetch', '--depth', '1', 'origin'], { cwd: home, timeoutMs: 60_000 });
  if (fetched.code !== 0) {
    spin.stop('Fetch failed');
    p.log.error(fetched.output.split('\n').slice(-5).join('\n') || 'git fetch returned non-zero');
    return;
  }
  spin.stop('Fetched latest from origin');

  // Detect current branch (fast — execSync is fine here, no spinner active)
  let branch = 'main';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: home, encoding: 'utf-8' }).trim() || 'main';
  } catch {
    // Keep default
  }

  // Refuse to upgrade if the user has uncommitted local changes. `git reset
  // --hard` would silently wipe them. As of v1.0.2 user-editable content
  // (skills/) is gitignored, so this check should mostly only catch
  // accidental edits to shipped files — but it's still the right default.
  // Let the user stash or commit, then re-run.
  spin.start('Checking for local changes');
  let dirty = '';
  try {
    dirty = execSync('git status --porcelain', { cwd: home, encoding: 'utf-8' }).trim();
  } catch {
    spin.stop('Could not read git status');
    p.log.error('Aborting upgrade to avoid data loss.');
    return;
  }
  spin.stop('Working tree checked');
  if (dirty) {
    p.log.error('Uncommitted local changes detected — upgrade would overwrite them:');
    p.log.message(dirty.split('\n').map(l => '  ' + l).join('\n'));
    p.log.message('\nStash or commit the changes, then re-run `flockbots upgrade`:');
    p.log.message(`  git -C ${home} stash push -u -m "pre-upgrade"`);
    p.log.message('  flockbots upgrade');
    p.cancel('Upgrade cancelled.');
    return;
  }

  spin.start(`Resetting source to origin/${branch}`);
  const reset = await runAsync('git', ['reset', '--hard', `origin/${branch}`], { cwd: home, timeoutMs: 30_000 });
  if (reset.code !== 0) {
    spin.stop('Reset failed');
    p.log.error(reset.output.split('\n').slice(-5).join('\n') || 'git reset returned non-zero');
    return;
  }
  spin.stop('Source updated');

  spin.start('Installing coordinator dependencies (npm ci)');
  const npmCi = await runAsync('npm', ['ci', '--silent'], { cwd: join(home, 'coordinator'), timeoutMs: 180_000 });
  if (npmCi.code !== 0) {
    spin.stop('npm ci failed');
    p.log.error(npmCi.output.split('\n').slice(-10).join('\n') || 'npm ci returned non-zero');
    return;
  }
  spin.stop('Dependencies installed');

  spin.start('Building coordinator (tsc)');
  const build = await runAsync('npm', ['run', 'build', '--silent'], { cwd: join(home, 'coordinator'), timeoutMs: 120_000 });
  if (build.code !== 0) {
    spin.stop('Build failed');
    p.log.error(build.output.split('\n').slice(-10).join('\n') || 'tsc returned non-zero');
    return;
  }
  spin.stop('Coordinator built');

  // Propagate new skill templates (if any shipped this release) into each
  // instance's active skills/ dir. Existing user-edited files are skipped.
  // Skills are per-instance because some skills (kg) are target-repo-
  // specific — the shared skills-template/ at root seeds each instance.
  const slugs = listInstanceSlugs();
  if (slugs.length === 0) {
    p.log.info('No instances configured yet — run `flockbots init` to create one.');
  } else {
    spin.start(`Syncing skill templates across ${slugs.length} flock${slugs.length === 1 ? '' : 's'}`);
    let totalCopied = 0;
    const updates: string[] = [];
    for (const slug of slugs) {
      try {
        spin.message(`Syncing skills for ${slug}`);
        const instanceHome = join(instancesDir(), slug);
        const { copied } = ensureSkillsFromTemplate(instanceHome, home);
        if (copied.length > 0) {
          updates.push(`[${slug}] added ${copied.length} new skill file${copied.length === 1 ? '' : 's'}`);
          totalCopied += copied.length;
        }
      } catch (err: any) {
        updates.push(`[${slug}] skills sync skipped: ${err?.message || String(err)}`);
      }
    }
    spin.stop(totalCopied === 0 ? 'Skills already up to date' : `Synced ${totalCopied} new skill file${totalCopied === 1 ? '' : 's'}`);
    for (const line of updates) p.log.info(line);
  }

  // Try pm2 restart — matches every flockbots:<slug> app via regex.
  spin.start('Restarting pm2 processes');
  const pm2 = await runAsync('pm2', ['restart', '/^flockbots:/'], { timeoutMs: 30_000 });
  if (pm2.code === 0) {
    spin.stop('pm2 processes restarted');
  } else {
    spin.stop('pm2 restart skipped (daemon not running)');
    p.log.info('Start FlockBots manually with `pm2 start ecosystem.config.js`.');
  }

  // Redeploy linked Vercel projects so dashboard + relay advance in lockstep
  // with the coordinator. Only fires if the user already linked them via
  // `flockbots dashboard deploy` / `flockbots webhook deploy`. Best effort —
  // a Vercel hiccup shouldn't block the local upgrade.
  for (const subdir of ['dashboard', 'webhook-relay']) {
    const dir = join(home, subdir);
    if (existsSync(dir) && isVercelLinked(dir)) {
      const vercelSpin = p.spinner();
      vercelSpin.start(`Redeploying ${subdir} to Vercel`);
      const result = await runAsync('npx', ['--yes', 'vercel', '--prod', '--yes'], {
        cwd: dir,
        timeoutMs: 300_000,
      });
      if (result.code === 0) {
        vercelSpin.stop(`${subdir} redeployed`);
      } else {
        vercelSpin.stop(`${subdir} redeploy failed — re-run \`flockbots ${subdir === 'dashboard' ? 'dashboard' : 'webhook'} deploy\` to retry`);
      }
    }
  }

  p.outro('Upgrade complete.');
}
