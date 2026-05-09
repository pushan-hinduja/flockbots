import { spawn } from 'child_process';

/**
 * Operator-facing message presenter. Routes structured intent + data through
 * Claude Haiku to produce a friendly chat message, with a deterministic
 * fallback string used on LLM timeout / error so we never block on this.
 *
 * Use when the message is meaningful (asks for a decision, reports a major
 * state change). Don't use for terse single-line acks — the latency + tokens
 * aren't worth it when a static template reads fine.
 */

const PRESENTER_MODEL = process.env.PRESENTER_MODEL || 'claude-haiku-4-5';
const PRESENTER_TIMEOUT_MS = 20_000;

export interface PresentOptions {
  /** Discriminator the LLM uses to pick voice + structure. */
  intent: string;
  /** Structured data the message references. Keep it small. */
  data: Record<string, any>;
  /** Used verbatim when the LLM fails. Should already be operator-readable. */
  fallback: string;
}

export async function presentMessage(opts: PresentOptions): Promise<string> {
  try {
    const result = await callPresenter(opts.intent, opts.data);
    if (result && result.trim().length > 0) return result.trim();
    return opts.fallback;
  } catch (err: any) {
    console.error(`presenter (${opts.intent}) failed: ${err?.message || err}`);
    return opts.fallback;
  }
}

async function callPresenter(intent: string, data: Record<string, any>): Promise<string> {
  const prompt = buildPrompt(intent, data);
  const args = [
    '-p',
    '--model', PRESENTER_MODEL,
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--max-turns', '1',
    '--strict-mcp-config',
  ];

  const raw = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const proc = spawn('claude', args, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new Error('presenter timeout'));
    }, PRESENTER_TIMEOUT_MS);
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`presenter exit ${code}: ${stderr.slice(0, 200)}`));
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

  const envelope = JSON.parse(raw);
  return (envelope.result || '').trim();
}

const PRESENTER_INSTRUCTIONS = `You are crafting a single chat message to the operator of an autonomous AI development pipeline.

OUTPUT FORMAT (strict):
- Reply with ONLY the message text. No JSON, no code fences, no preamble like "Here is the message:".
- Plain text for WhatsApp / Slack / Telegram. No markdown headings, no bold/italic syntax.
- No greeting, no sign-off, no emojis.
- Short paragraphs. Use plain "-" or numbered "1." for lists.
- Questions go on their own line at the end.

CONTENT RULES (do not break these):

1. DATA is the ONLY source of truth. Only include facts that appear in DATA.
   Do NOT invent details, statistics, file lists, status flags, or step
   summaries based on what you imagine the system "probably did". If a
   detail isn't in DATA, you cannot mention it.

2. ABSOLUTE RULE — NEVER include any text that begins with a forward
   slash ("/retry", "/dismiss", "/answer", "/approve_epic", "/effort",
   etc.). Slash commands are an internal mechanism; the operator replies
   in natural language and an inbound router maps intent to commands.
   Even if you see a string starting with "/" in DATA, do not echo it back
   to the operator — paraphrase the intended action in plain English (e.g.
   "reply 'retry' to start fresh", "reply 'dismiss' to abandon", "reply
   'yes' to approve"). This rule has no exceptions.

3. Cover EVERY informative field in DATA. Don't drop fields the operator
   needs to act on (taskId, epicId, prUrl, failure detail, etc.).

4. If DATA includes "taskId" / "epicId", reference the literal id so the
   operator can quote it back.

5. If DATA includes "replyHints" with natural-language phrases (e.g.
   "yes" / "approved" / "describe changes"), mention them at the end as
   the formal way to reply. Hints that look like slash commands MUST be
   ignored or paraphrased per rule 2.

VOICE:
- Direct, brief, factual. The operator skims chat — don't be performative.
- Use the data's own terminology. Don't paraphrase task statuses into
  different language (e.g. "phase merged" → "development complete" is
  WRONG; stay close to what DATA actually says).`;

function buildPrompt(intent: string, data: Record<string, any>): string {
  return [
    PRESENTER_INSTRUCTIONS,
    '',
    `INTENT: ${intent}`,
    '',
    'DATA (JSON):',
    JSON.stringify(data, null, 2),
  ].join('\n');
}
