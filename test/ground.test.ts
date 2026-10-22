/**
 * rig-c/pose#379: the ankle's vertical speed (#280) decides a clip's support
 * only where the ground moves in the picture by at least `STILL_SPEED` a frame.
 * The speed reads a foot down on a step within `STILL_SPEED` of its ground
 * speed, and a still ankle steps by 0 — so where the ground itself moves less
 * than that, "with the ground" and "still" are one reading, and the signal
 * plants every still ankle: a heel held on its toe while the other foot lands,
 * a swing foot paused at its apex. Depth drawn as height is exactly a ground
 * that moves (the planted feet slide back in a gait in place, or the hips come
 * down the picture toward a fixed camera), which is what #280's signal exists
 * to read.
 *
 * Held by #280's own fixture drawn under a level camera, with the two things a
 * walk does that a point foot sliding on a floor does not: the ankle rises on
 * its last three down drawings (the heel held on the toe) and the swing holds
 * its apex over both air drawings; read against its contact table and by the
 * foot it must never plant. The planted mutant (the gate removed) makes it red.
 * Two controls hold #280's reading where the ground does move — its fixture as
 * drawn (feet sliding) and the same walk travelling toward the camera (feet
 * fixed, hips drifting), with a mutant for the hips' clause — and one names the
 * limit: a depth clip whose feet slide less than `STILL_SPEED` is read by ankle
 * height, one frame early at each landing.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FRONTAL_DISAGREE, STILL_SPEED, supportsOf, type Contact, type Side } from '../src/legs.ts';
import { signalLines } from '../src/run.ts';

const ROOT = join(import.meta.dir, '..');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
type Pt = [number, number];

// --- the fixture: test/frontal.test.ts's walk, with a heel, a held apex, a level camera and a travelling body as options ---

const FPS = 24;
const DRAWINGS = 8;
const CYCLE = 2 * DRAWINGS;
const CYCLES = 6;
const N = CYCLE * CYCLES;
const FLOOR_Y = 553;
const HIP_Y = 403;
const X: Record<Side, number> = { r: 185, l: 215 };
const LANDS: Record<Side, number> = { r: 0, l: 4 };

interface Walk {
  /** Each foot's depth from front to back as the picture draws it, px (#280's 17 and 23; 0 under a level camera). */
  depth: Record<Side, number>;
  /** The swinging foot's lift on its two air drawings, px (#280's 3 and 2; equal values hold the apex over both). */
  lift: [number, number];
  /** The ankle's rise on the last three down drawings, px: the heel held on its toe (0: a point foot on the floor). */
  heel: number;
  /** The body travels toward a fixed camera: the planted feet stay, the hips come down the picture by the stride's depth a cycle. */
  travelling: boolean;
}
const C280: Walk = { depth: { r: 17, l: 23 }, lift: [3, 2], heel: 0, travelling: false };

const phaseOf = (s: Side, k: number): number => (((k - LANDS[s]) % DRAWINGS) + DRAWINGS) % DRAWINGS;
const downOn = (s: Side, k: number): boolean => phaseOf(s, k) <= 5;

function drawn(w: Walk, s: Side, k: number): Pt {
  const j = phaseOf(s, k);
  const z = j <= 5 ? j / 5 : (DRAWINGS - j) / 3;
  const lift = j === 6 ? w.lift[0] : j === 7 ? w.lift[1] : 0;
  const heel = j >= 3 && j <= 5 ? w.heel : 0;
  return [X[s], FLOOR_Y - w.depth[s] * z - lift - heel];
}

/** The ankles and hips on every frame, the contact table, and per frame the foot in the air (null on a double support). */
function walk(w: Walk): { ankle: Record<Side, Pt[]>; hip: Record<Side, Pt[]>; table: Contact[]; air: Array<Side | null> } {
  const ankle = { r: [] as Pt[], l: [] as Pt[] };
  const hip = { r: [] as Pt[], l: [] as Pt[] };
  const table: Contact[] = [];
  const air: Array<Side | null> = [];
  // Travelling: the ground is still, so the slide the in-place drawing gives the planted feet is given to the body instead.
  const slide = w.travelling ? (w.depth.r + w.depth.l) / 2 / (2 * 5) : 0;
  for (let i = 0; i < N; i++) {
    const k = Math.floor((i % CYCLE) / 2);
    const between = i % 2 === 1;
    const down = {} as Record<Side, boolean>;
    let up: Side | null = null;
    for (const s of ['r', 'l'] as const) {
      const a = drawn(w, s, k);
      const b = drawn(w, s, k + 1);
      const y = (between ? (a[1] + b[1]) / 2 : a[1]) + slide * i;
      ankle[s].push([X[s], y]);
      hip[s].push([X[s], HIP_Y + slide * i]);
      down[s] = between ? downOn(s, k) && downOn(s, k + 1) : downOn(s, k);
      if (!down[s]) up = s;
    }
    table.push(down.r && down.l ? 'both' : down.r ? 'r' : down.l ? 'l' : null);
    air.push(up);
  }
  return { ankle, hip, table, air };
}

const times = Array.from({ length: N }, (_, i) => i / FPS);
const secondsOf = (x: [number, number]) => (x[1] - x[0] + 1) / FPS;
const agrees = (support: Side | null, table: Contact): boolean => support !== null && (table === support || table === 'both');
const notDown = (support: ReadonlyArray<Side | null>, table: Contact[]): number[] => table.map((t, i) => (agrees(support[i] ?? null, t) ? -1 : i)).filter((i) => i >= 0);
const inAir = (support: ReadonlyArray<Side | null>, air: Array<Side | null>): number[] => air.map((u, i) => (u !== null && support[i] === u ? i : -1)).filter((i) => i >= 0);

/** A copy of `src/` with one line of legs.ts replaced, imported fresh. */
async function mutant(from: string, to: string): Promise<{ supportsOf: typeof supportsOf; dir: string }> {
  mkdirSync(MUTANTS, { recursive: true });
  const dir = mkdtempSync(join(MUTANTS, 'm379-'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  const path = join(dir, 'src', 'legs.ts');
  const src = readFileSync(path, 'utf8');
  expect(src.split(from)).toHaveLength(2);
  writeFileSync(path, src.replace(from, to));
  const m = (await import(path)) as { supportsOf: typeof supportsOf };
  return { supportsOf: m.supportsOf, dir };
}

/** The walk this card was measured on, in the fixture's proportions: the heel held on its toe raises the ankle a twelfth of the leg, the apex is a sixth up and held, no depth. */
const HEEL_AND_APEX: Walk = { depth: { r: 0, l: 0 }, lift: [24, 24], heel: 12, travelling: false };

describe('#379: a level-camera walk — the ground does not move, so the vertical speed does not decide', () => {
  test('the fixture: ankle height reads the contact table on all 96 frames and never plants the foot in the air; the clip contradicts past 5 % but is not read as frontal, and the support line says why', () => {
    const { ankle, hip, table, air } = walk(HEEL_AND_APEX);
    const feet = supportsOf(ankle, hip, times, secondsOf, true);
    const sig = feet.signal!;
    const Lm = (feet.legLength.r + feet.legLength.l) / 2;
    console.log(`  #379 level walk: heel ${(HEEL_AND_APEX.heel / Lm).toFixed(3)} L, apex ${(HEEL_AND_APEX.lift[0] / Lm).toFixed(3)} L; contradict ${sig.contradict.length} of ${sig.read}; ground r ${(sig.ground.r / feet.legLength.r).toFixed(4)} l ${(sig.ground.l / feet.legLength.l).toFixed(4)}, hips ${(sig.hipStep / Lm).toFixed(4)} L a frame; spans ${feet.supports.length}`);
    expect(sig.contradict.length).toBeGreaterThan(FRONTAL_DISAGREE * sig.read);
    expect(sig.groundResolved).toBe(false);
    expect(sig.frontal).toBe(false);
    expect(sig.by.every((b) => b === 'height')).toBe(true);
    expect(notDown(feet.support, table)).toEqual([]);
    expect(inAir(feet.support, air)).toEqual([]);
    expect(feet.supports).toHaveLength(2 * CYCLES);
    const lines = signalLines(sig, feet.supports);
    console.log(`  #379 run:\n    FEET   ${lines.join('\n    FEET   ')}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`support: ankle height — vertical speed contradicts it on 12 of 96 frame(s) (12.5 %, past 5 %) but the ground moves under ${STILL_SPEED} leg lengths a frame (feet 0.00 · 0.00 px, hips 0.00): a still ankle reads as ground, so it cannot decide (rig-c/pose#379)`);
    expect(`  FEET   ${lines[0]}`.length).toBeLessThanOrEqual(260);
  });

  test('mutant: the gate removed — the vertical speed decides, plants the held apex on 24 frames, and fragments support to three spans a step; the test above is red', async () => {
    const { supportsOf: m, dir } = await mutant('const decides = frontal && groundResolved;', 'const decides = frontal;');
    try {
      const { ankle, hip, table, air } = walk(HEEL_AND_APEX);
      const feet = m(ankle, hip, times, secondsOf, true);
      const wrong = inAir(feet.support, air);
      console.log(`  #379 mutant "gate removed": frontal ${feet.signal!.frontal}; the foot in the air supported on ${wrong.length} frame(s): ${wrong.slice(0, 6).join(', ')}, …; spans ${feet.supports.length}`);
      expect(feet.signal!.frontal).toBe(true);
      expect(wrong).toHaveLength(24);
      expect(wrong.slice(0, 4)).toEqual([4, 5, 12, 13]);
      expect(notDown(feet.support, table)).toEqual(wrong);
      expect(feet.supports).toHaveLength(6 * CYCLES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#379: where the ground moves, #280\'s reading stands', () => {
  test('#280\'s fixture as drawn: the planted feet slide past the stillness tolerance on both sides, the clip is frontal, 0 contact mismatches', () => {
    const { ankle, hip, table } = walk(C280);
    const feet = supportsOf(ankle, hip, times, secondsOf, true);
    const sig = feet.signal!;
    console.log(`  #280 as drawn: ground r ${(sig.ground.r / feet.legLength.r).toFixed(4)} l ${(sig.ground.l / feet.legLength.l).toFixed(4)} L a frame against ${STILL_SPEED}`);
    for (const s of ['r', 'l'] as const) expect(Math.abs(sig.ground[s])).toBeGreaterThanOrEqual(STILL_SPEED * feet.legLength[s]);
    expect(sig.groundResolved).toBe(true);
    expect(sig.frontal).toBe(true);
    expect(table.filter((t, i) => sig.contact[i] !== t)).toHaveLength(0);
    expect(notDown(feet.support, table)).toEqual([]);
    expect(feet.supports).toHaveLength(2 * CYCLES);
  });

  test('the same walk travelling toward a fixed camera: the feet stay and the hips come down the picture; the clip is frontal by the hips, 0 contact mismatches', () => {
    const { ankle, hip, table } = walk({ ...C280, travelling: true });
    const feet = supportsOf(ankle, hip, times, secondsOf, false, true);
    const sig = feet.signal!;
    const Lm = (feet.legLength.r + feet.legLength.l) / 2;
    console.log(`  #280 travelling: ground r ${(sig.ground.r / feet.legLength.r).toFixed(4)} l ${(sig.ground.l / feet.legLength.l).toFixed(4)}, hips ${(sig.hipStep / Lm).toFixed(4)} L a frame against ${STILL_SPEED}`);
    for (const s of ['r', 'l'] as const) expect(Math.abs(sig.ground[s])).toBeLessThan(STILL_SPEED * feet.legLength[s]);
    expect(Math.abs(sig.hipStep)).toBeGreaterThanOrEqual(STILL_SPEED * Lm);
    expect(sig.groundResolved).toBe(true);
    expect(sig.frontal).toBe(true);
    expect(table.filter((t, i) => sig.contact[i] !== t)).toHaveLength(0);
    expect(notDown(feet.support, table)).toEqual([]);
    expect(feet.supports).toHaveLength(2 * CYCLES);
  });

  test('mutant: the hips\' clause removed — the travelling walk falls to ankle height, which plants a foot in the air on 5 frames; the test above is red', async () => {
    const { supportsOf: m, dir } = await mutant('const groundResolved = feetResolved || hipResolved;', 'const groundResolved = feetResolved;');
    try {
      const { ankle, hip, table } = walk({ ...C280, travelling: true });
      const feet = m(ankle, hip, times, secondsOf, false, true);
      const wrong = notDown(feet.support, table);
      console.log(`  #379 mutant "no hips": frontal ${feet.signal!.frontal}; a foot in the air read as support on ${wrong.length} frame(s): ${wrong.slice(0, 6).join(', ')}, …`);
      expect(feet.signal!.frontal).toBe(false);
      expect(wrong).toHaveLength(5);
      expect(wrong.slice(0, 2)).toEqual([16, 32]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the limit, named: a depth clip whose feet slide less than the tolerance (13 px a stride, 0.0091 L a frame) is read by ankle height — one frame early at each landing after the first, 11 of 96', () => {
    const { ankle, hip, table } = walk({ ...C280, depth: { r: 13, l: 13 } });
    const feet = supportsOf(ankle, hip, times, secondsOf, true);
    const sig = feet.signal!;
    const wrong = notDown(feet.support, table);
    console.log(`  #379 limit: ground r ${(sig.ground.r / feet.legLength.r).toFixed(4)} l ${(sig.ground.l / feet.legLength.l).toFixed(4)} L a frame; ankle height plants a foot in the air on ${wrong.length} frame(s): ${wrong.slice(0, 4).join(', ')}, …`);
    for (const s of ['r', 'l'] as const) expect(Math.abs(sig.ground[s])).toBeLessThan(STILL_SPEED * feet.legLength[s]);
    expect(sig.contradict.length).toBeGreaterThan(FRONTAL_DISAGREE * sig.read);
    expect(sig.frontal).toBe(false);
    expect(wrong).toHaveLength(11);
    expect(wrong.slice(0, 2)).toEqual([7, 15]);
  });
});
