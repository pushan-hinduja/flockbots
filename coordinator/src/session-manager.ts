import { spawn, ChildProcess, execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { db, logEvent, logUsage, getPrNumber, getLastSessionId } from './queue';
import { recordRateLimitHit } from './rate-limiter';
import { syncToSupabase } from './supabase-sync';
import { flockbotsHome, flockbotsRoot, tasksDir } from './paths';

// Locate the graphify binary once at module load. graphify is installed via
// `pip install --user graphifyy` and lands in a Python-version-specific bin
// dir that may not be on PATH when the coordinator runs under pm2.
const GRAPHIFY_PATH: string | null = (() => {
  try {
    const found = execSync('command -v graphify', { encoding: 'utf-8' }).trim();
    return found || null;
  } catch {
    // Try common locations. Covers Python 3.10–3.14 user-installs (macOS +
    // Linux) and Homebrew. Mirrored in cli/kg.ts's findGraphifyBinary —
    // keep the lists in sync if you add a new path.
    const candidates = [
      `${process.env.HOME}/Library/Python/3.14/bin/graphify`,
      `${process.env.HOME}/Library/Python/3.13/bin/graphify`,
      `${process.env.HOME}/Library/Python/3.12/bin/graphify`,
      `${process.env.HOME}/Library/Python/3.11/bin/graphify`,
      `${process.env.HOME}/Library/Python/3.10/bin/graphify`,
      `${process.env.HOME}/.local/bin/graphify`,    // Linux pip --user default
      '/opt/homebrew/bin/graphify',
      '/usr/local/bin/graphify',
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return null;
  }
})();

// Registry of running Claude sessions keyed by taskId. Allows external callers
// (e.g. WhatsApp override handler) to kill a mid-flight session. At most one
// session per task runs at a time because the pipeline holds an agent lock.
interface RunningSession {
  proc: ChildProcess;
  agent: string;
  startedAt: number;
}
const runningSessions = new Map<string, RunningSession>();

// Tracks which sessions were killed intentionally via killSession, so runAgent
// can distinguish "killed by override" from "crashed" and return 'killed' status.
const killedByOverride = new Set<string>();

export function killSession(taskId: string): { killed: boolean; agent?: string; runtimeMs?: number } {
  const entry = runningSessions.get(taskId);
  if (!entry) return { killed: false };
  killedByOverride.add(taskId);
  try { entry.proc.kill('SIGTERM'); } catch {}
  const runtimeMs = Date.now() - entry.startedAt;
  return { killed: true, agent: entry.agent, runtimeMs };
}

export function isSessionRunning(taskId: string): { running: boolean; agent?: string } {
  const entry = runningSessions.get(taskId);
  return entry ? { running: true, agent: entry.agent } : { running: false };
}

const PROJECT_ROOT = flockbotsHome();
// Shared resources (agent prompts, mcp-configs, scripts) live at the
// flock root, NOT inside this instance's home. v1.1 split flockbotsHome()
// (per-instance) from flockbotsRoot() (shared); using PROJECT_ROOT for
// shared paths is the v1.0 muscle memory that v1.1 has to break.
const SHARED_ROOT = flockbotsRoot();
const TASKS_DIR = tasksDir();
const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH || '';

export type ClaudeModel = 'claude-opus-4-7' | 'claude-sonnet-4-6';
export type EffortLevel = 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentConfig {
  agent: 'pm' | 'ux' | 'dev' | 'reviewer' | 'qa';
  taskId: string;
  model: ClaudeModel;
  tools: string[];
  promptVariant?: 'single' | 'swarm';
  extraPromptContext?: string;
  cwd: string;
  maxTurns?: number;
  effortSize?: string;
  effortLevel?: EffortLevel; // Explicit override; falls back to agent-role default or size-derived map
  enableStreaming?: boolean; // Stream stdout to Supabase for live viewing
  resume?: boolean; // If true, resume the most recent session for this task+agent
  mcpConfigPath?: string; // Explicit MCP config override (for QA, etc.). If unset, auto-generates KG-only config.
}

// Per-segment session timeouts (ms). With auto-resume in place the *total*
// budget per task can span many of these segments — the timeout is just
// when the agent gets cut off mid-thought and the resume loop picks back
// up. Bumped L to 60min and XL to 90min so substantial work fits in one
// segment more often, reducing context-warmup waste from too many resumes.
const SESSION_TIMEOUT: Record<string, number> = {
  'XS': 15 * 60 * 1000,
  'S':  15 * 60 * 1000,
  'M':  30 * 60 * 1000,
  'L':  60 * 60 * 1000,
  'XL': 90 * 60 * 1000,
};
const DEFAULT_SESSION_TIMEOUT = 30 * 60 * 1000;

// Fallback map from task size to effort level when no explicit effortLevel is passed.
// Only used for dev/reviewer when PM didn't record an explicit dev_effort/reviewer_effort.
// PM and UX have their own hardcoded defaults below.
const EFFORT_LEVEL: Record<string, EffortLevel> = {
  'XS': 'medium',
  'S':  'medium',
  'M':  'high',
  'L':  'high',
  'XL': 'max',
};


// Claude Code's --effort flag accepts only low/medium/high/max. The legacy
// 'xhigh' label was meant as "between high and max" but the CLI rejects it.
// Normalize any leftover xhigh (from already-persisted rows) up to max so
// older tasks resumed after this fix don't break at the dev/reviewer step.
function normalizeEffortForCli(level: EffortLevel): 'low' | 'medium' | 'high' | 'max' {
  if (level === 'xhigh') return 'max';
  return level;
}

export interface SessionResult {
  status: 'complete' | 'failed' | 'questions_pending' | 'escalate' | 'rate_limited' | 'killed' | 'max_turns_reached' | 'timeout';
  output: string;
  durationMs: number;
  exitCode: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Agent's final result text from the JSON envelope (often a handoff note
   *  on cutoff cases). For escalations after auto-resume exhaustion, this is
   *  the cumulative segment-by-segment handoff history. */
  finalAgentMessage?: string;
}

/**
 * Patterns that indicate the session ended because of an Anthropic-side usage
 * cap (rate limit, weekly cap, hourly quota). Checked against both stderr and
 * stdout because Claude CLI sometimes surfaces these in the JSON envelope on
 * stdout, not stderr. Phrasings observed across CLI versions and Anthropic
 * error responses.
 */
const RATE_LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /usage[\s_-]?limit/i,
  /weekly[\s_-]?limit/i,
  /quota[\s_-]?(?:exceeded|reached|exhausted)/i,
  /usage[\s_-]?cap/i,
  /max[\s_-]?(?:sessions|requests)/i,
  /please try again (?:in|later)/i,
  /rate_limit_error/i,
];

function isRateLimitSignal(stderr: string, resultEvent: any | null): boolean {
  // Always inspect stderr — Claude CLI surfaces real Anthropic API errors
  // (including 429/quota responses) on stderr.
  const sources: string[] = [stderr];
  // Only inspect the agent's final result text when the result was
  // explicitly flagged as an error. Scanning all of stdout false-positives
  // any time the agent's code or comments contain phrases like "rate limit"
  // (e.g. when implementing throttling logic in the user's project).
  const subtype = typeof resultEvent?.subtype === 'string' ? resultEvent.subtype : '';
  const isErrorResult = resultEvent?.is_error === true || subtype.startsWith('error');
  if (isErrorResult && typeof resultEvent?.result === 'string') {
    sources.push(resultEvent.result);
  }
  return RATE_LIMIT_PATTERNS.some(p => p.test(sources.join('\n')));
}

/**
 * runAgentWithRetry resume strategy by agent. After a max_turns / timeout
 * cutoff:
 *   - 'snapshot': only resume when the worktree observably changed since
 *     the previous segment (dev — modifies files/commits in the worktree).
 *   - 'count': resume up to MAX_COUNT_RESUMES regardless of worktree
 *     state (pm/ux/reviewer/qa — their artifacts live in the task dir,
 *     not the worktree, so snapshotting wouldn't see progress; the cap
 *     prevents runaway loops on a stuck agent).
 *   - 'none': never auto-resume.
 */
const RESUME_STRATEGY: Record<string, 'snapshot' | 'count' | 'none'> = {
  dev: 'snapshot',
  pm: 'count',
  ux: 'count',
  reviewer: 'count',
  qa: 'count',
};
const MAX_COUNT_RESUMES = 3;

/** Human-readable duration. 71218ms → "1m 11s". 336789ms → "5m 36s". */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Compact model label for activity-tape readability. */
function shortModel(model: string): string {
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return model;
}

// Agent tool defaults. We no longer impose a default --max-turns cap on
// these agents — sessionTimeout (15-60min depending on size) is the real
// wall-clock bound, and Claude Code's --effort flag is the real budget
// control. Explicit short-loop callers that want a turn cap (e.g. dev's
// after-test-fail tight retry) still pass config.maxTurns and that wins.
const AGENT_DEFAULTS: Record<string, { tools: string[] }> = {
  pm:       { tools: ['Read', 'Write', 'WebSearch', 'WebFetch'] },
  ux:       { tools: ['Read', 'Write'] },
  dev:      { tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] },
  reviewer: { tools: ['Read', 'Bash', 'Glob', 'Grep'] },
  // QA: browser automation via Playwright MCP + DB queries via Supabase MCP.
  // Read/Write/Bash for task-dir ops; no Edit/Glob (doesn't touch source code).
  qa:       { tools: ['Read', 'Write', 'Bash', 'Grep'] },
};

export { AGENT_DEFAULTS };

interface TaskContext {
  title: string;
  description: string;
  status: string;
}

function readTaskContext(taskId: string): TaskContext {
  const task = db.prepare('SELECT title, description, status FROM tasks WHERE id = ?').get(taskId) as TaskContext | undefined;
  return task || { title: '', description: '', status: '' };
}

export function readJSON(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

function buildUserPrompt(
  agent: string,
  taskId: string,
  context: TaskContext,
  extraContext?: string
): string {
  const base = `
Task ID: ${taskId}
Task title: ${context.title}
Task description: ${context.description}
Current status: ${context.status}
Tasks directory: ${TASKS_DIR}/${taskId}
Target repo: ${TARGET_REPO_PATH}
`.trim();

  if (extraContext) {
    return `${base}\n\n---\n\n${extraContext}`;
  }

  return base;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function spawnClaude(
  args: string[], userPrompt: string, cwd: string,
  timeoutMs?: number, onChunk?: (text: string) => void,
  onSpawn?: (proc: ChildProcess) => void
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (onSpawn) onSpawn(proc);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      if (onChunk) onChunk(text);
    });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    proc.stdin.write(userPrompt, 'utf-8');
    proc.stdin.end();

    const actualTimeout = timeoutMs || DEFAULT_SESSION_TIMEOUT;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        resolve({ stdout, stderr: stderr + '\nSession timed out', exitCode: 124 });
      }
    }, actualTimeout);

    proc.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      }
    });
  });
}

function deriveStatus(
  taskId: string,
  agent: string,
  result: SpawnResult,
  resultEvent: any | null,
): SessionResult['status'] {
  // Distinct statuses for cutoffs — runAgentWithRetry treats both as
  // "needs auto-resume if progress was made" rather than fresh-retrying:
  //   - 'max_turns_reached': the CLI hit a turn cap (we don't set --max-turns
  //     by default anymore; this only fires if Claude Code has its own
  //     internal cap or if a caller passed an explicit maxTurns).
  //   - 'timeout': spawnClaude killed the process via SIGTERM at the
  //     sessionTimeout deadline (exit 124).
  if (resultEvent?.subtype === 'error_max_turns') return 'max_turns_reached';
  if (result.exitCode === 124) return 'timeout';

  if (result.exitCode !== 0) return 'failed';

  const questionsPath = join(TASKS_DIR, taskId, 'questions.md');
  const contextPath = join(TASKS_DIR, taskId, 'context.json');

  if (fileExists(questionsPath)) {
    const content = readFileSync(questionsPath, 'utf-8');
    const prefix = agent === 'pm' ? 'PM_QUESTION:' : 'DEV_QUESTION:';
    if (content.includes(prefix) && !content.includes(`ANSWERED_${prefix}`)) {
      return 'questions_pending';
    }
  }

  if (fileExists(contextPath)) {
    const ctx = readJSON(contextPath);
    if (ctx.escalate === true) return 'escalate';
  }

  return 'complete';
}

export async function runAgent(config: AgentConfig): Promise<SessionResult> {
  const sessionId = randomUUID();
  const startTime = Date.now();
  const defaults = AGENT_DEFAULTS[config.agent];

  // 1. Determine prompt file
  const variant = config.promptVariant || 'single';
  const promptFileName = variant === 'swarm'
    ? `${config.agent}-agent-swarm.md`
    : `${config.agent}-agent.md`;

  // 2. Load and interpolate system prompt
  const systemPromptTemplate = readFileSync(
    join(SHARED_ROOT, 'agents', 'prompts', promptFileName), 'utf-8'
  );
  const systemPrompt = systemPromptTemplate
    .replaceAll('{TASK_ID}', config.taskId)
    .replaceAll('{PR_NUMBER}', getPrNumber(config.taskId) ?? '');

  // 3. Write to temp file
  const tmpDir = join(tmpdir(), 'multi-agent', sessionId);
  mkdirSync(tmpDir, { recursive: true });
  const systemPromptFile = join(tmpDir, 'system-prompt.md');
  writeFileSync(systemPromptFile, systemPrompt, 'utf-8');

  // Ensure task directory exists
  const taskDir = join(TASKS_DIR, config.taskId);
  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true });
  }

  // 4. Build user prompt
  const taskContext = readTaskContext(config.taskId);
  const userPrompt = buildUserPrompt(config.agent, config.taskId, taskContext, config.extraPromptContext);

  // 5. Build CLI args — smart file loading for dev/reviewer.
  // No default --max-turns cap. Real bounds are sessionTimeout (wall-clock)
  // and --effort (Claude's own thinking budget). Explicit config.maxTurns
  // is honored when callers want a tight loop (e.g. dev's after-test-fail
  // 20-turn rerun, the AI conflict resolver's 5-turn budget).
  const maxTurns = config.maxTurns;
  const tools = config.tools.length > 0 ? config.tools : defaults.tools;

  // Determine if we're resuming a previous session
  let resumedFrom: string | null = null;
  if (config.resume) {
    const prevSessionId = getLastSessionId(config.taskId, config.agent);
    if (prevSessionId) {
      resumedFrom = prevSessionId;
      logEvent(config.taskId, config.agent, 'session_resume', `Resuming session ${prevSessionId.slice(0, 8)}`);
    }
  }

  // Build an MCP config for this session. pm/ux/dev/reviewer get graphify's
  // built-in knowledge-graph MCP server. QA passes its own mcpConfigPath with
  // Playwright + Supabase servers (opts out of the KG graph entirely).
  // Other agents with an explicit mcpConfigPath bypass the auto-generated one.
  //
  // Graphify's --mcp server reads graph.json from its default output dir,
  // which it finds relative to its cwd. We wrap it in a bash shell so we can
  // cd into skills/kg/ before launching the server.
  let mcpConfigPath: string | null = null;
  if (config.mcpConfigPath) {
    mcpConfigPath = config.mcpConfigPath;
  } else if (config.agent !== 'qa' && GRAPHIFY_PATH) {
    const kgDir = join(PROJECT_ROOT, 'skills', 'kg');
    if (existsSync(join(kgDir, 'graph.json'))) {
      const generatedPath = join(tmpDir, 'mcp-config.json');
      writeFileSync(generatedPath, JSON.stringify({
        mcpServers: {
          'graphify': {
            command: 'bash',
            args: ['-c', `cd ${JSON.stringify(kgDir)} && exec ${JSON.stringify(GRAPHIFY_PATH)} --mcp`],
            env: {},
          },
        },
      }, null, 2));
      mcpConfigPath = generatedPath;
    }
  }

  // Include MCP-server tool names in the allow-list so agents can actually call them.
  // We derive the allow patterns from the config file's `mcpServers` keys so this
  // works for any future MCP config (graphify for pm/ux/dev/reviewer; playwright +
  // supabase for QA; etc.) without per-agent hardcoding.
  const mcpToolPatterns: string[] = [];
  if (mcpConfigPath) {
    try {
      const cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
      for (const server of Object.keys(cfg?.mcpServers || {})) {
        mcpToolPatterns.push(`mcp__${server}`);
      }
    } catch (err: any) {
      logEvent(config.taskId, config.agent, 'mcp_config_parse_warn',
        `Failed to parse MCP config ${mcpConfigPath} for allow-list derivation: ${err.message}`);
    }
  }
  const toolsWithMcp = [...tools, ...mcpToolPatterns];

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', config.model,
    '--permission-mode', 'bypassPermissions',
    '--allowedTools', toolsWithMcp.join(','),
    '--strict-mcp-config',  // Only allow MCP servers listed in --mcp-config (or none)
  ];
  // --max-turns only when the caller explicitly bounded this run. By default
  // sessionTimeout is the real cap; a fixed turn count cuts off legit XL work.
  if (typeof maxTurns === 'number') {
    args.push('--max-turns', String(maxTurns));
  }
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath);
  }

  // System prompt: only set for fresh sessions. Resumed sessions already have it in history.
  if (!resumedFrom) {
    args.push('--system-prompt-file', systemPromptFile);
  }

  // Resume flag
  if (resumedFrom) {
    args.push('--resume', resumedFrom);
  }

  // Resolve effort level with precedence:
  //   1. Explicit effortLevel from config (PM-selected dev_effort/reviewer_effort, or WhatsApp override)
  //   2. Agent-role default (PM always high, UX always medium, QA default medium — cost and role bounded)
  //   3. Size-derived fallback
  const effortLevel: EffortLevel = config.effortLevel
    || (config.agent === 'pm' ? 'high'
        : config.agent === 'ux' ? 'high'
        : config.agent === 'qa' ? 'medium'
        : (EFFORT_LEVEL[config.effortSize || 'M'] || 'medium'));
  args.push('--effort', normalizeEffortForCli(effortLevel));

  // Add working directory and task artifacts
  args.push('--add-dir', config.cwd);
  if ((config.agent === 'dev' || config.agent === 'reviewer') && existsSync(taskDir)) {
    args.push('--add-dir', taskDir);
  }

  // 6. Spawn and run with effort-based timeout + optional streaming.
  // Activity-tape message keeps only the operator-relevant fields (variant,
  // model, effort). maxTurns/timeout/session-id stay in pm2 stdout for
  // post-mortem debugging — they're noise on the live tape.
  const sessionTimeout = SESSION_TIMEOUT[config.effortSize || 'M'] || DEFAULT_SESSION_TIMEOUT;
  const effortLabel = normalizeEffortForCli(effortLevel);
  logEvent(config.taskId, config.agent, 'session_start',
    `Starting ${config.agent} (${variant}, ${shortModel(config.model)}, ${effortLabel} effort)`);
  console.log(`[${config.taskId}] session_start: agent=${config.agent} variant=${variant} model=${config.model} effort=${effortLabel} maxTurns=${maxTurns ?? 'unbounded'} timeout=${Math.round(sessionTimeout / 60000)}m session=${sessionId}`);

  // Stream structured events to Supabase for live dashboard viewing
  let streamBuffer = '';
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let lineBuffer = '';
  let currentToolName = '';
  let currentToolInput = '';
  let currentToolUseId = '';
  let resultEvent: any = null;
  // Captured from any event that carries session_id — needed for --resume
  // when the session was killed mid-stream (timeout, etc.) before emitting
  // the final 'result' event. Claude Code's stream-json typically includes
  // session_id on the very first system_init event, so we'll have it even
  // for sessions that never completed.
  let earlySessionId: string | undefined;

  // Swarm visualization — track Agent-tool spawns so the dashboard can show
  // clones at the parent's desk. Keyed by tool_use_id so the matching tool_result
  // fires sub_agent_done with the same spawn_idx.
  const subAgentSpawns = new Map<string, { sub_name: string; spawn_idx: number }>();
  let nextSpawnIdx = 0;
  const emitSubAgentEvent = (kind: 'spawn' | 'done', data: Record<string, any>) => {
    syncToSupabase('sub_agent' as any, {
      kind,
      task_id: config.taskId,
      parent_agent: config.agent,
      session_id: sessionId,
      ...data,
    }).catch(() => {});
  };

  const flushStream = () => {
    if (streamBuffer && config.enableStreaming) {
      syncToSupabase('stream' as any, {
        task_id: config.taskId, agent: config.agent,
        session_id: sessionId, chunk: streamBuffer,
      }).catch(() => {});
      streamBuffer = '';
    }
  };

  const appendStream = (text: string) => {
    streamBuffer += text;
    if (streamBuffer.length > 300) { flushStream(); }
    else if (!streamTimer) {
      streamTimer = setTimeout(() => { flushStream(); streamTimer = null; }, 500);
    }
  };

  const formatToolInput = (input: any): string => {
    if (input.file_path) return input.file_path;
    if (input.command) return input.command.slice(0, 200);
    if (input.pattern) return `"${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
    if (input.query) return `"${input.query}"`;
    return JSON.stringify(input).slice(0, 100);
  };

  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);

      // Sticky-capture session_id from the first event that carries it (usually
      // system_init). Survives mid-stream kills so --resume still works.
      if (!earlySessionId && typeof event.session_id === 'string') {
        earlySessionId = event.session_id;
      }

      // Capture result event for usage data
      if (event.type === 'result') {
        resultEvent = event;
        return;
      }

      // Process stream events for real-time output
      if (event.type === 'stream_event') {
        const inner = event.event;
        if (!inner) return;

        switch (inner.type) {
          case 'content_block_start': {
            const block = inner.content_block;
            if (block?.type === 'tool_use') {
              currentToolName = block.name;
              currentToolUseId = block.id || '';
              currentToolInput = '';
              appendStream(`\n[tool] ${block.name} `);
            } else if (block?.type === 'thinking') {
              appendStream('\n[thinking] ');
            }
            break;
          }
          case 'content_block_delta': {
            const delta = inner.delta;
            if (delta?.type === 'text_delta') {
              appendStream(delta.text);
            } else if (delta?.type === 'thinking_delta') {
              appendStream(delta.thinking);
            } else if (delta?.type === 'input_json_delta') {
              currentToolInput += delta.partial_json;
            }
            break;
          }
          case 'content_block_stop': {
            if (currentToolInput) {
              try {
                const input = JSON.parse(currentToolInput);
                appendStream(formatToolInput(input));

                // Sub-agent spawn — Agent tool calls get visualized on the dashboard.
                // subagent_type is the agent name (e.g., "coder", "tester", "security").
                if (currentToolName === 'Agent' && currentToolUseId) {
                  const subName = input.subagent_type || input.description || 'sub-agent';
                  const spawnIdx = nextSpawnIdx++;
                  subAgentSpawns.set(currentToolUseId, { sub_name: subName, spawn_idx: spawnIdx });
                  emitSubAgentEvent('spawn', {
                    sub_name: subName,
                    spawn_idx: spawnIdx,
                    tool_use_id: currentToolUseId,
                  });
                }
              } catch {}
              currentToolInput = '';
              currentToolName = '';
              currentToolUseId = '';
            }
            appendStream('\n');
            break;
          }
        }
        return;
      }

      // Show tool errors from user/tool_result events + emit sub_agent_done
      // for Agent-tool results we previously spawn-tracked.
      if (event.type === 'user' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id && subAgentSpawns.has(block.tool_use_id)) {
            const spawn = subAgentSpawns.get(block.tool_use_id)!;
            emitSubAgentEvent('done', {
              sub_name: spawn.sub_name,
              spawn_idx: spawn.spawn_idx,
              tool_use_id: block.tool_use_id,
            });
            subAgentSpawns.delete(block.tool_use_id);
          }
          if (block.is_error) {
            appendStream(`[error] ${String(block.content).slice(0, 300)}\n`);
          }
        }
      }
    } catch {}
  };

  const onChunk = config.enableStreaming ? (text: string) => {
    lineBuffer += text;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  } : undefined;

  // When streaming, use stream-json format for structured events
  if (config.enableStreaming) {
    const fmtIdx = args.indexOf('--output-format');
    if (fmtIdx !== -1) {
      args[fmtIdx + 1] = 'stream-json';
    }
    args.push('--verbose', '--include-partial-messages');
  }

  const onSpawnRegister = (proc: ChildProcess) => {
    runningSessions.set(config.taskId, { proc, agent: config.agent, startedAt: startTime });
  };

  let result: SpawnResult;
  try {
    result = await spawnClaude(args, userPrompt, config.cwd, sessionTimeout, onChunk, onSpawnRegister);
  } finally {
    runningSessions.delete(config.taskId);
  }
  // Process any remaining buffered line
  if (lineBuffer) processLine(lineBuffer);
  if (streamTimer) clearTimeout(streamTimer);
  flushStream();

  // Force-done any orphaned sub-agent spawns (session crashed or timed out
  // before tool_results were received). Dashboard cleanup depends on this.
  for (const [toolUseId, spawn] of subAgentSpawns) {
    emitSubAgentEvent('done', {
      sub_name: spawn.sub_name,
      spawn_idx: spawn.spawn_idx,
      tool_use_id: toolUseId,
      forced: true,
    });
  }
  subAgentSpawns.clear();

  const durationMs = Date.now() - startTime;

  // If this session was killed via WhatsApp override, return 'killed' so the pipeline
  // leaves the task alone — the override handler has already reset status + override columns.
  if (killedByOverride.has(config.taskId)) {
    killedByOverride.delete(config.taskId);
    logEvent(config.taskId, config.agent, 'session_killed',
      `Session killed by override after ${durationMs}ms`);
    return { status: 'killed', output: result.stdout, durationMs, exitCode: result.exitCode };
  }

  // 7. Parse token usage, cost, and Claude Code's actual session_id from result
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreateTokens: number | undefined;
  let costUsd: number | undefined;
  let claudeSessionId: string | undefined;
  const parseUsage = (data: any) => {
    if (data.usage) {
      inputTokens = data.usage.input_tokens;
      outputTokens = data.usage.output_tokens;
      cacheReadTokens = data.usage.cache_read_input_tokens;
      cacheCreateTokens = data.usage.cache_creation_input_tokens;
    }
    if (typeof data.total_cost_usd === 'number') {
      costUsd = data.total_cost_usd;
    }
    if (typeof data.session_id === 'string') {
      claudeSessionId = data.session_id;
    }
  };
  if (resultEvent) {
    parseUsage(resultEvent);
  } else {
    try { parseUsage(JSON.parse(result.stdout)); } catch {}
  }

  // Use Claude Code's session_id for logging so --resume can find it later.
  // When resuming, Claude Code keeps the same session_id across continuations.
  // Prefer a real Claude session_id (from the result event, then the early
  // capture, then the resumed-from fallback) over our random UUID — only the
  // real one supports --resume on the next invocation.
  const loggedSessionId = claudeSessionId || earlySessionId || resumedFrom || sessionId;

  // 8. Log usage
  logUsage(config.taskId, config.agent, loggedSessionId, config.model,
    result.exitCode, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd);

  // 9. Check for rate limit. Inspect stderr (where Claude CLI surfaces
  // real Anthropic API errors) and the result event's text only when the
  // result was flagged as an error. Scanning all of stdout — which we did
  // briefly in rc.3 — false-positives any time the agent's code or
  // comments contain "rate limit" (e.g. throttle logic in user code).
  if (isRateLimitSignal(result.stderr, resultEvent)) {
    const detail = result.stderr
      || (resultEvent?.is_error && typeof resultEvent.result === 'string' ? resultEvent.result.slice(0, 500) : '');
    recordRateLimitHit(config.taskId, detail);
    const durHuman = formatDuration(durationMs);
    logEvent(config.taskId, config.agent, 'session_end',
      `Stopped ${config.agent} — Anthropic usage limit hit (${durHuman}); will retry off-peak`);
    try { rmSync(tmpDir, { recursive: true }); } catch {}
    return { status: 'rate_limited', output: result.stderr, durationMs, exitCode: result.exitCode };
  }

  // 10. Derive status (uses resultEvent.subtype to detect max-turns hits
  // distinctly from generic exit-1 failures)
  const status = deriveStatus(config.taskId, config.agent, result, resultEvent);

  // The agent's final result text — the last meaningful thing the model
  // said before exit. For maxTurns hits this is usually a handoff note
  // ("Done X, Y, Z. Remaining: ..."); for generic failures it's the last
  // chunk of reasoning before the crash. Operator sees this directly on
  // the activity tape so they know what happened without grepping pm2.
  const finalAgentMessage: string | undefined = (typeof resultEvent?.result === 'string')
    ? resultEvent.result.trim()
    : undefined;

  const durHuman = formatDuration(durationMs);
  let endMsg: string;
  if (status === 'complete') {
    const summary = finalAgentMessage ? truncateForTape(finalAgentMessage, 240) : '';
    endMsg = summary
      ? `Finished ${config.agent} (${durHuman}) — ${summary}`
      : `Finished ${config.agent} (${durHuman})`;
  } else if (status === 'max_turns_reached') {
    const note = finalAgentMessage ? truncateForTape(finalAgentMessage, 240) : '(no handoff note)';
    const cap = typeof maxTurns === 'number' ? `${maxTurns}-turn` : 'turn';
    endMsg = `Stopped ${config.agent} — hit ${cap} limit (${durHuman}) — ${note}`;
  } else if (status === 'timeout') {
    const note = finalAgentMessage ? truncateForTape(finalAgentMessage, 240) : '(no handoff note)';
    endMsg = `Stopped ${config.agent} — wall-clock timeout (${durHuman}) — ${note}`;
  } else if (status === 'questions_pending' || status === 'escalate') {
    endMsg = `Stopped ${config.agent} — needs operator input (${durHuman})`;
  } else {
    // 'failed' — surface whatever signal we have. Order of preference:
    // (a) agent's final result text (often explains the crash)
    // (b) stderr last 240 chars
    // (c) generic "exit code N"
    const detail = finalAgentMessage
      ? truncateForTape(finalAgentMessage, 240)
      : result.stderr
        ? truncateForTape(result.stderr, 240)
        : `exit ${result.exitCode}`;
    endMsg = `Stopped ${config.agent} — failed (${durHuman}): ${detail}`;
  }
  logEvent(config.taskId, config.agent, 'session_end', endMsg);

  // 11. Cleanup temp files
  try { rmSync(tmpDir, { recursive: true }); } catch {}

  return {
    status, output: result.stdout, durationMs, exitCode: result.exitCode,
    inputTokens, outputTokens, finalAgentMessage,
  };
}

/**
 * Single-line, length-capped excerpt for the activity tape. Collapses
 * whitespace + newlines so a multi-paragraph handoff note still fits in one
 * row, with an ellipsis when truncated.
 */
function truncateForTape(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

/**
 * Run an agent with two distinct retry behaviors layered on top:
 *
 *   1. **Fresh-retry on hard failure** (status: 'failed'). Up to maxRetries
 *      attempts, restart from a clean session. Same as before.
 *
 *   2. **Auto-resume on cutoff** (status: 'max_turns_reached' or 'timeout').
 *      Worktree state is snapshotted before/after each segment. If the
 *      segment made progress (snapshot changed), we set resume=true and
 *      continue with the same Claude session_id — fresh wall-clock budget,
 *      preserved context. If it made no progress, we escalate to the
 *      operator with the cumulative segment-by-segment handoff history.
 *
 * Auto-resume only applies to dev/reviewer (the agents that work in a git
 * worktree where progress is observable). PM/UX/QA fall through to
 * escalation on cutoff per the previous behavior.
 */
export async function runAgentWithRetry(config: AgentConfig, maxRetries: number): Promise<SessionResult> {
  const { snapshotWorktree } = await import('./worktree-manager');
  const handoffSegments: string[] = [];
  let currentConfig = config;
  let attempt = 0;
  let segmentNum = 1;
  let cumulativeWallMs = 0;
  let countResumes = 0;

  while (true) {
    // Resume strategy varies by agent:
    //   - dev → 'snapshot': only resume when the worktree observably
    //     changed in the last segment. Dev edits files / commits, so the
    //     snapshot is a real signal of progress vs. spinning.
    //   - pm / ux / reviewer / qa → 'count': resume up to MAX_COUNT_RESUMES
    //     regardless of worktree state. Their artifacts (research.json,
    //     wireframes, review.md, qa-report.md) live in the task dir, not
    //     the worktree, so snapshotting the worktree is meaningless. Cap
    //     prevents runaway loops on a genuinely-stuck agent.
    const strategy = RESUME_STRATEGY[currentConfig.agent] || 'none';
    const snapshotBefore = strategy === 'snapshot' ? await snapshotWorktree(currentConfig.cwd) : '';
    const result = await runAgent(currentConfig);
    const snapshotAfter = strategy === 'snapshot' ? await snapshotWorktree(currentConfig.cwd) : '';
    cumulativeWallMs += result.durationMs;

    if (result.finalAgentMessage) {
      handoffSegments.push(`Segment ${segmentNum}: ${result.finalAgentMessage}`);
    }

    // Cutoff path: max_turns or timeout.
    if (result.status === 'max_turns_reached' || result.status === 'timeout') {
      let decision: { resume: boolean; reason: string };
      if (strategy === 'snapshot') {
        const observable = snapshotBefore !== '' && snapshotAfter !== '';
        const madeProgress = observable && snapshotBefore !== snapshotAfter;
        decision = madeProgress
          ? { resume: true, reason: 'worktree changed during last segment' }
          : !observable
            ? { resume: false, reason: 'progress check unavailable (no worktree)' }
            : { resume: false, reason: 'no progress detected in last segment' };
      } else if (strategy === 'count') {
        decision = countResumes < MAX_COUNT_RESUMES
          ? { resume: true, reason: `count-based continuation ${countResumes + 1}/${MAX_COUNT_RESUMES}` }
          : { resume: false, reason: `reached ${MAX_COUNT_RESUMES}-continuation cap` };
      } else {
        decision = { resume: false, reason: 'auto-resume not supported for this agent' };
      }

      if (decision.resume) {
        const note = result.finalAgentMessage
          ? truncateForTape(result.finalAgentMessage, 200)
          : '(no handoff note)';
        logEvent(currentConfig.taskId, currentConfig.agent, 'auto_resume',
          `Resuming ${currentConfig.agent} (continuation ${segmentNum + 1}, ${formatDuration(cumulativeWallMs)} so far) — ${note}`);
        notifyAutoResume(currentConfig.taskId, currentConfig.agent, segmentNum + 1, result.finalAgentMessage)
          .catch((err) => {
            console.error(`[${currentConfig.taskId}] auto-resume notification failed: ${err?.message || err}`);
          });
        currentConfig = { ...currentConfig, resume: true };
        segmentNum++;
        countResumes++;
        continue;
      }

      logEvent(currentConfig.taskId, currentConfig.agent, 'auto_resume_exhausted',
        `Escalating after ${segmentNum} segment(s), ${formatDuration(cumulativeWallMs)} total — ${decision.reason}`);
      return {
        ...result,
        status: 'max_turns_reached',
        finalAgentMessage: handoffSegments.length > 0
          ? handoffSegments.join('\n\n')
          : result.finalAgentMessage,
      };
    }

    // Hard failure path: fresh-retry up to maxRetries. Same as before.
    if (result.status === 'failed' && attempt < maxRetries - 1) {
      attempt++;
      if (currentConfig.resume) {
        logEvent(config.taskId, config.agent, 'resume_fallback',
          `Resume failed, falling back to fresh session`);
        currentConfig = { ...currentConfig, resume: false };
      }
      logEvent(config.taskId, config.agent, 'retry',
        `Retrying ${config.agent} (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    // Anything else (complete, escalate, rate_limited, killed, exhausted
    // failed retries) — return as-is to the pipeline.
    return result;
  }
}

/**
 * Operator notification on auto-resume. Lazy-loaded to avoid pulling notifier
 * + presenter into session-manager's module graph (notifier transitively
 * imports things that would create a cycle on coordinator startup).
 */
async function notifyAutoResume(
  taskId: string,
  agent: string,
  continuationNum: number,
  handoff: string | undefined,
): Promise<void> {
  const { notifyOperator } = await import('./notifier');
  const { presentMessage } = await import('./presenter');
  const fallback = [
    `Task ${taskId}: ${agent} continued (continuation ${continuationNum})`,
    handoff ? `Last segment handoff: ${handoff.slice(0, 600)}` : '',
    `Auto-resuming. Reply to stop the loop if you'd rather not continue.`,
  ].filter(Boolean).join('\n');
  const presented = await presentMessage({
    intent: 'agent_auto_resume',
    data: {
      taskId,
      agent,
      continuationNum,
      lastSegmentHandoff: handoff || null,
    },
    fallback,
  });
  await notifyOperator(presented);
}

export { TASKS_DIR, TARGET_REPO_PATH, PROJECT_ROOT };
