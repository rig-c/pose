import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

describe('the gates read this tree only, not a worktree nested in it', () => {
  const root = join(import.meta.dir, '..');
  test('eslint skips .claude/ (a nested worktree with an `any` in it), and a control outside it is caught', () => {
    const nested = join(root, '.claude', 'worktrees', 'gate-plant');
    const control = join(root, 'gate-plant-control');
    const bad = 'export const x: any = 1;\n';
    try {
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'bad.ts'), bad);
      const nestedRun = spawnSync('bunx', ['eslint', '.'], { cwd: root, encoding: 'utf8' });
      expect(nestedRun.status).toBe(0);
      mkdirSync(control, { recursive: true });
      writeFileSync(join(control, 'bad.ts'), bad);
      const controlRun = spawnSync('bunx', ['eslint', '.'], { cwd: root, encoding: 'utf8' });
      expect(controlRun.status).toBe(1);
      expect(controlRun.stdout).toContain('no-explicit-any');
    } finally {
      rmSync(nested, { recursive: true, force: true });
      rmSync(control, { recursive: true, force: true });
    }
  }, 60_000);

  test('`bun run test` and prepublishOnly run the tests under ./test only', () => {
    expect(pkg.scripts.test).toBe('bun test ./test');
    expect(pkg.scripts.prepublishOnly).toContain('bun run test');
    expect(pkg.scripts.prepublishOnly).not.toMatch(/bun test(?! \.\/test)/);
  });
});
