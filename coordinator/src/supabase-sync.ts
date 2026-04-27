import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { db, logEvent } from './queue';
import { notifyOperator } from './notifier';

let consecutiveFailures = 0;
const DRIFT_ALERT_THRESHOLD = 5;

let supabase: SupabaseClient;

export function getSupabaseClient(): SupabaseClient | null {
  return supabase || null;
}

/**
 * Resolve the current instance id once per call. Validated at coordinator
 * startup (index.ts), so this should never be undefined in practice — the
 * `!` is a runtime safety net for unit tests / direct module invocations.
 */
function instanceId(): string {
  const id = process.env.FLOCKBOTS_INSTANCE_ID;
  if (!id) throw new Error('FLOCKBOTS_INSTANCE_ID is not set; supabase-sync cannot scope rows.');
  return id;
}

export function initSupabase(): void {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.log('[supabase] credentials not configured — dashboard disabled, CLI-only mode');
    return;
  }

  supabase = createClient(url, key);
  console.log('[supabase] connected — dashboard enabled');
}

/** True when Supabase is configured and the coordinator should sync to it. */
export function isSupabaseEnabled(): boolean {
  return !!supabase;
}

/**
 * Register this coordinator's instance in flockbots_instances. Must run
 * BEFORE any task/event/usage/etc. write — every coordinator-written table
 * has `instance_id NOT NULL REFERENCES flockbots_instances(id)`, so a
 * missing registry row produces FK violations on the first sync.
 *
 * Safe to call repeatedly: upsert preserves registered_at, refreshes
 * last_seen_at as a startup heartbeat. Called from index.ts after
 * initSupabase() and again on a periodic timer for liveness tracking.
 */
export async function upsertInstance(): Promise<void> {
  if (!supabase) return;
  const id = instanceId();
  const owner = process.env.GITHUB_OWNER || '';
  const repo = process.env.GITHUB_REPO || '';
  const targetRepo = owner && repo ? `${owner}/${repo}` : id;
  await supabase.from('flockbots_instances').upsert({
    id,
    display_name: process.env.FLOCKBOTS_DISPLAY_NAME || id,
    target_repo: targetRepo,
    chat_provider: process.env.CHAT_PROVIDER || null,
    last_seen_at: new Date().toISOString(),
    // Explicitly clear archive — if the operator archived this instance and
    // then started its coordinator again, treat that as un-archive intent
    // rather than letting the dashboard silently hide a live writer.
    archived_at: null,
  }, { onConflict: 'id' });
}

/**
 * Heartbeat: refresh last_seen_at on the current instance. Called from a
 * lightweight timer so the dashboard can show online/offline state for
 * each instance without parsing pm2.
 */
export async function heartbeatInstance(): Promise<void> {
  if (!supabase) return;
  const id = instanceId();
  await supabase.from('flockbots_instances')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', id);
}

/**
 * Async dual-write to Supabase. Never blocks the pipeline.
 * SQLite is source of truth; Supabase is eventual-consistency mirror.
 *
 * Every write carries instance_id, populated from FLOCKBOTS_INSTANCE_ID
 * once per call — call sites in queue.ts and pipeline.ts don't need to
 * thread the id through.
 */
export async function syncToSupabase(
  type: 'task_update' | 'event' | 'usage' | 'escalation' | 'health' | 'stream' | 'sub_agent',
  data: Record<string, any>
): Promise<void> {
  if (!supabase) return;
  const inst = instanceId();

  try {
    switch (type) {
      case 'task_update': {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id) as any;
        if (!task) return;
        await supabase.from('flockbots_tasks').upsert({
          instance_id: inst,
          id: task.id,
          title: task.title,
          description: task.description,
          source: task.source,
          linear_url: task.linear_url,
          status: task.status,
          priority: task.priority,
          effort_size: task.effort_size,
          dev_model: task.dev_model,
          reviewer_model: task.reviewer_model,
          dev_effort: task.dev_effort,
          reviewer_effort: task.reviewer_effort,
          affected_files: task.affected_files,
          qa_status: task.qa_status,
          use_swarm: task.use_swarm === 1,
          branch_name: task.branch_name,
          pr_url: task.pr_url,
          pr_number: task.pr_number,
          retry_count: task.retry_count,
          error: task.error,
          updated_at: new Date(task.updated_at).toISOString(),
          completed_at: task.completed_at ? new Date(task.completed_at).toISOString() : null,
        }, { onConflict: 'instance_id,id' });
        break;
      }
      case 'event': {
        await supabase.from('flockbots_events').insert({
          instance_id: inst,
          task_id: data.task_id,
          agent: data.agent,
          event_type: data.event_type,
          message: data.message,
          metadata: data.metadata ? (() => { try { return JSON.parse(data.metadata); } catch { return { raw: data.metadata }; } })() : null,
        });
        break;
      }
      case 'usage': {
        await supabase.from('flockbots_usage').insert({
          instance_id: inst,
          task_id: data.task_id,
          agent: data.agent,
          session_id: data.session_id,
          model: data.model,
          exit_code: data.exit_code,
          duration_ms: data.duration_ms,
          input_tokens: data.input_tokens,
          output_tokens: data.output_tokens,
        });
        break;
      }
      case 'escalation': {
        await supabase.from('flockbots_escalations').upsert({
          ...data,
          instance_id: inst,
        }, { onConflict: 'instance_id,id' });
        break;
      }
      case 'health': {
        await supabase.from('flockbots_system_health').upsert({
          instance_id: inst,
          key: data.key,
          value: data.value,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'instance_id,key' });
        break;
      }
      case 'stream': {
        await supabase.from('flockbots_stream_log').insert({
          instance_id: inst,
          task_id: data.task_id,
          agent: data.agent,
          session_id: data.session_id,
          chunk: data.chunk,
        });
        break;
      }
      case 'sub_agent': {
        // Swarm visualization: parent Agent tool spawns/dones. Dashboard
        // subscribes to this table via realtime to render clones at desks.
        await supabase.from('flockbots_sub_agents').insert({
          instance_id: inst,
          task_id: data.task_id,
          parent_agent: data.parent_agent,
          session_id: data.session_id,
          kind: data.kind,         // 'spawn' | 'done'
          sub_name: data.sub_name,
          spawn_idx: data.spawn_idx,
          tool_use_id: data.tool_use_id,
        });
        break;
      }
    }

    // Reset failure counter on success
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    console.error(`Supabase sync failed (${type}):`, err);

    // Alert on persistent drift
    if (consecutiveFailures === DRIFT_ALERT_THRESHOLD) {
      logEvent(null, 'supabase', 'drift_alert', `${DRIFT_ALERT_THRESHOLD} consecutive Supabase write failures`);
      notifyOperator(`Supabase sync failing — ${DRIFT_ALERT_THRESHOLD} consecutive write errors. Dashboard data may be stale.`).catch(() => {});
    }
  }
}

/**
 * Full sync — pushes this instance's entire SQLite state to Supabase.
 */
export async function fullSync(): Promise<void> {
  if (!supabase) return;

  const tasks = db.prepare('SELECT * FROM tasks').all();
  for (const task of tasks) {
    await syncToSupabase('task_update', { id: (task as any).id });
  }

  const healthRows = db.prepare('SELECT * FROM system_health').all();
  for (const row of healthRows as any[]) {
    await syncToSupabase('health', { key: row.key, value: row.value });
  }
}
