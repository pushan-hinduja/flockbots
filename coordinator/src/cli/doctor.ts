import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { runPrereqChecks } from './prereq';
import { loadEnvFile } from './env';
import { kgState } from './kg';
import { fg, COLORS, dim } from './brand';

/**
 * Diagnostic — prints the state of every external dependency and
 * configured integration. Read-only, safe to run anytime.
 */
export async function runDoctor(): Promise<void> {
  const p = await import('@clack/prompts');

  // Pull values from ~/.flockbots/.env into process.env so the config
  // section below reflects the wizard-written config when doctor runs in
  // a fresh shell (i.e. after init, before the coordinator starts).
  loadEnvFile();

  p.intro('FlockBots doctor');

  const tick = fg(COLORS.duck, '✓');
  const cross = fg(COLORS.bill, '✗');

  const checks = runPrereqChecks();
  const report = checks
    .map(c => `  ${c.ok ? tick : cross}  ${c.name.padEnd(16)} ${dim(c.detail)}`)
    .join('\n');
  p.note(report, 'Prerequisites');

  // Claude auth: either an API key is set, OR ~/.claude exists (Max OAuth
  // cache). `HOME` is always set on Unix so the prior check always passed.
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const hasClaudeDir = existsSync(join(homedir(), '.claude'));
  const claudeDetail = hasApiKey
    ? 'API key set'
    : hasClaudeDir
      ? 'Max OAuth (~/.claude present)'
      : 'not authenticated — run claude login';

  // Config presence
  const configSections = [
    { name: 'Claude auth', ok: hasApiKey || hasClaudeDir, detail: claudeDetail },
    { name: 'GitHub App (PR)', ok: !!process.env.GITHUB_APP_ID, detail: process.env.GITHUB_APP_ID ? `id=${process.env.GITHUB_APP_ID}` : 'not configured' },
    { name: 'GitHub App (Reviewer)', ok: !!process.env.REVIEWER_GITHUB_APP_ID, detail: process.env.REVIEWER_GITHUB_APP_ID ? `id=${process.env.REVIEWER_GITHUB_APP_ID}` : 'not configured' },
    { name: 'Target repo', ok: !!process.env.GITHUB_OWNER && !!process.env.GITHUB_REPO, detail: process.env.GITHUB_OWNER && process.env.GITHUB_REPO ? `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}` : 'not configured' },
    { name: 'Chat provider', ok: !!process.env.CHAT_PROVIDER, detail: process.env.CHAT_PROVIDER || 'not configured' },
    { name: 'Supabase (dashboard)', ok: !!process.env.SUPABASE_URL, detail: process.env.SUPABASE_URL ? 'configured' : 'optional, not set (CLI-only mode)' },
    { name: 'Linear', ok: !!process.env.LINEAR_API_KEY, detail: process.env.LINEAR_API_KEY ? 'configured' : 'optional, not set' },
    { name: 'QA agent', ok: process.env.QA_ENABLED === 'true', detail: process.env.QA_ENABLED === 'true' ? 'enabled' : 'disabled' },
  ];

  const kg = kgState();
  const kgDetail = !kg.graphifyInstalled
    ? 'graphify not installed — agents will use grep'
    : !kg.graphExists
      ? 'graphify installed but no graph yet — run `flockbots kg build`'
      : kg.graphAgeDays !== null
        ? `built ${kg.graphAgeDays === 0 ? 'today' : `${kg.graphAgeDays}d ago`}`
        : 'built';
  configSections.push({
    name: 'Knowledge graph',
    ok: kg.graphExists,
    detail: kgDetail,
  });

  const bullet = fg(COLORS.dim, '·');
  const cfgReport = configSections
    .map(c => `  ${c.ok ? tick : bullet}  ${c.name.padEnd(22)} ${dim(c.detail)}`)
    .join('\n');
  p.note(cfgReport, 'Configuration');

  const reqMissing = checks.filter(c => !c.ok && c.required);
  if (reqMissing.length > 0) {
    p.outro(`${reqMissing.length} required prerequisite(s) missing — fix and re-run.`);
    process.exit(1);
  }
  p.outro('All required prerequisites present.');
}
