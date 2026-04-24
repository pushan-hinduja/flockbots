import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase';

interface StreamChunk {
  id: number;
  chunk: string;
  created_at: string;
}

// How many recent chunks to fetch when the modal opens — enough for context
// but capped so we don't render a huge scroll buffer.
const HISTORY_LIMIT = 200;
// Only include history from the last N ms — longer ago than this is almost
// certainly a prior session, not relevant to the currently running agent.
const HISTORY_WINDOW_MS = 30 * 60 * 1000;

export function useAgentStream(taskId: string, agentId: string) {
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoaded(false);
    setChunks([]);
    const since = new Date(Date.now() - HISTORY_WINDOW_MS).toISOString();

    // Fetch the most recent chunks DESC (cheap with an index), reverse to
    // chronological order for display. Gives instant context on modal open
    // instead of waiting for the next live chunk — which could be 20-30s
    // during agent thinking/tool phases.
    supabase.from('flockbots_stream_log')
      .select('id, chunk, created_at')
      .eq('task_id', taskId)
      .eq('agent', agentId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)
      .then(({ data, error }) => {
        if (error) {
          console.error('Failed to load stream:', error.message);
          setConnected(false);
        } else {
          const ordered = (data as StreamChunk[] || []).slice().reverse();
          setChunks(ordered);
          setConnected(true);
        }
        setLoaded(true);
      });

    const channel = supabase
      .channel(`stream-${taskId}-${agentId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'flockbots_stream_log',
        filter: `task_id=eq.${taskId}`,
      }, (payload: any) => {
        if (payload.new.agent === agentId) {
          setChunks(prev => {
            // Guard against dupes if realtime echoes a row we also fetched
            if (prev.some(c => c.id === payload.new.id)) return prev;
            return [...prev, payload.new as StreamChunk];
          });
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [taskId, agentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chunks.length]);

  return { chunks, connected, loaded, bottomRef };
}
