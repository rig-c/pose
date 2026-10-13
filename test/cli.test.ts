import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const bin = join(import.meta.dir, '..', 'bin', 'rig-pose.cjs');
const run = (...args: string[]) => spawnSync('node', [bin, ...args], { encoding: 'utf8' });

describe('the bin shim hands off to the CLI', () => {
  test('--version prints the package version', () => {
    const r = run('--version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });
  test('--help names the retarget command', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('rig-pose retarget --rig');
  });
  test('an unknown command is refused by name with exit 2', () => {
    const r = run('dance');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown command "dance"');
  });
});
