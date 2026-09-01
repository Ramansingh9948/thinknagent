#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const chalk       = require('chalk');
const ora         = require('ora');
const { v4: uuid} = require('uuid');
const store       = require('../lib/store');
const Agent       = require('../lib/agent');

const program = new Command();

program
  .name('thinknagent')
  .description('ThinkNCollab server agent')
  .version(require('../package.json').version);

// ── init ─────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Register this server with ThinkNCollab DevOps Wall')
  .option('--room <roomId>',       'Room ID to connect to (required)')
  .option('--server <url>',        'ThinkNCollab server URL', 'https://thinkncollab.com')
  .option('--name <name>',         'Display name for this server (default: hostname)')
  .option('--gpu',                 'Enable GPU metrics (requires nvidia-smi)')
  .option('--interval <ms>',       'Metrics polling interval in ms (default: 1000)', '1000')
  .option('--logs <paths>',        'Comma-separated log file paths to stream')
  .option('--app-path <path>',     'Path to the deployed application folder (to track version)')
  .option('-f, --force',           'Force overwrite existing registration')
  .option('-d, --daemon',          'Start background auto-restart daemon immediately after init')
  .action(async (opts) => {
    if (!opts.room) {
      console.error(chalk.red('\n  Error: --room <roomId> is required.'));
      console.log(chalk.gray('  Usage: thinknagent init --room <roomId> [--name <name>] [--server <url>]\n'));
      process.exit(1);
    }

    const os = require('os');
    const existing = store.read();
    if (existing.agentToken && !opts.force) {
      console.log(chalk.yellow('\n  Already registered for: ' + (existing.name || existing.agentId)));
      console.log(chalk.gray('  To overwrite config, pass: --force (e.g. thinknagent init --room <roomId> --force)'));
      console.log(chalk.gray('  Or check status: thinknagent status\n'));
      return;
    }

    const agentId = existing.agentId || uuid();
    const serverUrl = (opts.server || 'https://thinkncollab.com').replace(/\/$/, '');
    const nodeName = opts.name || os.hostname();
    const intervalMs = opts.interval ? parseInt(opts.interval, 10) : (existing.interval || 1000);

    const cfg = {
      ...existing,
      agentId,
      serverUrl,
      name:      nodeName,
      interval:  intervalMs,
      gpu:       opts.gpu !== undefined ? !!opts.gpu : (existing.gpu || false),
      logs:      opts.logs ? opts.logs.split(',').map(s => s.trim()) : (existing.logs || []),
      roomId:    opts.room,
      appPath:   opts.appPath || existing.appPath || null,
      alerts:    existing.alerts || [
        { id: 'cpu-high',  metric: 'cpu.usage',      op: 'gt', value: 85, for: 60, severity: 'warning'  },
        { id: 'cpu-crit',  metric: 'cpu.usage',      op: 'gt', value: 95, for: 30, severity: 'critical' },
        { id: 'mem-high',  metric: 'memory.usedPct', op: 'gt', value: 85, for: 60, severity: 'warning'  },
        { id: 'disk-root', metric: 'disk./',         op: 'gt', value: 90, for: 0,  severity: 'critical' },
      ],
    };

    if (opts.force) {
      delete cfg.agentToken;
      delete cfg.role;
    }

    store.write(cfg);

    console.log(chalk.cyan('\n  thinknagent') + chalk.gray(` v${require('../package.json').version}`));
    console.log(chalk.gray('  ─────────────────────────────────────────'));
    console.log(`  Server  : ${chalk.white(cfg.serverUrl)}`);
    console.log(`  Name    : ${chalk.white(cfg.name)}`);
    console.log(`  Room ID : ${chalk.white(cfg.roomId)}`);
    console.log(`  Agent ID: ${chalk.white(agentId)}`);
    console.log(`  GPU     : ${cfg.gpu ? chalk.green('enabled') : chalk.gray('disabled')}`);
    console.log(`  Logs    : ${cfg.logs.length ? chalk.white(cfg.logs.join(', ')) : chalk.gray('none')}`);
    console.log(`  App Path: ${cfg.appPath ? chalk.white(cfg.appPath) : chalk.gray('none')}`);
    console.log(chalk.gray('  ─────────────────────────────────────────'));
    console.log(chalk.green('  ✔ Configuration saved successfully!\n'));

    if (opts.daemon) {
      const DaemonManager = require('../lib/daemon');
      new DaemonManager().startSupervisor();
    } else {
      console.log(chalk.yellow('  Next steps:'));
      console.log('  • Start background auto-restart daemon : ' + chalk.cyan('thinknagent daemon start'));
      console.log('  • Or run directly in terminal          : ' + chalk.cyan('thinknagent start\n'));
    }
  });

// ── start ─────────────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the agent (connect to ThinkNCollab)')
  .option('--dev',           'Dev mode — verbose logging')
  .option('--interval <ms>', 'Metrics polling interval in ms (default: 1000)')
  .action((opts) => {
    if (opts.dev) process.env.THINKNAGENT_DEV = '1';

    const cfg = store.read();
    if (!cfg.serverUrl || !cfg.roomId) {
      console.error(chalk.red('\n  Not initialized. Run: thinknagent init --room <roomId>'));
      process.exit(1);
    }

    if (opts.interval) {
      cfg.interval = parseInt(opts.interval, 10);
      store.write(cfg);
    }

    console.log(chalk.cyan(`\n  Starting thinknagent — ${cfg.name || cfg.agentId}`));
    if (!cfg.agentToken) {
      console.log(chalk.yellow('  Status: PENDING — waiting for Owner approval in DevOps Wall\n'));
    }

    const agent = new Agent();
    agent.start();
  });

// ── stop ──────────────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Stop running thinknagent background daemon')
  .action(() => {
    const DaemonManager = require('../lib/daemon');
    new DaemonManager().stopSupervisor();
  });

// ── restart ───────────────────────────────────────────────────────────────────
program
  .command('restart')
  .description('Restart the background daemon')
  .action(() => {
    const DaemonManager = require('../lib/daemon');
    const daemon = new DaemonManager();
    daemon.stopSupervisor();
    setTimeout(() => daemon.startSupervisor(), 1000);
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show current agent config, approval, and daemon status')
  .action(() => {
    const os = require('os');
    const cfg = store.read();
    const DaemonManager = require('../lib/daemon');
    const daemon = new DaemonManager();
    const isRunning = daemon.isRunning();

    if (!cfg.serverUrl && !cfg.roomId) {
      console.log(chalk.gray('\n  thinknagent is not configured yet.'));
      console.log(chalk.cyan('  Run: thinknagent init --room <roomId>\n'));
      return;
    }

    console.log(chalk.cyan('\n  thinknagent status') + chalk.gray(` v${require('../package.json').version}`));
    console.log(chalk.gray('  ─────────────────────────────────────────────'));
    console.log(`  Name       : ${chalk.white(cfg.name || os.hostname())}`);
    console.log(`  Server     : ${chalk.white(cfg.serverUrl || 'https://thinkncollab.com')}`);
    console.log(`  Room ID    : ${chalk.white(cfg.roomId || '—')}`);
    console.log(`  Agent ID   : ${chalk.white(cfg.agentId || '—')}`);
    console.log(`  Role       : ${chalk.white(cfg.role || 'monitor')}`);
    console.log(`  Auth State : ${cfg.agentToken ? chalk.green('APPROVED (Active)') : chalk.yellow('PENDING (Waiting for Owner approval)')}`);
    console.log(`  Daemon     : ${isRunning ? chalk.green(`RUNNING (PID ${daemon.getPid()})`) : chalk.gray('STOPPED')}`);
    console.log(`  GPU        : ${cfg.gpu ? chalk.green('enabled') : chalk.gray('disabled')}`);
    console.log(`  Logs       : ${(cfg.logs||[]).length ? cfg.logs.join(', ') : chalk.gray('none')}`);
    console.log(`  App Path   : ${cfg.appPath ? chalk.white(cfg.appPath) : chalk.gray('none')}`);
    console.log(chalk.gray('  ─────────────────────────────────────────────\n'));
  });

// ── logs ──────────────────────────────────────────────────────────────────────
program
  .command('logs')
  .description('View recent daemon logs')
  .option('-n, --lines <count>', 'Number of lines to view', '50')
  .action((opts) => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(os.homedir(), '.thinknagent', 'daemon.log');
    if (!fs.existsSync(logFile)) {
      console.log(chalk.gray('No daemon logs found at: ' + logFile));
      return;
    }
    const lines = parseInt(opts.lines, 10) || 50;
    const content = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    console.log(chalk.cyan(`\n  --- thinknagent daemon logs (last ${lines} lines) ---`));
    console.log(content.slice(-lines).join('\n'));
    console.log(chalk.cyan(`  --- end of logs ---\n`));
  });

// ── revoke ────────────────────────────────────────────────────────────────────
program
  .command('revoke')
  .description('Remove all credentials from this server')
  .action(() => {
    const DaemonManager = require('../lib/daemon');
    new DaemonManager().stopSupervisor();
    store.clear();
    console.log(chalk.yellow('\n  Credentials cleared from ~/.thinknagent/'));
    console.log(chalk.gray('  To re-register: thinknagent init --room <roomId>\n'));
  });

// ── daemon (Background Auto-Restart Service) ──────────────────────────────────
const daemonCmd = program
  .command('daemon')
  .description('Manage the background auto-restarting daemon');

daemonCmd
  .command('start')
  .description('Start the background daemon with auto-restart supervisor')
  .action(() => {
    const DaemonManager = require('../lib/daemon');
    new DaemonManager().startSupervisor();
  });

daemonCmd
  .command('stop')
  .description('Stop the background daemon supervisor')
  .action(() => {
    const DaemonManager = require('../lib/daemon');
    new DaemonManager().stopSupervisor();
  });

daemonCmd
  .command('restart')
  .description('Restart the background daemon')
  .action(() => {
    const DaemonManager = require('../lib/daemon');
    const daemon = new DaemonManager();
    daemon.stopSupervisor();
    setTimeout(() => daemon.startSupervisor(), 1000);
  });

daemonCmd
  .command('status')
  .description('Check daemon process status')
  .action(() => {
    const DaemonManager = require('../lib/daemon');
    new DaemonManager().getStatus();
  });

daemonCmd
  .command('install')
  .description('Install as OS background service (Systemd on Linux, Launchd on macOS)')
  .action(() => {
    const DaemonManager = require('../lib/daemon');
    new DaemonManager().installService();
  });

// ── mcp (Model Context Protocol Stdio Server for LLMs & PMs) ──────────────────
program
  .command('mcp')
  .description('Start Model Context Protocol (MCP) server for Claude Desktop, Cursor & ChatGPT')
  .option('--board <boardId>', 'Board ID to manage')
  .option('--token <token>',   'ThinkNCollab API Token')
  .option('--server <url>',    'ThinkNCollab API Server URL')
  .action((opts) => {
    if (opts.board)  process.env.THINKNCOLLAB_BOARD_ID = opts.board;
    if (opts.token)  process.env.THINKNCOLLAB_TOKEN    = opts.token;
    if (opts.server) process.env.THINKNCOLLAB_API_URL  = opts.server;
    require('./thinkncollab-mcp');
  });

// Default banner if no arguments
if (process.argv.length <= 2) {
  const os = require('os');
  const cfg = store.read();
  const v = require('../package.json').version;
  console.log(chalk.cyan(`\n  ╔═══════════════════════════════════════════════════╗`));
  console.log(chalk.cyan(`  ║         ThinkNCollab Server Agent v${v}        ║`));
  console.log(chalk.cyan(`  ╚═══════════════════════════════════════════════════╝`));
  console.log(chalk.gray(`  Zero-config server telemetry, terminal & DevOps sync\n`));

  if (cfg.roomId) {
    console.log(`  Configured Room : ${chalk.green(cfg.roomId)} (${cfg.name || os.hostname()})`);
    console.log(`  Quick Commands  :`);
    console.log(`    • ${chalk.cyan('thinknagent daemon start')}  (Run in background with auto-restart)`);
    console.log(`    • ${chalk.cyan('thinknagent status')}        (Check live approval & status)`);
    console.log(`    • ${chalk.cyan('thinknagent logs')}          (View recent logs)\n`);
  } else {
    console.log(`  Get Started:`);
    console.log(`    • ${chalk.cyan('thinknagent init --room <roomId>')}   (Register this server)\n`);
  }
}

program.parse(process.argv);
