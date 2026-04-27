import { execSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { instancesDir, listInstanceSlugs } from '../paths';
import { extractInstanceFlag, readInstanceEnv } from './env';

type ClackModule = typeof import('@clack/prompts');

/**
 * `flockbots remove [-i <slug>]` — tear down a single instance:
 *   1. Resolve the slug + read its .env (pm2 stop will lose the env later).
 *   2. Best-effort Supabase archive (archived_at = now()).
 *   3. pm2 stop / delete / save for `flockbots:<slug>`.
 *   4. Clean target repo's .worktrees.
 *   5. rm -rf <root>/instances/<slug>/.
 *
 * Order matters: read the .env BEFORE deleting the dir, archive in Supabase
 * BEFORE the pm2 process disappears (technically harmless either way, but
 * keeps the "done before destroy" pattern consistent).
 */
export async function runRemove(args: string[]): Promise<void> {
  const p = await import('@clack/prompts');
  const { instanceId } = extractInstanceFlag(args);

  const slugs = listInstanceSlugs();
  if (slugs.length === 0) {
    console.error('No FlockBots instances configured. Nothing to remove.');
    process.exit(1);
  }

  p.intro('Remove FlockBots instance');

  // Resolve which slug to remove
  let slug: string;
  if (instanceId) {
    if (!slugs.includes(instanceId)) {
      p.cancel(`Unknown instance '${instanceId}'. Known: ${slugs.join(', ')}.`);
      return;
    }
    slug = instanceId;
  } else if (slugs.length === 1) {
    slug = slugs[0];
  } else {
    const picked = await p.select({
      message: 'Which instance do you want to remove?',
      options: slugs.map((s) => ({ value: s, label: s })),
    });
    if (p.isCancel(picked)) {
      p.cancel('Cancelled.');
      return;
    }
    slug = picked as string;
  }

  // Read the instance's .env so we can archive in Supabase + clean its
  // target repo worktrees AFTER the dir is gone. We don't loadEnvFile()
  // here because that pollutes process.env for the rest of the run.
  const env = readInstanceEnv(slug);
  const targetRepoPath = env.TARGET_REPO_PATH || '';
  const supabaseUrl = env.SUPABASE_URL || '';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const chatProvider = env.CHAT_PROVIDER || '';
  const githubAppId = env.GITHUB_APP_ID || '';
  const reviewerAppId = env.REVIEWER_GITHUB_APP_ID || '';

  const home = join(instancesDir(), slug);
  const worktreeDir = targetRepoPath ? join(targetRepoPath, '.worktrees') : '';
  const willCleanWorktrees = !!worktreeDir && existsSync(worktreeDir);

  const plan: string[] = [`Remove instance '${slug}':`, ''];
  plan.push(`  • pm2 process flockbots:${slug}`);
  plan.push(`  • ${home}  (config + keys + queue + logs)`);
  if (willCleanWorktrees) plan.push(`  • ${worktreeDir}  (agent worktrees)`);
  if (supabaseUrl && serviceKey) plan.push('  • Supabase row archived (history preserved, hidden from dashboard)');
  plan.push('');
  const remaining = slugs.filter((s) => s !== slug);
  if (remaining.length === 0) {
    plan.push('This is your only instance. Run `flockbots uninstall` if you want to');
    plan.push('remove FlockBots itself afterwards.');
  } else {
    plan.push(`Other instances will keep running: ${remaining.join(', ')}`);
  }
  p.note(plan.join('\n'), 'Plan');

  // Real type-confirm — accidental Enter on a y/n is too easy for a
  // destructive op that wipes pm2 + dir + worktrees.
  const typed = await p.text({
    message: `Type the slug '${slug}' to confirm removal:`,
    placeholder: slug,
    validate: (v) => (v.trim() === slug ? undefined : `Must match '${slug}' exactly.`),
  });
  if (p.isCancel(typed)) {
    p.cancel('Cancelled.');
    return;
  }

  // 1. Best-effort Supabase archive — do it BEFORE we kill pm2/dir, so a
  // mid-run failure leaves the operator able to re-try.
  if (supabaseUrl && serviceKey) {
    const spin = p.spinner();
    spin.start('Archiving instance in Supabase');
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(supabaseUrl, serviceKey);
      const { error } = await sb.from('flockbots_instances')
        .update({ archived_at: new Date().toISOString() })
        .eq('id', slug);
      if (error) {
        spin.stop(`Supabase archive failed: ${error.message}`);
        p.log.warn('Continuing — you can clean up the row manually.');
      } else {
        spin.stop('Supabase row archived');
      }
    } catch (err: any) {
      spin.stop(`Supabase archive errored: ${err?.message || String(err)}`);
      p.log.warn('Continuing — you can clean up the row manually.');
    }
  }

  // 2. Stop + delete pm2 app. Silent failure (pm2 not running, app not
  // registered) — the next step still proceeds.
  safeExec(`pm2 stop flockbots:${slug}`);
  safeExec(`pm2 delete flockbots:${slug}`);
  safeExec('pm2 save');
  p.log.success(`pm2 flockbots:${slug} stopped and removed`);

  // pm2 saved-list staleness check: if the daemon was down when we ran
  // stop/delete/save, those commands no-op'd and the dump file still has
  // our slug — `pm2 resurrect` later would try to start a coordinator with
  // no instance dir. Inspect the artifact directly so we don't depend on
  // daemon-up auto-start side effects.
  const pm2Dump = join(homedir(), '.pm2', 'dump.pm2');
  if (existsSync(pm2Dump)) {
    try {
      const dump = readFileSync(pm2Dump, 'utf-8');
      if (dump.includes(`"flockbots:${slug}"`)) {
        p.log.warn(
          `Stale 'flockbots:${slug}' entry still in ${pm2Dump} — pm2 daemon was probably down.`
        );
        p.log.warn(
          `Once pm2 is running, run: pm2 delete flockbots:${slug} && pm2 save`
        );
      }
    } catch {
      // Can't read dump — skip the check, not worth surfacing
    }
  }

  // 3. Clean .worktrees inside the target repo. Worktrees are ephemeral
  // per-task working dirs; safe to drop on instance removal.
  if (willCleanWorktrees) {
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
      p.log.success(`cleaned ${worktreeDir}`);
    } catch (err: any) {
      p.log.warn(`could not remove ${worktreeDir}: ${err.message}`);
    }
  }

  // 4. Remove the instance dir
  try {
    rmSync(home, { recursive: true, force: true });
    p.log.success(`removed ${home}`);
  } catch (err: any) {
    p.log.warn(`could not remove ${home}: ${err.message}`);
  }

  // 5. Revocation checklist — hedged for GitHub App reuse and tailored to
  // the chat provider this instance was using.
  const checklist = buildChecklist({
    slug,
    chatProvider,
    githubAppId,
    reviewerAppId,
    remainingSlugs: remaining,
  });
  if (checklist.length > 0) {
    p.note(checklist.join('\n'), 'External services to revoke');
  }

  p.outro(`Removed instance '${slug}'.`);
}

interface ChecklistInput {
  slug: string;
  chatProvider: string;
  githubAppId: string;
  reviewerAppId: string;
  remainingSlugs: string[];
}

function buildChecklist(input: ChecklistInput): string[] {
  const lines: string[] = [];

  // GitHub Apps — hedge based on whether other instances still reference
  // the same app (step 4b enables app reuse across instances).
  const remainingAppIds = collectGithubAppIds(input.remainingSlugs);
  const agentReused = !!input.githubAppId && remainingAppIds.agent.has(input.githubAppId);
  const reviewerReused = !!input.reviewerAppId && remainingAppIds.reviewer.has(input.reviewerAppId);

  lines.push('GitHub Apps — github.com/settings/apps');
  if (input.githubAppId) {
    if (agentReused) {
      lines.push(`  · Agent App ${input.githubAppId} is still used by another instance — keep it`);
    } else {
      lines.push(`  · Agent App ${input.githubAppId} — uninstall from your repo, or delete entirely`);
    }
  }
  if (input.reviewerAppId) {
    if (reviewerReused) {
      lines.push(`  · Reviewer App ${input.reviewerAppId} is still used by another instance — keep it`);
    } else {
      lines.push(`  · Reviewer App ${input.reviewerAppId} — uninstall from your repo, or delete entirely`);
    }
  }

  // Chat provider — bot/app credentials are per-instance by design (step 4a)
  if (input.chatProvider) lines.push('');
  if (input.chatProvider === 'telegram') {
    lines.push('Telegram bot — DM @BotFather → /deletebot');
  } else if (input.chatProvider === 'slack') {
    lines.push('Slack app — api.slack.com/apps → Delete App');
  } else if (input.chatProvider === 'whatsapp') {
    lines.push('WhatsApp — Meta Business Settings → Apps');
    lines.push('  Also remove this instance\'s callback path from the Meta webhook config.');
  }

  // GitHub branches/PRs the agents created on this instance's target repo
  // aren't deleted by `remove` — agent-created branches sit on the remote.
  lines.push('');
  lines.push(`GitHub branches/PRs on the target repo`);
  lines.push(`  · Open PRs from the agent are still on GitHub — close or merge any leftovers.`);
  lines.push(`  · Stale agent branches: gh api repos/<owner>/<repo>/branches | jq '.[].name | select(test("^agent/"))'`);

  // Linear / Supabase aren't per-instance — Supabase is shared, Linear key
  // is shared. So nothing to revoke there on a single-instance removal.
  if (input.remainingSlugs.length === 0) {
    lines.push('');
    lines.push('Last instance removed — Supabase project + Linear API key are no');
    lines.push('longer needed. Use `flockbots uninstall` to remove FlockBots itself.');
  }

  return lines;
}

/**
 * Read GITHUB_APP_ID + REVIEWER_GITHUB_APP_ID from each remaining instance
 * so the revocation checklist can hedge on apps that are still in use.
 */
function collectGithubAppIds(slugs: string[]): { agent: Set<string>; reviewer: Set<string> } {
  const agent = new Set<string>();
  const reviewer = new Set<string>();
  for (const slug of slugs) {
    const env = readInstanceEnv(slug);
    if (env.GITHUB_APP_ID) agent.add(env.GITHUB_APP_ID);
    if (env.REVIEWER_GITHUB_APP_ID) reviewer.add(env.REVIEWER_GITHUB_APP_ID);
  }
  return { agent, reviewer };
}

function safeExec(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
