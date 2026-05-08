import { db, logEvent } from './queue';
import { getBudgetEstimate, isPeakHours } from './rate-limiter';

interface SchedulableTask {
  id: string;
  title: string;
  effort_size: string;
  dev_model: string;
  dev_effort: string;
  priority: number;
  status: string;
  affected_files: string | null;
  parent_task_id: string | null;
  depends_on_task_id: string | null;
}

// Track whether we've already logged the peak deferral to avoid spamming the activity feed
let peakDeferLogged = false;
let rateLimitLogged = false;

// Per-task "first deferred at" timestamp for file-overlap serialization. When a task
// stays deferred longer than STALE_DEFER_MS, bypass the overlap check so it can't
// starve behind a long-running in-flight task.
const STALE_DEFER_MS = 30 * 60 * 1000;
const firstDeferredAt = new Map<string, number>();

function parseAffectedFiles(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : null;
  } catch { return null; }
}

/** Two file paths "overlap" if they're equal or one is a directory prefix of the other. */
function pathsOverlap(a: string[], b: string[]): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '');
  const aList = a.map(norm);
  const bList = b.map(norm);
  for (const p1 of aList) {
    for (const p2 of bList) {
      if (p1 === p2) return true;
      if (p1.startsWith(p2 + '/')) return true;
      if (p2.startsWith(p1 + '/')) return true;
    }
  }
  return false;
}

/** Find in-flight tasks whose affected_files overlap with the candidate's. */
function conflictingInFlightTasks(
  candidateId: string,
  candidateFiles: string[] | null,
  candidateParentId: string | null,
): string[] {
  const inflight = db.prepare(`
    SELECT id, affected_files, parent_task_id
    FROM tasks
    WHERE status IN ('developing', 'review_pending', 'reviewing')
      AND id != ?
  `).all(candidateId) as { id: string; affected_files: string | null; parent_task_id: string | null }[];

  const conflicts: string[] = [];
  for (const other of inflight) {
    // Sibling-phase bypass: phases of the same epic are sequenced by the
    // dependency chain (depends_on_task_id), so they should never be
    // contending for the same files in practice. Skip them here so we don't
    // double-serialize.
    if (candidateParentId && other.parent_task_id === candidateParentId) continue;

    const otherFiles = parseAffectedFiles(other.affected_files);
    // Conservative fallback: if either side has no affected_files, assume overlap.
    // This serializes tasks with unknown scope so we don't ship a bad merge.
    if (!candidateFiles || candidateFiles.length === 0 ||
        !otherFiles || otherFiles.length === 0) {
      conflicts.push(other.id);
      continue;
    }
    if (pathsOverlap(candidateFiles, otherFiles)) {
      conflicts.push(other.id);
    }
  }
  return conflicts;
}

/**
 * For phases of an epic: the prior phase must be merged (or deployed) before
 * this phase can move into dev. Returns true if the candidate is blocked.
 * Non-phase tasks (no depends_on_task_id) always return false.
 */
function isBlockedByDependency(task: SchedulableTask): boolean {
  if (!task.depends_on_task_id) return false;
  const dep = db.prepare("SELECT status FROM tasks WHERE id = ?")
    .get(task.depends_on_task_id) as { status: string } | undefined;
  if (!dep) return false; // dependency disappeared; don't block
  return dep.status !== 'merged' && dep.status !== 'deployed';
}

/**
 * Picks the next task to work on based on:
 * 1. Rate limit cooldown (pause after hitting a limit)
 * 2. Peak hours (defer L/XL tasks)
 * 3. File-overlap with in-flight tasks (serialize conflicts)
 * 4. Priority
 */
export function pickNextTask(): SchedulableTask | null {
  const budget = getBudgetEstimate();

  if (budget.shouldPause) {
    if (!rateLimitLogged) {
      const resumeStr = budget.rateLimitResumeAt
        ? `until ${new Date(budget.rateLimitResumeAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : '';
      logEvent(null, 'scheduler', 'rate_limit_cooldown', `Paused ${resumeStr} — rate limit cooldown`);
      rateLimitLogged = true;
    }
    return null;
  }
  rateLimitLogged = false;

  const readyTasks = db.prepare(`
    SELECT id, title, effort_size, dev_model, dev_effort, priority, status,
           affected_files, parent_task_id, depends_on_task_id
    FROM tasks
    WHERE status = 'dev_ready'
    ORDER BY priority ASC, created_at ASC
  `).all() as SchedulableTask[];

  // Purge stale defer entries for tasks no longer in dev_ready.
  const readyIds = new Set(readyTasks.map(t => t.id));
  for (const id of firstDeferredAt.keys()) {
    if (!readyIds.has(id)) firstDeferredAt.delete(id);
  }

  if (readyTasks.length === 0) {
    peakDeferLogged = false;
    return null;
  }

  for (const task of readyTasks) {
    if (!budget.canRunEffort(task.effort_size, task.dev_model, task.dev_effort)) continue;

    // Phase-dependency check: an epic phase can't enter dev until its
    // predecessor has merged. Stays silent (no event log spam) since this is
    // the steady-state for early phases waiting on later ones.
    if (isBlockedByDependency(task)) continue;

    // File-overlap serialization
    const candidateFiles = parseAffectedFiles(task.affected_files);
    const conflicts = conflictingInFlightTasks(task.id, candidateFiles, task.parent_task_id);

    if (conflicts.length > 0) {
      const now = Date.now();
      const firstDeferred = firstDeferredAt.get(task.id);

      if (!firstDeferred) {
        firstDeferredAt.set(task.id, now);
        logEvent(task.id, 'scheduler', 'deferred_file_overlap',
          `Deferred — affected_files overlap with in-flight task(s): ${conflicts.join(', ')}`);
        continue;
      }

      if (now - firstDeferred <= STALE_DEFER_MS) {
        // Still within staleness window — stay deferred (no repeat log)
        continue;
      }

      // Starvation escape — bypass overlap check so this task can finally run
      logEvent(task.id, 'scheduler', 'overlap_check_bypassed_stale',
        `Deferred >${Math.round(STALE_DEFER_MS / 60000)}min on overlap with ${conflicts.join(', ')} — bypassing to avoid starvation`);
      firstDeferredAt.delete(task.id);
    } else {
      // Candidate clear of overlap — drop any prior defer entry
      firstDeferredAt.delete(task.id);
    }

    logEvent(task.id, 'scheduler', 'task_selected',
      `Selected task ${task.id} (${task.effort_size}, ${task.dev_model}, ${task.dev_effort}) | peak: ${budget.isPeakHours}`);
    peakDeferLogged = false;
    return task;
  }

  if (budget.isPeakHours && !peakDeferLogged) {
    // Calculate when off-peak starts (11am PT)
    const now = new Date();
    const ptTime = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
    logEvent(null, 'scheduler', 'peak_defer',
      `${readyTasks.length} task(s) deferred — L/XL scheduled for off-peak (after 11am PT, currently ${ptTime})`);
    peakDeferLogged = true;
  }

  return null;
}

export function canRunAgent(model: string, estimatedEffort: string = 'S'): boolean {
  const budget = getBudgetEstimate();
  return budget.canRunEffort(estimatedEffort, model);
}
