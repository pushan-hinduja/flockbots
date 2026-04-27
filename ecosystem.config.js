const { readFileSync, existsSync, readdirSync } = require('fs');
const { resolve, join } = require('path');
const { homedir } = require('os');

// Root of the flock — contains shared resources (state.json, agents/,
// skills-template/, scripts/) and the instances/ directory. Each instance
// gets its own pm2 app and its own skills/ dir under instances/<slug>/.
// Resolution mirrors flockbotsRoot() in coordinator/src/paths.ts.
const ROOT =
  process.env.FLOCKBOTS_HOME ||
  process.env.PROJECT_ROOT ||
  join(homedir(), '.flockbots');

function loadEnv(envPath) {
  const env = { NODE_ENV: 'production' };
  if (!existsSync(envPath)) return env;
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      let value = line.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key) env[key] = value;
    }
  } catch {
    // Best effort — malformed .env shouldn't crash pm2 boot
  }
  return env;
}

function discoverInstances(root) {
  const instancesPath = join(root, 'instances');
  if (!existsSync(instancesPath)) return [];
  return readdirSync(instancesPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

const script = resolve(__dirname, 'coordinator/dist/coordinator/src/index.js');
const instances = discoverInstances(ROOT);

module.exports = {
  apps: instances.map((id) => {
    const home = join(ROOT, 'instances', id);
    const env = loadEnv(join(home, '.env'));
    env.FLOCKBOTS_HOME = ROOT;
    env.FLOCKBOTS_INSTANCE_ID = id;
    return {
      name: `flockbots:${id}`,
      script,
      cwd: __dirname,
      watch: false,
      restart_delay: 5000,
      max_restarts: 20,
      env,
      error_file: join(home, 'logs', 'flockbots-error.log'),
      out_file: join(home, 'logs', 'flockbots-out.log'),
    };
  }),
};
