interface ActivityFeedProps {
  events: any[];
}

const AGENT_NAMES: Record<string, string> = {
  pm: 'George',
  ux: 'Luna',
  dev: 'Enzo',
  test: 'Zara',
  reviewer: 'Oscar',
  test_gate: 'Test Gate',
  scheduler: 'Scheduler',
  system: 'System',
  validator: 'Validator',
  linear: 'Linear',
  health: 'Health',
  notifier: 'Notifier',
  rate_limiter: 'Rate Limiter',
};

const AGENT_COLORS: Record<string, string> = {
  pm: 'text-blue-500',
  ux: 'text-purple-500',
  dev: 'text-amber-500',
  reviewer: 'text-emerald-500',
  test: 'text-pink-500',
  system: 'text-muted-foreground',
  scheduler: 'text-cyan-500',
  test_gate: 'text-pink-500',
  validator: 'text-orange-500',
  linear: 'text-indigo-500',
};

const EVENT_ICONS: Record<string, string> = {
  task_received: 'inbox',
  status_change: 'step',
  session_start: 'start',
  session_end: 'end',
  pr_created: 'pr',
  review_approved: 'approve',
  changes_requested: 'revise',
  task_merged: 'merge',
  design_approved: 'approve',
  design_revision: 'revise',
  test_passed: 'approve',
  test_failed: 'fail',
  retry: 'retry',
  rate_limited: 'wait',
  defer: 'wait',
  task_imported: 'inbox',
  rollback: 'fail',
  knowledge_update_started: 'step',
  knowledge_updated: 'approve',
};

// Internal events that add noise without helping the user
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

const ICON_COLORS: Record<string, string> = {
  inbox: 'bg-blue-400',
  approve: 'bg-emerald-400',
  merge: 'bg-emerald-400',
  fail: 'bg-red-400',
  revise: 'bg-amber-400',
  retry: 'bg-amber-400',
  pr: 'bg-purple-400',
  wait: 'bg-muted-foreground/40',
  start: 'bg-emerald-400/50',
  end: 'bg-muted-foreground/30',
  step: 'bg-foreground/40',
};

function EventIcon({ type }: { type: string }) {
  const icon = EVENT_ICONS[type];
  const color = ICON_COLORS[icon || ''] || 'bg-muted-foreground/30';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />;
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ActivityFeed({ events }: ActivityFeedProps) {
  const filtered = events.filter((e: any) => !HIDDEN_EVENTS.has(e.event_type));

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-4">
        Activity
      </h2>
      <div className="space-y-2.5 max-h-[500px] overflow-y-auto">
        {filtered.map((event: any) => (
          <div key={event.id} className="flex items-start gap-2 text-xs">
            <div className="w-4 text-center mt-0.5 shrink-0">
              <EventIcon type={event.event_type} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className={`font-medium shrink-0 ${AGENT_COLORS[event.agent] || 'text-foreground'}`}>
                  {AGENT_NAMES[event.agent] || event.agent}
                </span>
                <span className="text-muted-foreground/60 shrink-0">
                  {formatTime(event.created_at)}
                </span>
              </div>
              <p className="text-muted-foreground mt-0.5 break-words line-clamp-2">
                {event.message}
              </p>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground">No activity yet</p>
        )}
      </div>
    </div>
  );
}
