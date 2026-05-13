'use strict';

let pty;
try {
  pty = require('node-pty');
} catch {
  pty = null; // node-pty is optional — shell feature disabled if not installed
}

/**
 * Shell bridge — opens a PTY session on this server and relays I/O
 * bidirectionally over Socket.IO to the DevOps Wall xterm.js terminal.
 *
 * Role gate: connection.hasRole('shell') must be true.
 * If the agent role is 'monitor' only, all shell:open events are rejected.
 */

class ShellBridge {
  constructor({ connection }) {
    this.conn     = connection;
    this._sessions = new Map(); // sessionId → ptyProcess
  }

  start() {
    if (!pty) {
      console.warn('[shell] node-pty not installed — shell feature disabled');
      return;
    }

    const s = this.conn.socket;

    // Browser requests a new shell session
    s.on('shell:open', ({ sessionId, cols = 80, rows = 24 }) => {
      if (!this.conn.hasRole('shell')) {
        s.emit('shell:error', { sessionId, reason: 'Insufficient role — shell access not granted for this agent' });
        return;
      }
      if (this._sessions.has(sessionId)) return; // already open

      const proc = pty.spawn(process.env.SHELL || '/bin/bash', [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd:  process.env.HOME || '/',
        env:  {
          ...process.env,
          TERM: 'xterm-256color',
          THINKNCOLLAB_AGENT: '1',       // agent can inject this env so shell scripts know
        },
      });

      proc.onData(data => {
        s.emit('shell:data', { sessionId, data });
      });

      proc.onExit(({ exitCode }) => {
        s.emit('shell:exit', { sessionId, exitCode });
        this._sessions.delete(sessionId);
        console.log(`[shell] Session ${sessionId} exited (code ${exitCode})`);
      });

      this._sessions.set(sessionId, proc);
      s.emit('shell:opened', { sessionId });
      console.log(`[shell] Session ${sessionId} opened (${cols}x${rows})`);
    });

    // Browser → server → agent: user typed something
    s.on('shell:input', ({ sessionId, data }) => {
      const proc = this._sessions.get(sessionId);
      if (!proc) return;
      proc.write(data);
    });

    // Browser resized terminal
    s.on('shell:resize', ({ sessionId, cols, rows }) => {
      const proc = this._sessions.get(sessionId);
      if (!proc) return;
      proc.resize(cols, rows);
    });

    // Browser closed terminal tab
    s.on('shell:close', ({ sessionId }) => {
      this._killSession(sessionId);
    });

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

  // Kill all sessions on disconnect
  killAll() {
    for (const [id] of this._sessions) this._killSession(id);
  }
}

module.exports = ShellBridge;
