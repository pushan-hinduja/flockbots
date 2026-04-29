import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';

export interface PrereqCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** True if this prereq is required to proceed; false if merely recommended. */
  required: boolean;
  /** One-line fix hint shown when !ok. */
  fix?: string;
}

function check(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function pm2Installed(): boolean {
  return !!check('pm2 --version');
}

/**
 * Interactive installer for pm2. Called at the end of `flockbots init` so
 * the "Next steps" command (`pm2 start ecosystem.config.js`) actually runs.
 * Returns true if pm2 is available afterwards.
 *
 * Failure handling: surfaces the actual npm error (often EACCES on system
 * Node) and tells the user to retry with sudo. We don't run sudo ourselves
 * — that would surprise users who manage globals via nvm / their own prefix.
 */
export async function offerPm2Install(
  p: typeof import('@clack/prompts'),
): Promise<boolean> {
  if (pm2Installed()) return true;

  const installNow = await p.confirm({
    message: 'pm2 is required to run FlockBots but is not installed. Install it globally now?',
    initialValue: true,
  });
  if (p.isCancel(installNow) || !installNow) {
    p.log.info('Install later with: npm install -g pm2');
    return false;
  }

  const spin = p.spinner();
  spin.start('Installing pm2 globally (npm install -g pm2)');
  const result = spawnSync('npm', ['install', '-g', 'pm2'], { encoding: 'utf-8' });
  if (result.status === 0 && pm2Installed()) {
    spin.stop('pm2 installed');
    return true;
  }
  spin.stop('Install failed');

  const errText = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (/EACCES|permission denied/i.test(errText)) {
    p.log.error('Permission denied — your npm prefix needs sudo. Retry:');
    p.log.message('  sudo npm install -g pm2');
  } else {
    const lines = errText.split('\n').filter(Boolean).slice(0, 5).join('\n');
    p.log.error(lines || 'npm exited non-zero');
    p.log.message('Retry: npm install -g pm2');
  }
  return false;
}

function parseMajor(version: string): number {
  const match = version.match(/v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

export function runPrereqChecks(): PrereqCheck[] {
  const checks: PrereqCheck[] = [];

  const nodeVer = check('node --version');
  const nodeMajor = nodeVer ? parseMajor(nodeVer) : 0;
  checks.push({
    name: 'Node.js',
    ok: nodeMajor >= 20,
    detail: nodeVer || 'not found',
    required: true,
    fix: 'Install Node 20+ from nodejs.org or via nvm.',
  });

  const gitVer = check('git --version');
  checks.push({
    name: 'git',
    ok: !!gitVer,
    detail: gitVer || 'not found',
    required: true,
    fix: 'Install git: https://git-scm.com/downloads',
  });

  // Python 3.11+ required: Playwright (QA agent) + graphify (knowledge
  // graph) both need it, and better-sqlite3 also builds with it. Parse the
  // version string ("Python 3.11.5") and gate on major.minor >= 3.11.
  const pyVer = check('python3 --version') || check('python --version');
  const pyOk = (() => {
    if (!pyVer) return false;
    const m = pyVer.match(/Python\s+(\d+)\.(\d+)/);
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 3 || (major === 3 && minor >= 11);
  })();
  checks.push({
    name: 'Python 3.11+',
    ok: pyOk,
    detail: pyVer || 'not found',
    required: true,
    fix: 'Python 3.11+ required (Playwright + graphify + better-sqlite3). macOS: brew install python@3.12. Linux: apt install python3.12.',
  });

  const ccVer = check('cc --version') || check('gcc --version') || check('clang --version');
  checks.push({
    name: 'C/C++ compiler',
    ok: !!ccVer,
    detail: (ccVer || 'not found').split('\n')[0],
    required: true,
    fix: 'macOS: run `xcode-select --install`. Linux: apt install build-essential.',
  });

  const claudeVer = check('claude --version');
  checks.push({
    name: 'claude CLI',
    ok: !!claudeVer,
    detail: claudeVer || 'not found',
    required: true,
    fix: 'Install from https://claude.com/code or run: curl -fsSL https://claude.ai/install.sh | bash',
  });

  const pm2Ver = check('pm2 --version');
  checks.push({
    name: 'pm2',
    ok: !!pm2Ver,
    detail: pm2Ver || 'not found',
    required: true,
    fix: 'Install: npm install -g pm2  (sudo may be needed depending on your npm prefix)',
  });

  // Playwright Chromium — required for wireframe rendering on every install
  // (not just QA-enabled ones). The browser binary lands in Playwright's
  // OS-specific cache dir during `npm install` postinstall + the setup.sh
  // pre-warm. If `chromium-*` is missing, surface it so the user knows to
  // run `npx playwright install chromium`.
  const chromium = checkPlaywrightChromium();
  checks.push({
    name: 'Playwright Chromium',
    ok: chromium.ok,
    detail: chromium.detail,
    required: true,
    fix: 'Run: cd coordinator && npx playwright install chromium',
  });

  return checks;
}

/**
 * Authoritative Playwright Chromium check. We ask Playwright itself where
 * its expected binary lives (factors in the installed-package version) and
 * verify the file exists. Pattern-matching the cache directory is unreliable
 * because Playwright pins to a specific build number per package version.
 */
function checkPlaywrightChromium(): { ok: boolean; detail: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright');
    const p: string = chromium.executablePath();
    if (existsSync(p)) {
      // Extract the versioned cache dir name (e.g. "chromium-1217") for a
      // recognizable detail line — full executable path is too long.
      const versionTag = p.match(/chromium[-_][^/]+/)?.[0] || 'installed';
      return { ok: true, detail: versionTag };
    }
    return { ok: false, detail: `binary missing (run: npx playwright install chromium)` };
  } catch (err: any) {
    return { ok: false, detail: err?.message || 'playwright import failed' };
  }
}
