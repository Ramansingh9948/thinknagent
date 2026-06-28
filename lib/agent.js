'use strict';

const path          = require('path');
const Connection    = require('./connect');
const MetricsPoller = require('./metrics');
const LogWatcher    = require('./logwatcher');
const AlertEngine   = require('./alerts');
const ShellBridge   = require('./shell');
const store         = require('./store');
const chokidar      = require('chokidar');
const fs            = require('fs');

// allowed base dirs for log streaming
// room owner agent:logs_updated se bahar ke paths reject ho jayenge
const LOG_PATH_ALLOWLIST = [
  '/var/log',
  '/home',
  '/root',
  '/tmp',
];

function isSafeLogPath(logPath) {
  const resolved = path.resolve(logPath);

  // path traversal check — resolved path allowlist mein hona chahiye
  const allowed = LOG_PATH_ALLOWLIST.some(base => resolved.startsWith(base + path.sep) || resolved === base);
  if (!allowed) {
    console.warn(`[agent] Rejected log path (not in allowlist): ${resolved}`);
    return false;
  }

  // sensitive files blocklist
  const BLOCKED = [
    '/etc/passwd', '/etc/shadow', '/etc/sudoers',
    '.ssh', '.gnupg', '.aws', '.env',
    'id_rsa', 'id_ed25519', 'authorized_keys',
  ];
  const blocked = BLOCKED.some(b => resolved.includes(b));
  if (blocked) {
    console.warn(`[agent] Rejected sensitive log path: ${resolved}`);
    return false;
  }

  return true;
}

function validateRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.filter(r =>
    r && typeof r.id === 'string' &&
    typeof r.metric === 'string' &&
    typeof r.op === 'string' &&
    typeof r.value === 'number'
  );
}

class Agent {
  constructor() {
    const cfg = store.read();

    this.alerts = new AlertEngine({
      connection: null,
      rules:      cfg.alerts || [],
    });

    this.conn = new Connection({
      serverUrl:    cfg.serverUrl,
      onReady:      ({ role, roomId }) => this._onReady(role, roomId),
      onDisconnect: ({ reason })       => this._onDisconnect(reason),
      onRoleUpdate: ({ role })         => this._onRoleUpdate(role),
    });

    this.alerts.conn = this.conn;

    this.metrics = new MetricsPoller({
      connection:    this.conn,
      gpu:           cfg.gpu || false,
      onMetricsEmit: (payload) => this.alerts.evaluate(payload),
    });

    this.logs  = new LogWatcher({
      connection: this.conn,
      logPaths:   (cfg.logs || []).filter(isSafeLogPath),
    });

    this.shell   = new ShellBridge({ connection: this.conn });
    this._active = false;
  }

  start() {
    const cfg = store.read();
    if (!cfg.serverUrl) {
      console.error('[agent] Not initialized.');
      process.exit(1);
    }

    console.log(`[agent] Connecting to ${cfg.serverUrl}...`);
    this.conn.connect();

    this.conn.socket.on('agent:rules_updated', ({ rules }) => {
      const safe = validateRules(rules);
      store.set('alerts', safe);
      this.alerts.reloadRules(safe);
    });

    this.conn.socket.on('agent:send_metrics_now', () => {
      console.log('[agent] Metrics poll requested');
      this.metrics.pollNow();
    });

    this.conn.socket.on('agent:logs_updated', ({ logs }) => {
      if (!Array.isArray(logs)) return;

      // har path validate karo — koi bhi unsafe ho toh poori update reject
      const safeLogs = logs.filter(isSafeLogPath);
      if (safeLogs.length !== logs.length) {
        console.warn(`[agent] Dropped ${logs.length - safeLogs.length} unsafe log path(s) from server update`);
      }

      store.set('logs', safeLogs);
      this.logs.stop();
      this.logs = new LogWatcher({ connection: this.conn, logPaths: safeLogs });
      if (this._active) this.logs.start();
    });

    // Start watching the application path for git pulls or package.json updates
    this._startAppWatcher(cfg);

    process.on('SIGTERM', () => this._shutdown('SIGTERM'));
    process.on('SIGINT',  () => this._shutdown('SIGINT'));
  }

  _startAppWatcher(cfg) {
    if (!cfg.appPath) return;

    try {
      const resolvedPath = path.resolve(cfg.appPath);
      const gitHeadPath  = path.join(resolvedPath, '.git', 'HEAD');
      const gitIndex     = path.join(resolvedPath, '.git', 'index');
      const pkgJsonPath  = path.join(resolvedPath, 'package.json');

      const filesToWatch = [];
      if (fs.existsSync(gitHeadPath)) filesToWatch.push(gitHeadPath);
      if (fs.existsSync(gitIndex)) filesToWatch.push(gitIndex);
      if (fs.existsSync(pkgJsonPath)) filesToWatch.push(pkgJsonPath);

      if (filesToWatch.length === 0) return;

      console.log(`[agent] Watching application path for version changes: ${resolvedPath}`);
      const watcher = chokidar.watch(filesToWatch, {
        persistent: true,
        ignoreInitial: true,
      });

      let debounceTimeout = null;
      watcher.on('change', (filePath) => {
        console.log(`[agent] Detected app file change: ${filePath}. Recalculating version...`);
        if (debounceTimeout) clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => {
          const newVersion = Connection.getDeployedAppVersion(cfg.appPath);
          console.log(`[agent] Reporting updated app version: ${newVersion}`);
          this.conn.emit('agent:meta_update', { appVersion: newVersion });
        }, 2000);
      });

      this._appWatcher = watcher;
    } catch (err) {
      console.warn(`[agent] Failed to initialize application path watcher: ${err.message}`);
    }
  }

  _onReady(role, roomId) {
    if (this._active) {
      console.log(`[agent] Reconnected. Role: ${role}`);
      return;
    }
    this._active = true;
    console.log(`[agent] Active! Role: ${role} | Room: ${roomId}`);
    this.metrics.start();
    this.logs.start();
    this.shell.start();
  }

  _onDisconnect(reason) {
    this.shell.killAll();
  }

  _onRoleUpdate({ role }) {
    if (!this.conn.hasRole('shell')) {
      this.shell.killAll();
    }
  }

  _shutdown(signal) {
    console.log(`[agent] ${signal} received — shutting down`);
    this.metrics.stop();
    this.logs.stop();
    this.shell.killAll();
    if (this._appWatcher) {
      try {
        this._appWatcher.close();
      } catch (e) {}
    }
    this.conn.socket?.disconnect();
    process.exit(0);
  }
}

module.exports = Agent;