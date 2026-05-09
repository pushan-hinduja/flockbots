import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { useInstance } from '../contexts/InstanceContext';

export function useTaskPipeline() {
  const { selectedInstance } = useInstance();
  const [tasks, setTasks] = useState<any[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);

  useEffect(() => {
    // No instance picked yet — render empty until the context resolves.
    if (!selectedInstance) {
      setTasks([]);
      setTasksLoaded(true);
      return;
    }

    // Clear before re-fetch so a switch from acme → my-blog doesn't briefly
    // render acme's tasks under the my-blog header (50–200ms flash).
    setTasks([]);
    setTasksLoaded(false);

    const fetchTasks = () => {
      // Exclude dismissed tasks at the query level — they're functionally
      // deleted and never need to render anywhere in the UI. Defense-in-
      // depth against stale rows that didn't get sync'd properly: even if
      // dismissTask never reached Supabase for some reason, the dashboard
      // still won't surface dismissed tasks to the operator.
      supabase.from('flockbots_tasks')
        .select('*')
        .eq('instance_id', selectedInstance)
        .neq('status', 'dismissed')
        .order('updated_at', { ascending: false })
        .then(({ data, error }) => {
          if (error) console.error('Failed to load tasks:', error.message);
          setTasks(data || []);
          setTasksLoaded(true);
        });
    };

    fetchTasks();

    // Realtime filter: instance_id=eq.<slug> means we only receive events
    // for this instance's tasks, not the whole flock — switching instances
    // tears down + re-subscribes via the dependency array.
    const channelName = `agent-tasks-${selectedInstance}-${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'flockbots_tasks',
        filter: `instance_id=eq.${selectedInstance}`,
      }, (payload: any) => {
        setTasks(prev => {
          if (payload.eventType === 'DELETE') {
            return prev.filter(t => t.id !== payload.old?.id);
          }
          // When a realtime UPDATE arrives flipping a task to 'dismissed',
          // remove it from state instead of merging it back in. Mirrors the
          // query-level filter so dismiss disappears the task instantly
          // without waiting for the next fetchTasks / page reload.
          if (payload.new?.status === 'dismissed') {
            return prev.filter(t => t.id !== payload.new.id);
          }
          const updated = prev.filter(t => t.id !== payload.new?.id);
          if (payload.new) updated.unshift(payload.new);
          return updated;
        });
      })
      .subscribe();

    // When the tab becomes visible again, re-fetch. Browsers pause rAF and
    // WebSocket events can drop or buffer while the tab is backgrounded —
    // a fresh query guarantees we're looking at reality on return.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchTasks();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Same treatment for window focus — covers cases where visibilitychange
    // doesn't fire (e.g. switching Mac windows without hiding the tab).
    window.addEventListener('focus', fetchTasks);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', fetchTasks);
      supabase.removeChannel(channel);
    };
  }, [selectedInstance]);

  return { tasks, tasksLoaded };
}
