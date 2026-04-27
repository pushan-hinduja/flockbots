import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../supabase';

export interface Instance {
  id: string;
  display_name: string | null;
  target_repo: string;
  chat_provider: string | null;
  registered_at: string;
  last_seen_at: string | null;
  archived_at: string | null;
}

interface InstanceContextValue {
  /** All non-archived instances, sorted by id. */
  instances: Instance[];
  /** Currently-selected instance id. Null until instances load OR if none exist. */
  selectedInstance: string | null;
  setSelectedInstance: (id: string) => void;
  /** True after the first fetch resolves — components can show a skeleton until then. */
  loaded: boolean;
}

const InstanceContext = createContext<InstanceContextValue | null>(null);

const STORAGE_KEY = 'flockbots:selectedInstance';

/**
 * Provider that owns the active-instance state for the whole dashboard.
 * Persists the user's pick to localStorage so refreshes and tab opens
 * don't reset to the first instance. Subscribes to flockbots_instances
 * for live add/remove/heartbeat updates.
 */
export function InstanceProvider({ children }: { children: ReactNode }) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedInstance, setSelectedInstanceState] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const setSelectedInstance = useCallback((id: string) => {
    setSelectedInstanceState(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    const fetchInstances = async () => {
      const { data, error } = await supabase
        .from('flockbots_instances')
        .select('*')
        .is('archived_at', null)
        .order('id');
      if (error) {
        console.error('Failed to load instances:', error.message);
        setLoaded(true);
        return;
      }
      const rows = (data || []) as Instance[];
      setInstances(rows);

      // Choose initial selection: saved pick if it still exists, else first.
      // Only run the seed logic on first load — afterwards the user's
      // explicit pick wins.
      setSelectedInstanceState((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        let saved: string | null = null;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
        if (saved && rows.some((r) => r.id === saved)) return saved;
        return rows[0]?.id || null;
      });
      setLoaded(true);
    };
    fetchInstances();

    const channel = supabase
      .channel(`instances-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'flockbots_instances',
      }, () => fetchInstances())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return (
    <InstanceContext.Provider value={{ instances, selectedInstance, setSelectedInstance, loaded }}>
      {children}
    </InstanceContext.Provider>
  );
}

/** Read the active instance + setter. Throws if used outside the provider. */
export function useInstance(): InstanceContextValue {
  const ctx = useContext(InstanceContext);
  if (!ctx) throw new Error('useInstance must be used within InstanceProvider');
  return ctx;
}

/** Heartbeat-based online check — coordinator updates last_seen_at every 2 min. */
export function isInstanceOnline(inst: Instance): boolean {
  if (!inst.last_seen_at) return false;
  const ageMs = Date.now() - new Date(inst.last_seen_at).getTime();
  return ageMs < 5 * 60 * 1000;
}
