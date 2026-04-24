#!/usr/bin/env bash
#
# FlockBots installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/flockbots/main/install.sh | bash
#
# Overridable env vars:
#   FLOCKBOTS_DIR    Where to install (default: ~/.flockbots)
#   FLOCKBOTS_BIN    Where to symlink the binary (default: /usr/local/bin)
#   FLOCKBOTS_REPO   Git URL to clone (default: the public flockbots repo)
#   FLOCKBOTS_REF    Branch / tag to check out (default: main)

set -euo pipefail

# Brand palette (24-bit ANSI; falls back to plain text if NO_COLOR is set or
# stdout isn't a TTY).
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  c_duck=$'\e[38;2;244;208;58m'
  c_bill=$'\e[38;2;240;138;42m'
  c_dim=$'\e[38;2;138;138;132m'
  c_reset=$'\e[0m'
else
  c_duck=''; c_bill=''; c_dim=''; c_reset=''
fi

log()  { printf '%s▸%s %s\n' "$c_duck" "$c_reset" "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_duck" "$c_reset" "$*"; }
die()  { printf '%s✗%s %s\n' "$c_bill" "$c_reset" "$*" >&2; exit 1; }

banner() {
  printf '\n%s' "$c_duck"
  cat <<'WORDMARK'
    ███████╗██╗      ██████╗  ██████╗██╗  ██╗██████╗  ██████╗ ████████╗███████╗
    ██╔════╝██║     ██╔═══██╗██╔════╝██║ ██╔╝██╔══██╗██╔═══██╗╚══██╔══╝██╔════╝
    █████╗  ██║     ██║   ██║██║     █████╔╝ ██████╔╝██║   ██║   ██║   ███████╗
    ██╔══╝  ██║     ██║   ██║██║     ██╔═██╗ ██╔══██╗██║   ██║   ██║   ╚════██║
    ██║     ███████╗╚██████╔╝╚██████╗██║  ██╗██████╔╝╚██████╔╝   ██║   ███████║
    ╚═╝     ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═════╝  ╚═════╝    ╚═╝   ╚══════╝
WORDMARK
  printf '%s\n' "$c_reset"
  printf '    %sa flock of ai agents · idea → deploy%s\n\n' "$c_dim" "$c_reset"
}

banner

INSTALL_DIR="${FLOCKBOTS_DIR:-$HOME/.flockbots}"
BIN_DIR="${FLOCKBOTS_BIN:-/usr/local/bin}"
REPO_URL="${FLOCKBOTS_REPO:-https://github.com/pushan-hinduja/flockbots.git}"
REF="${FLOCKBOTS_REF:-main}"

# ---------------------------------------------------------------------------
# 1. Prerequisite checks
# ---------------------------------------------------------------------------

log "Checking prerequisites"

have() { command -v "$1" >/dev/null 2>&1; }

have git || die "git is required. Install it first: https://git-scm.com/downloads"
have node || die "Node.js 20+ is required. Install from https://nodejs.org or via nvm."

node_major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$node_major" -lt 20 ]; then
  die "Node $node_major found — Node 20+ required."
fi

have npm || die "npm is required (ships with Node)."
have python3 || log "python3 not found — better-sqlite3 may need it to compile."
have claude || log "Claude CLI not found — install from https://claude.com/code before running flockbots init."

ok "Prerequisites OK (Node $(node -v), git $(git --version | awk '{print $3}'))"

# ---------------------------------------------------------------------------
# 2. Clone or update
# ---------------------------------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
  git -C "$INSTALL_DIR" checkout "$REF"
  git -C "$INSTALL_DIR" reset --hard "origin/$REF"
else
  log "Cloning FlockBots into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
fi
ok "Source at $INSTALL_DIR"

# ---------------------------------------------------------------------------
# 3. Install dependencies + build
# ---------------------------------------------------------------------------

log "Installing coordinator dependencies"
(cd "$INSTALL_DIR/coordinator" && npm ci --silent)
log "Building coordinator"
(cd "$INSTALL_DIR/coordinator" && npm run build --silent)

if [ -f "$INSTALL_DIR/dashboard/package.json" ]; then
  log "Installing dashboard dependencies"
  (cd "$INSTALL_DIR/dashboard" && npm ci --silent)
fi

ok "Build complete"

# ---------------------------------------------------------------------------
# 4. Symlink the binary
# ---------------------------------------------------------------------------

chmod +x "$INSTALL_DIR/bin/flockbots"

if [ -w "$BIN_DIR" ]; then
  ln -sf "$INSTALL_DIR/bin/flockbots" "$BIN_DIR/flockbots"
  ok "Symlinked $BIN_DIR/flockbots → $INSTALL_DIR/bin/flockbots"
else
  log "$BIN_DIR is not writable — attempting with sudo"
  if sudo ln -sf "$INSTALL_DIR/bin/flockbots" "$BIN_DIR/flockbots"; then
    ok "Symlinked $BIN_DIR/flockbots (via sudo)"
  else
    echo
    echo "Could not create symlink in $BIN_DIR. Add this to your shell profile instead:"
    echo "    export PATH=\"$INSTALL_DIR/bin:\$PATH\""
    echo
  fi
fi

# ---------------------------------------------------------------------------
# 5. Done
# ---------------------------------------------------------------------------

cat <<EOF

${c_duck}FlockBots installed.${c_reset}

Next:
    flockbots init        # interactive setup wizard (~10-15 min)

Upgrade anytime:
    flockbots upgrade

EOF
