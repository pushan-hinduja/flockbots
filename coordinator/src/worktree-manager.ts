import simpleGit, { SimpleGit } from 'simple-git';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { db, logEvent } from './queue';
import { GITHUB_STAGING_BRANCH } from './github-auth';

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH || '';
const WORKTREE_DIR = join(TARGET_REPO_PATH, '.worktrees');

// AI conflict resolver limits — above these, skip straight to re-dev.
const AI_RESOLVER_MAX_FILES = 3;
const AI_RESOLVER_MAX_MARKERS_PER_FILE = 20;
const AI_RESOLVER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function createWorktree(taskId: string): Promise<string> {
  if (!TARGET_REPO_PATH) throw new Error('TARGET_REPO_PATH not configured');
  const git: SimpleGit = simpleGit(TARGET_REPO_PATH);
  const branchName = `task/${taskId}`;
  const worktreePath = join(WORKTREE_DIR, `task-${taskId}`);

  // Clean up stale worktree/branch from a previous attempt
  if (existsSync(worktreePath)) {
    try { await git.raw(['worktree', 'remove', worktreePath, '--force']); } catch {}
  }
  await git.raw(['worktree', 'prune']).catch(() => {});
  try { await git.branch(['-D', branchName]); } catch {}

  // Bootstrap empty repo: a brand-new GitHub repo has no branches at all,
  // so `git fetch origin <staging>` fails with "couldn't find remote ref".
  // Detect that case and seed origin/<staging> with an initial commit so
  // the rest of the pipeline can proceed normally. Idempotent — only fires
  // when the remote actually has zero branches.
  await ensureRemoteStagingExists(git, taskId);

  // Fetch latest staging without checking it out (avoids mutating main repo HEAD)
  await git.fetch('origin', GITHUB_STAGING_BRANCH);

  // Create worktree from origin/staging — does not touch main repo working directory
  await git.raw(['worktree', 'add', '-b', branchName, worktreePath, `origin/${GITHUB_STAGING_BRANCH}`]);

  logEvent(taskId, 'system', 'worktree_created', `Worktree at ${worktreePath}, branch ${branchName}`);
  return worktreePath;
}

/**
 * Make sure `origin/<staging>` exists. If the remote has zero branches
 * (brand-new GitHub repo, no commits) we create an initial empty commit
 * locally and push it as the staging branch so subsequent worktrees can
 * branch from it. If the remote has SOME branches but not staging, we
 * push our local HEAD as staging.
 *
 * No-op when origin/<staging> already exists (the common path).
 */
async function ensureRemoteStagingExists(git: SimpleGit, taskId: string): Promise<void> {
  const stagingRef = await git.raw(['ls-remote', '--heads', 'origin', GITHUB_STAGING_BRANCH]).catch(() => '');
  if (stagingRef.trim().length > 0) return; // staging already exists on remote

  // Check whether the remote is COMPLETELY empty (no branches at all)
  // vs has-branches-but-no-staging. Different recovery paths.
  const allRefs = await git.raw(['ls-remote', '--heads', 'origin']).catch(() => '');
  const isEmptyRemote = allRefs.trim().length === 0;

  // Make sure we have at least one local commit. A fresh `git clone` of an
  // empty repo leaves no HEAD; without a commit we have nothing to push.
  let hasLocalCommit = true;
  try {
    await git.raw(['rev-parse', 'HEAD']);
  } catch {
    hasLocalCommit = false;
  }
  if (!hasLocalCommit) {
    // Configure committer if needed (for fresh clones with no user.name)
    try { await git.raw(['config', 'user.email', 'flockbots@example.com']); } catch {}
    try { await git.raw(['config', 'user.name', 'FlockBots']); } catch {}
    await git.raw(['commit', '--allow-empty', '-m', 'Initial commit (FlockBots)']);
    logEvent(taskId, 'system', 'repo_bootstrapped', 'Created initial empty commit on a fresh repo.');
  }

  // Push HEAD as origin/<staging>. -u sets upstream so future fetches
  // and rebases find the right ref.
  try {
    await git.raw(['push', '-u', 'origin', `HEAD:refs/heads/${GITHUB_STAGING_BRANCH}`]);
    logEvent(
      taskId,
      'system',
      'remote_staging_seeded',
      `Pushed HEAD to origin/${GITHUB_STAGING_BRANCH} (was ${isEmptyRemote ? 'empty repo' : 'missing staging branch'}).`,
    );
  } catch (err: any) {
    throw new Error(
      `Failed to seed origin/${GITHUB_STAGING_BRANCH}: ${err.message}. ` +
      `Verify the FlockBots Agent GitHub App has push access to your target repo.`,
    );
  }
}

export async function cleanupWorktree(taskId: string): Promise<void> {
  const git: SimpleGit = simpleGit(TARGET_REPO_PATH);
  const worktreePath = join(WORKTREE_DIR, `task-${taskId}`);

  if (existsSync(worktreePath)) {
    await git.raw(['worktree', 'remove', worktreePath, '--force']);
    logEvent(taskId, 'system', 'worktree_removed', `Cleaned up ${worktreePath}`);
  }

  await git.raw(['worktree', 'prune']);
}

export function getWorktreePath(taskId: string): string {
  return join(WORKTREE_DIR, `task-${taskId}`);
}

export async function isWorktreeClean(taskId: string): Promise<boolean> {
  const worktreePath = getWorktreePath(taskId);
  const git: SimpleGit = simpleGit(worktreePath);
  const status = await git.status();
  return status.isClean();
}

export type RebaseResult =
  | { ok: true; strategy: 'rebase' | 'merge' | 'ai-resolve' }
  | { ok: false; reason: 'conflict' | 'network' | 'other'; message: string };

function isNetworkError(message: string): boolean {
  return message.includes('Could not resolve host') ||
    message.includes('unable to access') ||
    message.includes('Could not connect') ||
    message.includes('Connection refused') ||
    message.includes('timed out') ||
    message.includes('Failed to connect') ||
    message.includes('Network is unreachable');
}

async function safeAbort(worktreePath: string, op: 'rebase' | 'merge'): Promise<void> {
  try {
    const git = simpleGit(worktreePath);
    await git.raw([op, '--abort']);
  } catch (err: any) {
    // Suppress the expected "no X in progress" noise
    if (!err.message?.match(/no (rebase|merge) in progress/i)) {
      logEvent(null, 'system', 'safe_abort_failed', `${op} --abort failed: ${err.message}`);
    }
  }
}

/**
 * Inspect the worktree for conflict markers. Returns files and the largest
 * marker count per file — used to decide whether conflicts are small enough
 * for the AI resolver.
 */
async function analyzeConflicts(worktreePath: string): Promise<{ files: string[]; maxMarkersPerFile: number }> {
  const git = simpleGit(worktreePath);
  const status = await git.status();
  const files = status.conflicted.slice();
  let maxMarkers = 0;
  for (const f of files) {
    try {
      const content = readFileSync(join(worktreePath, f), 'utf-8');
      const markers = (content.match(/^<<<<<<< /gm) || []).length;
      if (markers > maxMarkers) maxMarkers = markers;
    } catch {
      // Unreadable — be conservative, treat as above threshold
      maxMarkers = AI_RESOLVER_MAX_MARKERS_PER_FILE + 1;
    }
  }
  return { files, maxMarkersPerFile: maxMarkers };
}

/**
 * Spawn a short Claude session focused solely on resolving the current merge
 * conflicts in the worktree. Uses a narrow tool set and low turn cap.
 * Not routed through session-manager's registry — conflict resolution is an
 * internal op, not a task-level session that should be kill-able via WhatsApp.
 */
async function tryAiConflictResolver(
  taskId: string, worktreePath: string, conflictedFiles: string[]
): Promise<{ resolved: boolean; message: string }> {
  const prompt = `You are resolving a git merge conflict in the current worktree. Another task merged to ${GITHUB_STAGING_BRANCH} while this branch was in progress. Your job: preserve this branch's original intent while absorbing the incoming changes from staging.

Conflicted files:
${conflictedFiles.map(f => `- ${f}`).join('\n')}

Steps:
1. For each conflicted file, Read it. Git has inserted <<<<<<<, =======, >>>>>>> markers.
2. Above "=======" is this branch's change (HEAD). Below is staging's change.
3. Combine them coherently — keep this branch's logic, incorporate compatible staging changes. Don't blindly pick one side.
4. Run \`git add <file>\` for each resolved file.
5. Run \`git commit --no-edit\` (the merge commit message is already set).
6. Run \`git status\` to verify clean state.

Rules:
- Do NOT run \`git merge --abort\`. You must resolve, not abort.
- Do NOT modify files that are not in the conflicted list.
- Do NOT create new files.
- If a conflict is too complex or risky to resolve safely (opposing logic changes, ambiguous intent), write the single line "RESOLVE_FAILED: <brief reason>" to stdout and stop. Do not leave the worktree in a half-resolved state.

Stop when the merge is committed and \`git status\` is clean.`;

  const args = [
    '-p',
    '--model', 'claude-sonnet-4-6',
    '--effort', 'medium',
    '--max-turns', '5',
    '--allowedTools', 'Read,Write,Edit,Bash',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'json',
    '--strict-mcp-config',
    '--add-dir', worktreePath,
  ];

  const output = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const proc = spawn('claude', args, {
      cwd: worktreePath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new Error('AI resolver timeout'));
    }, AI_RESOLVER_TIMEOUT_MS);
    proc.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stdout + '\n' + stderr);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();
  }).catch((err: Error) => `SPAWN_ERROR: ${err.message}`);

  // Explicit self-declared failure short-circuits the status check
  if (output.includes('RESOLVE_FAILED:')) {
    const reason = output.match(/RESOLVE_FAILED:\s*([^\n]+)/)?.[1]?.trim() || 'unknown';
    return { resolved: false, message: `Agent declined: ${reason}` };
  }
  if (output.startsWith('SPAWN_ERROR:')) {
    return { resolved: false, message: output };
  }

  // Verify the worktree ended up clean
  try {
    const git = simpleGit(worktreePath);
    const status = await git.status();
    if (status.conflicted.length > 0) {
      return { resolved: false, message: `Still has conflicts: ${status.conflicted.join(', ')}` };
    }
    if (!status.isClean()) {
      return { resolved: false, message: `Worktree dirty after resolver (unstaged changes remaining)` };
    }
    logEvent(taskId, 'system', 'ai_resolver_verified', `Worktree clean after AI resolution`);
    return { resolved: true, message: 'AI resolver succeeded and worktree is clean' };
  } catch (err: any) {
    return { resolved: false, message: `Status check failed: ${err.message}` };
  }
}

/**
 * Rebase a worktree branch on latest staging before PR creation. Escalates
 * through cheaper recovery strategies before giving up:
 *   1. git rebase origin/staging       (linear history, preferred)
 *   2. git merge origin/staging        (3-way merge, handles more cases)
 *   3. AI conflict resolver            (small conflicts only)
 *   4. Return conflict → pipeline wipes worktree and re-devs
 */
export async function rebaseOnStaging(taskId: string): Promise<RebaseResult> {
  const worktreePath = getWorktreePath(taskId);
  if (!existsSync(worktreePath)) {
    return { ok: false, reason: 'other', message: 'Worktree does not exist' };
  }

  const git = simpleGit(worktreePath);

  // ── Step 1: rebase ──
  try {
    await git.fetch('origin', GITHUB_STAGING_BRANCH);
    await git.rebase([`origin/${GITHUB_STAGING_BRANCH}`]);
    logEvent(taskId, 'system', 'rebase_success', `Rebased on latest ${GITHUB_STAGING_BRANCH}`);
    return { ok: true, strategy: 'rebase' };
  } catch (err: any) {
    const message = err.message || String(err);
    if (isNetworkError(message)) {
      logEvent(taskId, 'system', 'rebase_network_error', `Git fetch failed (network): ${message.slice(0, 300)}`);
      return { ok: false, reason: 'network', message };
    }
    await safeAbort(worktreePath, 'rebase');
    logEvent(taskId, 'system', 'rebase_conflict_fallback',
      `Rebase conflict — falling back to 3-way merge: ${message.slice(0, 200)}`);
  }

  // ── Step 2: 3-way merge ──
  try {
    await git.merge([`origin/${GITHUB_STAGING_BRANCH}`, '--no-edit']);
    logEvent(taskId, 'system', 'merge_success',
      `3-way merge with ${GITHUB_STAGING_BRANCH} succeeded (rebase had conflicted)`);
    return { ok: true, strategy: 'merge' };
  } catch (err: any) {
    const message = err.message || String(err);
    logEvent(taskId, 'system', 'merge_conflict_fallback',
      `Merge also conflicted — inspecting for AI resolver eligibility: ${message.slice(0, 200)}`);
  }

  // ── Step 3: AI conflict resolver (only for small conflicts) ──
  const conflicts = await analyzeConflicts(worktreePath);
  if (conflicts.files.length === 0) {
    // Unexpected — no conflicted files but merge failed. Abort and bail.
    await safeAbort(worktreePath, 'merge');
    return { ok: false, reason: 'conflict', message: 'Merge failed but no conflicted files detected' };
  }
  if (conflicts.files.length > AI_RESOLVER_MAX_FILES ||
      conflicts.maxMarkersPerFile > AI_RESOLVER_MAX_MARKERS_PER_FILE) {
    await safeAbort(worktreePath, 'merge');
    logEvent(taskId, 'system', 'ai_resolver_skipped',
      `Conflict too complex for AI resolver — ${conflicts.files.length} files, max ${conflicts.maxMarkersPerFile} markers/file (limits ${AI_RESOLVER_MAX_FILES} / ${AI_RESOLVER_MAX_MARKERS_PER_FILE})`);
    return {
      ok: false, reason: 'conflict',
      message: `Merge conflicts too large for AI resolver: ${conflicts.files.length} files, ${conflicts.maxMarkersPerFile} max markers per file`,
    };
  }

  logEvent(taskId, 'system', 'ai_resolver_started',
    `Invoking AI conflict resolver on ${conflicts.files.length} file(s), max ${conflicts.maxMarkersPerFile} markers/file`);
  const aiResult = await tryAiConflictResolver(taskId, worktreePath, conflicts.files);
  if (aiResult.resolved) {
    logEvent(taskId, 'system', 'ai_resolve_success', aiResult.message);
    return { ok: true, strategy: 'ai-resolve' };
  }

  await safeAbort(worktreePath, 'merge');
  logEvent(taskId, 'system', 'ai_resolve_failed', aiResult.message);
  return { ok: false, reason: 'conflict', message: `AI resolver failed: ${aiResult.message}` };
}

/**
 * Prune worktrees for tasks that are in terminal states (merged, failed)
 * or have been abandoned. Called on a periodic cron.
 */
export async function pruneStaleWorktrees(): Promise<void> {
  if (!existsSync(WORKTREE_DIR)) return;

  const git: SimpleGit = simpleGit(TARGET_REPO_PATH);
  const entries = readdirSync(WORKTREE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('task-'));

  for (const entry of entries) {
    const taskId = entry.name.replace('task-', '');
    const task = db.prepare('SELECT status, updated_at FROM tasks WHERE id = ?').get(taskId) as
      { status: string; updated_at: number } | undefined;

    const shouldClean =
      !task || // Task doesn't exist in DB — orphaned worktree
      task.status === 'merged' ||
      task.status === 'failed' ||
      (task.status === 'awaiting_human' && Date.now() - task.updated_at > 24 * 60 * 60 * 1000); // Waiting >24h

    if (shouldClean) {
      try {
        const worktreePath = join(WORKTREE_DIR, entry.name);
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
        logEvent(taskId, 'system', 'stale_worktree_pruned',
          `Pruned stale worktree (status: ${task?.status || 'unknown'})`);
      } catch (err: any) {
        console.error(`Failed to prune worktree ${entry.name}:`, err.message);
      }
    }
  }

  await git.raw(['worktree', 'prune']);
}
