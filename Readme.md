# thinknagent

Official server agent for [ThinkNCollab](https://thinkncollab.com) — monitor your servers, stream logs, and access remote terminals directly from your DevOps Wall.

---

## Installation

```bash
npm install -g thinknagent
```

> **Linux/macOS only.** Requires Node.js v18+.

**If build error on Linux:**
```bash
sudo apt-get install -y build-essential python3
npm install -g thinknagent
```

**If permission denied:**
```bash
chmod +x (which thinknagent)
```

---

## Commands

| Command | Description |
|---------|-------------|
| `thinknagent init` | Register this server with ThinkNCollab |
| `thinknagent start` | Connect and start monitoring |
| `thinknagent status` | Show current config and status |
| `thinknagent revoke` | Clear all credentials and re-register |

---

## Init Options

| Option | Required | Description |
|--------|----------|-------------|
| `--server <url>` | ✅ | ThinkNCollab server URL |
| `--name <name>` | ✅ | Display name on DevOps Wall |
| `--room <roomId>` | ✅ | Room ID to connect to |
| `--gpu` | ❌ | Enable GPU metrics (requires nvidia-smi) |
| `--logs <paths>` | ❌ | Comma-separated log file paths to stream |

---

## Quick Start

### Step 1 — Initialize

**Basic (metrics only):**
```bash
thinknagent init \
  --server YOUR_APP_SERVER \
  --name my-server \
  --room <roomId>
```

**With log streaming:**
```bash
thinknagent init \
  --server YOUR_APP_SERVER \
  --name my-server \
  --room <roomId> \
  --logs <YOUR_LOG_FILE> 
```

**With PM2 app logs:**
```bash
thinknagent init \
  --server YOUR_APP_SERVER \
  --name my-server \
  --room <roomId> \
  --logs <YOUR_PM2_LOG_FILE> 
```

**With GPU metrics:**
```bash
thinknagent init \
  --server YOUR_APP_SERVER \
  --name my-server \
  --room <roomId> \
  --gpu \
  --logs <YOUR_SYS_LOG_FILE> 
```

Get your `roomId` from the room URL:
https://thinkncollab.com/rooms/YOUR_ROOM_ID_HERE

### Step 2 — Start

```bash
thinknagent start
```

Output:
Starting thinknagent — my-server
Status: PENDING — waiting for Owner approval
[agent] Connecting to https://thinkncollab.com...
[thinknagent] Registered as <agentId> — waiting for Owner approval...

### Step 3 — Approve in Browser

Go to your room's DevOps Wall:
https://thinkncollab.com/devops/<roomId>/devops

Click **Approve** on the pending agent in the sidebar.

Once approved:
[thinknagent] Approved! Role: monitor | Room: <roomId>
[agent] Active. Role: monitor | Room: <roomId>
[metrics] Poller started
[logs] Watching 2 file(s)
[shell] Bridge ready

---

## Features

### ◈ Metrics
Real-time system metrics pushed every 5 seconds — no config needed, starts automatically:
- CPU usage + load average + core count
- Memory usage (used / total GB)
- Disk usage per mount point
- Network I/O (rx/tx per second)
- Top 5 processes by CPU

### ≡ Log Streaming
Stream any log file to the DevOps Wall in real-time:
```bash
# Common log paths on Ubuntu
/var/log/syslog                                    # system
/var/log/auth.log                                  # auth/ssh
/var/log/nginx/access.log                          # nginx access
/var/log/nginx/error.log                           # nginx errors
/home/ubuntu/.pm2/logs/app-out.log        # pm2 stdout
/home/ubuntu/.pm2/logs/app-error.log      # pm2 stderr
```

Pass multiple paths comma-separated:
```bash
--logs /var/log/syslog,/var/log/nginx/error.log,/home/ubuntu/.pm2/logs/app-out.log
```

### ⚠ Alerts
Default alert rules — configurable from DevOps Wall at runtime:

| ID | Metric | Condition | Severity |
|----|--------|-----------|----------|
| cpu-high | CPU usage | > 85% for 60s | warning |
| cpu-crit | CPU usage | > 95% for 30s | critical |
| mem-high | Memory usage | > 85% for 60s | warning |
| disk-root | Disk `/` | > 90% | critical |

### ▸ Shell Access
Remote terminal via xterm.js in the browser. Requires `shell` or `admin` role.

**How to enable shell access:**

1. Owner opens DevOps Wall
2. Changes agent role to `shell` from the UI
3. Click `▸ shell` tab → `▸ open terminal`

Full bash session on your server — directly in the browser.

---

## Roles

| Role | Metrics | Logs | Alerts | Shell | Edit Rules |
|------|---------|------|--------|-------|------------|
| monitor | ✅ | ✅ | ✅ | ❌ | ❌ |
| shell | ✅ | ✅ | ✅ | ✅ | ❌ |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ |

Role is assigned by the room Owner at approval time and can be changed anytime from the DevOps Wall.

---

## Auth Flow
thinknagent init
→ generates agentId
→ saves to ~/.thinknagent/config.json
thinknagent start
→ connects to wss://thinkncollab.com/devops
→ sends { agentId, name, hostname, roomId }
→ server creates PENDING entry
→ Owner approves in browser
→ server sends back signed agentToken
→ token saved to config (mode 600)
→ agent reconnects as ACTIVE
subsequent starts
→ sends { agentId, agentToken }
→ server verifies → ACTIVE immediately

---

## Config File

Location: `~/.thinknagent/config.json` (permissions: 600)

```json
{
  "agentId": "uuid-v4",
  "serverUrl": "ur.server.url",
  "name": "my-server",
  "roomId": "your-room-id",
  "agentToken": "sha256-hmac-signed-token",
  "role": "monitor",
  "gpu": false,
  "logs": [
    "/var/log/syslog",
    "/var/log/nginx/error.log"
  ],
  "alerts": [
    { "id": "cpu-high",  "metric": "cpu.usage",      "op": "gt", "value": 85, "for": 60, "severity": "warning"  },
    { "id": "cpu-crit",  "metric": "cpu.usage",      "op": "gt", "value": 95, "for": 30, "severity": "critical" },
    { "id": "mem-high",  "metric": "memory.usedPct", "op": "gt", "value": 85, "for": 60, "severity": "warning"  },
    { "id": "disk-root", "metric": "disk./",         "op": "gt", "value": 90, "for": 0,  "severity": "critical" }
  ]
}
```

---

## Run as a Service (Recommended)

Keep the agent running after SSH disconnect:

**Using pm2:**
```bash
npm install -g pm2
pm2 start $(which thinknagent) --name thinknagent -- start
pm2 save
pm2 startup
```

**Using systemd:**
```bash
sudo nano /etc/systemd/system/app.service
```

```ini
[Unit]
Description=ThinkNCollab Agent
After=network.target

[Service]
Type=simple
User=ubuntu
ExecStart=/home/ubuntu/.npm-global/bin/thinknagent start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable thinknagent
sudo systemctl start thinknagent
sudo systemctl status thinknagent
```

---

## Troubleshooting

**Permission denied**
```bash
chmod +x $(which thinknagent)
```

**node-pty build error**
```bash
sudo apt-get install -y build-essential python3
npm install -g thinknagent
```

**Registration rejected: Invalid or revoked credentials**
```bash
thinknagent revoke
thinknagent init --server https://thinkncollab.com --name my-server --room <roomId>
thinknagent start
```

**Agent connects but not showing in DevOps Wall**

Refresh the DevOps Wall page — the agent list updates on page load.

**Metrics not updating**

Make sure agent is approved and `connected: true`. Check:
```bash
thinknagent status
```

---

## Requirements

- Node.js v18+
- Linux or macOS
- `build-essential` + `python3` (for shell feature)
- Outbound HTTPS/WSS to your ThinkNCollab server

---

## License

MIT © [ThinkNCollab](https://thinkncollab.com)
