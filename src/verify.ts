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
import { poseRawAnimation, type CompiledDocument, type RawBone } from 'rig-c/core';
import type { Body18 } from './joints.ts';
import { aimAngle, pointAt, type JointMap } from './map.ts';
import type { Joint } from './pose.ts';
import type { Retarget } from './retarget.ts';
import { pictureAngle, pointOn, wrap } from './retarget.ts';

export interface Landing {
  bone: string;
  /** The largest |reached − asked| over the frames, degrees (rotate) or world units (translate). */
  worst: number;
  frame: number;
  kind: 'angle' | 'origin';
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
      out.push({ bone: b, worst, frame, kind: 'angle' });
    });
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
    out.push({ bone: r.origin.bone, worst, frame, kind: 'origin' });
  }
  return out;
}

export function landed(l: Landing): boolean {
  return l.worst <= (l.kind === 'angle' ? ANGLE_TOLERANCE : ORIGIN_TOLERANCE);
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
  /** Hip-line tilt, Spine degrees (r_hip → l_hip; the rig: the pelvis chain's aim). */
  tilt: { reference: Range; rig: Range; ratio: number };
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
 */
export function measurePosture(posed: Array<Map<string, RawBone>>, lengths: ReadonlyMap<string, number>, map: JointMap, r: Retarget, frames: ReadonlyArray<Partial<Record<Body18, Joint>>>, minScore: number): Posture | null {
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
  frames.forEach((_, i) => {
    const rh = at(i, 'r_hip');
    const lh = at(i, 'l_hip');
    if (rh === null || lh === null) return;
    refTilt.push(pictureAngle(rh, lh));
    const rs = at(i, 'r_shoulder');
    const ls = at(i, 'l_shoulder');
    if (rs === null || ls === null) return;
    refSway.push(((rh[0] + lh[0]) / 2 - (rs[0] + ls[0]) / 2) * s);
    refSw.push(Math.hypot(ls[0] - rs[0], ls[1] - rs[1]) * s);
  });
  const bone = pelvis.bones[0]!;
  const aim = pelvis.aim[0]!;
  const rigTilt = posed.map((b) => aimAngle(b, lengths, bone, aim));
  const tilt = { reference: rangeOf(unwrapped(refTilt)), rig: rangeOf(unwrapped(rigTilt)), ratio: 0 };
  tilt.ratio = tilt.rig.range / tilt.reference.range;

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
  return { pelvis: pelvis.name, rigHip: r.origin.bone, rigShoulder, frames: { tilt: refTilt.length, sway: refSway.length, of: frames.length }, tilt, sway };
}

const f1 = (x: number) => x.toFixed(1);
const f3 = (x: number) => x.toFixed(3);
const sg = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;

/** The POSTURE lines. */
export function postureLines(q: Posture): string[] {
  const over = (k: number) => (k === q.frames.of ? '' : ` over ${k} of ${q.frames.of} frames`);
  const out = [
    `hip tilt range (chain "${q.pelvis}", r_hip → l_hip, Spine degrees): reference ${f1(q.tilt.reference.range)}° (${sg(q.tilt.reference.min)}° … ${sg(q.tilt.reference.max)}°${over(q.frames.tilt)}), rig ${f1(q.tilt.rig.range)}° (${sg(q.tilt.rig.min)}° … ${sg(q.tilt.rig.max)}°) — rig/reference ${f3(q.tilt.ratio)}`,
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
  return out;
}
