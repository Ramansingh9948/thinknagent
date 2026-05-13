'use strict';

const fs      = require('fs');
const path    = require('path');
const { EventEmitter } = require('events');

const BUFFER_LINES = 100;   // lines to send on initial connect
const CHUNK_DELAY  = 50;    // ms debounce before flushing new lines

class LogWatcher extends EventEmitter {
  constructor({ connection, logPaths = [] }) {
    super();
    this.conn     = connection;
    this.logPaths = logPaths;
    this._watchers = new Map(); // path → { fd, size, timer }
  }

  start() {
    if (!this.logPaths.length) {
      console.log('[logs] No log paths configured — skipping');
      return;
    }
    for (const p of this.logPaths) {
      this._watch(p);
    }
    console.log(`[logs] Watching ${this.logPaths.length} file(s)`);
  }

  stop() {
    for (const [p, w] of this._watchers) {
      try { fs.unwatchFile(p); } catch {}
      if (w.timer) clearTimeout(w.timer);
    }
    this._watchers.clear();
  }

  _watch(filePath) {
    const absPath = path.resolve(filePath);

    if (!fs.existsSync(absPath)) {
      console.warn(`[logs] File not found: ${absPath} — will retry when it appears`);
      // retry every 10s in case log file is created later
      setTimeout(() => this._watch(filePath), 10000);
      return;
    }

    const stat = fs.statSync(absPath);
    const state = {
      size:  stat.size,
      timer: null,
      lines: [],
    };

    // Send last BUFFER_LINES lines on startup
    this._sendTail(absPath);

    fs.watchFile(absPath, { interval: 500 }, (curr, prev) => {
      if (curr.size < prev.size) {
        // Log rotated — reset position
        state.size = 0;
      }
      if (curr.size === prev.size) return;

      const newBytes = curr.size - state.size;
      if (newBytes <= 0) return;

      const buf = Buffer.alloc(newBytes);
      const fd  = fs.openSync(absPath, 'r');
      fs.readSync(fd, buf, 0, newBytes, state.size);
      fs.closeSync(fd);
      state.size = curr.size;

      const newLines = buf.toString('utf8').split('\n').filter(Boolean);
      state.lines.push(...newLines);

      // debounce — batch lines before emit
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        const toSend = state.lines.splice(0);
        if (toSend.length) {
          this.conn.emit('agent:logs', {
            file:  absPath,
            lines: toSend.map(l => ({ ts: Date.now(), text: l })),
          });
        }
      }, CHUNK_DELAY);
    });

    this._watchers.set(absPath, state);
  }

  _sendTail(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines   = content.split('\n').filter(Boolean).slice(-BUFFER_LINES);
      if (lines.length) {
        this.conn.emit('agent:logs:tail', {
          file:  filePath,
          lines: lines.map(l => ({ ts: null, text: l })), // historical = no ts
        });
      }
    } catch (err) {
      console.error(`[logs] Failed to read tail for ${filePath}:`, err.message);
    }
  }
}

module.exports = LogWatcher;
