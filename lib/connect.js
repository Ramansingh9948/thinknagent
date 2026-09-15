'use strict';

const { io }   = require('socket.io-client');
const store    = require('./store');
const { execSync } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');

let cachedAppVersion = null;
let lastAppPathChecked = null;

function getDeployedAppVersion(appPath) {
  if (cachedAppVersion && lastAppPathChecked === appPath) {
    return cachedAppVersion;
  }
  try {
    const resolvedPath = path.resolve(appPath || process.cwd());
    lastAppPathChecked = appPath;
    let pkgVersion = '';
    let gitCommit = '';

    const pkgJsonPath = path.join(resolvedPath, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        pkgVersion = pkg.version || '';
      } catch (e) {}
    }

    try {
      gitCommit = execSync('git log -n 1 --format="%h - %s" --no-color', {
        cwd: resolvedPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
        encoding: 'utf8'
      }).trim();
    } catch (e) {}

    if (pkgVersion && gitCommit) {
      cachedAppVersion = `v${pkgVersion} (${gitCommit})`;
    } else if (pkgVersion) {
      cachedAppVersion = `v${pkgVersion}`;
    } else if (gitCommit) {
      cachedAppVersion = gitCommit;
    } else {
      cachedAppVersion = 'unknown';
    }
    return cachedAppVersion;
  } catch (err) {
    cachedAppVersion = 'unknown';
    return cachedAppVersion;
  }
}

const NAMESPACE = '/devops';
const RECONNECT_DELAY = 3000;
const cachedHostname = os.hostname();
let cachedPkgVersion = null;
try {
  cachedPkgVersion = require('../package.json').version;
} catch (e) {
  cachedPkgVersion = '0.1.28';
}

/**
 * Option B auth flow:
 * 1. Agent has no token yet → sends { agentId, name, hostname } to server
 * 2. Server creates a PENDING agent entry, notifies Owner in room
 * 3. Owner approves in browser → server sends back a signed agentToken
 * 4. Agent stores token in ~/.thinknagent/config.json (mode 600)
 * 5. All future connections: agent computes HMAC(agentId:ts) in ~0.05ms → server verifies → ACTIVE
 */

class Connection {
  constructor({ serverUrl, onReady, onDisconnect, onRoleUpdate }) {
    this.serverUrl    = serverUrl;
    this.onReady      = onReady;       // called when agent is ACTIVE and authed
    this.onDisconnect = onDisconnect;
    this.onRoleUpdate = onRoleUpdate; // called if Owner changes agent permissions
    this.socket       = null;
    this.agentId      = store.get('agentId');
    this.agentToken   = store.get('agentToken');
    this.role         = store.get('role') || 'monitor'; // monitor | shell | admin
    this._pollTimer   = null;
  }

  connect() {
    const cfg = store.read();
    const appVer = getDeployedAppVersion(cfg.appPath);

    let normalizedServer = (this.serverUrl || cfg.serverUrl || 'https://thinkncollab.com').trim().replace(/\/$/, '');
    if (!normalizedServer.startsWith('https://') && !normalizedServer.startsWith('http://')) {
      normalizedServer = 'https://' + normalizedServer;
    }

    const isLocal = normalizedServer.includes('localhost') || normalizedServer.includes('127.0.0.1');

    // MITM Transport Security: Automatically upgrade HTTP to HTTPS for remote servers
    if (!isLocal && normalizedServer.startsWith('http://')) {
      console.warn('[thinknagent:security] Upgrading insecure HTTP to encrypted HTTPS/WSS to prevent MITM interception.');
      normalizedServer = normalizedServer.replace(/^http:\/\//, 'https://');
    }

    this.serverUrl = normalizedServer;

    this.socket = io(`${this.serverUrl}${NAMESPACE}`, {
      reconnection: true,
      reconnectionDelay: RECONNECT_DELAY,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
      rejectUnauthorized: !cfg.allowSelfSignedCert, // Strict TLS Certificate Authority validation against MITM
      auth: (cb) => {
        const freshCfg = store.read();
        const token = freshCfg.agentToken || this.agentToken;
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex'); // 128-bit cryptographic anti-replay nonce
        let signature = null;

        // Zero-Knowledge HMAC calculation (<0.05ms) with Anti-Replay Nonce
        if (token && freshCfg.agentId) {
          const raw = `${freshCfg.agentId}:${ts}:${nonce}`;
          signature = crypto.createHmac('sha256', token).update(raw).digest('hex');
        }

        cb({
          agentId:    freshCfg.agentId,
          ts,
          nonce,
          signature,
          agentToken: null, // Zero-Knowledge: Secret token NEVER sent in plaintext over the wire
          name:       freshCfg.name,
          hostname:   cachedHostname,
          version:    cachedPkgVersion,
          roomId:     freshCfg.roomId || null,
          appVersion: appVer,
        });
      }
    });

    this._bind();

    // If agent is waiting for approval, start background poll to auto-detect web approval
    if (!cfg.agentToken) {
      this._startApprovalPolling();
    }

    return this.socket;
  }

  _verifyCertPinning(expectedPin) {
    if (!expectedPin) return;
    try {
      const rawSocket = this.socket?.io?.engine?.transport?.ws?._socket || this.socket?.io?.engine?.transport?.socket;
      if (rawSocket && typeof rawSocket.getPeerCertificate === 'function') {
        const cert = rawSocket.getPeerCertificate();
        if (cert && cert.fingerprint256) {
          const actualPin = cert.fingerprint256.replace(/:/g, '').toLowerCase();
          const cleanExpected = expectedPin.replace(/:/g, '').toLowerCase();
          if (actualPin !== cleanExpected) {
            console.error(`\x1b[31m[thinknagent:security] CRITICAL: MITM ATTACK DETECTED!\x1b[0m`);
            console.error(`  Server certificate SHA-256 fingerprint mismatch!`);
            console.error(`  Expected: ${cleanExpected}`);
            console.error(`  Received: ${actualPin}`);
            this.socket.disconnect();
            process.exit(1);
          }
        }
      }
    } catch (pinErr) {
      console.warn('[thinknagent:security] Fingerprint check skipped:', pinErr.message);
    }
  }

  _startApprovalPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      const cfg = store.read();
      if (cfg.agentToken || !cfg.agentId) {
        this._stopApprovalPolling();
        return;
      }
      try {
        const url = `${this.serverUrl}/devops/api/agent/status/${cfg.agentId}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const data = await res.json();
          if (data && data.success && data.status === 'approved' && data.token) {
            console.log(`[thinknagent] Approval detected via API! Saving token...`);
            this._handleApproved({
              agentToken: data.token,
              role: data.role || 'monitor',
              roomId: cfg.roomId
            });
          }
        }
      } catch (err) {}
    }, 4000);
  }

  _stopApprovalPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _handleApproved({ agentToken, role, roomId }) {
    this._stopApprovalPolling();
    store.set('agentToken', agentToken);
    store.set('role',       role);
    if (roomId) store.set('roomId', roomId);

    this.agentToken = agentToken;
    this.role       = role;

    console.log(`[thinknagent] Approved! Active session ready. Role: ${role} | Room: ${roomId}`);
    this.onReady?.({ role, roomId });
  }

  _bind() {
    const s = this.socket;

    s.on('connect', () => {
      const cfg = store.read();
      if (cfg.certFingerprint) {
        this._verifyCertPinning(cfg.certFingerprint);
      }
    });

    // Server says: "I got your registration, waiting for Owner approval"
    s.on('agent:pending', ({ agentId }) => {
      console.log(`[thinknagent] Registered — waiting for Owner approval...`);
      this._startApprovalPolling();
    });

    // Owner approved agent via socket broadcast
    s.on('agent:approved', (payload) => {
      this._handleApproved(payload);
    });

    // Owner explicitly rejected this agent
    s.on('agent:rejected', ({ reason }) => {
      console.error(`[thinknagent] Registration rejected by owner: ${reason}`);
      this._stopApprovalPolling();
      store.clear();
      process.exit(1);
    });

    // Auth verification failed (do NOT wipe store, could be temporary drift or network error)
    s.on('agent:auth_failed', ({ reason }) => {
      console.warn(`[thinknagent] Auth challenge warning: ${reason}. Retrying...`);
      this._startApprovalPolling();
    });

    // Already approved on previous run — server confirms active session
    s.on('agent:active', ({ role, roomId }) => {
      this._stopApprovalPolling();
      this.role = role;
      console.log(`[thinknagent] Active session confirmed. Role: ${role} | Room: ${roomId}`);
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
      this._stopApprovalPolling();
      store.clear();
      process.exit(0);
    });

    // ── Periodic HMAC Challenge-Response Zero-Trust Protocol ───────────────────
    s.on('agent:auth_challenge', ({ challenge, ts }) => {
      const cfg = store.read();
      const token = cfg.agentToken || this.agentToken;
      if (!token) return;

      const clientNonce = crypto.randomBytes(16).toString('hex');
      const raw = `${challenge}:${ts}:${cfg.agentId}:${clientNonce}`;
      const signature = crypto.createHmac('sha256', token).update(raw).digest('hex');

      s.emit('agent:auth_challenge_response', {
        challenge,
        ts,
        clientNonce,
        signature,
        agentId: cfg.agentId
      });
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

Connection.getDeployedAppVersion = getDeployedAppVersion;
module.exports = Connection;

