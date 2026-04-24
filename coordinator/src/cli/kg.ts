import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { flockbotsHome } from '../paths';
import { loadEnvFile } from './env';

export interface KgBuildOptions {
  incremental?: boolean;
}

/**
 * Invoke scripts/build-knowledge-graph.sh as a child process and surface its
 * progress through a clack spinner. Returns true on exit code 0, false
 * otherwise. The spinner's rotating message shows the last stdout line so a
 * 10-30 minute build isn't a silent wait.
 */
export async function runKgBuild(opts: KgBuildOptions = {}): Promise<boolean> {
  const p = await import('@clack/prompts');
  const home = flockbotsHome();
  const script = join(home, 'scripts', 'build-knowledge-graph.sh');

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
      cwd: home,
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

/** `flockbots kg build [--incremental]` entry point. */
export async function runKgCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== 'build') {
    console.error('Usage: flockbots kg build [--incremental]');
    process.exit(1);
  }
  loadEnvFile();
  const p = await import('@clack/prompts');
  p.intro('Knowledge graph');
  const incremental = args.includes('--incremental');
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
  const graphPath = join(flockbotsHome(), 'skills', 'kg', 'graph.json');
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

  let graphifyInstalled = false;
  try {
    const out = require('child_process').execSync('command -v graphify', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    graphifyInstalled = !!out.trim();
  } catch {
    // Not installed
  }
  return { graphifyInstalled, graphExists, graphAgeDays };
}
