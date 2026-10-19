/**
 * rig-c/pose#270: `retarget --build` writes `retarget.json` (rig-pose-retarget/1) beside the build.
 * Planted: `--reference` given is echoed verbatim (a path with `../` and spaces, never normalised);
 * control: without it the record has no `reference` key at all. `--reference` without `--build` is
 * refused by name. Two runs of the same inputs into two build directories write the same bytes. The
 * shape: the spec, the fixed key order, each hash the sha256 of the file's bytes, the sequence's own
 * `source`, and `flags` = the report's `options` with the name first.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { PROVENANCE_FILE } from '../src/provenance.ts';
import { runRetarget, type RetargetArgs } from '../src/run.ts';
import { Refusal } from '../src/problems.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
/** Given relative to the repository root, as an author types them; the run's cwd is the root. */
const RIG = 'examples/wave/rig';
const MAP = 'examples/wave/map.json';
const POSE = 'examples/wave/pose.json';
const REFERENCE = '../source clips/the wave take 2.mp4';
const SLOW = 60_000;

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
  dir: string;
  build: string;
}

function retarget(extra: string[], opts: { build?: boolean; rig?: string } = {}): Ran {
  const dir = mkdtempSync(join(tmpdir(), 'rig-pose-provenance-'));
  const build = join(dir, 'build');
  const args = ['retarget', '--rig', opts.rig ?? RIG, '--map', MAP, '--sequence', POSE, '--out', join(dir, 'motion.json'), ...(opts.build === false ? [] : ['--build', build]), ...extra];
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', dir, build };
}
const sha = (path: string): string => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
const record = (r: Ran): Record<string, unknown> => JSON.parse(readFileSync(join(r.build, PROVENANCE_FILE), 'utf8')) as Record<string, unknown>;

describe('retarget --build writes its record, retarget.json (#270)', () => {
  test('planted: --reference is echoed verbatim; control: without it the key is absent', () => {
    const given = retarget(['--reference', REFERENCE]);
    const without = retarget([]);
    try {
      expect(given.status, given.stdout + given.stderr).toBe(0);
      expect(without.status, without.stdout + without.stderr).toBe(0);
      const a = record(given), b = record(without);
      expect(a.reference).toBe(REFERENCE);
      expect(given.stdout).toContain(`  RECORD ${PROVENANCE_FILE} written beside the build (reference: ${REFERENCE})\n`);
      expect('reference' in b).toBe(false);
      expect(without.stdout).toContain(`  RECORD ${PROVENANCE_FILE} written beside the build (reference: none given)\n`);
      // Nothing but the reference differs between the two.
      const { reference: _r, ...rest } = a;
      expect(rest).toEqual(b);
    } finally {
      rmSync(given.dir, { recursive: true, force: true });
      rmSync(without.dir, { recursive: true, force: true });
    }
  }, SLOW * 2);

  test('planted: --reference without --build is refused by name, nothing written', () => {
    const r = retarget(['--reference', REFERENCE], { build: false });
    try {
      expect(r.status).toBe(2);
      expect(r.stderr).toBe(`rig-pose retarget: --reference needs --build: the record it goes in is written beside the build (${PROVENANCE_FILE}) (rig-pose --help)\n`);
      expect(existsSync(join(r.dir, 'motion.json'))).toBe(false);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
    // The same refusal where runRetarget is called without the CLI, before anything is read.
    const args = { rig: join(ROOT, RIG), map: join(ROOT, MAP), pose: join(ROOT, POSE), out: join(tmpdir(), 'rig-pose-provenance-none.json'), name: 'dance', coco: false, reference: REFERENCE } as RetargetArgs;
    let caught: unknown;
    try {
      runRetarget(args, () => {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Refusal);
    expect((caught as Refusal).problems).toEqual([{ code: 'ARG_REFERENCE', text: `--reference ${REFERENCE} needs --build: the record it goes in is written beside the build (${PROVENANCE_FILE})` }]);
  });

  test('determinism: the same inputs into two build directories write the same bytes', () => {
    const one = retarget(['--reference', REFERENCE]);
    const two = retarget(['--reference', REFERENCE]);
    try {
      expect(one.status, one.stdout + one.stderr).toBe(0);
      expect(two.status, two.stdout + two.stderr).toBe(0);
      const x = readFileSync(join(one.build, PROVENANCE_FILE));
      expect(readFileSync(join(two.build, PROVENANCE_FILE)).equals(x)).toBe(true);
      // 2-space JSON with a trailing newline, as the other writers.
      const text = x.toString('utf8');
      expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    } finally {
      rmSync(one.dir, { recursive: true, force: true });
      rmSync(two.dir, { recursive: true, force: true });
    }
  }, SLOW * 2);

  test('shape: spec, key order, hashes of the bytes, the source, flags = report options with the name', () => {
    const r = retarget(['--reference', REFERENCE, '--name', 'hello', '--bends', 'clamp', '--min-score', '0.25']);
    try {
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const rec = record(r) as {
        spec: string;
        pose: { version: string };
        rigc: { version: string };
        inputs: Record<string, Record<string, string>>;
        flags: Record<string, unknown>;
      };
      expect(Object.keys(rec)).toEqual(['spec', 'pose', 'rigc', 'inputs', 'flags', 'reference']);
      expect(rec.spec).toBe('rig-pose-retarget/1');
      expect(rec.pose).toEqual({ version: pkg.version });
      expect(Object.keys(rec.rigc)).toEqual(['version']);
      expect(r.stdout).toContain(`  RIGC   rig-c ${rec.rigc.version} (`);
      expect(Object.keys(rec.inputs)).toEqual(['rig', 'map', 'sequence']);
      // A directory --rig: the path as typed, the hash of the rig spec rigc gated (its rig.json).
      expect(rec.inputs.rig).toEqual({ path: RIG, sha256: sha(join(RIG, 'rig.json')) });
      expect(rec.inputs.map).toEqual({ path: MAP, sha256: sha(MAP) });
      const source = (JSON.parse(readFileSync(join(ROOT, POSE), 'utf8')) as { source: string }).source;
      expect(rec.inputs.sequence).toEqual({ path: POSE, sha256: sha(POSE), source });
      expect(Object.keys(rec.inputs.sequence!)).toEqual(['path', 'sha256', 'source']);
      const report = JSON.parse(readFileSync(join(r.dir, 'motion.report.json'), 'utf8')) as { options: Record<string, unknown> };
      expect(rec.flags).toEqual({ name: 'hello', ...report.options });
      expect(Object.keys(rec.flags)).toEqual(['name', ...Object.keys(report.options)]);
      expect(rec.flags.bends).toBe('clamp');
      expect(rec.flags.minScore).toBe(0.25);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, SLOW);

  test('a rig.json --rig: its own path, the same rig hash as the directory form', () => {
    const r = retarget([], { rig: join(RIG, 'rig.json') });
    try {
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const inputs = record(r).inputs as Record<string, { path: string; sha256: string }>;
      expect(inputs.rig).toEqual({ path: join(RIG, 'rig.json'), sha256: sha(join(RIG, 'rig.json')) });
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, SLOW);
});
