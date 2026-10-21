/**
 * rig-c/pose#369: a frontal run with two flights a stride plants the lower foot.
 * #280's vertical-speed reading took support from the ankle that moves with the
 * ground; on a run's short stances the lifted foot near the top of its swing is
 * nearly still and read as down while the landed foot still settles, so the
 * lifted foot was planted and the body hoisted onto it. The rule since: the
 * vertical speed decides only on a grounded span (between two jumps) that holds
 * a double support; a single stance's support is the lower ankle.
 *
 * Held by the run of examples/walk/make-depth.ts carried on a floor (`ground`):
 * its reading frame by frame against the generator's truth, the card's four
 * bars on a retarget onto the wave rig (support foot, hip vertical range,
 * rebound, loop position), and a planted mutant (the rule reverted) that must
 * fail them.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from '../src/clean.ts';
import { supportsOf, type Side } from '../src/legs.ts';
import { pointAt } from '../src/map.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { readBuild } from '../src/rigc.ts';
import { poseFrames } from '../src/verify.ts';
import { depthCycle, depthDoc, STRIDE, type DepthFrame } from '../examples/walk/make-depth.ts';

const ROOT = join(import.meta.dir, '..');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const RIG = join(ROOT, 'examples', 'wave', 'rig');
const MAP = join(ROOT, 'examples', 'walk', 'map.json');
const SLOW = 120_000;
const FPS = 24;
const STRIDES = 10;
const CYCLE = STRIDE.run;
type Pt = [number, number];

const run = (): DepthFrame[] => depthCycle('run', 'front', STRIDES, true);
const series = (c: DepthFrame[], j: string): Pt[] => c.map((f) => f.joints[j]!);

/** The fixture as a cleaned, in-place sequence, the form retarget reads. */
function sequence(): string {
  const doc = { ...depthDoc(run(), 'test/flight.test.ts: the frontal run of make-depth.ts carried on a floor, no picture'), travel: 'in-place' };
  const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
  return writePoseSequence(clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture').seq);
}

interface Rows {
  support: number;
  vertical: number;
  rebound: number;
  loop: number;
}

/**
 * The card's four rows, read as the exam's grader reads them, on a build: the
 * feet are the shins' tips, the hip the thigh roots' midpoint, leg lengths the
 * rig's at setup (thigh root → shin tip) and the sequence's (95th percentile
 * hip → ankle, both sides' mean); grounded frames are those outside the
 * report's jumps.
 */
function rowsOf(build: string, report: string, seqText: string): Rows {
  const doc = readBuild(build);
  const seq = JSON.parse(seqText) as { frames: Array<{ t: number; people: Array<{ joints: Record<string, { at: Pt }> }> }> };
  const times = seq.frames.map((f) => f.t);
  const n = times.length;
  const posed = poseFrames(doc, 'run', times);
  const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
  const tip = (i: number, s: Side): Pt => pointAt(posed[i]!, lengths, `leg_${s}1:tip`)!;
  const root = (i: number, s: Side): Pt => {
    const b = posed[i]!.get(`leg_${s}0`)!;
    return [b.worldX, b.worldY];
  };
  const rig = JSON.parse(readFileSync(join(RIG, 'rig.json'), 'utf8')) as { bones: Array<{ name: string; rotation?: number; length?: number }> };
  const bone = (name: string) => rig.bones.find((b) => b.name === name)!;
  const legOf = (s: Side) => {
    const a = bone(`leg_${s}0`).length!;
    const b = bone(`leg_${s}1`).length!;
    const bend = ((bone(`leg_${s}1`).rotation ?? 0) * Math.PI) / 180;
    return Math.hypot(a + b * Math.cos(bend), b * Math.sin(bend));
  };
  const L = (legOf('r') + legOf('l')) / 2;
  const sj = (i: number, j: string): Pt => seq.frames[i]!.people[0]!.joints[j]!.at;
  const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    const k = (s.length - 1) * q;
    const lo = Math.floor(k);
    return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (k - lo);
  };
  const median = (xs: number[]) => pct(xs, 0.5);
  const Ls = (pct(times.map((_, i) => Math.hypot(sj(i, 'r_ankle')[0] - sj(i, 'r_hip')[0], sj(i, 'r_ankle')[1] - sj(i, 'r_hip')[1])), 0.95) + pct(times.map((_, i) => Math.hypot(sj(i, 'l_ankle')[0] - sj(i, 'l_hip')[0], sj(i, 'l_ankle')[1] - sj(i, 'l_hip')[1])), 0.95)) / 2;
  const jumps = (JSON.parse(readFileSync(report, 'utf8')) as { feet: { jumps: Array<[number, number]> } }).feet.jumps;
  const air = new Set<number>();
  for (const [a, b] of jumps) for (let i = a; i <= b; i++) air.add(i);
  const grounded = times.map((_, i) => i).filter((i) => !air.has(i));
  // Support foot: the lower foot (world y up) against the floor, the median of it over the grounded frames.
  const low = new Map(grounded.map((i) => [i, Math.min(tip(i, 'r')[1], tip(i, 'l')[1])]));
  const floor = median([...low.values()]);
  const support = Math.max(...[...low.values()].map((y) => Math.abs(y - floor))) / L;
  // Hip vertical range: the median per-cycle width of the rig's hip y over the sequence's mid_hip's.
  const hipR = times.map((_, i) => (root(i, 'r')[1] + root(i, 'l')[1]) / 2 / L);
  const hipS = times.map((_, i) => -(sj(i, 'r_hip')[1] + sj(i, 'l_hip')[1]) / 2 / Ls);
  const cycles = Array.from({ length: Math.floor(n / CYCLE) }, (_, k) => [k * CYCLE, (k + 1) * CYCLE] as const);
  const width = (v: number[]) => median(cycles.map(([a, b]) => Math.max(...v.slice(a, b)) - Math.min(...v.slice(a, b))));
  const vertical = width(hipR) / width(hipS);
  // Rebound: the median over the stance windows between two jumps of the rig's peak upward hip acceleration over the sequence's.
  const spans = [...jumps].sort((a, b) => a[0] - b[0]);
  const ratios: number[] = [];
  for (let k = 0; k + 1 < spans.length; k++) {
    const a = spans[k]![1] + 1;
    const b = spans[k + 1]![0] - 1;
    const js: number[] = [];
    for (let j = Math.max(a, 1); j <= Math.min(b, n - 2); j++) js.push(j);
    if (js.length === 0) continue;
    const acc = (h: number[]) => Math.max(...js.map((j) => h[j - 1]! - 2 * h[j]! + h[j + 1]!));
    if (acc(hipS) > 0) ratios.push(acc(hipR) / acc(hipS));
  }
  const rebound = median(ratios);
  // Loop: cycle 1 against the last, the hip's and both feet's world positions.
  const last = (cycles.length - 1) * CYCLE;
  const hipAt = (i: number): Pt => {
    const b = posed[i]!.get('hip')!;
    return [b.worldX, b.worldY];
  };
  let loop = 0;
  for (let i = 0; i < CYCLE; i++) {
    for (const at of [hipAt, (k: number) => tip(k, 'r'), (k: number) => tip(k, 'l')]) {
      const p = at(i);
      const q = at(last + i);
      loop = Math.max(loop, Math.hypot(p[0] - q[0], p[1] - q[1]) / L);
    }
  }
  return { support, vertical, rebound, loop };
}

/** Retargets the fixture with the card's flags through `cli`, and reads its rows. */
function retarget(cli: string, dir: string): { status: number | null; stdout: string; rows: Rows } {
  const seq = join(dir, 'run.json');
  const text = sequence();
  writeFileSync(seq, text);
  const build = join(dir, 'build');
  const report = join(dir, 'report.json');
  const r = spawnSync(process.execPath, [cli, 'retarget', '--rig', RIG, '--map', MAP, '--pose', seq, '--out', join(dir, 'motion.json'), '--name', 'run', '--build', build, '--report', report, '--plant-feet', '--stance', '0.07', '--leg-scale', '0.5,1.05'], { encoding: 'utf8', cwd: ROOT });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return { status: r.status, stdout: r.stdout, rows: rowsOf(build, report, text) };
}

const fmt = (x: Rows) => `support ${x.support.toFixed(4)} L, hip vertical ${x.vertical.toFixed(3)}, rebound ${x.rebound.toFixed(3)}, loop ${x.loop.toFixed(4)} L`;
const pass = (x: Rows) => x.support <= 0.01 && x.vertical >= 0.85 && x.vertical <= 1.15 && x.rebound >= 0.7 && x.rebound <= 1.43 && x.loop <= 0.01;

describe('#369: a frontal run with two flights a stride plants the lower foot', () => {
  test('the fixture: 10 strides of 20 frames, two flights of 6 frames a stride, each foot down on 4', () => {
    const c = run();
    expect(c).toHaveLength(STRIDES * CYCLE);
    const flight = c.map((f) => f.lifted.length === 2);
    const spans: Array<[number, number]> = [];
    flight.forEach((x, i) => {
      if (!x) return;
      const last = spans[spans.length - 1];
      if (last !== undefined && last[1] === i - 1) last[1] = i;
      else spans.push([i, i]);
    });
    expect(spans).toHaveLength(2 * STRIDES);
    expect(spans.every(([a, b]) => b - a + 1 === 6)).toBe(true);
    // The supporting ankle is on the floor and is the lower one; the lifted ankle is higher on every one-foot frame.
    for (const f of c) {
      if (f.lifted.length !== 1) continue;
      const down: Side = f.lifted[0] === 'r' ? 'l' : 'r';
      expect(f.joints[`${down}_ankle`]![1]).toBeGreaterThan(f.joints[`${f.lifted[0]}_ankle`]![1]);
    }
  });

  test('read frame by frame: no contradiction on a span without double support, not frontal, every one-foot frame supported by its foot down (the lower ankle)', () => {
    const c = run();
    const feet = supportsOf({ r: series(c, 'r_ankle'), l: series(c, 'l_ankle') }, { r: series(c, 'r_hip'), l: series(c, 'l_hip') }, c.map((_, i) => i / FPS), (x) => (x[1] - x[0] + 1) / FPS, true, false);
    const sig = feet.signal!;
    expect(feet.jumps).toHaveLength(2 * STRIDES);
    expect(sig.contact.includes('both')).toBe(false);
    expect(sig.contradict).toEqual([]);
    expect(sig.frontal).toBe(false);
    let read = 0;
    c.forEach((f, i) => {
      if (f.lifted.length !== 1) return;
      read++;
      expect(feet.support[i]).toBe(f.lifted[0] === 'r' ? 'l' : 'r');
    });
    expect(read).toBe(2 * 4 * STRIDES);
  });

  test('retargeted with the card\'s flags: support foot ≤ 0.01 L, hip vertical 0.85–1.15, rebound 0.7–1.43, loop ≤ 0.01 L; no support line printed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-pose-test-'));
    try {
      const r = retarget(join(ROOT, 'cli.ts'), dir);
      console.log(`  #369 fixed: ${fmt(r.rows)}`);
      expect(r.rows.support).toBeLessThanOrEqual(0.01);
      expect(r.rows.vertical).toBeGreaterThanOrEqual(0.85);
      expect(r.rows.vertical).toBeLessThanOrEqual(1.15);
      expect(r.rows.rebound).toBeGreaterThanOrEqual(0.7);
      expect(r.rows.rebound).toBeLessThanOrEqual(1.43);
      expect(r.rows.loop).toBeLessThanOrEqual(0.01);
      expect(r.stdout.split('\n').filter((l) => l.includes('FEET   support:') || l.includes('FEET   stride '))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);

  test('mutant: the vertical speed deciding on every span (the rule reverted) plants the lifted foot and fails the bars', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm369-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const src = readFileSync(path, 'utf8');
      const edits: Array<[string, string]> = [
        ['(withGround(s, i) || withGround(s, i + 1)) && !aloft(s, i)', 'withGround(s, i) || withGround(s, i + 1)'],
      ];
      let text = src;
      for (const [from, to] of edits) {
        expect(text.split(from)).toHaveLength(2);
        text = text.replace(from, to);
      }
      writeFileSync(path, text);
      const m = (await import(path)) as { supportsOf: typeof supportsOf };
      const c = run();
      const feet = m.supportsOf({ r: series(c, 'r_ankle'), l: series(c, 'l_ankle') }, { r: series(c, 'r_hip'), l: series(c, 'l_hip') }, c.map((_, i) => i / FPS), (x) => (x[1] - x[0] + 1) / FPS, true, false);
      const wrong = c.map((f, i) => (f.lifted.length === 1 && feet.support[i] === f.lifted[0] ? i : -1)).filter((i) => i >= 0);
      console.log(`  #369 mutant: frontal ${String(feet.signal!.frontal)}, contradict ${feet.signal!.contradict.length} of ${feet.signal!.read}; the lifted foot supports on ${wrong.length} frame(s): ${wrong.join(', ')}`);
      expect(feet.signal!.frontal).toBe(true);
      expect(wrong.length).toBeGreaterThan(0);
      const out = join(d, 'out');
      mkdirSync(out);
      const r = retarget(join(d, 'cli.ts'), out);
      console.log(`  #369 mutant retarget: ${fmt(r.rows)}`);
      expect(r.rows.support).toBeGreaterThan(0.01);
      expect(pass(r.rows)).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});
