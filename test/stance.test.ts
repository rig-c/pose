/**
 * #87: `--stance` reads its tolerance with hysteresis and absorbs a run shorter
 * than 0.1 s, because a foot cannot take a stance for one frame. The pure
 * `stanceOf` on a synthetic free foot whose height is given frame by frame;
 * the planted mutant (no hysteresis, no absorption) must flicker.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STANCE_MIN_SECONDS, STANCE_RELEASE, stanceOf, type Feet, type Stance, type StancePosed } from '../src/legs.ts';

const ROOT = join(import.meta.dir, '..');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const FPS = 24;
const TOL = 0.07;
/** Picture px per leg length. */
const LEG = 100;

type StanceOf = typeof stanceOf;

/** The right foot supports on every frame; the left (free) ankle stands `heights[i]` leg lengths above it. */
function run(heights: readonly number[], fn: StanceOf = stanceOf): Stance {
  const n = heights.length;
  const feet: Feet = { legLength: { r: LEG, l: LEG }, support: new Array(n).fill('r'), supports: [{ side: 'r', frames: [0, n - 1] }], jumps: [], steps: [], changes: [] };
  const ankle = { r: heights.map((): [number, number] => [0, 500]), l: heights.map((h): [number, number] => [20, 500 - h * LEG]) };
  // World, y up: the roots 150 units above the floor; the free ankle at its picture height in world units.
  const posed = (i: number): StancePosed => ({ root: { r: [0, 150], l: [20, 150] }, ankle: { r: [0, 0], l: [20, heights[i]! * 150] } });
  const secondsOf = (x: [number, number]) => (x[1] - x[0] + 1) / FPS;
  return fn(feet, ankle, TOL, posed, secondsOf);
}

const states = (st: Stance) => st.runs.filter((r) => r.absorbed !== true).map((r) => [r.state, r.frames[0], r.frames[1]]);
const flat = (k: number, h: number) => new Array<number>(k).fill(h);
/** 20 frames hovering at the tolerance ±1 %, between planted runs. */
const HOVER = [...flat(10, 0.03), ...Array.from({ length: 20 }, (_, i) => TOL * (i % 2 === 0 ? 1.01 : 0.99)), ...flat(10, 0.03)];
/** A clean lift: 0.5 s (12 frames) at 0.15 leg lengths. */
const CLEAN = [...flat(10, 0.03), ...flat(12, 0.15), ...flat(10, 0.03)];

describe('#87: --stance with hysteresis, and a run shorter than 0.1 s absorbed', () => {
  test('the stated figures', () => {
    expect(STANCE_RELEASE).toBe(0.8);
    expect(STANCE_MIN_SECONDS).toBe(0.1);
  });

  test('a free foot hovering at the tolerance ±1 % for 20 frames stays in one state', () => {
    const st = run(HOVER);
    expect(states(st)).toEqual([['both', 0, 39]]);
    // Each one-frame crossing over the tolerance is listed as absorbed, none kept.
    expect(st.runs.filter((r) => r.absorbed === true).map((r) => r.frames)).toEqual(Array.from({ length: 10 }, (_, k) => [10 + 2 * k, 10 + 2 * k]));
  });

  test('control: a clean 0.5 s lift changes state once, for exactly its frames', () => {
    expect(states(run(CLEAN))).toEqual([['both', 0, 9], ['lifted', 10, 21], ['both', 22, 31]]);
  });

  test('a one-frame crossing (the reference\'s 0.0708 against 0.07) is absorbed: planted both through it, stretched, and listed', () => {
    const h = [...flat(10, 0.0649), 0.0708, ...flat(10, 0.0681)];
    const st = run(h);
    expect(states(st)).toEqual([['both', 0, 20]]);
    const ab = st.runs.filter((r) => r.absorbed === true);
    expect(ab.map((r) => [r.state, r.side, r.frames, r.k])).toEqual([['lifted', 'l', [10, 10], null]]);
    expect(ab[0]!.maxHeight).toBeCloseTo(0.0708, 9);
    expect(st.stretch[10]).not.toBeNull();
  });

  test('a lift past the band for 3 frames (0.125 s) is a lift, not absorbed', () => {
    const st = run([...flat(10, 0.03), ...flat(3, TOL * 1.3), ...flat(10, 0.03)]);
    expect(states(st)).toEqual([['both', 0, 9], ['lifted', 10, 12], ['both', 13, 22]]);
    expect(st.runs.filter((r) => r.absorbed === true)).toEqual([]);
    expect(st.stretch.slice(10, 13)).toEqual([null, null, null]);
  });

  test('mutant: without hysteresis and absorption the hovering foot flickers, and the hover test is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      let src = readFileSync(path, 'utf8');
      for (const [from, to] of [['export const STANCE_RELEASE = 0.8;', 'export const STANCE_RELEASE = 1;'], ['export const STANCE_MIN_SECONDS = 0.1;', 'export const STANCE_MIN_SECONDS = 0;']] as const) {
        expect(src.split(from)).toHaveLength(2);
        src = src.replace(from, to);
      }
      writeFileSync(path, src);
      const m = (await import(path)) as { stanceOf: StanceOf };
      const hover = states(run(HOVER, m.stanceOf));
      console.log(`  mutant "no hysteresis, no absorption": ${hover.length} runs over the hover (${hover.slice(0, 4).map((x) => x.join(' ')).join(', ')}, …)`);
      expect(hover.length).toBeGreaterThan(3);
      expect(states(run([...flat(10, 0.0649), 0.0708, ...flat(10, 0.0681)], m.stanceOf))).toEqual([['both', 0, 9], ['lifted', 10, 10], ['both', 11, 20]]);
      // The control still passes on the mutant: the clean lift is not what the factor is for.
      expect(states(run(CLEAN, m.stanceOf))).toEqual([['both', 0, 9], ['lifted', 10, 21], ['both', 22, 31]]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
