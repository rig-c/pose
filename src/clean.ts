/**
 * `rig-pose clean` (rig-c/pose#67): the sequence-cleaning step every sequence
 * passes through before `retarget`. A pose model reads each frame alone, so a
 * hanging wrist moves ±20 px a frame and a cloak-hidden leg jumps 100+ px; this
 * removes that once, at the sequence, where others can inspect the result.
 *
 * Five steps, in this order, each on one person's joints:
 *
 * 1. **Spikes.** A joint more than `SPIKE_TRUNKS` (0.2) trunk lengths from its
 *    `SPIKE_WINDOW`-frame (5) median takes the median. The trunk is neck →
 *    mid_hip (the hips' midpoint), the median of its picture length over the
 *    frames where all three have a position. Every replacement is listed by
 *    frame and joint. Without `loop`, a frame whose window a clip end cuts
 *    (the first and last two) is not tested, and is listed as untested: on a
 *    cut window the median is a neighbour's value, so a joint moving steadily
 *    would read as a spike there. Reflecting the window at the end does not
 *    help — the median of [x2, x1, x0, x1, x2] is still x1.
 * 2. **Occlusion.** A joint whose state is not `observed`, or whose score is
 *    under `OCCLUSION_SCORE` (0.3), takes its `OCCLUSION_WINDOW`-frame (3)
 *    median.
 * 3. **Smoothing.** A quadratic Savitzky–Golay per joint: the legs (`LEGS`:
 *    both hips, knees and ankles) over `legs` frames, every other joint over
 *    `rest`. A window of 1 is none.
 * 4. **Floor.** With `loop` only: the whole figure is moved in y by one
 *    constant, so the lowest ankle over the cycle (the largest y of either
 *    ankle on any frame) is at its height before smoothing. A loop is also
 *    written with `travel: "in-place"` (rig-c/pose#92): one cycle of a gait,
 *    repeated, does not travel, whatever its supporting foot does in the
 *    picture.
 * 5. **Hold** (#91, unless `hold` is "off"). A joint that has stopped is
 *    written at one position: detector noise on a still joint is not motion.
 *    `holdStill` below states the test and the write.
 *
 * What a median is here: per coordinate (x and y apart), over the frames of the
 * window on which the joint has a position — its own frame included, any state.
 * An even count takes the mean of the middle two. The windows are centred; with
 * `loop` they wrap (the sequence is one cycle, its last frame followed by its
 * first), without it they are cut at the ends. The medians read the step's
 * input, never a value the same step already replaced.
 *
 * What is never invented: a joint with no position on a frame (`missing`, or a
 * frame the person is absent from) gets none here. It has nothing to take a
 * median of on its own frame, and a value made from its neighbours would be a
 * guess; `retarget` holds it, and says so with a HOLD line. A joint's state and
 * score are the detector's and are written as they were read: this step moves
 * positions only — with one stated exception, `hipsInferred` below.
 *
 * `hipsInferred` (rig-c/pose#63, `--hips-inferred`): after the steps, r_hip
 * and l_hip are marked `inferred` on every frame where they have a position,
 * and the record says who said so (`{ by: 'declared' }`, the person running
 * clean). Positions and scores are not touched by it, so retarget's keys are
 * the same with and without it; what changes is POSTURE, which does not read a
 * hip tilt off inferred hips. The occlusion step reads `inferred` as it reads
 * `observed`: a cleaned file cleaned again moves its hips the same way.
 *
 * The smoothing fits the frames of the window where the joint has a position;
 * where fewer than three are there, the polynomial's degree drops to fit the
 * ones that are (two give a line, one returns the frame's own value).
 *
 * Jitter, the step's figure, is the mean |second difference| of y, in px/f²,
 * over every joint and every three consecutive frames on which it has a
 * position (wrapping with `loop`), before (the sequence as read) and after
 * (the cleaned positions, before the writer rounds them to 0.01 px).
 *
 * Pure: no clock, no randomness, no disk.
 */
import { BODY18, type Body18 } from './joints.ts';
import type { CleanRecord, CleanSeam, CleanSpike, CleanUnheld, Joint, PoseSequence } from './pose.ts';

/** A joint not held inside a region where others are (#91): the test it fails there and its figure. */
export type Unheld = CleanUnheld;
/** Two holds of one joint back to back (#91): the second's first frame, and the step between their medians. */
export type Seam = CleanSeam;
import { CLEAN_SPEC, personTrack, sortedJoints, TRAVEL_IN_PLACE } from './pose.ts';
import { Problems } from './problems.ts';

/** A spike is a joint this many trunk lengths or more from its median. */
export const SPIKE_TRUNKS = 0.2;
/** The spike median's window, in frames. */
export const SPIKE_WINDOW = 5;
/** The occlusion median's window, in frames. */
export const OCCLUSION_WINDOW = 3;
/** A joint scored under this is treated as occluded. */
export const OCCLUSION_SCORE = 0.3;
/** The joints smoothed over `legs`; every other joint is smoothed over `rest`. */
export const LEGS: readonly Body18[] = ['r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle'];
/** The polynomial's degree. */
const ORDER = 2;
/** The stillness hold (#91): a joint's speed, trunk lengths per frame, under which a frame can be still (`--hold-speed`). */
export const HOLD_SPEED = 0.015;
/** The stillness hold: how far, in trunk lengths, a joint may lie from its span median (`--hold-reach`). */
export const HOLD_REACH = 0.03;
/** The shortest hold, seconds: the first frame's time to the end of the last. */
export const HOLD_MIN_SECONDS = 0.5;
/** The frames before a hold over which the positions blend into it. */
export const HOLD_BLEND = 6;
/** The longest excursion inside a hold (#108), frames: a run over the reach that is kept while the span around it stays held. */
export const HOLD_EXCURSION = 6;
/** The speed's median window, frames. */
export const HOLD_SPEED_WINDOW = 5;

export interface CleanParams {
  /** The sequence is one cycle: every window wraps, and the floor is re-pinned. */
  loop: boolean;
  /** Savitzky–Golay window over the legs, frames: 1 (none), or odd and ≥ 5. */
  legs: number;
  /** Savitzky–Golay window over every other joint, frames: 1 (none), or odd and ≥ 5. */
  rest: number;
  /** Mark r_hip and l_hip `inferred` wherever they have a position (#63): the person running clean declares it. */
  hipsInferred?: boolean;
  /**
   * The stillness hold (#91): its thresholds, or "off". Absent, the step is not
   * run and the record does not name it (a caller written before #91); the CLI
   * always passes one.
   */
  hold?: { speed: number; reach: number } | 'off';
}

/** The joints `--hips-inferred` marks. */
export const HIPS: readonly Body18[] = ['r_hip', 'l_hip'];

export type Pt = [number, number];
/** One joint's positions over the frames; null where it has none. */
export type Series = Array<Pt | null>;

export interface SpikeFound extends CleanSpike {
  /** Its distance from the median, px. */
  off: number;
}
export interface Occluded {
  joint: Body18;
  frame: number;
  /** How far the median moved it, px. */
  moved: number;
  why: string;
}
export interface Floor {
  /** The lowest ankle's y before smoothing, and after, px. */
  before: number;
  after: number;
  /** The y every joint was moved by, px. */
  shift: number;
}

export interface HoldFound {
  joint: Body18;
  /** The span, inclusive. */
  frames: [number, number];
  /** A short run inside the span that left the reach and was kept, not held (#108); null when every frame was held. */
  excursion: [number, number] | null;
  /** First frame's time to the end of the last, seconds. */
  seconds: number;
  /** The joint's largest 5-frame median speed on the span, trunk lengths per frame. */
  speed: number;
  /** Its largest distance from its span median, trunk lengths. */
  reach: number;
  /** The frames blended in before it and out after it, inclusive; null where there are none. */
  blendIn: [number, number] | null;
  blendOut: [number, number] | null;
  /** The joint's jitter over the triples inside the span, px/f²: cleaned, and held. */
  jitter: { before: number | null; after: number | null };
}

export interface Cleaned {
  seq: PoseSequence;
  record: CleanRecord;
  person: string;
  /** Neck → mid_hip, the median picture length, px, and over how many frames. */
  trunk: { length: number; frames: number };
  spikes: SpikeFound[];
  occluded: Occluded[];
  /** Joints without a position on some frames, as runs: left without one. */
  missing: Array<{ joint: Body18; from: number; to: number }>;
  /** The frames the spike step did not test (a clip end cuts their window). */
  untested: number[];
  /** With loop, where an ankle exists; else null. */
  floor: Floor | null;
  /** How many (joint, three-frame) runs the jitter was read over: before, after. */
  triples: number;
  /** With `hipsInferred`: how many joint-frames were marked `inferred`, per hip. */
  inferred: { r_hip: number; l_hip: number } | null;
  /** The stillness holds (#91), one per joint and span, in frame then body-18 order; empty when none was found or the step is off or not run. */
  holds: HoldFound[];
  /** The joints not held inside a region where others are, with the test each fails there. */
  unheld: Unheld[];
  /** Back-to-back holds of one joint, cross-faded, in frame then body-18 order. */
  seams: Seam[];
}

/**
 * The windows `clean` accepts: 1, or odd and ≥ 5. A window of 3 is refused:
 * a quadratic fitted through 3 points passes through all three, so it would
 * change nothing (and at the ends the window cut to 2 frames is a line through
 * both). An even window has no centre frame.
 */
export function windowProblem(flag: string, n: number): string | null {
  if (!Number.isInteger(n) || n < 1) return `${flag} is "${n}"; it must be 1 (none) or an odd whole number ≥ 5`;
  if (n === 3) return `${flag} is "3"; a quadratic fitted through 3 points passes through all three, so a window of 3 changes nothing — it must be 1 (none) or an odd whole number ≥ 5`;
  if (n % 2 === 0) return `${flag} is "${n}"; an even window has no centre frame — it must be 1 (none) or an odd whole number ≥ 5`;
  return null;
}

/** The frame offsets of a centred window at frame i over n frames: wrapped with loop, cut at the ends without. */
function windowAt(i: number, n: number, size: number, loop: boolean): number[] {
  const h = size >> 1;
  const out: number[] = [];
  for (let u = -h; u <= h; u++) {
    const j = i + u;
    if (loop) out.push(((j % n) + n) % n);
    else if (j >= 0 && j < n) out.push(j);
  }
  return out;
}

function median1(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The per-coordinate median of a joint's positions over the window around i; null when it has none there. */
export function medianAt(xs: Series, i: number, size: number, loop: boolean): Pt | null {
  const pts = windowAt(i, xs.length, size, loop).map((j) => xs[j]).filter((p): p is Pt => p !== null && p !== undefined);
  if (pts.length === 0) return null;
  return [median1(pts.map((p) => p[0])), median1(pts.map((p) => p[1]))];
}

/** Whether the spike step tests frame i: under loop always; without it, only where no clip end cuts the window. */
export function testedAt(i: number, n: number, loop: boolean, size = SPIKE_WINDOW): boolean {
  const h = size >> 1;
  return loop ? n >= size : i - h >= 0 && i + h < n;
}

/**
 * Spikes on one joint: every frame where it lies more than `limit` px from its
 * `size`-frame median (read from `xs`, not from a replaced value). Returns the
 * frames, each with its median and distance; `xs` is not changed.
 */
export function spikesOf(xs: Series, limit: number, loop: boolean, size = SPIKE_WINDOW): Array<{ frame: number; at: Pt; off: number }> {
  const out: Array<{ frame: number; at: Pt; off: number }> = [];
  xs.forEach((p, i) => {
    if (p === null || !testedAt(i, xs.length, loop, size)) return;
    const m = medianAt(xs, i, size, loop)!;
    const off = Math.hypot(p[0] - m[0], p[1] - m[1]);
    if (off > limit) out.push({ frame: i, at: m, off });
  });
  return out;
}

/**
 * Savitzky–Golay, centred: at each frame with a position, the least-squares
 * polynomial of degree `ORDER` (2) through the window's frames that have one,
 * read at that frame. With `loop` the window wraps; without it, it is cut at
 * the ends. Fewer than three points drop the degree to fit them exactly. A
 * polynomial of degree ≤ 2 passes through unchanged; a window of 1 is the input.
 */
export function savitzkyGolay(xs: Series, window: number, loop: boolean): Series {
  if (window <= 1) return xs.map((p) => (p === null ? null : [p[0], p[1]]));
  const n = xs.length;
  const h = window >> 1;
  const cache = new Map<string, number[]>();
  return xs.map((p, i) => {
    if (p === null) return null;
    const us: number[] = [];
    const at: Pt[] = [];
    for (let u = -h; u <= h; u++) {
      let j = i + u;
      if (loop) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      const q = xs[j];
      if (q === null || q === undefined) continue;
      us.push(u);
      at.push(q);
    }
    const key = us.join(',');
    let w = cache.get(key);
    if (w === undefined) {
      w = sgWeights(us, Math.min(ORDER, us.length - 1));
      cache.set(key, w);
    }
    let x = 0;
    let y = 0;
    w.forEach((c, k) => {
      x += c * at[k]![0];
      y += c * at[k]![1];
    });
    return [x, y];
  });
}

/** The weights that read a least-squares polynomial of degree q over the offsets `us` at offset 0. */
function sgWeights(us: readonly number[], q: number): number[] {
  const m = q + 1;
  // Normal equations: A[j][l] = Σ u^(j+l); solve A z = e0, then w(u) = Σ z_j u^j.
  const A = Array.from({ length: m }, (_, j) => Array.from({ length: m + 1 }, (_, l) => {
    if (l === m) return j === 0 ? 1 : 0;
    let s = 0;
    for (const u of us) s += u ** (j + l);
    return s;
  }));
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let l = c; l <= m; l++) A[r]![l]! -= f * A[c]![l]!;
    }
  }
  const z = A.map((row, j) => row[m]! / row[j]!);
  return us.map((u) => z.reduce((s, zj, j) => s + zj * u ** j, 0));
}

/** Mean |second difference| of y, px/f², over every series and every three consecutive frames with a position (wrapping with loop). */
export function jitterOf(all: readonly Series[], loop: boolean): { value: number | null; triples: number } {
  let sum = 0;
  let count = 0;
  for (const xs of all) {
    const n = xs.length;
    for (let i = 0; i < n; i++) {
      if (!loop && (i === 0 || i === n - 1)) continue;
      if (loop && n < 3) continue;
      const a = xs[(i - 1 + n) % n];
      const b = xs[i];
      const c = xs[(i + 1) % n];
      if (a === null || b === null || c === null || a === undefined || b === undefined || c === undefined) continue;
      sum += Math.abs(c[1] - 2 * b[1] + a[1]);
      count++;
    }
  }
  return { value: count === 0 ? null : sum / count, triples: count };
}

/**
 * The stillness hold (#91), on the cleaned positions (after the smoothing and
 * the floor), joint by joint — except the face (`FACE`: nose, eyes, ears, #109),
 * which is held as one group (all of them or none, over the span where all of
 * them pass), so a piecewise hold does not turn the head.
 *
 * A joint's speed on frame i is its movement from frame i − 1 in trunk lengths
 * (wrapping with `loop`; none where either frame has no position), taken as a
 * `HOLD_SPEED_WINDOW`-frame (5) median. The joint is still on a frame where it
 * has a position and a median speed under `speed` (no speed in its window is
 * not still: its speed is not known).
 *
 * A hold of a joint is a span of its still frames lasting at least
 * `HOLD_MIN_SECONDS` (first frame's time to the end of the last) over which it
 * stays within `reach` trunk lengths of its own per-coordinate span median. The
 * span is chosen greedily, left to right, inside each run of still frames:
 * from a start it grows one frame at a time while the reach holds on the grown
 * span (its median re-read each time) and stops at the first frame that breaks
 * it; if what it reached lasts long enough it is a hold and the next start is
 * the frame after it, else the start moves one frame on. A still run not held
 * by that greedy pass that lasts at least `HOLD_MIN_SECONDS` and fails `reach`
 * only on one interior run of at most `HOLD_EXCURSION` (6) frames stays held
 * around that excursion (#108), provided the held frames themselves last at
 * least `HOLD_MIN_SECONDS` and stay within `reach` of their own median; the
 * excursion's frames blend from their cleaned positions toward the span median
 * over the `HOLD_BLEND` frames from either held side. A span never crosses the
 * loop's seam.
 *
 * On every held frame of a hold the joint takes its span median. It blends in over
 * the `HOLD_BLEND` (6) frames before (p + w (held − p), w = (6 − k)/6 on the
 * k-th frame before: the 6th stays as cleaned, the frame before is 5/6 of the
 * way) and out over the 6 frames after, mirrored (the frame after is 5/6 of the
 * way, the 6th after stays as cleaned). A blend frame outside the clip, or
 * inside another hold of the same joint, is not touched; where two blends of
 * the same joint meet, the frame takes the one with the larger weight (the
 * earlier hold on a tie). No position is invented: a joint without one on a
 * frame stays without one.
 *
 * A seam is two holds of a joint meeting: the first ending on frame k and the
 * next starting on k + 1 + g, with a gap of g < `HOLD_BLEND` frames between
 * them (0 when they are back to back). Their medians differ, and stepping from
 * one to the other across a frame or a short gap would be a jump. The seam
 * cross-fades over `HOLD_BLEND` + g frames, symmetric about the gap's centre:
 * frames k − 2 … k + 3 + g take m₁ + w (m₂ − m₁) with w = (2j + 1)/(2(6 + g))
 * on the j-th of them (for g = 0: 1/12, 3/12, … 11/12, the blend's 1/6 steps
 * placed symmetric about the seam), so no frame moves more than 1/(6 + g) of the
 * step. The cross-fade is written after the blends, so it replaces them on the
 * gap's frames; a frame outside the two holds and the gap is not touched, nor a
 * frame without a position; where two seams' frames meet (a hold of under 6
 * frames between them), the later seam is written last. Each seam is recorded
 * with the joint, the second hold's first frame, the step |m₂ − m₁| in trunk
 * lengths and the gap.
 *
 * A hold that carries a cross-fade's frames has a non-zero jitter after: the
 * ramp's own curvature, not noise. The lines say "ramp" beside it.
 *
 * Where joints are held, the others are read too, so the lines can say why
 * they were not: the frames any held span covers are joined into regions
 * (overlapping or touching spans), and every run of a region's frames on which
 * a joint has a position and no hold of its own is named with the test it
 * fails over that run — `speed` (its largest median speed there, null where
 * its speed is not known on some frame), else `reach` (its largest distance
 * from its median over the run), else `short` (it passes both, and the run
 * lasts under `HOLD_MIN_SECONDS`; the figure is its seconds), else `span` (it
 * passes all three over the run, and its greedy spans broke elsewhere; the
 * figure is its reach).
 */
/** The face joints (#109): held as one group (all of them or none, over the span where all of them pass), so a piecewise hold does not turn the head. */
export const FACE: readonly Body18[] = ['nose', 'r_eye', 'l_eye', 'r_ear', 'l_ear'];

export function holdStill(series: ReadonlyMap<Body18, Series>, times: readonly number[], trunk: number, speed: number, reach: number, loop: boolean, minSeconds = HOLD_MIN_SECONDS): { held: Map<Body18, Series>; holds: HoldFound[]; unheld: Unheld[]; seams: Seam[] } {
  const n = times.length;
  const names = BODY18.filter((name) => series.has(name));
  const endOf = (i: number): number => (i + 1 < n ? times[i + 1]! : n > 1 ? 2 * times[i]! - times[i - 1]! : times[i]!);
  const secondsOf = (a: number, b: number): number => Math.round((endOf(b) - times[a]!) * 1e6) / 1e6;
  const med = new Map<Body18, Array<number | null>>();
  const stillByJoint = new Map<Body18, boolean[]>();
  for (const name of names) {
    const xs = series.get(name)!;
    const v: Array<number | null> = xs.map((p, i) => {
      if (p === null || n < 2) return null;
      if (!loop && i === 0) return null;
      const q = xs[(i - 1 + n) % n];
      if (q === null || q === undefined) return null;
      return Math.hypot(p[0] - q[0], p[1] - q[1]) / trunk;
    });
    const sp = v.map((_, i) => {
      const w = windowAt(i, n, HOLD_SPEED_WINDOW, loop).map((j) => v[j]).filter((x): x is number => x !== null && x !== undefined);
      return w.length === 0 ? null : median1(w);
    });
    med.set(name, sp);
    stillByJoint.set(name, xs.map((p, i) => p !== null && sp[i] !== null && sp[i] !== undefined && sp[i]! < speed));
  }
  /** One joint's distance (largest) from its per-coordinate median over a..b, trunk lengths, and that median; null where it has no position there. */
  const spanOf = (name: Body18, a: number, b: number): { reach: number; at: Pt } | null => {
    const s = series.get(name);
    if (s === undefined) return null;
    const pts = s.slice(a, b + 1).filter((p): p is Pt => p !== null);
    if (pts.length === 0) return null;
    const m: Pt = [median1(pts.map((p) => p[0])), median1(pts.map((p) => p[1]))];
    let worst = 0;
    for (const p of pts) worst = Math.max(worst, Math.hypot(p[0] - m[0], p[1] - m[1]) / trunk);
    return { reach: worst, at: m };
  };
  const held = new Map<Body18, Series>();
  const holds: HoldFound[] = [];
  const seams: Seam[] = [];
  for (const name of names) {
    const xs = series.get(name)!;
    const sp = med.get(name)!;
    // #109: the face joints (nose, eyes, ears) are held as one group — all of them or none, over the span where all of them pass.
    const group: readonly Body18[] = FACE.includes(name) ? FACE : [name];
    const still = Array.from({ length: n }, (_, i) => group.every((g) => stillByJoint.get(g)?.[i] === true));
    const spans: Array<{ a: number; b: number; exc: [number, number] | null }> = [];
    let s = 0;
    while (s < n) {
      if (!still[s]) {
        s++;
        continue;
      }
      let e = s;
      while (e + 1 < n && still[e + 1] && group.every((g) => spanOf(g, s, e + 1)!.reach <= reach)) e++;
      if (secondsOf(s, e) >= minSeconds - 1e-9) {
        spans.push({ a: s, b: e, exc: null });
        s = e + 1;
      } else s++;
    }
    // #108: a still run not held above that fails the reach only on one interior run of ≤ HOLD_EXCURSION frames
    // stays held around that excursion, provided the held frames themselves last ≥ minSeconds and stay within reach.
    const coveredByPass1 = (i: number) => spans.some((x) => i >= x.a && i <= x.b);
    let u = 0;
    while (u < n) {
      if (!still[u] || coveredByPass1(u)) {
        u++;
        continue;
      }
      let v = u;
      while (v + 1 < n && still[v + 1] && !coveredByPass1(v + 1)) v++;
      if (secondsOf(u, v) >= minSeconds - 1e-9) {
        const ats = new Map(group.map((g) => [g, spanOf(g, u, v)!.at]));
        let e0 = -1;
        let e1 = -1;
        let single = true;
        for (let i = u; i <= v; i++) {
          const over = group.some((g) => {
            const p = series.get(g)![i]!;
            const at = ats.get(g)!;
            return Math.hypot(p[0] - at[0], p[1] - at[1]) / trunk > reach;
          });
          if (over) {
            if (e0 === -1) e0 = i;
            else if (i > e1 + 1) {
              single = false;
              break;
            }
            e1 = i;
          }
        }
        if (single && e0 > u && e1 < v && e1 - e0 + 1 <= HOLD_EXCURSION && secondsOf(u, e0 - 1) + secondsOf(e1 + 1, v) >= minSeconds - 1e-9) {
          const ok = group.every((g) => {
            const kept = series.get(g)!.slice(u, v + 1).filter((p, k): p is Pt => p !== null && (u + k < e0 || u + k > e1));
            const km: Pt = [median1(kept.map((p) => p[0])), median1(kept.map((p) => p[1]))];
            return kept.every((p) => Math.hypot(p[0] - km[0], p[1] - km[1]) / trunk <= reach);
          });
          if (ok) spans.push({ a: u, b: v, exc: [e0, e1] });
        }
      }
      u = v + 1;
    }
    spans.sort((x, y) => x.a - y.a);
    const out: Series = xs.map((p) => (p === null ? null : [p[0], p[1]] as Pt));
    const inHold = (i: number) => spans.some(({ a, b, exc }) => i >= a && i <= b && (exc === null || i < exc[0] || i > exc[1]));
    // The blends: on each frame outside a hold, the largest weight any hold of this joint gives it (the earlier hold on a tie).
    const blend = new Map<number, { w: number; at: Pt }>();
    const found: Array<{ a: number; b: number; exc: [number, number] | null; at: Pt; in: number[]; out: number[] }> = [];
    for (const { a, b, exc } of spans) {
      const { at } = spanOf(name, a, b)!;
      const ins: number[] = [];
      const outs: number[] = [];
      for (let k = 1; k < HOLD_BLEND; k++) {
        const w = (HOLD_BLEND - k) / HOLD_BLEND;
        for (const [i, list] of [[a - k, ins], [b + k, outs]] as const) {
          if (i < 0 || i >= n || inHold(i)) continue;
          list.push(i);
          const was = blend.get(i);
          if (was === undefined || w > was.w) blend.set(i, { w, at });
        }
      }
      if (exc !== null) {
        const [e0, e1] = exc;
        for (let k = 1; k < HOLD_BLEND; k++) {
          const w = (HOLD_BLEND - k) / HOLD_BLEND;
          for (const i of [e0 - 1 + k, e1 + 1 - k]) {
            if (i < e0 || i > e1) continue;
            const was = blend.get(i);
            if (was === undefined || w > was.w) blend.set(i, { w, at });
          }
        }
      }
      found.push({ a, b, exc, at, in: ins, out: outs });
    }
    for (const { a, b, exc, at } of found) {
      for (let i = a; i <= b; i++) {
        if (exc !== null && i >= exc[0] && i <= exc[1]) continue;
        if (out[i] !== null) out[i] = [at[0], at[1]];
      }
    }
    for (const [i, { w, at }] of blend) {
      const p = xs[i];
      if (p === null || p === undefined) continue;
      out[i] = [p[0] + w * (at[0] - p[0]), p[1] + w * (at[1] - p[1])];
    }
    // The seams: two holds back to back, or with a gap of under HOLD_BLEND frames, cross-fade over the
    // HOLD_BLEND + gap frames centred on the gap's centre (one.b − 2 … two.a + 2), after the blends.
    for (let q = 0; q + 1 < found.length; q++) {
      const one = found[q]!;
      const two = found[q + 1]!;
      const gap = two.a - one.b - 1;
      if (gap < 0 || gap >= HOLD_BLEND) continue;
      seams.push({ joint: name, frame: two.a, step: Math.hypot(two.at[0] - one.at[0], two.at[1] - one.at[1]) / trunk, gap });
      const width = HOLD_BLEND + gap;
      for (let j = 0; j < width; j++) {
        const i = one.b - (HOLD_BLEND / 2 - 1) + j;
        if (i < one.a || i > two.b || out[i] === null) continue;
        const w = (2 * j + 1) / (2 * width);
        out[i] = [one.at[0] + w * (two.at[0] - one.at[0]), one.at[1] + w * (two.at[1] - one.at[1])];
      }
    }
    held.set(name, out);
    for (const f of found) {
      let fastest = 0;
      for (let i = f.a; i <= f.b; i++) if (xs[i] !== null && sp[i] !== null && sp[i] !== undefined) fastest = Math.max(fastest, sp[i]!);
      const range = (xs2: number[]): [number, number] | null => (xs2.length === 0 ? null : [Math.min(...xs2), Math.max(...xs2)]);
      holds.push({
        joint: name,
        frames: [f.a, f.b],
        excursion: f.exc,
        seconds: secondsOf(f.a, f.b),
        speed: fastest,
        reach: spanOf(name, f.a, f.b)!.reach,
        blendIn: range(f.in),
        blendOut: range(f.out),
        jitter: { before: jitterOf([xs.slice(f.a, f.b + 1)], false).value, after: jitterOf([out.slice(f.a, f.b + 1)], false).value },
      });
    }
  }
  holds.sort((x, y) => x.frames[0] - y.frames[0] || BODY18.indexOf(x.joint) - BODY18.indexOf(y.joint));
  const unheld: Unheld[] = [];
  for (const [a, b] of holdRegions(holds)) {
    for (const name of names) {
      const xs = series.get(name)!;
      const sp = med.get(name)!;
      const covered = (i: number) => holds.some((h) => h.joint === name && i >= h.frames[0] && i <= h.frames[1]);
      const runs: Array<[number, number]> = [];
      for (let i = a; i <= b; i++) {
        if (xs[i] === null || covered(i)) continue;
        const last = runs[runs.length - 1];
        if (last !== undefined && last[1] === i - 1) last[1] = i;
        else runs.push([i, i]);
      }
      for (const [s0, s1] of runs) {
        let fastest: number | null = 0;
        for (let i = s0; i <= s1; i++) {
          const v = sp[i];
          if (v === null || v === undefined) {
            fastest = null;
            break;
          }
          fastest = Math.max(fastest, v);
        }
        const r = spanOf(name, s0, s1)!;
        const seconds = secondsOf(s0, s1);
        if (fastest === null || fastest >= speed) unheld.push({ joint: name, frames: [s0, s1], test: 'speed', value: fastest });
        else if (r.reach > reach) unheld.push({ joint: name, frames: [s0, s1], test: 'reach', value: r.reach });
        else if (seconds < minSeconds - 1e-9) unheld.push({ joint: name, frames: [s0, s1], test: 'short', value: seconds });
        else unheld.push({ joint: name, frames: [s0, s1], test: 'span', value: r.reach });
      }
    }
  }
  unheld.sort((x, y) => x.frames[0] - y.frames[0] || BODY18.indexOf(x.joint) - BODY18.indexOf(y.joint));
  seams.sort((x, y) => x.frame - y.frame || BODY18.indexOf(x.joint) - BODY18.indexOf(y.joint));
  return { held, holds, unheld, seams };
}

/** The regions the holds cover: their spans joined where they overlap or touch, in frame order. */
export function holdRegions(holds: ReadonlyArray<{ frames: readonly [number, number] }>): Array<[number, number]> {
  const spans = holds.map((h) => [h.frames[0], h.frames[1]] as [number, number]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Clean one person's track. Refuses (every reason at once) a window that is
 * not 1 or odd ≥ 5, a loop shorter than the widest window it reads, and a
 * sequence whose trunk is measured on no frame.
 */
export function clean(seq: PoseSequence, params: CleanParams, wanted: string | undefined, where: string): Cleaned {
  const p = new Problems();
  for (const [flag, v] of [['--legs', params.legs], ['--rest', params.rest]] as const) {
    const why = windowProblem(flag, v);
    if (why !== null) p.add('CLEAN_WINDOW', why);
  }
  const track = personTrack(seq, wanted, where);
  const n = track.length;
  const person = wanted ?? [...new Set(seq.frames.flatMap((f) => f.people.map((q) => q.id)))].sort()[0]!;
  if (params.loop) {
    const widest = Math.max(SPIKE_WINDOW, params.legs, params.rest);
    if (n < widest) p.add('CLEAN_LOOP', `--loop over ${n} frame(s) of ${where}: a circular window of ${widest} frames would read a frame twice; a cycle needs ≥ ${widest} frames (the spike median reads ${SPIKE_WINDOW}, --legs ${params.legs}, --rest ${params.rest})`);
  }
  const at = (j: Joint | undefined): Pt | null => (j === undefined || j.state === 'missing' || j.at === undefined ? null : [j.at[0], j.at[1]]);
  const names = BODY18.filter((name) => track.some((f) => f[name] !== undefined));
  const raw = new Map<Body18, Series>(names.map((name) => [name, track.map((f) => at(f[name]))]));

  // The trunk: neck → mid_hip, its median picture length.
  const lengths: number[] = [];
  for (let i = 0; i < n; i++) {
    const neck = raw.get('neck')?.[i] ?? null;
    const r = raw.get('r_hip')?.[i] ?? null;
    const l = raw.get('l_hip')?.[i] ?? null;
    if (neck === null || r === null || l === null) continue;
    lengths.push(Math.hypot(neck[0] - (r[0] + l[0]) / 2, neck[1] - (r[1] + l[1]) / 2));
  }
  if (lengths.length === 0) p.add('CLEAN_TRUNK', `${where} person "${person}": neck, r_hip and l_hip have a position together on none of its ${n} frame(s); the spike limit is ${SPIKE_TRUNKS} trunk lengths (neck → mid_hip), so there is no limit to read`);
  p.throwIfAny();
  const trunk = median1(lengths);
  const limit = SPIKE_TRUNKS * trunk;

  // 1. Spikes.
  const spikes: SpikeFound[] = [];
  const despiked = new Map<Body18, Series>();
  for (const name of names) {
    const xs = raw.get(name)!;
    const out = [...xs];
    for (const s of spikesOf(xs, limit, params.loop)) {
      out[s.frame] = s.at;
      spikes.push({ frame: s.frame, joint: name, off: s.off });
    }
    despiked.set(name, out);
  }
  spikes.sort((a, b) => a.frame - b.frame || BODY18.indexOf(a.joint) - BODY18.indexOf(b.joint));

  // 2. Occlusion.
  const occluded: Occluded[] = [];
  const unhidden = new Map<Body18, Series>();
  for (const name of names) {
    const xs = despiked.get(name)!;
    const out = [...xs];
    xs.forEach((q, i) => {
      if (q === null) return;
      const j = track[i]![name]!;
      const low = j.score !== undefined && j.score < OCCLUSION_SCORE;
      if ((j.state === 'observed' || j.state === 'inferred') && !low) return;
      const m = medianAt(xs, i, OCCLUSION_WINDOW, params.loop)!;
      out[i] = m;
      occluded.push({ joint: name, frame: i, moved: Math.hypot(m[0] - q[0], m[1] - q[1]), why: j.state !== 'observed' && j.state !== 'inferred' ? j.state : `score ${j.score!.toFixed(3)} < ${OCCLUSION_SCORE}` });
    });
    unhidden.set(name, out);
  }

  // 3. Smoothing.
  const smoothed = new Map<Body18, Series>();
  for (const name of names) smoothed.set(name, savitzkyGolay(unhidden.get(name)!, LEGS.includes(name) ? params.legs : params.rest, params.loop));

  // 4. Floor (loop only).
  let floor: Floor | null = null;
  if (params.loop) {
    const lowest = (m: Map<Body18, Series>): number | null => {
      const ys = (['r_ankle', 'l_ankle'] as const).flatMap((a) => (m.get(a) ?? []).filter((q): q is Pt => q !== null).map((q) => q[1]));
      return ys.length === 0 ? null : Math.max(...ys);
    };
    const before = lowest(unhidden);
    const after = lowest(smoothed);
    if (before !== null && after !== null) {
      const shift = before - after;
      floor = { before, after, shift };
      for (const name of names) smoothed.set(name, smoothed.get(name)!.map((q) => (q === null ? null : [q[0], q[1] + shift])));
    }
  }

  const missing: Cleaned['missing'] = [];
  for (const name of names) {
    raw.get(name)!.forEach((q, i) => {
      if (q !== null) return;
      const last = missing[missing.length - 1];
      if (last !== undefined && last.joint === name && last.to === i - 1) last.to = i;
      else missing.push({ joint: name, from: i, to: i });
    });
  }

  // 5. The stillness hold (#91).
  const hold = params.hold;
  let holds: HoldFound[] = [];
  let unheld: Unheld[] = [];
  let seams: Seam[] = [];
  if (hold !== undefined && hold !== 'off') {
    const r = holdStill(smoothed, seq.frames.map((f) => f.t), trunk, hold.speed, hold.reach, params.loop);
    holds = r.holds;
    unheld = r.unheld;
    seams = r.seams;
    for (const name of names) smoothed.set(name, r.held.get(name)!);
  }

  const untested = Array.from({ length: n }, (_, i) => i).filter((i) => !testedAt(i, n, params.loop));
  const before = jitterOf([...raw.values()], params.loop);
  const after = jitterOf([...smoothed.values()], params.loop);
  const record: CleanRecord = {
    spec: CLEAN_SPEC,
    params: {
      loop: params.loop,
      legs: params.legs,
      rest: params.rest,
      ...(params.hipsInferred === true ? { hipsInferred: { by: 'declared' as const } } : {}),
      ...(hold === undefined ? {} : { hold: hold === 'off' ? ('off' as const) : { speed: hold.speed, reach: hold.reach, minSeconds: HOLD_MIN_SECONDS, blend: HOLD_BLEND } }),
    },
    spikes: { found: spikes.map((s) => ({ frame: s.frame, joint: s.joint })), untested },
    jitter: { before: before.value, after: after.value },
    ...(hold === undefined || hold === 'off' ? {} : {
      holds: holds.map((h) => ({
        joint: h.joint,
        frames: [h.frames[0], h.frames[1]] as [number, number],
        ...(h.excursion === null ? {} : { excursion: [h.excursion[0], h.excursion[1]] as [number, number] }),
        jitter: { before: h.jitter.before, after: h.jitter.after },
      })),
      unheld: unheld.map((u) => ({ joint: u.joint, frames: [u.frames[0], u.frames[1]] as [number, number], test: u.test, value: u.value })),
      seams: seams.map((x) => ({ joint: x.joint, frame: x.frame, step: x.step, gap: x.gap })),
    }),
  };
  const inferred = params.hipsInferred === true ? { r_hip: 0, l_hip: 0 } : null;
  const frames = seq.frames.map((f, i) => {
    const q = f.people.find((x) => x.id === person);
    if (q === undefined) return { t: f.t, people: [] };
    const joints: Partial<Record<Body18, Joint>> = {};
    for (const [name, j] of Object.entries(q.joints) as Array<[Body18, Joint]>) {
      const moved = smoothed.get(name)?.[i] ?? null;
      const out: Joint = moved === null ? { ...j } : { ...j, at: [moved[0], moved[1]] };
      if (inferred !== null && (name === 'r_hip' || name === 'l_hip') && out.state !== 'missing' && out.at !== undefined) {
        out.state = 'inferred';
        inferred[name]++;
      }
      joints[name] = out;
    }
    return { t: f.t, people: [{ id: person, joints: sortedJoints(joints) }] };
  });
  const { cleaned: _was, ...rest } = seq;
  return {
    // #92: a loop is one cycle of a gait repeated in place, so it carries no travel of its own.
    seq: { ...rest, ...(params.loop ? { travel: TRAVEL_IN_PLACE } : {}), cleaned: record, frames },
    record,
    person,
    trunk: { length: trunk, frames: lengths.length },
    spikes,
    occluded,
    missing,
    untested,
    floor,
    triples: before.triples,
    inferred,
    holds,
    unheld,
    seams,
  };
}

/** The untested frames as text: "frames 0, 1, 30, 31 untested (a clip end cuts their window)", or "every frame tested". */
export function untestedText(frames: readonly number[]): string {
  if (frames.length === 0) return 'every frame tested';
  return `frame${frames.length === 1 ? '' : 's'} ${frames.join(', ')} untested (a clip end cuts the ${SPIKE_WINDOW}-frame window)`;
}

/** The record as one line: retarget's CLEAN line, and clean's own summary. */
export function cleanLine(r: CleanRecord): string {
  const { loop, legs, rest } = r.params;
  const windows = legs === 1 && rest === 1 ? 'legs 1, rest 1 — no smoothing' : `legs ${legs}, rest ${rest}`;
  const found = r.spikes.found;
  const shown = found.slice(0, 8).map((s) => `frame ${s.frame} ${s.joint}`).join(', ');
  const spikes = `${found.length === 0 ? 'no spike' : `${found.length} spike(s) replaced (${shown}${found.length > 8 ? `, … ${found.length - 8} more` : ''})`}, ${untestedText(r.spikes.untested)}`;
  const jit = (v: number | null) => (v === null ? 'not measured' : v.toFixed(2));
  const hips = r.params.hipsInferred === undefined ? '' : `; hips inferred (${inferredSource(r)})`;
  return `${r.spec}: ${windows}, ${loop ? 'loop' : 'no loop'}; ${spikes}; jitter (mean |second difference| of y) ${jit(r.jitter.before)} → ${jit(r.jitter.after)} px/f²${holdText(r)}${hips}`;
}

/**
 * The stillness hold on the CLEAN line (#91): "; hold off"; "; no HOLD (…)";
 * or, per region the holds cover, the joints held over which frames and the
 * joints not held with the test each fails and its figure. Nothing for a
 * record written before #91.
 */
function holdText(r: CleanRecord): string {
  const h = r.params.hold;
  if (h === undefined) return '';
  if (h === 'off') return '; hold off';
  const holds = r.holds ?? [];
  if (holds.length === 0) return `; no HOLD (speed < ${h.speed} trunk/frame, within ${h.reach} trunk, ≥ ${h.minSeconds} s)`;
  return holdRegions(holds).map(([a, b]) => {
    const groups = new Map<string, string[]>();
    for (const x of holds) {
      if (x.frames[0] > b || x.frames[1] < a) continue;
      const exc = x.excursion === undefined ? '' : ` (excursion ${x.excursion[0] === x.excursion[1] ? `${x.excursion[0]}` : `${x.excursion[0]}–${x.excursion[1]}`} kept)`;
      const k = `${x.frames[0]}–${x.frames[1]}${exc}`;
      groups.set(k, [...(groups.get(k) ?? []), x.joint]);
    }
    const held = [...groups].map(([k, js]) => `${js.join(', ')} ${k}`).join('; ');
    const not = (r.unheld ?? []).filter((u) => u.frames[0] >= a && u.frames[1] <= b).map(unheldText(h));
    const sm = (r.seams ?? []).filter((x) => x.frame >= a && x.frame <= b).map((x) => `${x.joint} ${x.frame} (step ${x.step.toFixed(4)}${x.gap > 0 ? `, gap ${x.gap}` : ''})`);
    const ramps = holds.filter((x) => x.frames[0] <= b && x.frames[1] >= a && x.jitter.after !== null && x.jitter.after > 0).map((x) => `${x.joint} ${x.frames[0]}–${x.frames[1]} ${x.jitter.after!.toFixed(4)} px/f² (${x.excursion !== undefined ? 'excursion' : 'ramp'})`);
    return `; HOLD frames ${a}–${b}: held ${held}${sm.length === 0 ? '' : `; seams cross-faded: ${sm.join(', ')}`}${ramps.length === 0 ? '' : `; jitter after ${ramps.join(', ')}`}${not.length === 0 ? '; every joint held' : `; not held: ${not.join(', ')}`}`;
  }).join('');
}

/** One joint's frames not held, as the lines say it: `r_wrist 21–59 (reach 0.1375 > 0.03)` (the drifting wrist of the tests). */
export function unheldText(h: { speed: number; reach: number; minSeconds?: number }): (u: CleanUnheld) => string {
  return (u) => {
    const at = `${u.joint} ${u.frames[0] === u.frames[1] ? `${u.frames[0]}` : `${u.frames[0]}–${u.frames[1]}`}`;
    if (u.test === 'speed') return `${at} (speed ${u.value === null ? 'not known on some frame' : `${u.value.toFixed(4)} ≥ ${h.speed}`})`;
    if (u.test === 'reach') return `${at} (reach ${u.value!.toFixed(4)} > ${h.reach})`;
    if (u.test === 'short') return `${at} (still, ${u.value!.toFixed(3)} s < ${h.minSeconds ?? HOLD_MIN_SECONDS} s)`;
    return `${at} (passes all three, reach ${u.value!.toFixed(4)}; its spans broke elsewhere)`;
  };
}

/**
 * Where a sequence's `inferred` hips come from, as the lines say it: "declared
 * at clean" when the record says `--hips-inferred` marked them; "measured by
 * <method>" when a tool read the pelvis line off the picture (#86); "source not
 * stated" when the joints carry the state and the record does not say why
 * (a file whose states were written by hand or by another tool).
 */
export function inferredSource(r: CleanRecord | undefined): string {
  const h = r?.params.hipsInferred;
  if (h === undefined) return 'source not stated';
  if (h.by === 'declared') return 'declared at clean';
  const spans = (rs: Array<[number, number]>) => rs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  const scaled = h.scaled !== undefined && h.scaled.length > 0 ? `, scaled ${spans(h.scaled)}${h.fit?.gain !== undefined && h.fit.gain !== null && h.fit.corr !== null ? ` (gain ${h.fit.gain.toFixed(2)}×, r=${h.fit.corr.toFixed(3)})` : ''}` : '';
  const unmeasured =
    h.unmeasured !== undefined && (h.unmeasured.length > 0 || (h.fit !== undefined && (h.fit.corr === null || h.fit.corr < 0.9)))
      ? `, unmeasured ${h.unmeasured.length === 0 ? 'none' : spans(h.unmeasured)}${h.fit !== undefined ? ` (r=${h.fit.corr === null ? 'none' : h.fit.corr.toFixed(3)} < 0.9)` : ''}`
      : '';
  return `measured by ${h.method}${scaled}${unmeasured}`;
}
