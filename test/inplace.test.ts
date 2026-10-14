/**
 * rig-c/pose#92: a gait filmed in place. A sequence may declare
 * `travel: "in-place"` (`clean --loop` writes it); under it `--plant-feet`
 * lets the supporting foot follow its own track instead of holding it, releases
 * no step, and closes the loop. Held by a synthetic in-place loop with known
 * answers: its supporting foot slides back in the picture while the hips stay,
 * so in place the hip travels nothing, and the same joints without the
 * declaration read today's travel (the slide integrated). The planted mutant
 * (the follow ignored) must make the in-place test red.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY18 } from '../src/joints.ts';
import { clean } from '../src/clean.ts';
import { closeLoop, plantHip, supportsOf, type Feet, type Side } from '../src/legs.ts';
import { readPoseSequence, writePoseSequence, type PoseSequence } from '../src/pose.ts';
import { Refusal } from '../src/problems.ts';

const ROOT = join(import.meta.dir, '..');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
type Pt = [number, number];
const FPS = 24;
/** Picture px per leg length (hip → ankle at the floor). */
const LEG = 100;
/** One cycle: each foot supports for HALF frames, sliding back, then swings forward, lifted up to LIFT px. */
const N = 40;
const HALF = N / 2;
const LIFT = 10;

/**
 * The synthetic in-place gait, picture px, y down: the hips still at (∓10, 0),
 * each ankle LEG below its hip. A supporting ankle slides back by `slide` px a
 * frame over its HALF frames (from +slide·(HALF−1)/2 to −slide·(HALF−1)/2 about
 * its hip) and swings forward over the next HALF, rising and falling 2 px a
 * frame (0.02 leg lengths: no step) up to LIFT; the left foot half a cycle
 * behind the right. Periodic: frame N would be frame 0.
 */
function gait(slide: number): { ankle: Record<Side, Pt[]>; hip: Record<Side, Pt[]> } {
  const half = (slide * (HALF - 1)) / 2;
  const foot = (k: number): Pt => (k < HALF ? [half - slide * k, LEG] : [-half + slide * (k - HALF), LEG - Math.min(LIFT, 2 * (k - HALF), 2 * (N - 1 - k))]);
  const ankle = { r: [] as Pt[], l: [] as Pt[] };
  const hip = { r: [] as Pt[], l: [] as Pt[] };
  for (let i = 0; i < N; i++) {
    const r = foot(i);
    const l = foot((i + HALF) % N);
    ankle.r.push([-10 + r[0], r[1]]);
    ankle.l.push([10 + l[0], l[1]]);
    hip.r.push([-10, 0]);
    hip.l.push([10, 0]);
  }
  return { ankle, hip };
}

const SUPPORTS: Feet['supports'] = [{ side: 'r', frames: [0, 23] }, { side: 'l', frames: [24, 39] }];
const times = Array.from({ length: N }, (_, i) => i / FPS);
const secondsOf = (x: [number, number]) => (x[1] - x[0] + 1) / FPS;
/** Rig scale 1: world x = picture x, world y = −picture y; the ankle's posed offset from the hip is the picture's. */
function plant(g: ReturnType<typeof gait>, feet: Feet, inPlace: boolean, impl: typeof plantHip = plantHip) {
  const offset = (i: number, s: Side): Pt => [g.ankle[s][i]![0], -g.ankle[s][i]![1]];
  const follow = inPlace ? (i: number, s: Side) => g.ankle[s][i]![0] : undefined;
  return impl(feet, offset, () => [0, 0], [0, 0], undefined, follow);
}

describe('#92: --plant-feet under travel "in-place"', () => {
  test('a supporting foot sliding back while the hips stay: in place the hip travels nothing, and each supporting ankle follows its own track', () => {
    const g = gait(2);
    const feet = supportsOf(g.ankle, g.hip, times, secondsOf, true);
    // The right foot supports first; the left takes over once it has been 0.02 leg lengths lower (4 px over the
    // 100.02 px median leg: from frame 22) for 0.1 s (frames 22–24).
    expect(feet.supports).toEqual(SUPPORTS);
    expect(feet.jumps).toEqual([]);
    expect(feet.steps).toEqual([]);
    const p = plant(g, feet, true);
    expect(p.closure).not.toBeNull();
    expect(Math.abs(p.closure!.drift)).toBeLessThan(1e-9);
    for (let i = 0; i < N; i++) expect(Math.abs(p.hip[i]![0])).toBeLessThan(1e-9);
    // The supporting ankle (hip + offset) moves frame to frame as its picture ankle does.
    for (let i = 1; i < N; i++) {
      const s = feet.support[i]!;
      if (feet.support[i - 1] !== s) continue;
      const world = (k: number) => p.hip[k]![0] + g.ankle[s][k]![0];
      expect(Math.abs(world(i) - world(i - 1) - (g.ankle[s][i]![0] - g.ankle[s][i - 1]![0]))).toBeLessThan(1e-9);
    }
    // The last frame's hip is the first's.
    expect(Math.abs(p.hip[N - 1]![0] - p.hip[0]![0])).toBeLessThan(1e-9);
  });

  test('control: the same joints without the declaration read today\'s travel — the slide held and integrated into the hip', () => {
    const g = gait(2);
    const feet = supportsOf(g.ankle, g.hip, times, secondsOf);
    // The slide (2 px, and 2.8 px on a frame the foot also lifts) is under a step's 0.03 leg lengths, so the reading is the in-place one.
    expect(feet.supports).toEqual(SUPPORTS);
    const p = plant(g, feet, false);
    expect(p.closure).toBeNull();
    // Held while it slides back 2 px a frame, the right foot carries the hip 2 px a frame forward …
    for (let i = 1; i < HALF; i++) expect(p.hip[i]![0] - p.hip[i - 1]![0]).toBeCloseTo(2, 9);
    // … and over the loop the hip travels 60 px (the swing the held right foot makes before the left takes over pulls 8 back).
    expect(p.hip[N - 1]![0] - p.hip[0]![0]).toBeCloseTo(60, 9);
  });

  test('a slide faster than a step (0.04 leg lengths a frame): without the declaration both feet are released and never re-plant; in place nothing is released and the supports alternate', () => {
    const g = gait(4);
    const today = supportsOf(g.ankle, g.hip, times, secondsOf);
    // Each foot supports for one frame, then is released as stepping and is never still again.
    expect(today.supports).toEqual([{ side: 'r', frames: [0, 0] }, { side: 'l', frames: [20, 20] }]);
    expect(today.steps.map((s) => [s.side, s.frames, s.replant, s.to])).toEqual([['r', [1, 39], null, null], ['l', [21, 39], null, null]]);
    const inPlace = supportsOf(g.ankle, g.hip, times, secondsOf, true);
    expect(inPlace.steps).toEqual([]);
    expect(inPlace.supports).toEqual(SUPPORTS);
  });

  test('closeLoop: a drift spread back linearly, the last frame\'s x the first\'s, y untouched', () => {
    const hip: Pt[] = Array.from({ length: 11 }, (_, i): Pt => [5 + 3 * i, 7 - i]);
    const c = closeLoop(hip);
    expect(c).toEqual({ drift: 30, frames: 11 });
    for (let i = 0; i < 11; i++) {
      expect(hip[i]![0]).toBeCloseTo(5, 9);
      expect(hip[i]![1]).toBe(7 - i);
    }
  });

  test('mutant: the follow ignored (the anchor held where it planted) and the in-place test is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'const dx = follow === undefined ? 0 : follow(i, mode.side) - follow(mode.from, mode.side);';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'const dx = 0;'));
      const m = (await import(path)) as { plantHip: typeof plantHip };
      const g = gait(2);
      const feet = supportsOf(g.ankle, g.hip, times, secondsOf, true);
      const p = plant(g, feet, true, m.plantHip);
      const worst = Math.max(...p.hip.map((h) => Math.abs(h[0])));
      console.log(`  mutant "follow ignored": closure drift ${p.closure!.drift.toFixed(3)} px, the hip up to ${worst.toFixed(3)} px off still`);
      // The slide is integrated again (today's 60 px over the loop), and closing it bows the hip in between.
      expect(p.closure!.drift).toBeCloseTo(60, 9);
      expect(worst).toBeGreaterThan(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// --- the declaration ---------------------------------------------------------------

/** A standing figure, every joint still: enough for the reader and clean. */
function seqDoc(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const frames = Array.from({ length: n }, (_, i) => {
    const joints: Record<string, { state: string; at: Pt; score: number }> = {};
    BODY18.forEach((name, k) => {
      joints[name] = { state: 'observed', at: [500 + 10 * k + Math.sin(0.3 * i + k), 300 + 20 * k], score: 0.9 };
    });
    return { t: i / 30, people: [{ id: 'a', joints }] };
  });
  return { spec: 'rig-pose-sequence/1', space: { units: 'picture-px', origin: 'top-left', y: 'down' }, width: 1000, height: 1000, source: 'synthetic, test/inplace.test.ts', ...extra, frames };
}
const read = (doc: Record<string, unknown>): PoseSequence => readPoseSequence(JSON.stringify(doc), 'mem');
function refusal(doc: Record<string, unknown>): string[] {
  try {
    read(doc);
  } catch (e) {
    if (e instanceof Refusal) return e.problems.map((p) => `${p.code}: ${p.text}`);
    throw e;
  }
  return [];
}

describe('#92: the sequence\'s "travel"', () => {
  test('"in-place" is read and written back; absent, nothing is written', () => {
    const s = read(seqDoc(8, { travel: 'in-place' }));
    expect(s.travel).toBe('in-place');
    expect(JSON.parse(writePoseSequence(s)).travel).toBe('in-place');
    const none = read(seqDoc(8));
    expect(none.travel).toBeUndefined();
    expect('travel' in JSON.parse(writePoseSequence(none))).toBe(false);
  });

  test('POSE_TRAVEL: any other value is refused by name; control: "in-place" reads', () => {
    expect(refusal(seqDoc(8, { travel: 'treadmill' }))).toEqual(['POSE_TRAVEL: mem "travel" is the string "treadmill"; the one value is "in-place" (a gait filmed without the figure travelling), and without the key the picture\'s travel is the figure\'s']);
    expect(refusal(seqDoc(8, { travel: true }))[0]).toStartWith('POSE_TRAVEL: mem "travel" is boolean true;');
    expect(refusal(seqDoc(8, { travel: 'in-place' }))).toEqual([]);
  });

  test('clean --loop writes "in-place"; without --loop the sequence keeps what it had', () => {
    const loop = clean(read(seqDoc(12)), { loop: true, legs: 5, rest: 5 }, undefined, 'mem');
    expect(loop.seq.travel).toBe('in-place');
    expect(JSON.parse(writePoseSequence(loop.seq)).travel).toBe('in-place');
    const open = clean(read(seqDoc(12)), { loop: false, legs: 5, rest: 5 }, undefined, 'mem');
    expect(open.seq.travel).toBeUndefined();
    const byHand = clean(read(seqDoc(12, { travel: 'in-place' })), { loop: false, legs: 5, rest: 5 }, undefined, 'mem');
    expect(byHand.seq.travel).toBe('in-place');
  });
});
