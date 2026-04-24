import { execSync } from 'child_process';
import { logEvent } from './queue';

interface TestResult {
  passed: boolean;
  output: string;
  exitCode: number;
}

/**
 * Runs the project test suite in the worktree.
 * Test command is read from env var or defaults.
 */
export async function runTestGate(taskId: string, worktreePath: string): Promise<TestResult> {
  const installCommand = process.env.INSTALL_COMMAND || 'npm install --ignore-scripts';
  const testCommand = process.env.TEST_COMMAND || 'npm test';
  const lintCommand = process.env.LINT_COMMAND || 'npm run lint';
  const typeCheckCommand = process.env.TYPECHECK_COMMAND || 'npx tsc --noEmit';

  logEvent(taskId, 'test_gate', 'test_start', `Running test gate in ${worktreePath}`);

  // Ensure dependencies are installed in the worktree
  try {
    execSync(installCommand, {
      cwd: worktreePath,
      timeout: 3 * 60 * 1000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    logEvent(taskId, 'test_gate', 'install_failed', `Dependency install failed: ${(err.stderr || '').slice(0, 500)}`);
    return {
      passed: false,
      output: `[install] FAIL\n${(err.stdout || '')}\n${(err.stderr || '')}`,
      exitCode: err.status || 1,
    };
  }

  const results: { step: string; passed: boolean; output: string }[] = [];

  for (const [step, cmd] of [
    ['typecheck', typeCheckCommand],
    ['lint', lintCommand],
    ['test', testCommand],
  ] as const) {
    try {
      const output = execSync(cmd, {
        cwd: worktreePath,
        timeout: 5 * 60 * 1000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      results.push({ step, passed: true, output });
    } catch (err: any) {
      results.push({ step, passed: false, output: (err.stdout || '') + '\n' + (err.stderr || '') });
      logEvent(taskId, 'test_gate', 'test_failed', `${step} failed`);

      return {
        passed: false,
        output: results.map(r => `[${r.step}] ${r.passed ? 'PASS' : 'FAIL'}\n${r.output}`).join('\n\n'),
        exitCode: err.status || 1,
      };
    }
  }

  logEvent(taskId, 'test_gate', 'test_passed', 'All checks passed');
  return {
    passed: true,
    output: results.map(r => `[${r.step}] PASS`).join('\n'),
    exitCode: 0,
  };
}
