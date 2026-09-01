'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const chalk = require('chalk');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.thinknagent');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');

class DaemonManager {
  constructor() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
  }

  // ─── 1. Background Supervisor with Auto-Restart ───────────────────────────
  startSupervisor() {
    if (this.isRunning()) {
      const pid = this.getPid();
      console.log(chalk.yellow(`Daemon is already running (PID: ${pid}).`));
      return;
    }

    const supervisorPath = path.resolve(__dirname, 'supervisor.js');
    const logFd = fs.openSync(LOG_FILE, 'a', 0o600);

    // Spawn detached supervisor process
    const child = spawn(process.execPath, [supervisorPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });

    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid), { encoding: 'utf8', mode: 0o600 });


    console.log(chalk.green('\n  ✔ ThinkNCollab Agent Daemon started with Auto-Restart!'));
    console.log(chalk.gray('  ─────────────────────────────────────────────'));
    console.log(`  PID      : ${chalk.cyan(child.pid)}`);
    console.log(`  Logs     : ${chalk.white(LOG_FILE)}`);
    console.log(`  Behavior : ${chalk.green('Auto-restarts automatically if stopped/killed')}`);
    console.log(chalk.gray('  ─────────────────────────────────────────────'));
    console.log(`  Check status : ${chalk.cyan('thinknagent daemon status')}`);
    console.log(`  Stop daemon  : ${chalk.cyan('thinknagent daemon stop')}\n`);
  }

  stopSupervisor() {
    if (!this.isRunning()) {
      console.log(chalk.yellow('No daemon process currently running.'));
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      return;
    }

    const pid = this.getPid();
    try {
      // Kill process group
      process.kill(-pid, 'SIGTERM');
    } catch (e) {
      try { process.kill(pid, 'SIGTERM'); } catch (e2) {}
    }

    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    console.log(chalk.green(`\n  ✔ Stopped thinknagent daemon (PID ${pid}).\n`));
  }

  getStatus() {
    const running = this.isRunning();
    const pid = running ? this.getPid() : null;

    console.log(chalk.cyan('\n  thinknagent Daemon Status'));
    console.log(chalk.gray('  ─────────────────────────────────────────────'));
    console.log(`  Status       : ${running ? chalk.green('RUNNING (Auto-Restart Active)') : chalk.gray('STOPPED')}`);
    if (running) {
      console.log(`  PID          : ${chalk.cyan(pid)}`);
      console.log(`  Log file     : ${chalk.white(LOG_FILE)}`);
    }
    console.log(`  OS Platform  : ${os.type()} ${os.release()} (${os.arch()})`);
    console.log(chalk.gray('  ─────────────────────────────────────────────\n'));
  }

  getPid() {
    if (!fs.existsSync(PID_FILE)) return null;
    try {
      return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    } catch {
      return null;
    }
  }

  isRunning() {
    const pid = this.getPid();
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // ─── 2. OS Level Auto-Boot Service Installation ───────────────────────────
  installService() {
    const platform = process.platform;
    const binPath = path.resolve(__dirname, '../bin/thinknagent.js');
    const nodeExec = process.execPath;

    if (platform === 'linux') {
      this._installLinuxSystemd(nodeExec, binPath);
    } else if (platform === 'darwin') {
      this._installMacLaunchd(nodeExec, binPath);
    } else {
      console.log(chalk.yellow(`OS ${platform} service generation not supported. Use 'thinknagent daemon start' instead.`));
    }
  }

  _installLinuxSystemd(nodeExec, binPath) {
    const serviceContent = `[Unit]
Description=ThinkNCollab Server Agent (Auto-Restart Daemon)
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodeExec} ${binPath} start
Restart=always
RestartSec=5s
KillMode=process
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=thinknagent

[Install]
WantedBy=multi-user.target
`;
    const servicePath = '/etc/systemd/system/thinknagent.service';
    try {
      fs.writeFileSync(servicePath, serviceContent, 'utf8');
      execSync('systemctl daemon-reload && systemctl enable thinknagent && systemctl restart thinknagent', { stdio: 'inherit' });
      console.log(chalk.green('\n  ✔ Linux Systemd service installed and started with auto-restart!'));
      console.log(`  Logs: ${chalk.cyan('journalctl -u thinknagent -f')}\n`);
    } catch (err) {
      console.error(chalk.red(`\n  Failed to install systemd service: ${err.message}`));
      console.log(chalk.yellow('  Make sure to run with sudo: sudo thinknagent daemon install\n'));
    }
  }

  _installMacLaunchd(nodeExec, binPath) {
    const launchAgentsDir = path.join(HOME, 'Library/LaunchAgents');
    if (!fs.existsSync(launchAgentsDir)) fs.mkdirSync(launchAgentsDir, { recursive: true });

    const plistPath = path.join(launchAgentsDir, 'com.thinkncollab.agent.plist');
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.thinkncollab.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
    <string>${binPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
`;

    try {
      fs.writeFileSync(plistPath, plistContent, 'utf8');
      try { execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: 'ignore' }); } catch (e) {}
      execSync(`launchctl load ${plistPath}`, { stdio: 'inherit' });
      console.log(chalk.green('\n  ✔ macOS LaunchAgent daemon installed and started with KeepAlive auto-restart!'));
      console.log(`  Logs: ${chalk.cyan(LOG_FILE)}\n`);
    } catch (err) {
      console.error(chalk.red(`\n  Failed to install LaunchAgent: ${err.message}\n`));
    }
  }
}

module.exports = DaemonManager;
