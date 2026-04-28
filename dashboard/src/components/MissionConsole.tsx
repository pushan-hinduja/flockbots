import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase';
import { useTaskPipeline } from '../hooks/useTaskPipeline';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { useUsageMetrics } from '../hooks/useUsageMetrics';
import { useSystemStatus, type SystemStatus } from '../hooks/useSystemStatus';
import { useEventsLast24h } from '../hooks/useEventsLast24h';
import { useRecentUsage, type UsageRow } from '../hooks/useRecentUsage';
import { PixelOffice } from './PixelOffice';
import { AgentSpriteThumb } from './AgentSpriteThumb';
import { AgentStreamModal } from './AgentStreamModal';
import { AgentEditorModal } from './AgentEditorModal';
import { Logo } from './Logo';
import { InstanceSwitcher } from './InstanceSwitcher';
import { useAgentCustomizations, resolveDashboardAgentId, type MergedAgent } from '../hooks/useAgentCustomizations';
import './MissionConsole.css';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PIPELINE_STAGES = [
  { id: 'inbox',        name: 'INBOX',       statuses: ['inbox'] },
  { id: 'researching',  name: 'RESEARCH',    statuses: ['researching'] },
  { id: 'designing',    name: 'DESIGN',      statuses: ['designing', 'design_pending'] },
  { id: 'design_review',name: 'REVIEW·DES',  statuses: ['design_review'] },
  { id: 'dev_ready',    name: 'READY',       statuses: ['dev_ready'] },
  { id: 'developing',   name: 'DEV',         statuses: ['developing', 'testing'] },
  { id: 'reviewing',    name: 'CODE REVIEW', statuses: ['reviewing', 'review_pending'] },
  // Merged stage bundles the post-merge pipeline states: waiting for QA,
  // actively in QA, and QA-passed (or no QA needed). The flow chart segments
  // this bar visually by color, and the kanban shows per-task QA tags.
  { id: 'merged',       name: 'MERGED',      statuses: ['merged', 'qa_pending', 'qa_running', 'qa_done', 'qa_failed'] },
] as const;

type StageId = typeof PIPELINE_STAGES[number]['id'];

// Which agent "owns" each task status when rendering the roster.
// qa_pending is intentionally NOT mapped — during the post-merge deploy wait
// (qa_ready_at buffer) Zara isn't doing anything; she shouldn't appear as
// actively working. The pipeline picks up the task once the buffer elapses
// and flips status to qa_running, at which point Zara goes to her desk.
const STATUS_TO_AGENT: Record<string, string> = {
  researching: 'pm',
  design_review: 'pm',
  designing: 'ux',
  design_pending: 'ux',
  developing: 'dev',
  testing: 'test',
  reviewing: 'reviewer',
  review_pending: 'reviewer',
  // Zara handles QA (coordinator agent role is 'qa', dashboard character id is 'test')
  qa_running: 'test',
};

// Which events come from the running system vs. from an agent.
const SYSTEM_AGENTS = new Set([
  'system', 'scheduler', 'validator', 'linear', 'health',
  'notifier', 'rate_limiter', 'test_gate',
]);

const HIDDEN_EVENTS = new Set([
  'calibration',
  'github_auth_refresh',
  'stale_worktree_pruned',
  'worktree_created',
  'worktree_removed',
  'knowledge_update_skipped',
  'whatsapp_sent',
  'rebase_success',
  'budget_pause',
]);

// Non-agent labels only. Agent-role labels (pm/ux/dev/test/reviewer) resolve
// through useAgentCustomizations at render time so renames propagate to all
// historical tape rows — events store role IDs, never names.
const AGENT_DISPLAY: Record<string, string> = {
  system: 'SYSTEM',
  scheduler: 'SCHED',
  validator: 'VALID',
  linear: 'LINEAR',
  health: 'HEALTH',
  notifier: 'NOTIFY',
  rate_limiter: 'RATELIM',
  test_gate: 'GATE',
};

const ACCENT_STORAGE_KEY = 'mc.accent';
const PIPE_VIEW_STORAGE_KEY = 'mc.pipeView';
const DEFAULT_ACCENT = 'white';
const DEFAULT_PIPE_VIEW: 'flow' | 'kanban' = 'flow';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function pad(n: number, l: number = 2): string { return String(n).padStart(l, '0'); }

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function stampTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortAgentLabel(
  agent: string | null | undefined,
  byId?: Record<string, MergedAgent>,
): string {
  if (!agent) return 'SYSTEM';
  // Coordinator agent names may differ from dashboard character ids (e.g. 'qa' → 'test')
  const dashboardId = resolveDashboardAgentId(agent);
  // Live agent name takes priority so renames propagate everywhere
  if (byId && byId[dashboardId]) return byId[dashboardId].name.toUpperCase();
  return AGENT_DISPLAY[agent] || agent.toUpperCase();
}

/** Bucket numeric values into fixed-length time series (oldest → newest). */
function bucketByTime(
  rows: Array<{ created_at: string; value: number }>,
  bucketMs: number,
  bucketCount: number,
): number[] {
  const now = Date.now();
  const startOfCurrent = Math.floor(now / bucketMs) * bucketMs;
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    const idx = bucketCount - 1 - Math.floor((startOfCurrent - t) / bucketMs);
    if (idx >= 0 && idx < bucketCount) buckets[idx] += r.value;
  }
  return buckets;
}

/** Build an SVG polyline/area path for a sparkline. */
function sparklinePath(values: number[], w: number = 120, h: number = 20): { line: string; area: string; last: { x: number; y: number } } {
  const max = Math.max(1, ...values);
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = n === 1 ? w : (i / (n - 1)) * w;
    const y = h - Math.max(1, (v / max) * (h - 2));
    return { x, y };
  });
  const line = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = pts.length > 0
    ? `M0,${h} L${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')} L${w},${h} Z`
    : '';
  return { line, area, last: pts[pts.length - 1] || { x: w, y: h } };
}

function Sparkline({ values }: { values: number[] }) {
  const { line, area, last } = sparklinePath(values);
  return (
    <svg className="mc-ticker-spark" viewBox="0 0 120 20" preserveAspectRatio="none">
      {area && <path d={area} fill="var(--accent-glow)" />}
      {line && <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1" />}
      <circle cx={last.x} cy={last.y} r="2" fill="var(--accent)" style={{ filter: 'drop-shadow(0 0 3px var(--accent))' }} />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

interface StreamModalState { agentId: string; taskId: string; taskTitle: string }

export function MissionConsole() {
  const { tasks, tasksLoaded } = useTaskPipeline();
  const events = useRealtimeEvents(1000);
  const events24h = useEventsLast24h();
  const usage = useRecentUsage(4);
  const { health, refreshHealth } = useUsageMetrics();
  const systemStatus = useSystemStatus(health);

  const [accent, setAccent] = useState<string>(() =>
    (typeof window !== 'undefined' && localStorage.getItem(ACCENT_STORAGE_KEY)) || DEFAULT_ACCENT);
  const [pipeView, setPipeView] = useState<'flow' | 'kanban'>(() =>
    ((typeof window !== 'undefined' && localStorage.getItem(PIPE_VIEW_STORAGE_KEY)) as 'flow' | 'kanban') || DEFAULT_PIPE_VIEW);
  const [tapeFilter, setTapeFilter] = useState<'all' | 'system' | 'agents'>('all');
  const [selectedStage, setSelectedStage] = useState<StageId>('merged');
  const [streamModal, setStreamModal] = useState<StreamModalState | null>(null);
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  }, [accent]);
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(PIPE_VIEW_STORAGE_KEY, pipeView);
  }, [pipeView]);

  // 1Hz ticker for the clock + frame counter.
  useEffect(() => {
    const id = setInterval(() => setClockTick(t => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, []);

  // ----- Derived: pipeline stage counts -----
  // Special-case merged: an awaiting_human task that escalated during QA still
  // belongs in the merged bar (the feature did merge — only post-merge QA is
  // stuck). We detect it via error.previous_status, mirroring agentStates.
  const stageCounts = useMemo(() => {
    const out: Record<StageId, number> = {
      inbox: 0, researching: 0, designing: 0, design_review: 0,
      dev_ready: 0, developing: 0, reviewing: 0, merged: 0,
    };
    for (const stage of PIPELINE_STAGES) {
      out[stage.id] = tasks.filter((t: any) => (stage.statuses as readonly string[]).includes(t.status)).length;
    }
    out.merged += tasks.filter((t: any) => {
      if (t.status !== 'awaiting_human') return false;
      try {
        const prev = JSON.parse(t.error || '{}').previous_status || '';
        return prev.startsWith('qa_');
      } catch { return false; }
    }).length;
    return out;
  }, [tasks]);

  const totalActiveTasks = useMemo(() =>
    tasks.filter((t: any) => !['merged', 'failed', 'dismissed', 'deployed'].includes(t.status)).length,
  [tasks]);

  // Tasks already shipped to production — shown only in the "Deployed" modal,
  // hidden from the pipeline chart and kanban (neither PIPELINE_STAGES nor
  // kanban columns include 'deployed').
  const deployedTasks = useMemo(
    () => tasks.filter((t: any) => t.status === 'deployed')
      .sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0)),
    [tasks],
  );
  const [showDeployedModal, setShowDeployedModal] = useState(false);

  const pendingCount = stageCounts.inbox + stageCounts.dev_ready;
  const runningCount = stageCounts.researching + stageCounts.designing + stageCounts.design_review + stageCounts.developing + stageCounts.reviewing;

  // Agent customizations — merged names + sprite rows with defaults.
  const { agents: AGENTS, byId: agentsById, save: saveAgent } = useAgentCustomizations();

  // Editor modal state — opened by pencil click (name) or sprite click (appearance)
  const [editingAgent, setEditingAgent] = useState<{ agent: MergedAgent; focus: 'name' | 'appearance' } | null>(null);

  // ----- Derived: per-agent active task + status -----
  const agentStates = useMemo(() => {
    return AGENTS.map(def => {
      const ownedTasks = tasks.filter((t: any) => STATUS_TO_AGENT[t.status] === def.id);
      const activeTask = ownedTasks[0];
      const waitingTasks = tasks.filter((t: any) => {
        if (t.status !== 'awaiting_human') return false;
        try {
          const prev = JSON.parse(t.error || '{}').previous_status;
          return STATUS_TO_AGENT[prev] === def.id;
        } catch { return false; }
      });
      const isActive = !!activeTask;
      const isWaiting = waitingTasks.length > 0;
      const status: 'active' | 'idle' | 'off' = isActive
        ? 'active'
        : isWaiting ? 'idle' : 'idle';
      const taskLine = activeTask
        ? activeTask.title
        : isWaiting
          ? `Awaiting human · ${waitingTasks[0].title}`
          : 'Idle';
      return { def, status, activeTask, taskLine };
    });
  }, [tasks, AGENTS]);

  const activeAgentCount = agentStates.filter(a => a.status === 'active').length;

  // ----- Derived: sparklines (5-min buckets, ~40 buckets = 3h20m) -----
  const BUCKET_MS = 5 * 60 * 1000;
  const BUCKET_N = 40;
  const usageRows = usage as UsageRow[];
  const sessionsSpark = useMemo(
    () => bucketByTime(usageRows.map(r => ({ created_at: r.created_at, value: 1 })), BUCKET_MS, BUCKET_N),
    [usageRows]);
  const tokensInSpark = useMemo(
    () => bucketByTime(usageRows.map(r => ({ created_at: r.created_at, value: r.input_tokens || 0 })), BUCKET_MS, BUCKET_N),
    [usageRows]);
  const tokensOutSpark = useMemo(
    () => bucketByTime(usageRows.map(r => ({ created_at: r.created_at, value: r.output_tokens || 0 })), BUCKET_MS, BUCKET_N),
    [usageRows]);
  const inboundSpark = useMemo(
    () => bucketByTime(
      events24h
        .filter((e: any) => ['task_received', 'task_imported', 'status_change'].includes(e.event_type))
        .map((e: any) => ({ created_at: e.created_at, value: 1 })),
      BUCKET_MS, BUCKET_N),
    [events24h]);

  // Trend deltas (compare last ~20% to rest).
  function deltaPct(spark: number[]): { value: number; up: boolean } {
    if (spark.length < 4) return { value: 0, up: true };
    const splitAt = Math.floor(spark.length * 0.8);
    const recent = spark.slice(splitAt).reduce((s, v) => s + v, 0);
    const prior = spark.slice(0, splitAt).reduce((s, v) => s + v, 0) || 1;
    const priorPerBucket = prior / splitAt;
    const recentPerBucket = recent / (spark.length - splitAt);
    if (priorPerBucket === 0) return { value: recentPerBucket > 0 ? 100 : 0, up: recentPerBucket > 0 };
    const pct = ((recentPerBucket - priorPerBucket) / priorPerBucket) * 100;
    return { value: Math.round(pct), up: pct >= 0 };
  }

  const sessionsDelta = useMemo(() => deltaPct(sessionsSpark), [sessionsSpark]);
  const tinDelta = useMemo(() => deltaPct(tokensInSpark), [tokensInSpark]);
  const toutDelta = useMemo(() => deltaPct(tokensOutSpark), [tokensOutSpark]);
  const queueDelta = useMemo(() => deltaPct(inboundSpark), [inboundSpark]);

  // ----- Derived: heatmap (5 agents × 24 hours) -----
  const heatCells = useMemo(() => {
    const now = new Date();
    const currentHour = now.getHours();
    // For each agent, a map from hour-of-day (0-23) to count over last 24h.
    const perAgent: Record<string, number[]> = {};
    for (const def of AGENTS) perAgent[def.id] = new Array(24).fill(0);
    for (const e of events24h) {
      // Translate coordinator-side role names (e.g. 'qa') to dashboard ids ('test')
      // so Zara's row bucketizes QA events instead of silently dropping them.
      const agent = e.agent ? resolveDashboardAgentId(e.agent) : null;
      if (!agent || !perAgent[agent]) continue;
      if (HIDDEN_EVENTS.has(e.event_type)) continue;
      const h = new Date(e.created_at).getHours();
      perAgent[agent][h] += 1;
    }
    // Present cells in chronological order (24h ago → now). So column 0 = (currentHour + 1) % 24.
    const ordered: Record<string, number[]> = {};
    for (const def of AGENTS) {
      const arr = perAgent[def.id];
      const out = new Array(24);
      for (let i = 0; i < 24; i++) {
        out[i] = arr[(currentHour + 1 + i) % 24];
      }
      ordered[def.id] = out;
    }
    return ordered;
  }, [events24h, AGENTS]);

  // ----- Derived: activity tape (filtered) -----
  type TapeRow = {
    id: string; ts: string; agent: string; message: string;
    bucket: 'agent' | 'system'; tone: 'ok' | 'warn' | 'err' | null;
  };
  const tapeRows: TapeRow[] = useMemo(() => {
    return events
      .filter((e: any) => !HIDDEN_EVENTS.has(e.event_type))
      .map((e: any): TapeRow => {
        const agent = e.agent || 'system';
        const bucket: 'agent' | 'system' = SYSTEM_AGENTS.has(agent) ? 'system' : 'agent';
        let tone: TapeRow['tone'] = null;
        if (e.event_type === 'test_failed' || e.event_type === 'rollback') tone = 'err';
        else if (e.event_type === 'rate_limited' || e.event_type === 'changes_requested' || e.event_type === 'design_revision') tone = 'warn';
        else if (['review_approved', 'design_approved', 'task_merged', 'test_passed', 'knowledge_updated'].includes(e.event_type)) tone = 'ok';
        return {
          id: String(e.id),
          ts: stampTime(e.created_at),
          agent: shortAgentLabel(agent, agentsById),
          message: e.message || e.event_type,
          bucket,
          tone,
        };
      });
  }, [events, agentsById]);

  const visibleTape = tapeRows.filter(r =>
    tapeFilter === 'all' ? true :
    tapeFilter === 'agents' ? r.bucket === 'agent' :
    r.bucket === 'system');

  // ----- Derived: marquee items -----
  const marqueeItems = useMemo(() => {
    const items: Array<{ sym: string; val: string; chg?: string; dir?: 'up' | 'dn' | '' }> = [];
    for (const a of agentStates) {
      items.push({
        sym: `${a.def.name.toUpperCase()}·${a.def.role.toUpperCase()}`,
        val: a.status === 'active' ? 'RUN' : a.status === 'idle' ? 'IDLE' : 'OFF',
        dir: a.status === 'active' ? 'up' : '',
      });
    }
    items.push({ sym: 'PEND', val: String(pendingCount), dir: '' });
    items.push({ sym: 'RUN', val: String(runningCount), dir: runningCount > 0 ? 'up' : '' });
    items.push({ sym: 'MERGED', val: String(stageCounts.merged), dir: 'up' });
    const tkSum = (health.scheduler?.inputTokens || 0) + (health.scheduler?.outputTokens || 0);
    items.push({ sym: 'TKN/5H', val: formatShort(tkSum), dir: tkSum > 0 ? 'up' : '' });
    items.push({ sym: 'SESSIONS', val: String(health.scheduler?.sessionCount || 0), dir: '' });
    if (health.scheduler?.shouldPause) items.push({ sym: 'STATUS', val: 'RATE-LIMITED', dir: 'dn' });
    else if (health.scheduler?.isPeakHours) items.push({ sym: 'STATUS', val: 'PEAK', dir: 'up' });
    else items.push({ sym: 'STATUS', val: 'OFF-PEAK', dir: '' });
    return items;
  }, [agentStates, pendingCount, runningCount, stageCounts.merged, health]);

  // ----- Clock + heartbeat countdown (bar empties just before next beat) -----
  // Coordinator heartbeat fires every 2 minutes — see coordinator/src/index.ts.
  const HEARTBEAT_INTERVAL_MS = 120_000;
  const now = new Date();
  const clockText = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
  const heartbeatAgeMs = (() => {
    const hb = health.coordinator_heartbeat;
    if (!hb?.timestamp) return null;
    const t = new Date(hb.timestamp).getTime();
    if (Number.isNaN(t)) return null;
    return Math.max(0, Date.now() - t);
  })();
  // Bar = fraction of interval remaining before next expected sync.
  const heartbeatBarPct = heartbeatAgeMs == null
    ? 0
    : Math.max(0, 100 - (heartbeatAgeMs / HEARTBEAT_INTERVAL_MS) * 100);
  const heartbeatText = heartbeatAgeMs == null
    ? '—'
    : `${Math.floor(heartbeatAgeMs / 1000)}s`;

  const systemLabel: Record<SystemStatus, string> = {
    online: 'ONLINE',
    warning: 'OFFLINE',
    offline: 'OFFLINE',
  };

  // ----- Merged stage QA breakdown (powers flow-chart segments + legend) -----
  // Counts derive from qa_status + live status so pre-QA-feature tasks
  // (qa_status=null) don't inflate the "passed" bucket.
  const mergedBreakdown = useMemo(() => {
    const awaiting = tasks.filter((t: any) => t.status === 'qa_pending').length;
    const inQA = tasks.filter((t: any) => t.status === 'qa_running').length;
    // Passed = qa_status 'passed' (verified) or 'skipped' (qa_required=false).
    // Legacy merged tasks (qa_status=null) aren't counted here.
    const passed = tasks.filter((t: any) =>
      (t.qa_status === 'passed' || t.qa_status === 'skipped')
      && ['merged', 'qa_done'].includes(t.status)
    ).length;
    // QA verified the merge but found regressions. Excludes awaiting_human
    // (that's its own bucket below — operator has to triage).
    const failed = tasks.filter((t: any) =>
      t.qa_status === 'failed' && t.status !== 'awaiting_human'
    ).length;
    // Tasks that escalated mid-QA — status is awaiting_human but previous_status
    // was a qa_* stage. Surfaced here so the merged bar accounts for them.
    const awaitingHuman = tasks.filter((t: any) => {
      if (t.status !== 'awaiting_human') return false;
      try {
        const prev = JSON.parse(t.error || '{}').previous_status || '';
        return prev.startsWith('qa_');
      } catch { return false; }
    }).length;
    return { awaiting, inQA, passed, failed, awaitingHuman, total: awaiting + inQA + passed + failed + awaitingHuman };
  }, [tasks]);

  // ----- Selected stage detail -----
  const selectedMeta = useMemo(() => {
    const stage = PIPELINE_STAGES.find(s => s.id === selectedStage) || PIPELINE_STAGES[PIPELINE_STAGES.length - 1];
    const count = stageCounts[stage.id];
    // Throughput = status_change events into this stage in last 24h.
    const thru = events24h.filter((e: any) => {
      if (e.event_type !== 'status_change') return false;
      // best-effort: we don't parse the payload — fall back to matching task_merged for merged stage.
      return false;
    }).length;
    const thruEffective = stage.id === 'merged'
      ? events24h.filter((e: any) => e.event_type === 'task_merged').length
      : thru;
    const maxBar = Math.max(1, ...PIPELINE_STAGES.map(s => stageCounts[s.id]));
    const barPct = Math.round((count / maxBar) * 100);
    return { stage, count, thru: thruEffective, barPct };
  }, [selectedStage, stageCounts, events24h]);

  const handleSignOut = async () => { await supabase.auth.signOut(); };

  // ----- Escalations banner (lightweight version) -----
  const awaitingHuman = tasks.filter((t: any) => t.status === 'awaiting_human');

  return (
    <div className="mc-root" data-accent={accent}>
      <div className="mc-app">

        {/* TOP CHROME */}
        <header className="mc-chrome">
          <div className="mc-brand">
            <Logo size={28} />
            <div><div className="mc-brand-name">FLOCKBOTS</div></div>
          </div>

          <div className="mc-uptime">
            <span className="label">HEARTBEAT</span>
            <div className="mc-uptime-bar">
              <div className="mc-uptime-fill" style={{ width: `${heartbeatBarPct}%` }} />
            </div>
            <span className="num" style={{ fontSize: 11, color: 'var(--fg)' }}>
              {heartbeatAgeMs == null ? '—' : heartbeatText}
            </span>
          </div>

          <InstanceSwitcher />

          <div className={`mc-chrome-status ${systemStatus.status}`}>
            <span className="dot" />
            <span>{systemLabel[systemStatus.status]}</span>
            <button
              onClick={refreshHealth}
              style={{ background: 'transparent', border: '1px solid var(--line-2)', color: 'var(--fg-dim)', padding: '2px 8px', fontSize: 9, letterSpacing: '0.2em', cursor: 'pointer', fontFamily: 'inherit' }}
              title="Refresh health"
            >SYNC</button>
          </div>

          <button className="mc-signout" onClick={handleSignOut}>SIGN OUT</button>

          <div className="mc-chrome-right">
            <span className="k">{clockText}</span>
          </div>
        </header>

        {/* BODY */}
        <div className="mc-body">

          {awaitingHuman.length > 0 && (
            <div className="mc-esc">
              <span className="dot" />
              <span className="body">
                <b>{awaitingHuman.length} escalation{awaitingHuman.length !== 1 ? 's' : ''}</b> awaiting human · reply via WhatsApp to resume
              </span>
            </div>
          )}

          {/* TICKERS */}
          <section className="mc-tickers">
            <div className="mc-ticker-cell">
              <div className="mc-ticker-head">
                <span className="label">SESSIONS</span>
                <span className={`delta ${sessionsDelta.up ? '' : 'down'}`}>{sessionsDelta.up ? '+' : ''}{sessionsDelta.value}%</span>
              </div>
              <div className="mc-ticker-val">
                <span className="v">{health.scheduler?.sessionCount ?? 0}</span>
                <span className="u">/ 5H</span>
              </div>
              <Sparkline values={sessionsSpark} />
            </div>

            <div className="mc-ticker-cell">
              <div className="mc-ticker-head">
                <span className="label">TOKENS IN</span>
                <span className={`delta ${tinDelta.up ? '' : 'down'}`}>{tinDelta.up ? '+' : ''}{tinDelta.value}%</span>
              </div>
              <div className="mc-ticker-val">
                <span className="v">{formatTokens(health.scheduler?.inputTokens || 0)}</span>
                <span className="u">/ 5H</span>
              </div>
              <Sparkline values={tokensInSpark} />
            </div>

            <div className="mc-ticker-cell">
              <div className="mc-ticker-head">
                <span className="label">TOKENS OUT</span>
                <span className={`delta ${toutDelta.up ? '' : 'down'}`}>{toutDelta.up ? '+' : ''}{toutDelta.value}%</span>
              </div>
              <div className="mc-ticker-val">
                <span className="v">{formatTokens(health.scheduler?.outputTokens || 0)}</span>
                <span className="u">/ 5H</span>
              </div>
              <Sparkline values={tokensOutSpark} />
            </div>

            <div className="mc-ticker-cell">
              <div className="mc-ticker-head">
                <span className="label">QUEUE</span>
                <span className={`delta ${queueDelta.up ? '' : 'down'}`}>{queueDelta.up ? '+' : ''}{queueDelta.value}%</span>
              </div>
              <div className="mc-ticker-val">
                <span className="v">{pendingCount}</span>
                <span className="u">PENDING · {runningCount} RUNNING</span>
              </div>
              <Sparkline values={inboundSpark} />
            </div>

            <div className="mc-marquee mc-ticker-cell" style={{ borderRight: 'none' }}>
              <span className="label">LIVE FEED</span>
              <div className="mc-marquee-viewport">
                <div className="mc-marquee-track">
                  {[...marqueeItems, ...marqueeItems].map((it, i) => (
                    <span key={i} className="mc-marquee-item">
                      <span className="sym">{it.sym}</span>
                      <span className="val">{it.val}</span>
                      {it.chg && <span className={`chg ${it.dir || ''}`}>{it.chg}</span>}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* MAIN ROW: OFFICE + PIPELINE */}
          <section className="mc-main-row">
            <div className="mc-office">
              <div className="mc-office-head">
                <div className="l">
                  <span>FEED-01 · OFFICE</span>
                  <span>·</span>
                  <span>CAM 01/01</span>
                </div>
                <div className="rec">{systemStatus.status === 'online' ? 'REC LIVE' : systemStatus.status === 'offline' ? 'OFFLINE' : 'REC · WARN'}</div>
              </div>
              <div className="mc-office-view">
                <div className="mc-office-frame">
                  <PixelOffice
                    tasks={tasks}
                    tasksLoaded={tasksLoaded}
                    systemStatus={systemStatus.status}
                    bare
                    onAgentClick={(agentId, taskId, taskTitle) => setStreamModal({ agentId, taskId, taskTitle })}
                  />
                </div>
              </div>
            </div>

            <div className="mc-pipeline">
              <div className="mc-panel-head">
                <div className="l">
                  <span className="h">PIPELINE</span>
                  <span>· {totalActiveTasks} TASKS</span>
                </div>
                <div className="r">
                  <div className="mc-seg">
                    <button className={pipeView === 'flow' ? 'on' : ''} onClick={() => setPipeView('flow')}>FLOW</button>
                    <button className={pipeView === 'kanban' ? 'on' : ''} onClick={() => setPipeView('kanban')}>KANBAN</button>
                  </div>
                </div>
              </div>
              <div className="mc-pipeline-body">
                {pipeView === 'flow'
                  ? <PipelineFlow
                      stageCounts={stageCounts}
                      selectedStage={selectedStage}
                      onSelect={setSelectedStage}
                      selectedMeta={selectedMeta}
                      mergedBreakdown={mergedBreakdown}
                      awaitingHumanCount={awaitingHuman.length}
                      deployedCount={deployedTasks.length}
                      onShowDeployed={() => setShowDeployedModal(true)}
                    />
                  : <PipelineKanban tasks={tasks} />}
              </div>
            </div>
          </section>

          {/* ROSTER */}
          <section className="mc-roster">
            <div className="mc-roster-label">
              <span className="title">AGENTS</span>
              <span className="sub">{pad(AGENTS.length)} DEPLOYED · {activeAgentCount} ACTIVE</span>
            </div>
            {agentStates.map(a => (
              <div key={a.def.id} className="mc-agent" data-status={a.status}>
                <div className="mc-agent-avatar">{a.def.name.charAt(0)}</div>
                <div className="mc-agent-info">
                  <div className="name">
                    <span>{a.def.name.toUpperCase()}</span>
                    <button
                      className="mc-agent-edit"
                      onClick={() => setEditingAgent({ agent: a.def, focus: 'name' })}
                      title={`Edit ${a.def.name}`}
                      aria-label={`Edit ${a.def.name}`}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                      </svg>
                    </button>
                  </div>
                  <div className="role">{a.def.role} · {a.status.toUpperCase()}</div>
                  <div
                    className="task"
                    onClick={() => {
                      if (!a.activeTask) return;
                      // Zara on a QA task streams under coordinator role 'qa', not 'test'
                      const isQA = a.activeTask.status === 'qa_pending' || a.activeTask.status === 'qa_running';
                      const streamId = (a.def.id === 'test' && isQA) ? 'qa' : a.def.id;
                      setStreamModal({ agentId: streamId, taskId: a.activeTask.id, taskTitle: a.activeTask.title });
                    }}
                    style={{ cursor: a.activeTask ? 'pointer' : 'default' }}
                    title={a.taskLine}
                  >{a.taskLine}</div>
                </div>
                <button
                  className="mc-agent-sprite"
                  onClick={() => setEditingAgent({ agent: a.def, focus: 'appearance' })}
                  title={`Customize ${a.def.name}'s appearance`}
                  aria-label={`Customize ${a.def.name}'s appearance`}
                >
                  <AgentSpriteThumb bodyRow={a.def.bodyRow} hairRow={a.def.hairRow} suitRow={a.def.suitRow} size={52} />
                </button>
              </div>
            ))}
          </section>

          {/* BOTTOM ROW */}
          <section className="mc-bottom-row">
            <div className="mc-activity">
              <div className="mc-panel-head">
                <div className="l">
                  <span className="h">ACTIVITY TAPE</span>
                  <span>· LIVE</span>
                </div>
                <div className="r">
                  <div className="mc-seg">
                    <button className={tapeFilter === 'all' ? 'on' : ''} onClick={() => setTapeFilter('all')}>ALL</button>
                    <button className={tapeFilter === 'system' ? 'on' : ''} onClick={() => setTapeFilter('system')}>SYSTEM</button>
                    <button className={tapeFilter === 'agents' ? 'on' : ''} onClick={() => setTapeFilter('agents')}>AGENTS</button>
                  </div>
                </div>
              </div>
              <div className="mc-tape">
                <div className="mc-tape-inner">
                  {visibleTape.length === 0 && <div className="mc-tape-empty">NO EVENTS</div>}
                  {visibleTape.map(r => (
                    <div key={r.id} className={`mc-tape-row ${r.bucket}${r.tone ? ' ' + r.tone : ''}`}>
                      <span className="ts">{r.ts}</span>
                      <span className="src">{r.agent}</span>
                      <span className="msg">{r.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mc-heatmap">
              <div className="mc-panel-head">
                <div className="l"><span className="h">AGENT ACTIVITY · 24H</span></div>
                <div className="r"><span>EVENTS/HR</span></div>
              </div>
              <div className="mc-heat-body">
                <div className="mc-heat-grid">
                  {AGENTS.map(def => (
                    <HeatRow key={def.id} label={def.name.toUpperCase()} cells={heatCells[def.id] || new Array(24).fill(0)} />
                  ))}
                </div>
                <div className="mc-heat-legend">
                  <span>−24H</span>
                  <div className="scale">
                    <span>LOW</span>
                    <i style={{ background: 'var(--line)' }} />
                    <i style={{ background: 'var(--accent-dim)' }} />
                    <i style={{ background: 'color-mix(in oklab, var(--accent) 60%, transparent)' }} />
                    <i style={{ background: 'var(--accent)' }} />
                    <span>HIGH</span>
                  </div>
                  <span>NOW</span>
                </div>
              </div>
            </div>
          </section>

        </div>
      </div>

      {/* Accent switcher (small floating control) */}
      <AccentSwitcher accent={accent} setAccent={setAccent} />

      {streamModal && (
        <AgentStreamModal
          agentId={streamModal.agentId}
          taskId={streamModal.taskId}
          taskTitle={streamModal.taskTitle}
          onClose={() => setStreamModal(null)}
        />
      )}
      {editingAgent && (
        <AgentEditorModal
          agent={editingAgent.agent}
          initialFocus={editingAgent.focus}
          onClose={() => setEditingAgent(null)}
          onSave={patch => saveAgent(editingAgent.agent.id, patch)}
        />
      )}
      {showDeployedModal && (
        <DeployedTasksModal
          tasks={deployedTasks}
          onClose={() => setShowDeployedModal(false)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function HeatRow({ label, cells }: { label: string; cells: number[] }) {
  const max = Math.max(1, ...cells);
  return (
    <>
      <div className="mc-heat-row-label">{label}</div>
      <div className="mc-heat-cells">
        {cells.map((v, i) => {
          const n = v / max;
          let bg = 'var(--line)';
          if (n >= 0.7) bg = 'var(--accent)';
          else if (n >= 0.4) bg = 'color-mix(in oklab, var(--accent) 55%, transparent)';
          else if (n >= 0.15) bg = 'var(--accent-dim)';
          return (
            <div
              key={i}
              className="mc-heat-cell"
              style={{ background: bg, boxShadow: n >= 0.7 ? '0 0 4px var(--accent-glow)' : undefined }}
              title={`${label} · ${v} events`}
            />
          );
        })}
      </div>
    </>
  );
}

interface SelectedMeta { stage: typeof PIPELINE_STAGES[number]; count: number; thru: number; barPct: number }
interface MergedBreakdown { awaiting: number; inQA: number; passed: number; failed: number; awaitingHuman: number; total: number }

// QA segment colors — referenced in the SVG bar, breakdown swatches, kanban
// dots, and overflow-modal tags. Solid hex so they render identically
// regardless of CSS variable resolution / opacity context.
const QA_COLORS = {
  awaiting:      '#ffffff',  // pure white: queued for QA, not started
  inQA:          '#5B8DEF',  // ink blue: actively verifying
  passed:        '#34945C',  // green: shipped-ready (or QA not required)
  failed:        '#e06a6a',  // red: QA caught a regression, merge needs revert / fix
  awaitingHuman: '#ffb86b',  // orange (matches --warn / escalation banner): stuck in QA, needs human
};

function PipelineFlow({
  stageCounts, selectedStage, onSelect, selectedMeta,
  mergedBreakdown, awaitingHumanCount, deployedCount, onShowDeployed,
}: {
  stageCounts: Record<StageId, number>;
  selectedStage: StageId;
  onSelect: (s: StageId) => void;
  selectedMeta: SelectedMeta;
  mergedBreakdown: MergedBreakdown;
  awaitingHumanCount: number;
  deployedCount: number;
  onShowDeployed: () => void;
}) {
  const W = 600, H = 500;
  const padL = 60, padR = 60;
  const span = W - padL - padR;
  const N = PIPELINE_STAGES.length;
  const maxCount = Math.max(1, ...PIPELINE_STAGES.map(s => stageCounts[s.id]));
  const total = PIPELINE_STAGES.reduce((s, st) => s + stageCounts[st.id], 0);

  return (
    <>
      <svg className="mc-pipe-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {PIPELINE_STAGES.map((s, i) => {
          const x = padL + (i / (N - 1)) * span;
          const count = stageCounts[s.id];
          const h = 40 + (count / maxCount) * 200;
          const y = H / 2 - h / 2;
          const fillH = (count / maxCount) * h;
          const isSelected = s.id === selectedStage;
          const isMerged = s.id === 'merged';
          return (
            <g key={s.id}>
              <rect x={x - 22} y={y} width={44} height={h} fill="var(--bg-2)" stroke={isSelected ? 'var(--accent)' : 'var(--line-2)'} />
              {isMerged && mergedBreakdown.total > 0 ? (
                // Stack bottom→top: passed (green) → failed (red) → inQA (blue) → awaiting QA (white) → awaiting human (orange).
                // Both terminal QA outcomes (passed, failed) sit at the bottom of the stack; in-flight states above them.
                // Heights are proportional to each bucket's share of the stage total.
                (() => {
                  const passedH = fillH * (mergedBreakdown.passed / mergedBreakdown.total);
                  const failedH = fillH * (mergedBreakdown.failed / mergedBreakdown.total);
                  const inQAH = fillH * (mergedBreakdown.inQA / mergedBreakdown.total);
                  const awaitingH = fillH * (mergedBreakdown.awaiting / mergedBreakdown.total);
                  const awaitingHumanH = fillH * (mergedBreakdown.awaitingHuman / mergedBreakdown.total);
                  const baseY = y + h;
                  return (
                    <>
                      {passedH > 0 && (
                        <rect x={x - 22} y={baseY - passedH} width={44} height={passedH} fill={QA_COLORS.passed} opacity={isSelected ? 1 : 0.75} />
                      )}
                      {failedH > 0 && (
                        <rect x={x - 22} y={baseY - passedH - failedH} width={44} height={failedH} fill={QA_COLORS.failed} opacity={isSelected ? 1 : 0.75} />
                      )}
                      {inQAH > 0 && (
                        <rect x={x - 22} y={baseY - passedH - failedH - inQAH} width={44} height={inQAH} fill={QA_COLORS.inQA} opacity={isSelected ? 1 : 0.75} />
                      )}
                      {awaitingH > 0 && (
                        <rect x={x - 22} y={baseY - passedH - failedH - inQAH - awaitingH} width={44} height={awaitingH} fill={QA_COLORS.awaiting} opacity={isSelected ? 1 : 0.75} />
                      )}
                      {awaitingHumanH > 0 && (
                        <rect x={x - 22} y={baseY - passedH - failedH - inQAH - awaitingH - awaitingHumanH} width={44} height={awaitingHumanH} fill={QA_COLORS.awaitingHuman} opacity={isSelected ? 1 : 0.75} />
                      )}
                    </>
                  );
                })()
              ) : (
                <rect x={x - 22} y={y + h - fillH} width={44} height={fillH} fill={isSelected ? 'var(--accent)' : 'var(--accent-dim)'} />
              )}
              <text className="mc-pipe-stage-label" x={x} y={y - 8} textAnchor="middle">{s.name}</text>
              <text className="mc-pipe-stage-count" x={x} y={y + h + 22} textAnchor="middle">{count}</text>
              {i < N - 1 && (
                <>
                  <line
                    x1={x + 22}
                    y1={H / 2}
                    x2={padL + ((i + 1) / (N - 1)) * span - 22}
                    y2={H / 2}
                    stroke="var(--line-2)"
                    strokeDasharray="2 2"
                  />
                  <circle r="2" fill="var(--accent)">
                    <animate attributeName="cx" from={x + 22} to={padL + ((i + 1) / (N - 1)) * span - 22} dur={`${2 + (i % 3) * 0.4}s`} repeatCount="indefinite" />
                    <animate attributeName="cy" from={H / 2} to={H / 2} dur="2s" repeatCount="indefinite" />
                  </circle>
                </>
              )}
              <rect
                x={x - 25}
                y={0}
                width={50}
                height={H}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onClick={() => onSelect(s.id)}
              />
            </g>
          );
        })}
      </svg>
      <div className="mc-pipe-legend">
        <div className="row"><span className="sw" /><span>TOTAL ACTIVE</span><span className="c">{total}</span></div>
        <div className="row"><span className="sw" style={{ background: 'var(--warn)' }} /><span>AWAITING HUMAN</span><span className="c">{awaitingHumanCount}</span></div>
      </div>
      <div className="mc-pipe-selected">
        <div className="k">SELECTED STAGE</div>
        <div className="v">{selectedMeta.stage.name}</div>
        <div className="k" style={{ marginTop: 8 }}>TASKS IN STAGE</div>
        <div className="v num">{selectedMeta.count}</div>
        {selectedMeta.stage.id === 'merged' && (
          <>
            <div className="mc-pipe-selected-sep" />
            <div className="k">BREAKDOWN</div>
            <div className="mc-pipe-selected-row">
              <span className="sw" style={{ background: QA_COLORS.awaiting }} />
              <span>AWAITING QA</span>
              <span className="n">{mergedBreakdown.awaiting}</span>
            </div>
            <div className="mc-pipe-selected-row">
              <span className="sw" style={{ background: QA_COLORS.inQA }} />
              <span>IN QA</span>
              <span className="n">{mergedBreakdown.inQA}</span>
            </div>
            <div className="mc-pipe-selected-row">
              <span className="sw" style={{ background: QA_COLORS.passed }} />
              <span>QA PASSED</span>
              <span className="n">{mergedBreakdown.passed}</span>
            </div>
            <div className="mc-pipe-selected-row">
              <span className="sw" style={{ background: QA_COLORS.failed }} />
              <span>QA FAILED</span>
              <span className="n">{mergedBreakdown.failed}</span>
            </div>
            <div className="mc-pipe-selected-row">
              <span className="sw" style={{ background: QA_COLORS.awaitingHuman }} />
              <span>AWAITING HUMAN</span>
              <span className="n">{mergedBreakdown.awaitingHuman}</span>
            </div>
            <div className="mc-pipe-selected-sep" />
            <div className="k">MERGED · 24H</div>
            <div className="v num">+{selectedMeta.thru}</div>
          </>
        )}
        <div className="bar"><i style={{ width: `${selectedMeta.barPct}%` }} /></div>
      </div>
      <button
        className="mc-pipe-deployed-btn"
        onClick={onShowDeployed}
        title="Show tasks that have been deployed to production"
      >
        DEPLOYED · {deployedCount}
      </button>
    </>
  );
}

function TaskCardView({ task, compact = false }: { task: any; compact?: boolean }) {
  const model = task.dev_model?.includes('opus') ? 'OPUS' : 'SONNET';
  // QA indicator — derived from qa_status (post-feature tasks) or live status
  // (qa_pending/qa_running for tasks currently in the QA flow). Pre-feature
  // merged tasks have qa_status=null and never went through QA, so they show
  // no tag at all rather than being incorrectly labeled "QA PASSED".
  let qaState: 'progress' | 'passed' | 'failed' | null = null;
  if (task.status === 'qa_pending' || task.status === 'qa_running') {
    qaState = 'progress';
  } else if (task.qa_status === 'passed' || task.qa_status === 'skipped') {
    qaState = 'passed';
  } else if (task.qa_status === 'failed') {
    qaState = 'failed';
  }

  const qaLabel = qaState === 'progress' ? 'QA IN PROGRESS'
    : qaState === 'passed' ? (task.qa_status === 'skipped' ? 'QA NOT REQUIRED' : 'QA PASSED')
    : qaState === 'failed' ? 'QA FAILED'
    : null;

  return (
    <div className="mc-kanban-card" title={task.title}>
      <div className="mc-kanban-card-head">
        <span className="sz">{(task.effort_size || '?').toUpperCase()} · {model}{task.use_swarm ? ' · SWARM' : ''}</span>
        {qaState && compact && (
          <span className={`mc-qa-dot mc-qa-dot-${qaState}`} data-label={qaLabel || ''} />
        )}
        {qaState && !compact && (
          <span className={`mc-qa-tag mc-qa-tag-${qaState}`}>{qaLabel}</span>
        )}
      </div>
      <b>{task.title}</b>
    </div>
  );
}

function KanbanColumn({
  stage,
  tasks,
  onOverflow,
}: {
  stage: typeof PIPELINE_STAGES[number];
  tasks: any[];
  onOverflow: (stage: typeof PIPELINE_STAGES[number], tasks: any[]) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);

  // Keep every card in the DOM so measurements stay correct; CSS overflow
  // clips whatever doesn't fit visually. We just count the clipped ones.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    const measure = () => {
      const el = bodyRef.current;
      if (!el) return;
      const bodyH = el.clientHeight;
      if (bodyH <= 4) return; // not laid out yet; ResizeObserver will re-fire.
      const cards = Array.from(el.children).filter(c =>
        (c as HTMLElement).classList.contains('mc-kanban-card')) as HTMLElement[];
      if (cards.length === 0) { setHidden(0); return; }
      let firstHidden = cards.length; // none hidden by default
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        const bottom = c.offsetTop + c.offsetHeight;
        if (bottom > bodyH + 1) { firstHidden = i; break; }
      }
      const hiddenCount = cards.length - firstHidden;
      setHidden(prev => (prev === hiddenCount ? prev : hiddenCount));
    };

    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(() => measure());
    ro.observe(body);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [tasks]);

  return (
    <div className="mc-kanban-col">
      <h4>
        <span>{stage.name}</span>
        <b>{tasks.length}</b>
      </h4>
      <div className="mc-kanban-col-body" ref={bodyRef}>
        {tasks.map((t: any) => <TaskCardView key={t.id} task={t} compact />)}
        {tasks.length === 0 && (
          <div style={{ fontSize: 10, color: 'var(--fg-dimmer)', letterSpacing: '0.15em', padding: '6px 2px' }}>—</div>
        )}
      </div>
      {hidden > 0 && (
        <button className="mc-kanban-col-more" onClick={() => onOverflow(stage, tasks)}>
          + {hidden} MORE ▸
        </button>
      )}
    </div>
  );
}

function KanbanOverflowModal({
  stage, tasks, onClose,
}: {
  stage: typeof PIPELINE_STAGES[number];
  tasks: any[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="mc-modal-backdrop" onClick={onClose}>
      <div className="mc-modal" onClick={e => e.stopPropagation()}>
        <div className="mc-modal-head">
          <span className="title">{stage.name} · {tasks.length}</span>
          <button className="mc-modal-close" onClick={onClose}>[ CLOSE ]</button>
        </div>
        <div className="mc-modal-body">
          {tasks.map((t: any) => <TaskCardView key={t.id} task={t} />)}
          {tasks.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--fg-dimmer)', letterSpacing: '0.15em', padding: '6px 2px' }}>EMPTY</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DeployedTasksModal({
  tasks, onClose,
}: {
  tasks: any[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fmtTime = (ts?: number) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  return (
    <div className="mc-modal-backdrop" onClick={onClose}>
      <div className="mc-modal" onClick={e => e.stopPropagation()}>
        <div className="mc-modal-head">
          <span className="title">DEPLOYED · {tasks.length}</span>
          <button className="mc-modal-close" onClick={onClose}>[ CLOSE ]</button>
        </div>
        <div className="mc-modal-body">
          {tasks.map((t: any) => (
            <div key={t.id} className="mc-kanban-card" title={t.title}>
              <span className="sz">
                {(t.effort_size || '?').toUpperCase()}
                {' · '}
                {fmtTime(t.updated_at)}
              </span>
              <b>{t.title}</b>
            </div>
          ))}
          {tasks.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--fg-dimmer)', letterSpacing: '0.15em', padding: '6px 2px' }}>
              NO TASKS DEPLOYED TO PRODUCTION YET
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PipelineKanban({ tasks }: { tasks: any[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(true);
  const [modal, setModal] = useState<{ stage: typeof PIPELINE_STAGES[number]; tasks: any[] } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setCanLeft(el.scrollLeft > 2);
      setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
    };
    el.addEventListener('scroll', update);
    update();
    return () => el.removeEventListener('scroll', update);
  }, []);

  const scrollBy = (dx: number) => {
    scrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' });
  };

  return (
    <div className="mc-kanban-wrap">
      <button className="mc-kanban-nav left" disabled={!canLeft} onClick={() => scrollBy(-240)} aria-label="Scroll left">◀</button>
      <div className="mc-kanban" ref={scrollRef}>
        {PIPELINE_STAGES.map(stage => {
          const stageTasks = tasks.filter((t: any) => (stage.statuses as readonly string[]).includes(t.status));
          return (
            <KanbanColumn
              key={stage.id}
              stage={stage}
              tasks={stageTasks}
              onOverflow={(s, ts) => setModal({ stage: s, tasks: ts })}
            />
          );
        })}
      </div>
      <button className="mc-kanban-nav right" disabled={!canRight} onClick={() => scrollBy(240)} aria-label="Scroll right">▶</button>
      {modal && <KanbanOverflowModal stage={modal.stage} tasks={modal.tasks} onClose={() => setModal(null)} />}
    </div>
  );
}

function AccentSwitcher({ accent, setAccent }: { accent: string; setAccent: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const options = [
    { id: 'white', label: 'WHT' },
    { id: 'ink',   label: 'INK' },
    { id: 'amber', label: 'AMB' },
    { id: 'phosphor', label: 'GRN' },
  ];
  return (
    <div className="mc-accent-switcher" style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 1000,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      {open && (
        <div style={{
          background: 'var(--bg-1)', border: '1px solid var(--line-2)', padding: '10px 12px',
          display: 'flex', gap: 6, marginBottom: 6,
        }}>
          {options.map(o => (
            <button
              key={o.id}
              onClick={() => setAccent(o.id)}
              style={{
                background: 'transparent',
                border: `1px solid ${accent === o.id ? 'var(--accent)' : 'var(--line-2)'}`,
                color: accent === o.id ? 'var(--accent)' : 'var(--fg-dim)',
                padding: '4px 10px',
                fontSize: 9, letterSpacing: '0.15em',
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >{o.label}</button>
          ))}
        </div>
      )}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'var(--bg-1)', border: '1px solid var(--line-2)', color: 'var(--fg-dim)',
          padding: '6px 12px', fontSize: 9, letterSpacing: '0.2em', fontFamily: 'inherit', cursor: 'pointer',
        }}
      >ACCENT · {accent.toUpperCase()}</button>
    </div>
  );
}
