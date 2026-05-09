import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  db, Task, createTask, createEscalation, dismissEscalationsForTask,
  answerEscalation, logEvent,
} from './queue';
import { tasksDir } from './paths';
import { syncToSupabase } from './supabase-sync';
import { notifyOperator } from './notifier';
import { presentMessage } from './presenter';
import { randomUUID } from 'crypto';

const TASKS_DIR = tasksDir();

export interface DecompositionPhase {
  index: number;
  title: string;
  description: string;
  seam: string;
  effort: {
    size: string;
    estimated_turns: number;
    dev_model: string;
    reviewer_model: string;
    dev_effort: string;
    reviewer_effort: string;
    use_swarm?: boolean;
    skip_design?: boolean;
  };
  affected_files?: string[];
  depends_on: number | null;
}

export interface Decomposition {
  ship_mode: 'epic_branch' | 'incremental';
  rationale?: string;
  phases: DecompositionPhase[];
  integration_qa: {
    qa_required: boolean;
    qa_urls: string[];
    qa_instructions: string;
    qa_uses_canvas?: boolean;
  };
}

interface DecompositionValidation {
  valid: boolean;
  errors: string[];
  decomposition: Decomposition | null;
}

export function readDecomposition(epicId: string): Decomposition | null {
  const path = join(TASKS_DIR, epicId, 'decomposition.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Decomposition;
  } catch {
    return null;
  }
}

const VALID_SHIP_MODES = ['epic_branch', 'incremental'];
const VALID_EFFORT_SIZES = ['XS', 'S', 'M', 'L', 'XL'];

export function validateDecomposition(epicId: string): DecompositionValidation {
  const errors: string[] = [];
  const decomposition = readDecomposition(epicId);
  if (!decomposition) {
    return { valid: false, errors: ['decomposition.json missing or invalid JSON'], decomposition: null };
  }

  if (!VALID_SHIP_MODES.includes(decomposition.ship_mode)) {
    errors.push(`ship_mode must be one of: ${VALID_SHIP_MODES.join(', ')}`);
  }

  if (!Array.isArray(decomposition.phases) || decomposition.phases.length < 2) {
    errors.push('phases must be an array with at least 2 entries');
  } else {
    for (let i = 0; i < decomposition.phases.length; i++) {
      const phase = decomposition.phases[i];
      const expected = i + 1;
      if (phase.index !== expected) {
        errors.push(`phase ${i}: index should be ${expected}, got ${phase.index}`);
      }
      if (!phase.title || phase.title.length < 3) {
        errors.push(`phase ${expected}: missing or too-short title`);
      }
      if (!phase.description || phase.description.length < 20) {
        errors.push(`phase ${expected}: description must be ≥20 chars`);
      }
      if (!phase.seam || phase.seam.length < 10) {
        errors.push(`phase ${expected}: seam must describe a real architectural boundary`);
      }
      if (!phase.effort || !VALID_EFFORT_SIZES.includes(phase.effort.size)) {
        errors.push(`phase ${expected}: effort.size missing or invalid`);
      }
      const expectedDep = i === 0 ? null : i;
      if (phase.depends_on !== expectedDep) {
        errors.push(`phase ${expected}: depends_on should be ${expectedDep === null ? 'null' : expectedDep}, got ${phase.depends_on}`);
      }
    }
  }

  const intQa = decomposition.integration_qa;
  if (!intQa) {
    errors.push('integration_qa block is required');
  } else {
    if (intQa.qa_required !== true) {
      errors.push('integration_qa.qa_required must be true');
    }
    if (!Array.isArray(intQa.qa_urls) || intQa.qa_urls.length === 0) {
      errors.push('integration_qa.qa_urls must be a non-empty array');
    }
    if (!intQa.qa_instructions || intQa.qa_instructions.length < 20) {
      errors.push('integration_qa.qa_instructions must be a substantive string');
    }
  }

  return { valid: errors.length === 0, errors, decomposition };
}

/**
 * Helper: is this task a phase under an epic? Read parent flag fresh from DB
 * because the in-memory Task may predate the parent's promotion to epic.
 */
export function isEpicPhase(task: Task): boolean {
  if (!task.parent_task_id) return false;
  const parent = db.prepare('SELECT is_epic FROM tasks WHERE id = ?')
    .get(task.parent_task_id) as { is_epic: number } | undefined;
  return parent?.is_epic === 1;
}

export function getEpicForPhase(task: Task): Task | null {
  if (!task.parent_task_id) return null;
  const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.parent_task_id) as Task | undefined;
  return parent && parent.is_epic === 1 ? parent : null;
}

/**
 * Resolve the base branch a task should branch from / PR into. Phases of an
 * epic build on top of `epic/<epicId>`; everything else builds on staging.
 * Caller passes its own staging-branch fallback to avoid importing
 * github-auth here (keeps the dependency graph linear).
 */
export function getBaseBranchForTask(task: Task, stagingFallback: string): string {
  if (task.parent_task_id) {
    const parent = db.prepare('SELECT is_epic FROM tasks WHERE id = ?')
      .get(task.parent_task_id) as { is_epic: number } | undefined;
    if (parent?.is_epic === 1) return `epic/${task.parent_task_id}`;
  }
  return stagingFallback;
}

/**
 * Move a freshly-decomposed task into the approval gate. Persists epic
 * markers, transitions to epic_awaiting_approval, creates an escalation
 * (so the dashboard surfaces it), and notifies the operator via WhatsApp
 * with the phase plan.
 */
export async function enterEpicApprovalGate(
  task: Task,
  decomposition: Decomposition,
  updateStatus: (taskId: string, status: string) => Promise<void>,
): Promise<void> {
  db.prepare(`
    UPDATE tasks SET
      is_epic = 1,
      ship_mode = ?,
      total_phases = ?,
      updated_at = ?
    WHERE id = ?
  `).run(decomposition.ship_mode, decomposition.phases.length, Date.now(), task.id);

  const phaseLines = decomposition.phases.map((p) => {
    const turns = p.effort?.estimated_turns ? `~${p.effort.estimated_turns} turns` : '?';
    return `${p.index}. ${p.title} (${p.effort?.size || '?'}, ${turns}) — seam: ${p.seam}`;
  });

  // Deterministic fallback — used as the dashboard escalation row body and
  // as the chat message if the presenter LLM fails. Stable on its own.
  const fallback = [
    `Epic plan ready: ${task.title}`,
    `${decomposition.phases.length} phases · ship_mode=${decomposition.ship_mode}`,
    '',
    ...phaseLines,
    '',
    decomposition.rationale ? `Why: ${decomposition.rationale}` : '',
    '',
    `Reply yes to start, no to cancel.`,
  ].filter(Boolean).join('\n');

  // Friendly chat message via the Haiku presenter. Inbound replies are
  // routed via the WhatsApp router so the operator can answer in plain
  // language ("yes" / "no" / free-text).
  const chatMsg = await presentMessage({
    intent: 'epic_approval_request',
    data: {
      taskId: task.id,
      taskTitle: task.title,
      phaseCount: decomposition.phases.length,
      shipMode: decomposition.ship_mode,
      rationale: decomposition.rationale || null,
      phases: decomposition.phases.map((p) => ({
        index: p.index,
        title: p.title,
        size: p.effort?.size || '?',
        estimatedTurns: p.effort?.estimated_turns || null,
        seam: p.seam,
      })),
      replyHints: {
        approve: ['yes', 'approve', 'go', 'start', 'lgtm'],
        cancel:  ['no', 'cancel', 'abort', 'skip'],
      },
    },
    fallback,
  });

  await updateStatus(task.id, 'epic_awaiting_approval');
  // Use the deterministic fallback for the dashboard escalation row so its
  // banner stays stable regardless of what the presenter produced.
  createEscalation(task.id, fallback, JSON.stringify({ kind: 'epic_approval' }));
  logEvent(task.id, 'system', 'epic_approval_requested',
    `Decomposition into ${decomposition.phases.length} phases awaiting approval`);
  await notifyOperator(chatMsg);
}

export async function cancelEpic(epicId: string): Promise<string> {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(epicId) as Task | undefined;
  if (!task) return `Epic ${epicId} not found`;
  if (task.is_epic !== 1) return `Task ${epicId} is not an epic`;
  if (task.status !== 'epic_awaiting_approval') {
    return `Epic ${epicId} is "${task.status}", not awaiting approval`;
  }
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run('dismissed', Date.now(), epicId);
  dismissEscalationsForTask(epicId);
  logEvent(epicId, 'system', 'epic_cancelled', 'Operator declined the decomposition');
  await syncToSupabase('task_update', { id: epicId });
  return `Epic ${epicId} cancelled.`;
}

/**
 * Create one task row per phase listed in decomposition.json. Phases inherit
 * the epic's priority and are linked via parent_task_id + phase_index +
 * depends_on_task_id (linear chain in v1). Source is 'epic-phase' so the
 * Linear sync skips them.
 */
export async function spawnEpicPhases(epicId: string): Promise<{
  success: boolean;
  message: string;
  phaseIds?: string[];
}> {
  const epic = db.prepare('SELECT * FROM tasks WHERE id = ?').get(epicId) as Task | undefined;
  if (!epic) return { success: false, message: `Epic ${epicId} not found` };
  if (epic.is_epic !== 1) return { success: false, message: `Task ${epicId} is not an epic` };

  // Idempotency: refuse to re-spawn if phases already exist. Protects
  // against approveEpic being called twice across a coordinator crash.
  const existingPhases = db.prepare(
    "SELECT id FROM tasks WHERE parent_task_id = ? AND source = 'epic-phase'"
  ).all(epicId) as Array<{ id: string }>;
  if (existingPhases.length > 0) {
    return {
      success: false,
      message: `Epic ${epicId} already has ${existingPhases.length} phase(s) — refusing to re-spawn duplicates`,
      phaseIds: existingPhases.map(p => p.id),
    };
  }

  const decomposition = readDecomposition(epicId);
  if (!decomposition) {
    return { success: false, message: 'decomposition.json missing or invalid' };
  }

  const epicBranch = `epic/${epicId}`;
  db.prepare('UPDATE tasks SET epic_branch = ?, updated_at = ? WHERE id = ?')
    .run(epicBranch, Date.now(), epicId);

  // Push staging tip to origin/epic/<id> so phase 1's worktree has a real
  // remote ref to branch from. Idempotent (no-op if branch exists).
  try {
    const { ensureEpicBranchExists } = await import('./worktree-manager');
    await ensureEpicBranchExists(epicId);
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to create epic branch: ${err?.message || err}`,
    };
  }

  // Read epic's research so phases can inherit it via their pre-populated
  // context.json. Phase-mode PM is told to read the epic's context, but
  // pre-populating the phase ctx makes downstream validation (which checks
  // research.title / research.summary) pass even when the phase PM keeps
  // its output minimal.
  const epicCtxPath = join(TASKS_DIR, epicId, 'context.json');
  let epicCtx: any = {};
  try {
    if (existsSync(epicCtxPath)) {
      epicCtx = JSON.parse(readFileSync(epicCtxPath, 'utf-8'));
    }
  } catch { /* fall through with empty ctx */ }

  const phaseIds: string[] = [];
  let priorPhaseId: string | null = null;

  for (const phase of decomposition.phases) {
    const childId = randomUUID().slice(0, 8);
    createTask(childId, phase.title, phase.description, 'epic-phase', undefined, epic.priority);

    db.prepare(`
      UPDATE tasks SET
        parent_task_id = ?,
        phase_index = ?,
        total_phases = ?,
        depends_on_task_id = ?,
        effort_size = ?,
        estimated_turns = ?,
        dev_model = COALESCE(?, dev_model),
        reviewer_model = COALESCE(?, reviewer_model),
        dev_effort = COALESCE(?, dev_effort),
        reviewer_effort = COALESCE(?, reviewer_effort),
        use_swarm = ?,
        affected_files = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      epicId,
      phase.index,
      decomposition.phases.length,
      priorPhaseId,
      phase.effort?.size || null,
      phase.effort?.estimated_turns || null,
      phase.effort?.dev_model || null,
      phase.effort?.reviewer_model || null,
      phase.effort?.dev_effort || null,
      phase.effort?.reviewer_effort || null,
      phase.effort?.use_swarm ? 1 : 0,
      JSON.stringify(phase.affected_files || []),
      Date.now(),
      childId,
    );

    // Pre-populate phase context.json with inherited research + decomposition
    // effort. Phase PM will overwrite/extend, but if it doesn't, validation
    // still passes.
    const phaseDir = join(TASKS_DIR, childId);
    mkdirSync(phaseDir, { recursive: true });
    const phaseCtx = {
      research: {
        title: phase.title,
        summary: epicCtx.research?.summary || '(inherited from epic — see parent context.json)',
        affected_files: phase.affected_files || [],
        root_cause: epicCtx.research?.root_cause || null,
        related_patterns: epicCtx.research?.related_patterns || '',
        dependencies: epicCtx.research?.dependencies || '',
      },
      effort: phase.effort,
      epic_parent_id: epicId,
      phase_index: phase.index,
      seam: phase.seam,
    };
    writeFileSync(join(phaseDir, 'context.json'), JSON.stringify(phaseCtx, null, 2));

    await syncToSupabase('task_update', { id: childId });
    phaseIds.push(childId);
    priorPhaseId = childId;

    logEvent(childId, 'system', 'phase_spawned',
      `Phase ${phase.index}/${decomposition.phases.length} of epic ${epicId}: ${phase.title}`);
  }

  return { success: true, message: `Spawned ${phaseIds.length} phases`, phaseIds };
}

/**
 * Spawn the integration QA task that runs after every phase merges to the
 * epic branch and the epic branch is merged to staging. The task is a
 * normal qa_pending task with pre-populated qa context from
 * decomposition.integration_qa, so the existing runQAStage handles it
 * unchanged.
 */
export async function spawnIntegrationQATask(epic: Task): Promise<{
  success: boolean;
  message: string;
  qaTaskId?: string;
}> {
  // Idempotency: if an integration-QA child already exists, return it.
  // Protects against mergeEpicToStaging re-firing after a crash between
  // the GitHub merge and the epic_integrating status transition.
  const existing = db.prepare(
    "SELECT id FROM tasks WHERE parent_task_id = ? AND source = 'epic-qa' ORDER BY created_at DESC LIMIT 1"
  ).get(epic.id) as { id: string } | undefined;
  if (existing) {
    return {
      success: true,
      message: `Integration QA already spawned for epic ${epic.id}`,
      qaTaskId: existing.id,
    };
  }

  const decomposition = readDecomposition(epic.id);
  if (!decomposition) {
    return { success: false, message: 'decomposition.json missing or invalid for epic' };
  }
  const intQa = decomposition.integration_qa;
  if (!intQa) {
    return { success: false, message: 'decomposition has no integration_qa block' };
  }

  const qaTaskId = randomUUID().slice(0, 8);
  const title = `Integration QA: ${epic.title}`;
  const description = [
    `End-to-end QA verification for epic ${epic.id} (${decomposition.phases.length} phases merged to staging).`,
    '',
    `URLs to verify: ${intQa.qa_urls.join(', ')}`,
    '',
    `Steps: ${intQa.qa_instructions}`,
  ].join('\n');

  createTask(qaTaskId, title, description, 'epic-qa', undefined, epic.priority);

  const waitMs = parseInt(process.env.QA_DEPLOY_WAIT_MS || String(5 * 60 * 1000));
  const safeWait = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 5 * 60 * 1000;
  const readyAt = Date.now() + safeWait;

  db.prepare(`
    UPDATE tasks SET
      parent_task_id = ?,
      status = ?,
      qa_ready_at = ?,
      pr_url = ?,
      pr_number = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    epic.id,
    'qa_pending',
    readyAt,
    epic.pr_url,
    epic.pr_number,
    Date.now(),
    qaTaskId,
  );

  // Pre-populate context.json with the qa block — runQAStage reads this to
  // build the qaContext prompt for the QA agent.
  const qaTaskDir = join(TASKS_DIR, qaTaskId);
  mkdirSync(qaTaskDir, { recursive: true });
  const qaCtx = {
    research: {
      title,
      summary: `Integration QA for epic ${epic.id}: ${epic.title}`,
    },
    qa: {
      qa_required: true,
      qa_urls: intQa.qa_urls,
      qa_instructions: intQa.qa_instructions,
      qa_uses_canvas: !!intQa.qa_uses_canvas,
    },
    epic_parent_id: epic.id,
    is_integration_qa: true,
  };
  writeFileSync(join(qaTaskDir, 'context.json'), JSON.stringify(qaCtx, null, 2));

  await syncToSupabase('task_update', { id: qaTaskId });
  logEvent(qaTaskId, 'system', 'integration_qa_spawned',
    `Integration QA task spawned for epic ${epic.id}; will start in ~${Math.round(safeWait / 60000)}min`);

  return { success: true, message: 'Integration QA queued', qaTaskId };
}

/**
 * Internal: transition an epic to epic_done, dismiss any leftover
 * escalation, and mark the parent Linear ticket Done (if Linear is
 * configured and the epic was Linear-sourced). Returns the (pre-update)
 * epic row so callers can use it for messaging. Idempotent.
 */
async function markEpicDone(epicId: string): Promise<Task | null> {
  const epic = db.prepare('SELECT * FROM tasks WHERE id = ?').get(epicId) as Task | undefined;
  if (!epic || epic.is_epic !== 1) return null;
  if (epic.status === 'epic_done') return epic;

  db.prepare('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
    .run('epic_done', Date.now(), Date.now(), epicId);
  dismissEscalationsForTask(epicId);

  // Mark the parent Linear ticket Done if the epic was sourced from Linear.
  // updateLinearIssue is a no-op when Linear isn't configured for this instance.
  if (epic.source_id) {
    try {
      const { updateLinearIssue } = await import('./linear-sync');
      await updateLinearIssue(epic.source_id, 'Done', epic.pr_url || undefined);
    } catch (err: any) {
      logEvent(epicId, 'system', 'linear_update_failed',
        `Could not mark Linear issue Done: ${err?.message || err}`);
    }
  }

  await syncToSupabase('task_update', { id: epicId });
  return epic;
}

/**
 * Final transition for an epic after integration QA completes. On pass,
 * epic → epic_done (and parent Linear ticket → Done if linked). On fail,
 * epic → awaiting_human (an escalation is created so the operator sees
 * what failed; the QA-fix child task is created separately by runQAStage
 * via createQAFixTask, linked directly to the epic so
 * maybeFinalizeEpicAfterFix can close the epic when all fixes land).
 */
export async function finalizeEpic(
  epicId: string,
  qaResult: 'passed' | 'failed',
  failure?: any,
): Promise<void> {
  const epic = db.prepare('SELECT * FROM tasks WHERE id = ?').get(epicId) as Task | undefined;
  if (!epic || epic.is_epic !== 1) return;

  if (qaResult === 'passed') {
    const completed = await markEpicDone(epicId);
    if (!completed) return;
    logEvent(epicId, 'system', 'epic_done',
      `Epic completed — integration QA passed (${completed.total_phases || '?'} phases)`);
    const fallback = `Epic complete: ${completed.title}\nIntegration QA passed. PR: ${completed.pr_url || '(none)'}`;
    const presented = await presentMessage({
      intent: 'epic_complete',
      data: {
        epicId,
        epicTitle: completed.title,
        prUrl: completed.pr_url,
        phasesCount: completed.total_phases,
      },
      fallback,
    });
    await notifyOperator(presented);
    return;
  }

  // FAILED — escalate. The QA-fix child task is created separately by
  // runQAStage via createQAFixTask (linked directly to this epic with
  // source='epic-qa-fix'). The epic stays awaiting_human until
  // maybeFinalizeEpicAfterFix finishes the cycle.
  db.prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?')
    .run('awaiting_human',
      JSON.stringify({ previous_status: 'epic_integrating', integration_qa_failed: true }),
      Date.now(), epicId);

  const msg = [
    `Epic ${epicId} integration QA FAILED.`,
    `Title: ${epic.title}`,
    failure?.failing_step ? `Failing step: ${failure.failing_step}` : '',
    failure?.expected ? `Expected: ${failure.expected}` : '',
    failure?.actual ? `Actual: ${failure.actual}` : '',
    '',
    `A QA-fix task was auto-created and linked to this epic. The epic will close automatically once the fix(es) land. Reply if you'd like to abandon the epic instead.`,
  ].filter(Boolean).join('\n');
  createEscalation(epicId, msg, JSON.stringify({ kind: 'epic_integration_failed' }));
  await syncToSupabase('task_update', { id: epicId });
  const presented = await presentMessage({
    intent: 'epic_integration_qa_failed',
    data: {
      epicId,
      epicTitle: epic.title,
      failingStep: failure?.failing_step || null,
      expected: failure?.expected || null,
      actual: failure?.actual || null,
    },
    fallback: msg,
  });
  await notifyOperator(presented);
}

/**
 * After an epic-qa-fix task (or any descendant) merges, check whether the
 * epic now has any remaining in-flight fixes. If none, close out the epic
 * (mark epic_done + update Linear if applicable). Idempotent — repeated
 * calls after the epic is already done are no-ops.
 *
 * Only acts when the epic is halted on integration-QA failure
 * (status=awaiting_human with integration_qa_failed=true). Won't
 * accidentally close an epic that's halted for some other reason.
 */
export async function maybeFinalizeEpicAfterFix(epicId: string): Promise<void> {
  const epic = db.prepare('SELECT * FROM tasks WHERE id = ?').get(epicId) as Task | undefined;
  if (!epic || epic.is_epic !== 1) return;
  if (epic.status === 'epic_done' || epic.status === 'dismissed') return;
  if (epic.status !== 'awaiting_human') return;

  let integrationFailed = false;
  try {
    integrationFailed = JSON.parse(epic.error || '{}').integration_qa_failed === true;
  } catch { /* malformed error blob — be conservative and bail */ }
  if (!integrationFailed) return;

  const TERMINAL = ['merged', 'dismissed', 'failed', 'deployed'];
  const placeholders = TERMINAL.map(() => '?').join(',');
  const pending = db.prepare(`
    SELECT COUNT(*) as n FROM tasks
    WHERE parent_task_id = ?
      AND source = 'epic-qa-fix'
      AND status NOT IN (${placeholders})
  `).get(epicId, ...TERMINAL) as { n: number };
  if (pending.n > 0) return;

  const completed = await markEpicDone(epicId);
  if (!completed) return;
  logEvent(epicId, 'system', 'epic_done_after_fix',
    'Epic closed after all integration QA fix tasks merged');
  const fallback = `Epic complete: ${completed.title}\nAll integration-QA fixes merged. PR: ${completed.pr_url || '(none)'}`;
  const presented = await presentMessage({
    intent: 'epic_complete_after_fix',
    data: {
      epicId,
      epicTitle: completed.title,
      prUrl: completed.pr_url,
    },
    fallback,
  });
  await notifyOperator(presented);
}

export async function approveEpic(
  epicId: string,
  updateStatus: (taskId: string, status: string) => Promise<void>,
): Promise<string> {
  const epic = db.prepare('SELECT * FROM tasks WHERE id = ?').get(epicId) as Task | undefined;
  if (!epic) return `Epic ${epicId} not found`;
  if (epic.is_epic !== 1) return `Task ${epicId} is not an epic`;
  if (epic.status !== 'epic_awaiting_approval') {
    return `Epic ${epicId} is "${epic.status}", not awaiting approval`;
  }

  const result = await spawnEpicPhases(epicId);
  if (!result.success) return result.message;

  // Mark the pending approval escalation as answered before transitioning
  // status — updateStatus will dismiss any leftover pending escalations.
  const escalation = db.prepare(
    "SELECT id FROM escalations WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).get(epicId) as { id: number } | undefined;
  if (escalation) answerEscalation(escalation.id, 'approved');

  await updateStatus(epicId, 'epic_in_progress');

  logEvent(epicId, 'system', 'epic_approved',
    `Operator approved decomposition; spawned ${result.phaseIds?.length || 0} phases`);

  const idList = (result.phaseIds || []).join(', ');
  return `Epic ${epicId} approved. ${result.phaseIds?.length || 0} phases queued: ${idList}`;
}
