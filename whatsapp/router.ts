import { spawn } from 'child_process';
import {
  db,
  getPendingEscalations,
  getPendingConfirmation,
  setPendingConfirmation,
  clearPendingConfirmation,
  getRecentConversation,
  ConversationMessage,
} from '../coordinator/src/queue';
import { handleWhatsAppMessage } from './commands';

const ROUTER_MODEL = process.env.WHATSAPP_ROUTER_MODEL || 'claude-haiku-4-5';
const ROUTER_FALLBACK_MODEL = 'claude-sonnet-4-6';
const ROUTER_TIMEOUT_MS = 30_000;
const RECENT_MESSAGE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours
// Larger limit than inbound-only because the log now includes bot replies + pipeline
// notifications. ~10 messages covers ~5 back-and-forth exchanges or the last few
// task notifications, without drowning the prompt.
const RECENT_MESSAGE_LIMIT = 10;
// Trim per-message text to keep the prompt compact — bot pipeline notifications
// can be multi-line; we just need the gist for reference resolution.
const MESSAGE_TEXT_CAP = 240;

// Commands that change state or spend money — router must ask before running.
const DESTRUCTIVE_COMMANDS = new Set(['/deploy', '/rollback', '/dismiss', '/retry', '/effort', '/model']);

// Affirmative / negative matchers for confirming a pending destructive action.
// Scoped: only consulted when a pending confirmation exists.
const YES_PATTERN = /^(y|yes|yep|yeah|yup|ok|okay|sure|do it|go|confirm|approved?)$/i;
const NO_PATTERN = /^(n|no|nope|nah|cancel|stop|abort|nevermind|never mind)$/i;

interface RouterDecision {
  command: string | null;
  reply: string;
  needs_confirmation: boolean;
  confirmation_action: string | null;
}

/**
 * Top-level WhatsApp message handler.
 * Pipeline:
 *   1. `/command` prefix     → existing command parser (muscle memory preserved)
 *   2. Pending confirmation  → match yes/no and execute or abort
 *   3. Natural language      → Claude Haiku router → command + natural reply
 */
export async function routeMessage(from: string, text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Fast-path 1: explicit slash command — bypass the LLM entirely.
  if (trimmed.startsWith('/')) {
    return handleWhatsAppMessage(from, trimmed);
  }

  // Fast-path 2: resolve a pending confirmation with a bare yes/no.
  const pending = getPendingConfirmation();
  if (pending) {
    if (YES_PATTERN.test(trimmed)) {
      clearPendingConfirmation();
      const result = await handleWhatsAppMessage(from, pending.command);
      return result ?? `Done: ${pending.command}`;
    }
    if (NO_PATTERN.test(trimmed)) {
      clearPendingConfirmation();
      return `Cancelled. Let me know what you'd like to do instead.`;
    }
    // Anything else with a pending confirmation falls through to the LLM —
    // the operator may be clarifying or switching intent entirely.
  }

  // Main path: LLM routing.
  try {
    const decision = await callRouter(from, trimmed, pending);
    return await applyDecision(from, decision);
  } catch (err: any) {
    console.error('WhatsApp router error:', err.message);
    return `Sorry — I didn't catch that. Try /help for a list of commands.`;
  }
}

async function applyDecision(from: string, decision: RouterDecision): Promise<string | null> {
  // Destructive intent → park it, ask for confirmation.
  if (decision.needs_confirmation && decision.confirmation_action) {
    setPendingConfirmation(decision.confirmation_action, decision.reply);
    return decision.reply;
  }

  // Chat-only response.
  if (!decision.command) {
    return decision.reply;
  }

  // Execute the mapped command and combine the LLM's framing with the raw output.
  const cmdResult = await handleWhatsAppMessage(from, decision.command);
  if (cmdResult === null) {
    // Unknown command fell through the switch — hand back the LLM's reply alone.
    return decision.reply;
  }
  if (!decision.reply.trim()) return cmdResult;
  return `${decision.reply}\n\n${cmdResult}`;
}

// ──────────────────────────────── LLM call ────────────────────────────────

async function callRouter(
  from: string,
  text: string,
  pending: ReturnType<typeof getPendingConfirmation>,
): Promise<RouterDecision> {
  const prompt = await buildPrompt(from, text, pending);

  try {
    const raw = await spawnClaudeRouter(prompt, ROUTER_MODEL);
    return parseDecision(raw);
  } catch (err: any) {
    if (ROUTER_MODEL !== ROUTER_FALLBACK_MODEL) {
      console.warn(`Router model ${ROUTER_MODEL} failed (${err.message}), retrying with ${ROUTER_FALLBACK_MODEL}`);
      const raw = await spawnClaudeRouter(prompt, ROUTER_FALLBACK_MODEL);
      return parseDecision(raw);
    }
    throw err;
  }
}

function spawnClaudeRouter(prompt: string, model: string): Promise<string> {
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
      reject(new Error('router timeout'));
    }, ROUTER_TIMEOUT_MS);

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

function parseDecision(rawStdout: string): RouterDecision {
  // `claude -p --output-format json` returns an envelope; the model's text is in `.result`.
  const envelope = JSON.parse(rawStdout);
  let resultText: string = envelope.result ?? '';

  // Strip ```json fences if the model emitted them despite instructions.
  const fenced = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) resultText = fenced[1];

  // If there's leading/trailing prose, extract the outermost JSON object.
  const firstBrace = resultText.indexOf('{');
  const lastBrace = resultText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    resultText = resultText.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(resultText);
  const command = typeof parsed.command === 'string' && parsed.command.trim()
    ? parsed.command.trim()
    : null;
  const needsConfirmation = !!parsed.needs_confirmation;
  const confirmationAction = typeof parsed.confirmation_action === 'string'
    ? parsed.confirmation_action.trim()
    : null;

  return {
    command: needsConfirmation ? null : command,
    reply: typeof parsed.reply === 'string' ? parsed.reply : '',
    needs_confirmation: needsConfirmation,
    confirmation_action: needsConfirmation ? confirmationAction : null,
  };
}

// ────────────────────────────── Prompt build ──────────────────────────────

async function buildPrompt(
  _from: string,
  text: string,
  pending: ReturnType<typeof getPendingConfirmation>,
): Promise<string> {
  const state = await buildStructuredState(pending);
  const recent = formatRecentConversation();

  // Static instructions first so the CLI's prompt cache can hit across calls.
  return [
    INSTRUCTIONS,
    '',
    '=== CURRENT STATE ===',
    state,
    '',
    '=== RECENT CONVERSATION (older → newer, "user:" = operator, "bot:" = system/you) ===',
    recent,
    '',
    '=== CURRENT MESSAGE (from operator, not yet in conversation log) ===',
    text,
    '',
    'Respond with JSON only. No prose, no code fences.',
  ].join('\n');
}

const INSTRUCTIONS = `You are the intent router for a WhatsApp-based AI development-agent orchestrator run by a single operator.
You translate the operator's natural-language message into one of the orchestrator's slash commands, and compose a brief natural-language reply.

AVAILABLE COMMANDS:
- /task {title} | {description}         — Queue a new development task
- /status                                — System overview (budget, counts, health)
- /status {taskId}                       — Details for one task
- /queue                                 — List active tasks
- /budget                                — Rate-limit budget summary
- /answer {taskId} {text}                — Answer a pending agent escalation
- /retry {taskId}                        — Retry a failed task                      [DESTRUCTIVE]
- /dismiss {taskId}                      — Dismiss a failed task                    [DESTRUCTIVE]
- /deploy                                — Merge staging → master                    [DESTRUCTIVE]
- /rollback {taskId}                     — Revert a merged task                      [DESTRUCTIVE]
- /effort {taskId} {medium|high|xhigh|max} — Override effort level for dev or reviewer
                                          (applies to current stage; kills in-flight session and reruns)
                                          [DESTRUCTIVE if task is currently running]
- /model {taskId} {opus|sonnet}          — Override model for dev or reviewer
                                          (applies to current stage; kills in-flight session and reruns)
                                          [DESTRUCTIVE if task is currently running]
- /pause                                 — Pause the pipeline
- /resume                                — Resume the pipeline
- /help                                  — List commands

OUTPUT SHAPE (raw JSON, no markdown):
{
  "command": "/task Add login | Needs email/password" | null,
  "reply": "short natural-language message to the operator",
  "needs_confirmation": false,
  "confirmation_action": null
}

RULES:
1. Destructive commands (/retry /dismiss /deploy /rollback) MUST set needs_confirmation=true,
   put the command in confirmation_action, set command=null, and phrase reply as a yes/no question.
2. /effort and /model are DESTRUCTIVE when the target task is currently running (status is researching,
   designing, developing, or reviewing). Set needs_confirmation=true. Phrase the reply with the
   trade-off, e.g. "Bumping dev_effort to xhigh will kill the running dev session (~N minutes of tokens
   wasted) and restart with the new setting. Confirm?". If the task is NOT currently running, run the
   command directly (no confirmation needed) — it just updates the override for the next stage run.
3. If the operator is clearly answering a pending escalation (e.g. "use OAuth", "keep the sidebar"),
   use /answer {taskId} {text} with the escalation's task ID from state.
4. Pronouns / references ("that task", "the second one") should resolve against the task list in state.
5. If intent is unclear, set command=null and ask a clarifying question in reply.
6. Replies are short (1–2 sentences), friendly, not robotic. No emojis.
7. Never invent task IDs — only use IDs that appear in state.
8. For /task, take the operator's phrasing as the title; add a description only if they gave extra context.`;

// ───────────────────────── State / history helpers ─────────────────────────

async function buildStructuredState(
  pending: ReturnType<typeof getPendingConfirmation>,
): Promise<string> {
  const lines: string[] = [];

  if (pending) {
    lines.push(`Pending confirmation: ${pending.command}${pending.description ? ` — ${pending.description}` : ''}`);
  }

  const escalations = getPendingEscalations();
  if (escalations.length > 0) {
    lines.push('Pending escalations:');
    for (const e of escalations.slice(0, 10)) {
      const q = (e.question || '').slice(0, 160).replace(/\s+/g, ' ');
      lines.push(`  - task ${e.task_id}: ${q}`);
    }
  }

  const tasks = db.prepare(`
    SELECT id, title, status, effort_size
    FROM tasks
    WHERE status NOT IN ('merged', 'failed')
    ORDER BY created_at DESC
    LIMIT 15
  `).all() as any[];
  if (tasks.length > 0) {
    lines.push('Active tasks:');
    for (const t of tasks) {
      const title = (t.title || '').slice(0, 80);
      lines.push(`  - ${t.id} "${title}" [${t.status}${t.effort_size ? `, ${t.effort_size}` : ''}]`);
    }
  }

  const recentMerged = db.prepare(`
    SELECT id, title FROM tasks
    WHERE status = 'merged' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 3
  `).all() as any[];
  if (recentMerged.length > 0) {
    lines.push('Recently merged:');
    for (const t of recentMerged) {
      lines.push(`  - ${t.id} "${(t.title || '').slice(0, 80)}"`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '(no active state)';
}

function formatRecentConversation(): string {
  const history = getRecentConversation(RECENT_MESSAGE_WINDOW_MS, RECENT_MESSAGE_LIMIT);
  if (history.length === 0) return '(none)';

  return history.map((msg: ConversationMessage) => {
    const role = msg.direction === 'in' ? 'user' : 'bot';
    const text = msg.text.replace(/\s+/g, ' ').slice(0, MESSAGE_TEXT_CAP);
    const age = formatAge(Date.now() - msg.created_at);
    return `[${age} ago] ${role}: ${text}`;
  }).join('\n');
}

function formatAge(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = (mins / 60).toFixed(1);
  return `${hours}h`;
}
