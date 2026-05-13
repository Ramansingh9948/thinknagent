#!/usr/bin/env bash
# ThinkNCollab Agent — installer
# Usage: curl -fsSL https://thinkncollab.com/install-agent.sh | bash -s -- --server https://thinkncollab.com --name my-server

set -euo pipefail

SERVER=""
NAME=""
GPU=false
LOGS=""
SYSTEMD=false

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --server) SERVER="$2"; shift 2 ;;
    --name)   NAME="$2";   shift 2 ;;
    --gpu)    GPU=true;    shift   ;;
    --logs)   LOGS="$2";   shift 2 ;;
    --systemd) SYSTEMD=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ -z "$SERVER" ]] && echo "Error: --server required" && exit 1
[[ -z "$NAME"   ]] && echo "Error: --name required"   && exit 1

echo ""
echo "  ThinkNCollab Agent Installer"
echo "  ──────────────────────────────"

# Check Node.js >= 18
NODE_VER=$(node --version 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo "0")
if [[ "$NODE_VER" -lt 18 ]]; then
  echo "  Error: Node.js 18+ required (found: $(node --version 2>/dev/null || echo 'not found'))"
  exit 1
fi
echo "  Node.js : $(node --version) ✓"

# Install package
echo "  Installing thinknagent..."
npm install -g thinknagent --silent

# Init
GPU_FLAG=""
$GPU && GPU_FLAG="--gpu"
LOGS_FLAG=""
[[ -n "$LOGS" ]] && LOGS_FLAG="--logs $LOGS"

thinknagent init --server "$SERVER" --name "$NAME" $GPU_FLAG $LOGS_FLAG

# Optional systemd setup
if $SYSTEMD; then
  echo ""
  echo "  Setting up systemd service..."

  # Create system user
  id thinknagent &>/dev/null || useradd --system --no-create-home thinknagent

  # Copy service file
  AGENT_SERVICE_SRC="$(npm root -g)/thinknagent/install/thinknagent.service"
  cp "$AGENT_SERVICE_SRC" /etc/systemd/system/thinknagent.service

  systemctl daemon-reload
  systemctl enable thinknagent
  systemctl start  thinknagent

  echo "  systemd service: enabled + started ✓"
  echo "  Logs: journalctl -u thinknagent -f"
else
  echo ""
  echo "  To start now    : thinknagent start"
  echo "  To run on boot  : Re-run this script with --systemd flag"
  echo "  Or with pm2     : pm2 start \$(which thinknagent) -- start && pm2 save"
fi

echo ""
echo "  ✓ Done. Open ThinkNCollab and approve this agent in your room's DevOps Wall."
echo ""
