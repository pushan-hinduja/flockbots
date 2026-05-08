import { db, logEvent, Task } from './queue';
import { notifyOperator } from './notifier';
import { presentMessage } from './presenter';
import { syncToSupabase } from './supabase-sync';

/**
 * Effort-based staleness timeouts (in ms).
 * If a task's updated_at hasn't changed within this window, it's stuck.
 */
const STALENESS_TIMEOUT: Record<string, number> = {
  'XS': 45 * 60 * 1000,   // 45 min
  'S':  45 * 60 * 1000,   // 45 min
  'M':  60 * 60 * 1000,   // 60 min
  'L':  90 * 60 * 1000,   // 90 min
  'XL': 90 * 60 * 1000,   // 90 min
};
const DEFAULT_TIMEOUT = 60 * 60 * 1000; // 60 min fallback

// Active states that should be progressing. wireframes_rendering and
// awaiting_design_approval are intentionally excluded — the first is sub-second
// (Playwright batch render), the second is unbounded (waiting for human
// reply) and shouldn't trigger a stuck-task alarm.
const ACTIVE_STATES = [
  'researching', 'designing', 'design_validation',
  'developing', 'testing', 'reviewing',
];

/**
 * Check for tasks stuck in active states past their expected duration.
 * Called on a cron (every 5 minutes).
 */
export async function checkStaleTasks(): Promise<void> {
  const now = Date.now();

  const activeTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status IN (${ACTIVE_STATES.map(() => '?').join(',')})
  `).all(...ACTIVE_STATES) as Task[];

  for (const task of activeTasks) {
    const timeout = STALENESS_TIMEOUT[task.effort_size || 'M'] || DEFAULT_TIMEOUT;
    const age = now - task.updated_at;

    if (age > timeout) {
      logEvent(task.id, 'staleness', 'task_stuck',
        `Task stuck in "${task.status}" for ${Math.round(age / 60000)} min (timeout: ${Math.round(timeout / 60000)} min)`);

      // Check retry count — if already retried, escalate
      if (task.retry_count >= 2) {
        db.prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?')
          .run('awaiting_human', JSON.stringify({ previous_status: task.status, reason: 'staleness_timeout' }), now, task.id);

        const fallback =
          `Task stuck: ${task.title}\n` +
          `Status "${task.status}" for ${Math.round(age / 60000)} min\n` +
          `Retried ${task.retry_count} times — needs manual review`;
        const presented = await presentMessage({
          intent: 'task_stalled',
          data: {
            taskId: task.id,
            taskTitle: task.title,
            status: task.status,
            stuckMinutes: Math.round(age / 60000),
            retryCount: task.retry_count,
            replyHints: [`/retry ${task.id}`, `/dismiss ${task.id}`],
          },
          fallback,
        });
        await notifyOperator(presented);
        await syncToSupabase('task_update', { id: task.id });
      } else {
        // Retry: reset to the beginning of the current stage
        db.prepare('UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?')
          .run(now, task.id);

        logEvent(task.id, 'staleness', 'retry',
          `Retrying stuck task (attempt ${task.retry_count + 1})`);
        await syncToSupabase('task_update', { id: task.id });
      }
    }
  }
}
