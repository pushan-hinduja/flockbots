import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * `flockbots upgrade` — pulls latest from origin, rebuilds the coordinator,
 * and restarts via pm2 if it's running. Refuses to run with a dirty working
 * tree so user-edited skills/*.md don't get wiped by the git reset.
 */
export async function runUpgrade(): Promise<void> {
  const p = await import('@clack/prompts');
  p.intro('FlockBots upgrade');

  const home = process.env.FLOCKBOTS_HOME || join(homedir(), '.flockbots');
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
  // --hard` would silently wipe them — and since skills/*.md and
  // docs/templates/CLAUDE.md are tracked starter templates the user is
  // expected to edit, this is a real data-loss risk. Let the user stash or
  // commit, then re-run.
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

  // Try pm2 restart — silent failure if pm2 isn't running the process
  try {
    execSync('pm2 restart flockbots', { stdio: 'ignore' });
    p.log.success('pm2 restart flockbots — coordinator restarted');
  } catch {
    p.log.info('pm2 restart skipped (not running). Restart FlockBots manually.');
  }

  p.outro('Upgrade complete.');
}
