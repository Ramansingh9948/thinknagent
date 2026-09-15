'use strict';

let pty = null;
try {
  pty = require('node-pty');
} catch {
  pty = null;
}

let detectedPtyLauncher = null;
function getPtyLauncher() {
  if (detectedPtyLauncher) return detectedPtyLauncher;
  if (pty) {
    detectedPtyLauncher = 'node-pty';
    return 'node-pty';
  }
  const { execSync } = require('child_process');
  try {
    execSync('python3 -c "import pty"', { stdio: 'ignore' });
    detectedPtyLauncher = 'python3';
    return 'python3';
  } catch {}
  try {
    execSync('python -c "import pty"', { stdio: 'ignore' });
    detectedPtyLauncher = 'python';
    return 'python';
  } catch {}
  detectedPtyLauncher = 'spawn';
  return 'spawn';
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

      const launcher = getPtyLauncher();
      const shellPath = process.env.SHELL || '/bin/bash';
      const homeDir = process.env.HOME || '/';
      const safeEnv = buildSafeEnv();

      if (launcher === 'node-pty' && pty) {
        // Tier 1: node-pty native module
        const proc = pty.spawn(shellPath, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: homeDir,
          env: safeEnv,
        });

        proc.onData(data => this._sendData(s, sessionId, data));
        proc.onExit(({ exitCode }) => {
          s.emit('shell:exit', { sessionId, exitCode });
          this._sessions.delete(sessionId);
          console.log(`[shell] Session ${sessionId} exited (code ${exitCode})`);
        });

        this._sessions.set(sessionId, proc);
        s.emit('shell:opened', { sessionId });
        console.log(`[shell] PTY session ${sessionId} opened via node-pty (${cols}x${rows})`);
      } else if (launcher === 'python3' || launcher === 'python') {
        // Tier 2: Native OS pseudo-terminal via standard library pty.spawn
        // Eliminates 'Inappropriate ioctl for device' & 'no job control' completely
        const { spawn } = require('child_process');
        const pyCode = 'import pty, os; os.environ["TERM"]="xterm-256color"; pty.spawn([os.environ.get("SHELL", "/bin/bash")])';
        const proc = spawn(launcher, ['-c', pyCode], {
          cwd: homeDir,
          env: safeEnv,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.stdout.on('data', data => this._sendData(s, sessionId, data.toString()));
        proc.stderr.on('data', data => {
          const clean = data.toString()
            .replace(/^bash: cannot set terminal process group.*?\n/gm, '')
            .replace(/^bash: no job control in this shell.*?\n/gm, '');
          if (clean) this._sendData(s, sessionId, clean);
        });
        proc.on('exit', exitCode => {
          s.emit('shell:exit', { sessionId, exitCode: exitCode || 0 });
          this._sessions.delete(sessionId);
          console.log(`[shell] Python PTY session ${sessionId} exited (code ${exitCode})`);
        });

        this._sessions.set(sessionId, {
          write: data => proc.stdin.write(data),
          resize: () => {},
          kill: () => {
            try { proc.kill('SIGTERM'); } catch {}
          }
        });
        s.emit('shell:opened', { sessionId });
        console.log(`[shell] Genuine OS PTY session ${sessionId} opened via ${launcher}`);
      } else {
        // Tier 3: Pure ChildProcess fallback with suppressed ioctl noise
        const { spawn } = require('child_process');
        const proc = spawn(shellPath, ['--login'], {
          cwd: homeDir,
          env: safeEnv,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.stdout.on('data', data => this._sendData(s, sessionId, data.toString()));
        proc.stderr.on('data', data => {
          // Filter out terminal ioctl startup noise on non-tty pipes
          const clean = data.toString()
            .replace(/^bash: cannot set terminal process group.*?\n/gm, '')
            .replace(/^bash: no job control in this shell.*?\n/gm, '');
          if (clean) this._sendData(s, sessionId, clean);
        });
        proc.on('exit', exitCode => {
          s.emit('shell:exit', { sessionId, exitCode: exitCode || 0 });
          this._sessions.delete(sessionId);
        });

        this._sessions.set(sessionId, {
          write: data => proc.stdin.write(data),
          resize: () => {},
          kill: () => {
            try { proc.kill('SIGTERM'); } catch {}
          }
        });
        s.emit('shell:opened', { sessionId });
        console.log(`[shell] Fallback login shell session ${sessionId} opened`);
      }
    });

    s.on('shell:input', ({ sessionId, data, e2ee }) => {
      const proc = this._sessions.get(sessionId);
      if (!proc) return;
      let text = data;
      if (e2ee || (typeof data === 'string' && data.startsWith('e2ee:'))) {
        const store = require('./store');
        const { decryptE2EE } = require('./e2ee');
        const roomId = this.conn?.roomId || store.get('roomId');
        if (roomId) {
          text = decryptE2EE(data, roomId);
        }
      }
      proc.write(text);
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

  _sendData(s, sessionId, rawChunk) {
    if (!rawChunk) return;
    const store = require('./store');
    const { encryptE2EE } = require('./e2ee');
    const roomId = this.conn?.roomId || store.get('roomId');
    if (roomId) {
      const encrypted = encryptE2EE(rawChunk, roomId);
      s.emit('shell:data', { sessionId, data: encrypted, e2ee: true });
    } else {
      s.emit('shell:data', { sessionId, data: rawChunk, e2ee: false });
    }
  }

  killAll() {
    for (const [id] of this._sessions) this._killSession(id);
  }
}

module.exports = ShellBridge;