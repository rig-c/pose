/**
 * The retarget: a pose sequence and a joint map, over a rig's setup pose, to one
 * animation in rig-c's motion format. Pure — no file, no clock, no process.
 *
 * Per frame and per mapped bone, the segment the bone carries points somewhere
 * in the picture. Its angle in Spine's world (y up, counter-clockwise; the flip
 * is rig-c's `screenToSpineDegrees`) minus the bone's rest angle (its aim at
 * the setup pose, by rig-c's poser) is how far the bone must turn in the world,
 * `D`. rig-c's `rotate` key ADDS to the setup rotation, and a child with the
 * `normal` inherit mode turns with its parent, so the key is the bone's turn
 * less the turn of the nearest mapped bone above it: `key = D(bone) − D(parent)`.
 * Keys are unwrapped across frames, because the runtime interpolates an angle as
 * a plain number (350 → 10 passes through 180).
 *
 * What this cannot know is held to account afterwards: `verify.ts` poses the
 * gated build with rig-c's poser and measures where each bone landed.
 */
import { screenToSpineDegrees } from 'rig-c/transform';
import type { Body18 } from './joints.ts';
import { isBody18, VIRTUAL } from './joints.ts';
import type { Chain, JointMap, Rest } from './map.ts';
import { rigPoint } from './map.ts';
import type { Joint } from './pose.ts';
import { Problems } from './problems.ts';

const DEG = 180 / Math.PI;

export interface RetargetOptions {
  /** A joint with a score below this is not good on that frame (a joint with no score is). */
  minScore: number;
  /** Centered moving-average window over joint positions, in frames; 1 = none. Odd. */
  smooth: number;
  /** What a hinge bent the wrong way does: refuse the run, or straighten that hinge on that frame. */
  bends: 'refuse' | 'clamp';
  /** Degrees past straight a hinge may bend the wrong way before it counts. */
  bendTolerance: number;
}

export interface Hold {
  point: string;
  /** First and last frame index held. */
  from: number;
  to: number;
  /** The frame whose value was used. */
  source: number;
  why: string;
}

export interface BendEvent {
  chain: string;
  joint: string;
  frame: number;
  t: number;
  /** The inner angle found, degrees, Spine's sense (counter-clockwise +). */
  angle: number;
  /** The side the hinge may bend: +1 counter-clockwise, −1 clockwise. */
  side: 1 | -1;
  rest: number;
}

export interface MotionKey {
  t: number;
  v: number[];
}
export interface MotionTrack {
  bone: string;
  property: 'rotate' | 'translate';
  keys: MotionKey[];
}
export interface Animation {
  duration: number;
  tracks: MotionTrack[];
}

export interface Retarget {
  animation: Animation;
  /** Key times, seconds from the first frame, as written. */
  times: number[];
  /** Per mapped bone, the world angle (Spine degrees) its aim must reach on each frame. */
  targets: Map<string, number[]>;
  /** The translated bone's world origin on each frame, when the map translates one. */
  origin: { bone: string; at: Array<[number, number]> } | null;
  holds: Hold[];
  bends: BendEvent[];
  /** The figure scale, rig units per picture pixel, and the lengths it came from. */
  scale: { factor: number; pose: number; rig: number } | null;
}

type Pt = [number, number];

/** The value of a point on one frame, or why it is not good. */
function pointOn(joints: Partial<Record<Body18, Joint>>, name: string, minScore: number): Pt | string {
  if (isBody18(name)) {
    const j = joints[name];
    if (j === undefined || j.state === 'missing') return 'missing';
    if (j.at === undefined) return `${j.state} without a position`;
    if (j.score !== undefined && j.score < minScore) return `score ${j.score.toFixed(3)} < ${minScore}`;
    return j.at;
  }
  const pair = VIRTUAL[name];
  if (pair === undefined) return 'not a point';
  const a = pointOn(joints, pair[0], minScore);
  const b = pointOn(joints, pair[1], minScore);
  if (typeof a === 'string') return `${pair[0]} ${a}`;
  if (typeof b === 'string') return `${pair[1]} ${b}`;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

export function wrap(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Spine world degrees of a picture-space direction (y down). */
export function pictureAngle(from: Pt, to: Pt): number {
  return screenToSpineDegrees(Math.atan2(to[1] - from[1], to[0] - from[0]) * DEG);
}

/** The rest angle of a mapped bone's aim, Spine world degrees, from rig-c's setup pose. */
export function restAngle(rest: Rest, bone: string, aim: string): number {
  const b = rest.get(bone)!;
  if (aim === 'x') return Math.atan2(b.c, b.a) * DEG;
  const a = rest.get(aim)!;
  return Math.atan2(a.worldY - b.worldY, a.worldX - b.worldX) * DEG;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function smoothSeries(xs: Pt[], window: number): Pt[] {
  if (window <= 1) return xs;
  const h = window >> 1;
  return xs.map((_, i) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(xs.length - 1, i + h); k++) {
      sx += xs[k]![0];
      sy += xs[k]![1];
      n++;
    }
    return [sx / n, sy / n];
  });
}

const r3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Retarget. Refuses (every reason at once) when a point the map needs is never
 * good, when a hinge's side cannot be read off a straight rest, and — with
 * `bends: 'refuse'` — when a hinge bends the wrong way.
 */
export function retarget(rest: Rest, map: JointMap, frames: ReadonlyArray<Partial<Record<Body18, Joint>>>, times: readonly number[], opts: RetargetOptions): Retarget {
  const p = new Problems();
  const n = frames.length;
  const t0 = times[0]!;
  const keyTimes = times.map((t) => Math.round((t - t0) * 1e6) / 1e6);
  for (let i = 1; i < n; i++) {
    if (keyTimes[i]! <= keyTimes[i - 1]!) p.add('POSE_TIME', `frames ${i - 1} and ${i} are ${keyTimes[i - 1]}s and ${keyTimes[i]}s after rounding to the microsecond; keys must strictly increase`);
  }

  // Every point the map reads, held where it is not good.
  const needed = new Set<string>();
  for (const c of map.chains) c.joints.forEach((j) => needed.add(j));
  if (map.translate !== null) {
    needed.add(map.translate.joint);
    map.translate.scale.pose.forEach((j) => needed.add(j));
  }
  const series = new Map<string, Pt[]>();
  const good = new Map<string, boolean[]>();
  const holds: Hold[] = [];
  for (const name of [...needed].sort()) {
    const raw = frames.map((f) => pointOn(f, name, opts.minScore));
    const firstGood = raw.findIndex((v) => typeof v !== 'string');
    if (firstGood < 0) {
      const why = [...new Set(raw as string[])].slice(0, 3).join('; ');
      p.add('POSE_POINT_NEVER_GOOD', `point "${name}" is good on none of the ${n} frames (${why}); the map needs it, and there is no value to hold`);
      continue;
    }
    const out: Pt[] = [];
    let last = firstGood;
    let span: Hold | null = null;
    for (let i = 0; i < n; i++) {
      const v = raw[i]!;
      if (typeof v !== 'string') {
        out.push(v);
        last = i;
        span = null;
        continue;
      }
      out.push(raw[last]! as Pt);
      if (span !== null && span.source === last && span.why === v) span.to = i;
      else {
        span = { point: name, from: i, to: i, source: last, why: v };
        holds.push(span);
      }
    }
    series.set(name, smoothSeries(out, opts.smooth));
    good.set(name, raw.map((v) => typeof v !== 'string'));
  }
  p.throwIfAny();

  // Each mapped bone's target world angle per frame.
  const targets = new Map<string, number[]>();
  const restOf = new Map<string, number>();
  for (const c of map.chains) {
    c.bones.forEach((b, k) => {
      const from = series.get(c.joints[k]!)!;
      const to = series.get(c.joints[k + 1]!)!;
      const angles: number[] = [];
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(to[i]![0] - from[i]![0], to[i]![1] - from[i]![1]);
        angles.push(d > 1e-9 ? pictureAngle(from[i]!, to[i]!) : (angles[i - 1] ?? NaN));
      }
      const firstReal = angles.findIndex((a) => !Number.isNaN(a));
      if (firstReal < 0) p.add('POSE_SEGMENT_ZERO', `chain "${c.name}" — bone "${b}"'s segment ${c.joints[k]} → ${c.joints[k + 1]} has zero length on every frame; it has no direction`);
      for (let i = 0; i < firstReal; i++) angles[i] = angles[firstReal]!;
      targets.set(b, angles);
      restOf.set(b, restAngle(rest, b, c.aim[k]!));
    });
  }
  p.throwIfAny();

  // Hinges: each joint strictly inside a chain.
  const bends: BendEvent[] = [];
  for (const c of map.chains) {
    for (let k = 1; k < c.bones.length; k++) checkHinge(c, k, targets, restOf, keyTimes, opts, bends, p);
  }
  if (opts.bends === 'refuse' && bends.length > 0) {
    for (const e of bends) p.add('POSE_BEND_ONE_WAY', bendLine(e));
  }
  p.throwIfAny();

  // Keys: the bone's turn less the turn of the nearest mapped bone above it.
  const mappedAbove = (b: string): string | null => {
    for (let a = rest.get(b)!.parent; a !== null; a = rest.get(a)!.parent) if (targets.has(a)) return a;
    return null;
  };
  const tracks: MotionTrack[] = [];
  for (const c of map.chains) {
    for (const b of c.bones) {
      const above = mappedAbove(b);
      const turn = (bone: string, i: number) => targets.get(bone)![i]! - restOf.get(bone)!;
      let prev = 0;
      const keys: MotionKey[] = [];
      for (let i = 0; i < n; i++) {
        const raw = turn(b, i) - (above === null ? 0 : turn(above, i));
        const v = i === 0 ? wrap(raw) : prev + wrap(raw - prev);
        prev = v;
        keys.push({ t: keyTimes[i]!, v: [r3(v)] });
      }
      tracks.push({ bone: b, property: 'rotate', keys });
    }
  }

  // The hip: the travel of one point, scaled, in its parent's axes.
  let origin: Retarget['origin'] = null;
  let scale: Retarget['scale'] = null;
  const t = map.translate;
  if (t !== null) {
    const [pa, pb] = t.scale.pose;
    const ga = good.get(pa)!;
    const gb = good.get(pb)!;
    const lengths: number[] = [];
    const A = series.get(pa)!;
    const B = series.get(pb)!;
    for (let i = 0; i < n; i++) if (ga[i] && gb[i]) lengths.push(Math.hypot(B[i]![0] - A[i]![0], B[i]![1] - A[i]![1]));
    const [ra, rb] = t.scale.rig.map((r) => rigPoint(rest, r)!) as [Pt, Pt];
    const rigLen = Math.hypot(rb[0] - ra[0], rb[1] - ra[1]);
    if (lengths.length === 0) p.add('POSE_SCALE', `"translate" "scale.pose" ${pa} → ${pb} is good on no frame where both points are; the figure scale cannot be measured`);
    else {
      const poseLen = median(lengths);
      if (poseLen < 1e-6) p.add('POSE_SCALE', `"translate" "scale.pose" ${pa} → ${pb} has median length ${poseLen}px; the figure scale cannot be measured`);
      else {
        const s = rigLen / poseLen;
        scale = { factor: s, pose: poseLen, rig: rigLen };
        const P = series.get(t.joint)!;
        const bone = rest.get(t.bone)!;
        const parent = bone.parent === null ? null : rest.get(bone.parent)!;
        const keys: MotionKey[] = [];
        const at: Pt[] = [];
        for (let i = 0; i < n; i++) {
          const wx = (P[i]![0] - P[0]![0]) * s;
          const wy = -(P[i]![1] - P[0]![1]) * s;
          let lx = wx;
          let ly = wy;
          if (parent !== null) {
            const det = parent.a * parent.d - parent.b * parent.c;
            lx = (parent.d * wx - parent.b * wy) / det;
            ly = (-parent.c * wx + parent.a * wy) / det;
          }
          keys.push({ t: keyTimes[i]!, v: [r3(lx), r3(ly)] });
          at.push([bone.worldX + wx, bone.worldY + wy]);
        }
        tracks.push({ bone: t.bone, property: 'translate', keys });
        origin = { bone: t.bone, at };
      }
    }
  }
  p.throwIfAny();

  return { animation: { duration: keyTimes[n - 1]!, tracks }, times: keyTimes, targets, origin, holds, bends, scale };
}

function checkHinge(c: Chain, k: number, targets: Map<string, number[]>, restOf: Map<string, number>, times: readonly number[], opts: RetargetOptions, out: BendEvent[], p: Problems): void {
  if (c.bend === 'free') return;
  const upper = c.bones[k - 1]!;
  const lower = c.bones[k]!;
  const joint = c.joints[k]!;
  const restInner = wrap(restOf.get(lower)! - restOf.get(upper)!);
  let side: 1 | -1;
  if (c.bend === 'ccw') side = 1;
  else if (c.bend === 'cw') side = -1;
  else {
    if (Math.abs(restInner) < 0.5) {
      p.add('MAP_BEND_SIDE', `chain "${c.name}" — the hinge at ${joint} is straight at rest (inner angle ${restInner.toFixed(3)}°), so the rest pose does not say which way it bends; state "bend": "ccw", "cw" or "free"`);
      return;
    }
    side = restInner > 0 ? 1 : -1;
  }
  const up = targets.get(upper)!;
  const lo = targets.get(lower)!;
  for (let i = 0; i < up.length; i++) {
    const inner = wrap(lo[i]! - up[i]!);
    if (inner * side < -opts.bendTolerance) {
      out.push({ chain: c.name, joint, frame: i, t: times[i]!, angle: inner, side, rest: restInner });
      if (opts.bends === 'clamp') lo[i] = up[i]!;
    }
  }
}

export function bendLine(e: BendEvent): string {
  const sense = e.side > 0 ? 'counter-clockwise (+)' : 'clockwise (−)';
  return `chain "${e.chain}" hinge ${e.joint}, frame ${e.frame} (t=${e.t.toFixed(3)}s) — inner angle ${e.angle.toFixed(1)}°; it bends ${sense} at rest (${e.rest.toFixed(1)}°), so the angle must stay ${e.side > 0 ? '≥' : '≤'} 0`;
}

/** Holds grouped per point, one line each span. */
export function holdLine(h: Hold, times: readonly number[]): string {
  const span = h.from === h.to ? `frame ${h.from} (t=${times[h.from]!.toFixed(3)}s)` : `frames ${h.from}–${h.to} (t=${times[h.from]!.toFixed(3)}–${times[h.to]!.toFixed(3)}s)`;
  return `point "${h.point}" ${span}: ${h.why}; held frame ${h.source}'s value`;
}
