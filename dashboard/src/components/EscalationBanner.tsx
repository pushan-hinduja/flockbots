import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

async function fetchActiveEscalations(): Promise<any[]> {
  const { data: escs } = await supabase.from('flockbots_escalations')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (!escs || escs.length === 0) return [];

  // Cross-reference with tasks — only show escalations whose task is still awaiting_human
  const taskIds = [...new Set(escs.map(e => e.task_id))];
  const { data: tasks } = await supabase.from('tasks')
    .select('id, status')
    .in('id', taskIds);

  const awaitingTasks = new Set(
    (tasks || []).filter(t => t.status === 'awaiting_human').map(t => t.id)
  );

  return escs.filter(e => awaitingTasks.has(e.task_id));
}

export function EscalationBanner() {
  const [escalations, setEscalations] = useState<any[]>([]);

  useEffect(() => {
    fetchActiveEscalations().then(setEscalations);

    const channel = supabase
      .channel('agent-escalations')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'flockbots_escalations',
      }, () => fetchActiveEscalations().then(setEscalations))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  if (escalations.length === 0) return null;

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <h2 className="text-sm font-medium text-amber-700 dark:text-amber-400">
          {escalations.length} escalation{escalations.length > 1 ? 's' : ''} pending
        </h2>
      </div>
      <div className="space-y-2">
        {escalations.map((esc: any) => (
          <div key={esc.id} className="text-xs">
            <span className="text-muted-foreground">Task {esc.task_id}:</span>{' '}
            <span>{esc.question}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Reply via WhatsApp: /answer {'{id}'} {'{your answer}'}
      </p>
    </div>
  );
}
