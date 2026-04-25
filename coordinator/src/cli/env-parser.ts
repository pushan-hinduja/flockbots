import { readFileSync } from 'fs';

/**
 * Parse a .env file in the exact format `buildEnvContent` emits:
 * KEY=VALUE, one per line, comments with `#`, blank lines ignored.
 * No quoting, no multi-line values, no interpolation — the wizard
 * owns both sides of this format, so we intentionally don't pull in
 * dotenv. Returns raw strings; caller decides how to coerce.
 */
export function parseEnvFile(path: string): Record<string, string> {
  const content = readFileSync(path, 'utf-8');
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1);
  }
  return out;
}
