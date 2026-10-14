/**
 * rig-c/pose#113: with --plant-feet, on a sequence not declared in place, the
 * supporting foot is read from the lower ankle — a foot whose ankle is higher in
 * the picture than the other's by PLANT_SWITCH leg lengths or more never takes
 * support, and a supporting foot the other has been that much lower than for
 * PLANT_SWITCH_SECONDS is released when the lower one may not take it. Held by
 * synthetic legs with known answers beside the reading before #113, and by a
 * planted mutant (the rule off) that must make the first test red.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plantHip, supportsOf, type Side } from '../src/legs.ts';

const ROOT = join(import.meta.dir, '..');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
type Pt = [number, number];
const FPS = 30;
const N = 30;
const times = Array.from({ length: N }, (_, i) => i / FPS);
const secondsOf = (x: [number, number]) => (x[1] - x[0] + 1) / FPS;
const hips = { r: Array.from({ length: N }, (): Pt => [-10, 0]), l: Array.from({ length: N }, (): Pt => [10, 0]) };

/**
 * A step and a lifted leg, picture px, y down. The right ankle stands on the
 * floor 100 px below its hip and steps 5 px forward on frame 10 (0.05 leg
 * lengths: past a step's 0.03), still again from frame 11. The left ankle is
 * held 20 px up the whole time (0.2 leg lengths higher: a folded, lifted leg).
 */
function stepUnderLift(): Record<Side, Pt[]> {
  const r = Array.from({ length: N }, (_, i): Pt => [i < 10 ? -10 : -5, 100]);
  const l = Array.from({ length: N }, (): Pt => [10, 80]);
  return { r, l };
}

/**
 * The lower foot released and not yet still. Both ankles on the floor (the
 * left 100 px below its hip, the right 0.5 px higher); the left supports and steps 5 px on frame 5, then keeps
 * drifting 2 px a frame (under a step, over still) to frame 14 and is still from
 * frame 15. The right takes support on the step and rises 2 px a frame from
 * frame 6 to 10 px higher (frame 10), where it stays.
 */
function liftedOverDrift(): Record<Side, Pt[]> {
  const l = Array.from({ length: N }, (_, i): Pt => [i < 5 ? 10 : 15 + 2 * (Math.min(i, 14) - 5), 100]);
  const r = Array.from({ length: N }, (_, i): Pt => [-10, 99.5 - 2 * Math.min(5, Math.max(0, i - 5))]);
  return { r, l };
}

const sides = (s: Array<Side | null>) => s.map((x) => x ?? '-').join('');

describe('#113: --plant-feet reads the support from the lower ankle', () => {
  test('a step under a lifted leg: before #113 the lifted leg takes support; read from the lower ankle, no foot supports until the grounded one is still, and then it does', () => {
    const a = stepUnderLift();
    const before = supportsOf(a, hips, times, secondsOf);
    // Before: the step hands support to the only free foot, the lifted left, held until the right re-plants on frame 12
    // and is 0.02 leg lengths lower for 0.1 s (frames 12–14, taking support from 12: #102).
    expect(sides(before.support)).toBe('rrrrrrrrrrllrrrrrrrrrrrrrrrrrr');
    expect(before.lowered).toBeUndefined();
    const feet = supportsOf(a, hips, times, secondsOf, false, true);
    // The step still releases the right foot (frame 10, re-planted on 12); the lifted left may not take support.
    expect(feet.steps.map((s) => [s.side, s.frames, s.replant, s.to])).toEqual([['r', [10, 11], 12, null]]);
    expect(sides(feet.support)).toBe('rrrrrrrrrr--rrrrrrrrrrrrrrrrrr');
    // Frames 10–11: the lifted leg wins the rule before #113; read from the lower ankle, neither foot is planted.
    for (const i of [10, 11]) {
      expect(before.support[i]).toBe('l');
      expect(feet.support[i]).toBeNull();
      expect(a.r[i]![1] - a.l[i]![1]).toBe(20);
    }
    expect(feet.lowered).toEqual([
      { frames: [10, 11], was: 'l', now: null, cause: 'higher' },
    ]);
    expect(feet.tracked).toEqual([
      { side: 'r', frames: [10, 11] },
    ]);
    // On every frame with a supporting foot, its ankle is the lower one.
    feet.support.forEach((s, i) => {
      if (s !== null) expect(a[s][i]![1]).toBeGreaterThanOrEqual(a[s === 'r' ? 'l' : 'r'][i]![1]);
    });
  });

  test('a supporting foot rising above a lower foot that is released and not yet still: before #113 it is kept; read from the lower ankle it is released after 0.1 s, and the lower foot takes support once it is still', () => {
    const a = liftedOverDrift();
    const before = supportsOf(a, hips, times, secondsOf);
    expect(sides(before.support)).toBe('lllllrrrrrrrrrrrllllllllllllll');
    const feet = supportsOf(a, hips, times, secondsOf, false, true);
    expect(feet.steps.map((s) => [s.side, s.frames, s.replant, s.to])).toEqual([['l', [5, 15], 16, 'r']]);
    // The right is 2.5 px higher from frame 6 (0.02 leg lengths of the 96.06 px mean leg is 1.92 px), so it is released
    // on frame 8; the left re-plants on 16 and is the lower foot, so it takes support there.
    expect(sides(feet.support)).toBe('lllllrrr--------llllllllllllll');
    expect(feet.lowered).toEqual([
      { frames: [8, 15], was: 'r', now: null, cause: 'released' },
    ]);
  });

  test('control: ankles that never cross the margin read as before, and lowered is empty', () => {
    // Both ankles on the floor, the right 1 px lower (under 0.02 leg lengths), nothing moves.
    const a = { r: Array.from({ length: N }, (): Pt => [-10, 101]), l: Array.from({ length: N }, (): Pt => [10, 100]) };
    const before = supportsOf(a, hips, times, secondsOf);
    const feet = supportsOf(a, hips, times, secondsOf, false, true);
    expect(feet.support).toEqual(before.support);
    expect(feet.supports).toEqual([{ side: 'r', frames: [0, N - 1] }]);
    expect(feet.lowered).toEqual([]);
    expect(feet.tracked).toBeUndefined();
  });

  test('in place (#92) the rule does not apply: the reading is #92\'s, and lowered is absent', () => {
    const a = stepUnderLift();
    const inPlace = supportsOf(a, hips, times, secondsOf, true);
    const both = supportsOf(a, hips, times, secondsOf, true, true);
    expect(both).toEqual(inPlace);
    expect(both.lowered).toBeUndefined();
  });

  test('mutant: the rule off (the reading before #113 under the flag) and the first test is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'const { feet, released } = readSupports(ankle, hip, times, secondsOf, false, true);';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'const { feet, released } = readSupports(ankle, hip, times, secondsOf, false, false);'));
      const m = (await import(path)) as { supportsOf: typeof supportsOf };
      const a = stepUnderLift();
      const feet = m.supportsOf(a, hips, times, secondsOf, false, true);
      console.log(`  mutant "rule off": support ${sides(feet.support)}, frames 10–11 ${feet.support[10]}${feet.support[11]}, lowered ${JSON.stringify(feet.lowered)}`);
      // The lifted left supports frames 10–11 again, and nothing is named.
      expect(feet.support[10]).toBe('l');
      expect(feet.support[11]).toBe('l');
      expect(feet.lowered).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('#119: a release followed by frames where only the higher foot is free tracks the lower foot on the floor; mutant following the pose\'s travel is red', async () => {
    const a = stepUnderLift();
    const feet = supportsOf(a, hips, times, secondsOf, false, true);
    expect(feet.tracked).toEqual([{ side: 'r', frames: [10, 11] }]);
    const offset = (i: number, s: Side): Pt => [a[s][i]![0], -a[s][i]![1]];
    // Pose travel dips 25 units down and slides 30 units right on the released frames 10–11.
    const travel = (i: number): Pt => (i >= 10 && i <= 11 ? [30, -25] : [0, 0]);
    const track = (i: number, s: Side): number => a[s][i]![0];
    const p = plantHip(feet, offset, travel, [0, 0], undefined, undefined, track);
    expect(p.floor?.y).toBe(-100);
    // On tracked frames 10–11, the lower foot r stays on the floor (-100) and follows its own ankle track (+5 px from frame 9),
    // not the pose's travel; on frame 12 the normal plant takes over at that position with no vertical step.
    for (const i of [10, 11, 12]) {
      const footX = p.hip[i]![0] + offset(i, 'r')[0];
      const footY = p.hip[i]![1] + offset(i, 'r')[1];
      expect(footY).toBeCloseTo(-100, 9);
      expect(footX - (p.hip[9]![0] + offset(9, 'r')[0])).toBeCloseTo(5, 9);
    }
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'const tr = s === null ? (tracked[i] ?? null) : null;';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'const tr = null;'));
      const m = (await import(path)) as { plantHip: typeof plantHip };
      const mp = m.plantHip(feet, offset, travel, [0, 0], undefined, undefined, track);
      const mutFootY = mp.hip[10]![1] + offset(10, 'r')[1];
      const mutFootX = mp.hip[10]![0] + offset(10, 'r')[0] - (mp.hip[9]![0] + offset(9, 'r')[0]);
      console.log(`  mutant "tracked follows travel": frame 10 lower foot y=${mutFootY.toFixed(2)} (floor -100), dx=${mutFootX.toFixed(2)} (track +5)`);
      expect(mutFootY).toBeCloseTo(-125, 9);
      expect(mutFootX).toBeCloseTo(35, 9);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

