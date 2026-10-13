/**
 * The legs (rig-c/pose#47): foreshortening by length, and the hip derived from
 * the supporting foot. Pure — no file, no clock, no process.
 *
 * **Leg scale.** A knee bending toward the camera is seen from the front only
 * as a shorter leg. Each mapped leg segment (two of one side's hip, knee and
 * ankle) is scaled along its own x axis (`scalex`): its picture length on the
 * frame over its *straight length*, the 95th percentile of its picture length
 * over the sequence, clamped to a declared range. The frames clamped are listed.
 *
 * **A scaled parent turns its child.** rig-c's `scalex` multiplies the bone's
 * x axis, and a child with the `normal` inherit mode takes the parent's whole
 * world matrix — so under a thigh scaled by s, a shin at angle φ in the thigh's
 * axes points at atan2(sin φ, s·cos φ), not φ, and its own length is scaled by
 * |(s·cos φ, sin φ)|. The rotate key `turn − turn above` assumes unit scale. A
 * mapped bone below a scaled bone is therefore keyed through its parent's
 * posed matrix (`posePath`): with rig-c's semantics, a `rotate` key k and a
 * `scalex` key s' make the bone's local matrix R(k) · L · diag(s', 1), L its
 * setup local matrix (from rig-c's setup world matrices), so k and s' are the
 * ones that put its world x axis on the target angle at the asked length. Its
 * art is still sheared by the parent's scale; that is measured, not hidden
 * (`shear` in the report).
 *
 * **Planted feet.** The hip is no longer the pose's mid_hip travel scaled. On
 * every frame one foot supports: the one whose reference ankle is lower in the
 * picture, changing only when the other ankle has been ≥ `PLANT_SWITCH` leg
 * lengths lower for ≥ `PLANT_SWITCH_SECONDS`. The supporting foot is held where
 * it was on the frame it took support, and the hip is placed so it stays there,
 * through the posed (scaled) legs. A change of support blends the two
 * derivations over `PLANT_BLEND` frames. A jump — both ankles and mid_hip more
 * than `JUMP_RISE` leg lengths above their rolling floor (the 95th-percentile
 * picture y over ± `FLOOR_SECONDS`), for ≥ `JUMP_FRAMES` frames — releases the
 * plant: the hip follows the pose's travel from where it was, and re-plants on
 * landing. A step does too: while the supporting ankle moves more than
 * `STEP_SPEED` leg lengths a frame its plant is released, the other foot takes
 * support if it is planted (not released, not moving) and otherwise the hip
 * follows the pose; the released ankle may support again once it has moved
 * less than `STILL_SPEED` for `STILL_FRAMES` frames (rig-c/pose#47, round 2).
 * The floor is rolling because an ankle's picture y drifts with depth: under
 * one floor for the sequence, HQ's dancer standing still read as jumping.
 */
import type { Chain, JointMap, Rest } from './map.ts';

type Pt = [number, number];
/** A world 2×2: columns (a, c) — the x axis — and (b, d) — the y axis. */
export type M2 = [number, number, number, number];

const DEG = 180 / Math.PI;

/** A change of support needs the other ankle this many leg lengths lower … */
export const PLANT_SWITCH = 0.02;
/** … for at least this long, in seconds (first frame's time to the end of the last, as END-ON times a run). */
export const PLANT_SWITCH_SECONDS = 0.1;
/** A change of support (and a landing) blends the hip over this many frames. */
export const PLANT_BLEND = 3;
/** Both ankles and mid_hip more than this many leg lengths above their rolling floors: a jump. */
export const JUMP_RISE = 0.05;
/** A rolling floor: this percentile of the picture y around the frame. */
export const FLOOR_PERCENTILE = 0.95;
/** A segment's straight length: this percentile of its picture length over the sequence. */
export const STRAIGHT_PERCENTILE = 0.95;

export type Side = 'r' | 'l';
export const SIDES: readonly Side[] = ['r', 'l'];

/** A segment of one side's hip, knee and ankle. */
export function isLegSegment(a: string, b: string): boolean {
  const side = (x: string) => (x.startsWith('r_') ? 'r' : x.startsWith('l_') ? 'l' : null);
  if (a === b || side(a) === null || side(a) !== side(b)) return false;
  const LEG = ['hip', 'knee', 'ankle'];
  return LEG.includes(a.slice(2)) && LEG.includes(b.slice(2));
}

/** Linear-interpolated percentile (numpy's default) of the finite values. */
export function percentile(xs: readonly number[], q: number): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export interface Leg {
  side: Side;
  chain: Chain;
  /** The chain's last bone: its x axis ends at the ankle (`<bone>:tip`). */
  ankleBone: string;
}

/**
 * Each side's leg: the (non-reach) chain whose last joint is that side's
 * ankle. Every refusal names what it found.
 */
export function legsOf(map: JointMap, why: string): { legs: Record<Side, Leg> } | { problems: string[] } {
  const problems: string[] = [];
  const legs: Partial<Record<Side, Leg>> = {};
  for (const side of SIDES) {
    const ankle = `${side}_ankle`;
    const found = map.chains.filter((c) => !c.reach && c.joints[c.joints.length - 1] === ankle);
    if (found.length !== 1) {
      problems.push(`${why} needs one chain ending at "${ankle}" (its last bone's x axis ends at the ankle); the map has ${found.length === 0 ? 'none' : found.map((c) => `"${c.name}"`).join(', ')}`);
      continue;
    }
    const chain = found[0]!;
    const k = chain.bones.length - 1;
    if (chain.aim[k] !== 'x') problems.push(`${why}: chain "${chain.name}" ends at "${ankle}" with bone "${chain.bones[k]}" aimed ${JSON.stringify(chain.aim[k])}; the ankle is read as that bone's tip, so it must be aimed along its own x axis ("x")`);
    legs[side] = { side, chain, ankleBone: chain.bones[k]! };
  }
  return problems.length > 0 ? { problems } : { legs: legs as Record<Side, Leg> };
}

// --- 2×2 -------------------------------------------------------------------

const mul = (p: M2, q: M2): M2 => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
const inv = (m: M2): M2 => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
};
const apply = (m: M2, v: Pt): Pt => [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
const rot = (deg: number): M2 => {
  const r = deg / DEG;
  return [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)];
};
const scaleX = (s: number): M2 => [s, 0, 0, 1];
export const restMatrix = (rest: Rest, bone: string): M2 => {
  const b = rest.get(bone)!;
  return [b.a, b.b, b.c, b.d];
};

/**
 * How one mapped bone is posed on a frame: its world turn from setup (the
 * target less the rest angle), its target (the world angle of its aim), whether
 * its aim is its own x axis, and the scale asked of its x axis (1: none).
 */
export interface Posing {
  turn: number;
  target: number;
  aimX: boolean;
}

export interface PathPose {
  /** Each bone's posed origin, relative to the first bone's origin. */
  origin: Map<string, Pt>;
  /** Each bone's posed world 2×2. */
  m: Map<string, M2>;
  /** For a mapped bone under a scaled bone: the rotate key (degrees, wrapped) and the scalex key that land it. */
  solved: Map<string, { rotate: number; scale: number }>;
}

/**
 * Pose a path of bones, parents first, the first the path's top (its origin is
 * (0, 0)). A mapped bone with no scaled bone above it turns rigidly from setup
 * (R(turn) · setup world · diag(scale, 1)); a mapped bone under a scaled bone
 * is solved through its parent's posed matrix (the header); an unmapped bone
 * keeps its setup local matrix. Every setup matrix and origin is rig-c's.
 */
export function posePath(rest: Rest, path: readonly string[], posing: (b: string) => Posing | null, scaleOf: (b: string) => number | null): PathPose | string {
  const origin = new Map<string, Pt>();
  const m = new Map<string, M2>();
  const solved = new Map<string, { rotate: number; scale: number }>();
  const scaledAbove = new Set<string>();
  for (const b of path) {
    const rb = rest.get(b)!;
    const W0 = restMatrix(rest, b);
    const pz = posing(b);
    const s = scaleOf(b) ?? 1;
    const p = rb.parent;
    const top = origin.size === 0;
    if (top || p === null || !m.has(p)) {
      if (!top) return `bone "${b}" is on the path but its parent "${p}" is not`;
      origin.set(b, [0, 0]);
      m.set(b, mul(mul(rot(pz?.turn ?? 0), W0), scaleX(s)));
      if (scaleOf(b) !== null) scaledAbove.add(b);
      continue;
    }
    const Wp0 = restMatrix(rest, p);
    const Wp = m.get(p)!;
    const rp = rest.get(p)!;
    const local = apply(inv(Wp0), [rb.worldX - rp.worldX, rb.worldY - rp.worldY]);
    const po = origin.get(p)!;
    const o = apply(Wp, local);
    origin.set(b, [po[0] + o[0], po[1] + o[1]]);
    const L0 = mul(inv(Wp0), W0);
    const under = scaledAbove.has(p);
    if (pz === null) m.set(b, mul(Wp, L0));
    else if (!under) m.set(b, mul(mul(rot(pz.turn), W0), scaleX(s)));
    else {
      if (!pz.aimX) return `bone "${b}" is mapped under a scaled bone and aimed other than along its x axis; only an "x" aim is solved through a scaled parent`;
      const len0 = Math.hypot(W0[0], W0[2]);
      const X: Pt = [s * len0 * Math.cos(pz.target / DEG), s * len0 * Math.sin(pz.target / DEG)];
      const v = apply(inv(Wp), X);
      const l0: Pt = [L0[0], L0[2]];
      const k = (Math.atan2(v[1], v[0]) - Math.atan2(l0[1], l0[0])) * DEG;
      const sk = Math.hypot(v[0], v[1]) / Math.hypot(l0[0], l0[1]);
      m.set(b, mul(mul(mul(Wp, rot(k)), L0), scaleX(sk)));
      solved.set(b, { rotate: k, scale: sk });
    }
    if (under || scaleOf(b) !== null) scaledAbove.add(b);
  }
  return { origin, m, solved };
}

/** Where `bone`'s x axis ends on a posed path: its origin plus its world x column times its length. */
export function tipOf(rest: Rest, pose: PathPose, bone: string): Pt {
  const o = pose.origin.get(bone)!;
  const w = pose.m.get(bone)!;
  const len = rest.get(bone)!.length;
  return [o[0] + w[0] * len, o[1] + w[2] * len];
}

/** The bones from `top` down to each of `ends` (inclusive), parents first; null when an end does not descend from top. */
export function pathFrom(rest: Rest, top: string, ends: readonly string[]): string[] | null {
  const set = new Set<string>([top]);
  for (const e of ends) {
    const up: string[] = [];
    let b: string | null = e;
    while (b !== null && b !== top) {
      up.push(b);
      b = rest.get(b)!.parent;
    }
    if (b === null) return null;
    for (const x of up) set.add(x);
  }
  const depth = (b: string): number => {
    let d = 0;
    for (let a = rest.get(b)!.parent; a !== null; a = rest.get(a)!.parent) d++;
    return d;
  };
  return [...set].sort((x, y) => depth(x) - depth(y) || (x < y ? -1 : x > y ? 1 : 0));
}

/** The root of `b`'s ancestry. */
export function rootOf(rest: Rest, b: string): string {
  let x = b;
  for (let p = rest.get(x)!.parent; p !== null; p = rest.get(x)!.parent) x = p;
  return x;
}

// --- leg scale -------------------------------------------------------------

export interface LegScale {
  chain: string;
  bone: string;
  joints: [string, string];
  /** The straight length: the 95th percentile of the segment's picture length, px. */
  straight: number;
  /** The picture length over the straight length, before the clamp: lowest, median, highest. */
  ratio: { min: number; median: number; max: number };
  /** The range the scale is clamped to. */
  limits: [number, number];
  /** Runs of frames clamped at the low and at the high limit. */
  low: Array<[number, number]>;
  high: Array<[number, number]>;
  /** The scale keyed on each frame (clamped). */
  scale: number[];
}

/** One segment's scale per frame: picture length ÷ its 95th percentile, clamped; and the runs clamped. */
export function legScaleOf(lengths: readonly number[], limits: [number, number]): Omit<LegScale, 'chain' | 'bone' | 'joints'> {
  const straight = percentile(lengths, STRAIGHT_PERCENTILE);
  const ratio = lengths.map((l) => l / straight);
  const scale = ratio.map((r) => Math.min(Math.max(r, limits[0]), limits[1]));
  const sorted = [...ratio].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return {
    straight,
    ratio: { min: sorted[0]!, median, max: sorted[sorted.length - 1]! },
    limits,
    low: runs(ratio.map((r) => r < limits[0])),
    high: runs(ratio.map((r) => r > limits[1])),
    scale,
  };
}

function runs(flags: readonly boolean[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    let j = i;
    while (j + 1 < flags.length && flags[j + 1]) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

// --- supports, jumps and steps ---------------------------------------------

/** The points a jump reads, each above its rolling floor by more than `JUMP_RISE` leg lengths. */
export const JUMP_POINTS = ['r_ankle', 'l_ankle', 'mid_hip'] as const;
/** A jump lasts at least this many frames. */
export const JUMP_FRAMES = 2;
/** A rolling floor: `FLOOR_PERCENTILE` of the picture y over ± this many seconds around the frame. */
export const FLOOR_SECONDS = 1.0;
/** A supporting ankle moving more than this many leg lengths a frame is stepping: its plant is released. */
export const STEP_SPEED = 0.03;
/** A released ankle re-plants once it moves less than this many leg lengths a frame … */
export const STILL_SPEED = 0.01;
/** … for this many frames. */
export const STILL_FRAMES = 2;

export interface Step {
  side: Side;
  /** First frame the ankle moved past `STEP_SPEED`, and the last frame before it re-planted (or the last frame). */
  frames: [number, number];
  /** The frame it re-planted on (still for `STILL_FRAMES`), or null if it never did. */
  replant: number | null;
  /** The side that took support when it released, or null: the hip followed the pose's travel. */
  to: Side | null;
}

export interface Feet {
  /** Each side's median picture length hip → ankle, px; the unit of every threshold below (mid_hip: their mean). */
  legLength: Record<Side, number>;
  /** Per frame: the side that supports, or null (a jump, or a step with no other foot planted). */
  support: Array<Side | null>;
  /** Runs of one supporting side: [first, last] frames and the side. */
  supports: Array<{ side: Side; frames: [number, number] }>;
  /** Runs of jump frames. */
  jumps: Array<[number, number]>;
  /** Every release of a supporting foot by a step. */
  steps: Step[];
  /** The frames a change of support (or a landing, or a re-plant) was keyed on: the blend starts there. */
  changes: Array<{ frame: number; from: Side | null; to: Side }>;
}

/** Each frame's rolling floor of a picture-y series: its `FLOOR_PERCENTILE` over the frames within ± `FLOOR_SECONDS`. */
export function rollingFloor(ys: readonly number[], times: readonly number[]): number[] {
  return ys.map((_, i) => {
    const w: number[] = [];
    for (let j = 0; j < ys.length; j++) if (Math.abs(times[j]! - times[i]!) <= FLOOR_SECONDS + 1e-9) w.push(ys[j]!);
    return percentile(w, FLOOR_PERCENTILE);
  });
}

/**
 * Which foot supports on each frame, from the reference ankles and hips (picture
 * px, y down) — the header's rules. `times` are the key times; `secondsOf`
 * times a run of frames as the rest of the retarget does.
 */
export function supportsOf(ankle: Record<Side, readonly Pt[]>, hip: Record<Side, readonly Pt[]>, times: readonly number[], secondsOf: (run: [number, number]) => number): Feet {
  const n = ankle.r.length;
  const legLength = {} as Record<Side, number>;
  for (const s of SIDES) legLength[s] = percentile(ankle[s].map((a, i) => Math.hypot(a[0] - hip[s][i]![0], a[1] - hip[s][i]![1])), 0.5);
  const mean = (legLength.r + legLength.l) / 2;
  // A jump: both ankles and mid_hip above their rolling floors, for ≥ JUMP_FRAMES frames.
  const midY = hip.r.map((h, i) => (h[1] + hip.l[i]![1]) / 2);
  const rises: Array<{ ys: number[]; unit: number }> = [
    { ys: ankle.r.map((a) => a[1]), unit: legLength.r },
    { ys: ankle.l.map((a) => a[1]), unit: legLength.l },
    { ys: midY, unit: mean },
  ];
  const up = rises.map(({ ys, unit }) => {
    const floor = rollingFloor(ys, times);
    return ys.map((y, i) => floor[i]! - y > JUMP_RISE * unit);
  });
  const lifted = Array.from({ length: n }, (_, i) => up.every((u) => u[i]));
  const jumps = runs(lifted).filter(([a, b]) => b - a + 1 >= JUMP_FRAMES);
  const jump = new Array<boolean>(n).fill(false);
  for (const [a, b] of jumps) for (let i = a; i <= b; i++) jump[i] = true;
  // Ankle speeds, leg lengths a frame (0 on the first frame).
  const speed = {} as Record<Side, number[]>;
  for (const s of SIDES) speed[s] = ankle[s].map((a, i) => (i === 0 ? 0 : Math.hypot(a[0] - ankle[s][i - 1]![0], a[1] - ankle[s][i - 1]![1]) / legLength[s]));
  const moving = (s: Side, i: number) => speed[s][i]! > STEP_SPEED;
  const still = (s: Side, i: number) => {
    for (let k = i - STILL_FRAMES + 1; k <= i; k++) if (k >= 0 && !(speed[s][k]! < STILL_SPEED)) return false;
    return true;
  };
  const support: Array<Side | null> = new Array<Side | null>(n).fill(null);
  const changes: Feet['changes'] = [];
  const steps: Step[] = [];
  const open: Partial<Record<Side, Step>> = {};
  let cur: Side | null = null;
  let lowerFrom = -1;
  const lower = (cands: Side[], i: number): Side => (cands.length === 2 ? (ankle.l[i]![1] > ankle.r[i]![1] ? 'l' : 'r') : cands[0]!);
  for (let i = 0; i < n; i++) {
    // A released ankle re-plants once it has been still for STILL_FRAMES frames.
    for (const s of SIDES) {
      const st = open[s];
      if (st !== undefined && still(s, i)) {
        st.replant = i;
        st.frames[1] = i - 1;
        delete open[s];
      }
    }
    if (jump[i]) {
      cur = null;
      lowerFrom = -1;
      continue;
    }
    const free = (s: Side) => open[s] === undefined && !moving(s, i);
    if (cur !== null && moving(cur, i)) {
      const other: Side = cur === 'r' ? 'l' : 'r';
      const to: Side | null = free(other) ? other : null;
      const st: Step = { side: cur, frames: [i, n - 1], replant: null, to };
      steps.push(st);
      open[cur] = st;
      if (to !== null) changes.push({ frame: i, from: cur, to });
      cur = to;
      lowerFrom = -1;
    } else if (cur === null) {
      const cands = SIDES.filter(free);
      if (cands.length > 0) {
        cur = lower(cands, i);
        changes.push({ frame: i, from: null, to: cur });
        lowerFrom = -1;
      }
    } else {
      const other: Side = cur === 'r' ? 'l' : 'r';
      if (free(other) && ankle[other][i]![1] - ankle[cur][i]![1] >= PLANT_SWITCH * mean) {
        if (lowerFrom < 0) lowerFrom = i;
        if (secondsOf([lowerFrom, i]) >= PLANT_SWITCH_SECONDS - 1e-9) {
          changes.push({ frame: i, from: cur, to: other });
          cur = other;
          lowerFrom = -1;
        }
      } else lowerFrom = -1;
    }
    support[i] = cur;
  }
  const supports: Feet['supports'] = [];
  for (let i = 0; i < n; i++) {
    const s = support[i];
    if (s === null || s === undefined) continue;
    const last = supports[supports.length - 1];
    if (last !== undefined && last.side === s && last.frames[1] === i - 1) last.frames[1] = i;
    else supports.push({ side: s, frames: [i, i] });
  }
  return { legLength, support, supports, jumps, steps, changes };
}

/**
 * The hip's world origin on every frame, from the supporting foot (header).
 * `offset(i, side)` is the ankle's posed position relative to the hip's origin
 * on frame i; `travel(i)` the pose's own travel of the hip from frame 0, world.
 * `start` is the hip's origin on frame 0 (its setup origin).
 */
export function plantHip(feet: Feet, offset: (i: number, s: Side) => Pt, travel: (i: number) => Pt, start: Pt): Pt[] {
  const n = feet.support.length;
  const hip: Pt[] = [];
  /** How the hip is derived on a frame: held over a foot's anchor, or carried by the pose's travel from a frame's hip. */
  type Mode = { kind: 'plant'; side: Side; anchor: Pt } | { kind: 'travel'; from: number; at: Pt };
  const of = (mode: Mode, i: number): Pt => {
    if (mode.kind === 'plant') {
      const o = offset(i, mode.side);
      return [mode.anchor[0] - o[0], mode.anchor[1] - o[1]];
    }
    const a = travel(i);
    const b = travel(mode.from);
    return [mode.at[0] + a[0] - b[0], mode.at[1] + a[1] - b[1]];
  };
  let mode: Mode | null = null;
  let from: Mode | null = null;
  let blendAt = -1;
  for (let i = 0; i < n; i++) {
    const s = feet.support[i] ?? null;
    if (i === 0) {
      if (s === null) mode = { kind: 'travel', from: 0, at: start };
      else {
        const o = offset(0, s);
        mode = { kind: 'plant', side: s, anchor: [start[0] + o[0], start[1] + o[1]] };
      }
    } else if (s === null && mode!.kind === 'plant') {
      mode = { kind: 'travel', from: i - 1, at: hip[i - 1]! };
      from = null;
      blendAt = -1;
    } else if (s !== null && (mode!.kind === 'travel' || (mode as { side: Side }).side !== s)) {
      // The new support is held where it is on this frame, under the hip the old derivation gives here.
      const here = of(mode!, i);
      const o = offset(i, s);
      from = mode;
      mode = { kind: 'plant', side: s, anchor: [here[0] + o[0], here[1] + o[1]] };
      blendAt = i;
    }
    const to = of(mode!, i);
    if (from !== null && i - blendAt < PLANT_BLEND) {
      const w = (i - blendAt + 1) / (PLANT_BLEND + 1);
      const f = of(from, i);
      hip.push([f[0] + (to[0] - f[0]) * w, f[1] + (to[1] - f[1]) * w]);
    } else {
      from = null;
      hip.push(to);
    }
  }
  return hip;
}
