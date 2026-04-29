import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { useInstance } from '../contexts/InstanceContext';

interface EscalationRow {
  id: number;
  instance_id: string;
  task_id: string;
  question: string;
  /** "awaiting_human" (regular escalation) or "awaiting_design_approval" — drives the chat hint shown to the operator. */
  task_status: string;
}

const HUMAN_WAIT_STATUSES = ['awaiting_human', 'awaiting_design_approval'];

async function fetchActiveEscalations(): Promise<EscalationRow[]> {
  // Cross-instance: escalations page the operator regardless of which
  // instance is in focus, so don't filter by instance_id here.
  const { data: escs } = await supabase.from('flockbots_escalations')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (!escs || escs.length === 0) return [];

  // Cross-reference with tasks — only show escalations whose task is still
  // in a human-wait status (awaiting_human OR awaiting_design_approval).
  // Composite key (instance_id, id) means we have to match on both columns;
  // do it in JS after one batch fetch instead of N queries.
  const taskKeys = new Set(escs.map((e: any) => `${e.instance_id}:${e.task_id}`));
  const taskIds = [...new Set(escs.map((e: any) => e.task_id))];
  const { data: tasks } = await supabase.from('flockbots_tasks')
    .select('id, instance_id, status')
    .in('id', taskIds);

  // Map composite key → task status so we can attach it to each row.
  const taskStatusByKey = new Map<string, string>();
  for (const t of (tasks || [])) {
    const key = `${(t as any).instance_id}:${(t as any).id}`;
    if (taskKeys.has(key) && HUMAN_WAIT_STATUSES.includes((t as any).status)) {
      taskStatusByKey.set(key, (t as any).status);
    }
  }

  return escs
    .filter((e: any) => taskStatusByKey.has(`${e.instance_id}:${e.task_id}`))
    .map((e: any) => ({
      ...e,
      task_status: taskStatusByKey.get(`${e.instance_id}:${e.task_id}`)!,
    }));
}

export function EscalationBanner() {
  const { instances } = useInstance();
  const [escalations, setEscalations] = useState<EscalationRow[]>([]);

  useEffect(() => {
    fetchActiveEscalations().then(setEscalations);

    const channel = supabase
      .channel(`agent-escalations-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'flockbots_escalations',
      }, () => fetchActiveEscalations().then(setEscalations))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  if (escalations.length === 0) return null;

  // Map instance id → display name for the badge. Falls back to slug if
  // the instance was archived (still want to show the escalation).
  const instanceLabel = (id: string) => {
    const inst = instances.find((i) => i.id === id);
    return inst?.display_name || id;
  };

  // Two reply commands — /answer for regular escalations, /design_reply for
  // design-approval rows. The natural-language router handles the right
  // routing automatically, but slash commands are documented for power users.
  const hasRegular = escalations.some(e => e.task_status === 'awaiting_human');
  const hasDesign = escalations.some(e => e.task_status === 'awaiting_design_approval');

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <h2 className="text-sm font-medium text-amber-700 dark:text-amber-400">
          {escalations.length} item{escalations.length > 1 ? 's' : ''} awaiting human
        </h2>
      </div>
      <div className="space-y-2">
        {escalations.map((esc: any) => {
          const isDesign = esc.task_status === 'awaiting_design_approval';
          return (
            <div key={`${esc.instance_id}:${esc.id}`} className="text-xs">
              <span className="text-muted-foreground">
                [{instanceLabel(esc.instance_id)}] Task {esc.task_id}
                {isDesign ? ' · design approval' : ''}:
              </span>{' '}
              <span>{esc.question}</span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Reply via WhatsApp:
        {hasRegular && <> /answer {'{id}'} {'{your answer}'}</>}
        {hasRegular && hasDesign && <> · </>}
        {hasDesign && <> /design_reply {'{id}'} approved (or describe changes)</>}
      </p>
    </div>
  );
}
