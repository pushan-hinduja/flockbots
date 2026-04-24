import { existsSync } from 'fs';
import { join } from 'path';
import simpleGit from 'simple-git';
import { db, logEvent, dismissEscalationsForTask } from './queue';
import { cleanupWorktree } from './worktree-manager';
import { syncToSupabase, getSupabaseClient } from './supabase-sync';
import { readJSON, TASKS_DIR } from './session-manager';

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH || '';

/**
 * Retry a failed task. Resumes from the latest safe checkpoint:
 * - If PM research exists → dev_ready (skip PM, reuse research artifacts)
 * - Otherwise → inbox (start from scratch)
 */
export async function retryTask(taskId: string): Promise<string> {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  if (!task) return `Task ${taskId} not found`;
  if (task.status !== 'failed') return `Can only retry failed tasks (current: ${task.status})`;

  // Determine resume point based on existing artifacts
  const contextPath = join(TASKS_DIR, taskId, 'context.json');
  const hasResearch = existsSync(contextPath) && !!readJSON(contextPath)?.research;
  const resumeStatus = hasResearch ? 'dev_ready' : 'inbox';

  // Clean up worktree and branch from previous attempt
  try { await cleanupWorktree(taskId); } catch {}
  if (task.branch_name && TARGET_REPO_PATH) {
    try {
      await simpleGit(TARGET_REPO_PATH).branch(['-D', task.branch_name]);
    } catch {}
  }

  // Reset task state
  db.prepare(`
    UPDATE tasks SET
      status = ?, error = NULL, retry_count = 0, test_retry_count = 0,
      worktree_path = NULL, branch_name = NULL, pr_url = NULL, pr_number = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(resumeStatus, Date.now(), taskId);

  dismissEscalationsForTask(taskId);
  logEvent(taskId, 'system', 'task_retried',
    `Retrying from ${resumeStatus} (research artifacts: ${hasResearch ? 'reused' : 'none'})`);
  await syncToSupabase('task_update', { id: taskId });

  return `Task ${taskId} queued for retry at ${resumeStatus}`;
}

/**
 * Dismiss a task — removes it from the pipeline regardless of current status.
 */
export async function dismissTask(taskId: string): Promise<string> {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  if (!task) return `Task ${taskId} not found`;
  if (task.status === 'dismissed' || task.status === 'merged') return `Task ${taskId} is already ${task.status}`;

  try { await cleanupWorktree(taskId); } catch {}

  db.prepare('UPDATE tasks SET status = ?, error = NULL, updated_at = ? WHERE id = ?')
    .run('dismissed', Date.now(), taskId);

  dismissEscalationsForTask(taskId);
  logEvent(taskId, 'system', 'task_dismissed', 'Task dismissed from dashboard');
  await syncToSupabase('task_update', { id: taskId });

  return `Task ${taskId} dismissed`;
}

/**
 * Move a task back to a previous pipeline stage.
 * Tasks can only move backward, never forward. Merged tasks cannot be reverted.
 */
const STAGE_ORDER = ['inbox', 'researching', 'design_pending', 'designing', 'design_review', 'dev_ready', 'developing', 'testing', 'review_pending', 'reviewing'];

export async function revertTaskStage(taskId: string, targetStatus: string): Promise<string> {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  if (!task) return `Task ${taskId} not found`;
  if (task.status === 'merged') return `Cannot revert a merged task`;
  if (task.status === 'dismissed') return `Cannot revert a dismissed task`;

  const currentIdx = STAGE_ORDER.indexOf(task.status);
  const targetIdx = STAGE_ORDER.indexOf(targetStatus);

  if (targetIdx === -1) return `Invalid target status: ${targetStatus}`;
  if (currentIdx !== -1 && targetIdx >= currentIdx) return `Can only move backward (current: ${task.status}, target: ${targetStatus})`;

  // Clean up worktree/branch if moving back before dev stages
  if (targetIdx < STAGE_ORDER.indexOf('dev_ready') && task.worktree_path) {
    try { await cleanupWorktree(taskId); } catch {}
    if (task.branch_name && TARGET_REPO_PATH) {
      try { await simpleGit(TARGET_REPO_PATH).branch(['-D', task.branch_name]); } catch {}
    }
    db.prepare('UPDATE tasks SET worktree_path = NULL, branch_name = NULL, pr_url = NULL, pr_number = NULL WHERE id = ?')
      .run(taskId);
  }

  // Reset retry counts when reverting
  db.prepare('UPDATE tasks SET status = ?, retry_count = 0, test_retry_count = 0, error = NULL, updated_at = ? WHERE id = ?')
    .run(targetStatus, Date.now(), taskId);

  dismissEscalationsForTask(taskId);
  logEvent(taskId, 'system', 'task_reverted', `Moved back to ${targetStatus} (was ${task.status})`);
  await syncToSupabase('task_update', { id: taskId });

  return `Task ${taskId} moved to ${targetStatus}`;
}

/**
 * Poll Supabase webhook_inbox for dashboard actions (retry/dismiss).
 * Follows the same pattern as the WhatsApp bot polling.
 */
export async function pollDashboardActions(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const { data: actions, error } = await supabase
    .from('webhook_inbox')
    .select('*')
    .eq('processed', false)
    .eq('source', 'dashboard')
    .order('created_at', { ascending: true })
    .limit(10);

  if (error || !actions || actions.length === 0) return;

  for (const action of actions) {
    const { action: actionType, task_id: taskId } = action.payload || {};

    try {
      let result: string;
      switch (actionType) {
        case 'retry':
          result = await retryTask(taskId);
          break;
        case 'dismiss':
          result = await dismissTask(taskId);
          break;
        case 'revert_stage':
          result = await revertTaskStage(taskId, action.payload?.target_status);
          break;
        default:
          result = `Unknown action: ${actionType}`;
      }
      logEvent(taskId || null, 'dashboard', 'action_processed', result);
    } catch (err: any) {
      console.error('Dashboard action error:', err.message);
    }

    await supabase.from('webhook_inbox').update({ processed: true }).eq('id', action.id);
  }
}
