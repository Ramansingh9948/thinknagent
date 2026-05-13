'use strict';

/**
 * Alert engine — evaluates threshold rules against live metrics.
 *
 * Rule format (stored in ~/.thinknagent/config.json under "alerts"):
 * [
 *   { id: "cpu-high",  metric: "cpu.usage",         op: "gt", value: 80,  for: 60,  severity: "warning"  },
 *   { id: "cpu-crit",  metric: "cpu.usage",         op: "gt", value: 95,  for: 30,  severity: "critical" },
 *   { id: "mem-high",  metric: "memory.usedPct",    op: "gt", value: 85,  for: 60,  severity: "warning"  },
 *   { id: "disk-root", metric: "disk./",            op: "gt", value: 90,  for: 0,   severity: "critical" },
 *   { id: "proc-down", metric: "process.nginx",     op: "eq", value: 0,   for: 0,   severity: "critical" },
 * ]
 *
 * "for" = seconds the condition must persist before firing (0 = fire immediately)
 */

class AlertEngine {
  constructor({ connection, rules = [] }) {
    this.conn  = connection;
    this.rules = rules;

    // per-rule state: { firstTriggeredAt, fired }
    this._state = {};
    for (const r of rules) {
      this._state[r.id] = { firstTriggeredAt: null, fired: false };
    }
  }

  // Called by metrics poller on every tick
  evaluate(metrics) {
    const now = Date.now();

    for (const rule of this.rules) {
      const val = this._extract(metrics, rule.metric);
      if (val === null) continue;

      const breached = this._check(val, rule.op, rule.value);
      const state    = this._state[rule.id];

      if (breached) {
        if (!state.firstTriggeredAt) state.firstTriggeredAt = now;

        const elapsed = (now - state.firstTriggeredAt) / 1000; // seconds
        if (elapsed >= rule.for && !state.fired) {
          state.fired = true;
          this._fire(rule, val);
        }
      } else {
        // Condition cleared
        if (state.fired) {
          this._resolve(rule);
        }
        state.firstTriggeredAt = null;
        state.fired = false;
      }
    }
  }

  _fire(rule, currentValue) {
    console.warn(`[alerts] FIRING: ${rule.id} — ${rule.metric} ${rule.op} ${rule.value} (current: ${currentValue})`);
    this.conn.emit('agent:alert', {
      id:       rule.id,
      metric:   rule.metric,
      op:       rule.op,
      threshold: rule.value,
      current:  currentValue,
      severity: rule.severity || 'warning',
      status:   'active',
      firedAt:  Date.now(),
    });
  }

  _resolve(rule) {
    console.log(`[alerts] RESOLVED: ${rule.id}`);
    this.conn.emit('agent:alert:resolved', {
      id:         rule.id,
      resolvedAt: Date.now(),
    });
  }

  // Extract a value from the metrics payload by dot-path
  // Special case: "disk./" = disk entry with mount "/"
  // Special case: "process.nginx" = check if process named "nginx" is running
  _extract(metrics, path) {
    if (path.startsWith('disk.')) {
      const mount = path.slice(5); // e.g. "/"
      const entry = (metrics.disk || []).find(d => d.mount === mount);
      return entry?.usedPct ?? null;
    }
    if (path.startsWith('process.')) {
      const procName = path.slice(8);
      const found = (metrics.processes?.top || []).some(p => p.name.includes(procName));
      return found ? 1 : 0;
    }
    // Standard dot-path: "cpu.usage", "memory.usedPct"
    return path.split('.').reduce((obj, k) => obj?.[k] ?? null, metrics);
  }

  _check(val, op, threshold) {
    switch (op) {
      case 'gt': return val > threshold;
      case 'gte': return val >= threshold;
      case 'lt': return val < threshold;
      case 'lte': return val <= threshold;
      case 'eq': return val === threshold;
      case 'neq': return val !== threshold;
      default: return false;
    }
  }

  // Reload rules at runtime (Owner updated alert config)
  reloadRules(rules) {
    this.rules = rules;
    this._state = {};
    for (const r of rules) {
      this._state[r.id] = { firstTriggeredAt: null, fired: false };
    }
    console.log(`[alerts] Rules reloaded: ${rules.length} rule(s)`);
  }
}

module.exports = AlertEngine;
