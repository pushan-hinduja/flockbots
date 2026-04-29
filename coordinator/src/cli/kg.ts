import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { flockbotsRoot, flockbotsInstanceHome, skillsDir } from '../paths';
import { extractInstanceFlag, loadEnvFile } from './env';
import { updateState } from './state-file';

export interface KgBuildOptions {
  incremental?: boolean;
}

/**
 * Invoke scripts/build-knowledge-graph.sh as a child process and surface its
 * progress through a clack spinner. Returns true on exit code 0, false
 * otherwise. The spinner's rotating message shows the last stdout line so a
 * 10-30 minute build isn't a silent wait.
 *
 * Per-instance: the build script lives at the shared root, but runs with
 * cwd = the current instance's home so it produces a graph specific to
 * that instance's TARGET_REPO_PATH. Graph and state are written into the
 * instance dir.
 */
export async function runKgBuild(opts: KgBuildOptions = {}): Promise<boolean> {
  const p = await import('@clack/prompts');
  const root = flockbotsRoot();
  const instanceHome = flockbotsInstanceHome();
  const script = join(root, 'scripts', 'build-knowledge-graph.sh');

  if (!existsSync(script)) {
    p.log.error(`Build script not found at ${script}`);
    return false;
  }

  const args = opts.incremental ? ['incremental'] : [];
  const spin = p.spinner();
  const mode = opts.incremental ? 'incremental' : 'full';
  spin.start(`Building knowledge graph (${mode}) — first build can take 10-30 min`);

  return new Promise<boolean>((resolve) => {
    const proc = spawn('bash', [script, ...args], {
      cwd: instanceHome,
      env: process.env,
      // Close stdin so the child `claude -p ...` doesn't sit in its
      // 3-second stdin-wait ("Warning: no stdin data received in 3s…").
      // We never pipe anything to the graph builder.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const updateFromChunk = (data: Buffer) => {
      const lines = data.toString('utf-8').split('\n').map(s => s.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        const truncated = last.length > 78 ? last.slice(0, 78) + '…' : last;
        spin.message(`kg: ${truncated}`);
      }
    };

    proc.stdout?.on('data', updateFromChunk);
    proc.stderr?.on('data', updateFromChunk);

    proc.on('exit', (code) => {
      if (code === 0) {
        spin.stop('Knowledge graph built');
        try { updateState(instanceHome, { knowledgeGraphBuiltAt: new Date().toISOString() }); } catch { /* best effort */ }
        resolve(true);
      } else {
        spin.stop(`Build exited with code ${code}`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      spin.stop(`Build failed to start: ${err.message}`);
      resolve(false);
    });
  });
}

/** `flockbots kg build [--incremental] [-i <slug>]` entry point. */
export async function runKgCommand(args: string[]): Promise<void> {
  const { instanceId, rest } = extractInstanceFlag(args);
  const sub = rest[0];
  if (sub !== 'build') {
    console.error('Usage: flockbots kg build [--incremental] [-i <slug>]');
    process.exit(1);
  }
  loadEnvFile(instanceId);
  const p = await import('@clack/prompts');
  p.intro('Knowledge graph');
  const incremental = rest.includes('--incremental');
  const ok = await runKgBuild({ incremental });
  if (!ok) {
    p.outro('Graph build failed — see output above.');
    process.exit(1);
  }
  p.outro('Done.');
}

/** Small struct returned by kgState() for use in doctor / status screens. */
export interface KgState {
  graphifyInstalled: boolean;
  graphExists: boolean;
  graphAgeDays: number | null;
}

export function kgState(): KgState {
  const graphPath = join(skillsDir(), 'kg', 'graph.json');
  const graphExists = existsSync(graphPath);
  let graphAgeDays: number | null = null;
  if (graphExists) {
    try {
      const ms = Date.now() - statSync(graphPath).mtimeMs;
      graphAgeDays = Math.floor(ms / (24 * 60 * 60 * 1000));
    } catch {
      // Keep null
    }
  }

  return { graphifyInstalled: !!findGraphifyBinary(), graphExists, graphAgeDays };
}

/**
 * Locate the graphify executable. `command -v graphify` is the fast path; if
 * it misses (PATH doesn't include the user-pip install dir), fall back to
 * known install locations across macOS, Linux, and Homebrew.
 *
 * Why this matters: `pip install --user graphifyy` lands the binary in
 *   macOS: ~/Library/Python/3.x/bin/graphify
 *   Linux: ~/.local/bin/graphify
 * Neither directory is on the default PATH on most shells, so a wizard run
 * that just installed graphify will see graphify_doctor flag it as missing
 * unless the user has manually added the dir to PATH. Probing these paths
 * directly fixes the false-negative.
 */
function findGraphifyBinary(): string | null {
  try {
    const out = require('child_process').execSync('command -v graphify', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = (out as string).trim();
    if (found) return found;
  } catch { /* fall through to candidate scan */ }

  const home = process.env.HOME || '';
  const candidates = [
    `${home}/Library/Python/3.14/bin/graphify`,
    `${home}/Library/Python/3.13/bin/graphify`,
    `${home}/Library/Python/3.12/bin/graphify`,
    `${home}/Library/Python/3.11/bin/graphify`,
    `${home}/Library/Python/3.10/bin/graphify`,
    `${home}/.local/bin/graphify`,             // Linux pip --user default
    '/opt/homebrew/bin/graphify',              // macOS Homebrew (Apple Silicon)
    '/usr/local/bin/graphify',                 // macOS Homebrew (Intel) / generic Linux
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
