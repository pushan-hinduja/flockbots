import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { flockbotsRoot, instancesDir, listInstanceSlugs } from '../paths';
import { ensureSkillsFromTemplate } from './skills-sync';
import { isVercelLinked } from './vercel-cli';

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
  spin.start('Fetching latest');
  try {
    execSync('git fetch --depth 1 origin', { cwd: home, stdio: 'ignore' });
  } catch (err: any) {
    spin.stop('Fetch failed');
    p.log.error(err.message);
    return;
  }
  spin.stop('Fetched');

  // Detect current branch
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
  let dirty = '';
  try {
    dirty = execSync('git status --porcelain', { cwd: home, encoding: 'utf-8' }).trim();
  } catch {
    // If `git status` itself fails we don't have a safe picture; bail out.
    p.log.error('Could not read git status — aborting upgrade to avoid data loss.');
    return;
  }
  if (dirty) {
    p.log.error('Uncommitted local changes detected — upgrade would overwrite them:');
    p.log.message(dirty.split('\n').map(l => '  ' + l).join('\n'));
    p.log.message('\nStash or commit the changes, then re-run `flockbots upgrade`:');
    p.log.message(`  git -C ${home} stash push -u -m "pre-upgrade"`);
    p.log.message('  flockbots upgrade');
    p.cancel('Upgrade cancelled.');
    return;
  }

  spin.start(`Resetting to origin/${branch}`);
  try {
    execSync(`git reset --hard origin/${branch}`, { cwd: home, stdio: 'ignore' });
  } catch (err: any) {
    spin.stop('Reset failed');
    p.log.error(err.message);
    return;
  }
  spin.stop('Source updated');

  spin.start('Installing coordinator dependencies');
  try {
    execSync('npm ci --silent', { cwd: join(home, 'coordinator'), stdio: 'ignore' });
  } catch (err: any) {
    spin.stop('npm ci failed');
    p.log.error(err.message);
    return;
  }
  spin.stop('Dependencies installed');

  spin.start('Building coordinator');
  try {
    execSync('npm run build --silent', { cwd: join(home, 'coordinator'), stdio: 'ignore' });
  } catch (err: any) {
    spin.stop('Build failed');
    p.log.error(err.message);
    return;
  }
  spin.stop('Built');

  // Propagate new skill templates (if any shipped this release) into each
  // instance's active skills/ dir. Existing user-edited files are skipped.
  // Skills are per-instance because some skills (kg) are target-repo-
  // specific — the shared skills-template/ at root seeds each instance.
  const slugs = listInstanceSlugs();
  if (slugs.length === 0) {
    p.log.info('No instances configured yet — run `flockbots init` to create one.');
  } else {
    let totalCopied = 0;
    for (const slug of slugs) {
      try {
        const instanceHome = join(instancesDir(), slug);
        const { copied } = ensureSkillsFromTemplate(instanceHome, home);
        if (copied.length > 0) {
          p.log.info(`[${slug}] added ${copied.length} new skill file${copied.length === 1 ? '' : 's'}:`);
          for (const f of copied.slice(0, 10)) p.log.message(`  + skills/${f}`);
          if (copied.length > 10) p.log.message(`  (+ ${copied.length - 10} more)`);
          totalCopied += copied.length;
        }
      } catch (err: any) {
        p.log.warn(`[${slug}] skills sync skipped: ${err?.message || String(err)}`);
      }
    }
    if (totalCopied === 0) p.log.info('Skills already up to date.');
  }

  // Try pm2 restart — matches every flockbots:<slug> app via regex. Silent
  // failure if pm2 isn't running anything.
  try {
    execSync('pm2 restart /^flockbots:/', { stdio: 'ignore' });
    p.log.success('pm2 restart /^flockbots:/ — coordinator(s) restarted');
  } catch {
    p.log.info('pm2 restart skipped (not running). Restart FlockBots manually.');
  }

  // Redeploy linked Vercel projects so dashboard + relay advance in lockstep
  // with the coordinator. Only fires if the user already linked them via
  // `flockbots dashboard deploy` / `flockbots webhook deploy`. Best effort —
  // a Vercel hiccup shouldn't block the local upgrade.
  for (const subdir of ['dashboard', 'webhook-relay']) {
    const dir = join(home, subdir);
    if (existsSync(dir) && isVercelLinked(dir)) {
      const spin = p.spinner();
      spin.start(`Redeploying ${subdir} to Vercel`);
      const ok = await new Promise<boolean>((resolve) => {
        const proc = spawn('npx', ['--yes', 'vercel', '--prod', '--yes'], {
          cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        proc.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
        proc.stderr?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
        proc.on('exit', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
      });
      if (ok) spin.stop(`${subdir} redeployed`);
      else spin.stop(`${subdir} redeploy failed — re-run \`flockbots ${subdir === 'dashboard' ? 'dashboard' : 'webhook'} deploy\` to retry`);
    }
  }

  p.outro('Upgrade complete.');
}
