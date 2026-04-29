import { createServer, Server } from 'http';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { createAppAuth } from '@octokit/auth-app';
import { keysDir, instancesDir, listInstanceSlugs } from '../paths';
import { renderDuckSvg, help } from './brand';

export interface GitHubAppResult {
  appId: number;
  installationId: number;
  pemPath: string;
  name: string;
}

/**
 * Identifying details of a previously-created GitHub App. Passed in by
 * the wizard during reconfigure so `createGitHubApp` can offer to keep
 * the existing app instead of forcing a re-create.
 */
export interface GitHubAppExisting {
  appId: number;
  installationId: number;
  pemPath: string;
}

export interface CreateGitHubAppOptions {
  /**
   * If set, offers the 3-option reconfigure choice (use existing /
   * create new with custom name / re-create after manual deletion)
   * instead of going straight into the manifest flow.
   */
  existing?: GitHubAppExisting;
  /**
   * Sibling instances that already have this role's app configured.
   * When non-empty AND `existing` is not set (i.e. fresh-install path
   * for instance N>=2), the wizard offers "Reuse from existing instance"
   * as the default option — same app, just install it on this repo.
   */
  reusableFromSiblings?: SiblingApp[];
  /**
   * The new instance's target repo. Required when `reusableFromSiblings`
   * is non-empty so the wizard can verify the installation has access
   * (and prompt the user to add the repo if not).
   */
  newRepo?: { owner: string; repo: string };
  /**
   * The new instance's home dir. Required when `reusableFromSiblings`
   * is non-empty so the wizard can copy the .pem into <home>/keys/.
   */
  newInstanceHome?: string;
}

/**
 * Snapshot of a sibling instance's GitHub App credentials, suitable for
 * "reuse on this repo" flows. Populated by `findReusableApps()` from each
 * sibling's .env.
 */
export interface SiblingApp {
  slug: string;
  appId: number;
  installationId: number;
  pemPath: string;
}

export type ClackModule = typeof import('@clack/prompts');

// Process-scoped flag: once the user confirms they're signed into github.com,
// don't re-ask within the same wizard run (the wizard creates two apps back-
// to-back, and the github.com session is shared across both flows).
let signedInConfirmed = false;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Walk the user through creating (or selecting) a GitHub App.
 *
 * Three modes, depending on what comes in via `opts.existing`:
 *   1. Fresh install (no `existing`) — prompt for name (default
 *      "FlockBots Agent" / "FlockBots Reviewer"), then run the manifest
 *      flow to create the app.
 *   2. Reconfigure with verifiable existing app — show 3-option select:
 *      keep / create new with custom name / re-create with default name.
 *   3. Reconfigure with broken existing app — same 3-option select but
 *      "keep" is disabled because the JWT call failed.
 */
export async function createGitHubApp(
  p: ClackModule,
  role: 'agent' | 'reviewer',
  opts: CreateGitHubAppOptions = {},
): Promise<GitHubAppResult | null> {
  const label = role === 'agent' ? 'PR creator' : 'Reviewer';
  const defaultName = role === 'agent' ? 'FlockBots Agent' : 'FlockBots Reviewer';

  // ---- Reconfigure path: 3-option choice -----------------------------------
  if (opts.existing) {
    const existing = opts.existing;
    const aliveSpin = p.spinner();
    aliveSpin.start(`Checking the existing ${label} app on GitHub`);
    const alive = await verifyExistingApp(existing.appId, existing.pemPath, existing.installationId);
    if (alive.ok) {
      aliveSpin.stop(`Existing app is alive: ${alive.name} (id=${existing.appId})`);
    } else {
      aliveSpin.stop(`Existing app is unreachable: ${alive.reason}`);
    }

    const choice = await p.select({
      message: `${label} GitHub App:`,
      options: [
        ...(alive.ok
          ? [{ value: 'keep' as const, label: 'Use existing app — no changes', hint: 'recommended' }]
          : []),
        { value: 'new' as const,      label: 'Create a new app with a different name', hint: 'old app keeps existing' },
        { value: 'recreate' as const, label: 'Re-create with the same name', hint: "I've deleted the old app on github.com already" },
      ],
      initialValue: alive.ok ? 'keep' : 'new',
    });
    if (p.isCancel(choice)) return null;

    if (choice === 'keep') {
      return {
        appId: existing.appId,
        installationId: existing.installationId,
        pemPath: existing.pemPath,
        name: alive.ok ? alive.name : defaultName,
      };
    }

    if (choice === 'new') {
      const name = await askAppName(p, suggestVariantName(defaultName), `Pick a unique name for the new ${label.toLowerCase()} app:`);
      if (name === null) return null;
      return runManifestFlow(p, role, name, label);
    }

    // choice === 'recreate'
    p.note(
      help([
        `Re-creating the ${label} app with name "${defaultName}".`,
        '',
        'GitHub App names are unique per account. This step only works',
        'if you\'ve already deleted the old app at:',
        '  https://github.com/settings/apps',
        '',
        'If you haven\'t deleted it yet, GitHub will reject the manifest',
        'with a name conflict. In that case pick "Create a new app with',
        'a different name" instead.',
      ].join('\n')),
      'Heads up'
    );
    const ok = await p.confirm({
      message: `Have you deleted the old "${defaultName}" app on github.com?`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) return null;
    return runManifestFlow(p, role, defaultName, label);
  }

  // ---- Fresh path: reuse-from-sibling (if available), or new manifest ------
  const siblings = opts.reusableFromSiblings || [];
  if (siblings.length > 0 && opts.newRepo && opts.newInstanceHome) {
    const choice = await p.select({
      message: `${label} GitHub App:`,
      options: [
        { value: 'reuse',       label: `Reuse ${label.toLowerCase()} app from another instance`, hint: 'recommended — install it on this repo too' },
        { value: 'new-default', label: `Create new app with default name ("${defaultName}")` },
        { value: 'new-custom',  label: 'Create new app with custom name' },
      ],
      initialValue: 'reuse',
    });
    if (p.isCancel(choice)) return null;

    if (choice === 'reuse') {
      return reuseGitHubApp(p, role, label, siblings, opts.newRepo, opts.newInstanceHome);
    }
    if (choice === 'new-custom') {
      const name = await askAppName(p, suggestVariantName(defaultName), `Pick a unique name for the new ${label.toLowerCase()} app:`);
      if (name === null) return null;
      return runManifestFlow(p, role, name, label);
    }
    // 'new-default'
    return runManifestFlow(p, role, defaultName, label);
  }

  const name = await askAppName(
    p,
    defaultName,
    `Name for the ${label.toLowerCase()} GitHub App (Enter to accept default):`,
  );
  if (name === null) return null;
  return runManifestFlow(p, role, name, label);
}

/**
 * Ask the user to confirm they're signed into github.com before we open a
 * browser flow that requires authentication. If they say no, open the login
 * page and wait for them to come back. The result is cached at module scope
 * so we don't re-ask when the wizard creates a second app in the same run.
 *
 * GitHub's manifest POST returns a 404 when the user isn't authenticated,
 * which silently strips the manifest payload — without this pre-flight, the
 * wizard sits at "Waiting for GitHub to redirect back" forever.
 */
async function ensureSignedIn(p: ClackModule): Promise<boolean> {
  if (signedInConfirmed) return true;

  const status = await p.select({
    message: 'Are you signed into GitHub on the web (github.com)?',
    options: [
      { value: 'yes', label: 'Yes — continue' },
      { value: 'no',  label: 'No — open github.com to sign in first' },
    ],
    initialValue: 'yes',
  });
  if (p.isCancel(status)) return false;

  if (status === 'no') {
    p.note(
      help([
        'Opening github.com/login in your browser.',
        'Sign in, then come back here and confirm.',
      ].join('\n')),
      'Sign in to GitHub'
    );
    openBrowser('https://github.com/login');
    const done = await p.confirm({
      message: 'Done — signed into github.com?',
      initialValue: true,
    });
    if (p.isCancel(done) || !done) return false;
  }

  signedInConfirmed = true;
  return true;
}

/**
 * Walk the user through reusing an existing GitHub App on a new repo.
 * The app already has credentials + a .pem we can copy; the only thing
 * that has to change on github.com is adding `<owner>/<repo>` to the
 * installation's repository list. We check via the API and prompt the
 * user to fix it via the settings page if missing.
 */
async function reuseGitHubApp(
  p: ClackModule,
  role: 'agent' | 'reviewer',
  label: string,
  siblings: SiblingApp[],
  newRepo: { owner: string; repo: string },
  newInstanceHome: string,
): Promise<GitHubAppResult | null> {
  // Pick which sibling to reuse from.
  let source: SiblingApp;
  if (siblings.length === 1) {
    source = siblings[0];
    p.log.info(`Reusing ${label} app from '${source.slug}' (id=${source.appId})`);
  } else {
    const choice = await p.select({
      message: `Reuse ${label.toLowerCase()} app from which instance?`,
      options: siblings.map((s) => ({ value: s.slug, label: `${s.slug}  (id=${s.appId})` })),
      initialValue: siblings[0].slug,
    });
    if (p.isCancel(choice)) return null;
    source = siblings.find((s) => s.slug === choice)!;
  }

  // JWT-check the app is alive on github.com.
  const aliveSpin = p.spinner();
  aliveSpin.start(`Verifying ${label} app on GitHub`);
  const alive = await verifyExistingApp(source.appId, source.pemPath, source.installationId);
  if (!alive.ok) {
    aliveSpin.stop(`App is unreachable: ${alive.reason}`);
    p.log.error(`Can't reuse — repair '${source.slug}' first or pick "Create new app" instead.`);
    return null;
  }
  aliveSpin.stop(`App is alive: ${alive.name}`);

  // Check whether the installation has access to the new repo.
  const target = `${newRepo.owner}/${newRepo.repo}`;
  let hasAccess = await installationHasRepo(source.appId, source.pemPath, source.installationId, newRepo.owner, newRepo.repo);

  if (!hasAccess) {
    p.note(
      help([
        `The ${label} app is currently only installed on its original repo.`,
        `We need to add "${target}" to the installation before this instance can use it.`,
        '',
        '1. We\'ll open the GitHub App\'s install page in your browser.',
        '2. Under "Repository access", click "Only select repositories",',
        `   add "${newRepo.repo}", and click "Save".`,
        '3. Come back here and confirm.',
      ].join('\n')),
      'Add new repo to installation'
    );
    if (!(await ensureSignedIn(p))) return null;
    openBrowser(`https://github.com/settings/installations/${source.installationId}`);

    const confirmed = await p.confirm({
      message: `Done — added "${target}" to the installation?`,
      initialValue: true,
    });
    if (p.isCancel(confirmed) || !confirmed) return null;

    const recheckSpin = p.spinner();
    recheckSpin.start('Verifying access');
    hasAccess = await installationHasRepo(source.appId, source.pemPath, source.installationId, newRepo.owner, newRepo.repo);
    recheckSpin.stop(hasAccess ? 'Access confirmed' : 'Still no access');
    if (!hasAccess) {
      p.log.error(`Could not see "${target}" in the installation. Verify on github.com and re-run the wizard.`);
      return null;
    }
  }

  // Copy the .pem from the sibling instance into the new instance's keys/.
  // Self-contained per-instance dirs are simpler to reason about than
  // symlinks; rotation cost ("update both instances") is rare enough.
  try {
    const destKeysDir = join(newInstanceHome, 'keys');
    mkdirSync(destKeysDir, { recursive: true });
    const destPemPath = join(destKeysDir, `${role}.pem`);
    const pemContent = readFileSync(source.pemPath);
    writeFileSync(destPemPath, pemContent, { mode: 0o600 });
    p.log.success(`Copied private key → ${destPemPath}`);

    return {
      appId: source.appId,
      installationId: source.installationId,
      pemPath: destPemPath,
      name: alive.name,
    };
  } catch (err: any) {
    p.log.error(`Could not copy private key: ${err.message}`);
    return null;
  }
}

/**
 * Use the installation's access token to list the repositories it has
 * access to. Returns true if owner/repo is present.
 */
async function installationHasRepo(
  appId: number,
  pemPath: string,
  installationId: number,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const privateKey = readFileSync(pemPath, 'utf-8');
    const auth = createAppAuth({ appId, privateKey });
    const instAuth = await auth({ type: 'installation', installationId });

    const target = `${owner}/${repo}`.toLowerCase();
    let page = 1;
    while (true) {
      const res = await fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${instAuth.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) return false;
      const json = await res.json() as { repositories: Array<{ full_name: string }>; total_count: number };
      if (json.repositories.some((r) => r.full_name.toLowerCase() === target)) return true;
      if (json.repositories.length < 100) return false;
      page += 1;
      if (page > 10) return false; // sanity cap
    }
  } catch {
    return false;
  }
}

/**
 * Scan sibling instances' .env for this role's GitHub App credentials.
 * Returns the slugs whose app is fully configured, whose .pem still exists
 * on disk, AND that pass a live JWT check against github.com. Pre-flight
 * filtering means the picker only offers genuinely reusable apps —
 * revoked, deleted, or unreachable apps don't appear as choices.
 *
 * Async because the JWT check is a network call. Runs N requests in
 * parallel where N is the number of sibling candidates; for typical
 * setups (1–3 instances) this is sub-second, and dead apps fail fast.
 */
export async function findReusableApps(
  role: 'agent' | 'reviewer',
  excludeSlug?: string,
): Promise<SiblingApp[]> {
  const idKey = role === 'agent' ? 'GITHUB_APP_ID' : 'REVIEWER_GITHUB_APP_ID';
  const installKey = role === 'agent' ? 'GITHUB_APP_INSTALLATION_ID' : 'REVIEWER_GITHUB_APP_INSTALLATION_ID';
  const pemKey = role === 'agent' ? 'GITHUB_APP_PRIVATE_KEY_PATH' : 'REVIEWER_GITHUB_APP_PRIVATE_KEY_PATH';

  const candidates: SiblingApp[] = [];
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
      const appId = parseInt(env[idKey] || '', 10);
      const installationId = parseInt(env[installKey] || '', 10);
      const pemPath = env[pemKey] || '';
      if (appId && installationId && pemPath && existsSync(pemPath)) {
        candidates.push({ slug, appId, installationId, pemPath });
      }
    } catch {
      // Skip unreadable .env
    }
  }

  // Pre-flight JWT check in parallel. Apps that fail (revoked, deleted,
  // network issue) drop out; the picker only shows live ones.
  const results = await Promise.all(
    candidates.map(async (c) => {
      const alive = await verifyExistingApp(c.appId, c.pemPath, c.installationId);
      return alive.ok ? c : null;
    }),
  );
  return results.filter((c): c is SiblingApp => c !== null);
}

/**
 * Run GitHub's app manifest flow: stand up a tiny local callback server,
 * pre-POST the manifest to GitHub via a /start auto-submit page, wait for
 * the redirect-back code, exchange it for credentials, save the .pem, then
 * poll for the installation ID once the user installs the app on a repo.
 *
 * Shared with the reconfigure flow's "create new" and "re-create" branches.
 */
async function runManifestFlow(
  p: ClackModule,
  role: 'agent' | 'reviewer',
  appName: string,
  label: string,
): Promise<GitHubAppResult | null> {
  p.note(
    help([
      `We'll create a GitHub App named "${appName}" — the ${label} identity.`,
      '',
      "GitHub's manifest flow pre-fills all the permissions and captures",
      'the App ID + private key automatically when you click "Create".',
    ].join('\n')),
    `GitHub App — ${label}`
  );

  const scope = await p.select({
    message: `Where should the "${appName}" app live?`,
    options: [
      { value: 'personal', label: 'My personal GitHub account' },
      { value: 'org', label: 'A GitHub organization' },
    ],
    initialValue: 'personal',
  });
  if (p.isCancel(scope)) return null;

  let org: string | undefined;
  if (scope === 'org') {
    const o = await p.text({
      message: 'Organization name (case-sensitive):',
      validate: (v) => (v && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v) ? undefined : 'Invalid org name'),
    });
    if (p.isCancel(o)) return null;
    org = o as string;
  }

  const port = await findFreePort(8765, 8785);
  if (!port) {
    p.log.error('Could not find a free port in 8765-8785. Close local services and retry.');
    return null;
  }

  const state = randomBytes(16).toString('hex');
  const redirectUrl = `http://localhost:${port}/callback`;
  const manifest = buildManifest(appName, redirectUrl);
  const formAction = buildFormAction(org);

  p.note(
    help([
      "Opening a local page that will auto-POST the manifest to GitHub.",
      '',
      'Steps:',
      '  1. Your browser will briefly show "Creating GitHub App..." then',
      '     jump to GitHub with permissions pre-filled',
      '  2. Review the permissions, click the green "Create GitHub App"',
      '  3. GitHub redirects back here automatically',
      '',
      'If you see a 404 page on github.com instead, it means you\'re not',
      'signed in. Sign in at github.com, then pick "Retry" at the prompt',
      'below to re-open the link.',
    ].join('\n')),
    'Create the app'
  );

  if (!(await ensureSignedIn(p))) return null;

  // Start callback server BEFORE opening browser (race-safe).
  // The server also serves a /start page that POSTs the manifest to GitHub —
  // GitHub's manifest flow requires a POST form, not a GET URL param.
  const cb = startManifestCallback(port, state, formAction, manifest, appName);
  const startUrl = `http://localhost:${port}/start`;
  const openStart = (): void => openBrowser(startUrl);
  openStart();

  let code: string | null;
  try {
    code = await waitForManifestCode(p, cb.codePromise, openStart);
  } finally {
    cb.close();
  }
  if (!code) {
    p.log.error('GitHub App creation did not complete.');
    return null;
  }

  const exchSpin = p.spinner();
  exchSpin.start('Fetching app credentials from GitHub');
  let app: ManifestConversionResult;
  try {
    app = await exchangeManifestCode(code);
  } catch (err: any) {
    exchSpin.stop('Exchange failed');
    p.log.error(err.message);
    return null;
  }
  exchSpin.stop(`App created: ${app.name} (id=${app.id})`);

  const dir = keysDir();
  mkdirSync(dir, { recursive: true });
  const pemPath = join(dir, `${role}.pem`);
  writeFileSync(pemPath, app.pem, { mode: 0o600 });
  p.log.info(`Saved private key → ${pemPath}`);

  p.note(
    help([
      'Opening the install page in your browser.',
      '',
      'Steps:',
      '  1. Choose "Only select repositories"',
      '  2. Pick your target repo (the one FlockBots should make PRs on)',
      '  3. Click "Install"',
      '',
      "I'll detect the installation automatically — no copy-paste.",
    ].join('\n')),
    'Install the app'
  );
  const installReady = await p.confirm({ message: 'Open the install page?', initialValue: true });
  if (p.isCancel(installReady) || !installReady) return null;
  const installUrl = `${app.html_url}/installations/new`;
  const openInstall = (): void => openBrowser(installUrl);
  openInstall();

  const installationId = await waitForInstallation(p, app.id, app.pem, openInstall);
  if (!installationId) {
    p.log.error('Installation not detected.');
    return null;
  }

  return { appId: app.id, installationId, pemPath, name: app.name };
}

/**
 * Prompt for an app name; default = `defaultValue`. Returns the trimmed
 * value, null on cancel.
 */
async function askAppName(p: ClackModule, defaultValue: string, message: string): Promise<string | null> {
  const value = await p.text({
    message,
    placeholder: defaultValue,
    initialValue: defaultValue,
    validate: (v) => v.trim().length > 0 ? undefined : 'Required',
  });
  if (p.isCancel(value)) return null;
  return (value as string).trim();
}

/**
 * Pick a sensible default for "new app, different name" — appends a v2/v3
 * suffix that's easy for the user to override.
 */
function suggestVariantName(defaultName: string): string {
  return `${defaultName} v2`;
}

/**
 * Verify that an existing GitHub App is reachable: the .pem file is on
 * disk, signs JWTs successfully, GET /app returns 200, and the recorded
 * installation still exists. Returns ok + name on success, or ok=false +
 * a short reason string on any failure.
 */
async function verifyExistingApp(
  appId: number,
  pemPath: string,
  installationId: number,
): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  if (!existsSync(pemPath)) {
    return { ok: false, reason: 'private key file is missing on disk' };
  }
  let privateKey: string;
  try {
    privateKey = readFileSync(pemPath, 'utf-8');
  } catch (err: any) {
    return { ok: false, reason: `cannot read .pem (${err.message})` };
  }
  try {
    const auth = createAppAuth({ appId, privateKey });
    const appAuth = await auth({ type: 'app' });

    const appRes = await fetch('https://api.github.com/app', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appAuth.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!appRes.ok) return { ok: false, reason: `GET /app returned ${appRes.status}` };
    const appJson = await appRes.json() as { name: string };

    const instRes = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appAuth.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!instRes.ok) return { ok: false, reason: `installation ${installationId} returned ${instRes.status}` };

    return { ok: true, name: appJson.name };
  } catch (err: any) {
    return { ok: false, reason: err.message || 'API call failed' };
  }
}

// ---------------------------------------------------------------------------
// Manifest + URL helpers
// ---------------------------------------------------------------------------

function buildManifest(name: string, redirectUrl: string): Record<string, unknown> {
  // GitHub App manifest spec:
  // https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
  return {
    name,
    url: 'https://github.com/flockbots/flockbots',
    redirect_url: redirectUrl,
    public: false,
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
      checks: 'write',
      statuses: 'write',
    },
    default_events: [],
  };
}

function buildFormAction(org: string | undefined): string {
  return org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Branded HTML shell used by /start and /callback responses — dark
 * background, subtle scanline overlay, FlockBots wordmark + duck logo in
 * the top-left, a centered card with the page's actual content. Pulls
 * JetBrains Mono + VT323 from Google Fonts so the console aesthetic
 * matches the dashboard.
 */
function pageShell(title: string, cardHtml: string): string {
  const duckSvg = renderDuckSvg({ pixelSize: 3 });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlockBots — ${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=VT323&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0b0d; --bg-1: #0f1013;
    --line-2: #2e323a;
    --fg: #e8e6e0; --fg-dim: #8a8a84;
    --duck: #f4d03a;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--fg);
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    font-size: 14px; line-height: 1.6;
    min-height: 100vh;
  }
  body::before {
    content: ''; position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background: repeating-linear-gradient(to bottom, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px);
  }
  body::after {
    content: ''; position: fixed; top: -220px; left: 50%; transform: translateX(-50%);
    width: 900px; height: 900px; z-index: 0; pointer-events: none;
    background: conic-gradient(from 0deg, transparent 0deg, rgba(244,208,58,0.06) 40deg, transparent 80deg);
    filter: blur(40px);
  }
  .shell { position: relative; z-index: 1; min-height: 100vh; display: flex; flex-direction: column; }
  .brand { position: absolute; top: 28px; left: 32px; display: flex; align-items: center; gap: 18px; }
  .brand svg { display: block; image-rendering: pixelated; flex-shrink: 0; }
  .brand-text { display: flex; flex-direction: column; }
  .brand-name {
    font-family: 'VT323', monospace; font-size: 30px; color: var(--duck);
    letter-spacing: 0.12em; text-shadow: 0 0 10px rgba(244,208,58,0.3); line-height: 1;
  }
  .brand-tagline {
    font-size: 9px; letter-spacing: 0.3em; color: var(--fg-dim);
    text-transform: uppercase; margin-top: 6px;
  }
  .main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 160px 32px 60px; }
  .card {
    background: var(--bg-1); border: 1px solid var(--line-2);
    padding: 40px 44px; max-width: 540px; width: 100%;
    border-radius: 4px;
    box-shadow: 0 0 40px rgba(244,208,58,0.03);
  }
  .card-tag {
    font-size: 9px; letter-spacing: 0.3em;
    color: var(--duck); text-transform: uppercase;
    margin-bottom: 18px;
  }
  .card h1 {
    font-family: 'VT323', monospace; font-size: 32px;
    margin: 0 0 18px; color: var(--fg); letter-spacing: 0.04em; line-height: 1.1;
  }
  .card p { color: var(--fg-dim); margin: 0 0 14px; }
  .cursor {
    display: inline-block; width: 10px; height: 18px;
    background: var(--duck); vertical-align: -3px; margin-left: 6px;
    box-shadow: 0 0 6px rgba(244,208,58,0.5);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .noscript-btn {
    display: inline-block; margin-top: 18px;
    background: var(--duck); color: #0a0b0d;
    padding: 10px 18px; border: 0; font-family: inherit;
    font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 4px;
  }
  @media (max-width: 640px) {
    .brand { position: static; padding: 24px 24px 0; }
    .main { padding: 40px 20px; }
    .card { padding: 28px 24px; }
  }
</style>
</head>
<body>
  <div class="shell">
    <div class="brand">
      ${duckSvg}
      <div class="brand-text">
        <div class="brand-name">FLOCKBOTS</div>
        <div class="brand-tagline">a flock of ai agents · idea → deploy</div>
      </div>
    </div>
    <div class="main">
      ${cardHtml}
    </div>
  </div>
</body>
</html>`;
}

/**
 * HTML page served at /start — auto-POSTs the manifest to GitHub so the
 * App creation form lands pre-filled. GitHub's manifest flow requires a
 * form POST; passing the manifest as a GET query param silently renders a
 * blank form.
 */
function buildStartPage(formAction: string, state: string, manifest: Record<string, unknown>, appName: string): string {
  const action = `${formAction}?state=${encodeURIComponent(state)}`;
  const manifestJson = escapeHtml(JSON.stringify(manifest));
  const card = `
    <div class="card">
      <div class="card-tag">▸ creating &nbsp;·&nbsp; ${escapeHtml(appName)}</div>
      <h1>Redirecting to GitHub<span class="cursor"></span></h1>
      <p>Posting the manifest now. You'll land on the GitHub App creation
      page with every permission pre-filled — review, click
      <strong>Create GitHub App</strong>, and the wizard will pick up the
      credentials automatically.</p>
      <form id="manifest-form" method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="manifest" value="${manifestJson}">
        <noscript>
          <p>JavaScript is disabled. Click below to continue:</p>
          <button class="noscript-btn" type="submit">Continue to GitHub →</button>
        </noscript>
      </form>
      <script>document.getElementById('manifest-form').submit();</script>
    </div>`;
  return pageShell('Creating GitHub App', card);
}

function buildSuccessPage(appName: string): string {
  const card = `
    <div class="card">
      <div class="card-tag">✓ app created</div>
      <h1>${escapeHtml(appName)}</h1>
      <p>Your GitHub App is ready. The wizard is pulling the credentials
      and installation details right now — no copy-paste needed.</p>
      <p>You can safely close this tab and head back to the terminal.</p>
    </div>`;
  return pageShell('GitHub App created', card);
}

function buildErrorPage(title: string, detail: string): string {
  const card = `
    <div class="card">
      <div class="card-tag">✗ error</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
      <p>Head back to the terminal — you can re-run <code>flockbots init</code>
      to try again.</p>
    </div>`;
  return pageShell('Error', card);
}

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

/**
 * Stand up the local HTTP server that serves /start (auto-POSTs the manifest
 * to GitHub) and /callback (receives the manifest code from GitHub's redirect).
 * Returns the codePromise plus an explicit close() so the caller can drive the
 * wait loop and cancellation.
 */
function startManifestCallback(
  port: number,
  expectedState: string,
  formAction: string,
  manifest: Record<string, unknown>,
  appName: string,
): { codePromise: Promise<string | null>; close: () => void } {
  let settled = false;
  let resolveCode!: (v: string | null) => void;
  const codePromise = new Promise<string | null>((r) => { resolveCode = r; });

  const server: Server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400); res.end('bad request');
      return;
    }
    const url = new URL(req.url, `http://localhost:${port}`);

    // /start — serves an auto-submitting HTML form that POSTs the manifest
    // to GitHub. Required because the manifest flow is POST-only.
    if (url.pathname === '/start') {
      const html = buildStartPage(formAction, expectedState, manifest, appName);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname !== '/callback') {
      res.writeHead(404); res.end('not found');
      return;
    }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (state !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildErrorPage('State mismatch', 'The state parameter returned by GitHub did not match. For security, the callback was rejected.'));
      finish(null);
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildErrorPage('Missing code parameter', 'GitHub redirected back without a code in the URL. Something went wrong mid-flow.'));
      finish(null);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildSuccessPage(appName));
    finish(code);
  });
  server.listen(port);

  function finish(code: string | null): void {
    if (settled) return;
    settled = true;
    server.close();
    resolveCode(code);
  }

  return { codePromise, close: () => finish(null) };
}

/**
 * Wait for the manifest callback to arrive, with a periodic prompt that lets
 * the user re-open the link or cancel. Each interval is 45s; if no callback
 * arrives the wizard offers wait/retry/cancel and loops until the user picks
 * one or the code lands.
 */
async function waitForManifestCode(
  p: ClackModule,
  codePromise: Promise<string | null>,
  retry: () => void,
): Promise<string | null> {
  const intervalMs = 45_000;
  let firstAttempt = true;
  // Track whether the callback already landed (possibly while the user is in
  // the prompt). Without this, picking "retry" after the code arrived would
  // re-POST the manifest and create a duplicate GitHub App on the user's
  // account — a real cleanup burden. The next loop iteration's race will
  // resolve instantly with the existing code.
  let codeReady = false;
  void codePromise.then(() => { codeReady = true; });

  while (true) {
    const spin = p.spinner();
    spin.start(firstAttempt ? 'Waiting for GitHub to redirect back' : 'Waiting...');
    const result = await Promise.race([
      codePromise,
      sleep(intervalMs).then(() => 'timeout' as const),
    ]);

    if (result !== 'timeout') {
      spin.stop(result ? 'Callback received' : 'Callback failed');
      return result;
    }
    spin.stop('No redirect yet');

    const action = await p.select({
      message: "GitHub hasn't redirected back. What would you like to do?",
      options: [
        { value: 'wait',   label: 'Keep waiting (45s more)' },
        { value: 'retry',  label: 'Re-open the link in browser', hint: 'pick this if you saw a 404 or had to log in' },
        { value: 'cancel', label: 'Cancel' },
      ],
      initialValue: 'wait',
    });
    if (p.isCancel(action) || action === 'cancel') return null;
    if (action === 'retry' && !codeReady) retry();
    firstAttempt = false;
  }
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

interface ManifestConversionResult {
  id: number;
  name: string;
  html_url: string;
  pem: string;
}

async function exchangeManifestCode(code: string): Promise<ManifestConversionResult> {
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub manifest exchange failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as ManifestConversionResult;
  return data;
}

/**
 * Single polling window: GET /app/installations every 3s for `durationMs`,
 * returning the first installation's ID as soon as it appears. Network errors
 * are swallowed (keep polling). Returns null on window timeout.
 */
async function pollInstallationOnce(appId: number, privateKey: string, durationMs: number): Promise<number | null> {
  const auth = createAppAuth({ appId, privateKey });
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    try {
      const appAuth = await auth({ type: 'app' });
      const res = await fetch('https://api.github.com/app/installations', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${appAuth.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (res.ok) {
        const installs = (await res.json()) as Array<{ id: number }>;
        if (installs && installs.length > 0) return installs[0].id;
      }
    } catch {
      // Network hiccup — keep polling
    }
    await sleep(3000);
  }
  return null;
}

/**
 * Poll for the user to install the app, with a periodic prompt that lets the
 * user re-open the install page or cancel. Each window is 45s; if nothing is
 * detected the wizard offers wait/retry/cancel and loops until the user picks
 * one or the install lands.
 */
async function waitForInstallation(
  p: ClackModule,
  appId: number,
  privateKey: string,
  retry: () => void,
): Promise<number | null> {
  const intervalMs = 45_000;
  let firstAttempt = true;

  while (true) {
    const spin = p.spinner();
    spin.start(firstAttempt ? 'Waiting for you to install the app' : 'Waiting...');
    const installId = await pollInstallationOnce(appId, privateKey, intervalMs);

    if (installId !== null) {
      spin.stop(`Installation ID: ${installId}`);
      return installId;
    }
    spin.stop('Installation not detected yet');

    const action = await p.select({
      message: "Install not detected yet. What would you like to do?",
      options: [
        { value: 'wait',   label: 'Keep waiting (45s more)' },
        { value: 'retry',  label: 'Re-open the install page', hint: "pick this if the page didn't load" },
        { value: 'cancel', label: 'Cancel' },
      ],
      initialValue: 'wait',
    });
    if (p.isCancel(action) || action === 'cancel') return null;
    if (action === 'retry') retry();
    firstAttempt = false;
  }
}

// ---------------------------------------------------------------------------
// Low-level utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find the first available port in [start, end). */
async function findFreePort(start: number, end: number): Promise<number | null> {
  for (let port = start; port < end; port++) {
    if (await isPortFree(port)) return port;
  }
  return null;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Cross-platform browser opener. */
export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd.exe'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Fall through — the user can open the URL manually if this fails.
  }
}
