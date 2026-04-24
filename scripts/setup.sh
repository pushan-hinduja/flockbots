#!/bin/bash
set -e

echo "=== Multi-Agent System Setup ==="

# Check Node 20+
node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$node_version" -lt 20 ]; then
  echo "Node.js 20+ required. Current: $(node -v)"; exit 1
fi

# Check claude CLI
if ! command -v claude &> /dev/null; then
  echo "Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code"; exit 1
fi

# Check claude auth
claude -p "say ok" --max-turns 1 > /dev/null 2>&1 || {
  echo "Claude not authenticated. Run: claude login"; exit 1
}
echo "Claude CLI authenticated"

# Check .env
if [ ! -f .env ]; then
  echo "No .env file found. Copy .env.example to .env and fill in values."; exit 1
fi

source .env

# Check required env vars
required_vars=("GITHUB_APP_ID" "GITHUB_APP_PRIVATE_KEY_PATH" "GITHUB_APP_INSTALLATION_ID"
               "GITHUB_OWNER" "GITHUB_REPO" "TARGET_REPO_PATH" "PROJECT_ROOT"
               "SUPABASE_URL" "SUPABASE_SERVICE_ROLE_KEY")
for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "Missing required env var: $var"; exit 1
  fi
done
echo "Environment variables present"

# Check GitHub App private key exists
if [ ! -f "$GITHUB_APP_PRIVATE_KEY_PATH" ]; then
  echo "GitHub App private key not found at $GITHUB_APP_PRIVATE_KEY_PATH"; exit 1
fi
echo "GitHub App private key found"

# Install dependencies
echo "Installing coordinator dependencies..."
cd coordinator && npm install && cd ..

if [ -d "dashboard" ]; then
  echo "Installing dashboard dependencies..."
  cd dashboard && npm install && cd ..
fi

# Create directories
mkdir -p tasks logs data

# Add .worktrees to target repo gitignore
if ! grep -q ".worktrees" "$TARGET_REPO_PATH/.gitignore" 2>/dev/null; then
  echo ".worktrees/" >> "$TARGET_REPO_PATH/.gitignore"
  echo "Added .worktrees/ to target repo .gitignore"
fi

# Initialize database
npx ts-node coordinator/src/queue.ts --init
echo "Database initialized"

# Run Supabase migration
echo "Run the migration in supabase/migrations/001_dashboard_tables.sql against your Supabase project"

# Build
cd coordinator && npm run build && cd ..
echo "Build complete"

# Build knowledge graph (graphify). Can take 10-30 min on first run — the
# semantic extraction runs via a claude CLI session. Skip with SKIP_KG=1.
if [ "$SKIP_KG" != "1" ]; then
  echo "Building knowledge graph via graphify (this can take a while on first run)..."
  if scripts/build-knowledge-graph.sh; then
    echo "Knowledge graph ready at skills/kg/"
  else
    echo "WARNING: knowledge graph build failed. Agents will fall back to grep."
    echo "You can retry later with: scripts/build-knowledge-graph.sh"
  fi
fi

# QA agent — browser binaries (Chromium) auto-install via Playwright's postinstall
# when `cd coordinator && npm install` runs above. No separate browser install
# step needed. Pre-warm the MCP packages so the first QA task doesn't pay the
# npx download latency. Skip with SKIP_QA_DEPS=1.
if [ "$SKIP_QA_DEPS" != "1" ]; then
  echo "Pre-warming QA MCP packages (Playwright, Supabase)..."
  npx --yes @playwright/mcp@latest --help > /dev/null 2>&1 || echo "  (Playwright MCP pre-warm skipped)"
  npx --yes @supabase/mcp-server-supabase@latest --help > /dev/null 2>&1 || echo "  (Supabase MCP pre-warm skipped)"
fi

# Start pm2
pm2 start ecosystem.config.js
pm2 save
echo "pm2 started"

echo ""
echo "=== Setup complete ==="
echo "Coordinator: running via pm2"
echo "Dashboard: deploy to Vercel (cd dashboard && vercel --prod)"
echo "Scan the WhatsApp QR code: pm2 logs coordinator --lines 100"
