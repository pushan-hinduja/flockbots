import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import simpleGit from 'simple-git';
import { runPrereqChecks, offerPm2Install } from './prereq';
import { createGitHubApp, findReusableApps, openBrowser, type GitHubAppExisting } from './wizard-github';
import { runKgBuild } from './kg';
import { renderBanner, help } from './brand';
import { ensureSkillsFromTemplate } from './skills-sync';
import {
  ALL_SECTIONS,
  detectExistingConfig,
  expandDependencies,
  isSharedSection,
  pickSectionsToReconfigure,
  type ReconfigureSection,
} from './reconfigure';
import { updateState } from './state-file';
import { instancesDir, listInstanceSlugs } from '../paths';
import {
  pickInstanceFlow,
  askNewInstanceSlug,
  findInstanceForTarget,
} from './wizard-instances';
import { askLinear as askLinearWithProject } from './wizard-linear';

/**
 * Partial configuration built up across wizard steps. Persisted to the
 * .env file in the finalize step.
 */
export interface WizardConfig {
  claudeAuth: 'max' | 'api_key';
  anthropicApiKey?: string;
  targetRepoPath: string;
  chatProvider: 'telegram' | 'whatsapp' | 'slack';
  telegramBotToken?: string;
  telegramChatId?: string;
  whatsappPhoneNumberId?: string;
  whatsappAccessToken?: string;
  whatsappVerifyToken?: string;
  whatsappAppSecret?: string;
  operatorWhatsappNumber?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackChannelId?: string;
  githubAppId?: number;
  githubAppPrivateKeyPath?: string;
  githubAppInstallationId?: number;
  reviewerGithubAppId?: number;
  reviewerGithubAppPrivateKeyPath?: string;
  reviewerGithubAppInstallationId?: number;
  githubOwner?: string;
  githubRepo?: string;
  githubStagingBranch?: string;
  githubProdBranch?: string;
  linearApiKey?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  linearProjectName?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseAnonKey?: string;
  /** Admin email for the dashboard login (written to auth.users by the bootstrap SQL). */
  dashboardAdminEmail?: string;
  /** Admin password, held in memory only for the wizard run — never persisted. */
  dashboardAdminPassword?: string;
  qaEnabled: boolean;
  stagingBaseUrl?: string;
  qaTestEmail?: string;
  qaTestPassword?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Interactive setup wizard for FlockBots. Multi-instance: opens with a
 * picker that decides whether the user is creating a NEW instance or
 * RECONFIGURING an existing one. Each instance is its own coordinator
 * pointed at one target repo, with its own .env at
 * `<root>/instances/<slug>/.env` and its own keys/, data/, tasks/, logs/.
 *
 * Shared state (Supabase URL/keys, dashboard URL, webhook relay URL) is
 * duplicated across every instance's .env — when the user edits a shared
 * section in one instance's reconfigure flow, the wizard propagates the
 * new values into every other instance.
 */
export async function runWizard(): Promise<void> {
  // Anchor FLOCKBOTS_HOME (the flock root) before any downstream path
  // helper runs. Per-instance state lives at <root>/instances/<slug>/.
  if (!process.env.FLOCKBOTS_HOME) {
    process.env.FLOCKBOTS_HOME = wizardRoot();
  }
  const root = process.env.FLOCKBOTS_HOME as string;

  const p = await import('@clack/prompts');

  // Branded banner — pixel duck + FLOCKBOTS wordmark + tagline. Prints
  // before clack takes over so it sits above the framed intro box.
  process.stdout.write(renderBanner() + '\n');
  p.intro('FlockBots setup');

  // ----- Instance picker ----------------------------------------------------
  const picked = await pickInstanceFlow(p);
  if (picked.action === 'cancel') {
    return cancelAndExit(p, 'Setup cancelled. Re-run `flockbots init` anytime.');
  }

  // Shared-settings shortcut: anchor to the first instance, run only the
  // shared sections, propagate after. The user's intent is "edit Supabase /
  // dashboard for the whole flock at once" — they don't care which instance
  // we use as the write target.
  if (picked.action === 'reconfigure-shared') {
    const slugs = listInstanceSlugs();
    if (slugs.length === 0) {
      p.cancel('No instances to reconfigure.');
      return;
    }
    const anchorSlug = slugs[0];
    process.env.FLOCKBOTS_INSTANCE_ID = anchorSlug;
    p.note(
      help([
        `Anchoring to '${anchorSlug}' — values you set will propagate to`,
        `all ${slugs.length} instances after save.`,
      ].join('\n')),
      'Reconfigure shared settings'
    );
    // Falls through into the main reconfigure flow with sectionsToRun
    // pre-set to just the shared sections.
    return runSharedReconfigure(p, root, anchorSlug);
  }

  // For 'reconfigure' the slug is known up front. For 'create' the slug is
  // asked after the target-repo step (so we can default it from owner/repo).
  let instanceSlug: string | null = picked.action === 'reconfigure' ? picked.slug : null;
  let instanceHome: string | null = instanceSlug ? join(instancesDir(), instanceSlug) : null;
  if (instanceSlug) process.env.FLOCKBOTS_INSTANCE_ID = instanceSlug;

  // Snapshot existing state for reconfigure flows. For 'create' we start
  // fresh — no .env, no keys, no kg state.
  const snapshot = instanceHome
    ? detectExistingConfig(instanceHome)
    : detectExistingConfig(join(instancesDir(), '__placeholder__'));  // empty snapshot

  // Section picker: only relevant for reconfigure. Fresh-install runs every
  // section by default.
  let mode: 'fresh' | 'reconfigure' = picked.action === 'reconfigure' ? 'reconfigure' : 'fresh';
  let sectionsToRun = new Set<ReconfigureSection>(ALL_SECTIONS);

  if (mode === 'reconfigure') {
    const sections = await pickSectionsToReconfigure(p, snapshot);
    if (sections === null) return cancelAndExit(p);
    if (sections.length === 0) {
      p.cancel('No sections selected — nothing to reconfigure.');
      return;
    }
    const { expanded, added } = expandDependencies(sections, snapshot.config);
    if (added.length > 0) {
      p.note(
        `These depend on other sections that aren't configured yet — pulling them in:\n  ${added.join(', ')}`,
        'Dependencies auto-added'
      );
    }

    // Warn if a shared section is being edited and this is a multi-instance
    // setup — the change will propagate into every other instance's .env.
    const otherSlugs = listInstanceSlugs().filter((s) => s !== instanceSlug);
    const sharedTouched = expanded.filter(isSharedSection);
    if (otherSlugs.length > 0 && sharedTouched.length > 0) {
      p.note(
        help([
          `Shared sections being edited: ${sharedTouched.join(', ')}`,
          '',
          `These values are duplicated across all ${otherSlugs.length + 1} instances.`,
          `Saving will also update: ${otherSlugs.join(', ')}.`,
        ].join('\n')),
        'Multi-instance impact'
      );
      const ok = await p.confirm({ message: 'Continue?', initialValue: true });
      if (p.isCancel(ok) || !ok) return cancelAndExit(p);
    }

    sectionsToRun = new Set(expanded);
  }

  // Welcome note + time estimate — only shown for fresh installs and full-
  // rewrite mode. Reconfigure mode skips this because the user has already
  // committed to the picker selection.
  if (mode === 'fresh') {
    p.note(
      help([
        'This wizard configures FlockBots on your machine.',
        '',
        'Estimated time:',
        '  - ~10 min      (Telegram, no dashboard)',
        '  - ~15-20 min   (Telegram + dashboard)',
        '  - ~30-40 min   (WhatsApp + dashboard — WhatsApp Business Account required)',
        '',
        'You will need:',
        '  - A GitHub account with a repository to work on',
        '  - Either a Claude Max subscription or an Anthropic API key',
        '  - Either a Telegram / Slack account, or a Meta Business account',
      ].join('\n')),
      'Welcome'
    );

    const proceed = await p.confirm({ message: 'Ready to start?', initialValue: true });
    if (p.isCancel(proceed) || !proceed) return cancelAndExit(p, 'Setup cancelled. Re-run `flockbots init` anytime.');
  }

  // ----- Prerequisites -------------------------------------------------------
  const spin = p.spinner();
  spin.start('Checking prerequisites');
  const checks = runPrereqChecks();
  spin.stop('Prerequisite check complete');
  p.note(
    checks.map(c => `  ${c.ok ? '✓' : '✗'}  ${c.name.padEnd(16)} ${c.detail}`).join('\n'),
    'System check'
  );
  const missing = checks.filter(c => !c.ok && c.required);
  if (missing.length > 0) {
    const fixes = missing.map(c => `  - ${c.name}: ${c.fix || 'install it'}`).join('\n');
    p.log.error('Missing required prerequisites:');
    p.log.message(fixes);
    return cancelAndExit(p, 'Install the missing tools and re-run `flockbots init`.');
  }

  const config: Partial<WizardConfig> = {};
  if (mode === 'reconfigure') {
    // Pre-load everything we parsed from .env. Gated ask* calls below
    // overwrite only the sections the user picked; everything else rides
    // through untouched into the final buildEnvContent write.
    Object.assign(config, snapshot.config);
  }

  const wants = (s: ReconfigureSection) => sectionsToRun.has(s);

  // ----- Claude auth ---------------------------------------------------------
  if (wants('claude-auth')) {
    const claude = await askClaudeAuth(p);
    if (!claude) return cancelAndExit(p);
    config.claudeAuth = claude.mode;
    config.anthropicApiKey = claude.apiKey;
  }

  // ----- Target repo (local path + GitHub owner/repo) ------------------------
  // Bundled: both answer "which repo does FlockBots work on?". If user picks
  // just target-repo in reconfigure mode, askGitHubTarget auto-detects from
  // the new remote and the user just confirms.
  if (wants('target-repo')) {
    const repo = await askTargetRepo(p);
    if (!repo) return cancelAndExit(p);
    config.targetRepoPath = repo;
  }

  // ----- Chat provider -------------------------------------------------------
  if (wants('chat-provider')) {
    const chat = await askChatProvider(p);
    if (!chat) return cancelAndExit(p);
    Object.assign(config, chat);

    // WhatsApp needs a Vercel-hosted webhook relay that writes inbound
    // messages to Supabase. Warn up front so the user isn't surprised when
    // Supabase becomes non-optional a few steps later.
    if (config.chatProvider === 'whatsapp') {
      p.note(
        help([
          'WhatsApp routes inbound messages through a small Vercel function',
          '(the "webhook-relay") that writes them to Supabase. The coordinator',
          'polls Supabase for new messages every few seconds.',
          '',
          "Because of this, picking WhatsApp means:",
          '  - Supabase is REQUIRED (we\'ll set it up in the next few steps)',
          '  - We\'ll auto-deploy the webhook-relay to Vercel for you',
          '  - You\'ll paste the resulting URL into Meta\'s webhook config',
          '',
          'Full walkthrough with screenshots: docs/setup/whatsapp.md',
        ].join('\n')),
        'Heads up — WhatsApp requires Supabase + Vercel'
      );
      const proceed = await p.confirm({
        message: 'Continue with WhatsApp?',
        initialValue: true,
      });
      if (p.isCancel(proceed) || !proceed) return cancelAndExit(p);

      // Reconfigure user picked chat-provider + WhatsApp but didn't pick
      // Supabase, and there's no existing Supabase setup. Pull it in —
      // WhatsApp without Supabase is a broken config.
      if (!wants('supabase') && !config.supabaseUrl) {
        p.log.info("Adding 'supabase' to this run — WhatsApp requires it.");
        sectionsToRun.add('supabase');
        sectionsToRun.add('dashboard-admin');
      }
    }
  }

  // ----- GitHub target repo (owner/repo) -------------------------------------
  if (wants('target-repo')) {
    const targetRepo = await askGitHubTarget(p, config.targetRepoPath as string);
    if (!targetRepo) return cancelAndExit(p);
    config.githubOwner = targetRepo.owner;
    config.githubRepo = targetRepo.repo;
  }

  // ----- Slug + instance home (fresh-install only) --------------------------
  // The slug couldn't be asked until we knew owner/repo (default suggestion).
  // For reconfigure flows the slug was already known from the picker.
  if (mode === 'fresh' && !instanceSlug) {
    const conflictingSlug = config.githubOwner && config.githubRepo
      ? findInstanceForTarget(config.githubOwner, config.githubRepo)
      : null;
    if (conflictingSlug) {
      p.log.error(
        `Instance '${conflictingSlug}' already targets ${config.githubOwner}/${config.githubRepo}. ` +
        `Pick a different repo or remove '${conflictingSlug}' first.`
      );
      return cancelAndExit(p);
    }
    // Default to flock-N — owner/repo can leak into shell paths and pm2 app
    // names that users see daily; a short slug keeps those tidy.
    const slug = await askNewInstanceSlug(p);
    if (!slug) return cancelAndExit(p);
    instanceSlug = slug;
    instanceHome = join(instancesDir(), slug);
    process.env.FLOCKBOTS_INSTANCE_ID = slug;

    // Create the instance dir + seed skills NOW so subsequent steps that
    // resolve keysDir() / skillsDir() find the right place.
    mkdirSync(instanceHome, { recursive: true });
    mkdirSync(join(instanceHome, 'keys'), { recursive: true });
    try { ensureSkillsFromTemplate(instanceHome, root); } catch { /* best effort */ }
  }

  // ----- Branch strategy -----------------------------------------------------
  if (wants('branches')) {
    const branches = await askBranches(
      p,
      config.targetRepoPath as string,
      config.githubOwner as string,
      config.githubRepo as string,
    );
    if (!branches) return cancelAndExit(p);
    config.githubStagingBranch = branches.staging;
    config.githubProdBranch = branches.prod;
  }

  // ----- GitHub Apps (x2: PR creator + reviewer) -----------------------------
  if (wants('github-apps')) {
    // Reuse-from-sibling option only kicks in for fresh-install flows where
    // sibling instances already have apps configured. In reconfigure mode
    // (existing is set), the user goes through the existing 3-option menu
    // (keep / new with custom name / re-create) — we don't suggest "reuse"
    // because they already have their own app configured.
    const agentExisting = existingGitHubApp(config, 'agent');
    const agentReusable = mode === 'fresh' ? await findReusableApps('agent', instanceSlug || undefined) : [];
    const agentApp = await createGitHubApp(p, 'agent', {
      existing: agentExisting,
      reusableFromSiblings: agentReusable,
      newRepo: config.githubOwner && config.githubRepo
        ? { owner: config.githubOwner, repo: config.githubRepo }
        : undefined,
      newInstanceHome: instanceHome || undefined,
    });
    if (!agentApp) return cancelAndExit(p);
    config.githubAppId = agentApp.appId;
    config.githubAppInstallationId = agentApp.installationId;
    config.githubAppPrivateKeyPath = agentApp.pemPath;

    const reviewerExisting = existingGitHubApp(config, 'reviewer');
    const reviewerReusable = mode === 'fresh' ? await findReusableApps('reviewer', instanceSlug || undefined) : [];
    const reviewerApp = await createGitHubApp(p, 'reviewer', {
      existing: reviewerExisting,
      reusableFromSiblings: reviewerReusable,
      newRepo: config.githubOwner && config.githubRepo
        ? { owner: config.githubOwner, repo: config.githubRepo }
        : undefined,
      newInstanceHome: instanceHome || undefined,
    });
    if (!reviewerApp) return cancelAndExit(p);
    config.reviewerGithubAppId = reviewerApp.appId;
    config.reviewerGithubAppInstallationId = reviewerApp.installationId;
    config.reviewerGithubAppPrivateKeyPath = reviewerApp.pemPath;
  }

  // ----- Linear (optional) ---------------------------------------------------
  if (wants('linear')) {
    const linear = await askLinearWithProject(
      p,
      {
        apiKey: config.linearApiKey,
        teamId: config.linearTeamId,
        projectId: config.linearProjectId,
      },
      instanceSlug || undefined,
    );
    if (linear === null) return cancelAndExit(p);
    Object.assign(config, linear);
  }

  // ----- Supabase (optional; required for WhatsApp) --------------------------
  if (wants('supabase')) {
    // Defaults: in reconfigure mode, this instance's existing values. In
    // fresh-install mode for instance N>=2, pre-fill from a sibling so the
    // user doesn't retype (and can't accidentally diverge by typo).
    let supabaseDefaults: SupabaseDefaults | undefined;
    if (mode === 'reconfigure' && config.supabaseUrl) {
      supabaseDefaults = {
        url: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
        anonKey: config.supabaseAnonKey,
      };
    } else if (mode === 'fresh') {
      const sibling = readSiblingSupabaseValues(instanceSlug || undefined);
      if (sibling) supabaseDefaults = sibling;
    }

    const supabase = await askSupabase(p, {
      required: config.chatProvider === 'whatsapp',
      defaults: supabaseDefaults,
    });
    if (supabase === null) return cancelAndExit(p);
    Object.assign(config, supabase);
  }

  // ----- Dashboard admin (requires Supabase) ---------------------------------
  // Split out from askSupabase so reconfigure users can re-roll just the
  // dashboard login without re-entering URLs + keys.
  //
  // Skip when adding instance N>=2: the first instance's setup created the
  // auth.users row, and all instances share one Supabase project. Asking
  // again here would either create a redundant second admin or let the
  // operator type a typo'd email and never realize it. One login, full stop.
  if (wants('dashboard-admin') && config.supabaseUrl) {
    const hasSiblingWithSupabase = mode === 'fresh' && readSiblingSupabaseValues(instanceSlug || undefined) !== null;
    if (hasSiblingWithSupabase) {
      p.log.info('Dashboard login already configured during the first instance setup — re-using it.');
    } else {
      const admin = await askDashboardAdmin(p);
      if (admin === null) return cancelAndExit(p);
      Object.assign(config, admin);
    }
  }

  // ----- QA ------------------------------------------------------------------
  if (wants('qa')) {
    if (config.supabaseUrl) {
      const qa = await askQA(p);
      if (qa === null) return cancelAndExit(p);
      Object.assign(config, qa);
    } else {
      p.note(
        help([
          "The QA agent uploads Playwright screenshots + short video clips",
          "to a Supabase Storage bucket (qa-media), then sends them to your",
          "chat provider as time-limited signed URLs. Since you skipped the",
          "dashboard (Supabase) step, QA is unavailable on this install.",
          '',
          'You can add it later: re-run `flockbots init` and enable the',
          'dashboard when prompted, then pick QA at the same step.',
        ].join('\n')),
        'QA agent unavailable (requires Supabase)'
      );
      config.qaEnabled = false;
    }
  }

  // ----- Summary + write -----------------------------------------------------
  const confirmed = await showSummary(p, config as WizardConfig);
  if (!confirmed) return cancelAndExit(p, 'No changes written — re-run `flockbots init` any time.');

  if (!instanceHome || !instanceSlug) {
    p.cancel('Internal error: instance not resolved before write.');
    return;
  }

  // Diff-based propagation: compare new shared values against the snapshot
  // (pre-reconfigure state) and only propagate keys that actually changed.
  // Disabled in fresh-install mode — adding a new instance should never
  // silently overwrite siblings' shared config (user might have mistyped).
  const sharedUpdates: Record<string, string> = {};
  if (mode === 'reconfigure') {
    const previousShared = collectSharedValues(snapshot.config as WizardConfig);
    const newShared = collectSharedValues(config as WizardConfig);
    for (const [key, value] of Object.entries(newShared)) {
      if (previousShared[key] !== value) sharedUpdates[key] = value;
    }
  }

  await writeConfig(p, config as WizardConfig, sectionsToRun, {
    root,
    instanceHome,
    instanceSlug,
    sharedUpdates,
  });

  // Knowledge-graph build — only offered when the user explicitly picked
  // it (fresh mode always does, reconfigure mode only if in sectionsToRun).
  if (wants('knowledge-graph')) {
    await offerKgBuild(p);
  }

  // pm2 env reload after a reconfigure that changed env vars. `pm2 restart
  // <name> --update-env` doesn't actually re-read the .env file via
  // ecosystem.config.js (it merges the env block pm2 cached at first
  // start), so a coordinator that was already running keeps its old env
  // — and the user's fresh QA_STAGING_BASE_URL / Telegram token / etc.
  // never take effect. Delete+start forces ecosystem.config.js to
  // re-evaluate, which re-runs our loadEnv on the freshly-written .env.
  if (mode === 'reconfigure' && instanceSlug && pm2HasInstance(instanceSlug)) {
    const restart = await p.confirm({
      message: `Restart pm2 for '${instanceSlug}' so the new config takes effect?`,
      initialValue: true,
    });
    if (!p.isCancel(restart) && restart) {
      const restartSpin = p.spinner();
      restartSpin.start(`Restarting flockbots:${instanceSlug} with fresh env`);
      const ok = pm2RestartWithFreshEnv(root, instanceSlug);
      restartSpin.stop(ok ? `flockbots:${instanceSlug} restarted` : `Restart failed — run manually: pm2 delete flockbots:${instanceSlug} && pm2 start ${join(root, 'ecosystem.config.js')} --only flockbots:${instanceSlug}`);
    }
  }

  // Per-instance state — stamp this instance's state.json so the next
  // reconfigure can show "last reconfigured" hints.
  try { updateState(instanceHome, { lastReconfiguredAt: new Date().toISOString() }); } catch { /* best effort */ }

  p.outro('FlockBots configured. Run `flockbots doctor` to verify, then start the coordinator.');
}

/**
 * Check pm2's running list for `flockbots:<slug>`. Returns false on any
 * pm2 daemon error (offline, missing, etc.) — the right behavior when
 * we're deciding whether to OFFER a restart.
 */
function pm2HasInstance(slug: string): boolean {
  try {
    const out = execSync('pm2 jlist', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const apps = JSON.parse(out) as Array<{ name?: string }>;
    return apps.some((a) => a.name === `flockbots:${slug}`);
  } catch {
    return false;
  }
}

/**
 * Force pm2 to re-evaluate ecosystem.config.js for one instance — delete
 * the running app, then start with --only so just that slug spins up
 * with fresh env from the freshly-written .env.
 */
function pm2RestartWithFreshEnv(root: string, slug: string): boolean {
  const ecosystem = join(root, 'ecosystem.config.js');
  try {
    execSync(`pm2 delete flockbots:${slug}`, { stdio: 'ignore' });
  } catch { /* might not exist; proceed */ }
  try {
    execSync(`pm2 start ${JSON.stringify(ecosystem)} --only flockbots:${slug}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared-settings shortcut for N>=2 setups. Runs Supabase + dashboard-admin
 * sections, then surgically rewrites only the shared keys in every
 * instance's .env via applyEnvUpdates. Per-instance fields (custom Linear
 * label, hand-edited QA flags, etc.) are preserved across the operation —
 * unlike the full reconfigure path which rebuilds .env from WizardConfig
 * and would silently revert anything not surfaced by hydrateConfig.
 */
async function runSharedReconfigure(
  p: ClackModule,
  root: string,
  anchorSlug: string,
): Promise<void> {
  const anchorHome = join(instancesDir(), anchorSlug);
  const snapshot = detectExistingConfig(anchorHome);

  // Supabase: defaults from the anchor's existing values.
  const defaults: SupabaseDefaults | undefined = snapshot.config.supabaseUrl
    ? {
        url: snapshot.config.supabaseUrl,
        serviceRoleKey: snapshot.config.supabaseServiceRoleKey,
        anonKey: snapshot.config.supabaseAnonKey,
      }
    : undefined;
  const supabase = await askSupabase(p, { defaults });
  if (supabase === null) return cancelAndExit(p);

  // Dashboard admin (re-prompt the email + password so the SQL bootstrap
  // re-runs against the latest auth.users).
  let admin: { email: string; password: string } | undefined;
  if (supabase.supabaseUrl) {
    const adminResult = await askDashboardAdmin(p);
    if (adminResult === null) return cancelAndExit(p);
    if (adminResult.dashboardAdminEmail && adminResult.dashboardAdminPassword) {
      admin = {
        email: adminResult.dashboardAdminEmail,
        password: adminResult.dashboardAdminPassword,
      };
    }
  }

  const otherSlugs = listInstanceSlugs().filter((s) => s !== anchorSlug);
  const ok = await p.confirm({
    message: `Update shared values across ${otherSlugs.length + 1} instances?`,
    initialValue: true,
  });
  if (p.isCancel(ok) || !ok) return cancelAndExit(p);

  // Build the shared-key update set and apply it surgically to every
  // instance's .env. applyEnvUpdates preserves comments, ordering, and any
  // keys outside the update set.
  const updates: Record<string, string> = {};
  if (supabase.supabaseUrl) {
    updates.SUPABASE_URL = supabase.supabaseUrl;
    updates.VITE_SUPABASE_URL = supabase.supabaseUrl;
  }
  if (supabase.supabaseServiceRoleKey) updates.SUPABASE_SERVICE_ROLE_KEY = supabase.supabaseServiceRoleKey;
  if (supabase.supabaseAnonKey) {
    updates.SUPABASE_ANON_KEY = supabase.supabaseAnonKey;
    updates.VITE_SUPABASE_ANON_KEY = supabase.supabaseAnonKey;
  }

  let updatedCount = 0;
  for (const slug of [anchorSlug, ...otherSlugs]) {
    const envPath = join(instancesDir(), slug, '.env');
    if (!existsSync(envPath)) continue;
    try {
      const original = readFileSync(envPath, 'utf-8');
      const next = applyEnvUpdates(original, updates);
      if (next !== original) {
        writeFileSync(envPath, next, { mode: 0o600 });
        updatedCount += 1;
      }
    } catch (err: any) {
      p.log.warn(`[${slug}] could not update .env: ${err.message}`);
    }
  }
  p.log.success(`Shared values written → ${updatedCount} instance${updatedCount === 1 ? '' : 's'}`);

  // Re-apply Supabase migration (idempotent) + bootstrap admin if creds
  // were collected.
  if (supabase.supabaseUrl) {
    await applySupabaseMigration(p, supabase.supabaseUrl, root, admin);
  }

  try { updateState(anchorHome, { lastReconfiguredAt: new Date().toISOString() }); } catch { /* best effort */ }

  p.outro(`Shared settings updated across ${otherSlugs.length + 1} instances.`);
}

/**
 * Offer to build the graphify knowledge graph right now. Synchronous — the
 * user waits (or ctrl-c's and runs `flockbots kg build` later). Skipping is
 * fine; agents fall back to grep, just more expensive in tokens.
 */
async function offerKgBuild(p: ClackModule): Promise<void> {
  p.note(
    help([
      'Optional: a knowledge graph of your target repo lets agents use',
      'mcp__graphify__* tools for symbol + import lookups instead of grep.',
      'Agents run 5-10× cheaper in tokens once it is built.',
      '',
      'Build now (10-30 min, uses Claude tokens) or skip? You can build',
      'anytime later with `flockbots kg build`.',
    ].join('\n')),
    'Knowledge graph (graphify)'
  );

  const build = await p.confirm({
    message: 'Build the knowledge graph now?',
    initialValue: false,
  });
  if (p.isCancel(build) || !build) {
    p.log.info('Skipped. Agents will fall back to grep. Run `flockbots kg build` anytime.');
    return;
  }

  const ok = await runKgBuild();
  if (!ok) {
    p.log.warn('Graph build failed. Retry with `flockbots kg build` once you have sorted the issue.');
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type ClackModule = typeof import('@clack/prompts');

async function askClaudeAuth(p: ClackModule): Promise<{ mode: 'max' | 'api_key'; apiKey?: string } | null> {
  const mode = await p.select({
    message: 'How should FlockBots authenticate with Claude?',
    options: [
      { value: 'max', label: 'Claude Max / Pro subscription (OAuth)', hint: 'included, no per-token cost' },
      { value: 'api_key', label: 'Anthropic API key', hint: 'pay-per-token' },
    ],
    initialValue: 'max',
  });
  if (p.isCancel(mode)) return null;

  if (mode === 'api_key') {
    const apiKey = await p.password({
      message: 'Paste your ANTHROPIC_API_KEY:',
      validate: (v) => (v.startsWith('sk-ant-') ? undefined : 'Expected value to start with "sk-ant-"'),
    });
    if (p.isCancel(apiKey)) return null;
    return { mode: 'api_key', apiKey: apiKey as string };
  }

  // Max path: verify by running a cheap claude -p call
  p.note(
    help("FlockBots will use your Claude Max/Pro OAuth session. If you haven't run `claude login` yet, do it now in another terminal."),
    'Claude authentication'
  );
  const ready = await p.confirm({ message: 'Done? Run the verification?', initialValue: true });
  if (p.isCancel(ready) || !ready) return null;

  const spin = p.spinner();
  spin.start('Spawning a test claude session');
  const ok = await verifyClaudeCli();
  if (!ok) {
    spin.stop('Claude CLI could not authenticate');
    p.log.error('Run `claude login` and re-run `flockbots init`.');
    return null;
  }
  spin.stop('Claude CLI authenticated');
  return { mode: 'max' };
}

async function askTargetRepo(p: ClackModule): Promise<string | null> {
  const mode = await p.select({
    message: 'Which codebase should FlockBots work on?',
    options: [
      { value: 'existing', label: 'A repo already on my computer', hint: 'paste a path' },
      { value: 'clone', label: 'Clone a repo from GitHub', hint: 'paste a URL' },
    ],
    initialValue: 'existing',
  });
  if (p.isCancel(mode)) return null;

  if (mode === 'existing') {
    const path = await p.text({
      message: 'Absolute path to your repo (spaces are fine, no quoting):',
      placeholder: '/Users/you/code/my-app',
      validate: (v) => {
        if (!v) return 'Required';
        const cleaned = normalizePath(v);
        if (!existsSync(cleaned)) return `Path does not exist: ${cleaned}`;
        if (!existsSync(join(cleaned, '.git'))) return `Not a git repo (no .git/ in ${cleaned})`;
        return undefined;
      },
    });
    if (p.isCancel(path)) return null;
    return normalizePath(path as string);
  }

  // Clone path — note auth expectations up front so users with private
  // repos can bail out and set up credentials before wasting a prompt cycle.
  p.note(help([
    'For a public repo, no auth is needed.',
    '',
    'For a private repo, git needs credentials. Easiest:',
    '  • run `gh auth login` in another terminal (populates the keychain), or',
    '  • set up a PAT at github.com/settings/tokens and store it with',
    '    `git config --global credential.helper osxkeychain` (macOS) or',
    '    `git config --global credential.helper store` (Linux).',
  ].join('\n')), 'Clone auth');

  const url = await p.text({
    message: 'GitHub repository URL:',
    placeholder: 'https://github.com/you/my-app.git',
    validate: (v) => (/github\.com/.test(v) ? undefined : 'Expected a github.com URL'),
  });
  if (p.isCancel(url)) return null;

  const defaultParent = join(homedir(), 'code');
  const parentRaw = await p.text({
    message: 'Parent directory to clone into (spaces are fine, no quoting):',
    initialValue: defaultParent,
    validate: (v) => {
      const cleaned = normalizePath(v);
      if (!cleaned || (!cleaned.startsWith('/') && !cleaned.startsWith('~'))) {
        return 'Must be an absolute path';
      }
      return undefined;
    },
  });
  if (p.isCancel(parentRaw)) return null;

  const parentPath = normalizePath(parentRaw as string);

  // Auto-create missing parents so the user doesn't have to mkdir first.
  if (!existsSync(parentPath)) {
    try {
      mkdirSync(parentPath, { recursive: true });
      p.log.info(`created ${parentPath}`);
    } catch (err: any) {
      p.log.error(`could not create ${parentPath}: ${err.message}`);
      return null;
    }
  } else if (!statSync(parentPath).isDirectory()) {
    p.log.error(`${parentPath} exists but is not a directory`);
    return null;
  }

  const repoName = (url as string).split('/').pop()?.replace(/\.git$/, '') || 'repo';
  const target = join(parentPath, repoName);
  if (existsSync(target)) {
    p.log.warn(`${target} already exists — using it.`);
    if (!existsSync(join(target, '.git'))) {
      p.log.error(`${target} exists but is not a git repo.`);
      return null;
    }
    return target;
  }

  // Probe access with `git ls-remote` before attempting the full clone.
  // Fails fast on auth / URL errors with a much clearer message than git's
  // raw output would give the user mid-clone.
  const probe = p.spinner();
  probe.start(`Checking access to ${url}`);
  try {
    execSync(`git ls-remote --heads ${JSON.stringify(url)}`, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 15_000,
    });
    probe.stop('Access confirmed');
  } catch (err: any) {
    probe.stop('Could not access the repo');
    p.log.error([
      `git ls-remote failed. Either the URL is wrong or you don't have access.`,
      '',
      'If the repo is private, set up git credentials and re-run:',
      '  • gh auth login                            (easiest, uses keychain)',
      '  • or create a PAT + credential.helper      (github.com/settings/tokens)',
      '',
      'If the repo is public, double-check the URL.',
    ].join('\n'));
    return null;
  }

  const spin = p.spinner();
  spin.start(`Cloning ${url} into ${parentPath}`);
  try {
    const git = simpleGit(parentPath);
    await git.clone(url as string);
    spin.stop(`Cloned to ${target}`);
    return target;
  } catch (err: any) {
    spin.stop('Clone failed');
    p.log.error(err.message);
    return null;
  }
}

/**
 * Normalize a user-entered path: trim whitespace, unescape shell-style
 * space escaping (`\ `), strip quote characters they might have typed to
 * escape spaces, expand leading `~`, and resolve to a canonical absolute
 * path. Handles the three most common shell-escape habits users have
 * when pasting paths with spaces.
 */
function normalizePath(input: string): string {
  let s = input.trim()
    .replace(/\\ /g, ' ')      // backslash-space → space
    .replace(/["']/g, '');     // strip any quote characters
  if (s.startsWith('~')) s = join(homedir(), s.slice(1));
  return resolve(s);
}

/**
 * Parse a GitHub remote URL into owner + repo. Handles both the HTTPS and
 * SSH forms that `git remote add origin <url>` accepts.
 *   https://github.com/octocat/Hello-World.git → octocat / Hello-World
 *   git@github.com:octocat/Hello-World.git      → octocat / Hello-World
 * Returns null for non-GitHub URLs.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Read the `origin` remote from the local checkout and parse github.com
 * owner + repo out of it. Silent-fails on any git error (no remote, non-
 * GitHub remote, permissions, etc.) so the caller falls through to asking.
 */
function detectGitHubTarget(targetRepoPath: string): { owner: string; repo: string } | null {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: targetRepoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseGitHubUrl(url);
  } catch {
    return null;
  }
}

async function askGitHubTarget(p: ClackModule, targetRepoPath: string): Promise<{ owner: string; repo: string } | null> {
  const detected = detectGitHubTarget(targetRepoPath);

  if (detected) {
    p.note(
      help([
        `Detected from the repo's git remote:`,
        ``,
        `  ${detected.owner} / ${detected.repo}`,
        ``,
        `Use these, or enter different values if you want PRs to go to a`,
        `fork or a different repo than origin points at.`,
      ].join('\n')),
      'Target repo on GitHub (auto-detected)'
    );

    const useDetected = await p.confirm({
      message: `Use ${detected.owner}/${detected.repo}?`,
      initialValue: true,
    });
    if (p.isCancel(useDetected)) return null;
    if (useDetected) return detected;
    // Else fall through to the manual entry prompts below.
  } else {
    p.note(
      help([
        "Couldn't auto-detect from origin — enter the GitHub coordinates",
        "of the target repo manually. Example: for github.com/octocat/",
        "hello-world → owner: octocat, repo: hello-world.",
      ].join('\n')),
      'Target repo on GitHub'
    );
  }

  const owner = await p.text({
    message: 'GitHub owner (username or org):',
    initialValue: detected?.owner,
    validate: (v) => (v && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v) ? undefined : 'Invalid owner name'),
  });
  if (p.isCancel(owner)) return null;

  const repo = await p.text({
    message: 'Repo name:',
    initialValue: detected?.repo,
    validate: (v) => (v && /^[A-Za-z0-9._-]+$/.test(v) ? undefined : 'Invalid repo name'),
  });
  if (p.isCancel(repo)) return null;

  return { owner: owner as string, repo: repo as string };
}

/**
 * Detect the target repo's default branch without requiring `gh`.
 * Tries, in order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` in the local clone
 *   2. `git ls-remote --symref <url> HEAD` against github.com
 *   3. 'main' as the last-resort default
 */
function detectDefaultBranch(targetRepoPath: string, owner: string, repo: string): string {
  try {
    const out = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: targetRepoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = out.match(/refs\/remotes\/origin\/(.+)/);
    if (m) return m[1];
  } catch { /* fall through */ }
  try {
    const url = `https://github.com/${owner}/${repo}.git`;
    const out = execSync(`git ls-remote --symref ${JSON.stringify(url)} HEAD`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const m = out.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return 'main';
}

/**
 * True when the remote has zero branches — i.e. the repo was created on
 * GitHub but has no commits yet. We use the throw-vs-empty distinction to
 * separate "ls-remote failed" (network/auth — assume not empty, let the
 * normal flow surface the error) from "ls-remote succeeded with no refs".
 */
function repoIsEmpty(owner: string, repo: string): boolean {
  try {
    const url = `https://github.com/${owner}/${repo}.git`;
    const out = execSync(
      `git ls-remote --heads ${JSON.stringify(url)}`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }
    ).trim();
    return out.length === 0;
  } catch {
    return false;
  }
}

/**
 * Check whether a branch exists on the remote. Returns false on network errors
 * too — caller should treat "can't confirm" as "probably doesn't exist" and
 * offer to create.
 */
function branchExistsOnRemote(owner: string, repo: string, branch: string): boolean {
  try {
    const url = `https://github.com/${owner}/${repo}.git`;
    const out = execSync(
      `git ls-remote --heads ${JSON.stringify(url)} ${JSON.stringify(branch)}`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

async function askBranches(
  p: ClackModule,
  targetRepoPath: string,
  owner: string,
  repo: string,
): Promise<{ staging: string; prod: string } | null> {
  const primary = detectDefaultBranch(targetRepoPath, owner, repo);

  // Empty repo: two-branch mode can't work (nothing to branch staging from).
  // The agent's first push will create origin/<primary>; once they have
  // commits, the operator can re-run init to switch to staging+prod.
  if (repoIsEmpty(owner, repo)) {
    p.log.info(
      `${owner}/${repo} has no commits yet — using single-branch mode (PRs merge to ${primary}). ` +
      `Re-run \`flockbots init\` once you have commits to switch to staging+prod.`
    );
    return { staging: primary, prod: primary };
  }

  const mode = await p.select({
    message: `Deploy strategy for ${owner}/${repo}?`,
    options: [
      {
        value: 'single',
        label: `Single branch — merge PRs directly into ${primary}`,
        hint: 'simplest, /deploy is a no-op',
      },
      {
        value: 'two',
        label: `Staging + prod — PRs merge to staging first, /deploy promotes to ${primary}`,
        hint: 'if you have CI that deploys from staging',
      },
    ],
    initialValue: 'single',
  });
  if (p.isCancel(mode)) return null;

  if (mode === 'single') {
    return { staging: primary, prod: primary };
  }

  // Two-branch flow — prompt for staging name, create on remote if missing.
  const stagingRaw = await p.text({
    message: 'Staging branch name (existing or new):',
    initialValue: 'staging',
    validate: (v) => (v && /^[A-Za-z0-9._/-]+$/.test(v) ? undefined : 'Invalid branch name'),
  });
  if (p.isCancel(stagingRaw)) return null;
  const stagingName = (stagingRaw as string).trim();

  if (!branchExistsOnRemote(owner, repo, stagingName)) {
    const create = await p.confirm({
      message: `Branch "${stagingName}" not found on ${owner}/${repo}. Create it from ${primary}?`,
      initialValue: true,
    });
    if (p.isCancel(create) || !create) return null;

    const spin = p.spinner();
    spin.start(`Creating ${stagingName} from ${primary}`);
    try {
      const git = simpleGit(targetRepoPath);
      await git.fetch('origin', primary);
      // Branch from origin/<primary> without disturbing the user's current working copy.
      await git.raw(['branch', stagingName, `origin/${primary}`]);
      await git.push('origin', stagingName, ['--set-upstream']);
      spin.stop(`Created origin/${stagingName}`);
    } catch (err: any) {
      spin.stop('Branch creation failed');
      p.log.error(err.message);
      return null;
    }
  } else {
    p.log.success(`Using existing ${stagingName} branch`);
  }

  return { staging: stagingName, prod: primary };
}

async function askChatProvider(p: ClackModule): Promise<Partial<WizardConfig> | null> {
  const choice = await p.select({
    message: 'Which chat provider?',
    options: [
      { value: 'telegram', label: 'Telegram', hint: '2-min setup, recommended' },
      { value: 'slack', label: 'Slack', hint: '~5 min; workspace bot via Socket Mode' },
      { value: 'whatsapp', label: 'WhatsApp', hint: 'Advanced — WhatsApp Business Account required' },
    ],
    initialValue: 'telegram',
  });
  if (p.isCancel(choice)) return null;

  if (choice === 'telegram') return askTelegram(p);
  if (choice === 'slack') return askSlack(p);
  // WhatsApp's verify token is shared across the relay — pre-fill from a
  // sibling instance so adding instance N>=2 doesn't break inbound on the
  // existing one.
  const siblingVerifyToken = readSiblingEnvValue('WHATSAPP_VERIFY_TOKEN', process.env.FLOCKBOTS_INSTANCE_ID) || undefined;
  return askWhatsApp(p, { siblingVerifyToken });
}

async function askTelegram(p: ClackModule): Promise<Partial<WizardConfig> | null> {
  p.note(
    help([
      '1. Open Telegram, search for @BotFather',
      '2. Send /newbot — pick a name and username',
      '3. Copy the token BotFather gives you',
    ].join('\n')),
    'Create your Telegram bot'
  );

  const token = await p.password({
    message: 'Bot token:',
    validate: (v) => (/^\d+:[A-Za-z0-9_-]{30,}$/.test(v) ? undefined : 'Format: 1234567890:ABCdefGHI...'),
  });
  if (p.isCancel(token)) return null;

  const verify = p.spinner();
  verify.start('Verifying bot token');
  const me = await fetchTelegramMe(token as string);
  if (!me.ok || !me.username) {
    verify.stop('Token rejected by Telegram');
    return null;
  }
  verify.stop(`Connected to @${me.username}`);

  // Note: Telegram queues the last ~24h of updates. For a freshly-created
  // BotFather bot the queue is empty, but if the user has messaged the bot
  // before, detectTelegramChatId() may return an older chat_id without
  // waiting — that's fine, it's still the right chat.
  p.note(
    help([
      `Send any message to YOUR new bot — not to @BotFather.`,
      ``,
      `Open this link to jump straight to the right chat:`,
      `  https://t.me/${me.username}`,
      ``,
      `Or search Telegram for @${me.username}. Then send "hi" or any text.`,
      `I'll auto-detect your chat ID when it arrives (60s timeout).`,
    ].join('\n')),
    'Find your chat ID'
  );
  const proceed = await p.confirm({ message: 'Sent a message? Start listening?', initialValue: true });
  if (p.isCancel(proceed) || !proceed) return null;

  const detect = p.spinner();
  detect.start('Listening for your message');
  const chatId = await detectTelegramChatId(token as string, 60_000);
  if (!chatId) {
    detect.stop('No message received in 60s');
    p.log.error('Send a message to your bot and re-run `flockbots init`.');
    return null;
  }
  detect.stop(`Chat ID: ${chatId}`);

  return {
    chatProvider: 'telegram',
    telegramBotToken: token as string,
    telegramChatId: chatId,
  };
}

// Linear flow lives in wizard-linear.ts — askLinear is re-exported as
// askLinearWithProject above.

interface SupabaseDefaults {
  url?: string;
  serviceRoleKey?: string;
  anonKey?: string;
  /** Slug of the instance these defaults came from, for the "shared with X" hint. */
  fromSlug?: string;
}

async function askSupabase(
  p: ClackModule,
  opts: { required?: boolean; defaults?: SupabaseDefaults } = {},
): Promise<Partial<WizardConfig> | null> {
  if (opts.required) {
    p.note(
      help(
        'Supabase is required for WhatsApp (the webhook-relay writes inbound ' +
        'messages here). The dashboard comes along for free — you get the ' +
        'live office view + task history as a bonus.'
      ),
      'Supabase (required for WhatsApp)'
    );
  } else {
    const enable = await p.confirm({
      message: 'Enable the web dashboard? (requires a free Supabase project)',
      initialValue: !!opts.defaults?.url,
    });
    if (p.isCancel(enable)) return null;
    if (!enable) return {};
  }

  // Pre-population: when adding instance N>=2, sibling instances already
  // use a Supabase project. All three values (url + both keys) must match
  // across the flock — divergent values would break the dashboard for at
  // least one instance — so just re-use them silently. No prompts.
  if (opts.defaults?.fromSlug && opts.defaults.url && opts.defaults.serviceRoleKey && opts.defaults.anonKey) {
    p.log.info(
      `Re-using Supabase config from instance '${opts.defaults.fromSlug}' ` +
      `(all instances must share one project).`
    );
    return {
      supabaseUrl: opts.defaults.url,
      supabaseServiceRoleKey: opts.defaults.serviceRoleKey,
      supabaseAnonKey: opts.defaults.anonKey,
    };
  }

  if (opts.defaults?.fromSlug && opts.defaults.url) {
    // Sibling exists but missing one of the keys — fall through to prompts
    // so the user can fill in the gap (rare; only happens if a sibling
    // .env was hand-edited or partially propagated).
    p.note(
      help([
        `Pre-filled from instance '${opts.defaults.fromSlug}'. Press Enter to`,
        'accept each default — all instances must point at the same Supabase',
        'project (the dashboard reads one URL).',
      ].join('\n')),
      'Shared values'
    );
  } else {
    p.note(
      help([
        '1. Go to https://supabase.com/dashboard → New project (wait ~2 min for provisioning)',
        '2. Settings → API → copy the Project URL',
        '3. Settings → API Keys → Legacy tab → copy BOTH:',
        '     - service_role secret  (used by the coordinator to write)',
        '     - anon public key      (used by the dashboard to read with RLS)',
        '   (Supabase moved these under the Legacy tab in their recent redesign.)',
      ].join('\n')),
      'Supabase'
    );
  }

  const url = await p.text({
    message: 'Supabase Project URL:',
    placeholder: 'https://xxxx.supabase.co',
    initialValue: opts.defaults?.url,
    validate: (v) => (/^https:\/\/.+\.supabase\.co$/.test(v) ? undefined : 'Expected https://<id>.supabase.co'),
  });
  if (p.isCancel(url)) return null;

  const serviceKey = await p.password({
    message: opts.defaults?.serviceRoleKey
      ? 'Supabase service_role key (Enter to reuse the one from the sibling instance):'
      : 'Supabase service_role key (starts with eyJ):',
    validate: (v) => {
      if (!v && opts.defaults?.serviceRoleKey) return undefined;
      return v.startsWith('eyJ') ? undefined : 'Expected a JWT starting with eyJ...';
    },
  });
  if (p.isCancel(serviceKey)) return null;

  const anonKey = await p.password({
    message: opts.defaults?.anonKey
      ? 'Supabase anon public key (Enter to reuse the one from the sibling instance):'
      : 'Supabase anon public key (also starts with eyJ):',
    validate: (v) => {
      if (!v && opts.defaults?.anonKey) return undefined;
      return v.startsWith('eyJ') ? undefined : 'Expected a JWT starting with eyJ...';
    },
  });
  if (p.isCancel(anonKey)) return null;

  return {
    supabaseUrl: url as string,
    supabaseServiceRoleKey: (serviceKey as string) || opts.defaults?.serviceRoleKey || '',
    supabaseAnonKey: (anonKey as string) || opts.defaults?.anonKey || '',
  };
}

/**
 * Read a single env var from any sibling instance. Used for shared values
 * that should be identical across the flock (e.g. WHATSAPP_VERIFY_TOKEN —
 * the relay holds one token, all per-instance webhook URLs verify against
 * it). Returns the first value found.
 */
function readSiblingEnvValue(key: string, excludeSlug?: string): string | null {
  for (const slug of listInstanceSlugs()) {
    if (slug === excludeSlug) continue;
    const envPath = join(instancesDir(), slug, '.env');
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/\r$/, '').trim();
        const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
        if (!m || m[1] !== key) continue;
        let val = m[2].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (val) return val;
      }
    } catch {
      // Skip unreadable .env
    }
  }
  return null;
}

/**
 * Read Supabase URL/keys from the first sibling instance with them
 * configured. Used to pre-populate `askSupabase` defaults when adding a
 * new instance — every instance must point at the same Supabase project,
 * so the wizard saves the user from retyping (and from typos that would
 * silently diverge).
 */
function readSiblingSupabaseValues(excludeSlug?: string): SupabaseDefaults | null {
  for (const slug of listInstanceSlugs()) {
    if (slug === excludeSlug) continue;
    const envPath = join(instancesDir(), slug, '.env');
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      const env: Record<string, string> = {};
      for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/\r$/, '').trim();
        const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        let val = m[2].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        env[m[1]] = val;
      }
      if (env.SUPABASE_URL) {
        return {
          url: env.SUPABASE_URL,
          serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || undefined,
          anonKey: env.SUPABASE_ANON_KEY || undefined,
          fromSlug: slug,
        };
      }
    } catch {
      // Skip unreadable .env
    }
  }
  return null;
}

/**
 * Prompt for the email + password the operator will log into the dashboard
 * with. Bootstrapped into Supabase `auth.users` by the migration's DO block
 * so the operator can log in as soon as Vercel deploys the dashboard.
 *
 * Password is held in memory only for this wizard run — never written to
 * .env. Email is also *not* persisted to .env (it lives in auth.users).
 */
async function askDashboardAdmin(p: ClackModule): Promise<Partial<WizardConfig> | null> {
  p.note(
    help([
      'Pick the email + password you want to log into the dashboard with.',
      '',
      'The wizard will create a Supabase auth user for you as part of the',
      "migration — so once Vercel deploys the dashboard you can log in",
      'right away, no extra setup required.',
    ].join('\n')),
    'Dashboard login'
  );
  const adminEmail = await p.text({
    message: 'Email:',
    placeholder: 'you@company.com',
    validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? undefined : 'Invalid email'),
  });
  if (p.isCancel(adminEmail)) return null;

  const adminPassword = await p.password({
    message: 'Password (minimum 8 characters):',
    validate: (v) => (v && v.length >= 8 ? undefined : 'Must be at least 8 characters'),
  });
  if (p.isCancel(adminPassword)) return null;

  return {
    dashboardAdminEmail: (adminEmail as string).trim(),
    dashboardAdminPassword: adminPassword as string,
  };
}

async function askQA(p: ClackModule): Promise<Partial<WizardConfig> | null> {
  const enable = await p.confirm({
    message: 'Enable the QA agent? (post-merge Playwright browser tests)',
    initialValue: false,
  });
  if (p.isCancel(enable)) return null;
  if (!enable) return { qaEnabled: false };

  const stagingUrl = await p.text({
    message: 'Staging URL (where your app deploys after merge):',
    placeholder: 'https://staging.your-app.com',
    validate: (v) => (/^https?:\/\//.test(v) ? undefined : 'Expected an http(s) URL'),
  });
  if (p.isCancel(stagingUrl)) return null;

  p.note(
    help([
      'If your staging site has no login (e.g. public-facing marketing',
      'site), leave both fields blank. QA will skip the login step and',
      'go straight to testing the rendered pages.',
    ].join('\n')),
    'Staging credentials'
  );

  const email = await p.text({
    message: 'Test account email (leave blank if no login):',
    placeholder: 'qa-bot@example.com — or leave blank',
  });
  if (p.isCancel(email)) return null;

  const pw = await p.password({
    message: 'Test account password (leave blank if no login):',
  });
  if (p.isCancel(pw)) return null;

  return {
    qaEnabled: true,
    stagingBaseUrl: stagingUrl as string,
    qaTestEmail: (email as string) || '',
    qaTestPassword: (pw as string) || '',
  };
}

async function askSlack(p: ClackModule): Promise<Partial<WizardConfig> | null> {
  p.note(
    help([
      '1. Go to https://api.slack.com/apps → "Create New App" → From scratch.',
      '   Name it "FlockBots", pick your workspace.',
      '',
      '2. OAuth & Permissions → Scopes → Bot Token Scopes, add:',
      '   chat:write, channels:history, groups:history, im:history',
      '',
      '3. Socket Mode → toggle ON → "Generate an app-level token"',
      '   Scope: connections:write. Copy the xapp-... token.',
      '',
      '4. Event Subscriptions → toggle ON → Subscribe to bot events, add:',
      '   message.channels, message.groups (add message.im if you want DMs)',
      '',
      '5. Install to Workspace → copy the Bot User OAuth Token (xoxb-...).',
      '',
      '6. In Slack: create a channel for FlockBots, run /invite @flockbots,',
      '   then copy the channel ID from the URL (.../archives/C01234ABC).',
    ].join('\n')),
    'Slack setup'
  );

  const continueSL = await p.confirm({ message: 'Ready to proceed with Slack?', initialValue: true });
  if (p.isCancel(continueSL) || !continueSL) return null;

  const botToken = await p.password({
    message: 'Bot User OAuth Token (xoxb-…):',
    validate: (v) => (v.startsWith('xoxb-') ? undefined : 'Expected value to start with "xoxb-"'),
  });
  if (p.isCancel(botToken)) return null;

  const appToken = await p.password({
    message: 'App-Level Token for Socket Mode (xapp-…):',
    validate: (v) => (v.startsWith('xapp-') ? undefined : 'Expected value to start with "xapp-"'),
  });
  if (p.isCancel(appToken)) return null;

  const channelId = await p.text({
    message: 'Channel ID (from channel URL, e.g. C01234ABC):',
    validate: (v) => (/^[CGD][A-Z0-9]{8,}$/.test(v) ? undefined : 'Expected a Slack channel ID (starts with C, G, or D)'),
  });
  if (p.isCancel(channelId)) return null;

  return {
    chatProvider: 'slack',
    slackBotToken: botToken as string,
    slackAppToken: appToken as string,
    slackChannelId: channelId as string,
  };
}

async function askWhatsApp(p: ClackModule, opts: { siblingVerifyToken?: string } = {}): Promise<Partial<WizardConfig> | null> {
  p.note(
    help([
      'WhatsApp Cloud API setup is multi-step. The short version:',
      '',
      '1. Create a Meta Business account: https://business.facebook.com',
      '2. Add WhatsApp Business API — add a test phone number',
      '3. Business Settings → Users → System Users → create one',
      '4. Assign WhatsApp permissions, generate a PERMANENT access token',
      '5. Business Settings → WhatsApp Accounts → copy the phone number ID',
      '',
      'Full guide will land in docs/setup/whatsapp.md in Phase 5.',
      'Telegram is a much quicker starting option if you want to try first.',
    ].join('\n')),
    'WhatsApp setup'
  );

  const continueWA = await p.confirm({ message: 'Ready to proceed with WhatsApp?', initialValue: true });
  if (p.isCancel(continueWA) || !continueWA) return null;

  const phoneId = await p.text({
    message: 'WhatsApp phone number ID:',
    validate: (v) => (/^\d{10,25}$/.test(v) ? undefined : 'Numeric ID from Meta dashboard'),
  });
  if (p.isCancel(phoneId)) return null;

  const token = await p.password({
    message: 'WhatsApp system user access token:',
    validate: (v) => (v.length > 40 ? undefined : 'Expected a long token starting with EAA...'),
  });
  if (p.isCancel(token)) return null;

  const appSecret = await p.password({
    message: 'Meta app secret (Meta dashboard → App → Basic → App secret):',
    validate: (v) => (v && v.length >= 16 ? undefined : 'Required — used to HMAC-verify incoming webhooks.'),
  });
  if (p.isCancel(appSecret)) return null;

  const operator = await p.text({
    message: 'Your WhatsApp number (digits only, with country code):',
    placeholder: '14155551234',
    validate: (v) => (/^\d{10,15}$/.test(v) ? undefined : 'Digits only, e.g. 14155551234'),
  });
  if (p.isCancel(operator)) return null;

  // Verify token is shared across all WhatsApp instances on the same
  // relay deployment — Meta's webhook subscription verifies each per-
  // instance URL against this single token. If a sibling already set one,
  // default to that value so the relay's existing env var still matches.
  const verifyTokenDefault = opts.siblingVerifyToken || randomBytes(16).toString('hex');
  if (opts.siblingVerifyToken) {
    p.note(
      help([
        'A sibling instance already set a verify token. Keeping it ensures the',
        'relay\'s deployed env var still matches every instance\'s webhook URL.',
        'Changing this would require redeploying the relay with the new value.',
      ].join('\n')),
      'Shared verify token'
    );
  }
  const verifyToken = await p.text({
    message: 'Webhook verify token (any long random string):',
    initialValue: verifyTokenDefault,
  });
  if (p.isCancel(verifyToken)) return null;

  return {
    chatProvider: 'whatsapp',
    whatsappPhoneNumberId: phoneId as string,
    whatsappAccessToken: token as string,
    whatsappAppSecret: appSecret as string,
    operatorWhatsappNumber: operator as string,
    whatsappVerifyToken: verifyToken as string,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cancelAndExit(p: ClackModule, msg?: string): void {
  p.cancel(msg || 'Setup cancelled.');
}

/** Redact credentials in a config object for display. */
function redact(cfg: Partial<WizardConfig>): Partial<WizardConfig> {
  const copy = { ...cfg };
  if (copy.anthropicApiKey) copy.anthropicApiKey = redactValue(copy.anthropicApiKey);
  if (copy.telegramBotToken) copy.telegramBotToken = redactValue(copy.telegramBotToken);
  if (copy.whatsappAccessToken) copy.whatsappAccessToken = redactValue(copy.whatsappAccessToken);
  return copy;
}

function redactValue(v: string): string {
  if (v.length <= 8) return '***';
  return v.slice(0, 6) + '…' + v.slice(-4);
}

/** Run a cheap `claude -p 'say ok'` to verify auth. 30s timeout. */
function verifyClaudeCli(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', '--max-turns', '1', 'say ok'], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(false);
    }, 30_000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** GET https://api.telegram.org/bot<token>/getMe */
async function fetchTelegramMe(token: string): Promise<{ ok: boolean; username?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!res.ok) return { ok: false };
    const data = await res.json() as { ok: boolean; result?: { username?: string } };
    return { ok: !!data.ok, username: data.result?.username };
  } catch {
    return { ok: false };
  }
}

/**
 * Poll getUpdates until a message arrives from any user, then return that
 * message's chat.id. Rejects after timeoutMs without a message.
 */
async function detectTelegramChatId(token: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=5`);
      if (!res.ok) { await sleep(1000); continue; }
      const data = await res.json() as { result?: Array<{ update_id: number; message?: { chat?: { id: number } } }> };
      if (data.result && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const id = update.message?.chat?.id;
          if (id !== undefined) return String(id);
        }
      }
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Summary + write
// ---------------------------------------------------------------------------

/**
 * The flock root — `~/.flockbots/` by default. Mirrors flockbotsRoot() in
 * paths.ts but lives here so wizard code can resolve the root before
 * paths.ts is imported indirectly via skill seeding etc.
 */
function wizardRoot(): string {
  return process.env.FLOCKBOTS_HOME || join(homedir(), '.flockbots');
}

/**
 * Build a `GitHubAppExisting` from the partial config we've pre-loaded
 * out of .env on a reconfigure run. We deliberately DO NOT check that the
 * .pem file exists on disk — `createGitHubApp` calls `verifyExistingApp`
 * which surfaces a missing pem cleanly through the 3-option picker (hides
 * "keep" so the user has to pick "create new" or "re-create"). Short-
 * circuiting here would force the fresh-install path with the default
 * name — which would then collide with the still-existing GitHub App.
 */
function existingGitHubApp(c: Partial<WizardConfig>, role: 'agent' | 'reviewer'): GitHubAppExisting | undefined {
  const appId = role === 'agent' ? c.githubAppId : c.reviewerGithubAppId;
  const installationId = role === 'agent' ? c.githubAppInstallationId : c.reviewerGithubAppInstallationId;
  const pemPath = role === 'agent' ? c.githubAppPrivateKeyPath : c.reviewerGithubAppPrivateKeyPath;
  if (appId && installationId && pemPath) {
    return { appId, installationId, pemPath };
  }
  return undefined;
}

async function showSummary(p: ClackModule, c: WizardConfig): Promise<boolean> {
  const lines: string[] = [];
  const pad = (label: string) => (label + ':').padEnd(22);
  const slug = process.env.FLOCKBOTS_INSTANCE_ID;
  if (slug) lines.push(`  ${pad('Instance')}${slug}`);
  lines.push(`  ${pad('Claude auth')}${c.claudeAuth === 'max' ? 'Max/Pro OAuth' : 'API key (' + redactValue(c.anthropicApiKey || '') + ')'}`);
  lines.push(`  ${pad('Target repo')}${c.githubOwner}/${c.githubRepo}`);
  lines.push(`  ${pad('Repo path')}${c.targetRepoPath}`);
  if (c.githubStagingBranch === c.githubProdBranch) {
    lines.push(`  ${pad('Branches')}single (${c.githubProdBranch})`);
  } else {
    lines.push(`  ${pad('Branches')}${c.githubStagingBranch} → ${c.githubProdBranch}`);
  }
  lines.push(`  ${pad('Chat provider')}${c.chatProvider}`);
  if (c.chatProvider === 'telegram') {
    lines.push(`  ${pad('Telegram chat ID')}${c.telegramChatId}`);
  } else if (c.chatProvider === 'slack') {
    lines.push(`  ${pad('Slack channel')}${c.slackChannelId}`);
  } else {
    lines.push(`  ${pad('WhatsApp number')}${c.operatorWhatsappNumber}`);
  }
  lines.push(`  ${pad('GitHub App (PR)')}id=${c.githubAppId}, install=${c.githubAppInstallationId}`);
  lines.push(`  ${pad('GitHub App (Review)')}id=${c.reviewerGithubAppId}, install=${c.reviewerGithubAppInstallationId}`);
  lines.push(`  ${pad('Linear')}${c.linearApiKey ? 'enabled' : 'disabled'}`);
  lines.push(`  ${pad('Dashboard')}${c.supabaseUrl ? 'enabled' : 'disabled (CLI-only mode)'}`);
  lines.push(`  ${pad('QA agent')}${c.qaEnabled ? 'enabled' : 'disabled'}`);
  lines.push(`  ${pad('Flock root')}${wizardRoot()}`);

  p.note(lines.join('\n'), 'Summary');
  const ok = await p.confirm({ message: 'Write config and finish setup?', initialValue: true });
  if (p.isCancel(ok)) return false;
  return !!ok;
}

interface WriteConfigPaths {
  /** Flock root, e.g. ~/.flockbots/. Holds shared resources (consolidated.sql, skills-template/). */
  root: string;
  /** Per-instance home, e.g. ~/.flockbots/instances/acme-app/. Holds .env + keys/. */
  instanceHome: string;
  /** This instance's slug. */
  instanceSlug: string;
  /**
   * Shared-key updates to propagate into every other instance's .env.
   * Caller computes the diff (new vs previous values) so propagation only
   * fires for keys that actually changed — avoids no-op writes and the
   * "section X was touched but the values didn't change" footgun.
   * Pass an empty object (or undefined) to skip propagation entirely.
   */
  sharedUpdates?: Record<string, string>;
}

async function writeConfig(
  p: ClackModule,
  c: WizardConfig,
  touched: Set<ReconfigureSection>,
  paths: WriteConfigPaths,
): Promise<void> {
  const { root, instanceHome, instanceSlug, sharedUpdates } = paths;
  mkdirSync(instanceHome, { recursive: true });
  mkdirSync(join(instanceHome, 'keys'), { recursive: true });

  const envPath = join(instanceHome, '.env');
  writeFileSync(envPath, buildEnvContent(c, root, instanceSlug), { mode: 0o600 });
  p.log.success(`Wrote config → ${envPath}`);
  p.log.success(`Keys in → ${join(instanceHome, 'keys')}/`);

  // Propagate any shared values that changed in this run into every other
  // instance's .env. Diff-based: caller passes only the keys whose values
  // actually changed (sharedUpdates), so a no-op reconfigure of a shared
  // section produces no propagation, and a chat-provider edit that
  // happens to change WHATSAPP_VERIFY_TOKEN propagates correctly even
  // though chat-provider isn't classified as a "shared section."
  if (sharedUpdates && Object.keys(sharedUpdates).length > 0) {
    const propagated = propagateSharedValues(root, instanceSlug, sharedUpdates);
    if (propagated.length > 0) {
      p.log.success(
        `Propagated shared values to ${propagated.length} other instance${propagated.length === 1 ? '' : 's'}: ${propagated.join(', ')}`
      );
    }
  }

  // Side-effect: re-apply Supabase migration only when supabase or
  // dashboard-admin was touched this run AND no sibling already runs
  // against the same Supabase URL. Two skip cases:
  //   1. Reconfigure that didn't touch Supabase (e.g., rotating a Telegram
  //      token) — sectionsToRun won't include 'supabase'.
  //   2. Adding instance N>=2 — Supabase + dashboard-admin sections process
  //      via silent reuse from the first instance, so they're "touched" in
  //      bookkeeping even though the user never saw a prompt. Migration was
  //      applied during that first instance's setup; running it again would
  //      ask the user to paste it for nothing.
  if (c.supabaseUrl) {
    const supabaseTouched = touched.has('supabase') || touched.has('dashboard-admin');
    const siblingWithSameSupabase = readSiblingSupabaseValues(instanceSlug);
    const alreadyAppliedBySibling = siblingWithSameSupabase?.url === c.supabaseUrl;
    if (supabaseTouched && !alreadyAppliedBySibling) {
      const admin = c.dashboardAdminEmail && c.dashboardAdminPassword
        ? { email: c.dashboardAdminEmail, password: c.dashboardAdminPassword }
        : undefined;
      await applySupabaseMigration(p, c.supabaseUrl, root, admin);
    } else if (supabaseTouched && alreadyAppliedBySibling) {
      p.log.info(
        `Supabase schema already applied during instance '${siblingWithSameSupabase!.fromSlug}' setup — skipping.`
      );
    }
  }

  // pm2 powers the "Next steps" start command. Detect + offer to install
  // before printing the note so the start command actually runs on first try.
  await offerPm2Install(p);

  // Build the next-steps note. Different commands matter for different
  // configs — only mention the ones the user actually needs.
  const nextSteps: string[] = [
    `Config saved to ${envPath}`,
    `Keys saved to ${join(instanceHome, 'keys')}/`,
    '',
    'Start FlockBots:',
    `  cd ${root}`,
    '  pm2 start ecosystem.config.js',
    `  pm2 logs flockbots:${instanceSlug}`,
    '',
    `Then send a message to your ${c.chatProvider === 'telegram' ? 'Telegram bot' : c.chatProvider === 'slack' ? 'Slack channel' : 'WhatsApp number'} to kick off a task.`,
  ];

  const deployCmds: string[] = [];
  if (c.supabaseUrl) deployCmds.push('  flockbots dashboard deploy   # put the web dashboard on Vercel');
  if (c.chatProvider === 'whatsapp') deployCmds.push('  flockbots webhook deploy     # required for WhatsApp inbound messages');
  if (deployCmds.length > 0) {
    nextSteps.push('', 'When you\'re ready, deploy with:', ...deployCmds);
  }

  p.note(nextSteps.join('\n'), 'Next steps');
}

/**
 * Keys whose values are duplicated across every instance's .env.
 * SUPABASE_* — one project hosts the dashboard for all instances.
 * WHATSAPP_VERIFY_TOKEN — one shared verify token is held by the relay's
 *   Vercel env vars, and Meta verifies each per-instance webhook URL with
 *   the same token. Per-instance verify tokens would require per-instance
 *   relay env vars or a per-slug lookup table; not worth the complexity.
 */
const SHARED_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'WHATSAPP_VERIFY_TOKEN',
] as const;

function collectSharedValues(c: WizardConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (c.supabaseUrl) {
    out.SUPABASE_URL = c.supabaseUrl;
    out.VITE_SUPABASE_URL = c.supabaseUrl;
  }
  if (c.supabaseServiceRoleKey) out.SUPABASE_SERVICE_ROLE_KEY = c.supabaseServiceRoleKey;
  if (c.supabaseAnonKey) {
    out.SUPABASE_ANON_KEY = c.supabaseAnonKey;
    out.VITE_SUPABASE_ANON_KEY = c.supabaseAnonKey;
  }
  if (c.whatsappVerifyToken) out.WHATSAPP_VERIFY_TOKEN = c.whatsappVerifyToken;
  return out;
}

/**
 * Update SHARED_ENV_KEYS in every instance's .env except the one we just
 * wrote. Preserves comments, ordering, and any keys we don't touch. Returns
 * the slugs that were updated so the caller can report them.
 */
function propagateSharedValues(
  root: string,
  excludeSlug: string,
  values: Record<string, string>,
): string[] {
  const updated: string[] = [];
  const otherSlugs = listInstanceSlugs().filter((s) => s !== excludeSlug);
  for (const slug of otherSlugs) {
    const envPath = join(instancesDir(), slug, '.env');
    if (!existsSync(envPath)) continue;
    try {
      const original = readFileSync(envPath, 'utf-8');
      const next = applyEnvUpdates(original, values);
      if (next !== original) {
        writeFileSync(envPath, next, { mode: 0o600 });
        updated.push(slug);
      }
    } catch {
      // Skip unreadable .env — defensive only
    }
  }
  return updated;
}

/**
 * Update KEY=VALUE lines in an existing .env, preserving everything else.
 * Keys not present in the file are appended at the end. Values are written
 * verbatim — caller is responsible for any quoting.
 */
function applyEnvUpdates(content: string, updates: Record<string, string>): string {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const out = lines.map((rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return rawLine;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return rawLine;
    const key = line.slice(0, eqIdx).trim();
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return rawLine;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  return out.join('\n');
}

/**
 * Parse a Supabase project URL and return the project ref (subdomain).
 * `https://tmgdnegbdzokvihtzjov.supabase.co` → `tmgdnegbdzokvihtzjov`.
 * Returns null for anything that doesn't match the standard Supabase host.
 */
function supabaseProjectRef(url: string): string | null {
  const m = url.trim().match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  return m ? m[1] : null;
}

/**
 * Walk the user through applying consolidated.sql to their Supabase project.
 * Offers three paths: automatic via the Management API (needs a PAT, one
 * HTTP call, nothing stored after), manual paste in the SQL editor (opens
 * the browser + clipboards the SQL on macOS), or skip.
 *
 * If `admin` is provided, the consolidated SQL is appended with a bootstrap
 * block that creates (or updates) an auth.users row for that email/password
 * so the operator can log into the dashboard as soon as it deploys.
 */
async function applySupabaseMigration(
  p: ClackModule,
  supabaseUrl: string,
  root: string,
  admin?: { email: string; password: string },
): Promise<void> {
  const ref = supabaseProjectRef(supabaseUrl);
  const sqlPath = join(root, 'supabase', 'migrations', 'consolidated.sql');

  if (!existsSync(sqlPath)) {
    p.log.error(`Migration file not found at ${sqlPath}`);
    return;
  }

  // Base migration + bootstrap admin block (if creds were collected)
  let sql = readFileSync(sqlPath, 'utf-8');
  if (admin) {
    sql += '\n' + buildBootstrapAdminSql(admin.email, admin.password);
  }

  p.note(
    help([
      "FlockBots' dashboard needs tables, RLS policies, and realtime",
      "subscriptions set up in your Supabase project before it can read",
      "any data. This is a single idempotent SQL migration — safe to",
      "re-run on an existing project.",
      admin ? '' : '',
      admin ? `Will also create the dashboard login for ${admin.email}.` : '',
    ].filter(Boolean).join('\n')),
    'Supabase schema migration'
  );

  const mode = await p.select({
    message: 'How should the migration be applied?',
    options: [
      { value: 'auto',   label: 'Apply automatically',         hint: 'via a one-time Supabase Personal Access Token' },
      { value: 'manual', label: 'Paste it myself',              hint: 'opens the SQL editor; SQL copied to clipboard on macOS' },
      { value: 'skip',   label: "Skip — I'll do it later" },
    ],
    initialValue: 'auto',
  });
  if (p.isCancel(mode)) return;
  if (mode === 'skip') {
    p.log.warn(`Skipped. Dashboard will 404 on queries until you apply ${sqlPath} in the Supabase SQL editor.`);
    if (admin) p.log.warn('(Dashboard login was not created — re-run `flockbots init` when you are ready.)');
    return;
  }

  let applied = false;
  if (mode === 'auto' && ref) {
    applied = await applyViaManagementAPI(p, ref, sql);
    if (!applied) p.log.info('Falling back to the manual paste flow.');
  } else if (mode === 'auto' && !ref) {
    p.log.warn(`Couldn't parse a project ref from ${supabaseUrl}. Falling back to manual.`);
  }

  if (!applied) {
    await applyViaManualPaste(p, ref, sql, root);
  }

  if (admin) {
    p.note(
      help([
        `Dashboard login is ${admin.email} + the password you entered.`,
        '',
        'Security note: Supabase allows public email signups by default,',
        'which means anyone with your anon key could create an account.',
        'For a private dashboard, disable signups in your Supabase project:',
        '  Authentication → Providers → Email → Enable Sign Ups: OFF',
      ].join('\n')),
      'Dashboard login ready'
    );
  }
}

/**
 * Apply an in-memory SQL string via Supabase's Management API — POST
 * /v1/projects/<ref>/database/query with the SQL as a JSON body. One HTTP
 * call, runs as a transaction on Supabase's side. Returns false on any
 * failure so the caller falls back to manual paste.
 */
async function applyViaManagementAPI(p: ClackModule, ref: string, sql: string): Promise<boolean> {
  p.note(help([
    'Go to https://supabase.com/dashboard/account/tokens',
    'Click "Generate new token", name it "FlockBots".',
    '',
    'The token is used once to run the migration and not stored after.',
  ].join('\n')), 'Supabase Personal Access Token');

  openBrowser('https://supabase.com/dashboard/account/tokens');

  const pat = await p.password({
    message: 'Personal Access Token (starts with sbp_):',
    validate: (v) => (v && v.length >= 20 ? undefined : 'Required — paste the token you just created'),
  });
  if (p.isCancel(pat)) return false;

  const spin = p.spinner();
  spin.start('Applying migration via Supabase Management API');
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat as string}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) {
      const body = await res.text();
      spin.stop(`Migration failed (HTTP ${res.status})`);
      p.log.error(body.slice(0, 400));
      return false;
    }
    spin.stop('Migration applied');
    return true;
  } catch (err: any) {
    spin.stop('Migration failed');
    p.log.error(err?.message || String(err));
    return false;
  }
}

/**
 * Build the bootstrap admin-user SQL block that gets appended to the
 * consolidated migration. Creates (or updates — idempotent) a row in
 * auth.users + auth.identities for the given email/password, using
 * pgcrypto's bcrypt for password hashing (pre-installed on Supabase).
 *
 * Single-quotes in email/password are escaped by doubling them so user
 * input with apostrophes doesn't break the DO block.
 */
function buildBootstrapAdminSql(email: string, password: string): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  return [
    '',
    '-- -----------------------------------------------------------------------------',
    '-- Bootstrap admin user (appended by `flockbots init`)',
    '-- -----------------------------------------------------------------------------',
    '-- Creates or updates an auth.users row for the email/password entered in',
    "-- the wizard, so the dashboard login works as soon as it's deployed.",
    '-- Uses pgcrypto (pre-installed on Supabase) for bcrypt hashing.',
    'DO $bootstrap$',
    'DECLARE',
    `  v_email TEXT := '${esc(email)}';`,
    `  v_password TEXT := '${esc(password)}';`,
    '  v_user_id UUID;',
    'BEGIN',
    '  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email;',
    '',
    '  IF v_user_id IS NOT NULL THEN',
    '    -- Existing user — rotate password, re-confirm if needed',
    '    UPDATE auth.users',
    "      SET encrypted_password = crypt(v_password, gen_salt('bf', 10)),",
    '          email_confirmed_at = COALESCE(email_confirmed_at, NOW()),',
    '          updated_at = NOW()',
    '      WHERE id = v_user_id;',
    '  ELSE',
    '    -- Fresh user — create auth.users + matching auth.identities row',
    '    v_user_id := gen_random_uuid();',
    '    INSERT INTO auth.users (',
    '      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,',
    '      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,',
    '      confirmation_token, email_change, email_change_token_new, recovery_token',
    '    ) VALUES (',
    "      '00000000-0000-0000-0000-000000000000', v_user_id,",
    "      'authenticated', 'authenticated', v_email,",
    "      crypt(v_password, gen_salt('bf', 10)), NOW(),",
    `      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,`,
    "      NOW(), NOW(), '', '', '', ''",
    '    );',
    '    INSERT INTO auth.identities (',
    '      id, user_id, identity_data, provider, provider_id,',
    '      last_sign_in_at, created_at, updated_at',
    '    ) VALUES (',
    '      gen_random_uuid(), v_user_id,',
    "      jsonb_build_object('sub', v_user_id::text, 'email', v_email),",
    "      'email', v_email,",
    '      NOW(), NOW(), NOW()',
    '    );',
    '  END IF;',
    'END',
    '$bootstrap$;',
    '',
  ].join('\n');
}

// Vercel deploy flows live in dashboard-deploy.ts and webhook-deploy.ts as
// of v1.0.3 — the wizard prints a "Next steps" note pointing at those
// commands instead of running the deploy inline. Decoupling means a re-
// configure that doesn't touch Supabase/WhatsApp doesn't drag the user
// through Vercel prompts they don't need.

/** Paste-it-yourself fallback — copy SQL to clipboard on macOS, open SQL editor. */
async function applyViaManualPaste(p: ClackModule, ref: string | null, sql: string, root: string): Promise<void> {
  // Write the (possibly-augmented-with-admin-bootstrap) SQL to a tmp file
  // so users on non-macOS can still find it. On macOS we also copy to
  // clipboard for one-step paste.
  const tmpPath = join(root, 'tmp-migration.sql');
  try { writeFileSync(tmpPath, sql, { mode: 0o600 }); } catch { /* best effort */ }

  let clipboardOk = false;
  if (process.platform === 'darwin') {
    try {
      execSync('pbcopy', { input: sql });
      clipboardOk = true;
    } catch { /* best effort */ }
  }

  p.note(
    help([
      ref
        ? 'Opening the Supabase SQL editor for your project in the browser.'
        : 'Open the SQL editor in your Supabase dashboard.',
      '',
      clipboardOk
        ? 'I copied the migration SQL to your clipboard — just paste and click Run.'
        : `Paste the contents of ${tmpPath} into the editor, then click Run.`,
      '',
      'One-time setup. Come back here once the query finishes.',
    ].join('\n')),
    'Next steps in the browser'
  );

  if (ref) openBrowser(`https://supabase.com/dashboard/project/${ref}/sql/new`);

  const applied = await p.confirm({ message: 'Migration applied?', initialValue: true });
  if (p.isCancel(applied) || !applied) {
    p.log.warn('Skipped. Dashboard will 404 on queries until the migration runs.');
  }

  // Clean up tmp file — contains the bcrypt-hashable password in plaintext
  try { require('fs').unlinkSync(tmpPath); } catch { /* best effort */ }
}

/** Build the .env contents from the collected wizard config. */
function buildEnvContent(c: WizardConfig, root: string, instanceSlug: string): string {
  const out: string[] = [
    '# FlockBots configuration',
    `# Generated by \`flockbots init\` on ${new Date().toISOString()}`,
    '# Re-run the wizard to regenerate. Values inline-edit at your own risk.',
    '',
    '# --- Anthropic auth ---',
  ];
  if (c.claudeAuth === 'api_key' && c.anthropicApiKey) {
    out.push(`ANTHROPIC_API_KEY=${c.anthropicApiKey}`);
  } else {
    out.push('# (using Claude Max OAuth via `claude login`; ANTHROPIC_API_KEY left blank)');
    out.push('ANTHROPIC_API_KEY=');
  }
  out.push(
    '',
    '# --- GitHub Apps ---',
    `GITHUB_APP_ID=${c.githubAppId}`,
    `GITHUB_APP_PRIVATE_KEY_PATH=${c.githubAppPrivateKeyPath}`,
    `GITHUB_APP_INSTALLATION_ID=${c.githubAppInstallationId}`,
    `REVIEWER_GITHUB_APP_ID=${c.reviewerGithubAppId}`,
    `REVIEWER_GITHUB_APP_PRIVATE_KEY_PATH=${c.reviewerGithubAppPrivateKeyPath}`,
    `REVIEWER_GITHUB_APP_INSTALLATION_ID=${c.reviewerGithubAppInstallationId}`,
    `GITHUB_OWNER=${c.githubOwner}`,
    `GITHUB_REPO=${c.githubRepo}`,
    `GITHUB_STAGING_BRANCH=${c.githubStagingBranch || 'main'}`,
    `GITHUB_PROD_BRANCH=${c.githubProdBranch || 'main'}`,
    '',
    '# --- Chat provider ---',
    `CHAT_PROVIDER=${c.chatProvider}`,
  );
  if (c.chatProvider === 'telegram') {
    out.push(
      `TELEGRAM_BOT_TOKEN=${c.telegramBotToken}`,
      `TELEGRAM_CHAT_ID=${c.telegramChatId}`,
    );
  } else if (c.chatProvider === 'slack') {
    out.push(
      `SLACK_BOT_TOKEN=${c.slackBotToken}`,
      `SLACK_APP_TOKEN=${c.slackAppToken}`,
      `SLACK_CHANNEL_ID=${c.slackChannelId}`,
    );
  } else {
    out.push(
      `WHATSAPP_PHONE_NUMBER_ID=${c.whatsappPhoneNumberId}`,
      `WHATSAPP_ACCESS_TOKEN=${c.whatsappAccessToken}`,
      `WHATSAPP_APP_SECRET=${c.whatsappAppSecret || ''}`,
      `WHATSAPP_VERIFY_TOKEN=${c.whatsappVerifyToken}`,
      `OPERATOR_WHATSAPP_NUMBER=${c.operatorWhatsappNumber}`,
      'WHATSAPP_WEBHOOK_PORT=3001',
    );
  }
  out.push('', '# --- Linear (optional) ---');
  if (c.linearApiKey) {
    out.push(
      `LINEAR_API_KEY=${c.linearApiKey}`,
      `LINEAR_TEAM_ID=${c.linearTeamId}`,
      `LINEAR_PROJECT_ID=${c.linearProjectId || ''}`,
    );
    if (c.linearProjectName) {
      out.push(`# LINEAR_PROJECT_NAME=${c.linearProjectName}  (display only — coordinator filters by ID)`);
    }
  } else {
    out.push('LINEAR_API_KEY=');
  }
  out.push('LINEAR_AGENT_READY_LABEL=agent-ready');

  out.push('', '# --- Supabase + dashboard (optional) ---');
  if (c.supabaseUrl) {
    out.push(
      `SUPABASE_URL=${c.supabaseUrl}`,
      `SUPABASE_SERVICE_ROLE_KEY=${c.supabaseServiceRoleKey}`,
      `SUPABASE_ANON_KEY=${c.supabaseAnonKey || ''}`,
      `VITE_SUPABASE_URL=${c.supabaseUrl}`,
      `VITE_SUPABASE_ANON_KEY=${c.supabaseAnonKey || ''}`,
      'SUPABASE_STORAGE_BUCKET_WIREFRAMES=wireframes',
    );
  } else {
    out.push('SUPABASE_URL=', 'SUPABASE_SERVICE_ROLE_KEY=', 'SUPABASE_ANON_KEY=');
  }

  out.push('', '# --- QA agent (optional) ---');
  out.push(`QA_ENABLED=${c.qaEnabled === true}`);
  if (c.qaEnabled) {
    out.push(
      `STAGING_BASE_URL=${c.stagingBaseUrl}`,
      `QA_TEST_EMAIL=${c.qaTestEmail}`,
      `QA_TEST_PASSWORD=${c.qaTestPassword}`,
      'SUPABASE_STORAGE_BUCKET_QA=qa-media',
      'QA_HEADLESS=true',
      'QA_DEPLOY_WAIT_MS=300000',
    );
  }

  out.push(
    '',
    '# --- Paths ---',
    `TARGET_REPO_PATH=${c.targetRepoPath}`,
    `FLOCKBOTS_HOME=${root}`,
    `FLOCKBOTS_INSTANCE_ID=${instanceSlug}`,
    '',
  );
  return out.join('\n');
}
