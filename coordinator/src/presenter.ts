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

const PRESENTER_INSTRUCTIONS = `You're crafting a single message to the operator of an autonomous AI development pipeline. The operator skims chat — be clear and brief, not chatty.

Voice:
- Direct, no greeting, no sign-off, no emojis.
- Plain text suitable for WhatsApp / Slack / Telegram. No markdown headings or code fences.
- Short paragraphs, optional bullet/number list when there's a list. Use plain "-" or "1." prefixes.
- When there's a question, end with the question on its own line.

Content rules:
- Cover everything in the DATA. Don't drop fields the operator needs.
- If DATA contains a "taskId" / "epicId", reference it explicitly so the operator can quote it back.
- If DATA contains slash-command hints, mention them at the end as the formal way to reply, but make clear that natural-language replies also work ("yes" / "no" / etc.).
- Don't invent details that aren't in DATA.

Output:
- Reply with ONLY the message text. No JSON, no code fences, no preamble like "Here's the message:".`;

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
