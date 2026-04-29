import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { help } from './brand';

type ClackModule = typeof import('@clack/prompts');

interface VercelTeam {
  id: string;
  slug: string;
  name: string;
  plan?: string;
}

interface VercelProject {
  id: string;
  name: string;
}

/**
 * Read the cached Vercel auth token. Handles both the legacy single-token
 * format and the v32+ multi-token format. VERCEL_TOKEN env var takes
 * precedence for headless / CI use.
 */
function readVercelToken(): string | null {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  const home = homedir();
  const candidates = [
    join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
    join(home, '.local', 'share', 'com.vercel.cli', 'auth.json'),
    join(home, 'AppData', 'Roaming', 'com.vercel.cli', 'auth.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (Array.isArray(data.tokens) && data.tokens.length > 0) {
        const now = Date.now();
        const valid = data.tokens.find((t: any) => t.value && (!t.expiresAt || t.expiresAt > now));
        if (valid?.value) return valid.value;
      }
      if (typeof data.token === 'string') return data.token;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** GET <Vercel API path> with the cached auth token. Returns null on any failure. */
async function vercelApi<T>(path: string): Promise<T | null> {
  const token = readVercelToken();
  if (!token) return null;
  try {
    const res = await fetch(`https://api.vercel.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Fetch all teams the user belongs to. Returns empty list on any failure. */
async function fetchVercelTeams(): Promise<VercelTeam[]> {
  const data = await vercelApi<{ teams: VercelTeam[] }>('/v2/teams');
  return data?.teams || [];
}

/**
 * Fetch the cached token's owning user. We use this to surface the current
 * Vercel identity in the deploy flow so an operator who's signed in to the
 * wrong account can spot it and switch — without ever having to run
 * `vercel whoami` (which v52+ treats as interactive and may auto-launch a
 * device-auth browser flow). Returns null on any failure; the caller falls
 * back to "Signed in (account unknown)" rather than blocking.
 */
async function fetchVercelUser(): Promise<{ email: string; username: string } | null> {
  const data = await vercelApi<{ user: { email?: string; username?: string } }>('/v2/user');
  if (!data?.user) return null;
  const email = data.user.email || '';
  const username = data.user.username || '';
  if (!email && !username) return null;
  return { email, username };
}

/** Fetch projects scoped to a team (or personal account when slug is null). */
async function fetchVercelProjects(teamId: string | null): Promise<VercelProject[]> {
  const path = teamId ? `/v9/projects?teamId=${teamId}&limit=100` : '/v9/projects?limit=100';
  const data = await vercelApi<{ projects: VercelProject[] }>(path);
  return data?.projects || [];
}

/**
 * Clear a project's `rootDirectory` setting on Vercel. Only relevant when
 * linking to an existing project that was previously imported via the old
 * `vercel.com/new/clone?root-directory=dashboard` URL — that flow persists
 * rootDirectory=dashboard on the project, and our new CLI flow deploys
 * from inside the dashboard dir already, so the path resolves to
 * dashboard/dashboard and Vercel errors out. Best-effort: API failures
 * are non-fatal, we surface a hint and let the user fix in the UI.
 */
async function resetProjectRootDirectory(projectId: string, teamId: string | null): Promise<boolean> {
  const token = readVercelToken();
  if (!token) return false;
  const qs = teamId ? `?teamId=${teamId}` : '';
  try {
    const res = await fetch(`https://api.vercel.com/v9/projects/${projectId}${qs}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rootDirectory: null }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Read the linked project's id (and orgId/teamId) from .vercel/project.json. */
function readLinkedProjectMeta(cwd: string): { projectId: string; orgId: string } | null {
  const path = join(cwd, '.vercel', 'project.json');
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof data.projectId === 'string' && typeof data.orgId === 'string') {
      return { projectId: data.projectId, orgId: data.orgId };
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Shared Vercel CLI helpers used by `flockbots dashboard deploy` and
 * `flockbots webhook deploy`. Wraps the public `vercel` CLI shipped on npm
 * via `npx --yes vercel ...` so users don't need a separate global install.
 *
 * First invocation downloads the CLI (~30s, cached after). Browser-based
 * `vercel login` happens once and persists at
 * ~/Library/Application Support/com.vercel.cli/auth.json (macOS) or
 * ~/.local/share/com.vercel.cli/ (Linux), surviving uninstalls and shared
 * across every flock on the machine. Headless contexts can set VERCEL_TOKEN.
 */

/**
 * Pre-warm the Vercel CLI so subsequent calls don't pay the npx download
 * cost mid-flow. Uses async `spawn` (not execSync) so the Node event loop
 * keeps ticking — otherwise clack's spinner freezes and the 30-second
 * download looks like a hang. Returns false when npm itself is broken.
 */
export async function ensureVercelCli(p: ClackModule): Promise<boolean> {
  const spin = p.spinner();
  spin.start('Preparing Vercel CLI (first run downloads ~30s, cached after)');
  return new Promise<boolean>((resolve) => {
    const proc = spawn('npx', ['--yes', 'vercel', '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, 120_000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        spin.stop('Vercel CLI ready');
        resolve(true);
      } else {
        spin.stop('Could not prepare Vercel CLI');
        p.log.error(`\`npx vercel --version\` exited with code ${code}.`);
        if (stderr) p.log.message(stderr.split('\n').slice(-5).join('\n'));
        p.log.message('Verify Node + npm are healthy. To install Vercel CLI globally instead:');
        p.log.message('  npm install -g vercel');
        resolve(false);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      spin.stop('Could not prepare Vercel CLI');
      p.log.error(`spawn failed: ${err.message}`);
      resolve(false);
    });
  });
}

/**
 * Detect cached Vercel auth without spawning the CLI. We avoid `vercel
 * whoami` because Vercel CLI v52+ treats it as an interactive command
 * and auto-launches a browser device-auth flow when no token exists —
 * which would open a browser BEFORE our wizard's "open browser?" prompt
 * fires, completely defeating the UX. Reading the auth file directly is
 * file-system fast, side-effect free, and works for VERCEL_TOKEN too.
 *
 * Caveat: an expired token won't be detected here — it'll fail later in
 * `vercel link` / `vercel deploy` with a clearer auth error. That's the
 * right tradeoff vs the auto-browser-open footgun.
 */
export function vercelLoggedIn(): boolean {
  if (process.env.VERCEL_TOKEN) return true;
  const home = homedir();
  const candidates = [
    join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'), // macOS
    join(home, '.local', 'share', 'com.vercel.cli', 'auth.json'),                 // Linux
    join(home, 'AppData', 'Roaming', 'com.vercel.cli', 'auth.json'),              // Windows
  ];
  return candidates.some((p) => existsSync(p));
}

/**
 * Interactive browser-based login. Surfaces the current account identity
 * when a token is already cached, and offers a "sign out + sign in to a
 * different account" option — important when the cached token belongs to
 * the wrong personal/team account and the operator can't fix it via
 * vercel.com (logging out in the browser doesn't invalidate the local
 * CLI token).
 */
export async function ensureVercelLogin(p: ClackModule): Promise<boolean> {
  const checkSpin = p.spinner();
  checkSpin.start('Checking Vercel auth');
  const loggedIn = vercelLoggedIn();
  if (!loggedIn) {
    checkSpin.stop('Not signed in to Vercel');
    return runVercelLogin(p);
  }
  // Surface the current identity so the operator can confirm or switch.
  const user = await fetchVercelUser();
  const label = user
    ? (user.email || user.username || 'unknown account')
    : 'account unknown — token may be expired';
  checkSpin.stop(`Signed in to Vercel as ${label}`);

  // VERCEL_TOKEN bypass: the env var owns the auth, so vercel logout/login
  // can't change it. Tell the operator to clear the env var if they want
  // to switch accounts in this session.
  if (process.env.VERCEL_TOKEN) {
    p.log.info('VERCEL_TOKEN is set — that env var is in charge of auth. Unset it to switch accounts.');
    return true;
  }

  const choice = await p.select<'continue' | 'switch'>({
    message: `Use this Vercel account (${label})?`,
    options: [
      { value: 'continue', label: 'Yes — continue', hint: 'recommended' },
      { value: 'switch',   label: 'Sign out and sign in as a different account' },
    ],
    initialValue: 'continue',
  });
  if (p.isCancel(choice)) return false;
  if (choice === 'continue') return true;

  // Switch path: clear cached token, then fall through to fresh login flow.
  const logoutSpin = p.spinner();
  logoutSpin.start('Signing out of current Vercel account');
  const logoutResult = spawnSync('npx', ['--yes', 'vercel', 'logout'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (logoutResult.status !== 0) {
    logoutSpin.stop('Sign-out failed');
    p.log.error('`vercel logout` exited non-zero. Try running it manually then retry the deploy.');
    return false;
  }
  logoutSpin.stop('Signed out');

  return runVercelLogin(p);
}

/**
 * Browser-based device login. Extracted from ensureVercelLogin so the
 * "switch account" path can call it cleanly after the logout step.
 */
async function runVercelLogin(p: ClackModule): Promise<boolean> {
  p.note(
    help([
      'Sign-in flow:',
      '',
      '  1. A 6-digit confirmation code prints in this terminal',
      '  2. Your browser opens to vercel.com — sign in (Google / GitHub / email)',
      '  3. Verify the code in the browser to complete auth',
      '',
      'The auth token saves to ~/Library/Application Support/com.vercel.cli/',
      '(macOS) and is shared across every flock + survives FlockBots upgrades.',
    ].join('\n')),
    'Vercel sign-in',
  );

  const proceed = await p.confirm({
    message: 'Open browser to sign in to Vercel?',
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) {
    p.log.warn('Skipped Vercel login. Run `npx vercel login` manually, then retry.');
    return false;
  }
  // Inherit stdio so the user sees the device-code + can complete browser auth.
  const result = spawnSync('npx', ['--yes', 'vercel', 'login'], { stdio: 'inherit' });
  if (result.status !== 0) {
    p.log.error('Vercel login failed.');
    return false;
  }
  return vercelLoggedIn();
}

/**
 * Link the cwd to a Vercel project via three branded clack prompts:
 *   1. Pick scope (personal or a team)
 *   2. Link to existing project, or create new?
 *   3. Project name (text or pick from existing list)
 *
 * Then drive `vercel link` non-interactively with the picked args, so the
 * user never sees Vercel CLI's own multi-question flow. If
 * `.vercel/project.json` already exists, we treat the dir as linked and
 * return early.
 */
export async function linkVercelProject(
  p: ClackModule,
  cwd: string,
  defaultName: string,
): Promise<boolean> {
  if (existsSync(join(cwd, '.vercel', 'project.json'))) {
    p.log.info(`Project already linked at ${cwd}/.vercel/project.json — re-using.`);
    return true;
  }

  // 1. Scope picker — personal account + every team the token can see.
  const teamSpin = p.spinner();
  teamSpin.start('Fetching Vercel scopes');
  const teams = await fetchVercelTeams();
  teamSpin.stop(`Found ${teams.length} team${teams.length === 1 ? '' : 's'} (plus your personal account)`);

  const scopePicked = await p.select({
    message: 'Which Vercel scope should host this project?',
    options: [
      { value: '__personal__', label: 'Personal account' },
      ...teams.map((t) => ({
        value: t.id,
        label: t.plan ? `${t.name} (${t.plan})` : t.name,
      })),
    ],
  });
  if (p.isCancel(scopePicked)) return false;
  const teamId: string | null = scopePicked === '__personal__' ? null : (scopePicked as string);
  const scopeSlug: string | null = teamId ? (teams.find((t) => t.id === teamId)?.slug || null) : null;

  // 2. Link to existing? (only offered when at least one project exists in scope)
  const projSpin = p.spinner();
  projSpin.start('Looking up existing projects in this scope');
  const projects = await fetchVercelProjects(teamId);
  projSpin.stop(`Found ${projects.length} project${projects.length === 1 ? '' : 's'} in scope`);

  let projectName: string | null = null;

  if (projects.length > 0) {
    const linkExisting = await p.confirm({
      message: 'Link to an existing project? (no creates a fresh one)',
      initialValue: false,
    });
    if (p.isCancel(linkExisting)) return false;

    if (linkExisting) {
      const picked = await p.select({
        message: 'Which existing project?',
        options: projects.map((proj) => ({ value: proj.name, label: proj.name })),
      });
      if (p.isCancel(picked)) return false;
      projectName = picked as string;
    }
  }

  // 3. New project name (skipped if user picked an existing one above)
  if (!projectName) {
    const existingNames = new Set(projects.map((proj) => proj.name));
    const seedDefault = existingNames.has(defaultName)
      ? nextFreeName(defaultName, existingNames)
      : defaultName;

    const name = await p.text({
      message: 'Project name:',
      initialValue: seedDefault,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Required';
        if (!/^[a-z0-9-]{1,52}$/.test(t)) return 'Lowercase letters, digits, hyphens only (1-52 chars)';
        if (existingNames.has(t)) return `Project '${t}' already exists in this scope — pick a different name or restart and choose 'link to existing'.`;
        return undefined;
      },
    });
    if (p.isCancel(name)) return false;
    projectName = (name as string).trim();
  }

  // 4. Drive `vercel link` non-interactively. --yes accepts every default
  // (set up, code dir, modify settings); --project pins the name; --scope
  // pins the team. Async (not spawnSync) so the spinner animates.
  const linkSpin = p.spinner();
  linkSpin.start(`Linking to ${projectName} on Vercel`);
  const args = ['link', '--yes', '--project', projectName];
  if (scopeSlug) args.push('--scope', scopeSlug);
  const result = await runVercelCommand(args, { cwd, timeoutMs: 60_000 });
  if (result.code !== 0) {
    linkSpin.stop('Project link failed');
    const tail = (result.stderr + result.stdout).split('\n').filter(Boolean).slice(-5).join('\n');
    if (tail) p.log.message(tail);
    return false;
  }
  linkSpin.stop(`Linked to ${projectName}`);

  // Reset rootDirectory on the project — clears any leftover setting from
  // a prior import-clone deploy (where `root-directory=dashboard` was
  // baked into the project). Without this, deploys would resolve cwd +
  // rootDirectory = dashboard/dashboard and fail.
  const meta = readLinkedProjectMeta(cwd);
  if (meta) {
    const resetSpin = p.spinner();
    resetSpin.start('Normalizing project settings');
    const ok = await resetProjectRootDirectory(meta.projectId, teamId);
    resetSpin.stop(ok ? 'Project settings normalized' : 'Project settings not normalized (deploy may need manual fix)');
    if (!ok) {
      p.log.warn(
        'If deploy fails with "path does not exist", clear Root Directory ' +
        'in the Vercel project settings (https://vercel.com/<team>/<project>/settings).',
      );
    }
  }
  return existsSync(join(cwd, '.vercel', 'project.json'));
}

/** Pick the next free `<base>-N` name not in `taken`. */
function nextFreeName(base: string, taken: Set<string>): string {
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Set (or update) an env var on the linked Vercel project. We `rm` first
 * so a re-run with a different value actually overwrites — `vercel env
 * add` errors with "Environment variable already exists" otherwise.
 *
 * Async (not spawnSync) so the caller's spinner can keep animating —
 * each subprocess takes ~3-5s and freezes the UI under sync.
 */
export async function setVercelEnv(
  cwd: string,
  name: string,
  value: string,
  envScope: 'production' | 'preview' | 'development' = 'production',
): Promise<boolean> {
  // Best-effort remove (no-op if not yet set). --yes accepts the
  // "Are you sure?" confirm.
  await runVercelCommand(['env', 'rm', name, envScope, '--yes'], { cwd });
  // Add: pipe value via stdin with trailing newline.
  const add = await runVercelCommand(['env', 'add', name, envScope], {
    cwd,
    input: value + '\n',
  });
  return add.code === 0;
}

/**
 * Run a `vercel <args>` subprocess via npx. Async, captures stdout+stderr,
 * returns when the process exits. Used by setVercelEnv and linkVercelProject
 * so their spinners animate properly during the call.
 */
function runVercelCommand(
  args: string[],
  opts: { cwd: string; input?: string; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['--yes', 'vercel', ...args], {
      cwd: opts.cwd,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    if (opts.input !== undefined && proc.stdin) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs)
      : null;
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

/**
 * Deploy the linked project to production. Streams the spinner with the
 * latest stdout line so a 60-90s build doesn't look like a hang. On
 * success, captures the deployed *.vercel.app URL from stdout (Vercel
 * prints it on the final "Production: <url>" line). Returns the URL or
 * null on failure.
 */
export async function deployVercelProd(p: ClackModule, cwd: string): Promise<string | null> {
  const spin = p.spinner();
  spin.start('Deploying to Vercel');
  return new Promise((resolve) => {
    const proc = spawn('npx', ['--yes', 'vercel', '--prod', '--yes'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    const updateMsg = (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        const truncated = last.length > 78 ? last.slice(0, 78) + '…' : last;
        spin.message(`vercel: ${truncated}`);
      }
    };
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); updateMsg(chunk); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); updateMsg(chunk); });

    proc.on('exit', (code) => {
      if (code !== 0) {
        spin.stop(`Deploy failed (exit ${code})`);
        const tail = (stderr + stdout).split('\n').filter(Boolean).slice(-10).join('\n');
        if (tail) p.log.message(tail);
        resolve(null);
        return;
      }
      // Vercel prints the production URL multiple times during deploy. Take
      // the last *.vercel.app match — that's the canonical production URL.
      const matches = (stdout + stderr).match(/https:\/\/[a-z0-9-]+\.vercel\.app/g);
      const url = matches ? matches[matches.length - 1] : null;
      if (url) {
        spin.stop(`Deployed: ${url}`);
        resolve(url);
      } else {
        spin.stop('Deployed (URL not detected — check Vercel dashboard)');
        resolve('');
      }
    });
    proc.on('error', (err) => {
      spin.stop(`Deploy errored: ${err.message}`);
      resolve(null);
    });
  });
}

/**
 * True when the directory has been linked to a Vercel project — used by
 * `flockbots upgrade` to decide whether to redeploy the dashboard / relay
 * after pulling new code.
 */
export function isVercelLinked(cwd: string): boolean {
  return existsSync(join(cwd, '.vercel', 'project.json'));
}
