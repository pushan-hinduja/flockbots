import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dataDir, dbPath } from './paths';

// Ensure data directory exists before we attempt to open the DB
if (!existsSync(dataDir())) {
  mkdirSync(dataDir(), { recursive: true });
}

export const db = new Database(dbPath());

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Schema is idempotent (CREATE TABLE IF NOT EXISTS everywhere) — running it
// at module load keeps CLI entry points like `flockbots task add` working
// on a fresh install before the coordinator has ever started.
initDatabase();

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT,
      source_id TEXT,
      linear_url TEXT,
      status TEXT NOT NULL DEFAULT 'inbox',
      priority INTEGER DEFAULT 2,
      effort_size TEXT,
      estimated_turns INTEGER,
      dev_model TEXT DEFAULT 'claude-sonnet-4-6',
      reviewer_model TEXT DEFAULT 'claude-opus-4-7',
      dev_effort TEXT DEFAULT 'medium',
      reviewer_effort TEXT DEFAULT 'high',
      use_swarm INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      branch_name TEXT,
      worktree_path TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      retry_count INTEGER DEFAULT 0,
      test_retry_count INTEGER DEFAULT 0,
      error TEXT,
      affected_files TEXT,
      parent_task_id TEXT,
      qa_ready_at INTEGER,
      qa_status TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      agent TEXT,
      event_type TEXT NOT NULL,
      message TEXT,
      metadata TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      session_id TEXT,
      model TEXT,
      exit_code INTEGER,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_create_tokens INTEGER,
      cost_usd REAL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      context TEXT,
      status TEXT DEFAULT 'pending',
      answer TEXT,
      whatsapp_message_id TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS system_health (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limit_budget (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_start INTEGER NOT NULL,
      estimated_usage_pct REAL DEFAULT 0,
      session_tokens_used INTEGER DEFAULT 0,
      is_peak_hours INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pipeline_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      locked INTEGER DEFAULT 0,
      locked_by TEXT,
      locked_at INTEGER,
      task_id TEXT
    );

    -- Initialize pipeline lock row
    INSERT OR IGNORE INTO pipeline_lock (id, locked) VALUES (1, 0);

    -- Singleton row holding a pending WhatsApp confirmation for a destructive op.
    -- The router stores the command to run here when it needs a "yes" from the operator.
    CREATE TABLE IF NOT EXISTS whatsapp_pending_confirmation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      command TEXT,
      description TEXT,
      created_at INTEGER
    );
    INSERT OR IGNORE INTO whatsapp_pending_confirmation (id) VALUES (1);

    -- Rolling log of WhatsApp conversation for the router's short-term context.
    -- Captures both inbound operator messages and outbound bot replies / pipeline
    -- notifications so the LLM can resolve references like "yes do that" or "merge it".
    CREATE TABLE IF NOT EXISTS whatsapp_conversation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_conversation_created_at
      ON whatsapp_conversation(created_at DESC);
  `);

  // Migrations — add columns to existing tables
  const usageCols = db.prepare("PRAGMA table_info(usage)").all() as { name: string }[];
  const colNames = new Set(usageCols.map(c => c.name));
  if (!colNames.has('cache_read_tokens')) {
    db.exec('ALTER TABLE usage ADD COLUMN cache_read_tokens INTEGER');
  }
  if (!colNames.has('cache_create_tokens')) {
    db.exec('ALTER TABLE usage ADD COLUMN cache_create_tokens INTEGER');
  }
  if (!colNames.has('cost_usd')) {
    db.exec('ALTER TABLE usage ADD COLUMN cost_usd REAL');
  }

  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const taskColNames = new Set(taskCols.map(c => c.name));
  if (!taskColNames.has('dev_effort')) {
    db.exec("ALTER TABLE tasks ADD COLUMN dev_effort TEXT DEFAULT 'medium'");
  }
  if (!taskColNames.has('reviewer_effort')) {
    db.exec("ALTER TABLE tasks ADD COLUMN reviewer_effort TEXT DEFAULT 'high'");
  }
  if (!taskColNames.has('affected_files')) {
    db.exec("ALTER TABLE tasks ADD COLUMN affected_files TEXT");
  }
  if (!taskColNames.has('parent_task_id')) {
    db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT");
  }
  if (!taskColNames.has('qa_ready_at')) {
    db.exec("ALTER TABLE tasks ADD COLUMN qa_ready_at INTEGER");
  }
  if (!taskColNames.has('qa_status')) {
    db.exec("ALTER TABLE tasks ADD COLUMN qa_status TEXT");
  }
}

// Import syncToSupabase lazily to avoid circular dependency
let syncFn: ((type: string, data: Record<string, any>) => Promise<void>) | null = null;

export function setSyncFunction(fn: (type: string, data: Record<string, any>) => Promise<void>): void {
  syncFn = fn;
}

export function logEvent(
  taskId: string | null,
  agent: string,
  eventType: string,
  message: string,
  metadata?: string
): void {
  db.prepare(
    `INSERT INTO events (task_id, agent, event_type, message, metadata, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(taskId, agent, eventType, message, metadata || null, Date.now());

  if (syncFn) {
    syncFn('event', { task_id: taskId, agent, event_type: eventType, message, metadata }).catch((err: any) => console.error('Supabase sync (event) failed:', err.message));
  }
}

export function logUsage(
  taskId: string,
  agent: string,
  sessionId: string,
  model: string,
  exitCode: number,
  durationMs: number,
  inputTokens?: number,
  outputTokens?: number,
  cacheReadTokens?: number,
  cacheCreateTokens?: number,
  costUsd?: number
): void {
  db.prepare(
    `INSERT INTO usage (task_id, agent, session_id, model, exit_code, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(taskId, agent, sessionId, model, exitCode, durationMs,
    inputTokens || null, outputTokens || null,
    cacheReadTokens || null, cacheCreateTokens || null,
    costUsd || null, Date.now());

  if (syncFn) {
    syncFn('usage', {
      task_id: taskId, agent, session_id: sessionId, model,
      exit_code: exitCode, duration_ms: durationMs,
      input_tokens: inputTokens, output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens, cache_create_tokens: cacheCreateTokens,
      cost_usd: costUsd,
    }).catch((err: any) => console.error('Supabase sync (usage) failed:', err.message));
  }
}

export function createEscalation(taskId: string, question: string, context?: string): number {
  const result = db.prepare(
    `INSERT INTO escalations (task_id, question, context, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(taskId, question, context || null, Date.now());
  const escalationId = result.lastInsertRowid as number;

  if (syncFn) {
    // Pass the local id so Supabase keys on (instance_id, id). Earlier code
    // omitted id and relied on lockstep BIGSERIAL alignment with local
    // SQLite — fragile in single-instance, broken in multi-instance.
    syncFn('escalation', {
      id: escalationId,
      task_id: taskId, question, context, status: 'pending',
      created_at: new Date().toISOString(),
    }).catch((err: any) => console.error('Supabase sync (escalation) failed:', err.message));
  }

  return escalationId;
}

export function answerEscalation(escalationId: number, answer: string): void {
  db.prepare(
    `UPDATE escalations SET answer = ?, status = 'answered', answered_at = ? WHERE id = ?`
  ).run(answer, Date.now(), escalationId);

  if (syncFn) {
    syncFn('escalation', { id: escalationId, answer, status: 'answered', answered_at: new Date().toISOString() })
      .catch((err: any) => console.error('Supabase sync (escalation) failed:', err.message));
  }
}

/**
 * Mark answered escalations for a task as consumed so the agent doesn't
 * re-inject the same answer on future sessions.
 */
export function consumeAnsweredEscalations(taskId: string): void {
  db.prepare(
    `UPDATE escalations SET status = 'consumed' WHERE task_id = ? AND status = 'answered'`
  ).run(taskId);

  if (syncFn) {
    const escalations = db.prepare(
      "SELECT id FROM escalations WHERE task_id = ? AND status = 'consumed'"
    ).all(taskId) as any[];
    for (const esc of escalations) {
      syncFn('escalation', { id: esc.id, status: 'consumed' })
        .catch((err: any) => console.error('Supabase sync (escalation) failed:', err.message));
    }
  }
}

export function dismissEscalationsForTask(taskId: string): void {
  db.prepare(
    `UPDATE escalations SET status = 'dismissed', answered_at = ? WHERE task_id = ? AND status = 'pending'`
  ).run(Date.now(), taskId);

  if (syncFn) {
    // Sync all pending escalations for this task as dismissed
    const escalations = db.prepare('SELECT id FROM escalations WHERE task_id = ? AND status = ?').all(taskId, 'dismissed') as any[];
    for (const esc of escalations) {
      syncFn('escalation', { id: esc.id, status: 'dismissed', answered_at: new Date().toISOString() })
        .catch((err: any) => console.error('Supabase sync (escalation) failed:', err.message));
    }
  }
}

export function getPendingEscalations(): any[] {
  return db.prepare('SELECT * FROM escalations WHERE status = ?').all('pending');
}

export interface PendingConfirmation {
  command: string;
  description: string | null;
  created_at: number;
}

export function setPendingConfirmation(command: string, description: string | null): void {
  db.prepare(
    'UPDATE whatsapp_pending_confirmation SET command = ?, description = ?, created_at = ? WHERE id = 1'
  ).run(command, description, Date.now());
}

export function getPendingConfirmation(maxAgeMs = 15 * 60 * 1000): PendingConfirmation | null {
  const row = db.prepare(
    'SELECT command, description, created_at FROM whatsapp_pending_confirmation WHERE id = 1'
  ).get() as PendingConfirmation | undefined;
  if (!row || !row.command) return null;
  if (Date.now() - row.created_at > maxAgeMs) {
    clearPendingConfirmation();
    return null;
  }
  return row;
}

export function clearPendingConfirmation(): void {
  db.prepare(
    'UPDATE whatsapp_pending_confirmation SET command = NULL, description = NULL, created_at = NULL WHERE id = 1'
  ).run();
}

export type ConversationDirection = 'in' | 'out';

export interface ConversationMessage {
  direction: ConversationDirection;
  text: string;
  created_at: number;
}

export function logConversationMessage(direction: ConversationDirection, text: string): void {
  if (!text || !text.trim()) return;
  db.prepare(
    'INSERT INTO whatsapp_conversation (direction, text, created_at) VALUES (?, ?, ?)'
  ).run(direction, text, Date.now());
}

export function getRecentConversation(windowMs: number, limit: number): ConversationMessage[] {
  const since = Date.now() - windowMs;
  const rows = db.prepare(`
    SELECT direction, text, created_at
    FROM whatsapp_conversation
    WHERE created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(since, limit) as ConversationMessage[];
  return rows.reverse(); // oldest → newest for LLM readability
}

export interface Task {
  id: string;
  title: string;
  description: string;
  source: string | null;
  source_id: string | null;
  linear_url: string | null;
  status: string;
  priority: number;
  effort_size: string | null;
  estimated_turns: number | null;
  dev_model: string;
  reviewer_model: string;
  dev_effort: string;
  reviewer_effort: string;
  use_swarm: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  branch_name: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  pr_number: number | null;
  retry_count: number;
  test_retry_count: number;
  error: string | null;
  affected_files: string | null;
  parent_task_id: string | null;
  qa_ready_at: number | null;
  // 'passed' | 'failed' | 'skipped' | null
  //   passed  = went through QA successfully
  //   failed  = went through QA, failed (fix task created)
  //   skipped = qa_required=false so QA never ran
  //   null    = pre-QA-feature task (no QA info available)
  qa_status: string | null;
}

export function getTask(taskId: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
}

export function createTask(
  id: string,
  title: string,
  description: string,
  source: string = 'manual',
  sourceId?: string,
  priority: number = 2
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, title, description, source, source_id, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, title, description, source, sourceId || null, priority, now, now);

  const shortTitle = title.length > 80 ? title.slice(0, 80) + '...' : title;
  logEvent(id, 'system', 'task_received', `New task queued: ${shortTitle}`);

  if (syncFn) {
    syncFn('task_update', { id }).catch((err: any) => console.error('Supabase sync (task_update) failed:', err.message));
  }
}

export function getPrNumber(taskId: string): string | null {
  const task = db.prepare('SELECT pr_number FROM tasks WHERE id = ?').get(taskId) as { pr_number: number | null } | undefined;
  return task?.pr_number?.toString() || null;
}

/**
 * Get the most recent session ID for a given task + agent combination.
 * Used for --resume to continue a previous conversation.
 */
export function getLastSessionId(taskId: string, agent: string): string | null {
  const row = db.prepare(
    'SELECT session_id FROM usage WHERE task_id = ? AND agent = ? AND session_id IS NOT NULL ORDER BY timestamp DESC LIMIT 1'
  ).get(taskId, agent) as { session_id: string } | undefined;
  return row?.session_id || null;
}

// CLI initialization support
if (process.argv.includes('--init')) {
  initDatabase();
  console.log('Database initialized at', dbPath());
  process.exit(0);
}
