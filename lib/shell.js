'use strict';

let pty;
try {
  pty = require('node-pty');
} catch {
  pty = null;
}

// explicit allowlist — agent process ke secrets PTY mein nahi jayenge
const PTY_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'USER', 'LOGNAME', 'HOSTNAME', 'TZ', 'COLORTERM', 'DISPLAY',
]);

function buildSafeEnv() {
  const safe = {};
  for (const key of PTY_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  safe.TERM               = 'xterm-256color';
  safe.THINKNCOLLAB_AGENT = '1';
  return safe;
}

class ShellBridge {
  constructor({ connection }) {
    this.conn      = connection;
    this._sessions = new Map();
  }

  start() {
    const s = this.conn.socket;

    if (!pty) {
      console.warn('[shell] node-pty not installed — shell feature disabled');
      s.on('shell:open', ({ sessionId }) => {
        s.emit('shell:error', {
          sessionId,
          reason: 'node-pty is not installed on this agent. Run: npm install -g node-pty',
        });
      });
      return;
    }

    s.on('shell:open', ({ sessionId, cols = 80, rows = 24 }) => {
      if (!this.conn.hasRole('shell')) {
        s.emit('shell:error', {
          sessionId,
          reason: 'Insufficient role — shell access not granted for this agent',
        });
        return;
      }

      if (this._sessions.has(sessionId)) return;

      const proc = pty.spawn(process.env.SHELL || '/bin/bash', [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME || '/',
        env: buildSafeEnv(),   // only allowlisted vars — no secrets
      });

      proc.onData(data => s.emit('shell:data', { sessionId, data }));

      proc.onExit(({ exitCode }) => {
        s.emit('shell:exit', { sessionId, exitCode });
        this._sessions.delete(sessionId);
        console.log(`[shell] Session ${sessionId} exited (code ${exitCode})`);
      });

      this._sessions.set(sessionId, proc);
      s.emit('shell:opened', { sessionId });
      console.log(`[shell] Session ${sessionId} opened (${cols}x${rows})`);
    });

    s.on('shell:input', ({ sessionId, data }) => {
      const proc = this._sessions.get(sessionId);
      if (!proc) return;
      proc.write(data);
    });

    s.on('shell:resize', ({ sessionId, cols, rows }) => {
      const proc = this._sessions.get(sessionId);
      if (!proc) return;
      proc.resize(cols, rows);
    });

    s.on('shell:close', ({ sessionId }) => this._killSession(sessionId));

    console.log('[shell] Bridge ready');
  }

  _killSession(sessionId) {
    const proc = this._sessions.get(sessionId);
    if (proc) {
      try { proc.kill(); } catch {}
      this._sessions.delete(sessionId);
      console.log(`[shell] Session ${sessionId} killed`);
    }
  }

  killAll() {
    for (const [id] of this._sessions) this._killSession(id);
  }
}

module.exports = ShellBridge;