import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { WizardConfig } from './wizard';
import { parseEnvFile } from './env-parser';
import { readState, type FlockBotsState } from './state-file';

type ClackModule = typeof import('@clack/prompts');

/**
 * Canonical list of user-pickable reconfigure sections. Order matches the
 * wizard step order so the picker reads top-to-bottom like the install flow.
 */
export const ALL_SECTIONS = [
  'claude-auth',
  'target-repo',
  'chat-provider',
  'github-apps',
  'branches',
  'linear',
  'supabase',
  'dashboard-admin',
  'qa',
  'knowledge-graph',
] as const;

export type ReconfigureSection = typeof ALL_SECTIONS[number];

/**
 * Sections whose values are shared across all instances. Editing one of
 * these in any instance's reconfigure flow propagates the new values into
 * every other instance's .env. Per-instance flows still display them so
 * users can edit from anywhere; the wizard prompts a multi-instance
 * confirmation before saving.
 */
const SHARED_SECTIONS = new Set<ReconfigureSection>(['supabase', 'dashboard-admin']);

export function isSharedSection(s: ReconfigureSection): boolean {
  return SHARED_SECTIONS.has(s);
}

/**
 * Snapshot of what's already installed — .env values, whether .pem files
 * still exist on disk, whether the knowledge graph has been built. Built
 * once at the top of the wizard and passed around so we never re-stat the
 * same paths twice.
 */
export interface ExistingConfigSnapshot {
  home: string;
  envPath: string;
  envExists: boolean;
  /** Partial<WizardConfig> hydrated from .env via hydrateConfig(). */
  config: Partial<WizardConfig>;
  /** Raw KEY=VALUE map, in case downstream wants to read a key we don't surface yet. */
  rawEnv: Record<string, string>;
  agentPemExists: boolean;
  reviewerPemExists: boolean;
  knowledgeGraphBuilt: boolean;
  knowledgeGraphBuiltAt?: string;
  state: FlockBotsState | null;
}

/**
 * Read .env + known sidecar files into a snapshot. Does NOT hit the network
 * (no GitHub App aliveness check yet — that happens at reconfigure time for
 * the github-apps section, where a failed API call can drive the UX).
 */
export function detectExistingConfig(home: string): ExistingConfigSnapshot {
  const envPath = join(home, '.env');
  const envExists = existsSync(envPath);
  const rawEnv = envExists ? parseEnvFile(envPath) : {};
  const config = hydrateConfig(rawEnv);

  const agentPemExists = !!config.githubAppPrivateKeyPath && existsSync(config.githubAppPrivateKeyPath);
  const reviewerPemExists = !!config.reviewerGithubAppPrivateKeyPath && existsSync(config.reviewerGithubAppPrivateKeyPath);

  const graphPath = join(home, 'skills', 'kg', 'graph.json');
  const knowledgeGraphBuilt = existsSync(graphPath);
  const state = readState(home);
  let knowledgeGraphBuiltAt = state?.knowledgeGraphBuiltAt;
  if (knowledgeGraphBuilt && !knowledgeGraphBuiltAt) {
    try { knowledgeGraphBuiltAt = statSync(graphPath).mtime.toISOString(); } catch { /* ignore */ }
  }

  return {
    home, envPath, envExists, config, rawEnv,
    agentPemExists, reviewerPemExists,
    knowledgeGraphBuilt, knowledgeGraphBuiltAt,
    state,
  };
}

/**
 * Central type coercion: .env is all strings, WizardConfig has typed fields.
 * Missing keys stay undefined (not empty string), so "ANTHROPIC_API_KEY="
 * and a totally absent key both land as `apiKey: undefined`.
 */
export function hydrateConfig(env: Record<string, string>): Partial<WizardConfig> {
  const c: Partial<WizardConfig> = {};

  if (val(env.ANTHROPIC_API_KEY)) {
    c.claudeAuth = 'api_key';
    c.anthropicApiKey = env.ANTHROPIC_API_KEY;
  } else if ('ANTHROPIC_API_KEY' in env) {
    // Key present but blank → Max mode
    c.claudeAuth = 'max';
  }

  if (val(env.TARGET_REPO_PATH)) c.targetRepoPath = env.TARGET_REPO_PATH;

  const provider = val(env.CHAT_PROVIDER);
  if (provider === 'telegram' || provider === 'whatsapp' || provider === 'slack') {
    c.chatProvider = provider;
  }
  if (val(env.TELEGRAM_BOT_TOKEN)) c.telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  if (val(env.TELEGRAM_CHAT_ID)) c.telegramChatId = env.TELEGRAM_CHAT_ID;
  if (val(env.SLACK_BOT_TOKEN)) c.slackBotToken = env.SLACK_BOT_TOKEN;
  if (val(env.SLACK_APP_TOKEN)) c.slackAppToken = env.SLACK_APP_TOKEN;
  if (val(env.SLACK_CHANNEL_ID)) c.slackChannelId = env.SLACK_CHANNEL_ID;
  if (val(env.WHATSAPP_PHONE_NUMBER_ID)) c.whatsappPhoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (val(env.WHATSAPP_ACCESS_TOKEN)) c.whatsappAccessToken = env.WHATSAPP_ACCESS_TOKEN;
  if (val(env.WHATSAPP_APP_SECRET)) c.whatsappAppSecret = env.WHATSAPP_APP_SECRET;
  if (val(env.WHATSAPP_VERIFY_TOKEN)) c.whatsappVerifyToken = env.WHATSAPP_VERIFY_TOKEN;
  if (val(env.OPERATOR_WHATSAPP_NUMBER)) c.operatorWhatsappNumber = env.OPERATOR_WHATSAPP_NUMBER;

  if (val(env.GITHUB_APP_ID)) c.githubAppId = Number(env.GITHUB_APP_ID);
  if (val(env.GITHUB_APP_PRIVATE_KEY_PATH)) c.githubAppPrivateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (val(env.GITHUB_APP_INSTALLATION_ID)) c.githubAppInstallationId = Number(env.GITHUB_APP_INSTALLATION_ID);
  if (val(env.REVIEWER_GITHUB_APP_ID)) c.reviewerGithubAppId = Number(env.REVIEWER_GITHUB_APP_ID);
  if (val(env.REVIEWER_GITHUB_APP_PRIVATE_KEY_PATH)) c.reviewerGithubAppPrivateKeyPath = env.REVIEWER_GITHUB_APP_PRIVATE_KEY_PATH;
  if (val(env.REVIEWER_GITHUB_APP_INSTALLATION_ID)) c.reviewerGithubAppInstallationId = Number(env.REVIEWER_GITHUB_APP_INSTALLATION_ID);
  if (val(env.GITHUB_OWNER)) c.githubOwner = env.GITHUB_OWNER;
  if (val(env.GITHUB_REPO)) c.githubRepo = env.GITHUB_REPO;
  if (val(env.GITHUB_STAGING_BRANCH)) c.githubStagingBranch = env.GITHUB_STAGING_BRANCH;
  if (val(env.GITHUB_PROD_BRANCH)) c.githubProdBranch = env.GITHUB_PROD_BRANCH;

  if (val(env.LINEAR_API_KEY)) c.linearApiKey = env.LINEAR_API_KEY;
  if (val(env.LINEAR_TEAM_ID)) c.linearTeamId = env.LINEAR_TEAM_ID;
  if (val(env.LINEAR_PROJECT_ID)) c.linearProjectId = env.LINEAR_PROJECT_ID;

  if (val(env.SUPABASE_URL)) c.supabaseUrl = env.SUPABASE_URL;
  if (val(env.SUPABASE_SERVICE_ROLE_KEY)) c.supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (val(env.SUPABASE_ANON_KEY)) c.supabaseAnonKey = env.SUPABASE_ANON_KEY;

  // Dashboard admin email is NOT written to .env (password never is, email
  // isn't either — it lives in Supabase auth.users). So there's no hydrate
  // path for dashboardAdminEmail; reconfigure always re-prompts.

  c.qaEnabled = val(env.QA_ENABLED) === 'true';
  if (val(env.STAGING_BASE_URL)) c.stagingBaseUrl = env.STAGING_BASE_URL;
  if (val(env.QA_TEST_EMAIL)) c.qaTestEmail = env.QA_TEST_EMAIL;
  if (val(env.QA_TEST_PASSWORD)) c.qaTestPassword = env.QA_TEST_PASSWORD;

  return c;
}

function val(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Show the multi-select picker with "current value" hints so the user can
 * eyeball what's configured without opening .env. Returns the selected
 * section keys, or null on Ctrl-C. Empty array is a valid return — means
 * "nothing to do," handled by the caller.
 */
export async function pickSectionsToReconfigure(
  p: ClackModule,
  snap: ExistingConfigSnapshot,
): Promise<ReconfigureSection[] | null> {
  const options = ALL_SECTIONS.map(s => ({
    value: s,
    label: sectionLabel(s, snap),
    hint: isSharedSection(s) ? 'shared — affects all instances' : undefined,
  }));

  const picked = await p.multiselect({
    message: 'Which sections do you want to reconfigure?',
    options,
    required: false,
  });
  if (p.isCancel(picked)) return null;
  return picked as ReconfigureSection[];
}

function sectionLabel(s: ReconfigureSection, snap: ExistingConfigSnapshot): string {
  const c = snap.config;
  switch (s) {
    case 'claude-auth':
      return `Claude auth — ${c.claudeAuth === 'api_key' ? 'API key' : c.claudeAuth === 'max' ? 'Max/Pro OAuth' : 'not set'}`;
    case 'target-repo':
      return `Target repo — ${c.targetRepoPath || 'not set'}`;
    case 'chat-provider':
      return `Chat provider — ${c.chatProvider || 'not set'}`;
    case 'github-apps': {
      const stale: string[] = [];
      if (!snap.agentPemExists) stale.push('agent .pem missing');
      if (!snap.reviewerPemExists) stale.push('reviewer .pem missing');
      const tag = stale.length > 0 ? ` (STALE — ${stale.join(', ')})` : '';
      return `GitHub Apps — agent=${c.githubAppId ?? '?'}, reviewer=${c.reviewerGithubAppId ?? '?'}${tag}`;
    }
    case 'branches':
      if (c.githubStagingBranch && c.githubProdBranch && c.githubStagingBranch === c.githubProdBranch) {
        return `Branches — single (${c.githubProdBranch})`;
      }
      return `Branches — ${c.githubStagingBranch || '?'} → ${c.githubProdBranch || '?'}`;
    case 'linear':
      return `Linear — ${c.linearApiKey ? 'enabled' : 'disabled'}`;
    case 'supabase':
      return `Supabase — ${c.supabaseUrl ? c.supabaseUrl : 'disabled'}`;
    case 'dashboard-admin':
      if (!c.supabaseUrl) return 'Dashboard admin — requires Supabase';
      return 'Dashboard admin — re-prompt email + password, re-run bootstrap';
    case 'qa':
      return `QA agent — ${c.qaEnabled ? 'enabled' : 'disabled'}`;
    case 'knowledge-graph': {
      if (!snap.knowledgeGraphBuilt) return 'Knowledge graph — not built';
      const when = snap.knowledgeGraphBuiltAt ? ` (built ${formatRelative(snap.knowledgeGraphBuiltAt)})` : '';
      return `Knowledge graph — built${when}`;
    }
  }
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return 'today';
  const days = Math.floor(diffMs / day);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Auto-expand dependencies: a section that needs another section's output
 * pulls that one in — but ONLY if the needed section isn't already
 * configured. Re-selecting QA shouldn't force a Supabase reconfigure when
 * Supabase is already set up.
 *
 * Returns both the expanded list and the newly-added sections so the caller
 * can tell the user what got pulled in.
 */
export function expandDependencies(
  sections: ReconfigureSection[],
  existing: Partial<WizardConfig>,
): { expanded: ReconfigureSection[]; added: ReconfigureSection[] } {
  const result = new Set<ReconfigureSection>(sections);
  const added = new Set<ReconfigureSection>();

  const pullIn = (s: ReconfigureSection) => {
    if (!result.has(s)) { result.add(s); added.add(s); }
  };

  // github-apps / branches need a local target repo path
  if ((result.has('github-apps') || result.has('branches')) && !existing.targetRepoPath) {
    pullIn('target-repo');
  }

  // dashboard-admin / qa need Supabase
  if ((result.has('dashboard-admin') || result.has('qa')) && !existing.supabaseUrl) {
    pullIn('supabase');
  }

  // Preserve canonical wizard order in the output
  const expanded = ALL_SECTIONS.filter(s => result.has(s));
  const addedOrdered = ALL_SECTIONS.filter(s => added.has(s));
  return { expanded, added: addedOrdered };
}
