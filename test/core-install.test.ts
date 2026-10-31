/** #467: one canonical core, one launcher, including nested and wrong-bin defects.
 *  #484: @rig-c/core 3.0.0 named exports only — no deep @rig-c/core/… file path remains. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

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
    put(core, { name: '@rig-c/core', version: '3.0.0', exports: { './package.json': './package.json', './bin/rigc': './rigc.cjs' }, bin: { rigc: './rigc.cjs' } });
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

test('canonical core shared by consumer, pose and rigc is green, including a later 3.x core installed beside pose', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  expect(pkg.dependencies['@rig-c/core']).toBe('^3.0.0');
  const r = fixture();
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain('CORE_GRAPH ok:');
  expect(r.out).toContain('node_modules/@rig-c/core/rigc.cjs');

  const tmp = mkdtempSync(join(tmpdir(), 'pose-core-3x-'));
  try {
    const makeTgz = (name: string, manifest: object, files: Record<string, string> = {}): string => {
      const dir = join(tmp, name, 'package');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
      const tgz = join(tmp, `${name}.tgz`);
      expect(spawnSync('tar', ['-czf', tgz, '-C', join(tmp, name), 'package']).status).toBe(0);
      return tgz;
    };
    const core301 = makeTgz(
      'core-301',
      { name: '@rig-c/core', version: '3.0.1', exports: { './package.json': './package.json', './bin/rigc': './rigc.cjs' }, bin: { rigc: './rigc.cjs' } },
      { 'rigc.cjs': '#!/usr/bin/env node\n' },
    );
    const installAndCheck = (coreRange: string): { installStatus: number | null; checkStatus: number | null; out: string } => {
      const poseTgz = makeTgz(`pose-${coreRange.replace(/[^a-z0-9]/gi, '_')}`, {
        name: '@rig-c/pose',
        version: '1.6.0',
        exports: { './package.json': './package.json' },
        dependencies: { '@rig-c/core': coreRange },
      });
      const consumer = mkdtempSync(join(tmp, 'consumer-'));
      const cache = join(consumer, '.npm-cache');
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0' }));
      const inst = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund', '--cache', cache, poseTgz, core301], { cwd: consumer, encoding: 'utf8' });
      if (inst.status !== 0) return { installStatus: inst.status, checkStatus: null, out: `${inst.stdout}${inst.stderr}` };
      const chk = spawnSync('node', [CHECK, consumer], { encoding: 'utf8' });
      return { installStatus: 0, checkStatus: chk.status, out: `${chk.stdout}${chk.stderr}` };
    };

    // Control: package.json's ^3.0.0 range shares the consumer's 3.0.1 core and passes check_core.
    const shared = installAndCheck(pkg.dependencies['@rig-c/core']!);
    expect(shared.installStatus, shared.out).toBe(0);
    expect(shared.checkStatus, shared.out).toBe(0);
    expect(shared.out).toContain('CORE_GRAPH ok:');
    expect(shared.out).toContain('"version":"3.0.1"');

    // Planted exact pin ("3.0.0"): cannot share 3.0.1 (fails offline deduplication, and if nested fails CORE_GRAPH).
    const exact = installAndCheck('3.0.0');
    expect(exact.installStatus).not.toBe(0);
    const nestedPatch = fixture(root => {
      const top = join(root, 'node_modules/@rig-c/core/package.json');
      const m = JSON.parse(readFileSync(top, 'utf8')) as Record<string, unknown>;
      writeFileSync(top, JSON.stringify({ ...m, version: '3.0.1' }));
      const nested = join(root, 'node_modules/@rig-c/pose/node_modules/@rig-c/core');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'rigc.cjs'), '');
      writeFileSync(join(nested, 'package.json'), JSON.stringify({ ...m, version: '3.0.0' }));
    });
    expect(nestedPatch.status, nestedPatch.out).toBe(1);
    expect(nestedPatch.out).toContain('CORE_GRAPH:');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: kind === 'legacy' ? 'rig-c' : kind === 'nested-canonical' ? '@rig-c/core' : 'other', version: '3.0.0', bin: { rigc: './rigc.cjs' } }));
      }
    });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('CORE_GRAPH:');
    expect(r.out).not.toContain('CORE_GRAPH ok:');
  });
}

function coreExportsOf(): Set<string> {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'node_modules/@rig-c/core/package.json'), 'utf8')) as {
    version: string;
    exports: Record<string, string>;
  };
  expect(manifest.version.startsWith('3.')).toBe(true);
  expect(manifest.exports['./*.ts']).toBeUndefined();
  expect(manifest.exports['./model']).toBe('./src/model.ts');
  return new Set(Object.keys(manifest.exports));
}

function auditCoreSpecifiers(sources: ReadonlyArray<{ file: string; text: string }>, exported: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|resolve\s*\(\s*)['"](@rig-c\/core\/[^'"]+)['"]/g;
  const deepRe = /@rig-c\/core\/(?:(?:src|tools)\/[^'"`\s)]+|[^'"`\s)]+\.(?:ts|js|cjs|mjs))\b/g;
  for (const { file, text } of sources) {
    for (const m of text.matchAll(deepRe)) {
      problems.push(`CORE_DEEP_PATH: ${file} — deep file path "${m[0]}" is refused; use a named export from @rig-c/core/package.json`);
    }
    for (const m of text.matchAll(importRe)) {
      const spec = m[1]!;
      const sub = `./${spec.slice('@rig-c/core/'.length)}`;
      if (!exported.has(sub)) {
        problems.push(`CORE_UNEXPORTED: ${file} — "${spec}" (${sub}) is not in @rig-c/core/package.json exports`);
      }
    }
  }
  return problems;
}

function repoTypeScriptSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [{ file: 'cli.ts', text: readFileSync(join(ROOT, 'cli.ts'), 'utf8') }];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && full !== import.meta.path) {
        out.push({ file: relative(ROOT, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const d of ['src', 'test', 'scripts', 'tools', 'examples']) walk(join(ROOT, d));
  return out;
}

test('#484 control & planted imports: no deep @rig-c/core/… file path remains, and planted deep/unexported imports fail by name and at module resolution', () => {
  const exported = coreExportsOf();
  const sources = repoTypeScriptSources();
  expect(sources.length).toBeGreaterThan(50);
  expect(auditCoreSpecifiers(sources, exported)).toEqual([]);

  const scope = '@rig-c/core';
  const planted = [
    { file: 'test/walk-height.test.ts', text: `import { modelDocument } from '${scope}/src/model.ts';`, code: 'CORE_DEEP_PATH', target: `${scope}/src/model.ts` },
    { file: 'src/pelvis.ts', text: `import { readPlate } from '${scope}/tools/plate.ts';`, code: 'CORE_DEEP_PATH', target: `${scope}/tools/plate.ts` },
    { file: 'src/rigc.ts', text: `import.meta.resolve('${scope}/cli.ts');`, code: 'CORE_DEEP_PATH', target: `${scope}/cli.ts` },
    { file: 'src/retarget.ts', text: `import { nope } from '${scope}/unexported';`, code: 'CORE_UNEXPORTED', target: `${scope}/unexported` },
  ];
  for (const p of planted) {
    const res = auditCoreSpecifiers([...sources, { file: p.file, text: p.text }], exported);
    expect(res.some(line => line.startsWith(`${p.code}: ${p.file}`) && line.includes(p.target)), res.join('\n')).toBe(true);
  }

  // Runtime module-resolution control: @rig-c/core@3.0.0 itself refuses the removed deep path when imported.
  const probe = spawnSync(process.execPath, ['-e', `await import('${scope}/src/model.ts')`], { cwd: ROOT, encoding: 'utf8' });
  expect(probe.status).not.toBe(0);
});
