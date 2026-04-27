import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { useInstance } from '../contexts/InstanceContext';

/**
 * A sub-agent clone that's currently "alive" — spawned by a parent agent via
 * the Agent tool (swarm mode) and not yet done.
 */
export interface ActiveSubAgent {
  parent_agent: string;   // pm | ux | dev | reviewer
  sub_name: string;       // coder | tester | security | code-analyzer | ...
  spawn_idx: number;
  tool_use_id: string;
  task_id: string;
  spawned_at: number;     // ms epoch
}

/**
 * Subscribe to flockbots_sub_agents realtime. Maintains a map of currently-active
 * spawns keyed by tool_use_id, so the PixelOffice can render clones next to
 * their parent's desk. A spawn without a matching done stays active; a done
 * event removes it. Force-done events (session cleanup) also remove.
 *
 * Only tracks rows newer than when the hook mounted, to avoid rendering
 * historical spawns as "live" after page refresh.
 */
export function useSubAgents(): ActiveSubAgent[] {
  const { selectedInstance } = useInstance();
  const [active, setActive] = useState<Map<string, ActiveSubAgent>>(new Map());

  useEffect(() => {
    if (!selectedInstance) {
      setActive(new Map());
      return;
    }
    // Reset when switching instances — spawns from a different instance
    // don't belong on the current office floor.
    setActive(new Map());
    const mountedAt = Date.now();

    const apply = (row: any) => {
      if (!row || !row.tool_use_id) return;
      // Ignore rows older than mount — they're historical, not "live"
      const rowTime = row.created_at ? new Date(row.created_at).getTime() : Date.now();
      if (rowTime < mountedAt - 5_000) return; // 5s grace for in-flight spawns

      setActive(prev => {
        const next = new Map(prev);
        if (row.kind === 'spawn') {
          next.set(row.tool_use_id, {
            parent_agent: row.parent_agent,
            sub_name: row.sub_name || 'sub-agent',
            spawn_idx: row.spawn_idx ?? 0,
            tool_use_id: row.tool_use_id,
            task_id: row.task_id,
            spawned_at: rowTime,
          });
        } else if (row.kind === 'done') {
          next.delete(row.tool_use_id);
        }
        return next;
      });
    };

    // Unique channel name per hook instance — Supabase rejects re-subscribing
    // to the same channel name, which breaks when multiple components mount
    // the hook or when React StrictMode double-invokes effects.
    const channelName = `agent-sub-agents-${selectedInstance}-${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'flockbots_sub_agents',
        filter: `instance_id=eq.${selectedInstance}`,
      }, (payload: any) => apply(payload.new))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [selectedInstance]);

  return Array.from(active.values());
}
