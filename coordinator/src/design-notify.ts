/**
 * Design-approval notification: sends rendered wireframe proofs to the
 * operator via the configured chat provider, with a caption telling them
 * how to approve or revise.
 *
 * On the initial round, every screen in the index is sent. On rework
 * rounds, only the screens that were re-rendered this round are sent —
 * unchanged screens stay approved from the prior round, no need to
 * re-spam them.
 */

import { readJSON } from './session-manager';
import { join } from 'path';
import { tasksDir } from './paths';
import type { Task } from './queue';
import { logEvent } from './queue';
import { notifyOperator, notifyOperatorMedia } from './notifier';
import type { WireframeIndex, WireframeScreen, Viewport } from './wireframe-renderer';

/**
 * Send the rendered proofs for `task` to the operator. Reads the round
 * number and PM open notes from context.json#design.
 *
 * Behavior:
 * - Round 1 → send every screen.
 * - Round 2+ → send only screens with lastRenderedRound === current round.
 * - Each screen contributes one media message per viewport in its
 *   index entry (typically just desktop).
 * - PM open notes (if present after a force-approved validation) are
 *   appended to the caption.
 */
export async function notifyDesignApproval(task: Task): Promise<void> {
  const taskDir = join(tasksDir(), task.id);
  const ctx = readJSON(join(taskDir, 'context.json')) || {};
  const round: number = ctx.design?.round ?? 1;
  const openNotes: string[] = ctx.design?.open_pm_notes || [];
  const indexPath = join(taskDir, 'wireframes', 'index.json');
  const index = readJSON(indexPath) as WireframeIndex | null;

  if (!index || !index.screens?.length) {
    logEvent(task.id, 'notifier', 'design_notify_skipped', 'no wireframes/index.json or empty screens');
    return;
  }

  // Pick the screens to surface this round.
  const toShow: WireframeScreen[] = index.screens.filter(s =>
    round === 1 ? true : s.lastRenderedRound === round
  );

  if (toShow.length === 0) {
    logEvent(task.id, 'notifier', 'design_notify_skipped',
      `round ${round}: no screens flagged as re-rendered — nothing to surface`);
    return;
  }

  const taskTitle = readTaskTitle(task);
  const caption = buildCaption(taskTitle, toShow, round, openNotes);

  // Send the caption as text first so the operator sees the framing before
  // the image sequence — one big text + N small images is easier to scan
  // than N captioned images.
  await notifyOperator(caption);

  // One media message per (screen × viewport). Skip screens with no
  // mediaUrls (Supabase not configured or upload failed) and fall back
  // to a text-only listing for those.
  const textOnly: string[] = [];
  for (let i = 0; i < toShow.length; i++) {
    const screen = toShow[i];
    const viewports: Viewport[] = screen.viewports?.length ? screen.viewports : ['desktop'];
    let anySent = false;
    for (const vp of viewports) {
      const url = screen.mediaUrls?.[vp];
      if (!url) continue;
      const screenCaption = `${i + 1}. ${screen.title}${viewports.length > 1 ? ` — ${vp}` : ''}`;
      await notifyOperatorMedia(screenCaption, url, 'image');
      anySent = true;
    }
    if (!anySent) {
      textOnly.push(`${i + 1}. ${screen.title} — render unavailable (configure Supabase to receive proofs in chat)`);
    }
  }

  if (textOnly.length > 0) {
    await notifyOperator(textOnly.join('\n'));
  }

  logEvent(task.id, 'notifier', 'design_notify_sent',
    `Round ${round}: sent ${toShow.length} screen(s) with ${openNotes.length} PM note(s)`);
}

function readTaskTitle(task: Task): string {
  // Prefer the PM-distilled title from context; fall back to the raw task
  // title if context.json is missing or doesn't have one.
  try {
    const ctx = readJSON(join(tasksDir(), task.id, 'context.json'));
    const t = ctx?.research?.title;
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch { /* fall through */ }
  return task.title || `task ${task.id}`;
}

function buildCaption(
  taskTitle: string,
  screens: WireframeScreen[],
  round: number,
  openNotes: string[],
): string {
  const lines: string[] = [];

  const header = round === 1
    ? `📐 Design proofs for "${taskTitle}" — ${screens.length} screen${screens.length === 1 ? '' : 's'}`
    : `📐 Round ${round} — ${screens.length} updated screen${screens.length === 1 ? '' : 's'} for "${taskTitle}"`;
  lines.push(header);
  lines.push('');

  // Numbered screen list so the operator can reference by number.
  for (let i = 0; i < screens.length; i++) {
    const s = screens[i];
    lines.push(`  ${i + 1}. ${s.title}${s.description ? `  —  ${s.description}` : ''}`);
  }
  lines.push('');
  lines.push('Reply "approved" to ship to dev, or describe changes');
  lines.push('(you can reference specific screens by number).');

  if (openNotes.length > 0) {
    lines.push('');
    lines.push(`⚠️ PM still flags: ${openNotes.join('; ')}`);
  }

  return lines.join('\n');
}
