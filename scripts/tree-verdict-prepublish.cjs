const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const declaration = path.join(__dirname, 'tree-verdict.json');
const d = JSON.parse(fs.readFileSync(declaration, 'utf8'));
if (typeof d.chain !== 'string' || !d.chain.trim()) process.exit(1);
const helper = process.env.TREE_VERDICT_TOOLS && path.join(process.env.TREE_VERDICT_TOOLS, 'lifecycle.mjs');
let result;
if (helper && fs.existsSync(helper)) {
  result = spawnSync('node', [helper, '--declaration', declaration], { stdio: 'inherit' });
} else {
  console.log('tree-verdict helper absent: executing original full chain');
  const windows = process.platform === 'win32';
  result = spawnSync(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    windows ? ['/d', '/s', '/c', d.chain] : ['-c', d.chain], { stdio: 'inherit' });
}
process.exit(Number.isInteger(result.status) ? result.status : 1);
