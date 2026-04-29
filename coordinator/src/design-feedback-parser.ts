/**
 * Haiku-driven parser for human design-approval replies.
 *
 * Input: a free-form text reply from the operator + the screen list from
 * wireframes/index.json (id, title, description for context).
 *
 * Output: a structured verdict —
 *   { approved: true }
 *   { approved: false, feedback: { "01-empty": "...", "all": "..." } }
 *
 * Why Haiku: this is a one-shot classification + extraction job that gets
 * called every time the human responds to a proof. Sonnet would work but
 * is overkill for the cost; Haiku at ~$0.0001/call lets us run this on
 * every rework round without thinking about it.
 *
 * Failure mode: if Haiku times out or returns malformed JSON, treat the
 * reply as rework feedback addressed to "all" — defaults to safety
 * (keep designing) rather than promoting work the human didn't approve.
 */

import { spawn } from 'child_process';

const PARSER_MODEL = process.env.DESIGN_PARSER_MODEL || 'claude-haiku-4-5';
const PARSER_TIMEOUT_MS = 30_000;

export interface ScreenContext {
  id: string;
  title: string;
  description: string;
}

export interface DesignFeedbackVerdict {
  approved: boolean;
  /** Per-screen-id feedback. The "all" key targets every screen. */
  feedback?: Record<string, string>;
}

export async function parseDesignFeedback(
  rawReply: string,
  screens: ScreenContext[],
): Promise<DesignFeedbackVerdict> {
  const trimmed = rawReply.trim();
  if (!trimmed) {
    return { approved: false, feedback: { all: '(operator sent an empty reply)' } };
  }

  const prompt = buildPrompt(trimmed, screens);

  try {
    const raw = await spawnHaiku(prompt, PARSER_MODEL);
    return parseVerdict(raw, screens);
  } catch (err: any) {
    console.error('Design feedback parser failed:', err.message);
    // Fail safe: treat as rework feedback, do NOT auto-approve. Carry the
    // full original reply forward as "all" feedback so the designer still
    // sees what the human wrote.
    return { approved: false, feedback: { all: trimmed } };
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(reply: string, screens: ScreenContext[]): string {
  const screenList = screens
    .map((s, i) => `  ${i + 1}. id="${s.id}" — ${s.title}${s.description ? ` (${s.description})` : ''}`)
    .join('\n');

  return [
    'You parse a single operator reply to a design-approval message.',
    'The operator was shown N screen wireframes and asked to either approve or describe changes.',
    '',
    'SCREENS THE OPERATOR SAW:',
    screenList,
    '',
    'OPERATOR REPLY:',
    reply,
    '',
    'OUTPUT — raw JSON, no markdown fences, no prose:',
    '{',
    '  "approved": true   // operator approved with no caveats',
    '}',
    'OR',
    '{',
    '  "approved": false,',
    '  "feedback": {',
    '    "<screen-id>": "specific feedback for that screen",',
    '    "all": "global feedback applying to every screen, optional"',
    '  }',
    '}',
    '',
    'RULES:',
    '1. approved=true ONLY when the operator clearly accepts the design',
    '   (e.g. "approved", "yes ship it", "looks good", "lgtm", "go ahead").',
    '   Mixed signals like "looks good but tweak X" are NOT approval —',
    '   route the tweak as feedback.',
    '2. Map feedback to the screen-id strings exactly as listed above.',
    '   The operator may reference screens by number (1, 2, …) or by title;',
    '   resolve to the canonical id.',
    '3. If feedback applies to every screen or no specific screen is named,',
    '   put it under "all".',
    '4. If the operator gives feedback on only some screens, only include',
    '   those screen-ids — do NOT include screens they didn\'t mention.',
    '5. Never invent screen-ids that aren\'t in the list.',
    '6. Output JSON only. No code fences. No prose before or after.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Spawn + parse (mirrors the WhatsApp router pattern in whatsapp/router.ts)
// ---------------------------------------------------------------------------

function spawnHaiku(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', model,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--max-turns', '1',
      '--strict-mcp-config',
    ];

    const proc = spawn('claude', args, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new Error('design parser timeout'));
    }, PARSER_TIMEOUT_MS);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`));
      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();
  });
}

function parseVerdict(rawStdout: string, screens: ScreenContext[]): DesignFeedbackVerdict {
  const envelope = JSON.parse(rawStdout);
  let resultText: string = envelope.result ?? '';

  // Strip ```json fences if the model added them despite instructions.
  const fenced = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) resultText = fenced[1];

  // Extract outermost JSON object if there's surrounding prose.
  const firstBrace = resultText.indexOf('{');
  const lastBrace = resultText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    resultText = resultText.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(resultText);

  if (parsed?.approved === true) {
    return { approved: true };
  }

  // Sanitize feedback: drop any keys that don't map to a real screen-id
  // (or "all"). Defends against hallucinated ids.
  const validIds = new Set(screens.map(s => s.id));
  const feedback: Record<string, string> = {};
  if (parsed?.feedback && typeof parsed.feedback === 'object') {
    for (const [key, value] of Object.entries(parsed.feedback as Record<string, unknown>)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      if (key === 'all' || validIds.has(key)) {
        feedback[key] = value.trim();
      }
    }
  }

  // If parsing succeeded but no feedback survived, fall back to "all" with
  // the trimmed input — better to show the designer what was said than
  // silently drop it.
  if (Object.keys(feedback).length === 0) {
    return { approved: false, feedback: { all: '(no parseable feedback — designer should reread the original reply)' } };
  }

  return { approved: false, feedback };
}

/**
 * Render the parsed feedback as a markdown file the designer can read on
 * its next session. Mirrors the validation-feedback.md format so the
 * designer prompt's "read design-feedback.md" path handles both human
 * and PM revisions identically.
 */
export function feedbackToMarkdown(verdict: DesignFeedbackVerdict): string {
  if (verdict.approved || !verdict.feedback) return '';

  const lines: string[] = [];
  // Per-screen blocks first (excluding "all"), then "all" at the end.
  const entries = Object.entries(verdict.feedback);
  const perScreen = entries.filter(([k]) => k !== 'all');
  const allEntry = entries.find(([k]) => k === 'all');

  for (const [screenId, feedback] of perScreen) {
    lines.push(`## ${screenId}`);
    lines.push('');
    lines.push(feedback);
    lines.push('');
  }
  if (allEntry) {
    lines.push('## all');
    lines.push('');
    lines.push(allEntry[1]);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Which screen ids should be re-rendered next round.
 *
 * Returns:
 *   - `null`      → operator approved, no rework needed.
 *   - `[]`        → "all" feedback was given (every screen the designer
 *                   bumps gets re-rendered; no explicit targeting).
 *   - `["id", …]` → exactly these screen ids should be re-rendered.
 *
 * The null/[] distinction matters at call sites that need to branch on
 * "no rework at all" vs "rework everything" — they're different paths.
 */
export function affectedScreenIds(verdict: DesignFeedbackVerdict): string[] | null {
  if (verdict.approved || !verdict.feedback) return null;
  const keys = Object.keys(verdict.feedback);
  // "all" implies every screen is affected — return [] (renderer interprets
  // empty list as "render every screen whose version was bumped").
  if (keys.includes('all')) return [];
  return keys;
}
