'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_DIR  = path.join(os.homedir(), '.thinknagent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOG_FILE    = path.join(CONFIG_DIR, 'agent.log');

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); // owner-only
  }
}

function read() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(data) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 }); // owner read/write only
}

function get(key) {
  return read()[key];
}

function set(key, value) {
  const cfg = read();
  cfg[key] = value;
  write(cfg);
}

function clear() {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
}

module.exports = { CONFIG_DIR, CONFIG_FILE, LOG_FILE, read, write, get, set, clear };
