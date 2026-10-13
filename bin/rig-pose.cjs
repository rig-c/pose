#!/usr/bin/env node
'use strict';

/**
 * rig-pose's `bin` entry has one job: hand off to Bun.
 *
 * npm's `bin` field has to be something any installed Node can run, but
 * rig-pose is a Bun program (it runs its TypeScript sources directly, and so
 * does rig-c underneath it). If `bun` is on PATH, run the real CLI (cli.ts,
 * next to this file's directory) under it — argv, stdio, the exit code and
 * signals pass straight through. If it is not, say so once and stop.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'cli.ts');
const result = spawnSync('bun', [cli, ...process.argv.slice(2)], { stdio: 'inherit' });

if (result.error) {
  if (result.error.code === 'ENOENT') {
    process.stderr.write('rig-pose runs on Bun, which was not found on PATH — install it from https://bun.sh\n');
  } else {
    process.stderr.write(`rig-pose: could not launch bun: ${result.error.message}\n`);
  }
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(typeof result.status === 'number' ? result.status : 1);
}
