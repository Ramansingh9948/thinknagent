'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.thinknagent');
const HISTORY_DIR = path.join(CONFIG_DIR, 'history');
const RETENTION_DAYS = 3;
const SNAPSHOT_INTERVAL_MS = 30000; // Snapshot to disk every 30 seconds

class HistoryManager {
  constructor() {
    this._ensureDir();
    this._lastSnapshotTime = 0;
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
      }
    } catch (err) {
      console.warn('[history] Failed to create history directory:', err.message);
    }
  }

  _getDateKey(timestamp = Date.now()) {
    const d = new Date(timestamp);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  _getFilePathForDate(dateKey) {
    return path.join(HISTORY_DIR, `metrics_${dateKey}.jsonl`);
  }

  // Called on every metrics tick (we sample every 30s to disk)
  recordSnapshot(metrics) {
    const now = Date.now();
    if (now - this._lastSnapshotTime < SNAPSHOT_INTERVAL_MS) {
      return;
    }
    this._lastSnapshotTime = now;

    try {
      const dateKey = this._getDateKey(now);
      const filePath = this._getFilePathForDate(dateKey);

      const entry = {
        ts: now,
        cpu: metrics.cpu?.usage ?? 0,
        load: metrics.cpu?.loadAvg ?? 0,
        mem: metrics.memory?.usedPct ?? 0,
        memUsedMB: Math.round((metrics.memory?.used || 0) / (1024 * 1024)),
        rxSec: metrics.network?.[0]?.rxSec ?? 0,
        txSec: metrics.network?.[0]?.txSec ?? 0,
        procs: metrics.processes?.total ?? 0,
        diag: metrics.diagnostics?.hasSpike ? metrics.diagnostics : undefined,
      };

      // Append atomic line to daily disk file (survives crashes, restarts, reboots)
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });

      // Run daily pruning check
      this._pruneOldFiles();
    } catch (err) {
      console.error('[history] Error writing snapshot to disk:', err.message);
    }
  }

  // Deletes any history files older than RETENTION_DAYS (3 days)
  _pruneOldFiles() {
    try {
      const files = fs.readdirSync(HISTORY_DIR);
      const cutoffTime = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const cutoffDateKey = this._getDateKey(cutoffTime);

      for (const file of files) {
        if (!file.startsWith('metrics_') || !file.endsWith('.jsonl')) continue;
        const fileDateKey = file.replace('metrics_', '').replace('.jsonl', '');
        if (fileDateKey < cutoffDateKey) {
          try {
            fs.unlinkSync(path.join(HISTORY_DIR, file));
            console.log(`[history] Pruned old history file: ${file}`);
          } catch (e) {}
        }
      }
    } catch (err) {
      // ignore
    }
  }

  // Retrieve historical data across the last N hours (up to 72 hours / 3 days)
  getHistory(hours = 72) {
    const minTimestamp = Date.now() - (hours * 60 * 60 * 1000);
    const records = [];

    try {
      if (!fs.existsSync(HISTORY_DIR)) return [];

      const files = fs.readdirSync(HISTORY_DIR)
        .filter(f => f.startsWith('metrics_') && f.endsWith('.jsonl'))
        .sort(); // ascending date order

      for (const file of files) {
        const fullPath = path.join(HISTORY_DIR, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.ts >= minTimestamp) {
              records.push(data);
            }
          } catch (e) {}
        }
      }

      // If more than 300 points requested, downsample evenly to keep UI charts silky smooth
      if (records.length > 300) {
        const step = Math.ceil(records.length / 300);
        const sampled = [];
        for (let i = 0; i < records.length; i += step) {
          sampled.push(records[i]);
        }
        return sampled;
      }

      return records;
    } catch (err) {
      console.error('[history] Error reading history from disk:', err.message);
      return [];
    }
  }
}

module.exports = HistoryManager;
