const { readFileSync, existsSync } = require('fs');
const { resolve, join } = require('path');

// FlockBots home: where .env + state (logs, data, tasks, keys) live.
// Defaults to __dirname (the repo/package root), allowing existing dev setups
// to keep working without setting anything. Native install + Docker set
// FLOCKBOTS_HOME explicitly.
const HOME = process.env.FLOCKBOTS_HOME || process.env.PROJECT_ROOT || __dirname;

// Load .env into env vars for pm2. Trims whitespace, strips surrounding
// quotes, handles CRLF — subtle .env formatting shouldn't silently set the
// wrong value (e.g. QA_ENABLED="true" would have stored '"true"' literally).
function loadEnv() {
  const candidates = [join(HOME, '.env'), resolve(__dirname, '.env')];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      const env = { NODE_ENV: 'production' };
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
      return env;
    } catch {
      // Try next candidate
    }
  }
  return { NODE_ENV: 'production' };
}

const env = loadEnv();
// Propagate FLOCKBOTS_HOME into the child env if it wasn't set via .env
if (!env.FLOCKBOTS_HOME) env.FLOCKBOTS_HOME = HOME;

module.exports = {
  apps: [
    {
      name: 'flockbots',
      script: resolve(__dirname, 'coordinator/dist/coordinator/src/index.js'),
      cwd: __dirname,
      watch: false,
      restart_delay: 5000,
      max_restarts: 20,
      env,
      error_file: join(HOME, 'logs', 'flockbots-error.log'),
      out_file: join(HOME, 'logs', 'flockbots-out.log'),
    },
  ],
};
