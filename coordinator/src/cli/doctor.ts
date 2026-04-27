import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { runPrereqChecks } from './prereq';
import { extractInstanceFlag, readInstanceEnv } from './env';
import { kgState } from './kg';
import { listInstanceSlugs } from '../paths';
import { fg, COLORS, dim } from './brand';

/**
 * Diagnostic — prints prerequisites once, then a configuration block per
 * instance. Read-only, safe to run anytime. Accepts `-i <slug>` to limit
 * the configuration block to a single instance; otherwise shows all.
 */
export async function runDoctor(args: string[] = []): Promise<void> {
  const p = await import('@clack/prompts');
  const { instanceId } = extractInstanceFlag(args);

  p.intro('FlockBots doctor');

  const tick = fg(COLORS.duck, '✓');
  const cross = fg(COLORS.bill, '✗');
  const bullet = fg(COLORS.dim, '·');

  // ----- Prereqs (global) ---------------------------------------------------
  const checks = runPrereqChecks();
  const prereqReport = checks
    .map(c => `  ${c.ok ? tick : cross}  ${c.name.padEnd(16)} ${dim(c.detail)}`)
    .join('\n');
  p.note(prereqReport, 'Prerequisites');

  // Claude auth doesn't need an instance — check globally.
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const hasClaudeDir = existsSync(join(homedir(), '.claude'));

  // ----- Per-instance configuration -----------------------------------------
  const allSlugs = listInstanceSlugs();

  if (allSlugs.length === 0) {
    p.note('  no instances configured — run `flockbots init`', 'Configuration');
    p.outro('All required prerequisites present. Run `flockbots init` to configure.');
    return;
  }

  let slugs: string[];
  if (instanceId) {
    if (!allSlugs.includes(instanceId)) {
      p.cancel(`Unknown instance '${instanceId}'. Known: ${allSlugs.join(', ')}.`);
      process.exit(1);
    }
    slugs = [instanceId];
  } else {
    slugs = allSlugs;
  }

  for (const slug of slugs) {
    const env = readInstanceEnv(slug);
    const sections = [
      {
        name: 'Claude auth',
        ok: hasApiKey || hasClaudeDir || !!env.ANTHROPIC_API_KEY,
        detail: env.ANTHROPIC_API_KEY ? 'API key set'
              : hasApiKey ? 'API key set (env)'
              : hasClaudeDir ? 'Max OAuth (~/.claude present)'
              : 'not authenticated — run claude login',
      },
      { name: 'GitHub App (PR)',       ok: !!env.GITHUB_APP_ID,           detail: env.GITHUB_APP_ID          ? `id=${env.GITHUB_APP_ID}`          : 'not configured' },
      { name: 'GitHub App (Reviewer)', ok: !!env.REVIEWER_GITHUB_APP_ID,  detail: env.REVIEWER_GITHUB_APP_ID ? `id=${env.REVIEWER_GITHUB_APP_ID}` : 'not configured' },
      { name: 'Target repo',           ok: !!env.GITHUB_OWNER && !!env.GITHUB_REPO, detail: env.GITHUB_OWNER && env.GITHUB_REPO ? `${env.GITHUB_OWNER}/${env.GITHUB_REPO}` : 'not configured' },
      { name: 'Chat provider',         ok: !!env.CHAT_PROVIDER,           detail: env.CHAT_PROVIDER || 'not configured' },
      { name: 'Supabase (dashboard)',  ok: !!env.SUPABASE_URL,            detail: env.SUPABASE_URL ? 'configured' : 'optional, not set (CLI-only mode)' },
      { name: 'Linear',                ok: !!env.LINEAR_API_KEY,          detail: env.LINEAR_API_KEY ? 'configured' : 'optional, not set' },
      { name: 'QA agent',              ok: env.QA_ENABLED === 'true',     detail: env.QA_ENABLED === 'true' ? 'enabled' : 'disabled' },
    ];

    // Knowledge graph state is per-instance — kgState() reads skillsDir()
    // which depends on FLOCKBOTS_INSTANCE_ID. Set+restore so we can probe
    // each instance independently in the same process.
    const prevId = process.env.FLOCKBOTS_INSTANCE_ID;
    process.env.FLOCKBOTS_INSTANCE_ID = slug;
    try {
      const kg = kgState();
      const kgDetail = !kg.graphifyInstalled
        ? 'graphify not installed — agents will use grep'
        : !kg.graphExists
          ? 'graphify installed but no graph yet — run `flockbots kg build`'
          : kg.graphAgeDays !== null
            ? `built ${kg.graphAgeDays === 0 ? 'today' : `${kg.graphAgeDays}d ago`}`
            : 'built';
      sections.push({ name: 'Knowledge graph', ok: kg.graphExists, detail: kgDetail });
    } finally {
      if (prevId === undefined) delete process.env.FLOCKBOTS_INSTANCE_ID;
      else process.env.FLOCKBOTS_INSTANCE_ID = prevId;
    }

    const cfgReport = sections
      .map(c => `  ${c.ok ? tick : bullet}  ${c.name.padEnd(22)} ${dim(c.detail)}`)
      .join('\n');
    p.note(cfgReport, `Configuration — ${slug}`);
  }

  const reqMissing = checks.filter(c => !c.ok && c.required);
  if (reqMissing.length > 0) {
    p.outro(`${reqMissing.length} required prerequisite(s) missing — fix and re-run.`);
    process.exit(1);
  }
  p.outro('All required prerequisites present.');
}
