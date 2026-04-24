interface SchedulerStatusProps {
  tasks: any[];
  health: Record<string, any>;
}

export function SchedulerStatus({ tasks, health }: SchedulerStatusProps) {
  const queued = tasks.filter((t: any) => t.status === 'dev_ready');
  const active = tasks.filter((t: any) =>
    ['developing', 'testing', 'reviewing'].includes(t.status)
  );

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-3">
        Scheduler
      </h2>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Queued</span>
          <span className="font-medium">{queued.length}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Active</span>
          <span className="font-medium">{active.length}</span>
        </div>
      </div>
    </div>
  );
}
