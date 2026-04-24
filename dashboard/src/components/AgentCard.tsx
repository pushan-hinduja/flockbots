interface AgentCardProps {
  task: any;
}

const STATUS_COLORS: Record<string, string> = {
  researching: 'bg-blue-500',
  designing: 'bg-purple-500',
  developing: 'bg-amber-500',
  testing: 'bg-cyan-500',
  reviewing: 'bg-emerald-500',
};

export function AgentCard({ task }: AgentCardProps) {
  const dotColor = STATUS_COLORS[task.status] || 'bg-muted-foreground';

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-2 h-2 rounded-full ${dotColor} animate-pulse`} />
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          {task.status}
        </span>
      </div>
      <p className="text-sm font-medium truncate">{task.title}</p>
      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
        <span>{task.effort_size || '?'}</span>
        <span>{task.dev_model?.includes('opus') ? 'Opus' : 'Sonnet'}</span>
        {task.use_swarm && <span className="text-accent">Swarm</span>}
      </div>
    </div>
  );
}
