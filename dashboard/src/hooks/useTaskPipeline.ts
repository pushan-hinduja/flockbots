import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

export function useTaskPipeline() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);

  useEffect(() => {
    const fetchTasks = () => {
      supabase.from('flockbots_tasks')
        .select('*')
        .order('updated_at', { ascending: false })
        .then(({ data, error }) => {
          if (error) console.error('Failed to load tasks:', error.message);
          setTasks(data || []);
          setTasksLoaded(true);
        });
    };

    fetchTasks();

    // Unique channel name — Supabase rejects re-subscribing the same channel,
    // so multiple mounts (or React StrictMode double-invoke) need distinct names.
    const channelName = `agent-tasks-${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'flockbots_tasks',
      }, (payload: any) => {
        setTasks(prev => {
          if (payload.eventType === 'DELETE') {
            return prev.filter(t => t.id !== payload.old?.id);
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
  }, []);

  return { tasks, tasksLoaded };
}
