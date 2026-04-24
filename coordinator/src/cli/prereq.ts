import { execSync } from 'child_process';

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

  return checks;
}
