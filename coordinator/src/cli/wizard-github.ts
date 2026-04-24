import { createServer, Server } from 'http';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { createAppAuth } from '@octokit/auth-app';
import { keysDir } from '../paths';
import { renderDuckSvg, help } from './brand';

export interface GitHubAppResult {
  appId: number;
  installationId: number;
  pemPath: string;
  name: string;
}

export type ClackModule = typeof import('@clack/prompts');

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Walk the user through creating a GitHub App via GitHub's manifest flow.
 * Captures the app_id and private key automatically, then polls for the
 * installation_id once the user installs the app on a repo — no copy-paste
 * of IDs required.
 *
 * Returns null on cancel or timeout.
 */
export async function createGitHubApp(
  p: ClackModule,
  role: 'agent' | 'reviewer',
  suggestedName?: string
): Promise<GitHubAppResult | null> {
  const label = role === 'agent' ? 'PR creator' : 'Reviewer';
  const appName = suggestedName || (role === 'agent' ? 'FlockBots Agent' : 'FlockBots Reviewer');

  p.note(
    help([
      `We'll create a GitHub App named "${appName}" — the ${label} identity.`,
      '',
      "GitHub's manifest flow pre-fills all the permissions and captures",
      'the App ID + private key automatically when you click "Create".',
    ].join('\n')),
    `GitHub App — ${label}`
  );

  // Ask whether personal or org account
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

  // Find a free port for the callback server
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
    ].join('\n')),
    'Create the app'
  );

  // Start callback server BEFORE opening browser (race-safe).
  // The server also serves a /start page that POSTs the manifest to GitHub —
  // GitHub's manifest flow requires a POST form, not a GET URL param.
  const codePromise = awaitManifestCallback(port, state, formAction, manifest, appName);
  openBrowser(`http://localhost:${port}/start`);

  const createSpin = p.spinner();
  createSpin.start('Waiting for GitHub to redirect back (up to 5 min)');
  const code = await codePromise;
  if (!code) {
    createSpin.stop('No callback received');
    p.log.error('GitHub App creation did not complete.');
    return null;
  }
  createSpin.stop('Callback received');

  // Exchange the temporary code for the app's credentials
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

  // Persist the private key
  const dir = keysDir();
  mkdirSync(dir, { recursive: true });
  const pemPath = join(dir, `${role}.pem`);
  writeFileSync(pemPath, app.pem, { mode: 0o600 });
  p.log.info(`Saved private key → ${pemPath}`);

  // Ask user to install the app
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
  openBrowser(`${app.html_url}/installations/new`);

  // Poll for installation ID using the app's JWT
  const pollSpin = p.spinner();
  pollSpin.start('Waiting for you to install the app');
  const installationId = await pollForInstallation(app.id, app.pem, 5 * 60 * 1000);
  if (!installationId) {
    pollSpin.stop('Installation not detected within 5 minutes');
    return null;
  }
  pollSpin.stop(`Installation ID: ${installationId}`);

  return { appId: app.id, installationId, pemPath, name: app.name };
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

function awaitManifestCallback(
  port: number,
  expectedState: string,
  formAction: string,
  manifest: Record<string, unknown>,
  appName: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
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

    const timeout = setTimeout(() => finish(null), 5 * 60 * 1000);

    function finish(code: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      resolve(code);
    }
  });
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
 * Poll GET /app/installations using the app's JWT until the user installs
 * the app on a repo. Returns the first installation's ID, or null on timeout.
 */
async function pollForInstallation(appId: number, privateKey: string, timeoutMs: number): Promise<number | null> {
  const auth = createAppAuth({ appId, privateKey });
  const deadline = Date.now() + timeoutMs;
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
