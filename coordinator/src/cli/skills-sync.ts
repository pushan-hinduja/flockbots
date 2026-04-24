import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Populate FLOCKBOTS_HOME/skills/ from FLOCKBOTS_HOME/skills-template/
 * by copying every file that doesn't already exist in the target. Files
 * already present in skills/ are LEFT UNTOUCHED so user customizations
 * are never clobbered.
 *
 * Called from both `flockbots init` (first-time setup) and `flockbots
 * upgrade` (so new template files shipped upstream propagate into the
 * user's active skills/ dir without overwriting their edits).
 *
 * The skills/ directory itself is gitignored — this is what frees users
 * to edit it without blocking upgrades. The shipping defaults live in
 * skills-template/, which IS tracked and updated by `git pull`.
 */
export function ensureSkillsFromTemplate(home: string): { copied: string[]; skipped: string[] } {
  const templateDir = join(home, 'skills-template');
  const activeDir = join(home, 'skills');
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
