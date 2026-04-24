import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';

export function useUsageMetrics() {
  const [usage, setUsage] = useState<any[]>([]);
  const [health, setHealth] = useState<Record<string, any>>({});

  const refreshHealth = useCallback(() => {
    supabase.from('flockbots_system_health')
      .select('*')
      .then(({ data, error }) => {
        if (error) console.error('Failed to load health:', error.message);
        const healthMap: Record<string, any> = {};
        data?.forEach((row: any) => {
          // Supabase auto-deserializes JSONB, so row.value is already an object
          healthMap[row.key] = typeof row.value === 'string'
            ? (() => { try { return JSON.parse(row.value); } catch { return row.value; } })()
            : row.value;
        });
        setHealth(healthMap);
      });
  }, []);

  useEffect(() => {
    supabase.from('flockbots_usage')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) console.error('Failed to load usage:', error.message);
        setUsage(data || []);
      });

    refreshHealth();

    // Poll health every 60s as a fallback in case the realtime channel drops
    const pollInterval = setInterval(refreshHealth, 60_000);

    const channel = supabase
      .channel('agent-health')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'flockbots_system_health',
      }, (payload: any) => {
        if (!payload.new) return; // Guard against DELETE events
        const val = typeof payload.new.value === 'string'
          ? (() => { try { return JSON.parse(payload.new.value); } catch { return payload.new.value; } })()
          : payload.new.value;
        setHealth(prev => ({ ...prev, [payload.new.key]: val }));
      })
      .subscribe();

    return () => {
      clearInterval(pollInterval);
      supabase.removeChannel(channel);
    };
  }, [refreshHealth]);

  return { usage, health, refreshHealth };
}
