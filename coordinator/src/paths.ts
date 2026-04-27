import { join } from 'path';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { homedir } from 'os';

/**
 * Root of the FlockBots config tree — `~/.flockbots/` by default. Holds
 * shared resources (state.json, agents/, skills-template/, scripts/) and
 * the `instances/` directory containing per-coordinator state.
 *
 * Resolution order:
 *   1. FLOCKBOTS_HOME env var  (preferred; set by the wizard)
 *   2. PROJECT_ROOT env var    (legacy, still honored)
 *   3. Default: ~/.flockbots
 *
 * Dev mode: set FLOCKBOTS_HOME explicitly when running outside an install.
 */
export function flockbotsRoot(): string {
  if (process.env.FLOCKBOTS_HOME) return process.env.FLOCKBOTS_HOME;
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  return join(homedir(), '.flockbots');
}

/** Directory holding all per-instance subdirectories. */
export function instancesDir(): string {
  return join(flockbotsRoot(), 'instances');
}

/**
 * The current coordinator's per-instance home, e.g.
 * `~/.flockbots/instances/acme-app/`. Required for any code that reads or
 * writes `.env`, the SQLite DB, tasks, logs, or GitHub App private keys.
 *
 * Throws if FLOCKBOTS_INSTANCE_ID is unset — runtime code must be explicit
 * about which instance it operates on.
 */
export function flockbotsInstanceHome(): string {
  const id = process.env.FLOCKBOTS_INSTANCE_ID;
  if (!id) {
    throw new Error(
      'FLOCKBOTS_INSTANCE_ID is not set. The coordinator must run inside an instance — ' +
      'use `flockbots start [-i <slug>]` or set FLOCKBOTS_INSTANCE_ID in the process env.'
    );
  }
  return join(instancesDir(), id);
}

/**
 * Back-compat alias: existing runtime callers (pipeline, session-manager,
 * queue) want the instance home. New code should prefer the explicit
 * flockbotsInstanceHome() / flockbotsRoot() pair.
 */
export function flockbotsHome(): string {
  return flockbotsInstanceHome();
}

export function dataDir(): string {
  return join(flockbotsInstanceHome(), 'data');
}

export function dbPath(): string {
  return join(dataDir(), 'flockbots.db');
}

export function tasksDir(): string {
  return process.env.TASKS_DIR || join(flockbotsInstanceHome(), 'tasks');
}

export function logsDir(): string {
  return join(flockbotsInstanceHome(), 'logs');
}

export function keysDir(): string {
  return join(flockbotsInstanceHome(), 'keys');
}

// Agent prompt templates are pipeline-stage prompts (researcher, dev,
// reviewer, etc.) that operate on the task description — repo-agnostic, so
// they live at the shared root.
export function agentsDir(): string {
  return join(flockbotsRoot(), 'agents');
}

// Skills are per-instance because some skills (notably kg) build a target-
// repo-specific knowledge graph; sharing one skills/ dir across instances
// would mean only the most-recently-built graph survives. The shared seed
// at <root>/skills-template/ is copied into each instance on creation.
export function skillsDir(): string {
  return join(flockbotsInstanceHome(), 'skills');
}

/** Enumerate registered instance slugs by scanning <root>/instances/. */
export function listInstanceSlugs(): string[] {
  const dir = instancesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Ensure runtime-state directories exist. Called once at coordinator startup. */
export function ensureStateDirs(): void {
  for (const dir of [dataDir(), tasksDir(), logsDir(), keysDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
