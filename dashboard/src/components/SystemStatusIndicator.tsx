import { useState } from 'react';
import { SystemStatus } from '../hooks/useSystemStatus';

interface SystemStatusIndicatorProps {
  status: SystemStatus;
  errors: string[];
  lastHeartbeat: string | null;
  onRefresh?: () => void;
}

const STATUS_CONFIG: Record<SystemStatus, { color: string; bg: string; label: string }> = {
  online:  { color: 'bg-emerald-500', bg: 'bg-emerald-500/10', label: 'Online' },
  warning: { color: 'bg-amber-500',   bg: 'bg-amber-500/10',   label: 'Warning' },
  offline: { color: 'bg-zinc-500',    bg: 'bg-zinc-500/10',    label: 'Offline' },
};

export function SystemStatusIndicator({ status, errors, lastHeartbeat, onRefresh }: SystemStatusIndicatorProps) {
  const [showErrors, setShowErrors] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const config = STATUS_CONFIG[status];

  const handleRefresh = () => {
    if (!onRefresh) return;
    setSpinning(true);
    onRefresh();
    setTimeout(() => setSpinning(false), 600);
  };

  return (
    <div className="relative flex items-center gap-1.5">
      {onRefresh && (
        <button
          onClick={handleRefresh}
          title="Refresh status"
          className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={spinning ? 'animate-spin' : ''}
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
      )}
      <button
        onClick={() => status === 'warning' && setShowErrors(!showErrors)}
        className={`flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${config.bg} ${
          status === 'warning' ? 'cursor-pointer hover:brightness-110' : 'cursor-default'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${config.color} ${
          status === 'online' ? 'animate-pulse' : ''
        }`} />
        <span className="text-foreground/80">{config.label}</span>
      </button>

      {/* Error dropdown */}
      {showErrors && errors.length > 0 && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowErrors(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 w-80 bg-card border border-border rounded-xl shadow-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-amber-500">System Warnings</span>
              {lastHeartbeat && (
                <span className="text-[10px] text-muted-foreground">
                  Last heartbeat: {new Date(lastHeartbeat).toLocaleTimeString()}
                </span>
              )}
            </div>
            <ul className="space-y-1.5">
              {errors.map((err, i) => (
                <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                  <span className="text-amber-500 mt-0.5 shrink-0">-</span>
                  <span>{err}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
