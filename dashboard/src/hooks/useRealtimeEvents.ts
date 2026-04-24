import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

export function useRealtimeEvents(limit: number = 50) {
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    const fetchEvents = () => {
      supabase.from('flockbots_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)
        .then(({ data, error }) => {
          if (error) console.error('Failed to load events:', error.message);
          setEvents(data || []);
        });
    };

    fetchEvents();

    const channelName = `agent-events-${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'flockbots_events',
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
  }, [limit]);

  return events;
}
