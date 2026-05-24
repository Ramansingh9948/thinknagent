'use strict';

const fs      = require('fs');
const path    = require('path');
const chokidar = require('chokidar');
const { EventEmitter } = require('events');

const BUFFER_LINES = 100;
const CHUNK_DELAY  = 50;

class LogWatcher extends EventEmitter {
  constructor({ connection, logPaths = [] }) {
    super();
    this.conn     = connection;
    this.logPaths = logPaths;
    this._watchers = new Map(); // path → { watcher, size, timer, lines }
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
    for (const [, w] of this._watchers) {
      w.watcher.close();
      if (w.timer) clearTimeout(w.timer);
    }
    this._watchers.clear();
  }

  _watch(filePath) {
    const absPath = path.resolve(filePath);

    const state = {
      watcher: null,
      size:    fs.existsSync(absPath) ? fs.statSync(absPath).size : 0,
      timer:   null,
      lines:   [],
    };

    // send tail on startup if file exists
    if (fs.existsSync(absPath)) {
      this._sendTail(absPath);
    }

    const watcher = chokidar.watch(absPath, {
      persistent:    true,
      usePolling:    false,   // inotify on Linux — no polling overhead
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 50 },
    });

    watcher.on('add', () => {
      // file created after watch started (e.g. log rotation)
      state.size = 0;
      this._sendTail(absPath);
    });

    watcher.on('change', (fpath, stats) => {
      const newSize = stats ? stats.size : fs.statSync(absPath).size;

      if (newSize < state.size) {
        // log rotated — reset
        state.size = 0;
      }

      const newBytes = newSize - state.size;
      if (newBytes <= 0) return;

      const buf = Buffer.alloc(newBytes);
      const fd  = fs.openSync(absPath, 'r');
      fs.readSync(fd, buf, 0, newBytes, state.size);
      fs.closeSync(fd);
      state.size = newSize;

      const newLines = buf.toString('utf8').split('\n').filter(Boolean);
      state.lines.push(...newLines);

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

    watcher.on('error', (err) => {
      console.error(`[logs] Watch error on ${absPath}:`, err.message);
    });

    state.watcher = watcher;
    this._watchers.set(absPath, state);
  }

  _sendTail(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines   = content.split('\n').filter(Boolean).slice(-BUFFER_LINES);
      if (lines.length) {
        this.conn.emit('agent:logs:tail', {
          file:  filePath,
          lines: lines.map(l => ({ ts: null, text: l })),
        });
      }
    } catch (err) {
      console.error(`[logs] Failed to read tail for ${filePath}:`, err.message);
    }
  }
}

module.exports = LogWatcher;