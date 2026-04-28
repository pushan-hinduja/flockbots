import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { listInstanceSlugs, instancesDir } from '../paths';

type ClackModule = typeof import('@clack/prompts');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export type InstancePickerResult =
  | { action: 'create' }
  | { action: 'reconfigure'; slug: string }
  | { action: 'reconfigure-shared' }
  | { action: 'cancel' };

/**
 * Top-level instance picker — runs at the start of `flockbots init` to
 * decide whether the user is creating a new instance or reconfiguring an
 * existing one. Shape depends on N:
 *
 *   N=0: skip picker, return { action: 'create' } directly.
 *   N=1: simple choice — reconfigure the only instance, or add another.
 *   N>=2: pick the instance to reconfigure, or add another.
 *
 * The "Reconfigure shared settings" shortcut (for N>=2 cross-cutting
 * edits to Supabase / dashboard URL / webhook relay) lands in 4b — for
 * now, shared edits go through any instance's per-instance reconfigure
 * flow, which then propagates across all instances.
 */
export async function pickInstanceFlow(p: ClackModule): Promise<InstancePickerResult> {
  const slugs = listInstanceSlugs();

  if (slugs.length === 0) {
    return { action: 'create' };
  }

  if (slugs.length === 1) {
    const choice = await p.select({
      message: `Existing instance found: '${slugs[0]}'. What do you want to do?`,
      options: [
        { value: 'reconfigure', label: `Reconfigure '${slugs[0]}'`, hint: 'recommended — edit just what you need' },
        { value: 'create',      label: 'Add a new instance', hint: 'spin up a second coordinator on a different repo' },
        { value: 'cancel',      label: 'Cancel' },
      ],
      initialValue: 'reconfigure',
    });
    if (p.isCancel(choice) || choice === 'cancel') return { action: 'cancel' };
    if (choice === 'create') return { action: 'create' };
    return { action: 'reconfigure', slug: slugs[0] };
  }

  // N >= 2: full picker
  const top = await p.select({
    message: `${slugs.length} instances configured. What do you want to do?`,
    options: [
      { value: 'reconfigure-instance', label: 'Reconfigure an instance' },
      { value: 'reconfigure-shared',   label: 'Reconfigure shared settings', hint: 'Supabase, dashboard URL — affects all instances' },
      { value: 'create',               label: 'Add a new instance' },
      { value: 'cancel',               label: 'Cancel' },
    ],
    initialValue: 'reconfigure-instance',
  });
  if (p.isCancel(top) || top === 'cancel') return { action: 'cancel' };
  if (top === 'create') return { action: 'create' };
  if (top === 'reconfigure-shared') return { action: 'reconfigure-shared' };

  const targets = readTargetReposBySlug();
  const slug = await p.select({
    message: 'Which instance?',
    options: slugs.map((s) => ({
      value: s,
      label: targets.has(s) ? `${s}  (${targets.get(s)})` : s,
    })),
  });
  if (p.isCancel(slug)) return { action: 'cancel' };
  return { action: 'reconfigure', slug: slug as string };
}

/**
 * Prompt for a slug for a new instance. Defaults to `flock-N` where N is
 * the next free integer — short, friendly, and avoids leaking the GitHub
 * owner/repo into a path users see often. The `defaultFrom` arg is kept
 * for callers that want to override (currently unused). Validates
 * [a-z0-9-]{2,32}, no leading/trailing hyphen, uniqueness.
 */
export async function askNewInstanceSlug(
  p: ClackModule,
  defaultFrom?: string,
): Promise<string | null> {
  const existing = new Set(listInstanceSlugs());
  const initialValue = defaultFrom ? slugify(defaultFrom) : nextFlockSlug(existing);

  const slug = await p.text({
    message: 'Slug for this instance (lowercase letters, digits, hyphens; 2–32 chars):',
    initialValue,
    placeholder: 'e.g. flock-1',
    validate: (v) => {
      const t = v.trim();
      if (!t) return 'Required';
      if (t.length < 2 || t.length > 32) return 'Use 2–32 characters';
      if (!SLUG_RE.test(t)) return 'a–z, 0–9, hyphens only; no leading/trailing hyphen';
      if (existing.has(t)) return `Instance '${t}' already exists`;
      return undefined;
    },
  });
  if (p.isCancel(slug)) return null;
  return (slug as string).trim();
}

/**
 * Pick the next free `flock-N` — counts from existing.size + 1, but
 * iterates if a removed-and-re-added slug leaves a hole (e.g. flock-2
 * exists but flock-1 was removed).
 */
function nextFlockSlug(existing: Set<string>): string {
  let n = existing.size + 1;
  while (existing.has(`flock-${n}`)) n += 1;
  return `flock-${n}`;
}

/**
 * Read GITHUB_OWNER + GITHUB_REPO from each existing instance's .env so
 * the wizard can block creating a new instance pointing at a target repo
 * that's already claimed by an active instance.
 */
export function readTargetReposBySlug(): Map<string, string> {
  const map = new Map<string, string>();
  for (const slug of listInstanceSlugs()) {
    const envPath = join(instancesDir(), slug, '.env');
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      let owner = '';
      let repo = '';
      for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/\r$/, '').trim();
        const m = line.match(/^(GITHUB_OWNER|GITHUB_REPO)\s*=\s*(.*)$/);
        if (!m) continue;
        let val = m[2].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (m[1] === 'GITHUB_OWNER') owner = val;
        else repo = val;
      }
      if (owner && repo) map.set(slug, `${owner}/${repo}`);
    } catch {
      // Skip unreadable .env — defensive only
    }
  }
  return map;
}

/**
 * Returns the slug of an existing active instance already targeting
 * owner/repo, or null if none. Caller decides whether to error or
 * suggest reconfigure.
 */
export function findInstanceForTarget(owner: string, repo: string): string | null {
  const target = `${owner}/${repo}`;
  for (const [slug, t] of readTargetReposBySlug().entries()) {
    if (t === target) return slug;
  }
  return null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
