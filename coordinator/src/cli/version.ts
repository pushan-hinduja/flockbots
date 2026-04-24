import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Walk up from __dirname looking for the flockbots-coordinator package.json.
 * Works in both dev (ts-node) and compiled (tsc output nested under dist/)
 * layouts without hard-coded relative counts.
 */
export function getVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
        if (pkg.name === 'flockbots-coordinator' && pkg.version) return pkg.version;
      } catch {
        // Ignore parse errors; keep walking up.
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}
