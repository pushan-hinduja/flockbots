import { execSync, spawnSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadEnvFile } from './env';

const BIN_SYMLINK = '/usr/local/bin/flockbots';

function safeExec(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * `flockbots uninstall` — removes every local artifact FlockBots installed
 * (pm2 process, /usr/local/bin symlink, ~/.flockbots dir with its state,
 * target-repo worktrees) and prints a checklist of external services the
 * user has to revoke manually (GitHub Apps, chat bots, Supabase project,
 * Linear key). Requires explicit confirmation.
 *
 * Self-delete note: we remove ~/.flockbots/ while running from inside it.
 * On Unix, rmSync() unlinks the directory entries but Node's existing
 * file descriptors stay valid until process exit, so the remaining code
 * in this function still executes cleanly.
 */
export async function runUninstall(): Promise<void> {
  const p = await import('@clack/prompts');
  loadEnvFile();

  const home = process.env.FLOCKBOTS_HOME || join(homedir(), '.flockbots');
  const targetRepo = process.env.TARGET_REPO_PATH || '';
  const worktreesDir = targetRepo ? join(targetRepo, '.worktrees') : '';

  p.intro('FlockBots uninstall');

  const plan: string[] = ['This will remove from your machine:', ''];
  plan.push('  • pm2 process "flockbots" (if running)');
  if (existsSync(BIN_SYMLINK)) plan.push(`  • ${BIN_SYMLINK}  (may prompt sudo)`);
  if (existsSync(home)) plan.push(`  • ${home}  (code + config + keys + state)`);
  if (worktreesDir && existsSync(worktreesDir)) plan.push(`  • ${worktreesDir}  (agent worktrees)`);
  plan.push('');
  plan.push('External services (GitHub Apps, chat bot, Supabase, Linear)');
  plan.push('are NOT affected — revoke them yourself after.');
  p.note(plan.join('\n'), 'Plan');

  const sure = await p.confirm({ message: 'Proceed with uninstall?', initialValue: false });
  if (p.isCancel(sure) || !sure) {
    p.cancel('Uninstall cancelled.');
    return;
  }

  // 1. Stop pm2 process (silent failure if pm2 is absent / nothing running)
  if (safeExec('pm2 stop flockbots')) p.log.success('stopped pm2 process');
  safeExec('pm2 delete flockbots');
  safeExec('pm2 save');

  // 2. Remove the CLI symlink
  if (existsSync(BIN_SYMLINK)) {
    if (safeExec(`rm "${BIN_SYMLINK}"`)) {
      p.log.success(`removed ${BIN_SYMLINK}`);
    } else {
      p.log.message(`requesting sudo to remove ${BIN_SYMLINK}`);
      const res = spawnSync('sudo', ['rm', BIN_SYMLINK], { stdio: 'inherit' });
      if (res.status === 0) {
        p.log.success(`removed ${BIN_SYMLINK} (sudo)`);
      } else {
        p.log.warn(`could not remove ${BIN_SYMLINK} — run: sudo rm ${BIN_SYMLINK}`);
      }
    }
  }

  // 3. Clean target-repo .worktrees
  if (worktreesDir && existsSync(worktreesDir)) {
    try {
      rmSync(worktreesDir, { recursive: true, force: true });
      p.log.success(`cleaned ${worktreesDir}`);
    } catch (err: any) {
      p.log.warn(`could not remove ${worktreesDir}: ${err.message}`);
    }
  }

  // 4. Remove ~/.flockbots — this removes the directory holding our own
  // running script. On Unix the rm succeeds, our file descriptors stay
  // valid, and the code below keeps executing.
  if (existsSync(home)) {
    try {
      rmSync(home, { recursive: true, force: true });
      p.log.success(`removed ${home}`);
    } catch (err: any) {
      p.log.warn(`could not remove ${home}: ${err.message}`);
    }
  }

  // 5. Checklist for things we can't delete remotely
  p.note([
    "Revoke these yourself (we can't do it from here):",
    '',
    '  GitHub Apps — github.com/settings/apps',
    '    · FlockBots Agent',
    '    · FlockBots Reviewer',
    '',
    '  Chat provider',
    '    · Telegram: DM @BotFather → /deletebot',
    '    · Slack:    api.slack.com/apps → Delete App',
    '    · WhatsApp: Meta Business Settings → Apps',
    '',
    '  Supabase — dashboard → Settings → General → Delete project',
    '  Linear   — Settings → API → revoke the FlockBots key',
  ].join('\n'), 'External services to revoke');

  p.outro('FlockBots removed. Thanks for trying it.');
}
