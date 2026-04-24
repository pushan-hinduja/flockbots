import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { readFileSync } from 'fs';
import { logEvent } from './queue';

interface CachedClient {
  octokit: Octokit | null;
  expiresAt: number;
}

const coordinatorClient: CachedClient = { octokit: null, expiresAt: 0 };
const reviewerClient: CachedClient = { octokit: null, expiresAt: 0 };

async function getGitHubClient(
  cache: CachedClient,
  appIdVar: string, keyPathVar: string, installIdVar: string,
  label: string
): Promise<Octokit> {
  const now = Date.now();
  if (cache.octokit && cache.expiresAt > now + 5 * 60 * 1000) {
    return cache.octokit;
  }

  const appId = process.env[appIdVar];
  const keyPath = process.env[keyPathVar];
  const installId = process.env[installIdVar];
  if (!appId || !keyPath || !installId) {
    throw new Error(`Missing GitHub App env vars: ${appIdVar}, ${keyPathVar}, ${installIdVar}`);
  }

  const auth = createAppAuth({
    appId,
    privateKey: readFileSync(keyPath, 'utf-8'),
    installationId: Number(installId),
  });

  const installAuth = await auth({ type: 'installation' });
  cache.expiresAt = installAuth.expiresAt ? new Date(installAuth.expiresAt).getTime() : now + 55 * 60 * 1000;
  cache.octokit = new Octokit({ auth: installAuth.token });

  logEvent(null, 'system', 'github_auth_refresh', `${label} GitHub App token refreshed`);
  return cache.octokit;
}

/** Coordinator app — creates PRs, pushes branches, merges */
export async function getOctokit(): Promise<Octokit> {
  return getGitHubClient(
    coordinatorClient,
    'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID',
    'Coordinator'
  );
}

/** Reviewer app — posts formal PR reviews (APPROVE / REQUEST_CHANGES) */
export async function getReviewerOctokit(): Promise<Octokit> {
  return getGitHubClient(
    reviewerClient,
    'REVIEWER_GITHUB_APP_ID', 'REVIEWER_GITHUB_APP_PRIVATE_KEY_PATH', 'REVIEWER_GITHUB_APP_INSTALLATION_ID',
    'Reviewer'
  );
}

export const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
export const GITHUB_REPO = process.env.GITHUB_REPO || '';
export const GITHUB_STAGING_BRANCH = process.env.GITHUB_STAGING_BRANCH || 'staging';
export const GITHUB_PROD_BRANCH = process.env.GITHUB_PROD_BRANCH || 'master';
