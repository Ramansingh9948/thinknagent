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
  .description('Register this server with ThinkNCollab')
  .requiredOption('--server <url>', 'ThinkNCollab server URL (e.g. https://thinkncollab.com)')
  .requiredOption('--name <name>',  'Display name for this server on the DevOps Wall')
  .option('--room <roomId>', 'Room ID to connect to')
  .option('--gpu',                  'Enable GPU metrics (requires nvidia-smi)')
  .option('--logs <paths>',         'Comma-separated log file paths to stream')
  .action(async (opts) => {
    const existing = store.get('agentToken');
    if (existing) {
      console.log(chalk.yellow('Already registered. Run `thinknagent status` to check.'));
      console.log(chalk.gray('To re-register: thinknagent revoke && thinknagent init ...'));
      process.exit(0);
    }

    const agentId = uuid();
    const cfg = {
      agentId,
      serverUrl: opts.server.replace(/\/$/, ''),
      name:      opts.name,
      gpu:       !!opts.gpu,
      logs:      opts.logs ? opts.logs.split(',').map(s => s.trim()) : [],
      roomId:    opts.room,
      alerts:    [
        // sensible defaults — Owner can edit in browser
        { id: 'cpu-high',  metric: 'cpu.usage',      op: 'gt', value: 85, for: 60, severity: 'warning'  },
        { id: 'cpu-crit',  metric: 'cpu.usage',      op: 'gt', value: 95, for: 30, severity: 'critical' },
        { id: 'mem-high',  metric: 'memory.usedPct', op: 'gt', value: 85, for: 60, severity: 'warning'  },
        { id: 'disk-root', metric: 'disk./',         op: 'gt', value: 90, for: 0,  severity: 'critical' },
      ],
    };

    store.write(cfg);

    console.log(chalk.cyan('\n  thinknagent') + chalk.gray(` v${require('../package.json').version}`));
    console.log(chalk.gray('  ─────────────────────────────────────────'));
    console.log(`  Server  : ${chalk.white(cfg.serverUrl)}`);
    console.log(`  Name    : ${chalk.white(cfg.name)}`);
    console.log(`  Agent ID: ${chalk.white(agentId)}`);
    console.log(`  GPU     : ${cfg.gpu ? chalk.green('enabled') : chalk.gray('disabled')}`);
    console.log(`  Logs    : ${cfg.logs.length ? chalk.white(cfg.logs.join(', ')) : chalk.gray('none')}`);
    console.log(chalk.gray('  ─────────────────────────────────────────'));
    console.log(chalk.yellow('\n  Next step:'));
    console.log('  1. Run: ' + chalk.cyan('thinknagent start'));
    console.log('  2. An Owner of the target room must approve this agent in ThinkNCollab');
    console.log('  3. Once approved, agent becomes active automatically\n');
  });

// ── start ─────────────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the agent (connect to ThinkNCollab)')
  .option('--dev', 'Dev mode — verbose logging')
  .action((opts) => {
    if (opts.dev) process.env.THINKNAGENT_DEV = '1';

    const cfg = store.read();
    if (!cfg.serverUrl) {
      console.error(chalk.red('Not initialized. Run: thinknagent init --server <url> --name <name>'));
      process.exit(1);
    }

    console.log(chalk.cyan(`\n  Starting thinknagent — ${cfg.name || cfg.agentId}`));
    if (!cfg.agentToken) {
      console.log(chalk.yellow('  Status: PENDING — waiting for Owner approval\n'));
    }

    const agent = new Agent();
    agent.start();
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show current agent config and registration status')
  .action(() => {
    const cfg = store.read();
    if (!cfg.serverUrl) {
      console.log(chalk.gray('Not initialized.'));
      return;
    }

    console.log(chalk.cyan('\n  thinknagent status'));
    console.log(chalk.gray('  ────────────────────────────────'));
    console.log(`  Name    : ${chalk.white(cfg.name || '—')}`);
    console.log(`  Server  : ${chalk.white(cfg.serverUrl || '—')}`);
    console.log(`  Agent ID: ${chalk.white(cfg.agentId || '—')}`);
    console.log(`  Role    : ${chalk.white(cfg.role || '—')}`);
    console.log(`  Room    : ${chalk.white(cfg.roomId || '—')}`);
    console.log(`  Status  : ${cfg.agentToken ? chalk.green('APPROVED') : chalk.yellow('PENDING')}`);
    console.log(`  GPU     : ${cfg.gpu ? chalk.green('enabled') : chalk.gray('disabled')}`);
    console.log(`  Logs    : ${(cfg.logs||[]).length ? cfg.logs.join(', ') : chalk.gray('none')}`);
    console.log(`  Alerts  : ${(cfg.alerts||[]).length} rule(s)`);
    console.log(chalk.gray('  ────────────────────────────────\n'));
  });

// ── revoke ────────────────────────────────────────────────────────────────────
program
  .command('revoke')
  .description('Remove all credentials from this server')
  .action(() => {
    store.clear();
    console.log(chalk.yellow('  Credentials cleared. Run `thinknagent init` to re-register.'));
  });

program.parse(process.argv);
