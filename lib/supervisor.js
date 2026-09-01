'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.thinknagent');
const LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');
const BIN_PATH = path.resolve(__dirname, '../bin/thinknagent.js');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {}
}

log('[supervisor] Started ThinkNCollab Daemon Supervisor with Auto-Restart');

let restarting = false;

function runAgent() {
  log('[supervisor] Spawning thinknagent process: ' + BIN_PATH);

  const agentProc = spawn(process.execPath, [BIN_PATH, 'start'], {
    stdio: ['ignore', 'inherit', 'inherit']
  });

  agentProc.on('exit', (code, signal) => {
    log(`[supervisor] Agent process exited (code: ${code}, signal: ${signal}). Auto-restarting in 3s...`);
    if (!restarting) {
      setTimeout(runAgent, 3000);
    }
  });

  agentProc.on('error', (err) => {
    log(`[supervisor] Agent process error: ${err.message}. Retrying in 5s...`);
    if (!restarting) {
      setTimeout(runAgent, 5000);
    }
  });
}

process.on('SIGTERM', () => {
  restarting = true;
  log('[supervisor] Received SIGTERM. Shutting down supervisor cleanly.');
  process.exit(0);
});

process.on('SIGINT', () => {
  restarting = true;
  log('[supervisor] Received SIGINT. Shutting down supervisor cleanly.');
  process.exit(0);
});

runAgent();
