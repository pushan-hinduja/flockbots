/**
 * Handle the operator's reply to a design-approval message. Wraps the Haiku
 * parser + state-machine routing so command handlers (and downstream chat
 * routers) only need to call one function.
 *
 * Routing matrix:
 *   approved       → status = dev_ready, log success, clean up feedback file
 *   revise (any)   → write design-feedback.md, bump design.round, set
 *                    design.screens_to_render to the affected ids (or
 *                    undefined when "all" feedback was given), reset
 *                    validation_round, status = design_pending
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { db, Task, logEvent } from './queue';
import { tasksDir } from './paths';
import { syncToSupabase } from './supabase-sync';
import { parseDesignFeedback, feedbackToMarkdown, affectedScreenIds } from './design-feedback-parser';
import type { WireframeIndex } from './wireframe-renderer';

export interface DesignReplyResult {
  outcome: 'approved' | 'revising' | 'error';
  message: string;
}

export async function handleDesignReply(task: Task, reply: string): Promise<DesignReplyResult> {
  if (task.status !== 'awaiting_design_approval') {
    return {
      outcome: 'error',
      message: `Task ${task.id} is not awaiting design approval (status: ${task.status})`,
    };
  }

  const taskDir = join(tasksDir(), task.id);
  const indexPath = join(taskDir, 'wireframes', 'index.json');
  if (!existsSync(indexPath)) {
    return { outcome: 'error', message: `wireframes/index.json missing for task ${task.id}` };
  }

  let index: WireframeIndex;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf-8')) as WireframeIndex;
  } catch (err: any) {
    return { outcome: 'error', message: `wireframes/index.json failed to parse: ${err.message}` };
  }
  if (!index.screens?.length) {
    return { outcome: 'error', message: `wireframes/index.json has no screens` };
  }

  const screenContext = index.screens.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
  }));

  const verdict = await parseDesignFeedback(reply, screenContext);

  if (verdict.approved) {
    // Clean up any leftover feedback file from prior rounds so the next
    // designer run (on a future task or rework cycle) doesn't see stale
    // feedback.
    const feedbackPath = join(taskDir, 'design-feedback.md');
    if (existsSync(feedbackPath)) {
      try { rmSync(feedbackPath); } catch { /* best effort */ }
    }

    db.prepare("UPDATE tasks SET status = 'dev_ready', updated_at = ? WHERE id = ?")
      .run(Date.now(), task.id);
    logEvent(task.id, 'human', 'design_approved', 'Design approved by operator');
    await syncToSupabase('task_update', { id: task.id, status: 'dev_ready' });
    return {
      outcome: 'approved',
      message: `Design approved for task ${task.id}. Routing to dev.`,
    };
  }

  // Rework path.
  const feedbackMd = feedbackToMarkdown(verdict);
  const feedbackPath = join(taskDir, 'design-feedback.md');
  writeFileSync(feedbackPath, feedbackMd);

  const targetIds = affectedScreenIds(verdict);
  // affectedScreenIds returns null only when approved (handled above), so
  // here it's always [] or a non-empty list:
  //   []           → "all" feedback; renderer falls through to its
  //                  version-bump detection on the designer's next pass.
  //   non-empty    → narrow the re-render to exactly those screen ids.
  const renderTargets = targetIds ?? [];
  const ctxPath = join(taskDir, 'context.json');
  let ctx: any = {};
  if (existsSync(ctxPath)) {
    try { ctx = JSON.parse(readFileSync(ctxPath, 'utf-8')); } catch { /* ignore */ }
  }
  const prevRound: number = ctx.design?.round ?? 1;
  ctx.design = {
    ...(ctx.design || {}),
    round: prevRound + 1,
    screens_to_render: renderTargets.length > 0 ? renderTargets : undefined,
    // Reset PM validation counter so the designer + PM get a fresh 2-round
    // budget after the human's feedback. Otherwise a task that pinged PM
    // twice on round 1 would skip PM validation entirely on round 2.
    validation_round: 0,
    // Clear PM open notes from the prior round — they were the PM's view
    // BEFORE the human saw the proofs. The human has now decided; whatever
    // they want next is captured in design-feedback.md, and the next PM
    // validation pass will produce its own fresh notes if needed.
    open_pm_notes: undefined,
  };
  writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));

  db.prepare("UPDATE tasks SET status = 'design_pending', updated_at = ? WHERE id = ?")
    .run(Date.now(), task.id);
  logEvent(task.id, 'human', 'design_revision_requested',
    `Round ${prevRound + 1}: ${renderTargets.length > 0 ? `screens ${renderTargets.join(', ')}` : 'global feedback'}`);
  await syncToSupabase('task_update', { id: task.id, status: 'design_pending' });

  const summary = renderTargets.length > 0
    ? `Routing back to designer for round ${prevRound + 1} — revising ${renderTargets.length} screen${renderTargets.length === 1 ? '' : 's'}.`
    : `Routing back to designer for round ${prevRound + 1} — global revisions.`;

  return { outcome: 'revising', message: summary };
}
