import { db, logEvent } from './queue';
import { getBudgetEstimate } from './rate-limiter';
import { notifyOperator } from './notifier';
import { presentMessage } from './presenter';
import { syncToSupabase } from './supabase-sync';

// Track alert state to avoid spamming
let lastFailureAlert = 0;
let lastPauseAlert = 0;
let lastTimeoutAlert = 0;

const ALERT_COOLDOWN = 30 * 60 * 1000; // 30 min between repeated alerts

/**
 * Periodic health check — runs every 10 minutes.
 * Detects patterns that need human attention.
 */
export async function checkSystemHealth(): Promise<void> {
  const now = Date.now();
  const alerts: string[] = [];

  // 1. Consecutive task failures
  const recentTasks = db.prepare(
    `SELECT status FROM tasks ORDER BY updated_at DESC LIMIT 5`
  ).all() as { status: string }[];
  const consecutiveFailures = recentTasks.filter(t => t.status === 'failed').length;

  if (consecutiveFailures >= 3 && now - lastFailureAlert > ALERT_COOLDOWN) {
    alerts.push(`${consecutiveFailures} of last 5 tasks failed — pipeline may have a systemic issue`);
    lastFailureAlert = now;
  }

  // 2. Rate limiter paused too long
  const budget = getBudgetEstimate();
  if (budget.shouldPause) {
    const pauseStart = db.prepare(
      `SELECT timestamp FROM events WHERE event_type = 'budget_pause' ORDER BY timestamp DESC LIMIT 1`
    ).get() as { timestamp: number } | undefined;

    if (pauseStart && now - pauseStart.timestamp > 2 * 60 * 60 * 1000 && now - lastPauseAlert > ALERT_COOLDOWN) {
      const hours = Math.round((now - pauseStart.timestamp) / (60 * 60 * 1000));
      alerts.push(`Rate limit pause active for ${hours}h`);
      lastPauseAlert = now;
    }
  }

  // 3. Agent sessions timing out repeatedly
  const recentTimeouts = db.prepare(
    `SELECT COUNT(*) as count FROM events
     WHERE event_type = 'session_end' AND message LIKE '%timed out%'
     AND timestamp > ?`
  ).get(now - 60 * 60 * 1000) as { count: number };

  if (recentTimeouts.count >= 3 && now - lastTimeoutAlert > ALERT_COOLDOWN) {
    alerts.push(`${recentTimeouts.count} agent sessions timed out in the last hour`);
    lastTimeoutAlert = now;
  }

  // 4. Tasks stuck in awaiting_human for too long
  const stuckEscalations = db.prepare(
    `SELECT COUNT(*) as count FROM tasks
     WHERE status = 'awaiting_human' AND updated_at < ?`
  ).get(now - 12 * 60 * 60 * 1000) as { count: number };

  if (stuckEscalations.count > 0) {
    alerts.push(`${stuckEscalations.count} task(s) awaiting your input for 12+ hours`);
  }

  // Send consolidated alert
  if (alerts.length > 0) {
    const fallback = `Health Alert\n${alerts.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
    const presented = await presentMessage({
      intent: 'system_health_alert',
      data: { alerts },
      fallback,
    });
    await notifyOperator(presented);
    logEvent(null, 'health', 'alert_sent', fallback);
  }

  // Sync health summary to Supabase
  await syncToSupabase('health', {
    key: 'system_health',
    value: JSON.stringify({
      consecutiveFailures,
      budgetPaused: budget.shouldPause,
      recentTimeouts: recentTimeouts.count,
      stuckEscalations: stuckEscalations.count,
      alerts,
      lastCheck: new Date().toISOString(),
    }),
  });

}
