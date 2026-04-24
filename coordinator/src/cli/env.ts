import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Lightweight .env loader for CLI commands that run outside the pm2 wrapper.
 * Checks FLOCKBOTS_HOME/.env, then ~/.flockbots/.env. Existing process.env
 * values win — won't overwrite anything explicitly set by the user.
 */
export function loadEnvFile(): void {
  const candidates: string[] = [];
  if (process.env.FLOCKBOTS_HOME) candidates.push(join(process.env.FLOCKBOTS_HOME, '.env'));
  candidates.push(join(homedir(), '.flockbots', '.env'));

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
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
      return;
    } catch {
      // Try next candidate
    }
  }
}
