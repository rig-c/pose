/**
 * Whether the rig lands where the pose says, measured on the gated build by
 * rig-c's own poser — not by the arithmetic that wrote the keys.
 *
 * The retarget's key formula holds for a bone that inherits rotation from its
 * parent with unit scale and no shear, and no constraint pulling it. A rig
 * outside that (an IK constraint on an arm, a scaled parent) is not refused by
 * a guess about which rigs are safe; it is posed, and the distance between the
 * aim each bone reached and the aim the pose asked for is the verdict.
 */
import { poseRawAnimation, poseRawSetup, type CompiledDocument, type RawBone } from 'rig-c/core';
import type { Body18 } from './joints.ts';
import { aimAngle, aimEnds, pointAt, type JointMap } from './map.ts';
import type { HipsInferred, Joint, PelvisFit, Run } from './pose.ts';
import type { Retarget } from './retarget.ts';
import { pictureAngle, pointOn, wrap } from './retarget.ts';

export interface Landing {
  bone: string;
  /** The largest |reached − asked| over the frames: degrees (an aim), world units (an origin, an ankle), or a fraction of the setup length (a scale). */
  worst: number;
  frame: number;
  /** `scale`: the bone's world x axis against its setup length times the leg scale asked (#47); `foot`: the ankle (the leg's last bone's tip) against where the keys put it. */
  kind: 'angle' | 'origin' | 'scale' | 'foot';
  /** The tolerance it is held to. */
  tolerance: number;
}

/**
 * Tolerances, from what the writer does to a value: a rotate key is rounded to
 * 0.001° and a chain accumulates one rounding per link, rig-c stores numbers as
 * float32 (≈ 1e-5° at these magnitudes), and a key time is stored float32
 * rounded down; 0.01° and 0.01 world units sit an order above that sum for
 * chains up to ten links.
 */
export const ANGLE_TOLERANCE = 0.01;
export const ORIGIN_TOLERANCE = 0.01;
/**
 * A scale key is rounded to 1e-6 and a bone under a scaled bone takes its
 * parent's rounding too; rig-c stores float32 (≈ 6e-8 relative). 1e-4 sits
 * two orders above that.
 */
export const SCALE_TOLERANCE = 1e-4;
/**
 * An ankle sits at the end of a lever as long as the leg: each keyed rotation
 * on the way (the hip, the thigh, the shin; rounded to 0.001°, ±8.7e-6 rad)
 * moves it by up to 8.7e-6 × its setup distance from the hip's origin, so three
 * move it ≤ 2.6e-5 × that. The tolerance is the origin's plus 1e-4 × that
 * distance, about four times the sum (0.06 units on a 520-unit leg).
 */
export const FOOT_TOLERANCE_PER_UNIT = 1e-4;

/** Every bone, world, on every key frame of the animation, by rig-c's poser. */
export function poseFrames(doc: CompiledDocument, animation: string, times: readonly number[]): Array<Map<string, RawBone>> {
  const steps = times.slice(1).map((t, i) => t - times[i]!);
  // Pose 0 is the animation applied at t = 0 only under reset 'animation' (render's walk); under 'setup' it is the setup pose (rig-c src/core/track.ts).
  const poses = poseRawAnimation(doc, animation, steps, {}, 'animation');
  return poses.map((p) => new Map(p.bones.map((b) => [b.name, b])));
}

export function measureLanding(doc: CompiledDocument, animation: string, map: JointMap, r: Retarget, posed = poseFrames(doc, animation, r.times)): Landing[] {
  const out: Landing[] = [];
  const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
  for (const c of map.chains) {
    c.bones.forEach((b, k) => {
      const aim = c.aim[k]!;
      const asked = r.targets.get(b)!;
      let worst = -1;
      let frame = 0;
      posed.forEach((bones, i) => {
        const reached = aimAngle(bones, lengths, b, aim);
        const e = Math.abs(wrap(reached - asked[i]!));
        if (e > worst) {
          worst = e;
          frame = i;
        }
      });
      out.push({ bone: b, worst, frame, kind: 'angle', tolerance: ANGLE_TOLERANCE });
    });
  }
  const setup = new Map(poseRawSetup(doc).bones.map((b) => [b.name, b]));
  for (const [b, asked] of r.scales) {
    const s0 = setup.get(b)!;
    const len0 = Math.hypot(s0.a, s0.c);
    let worst = -1;
    let frame = 0;
    posed.forEach((bones, i) => {
      const o = bones.get(b)!;
      const e = Math.abs(Math.hypot(o.a, o.c) / len0 - asked[i]!);
      if (e > worst) {
        worst = e;
        frame = i;
      }
    });
    out.push({ bone: b, worst, frame, kind: 'scale', tolerance: SCALE_TOLERANCE });
  }
  if (r.origin !== null) {
    let worst = -1;
    let frame = 0;
    posed.forEach((bones, i) => {
      const o = bones.get(r.origin!.bone)!;
      const [x, y] = r.origin!.at[i]!;
      const e = Math.hypot(o.worldX - x, o.worldY - y);
      if (e > worst) {
        worst = e;
        frame = i;
      }
    });
    out.push({ bone: r.origin.bone, worst, frame, kind: 'origin', tolerance: ORIGIN_TOLERANCE });
  }
  if (r.ankles !== null) {
    const top = r.origin?.bone;
    for (const side of ['r', 'l'] as const) {
      const bone = r.ankles.bones[side];
      const s0 = setup.get(bone)!;
      const tip0: [number, number] = [s0.worldX + s0.a * (lengths.get(bone) ?? 0), s0.worldY + s0.c * (lengths.get(bone) ?? 0)];
      const h0 = top === undefined ? null : setup.get(top)!;
      const lever = h0 === null ? Math.hypot(tip0[0], tip0[1]) : Math.hypot(tip0[0] - h0.worldX, tip0[1] - h0.worldY);
      let worst = -1;
      let frame = 0;
      posed.forEach((bones, i) => {
        const got = pointAt(bones, lengths, `${bone}:tip`)!;
        const want = r.ankles!.at[side][i]!;
        const e = Math.hypot(got[0] - want[0], got[1] - want[1]);
        if (e > worst) {
          worst = e;
          frame = i;
        }
      });
      out.push({ bone: `${bone}:tip`, worst, frame, kind: 'foot', tolerance: ORIGIN_TOLERANCE + FOOT_TOLERANCE_PER_UNIT * lever });
    }
  }
  return out;
}

export function landed(l: Landing): boolean {
  return l.worst <= l.tolerance;
}

/**
 * How a scaled bone, or a bone under one, has its art distorted: the angle
 * between its world x and y axes less 90° (shear), and each world axis's length
 * against setup (a foot under a scaled shin is squashed along the shin). A
 * reading, not a gate: rig-c's `scalex` on a bone reaches every bone below it.
 */
export interface Shear {
  bone: string;
  /** Worst |angle(x, y) − 90°|, degrees, and its frame. */
  shear: number;
  frame: number;
  /** The world x and y axes' lengths over setup's: lowest and highest over the frames. */
  x: [number, number];
  y: [number, number];
}

export function measureShear(doc: CompiledDocument, posed: Array<Map<string, RawBone>>, scaled: Iterable<string>): Shear[] {
  const setup = new Map(poseRawSetup(doc).bones.map((b) => [b.name, b]));
  const under = new Set<string>(scaled);
  for (const b of doc.bones) if (b.parent !== undefined && b.parent !== null && under.has(b.parent)) under.add(b.name);
  const out: Shear[] = [];
  for (const b of doc.bones) {
    if (!under.has(b.name)) continue;
    const s0 = setup.get(b.name)!;
    const x0 = Math.hypot(s0.a, s0.c);
    const y0 = Math.hypot(s0.b, s0.d);
    let shear = -1;
    let frame = 0;
    const xs: number[] = [];
    const ys: number[] = [];
    posed.forEach((bones, i) => {
      const o = bones.get(b.name)!;
      const e = Math.abs(wrap((Math.atan2(o.d, o.b) - Math.atan2(o.c, o.a)) * (180 / Math.PI) - 90));
      if (e > shear) {
        shear = e;
        frame = i;
      }
      xs.push(Math.hypot(o.a, o.c) / x0);
      ys.push(Math.hypot(o.b, o.d) / y0);
    });
    const rx = rangeOf(xs);
    const ry = rangeOf(ys);
    out.push({ bone: b.name, shear, frame, x: [rx.min, rx.max], y: [ry.min, ry.max] });
  }
  return out;
}

/**
 * The feet on the posed build (#43, #47), outside the jumps read off the
 * reference: the lowest ankle's vertical range, and per support span, the
 * supporting ankle's vertical range and horizontal drift — in world units and
 * in that side's leg length (the median, over the frames, of its thigh's origin
 * to its ankle).
 */
export interface FeetReading {
  legLength: { r: number; l: number };
  /** The lowest ankle's world y range over the frames outside jumps. */
  lowest: { range: number; legs: number; frames: number };
  /** Per support span: the supporting ankle's ranges outside jumps. */
  plants: Array<{ side: 'r' | 'l'; frames: [number, number]; vertical: number; horizontal: number; verticalLegs: number; horizontalLegs: number }>;
}

export function measureFeet(posed: Array<Map<string, RawBone>>, lengths: ReadonlyMap<string, number>, r: Retarget, legs: { r: { root: string; ankle: string }; l: { root: string; ankle: string } }): FeetReading | null {
  if (r.feet === null) return null;
  const tip = (bones: Map<string, RawBone>, side: 'r' | 'l') => pointAt(bones, lengths, `${legs[side].ankle}:tip`)!;
  const legLength = { r: 0, l: 0 };
  for (const side of ['r', 'l'] as const) {
    legLength[side] = medianOf(posed.map((bones) => {
      const a = tip(bones, side);
      const o = bones.get(legs[side].root)!;
      return Math.hypot(a[0] - o.worldX, a[1] - o.worldY);
    }));
  }
  const jump = new Set<number>();
  for (const [a, b] of r.feet.jumps) for (let i = a; i <= b; i++) jump.add(i);
  const ys: number[] = [];
  posed.forEach((bones, i) => {
    if (jump.has(i)) return;
    ys.push(Math.min(tip(bones, 'r')[1], tip(bones, 'l')[1]));
  });
  const lr = rangeOf(ys);
  const mean = (legLength.r + legLength.l) / 2;
  const plants = r.feet.supports.map((s) => {
    const xs: number[] = [];
    const yy: number[] = [];
    for (let i = s.frames[0]; i <= s.frames[1]; i++) {
      const a = tip(posed[i]!, s.side);
      xs.push(a[0]);
      yy.push(a[1]);
    }
    const v = rangeOf(yy).range;
    const h = rangeOf(xs).range;
    return { side: s.side, frames: s.frames, vertical: v, horizontal: h, verticalLegs: v / legLength[s.side], horizontalLegs: h / legLength[s.side] };
  });
  return { legLength, lowest: { range: lr.range, legs: lr.range / mean, frames: ys.length }, plants };
}

export interface Range {
  min: number;
  max: number;
  range: number;
}
export interface Posture {
  /** The chain read as the pelvis (joints r_hip → l_hip), and the rig points the reading used. */
  pelvis: string;
  rigHip: string;
  rigShoulder: string | null;
  /** Reference frames on which the hips (tilt) and the hips and shoulders (sway) are all good. */
  frames: { tilt: number; sway: number; of: number };
  /**
   * Hip-line tilt, Spine degrees (r_hip → l_hip; the rig: the pelvis chain's
   * aim). Null when every frame with both hips good has an `inferred` hip
   * (#63): the tilt is not read, and `tiltWhy` says why.
   */
  tilt: { reference: Range; rig: Range; ratio: number } | null;
  /** Present only when `tilt` is null: why it was not read. */
  tiltWhy?: string;
  /**
   * Present only when some frame with both hips good has an `inferred` hip:
   * how many such frames the tilt left out, and where the state came from.
   */
  hipsInferred?: { frames: number; source: string };
  /**
   * Present only when the hips were measured (#86, #106, `hipsInferred.by` is
   * `measured`): the method, how many frames the tilt was read on — the
   * record's read, interpolated, scaled and held frames with both hips good,
   * each class counted — and the record's spans. Any `unmeasured` frame (corr
   * < 0.9) or other frame with an inferred hip is left out of `tilt`.
   */
  tiltMeasured?: {
    method: string;
    frames: number;
    read: number;
    interpolated: number;
    held: number;
    heldSpans: Run[];
    scaled?: number;
    scaledSpans?: Run[];
    unmeasured?: number;
    unmeasuredSpans?: Run[];
    fit?: PelvisFit;
  };
  /**
   * Sway: the x-range of mid_hip − mid_shoulder, in rig units (the reference's
   * picture px × the figure scale) and in each body's own shoulder widths.
   */
  sway: {
    reference: Range & { shoulderWidth: number; rangeSw: number };
    rig: (Range & { shoulderWidth: number | null; rangeSw: number | null }) | null;
    ratio: number | null;
    ratioSw: number | null;
  } | null;
  /**
   * Present with `--plant-feet` when there is at least one support span (#107):
   * per support span, the detrended (centred ±12-frame moving mean removed)
   * vertical sd, rig/reference ratio and correlation for the hip, the neck, and
   * eyes − neck.
   */
  bounce?: BounceSpan[];
}

export interface BounceMetric {
  reference: number;
  rig: number;
  ratio: number | null;
  corr: number | null;
}

export interface BounceSpan {
  side: 'r' | 'l';
  frames: [number, number];
  hip: BounceMetric;
  neck: BounceMetric;
  eyesNeck: BounceMetric;
}

/** Half-window (frames each side; 25-frame centred window at 24 fps ≈ 1 s) for detrending a support span's bounce (#107). */
export const POSTURE_DETREND_HALF_WINDOW = 12;

function detrend(xs: readonly number[], w = POSTURE_DETREND_HALF_WINDOW): number[] {
  const n = xs.length;
  return xs.map((x, i) => {
    const lo = Math.max(0, i - w);
    const hi = Math.min(n - 1, i + w);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += xs[k]!;
    return x - sum / (hi - lo + 1);
  });
}

function sdOf(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let s2 = 0;
  for (const x of xs) s2 += (x - mean) * (x - mean);
  return Math.sqrt(s2 / xs.length);
}

function corrOf(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 2 || a.length !== b.length) return null;
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = a[i]! - ma;
    const xb = b[i]! - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-9 ? num / den : null;
}

function bounceMetric(ref: readonly number[], rig: readonly number[]): BounceMetric {
  const dr = detrend(ref);
  const dg = detrend(rig);
  const sr = sdOf(dr);
  const sg = sdOf(dg);
  return {
    reference: sr,
    rig: sg,
    ratio: sr > 1e-9 ? sg / sr : null,
    corr: corrOf(dr, dg),
  };
}

function rangeOf(xs: number[]): Range {
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { min, max, range: max - min };
}
const unwrapped = (xs: number[]): number[] => xs.map((x) => xs[0]! + wrap(x - xs[0]!));
const medianOf = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * The pelvis, the reference beside the rig. A reading, not a gate: the
 * reference is the pose as read (no hold, no smoothing; a frame counts where
 * the joints it needs are good), the rig is the gated build posed by rig-c.
 * Null when the map has no pelvis chain (joints exactly r_hip, l_hip) or no
 * translate.
 *
 * Inferred hips (#63): a frame on which either hip is `inferred` is left out of
 * the tilt — its hip line is a position the detector supplied but did not see,
 * and a tilt read off it would be the detector's guess reported as the dancer's.
 * When that is every frame (`clean --hips-inferred` marks them all), the tilt
 * is null and `tiltWhy` names the reason and its source (`inferredSource`, read
 * from the clean record). On some frames only, the tilt is read over the rest
 * and the line counts the frames left out. Sway is read as before, inferred
 * hips included: it is a different measure, and the card leaves it as it is.
 *
 * Measured hips (#86, #106, `measured`): the hips are inferred on every frame,
 * and turned to a measured angle: read off the picture, interpolated between two
 * close reads, scaled from the detector's hip line when `fit.corr >= 0.9`, or
 * held from the earlier read. Those four are the measurement, so the tilt is
 * read on them; any `unmeasured` frame (`fit.corr < 0.9`) or other frame with
 * an inferred hip is left out and counted.
 */
export function measurePosture(posed: Array<Map<string, RawBone>>, lengths: ReadonlyMap<string, number>, map: JointMap, r: Retarget, frames: ReadonlyArray<Partial<Record<Body18, Joint>>>, minScore: number, inferredSource = 'source not stated', measured: Extract<HipsInferred, { by: 'measured' }> | null = null): Posture | null {
  const pelvis = map.chains.find((c) => c.joints.length === 2 && c.joints[0] === 'r_hip' && c.joints[1] === 'l_hip');
  if (pelvis === undefined || map.translate === null || r.origin === null || r.scale === null) return null;
  const s = r.scale.factor;
  const at = (i: number, j: Body18): [number, number] | null => {
    const v = pointOn(frames[i]!, j, minScore);
    return typeof v === 'string' ? null : v;
  };
  const refTilt: number[] = [];
  const refSway: number[] = [];
  const refSw: number[] = [];
  let inferred = 0;
  const inClass = (rs: Run[], i: number) => rs.some(([a, b]) => a <= i && i <= b);
  const counts = { read: 0, interpolated: 0, held: 0, scaled: 0, unmeasured: 0 };
  frames.forEach((f, i) => {
    const rh = at(i, 'r_hip');
    const lh = at(i, 'l_hip');
    if (rh === null || lh === null) return;
    const isInferred = f.r_hip?.state === 'inferred' || f.l_hip?.state === 'inferred';
    const cls = measured === null ? undefined : (['read', 'interpolated', 'held'] as const).find((c) => inClass(measured[c], i));
    const isScaled = measured !== null && measured.scaled !== undefined && inClass(measured.scaled, i);
    const isUnmeasured = measured !== null && measured.unmeasured !== undefined && inClass(measured.unmeasured, i);
    if (isInferred && cls !== undefined) {
      counts[cls]++;
      refTilt.push(pictureAngle(rh, lh));
    } else if (isInferred && isScaled) {
      counts.scaled++;
      refTilt.push(pictureAngle(rh, lh));
    } else if (isInferred && isUnmeasured) {
      counts.unmeasured++;
    } else if (isInferred) inferred++;
    else refTilt.push(pictureAngle(rh, lh));
    const rs = at(i, 'r_shoulder');
    const ls = at(i, 'l_shoulder');
    if (rs === null || ls === null) return;
    refSway.push(((rh[0] + lh[0]) / 2 - (rs[0] + ls[0]) / 2) * s);
    refSw.push(Math.hypot(ls[0] - rs[0], ls[1] - rs[1]) * s);
  });
  const bone = pelvis.bones[0]!;
  const aim = pelvis.aim[0]!;
  let tilt: Posture['tilt'] = null;
  const why = `hips inferred (${inferredSource})`;
  if ((inferred === 0 && counts.unmeasured === 0) || refTilt.length > 0) {
    const rigTilt = posed.map((b) => aimAngle(b, lengths, bone, aim));
    tilt = { reference: rangeOf(unwrapped(refTilt)), rig: rangeOf(unwrapped(rigTilt)), ratio: 0 };
    tilt.ratio = tilt.rig.range / tilt.reference.range;
  }

  // The rig's mid-shoulder: the point a reach aims at, else the midpoint of the arms' first bones.
  const reach = map.chains.find((c) => c.reach);
  const first = (j: string) => map.chains.find((c) => c.joints[0] === j)?.bones[0];
  const armR = first('r_shoulder');
  const armL = first('l_shoulder');
  const rigShoulder = reach !== undefined ? reach.aim[0]! : armR !== undefined && armL !== undefined ? `${armR}+${armL}` : null;
  let sway: Posture['sway'] = null;
  if (refSway.length > 0) {
    const refR = rangeOf(refSway);
    const refWidth = medianOf(refSw);
    const reference = { ...refR, shoulderWidth: refWidth, rangeSw: refR.range / refWidth };
    let rig: NonNullable<Posture['sway']>['rig'] = null;
    if (rigShoulder !== null) {
      const xs = posed.map((b) => b.get(r.origin!.bone)!.worldX - pointAt(b, lengths, rigShoulder)![0]);
      const rr = rangeOf(xs);
      const width = armR !== undefined && armL !== undefined ? medianOf(posed.map((b) => {
        const p = pointAt(b, lengths, armR)!;
        const q = pointAt(b, lengths, armL)!;
        return Math.hypot(q[0] - p[0], q[1] - p[1]);
      })) : null;
      rig = { ...rr, shoulderWidth: width, rangeSw: width === null ? null : rr.range / width };
    }
    sway = {
      reference,
      rig,
      ratio: rig === null ? null : rig.range / reference.range,
      ratioSw: rig === null || rig.rangeSw === null ? null : rig.rangeSw / reference.rangeSw,
    };
  }
  const bounce: BounceSpan[] = [];
  if (r.planted && r.feet !== null && r.feet.supports.length > 0) {
    const scaleNeckIdx = map.translate.scale.pose.indexOf('neck');
    const neckChain = map.chains.find((c) => c.joints.includes('neck'));
    const neckJointIdx = neckChain === undefined ? -1 : neckChain.joints.indexOf('neck');
    const rigNeck = posed[0]?.has('neck')
      ? 'neck'
      : scaleNeckIdx >= 0
        ? map.translate.scale.rig[scaleNeckIdx]!
        : neckChain !== undefined && neckJointIdx > 0
          ? (neckChain.aim[neckJointIdx - 1] === 'x' ? `${neckChain.bones[neckJointIdx - 1]}:tip` : neckChain.aim[neckJointIdx - 1]!)
          : rigShoulder;
    const headChain = map.chains.find((c) => c.joints.includes('r_eye') && c.joints.includes('l_eye'));
    const rigNeckY = (b: Map<string, RawBone>): number | null => (rigNeck === null ? null : (pointAt(b, lengths, rigNeck)?.[1] ?? null));
    const rigEyesY = (b: Map<string, RawBone>): number | null => {
      if (headChain !== undefined) {
        const k = headChain.joints.findIndex((j, idx) => idx + 1 < headChain.joints.length && ((j === 'r_eye' && headChain.joints[idx + 1] === 'l_eye') || (j === 'l_eye' && headChain.joints[idx + 1] === 'r_eye')));
        if (k >= 0) {
          const ha = headChain.aim[k]!;
          const hb = headChain.bones[k]!;
          if (ha.includes('>')) {
            const [pa, pb] = aimEnds(hb, ha);
            const ya = pointAt(b, lengths, pa);
            const yb = pointAt(b, lengths, pb);
            if (ya !== null && yb !== null) return (ya[1] + yb[1]) / 2;
          }
          const p = pointAt(b, lengths, ha === 'x' ? hb : ha);
          if (p !== null) return p[1];
        }
      }
      if (b.has('eye_r') && b.has('eye_l')) return (b.get('eye_r')!.worldY + b.get('eye_l')!.worldY) / 2;
      if (b.has('head')) return b.get('head')!.worldY;
      return rigNeckY(b);
    };
    for (const sp of r.feet.supports) {
      const refHip: number[] = [];
      const rigHipY: number[] = [];
      const refNeck: number[] = [];
      const rigNeckS: number[] = [];
      const refEyesNeck: number[] = [];
      const rigEyesNeck: number[] = [];
      for (let i = sp.frames[0]; i <= sp.frames[1]; i++) {
        const b = posed[i]!;
        const rh = at(i, 'r_hip');
        const lh = at(i, 'l_hip');
        if (rh !== null && lh !== null) {
          refHip.push(-((rh[1] + lh[1]) / 2) * s);
          rigHipY.push(b.get(r.origin.bone)!.worldY);
        }
        const nk = at(i, 'neck');
        const ny = rigNeckY(b);
        if (nk !== null && ny !== null) {
          refNeck.push(-nk[1] * s);
          rigNeckS.push(ny);
          const re = at(i, 'r_eye');
          const le = at(i, 'l_eye');
          const ey = rigEyesY(b);
          if (re !== null && le !== null && ey !== null) {
            refEyesNeck.push(-((re[1] + le[1]) / 2 - nk[1]) * s);
            rigEyesNeck.push(ey - ny);
          }
        }
      }
      bounce.push({
        side: sp.side,
        frames: [sp.frames[0], sp.frames[1]],
        hip: bounceMetric(refHip, rigHipY),
        neck: bounceMetric(refNeck, rigNeckS),
        eyesNeck: bounceMetric(refEyesNeck, rigEyesNeck),
      });
    }
  }
  const has106 = measured !== null && (measured.scaled !== undefined || measured.unmeasured !== undefined || measured.fit !== undefined);
  return {
    pelvis: pelvis.name,
    rigHip: r.origin.bone,
    rigShoulder,
    frames: { tilt: refTilt.length, sway: refSway.length, of: frames.length },
    tilt,
    ...(tilt === null ? { tiltWhy: why } : {}),
    ...(inferred > 0 ? { hipsInferred: { frames: inferred, source: inferredSource } } : {}),
    ...(measured !== null
      ? {
          tiltMeasured: {
            method: measured.method,
            frames: counts.read + counts.interpolated + counts.scaled + counts.held,
            read: counts.read,
            interpolated: counts.interpolated,
            held: counts.held,
            heldSpans: measured.held.map(([a, b]): Run => [a, b]),
            ...(has106
              ? {
                  scaled: counts.scaled,
                  scaledSpans: (measured.scaled ?? []).map(([a, b]): Run => [a, b]),
                  unmeasured: counts.unmeasured,
                  unmeasuredSpans: (measured.unmeasured ?? []).map(([a, b]): Run => [a, b]),
                  ...(measured.fit !== undefined ? { fit: { frames: measured.fit.frames, gain: measured.fit.gain, corr: measured.fit.corr } } : {}),
                }
              : {}),
          },
        }
      : {}),
    sway,
    ...(bounce.length > 0 ? { bounce } : {}),
  };
}

const f1 = (x: number) => x.toFixed(1);
const f3 = (x: number) => x.toFixed(3);
const sg = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;
const spansText = (rs: Run[] | undefined) => (rs === undefined || rs.length === 0 ? 'none' : rs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', '));

/** The POSTURE lines. */
export function postureLines(q: Posture): string[] {
  const over = (k: number) => (k === q.frames.of ? '' : ` over ${k} of ${q.frames.of} frames`);
  const t = q.tilt;
  const m = q.tiltMeasured;
  const heldSpans = spansText(m?.heldSpans);
  const scaledPart =
    m?.scaled !== undefined && m.scaled > 0
      ? `, ${m.scaled} scaled (scaled: ${spansText(m.scaledSpans)}${m.fit?.gain !== undefined && m.fit.gain !== null && m.fit.corr !== null ? `, gain ${m.fit.gain.toFixed(2)}×, r=${m.fit.corr.toFixed(3)}` : ''})`
      : '';
  const unmeasuredPart =
    m?.unmeasured !== undefined && (m.unmeasured > 0 || (m.fit !== undefined && (m.fit.corr === null || m.fit.corr < 0.9)))
      ? `; ${m.unmeasured} unmeasured (${spansText(m.unmeasuredSpans)}${m.fit !== undefined ? `, r=${m.fit.corr === null ? 'none' : m.fit.corr.toFixed(3)} < 0.9` : ''})`
      : '';
  const measured = m === undefined ? '' : `; tilt measured (${m.method}) on ${m.frames} frame(s): ${m.read} read, ${m.interpolated} interpolated${scaledPart}, ${m.held} held (held: ${heldSpans})${unmeasuredPart}`;
  const left = q.hipsInferred === undefined ? '' : `; ${q.hipsInferred.frames} frame(s) with an inferred hip not read (${q.hipsInferred.source})`;
  const out = [
    t === null
      ? `hip tilt not read: ${q.tiltWhy}`
      : `hip tilt range (chain "${q.pelvis}", r_hip → l_hip, Spine degrees): reference ${f1(t.reference.range)}° (${sg(t.reference.min)}° … ${sg(t.reference.max)}°${over(q.frames.tilt)}), rig ${f1(t.rig.range)}° (${sg(t.rig.min)}° … ${sg(t.rig.max)}°) — rig/reference ${f3(t.ratio)}${measured}${left}`,
  ];
  const w = q.sway;
  if (w === null) out.push('sway: the reference has no frame with both hips and both shoulders good; not measured');
  else {
    const ref = `reference ${f1(w.reference.range)} units = picture px × scale (${f3(w.reference.rangeSw)} shoulder widths${over(q.frames.sway)})`;
    if (w.rig === null) out.push(`sway, x-range of mid_hip − mid_shoulder: ${ref}; the rig has no mid-shoulder to read (no reach, no chains from r_shoulder and l_shoulder)`);
    else {
      const sw = w.rig.rangeSw === null ? 'no shoulder width' : `${f3(w.rig.rangeSw)} shoulder widths`;
      const ratioSw = w.ratioSw === null ? '' : `, ${f3(w.ratioSw)} in shoulder widths`;
      out.push(`sway, x-range of mid_hip − mid_shoulder: ${ref}, rig ${f1(w.rig.range)} units (${sw}; mid_hip = "${q.rigHip}", mid_shoulder = "${q.rigShoulder}") — rig/reference ${f3(w.ratio!)} in units${ratioSw}`);
    }
  }
  if (q.bounce !== undefined) {
    const fmt = (bm: BounceMetric) => `${bm.ratio === null ? 'n/a' : f3(bm.ratio)} (${f1(bm.rig)}/${f1(bm.reference)}u, r=${bm.corr === null ? 'none' : f3(bm.corr)})`;
    for (const b of q.bounce) {
      out.push(`bounce ${b.side} ${b.frames[0]}–${b.frames[1]} (detrended y sd, rig/reference): hip ${fmt(b.hip)}, neck ${fmt(b.neck)}, eyes − neck ${fmt(b.eyesNeck)}`);
    }
  }
  return out;
}
