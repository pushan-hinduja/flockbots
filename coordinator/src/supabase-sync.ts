import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { db, logEvent } from './queue';
import { notifyOperator } from './notifier';

let consecutiveFailures = 0;
const DRIFT_ALERT_THRESHOLD = 5;

let supabase: SupabaseClient;

export function getSupabaseClient(): SupabaseClient | null {
  return supabase || null;
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
 * Async dual-write to Supabase. Never blocks the pipeline.
 * SQLite is source of truth; Supabase is eventual-consistency mirror.
 */
export async function syncToSupabase(
  type: 'task_update' | 'event' | 'usage' | 'escalation' | 'health' | 'stream' | 'sub_agent',
  data: Record<string, any>
): Promise<void> {
  if (!supabase) return;

  try {
    switch (type) {
      case 'task_update': {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id) as any;
        if (!task) return;
        await supabase.from('flockbots_tasks').upsert({
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
        });
        break;
      }
      case 'event': {
        await supabase.from('flockbots_events').insert({
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
        await supabase.from('flockbots_escalations').upsert(data);
        break;
      }
      case 'health': {
        await supabase.from('flockbots_system_health').upsert({
          key: data.key,
          value: data.value,
          updated_at: new Date().toISOString(),
        });
        break;
      }
      case 'stream': {
        await supabase.from('flockbots_stream_log').insert({
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
 * Full sync — pushes entire SQLite state to Supabase.
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
