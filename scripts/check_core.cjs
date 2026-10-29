#!/usr/bin/env node
'use strict';

// Inspect the installed graph, including nested copies and every rigc provider.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function checkCore(root, poseName = '@rig-c/pose') {
  root = fs.realpathSync(path.resolve(root));
  const cores = [];
  const providers = [];
  const visited = new Set();
  function modules(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const at = path.join(dir, name);
      if (name.startsWith('@')) {
        for (const child of fs.readdirSync(at).sort()) inspect(path.join(at, child));
      } else inspect(at);
    }
  }
  function inspect(at) {
    const manifest = path.join(at, 'package.json');
    if (!fs.existsSync(manifest)) return;
    const real = fs.realpathSync(at);
    if (visited.has(real)) return;
    visited.add(real);
    const p = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const row = { name: p.name, version: p.version, path: path.relative(root, at) };
    if (p.name === '@rig-c/core' || p.name === 'rig-c') cores.push(row);
    const bin = typeof p.bin === 'string' ? (p.name === 'rigc' ? p.bin : undefined) : p.bin?.rigc;
    if (bin !== undefined) providers.push({ ...row, bin: fs.realpathSync(path.join(at, bin)) });
    modules(path.join(at, 'node_modules'));
  }
  modules(path.join(root, 'node_modules'));
  if (cores.length !== 1 || cores[0].name !== '@rig-c/core' || providers.length !== 1 || providers[0].name !== '@rig-c/core') {
    throw new Error(`CORE_GRAPH: required one @rig-c/core and one rigc provider; found cores ${JSON.stringify(cores)}, providers ${JSON.stringify(providers)}`);
  }
  const consumer = createRequire(path.join(root, 'package.json'));
  const pose = createRequire(consumer.resolve(`${poseName}/package.json`));
  const shared = fs.realpathSync(consumer.resolve('@rig-c/core/package.json'));
  const fromPose = fs.realpathSync(pose.resolve('@rig-c/core/package.json'));
  const bin = fs.realpathSync(path.join(root, 'node_modules/.bin/rigc'));
  if (shared !== fromPose || bin !== providers[0].bin || fs.realpathSync(pose.resolve('@rig-c/core/bin/rigc')) !== bin) {
    throw new Error(`CORE_GRAPH: consumer, ${poseName} and rigc must resolve the same core; consumer ${shared}, pose ${fromPose}, bin ${bin}`);
  }
  return { cores, providers: providers.map(({ bin: _bin, ...row }) => row), pose: poseName, bin: path.relative(root, bin) };
}

module.exports = { checkCore };
if (require.main === module) {
  try {
    console.log(`CORE_GRAPH ok: ${JSON.stringify(checkCore(process.argv[2] || process.cwd(), process.argv[3]))}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
