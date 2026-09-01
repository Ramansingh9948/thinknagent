# 🚀 thinknagent

[![npm version](https://img.shields.io/npm/v/thinknagent.svg?style=flat-square&color=00ff88)](https://www.npmjs.com/package/thinknagent)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg?style=flat-square)](https://nodejs.org)
[![e2ee](https://img.shields.io/badge/security-AES--256--GCM%20E2EE-brightgreen.svg?style=flat-square)](https://thinkncollab.com)

Official high-performance server agent for **[ThinkNCollab DevOps Wall](https://thinkncollab.com)** — real-time hardware metrics, event-driven log streaming, interactive Web PTY shell, APM traces, and automatic alert monitoring with **100% Client-Side AES-256-GCM End-to-End Encryption (E2EE)**.

---

## ⚡ Quick Start (Zero Install / NPX)

Connect any server in seconds with **NPX**:

```bash
# 1. Initialize & register with your room
npx thinknagent init --room <roomId> --role shell

# 2. Start the self-healing background daemon
npx thinknagent daemon start
```

---

## 📦 Global Installation

```bash
npm install -g thinknagent
```

> **Prerequisites:** Node.js v18+ on Linux, macOS, or Windows (WSL).

If you encounter native build errors for interactive shell (`node-pty`):
```bash
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y build-essential python3

# CentOS / RHEL
sudo yum groupinstall "Development Tools" -y
```

---

## 🛠️ CLI Commands

| Command | Description |
| :--- | :--- |
| `thinknagent init` | Initialize & register this node with your ThinkNCollab workspace |
| `thinknagent start` | Run agent in active foreground (ideal for testing / debugging) |
| `thinknagent daemon start` | Start detached supervisor with auto-restart protection |
| `thinknagent daemon stop` | Stop the background daemon supervisor |
| `thinknagent daemon status` | Check daemon health, PID, uptime, and system status |
| `thinknagent daemon install` | Install as an OS-level Auto-Boot Service (**Linux Systemd** or **macOS LaunchAgent**) |
| `thinknagent status` | Show current authentication state, role, token, and node info |
| `thinknagent logs` | Tail live agent daemon logs |
| `thinknagent revoke` | Clear local credentials and reset connection state |

---

## ⚙️ Initialization Options

```bash
thinknagent init [options]
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `--room <roomId>` | **Required** | Your ThinkNCollab Room ID (from workspace URL) |
| `--server <url>` | `https://thinkncollab.com` | Central ThinkNCollab server URL |
| `--name <name>` | Hostname | Custom display name for this node |
| `--role <role>` | `shell` | Requested permission role: `monitor` | `shell` | `admin` |
| `--logs <paths>` | `` | Comma-separated log file paths to stream live |
| `--app-path <path>` | Current Dir | Application directory path (for auto-version & git commit tracking) |
| `--gpu` | `false` | Enable NVIDIA GPU telemetry (requires `nvidia-smi`) |
| `--force` | `false` | Overwrite existing configuration |

### Example Commands:

```bash
# Standard Production Server with Nginx & PM2 logs
thinknagent init \
  --server https://thinkncollab.com \
  --room 6a318170496c7b00a7f74260 \
  --name "prod-api-01" \
  --role shell \
  --logs "/var/log/nginx/error.log,/home/ubuntu/.pm2/logs/app-error.log" \
  --app-path /home/ubuntu/myapp
```

---

## 🔒 Security & AES-256 E2EE Architecture

`thinknagent` is built with a strict **Zero-Trust & Zero-Knowledge** security model:

1. **Client-Side AES-256-GCM Encryption**:
   - All streamed log lines and sensitive terminal output are encrypted on the server before network transmission.
   - The central ThinkNCollab server acts as a blind relay and **cannot decrypt or read your logs**.
   - Your browser decrypts the stream locally via the **WebCrypto API** (`e2ee-vault.js`).

2. **Double-Gate Role-Based Access Control**:
   - New agents start in `PENDING` mode until explicitly approved by the workspace owner in the DevOps Wall.
   - Roles (`monitor`, `shell`, `admin`) restrict remote PTY terminal execution.

3. **Isolated Shell Environment**:
   - Interactive PTY shells run in a sanitized environment whitelist.
   - Secrets, environment variables (`.env`), and credentials belonging to the agent process are never leaked into the subshell.

4. **Path Traversal Protection**:
   - Log streaming strictly blocks access to `/etc/shadow`, `/etc/sudoers`, `.ssh`, `.gnupg`, and `.env` files.

---

## 📊 Features on ThinkNCollab DevOps Wall

- **◈ Live Telemetry**: CPU, Memory, Disk mounts, Network I/O, Top CPU processes, and GPU utilization streamed over persistent WebSockets.
- **≡ Encrypted Log Streams**: High-throughput chunked file watching (`chokidar`) with instant tailing and search.
- **▸ Full Interactive Web PTY**: Real-time bidirectional terminal with color, resize, and keystroke streaming.
- **⚡ APM Traces & Percentiles**: Auto-computes latency distribution (p50, p90, p95, p99) and flame graphs.
- **🚨 Dynamic Alert Engine**: Custom multi-metric threshold triggers evaluated in real-time.

---

## 🔄 Running Permanently (Production Setup)

### Option 1: Built-in Systemd Service (Recommended for Linux Servers)

```bash
# Auto-generates and activates /etc/systemd/system/thinknagent.service
sudo thinknagent daemon install
```

### Option 2: Built-in Background Supervisor

```bash
thinknagent daemon start
```

### Option 3: PM2 Process Manager

```bash
pm2 start thinknagent --name "thinknagent" -- start
pm2 save
pm2 startup
```

---

## 📜 License

MIT © [ThinkNCollab](https://thinkncollab.com)
