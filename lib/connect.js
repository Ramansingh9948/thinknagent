'use strict';

const { io }   = require('socket.io-client');
const store    = require('./store');

const NAMESPACE = '/devops';
const RECONNECT_DELAY = 5000;

/**
 * Option B auth flow:
 * 1. Agent has no token yet → sends { agentId, name, hostname } to server
 * 2. Server creates a PENDING agent entry, notifies Owner in room
 * 3. Owner approves in browser → server sends back a signed agentToken
 * 4. Agent stores token in ~/.thinknagent/config.json (mode 600)
 * 5. All future connections: agent sends { agentId, agentToken } → server verifies → ACTIVE
 */

class Connection {
  constructor({ serverUrl, onReady, onDisconnect, onRoleUpdate }) {
    this.serverUrl   = serverUrl;
    this.onReady     = onReady;       // called when agent is ACTIVE and authed
    this.onDisconnect = onDisconnect;
    this.onRoleUpdate = onRoleUpdate; // called if Owner changes agent permissions
    this.socket      = null;
    this.agentId     = store.get('agentId');
    this.agentToken  = store.get('agentToken');
    this.role        = store.get('role') || 'monitor'; // monitor | shell | admin
  }

  connect() {
  const cfg = store.read();

  this.socket = io(`${this.serverUrl}${NAMESPACE}`, {
    reconnection: true,
    reconnectionDelay: RECONNECT_DELAY,
    reconnectionAttempts: Infinity,
   auth: (cb) => {
  const freshCfg = store.read();
  console.log('[debug] Reconnecting with token:', !!freshCfg.agentToken, 'agentId:', freshCfg.agentId);
  cb({
    agentId:    freshCfg.agentId,
    agentToken: freshCfg.agentToken || null,
    name:       freshCfg.name,
    hostname:   require('os').hostname(),
    version:    require('../package.json').version,
    roomId:     freshCfg.roomId || null,
  });
}
  });

  this._bind();
  return this.socket;
}

  _bind() {
    const s = this.socket;

    // ── Registration flow (Option B) ─────────────────────────────────────────

    // Server says: "I got your registration, waiting for Owner approval"
  s.on('agent:pending', ({ agentId }) => {
  // ✅ agentId store mat karo — UUID pehle se store mein hai
  console.log(`[thinknagent] Registered — waiting for Owner approval...`);
});

s.on('agent:approved', ({ agentToken, role, roomId }) => {
  // ✅ agentId yahan store mat karo — UUID already store mein sahi hai
  store.set('agentToken', agentToken);
  store.set('role',       role);
  store.set('roomId',     roomId);
  // agentId touch mat karo!

  this.agentToken = agentToken;
  this.role       = role;

  console.log(`[thinknagent] Approved! Reconnecting with token...`);
  this.socket.disconnect();
  setTimeout(() => this.socket.connect(), 500);
});
    // Server says: "Owner rejected this agent"
    s.on('agent:rejected', ({ reason }) => {
      console.error(`[thinknagent] Registration rejected: ${reason}`);
      store.clear();
      process.exit(1);
    });

    // Already approved on previous run — server confirms active session
    s.on('agent:active', ({ role, roomId }) => {
      this.role = role;
      console.log(`[thinknagent] Reconnected. Role: ${role} | Room: ${roomId}`);
      this.onReady?.({ role, roomId });
    });

    // Owner changed this agent's role at runtime
    s.on('agent:role_updated', ({ role }) => {
      store.set('role', role);
      this.role = role;
      console.log(`[thinknagent] Role updated to: ${role}`);
      this.onRoleUpdate?.({ role });
    });

    // Owner revoked this agent
    s.on('agent:revoked', () => {
      console.warn('[thinknagent] Agent revoked by Owner. Clearing credentials.');
      store.clear();
      process.exit(0);
    });

    s.on('connect_error', (err) => {
      console.error(`[thinknagent] Connection error: ${err.message}`);
    });

    s.on('disconnect', (reason) => {
      console.warn(`[thinknagent] Disconnected: ${reason}`);
      this.onDisconnect?.({ reason });
    });
  }

  // Emit helper — checks role before sending sensitive data
  emit(event, data) {
    if (!this.socket?.connected) return;
    this.socket.emit(event, data);
  }

  // Role gate helper — called by shell.js before opening PTY
  hasRole(required) {
    const hierarchy = { monitor: 0, shell: 1, admin: 2 };
    return (hierarchy[this.role] ?? -1) >= (hierarchy[required] ?? 99);
  }

  get connected() {
    return this.socket?.connected ?? false;
  }
}

module.exports = Connection;
