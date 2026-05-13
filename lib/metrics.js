'use strict';

const si = require('systeminformation');

const POLL_INTERVAL = 5000; // ms

class MetricsPoller {
  constructor({ connection, gpu = false }) {
    this.conn     = connection;
    this.gpu      = gpu;
    this._timer   = null;
    this._history = []; // last 60 data points (5 min rolling)
  }

  start() {
    this._poll(); // immediate first poll
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL);
    console.log('[metrics] Poller started');
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    console.log('[metrics] Poller stopped');
  }
  pollNow() {
  return this._poll();
}

  async _poll() {
    try {
      const [cpu, mem, disk, net, load, procs] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.networkStats(),
        si.currentLoad(),       // for load average
        si.processes(),
      ]);

      const payload = {
        ts: Date.now(),
        cpu: {
          usage:    parseFloat(cpu.currentLoad.toFixed(1)),
          cores:    cpu.cpus?.length ?? 0,
          loadAvg:  load.avgLoad ?? 0,
        },
        memory: {
          total:    mem.total,
          used:     mem.used,
          free:     mem.free,
          usedPct:  parseFloat(((mem.used / mem.total) * 100).toFixed(1)),
        },
        disk: disk.map(d => ({
          fs:       d.fs,
          mount:    d.mount,
          size:     d.size,
          used:     d.used,
          usedPct:  parseFloat(d.use?.toFixed(1) ?? 0),
        })),
        network: net.map(n => ({
          iface:    n.iface,
          rxSec:    n.rx_sec ?? 0,
          txSec:    n.tx_sec ?? 0,
        })),
        processes: {
          total:  procs.all,
          running: procs.running,
          // top 5 by CPU
          top: (procs.list || [])
            .sort((a, b) => b.pcpu - a.pcpu)
            .slice(0, 5)
            .map(p => ({ pid: p.pid, name: p.name, cpu: p.pcpu, mem: p.pmem })),
        },
      };

      // optional GPU
      if (this.gpu) {
        try {
          const gpuData = await si.graphics();
          payload.gpu = gpuData.controllers?.map(g => ({
            model:      g.model,
            utilizationGpu: g.utilizationGpu ?? null,
            memUsed:    g.memoryUsed ?? null,
            memTotal:   g.memoryTotal ?? null,
            tempC:      g.temperatureGpu ?? null,
          }));
        } catch {
          // nvidia-smi not available — silently skip
        }
      }

      // rolling history (keep last 60 points)
      this._history.push({ ts: payload.ts, cpu: payload.cpu.usage, mem: payload.memory.usedPct });
      if (this._history.length > 60) this._history.shift();

      payload.history = this._history;

      this.conn.emit('agent:metrics', payload);
    } catch (err) {
      console.error('[metrics] Poll error:', err.message);
    }
  }
}

module.exports = MetricsPoller;
