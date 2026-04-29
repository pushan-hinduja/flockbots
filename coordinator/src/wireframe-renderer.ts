/**
 * Wireframe renderer — drives Playwright against the designer agent's HTML
 * wireframes, screenshots them at the requested viewports, and uploads the
 * PNGs to Supabase storage so they can be sent to the human for approval.
 *
 * Lifecycle:
 *   1. Designer writes `tasks/<id>/wireframes/<screen>.html` files plus
 *      `tasks/<id>/wireframes/index.json` (the screen list).
 *   2. Coordinator calls `renderWireframes(taskId, round)`.
 *   3. We read the index, render each screen at every requested viewport,
 *      save PNGs locally + upload to Supabase, then update the index in
 *      place with `lastRenderedRound` + per-viewport `mediaUrl`.
 *
 * On rework (round 2+), pass `screensToRender` to skip untouched screens.
 *
 * No Supabase = no upload. Local PNGs still get written so the dev/QA
 * agents have a visual reference, and the chat-send step in PR 3 will
 * degrade to text-only when mediaUrls are null.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { chromium, type Browser } from 'playwright';
import { flockbotsHome } from './paths';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type Viewport = 'desktop' | 'mobile';

export const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile:  { width: 390,  height: 844 },
};

export interface WireframeScreen {
  /** Stable identifier — used for filenames + chat numbering. e.g. "01-empty". */
  id: string;
  /** Short title for the chat caption. e.g. "Login (empty)". */
  title: string;
  /** One-line intent for PM/QA matching. */
  description: string;
  /** Relative path from the task's wireframes/ dir. e.g. "01-empty.html". */
  file: string;
  /** Defaults to ['desktop']. */
  viewports?: Viewport[];
  /** Bumped by the designer whenever it edits this screen. Drives partial re-render. */
  version: number;
  /** Render bookkeeping — coordinator-managed, not designer-managed. */
  lastRenderedAt?: number;
  lastRenderedRound?: number;
  /** The screen.version captured at last render — drives "skip if unchanged" detection. */
  lastRenderedVersion?: number;
  /** Per-viewport signed URLs from Supabase. Null when render failed or Supabase absent. */
  mediaUrls?: Partial<Record<Viewport, string | null>>;
}

export interface WireframeIndex {
  /** Schema version. Currently 1. */
  version: number;
  /** Ordered list — first entry is screen #1 in the chat caption. */
  screens: WireframeScreen[];
}

export interface RenderResult {
  index: WireframeIndex;
  rendered: string[];
  failed: { id: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

function indexPath(taskId: string): string {
  return join(flockbotsHome(), 'tasks', taskId, 'wireframes', 'index.json');
}

function wireframesDir(taskId: string): string {
  return join(flockbotsHome(), 'tasks', taskId, 'wireframes');
}

export function loadIndex(taskId: string): WireframeIndex | null {
  const p = indexPath(taskId);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as WireframeIndex;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.screens)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveIndex(taskId: string, index: WireframeIndex): void {
  const p = indexPath(taskId);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(index, null, 2));
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render screens to local PNGs and upload to Supabase. Returns the updated
 * index plus per-screen success/failure. Never throws on a single screen
 * failure — failures are reported in the result so partial rounds can still
 * proceed (chat-send step decides whether to surface partial results).
 *
 * @param taskId         Parent task ID.
 * @param round          Current rework round (1 = initial, 2+ = revisions).
 * @param screensToRender Optional whitelist of screen IDs. Omit to render every
 *                       screen whose `version` differs from `lastRenderedAt`'s
 *                       version-at-render-time, or all screens on round 1.
 */
export async function renderWireframes(
  taskId: string,
  round: number,
  screensToRender?: string[],
): Promise<RenderResult> {
  const index = loadIndex(taskId);
  if (!index) {
    return {
      index: { version: 1, screens: [] },
      rendered: [],
      failed: [{ id: '*', reason: 'index.json missing or invalid' }],
    };
  }

  // Decide which screens this round actually touches.
  const targets: WireframeScreen[] = screensToRender
    ? index.screens.filter(s => screensToRender.includes(s.id))
    : round === 1
      ? index.screens
      : index.screens.filter(needsRerender);

  if (targets.length === 0) {
    return { index, rendered: [], failed: [] };
  }

  // One browser, reused across screens + viewports for speed.
  let browser: Browser | null = null;
  const rendered: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  try {
    browser = await chromium.launch({ headless: true });

    for (const screen of targets) {
      const viewports: Viewport[] = screen.viewports?.length ? screen.viewports : ['desktop'];
      const screenResult: Partial<Record<Viewport, string | null>> = { ...(screen.mediaUrls || {}) };
      let anyFailed = false;

      for (const vp of viewports) {
        try {
          const localPath = await renderOne(browser, taskId, round, screen, vp);
          const uploadedUrl = await uploadWireframeMedia(taskId, round, screen.id, vp, localPath);
          screenResult[vp] = uploadedUrl; // null if Supabase not configured
        } catch (err: any) {
          anyFailed = true;
          failed.push({ id: `${screen.id}:${vp}`, reason: err?.message || String(err) });
          screenResult[vp] = null;
        }
      }

      // Update bookkeeping even on partial failure — the index is the source
      // of truth for what's been attempted this round.
      screen.lastRenderedAt = Date.now();
      screen.lastRenderedRound = round;
      screen.lastRenderedVersion = screen.version;
      screen.mediaUrls = screenResult;

      if (!anyFailed) rendered.push(screen.id);
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* best effort */ }
    }
  }

  saveIndex(taskId, index);
  return { index, rendered, failed };
}

/**
 * A screen needs a re-render iff its current `version` is ahead of the
 * version we last captured. Designer bumps `version` only on actual edits,
 * so untouched screens skip render. Used as the fallback selector when the
 * caller doesn't pass `screensToRender` explicitly.
 */
function needsRerender(screen: WireframeScreen): boolean {
  return screen.version > (screen.lastRenderedVersion ?? -1);
}

async function renderOne(
  browser: Browser,
  taskId: string,
  round: number,
  screen: WireframeScreen,
  viewport: Viewport,
): Promise<string> {
  const htmlPath = isAbsolute(screen.file)
    ? screen.file
    : join(wireframesDir(taskId), screen.file);

  if (!existsSync(htmlPath)) {
    throw new Error(`HTML not found at ${htmlPath}`);
  }

  const size = VIEWPORT_SIZES[viewport];
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2 });
  const page = await context.newPage();

  try {
    // `load` event = HTML + subresources fetched. More reliable than
    // `networkidle` for static wireframes (no XHR / SSE traffic to settle).
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 15_000 });
    // Wait for any web fonts referenced via @font-face to finish loading
    // before the screenshot — otherwise the first-paint baseline can render
    // in a fallback font and re-flow as fonts arrive. Replaces the prior
    // arbitrary 250ms sleep, which was both slower and less reliable.
    await page.evaluate(() => (document as any).fonts?.ready ?? Promise.resolve());

    const outDir = join(flockbotsHome(), 'tasks', taskId, 'wireframes', `round-${round}`);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${screen.id}-${viewport}.png`);
    await page.screenshot({ path: outPath, fullPage: true });
    return outPath;
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Supabase upload
// ---------------------------------------------------------------------------

/**
 * Upload a rendered PNG to the wireframes bucket and return a 7-day signed
 * URL. Returns null when Supabase isn't configured or FLOCKBOTS_INSTANCE_ID
 * is missing — the local PNG is still on disk for dev/QA agents to read.
 *
 * Thin wrapper around the shared `uploadTaskMedia` helper; this function
 * just builds the bucket / key for the wireframes namespace.
 */
async function uploadWireframeMedia(
  taskId: string,
  round: number,
  screenId: string,
  viewport: Viewport,
  localPath: string,
): Promise<string | null> {
  const inst = process.env.FLOCKBOTS_INSTANCE_ID;
  if (!inst) return null;

  const { uploadTaskMedia } = await import('./task-media-upload');
  return uploadTaskMedia({
    bucket: process.env.SUPABASE_STORAGE_BUCKET_WIREFRAMES || 'wireframes',
    key: `${inst}/${taskId}/round-${round}/${screenId}-${viewport}.png`,
    buffer: readFileSync(localPath),
    contentType: 'image/png',
    upsert: true, // Same screen + round + viewport overwrites — safe within a round.
  });
}
