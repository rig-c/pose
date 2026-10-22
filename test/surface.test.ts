/** #376: execution coverage complements, and does not replace, promise.test.ts. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditHelp, auditReport, helpCommands, helpFlags, releasing, reportFields, runHelp, surfaceRows } from './surface.ts';

const ROOT = join(import.meta.dir, '..');
const TEXT = releasing();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function privateCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rig-pose-surface-mutant-'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'examples'), join(dir, 'examples'), { recursive: true });
  for (const name of ['cli.ts', 'package.json', 'RELEASING.md']) cpSync(join(ROOT, name), join(dir, name));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  mkdirSync(join(dir, 'test'));
  // Keep the gate's helper imports and public fixture dependencies together as it grows.
  for (const name of readdirSync(join(ROOT, 'test')).filter((name) => name.endsWith('.ts'))) cpSync(join(ROOT, 'test', name), join(dir, 'test', name));
  return dir;
}

test('runtime surface: root and every command --help classify every printed flag', () => {
  const root = runHelp([]);
  const commands = helpCommands(root);
  for (const command of ['pelvis', 'clean', 'retarget', 'convert', 'compare']) expect(commands).toContain(command);
  expect(auditHelp(root, TEXT)).toEqual([]);
  for (const command of commands) {
    const help = runHelp([command]);
    expect(auditHelp(help, TEXT)).toEqual([]);
    const flags = helpFlags(help).filter((flag) => flag.startsWith(`${command} `));
    expect(flags.length).toBeGreaterThan(0);
    console.log(`SURFACE_HELP ${command}: ${flags.length} flags: ${flags.join(', ')}`);
  }
  console.log(`SURFACE_HELP rig-pose: ${helpFlags(root).filter((flag) => flag.startsWith('rig-pose ')).join(', ')}`);
});

test('runtime mutant: a help-only unlisted flag is refused by its command and name', () => {
  // Copy only the CLI's inputs to a disposable private directory.
  // Source mutations in controls never touch the checkout; restore the copy before removing it.
  const dir = privateCopy();
  const source = readFileSync(join(ROOT, 'cli.ts'), 'utf8');
  const before = hash(source);
  try {
    const control = () => spawnSync(process.execPath, ['test', 'test/surface.test.ts', '--test-name-pattern', '^runtime surface:'], { cwd: dir, encoding: 'utf8' });
    writeFileSync(join(dir, 'cli.ts'), source);
    const green = control();
    expect(green.status, green.stdout + green.stderr).toBe(0);
    const mutant = source.replace('\nretarget\n', '\nretarget\n  --unlisted-surface <n>  planted only in help, not in parseFlags\n');
    expect(mutant).not.toBe(source);
    writeFileSync(join(dir, 'cli.ts'), mutant);
    const help = runHelp(['retarget'], join(dir, 'cli.ts'));
    const problems = auditHelp(help, TEXT);
    expect(problems).toEqual(['SURFACE_UNLISTED_FLAG: retarget --unlisted-surface: 0 classification row(s) in RELEASING.md; expected exactly 1 promised or courtesy']);
    console.log(problems.join('\n'));
    const red = control();
    expect(red.status).toBe(1);
    expect(red.stdout + red.stderr).toContain('SURFACE_UNLISTED_FLAG: retarget --unlisted-surface');
    console.log('SURFACE_MUTANT flag: control exit 0; planted help-only flag exit 1; named retarget --unlisted-surface');
    writeFileSync(join(dir, 'cli.ts'), source);
    expect(hash(readFileSync(join(dir, 'cli.ts'), 'utf8'))).toBe(before);
    const restored = control();
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    console.log(`SURFACE_MUTANT restored cli.ts sha256 ${before}; control exit 0`);
  } finally {
    expect(hash(readFileSync(join(ROOT, 'cli.ts'), 'utf8'))).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('runtime mutant: a nested field in emitted regression reports makes their control red', () => {
  const dir = privateCopy();
  const sourcePath = join(ROOT, 'src', 'run.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const before = hash(source);
  const copied = join(dir, 'src', 'run.ts');
  // No Git history is present in the private copy. The regular #208 run still
  // owns base/head comparisons; this subprocess exercises only emitted fields.
  const control = () => spawnSync(process.execPath, ['test', 'test/gate.test.ts', '--test-name-pattern', 'Bar 1 & Bar 3'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GATE_BASE_CLI: '', GATE_BASE_SHA: '', GATE_HEAD_SHA: '', GATE_PR_BODY: '' },
  });
  try {
    const green = control();
    expect(green.status, green.stdout + green.stderr).toBe(0);
    const mutant = source.replace('        options,\n', '        options: { ...options, unlistedSurface: null },\n');
    expect(mutant).not.toBe(source);
    writeFileSync(copied, mutant);
    const red = control();
    expect(red.status).toBe(1);
    expect(red.stdout + red.stderr).toContain('SURFACE_UNLISTED_FIELD: options.unlistedSurface: 0 classification row(s)');
    expect(red.stdout + red.stderr).toContain('(dancer)');
    expect(red.stdout + red.stderr).toContain('(second)');
    expect(red.stdout + red.stderr).toContain('(run)');
    console.log('SURFACE_MUTANT report: control exit 0; planted nested field exit 1; named options.unlistedSurface (dancer, second, run)');
    writeFileSync(copied, source);
    expect(hash(readFileSync(copied, 'utf8'))).toBe(before);
    const restored = control();
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    console.log(`SURFACE_MUTANT restored src/run.ts sha256 ${before}; control exit 0`);
  } finally {
    expect(hash(readFileSync(sourcePath, 'utf8'))).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('runtime help reader covers paired declarations and Usage, not flags cited in descriptions', () => {
  const help = 'Usage:\n  rig-pose compare --usage-only <file>\ncompare\n  --reference-hands <f> --render-hands <f>  both inputs\n                        see --not-a-declaration\n';
  expect(helpFlags(help)).toEqual(['compare --reference-hands', 'compare --render-hands', 'compare --usage-only']);
  expect(auditHelp(help, TEXT)).toEqual(['SURFACE_UNLISTED_FLAG: compare --usage-only: 0 classification row(s) in RELEASING.md; expected exactly 1 promised or courtesy']);
});

test('runtime field reader visits every array row and null/container fields, but not array indices', () => {
  const report = { frames: 2, feet: { supports: [{ side: 'r' }, { side: 'l', unlistedSurface: 1 }], jumps: [[0, 1]] }, render: null };
  expect(reportFields(report)).toEqual(['feet', 'feet.jumps', 'feet.supports', 'feet.supports[].side', 'feet.supports[].unlistedSurface', 'frames', 'render']);
  expect(auditReport(report, TEXT)).toEqual(['SURFACE_UNLISTED_FIELD: feet.supports[].unlistedSurface: 0 classification row(s) in RELEASING.md; expected exactly 1 promised or courtesy']);
  delete (report.feet.supports[1] as Record<string, unknown>).unlistedSurface;
  expect(auditReport(report, TEXT)).toEqual([]);
});

test('record names are data; a new child inside a record value is still refused', () => {
  const doc = TEXT + '\n';
  expect(surfaceRows(doc).fields).toContain('switches[].slots.*');
  const report = { switches: [{ slots: { 'slot.with.dots': 'fold', another: 'open' } }] };
  expect(auditReport(report, doc)).toEqual([]);
  expect(auditReport({ switches: [{ slots: { another: { unlistedSurface: true } } }] }, doc)).toEqual([
    'SURFACE_UNLISTED_FIELD: switches[].slots.*.unlistedSurface: 0 classification row(s) in RELEASING.md; expected exactly 1 promised or courtesy',
  ]);
});

test('a duplicate or unclassified nested row is not a classification', () => {
  const row = '| `inputs.map.path` | promised | C |';
  expect(TEXT).toContain(row);
  expect(auditReport({ inputs: { map: { path: 'map.json' } } }, TEXT.replace(row, `${row}\n${row}`))).toEqual([
    'SURFACE_UNLISTED_FIELD: inputs.map.path: 2 classification row(s) in RELEASING.md; expected exactly 1 promised or courtesy',
  ]);
  expect(auditReport({ inputs: { map: { path: 'map.json' } } }, TEXT.replace(row, row.replace('promised', 'undecided')))).toEqual([
    'SURFACE_UNLISTED_FIELD: inputs.map.path: 0 classification row(s) in RELEASING.md; expected exactly 1 promised or courtesy',
  ]);
});

test('empty help and an absent classification section cannot pass vacuously', () => {
  expect(() => helpFlags('')).toThrow('SURFACE_HELP');
  expect(() => surfaceRows('')).toThrow('SURFACE_TABLE');
  const dir = mkdtempSync(join(tmpdir(), 'rig-pose-surface-'));
  try {
    const cli = join(dir, 'cli.ts');
    writeFileSync(cli, 'process.exit(2);\n');
    expect(() => runHelp([], cli)).toThrow('exited 2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
