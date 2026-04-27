import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { db, logEvent } from './queue';
import { flockbotsRoot } from './paths';

/**
 * Rate limit handling and scheduling decisions.
 *
 * Strategy: let tasks run freely. When we hit a rate limit, parse the
 * retry/reset time from the error and wait until then. During peak hours,
 * defer L/XL tasks to avoid burning through the window on large jobs.
 */

interface BudgetEstimate {
  isPeakHours: boolean;
  canRunEffort: (size: string, model: string, effort?: string) => boolean;
  shouldPause: boolean;
  rateLimitResumeAt: string | null;
  // Raw metrics for dashboard display
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  sessionCount: number;
}

const PEAK_MAX_SIZE = 'M';
// During peak hours, disallow high-cost effort levels regardless of size —
// xhigh/max burn tokens disproportionately when the 5-hour window matters most.
const PEAK_DISALLOWED_EFFORTS = new Set(['xhigh', 'max']);
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min fallback

export function isPeakHours(): boolean {
  const now = new Date();
  const ptHour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })
  );
  const day = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
  const isWeekday = !['Sat', 'Sun'].includes(day);
  return isWeekday && ptHour >= 5 && ptHour < 11;
}

/**
 * Parse a resume time from rate limit error output.
 * Looks for patterns like:
 * - "retry after X seconds" / "retry-after: X"
 * - "resets at 2:00 AM" / "reset at 2am"
 * - "try again in X minutes"
 * - Unix timestamps or ISO dates
 */
function parseResumeTime(errorOutput: string): number | null {
  const text = errorOutput.toLowerCase();

  // "retry after N seconds" or "retry-after: N"
  const retryAfterSec = text.match(/retry[- ]after[:\s]+(\d+)\s*(?:s|sec)/);
  if (retryAfterSec) return Date.now() + parseInt(retryAfterSec[1]) * 1000;

  // "retry after N" (assume seconds if no unit)
  const retryAfterNum = text.match(/retry[- ]after[:\s]+(\d+)/);
  if (retryAfterNum) {
    const val = parseInt(retryAfterNum[1]);
    // If it looks like a unix timestamp (>1 billion), use it directly
    if (val > 1_000_000_000) return val * 1000;
    return Date.now() + val * 1000;
  }

  // "try again in N minutes"
  const tryAgainMin = text.match(/try again in (\d+)\s*min/);
  if (tryAgainMin) return Date.now() + parseInt(tryAgainMin[1]) * 60 * 1000;

  // "try again in N hours"
  const tryAgainHrs = text.match(/try again in (\d+)\s*hour/);
  if (tryAgainHrs) return Date.now() + parseInt(tryAgainHrs[1]) * 60 * 60 * 1000;

  // "resets at H:MM AM/PM" or "reset at Ham/Hpm"
  const resetAt = text.match(/resets?\s+at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)/);
  if (resetAt) {
    let hour = parseInt(resetAt[1]);
    const min = parseInt(resetAt[2] || '0');
    const ampm = resetAt[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, min, 0, 0);
    // If the target time is in the past, it means tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  return null;
}

/**
 * Path to the cross-instance rate-limit signal file. Lives at the shared
 * root because Claude Max OAuth limits are account-level — when one
 * coordinator hits a 429, every other instance on the same machine should
 * pause too. Per-instance SQLite alone wouldn't propagate the signal.
 */
function sharedRateLimitPath(): string {
  return join(flockbotsRoot(), 'rate-limit-state.json');
}

interface SharedRateLimitState {
  resumeAt: number | null;
  lastHitAt: string | null;
  lastHitInstance: string | null;
}

function readSharedRateLimit(): number | null {
  try {
    const path = sharedRateLimitPath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SharedRateLimitState;
    if (!parsed || typeof parsed.resumeAt !== 'number') return null;
    if (parsed.resumeAt <= Date.now()) return null;
    return parsed.resumeAt;
  } catch {
    return null;
  }
}

function writeSharedRateLimit(resumeAt: number): void {
  try {
    const path = sharedRateLimitPath();
    const state: SharedRateLimitState = {
      resumeAt,
      lastHitAt: new Date().toISOString(),
      lastHitInstance: process.env.FLOCKBOTS_INSTANCE_ID || null,
    };
    // Atomic: write to .tmp then rename so concurrent readers never see a
    // partial JSON file.
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err: any) {
    console.error('[rate-limiter] could not write shared rate-limit state:', err.message);
  }
}

function getRateLimitResumeTime(): number | null {
  // Cross-instance signal wins — if any coordinator on this machine hit a
  // limit recently, all of them pause.
  const shared = readSharedRateLimit();
  if (shared) return shared;

  // Fall back to this instance's local SQLite — this row also gets synced
  // to Supabase by recordRateLimitHit() so the dashboard sees the per-
  // instance audit trail.
  const row = db.prepare(
    'SELECT value FROM system_health WHERE key = ?'
  ).get('rate_limit_resume') as { value: string } | undefined;
  if (!row) return null;
  const resumeAt = parseInt(row.value);
  if (isNaN(resumeAt) || resumeAt <= Date.now()) return null;
  return resumeAt;
}

export function getBudgetEstimate(): BudgetEstimate {
  const fiveHoursAgo = Date.now() - (5 * 60 * 60 * 1000);
  const recentUsage = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) as total_input,
           COALESCE(SUM(output_tokens), 0) as total_output,
           COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
           COALESCE(SUM(cache_create_tokens), 0) as total_cache_create,
           COALESCE(SUM(cost_usd), 0) as total_cost,
           COUNT(*) as session_count
    FROM usage
    WHERE timestamp > ?
  `).get(fiveHoursAgo) as {
    total_input: number; total_output: number;
    total_cache_read: number; total_cache_create: number; total_cost: number;
    session_count: number;
  } | undefined;

  const peak = isPeakHours();
  const resumeAt = getRateLimitResumeTime();
  const paused = resumeAt !== null;

  return {
    isPeakHours: peak,
    shouldPause: paused,
    rateLimitResumeAt: resumeAt ? new Date(resumeAt).toISOString() : null,
    canRunEffort: (size: string, _model: string, effort?: string) => {
      if (paused) return false;
      if (peak) {
        // Defer L/XL tasks during peak
        const sizeOrder = ['XS', 'S', 'M', 'L', 'XL'];
        const maxIdx = sizeOrder.indexOf(PEAK_MAX_SIZE);
        const taskIdx = sizeOrder.indexOf(size);
        if (taskIdx > maxIdx) return false;
        // Defer xhigh/max effort regardless of size during peak
        if (effort && PEAK_DISALLOWED_EFFORTS.has(effort)) return false;
      }
      return true;
    },
    inputTokens: recentUsage?.total_input || 0,
    outputTokens: recentUsage?.total_output || 0,
    cacheReadTokens: recentUsage?.total_cache_read || 0,
    cacheCreateTokens: recentUsage?.total_cache_create || 0,
    costUsd: recentUsage?.total_cost || 0,
    sessionCount: recentUsage?.session_count || 0,
  };
}

export function recordRateLimitHit(taskId: string, errorOutput: string = ''): void {
  const parsed = parseResumeTime(errorOutput);
  const resumeAt = parsed || (Date.now() + DEFAULT_COOLDOWN_MS);
  const source = parsed ? 'from error' : 'estimated';
  const resumeDate = new Date(resumeAt);

  // Shared file first — sibling coordinators consult this on every check
  // and pause immediately, so propagation is fast.
  writeSharedRateLimit(resumeAt);

  // Per-instance audit (also synced to Supabase via syncFn so the dashboard
  // sees per-instance hit history).
  db.prepare(
    'INSERT OR REPLACE INTO system_health (key, value, updated_at) VALUES (?, ?, ?)'
  ).run('rate_limit_resume', String(resumeAt), Date.now());

  const timeStr = resumeDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  logEvent(taskId, 'system', 'rate_limit_hit',
    `Rate limited — will resume at ${timeStr} (${source})`);
}

// Kept for interface compatibility
export function loadCalibration(): void {}
export function maybeRelaxCalibration(): void {}
