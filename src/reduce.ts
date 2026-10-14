/**
 * The dense keys thinned to few keys with curves, within a stated tolerance
 * (rig-c/pose#32, `--reduce`): one key per pose frame on every mapped bone's
 * `rotate` track and on the hip's `translate`, in; the keys a curve needs to
 * stay within the tolerance on every frame, out.
 *
 * Pure: numbers in, keys out. The method was fixed on the issue before any
 * measurement. Keys sit on the pose's own frame times; between two kept keys a
 * span is linear when every frame inside is within the tolerance, else it
 * carries one raw Bézier `curve` whose handle times sit at the span's thirds and
 * whose handle values are a least-squares fit; a span still over the tolerance
 * takes a key at its worst frame and both halves are fitted again.
 *
 * Top-down along the tree. A child's `rotate` key adds to the turn of the
 * mapped bone above it, so the reduced above's error turns the child's world
 * aim too. A bone is fitted against its dense key minus the error its above
 * carries (`target = dense − e_above`), and its own residual against that
 * target is its world error: errors do not pile up down a chain. A knot's value
 * is the target's, not the dense key's.
 *
 * Scaled bones (rig-c/pose#94). A `scalex` track is thinned in value space
 * within `SCALE_REDUCE` (`reduceScale`). A bone under a scaled bone is not
 * keyed by the formula above but through its parent's posed matrix (legs.ts
 * `posePath`), so `reduceUnderScale` solves its keys again through its parent
 * as reduced and reads each error as the world aim, and the world length, it
 * lands on.
 *
 * Every error is read after the numbers are rounded as written and evaluated as
 * rig-c's poser evaluates them (`curveAt`): the curve is the poser's ten-piece
 * polyline, not the cubic. The poser is the judge — run.ts measures the landing
 * of the gated build against the dense targets with the tolerance added.
 */
import { f32 } from 'rig-c/compile';

/** A key as the reducer writes it: a time, its values, and a raw curve on the segment to the next key. */
export interface ReducedKey {
  t: number;
  v: number[];
  curve?: number[];
}

export interface ReduceBone {
  bone: string;
  /** The nearest mapped bone above it (whose rotate track it adds to), or null. Always one of the other bones given, or null. */
  above: string | null;
  /** The dense key value on every frame (degrees, unwrapped, already rounded to 0.001). */
  dense: number[];
  /** Frame indices that must keep a key regardless (the first and last always do). */
  keep: ReadonlySet<number>;
}
export interface ReduceHip {
  bone: string;
  /** Dense translate key on every frame, parent-local units, rounded to 0.001. */
  dense: Array<[number, number]>;
  keep: ReadonlySet<number>;
  /** The hip's parent world matrix [a, b, c, d] at setup (wx = a·lx + b·ly, wy = c·lx + d·ly); null when it has none (identity). The tolerance is a world distance. */
  parent: [number, number, number, number] | null;
  tolerance: number;
}
export interface ReduceRow {
  bone: string;
  /** `scale`: a `scalex` track (#94), its error the bone's world x-axis length against its setup length times the scale asked. */
  kind: 'angle' | 'origin' | 'scale';
  /** Dense key count. */
  before: number;
  /** Reduced key count. */
  after: number;
  /** The largest error over all frames: degrees of world aim for a bone, world units for the hip, a fraction of the setup length for a scale. */
  worst: number;
  /** The first frame where it is. */
  frame: number;
}
export interface Reduced {
  rotate: Map<string, ReducedKey[]>;
  hip: ReducedKey[] | null;
  /** The bones in the order given, then the hip. */
  rows: ReduceRow[];
  /** Each bone's world-aim error on every frame (reduced less dense, degrees), as the poser evaluates the reduced keys. */
  errors: Map<string, number[]>;
}

// ---------------------------------------------------------------------------
// rig-c's evaluation
// ---------------------------------------------------------------------------

/** rig-c's `BEZIER_SIXTH` (node_modules/rig-c/src/core/animation.ts). */
const BEZIER_SIXTH = 0.16666667;
/** Pieces of the poser's polyline per Bézier segment — rig-c's `BEZIER_PIECES`. */
export const REDUCE_PIECES = 10;

/**
 * Copied verbatim from rig-c `src/core/animation.ts` (`bezierPolyline`, not
 * exported by `rig-c/core`): the nine interior points of one channel's Bézier
 * segment, `[t1, v1, …, t9, v9]`, each float32, by forward differences. The
 * poser is the judge; this copy only lets the fit see what it will see.
 */
export function bezierPolyline(t0: number, v0: number, cx1: number, cy1: number, cx2: number, cy2: number, t3: number, v3: number): number[] {
  const walk = (p0: number, p1: number, p2: number, p3: number): number[] => {
    const second = (p0 - 2 * p1 + p2) * 0.03;
    const third = ((p1 - p2) * 3 - p0 + p3) * 0.006;
    let first = (p1 - p0) * 0.3 + second + third * BEZIER_SIXTH;
    let d2 = second * 2 + third;
    let at = p0;
    const out: number[] = [];
    for (let i = 1; i < REDUCE_PIECES; i++) {
      at += first;
      first += d2;
      d2 += third;
      out.push(Math.fround(at));
    }
    return out;
  };
  const ts = walk(t0, cx1, cx2, t3);
  const vs = walk(v0, cy1, cy2, v3);
  const out: number[] = [];
  for (let i = 0; i < ts.length; i++) out.push(ts[i]!, vs[i]!);
  return out;
}

const F32 = new Float32Array(1);
const F32_BITS = new Uint32Array(F32.buffer);

/** A key time as the built model states it — rig-c's `keyTime`: its own float32 name, else the float32 at or below it, named. */
function statedTime(t: number): number {
  const named = f32(t);
  if (named === t) return named;
  let f = Math.fround(t);
  if (f > t) {
    F32[0] = f;
    if (f > 0) F32_BITS[0]! -= 1;
    else if (f < 0) F32_BITS[0]! += 1;
    else F32_BITS[0] = 0x80000001;
    f = F32[0]!;
  }
  return f32(f);
}
/** A key time as the poser compares it: the float32 of the stated time. */
const storedTime = (t: number): number => Math.fround(statedTime(t));

/**
 * One channel of one segment, as the poser holds it: null for a linear
 * segment, else the polyline `[t0, v0, …nine points…, t3, v3]`. The recurrence
 * runs on the numbers the built model states (rig-c's `f32` of each, a key
 * time by `keyTime`); the two ends are the keys as stored, float32.
 */
function segmentPoints(a: ReducedKey, b: ReducedKey, channel: number): number[] | null {
  if (a.curve === undefined) return null;
  const c = a.curve.slice(channel * 4, channel * 4 + 4).map(f32);
  const ta = statedTime(a.t);
  const tb = statedTime(b.t);
  const va = f32(a.v[channel]!);
  const vb = f32(b.v[channel]!);
  const inner = bezierPolyline(ta, va, c[0]!, c[1]!, c[2]!, c[3]!, tb, vb);
  return [Math.fround(ta), Math.fround(va), ...inner, Math.fround(tb), Math.fround(vb)];
}

/** `segmentPoints`' segment at `t` — rig-c's `channelAt` past the key search. */
function pointsAt(a: ReducedKey, b: ReducedKey, channel: number, points: readonly number[] | null, t: number): number {
  if (points === null) {
    const ta = storedTime(a.t);
    const va = Math.fround(a.v[channel]!);
    return va + ((t - ta) / (storedTime(b.t) - ta)) * (Math.fround(b.v[channel]!) - va);
  }
  let i = 2;
  while (i < points.length - 2 && points[i]! < t) i += 2;
  const x0 = points[i - 2]!;
  const y0 = points[i - 1]!;
  return y0 + ((t - x0) / (points[i]! - x0)) * (points[i + 1]! - y0);
}

/** Channel `channel` of the segment from key `a` to key `b` (`a.curve` shapes it) at `t`, as rig-c's poser evaluates it. */
export function curveAt(a: ReducedKey, b: ReducedKey, channel: number, t: number): number {
  return pointsAt(a, b, channel, segmentPoints(a, b, channel), t);
}

/** Every channel of a whole track at each sample time: the key search (last key stored at or before `t`), then the segment. */
function trackAt(keys: readonly ReducedKey[], samples: readonly number[], channels: number): number[][] {
  const stored = keys.map((k) => storedTime(k.t));
  const points = keys.map((k, j) => (j + 1 < keys.length ? Array.from({ length: channels }, (_, c) => segmentPoints(k, keys[j + 1]!, c)) : []));
  let j = 0;
  return samples.map((t) => {
    while (j + 1 < keys.length && stored[j + 1]! <= t) j++;
    const a = keys[j]!;
    const b = keys[j + 1];
    // Before the first key the track does not pose; the first key is on frame 0, stored at or below it.
    if (b === undefined || t < stored[j]!) return a.v.map((v) => Math.fround(v));
    return Array.from({ length: channels }, (_, c) => pointsAt(a, b, c, points[j]![c]!, t));
  });
}

// ---------------------------------------------------------------------------
// the fit
// ---------------------------------------------------------------------------

const r3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
/** A scale as the retarget writes one (retarget.ts `r6`). */
const r6 = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

/** One track to reduce: its targets per frame (one array per frame, a value per channel) and how a frame's error is read. */
interface Fit {
  targets: readonly (readonly number[])[];
  keep: ReadonlySet<number>;
  tolerance: number;
  /** The error at frame `i` of `values` against the target. */
  error: (i: number, values: readonly number[]) => number;
  /** How a written value is rounded: 0.001 (an angle, a translate) unless given. */
  round?: (v: number) => number;
}

/** The frame with the largest error over `frames` (the first, on a tie), or null when there is none. */
function worstOf(frames: readonly number[], errorAt: (i: number) => number): { worst: number; frame: number } | null {
  let best: { worst: number; frame: number } | null = null;
  for (const i of frames) {
    const e = errorAt(i);
    if (best === null || e > best.worst) best = { worst: e, frame: i };
  }
  return best;
}

/** The least-squares handle values of one channel, or null when the normal equations are singular. */
function solveHandles(a: ReducedKey, b: ReducedKey, channel: number, hx1: number, hx2: number, interior: readonly number[], samples: readonly number[], target: (i: number) => number): [number, number] | null {
  const model = (cy1: number, cy2: number): number[] => {
    const c = new Array<number>(a.v.length * 4).fill(0);
    c.splice(channel * 4, 4, hx1, cy1, hx2, cy2);
    const k: ReducedKey = { t: a.t, v: a.v, curve: c };
    const points = segmentPoints(k, b, channel);
    return interior.map((i) => pointsAt(k, b, channel, points, samples[i]!));
  };
  const f00 = model(0, 0);
  const f10 = model(1, 0);
  const f01 = model(0, 1);
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let r1 = 0;
  let r2 = 0;
  interior.forEach((i, j) => {
    const g1 = f10[j]! - f00[j]!;
    const g2 = f01[j]! - f00[j]!;
    const r = target(i) - f00[j]!;
    s11 += g1 * g1;
    s12 += g1 * g2;
    s22 += g2 * g2;
    r1 += g1 * r;
    r2 += g2 * r;
  });
  const det = s11 * s22 - s12 * s12;
  if (!(s11 > 0 && s22 > 0) || !(det > 1e-12 * s11 * s22)) return null;
  return [(r1 * s22 - r2 * s12) / det, (r2 * s11 - r1 * s12) / det];
}

/** A track's keys: the kept frames, then a knot at the worst frame of every span over the tolerance, until none is. */
function fitTrack(times: readonly number[], samples: readonly number[], fit: Fit): ReducedKey[] {
  const n = times.length;
  const channels = fit.targets[0]!.length;
  const round = fit.round ?? r3;
  const keyOn = (i: number): ReducedKey => ({ t: times[i]!, v: fit.targets[i]!.map(round) });
  const knots = [...new Set([0, n - 1, ...fit.keep])].sort((x, y) => x - y);
  const curves = new Map<number, number[]>();
  const done: number[] = [];
  const spans: Array<[number, number]> = [];
  for (let j = knots.length - 1; j > 0; j--) spans.push([knots[j - 1]!, knots[j]!]);
  done.push(...knots);
  while (spans.length > 0) {
    const [k0, k1] = spans.pop()!;
    if (k1 - k0 <= 1) continue;
    const a = keyOn(k0);
    const b = keyOn(k1);
    const interior = Array.from({ length: k1 - k0 - 1 }, (_, j) => k0 + 1 + j);
    const errorWith = (k: ReducedKey) => {
      const points = Array.from({ length: channels }, (_, c) => segmentPoints(k, b, c));
      return worstOf(interior, (i) => fit.error(i, points.map((p, c) => pointsAt(k, b, c, p, samples[i]!))))!;
    };
    const linear = errorWith(a);
    if (linear.worst <= fit.tolerance) continue;
    let split = linear.frame;
    const hx1 = times[k0]! + (times[k1]! - times[k0]!) / 3;
    const hx2 = times[k0]! + (2 * (times[k1]! - times[k0]!)) / 3;
    const handles = Array.from({ length: channels }, (_, c) => solveHandles(a, b, c, hx1, hx2, interior, samples, (i) => fit.targets[i]![c]!));
    if (handles.every((h) => h !== null)) {
      const curve = handles.flatMap(([cy1, cy2]) => [hx1, round(cy1), hx2, round(cy2)]);
      const bent = errorWith({ ...a, curve });
      if (bent.worst <= fit.tolerance) {
        curves.set(k0, curve);
        continue;
      }
      split = bent.frame;
    }
    done.push(split);
    spans.push([split, k1], [k0, split]);
  }
  return [...new Set(done)].sort((x, y) => x - y).map((i) => {
    const k = keyOn(i);
    const curve = curves.get(i);
    return curve === undefined ? k : { ...k, curve };
  });
}

/** The frame indices `keep` names, each checked against the frame count. */
function keptFrames(keep: ReadonlySet<number>, n: number, label: string): Set<number> {
  for (const i of keep) {
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`reduce: ${label} keeps frame ${i}, outside the ${n} frame(s) 0–${n - 1}`);
  }
  return new Set(keep);
}

/**
 * Every bone's rotate track (and the hip's translate) reduced within the
 * tolerance, top-down along `above`; the rows say each track's key counts and
 * its worst world error, measured on the reduced keys as the poser evaluates
 * them.
 */
export function reduceKeys(times: readonly number[], bones: readonly ReduceBone[], tolerance: number, hip: ReduceHip | null): Reduced {
  const n = times.length;
  if (n === 0) throw new Error('reduce: no frames to reduce');
  if (!(Number.isFinite(tolerance) && tolerance > 0)) throw new Error(`reduce: the tolerance is ${tolerance}°, not a positive number`);
  if (hip !== null && !(Number.isFinite(hip.tolerance) && hip.tolerance > 0)) throw new Error(`reduce: the hip's tolerance is ${hip.tolerance} units, not a positive number`);
  // The poser samples at the running sum of the frame steps (verify.ts `poseFrames`).
  const samples = samplesOf(times);

  const byName = new Map<string, ReduceBone>();
  for (const b of bones) {
    if (byName.has(b.bone)) throw new Error(`reduce: bone "${b.bone}" is given twice`);
    if (b.dense.length !== n) throw new Error(`reduce: bone "${b.bone}" has ${b.dense.length} dense key(s) for ${n} frame(s)`);
    byName.set(b.bone, b);
  }
  for (const b of bones) {
    if (b.above !== null && !byName.has(b.above)) throw new Error(`reduce: bone "${b.bone}" adds to bone "${b.above}", which is not among the bones reduced`);
  }

  // Top-down: a bone once its above is done, in the order given otherwise.
  const errors = new Map<string, number[]>();
  const rotate = new Map<string, ReducedKey[]>();
  const rowOf = new Map<string, ReduceRow>();
  const pending = [...bones];
  while (pending.length > 0) {
    const at = pending.findIndex((b) => b.above === null || errors.has(b.above));
    if (at < 0) throw new Error(`reduce: bones ${pending.map((b) => `"${b.bone}"`).join(', ')} each add to another of them — a loop, not a tree`);
    const b = pending.splice(at, 1)[0]!;
    const eAbove = b.above === null ? null : errors.get(b.above)!;
    const targets = b.dense.map((d, i) => [eAbove === null ? d : d - eAbove[i]!]);
    const keys = fitTrack(times, samples, {
      targets,
      keep: keptFrames(b.keep, n, `bone "${b.bone}"`),
      tolerance,
      error: (i, v) => Math.abs(v[0]! - targets[i]![0]!),
    });
    const e = trackAt(keys, samples, 1).map((v, i) => v[0]! - targets[i]![0]!);
    errors.set(b.bone, e);
    rotate.set(b.bone, keys);
    const worst = worstOf(e.map((_, i) => i), (i) => Math.abs(e[i]!))!;
    rowOf.set(b.bone, { bone: b.bone, kind: 'angle', before: n, after: keys.length, worst: worst.worst, frame: worst.frame });
  }
  const rows = bones.map((b) => rowOf.get(b.bone)!);
  const errorsOrdered = new Map(bones.map((b) => [b.bone, errors.get(b.bone)!]));
  const ordered = new Map(bones.map((b) => [b.bone, rotate.get(b.bone)!]));

  let hipKeys: ReducedKey[] | null = null;
  if (hip !== null) {
    if (hip.dense.length !== n) throw new Error(`reduce: hip "${hip.bone}" has ${hip.dense.length} dense key(s) for ${n} frame(s)`);
    const [ma, mb, mc, md] = hip.parent ?? [1, 0, 0, 1];
    const world = (i: number, v: readonly number[]): number => {
      const dx = v[0]! - hip.dense[i]![0];
      const dy = v[1]! - hip.dense[i]![1];
      return Math.hypot(ma * dx + mb * dy, mc * dx + md * dy);
    };
    hipKeys = fitTrack(times, samples, { targets: hip.dense, keep: keptFrames(hip.keep, n, `hip "${hip.bone}"`), tolerance: hip.tolerance, error: world });
    const at = trackAt(hipKeys, samples, 2);
    const worst = worstOf(at.map((_, i) => i), (i) => world(i, at[i]!))!;
    rows.push({ bone: hip.bone, kind: 'origin', before: n, after: hipKeys.length, worst: worst.worst, frame: worst.frame });
  }
  return { rotate: ordered, hip: hipKeys, rows, errors: errorsOrdered };
}

/** The times the poser samples a track at: the running sum of the frame steps (verify.ts `poseFrames`). */
export function samplesOf(times: readonly number[]): number[] {
  const samples: number[] = [times[0]!];
  for (let i = 1; i < times.length; i++) samples.push(samples[i - 1]! + (times[i]! - times[i - 1]!));
  return samples;
}

// ---------------------------------------------------------------------------
// scales, and bones keyed through a scaled parent (rig-c/pose#94)
// ---------------------------------------------------------------------------

/**
 * The tolerance a reduced `scalex` track is held to: half of the landing
 * check's scale tolerance (verify.ts `SCALE_TOLERANCE`, 1e-4 of the setup
 * length), so a reduced curve cannot fail the check it is re-run against.
 */
export const SCALE_REDUCE = 5e-5;

/**
 * One `scalex` track of a bone with no scaled bone above it, reduced: its world
 * x-axis length over setup is its own scale, so the error is the value's
 * distance from the scale asked.
 */
export function reduceScale(times: readonly number[], bone: string, asked: readonly number[], keep: ReadonlySet<number>, tolerance: number): { keys: ReducedKey[]; at: number[]; row: ReduceRow } {
  const n = times.length;
  if (asked.length !== n) throw new Error(`reduce: bone "${bone}" asks ${asked.length} scale(s) for ${n} frame(s)`);
  const samples = samplesOf(times);
  const keys = fitTrack(times, samples, { targets: asked.map((v) => [v]), keep: keptFrames(keep, n, `bone "${bone}" scalex`), tolerance, error: (i, v) => Math.abs(v[0]! - asked[i]!), round: r6 });
  const at = trackAt(keys, samples, 1).map((v) => v[0]!);
  const worst = worstOf(at.map((_, i) => i), (i) => Math.abs(at[i]! - asked[i]!))!;
  return { keys, at, row: { bone, kind: 'scale', before: n, after: keys.length, worst: worst.worst, frame: worst.frame } };
}

/** A world 2×2: columns (a, c) — the x axis — and (b, d) — the y axis (legs.ts `M2`). */
export type M2 = [number, number, number, number];
const DEG = 180 / Math.PI;
const mul = (p: M2, q: M2): M2 => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
const inv = (m: M2): M2 => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
};
const apply = (m: M2, v: [number, number]): [number, number] => [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
const rot = (deg: number): M2 => {
  const r = deg / DEG;
  return [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)];
};
const scaleX = (s: number): M2 => [s, 0, 0, 1];
/** A bone's setup local 2×2 in its parent's axes: inv(parent's setup world) · its setup world (legs.ts `posePath`'s L0). */
export const setupLocal = (parentWorld0: M2, world0: M2): M2 => mul(inv(parentWorld0), world0);
/** `p · q`. */
export const mulM2 = mul;
const IDENTITY: M2 = [1, 0, 0, 1];
export { IDENTITY as M2_IDENTITY };
const wrap180 = (d: number): number => {
  const x = ((d + 180) % 360 + 360) % 360 - 180;
  return x === -180 ? 180 : x;
};

/**
 * A mapped bone under a scaled bone (legs.ts `posePath`: keyed through its
 * parent's posed matrix), reduced once the bones above it are. Its parent's
 * world 2×2 is posed from keys already reduced — a bone the key formula holds
 * for (`rigid`: R(turn) · its setup world · diag(scale, 1), its turn and scale
 * the reduced ones), or another bone of the same call given before it — times
 * the setup locals of the unmapped bones between (`via`).
 */
export interface UnderBone {
  bone: string;
  parent: { rigid: { turn: readonly number[]; world0: M2; scale: readonly number[] }; via: M2 } | { under: string; via: M2 };
  /** Its setup local 2×2 in its parent's axes: inv(parent's setup world) · its setup world, by rig-c's setup. */
  local: M2;
  /** Its setup world x-axis length. */
  len0: number;
  /** The world angle its x axis is asked on every frame (degrees), and the scale of it asked (1: none). */
  target: readonly number[];
  asked: readonly number[];
  /** The dense rotate keys (unwrapped, as written). */
  dense: readonly number[];
  keep: ReadonlySet<number>;
}

/**
 * Each bone under a scaled bone, in the order given (parents first): its
 * rotate and scalex keys re-solved through its parent's reduced posed matrix
 * (the key that puts its x axis on the target, and the scale that gives it the
 * length asked), then reduced — the rotate with its error read as the world aim
 * it lands on through that matrix, the scale with its error read as the world
 * length over setup against the scale asked, on the rotate as reduced. Its
 * world error is its own fit error, as down a chain the key formula holds for.
 */
export function reduceUnderScale(times: readonly number[], bones: readonly UnderBone[], tolerance: number, scaleTolerance: number): { rotate: Map<string, ReducedKey[]>; scale: Map<string, ReducedKey[]>; rows: ReduceRow[] } {
  const n = times.length;
  const samples = samplesOf(times);
  const world = new Map<string, M2[]>();
  const rotate = new Map<string, ReducedKey[]>();
  const scale = new Map<string, ReducedKey[]>();
  const rows: ReduceRow[] = [];
  for (const b of bones) {
    for (const [what, xs] of [['target', b.target], ['asked', b.asked], ['dense', b.dense]] as const) {
      if (xs.length !== n) throw new Error(`reduce: bone "${b.bone}" has ${xs.length} ${what} value(s) for ${n} frame(s)`);
    }
    const p = b.parent;
    let parent: M2[];
    if ('under' in p) {
      const above = world.get(p.under);
      if (above === undefined) throw new Error(`reduce: bone "${b.bone}" hangs from bone "${p.under}", which is not given before it`);
      parent = above.map((m) => mul(m, p.via));
    } else {
      parent = Array.from({ length: n }, (_, i) => mul(mul(mul(rot(p.rigid.turn[i]!), p.rigid.world0), scaleX(p.rigid.scale[i]!)), p.via));
    }
    const l0: [number, number] = [b.local[0], b.local[2]];
    const a0 = Math.atan2(l0[1], l0[0]) * DEG;
    /** The x axis's world vector through the parent on frame i, at rotate key k, before its own scale. */
    const axis = (i: number, k: number) => apply(parent[i]!, apply(rot(k), l0));
    // The dense keys re-solved through the reduced parent (posePath's solve).
    const solved = b.target.map((t, i) => {
      const v = apply(inv(parent[i]!), [b.asked[i]! * b.len0 * Math.cos(t / DEG), b.asked[i]! * b.len0 * Math.sin(t / DEG)]);
      const k = Math.atan2(v[1], v[0]) * DEG - a0;
      return b.dense[i]! + wrap180(k - b.dense[i]!);
    });
    const aimError = (i: number, k: number) => {
      const w = axis(i, k);
      return Math.abs(wrap180(Math.atan2(w[1], w[0]) * DEG - b.target[i]!));
    };
    const keep = keptFrames(b.keep, n, `bone "${b.bone}"`);
    const rk = fitTrack(times, samples, { targets: solved.map((k) => [k]), keep, tolerance, error: (i, v) => aimError(i, v[0]!) });
    const kAt = trackAt(rk, samples, 1).map((v) => v[0]!);
    const ae = worstOf(kAt.map((_, i) => i), (i) => aimError(i, kAt[i]!))!;
    rows.push({ bone: b.bone, kind: 'angle', before: n, after: rk.length, worst: ae.worst, frame: ae.frame });
    // The scale that gives it the length asked on the rotate as reduced.
    const reach = kAt.map((k, i) => Math.hypot(...axis(i, k)) / b.len0);
    const sk = fitTrack(times, samples, { targets: reach.map((r, i) => [b.asked[i]! / r]), keep, tolerance: scaleTolerance, error: (i, v) => Math.abs(v[0]! * reach[i]! - b.asked[i]!), round: r6 });
    const sAt = trackAt(sk, samples, 1).map((v) => v[0]!);
    const se = worstOf(sAt.map((_, i) => i), (i) => Math.abs(sAt[i]! * reach[i]! - b.asked[i]!))!;
    rows.push({ bone: b.bone, kind: 'scale', before: n, after: sk.length, worst: se.worst, frame: se.frame });
    world.set(b.bone, parent.map((m, i) => mul(mul(mul(m, rot(kAt[i]!)), b.local), scaleX(sAt[i]!))));
    rotate.set(b.bone, rk);
    scale.set(b.bone, sk);
  }
  return { rotate, scale, rows };
}
