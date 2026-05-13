'use strict';

const Connection    = require('./connect');
const MetricsPoller = require('./metrics');
const LogWatcher    = require('./logwatcher');
const AlertEngine   = require('./alerts');
const ShellBridge   = require('./shell');
const store         = require('./store');

class Agent {
  constructor() {
    const cfg = store.read();

    this.conn    = new Connection({
      serverUrl:    cfg.serverUrl,
      onReady:      ({ role, roomId }) => this._onReady(role, roomId),
      onDisconnect: ({ reason })       => this._onDisconnect(reason),
      onRoleUpdate: ({ role })         => this._onRoleUpdate(role),
    });

    this.metrics = new MetricsPoller({
      connection: this.conn,
      gpu:        cfg.gpu || false,
    });

    this.logs    = new LogWatcher({
      connection: this.conn,
      logPaths:   cfg.logs || [],
    });

    this.alerts  = new AlertEngine({
      connection: this.conn,
      rules:      cfg.alerts || [],
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
  
  // ✅ Pehle connect karo
  this.conn.connect();

  // ✅ Socket ready hone ke baad events bind karo
  //    conn.socket ab available hai kyunki connect() sync mein socket banata hai
  this.conn.socket.on('agent:rules_updated', ({ rules }) => {
    store.set('alerts', rules);
    this.alerts.reloadRules(rules);
  });

  this.conn.socket.on('agent:send_metrics_now', () => {
    console.log('[agent] Metrics poll requested');
    this.metrics.pollNow();
  });

  this.conn.socket.on('agent:logs_updated', ({ logs }) => {
    store.set('logs', logs);
    this.logs.stop();
    this.logs = new LogWatcher({ connection: this.conn, logPaths: logs });
    if (this._active) this.logs.start(); // ✅ sirf tab start karo agar active ho
  });

  process.on('SIGTERM', () => this._shutdown('SIGTERM'));
  process.on('SIGINT',  () => this._shutdown('SIGINT'));
}

_onReady(role, roomId) {
  if (this._active) {
    // Reconnect case — metrics/logs already chal rahe hain
    console.log(`[agent] Reconnected. Role: ${role}`);
    return;
  }

  this._active = true;
  console.log(`[agent] Active! Role: ${role} | Room: ${roomId}`);

  // ✅ Metrics emit ko alert engine se connect karo
  const origEmit = this.conn.emit.bind(this.conn);
  this.conn.emit = (event, data) => {
    if (event === 'agent:metrics') this.alerts.evaluate(data);
    origEmit(event, data);
  };

  this.metrics.start();
  this.logs.start();
  this.shell.start();
}
  

  _onDisconnect(reason) {
    this.shell.killAll();
    // metrics + logs keep their intervals; socket.io will reconnect automatically
  }

  _onRoleUpdate({ role }) {
    // If role was downgraded to 'monitor', kill open shell sessions
    if (!this.conn.hasRole('shell')) {
      this.shell.killAll();
    }
  }

  _shutdown(signal) {
    console.log(`[agent] ${signal} received — shutting down`);
    this.metrics.stop();
    this.logs.stop();
    this.shell.killAll();
    this.conn.socket?.disconnect();
    process.exit(0);
  }
}

module.exports = Agent;
