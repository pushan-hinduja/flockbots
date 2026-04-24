import { useCallback, useSyncExternalStore } from 'react';
import { supabase } from '../supabase';
import { AGENT_DEFS } from '../office/engine';

/** Single row from flockbots_customizations. Any field may be null = use default. */
export interface AgentCustomization {
  agent_id: string;
  name: string | null;
  body_row: number | null;
  hair_row: number | null;
  suit_row: number | null;
  updated_at?: string;
}

/** Effective agent config (defaults from AGENT_DEFS + any overrides applied). */
export interface MergedAgent {
  id: string;
  name: string;
  role: string;
  bodyRow: number;
  hairRow: number;
  suitRow: number;
}

// Sprite option counts from sheet dimensions:
// character-body.png 768×192 = 6 rows; hairs.png 768×256 = 8; suit.png 768×128 = 4.
export const SPRITE_OPTION_COUNTS = { body: 6, hair: 8, suit: 4 };

// Coordinator-side agent role names can differ from the dashboard's character IDs.
// Right now only QA differs: coordinator writes events/streams under 'qa' but the
// dashboard has the character keyed 'test' (Zara). Any component looking up a
// character or filtering stream events by coordinator-role name should first run
// it through this alias so Zara lights up for QA work.
export const COORDINATOR_AGENT_ALIAS: Record<string, string> = {
  qa: 'test',
};

export function resolveDashboardAgentId(coordinatorAgent: string): string {
  return COORDINATOR_AGENT_ALIAS[coordinatorAgent] || coordinatorAgent;
}

function mergeOne(def: typeof AGENT_DEFS[number], custom?: AgentCustomization): MergedAgent {
  return {
    id: def.id,
    role: def.role,
    name: custom?.name ?? def.name,
    bodyRow: custom?.body_row ?? def.bodyRow,
    hairRow: custom?.hair_row ?? def.hairRow,
    suitRow: custom?.suit_row ?? def.suitRow,
  };
}

// ──────────────────────────────────────────────────────────────────
// Module-level store. Shared across every useAgentCustomizations()
// caller in the app so an optimistic save in one component propagates
// immediately to all others — even without Supabase realtime working.
// ──────────────────────────────────────────────────────────────────

let storeOverrides: Map<string, AgentCustomization> = new Map();
let storeLoaded = false;
let storeInitialized = false;
const storeListeners = new Set<() => void>();

/** Cached snapshots so useSyncExternalStore returns a stable reference when nothing changed. */
let cachedAgents: MergedAgent[] = AGENT_DEFS.map(def => mergeOne(def, undefined));
let cachedById: Record<string, MergedAgent> = Object.fromEntries(cachedAgents.map(a => [a.id, a]));
let cachedSnapshot = { agents: cachedAgents, byId: cachedById, loaded: storeLoaded };

function rebuildSnapshot() {
  cachedAgents = AGENT_DEFS.map(def => mergeOne(def, storeOverrides.get(def.id)));
  cachedById = Object.fromEntries(cachedAgents.map(a => [a.id, a]));
  cachedSnapshot = { agents: cachedAgents, byId: cachedById, loaded: storeLoaded };
}

function notify() {
  for (const fn of storeListeners) fn();
}

function subscribe(fn: () => void): () => void {
  storeListeners.add(fn);
  ensureInitialized();
  return () => { storeListeners.delete(fn); };
}

function ensureInitialized() {
  if (storeInitialized) return;
  storeInitialized = true;

  supabase.from('flockbots_customizations')
    .select('*')
    .then(({ data, error }: any) => {
      if (error) console.warn('Failed to load agent customizations:', error.message);
      const map = new Map<string, AgentCustomization>();
      for (const row of data || []) map.set(row.agent_id, row as AgentCustomization);
      storeOverrides = map;
      storeLoaded = true;
      rebuildSnapshot();
      notify();
    });

  // Realtime — best-effort. If the table isn't in the realtime publication,
  // we'll just never receive these events; optimistic updates handle the
  // single-tab case regardless.
  const channelName = `agent-customizations-store-${Math.random().toString(36).slice(2)}`;
  supabase
    .channel(channelName)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'flockbots_customizations',
    }, (payload: any) => {
      const next = new Map(storeOverrides);
      if (payload.eventType === 'DELETE') {
        if (payload.old?.agent_id) next.delete(payload.old.agent_id);
      } else {
        const row = payload.new as AgentCustomization;
        if (row?.agent_id) next.set(row.agent_id, row);
      }
      storeOverrides = next;
      rebuildSnapshot();
      notify();
    })
    .subscribe();
}

async function saveStore(agentId: string, patch: Partial<AgentCustomization>): Promise<void> {
  // Optimistic update: write to the shared store immediately so all consumers
  // re-render before the DB round-trip finishes.
  const snapshot = storeOverrides.get(agentId);
  const now = new Date().toISOString();
  const base: AgentCustomization = snapshot || {
    agent_id: agentId, name: null, body_row: null, hair_row: null, suit_row: null,
  };
  const merged: AgentCustomization = { ...base, ...patch, agent_id: agentId, updated_at: now };
  const nextMap = new Map(storeOverrides);
  nextMap.set(agentId, merged);
  storeOverrides = nextMap;
  rebuildSnapshot();
  notify();

  try {
    const { error } = await supabase
      .from('flockbots_customizations')
      .upsert({ agent_id: agentId, ...patch, updated_at: now });
    if (error) throw new Error(`Save failed: ${error.message}`);
  } catch (err) {
    // Roll back
    const revertMap = new Map(storeOverrides);
    if (snapshot) revertMap.set(agentId, snapshot);
    else revertMap.delete(agentId);
    storeOverrides = revertMap;
    rebuildSnapshot();
    notify();
    throw err;
  }
}

function getSnapshot() {
  return cachedSnapshot;
}

// ──────────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────────

/**
 * Subscribe to agent customization overrides. Returns the merged agent list
 * (AGENT_DEFS + overrides) plus a save helper. Dashboard components should
 * use this hook instead of importing AGENT_DEFS directly so user edits
 * propagate live across every consumer of the hook in the tree.
 */
export function useAgentCustomizations(): {
  agents: MergedAgent[];
  byId: Record<string, MergedAgent>;
  loaded: boolean;
  save: (agentId: string, patch: Partial<AgentCustomization>) => Promise<void>;
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const save = useCallback(saveStore, []);
  return { agents: snap.agents, byId: snap.byId, loaded: snap.loaded, save };
}
