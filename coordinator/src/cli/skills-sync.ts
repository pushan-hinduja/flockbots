import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Copy every file from <srcHome>/skills-template/ into <destHome>/skills/
 * that doesn't already exist there. Files already present are LEFT
 * UNTOUCHED so user customizations are never clobbered.
 *
 * Called from `flockbots init` (per-instance, on creation) and `flockbots
 * upgrade` (iterates instances so new template files propagate into each
 * one). Multi-instance: srcHome is the shared root (where skills-template
 * is git-tracked), destHome is the per-instance dir. Single-arg usage
 * (srcHome omitted) is preserved for callers that haven't been migrated
 * yet — falls back to destHome for both, matching the v1.0 layout.
 *
 * The skills/ directory itself is gitignored — this is what frees users
 * to edit it without blocking upgrades. The shipping defaults live in
 * skills-template/, which IS tracked and updated by `git pull`.
 */
export function ensureSkillsFromTemplate(
  destHome: string,
  srcHome?: string,
): { copied: string[]; skipped: string[] } {
  const templateDir = join(srcHome || destHome, 'skills-template');
  const activeDir = join(destHome, 'skills');
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(templateDir)) {
    // No template shipped (fresh clone pre-v1.0.2, or running against a
    // custom fork). Nothing to do.
    return { copied, skipped };
  }

  function walk(relPath: string): void {
    const srcPath = join(templateDir, relPath);
    const dstPath = join(activeDir, relPath);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      mkdirSync(dstPath, { recursive: true });
      for (const entry of readdirSync(srcPath)) {
        walk(join(relPath, entry));
      }
    } else if (st.isFile()) {
      if (existsSync(dstPath)) {
        skipped.push(relPath);
      } else {
        mkdirSync(dirname(dstPath), { recursive: true });
        copyFileSync(srcPath, dstPath);
        copied.push(relPath);
      }
    }
  }

  for (const entry of readdirSync(templateDir)) {
    walk(entry);
  }
  return { copied, skipped };
}
