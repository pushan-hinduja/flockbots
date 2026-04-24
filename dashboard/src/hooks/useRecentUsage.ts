import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

export interface UsageRow {
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  agent: string | null;
  model: string | null;
}

/** Last N hours of flockbots_usage rows, used to drive ticker sparklines. */
export function useRecentUsage(hours: number = 4) {
  const [rows, setRows] = useState<UsageRow[]>([]);

  useEffect(() => {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    supabase.from('flockbots_usage')
      .select('created_at, input_tokens, output_tokens, agent, model')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000)
      .then(({ data, error }) => {
        if (error) console.error('Failed to load recent usage:', error.message);
        setRows((data as UsageRow[]) || []);
      });

    const channel = supabase
      .channel('agent-usage-recent')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'flockbots_usage',
      }, (payload: any) => {
        setRows(prev => [payload.new as UsageRow, ...prev].slice(0, 2000));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [hours]);

  return rows;
}
