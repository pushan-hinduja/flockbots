import cron from 'node-cron';
import { db, initDatabase, setSyncFunction } from './queue';
import { initSupabase, fullSync, syncToSupabase, isSupabaseEnabled } from './supabase-sync';
import { getBudgetEstimate, isPeakHours } from './rate-limiter';
import { processNextTask } from './pipeline';
import { initLinear, pollLinearIssues } from './linear-sync';
import { notifyOperator, setChatProvider } from './notifier';
import { spawnClaude } from './session-manager';
import { checkStaleTasks } from './staleness-checker';
import { pruneStaleWorktrees } from './worktree-manager';
import { checkSystemHealth } from './health-monitor';
import { loadCalibration, maybeRelaxCalibration } from './rate-limiter';
import { getChatProvider } from './chat';
import { routeMessage } from '../../whatsapp/router';
import { pollDashboardActions } from './task-actions';
import { ensureStateDirs, flockbotsHome } from './paths';
import { header, progressLine, promptLine, fg, COLORS } from './cli/brand';

const TARGET_REPO_PATH = process.env.TARGET_REPO_PATH || process.cwd();

async function startup(): Promise<void> {
  console.log(header('start'));

  // 0. Ensure state directories exist
  ensureStateDirs();

  // 1. Initialize database
  initDatabase();
  console.log(progressLine('loading flock', null, 'OK'));

  // Validate required environment variables
  const requiredEnvVars = ['TARGET_REPO_PATH', 'GITHUB_OWNER', 'GITHUB_REPO'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}. Some features may not work.`);
  }

  // Recover tasks stuck in 'developing' from a prior crash
  await recoverStaleSessions();
  console.log('Stale session recovery complete');

  // 2. Load rate limit calibration
  loadCalibration();

  // 3. Initialize Supabase client (optional — dashboard requires it)
  initSupabase();
  setSyncFunction(syncToSupabase as (type: string, data: Record<string, any>) => Promise<void>);
  console.log(progressLine('dashboard', isSupabaseEnabled() ? 'supabase connected' : 'cli-only mode', isSupabaseEnabled() ? 'OK' : 'SKIP'));

  // 3. Initialize Linear
  initLinear();
  const linearOn = !!(process.env.LINEAR_API_KEY && process.env.LINEAR_TEAM_ID);
  console.log(progressLine('linear', linearOn ? 'syncing' : 'not configured', linearOn ? 'OK' : 'SKIP'));

  // 4. Verify claude CLI is available and authenticated
  try {
    const claudeCheck = await spawnClaude(
      ['-p', '--max-turns', '1'],
      'say ok',
      TARGET_REPO_PATH
    );
    if (claudeCheck.exitCode !== 0) {
      console.error('claude CLI not authenticated. Run: claude login');
      process.exit(1);
    }
    console.log(progressLine('claude CLI', process.env.ANTHROPIC_API_KEY ? 'API key' : 'max oauth', 'OK'));
  } catch {
    console.error('claude CLI not found or not authenticated. Run: claude login');
    process.exit(1);
  }

  // 5. Full sync to Supabase (no-op if disabled)
  if (isSupabaseEnabled()) {
    await fullSync();
  }

  // 6. Start chat provider (Telegram, Slack, or WhatsApp, per CHAT_PROVIDER)
  const chat = getChatProvider();
  await chat.healthCheck();
  setChatProvider(chat);
  await chat.start(routeMessage);
  console.log(progressLine('chat', chat.name, 'OK'));
  console.log(progressLine('binding agents', 'pm, ux, dev, review, qa', 'READY'));

  // 7. Sync initial heartbeat
  await syncToSupabase('health', {
    key: 'coordinator_heartbeat',
    value: JSON.stringify({ online: true, timestamp: new Date().toISOString() }),
  });

  // 8. Send startup notification (voice matches the brand console)
  await notifyOperator(
    `flock online · ${isPeakHours() ? 'peak hours' : 'off-peak'}\n\n` +
    `what are we building today? send /help for commands.`
  );

  // 8. Start cron jobs
  cron.schedule('* * * * *', () => {
    processNextTask().catch(err => console.error('Pipeline error:', err));
  });

  cron.schedule('*/5 * * * *', () => {
    pollLinearIssues().catch(err => console.error('Linear poll error:', err));
  });

  // Scheduler budget synced alongside heartbeat (every 2 min via setInterval below)

  cron.schedule('*/10 * * * *', () => {
    fullSync().catch(err => console.error('Full sync error:', err));
  });

  // Staleness check — every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    checkStaleTasks().catch(err => console.error('Staleness check error:', err));
  });

  // Stale worktree pruning — every hour
  cron.schedule('0 * * * *', () => {
    pruneStaleWorktrees().catch(err => console.error('Worktree prune error:', err));
  });

  // Health monitor — every 10 minutes
  cron.schedule('*/10 * * * *', () => {
    checkSystemHealth().catch(err => console.error('Health monitor error:', err));
  });

  // Lightweight heartbeat + budget sync — every 2 minutes
  setInterval(() => {
    syncToSupabase('health', {
      key: 'coordinator_heartbeat',
      value: JSON.stringify({ online: true, timestamp: new Date().toISOString() }),
    }).catch(err => console.error('Heartbeat sync error:', err));
    syncToSupabase('health', {
      key: 'scheduler',
      value: JSON.stringify(getBudgetEstimate()),
    }).catch(err => console.error('Scheduler sync error:', err));
  }, 2 * 60 * 1000);

  // Budget calibration relaxation — every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    maybeRelaxCalibration();
  });

  // Dashboard actions (retry/dismiss) — every 10 seconds (no-op if Supabase off)
  if (isSupabaseEnabled()) {
    setInterval(() => {
      pollDashboardActions().catch(err => console.error('Dashboard action poll error:', err));
    }, 10_000);
  }

  console.log('');
  console.log(promptLine(fg(COLORS.dim, 'what are we building today?')));
}

// Graceful shutdown — mark offline before exiting
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down…`);
  try {
    await syncToSupabase('health', {
      key: 'coordinator_heartbeat',
      value: JSON.stringify({ online: false, timestamp: new Date().toISOString() }),
    });
    await notifyOperator(`System offline (${signal})`);
  } catch (err) {
    console.error('Shutdown sync failed:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function recoverStaleSessions(): Promise<void> {
  const { cleanupWorktree } = await import('./worktree-manager');
  const stuck = db.prepare(
    "SELECT id, worktree_path, branch_name FROM tasks WHERE status = 'developing'"
  ).all() as any[];

  for (const task of stuck) {
    try { await cleanupWorktree(task.id); } catch {}
    db.prepare(
      "UPDATE tasks SET status = 'dev_ready', worktree_path = NULL, branch_name = NULL, updated_at = ? WHERE id = ?"
    ).run(Date.now(), task.id);
    console.log(`Recovered stuck task ${task.id} (developing → dev_ready)`);
  }
}

startup().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
