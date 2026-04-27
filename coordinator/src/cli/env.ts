import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { instancesDir } from '../paths';

/**
 * Parse <root>/instances/<slug>/.env into a plain map without touching
 * process.env. Used by doctor / instances / remove which need to inspect
 * per-instance values without the side-effects of loadEnvFile() (which
 * stamps process.env and is meant for the active instance only).
 */
export function readInstanceEnv(slug: string): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = join(instancesDir(), slug, '.env');
  if (!existsSync(envPath)) return out;
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      let value = line.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key) out[key] = value;
    }
  } catch {
    // Best effort
  }
  return out;
}

/**
 * Strip an `-i <slug>` (or `--instance <slug>`) pair out of args, returning
 * the slug and the remaining args. Pulled out of each command so a task
 * description like "add -i flag handling" doesn't get the flag stolen by a
 * naive parser — we only consume the pair when present at any position.
 *
 * Ambiguity is fine here: `flockbots task add -i acme "fix the -i flag"`
 * works because the inner -i is inside a quoted string, which the shell
 * already wrapped into one argv element.
 */
export function extractInstanceFlag(args: string[]): { instanceId?: string; rest: string[] } {
  const rest: string[] = [];
  let instanceId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-i' || a === '--instance') && i + 1 < args.length) {
      instanceId = args[i + 1];
      i++;
      continue;
    }
    rest.push(a);
  }
  return { instanceId, rest };
}

/**
 * Lightweight .env loader for CLI commands that run outside the pm2 wrapper.
 * Resolves to <root>/instances/<id>/.env where id is provided explicitly,
 * taken from FLOCKBOTS_INSTANCE_ID, or auto-picked when exactly one
 * instance exists.
 *
 * Existing process.env values win — we never overwrite anything explicitly
 * set by the user. Sets FLOCKBOTS_INSTANCE_ID itself before returning so
 * downstream paths.ts calls resolve correctly.
 *
 * Throws on an explicit but unknown slug so a typo errors helpfully here
 * instead of cascading into a confusing "missing env var" later.
 *
 * No-op (silent) when no instances exist yet — CLI commands that need an
 * instance should validate after calling.
 */
export function loadEnvFile(instanceId?: string): void {
  const instancesPath = instancesDir();

  let id = instanceId || process.env.FLOCKBOTS_INSTANCE_ID;
  if (!id) {
    if (!existsSync(instancesPath)) return;
    const slugs = readdirSync(instancesPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (slugs.length === 0) return;
    if (slugs.length === 1) {
      id = slugs[0];
    } else {
      throw new Error(
        `Multiple instances found (${slugs.join(', ')}). ` +
        'Pass `-i <slug>` or set FLOCKBOTS_INSTANCE_ID.'
      );
    }
  } else if (instanceId) {
    // Only validate when the slug came from a flag — env-derived ids may
    // legitimately point at an instance whose dir is being torn down.
    if (!existsSync(join(instancesPath, instanceId))) {
      const known = existsSync(instancesPath)
        ? readdirSync(instancesPath, { withFileTypes: true })
            .filter((d) => d.isDirectory()).map((d) => d.name)
        : [];
      throw new Error(
        `Unknown instance '${instanceId}'. ` +
        (known.length ? `Known: ${known.join(', ')}.` : 'No instances configured — run `flockbots init`.')
      );
    }
  }

  const envPath = join(instancesPath, id, '.env');
  if (!existsSync(envPath)) return;

  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      let value = line.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    if (!process.env.FLOCKBOTS_INSTANCE_ID) process.env.FLOCKBOTS_INSTANCE_ID = id;
  } catch {
    // Best effort — malformed .env shouldn't crash CLI invocation
  }
}
