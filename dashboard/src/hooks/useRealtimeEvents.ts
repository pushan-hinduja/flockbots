import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { useInstance } from '../contexts/InstanceContext';

export function useRealtimeEvents(limit: number = 50) {
  const { selectedInstance } = useInstance();
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    if (!selectedInstance) {
      setEvents([]);
      return;
    }

    // Clear before re-fetch so a switch from acme → my-blog doesn't briefly
    // render acme's events under the my-blog header.
    setEvents([]);

    const fetchEvents = () => {
      supabase.from('flockbots_events')
        .select('*')
        .eq('instance_id', selectedInstance)
        .order('created_at', { ascending: false })
        .limit(limit)
        .then(({ data, error }) => {
          if (error) console.error('Failed to load events:', error.message);
          setEvents(data || []);
        });
    };

    fetchEvents();

    const channelName = `agent-events-${selectedInstance}-${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'flockbots_events',
        filter: `instance_id=eq.${selectedInstance}`,
      }, (payload: any) => {
        setEvents(prev => [payload.new, ...prev].slice(0, limit));
      })
      .subscribe();

    // Refresh on tab/window focus so we never show stale events after returning
    // from a backgrounded tab. Supabase realtime can miss or buffer inserts
    // while the tab is hidden; a fresh query guarantees we caught up.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchEvents();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', fetchEvents);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', fetchEvents);
      supabase.removeChannel(channel);
    };
  }, [limit, selectedInstance]);

  return events;
}
