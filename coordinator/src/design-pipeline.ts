/**
 * Design pipeline stages — extracted from pipeline.ts to keep that file
 * closer to the project's <500-line guideline. Holds three coordinator
 * stages and their shared helpers:
 *
 *   designing → wireframes_rendering → design_validation
 *
 * After validation, the pipeline either routes to the human approval gate
 * (awaiting_design_approval, handled in design-notify.ts) or loops back to
 * design_pending for another designer pass.
 *
 * Cross-module imports for `updateStatus`, `handleAgentResult`, and
 * `handleEscalation` are deferred via dynamic `await import('./pipeline')`
 * inside each function body. This sidesteps the circular import: pipeline.ts
 * statically imports this module to register the dispatch table, while this
 * module only resolves the pipeline helpers at call time — by which point
 * both modules are fully loaded.
 */

import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { db, Task, logEvent, consumeAnsweredEscalations, createEscalation } from './queue';
import { AGENT_DEFAULTS, runAgentWithRetry, readJSON, fileExists } from './session-manager';
import { canRunAgent } from './scheduler';
import { tasksDir } from './paths';

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH || '';
const TASKS_DIR = tasksDir();

// ---------------------------------------------------------------------------
// Design system tier detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the target repo has a design system at skills/design/.
 * Branches the designer prompt: when present, designer is constrained to
 * existing tokens; when absent, designer picks a coherent visual language
 * from PM intent + repo context.
 */
function detectDesignSystem(): 'available' | 'absent' {
  if (!TARGET_REPO_PATH) return 'absent';
  const designDir = join(TARGET_REPO_PATH, 'skills', 'design');
  return existsSync(designDir) ? 'available' : 'absent';
}

function designerTierContext(): string {
  if (detectDesignSystem() === 'available') {
    return [
      '',
      'DESIGN SYSTEM TIER: AVAILABLE.',
      'A design system exists at skills/design/. Read only the sharded',
      'guides referenced in your context-pack. Use existing tokens and',
      'components. New components are allowed only when no equivalent',
      'exists; new components must match the established style, spacing',
      'scale, typography, and color vocabulary.',
    ].join('\n');
  }
  return [
    '',
    'DESIGN SYSTEM TIER: ABSENT.',
    'No design system exists in this repo. Pick a coherent visual',
    'language inferred from PM intent + any existing UI in the target',
    'repo. Document your typography scale, spacing base unit, color',
    'palette, and key component choices in an HTML comment block at the',
    'top of 01-*.html, then reference it for every later screen so the',
    'set stays visually consistent.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Stage: designing — designer agent produces HTML wireframes + index.json
// ---------------------------------------------------------------------------

export async function runDesignStage(task: Task): Promise<void> {
  if (!canRunAgent('claude-sonnet-4-6', 'S')) return;

  // If resuming after an answered escalation, inject the answer as context
  const escalation = db.prepare(
    "SELECT answer FROM escalations WHERE task_id = ? AND status = 'answered' ORDER BY answered_at DESC LIMIT 1"
  ).get(task.id) as { answer: string } | undefined;
  const isResume = !!escalation?.answer;

  // Build the extra prompt context: design-system tier first (always), then
  // any escalation answer carry-over.
  const tierContext = designerTierContext();
  const answerContext = isResume
    ? `\n\nHUMAN ANSWER TO YOUR QUESTION(S):\n${escalation.answer}\n\nContinue your design with this information. The questions.md file has been cleared since they are now answered. Only create a new questions.md if you have GENUINELY NEW questions.`
    : '';
  const extraPromptContext = tierContext + answerContext;

  // Clear old questions.md so resumed session doesn't see stale questions
  if (isResume) {
    const questionsPath = join(TASKS_DIR, task.id, 'questions.md');
    if (fileExists(questionsPath)) {
      try { rmSync(questionsPath); } catch {}
    }
  }

  const result = await runAgentWithRetry({
    agent: 'ux',
    taskId: task.id,
    model: 'claude-sonnet-4-6',
    tools: AGENT_DEFAULTS.ux.tools,
    cwd: TARGET_REPO_PATH,
    resume: isResume, // Resume UX's session if continuing after an escalation answer
    extraPromptContext,
    enableStreaming: true,
  }, 3);

  if (isResume && result.status !== 'questions_pending' && result.status !== 'escalate') {
    consumeAnsweredEscalations(task.id);
  }

  const { updateStatus, handleAgentResult } = await import('./pipeline');

  if (result.status === 'complete') {
    // After designer finishes, hand off to the coordinator-side renderer
    // before PM validation can look at the wireframes.
    await updateStatus(task.id, 'wireframes_rendering');
  } else {
    await handleAgentResult(task, result);
  }
}

// ---------------------------------------------------------------------------
// Stage: wireframes_rendering — coordinator-only, no agent invocation
// ---------------------------------------------------------------------------

/**
 * In-flight render guard. Each pipeline tick fires every 60s; a render
 * normally finishes in 5–15s, so concurrent invocations on the same task
 * are unlikely. But a slow Playwright start, a queued cron tick, or a
 * deliberate manual re-trigger could cause overlap. Without a guard we'd
 * launch two Chromium instances against the same files, double-upload to
 * Supabase, and race on saveIndex(). The guard is process-local — same
 * scope as the existing `agentLocks` Map in pipeline.ts.
 */
const wireframeRendersInProgress = new Set<string>();

/**
 * Coordinator-only stage: drive Playwright over the designer's HTML files,
 * upload to Supabase, write per-screen mediaUrls back into index.json. Then
 * transition to design_validation so PM can read the rendered output.
 *
 * The round number for this render is read from context.json#design.round
 * (defaults to 1). Round increments only on rework, set by the human-gate
 * code path in design-reply-handler.ts.
 */
export async function runWireframesRendering(task: Task): Promise<void> {
  if (wireframeRendersInProgress.has(task.id)) {
    logEvent(task.id, 'system', 'wireframes_render_skip',
      'Render already in progress for this task; skipping duplicate tick');
    return;
  }
  wireframeRendersInProgress.add(task.id);

  try {
    const { renderWireframes } = await import('./wireframe-renderer');
    const { updateStatus } = await import('./pipeline');
    const { handleEscalation } = await import('./pipeline');

    // Read the current round + the previous round's screen targets.
    const ctx = readJSON(join(TASKS_DIR, task.id, 'context.json')) || {};
    const round: number = ctx.design?.round ?? 1;
    const screensToRender: string[] | undefined = ctx.design?.screens_to_render;

    logEvent(task.id, 'system', 'wireframes_render_start',
      `Rendering wireframes for round ${round}${screensToRender ? ` (subset: ${screensToRender.length})` : ' (all screens)'}`);

    const result = await renderWireframes(task.id, round, screensToRender);

    if (result.failed.length > 0) {
      logEvent(task.id, 'system', 'wireframes_render_partial',
        `${result.rendered.length} ok, ${result.failed.length} failed: ${result.failed.map(f => f.id).join(', ')}`);
    } else {
      logEvent(task.id, 'system', 'wireframes_render_done',
        `Rendered ${result.rendered.length} screen(s) for round ${round}`);
    }

    if (result.rendered.length === 0 && result.failed.length > 0) {
      // Total failure — escalate so the human can investigate (likely missing
      // index.json or all HTML files broken). No partial success to surface.
      await handleEscalation(task, {
        status: 'failed',
        output: `Wireframe rendering failed for all screens: ${result.failed.map(f => `${f.id}: ${f.reason}`).join(' | ')}`,
        durationMs: 0,
        exitCode: 1,
      }, 'Wireframe rendering produced no output. Inspect tasks/<id>/wireframes/ for missing or broken files.');
      return;
    }

    // Clear the per-rework screen subset so a future re-entry without explicit
    // targeting doesn't accidentally render only this round's subset again.
    if (screensToRender) {
      ctx.design = { ...(ctx.design || {}), screens_to_render: undefined };
      writeFileSync(join(TASKS_DIR, task.id, 'context.json'), JSON.stringify(ctx, null, 2));
    }

    await updateStatus(task.id, 'design_validation');
  } finally {
    wireframeRendersInProgress.delete(task.id);
  }
}

/**
 * Best-effort screen count from the wireframes index, used in the synthesized
 * escalation question. On any error returns 0 — the escalation message is
 * still informative ("0 screens" → operator notices something is off).
 */
function countScreensInIndex(taskId: string, round: number): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const indexPath = join(TASKS_DIR, taskId, 'wireframes', 'index.json');
    if (!existsSync(indexPath)) return 0;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const all = Array.isArray(idx?.screens) ? idx.screens : [];
    if (round === 1) return all.length;
    // Rework round: count only screens re-rendered this round.
    return all.filter((s: any) => s?.lastRenderedRound === round).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Stage: design_validation — PM checks wireframes against requirements
// ---------------------------------------------------------------------------

export async function runDesignValidation(task: Task): Promise<void> {
  if (!canRunAgent('claude-sonnet-4-6', 'S')) return;

  // Track validation rounds in context.json#design.validation_round. Hard
  // cap at 2 PM revisions to prevent ping-pong with the designer; on the
  // 3rd entry we force-promote even if PM still has open notes (those go
  // into open_pm_notes and surface in the human-approval caption).
  //
  // The round counter is bumped only AFTER a successful agent run (below)
  // so a failed/retried session doesn't burn a round prematurely. We
  // compute `currentRound` here (what THIS attempt is), but only persist
  // it once the run succeeds.
  const ctxPath = join(TASKS_DIR, task.id, 'context.json');
  const ctx = readJSON(ctxPath) || {};
  const priorRound: number = ctx.design?.validation_round ?? 0;
  const currentRound: number = priorRound + 1;

  const escalation = db.prepare(
    "SELECT answer FROM escalations WHERE task_id = ? AND status = 'answered' ORDER BY answered_at DESC LIMIT 1"
  ).get(task.id) as { answer: string } | undefined;
  const isResume = !!escalation?.answer;
  const basePrompt = [
    'You are validating the designer\'s wireframes against the functional requirements you wrote earlier.',
    'Read tasks/' + task.id + '/wireframes/index.json + the rendered PNGs (paths in each entry\'s mediaUrls or under wireframes/round-' + (ctx.design?.round ?? 1) + '/).',
    'Cross-reference against context.json#research.summary, context.json#design_brief.successCriteria, and the original task description.',
    `Current validation_round: ${currentRound} (cap: 2). On round 2+ you cannot loop again — set handoff: "approved" and list still-open items under open_pm_notes.`,
    'Write the verdict to context.json#design (handoff, missing_requirements, open_pm_notes). If revising, also write tasks/' + task.id + '/validation-feedback.md per the format in your prompt.',
  ].join('\n');

  const extraContext = isResume
    ? `${basePrompt}\n\nHUMAN ANSWER TO YOUR QUESTION(S):\n${escalation.answer}\n\nContinue your validation with this information. The questions.md file has been cleared since they are now answered. Only create a new questions.md if you have GENUINELY NEW questions.`
    : basePrompt;

  if (isResume) {
    const questionsPath = join(TASKS_DIR, task.id, 'questions.md');
    if (fileExists(questionsPath)) {
      try { rmSync(questionsPath); } catch {}
    }
  }

  const result = await runAgentWithRetry({
    agent: 'pm',
    taskId: task.id,
    model: 'claude-sonnet-4-6',
    tools: ['Read', 'Write'],
    resume: isResume,
    extraPromptContext: extraContext,
    cwd: TARGET_REPO_PATH,
    enableStreaming: true,
  }, 3);

  if (isResume && result.status !== 'questions_pending' && result.status !== 'escalate') {
    consumeAnsweredEscalations(task.id);
  }

  const { updateStatus, handleAgentResult } = await import('./pipeline');

  if (result.status !== 'complete') {
    await handleAgentResult(task, result);
    return;
  }

  // Successful run — now persist the round bump alongside whatever the
  // agent wrote to context.json.
  const ctxAfter = readJSON(ctxPath) || {};
  ctxAfter.design = { ...(ctxAfter.design || {}), validation_round: currentRound };
  writeFileSync(ctxPath, JSON.stringify(ctxAfter, null, 2));
  const handoff: string | undefined = ctxAfter.design?.handoff;

  // Force-approve on round 2+ even if PM said revise — open notes get
  // carried into the human-gate caption and the dev handoff.
  const forceApprove = currentRound >= 2;
  const approved = handoff === 'approved' || forceApprove;

  if (approved) {
    if (handoff === 'revise' && forceApprove) {
      logEvent(task.id, 'pm', 'design_force_approved',
        `Round ${currentRound} hit cap; force-approving with open notes for human review`);
      ctxAfter.design.handoff = 'approved';
      writeFileSync(ctxPath, JSON.stringify(ctxAfter, null, 2));
    } else {
      logEvent(task.id, 'pm', 'design_validated', 'Wireframes validated against requirements');
    }
    // Hand off to the human approval gate. notifyDesignApproval reads the
    // index, picks the screens to show this round, and sends them via the
    // chat provider with caption + PM open notes. The operator's reply
    // routes through /design_reply (parsed by Haiku) and either ships to
    // dev or kicks rework.
    //
    // Synthesize an escalation row so the dashboard's existing escalation
    // surfaces (top-of-page banner, awaiting-human count, PixelOffice
    // waiting lounge) pick this up for free. The row is dismissed
    // automatically when the task transitions out of awaiting_design_approval
    // (see updateStatus's dismiss-on-leave guard).
    const screenCount = countScreensInIndex(task.id, ctxAfter.design?.round ?? 1);
    const openNotes: string[] = ctxAfter.design?.open_pm_notes || [];
    const screenNoun = screenCount === 1 ? 'screen' : 'screens';
    const notesSuffix = openNotes.length > 0 ? ` PM still flags: ${openNotes.join('; ')}` : '';
    createEscalation(
      task.id,
      `Design proofs ready for approval — ${screenCount} ${screenNoun}. Reply "approved" to ship to dev, or describe changes.${notesSuffix}`,
    );

    const { notifyDesignApproval } = await import('./design-notify');
    await updateStatus(task.id, 'awaiting_design_approval');
    await notifyDesignApproval(task);
    return;
  }

  // handoff === 'revise' AND under cap → loop back to designer with feedback.
  // We do NOT bump design.round here — that counter reflects the human-
  // rework round and only increments when the human asks for changes.
  // Within the current human-round, PM-driven revisions overwrite the same
  // round-N/ paths since the renderer uses upsert + per-screen version
  // tracking to skip untouched screens.
  logEvent(task.id, 'pm', 'design_revision_requested',
    `Round ${currentRound}: ${(ctxAfter.design?.missing_requirements || []).join('; ') || 'see validation-feedback.md'}`);
  await updateStatus(task.id, 'design_pending');
}
