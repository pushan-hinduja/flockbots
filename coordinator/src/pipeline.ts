import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import simpleGit from 'simple-git';
import { db, logEvent, Task, createEscalation, dismissEscalationsForTask, consumeAnsweredEscalations } from './queue';
import { getOctokit, getReviewerOctokit, GITHUB_OWNER, GITHUB_REPO, GITHUB_STAGING_BRANCH, GITHUB_PROD_BRANCH } from './github-auth';
import { createWorktree, cleanupWorktree } from './worktree-manager';
import { canRunAgent, pickNextTask } from './scheduler';
import {
  runAgentWithRetry, AgentConfig, SessionResult,
  AGENT_DEFAULTS, readJSON, fileExists
} from './session-manager';
import { runTestGate } from './test-gate';
import { syncToSupabase } from './supabase-sync';
import { notifyOperator } from './notifier';
import { updateLinearIssue, createLinearIssue, enrichLinearIssue } from './linear-sync';
import { validatePmOutput, validateUxOutput, validateDevOutput, validateReviewerOutput, validateQAOutput, buildValidationRetryPrompt } from './output-validator';
import { rebaseOnBase } from './worktree-manager';
import { flockbotsHome, flockbotsRoot, tasksDir } from './paths';
import { runDesignStage, runWireframesRendering, runDesignValidation } from './design-pipeline';
import {
  enterEpicApprovalGate, validateDecomposition,
  isEpicPhase, getBaseBranchForTask,
  spawnIntegrationQATask, finalizeEpic, maybeFinalizeEpicAfterFix,
} from './epic';
import { presentMessage } from './presenter';

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH || '';
const TASKS_DIR = tasksDir();

// --- Per-Agent Concurrency Locks ---
// Each agent (pm, ux, dev, reviewer) can run one task at a time.
// Different agents can run concurrently.

const agentLocks = new Map<string, { taskId: string; lockedAt: number }>();
const STALE_LOCK_MS = 65 * 60 * 1000; // 65 minutes

function agentForStatus(status: string): string {
  switch (status) {
    case 'inbox': case 'researching': case 'design_validation':
      return 'pm';
    case 'design_pending': case 'designing':
      return 'ux';
    case 'dev_ready': case 'developing': case 'testing':
      return 'dev';
    case 'review_pending': case 'reviewing':
      return 'reviewer';
    case 'qa_pending': case 'qa_running':
      return 'qa';
    // Coordinator-only stages (no agent invocation): wireframe rendering,
    // human-approval waits, and epic orchestration states. Distinct keys
    // so an epic orchestrator tick doesn't block an integration tick.
    case 'wireframes_rendering': case 'awaiting_design_approval':
    case 'epic_awaiting_approval': case 'epic_done':
      return status;
    case 'epic_in_progress':
      return 'epic_orchestrator';
    case 'epic_integrating':
      return 'epic_integrator';
    default:
      return status;
  }
}

function acquireAgentLock(agent: string, taskId: string): boolean {
  const existing = agentLocks.get(agent);
  if (existing) {
    // Auto-release stale locks
    if (Date.now() - existing.lockedAt > STALE_LOCK_MS) {
      agentLocks.delete(agent);
    } else {
      return false;
    }
  }
  agentLocks.set(agent, { taskId, lockedAt: Date.now() });
  return true;
}

function releaseAgentLock(agent: string): void {
  agentLocks.delete(agent);
}

function isAgentLocked(agent: string): boolean {
  const existing = agentLocks.get(agent);
  if (!existing) return false;
  if (Date.now() - existing.lockedAt > STALE_LOCK_MS) {
    agentLocks.delete(agent);
    return false;
  }
  return true;
}

// Legacy compatibility
function isLocked(): boolean {
  return false; // No longer a single global lock
}

// --- Status Management ---

const STATUS_LABELS: Record<string, string> = {
  researching: 'Research started',
  design_pending: 'Queued for design',
  designing: 'Design started',
  wireframes_rendering: 'Rendering wireframes',
  design_validation: 'Validating wireframes against requirements',
  awaiting_design_approval: 'Waiting for human design approval',
  dev_ready: 'Ready for development',
  developing: 'Development started',
  testing: 'Running tests',
  review_pending: 'Queued for PR & review',
  reviewing: 'Code review started',
  qa_pending: 'Queued for QA',
  qa_running: 'QA verification running',
  qa_done: 'QA passed',
  qa_failed: 'QA failed — auto fix task created',
  merged: 'Merged to staging',
  deployed: 'Deployed to production',
  failed: 'Task failed',
  awaiting_human: 'Waiting for human input',
  // Epic decomposition statuses (a mega-task split into ordered phases).
  epic_planning: 'Planning phases',
  epic_awaiting_approval: 'Waiting for human to approve phase plan',
  epic_in_progress: 'Phases in progress',
  epic_integrating: 'Integration QA running',
  epic_done: 'Epic complete',
};

export async function updateStatus(taskId: string, status: string): Promise<void> {
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), taskId);
  logEvent(taskId, 'system', 'status_change', STATUS_LABELS[status] || `Status: ${status}`);
  // Auto-clear pending escalations when the task moves past a human-wait
  // status. awaiting_design_approval and epic_awaiting_approval also create
  // escalation rows (so the dashboard banner surfaces them), so we keep
  // those escalations alive while in those statuses and dismiss on
  // transition out.
  if (status !== 'awaiting_human' &&
      status !== 'awaiting_design_approval' &&
      status !== 'epic_awaiting_approval') {
    dismissEscalationsForTask(taskId);
  }
  await syncToSupabase('task_update', { id: taskId, status });
}

// --- Escalation Handling ---

function extractEscalation(taskId: string): string {
  const questions: string[] = [];

  // 1. Check questions.md — if it contains any question marker, send the full content
  const questionsPath = join(TASKS_DIR, taskId, 'questions.md');
  if (fileExists(questionsPath)) {
    const content = readFileSync(questionsPath, 'utf-8').trim();
    if (content.length > 0) {
      // If the file has any PM_QUESTION or DEV_QUESTION marker (with any prefix like "## "),
      // send the entire file — agents often write multi-line questions with context,
      // recommendations, and escalation reasons that are all useful to the human.
      if (/PM_QUESTION|DEV_QUESTION/i.test(content)) {
        questions.push(content);
      } else {
        // No marker at all — still include the content as it may be a plain question
        questions.push(content);
      }
    }
  }

  // 2. Check context.json for escalation_reason or questions field
  const contextPath = join(TASKS_DIR, taskId, 'context.json');
  if (fileExists(contextPath)) {
    try {
      const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (ctx.escalation_reason) questions.push(`Reason: ${ctx.escalation_reason}`);
      if (ctx.questions && Array.isArray(ctx.questions)) {
        for (const q of ctx.questions) questions.push(typeof q === 'string' ? q : JSON.stringify(q));
      } else if (ctx.question) {
        questions.push(typeof ctx.question === 'string' ? ctx.question : JSON.stringify(ctx.question));
      }
    } catch {}
  }

  return questions.length > 0 ? questions.join('\n') : '';
}

export async function handleEscalation(task: Task, result: SessionResult, customMessage?: string): Promise<void> {
  let question = customMessage || extractEscalation(task.id);

  // If still no specific question, build a rich fallback with context + recent output
  if (!question || question.trim().length === 0) {
    const recentOutput = result.output
      ? result.output.slice(-1000).trim()
      : '';
    const parts = [
      `No specific question found in questions.md or context.json.`,
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description.slice(0, 300)}` : '',
      recentOutput ? `\nLast agent output:\n${recentOutput}` : '',
      `\nTo unblock: check tasks/${task.id}/ on the coordinator for partial output, or reply to retry from the last safe stage.`,
    ].filter(Boolean);
    question = parts.join('\n');
  }

  createEscalation(task.id, question);
  // Cap WhatsApp message to 4000 chars (WhatsApp API limit is 4096)
  const shortTitle = task.title.length > 80 ? task.title.slice(0, 80) + '...' : task.title;
  const header = `Task ${task.id} needs input\n${shortTitle}\n\n`;
  const maxQuestionLen = 4000 - header.length;
  const whatsappMsg = header + question.slice(0, maxQuestionLen);
  const presented = await presentMessage({
    intent: 'agent_escalation_question',
    data: {
      taskId: task.id,
      taskTitle: task.title,
      question: question.slice(0, maxQuestionLen),
    },
    fallback: whatsappMsg,
  });
  await notifyOperator(presented);
  // Re-fetch current status from DB — the in-memory task object may be stale because
  // processTaskStage transitions status (e.g. inbox → researching) before calling the agent
  const currentStatus = (db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string })?.status || task.status;
  db.prepare('UPDATE tasks SET error = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ previous_status: currentStatus }), Date.now(), task.id);
  await updateStatus(task.id, 'awaiting_human');
}

async function handleMaxTurnsEscalation(task: Task, result: SessionResult): Promise<void> {
  // session-manager's auto-resume loop already tried to continue the work
  // and gave up — either because the worktree showed no progress (dev) or
  // because the resume cap was hit (other agents). finalAgentMessage at
  // this point is the cumulative segment-by-segment handoff history.
  const handoff = result.finalAgentMessage || '(no handoff notes captured)';
  const message = [
    `Task ${task.id} stopped — agent ran out of budget and the auto-resume`,
    `loop gave up.`,
    '',
    `Handoff history (segment by segment):`,
    handoff.slice(0, 3500),
    '',
    `Partial work is preserved in the worktree. Reply with how you'd like`,
    `to proceed — start fresh, raise the effort first, or inspect the`,
    `worktree manually and commit if it's close enough.`,
  ].join('\n');
  await handleEscalation(task, result, message);
}

async function handleFailure(task: Task, result: SessionResult): Promise<void> {
  // Re-fetch current status from DB — in-memory task object may be stale
  const currentStatus = (db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string })?.status || task.status;
  const errorInfo = JSON.stringify({
    previous_status: currentStatus,
    output: result.output.slice(0, 2000),
  });
  db.prepare('UPDATE tasks SET error = ?, updated_at = ? WHERE id = ?')
    .run(errorInfo, Date.now(), task.id);
  await updateStatus(task.id, 'failed');
  const fallback = `Task failed: ${task.title}\n${result.output.slice(0, 500)}`;
  const presented = await presentMessage({
    intent: 'task_failed',
    data: {
      taskId: task.id,
      taskTitle: task.title,
      previousStage: currentStatus,
      errorOutput: result.output.slice(0, 500),
    },
    fallback,
  });
  await notifyOperator(presented);
}

export async function handleAgentResult(task: Task, result: SessionResult): Promise<void> {
  switch (result.status) {
    case 'questions_pending':
    case 'escalate':
      await handleEscalation(task, result);
      break;
    case 'max_turns_reached':
      // Agent ran out of turns mid-work. Worktree is preserved so the
      // operator can /retry (fresh attempt with more turns / higher effort)
      // or inspect + commit manually. Surface the agent's handoff note —
      // it usually says exactly what's done and what's remaining.
      await handleMaxTurnsEscalation(task, result);
      break;
    case 'rate_limited':
      logEvent(task.id, 'scheduler', 'rate_limited', 'Hit rate limit, will retry next cycle');
      break;
    case 'killed':
      // WhatsApp override killed the session; override handler already reset status.
      // No-op — just let the next pipeline tick re-run the stage with new settings.
      break;
    case 'failed':
      await handleFailure(task, result);
      break;
  }
}

async function handleDevQuestions(task: Task): Promise<void> {
  const result = await runAgentWithRetry({
    agent: 'pm',
    taskId: task.id,
    model: 'claude-sonnet-4-6',
    tools: ['Read', 'Write', 'Glob', 'Grep'],
    resume: true, // Resume PM's original research session — it knows the codebase already
    extraPromptContext: 'Answer DEV_QUESTION entries in questions.md. Write answers to context.json under "qa".',
    cwd: TARGET_REPO_PATH,
    enableStreaming: true,
  }, 2);

  if (result.status === 'complete') {
    await updateStatus(task.id, 'developing');
  } else if (result.status === 'escalate') {
    await handleEscalation(task, result);
  }
}

// --- Stage Handlers ---

async function runResearchStage(task: Task): Promise<void> {
  if (!canRunAgent('claude-sonnet-4-6', 'S')) {
    logEvent(task.id, 'scheduler', 'defer', 'Budget too low for research');
    return;
  }

  // If resuming after an answered escalation, inject the answer as context
  const escalation = db.prepare(
    "SELECT answer FROM escalations WHERE task_id = ? AND status = 'answered' ORDER BY answered_at DESC LIMIT 1"
  ).get(task.id) as { answer: string } | undefined;
  const isResume = !!escalation?.answer;
  const answerContext = isResume
    ? `\n\nHUMAN ANSWER TO YOUR QUESTION(S):\n${escalation.answer}\n\nContinue your research with this information. The questions.md file has been cleared since they are now answered. Only create a new questions.md if you have GENUINELY NEW questions the human hasn't answered yet.`
    : '';

  // Clear the old questions.md so the resumed session doesn't see stale questions
  // that would make deriveStatus think questions are still pending
  if (isResume) {
    const questionsPath = join(TASKS_DIR, task.id, 'questions.md');
    if (fileExists(questionsPath)) {
      try { rmSync(questionsPath); } catch {}
    }
  }

  // Phase mode: when a task is a phase of an epic, inject the EPIC_PARENT_ID
  // marker so the PM prompt skips RESEARCH + DECOMPOSITION and inherits from
  // the epic's already-completed research.
  let phaseContext = '';
  if (isEpicPhase(task)) {
    phaseContext = [
      '',
      `EPIC_PARENT_ID=${task.parent_task_id}`,
      `You are running for PHASE ${task.phase_index || '?'} of epic ${task.parent_task_id}.`,
      `Read tasks/${task.parent_task_id}/decomposition.json (your phase entry) and`,
      `tasks/${task.parent_task_id}/context.json (the epic's research). Follow the`,
      `PHASE-MODE DETECTION rules at the top of your prompt — skip RESEARCH and`,
      `DECOMPOSITION steps, write a phase-specific context-pack, then proceed to`,
      `EFFORT/DESIGN_BRIEF as needed.`,
    ].join('\n');
  }

  const combinedContext = [answerContext, phaseContext].filter(Boolean).join('');

  const result = await runAgentWithRetry({
    agent: 'pm',
    taskId: task.id,
    model: 'claude-sonnet-4-6',
    tools: AGENT_DEFAULTS.pm.tools,
    cwd: TARGET_REPO_PATH,
    resume: isResume, // Resume PM's session if continuing after an escalation answer
    extraPromptContext: combinedContext || undefined,
    enableStreaming: true,
  }, 3);

  // Mark any answered escalations as consumed so they don't re-inject on next run
  if (isResume && result.status !== 'questions_pending' && result.status !== 'escalate') {
    consumeAnsweredEscalations(task.id);
  }

  // Update task title from context.json if PM wrote one — even if escalating/failing,
  // so downstream messaging uses the clean title instead of the raw description
  try {
    const earlyCtx = readJSON(join(TASKS_DIR, task.id, 'context.json'));
    if (earlyCtx?.research?.title && earlyCtx.research.title.length > 0 && earlyCtx.research.title !== task.title) {
      db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?')
        .run(earlyCtx.research.title, Date.now(), task.id);
      task.title = earlyCtx.research.title; // Update in-memory so handleEscalation uses it
      await syncToSupabase('task_update', { id: task.id });
    }
  } catch {}

  switch (result.status) {
    case 'complete': {
      const ctx = readJSON(join(TASKS_DIR, task.id, 'context.json'));

      // Epic-mode short-circuit: PM decided to decompose this task. Validate
      // the plan, then enter the operator-approval gate. The normal
      // effort/design/dev routing does NOT apply here — each spawned phase
      // will run its own PM stage. We retry once on validation failure
      // (mirrors the per-task validatePmOutput retry below), then escalate.
      if (ctx?.is_epic === true) {
        let validation = validateDecomposition(task.id);
        if (!validation.valid) {
          logEvent(task.id, 'validator', 'epic_invalid', validation.errors.join(', '));
          const retryResult = await runAgentWithRetry({
            agent: 'pm', taskId: task.id, model: 'claude-sonnet-4-6',
            tools: AGENT_DEFAULTS.pm.tools, cwd: TARGET_REPO_PATH,
            resume: true,
            extraPromptContext: buildValidationRetryPrompt(validation.errors),
            enableStreaming: true,
          }, 1);
          if (retryResult.status !== 'complete') {
            await handleAgentResult(task, retryResult);
            break;
          }
          validation = validateDecomposition(task.id);
          if (!validation.valid) {
            await handleFailure(task, {
              ...result,
              output: `Epic decomposition invalid after retry: ${validation.errors.join(', ')}`,
            });
            break;
          }
        }
        await enterEpicApprovalGate(task, validation.decomposition!, updateStatus);
        break;
      }

      if (ctx.effort) {
        db.prepare(`
          UPDATE tasks SET effort_size = ?, estimated_turns = ?,
          dev_model = ?, reviewer_model = ?,
          dev_effort = ?, reviewer_effort = ?,
          use_swarm = ?,
          updated_at = ?
          WHERE id = ?
        `).run(
          ctx.effort.size, ctx.effort.estimated_turns,
          ctx.effort.dev_model, ctx.effort.reviewer_model,
          ctx.effort.dev_effort, ctx.effort.reviewer_effort,
          ctx.effort.use_swarm ? 1 : 0,
          Date.now(), task.id
        );
      }

      // Persist affected_files for scheduler's overlap-based serialization.
      // Tasks with empty/missing lists are treated conservatively (serialize against all).
      if (Array.isArray(ctx.research?.affected_files)) {
        db.prepare('UPDATE tasks SET affected_files = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(ctx.research.affected_files), Date.now(), task.id);
      } else {
        logEvent(task.id, 'validator', 'pm_missing_affected_files',
          'PM did not produce research.affected_files — scheduler will serialize against all in-flight tasks');
      }

      // Validate PM output (includes title check)
      const pmValidation = validatePmOutput(task.id);
      if (!pmValidation.valid) {
        logEvent(task.id, 'validator', 'pm_retry', `PM output invalid: ${pmValidation.errors.join(', ')}`);
        const retryResult = await runAgentWithRetry({
          agent: 'pm', taskId: task.id, model: 'claude-sonnet-4-6',
          tools: AGENT_DEFAULTS.pm.tools, cwd: TARGET_REPO_PATH,
          resume: true, // Resume — validation retry is a tight loop fixing the output we just produced
          extraPromptContext: buildValidationRetryPrompt(pmValidation.errors),
          enableStreaming: true,
        }, 1);
        if (retryResult.status !== 'complete' || !validatePmOutput(task.id).valid) {
          await handleFailure(task, { ...result, output: `PM validation failed: ${pmValidation.errors.join(', ')}` });
          break;
        }
        // Re-read context after retry
        const retryCtx = readJSON(join(TASKS_DIR, task.id, 'context.json'));
        Object.assign(ctx, retryCtx);
      }

      // Update task title from PM research (after validation ensures it exists)
      const pmTitle = ctx.research?.title;
      if (pmTitle && pmTitle.length > 0) {
        db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?')
          .run(pmTitle, Date.now(), task.id);
        await syncToSupabase('task_update', { id: task.id });
      }

      // Sync research findings to Linear. Phases (source='epic-phase'),
      // integration QA tasks (source='epic-qa'), and integration-QA fixes
      // (source='epic-qa-fix') do NOT get their own Linear issues — the
      // parent epic owns the Linear link in v1.
      const cleanTitle = pmTitle || task.title;
      const isEpicChild = task.source === 'epic-phase' ||
                          task.source === 'epic-qa' ||
                          task.source === 'epic-qa-fix';
      if (task.source === 'linear' && task.source_id) {
        await enrichLinearIssue(task.source_id, ctx, pmTitle);
      } else if (!task.source_id && !isEpicChild) {
        const linearId = await createLinearIssue(
          cleanTitle,
          `${task.description}\n\n${ctx.research?.summary || ''}`,
          task.priority
        );
        if (linearId) {
          db.prepare('UPDATE tasks SET source_id = ?, source = COALESCE(source, ?), updated_at = ? WHERE id = ?')
            .run(linearId, 'manual', Date.now(), task.id);
          await enrichLinearIssue(linearId, ctx);
          logEvent(task.id, 'system', 'linear_created', 'Created and enriched Linear issue from task');
          await syncToSupabase('task_update', { id: task.id });
        }
      }

      // Design skip — if PM flagged this as non-UI, jump straight to dev_ready
      if (ctx.effort?.skip_design) {
        logEvent(task.id, 'system', 'design_skipped', 'PM flagged as non-UI task, skipping design phase');
        await updateStatus(task.id, 'dev_ready');
      } else {
        await updateStatus(task.id, 'design_pending');
      }
      break;
    }
    case 'questions_pending':
    case 'escalate':
      await handleEscalation(task, result);
      break;
    case 'rate_limited':
      logEvent(task.id, 'scheduler', 'rate_limited', 'Hit rate limit during research, will retry');
      break;
    case 'failed':
      await handleFailure(task, result);
      break;
  }
}

// Design-pipeline stages (designing → wireframes_rendering → design_validation)
// live in their own module to keep pipeline.ts closer to the project's
// <500-line guideline. See design-pipeline.ts for the circular-import
// notes — it lazy-imports updateStatus / handleAgentResult / handleEscalation
// from this file so the cycle is resolved at call time.

/**
 * Resume dev agent on a task that was escalated and answered by a human.
 * Includes the human's answer and prior review history as context.
 */
async function resumeDevWithContext(task: Task): Promise<void> {
  const worktreePath = task.worktree_path || '';
  if (!worktreePath) {
    await handleFailure(task, { status: 'failed', output: 'Missing worktree_path for dev resume', durationMs: 0, exitCode: 1 });
    return;
  }

  // Get the human's answer from the most recent answered escalation
  const escalation = db.prepare(
    "SELECT answer FROM escalations WHERE task_id = ? AND status = 'answered' ORDER BY answered_at DESC LIMIT 1"
  ).get(task.id) as { answer: string } | undefined;

  // Get prior review history from GitHub
  let priorReviews = '';
  if (task.pr_number) {
    try {
      const octokit = await getOctokit();
      const { data: allReviews } = await octokit.pulls.listReviews({
        owner: GITHUB_OWNER, repo: GITHUB_REPO,
        pull_number: task.pr_number,
      });
      const changesRequested = allReviews.filter((r: any) => r.state === 'CHANGES_REQUESTED' && r.body);
      if (changesRequested.length > 0) {
        const lastReview = changesRequested[changesRequested.length - 1];
        priorReviews = `\n\nMOST RECENT REVIEW:\n${(lastReview as any).body!.slice(0, 2000)}`;
      }
    } catch {}
  }

  const humanContext = escalation?.answer
    ? `\n\nHUMAN ARCHITECT GUIDANCE (follow this exactly):\n${escalation.answer}`
    : '';

  // Clear old questions.md so the resumed session doesn't see stale questions
  if (escalation?.answer) {
    const questionsPath = join(TASKS_DIR, task.id, 'questions.md');
    if (fileExists(questionsPath)) {
      try { rmSync(questionsPath); } catch {}
    }
  }

  logEvent(task.id, 'system', 'dev_resumed', 'Dev agent resumed with human guidance');

  const result = await runAgentWithRetry({
    agent: 'dev',
    taskId: task.id,
    model: (task.dev_model || 'claude-sonnet-4-6') as any,
    tools: AGENT_DEFAULTS.dev.tools,
    promptVariant: 'single',
    resume: true, // Resume dev's session — human answer fills in missing context, continue where we left off
    extraPromptContext: `RESUMING AFTER HUMAN REVIEW

A human architect has reviewed the prior review cycles and provided specific guidance.
Follow their instructions precisely — they've identified the root cause of the recurring issues.
${humanContext}${priorReviews}`,
    cwd: worktreePath,
    effortSize: task.effort_size || 'M',
    effortLevel: (task.dev_effort || 'medium') as any,
    enableStreaming: true,
  }, 3);

  if (result.status !== 'questions_pending' && result.status !== 'escalate') {
    consumeAnsweredEscalations(task.id);
  }

  if (result.status === 'complete') {
    await updateStatus(task.id, 'review_pending');
  } else {
    await handleAgentResult(task, result);
  }
}

async function runDevPipeline(task: Task): Promise<void> {
  const baseBranch = getBaseBranchForTask(task, GITHUB_STAGING_BRANCH);
  const worktreePath = await createWorktree(task.id, baseBranch);
  db.prepare('UPDATE tasks SET worktree_path = ?, branch_name = ?, updated_at = ? WHERE id = ?')
    .run(worktreePath, `task/${task.id}`, Date.now(), task.id);
  await syncToSupabase('task_update', { id: task.id });

  await updateStatus(task.id, 'developing');

  const variant = task.use_swarm ? 'swarm' : 'single';

  const result = await runAgentWithRetry({
    agent: 'dev',
    taskId: task.id,
    model: (task.dev_model || 'claude-sonnet-4-6') as any,
    tools: task.use_swarm
      ? [...AGENT_DEFAULTS.dev.tools, 'Agent']
      : AGENT_DEFAULTS.dev.tools,
    promptVariant: variant as any,
    cwd: worktreePath,
    effortSize: task.effort_size || 'M',
    effortLevel: (task.dev_effort || 'medium') as any,
    enableStreaming: true,
  }, 3);

  switch (result.status) {
    case 'complete': {
      const ctx = readJSON(join(TASKS_DIR, task.id, 'context.json'));
      if (ctx.SECURITY_BLOCK) {
        await handleEscalation(task, result, 'Security issue found - review required');
        return;
      }
      // Validate dev output
      const devValidation = validateDevOutput(task.id);
      if (!devValidation.valid) {
        logEvent(task.id, 'validator', 'dev_incomplete', devValidation.errors.join(', '));
        // Retry once with validation feedback
        const retryResult = await runAgentWithRetry({
          agent: 'dev', taskId: task.id, model: (task.dev_model || 'claude-sonnet-4-6') as any,
          tools: AGENT_DEFAULTS.dev.tools, promptVariant: 'single', cwd: worktreePath,
          resume: true, // Resume — validation retry is a tight loop fixing output we just produced
          extraPromptContext: buildValidationRetryPrompt(devValidation.errors),
          effortSize: task.effort_size || 'M',
          effortLevel: (task.dev_effort || 'medium') as any,
        }, 1);
        if (retryResult.status !== 'complete' || !validateDevOutput(task.id).valid) {
          await handleFailure(task, { ...result, output: `Dev validation failed: ${devValidation.errors.join(', ')}` });
          break;
        }
      }
      await updateStatus(task.id, 'review_pending');
      break;
    }
    case 'questions_pending':
      await handleDevQuestions(task);
      break;
    case 'rate_limited':
      await updateStatus(task.id, 'dev_ready');
      break;
    case 'killed':
      // WhatsApp override handled state reset. Leave task alone for next pipeline tick.
      break;
    case 'failed':
      await handleFailure(task, result);
      break;
  }
}

async function runTestStage(task: Task): Promise<void> {
  const worktreePath = task.worktree_path || '';
  if (!worktreePath) { await handleFailure(task, { status: 'failed', output: 'Missing worktree_path', durationMs: 0, exitCode: 1 }); return; }
  const testResult = await runTestGate(task.id, worktreePath);

  if (testResult.passed) {
    await updateStatus(task.id, 'review_pending');
  } else {
    if (task.test_retry_count < 3) {
      db.prepare('UPDATE tasks SET test_retry_count = test_retry_count + 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), task.id);
      await syncToSupabase('task_update', { id: task.id });

      logEvent(task.id, 'test_gate', 'retry',
        `Tests failed (attempt ${task.test_retry_count + 1}/3), sending back to dev`);

      const result = await runAgentWithRetry({
        agent: 'dev',
        taskId: task.id,
        model: (task.dev_model || 'claude-sonnet-4-6') as any,
        tools: AGENT_DEFAULTS.dev.tools,
        promptVariant: 'single',
        resume: true, // Resume — tight feedback loop, dev just wrote the code that failed
        extraPromptContext: `TESTS FAILED. Fix the following failures and commit:\n\n${testResult.output}`,
        cwd: worktreePath,
        effortSize: task.effort_size || 'M',
        effortLevel: (task.dev_effort || 'medium') as any,
        enableStreaming: true,
      }, 2);

      if (result.status === 'complete') {
        await updateStatus(task.id, 'testing');
      } else {
        await handleAgentResult(task, result);
      }
    } else {
      await handleEscalation(
        task,
        { status: 'failed', output: testResult.output, durationMs: 0, exitCode: 1 },
        'Tests failed after 3 attempts'
      );
    }
  }
}

async function runCreatePR(task: Task): Promise<void> {
  const worktreePath = task.worktree_path || '';
  const branchName = task.branch_name || '';
  if (!worktreePath || !branchName) { await handleFailure(task, { status: 'failed', output: 'Missing worktree_path or branch_name', durationMs: 0, exitCode: 1 }); return; }
  const octokit = await getOctokit();

  // Rebase on the task's base branch (staging for normal tasks, epic/<id>
  // for phases). The helper escalates rebase → merge → AI conflict resolver
  // before giving up.
  const baseBranchForRebase = getBaseBranchForTask(task, GITHUB_STAGING_BRANCH);
  const rebaseResult = await rebaseOnBase(task.id, baseBranchForRebase);
  if (rebaseResult.ok && rebaseResult.strategy !== 'rebase') {
    logEvent(task.id, 'system', 'rebase_recovered',
      `Integrated ${baseBranchForRebase} via "${rebaseResult.strategy}" strategy (rebase had conflicts)`);
  }
  if (!rebaseResult.ok) {
    // Network errors are transient — leave the task at review_pending and let the next
    // pipeline cycle retry. Don't waste a retry slot or escalate.
    if (rebaseResult.reason === 'network') {
      logEvent(task.id, 'system', 'rebase_network_retry',
        'Network error during rebase — will retry next cycle (no recovery action taken)');
      return;
    }

    // Conflict — auto-recovery: another task likely touched the same files and merged.
    // Clean up the worktree and reset to dev_ready so the dev agent re-implements on top
    // of the latest staging. Cap to 2 attempts to avoid loops.
    if (rebaseResult.reason === 'conflict') {
      const retryCount = task.retry_count || 0;
      if (retryCount < 2) {
        logEvent(task.id, 'system', 'rebase_conflict_recover',
          `Rebase conflict detected — cleaning up and re-running dev on fresh worktree (attempt ${retryCount + 1}/2)`);

        try { await cleanupWorktree(task.id); } catch {}
        if (branchName && TARGET_REPO_PATH) {
          try { await simpleGit(TARGET_REPO_PATH).branch(['-D', branchName]); } catch {}
        }

        db.prepare(`
          UPDATE tasks SET
            status = 'dev_ready', worktree_path = NULL, branch_name = NULL,
            pr_url = NULL, pr_number = NULL,
            retry_count = ?, test_retry_count = 0, error = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(retryCount + 1, Date.now(), task.id);

        await syncToSupabase('task_update', { id: task.id });
        return;
      }

      // Exceeded auto-recovery attempts — escalate with manual resolution instructions
      await handleEscalation(task, {
        status: 'failed', output: 'Rebase on staging failed after 2 auto-recovery attempts', durationMs: 0, exitCode: 1,
      }, `Branch ${branchName} has persistent conflicts with staging.

Auto-recovery (re-running dev on fresh worktree) was attempted twice and failed.

To resolve manually:
1. SSH into the coordinator
2. cd to the worktree (TARGET_REPO_PATH/.worktrees/task-${task.id})
3. git fetch origin && git rebase origin/staging
4. Resolve conflicts, git add, git rebase --continue
5. git push --force-with-lease
6. Reply "resolved" to clear the escalation

Or use the dashboard to revert the task to Ready and let dev re-implement.`);
      return;
    }

    // Other failure — escalate with the raw error
    await handleEscalation(task, {
      status: 'failed', output: rebaseResult.message, durationMs: 0, exitCode: 1,
    }, `Rebase failed: ${rebaseResult.message.slice(0, 500)}`);
    return;
  }

  const git = simpleGit(worktreePath);
  await git.push('origin', branchName, ['--force-with-lease']);

  let prBody = '';
  try {
    prBody = readFileSync(join(TASKS_DIR, task.id, 'implementation-summary.md'), 'utf-8');
  } catch {
    prBody = `Automated implementation for task ${task.id}`;
  }

  let pr: { html_url: string; number: number; base?: { ref: string } } = null as any;

  // Phase tasks PR into their epic branch instead of staging — keeps
  // staging clean until the epic is fully integrated. Computed up front so
  // both reuse and recover paths can verify the PR's base matches.
  const prBaseBranch = getBaseBranchForTask(task, GITHUB_STAGING_BRANCH);

  // If the task already has a PR from a previous cycle, reuse it
  if (task.pr_number) {
    try {
      const { data: existingPr } = await octokit.pulls.get({
        owner: GITHUB_OWNER, repo: GITHUB_REPO,
        pull_number: task.pr_number,
      });
      if (existingPr.state === 'open') {
        // Update the PR title/body in case they changed
        await octokit.pulls.update({
          owner: GITHUB_OWNER, repo: GITHUB_REPO,
          pull_number: task.pr_number,
          title: task.title,
          body: prBody,
        });
        pr = existingPr;
        logEvent(task.id, 'system', 'pr_reused', `Using existing PR #${pr.number}`);
      } else {
        // PR was closed/merged — create a new one
        task.pr_number = null;
        task.pr_url = null;
        pr = null as any; // Will be created below
      }
    } catch {
      task.pr_number = null;
      task.pr_url = null;
      pr = null as any;
    }
  }

  if (!task.pr_number) {
    try {
      const { data } = await octokit.pulls.create({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        title: task.title,
        head: branchName,
        base: prBaseBranch,
        body: prBody,
      });
      pr = data;
    } catch (err: any) {
      const ghErrors = err.response?.data?.errors?.map((e: any) => e.message || JSON.stringify(e)).join('; ') || '';
      const detail = ghErrors ? `${err.message} — ${ghErrors}` : err.message;
      logEvent(task.id, 'system', 'pr_error', `PR creation failed: ${detail}`);

      // 422 — PR already exists for this branch. Find it (open or closed).
      if (err.status === 422) {
        const { data: openPrs } = await octokit.pulls.list({
          owner: GITHUB_OWNER, repo: GITHUB_REPO,
          head: `${GITHUB_OWNER}:${branchName}`, state: 'open',
        });
        if (openPrs.length > 0) {
          pr = openPrs[0];
          logEvent(task.id, 'system', 'pr_reused', `Using existing open PR #${pr.number}`);
        } else {
          // Try closed PRs — reopen if possible
          const { data: closedPrs } = await octokit.pulls.list({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            head: `${GITHUB_OWNER}:${branchName}`, state: 'closed',
          });
          const unmerged = closedPrs.find(p => !p.merged_at);
          if (unmerged) {
            await octokit.pulls.update({
              owner: GITHUB_OWNER, repo: GITHUB_REPO,
              pull_number: unmerged.number, state: 'open',
              title: task.title, body: prBody,
            });
            pr = unmerged;
            logEvent(task.id, 'system', 'pr_reopened', `Reopened PR #${pr.number}`);
          } else {
            await handleFailure(task, { status: 'failed', output: `PR creation failed: ${detail}`, durationMs: 0, exitCode: 1 });
            return;
          }
        }
      } else {
        await handleFailure(task, { status: 'failed', output: `PR creation failed: ${detail}`, durationMs: 0, exitCode: 1 });
        return;
      }
    }
  }

  // Verify the PR's base matches the branch we expect. Reused/reopened PRs
  // can target a stale base (e.g. an old PR targeting staging when this is
  // now a phase needing epic/<id>). Update via API — supports retargeting
  // open PRs without a close+recreate cycle. Best effort: if the update
  // fails, the merge step will surface the issue.
  const currentBase = pr.base?.ref;
  if (currentBase && currentBase !== prBaseBranch) {
    logEvent(task.id, 'system', 'pr_base_corrected',
      `PR #${pr.number} retargeted: ${currentBase} → ${prBaseBranch}`);
    try {
      const { data: updated } = await octokit.pulls.update({
        owner: GITHUB_OWNER, repo: GITHUB_REPO,
        pull_number: pr.number,
        base: prBaseBranch,
      });
      pr = updated;
    } catch (err: any) {
      logEvent(task.id, 'system', 'pr_base_update_failed',
        `Could not retarget PR #${pr.number} base to ${prBaseBranch}: ${err?.message || err}`);
    }
  }

  db.prepare('UPDATE tasks SET pr_url = ?, pr_number = ?, updated_at = ? WHERE id = ?')
    .run(pr.html_url, pr.number, Date.now(), task.id);

  logEvent(task.id, 'dev', 'pr_created', `PR #${pr.number} created: ${pr.html_url}`);
  await updateStatus(task.id, 'reviewing');

  const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
  await runReviewStage(updatedTask);
}

async function fetchPrDiff(prNumber: number): Promise<string> {
  try {
    const octokit = await getOctokit();
    const { data } = await octokit.pulls.get({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });
    return data as unknown as string;
  } catch {
    return '';
  }
}

async function runReviewStage(task: Task): Promise<void> {
  const worktreePath = task.worktree_path || '';
  if (!worktreePath || !task.pr_number) { await handleFailure(task, { status: 'failed', output: 'Missing worktree_path or pr_number', durationMs: 0, exitCode: 1 }); return; }
  const prDiff = await fetchPrDiff(task.pr_number!);
  const octokit = await getOctokit();

  // Include Linear ticket context so reviewer can check against original intent
  const ctx = readJSON(join(TASKS_DIR, task.id, 'context.json'));
  const ticketContext = [
    `PR #${task.pr_number} diff:\n\n${prDiff}`,
    `\n---\n\nOriginal task: ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
    ctx?.research?.summary ? `Research summary: ${ctx.research.summary}` : '',
    ctx?.research?.root_cause ? `Root cause: ${ctx.research.root_cause}` : '',
  ].filter(Boolean).join('\n');

  // On review retries, scope the reviewer to verify fixes — not re-review the entire PR
  let reviewMode = '';
  if (task.retry_count > 0) {
    let lastReviewBody = '';
    try {
      const { data: allReviews } = await octokit.pulls.listReviews({
        owner: GITHUB_OWNER, repo: GITHUB_REPO,
        pull_number: task.pr_number!,
      });
      const lastChangesRequested = allReviews
        .filter((r: any) => r.state === 'CHANGES_REQUESTED' && r.body)
        .pop();
      if (lastChangesRequested) {
        lastReviewBody = (lastChangesRequested as any).body!.slice(0, 2000);
      }
    } catch {}

    reviewMode = `
IMPORTANT — THIS IS REVIEW RETRY #${task.retry_count}. You are NOT doing a fresh review.

Your previous review requested these changes:
${lastReviewBody}

Your job this round:
1. VERIFY each requested change was correctly implemented. Check the specific files and lines.
2. If a fix introduced a NEW bug in the changed code, flag it. Be specific.
3. Do NOT re-review unchanged code. Do NOT raise new issues in code that existed before your last review.
4. If all requested changes are correctly implemented, APPROVE. Don't keep finding new things to block on.
5. Only REQUEST_CHANGES if a specific fix from your last review was done incorrectly or introduced a regression.

`;
  }

  const result = await runAgentWithRetry({
    agent: 'reviewer',
    taskId: task.id,
    model: (task.reviewer_model || 'claude-opus-4-7') as any,
    tools: task.use_swarm
      ? [...AGENT_DEFAULTS.reviewer.tools, 'Agent']
      : AGENT_DEFAULTS.reviewer.tools,
    promptVariant: task.use_swarm ? 'swarm' : 'single',
    extraPromptContext: reviewMode + ticketContext,
    cwd: worktreePath,
    effortSize: task.effort_size || 'M',
    effortLevel: (task.reviewer_effort || 'high') as any,
    enableStreaming: true,
  }, 3);

  if (result.status === 'complete') {
    // Validate reviewer output — never auto-approve on missing review.md
    const reviewValidation = validateReviewerOutput(task.id);
    if (!reviewValidation.valid) {
      logEvent(task.id, 'validator', 'reviewer_invalid', reviewValidation.errors.join(', '));
      await handleEscalation(task, result, `Reviewer did not produce valid output: ${reviewValidation.errors.join(', ')}`);
      return;
    }

    const review = readFileSync(join(TASKS_DIR, task.id, 'review.md'), 'utf-8');
    const reviewerOctokit = await getReviewerOctokit();
    const octokit = await getOctokit();

    if (review.includes('APPROVE')) {
      logEvent(task.id, 'reviewer', 'review_approved', `PR #${task.pr_number} approved`);

      // Post formal PR review via separate reviewer app (avoids self-approval restriction)
      try {
        await reviewerOctokit.pulls.createReview({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pull_number: task.pr_number!,
          body: review,
          event: 'APPROVE',
        });
      } catch (err: any) {
        logEvent(task.id, 'system', 'review_post_failed', `Failed to post review: ${err.message}`);
      }

      try {
        await octokit.pulls.merge({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pull_number: task.pr_number!,
          merge_method: 'squash',
        });
      } catch (err: any) {
        // PR may already be merged — check state before failing
        try {
          const { data: pr } = await octokit.pulls.get({
            owner: GITHUB_OWNER, repo: GITHUB_REPO,
            pull_number: task.pr_number!,
          });
          if (pr.merged) {
            logEvent(task.id, 'system', 'pr_already_merged', `PR #${task.pr_number} was already merged`);
          } else {
            await handleFailure(task, { status: 'failed', output: `Merge failed: ${err.message}`, durationMs: 0, exitCode: 1 });
            return;
          }
        } catch {
          await handleFailure(task, { status: 'failed', output: `Merge failed: ${err.message}`, durationMs: 0, exitCode: 1 });
          return;
        }
      }

      logEvent(task.id, 'system', 'task_merged', `Merged: ${task.title}`);

      db.prepare('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?')
        .run(Date.now(), Date.now(), task.id);
      await cleanupWorktree(task.id);

      // Decide next status: if reviewer flagged qa_required and QA is enabled,
      // transition to qa_pending instead of merged. Otherwise go straight to merged.
      // Epic phases skip per-phase QA entirely — the integration QA at epic
      // completion is what verifies user-facing behavior. (The reviewer's
      // qa_required flag is still preserved in context.json for posterity.)
      const ctxAfterMerge = readJSON(join(TASKS_DIR, task.id, 'context.json'));
      const reviewerWantsQA = ctxAfterMerge?.qa?.qa_required === true;
      const qaEnabled = (process.env.QA_ENABLED || '').toLowerCase() === 'true';
      const phaseSkipsQA = isEpicPhase(task);
      const qaRequired = reviewerWantsQA && !phaseSkipsQA;

      if (phaseSkipsQA && reviewerWantsQA) {
        logEvent(task.id, 'system', 'phase_qa_deferred',
          `Reviewer flagged qa_required, but phase QA is deferred to epic-level integration QA`);
      }

      if (qaRequired && qaEnabled) {
        // Give Vercel time to finish deploying the merge before QA hits staging.
        // Configurable via QA_DEPLOY_WAIT_MS; default 5 min.
        const waitMs = parseInt(process.env.QA_DEPLOY_WAIT_MS || String(5 * 60 * 1000));
        const readyAt = Date.now() + (Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 5 * 60 * 1000);
        db.prepare('UPDATE tasks SET qa_ready_at = ?, updated_at = ? WHERE id = ?')
          .run(readyAt, Date.now(), task.id);
        const waitMinutes = Math.round((readyAt - Date.now()) / 60000);
        logEvent(task.id, 'system', 'qa_queued',
          `Reviewer flagged QA required — queued; will start in ~${waitMinutes}min to give Vercel time to deploy`);
        await updateStatus(task.id, 'qa_pending');
        await notifyOperator(`${task.title}\nMerged — QA verification starts in ~${waitMinutes}min (waiting for Vercel deploy).\nPR: ${task.pr_url}`);
      } else {
        // qa_required=false OR QA_ENABLED=false — no QA ran. Mark the task as
        // 'skipped' so the dashboard can show it as pass-equivalent without
        // conflating it with pre-feature tasks that have no QA info at all.
        db.prepare("UPDATE tasks SET qa_status = 'skipped', updated_at = ? WHERE id = ?")
          .run(Date.now(), task.id);
        await updateStatus(task.id, 'merged');

        // Phase-aware notification: epic phases get "Phase N/M merged" so the
        // operator can track progress through the decomposition. Standalone
        // tasks keep the original single-line notification.
        if (phaseSkipsQA && task.phase_index && task.total_phases) {
          const epicTitle = task.parent_task_id
            ? (db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.parent_task_id) as any)?.title
            : null;
          const epicLine = epicTitle ? `\nEpic: ${epicTitle}` : '';
          const phaseFallback = `Phase ${task.phase_index}/${task.total_phases} merged: ${task.title}${epicLine}\nPR: ${task.pr_url}`;
          const phasePresented = await presentMessage({
            intent: 'epic_phase_complete',
            data: {
              taskId: task.id,
              phaseIndex: task.phase_index,
              totalPhases: task.total_phases,
              phaseTitle: task.title,
              epicId: task.parent_task_id,
              epicTitle,
              prUrl: task.pr_url,
            },
            fallback: phaseFallback,
          });
          await notifyOperator(phasePresented);
        } else {
          await notifyOperator(`${task.title}\nPR: ${task.pr_url}`);
        }
        if (qaRequired && !qaEnabled) {
          logEvent(task.id, 'system', 'qa_skipped', `QA was flagged required but QA_ENABLED=false — skipping`);
        }

        // Epic QA fix landed — close the epic if all integration-QA fixes
        // are done. No-op if this isn't a fix or other fixes are pending.
        if (task.source === 'epic-qa-fix' && task.parent_task_id) {
          await maybeFinalizeEpicAfterFix(task.parent_task_id);
        }
      }

      if (task.source_id) {
        await updateLinearIssue(task.source_id, 'Done', task.pr_url || undefined);
      }

      // Post-merge knowledge update (graph rebuild + skills refresh)
      await runPostMergeKnowledgeUpdate(task);
    } else if (review.includes('REQUEST_CHANGES')) {
      logEvent(task.id, 'reviewer', 'changes_requested', `PR #${task.pr_number} needs changes (attempt ${task.retry_count + 1}/5)`);

      // Post formal PR review via separate reviewer app
      await reviewerOctokit.pulls.createReview({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        pull_number: task.pr_number!,
        body: review,
        event: 'REQUEST_CHANGES',
      });

      if (task.retry_count < 5) {
        db.prepare('UPDATE tasks SET retry_count = retry_count + 1, test_retry_count = 0, updated_at = ? WHERE id = ?')
          .run(Date.now(), task.id);
        await syncToSupabase('task_update', { id: task.id });
        await updateStatus(task.id, 'developing');

        // Fetch prior review history so the dev agent can see patterns and avoid circular fixes
        let priorReviews = '';
        if (task.retry_count > 0 && task.pr_number) {
          try {
            const { data: allReviews } = await octokit.pulls.listReviews({
              owner: GITHUB_OWNER,
              repo: GITHUB_REPO,
              pull_number: task.pr_number,
            });
            const changesRequested = allReviews
              .filter((r: any) => r.state === 'CHANGES_REQUESTED' && r.body)
              .slice(0, -1); // Exclude the current review (already included below)
            if (changesRequested.length > 0) {
              priorReviews = '\n\nPRIOR REVIEW HISTORY (oldest first) — study these to avoid repeating the same fixes that were already tried and reverted):\n\n'
                + changesRequested.map((r: any, i: number) =>
                  `--- Review ${i + 1} ---\n${r.body!.slice(0, 1500)}`
                ).join('\n\n');
            }
          } catch {}
        }

        const devResult = await runAgentWithRetry({
          agent: 'dev',
          taskId: task.id,
          model: (task.dev_model || 'claude-sonnet-4-6') as any,
          tools: AGENT_DEFAULTS.dev.tools,
          promptVariant: 'single',
          // No --max-turns: review feedback can be substantive (5-blocker
          // reviews routinely need 50+ turns to address). sessionTimeout +
          // dev's snapshot-based auto-resume handle the bound — if the
          // worktree stops changing, the resume loop escalates.
          effortSize: task.effort_size || 'M',
          effortLevel: (task.dev_effort || 'medium') as any,
          extraPromptContext: `CODE REVIEW — CHANGES REQUESTED (attempt ${task.retry_count + 1}/5)

The reviewer found issues in your implementation. Address ALL of the following, but critically:
- Think about SIDE EFFECTS of each fix. Don't just change what was asked — consider what your change breaks or creates elsewhere.
- After making fixes, re-read the full diff of your changes to verify you haven't introduced new issues.
- If the reviewer says "use X instead of Y", understand WHY before making the change, and check if the same pattern exists elsewhere.
- Pay special attention to: security implications, error handling paths, state consistency across tables/components.
- IMPORTANT: Read the prior review history below. If you see the same issue raised multiple times, your previous fixes didn't work or caused regressions. Take a different approach this time.

CURRENT review feedback:

${review}${priorReviews}`,
          cwd: worktreePath,
          enableStreaming: true,
        }, 2);

        if (devResult.status === 'complete') {
          await updateStatus(task.id, 'reviewing');
        }
      } else {
        await handleEscalation(task, result, 'Review requested changes 5 times - needs human review');
      }
    }
  } else {
    await handleAgentResult(task, result);
  }
}

// --- Post-Merge QA ---

/**
 * Run the QA agent against the merged staging. Verifies the task's described
 * behavior via Playwright + Supabase MCP. On pass → merged. On fail → creates
 * a new inbox task with parent_task_id linking back, and notifies via WhatsApp.
 *
 * Self-upgrade: if the previous QA pass left QA_ESCALATE_OPUS: true in
 * context.json, this run uses Opus-4.7 / high for deeper analysis. Capped
 * to one upgrade per task via ctx.qa.escalated_already.
 */
async function runQAStage(task: Task): Promise<void> {
  // mcp-configs are shared resources at the flock root, not per-instance.
  const SHARED_ROOT = flockbotsRoot();
  const ctx = readJSON(join(TASKS_DIR, task.id, 'context.json'));
  const qaBlock = ctx?.qa || {};

  if (!qaBlock.qa_required) {
    logEvent(task.id, 'system', 'qa_not_required', 'qa_required was false — transitioning to merged');
    await updateStatus(task.id, 'merged');
    return;
  }

  // Vercel-deploy wait: don't run QA until `qa_ready_at` has passed. Each
  // pipeline tick re-checks; when the timestamp is in the past we proceed.
  // First time we defer, we log; subsequent deferrals stay silent to avoid
  // spamming the event feed.
  if (task.qa_ready_at && Date.now() < task.qa_ready_at) {
    const waitMs = task.qa_ready_at - Date.now();
    const waitSec = Math.ceil(waitMs / 1000);
    // Check if we've already logged a wait for this task — use the event log
    const alreadyLogged = db.prepare(
      "SELECT 1 FROM events WHERE task_id = ? AND event_type = 'qa_waiting_deploy' LIMIT 1"
    ).get(task.id);
    if (!alreadyLogged) {
      logEvent(task.id, 'system', 'qa_waiting_deploy',
        `Waiting ~${waitSec}s for Vercel deploy before starting QA`);
    }
    // Put status back to qa_pending so the scheduler continues polling
    if (task.status !== 'qa_pending') {
      await updateStatus(task.id, 'qa_pending');
    }
    return;
  }

  // Self-upgrade detection
  const escalateOpus = ctx?.QA_ESCALATE_OPUS === true && !qaBlock.escalated_already;
  const model: 'claude-sonnet-4-6' | 'claude-opus-4-7' = escalateOpus ? 'claude-opus-4-7' : 'claude-sonnet-4-6';
  const effort: 'medium' | 'high' = escalateOpus ? 'high' : 'medium';

  if (escalateOpus) {
    logEvent(task.id, 'qa', 'qa_escalated', `Self-upgrading to ${model}/${effort} for ambiguous verification`);
    // Mark escalated so we don't loop
    ctx.qa.escalated_already = true;
    delete ctx.QA_ESCALATE_OPUS;
    try {
      writeFileSync(join(TASKS_DIR, task.id, 'context.json'), JSON.stringify(ctx, null, 2));
    } catch {}
  }

  const mcpConfigPath = join(SHARED_ROOT, 'agents', 'mcp-configs', 'qa.json');

  // Pre-create the per-task QA screenshots dir under flockbotsHome so the
  // agent's first browser_screenshot call doesn't fail on a missing
  // directory and lands the file in the right place from the very first
  // step. mkdirSync(recursive) is a no-op if the dir already exists.
  const qaScreenshotsDir = join(flockbotsHome(), 'tasks', task.id, 'qa-screenshots');
  mkdirSync(qaScreenshotsDir, { recursive: true });

  // Build qa context for the prompt
  const qaContext = [
    `QA verification for task ${task.id}.`,
    `qa_urls: ${JSON.stringify(qaBlock.qa_urls || [])}`,
    `qa_instructions: ${qaBlock.qa_instructions || '(none)'}`,
    `qa_uses_canvas: ${!!qaBlock.qa_uses_canvas}`,
    `PR: ${task.pr_url || '(none)'}`,
    ``,
    `SCREENSHOT SAVE PATH (CRITICAL):`,
    `Save every screenshot to this exact directory:`,
    `  ${qaScreenshotsDir}`,
    `Use the absolute path when calling browser_screenshot — for example:`,
    `  browser_screenshot(path: "${qaScreenshotsDir}/step-1.png")`,
    `DO NOT save screenshots to a relative path. DO NOT save them in the`,
    `target repo. The directory is pre-created — just write to it.`,
  ].join('\n');

  const result = await runAgentWithRetry({
    agent: 'qa',
    taskId: task.id,
    model,
    effortLevel: effort as any,
    tools: AGENT_DEFAULTS.qa.tools,
    mcpConfigPath,
    extraPromptContext: qaContext,
    // cwd is flockbotsHome (NOT target repo): the QA prompt's relative
    // paths like "tasks/<id>/qa-screenshots/step-1.png" resolve here as
    // <flockbotsHome>/tasks/<id>/qa-screenshots/step-1.png — alongside the
    // canonical context.json + qa-report.md + qa-failure.json. QA tests
    // the deployed staging URL via Playwright; no target-repo file access
    // is needed, so changing cwd costs nothing.
    cwd: flockbotsHome(),
    enableStreaming: true,
  }, 1); // Single retry only — QA is expensive + Playwright flakiness isn't fixed by retrying

  if (result.status !== 'complete') {
    logEvent(task.id, 'qa', 'qa_session_failed', `QA session exited with ${result.status} — escalating`);
    await handleEscalation(task, result, 'QA session failed to complete. Review QA agent output for details.');
    return;
  }

  // Check for self-upgrade request — re-enter qa_pending so next tick picks up with Opus
  const ctxAfter = readJSON(join(TASKS_DIR, task.id, 'context.json'));
  if (ctxAfter?.QA_ESCALATE_OPUS === true && !ctxAfter?.qa?.escalated_already) {
    logEvent(task.id, 'qa', 'qa_requested_opus', 'QA requested Opus upgrade — requeueing');
    await updateStatus(task.id, 'qa_pending');
    return;
  }

  // Determine pass/fail from QA output (structure check, not semantics)
  const qaValidation = validateQAOutput(task.id);
  if (!qaValidation.valid) {
    await handleEscalation(task, result,
      `QA agent output failed validation: ${qaValidation.errors.join('; ')}`);
    return;
  }

  const reportPath = join(TASKS_DIR, task.id, 'qa-report.md');
  const failurePath = join(TASKS_DIR, task.id, 'qa-failure.json');
  const report = readFileSync(reportPath, 'utf-8');
  const passed = /QA Report\s*[—-]\s*PASS/i.test(report);
  const failed = /QA Report\s*[—-]\s*FAIL/i.test(report);

  // Visual drift handling runs on BOTH pass and fail paths since drift is a
  // side-channel report independent of functional pass/fail. Drift_major
  // items spawn their own child task.
  await processVisualDrift(task);

  if (passed) {
    logEvent(task.id, 'qa', 'qa_passed', `QA verification passed for ${task.title}`);
    db.prepare("UPDATE tasks SET qa_status = 'passed' WHERE id = ?").run(task.id);
    await updateStatus(task.id, 'qa_done');
    // Transition through to merged after qa_done — keeps downstream state consistent
    db.prepare('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), task.id);
    await updateStatus(task.id, 'merged');

    // Integration QA for an epic: finalize the parent epic. Suppress the
    // generic QA-pass notification — finalizeEpic sends its own epic-aware
    // message.
    if (task.source === 'epic-qa' && task.parent_task_id) {
      await finalizeEpic(task.parent_task_id, 'passed');
    } else {
      await notifyOperatorQAPass(task, ctxAfter);
    }

    // Epic QA fix landed — close the epic if all integration-QA fixes are done.
    if (task.source === 'epic-qa-fix' && task.parent_task_id) {
      await maybeFinalizeEpicAfterFix(task.parent_task_id);
    }
    cleanupQAArtifacts(task.id);
    return;
  }

  if (!failed || !fileExists(failurePath)) {
    await handleEscalation(task, result, 'QA report did not clearly pass or fail, or qa-failure.json missing');
    return;
  }

  // FAIL path. The parent task's FEATURE did merge — the regression is handled
  // by a separate auto-created fix task. So we still land the parent at merged
  // (with qa_failed as a short-lived intermediate for event-log visibility).
  const failure = readJSON(failurePath);
  logEvent(task.id, 'qa', 'qa_failed', `QA verification failed: ${failure.failing_step || 'unknown step'}`);
  db.prepare("UPDATE tasks SET qa_status = 'failed' WHERE id = ?").run(task.id);
  await updateStatus(task.id, 'qa_failed');

  // staging_error means the QA agent couldn't actually exercise the
  // feature — Playwright MCP unavailable, repeated element timeouts,
  // staging deploy broken, etc. Auto-spawning a code-fix task for that
  // sends a dev to chase a phantom regression. Skip the fix task and
  // escalate to the operator instead so they can fix staging.
  const isStagingError = failure.category === 'staging_error';
  if (!isStagingError) {
    await createQAFixTask(task, failure);
  } else {
    logEvent(task.id, 'qa', 'qa_staging_error',
      `Skipping auto-fix task: QA failed with staging_error (${failure.failing_step || 'unknown step'})`);
  }

  // Integration QA for an epic: halt the epic with finalizeEpic's escalation
  // (it knows the epic context). Suppress the generic QA-fail notification.
  if (task.source === 'epic-qa' && task.parent_task_id) {
    await finalizeEpic(task.parent_task_id, 'failed', failure);
  } else if (isStagingError) {
    await handleEscalation(task, result, [
      `QA could not run because of a staging environment error.`,
      ``,
      `Failing step: ${failure.failing_step || '(unknown)'}`,
      `Detail: ${failure.actual || failure.expected || '(no detail captured)'}`,
      ``,
      `This is not a code regression — staging is broken or the QA agent`,
      `couldn't reach the browser. No fix task was auto-created. Investigate`,
      `staging health, then reply to re-queue QA for task ${task.id}.`,
    ].join('\n'));
  } else {
    await notifyOperatorQAFail(task, failure);
  }

  db.prepare('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), task.id);
  await updateStatus(task.id, 'merged');

  // Epic QA fix landed (with QA failure → another fix already spawned by
  // createQAFixTask above). maybeFinalizeEpicAfterFix sees the new fix as
  // pending and skips closing — but call it for symmetry with the pass
  // path so any chain-end correctly finalizes when fixes finally clear.
  if (task.source === 'epic-qa-fix' && task.parent_task_id) {
    await maybeFinalizeEpicAfterFix(task.parent_task_id);
  }
  cleanupQAArtifacts(task.id);
}

/**
 * Read tasks/<id>/qa-visual-report.json (if QA wrote one) and spawn a single
 * "Design drift" follow-up task covering all `drift_major` screens. Minor
 * drift is recorded in the event log but doesn't spawn anything.
 *
 * Drift handling is intentionally decoupled from the parent task's
 * pass/fail: visual fidelity is a soft check and shouldn't reopen a feature
 * that functionally works.
 */
async function processVisualDrift(task: Task): Promise<void> {
  const reportPath = join(TASKS_DIR, task.id, 'qa-visual-report.json');
  if (!fileExists(reportPath)) return;

  let report: any;
  try {
    report = readJSON(reportPath);
  } catch (err: any) {
    logEvent(task.id, 'qa', 'visual_report_unreadable', err?.message || 'unknown');
    return;
  }

  const screens: any[] = Array.isArray(report?.screens) ? report.screens : [];
  if (screens.length === 0) return;

  const major = screens.filter(s => s?.verdict === 'drift_major');
  const minor = screens.filter(s => s?.verdict === 'drift_minor');
  const matched = screens.filter(s => s?.verdict === 'match');

  logEvent(task.id, 'qa', 'visual_summary',
    `match=${matched.length} drift_minor=${minor.length} drift_major=${major.length}`);

  if (major.length > 0) {
    await createDesignDriftTask(task, major);
  }
}

/**
 * Spawn a child task tracking visual drift between the merged implementation
 * and the originally-approved wireframes. Mirrors createQAFixTask shape so
 * the dashboard + chat surfaces handle both child types identically.
 */
async function createDesignDriftTask(parent: Task, drifts: any[]): Promise<void> {
  const { createTask } = await import('./queue');
  const { randomUUID } = await import('crypto');
  const newId = randomUUID().slice(0, 8);

  const lines: string[] = [
    `Visual drift detected against the approved wireframes after merging task ${parent.id}.`,
    '',
    `${drifts.length} screen${drifts.length === 1 ? '' : 's'} flagged as drift_major. The functional QA check itself passed (or was independently logged as failed); these are visual-fidelity issues only.`,
    '',
    '## Drifted screens',
    '',
  ];
  for (const d of drifts) {
    const id = d?.id || '(unknown)';
    const vp = d?.viewport ? ` (${d.viewport})` : '';
    lines.push(`### ${id}${vp}`);
    if (d?.notes) lines.push(d.notes);
    if (d?.wireframe_path) lines.push(`- Wireframe: ${d.wireframe_path}`);
    if (d?.live_screenshot_path) lines.push(`- Live: ${d.live_screenshot_path}`);
    lines.push('');
  }
  lines.push(`Original PR: ${parent.pr_url || '(none)'}`);
  lines.push(`Read full visual report at tasks/${parent.id}/qa-visual-report.json before coding.`);

  createTask(
    newId,
    `Design drift: ${parent.title}`,
    lines.join('\n'),
    'qa-auto',
    undefined,
    parent.priority,
  );
  db.prepare('UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE id = ?')
    .run(parent.id, Date.now(), newId);
  await syncToSupabase('task_update', { id: newId });
  logEvent(newId, 'system', 'design_drift_task',
    `Auto-created design-drift task for parent ${parent.id} covering ${drifts.length} screen(s)`);
}

/**
 * Remove the QA agent's local screenshot/video artifacts after they've
 * been uploaded to Supabase + sent to chat. The QA prompt directs the
 * agent to save under tasks/<taskId>/qa-screenshots/, which with
 * cwd=TARGET_REPO_PATH lands the files INSIDE the user's target repo —
 * polluting their working tree if not gitignored. We also clean the
 * flockbotsHome variant in case a future prompt change moves them there.
 *
 * Best-effort: silent on errors. If the dir doesn't exist (e.g. legacy
 * run that uploaded directly without local copies) the rmSync no-ops.
 */
function cleanupQAArtifacts(taskId: string): void {
  const candidates = [
    TARGET_REPO_PATH ? join(TARGET_REPO_PATH, 'tasks', taskId, 'qa-screenshots') : '',
    join(flockbotsHome(), 'tasks', taskId, 'qa-screenshots'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
  // If the parent tasks/<taskId>/ dir under TARGET_REPO_PATH is now empty
  // (we created it just for screenshots — the canonical task artifacts
  // live under flockbotsHome), remove it too. The parent tasks/ dir at
  // the repo root is left alone — it might be the user's own.
  if (TARGET_REPO_PATH) {
    const taskDirInRepo = join(TARGET_REPO_PATH, 'tasks', taskId);
    try {
      if (existsSync(taskDirInRepo) && readdirSync(taskDirInRepo).length === 0) {
        rmSync(taskDirInRepo, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
}

/**
 * Walk a task's parent chain to find the originating epic, if any. Returns
 * the epic's task ID when one is found, else null. Used to route QA-fix
 * tasks back to their epic regardless of how many fix-of-fix levels deep
 * we are.
 */
function findAncestorEpicId(task: Task): string | null {
  if (task.is_epic === 1) return task.id;
  const visited = new Set<string>();
  let current: Task | undefined = task;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.is_epic === 1) return current.id;
    if (!current.parent_task_id) return null;
    current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(current.parent_task_id) as Task | undefined;
  }
  return null;
}

/**
 * Create a new inbox task that links back to the failed QA's parent. The dev
 * pipeline picks it up naturally on the next tick.
 *
 * For epic-tied QA failures (integration QA or any fix-of-fix descended
 * from one), the new task is linked directly to the EPIC with source
 * 'epic-qa-fix' so maybeFinalizeEpicAfterFix can detect when all fixes
 * have landed and close the epic.
 */
async function createQAFixTask(parent: Task, failure: any): Promise<void> {
  const { createTask } = await import('./queue');
  const { randomUUID } = await import('crypto');
  const newId = randomUUID().slice(0, 8);

  const description = [
    `QA regression detected against staging after merging task ${parent.id}.`,
    '',
    `**Failing step:** ${failure.failing_step || '(not specified)'}`,
    `**Expected:** ${failure.expected || '(not specified)'}`,
    `**Actual:** ${failure.actual || '(not specified)'}`,
    failure.recommended_fix_hypothesis ? `\n**Hypothesis:** ${failure.recommended_fix_hypothesis}` : '',
    failure.screenshot_path ? `\n**Screenshot:** ${failure.screenshot_path}` : '',
    failure.console_errors?.length ? `\n**Console errors:**\n${failure.console_errors.map((e: string) => `- ${e}`).join('\n')}` : '',
    '',
    `Original PR: ${parent.pr_url || '(none)'}`,
    `Read full failure details at tasks/${parent.id}/qa-failure.json before coding.`,
  ].filter(Boolean).join('\n');

  const epicId = findAncestorEpicId(parent);
  const fixSource = epicId ? 'epic-qa-fix' : 'qa-auto';
  const fixParentId = epicId || parent.id;
  const titlePrefix = epicId ? 'Epic QA fix' : 'QA fix';

  createTask(
    newId,
    `${titlePrefix}: ${parent.title.replace(/^Integration QA:\s*/, '').replace(/^Epic QA fix:\s*/, '')}`,
    description,
    fixSource,
    undefined,
    parent.priority,
  );
  db.prepare('UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE id = ?')
    .run(fixParentId, Date.now(), newId);
  await syncToSupabase('task_update', { id: newId });
  logEvent(newId, 'system', 'qa_auto_task',
    epicId
      ? `Auto-created epic QA fix for epic ${epicId} (chained from ${parent.id})`
      : `Auto-created QA fix task for parent ${parent.id}`);
}

async function notifyOperatorQAPass(task: Task, ctx: any): Promise<void> {
  const screenshot = ctx?.qa_result?.screenshot_path;
  const childBlock = summarizeChildTasks(task.id);
  const msg = `QA passed ✓\n${task.title}\nPR: ${task.pr_url || '(none)'}` + childBlock;
  if (screenshot) {
    const { notifyOperatorMedia } = await import('./notifier');
    const url = await uploadQAMedia(task.id, screenshot);
    if (url) {
      await notifyOperatorMedia(msg, url, 'image').catch((err: any) => console.error('WA media send failed:', err.message));
      return;
    }
  }
  await notifyOperator(msg);
}

async function notifyOperatorQAFail(task: Task, failure: any): Promise<void> {
  const childBlock = summarizeChildTasks(task.id);
  const msg = [
    `QA failed ✗`,
    task.title,
    `Step: ${failure.failing_step || '(unknown)'}`,
    `Expected: ${failure.expected || '(unknown)'}`,
    `Actual: ${failure.actual || '(unknown)'}`,
  ].join('\n') + childBlock;
  if (failure.screenshot_path) {
    const { notifyOperatorMedia } = await import('./notifier');
    const url = await uploadQAMedia(task.id, failure.screenshot_path);
    if (url) {
      await notifyOperatorMedia(msg, url, 'image').catch((err: any) => console.error('WA media send failed:', err.message));
      return;
    }
  }
  await notifyOperator(msg);
}

/**
 * List child tasks spawned by QA on this run (regression fixes + design
 * drift). Returns a leading-newline-prefixed block ready to append to
 * pass/fail messages, or an empty string when no children exist.
 */
function summarizeChildTasks(parentId: string): string {
  const children = db.prepare(`
    SELECT id, title FROM tasks
    WHERE parent_task_id = ?
    ORDER BY created_at DESC
  `).all(parentId) as Array<{ id: string; title: string }>;

  if (children.length === 0) return '';

  const lines = [
    '',
    '',
    `📋 QA created ${children.length} follow-up task${children.length === 1 ? '' : 's'}:`,
  ];
  for (const c of children) {
    lines.push(`  • ${c.id} — ${c.title}`);
  }
  return lines.join('\n');
}

/**
 * Upload a QA screenshot/recording to Supabase Storage and return a
 * short-lived signed URL for WhatsApp media embedding. Wraps the shared
 * `uploadTaskMedia` helper with QA-specific path resolution: the QA agent
 * may emit relative or absolute paths, so we probe a few candidates before
 * giving up.
 */
async function uploadQAMedia(taskId: string, localPath: string): Promise<string | null> {
  // The QA agent runs with cwd=TARGET_REPO_PATH and the prompt may emit
  // relative paths like "tasks/<id>/qa-screenshots/step-3.png", which
  // resolves under the user's target repo. The agent may also use an
  // absolute path. Try every reasonable candidate so we find the file
  // regardless of which convention the agent picked this run.
  const candidates = localPath.startsWith('/')
    ? [localPath]
    : [
        join(flockbotsHome(), localPath),
        TARGET_REPO_PATH ? join(TARGET_REPO_PATH, localPath) : '',
      ].filter(Boolean);
  const fullPath = candidates.find(p => fileExists(p));
  if (!fullPath) {
    logEvent(taskId, 'qa', 'media_missing', `Screenshot not found at any of: ${candidates.join(', ')}`);
    return null;
  }

  // Prefix by instance so two instances generating the same 8-char taskId
  // never overwrite each other's QA artifacts.
  const inst = process.env.FLOCKBOTS_INSTANCE_ID;
  if (!inst) {
    logEvent(taskId, 'qa', 'media_skipped', 'FLOCKBOTS_INSTANCE_ID not set');
    return null;
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(fullPath);
  } catch (err: any) {
    logEvent(taskId, 'qa', 'media_error', err.message);
    return null;
  }

  const { uploadTaskMedia } = await import('./task-media-upload');
  const url = await uploadTaskMedia({
    bucket: process.env.SUPABASE_STORAGE_BUCKET_QA || 'qa-media',
    key: `${inst}/${taskId}/${Date.now()}-${localPath.split('/').pop()}`,
    buffer,
    contentType: localPath.endsWith('.webm') ? 'video/webm' : 'image/png',
  });
  if (url === null) {
    logEvent(taskId, 'qa', 'media_upload_failed', 'upload or sign failed (Supabase missing or rejected)');
  }
  return url;
}

// --- Post-Merge Knowledge Update ---

async function runPostMergeKnowledgeUpdate(task: Task): Promise<void> {
  if (!canRunAgent('claude-sonnet-4-6', 'XS')) return; // Skip if budget is tight

  // The script lives at the shared root; cwd must be the per-instance home
  // so the script's .env lookup finds this flock's TARGET_REPO_PATH.
  const SHARED_ROOT = flockbotsRoot();
  const INSTANCE_HOME = flockbotsHome();

  // Fire off an incremental graphify rebuild in the background so the next
  // task's agents get a fresh graph. Runs as its own claude -p session via the
  // build script; we don't await it — pipeline continues immediately.
  try {
    const { spawn } = await import('child_process');
    const kgProc = spawn('bash', [join(SHARED_ROOT, 'scripts/build-knowledge-graph.sh'), 'incremental'], {
      cwd: INSTANCE_HOME,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    kgProc.unref();
    logEvent(task.id, 'system', 'kg_incremental_started',
      'Kicked off incremental knowledge-graph rebuild in background');
  } catch (err: any) {
    logEvent(task.id, 'system', 'kg_incremental_skipped',
      `Could not start incremental KG rebuild: ${err.message}`);
  }

  try {
    // Get the merged diff to understand what changed
    let diff = '';
    try {
      const octokit = await getOctokit();
      const { data } = await octokit.pulls.get({
        owner: GITHUB_OWNER, repo: GITHUB_REPO,
        pull_number: task.pr_number!,
        mediaType: { format: 'diff' },
      });
      diff = (data as unknown as string).slice(0, 8000); // Cap diff size
    } catch { return; } // If we can't get the diff, skip

    logEvent(task.id, 'system', 'knowledge_update_started', `Updating system knowledge after merge: ${task.title}`);

    const result = await runAgentWithRetry({
      agent: 'pm',
      taskId: task.id,
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Write', 'Glob', 'Grep'],
      // No --max-turns: sessionTimeout (30min default for unsized PM
      // calls) + count-based auto-resume bound this fire-and-forget
      // doc-update path. The previous 10-turn cap was arbitrary.
      extraPromptContext: `POST-MERGE KNOWLEDGE UPDATE

A feature was just merged. Review the diff below and update the relevant sharded skills files if any of these changed:
- Architecture overview / technical decisions → skills/product/workflows.md
- Key user workflows → skills/product/workflows.md
- Domain concepts / entities → skills/product/domain.md
- Tech stack
- Integration points

Rules:
- Only update files that are actually affected by this diff
- Do NOT touch skills/product/vision.md (vision, personas, scope, success metrics)
- If nothing meaningful changed (just a bug fix, typo, etc.), write "NO_UPDATE_NEEDED" to context.json and stop
- Keep updates concise — match the existing writing style
- Append new workflows/entities if they were added, update existing ones if they changed

Task: ${task.title}
PR: ${task.pr_url}

Merged diff (truncated):
${diff}`,
      cwd: TARGET_REPO_PATH,
    }, 1); // Single attempt, non-critical

    if (result.status === 'complete') {
      logEvent(task.id, 'system', 'knowledge_updated', 'Product context updated after merge');
    }
  } catch (err: any) {
    // Non-critical — log and continue
    logEvent(task.id, 'system', 'knowledge_update_skipped', `Knowledge update failed: ${err.message}`);
  }
}

// --- Main Processing Loop ---

function getNextPendingStage(): Task | null {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('inbox', 'researching', 'design_pending', 'designing',
                     'wireframes_rendering', 'design_validation',
                     'developing', 'review_pending', 'reviewing')
    ORDER BY
      CASE status
        WHEN 'reviewing' THEN 1
        WHEN 'review_pending' THEN 2
        WHEN 'developing' THEN 3
        WHEN 'design_validation' THEN 4
        WHEN 'wireframes_rendering' THEN 5
        WHEN 'designing' THEN 6
        WHEN 'design_pending' THEN 7
        WHEN 'researching' THEN 8
        WHEN 'inbox' THEN 9
      END,
      priority ASC,
      created_at ASC
    LIMIT 1
  `).get() as Task | null;
}

/**
 * Cheap idempotent tick for an epic. Reads phase state and either:
 * - halts the epic if any phase is failed/dismissed (escalation to operator)
 * - merges epic→staging + spawns integration QA when all phases land
 * - no-ops while phases are still in progress
 *
 * Designed to be safe to run repeatedly — the next pipeline cycle will re-run
 * if the epic is still in progress. Each terminal action transitions status
 * out of epic_in_progress so we don't double-fire.
 */
async function runEpicOrchestrator(epicTask: Task): Promise<void> {
  const phases = db.prepare(`
    SELECT id, status, phase_index, title FROM tasks
    WHERE parent_task_id = ? AND source = 'epic-phase'
    ORDER BY phase_index ASC
  `).all(epicTask.id) as Array<{ id: string; status: string; phase_index: number; title: string }>;

  if (phases.length === 0) {
    logEvent(epicTask.id, 'system', 'epic_no_phases', 'Epic has no phase children — marking failed');
    await handleFailure(epicTask, {
      status: 'failed',
      output: 'Epic has no phase children to orchestrate',
      durationMs: 0, exitCode: 1,
    });
    return;
  }

  const blocking = phases.find(p => p.status === 'failed' || p.status === 'dismissed');
  if (blocking) {
    await haltEpicOnPhase(epicTask, blocking);
    return;
  }

  const allLanded = phases.every(p => p.status === 'merged' || p.status === 'deployed');
  if (!allLanded) return; // phases still in flight; nothing to do

  await mergeEpicToStaging(epicTask, phases);
}

async function haltEpicOnPhase(
  epicTask: Task,
  phase: { id: string; title: string; status: string },
): Promise<void> {
  db.prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?')
    .run('awaiting_human',
      JSON.stringify({
        previous_status: 'epic_in_progress',
        failed_phase_id: phase.id,
        phase_status: phase.status,
      }),
      Date.now(), epicTask.id);

  const msg = [
    `Epic ${epicTask.id} halted: phase ${phase.id} is "${phase.status}".`,
    `Phase title: ${phase.title}`,
    '',
    `Reply with how to proceed — retry the phase, give the agent guidance,`,
    `or abandon the epic.`,
  ].join('\n');
  createEscalation(epicTask.id, msg, JSON.stringify({ kind: 'epic_blocked', failed_phase_id: phase.id }));
  logEvent(epicTask.id, 'system', 'epic_halted',
    `Halted on phase ${phase.id} (${phase.status})`);
  await syncToSupabase('task_update', { id: epicTask.id });
  const haltPresented = await presentMessage({
    intent: 'epic_halted_on_phase',
    data: {
      epicId: epicTask.id,
      epicTitle: epicTask.title,
      phaseId: phase.id,
      phaseTitle: phase.title,
      phaseStatus: phase.status,
    },
    fallback: msg,
  });
  await notifyOperator(haltPresented);
}

async function mergeEpicToStaging(
  epicTask: Task,
  phases: Array<{ id: string; phase_index: number; title: string }>,
): Promise<void> {
  const epicBranch = epicTask.epic_branch || `epic/${epicTask.id}`;
  const octokit = await getOctokit();

  const phaseLines = phases
    .slice()
    .sort((a, b) => a.phase_index - b.phase_index)
    .map(p => `- Phase ${p.phase_index}: ${p.title} (${p.id})`);
  const prBody = [
    `Integration of epic ${epicTask.id}: ${epicTask.title}`,
    '',
    `${phases.length} phases merged on ${epicBranch}:`,
    ...phaseLines,
    '',
    `Per-phase reviews already covered correctness; this PR is a coordinator-only merge.`,
  ].join('\n');

  let prNumber: number | null = null;
  let prUrl: string | null = null;

  try {
    const { data } = await octokit.pulls.create({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      title: `Epic: ${epicTask.title}`,
      head: epicBranch,
      base: GITHUB_STAGING_BRANCH,
      body: prBody,
    });
    prNumber = data.number;
    prUrl = data.html_url;
  } catch (err: any) {
    if (err.status === 422) {
      // Try to recover an existing PR for this epic branch
      try {
        const { data: existing } = await octokit.pulls.list({
          owner: GITHUB_OWNER, repo: GITHUB_REPO,
          head: `${GITHUB_OWNER}:${epicBranch}`, state: 'open',
        });
        if (existing.length > 0) {
          prNumber = existing[0].number;
          prUrl = existing[0].html_url;
          logEvent(epicTask.id, 'system', 'epic_pr_reused', `Using existing epic PR #${prNumber}`);
        }
      } catch { /* fall through */ }
    }
    if (!prNumber) {
      logEvent(epicTask.id, 'system', 'epic_pr_failed',
        `Could not open epic→staging PR: ${err?.message || err}`);
      await handleFailure(epicTask, {
        status: 'failed',
        output: `Failed to open epic→staging PR: ${err?.message || err}`,
        durationMs: 0, exitCode: 1,
      });
      return;
    }
  }

  // Coordinator-only merge — no review since per-phase reviews already
  // covered correctness. Use 'merge' (not 'squash') so each phase's squash
  // commit stays visible on staging history.
  try {
    await octokit.pulls.merge({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      pull_number: prNumber!,
      merge_method: 'merge',
    });
    logEvent(epicTask.id, 'system', 'epic_merged',
      `Epic merged to ${GITHUB_STAGING_BRANCH} via PR #${prNumber}`);
  } catch (err: any) {
    // Idempotent: PR may already be merged from a previous attempt
    try {
      const { data: pr } = await octokit.pulls.get({
        owner: GITHUB_OWNER, repo: GITHUB_REPO,
        pull_number: prNumber!,
      });
      if (!pr.merged) {
        logEvent(epicTask.id, 'system', 'epic_merge_failed', `Merge failed: ${err?.message || err}`);
        await handleFailure(epicTask, {
          status: 'failed',
          output: `Failed to merge epic→staging PR: ${err?.message || err}`,
          durationMs: 0, exitCode: 1,
        });
        return;
      }
      logEvent(epicTask.id, 'system', 'epic_already_merged', `Epic PR #${prNumber} was already merged`);
    } catch (innerErr: any) {
      logEvent(epicTask.id, 'system', 'epic_merge_failed',
        `Could not verify merge state: ${innerErr?.message || innerErr}`);
      await handleFailure(epicTask, {
        status: 'failed',
        output: `Failed to verify epic→staging merge state: ${innerErr?.message || innerErr}`,
        durationMs: 0, exitCode: 1,
      });
      return;
    }
  }

  db.prepare('UPDATE tasks SET pr_url = ?, pr_number = ?, updated_at = ? WHERE id = ?')
    .run(prUrl, prNumber, Date.now(), epicTask.id);

  // Spawn integration QA. The QA task moves through normal qa_pending →
  // qa_running → merged with qa_status=passed/failed; runQAStage hooks
  // finalizeEpic on the epic_parent_id.
  const qaSpawn = await spawnIntegrationQATask(epicTask);
  if (!qaSpawn.success) {
    logEvent(epicTask.id, 'system', 'epic_qa_spawn_failed', qaSpawn.message);
    await handleFailure(epicTask, {
      status: 'failed',
      output: `Could not spawn integration QA: ${qaSpawn.message}`,
      durationMs: 0, exitCode: 1,
    });
    return;
  }

  await updateStatus(epicTask.id, 'epic_integrating');
  const mergeFallback =
    `Epic merged to staging: ${epicTask.title}\n` +
    `PR: ${prUrl}\n` +
    `Integration QA queued (will start in a few min — Vercel deploy buffer).`;
  const mergePresented = await presentMessage({
    intent: 'epic_merged_to_staging',
    data: {
      epicId: epicTask.id,
      epicTitle: epicTask.title,
      prUrl,
      phasesCount: phases.length,
      qaTaskId: qaSpawn.qaTaskId,
      qaWaitMinutes: Math.round((parseInt(process.env.QA_DEPLOY_WAIT_MS || String(5 * 60 * 1000)) || 5 * 60 * 1000) / 60000),
    },
    fallback: mergeFallback,
  });
  await notifyOperator(mergePresented);
}

/**
 * Tick for epic_integrating: detect QA child outcomes that runQAStage's
 * happy-path hook didn't catch (e.g. QA agent session itself failed). On
 * detected stuck states, escalate the epic.
 */
async function runEpicIntegrationTick(epicTask: Task): Promise<void> {
  const qaTask = db.prepare(`
    SELECT id, status, qa_status FROM tasks
    WHERE parent_task_id = ? AND source = 'epic-qa'
    ORDER BY created_at DESC LIMIT 1
  `).get(epicTask.id) as { id: string; status: string; qa_status: string | null } | undefined;

  if (!qaTask) {
    logEvent(epicTask.id, 'system', 'epic_integrating_orphan',
      'epic_integrating but no integration QA child found — investigate');
    return;
  }

  // Happy path is handled by runQAStage's finalizeEpic call. We only act here
  // when the QA task ended up in failed / awaiting_human (agent crash, etc.).
  if (qaTask.status === 'failed' || qaTask.status === 'awaiting_human') {
    db.prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run('awaiting_human',
        JSON.stringify({
          previous_status: 'epic_integrating',
          integration_qa_blocked: true,
          qa_task_id: qaTask.id,
        }),
        Date.now(), epicTask.id);

    const msg = [
      `Epic ${epicTask.id}: integration QA agent is stuck (${qaTask.status}).`,
      `QA task: ${qaTask.id}`,
      `Reply to retry the QA task or abandon the epic.`,
    ].join('\n');
    createEscalation(epicTask.id, msg, JSON.stringify({ kind: 'epic_qa_stuck', qa_task_id: qaTask.id }));
    logEvent(epicTask.id, 'system', 'epic_qa_stuck',
      `Integration QA in ${qaTask.status} — epic awaiting human`);
    await syncToSupabase('task_update', { id: epicTask.id });
    const stuckPresented = await presentMessage({
      intent: 'epic_integration_qa_stuck',
      data: {
        epicId: epicTask.id,
        epicTitle: epicTask.title,
        qaTaskId: qaTask.id,
        qaStatus: qaTask.status,
      },
      fallback: msg,
    });
    await notifyOperator(stuckPresented);
  }
  // qa_pending / qa_running / merged → just wait
}

async function processTaskStage(task: Task): Promise<void> {
  switch (task.status) {
    case 'inbox':
      await updateStatus(task.id, 'researching');
      await runResearchStage(task);
      break;
    case 'researching':
      await runResearchStage(task);
      break;
    case 'design_pending':
      await updateStatus(task.id, 'designing');
      await runDesignStage(task);
      break;
    case 'designing':
      await runDesignStage(task);
      break;
    case 'wireframes_rendering':
      await runWireframesRendering(task);
      break;
    case 'design_validation':
      await runDesignValidation(task);
      break;
    case 'developing':
      await resumeDevWithContext(task);
      break;
    case 'testing':
      await runTestStage(task);
      break;
    case 'review_pending':
      await runCreatePR(task);
      break;
    case 'reviewing':
      await runReviewStage(task);
      break;
    case 'qa_pending':
      await updateStatus(task.id, 'qa_running');
      await runQAStage(task);
      break;
    case 'qa_running':
      await runQAStage(task);
      break;
    case 'epic_in_progress':
      await runEpicOrchestrator(task);
      break;
    case 'epic_integrating':
      await runEpicIntegrationTick(task);
      break;
  }
}

export async function processNextTask(): Promise<void> {
  // Find all pending tasks and try to run one per available agent.
  // qa_pending tasks waiting for the post-merge Vercel deploy (qa_ready_at in the
  // future) are excluded — picking them up would flap qa_pending → qa_running →
  // qa_pending each tick, spam the activity tape, and show Zara as actively
  // working when she's not. Wait quietly until the deploy buffer has elapsed.
  const pendingTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('inbox', 'researching', 'design_pending', 'designing',
                     'wireframes_rendering', 'design_validation',
                     'developing', 'review_pending', 'reviewing',
                     'qa_pending', 'qa_running',
                     'epic_in_progress', 'epic_integrating')
      AND NOT (status = 'qa_pending' AND qa_ready_at IS NOT NULL AND qa_ready_at > ?)
    ORDER BY
      CASE status
        WHEN 'reviewing' THEN 1
        WHEN 'review_pending' THEN 2
        WHEN 'developing' THEN 3
        WHEN 'design_validation' THEN 4
        WHEN 'wireframes_rendering' THEN 5
        WHEN 'designing' THEN 6
        WHEN 'design_pending' THEN 7
        WHEN 'researching' THEN 8
        WHEN 'inbox' THEN 9
        WHEN 'qa_running' THEN 10
        WHEN 'qa_pending' THEN 11
        WHEN 'epic_in_progress' THEN 12
        WHEN 'epic_integrating' THEN 13
      END,
      priority ASC,
      created_at ASC
  `).all(Date.now()) as Task[];

  // Also check for dev_ready tasks
  const devTask = pickNextTask();
  if (devTask && !pendingTasks.find(t => t.id === devTask.id)) {
    const fullTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(devTask.id) as Task;
    if (fullTask) pendingTasks.push(fullTask);
  }

  const launched: Promise<void>[] = [];

  for (const task of pendingTasks) {
    const agent = agentForStatus(task.status);
    if (isAgentLocked(agent)) continue;
    if (!acquireAgentLock(agent, task.id)) continue;

    // Launch task processing without awaiting — allows multiple agents to run concurrently
    const work = (async () => {
      try {
        if (task.status === 'dev_ready') {
          await runDevPipeline(task);
        } else {
          await processTaskStage(task);
        }
      } catch (err: any) {
        console.error(`Task ${task.id} stage error:`, err.message);
      } finally {
        releaseAgentLock(agent);
      }
    })();

    launched.push(work);
  }

  // Wait for all launched tasks to complete before the next cycle
  if (launched.length > 0) {
    await Promise.all(launched);
  }
}

/**
 * Rollback a merged task by reverting its squash merge commit on staging.
 */
export async function rollbackTask(task: Task): Promise<string> {
  try {
    const octokit = await getOctokit();

    // Get the merge commit SHA from the PR
    const { data: pr } = await octokit.pulls.get({
      owner: GITHUB_OWNER, repo: GITHUB_REPO,
      pull_number: task.pr_number!,
    });

    if (!pr.merge_commit_sha) {
      return `No merge commit found for PR #${task.pr_number}`;
    }

    // Revert locally: fetch staging, revert the merge commit, push
    const git = simpleGit(TARGET_REPO_PATH);
    await git.fetch('origin', GITHUB_STAGING_BRANCH);
    await git.checkout(GITHUB_STAGING_BRANCH);
    await git.pull('origin', GITHUB_STAGING_BRANCH);

    try {
      await git.raw(['revert', '--no-edit', pr.merge_commit_sha]);
    } catch {
      await git.raw(['revert', '--abort']).catch(() => {});
      return `Revert has conflicts — needs manual resolution. Merge commit: ${pr.merge_commit_sha}`;
    }

    await git.push('origin', GITHUB_STAGING_BRANCH);

    // Update task status
    db.prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run('failed', JSON.stringify({ reverted: true, merge_commit: pr.merge_commit_sha }), Date.now(), task.id);

    logEvent(task.id, 'system', 'rollback', `Reverted merge commit ${pr.merge_commit_sha}`);
    await syncToSupabase('task_update', { id: task.id });

    if (task.source_id) {
      await updateLinearIssue(task.source_id, 'In Progress');
    }

    return `Rolled back: ${task.title}\nReverted commit ${pr.merge_commit_sha.slice(0, 7)} on ${GITHUB_STAGING_BRANCH}`;
  } catch (err: any) {
    return `Rollback failed: ${err.message}`;
  }
}

/**
 * Deploy staging to production by creating and merging a PR from staging → main/master.
 */
export async function deployToProduction(): Promise<string> {
  const prodBranch = GITHUB_PROD_BRANCH;
  try {
    const octokit = await getOctokit();

    // Check if there are commits ahead
    const { data: comparison } = await octokit.repos.compareCommits({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      base: prodBranch,
      head: GITHUB_STAGING_BRANCH,
    });

    if (comparison.total_commits === 0) {
      return `Nothing to deploy — ${GITHUB_STAGING_BRANCH} is up to date with ${prodBranch}`;
    }

    // Create PR from staging → production
    const { data: pr } = await octokit.pulls.create({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      title: `Deploy: ${GITHUB_STAGING_BRANCH} → ${prodBranch}`,
      head: GITHUB_STAGING_BRANCH,
      base: prodBranch,
      body: `Automated deploy of ${comparison.total_commits} commit(s) from ${GITHUB_STAGING_BRANCH} to ${prodBranch}.`,
    });

    // Merge immediately
    await octokit.pulls.merge({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      pull_number: pr.number,
      merge_method: 'merge',
    });

    // Transition all staging-merged tasks to 'deployed' so they leave the
    // "merged" column in the dashboard (which now reflects tasks currently
    // in staging only). The new "Deployed" modal surfaces historical tasks.
    const mergedTasks = db.prepare("SELECT id FROM tasks WHERE status = 'merged'").all() as { id: string }[];
    if (mergedTasks.length > 0) {
      const nowTs = Date.now();
      db.prepare("UPDATE tasks SET status = 'deployed', updated_at = ? WHERE status = 'merged'").run(nowTs);
      // Fire per-task sync so dashboard sees the new status immediately
      for (const t of mergedTasks) {
        syncToSupabase('task_update', { id: t.id }).catch((err: any) =>
          console.error(`Failed to sync deployed task ${t.id}:`, err.message));
      }
    }

    logEvent(null, 'system', 'deploy',
      `Deployed ${comparison.total_commits} commit(s) to ${prodBranch} via PR #${pr.number} | ${mergedTasks.length} task(s) moved to deployed`);

    return `Deployed to ${prodBranch}\n${comparison.total_commits} commit(s) merged via PR #${pr.number}\n${mergedTasks.length} task(s) moved to deployed\n${pr.html_url}`;
  } catch (err: any) {
    // PR might already exist
    if (err.status === 422) {
      try {
        const octokit = await getOctokit();
        const { data: existing } = await octokit.pulls.list({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          head: `${GITHUB_OWNER}:${GITHUB_STAGING_BRANCH}`,
          base: prodBranch,
          state: 'open',
        });
        if (existing.length > 0) {
          await octokit.pulls.merge({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            pull_number: existing[0].number,
            merge_method: 'merge',
          });
          // Same task-status flip as the primary deploy path
          const mergedTasks = db.prepare("SELECT id FROM tasks WHERE status = 'merged'").all() as { id: string }[];
          if (mergedTasks.length > 0) {
            db.prepare("UPDATE tasks SET status = 'deployed', updated_at = ? WHERE status = 'merged'").run(Date.now());
            for (const t of mergedTasks) {
              syncToSupabase('task_update', { id: t.id }).catch(() => {});
            }
          }
          logEvent(null, 'system', 'deploy',
            `Deployed to ${prodBranch} via existing PR #${existing[0].number} | ${mergedTasks.length} task(s) moved to deployed`);
          return `Deployed to ${prodBranch} via existing PR #${existing[0].number}\n${mergedTasks.length} task(s) moved to deployed\n${existing[0].html_url}`;
        }
      } catch {}
    }
    return `Deploy failed: ${err.message}`;
  }
}

export { handleFailure, isLocked };
