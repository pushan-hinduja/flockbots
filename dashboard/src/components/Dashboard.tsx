import { useState } from 'react';
import { supabase } from '../supabase';
import { useTaskPipeline } from '../hooks/useTaskPipeline';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { useUsageMetrics } from '../hooks/useUsageMetrics';
import { useSystemStatus } from '../hooks/useSystemStatus';
import { AgentCard } from './AgentCard';
import { TaskPipeline } from './TaskPipeline';
import { ActivityFeed } from './ActivityFeed';
import { UsageBudgetBar } from './UsageBudgetBar';
import { SchedulerStatus } from './SchedulerStatus';
import { EscalationBanner } from './EscalationBanner';
import { PixelOffice } from './PixelOffice';
import { AgentStreamModal } from './AgentStreamModal';
import { SystemStatusIndicator } from './SystemStatusIndicator';

export function Dashboard() {
  const [streamModal, setStreamModal] = useState<{ agentId: string; taskId: string; taskTitle: string } | null>(null);
  const { tasks, tasksLoaded } = useTaskPipeline();
  const events = useRealtimeEvents();
  const { health, refreshHealth } = useUsageMetrics();
  const systemStatus = useSystemStatus(health);

  const activeTasks = tasks.filter((t: any) =>
    ['researching', 'designing', 'developing', 'testing', 'reviewing'].includes(t.status)
  );

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-medium tracking-tight">Agent Dashboard</h1>
          {activeTasks.length > 0 && (
            <span className="text-xs text-muted-foreground px-2 py-0.5 bg-secondary rounded-full">
              {activeTasks.length} active task{activeTasks.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <SystemStatusIndicator
            status={systemStatus.status}
            errors={systemStatus.errors}
            lastHeartbeat={systemStatus.lastHeartbeat}
            onRefresh={refreshHealth}
          />
          <button
            onClick={handleSignOut}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Escalation Banner */}
        <EscalationBanner />

        {/* Status Strip */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <UsageBudgetBar health={health} />
          <SchedulerStatus tasks={tasks} health={health} />
          {activeTasks.slice(0, 2).map((task: any) => (
            <AgentCard key={task.id} task={task} />
          ))}
          {/* Fill empty grid slots when fewer than 2 active tasks */}
          {activeTasks.length < 2 && (
            <div className="bg-card border border-border rounded-2xl p-4 flex items-center justify-center">
              <span className="text-xs text-muted-foreground">
                {activeTasks.length === 0 ? 'No active agents' : 'One agent active'}
              </span>
            </div>
          )}
          {activeTasks.length === 0 && (
            <div className="bg-card border border-border rounded-2xl p-4 flex items-center justify-center">
              <span className="text-xs text-muted-foreground">All agents idle</span>
            </div>
          )}
        </div>

        {/* Pixel Office */}
        <PixelOffice
          tasks={tasks}
          tasksLoaded={tasksLoaded}
          systemStatus={systemStatus.status}
          onAgentClick={(agentId, taskId, taskTitle) => setStreamModal({ agentId, taskId, taskTitle })}
        />

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <TaskPipeline tasks={tasks} />
          </div>
          <div>
            <ActivityFeed events={events} />
          </div>
        </div>
      </main>

      {/* Agent Stream Modal */}
      {streamModal && (
        <AgentStreamModal
          agentId={streamModal.agentId}
          taskId={streamModal.taskId}
          taskTitle={streamModal.taskTitle}
          onClose={() => setStreamModal(null)}
        />
      )}
    </div>
  );
}
