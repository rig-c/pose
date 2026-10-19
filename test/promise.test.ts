/**
 * rig-c/pose#262: RELEASING.md's "What 1.x promises" lists every flag `cli.ts` parses and every
 * top-level key a report can carry, each exactly once, as promised or courtesy. A flag or a key
 * added without a row is a promise nobody decided; the tables are read against the source here, and
 * the mutants below add one of each and must go red.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Every `<command> --<flag>` cli.ts parses: the two name lists of each parseFlags call, and the retarget aliases. */
export function flagsOf(cli: string): string[] {
  const out: string[] = [];
  const lines = cli.split('\n');
  lines.forEach((line, i) => {
    const call = /parseFlags\((?:argv|rest), (\[[^\]]*\]), (\[[^\]]*\])/.exec(line);
    if (call === null) return;
    // The command: the function the call is in (retargetArgs, compareArgs, runClean), or the `cmd === '…'` branch above it.
    let cmd: string | null = null;
    for (let j = i; j >= 0 && cmd === null; j--) {
      const branch = /cmd === '([a-z]+)'/.exec(lines[j]!);
      const fn = /^(?:export )?function (retargetArgs|compareArgs|runClean)\(/.exec(lines[j]!);
      if (branch !== null) cmd = branch[1]!;
      else if (fn !== null) cmd = { retargetArgs: 'retarget', compareArgs: 'compare', runClean: 'clean' }[fn[1]!]!;
    }
    if (cmd === null) throw new Error(`cli.ts line ${i + 1}: a parseFlags call with no command above it`);
    for (const list of [call[1]!, call[2]!]) for (const m of list.matchAll(/'([a-z0-9-]+)'/g)) out.push(`${cmd} --${m[1]}`);
  });
  const aliases = /RETARGET_ALIASES = \{([^}]*)\}/.exec(cli);
  if (aliases === null) throw new Error('cli.ts: no RETARGET_ALIASES');
  for (const m of aliases[1]!.matchAll(/(\w+):/g)) out.push(`retarget --${m[1]}`);
  return out;
}

/** Every top-level key: the writeReport literal's own keys in run.ts (spreads included), and report.ts's `add(report,'…'`. */
export function reportKeysOf(run: string, report: string): string[] {
  const start = run.indexOf('const reportText = writeReport({');
  if (start < 0) throw new Error('run.ts: no writeReport call');
  const end = run.indexOf('\n      }, map, ', start);
  if (end < 0) throw new Error('run.ts: the writeReport literal has no end');
  const body = run.slice(start, end);
  const keys = new Set<string>();
  for (const m of body.matchAll(/^ {8}([A-Za-z]+)[:,]/gm)) keys.add(m[1]!);
  // A conditional key, spread in at the literal's own level: `...(cond ? { byHip: … } : {})` or the face block.
  for (const m of body.matchAll(/^ {8}\.\.\.\([^\n]*?\{ ([A-Za-z]+): /gm)) keys.add(m[1]!);
  for (const m of body.matchAll(/^ {14}([A-Za-z]+): \{$/gm)) keys.add(m[1]!);
  for (const m of report.matchAll(/add\(report,'([A-Za-z0-9]+)'/g)) keys.add(m[1]!);
  return [...keys];
}

/** The rows of the promise tables: `command --flag` and report keys, each with its status. */
export function rowsOf(releasing: string): { flags: string[]; keys: string[] } {
  const at = releasing.indexOf('## What 1.x promises');
  if (at < 0) throw new Error('RELEASING.md: no "What 1.x promises" section');
  const s = releasing.slice(at);
  const flags = [...s.matchAll(/^\| `([a-z]+)` \| `--([a-z0-9-]+)` \| (?:promised|courtesy) \|/gm)].map((m) => `${m[1]} --${m[2]}`);
  const keysAt = s.indexOf("### The report's top-level keys");
  const keysEnd = s.indexOf('\n### ', keysAt + 1);
  const keys = [...s.slice(keysAt, keysEnd).matchAll(/^\| `([A-Za-z0-9]+)` \| (?:promised|courtesy) \|/gm)].map((m) => m[1]!);
  return { flags, keys };
}

/** What is missing from the tables, and what they list twice. */
function audit(cli: string, run: string, report: string, releasing: string): string[] {
  const rows = rowsOf(releasing);
  const problems: string[] = [];
  const once = (kind: string, have: string[], want: string[]) => {
    for (const w of new Set(want)) {
      const n = have.filter((h) => h === w).length;
      if (n !== 1) problems.push(`${kind} ${w}: ${n} row(s) in RELEASING.md, expected 1`);
    }
    for (const h of new Set(have)) if (!want.includes(h)) problems.push(`${kind} ${h}: a row in RELEASING.md for nothing the source has`);
  };
  once('flag', rows.flags, flagsOf(cli));
  once('report key', rows.keys, reportKeysOf(run, report));
  return problems;
}

const CLI = read('cli.ts');
const RUN = read('src/run.ts');
const REPORT = read('src/report.ts');
const RELEASING = read('RELEASING.md');

test('control: every flag and every top-level report key has exactly one row', () => {
  // The readers find what they should: the four commands, and the report's anchors.
  const flags = flagsOf(CLI);
  for (const f of ['retarget --rig', 'retarget --sequence', 'clean --loop', 'compare --reference', 'convert --coco']) expect(flags).toContain(f);
  const keys = reportKeysOf(RUN, REPORT);
  for (const k of ['spec', 'feet', 'landings', 'byHip', 'face', 'body', 'reduce', 'frameTimes', 'fps', 'frame0', 'render', 'inputs']) expect(keys).toContain(k);
  expect(audit(CLI, RUN, REPORT, RELEASING)).toEqual([]);
});

test('mutant: a flag added to retarget with no row is named', () => {
  const cli = CLI.replace("'reduce-keep-planted', ", "'reduce-keep-planted', 'unpromised', ");
  expect(cli).not.toBe(CLI);
  expect(audit(cli, RUN, REPORT, RELEASING)).toEqual(['flag retarget --unpromised: 0 row(s) in RELEASING.md, expected 1']);
});

test('mutant: a report key added with no row is named', () => {
  const run = RUN.replace('        raised: r.raised,\n', '        raised: r.raised,\n        unpromised: null,\n');
  expect(run).not.toBe(RUN);
  expect(audit(CLI, run, REPORT, RELEASING)).toEqual(['report key unpromised: 0 row(s) in RELEASING.md, expected 1']);
});

test('mutant: a row listed twice is named', () => {
  const releasing = RELEASING.replace('| `retarget` | `--rig` |', '| `retarget` | `--rig` | promised | D | |\n| `retarget` | `--rig` |');
  expect(releasing).not.toBe(RELEASING);
  expect(audit(CLI, RUN, REPORT, releasing)).toEqual(['flag retarget --rig: 2 row(s) in RELEASING.md, expected 1']);
});

test('the package exports only package.json: no importable API is promised', () => {
  const pkg = JSON.parse(read('package.json')) as { exports?: unknown; bin?: unknown };
  expect(pkg.exports).toEqual({ './package.json': './package.json' });
  expect(pkg.bin).toEqual({ 'rig-pose': './bin/rig-pose.cjs' });
});
