/**
 * rig-c/pose#262: RELEASING.md's "What 1.x promises" lists every flag `cli.ts` parses and every
 * top-level key a report can carry, each exactly once, as promised or courtesy. A flag or a key
 * added without a row is a promise nobody decided; the tables are read against the source here, and
 * the mutants below add one of each and must go red.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

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

export interface DocLink {
  doc: string;
  line: number;
  target: string;
  resolved: string | null;
}

const NPM_ALWAYS_SHIPS = ['package.json', 'README.md', 'LICENSE'];
const WALK_SKIP = new Set(['.git', 'node_modules', '.claude']);

export function trackedFiles(root = ROOT): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (listed.error === undefined && listed.status === 0) {
    return listed.stdout
      .toString('utf8')
      .split('\u0000')
      .filter((p) => p !== '' && existsSync(join(root, p)));
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (WALK_SKIP.has(entry.name)) continue;
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk('');
  return out;
}

export function packedSet(allowlist: readonly string[], tracked: readonly string[], root = ROOT): { packed: Set<string>; unreadable: string[] } {
  const packed = new Set(NPM_ALWAYS_SHIPS);
  const unreadable: string[] = [];
  for (const entry of allowlist) {
    if (/[*?[\]{}!]/.test(entry)) {
      unreadable.push(`${entry} (pattern not expanded)`);
      continue;
    }
    const full = join(root, entry);
    if (!existsSync(full)) {
      unreadable.push(`${entry} (in files and not on disk)`);
      continue;
    }
    if (statSync(full).isDirectory()) {
      for (const file of tracked) if (file.startsWith(`${entry}/`)) packed.add(file);
    } else {
      packed.add(entry);
    }
  }
  return { packed, unreadable };
}

export function relativeDocLinks(doc: string, text: string, root = ROOT): DocLink[] {
  const found: DocLink[] = [];
  const lines = text.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^ {0,3}(```+|~~~+)/.exec(line);
    if (marker !== null) {
      if (fence === null) fence = marker[1]![0]!;
      else if (marker[1]![0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const targets = [
      ...[...line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^()\s]*)/g)].map((m) => m[1]!),
      ...[...line.matchAll(/^ {0,3}\[(?:[^\]\\]|\\.)+\]:\s*(<[^>]*>|\S+)/g)].map((m) => m[1]!),
      ...[...line.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => (m[1] ?? m[2])!),
    ];
    for (const raw of targets) {
      const target = raw.startsWith('<') ? raw.slice(1, -1) : raw;
      if (target === '' || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      let path: string;
      try {
        path = decodeURIComponent(target.split('#')[0]!.split('?')[0]!);
      } catch {
        path = target.split('#')[0]!.split('?')[0]!;
      }
      if (path === '') continue;
      const rel = relative(root, resolve(root, dirname(doc), path)).replace(/\/$/, '');
      found.push({ doc, line: i + 1, target, resolved: rel === '' || rel.startsWith('..') ? null : rel });
    }
  }
  return found;
}

export function auditShippedDocLinks(
  links: readonly DocLink[],
  packed: ReadonlySet<string>,
  tracked: ReadonlySet<string>,
): string[] {
  const inSet = (set: ReadonlySet<string>, path: string): boolean =>
    set.has(path) || [...set].some((file) => file.startsWith(`${path}/`));
  const problems: string[] = [];
  for (const link of links) {
    if (link.doc === 'README.md') {
      if (link.resolved === null || !inSet(tracked, link.resolved)) {
        problems.push(
          `PKG_README_LINK: ${link.doc}:${link.line} "${link.target}" resolves to ${link.resolved ?? 'outside the repository'}, which is not a tracked repository file`,
        );
      }
    } else if (link.resolved === null || !inSet(packed, link.resolved)) {
      problems.push(
        `PKG_DOC_LINK: ${link.doc}:${link.line} "${link.target}" resolves to ${link.resolved ?? 'outside the package'}, which is not in the packed file set`,
      );
    }
  }
  return problems;
}

test('shipped docs (#511): docs/REFERENCE.md ships, README relative links resolve to tracked files, and every other shipped doc relative-links only packed files', () => {
  const pkg = JSON.parse(read('package.json')) as { files?: string[] };
  const allowlist = pkg.files ?? [];
  expect(allowlist).toContain('docs/REFERENCE.md');
  const trackedList = trackedFiles();
  const tracked = new Set(trackedList);
  const { packed, unreadable } = packedSet(allowlist, trackedList);
  expect(unreadable).toEqual([]);
  expect(packed.has('docs/REFERENCE.md')).toBe(true);
  for (const unshipped of ['docs/REGRESSION.md', 'docs/JOURNEY-gait.md', 'docs/demos/visible-retarget/README.md', 'examples/wave/map.json']) {
    expect(packed.has(unshipped)).toBe(false);
  }

  const docs = [...packed].filter((file) => file.endsWith('.md')).sort();
  expect(docs).toEqual(['README.md', 'docs/REFERENCE.md', 'skills/rig-pose/SKILL.md']);
  const links = docs.flatMap((doc) => relativeDocLinks(doc, read(doc)));
  expect(links.filter((l) => l.doc === 'README.md').length).toBeGreaterThan(20);
  expect(links.filter((l) => l.doc === 'docs/REFERENCE.md').length).toBeGreaterThan(0);
  expect(auditShippedDocLinks(links, packed, tracked)).toEqual([]);
});

test('planted (#511): an unshipped relative link in a non-README shipped doc and an untracked relative link in README.md each turn the control red', () => {
  const pkg = JSON.parse(read('package.json')) as { files?: string[] };
  const trackedList = trackedFiles();
  const tracked = new Set(trackedList);
  const { packed } = packedSet(pkg.files ?? [], trackedList);

  // Rule 1 plant: a relative link in docs/REFERENCE.md to a repository file that does not ship.
  const plantedReference = `${read('docs/REFERENCE.md')}\nSee [the release contract](../RELEASING.md#what-1x-promises) and [a demo](demos/visible-retarget/README.md).\n`;
  const refProblems = auditShippedDocLinks(relativeDocLinks('docs/REFERENCE.md', plantedReference), packed, tracked);
  expect(refProblems).toEqual([
    expect.stringContaining('PKG_DOC_LINK: docs/REFERENCE.md:'),
    expect.stringContaining('PKG_DOC_LINK: docs/REFERENCE.md:'),
  ]);
  expect(refProblems[0]).toContain('"../RELEASING.md#what-1x-promises" resolves to RELEASING.md, which is not in the packed file set');
  expect(refProblems[1]).toContain('"demos/visible-retarget/README.md" resolves to docs/demos/visible-retarget/README.md, which is not in the packed file set');

  // Rule 2 plant: a relative link in README.md to an unshipped tracked file passes, while an untracked target turns red.
  const readmeWithTrackedUnshipped = `${read('README.md')}\nSee [releasing](RELEASING.md) and [missing](docs/DOES-NOT-EXIST.md).\n`;
  const readmeProblems = auditShippedDocLinks(relativeDocLinks('README.md', readmeWithTrackedUnshipped), packed, tracked);
  expect(readmeProblems).toEqual([
    expect.stringContaining('PKG_README_LINK: README.md:'),
  ]);
  expect(readmeProblems[0]).toContain('"docs/DOES-NOT-EXIST.md" resolves to docs/DOES-NOT-EXIST.md, which is not a tracked repository file');
});
