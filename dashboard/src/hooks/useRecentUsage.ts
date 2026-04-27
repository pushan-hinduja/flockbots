import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { useInstance } from '../contexts/InstanceContext';

export interface UsageRow {
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  agent: string | null;
  model: string | null;
}

/** Last N hours of flockbots_usage rows for the selected instance, used to
 *  drive ticker sparklines. */
export function useRecentUsage(hours: number = 4) {
  const { selectedInstance } = useInstance();
  const [rows, setRows] = useState<UsageRow[]>([]);

  useEffect(() => {
    if (!selectedInstance) {
      setRows([]);
      return;
    }
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    supabase.from('flockbots_usage')
      .select('created_at, input_tokens, output_tokens, agent, model')
      .eq('instance_id', selectedInstance)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000)
      .then(({ data, error }) => {
        if (error) console.error('Failed to load recent usage:', error.message);
        setRows((data as UsageRow[]) || []);
      });

    const channel = supabase
      .channel(`agent-usage-recent-${selectedInstance}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'flockbots_usage',
        filter: `instance_id=eq.${selectedInstance}`,
      }, (payload: any) => {
        setRows(prev => [payload.new as UsageRow, ...prev].slice(0, 2000));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [hours, selectedInstance]);

  return rows;
}
