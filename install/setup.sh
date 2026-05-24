#!/usr/bin/env bash
# ThinkNCollab Agent — installer
# Usage: curl -fsSL https://thinkncollab.com/install-agent.sh | bash -s -- --server https://thinkncollab.com --name my-server --room <roomId>
set -euo pipefail

SERVER=""
NAME=""
ROOM=""
GPU=false
LOGS=""
SYSTEMD=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --server)  SERVER="$2"; shift 2 ;;
    --name)    NAME="$2";   shift 2 ;;
    --room)    ROOM="$2";   shift 2 ;;
    --gpu)     GPU=true;    shift   ;;
    --logs)    LOGS="$2";   shift 2 ;;
    --systemd) SYSTEMD=true; shift  ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ -z "$SERVER" ]] && echo "Error: --server required" && exit 1
[[ -z "$NAME"   ]] && echo "Error: --name required"   && exit 1
[[ -z "$ROOM"   ]] && echo "Error: --room required"   && exit 1

echo ""
echo "  ThinkNCollab Agent Installer"
echo "  ──────────────────────────────"

NODE_VER=$(node --version 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo "0")
if [[ "$NODE_VER" -lt 18 ]]; then
  echo "  Error: Node.js 18+ required (found: $(node --version 2>/dev/null || echo 'not found'))"
  exit 1
fi
echo "  Node.js : $(node --version) ✓"

echo "  Installing thinknagent..."
npm install -g thinknagent --silent

GPU_FLAG=""
$GPU && GPU_FLAG="--gpu"

LOGS_FLAG=""
[[ -n "$LOGS" ]] && LOGS_FLAG="--logs $LOGS"

thinknagent init --server "$SERVER" --name "$NAME" --room "$ROOM" $GPU_FLAG $LOGS_FLAG

if $SYSTEMD; then
  echo ""
  echo "  Setting up systemd service..."
  id thinknagent &>/dev/null || useradd --system --no-create-home thinknagent
  AGENT_BIN="$(which thinknagent)"
  cat > /etc/systemd/system/thinknagent.service << SVCEOF
[Unit]
Description=ThinkNCollab Agent
After=network-online.target
Wants=network-online.target

[Service]
User=thinknagent
Group=thinknagent
ExecStart=${AGENT_BIN} start
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=thinknagent

[Install]
WantedBy=multi-user.target
SVCEOF
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