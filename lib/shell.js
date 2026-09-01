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
  'NVM_DIR', 'NODE_PATH', 'PM2_HOME', 'EDITOR', 'VISUAL', 'CI'
]);

function buildSafeEnv() {
  const safe = {};
  for (const key of PTY_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  const home = process.env.HOME || '/home/ubuntu';
  const extraPaths = [
    `${home}/.nvm/versions/node/$(ls ${home}/.nvm/versions/node 2>/dev/null | tail -n 1)/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.local/bin`,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].join(':');

  safe.PATH               = safe.PATH ? `${safe.PATH}:${extraPaths}` : extraPaths;
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

    s.on('shell:open', ({ sessionId, cols = 80, rows = 24 }) => {
      if (!this.conn.hasRole('shell')) {
        s.emit('shell:error', {
          sessionId,
          reason: 'Insufficient role — shell access not granted for this agent',
        });
        return;
      }

      // Close any existing PTY sessions to guarantee single active terminal session
      for (const [id, oldProc] of this._sessions) {
        try { oldProc.kill(); } catch (e) {}
        this._sessions.delete(id);
      }

      if (pty) {
        const proc = pty.spawn(process.env.SHELL || '/bin/bash', [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: process.env.HOME || '/',
          env: buildSafeEnv(),
        });

        proc.onData(data => s.emit('shell:data', { sessionId, data }));
        proc.onExit(({ exitCode }) => {
          s.emit('shell:exit', { sessionId, exitCode });
          this._sessions.delete(sessionId);
          console.log(`[shell] Session ${sessionId} exited (code ${exitCode})`);
        });

        this._sessions.set(sessionId, proc);
        s.emit('shell:opened', { sessionId });
        console.log(`[shell] PTY session ${sessionId} opened (${cols}x${rows})`);
      } else {
        // Fallback to interactive standard child_process spawn
        const { spawn } = require('child_process');
        const proc = spawn(process.env.SHELL || '/bin/bash', ['-i'], {
          cwd: process.env.HOME || '/',
          env: buildSafeEnv(),
          stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.stdout.on('data', data => s.emit('shell:data', { sessionId, data: data.toString() }));
        proc.stderr.on('data', data => s.emit('shell:data', { sessionId, data: data.toString() }));
        proc.on('exit', exitCode => {
          s.emit('shell:exit', { sessionId, exitCode: exitCode || 0 });
          this._sessions.delete(sessionId);
        });

        this._sessions.set(sessionId, {
          write: data => proc.stdin.write(data),
          resize: () => {},
          kill: () => proc.kill()
        });
        s.emit('shell:opened', { sessionId });
        console.log(`[shell] Interactive Spawn session ${sessionId} opened`);
      }
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