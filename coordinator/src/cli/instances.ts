import { execSync } from 'child_process';
import { listInstanceSlugs } from '../paths';
import { readInstanceEnv } from './env';
import { fg, COLORS, dim } from './brand';

interface Pm2App {
  name: string;
  pm2_env?: { status?: string };
}

/**
 * Probe pm2 once and return a slug → status map (e.g. 'online', 'stopped',
 * 'errored'). Returns null when the daemon is down so callers can show a
 * sentinel instead of misleading "stopped" text. We use stdio capture +
 * jlist instead of pm2 list because the JSON form is parseable; the
 * tabular pm2 list output is decorative and changes between versions.
 */
function readPm2Status(): Map<string, string> | null {
  try {
    const json = execSync('pm2 jlist', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const apps = JSON.parse(json) as Pm2App[];
    const map = new Map<string, string>();
    for (const app of apps) {
      if (app.name?.startsWith('flockbots:')) {
        const slug = app.name.slice('flockbots:'.length);
        map.set(slug, app.pm2_env?.status || 'unknown');
      }
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * `flockbots instances` — print one row per registered instance with
 * target repo, chat provider, and pm2 status. Read-only.
 */
export async function runInstancesCommand(_args: string[]): Promise<void> {
  const p = await import('@clack/prompts');
  const slugs = listInstanceSlugs();

  p.intro('FlockBots instances');

  if (slugs.length === 0) {
    p.note('no instances configured — run `flockbots init`', 'Empty');
    p.outro('Done.');
    return;
  }

  const pm2Map = readPm2Status();

  // Compute column widths for clean alignment
  const rows = slugs.map((slug) => {
    const env = readInstanceEnv(slug);
    const target = env.GITHUB_OWNER && env.GITHUB_REPO ? `${env.GITHUB_OWNER}/${env.GITHUB_REPO}` : '—';
    const provider = env.CHAT_PROVIDER || '—';
    const status = pm2Map === null
      ? 'pm2 down'
      : pm2Map.get(slug) || 'not started';
    return { slug, target, provider, status };
  });

  const slugW = Math.max(4, ...rows.map(r => r.slug.length));
  const targetW = Math.max(6, ...rows.map(r => r.target.length));
  const providerW = Math.max(8, ...rows.map(r => r.provider.length));

  const dot = (s: string) => {
    if (s === 'online') return fg(COLORS.duck, '●');
    if (s === 'pm2 down' || s === 'not started') return fg(COLORS.dim, '○');
    return fg(COLORS.bill, '●');
  };

  const body = rows
    .map(r =>
      `  ${dot(r.status)}  ${r.slug.padEnd(slugW)}  ` +
      `${r.target.padEnd(targetW)}  ${r.provider.padEnd(providerW)}  ${dim(r.status)}`
    )
    .join('\n');

  const header =
    `     ${'slug'.padEnd(slugW)}  ${'target'.padEnd(targetW)}  ${'provider'.padEnd(providerW)}  status`;

  p.note(`${dim(header)}\n${body}`, `${slugs.length} instance${slugs.length === 1 ? '' : 's'}`);
  p.outro('Done.');
}
