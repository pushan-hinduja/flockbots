import { join, resolve } from 'path';
import { existsSync, mkdirSync, renameSync } from 'fs';

/**
 * Root directory for FlockBots — contains both the installed code
 * (agents/, skills/) and the runtime state (data/, tasks/, logs/, keys/).
 *
 * Resolution order:
 *   1. FLOCKBOTS_HOME env var  (preferred; set by the wizard)
 *   2. PROJECT_ROOT env var    (legacy, still honored)
 *   3. Dev fallback: repo root via __dirname
 *
 * For production deployments, set FLOCKBOTS_HOME explicitly. The wizard
 * writes it into .env during `flockbots init`.
 */
export function flockbotsHome(): string {
  if (process.env.FLOCKBOTS_HOME) return process.env.FLOCKBOTS_HOME;
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  return resolve(__dirname, '..', '..');
}

export function dataDir(): string {
  return join(flockbotsHome(), 'data');
}

export function dbPath(): string {
  return join(dataDir(), 'flockbots.db');
}

export function tasksDir(): string {
  return process.env.TASKS_DIR || join(flockbotsHome(), 'tasks');
}

export function logsDir(): string {
  return join(flockbotsHome(), 'logs');
}

export function keysDir(): string {
  return join(flockbotsHome(), 'keys');
}

export function agentsDir(): string {
  return join(flockbotsHome(), 'agents');
}

export function skillsDir(): string {
  return join(flockbotsHome(), 'skills');
}

/** Ensure runtime-state directories exist. Called once at startup. */
export function ensureStateDirs(): void {
  for (const dir of [dataDir(), tasksDir(), logsDir(), keysDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * One-time rename: legacy orchestrator.db → flockbots.db. Safe to call every
 * startup; no-op unless a legacy file is present and the new name is free.
 * Includes WAL/SHM sidecar files.
 */
export function migrateLegacyDb(): void {
  const oldPath = join(dataDir(), 'orchestrator.db');
  const newPath = dbPath();
  if (!existsSync(newPath) && existsSync(oldPath)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const old = oldPath + suffix;
      if (existsSync(old)) renameSync(old, newPath + suffix);
    }
    console.log('[paths] migrated orchestrator.db → flockbots.db');
  }
}
