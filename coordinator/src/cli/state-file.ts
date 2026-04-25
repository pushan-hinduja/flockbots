import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Persistent, cross-run wizard state — deploy URLs, kg build time, last
 * reconfigure timestamp. Lives at ~/.flockbots/state.json (NOT .env, which
 * is runtime config). Shown back to the user at reconfigure time so they
 * don't have to remember their Vercel URLs.
 *
 * Lazy-written: only touched after a successful action (deploy, kg build,
 * reconfigure) — aborting the wizard leaves state.json unchanged.
 */
export interface FlockBotsState {
  /** Schema version for future migrations. */
  schemaVersion: number;
  /** ISO timestamp of the most recent successful reconfigure. */
  lastReconfiguredAt?: string;
  /** Public URL of the deployed Vercel dashboard (no trailing slash). */
  dashboardDeployUrl?: string;
  /** Public URL of the deployed webhook-relay (WhatsApp). */
  webhookRelayUrl?: string;
  /** ISO timestamp of the most recent successful knowledge-graph build. */
  knowledgeGraphBuiltAt?: string;
}

const SCHEMA_VERSION = 1;

function statePath(home: string): string {
  return join(home, 'state.json');
}

export function readState(home: string): FlockBotsState | null {
  const path = statePath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as FlockBotsState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Merge partial updates into the on-disk state file. Reads first so the
 * caller only has to specify the fields it actually changed.
 */
export function updateState(home: string, patch: Partial<FlockBotsState>): FlockBotsState {
  const current = readState(home) || { schemaVersion: SCHEMA_VERSION };
  const next: FlockBotsState = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };
  writeFileSync(statePath(home), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
