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
 * A chain with `reach` (a trunk from mid_hip) is the one exception to "the
 * bone points along the pose's segment": its bone is aimed from where its
 * origin is posed — the translated bone moved by the hip's travel, and every
 * bone between turned by the nearest mapped bone above it — at the point the
 * pose puts the segment's end, relative to the translated joint and scaled. So
 * the hip and its travel are computed before any bone's target.
 *
 * Smoothing is Savitzky–Golay: a centred least-squares cubic over the window,
 * evaluated at the frame, on each joint's positions after its holds. Centred,
 * it moves no motion in time; a cubic keeps a peak a moving average flattens.
 *
 * The flip guard (rig-c/pose#15) then spreads a segment's turn greater than
 * `flip` degrees in one frame over the frames around it, linearly and centred on
 * the jump (`spreadFlips`). It reads the mapped segments' target angles after
 * holds and smoothing and before the hinge check. A reach's target is aimed
 * later, from posed positions, and is not guarded.
 *
 * What this cannot know is held to account afterwards: `verify.ts` poses the
 * gated build with rig-c's poser and measures where each bone landed.
 */
import { screenToSpineDegrees } from 'rig-c/transform';
import type { Body18 } from './joints.ts';
import { isBody18, VIRTUAL } from './joints.ts';
import type { Chain, JointMap, Rest } from './map.ts';
import { aimAngle, rigPoint } from './map.ts';
import type { Joint } from './pose.ts';
import { Problems } from './problems.ts';

const DEG = 180 / Math.PI;

export interface RetargetOptions {
  /** A joint with a score below this is not good on that frame (a joint with no score is). */
  minScore: number;
  /** Savitzky–Golay window over joint positions, in frames: 1 = none, else odd and ≥ 5. */
  smooth: number;
  /** What a hinge bent the wrong way does: refuse the run, or straighten that hinge on that frame. */
  bends: 'refuse' | 'clamp';
  /** Degrees past straight a hinge may bend the wrong way before it counts. */
  bendTolerance: number;
  /** A segment turning more than this many degrees in one frame is spread (`spreadFlips`); 'off' keeps every turn. */
  flip: number | 'off';
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

/** One spread: a segment's turn over the threshold, and the frames whose angle was replaced. */
export interface Flip {
  chain: string;
  bone: string;
  /** The segment the bone carries: from joint, to joint. */
  joints: [string, string];
  /** The largest input turn in the spread, degrees, signed (Spine's sense, counter-clockwise +). */
  jump: number;
  /** Every input turn over the threshold the spread covers: `frame` is k, the turn is from frame k−1 to k. */
  turns: Array<{ frame: number; jump: number }>;
  /** First and last frame whose angle was replaced; the frames either side keep the input's. */
  frames: [number, number];
  /** The half-width the spread needed (for spreads merged from neighbouring turns, the widest). */
  h: number;
  /** The one-frame turn across the spread, degrees, signed. */
  step: number;
  /** Which end of the series cut the window short, if one did. */
  clipped: 'start' | 'end' | 'both' | null;
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
  flips: Flip[];
  /** The figure scale, rig units per picture pixel, and the lengths it came from. */
  scale: { factor: number; pose: number; rig: number } | null;
}

type Pt = [number, number];

/** The value of a point on one frame, or why it is not good. */
export function pointOn(joints: Partial<Record<Body18, Joint>>, name: string, minScore: number): Pt | string {
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
  return aimAngle(rest, new Map([...rest].map(([n, b]) => [n, b.length])), bone, aim);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Savitzky–Golay, centred: at each frame, the least-squares polynomial of
 * `order` over the frames of the window that exist (clipped at the ends), read
 * at that frame. With fewer points than order + 1 the order drops to fit them
 * exactly, so a window clipped to 4 frames or fewer returns the input there.
 * A polynomial of degree ≤ `order` passes through unchanged.
 */
export function savitzkyGolay(xs: readonly Pt[], window: number, order = 3): Pt[] {
  if (window <= 1) return xs.map((x) => [x[0], x[1]]);
  const h = window >> 1;
  const n = xs.length;
  const cache = new Map<string, number[]>();
  return xs.map((_, i) => {
    const lo = Math.max(0, i - h) - i;
    const hi = Math.min(n - 1, i + h) - i;
    const key = `${lo},${hi}`;
    let w = cache.get(key);
    if (w === undefined) {
      w = sgWeights(lo, hi, Math.min(order, hi - lo));
      cache.set(key, w);
    }
    let x = 0;
    let y = 0;
    for (let u = lo; u <= hi; u++) {
      const c = w[u - lo]!;
      x += c * xs[i + u]![0];
      y += c * xs[i + u]![1];
    }
    return [x, y];
  });
}

/** The weights that read a least-squares polynomial of degree q over u = lo..hi at u = 0. */
function sgWeights(lo: number, hi: number, q: number): number[] {
  const m = q + 1;
  // Normal equations: A[j][l] = Σ u^(j+l); solve A z = e0, then w(u) = Σ z_j u^j.
  const A = Array.from({ length: m }, (_, j) => Array.from({ length: m + 1 }, (_, l) => {
    if (l === m) return j === 0 ? 1 : 0;
    let s = 0;
    for (let u = lo; u <= hi; u++) s += u ** (j + l);
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
  const w: number[] = [];
  for (let u = lo; u <= hi; u++) w.push(z.reduce((s, zj, j) => s + zj * u ** j, 0));
  return w;
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
    series.set(name, savitzkyGolay(out, opts.smooth));
    good.set(name, raw.map((v) => typeof v !== 'string'));
  }
  p.throwIfAny();

  // The hip: the travel of one point, scaled, in its parent's axes. It comes
  // first, because a reach is aimed from where the hip has put its bone.
  let origin: Retarget['origin'] = null;
  let scale: Retarget['scale'] = null;
  let translateTrack: MotionTrack | null = null;
  /** The translated bone's world travel from its setup origin, per frame. */
  const travel: Pt[] = [];
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
          travel.push([wx, wy]);
        }
        translateTrack = { bone: t.bone, property: 'translate', keys };
        origin = { bone: t.bone, at };
      }
    }
  }
  p.throwIfAny();

  // Each mapped bone's target world angle per frame, reaches last.
  const targets = new Map<string, number[]>();
  const restOf = new Map<string, number>();
  for (const c of map.chains) {
    c.bones.forEach((b, k) => {
      restOf.set(b, restAngle(rest, b, c.aim[k]!));
      if (c.reach) return;
      const from = series.get(c.joints[k]!)!;
      const to = series.get(c.joints[k + 1]!)!;
      const angles: number[] = [];
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(to[i]![0] - from[i]![0], to[i]![1] - from[i]![1]);
        angles.push(d > 1e-9 ? pictureAngle(from[i]!, to[i]!) : (angles[i - 1] ?? NaN));
      }
      fillLeading(angles, () => p.add('POSE_SEGMENT_ZERO', `chain "${c.name}" — bone "${b}"'s segment ${c.joints[k]} → ${c.joints[k + 1]} has zero length on every frame; it has no direction`));
      targets.set(b, angles);
    });
  }
  p.throwIfAny();

  // The flip guard, on every segment the pose aims directly (not a reach).
  const flips: Flip[] = [];
  if (opts.flip !== 'off') {
    const threshold = opts.flip;
    for (const c of map.chains) {
      if (c.reach) continue;
      c.bones.forEach((b, k) => {
        for (const s of spreadFlips(targets.get(b)!, threshold)) {
          flips.push({ chain: c.name, bone: b, joints: [c.joints[k]!, c.joints[k + 1]!], ...s });
        }
      });
    }
  }

  // Hinges: each joint strictly inside a chain (a reach has one bone, so none).
  const bends: BendEvent[] = [];
  for (const c of map.chains) {
    for (let k = 1; k < c.bones.length; k++) checkHinge(c, k, targets, restOf, keyTimes, opts, bends, p);
  }
  if (opts.bends === 'refuse' && bends.length > 0) {
    for (const e of bends) p.add('POSE_BEND_ONE_WAY', bendLine(e));
  }
  p.throwIfAny();

  // Reaches: from the bone's posed origin at the pose's end point, anchored at
  // the translated bone. A reach above another is aimed first.
  const depth = (b: string): number => {
    let d = 0;
    for (let a = rest.get(b)!.parent; a !== null; a = rest.get(a)!.parent) d++;
    return d;
  };
  const reaches = map.chains.filter((c) => c.reach).sort((x, y) => depth(x.bones[0]!) - depth(y.bones[0]!));
  if (reaches.length > 0 && t !== null && scale !== null) {
    const s = scale.factor;
    const tb = rest.get(t.bone)!;
    /** The world turn of `b`'s nearest mapped bone-or-ancestor, degrees, on frame i. */
    const turnAbove = (b: string, i: number): number => {
      for (let a: string | null = b; a !== null; a = rest.get(a)!.parent) {
        const tg = targets.get(a);
        if (tg !== undefined) return tg[i]! - restOf.get(a)!;
      }
      return 0;
    };
    /** Where the poser will put `b`'s origin on frame i: forward from the translated bone. */
    const posedOrigin = (b: string, i: number): Pt => {
      if (b === t.bone) return [tb.worldX + travel[i]![0], tb.worldY + travel[i]![1]];
      const parent = rest.get(b)!.parent!;
      const po = posedOrigin(parent, i);
      const r = turnAbove(parent, i) / DEG;
      const ox = rest.get(b)!.worldX - rest.get(parent)!.worldX;
      const oy = rest.get(b)!.worldY - rest.get(parent)!.worldY;
      return [po[0] + Math.cos(r) * ox - Math.sin(r) * oy, po[1] + Math.sin(r) * ox + Math.cos(r) * oy];
    };
    for (const c of reaches) {
      const b = c.bones[0]!;
      const anchor = series.get(c.joints[0]!)!;
      const end = series.get(c.joints[1]!)!;
      const angles: number[] = [];
      for (let i = 0; i < n; i++) {
        const o = posedOrigin(b, i);
        const tx = tb.worldX + travel[i]![0] + (end[i]![0] - anchor[i]![0]) * s;
        const ty = tb.worldY + travel[i]![1] - (end[i]![1] - anchor[i]![1]) * s;
        const d = Math.hypot(tx - o[0], ty - o[1]);
        angles.push(d > 1e-9 ? Math.atan2(ty - o[1], tx - o[0]) * DEG : (angles[i - 1] ?? NaN));
      }
      fillLeading(angles, () => p.add('POSE_SEGMENT_ZERO', `chain "${c.name}" — bone "${b}" reaches for ${c.joints[1]}, which the pose puts on the bone's posed origin on every frame; it has no direction`));
      targets.set(b, angles);
    }
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
  if (translateTrack !== null) tracks.push(translateTrack);

  return { animation: { duration: keyTimes[n - 1]!, tracks }, times: keyTimes, targets, origin, holds, bends, flips, scale };
}

type Spread = Omit<Flip, 'chain' | 'bone' | 'joints'>;

/**
 * The flip guard on one angle series (degrees), in place. A turn greater than
 * `threshold` from frame k−1 to frame k is spread: for the smallest h ≥ 1, the
 * angles of frames k−h…k+h−1 are replaced by the straight line from frame
 * k−h−1 to frame k+h, taken through the unwrapped series (each one-frame turn
 * the short way round, so the jump keeps its own direction), such that every
 * one-frame turn in frames k−h…k+h is at or under the threshold. It is centred
 * on the jump, so the step happens when the input put it, spread over 2h frames,
 * and both ends are the input's own angles. A window that would cross the first
 * or the last frame stops there (`clipped`). Windows that overlap — one replaces
 * a frame the other ends on — merge into one line over both, widened again
 * while that line still turns faster than the threshold. Returns the spreads.
 */
export function spreadFlips(angles: number[], threshold: number): Spread[] {
  const n = angles.length;
  if (n < 2) return [];
  const u: number[] = [angles[0]!];
  for (let i = 1; i < n; i++) u.push(u[i - 1]! + wrap(angles[i]! - angles[i - 1]!));
  const fits = (lo: number, hi: number) => Math.abs(u[hi]! - u[lo]!) <= threshold * (hi - lo);
  interface Win { lo: number; hi: number; h: number; start: boolean; end: boolean; turns: Array<{ frame: number; jump: number }> }
  const wins: Win[] = [];
  for (let k = 1; k < n; k++) {
    const jump = u[k]! - u[k - 1]!;
    if (Math.abs(jump) <= threshold) continue;
    let h = 1;
    let lo = Math.max(0, k - h - 1);
    let hi = Math.min(n - 1, k + h);
    while (!fits(lo, hi) && (lo > 0 || hi < n - 1)) {
      h++;
      lo = Math.max(0, k - h - 1);
      hi = Math.min(n - 1, k + h);
    }
    wins.push({ lo, hi, h, start: k - h - 1 < 0, end: k + h > n - 1, turns: [{ frame: k, jump }] });
  }
  // Merge overlapping windows; a merged line that turns too fast widens by one on each side, then merges again.
  for (let changed = true; changed;) {
    changed = false;
    wins.sort((a, b) => a.lo - b.lo);
    for (let i = 0; i + 1 < wins.length; i++) {
      const a = wins[i]!;
      const b = wins[i + 1]!;
      if (b.lo >= a.hi) continue;
      wins.splice(i, 2, { lo: a.lo, hi: Math.max(a.hi, b.hi), h: Math.max(a.h, b.h), start: a.start || b.start, end: a.end || b.end, turns: [...a.turns, ...b.turns].sort((x, y) => x.frame - y.frame) });
      changed = true;
      break;
    }
    if (changed) continue;
    for (const w of wins) {
      if (w.turns.length < 2 || fits(w.lo, w.hi) || (w.lo === 0 && w.hi === n - 1)) continue;
      if (w.lo === 0) w.start = true;
      if (w.hi === n - 1) w.end = true;
      w.lo = Math.max(0, w.lo - 1);
      w.hi = Math.min(n - 1, w.hi + 1);
      w.h++;
      changed = true;
    }
  }
  return wins.map((w) => {
    const step = (u[w.hi]! - u[w.lo]!) / (w.hi - w.lo);
    for (let i = w.lo + 1; i < w.hi; i++) angles[i] = wrap(u[w.lo]! + step * (i - w.lo));
    const top = w.turns.reduce((m, t) => (Math.abs(t.jump) > Math.abs(m.jump) ? t : m));
    return {
      jump: top.jump,
      turns: w.turns,
      frames: [w.lo + 1, w.hi - 1] as [number, number],
      h: w.h,
      step,
      clipped: w.start && w.end ? 'both' : w.start ? 'start' : w.end ? 'end' : null,
    };
  });
}

export function flipLine(f: Flip, times: readonly number[], threshold: number): string {
  const sg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
  const turns = f.turns.map((t) => `${sg(t.jump)} from frame ${t.frame - 1} to ${t.frame} (t=${times[t.frame - 1]!.toFixed(3)}–${times[t.frame]!.toFixed(3)}s)`).join(', ');
  const span = f.frames[0] > f.frames[1] ? 'no frame (the pose has none between the two)' : f.frames[0] === f.frames[1] ? `frame ${f.frames[0]}` : `frames ${f.frames[0]}–${f.frames[1]}`;
  const clip = f.clipped === null ? '' : f.clipped === 'both' ? '; the window was cut short by both ends of the pose' : `; the window was cut short at the ${f.clipped === 'start' ? 'first' : 'last'} frame of the pose`;
  const still = Math.abs(f.step) > threshold ? ` — still over ${threshold}°: the pose is too short to spread it` : '';
  return `chain "${f.chain}" bone "${f.bone}" (${f.joints[0]} → ${f.joints[1]}) turned ${turns}, over ${threshold}° in one frame; spread over ${span} (h=${f.h}), ${sg(f.step)} per frame${clip}${still}`;
}

/** Frames before the first with a direction take its value; none at all is a problem. */
function fillLeading(angles: number[], none: () => void): void {
  const firstReal = angles.findIndex((a) => !Number.isNaN(a));
  if (firstReal < 0) {
    none();
    return;
  }
  for (let i = 0; i < firstReal; i++) angles[i] = angles[firstReal]!;
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
