/** #467: one canonical core, one launcher, including nested and wrong-bin defects. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CHECK = join(ROOT, 'scripts/check_core.cjs');
function fixture(edit?: (root: string) => void): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'pose-core-graph-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    const put = (dir: string, manifest: object): void => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    };
    const core = join(root, 'node_modules/@rig-c/core');
    put(core, { name: '@rig-c/core', version: '2.80.0', exports: { './package.json': './package.json', './bin/rigc': './rigc.cjs' }, bin: { rigc: './rigc.cjs' } });
    writeFileSync(join(core, 'rigc.cjs'), '');
    put(join(root, 'node_modules/@rig-c/pose'), { name: '@rig-c/pose', exports: { './package.json': './package.json' } });
    mkdirSync(join(root, 'node_modules/.bin'));
    symlinkSync('../@rig-c/core/rigc.cjs', join(root, 'node_modules/.bin/rigc'));
    edit?.(root);
    const r = spawnSync('node', [CHECK, root], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('canonical core shared by consumer, pose and rigc is green', () => {
  const r = fixture();
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain('CORE_GRAPH ok:');
  expect(r.out).toContain('node_modules/@rig-c/core/rigc.cjs');
});

for (const kind of ['legacy', 'nested-canonical', 'other-provider', 'wrong-bin', 'missing-core'] as const) {
  test(`planted ${kind} cannot pass the installed graph check`, () => {
    const r = fixture(root => {
      const modules = join(root, 'node_modules');
      if (kind === 'wrong-bin') {
        writeFileSync(join(modules, '.bin/other.cjs'), '');
        rmSync(join(modules, '.bin/rigc'));
        symlinkSync('other.cjs', join(modules, '.bin/rigc'));
      } else if (kind === 'missing-core') rmSync(join(modules, '@rig-c/core'), { recursive: true });
      else {
        const dir = kind === 'nested-canonical' ? join(modules, '@rig-c/pose/node_modules/@rig-c/core') : join(modules, kind === 'legacy' ? 'rig-c' : 'other');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'rigc.cjs'), '');
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: kind === 'legacy' ? 'rig-c' : kind === 'nested-canonical' ? '@rig-c/core' : 'other', version: '2.80.0', bin: { rigc: './rigc.cjs' } }));
      }
    });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('CORE_GRAPH:');
    expect(r.out).not.toContain('CORE_GRAPH ok:');
  });
}
