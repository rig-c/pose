/**
 * #87: `--stance` reads its tolerance with hysteresis and absorbs a run shorter
 * than 0.1 s, because a foot cannot take a stance for one frame. The pure
 * `stanceOf` on a synthetic free foot whose height is given frame by frame;
 * the planted mutant (no hysteresis, no absorption) must flicker.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdBlend, STANCE_BOUNDS, STANCE_MIN_SECONDS, STANCE_RELEASE, stanceOf, stanceRangeOf, type Feet, type Stance, type StancePosed } from '../src/legs.ts';
import { stanceLines } from '../src/run.ts';

const ROOT = join(import.meta.dir, '..');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const FPS = 24;
const TOL = 0.07;
/** Picture px per leg length. */
const LEG = 100;

type StanceOf = typeof stanceOf;
type StanceRangeOf = typeof stanceRangeOf;

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

/**
 * #95: the stretch's lower bound comes from the leg's own range. The free (left)
 * foot stands level with the supporting one on every frame (planted both); on
 * frames 30–39 the picture's left leg is folded to `fold` of its straight length
 * (the hip dropped onto a bent knee), and the posed rig needs k = 0.5 there to
 * put the free ankle on the floor.
 */
describe('#95: --stance\'s stretch bound from the leg\'s own range', () => {
  const N = 40;
  const FOLDED = (i: number) => i >= 30;
  function folding(fold: number, range: StanceRangeOf = stanceRangeOf, fn: StanceOf = stanceOf): Stance {
    const feet: Feet = { legLength: { r: LEG, l: LEG }, support: new Array(N).fill('r'), supports: [{ side: 'r', frames: [0, N - 1] }], jumps: [], steps: [], changes: [] };
    const ankle = { r: Array.from({ length: N }, (): [number, number] => [0, 500]), l: Array.from({ length: N }, (): [number, number] => [20, 500]) };
    const hip = { r: Array.from({ length: N }, (): [number, number] => [0, 500 - LEG]), l: Array.from({ length: N }, (_, i): [number, number] => [20, 500 - (FOLDED(i) ? fold : 1) * LEG]) };
    // World, y up: the floor at 0; on the folded frames the hip dropped to 75 and the rig's straight free leg (150) reaches −75, so k = 75 / 150 = 0.5.
    const posed = (i: number): StancePosed => (FOLDED(i) ? { root: { r: [0, 75], l: [20, 75] }, ankle: { r: [0, 0], l: [20, -75] } } : { root: { r: [0, 150], l: [20, 150] }, ankle: { r: [0, 0], l: [20, 0] } });
    const secondsOf = (x: [number, number]) => (x[1] - x[0] + 1) / FPS;
    return fn(feet, ankle, TOL, posed, secondsOf, range(ankle, hip));
  }

  test('a free leg the picture folds to 0.5 plants with k 0.5: nothing past the bounds, and the range stated', () => {
    const st = folding(0.5);
    expect(states(st)).toEqual([['both', 0, 39]]);
    for (let i = 30; i < N; i++) expect(st.stretch[i]).toEqual({ side: 'l', k: 0.5 });
    expect(st.over).toEqual([]);
    expect(st.range).toEqual({ l: 0.5 });
    expect(st.bounds).toEqual(STANCE_BOUNDS);
  });

  test('control: a leg that never folds keeps [0.92, 1.08] — held at 0.92, listed past the bounds, no range', () => {
    const st = folding(1);
    for (let i = 30; i < N; i++) expect(st.stretch[i]).toEqual({ side: 'l', k: 0.92 });
    expect(st.over.map((o) => [o.side, o.frames, o.needed, 'bound' in o])).toEqual([['l', [30, 39], 0.5, false]]);
    expect(st.range).toBeUndefined();
    // A fold above the default (0.95) is no fold: the default stands.
    expect(folding(0.95).range).toBeUndefined();
  });

  test('a fold short of what the floor needs is held at the fold, and listed past it with the bound it had', () => {
    const st = folding(0.7);
    expect(st.stretch[35]).toEqual({ side: 'l', k: 0.7 });
    expect(st.over).toHaveLength(1);
    expect(st.over[0]!.bound).toEqual([0.7, 1.08]);
  });

  test('the blend\'s supporting leg takes the same per-frame bound (#85)', () => {
    const blends = [30, 31, 32].map((frame) => ({ frame, side: 'r' as const, y: 0 }));
    const posed = (): StancePosed => ({ root: { r: [0, 75], l: [20, 75] }, ankle: { r: [0, -75], l: [20, 0] } });
    const lower = { r: new Array<number>(N).fill(0.92).map((x, i) => (i >= 30 ? 0.5 : x)), l: new Array<number>(N).fill(0.92) };
    const h = holdBlend(blends, N, posed, lower);
    expect(h.stretch.slice(30, 33)).toEqual([{ side: 'r', k: 0.5 }, { side: 'r', k: 0.5 }, { side: 'r', k: 0.5 }]);
    expect(h.over).toEqual([]);
    expect(h.range).toEqual({ r: 0.5 });
    // Control: without the leg's range, the default holds it at 0.92.
    const d = holdBlend(blends, N, posed);
    expect(d.stretch[30]).toEqual({ side: 'r', k: 0.92 });
    expect(d.over).toHaveLength(1);
  });

  test('mutant: with the fixed bound the folding leg is held at 0.92, and the fold test is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'Math.min(STANCE_BOUNDS[0], l / straight)';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'STANCE_BOUNDS[0]'));
      const m = (await import(path)) as { stanceOf: StanceOf; stanceRangeOf: StanceRangeOf };
      const st = folding(0.5, m.stanceRangeOf, m.stanceOf);
      console.log(`  mutant "the fixed bound": the folded frames keyed k ${st.stretch[35]!.k}, ${st.over.length} run(s) past the bounds`);
      expect(st.stretch[35]).toEqual({ side: 'l', k: 0.92 });
      expect(st.over).toHaveLength(1);
      // The control still passes on the mutant.
      expect(folding(1, m.stanceRangeOf, m.stanceOf).stretch[35]).toEqual({ side: 'l', k: 0.92 });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * #114: the tolerance is a distance, not a signed gap. A free ankle farther than
 * the tolerance below the supporting one is a support error, not a stance: it is
 * read `below`, never planted both, keeps the pose's height and is named on a
 * STANCE line. One within the tolerance below is planted, its k under 1, as #60
 * intends for a foot slightly under the floor. The planted mutant reads the
 * signed gap (h ≤ tolerance) and plants the far one.
 */
describe('#114: --stance\'s tolerance is a distance', () => {
  /** 0.5 s level, then 0.5 s with the free ankle `h` leg lengths above (negative: below) the supporting one, then 0.5 s level. */
  const DROP = (h: number) => [...flat(12, 0), ...flat(12, h), ...flat(12, 0)];
  const TIMES = Array.from({ length: 36 }, (_, i) => i / FPS);

  test('a free ankle 0.5 leg lengths below the supporting one is read below: not planted, the pose\'s height kept, and named', () => {
    const st = run(DROP(-0.5));
    expect(states(st)).toEqual([['both', 0, 11], ['below', 12, 23], ['both', 24, 35]]);
    expect(st.stretch.slice(12, 24)).toEqual(new Array(12).fill(null));
    expect(st.over).toEqual([]);
    const below = st.runs.find((r) => r.state === 'below')!;
    expect(below.k).toBeNull();
    expect(below.maxDepth).toBeCloseTo(0.5, 9);
    expect(stanceLines(st, TIMES)[1]).toBe('past the tolerance below: free foot l frames 12–23 (t=0.500–0.958s) — its ankle up to 0.5000 leg lengths below the supporting one in the picture, past the tolerance 0.07 leg lengths (planted again under 0.8 of it, 0.0560); a free foot that far below the supporting one is a support error, not a stance: never planted both, the pose\'s height kept');
  });

  test('control: one 0.03 below is planted both, its leg shortened (k under 1)', () => {
    const st = run(DROP(-0.03));
    expect(states(st)).toEqual([['both', 0, 35]]);
    // World: root 150 above the floor, the free ankle 0.03 × 150 = 4.5 under it, so k = 150 / 154.5.
    for (let i = 12; i < 24; i++) expect(st.stretch[i]).toEqual({ side: 'l', k: 150 / 154.5 });
    expect(st.stretch[12]!.k).toBeLessThan(1);
    expect(st.runs.some((r) => r.state === 'below')).toBe(false);
  });

  test('the hysteresis reads |h|: a foot at −tolerance ±1 % stays planted, and one below comes back only under 0.8 of it', () => {
    const hover = [...flat(10, -0.03), ...Array.from({ length: 20 }, (_, i) => -TOL * (i % 2 === 0 ? 1.01 : 0.99)), ...flat(10, -0.03)];
    expect(states(run(hover))).toEqual([['both', 0, 39]]);
    // Below for 0.5 s, then at −0.06 (inside the tolerance, outside 0.8 of it): still below; then at −0.03: planted.
    expect(states(run([...flat(10, 0), ...flat(12, -0.3), ...flat(6, -0.06), ...flat(10, -0.03)]))).toEqual([['both', 0, 9], ['below', 10, 27], ['both', 28, 37]]);
  });

  test('a one-frame dip far below is absorbed and named below; the stance holds through it', () => {
    const st = run([...flat(10, 0), -0.4, ...flat(10, 0)]);
    expect(states(st)).toEqual([['both', 0, 20]]);
    const ab = st.runs.filter((r) => r.absorbed === true);
    expect(ab.map((r) => [r.state, r.frames, r.maxDepth])).toEqual([['below', [10, 10], 0.4]]);
    expect(stanceLines(st, TIMES).find((l) => l.startsWith('absorbed'))).toContain('read past the tolerance below (its ankle up to 0.4000 leg lengths below the supporting one in the picture;');
  });

  test('mutant: reading the signed gap (h ≤ tolerance) plants the ankle 0.5 below, and the distance test is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      let src = readFileSync(path, 'utf8');
      for (const [from, to, count] of [['Math.abs(r0.height) <= tolerance', 'r0.height <= tolerance', 1], ['Math.abs(read[k]!.height)', 'read[k]!.height', 2]] as const) {
        expect(src.split(from)).toHaveLength(count + 1);
        src = src.split(from).join(to);
      }
      writeFileSync(path, src);
      const m = (await import(path)) as { stanceOf: StanceOf };
      const st = run(DROP(-0.5), m.stanceOf);
      console.log(`  mutant "the signed gap": the ankle 0.5 below read ${states(st).map((x) => x.join(' ')).join(', ')}; frame 15 keyed ${JSON.stringify(st.stretch[15])}`);
      expect(states(st)).toEqual([['both', 0, 35]]);
      expect(st.stretch[15]).not.toBeNull();
      // The control still passes on the mutant.
      expect(states(run(DROP(-0.03), m.stanceOf))).toEqual([['both', 0, 35]]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
