#!/bin/bash
# Knowledge graph builder using graphify (https://graphify.net).
#
# Graphify is designed to be invoked via the /graphify slash command inside a
# Claude Code session — it's a Claude skill, not a standalone CLI. This script
# orchestrates: pip install → graphify install → claude -p "/graphify ..."
# so the semantic extraction uses the same Claude auth the coordinator already
# has. No separate API key needed.
#
# Usage:
#   scripts/build-knowledge-graph.sh              # full rebuild
#   scripts/build-knowledge-graph.sh incremental  # only changed files
#
# Exit codes:
#   0 — graph built successfully
#   1 — dependency missing or build failed
#   2 — Python version too old (user action required)
#
# Note: intentionally NOT using `set -e` so a malformed line in .env (quoted
# value with special chars, etc.) doesn't kill the script before the first
# echo. We explicitly check return codes where it matters.

echo "=== knowledge graph builder ==="

MODE="${1:-full}"
UPDATE_FLAG=""
if [ "$MODE" = "incremental" ]; then UPDATE_FLAG=" --update"; fi

# Resolve the install root from the script's own location so `.env` is found
# regardless of which directory the user invoked the script from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVED_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$RESOLVED_ROOT/.env"

# Parse .env manually — safer than `source` which can fail on quoted values
# or unusual syntax. Skip blank lines and comments. Strip surrounding quotes
# on values. Only exports vars we need.
if [ -f "$ENV_FILE" ]; then
  echo "Reading $ENV_FILE"
  while IFS= read -r line || [ -n "$line" ]; do
    # skip blank/comment
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    # trim spaces around key
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    # strip surrounding single/double quotes
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    case "$key" in
      TARGET_REPO_PATH|FLOCKBOTS_HOME|PROJECT_ROOT)
        export "$key=$val"
        ;;
    esac
  done < "$ENV_FILE"
else
  echo "Warning: .env not found at $ENV_FILE"
fi

if [ -z "$TARGET_REPO_PATH" ]; then
  echo "TARGET_REPO_PATH not set. Checked: $ENV_FILE"
  echo "Verify the file has a line like: TARGET_REPO_PATH=/path/to/product/repo"
  echo "(no spaces around =, no trailing comments on the same line)"
  exit 1
fi
# Prefer FLOCKBOTS_HOME (current), fall back to PROJECT_ROOT (legacy), then
# to the script's own parent directory.
INSTALL_ROOT="${FLOCKBOTS_HOME:-${PROJECT_ROOT:-$RESOLVED_ROOT}}"

# ── Python 3.10+ ──
PYTHON=$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)
if [ -z "$PYTHON" ]; then
  echo "No python3 on PATH. Install Python 3.10+: brew install python@3.11"; exit 2
fi
PYVER=$($PYTHON -c 'import sys; print(".".join(map(str, sys.version_info[:2])))' 2>/dev/null || echo "0.0")
if [ "$(printf '%s\n3.10\n' "$PYVER" | sort -V | head -n1)" != "3.10" ]; then
  echo "Python $PYVER found but graphify needs 3.10+."
  echo "Install: brew install python@3.11 && brew link --force python@3.11"
  exit 2
fi
echo "Using Python $PYVER ($PYTHON)"

# ── graphifyy package ──
if ! command -v graphify &> /dev/null; then
  echo "Installing graphifyy package..."
  $PYTHON -m pip install --user graphifyy
  USER_BIN="$HOME/Library/Python/$PYVER/bin"
  if [ -d "$USER_BIN" ]; then export PATH="$USER_BIN:$PATH"; fi
  if ! command -v graphify &> /dev/null; then
    echo "Install succeeded but graphify not on PATH. Add $USER_BIN to your shell profile."; exit 1
  fi
fi

# ── Register as Claude Code skill (one-time; writes ~/.claude/skills/graphify/) ──
if [ ! -f "$HOME/.claude/skills/graphify/SKILL.md" ]; then
  echo "Registering graphify as a Claude Code skill (one-time)..."
  graphify install
fi

OUT_DIR="$INSTALL_ROOT/skills/kg"
mkdir -p "$OUT_DIR"

# Lockfile prevents overlapping builds (e.g., two post-merge hooks firing close
# together). Stale locks (process no longer running) are cleared.
LOCK_FILE="$OUT_DIR/.build.lock"
if [ -f "$LOCK_FILE" ]; then
  EXISTING_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Another graph build is in progress (pid $EXISTING_PID). Skipping."
    exit 0
  fi
  echo "Removing stale lock (pid $EXISTING_PID no longer running)"
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

echo ""
echo "=== Building knowledge graph ==="
echo "  target repo: $TARGET_REPO_PATH"
echo "  output:      $OUT_DIR"
echo "  mode:        $MODE"
echo ""

# Invoke /graphify via claude CLI. Claude handles LLM auth + invokes graphify
# as a skill. Run from OUT_DIR so graphify's default graphify-out/ lands here.
cd "$OUT_DIR"

PROMPT="/graphify $TARGET_REPO_PATH$UPDATE_FLAG

Write output into the current working directory ($PWD). Produce graph.json, graph.html, and GRAPH_REPORT.md. Report the final file paths when done."

# Initial builds can take 10-30 minutes on a real codebase — give it a generous
# turn budget. Incremental builds complete in minutes.
MAX_TURNS=50
[ "$MODE" = "incremental" ] && MAX_TURNS=15

claude -p "$PROMPT" \
  --model claude-sonnet-4-6 \
  --effort medium \
  --permission-mode bypassPermissions \
  --max-turns $MAX_TURNS \
  --output-format json

# Flatten graphify-out/ if graphify created a subdirectory despite our request
if [ -d "$OUT_DIR/graphify-out" ]; then
  echo "Flattening graphify-out/ subdirectory..."
  mv -f "$OUT_DIR/graphify-out/"* "$OUT_DIR/" 2>/dev/null || true
  rmdir "$OUT_DIR/graphify-out" 2>/dev/null || true
fi

if [ ! -f "$OUT_DIR/graph.json" ]; then
  echo ""
  echo "ERROR: graph.json not produced at $OUT_DIR/graph.json"
  echo "The Claude session may not have invoked graphify successfully."
  echo ""
  echo "Debug steps:"
  echo "  1. Verify the skill is registered: ls ~/.claude/skills/graphify/"
  echo "  2. Try manually in an interactive claude session: /graphify $TARGET_REPO_PATH"
  echo "  3. Check recent claude logs for errors"
  exit 1
fi

echo ""
echo "=== Graph built ==="
[ -f "$OUT_DIR/graph.json" ]       && echo "  $OUT_DIR/graph.json"
[ -f "$OUT_DIR/graph.html" ]       && echo "  $OUT_DIR/graph.html"
[ -f "$OUT_DIR/GRAPH_REPORT.md" ]  && echo "  $OUT_DIR/GRAPH_REPORT.md"
