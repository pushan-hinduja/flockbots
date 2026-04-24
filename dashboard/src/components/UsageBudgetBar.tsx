import { useState } from 'react';

interface UsageBudgetBarProps {
  health: Record<string, any>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function UsageBudgetBar({ health }: UsageBudgetBarProps) {
  const [showInfo, setShowInfo] = useState(false);
  const scheduler = health.scheduler || {};
  const isPeak = scheduler.isPeakHours || false;
  const paused = scheduler.shouldPause || false;
  const resumeAt = scheduler.rateLimitResumeAt || null;
  const inputTokens = scheduler.inputTokens || 0;
  const outputTokens = scheduler.outputTokens || 0;
  const sessionCount = scheduler.sessionCount || 0;

  // TODO: active session tracking would require real-time session state from coordinator
  // For now we show the 5h rolling window totals

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
          Agent Usage
        </h2>
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${paused ? 'bg-destructive' : isPeak ? 'bg-amber-500' : 'bg-accent'}`} />
          <span className="text-xs text-muted-foreground">
            {paused ? 'Rate limited' : isPeak ? 'Peak hours' : 'Off-peak'}
          </span>
        </div>
      </div>

      {paused && (
        <div className="mb-3 flex items-center gap-2 text-xs text-destructive">
          <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
          Resumes {resumeAt
            ? `at ${new Date(resumeAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : 'soon'}
        </div>
      )}

      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Sessions</span>
          <span className="font-medium">{sessionCount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Tokens in</span>
          <span className="font-medium">{formatTokens(inputTokens)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Tokens out</span>
          <span className="font-medium">{formatTokens(outputTokens)}</span>
        </div>
      </div>
    </div>
  );
}
