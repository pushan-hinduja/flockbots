import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { useInstance } from '../contexts/InstanceContext';

/** Fetch every event from the last 24 hours and subscribe to new inserts.
 *  Used to drive the activity heatmap. Scoped to the selected instance. */
export function useEventsLast24h() {
  const { selectedInstance } = useInstance();
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    if (!selectedInstance) {
      setEvents([]);
      return;
    }
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    supabase.from('flockbots_events')
      .select('agent, event_type, created_at')
      .eq('instance_id', selectedInstance)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000)
      .then(({ data, error }) => {
        if (error) console.error('Failed to load 24h events:', error.message);
        setEvents(data || []);
      });

    const channel = supabase
      .channel(`agent-events-24h-${selectedInstance}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'flockbots_events',
        filter: `instance_id=eq.${selectedInstance}`,
      }, (payload: any) => {
        setEvents(prev => [payload.new, ...prev].slice(0, 5000));
      })
      .subscribe();

    // Refresh the 24h window every 15 minutes so old events age out.
    const interval = setInterval(() => {
      const cutoff = Date.now() - 24 * 3600 * 1000;
      setEvents(prev => prev.filter(e => new Date(e.created_at).getTime() > cutoff));
    }, 15 * 60 * 1000);

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [selectedInstance]);

  return events;
}
