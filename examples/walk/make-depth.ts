/**
 * Writes the fixtures of rig-c/pose#281 (derived depth): a figure with the walk's
 * proportions (examples/wave/rig) walking or running in place, made in 3D from
 * joint angles and drawn by an orthographic camera in front of it or beside it.
 * The generator knows every joint's true depth, so it is the hand-read table
 * the derived depth is held to: per frame, each limb segment's true sign and
 * the limbs' true front-to-back order.
 *
 * The body: X to the figure's left, Y up, Z forward (the way it faces). mid_hip
 * is fixed (in place), the trunk upright, the neck 150 above it, the shoulders
 * 30 to either side 10 below the neck, the hips 15 to either side; upper arm 70,
 * forearm 60, thigh 80, shin 70. A limb segment swings in its side's sagittal
 * plane by an angle a (0 straight down, + forward) and leans out of it by a
 * small abduction b, so its vector is L·(±sin b, −cos a·cos b, sin a·cos b). Seen
 * from the front a sagittal swing is seen foreshortened, as |cos a|; from the
 * side it is seen whole.
 *
 * Each leg runs one stride in P frames, the left half a stride after the right;
 * u is the leg's phase in [0, 1):
 *
 * - walk (P = 24), in place: stance for u < 0.6 — the thigh from +10° to −10°,
 *   the knee straight, so the supporting leg stays inside the flat band; swing
 *   after — the thigh from −10° up to +14.2° and back to +10°, never past the band,
 *   and the knee folding `WALK_KNEE`·sin(π√v)°, early in the swing, so the
 *   lifted foot goes behind, its shin tilted back away from the camera: down to
 *   0.42 of its length. The owner's walk statement (rig-c/pose#336): the lifted
 *   foot is behind the supporting leg;
 * - run (P = 20): stance for u < 0.35 — the thigh from +15° to −15°, the knee
 *   bent 25·sin°; swing after — the thigh flexing forward from toe-off,
 *   −15° + 30·ease(v) + `RUN_LIFT`·sin(π·v^0.6), so it passes the band within
 *   the flight and is near its +35° top by the time the other foot lands, then
 *   settles to +15°; the knee folding `RUN_KNEE`·sin(πv)°, so the shin is kicked
 *   back away from the camera through the whole swing (down to 0.41 of its
 *   length), the foot following under the leading knee. On every frame with
 *   one leg lifted the lifted knee is in front of the supporting one
 *   (rig-c/pose#343). The owner's run statement (rig-c/pose#336, #343): the
 *   lifted leg is in front, its knee protruding, from toe-off;
 * - run on a floor (`ground`, rig-c/pose#369): the run with each foot down for
 *   `GROUND_SWING` of the stride (4 of 20 frames), its ankle on `RUN_FLOOR`,
 *   and the figure in flight between stances, so each stride has two flights of
 *   6 frames that lift both feet and mid_hip; not written by the CLI;
 * - arms: each upper arm swings against its own side's thigh (with the opposite
 *   leg), −0.6× (walk) or −0.9× (run) its angle from the thigh's mid-swing, the
 *   elbow bent 20° (walk) or 70° (run) forward;
 * - abduction: every limb segment leans out by 6·sin(2π·i/P)° (legs) or
 *   4·cos(2π·i/P)° (arms), outward on both sides.
 *
 * The front camera draws x = 200 + X, y = 400 − Y (the figure's right on the
 * picture's left), the near side +Z; the back camera, behind it, draws
 * x = 200 − X, the near side −Z; the side camera, on the figure's right, draws
 * x = 200 + Z, y = 400 − Y, the near side −X.
 *
 * `elevation` (rig-c/pose#379, the front camera only, degrees, default 0): the
 * front camera tilted down by e, still orthographic. It draws
 * y = 400 − (Y·cos e − Z·sin e) and reads depth as Y·sin e + Z·cos e, so a
 * nearer foot is drawn lower, which is how a frontal view draws depth as height
 * (rig-c/pose#280). At 0 every output is what it was without the parameter.
 *
 * The truth: a segment's sign is +1 when its distal joint is nearer the camera
 * than its proximal one, −1 farther, and 0 when the segment is drawn within the
 * flat band (cos of its tilt out of the picture ≥ 0.95). A limb's depth is the
 * mean of its middle and end joints' true depths; two limbs are in a true order
 * when their depths differ by at least the depth a limb can hold while both its
 * segments read flat — `TIE` (√(1 − 0.95²), what one segment within the flat
 * band can hide per unit length) × (upper + lower / 2), the smaller limb's of
 * the two — and tied otherwise: closer than that, the band cannot tell them.
 * Per joint (rig-c/pose#336), the two legs' knees are in a true order when
 * their depths differ by at least `TIE` × thigh, and their ankles by `TIE` ×
 * (thigh + shin): what a flat thigh, and a flat leg, can hide. A leg is lifted
 * on a frame when it is in its swing (its foot off the floor); the run's
 * flight frames have both lifted.
 *
 *   bun examples/walk/make-depth.ts <out-dir>   (writes run.json, walk.json, side.json before clean)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Gait = 'walk' | 'run';
export type View = 'front' | 'back' | 'side';
type Pt = [number, number];
type V3 = [number, number, number];

const RAD = Math.PI / 180;
const FPS = 24;
/** Frames per stride. */
export const STRIDE: Record<Gait, number> = { walk: 24, run: 20 };
/** The run's largest knee fold, degrees: the kicked-back shin at 0.41 of its length. */
export const RUN_KNEE = 102;
/** The run's hip flexion over its swing, degrees, on top of its −15° → +15° travel: the knee forward from toe-off (rig-c/pose#343). */
export const RUN_LIFT = 40;
/** The walk's largest knee fold, degrees: the lifted foot behind, its shin at 0.42 of its length. */
export const WALK_KNEE = 65;
/** Where each gait's swing starts in the stride (the foot leaves the floor). */
export const SWING: Record<Gait, number> = { walk: 0.6, run: 0.35 };
/** The flat band's low edge and the depth a segment within it can hide, per unit length. */
export const FLAT = 0.95;
export const TIE = Math.sqrt(1 - FLAT * FLAT);
const LEN = { upper: 70, fore: 60, thigh: 80, shin: 70 };

export const SEGMENTS = {
  r_upper_arm: ['r_shoulder', 'r_elbow'],
  r_forearm: ['r_elbow', 'r_wrist'],
  r_thigh: ['r_hip', 'r_knee'],
  r_shin: ['r_knee', 'r_ankle'],
  l_upper_arm: ['l_shoulder', 'l_elbow'],
  l_forearm: ['l_elbow', 'l_wrist'],
  l_thigh: ['l_hip', 'l_knee'],
  l_shin: ['l_knee', 'l_ankle'],
} as const;
export type Segment = keyof typeof SEGMENTS;
export const LIMBS = { r_arm: ['r_elbow', 'r_wrist'], l_arm: ['l_elbow', 'l_wrist'], r_leg: ['r_knee', 'r_ankle'], l_leg: ['l_knee', 'l_ankle'] } as const;
export type Limb = keyof typeof LIMBS;
/**
 * The depth a limb can hold while both its segments read flat, per unit of `TIE`: its depth is the mean of its middle
 * joint (up to TIE × upper) and its end (up to TIE × (upper + lower)), so TIE × (upper + lower / 2) — arm 100, leg 115.
 */
const HIDDEN: Record<Limb, number> = { r_arm: LEN.upper + LEN.fore / 2, l_arm: LEN.upper + LEN.fore / 2, r_leg: LEN.thigh + LEN.shin / 2, l_leg: LEN.thigh + LEN.shin / 2 };

export interface DepthFrame {
  /** The joints as drawn, picture px. */
  joints: Record<string, Pt>;
  /** Each joint's true depth, px, + toward the camera. */
  z: Record<string, number>;
  /** Each segment's true ratio (drawn ÷ length) and sign. */
  truth: Record<Segment, { ratio: number; sign: -1 | 0 | 1 }>;
  /** Each limb's true depth (mean of its middle and end joints). */
  limb: Record<Limb, number>;
  /** The legs in their swing on this frame (the foot off the floor): one, or both in a run's flight, or none in a walk's double support. */
  lifted: Array<'r' | 'l'>;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** A segment of length L swung a° forward in its sagittal plane and leaning b° outward on side s (+1 left, −1 right). */
const seg = (L: number, a: number, b: number, s: number): V3 => [s * L * Math.sin(b * RAD), -L * Math.cos(a * RAD) * Math.cos(b * RAD), L * Math.sin(a * RAD) * Math.cos(b * RAD)];
const ease = (v: number) => (1 - Math.cos(Math.PI * v)) / 2;

/**
 * rig-c/pose#379: a walk's push-off, in fractions of the leg's cycle u (textbook gait phases) and of its length. The
 * stance lasts until `toeOff` (the swing, and truth's `lifted`, start there instead of at `SWING.walk`); from `heelOff`
 * the heel rises, the knee folding so the ankle is `height` × (u − heelOff) / (toeOff − heelOff) leg lengths (world Y)
 * above the straight leg's; the swing after toe-off is the walk's own over what remains, the toe-off fold released
 * linearly. The other leg still lands half a cycle later.
 */
export interface PushOff {
  heelOff: number;
  toeOff: number;
  height: number;
}

/** The knee fold, degrees, that puts the ankle `height` leg lengths (world Y) above the straight leg's, the thigh at `thigh`° and the shin behind it. */
function foldFor(thigh: number, height: number): number {
  const c = Math.cos(thigh * RAD) - (height * (LEN.thigh + LEN.shin)) / LEN.shin;
  return thigh + Math.acos(c) / RAD;
}

/** One leg at phase u: thigh angle and knee bend, degrees. */
function leg(gait: Gait, u: number, s = SWING[gait], push?: PushOff): { thigh: number; knee: number } {
  if (gait === 'walk') {
    if (push !== undefined) {
      const t = push.toeOff;
      const fold = foldFor(-10, push.height);
      if (u < t) {
        const thigh = 10 - 20 * (u / t);
        return { thigh, knee: u < push.heelOff ? 0 : foldFor(thigh, (push.height * (u - push.heelOff)) / (t - push.heelOff)) };
      }
      const v = (u - t) / (1 - t);
      return { thigh: -10 + 20 * ease(v) + 10 * Math.sin(Math.PI * v), knee: WALK_KNEE * Math.sin(Math.PI * Math.sqrt(v)) + fold * (1 - v) };
    }
    if (u < s) return { thigh: 10 - 20 * (u / s), knee: 0 };
    const v = (u - s) / (1 - s);
    return { thigh: -10 + 20 * ease(v) + 10 * Math.sin(Math.PI * v), knee: WALK_KNEE * Math.sin(Math.PI * Math.sqrt(v)) };
  }
  if (u < s) {
    const v = u / s;
    return { thigh: 15 - 30 * v, knee: 25 * Math.sin(Math.PI * v) };
  }
  const v = (u - s) / (1 - s);
  return { thigh: -15 + 30 * ease(v) + RUN_LIFT * Math.sin(Math.PI * v ** 0.6), knee: RUN_KNEE * Math.sin(Math.PI * v) };
}

/** The floor's world Y under a run carried on it (`depthCycle`'s `ground`), and its flight's rise above the straight line from toe-off to landing, px. */
export const RUN_FLOOR = -150;
export const RUN_FLIGHT = 16;
/** Where the swing starts in the stride of a run carried on the floor: each foot down on 4 of the stride's 20 frames, a flight of 6 after each. */
export const GROUND_SWING = 0.16;

/** The ankle's world Y against the hip on leg phase u and frame phase phi: the leg's two segments, leaning by the abduction. */
function ankleY(gait: Gait, u: number, phi: number): number {
  const { thigh, knee } = leg(gait, u, GROUND_SWING);
  const b = 6 * Math.sin(phi) * RAD;
  return -(LEN.thigh * Math.cos(thigh * RAD) + LEN.shin * Math.cos((thigh - knee) * RAD)) * Math.cos(b);
}

/**
 * rig-c/pose#369: the figure's height on the floor at the right leg's phase x, for a run carried on a floor. On a
 * frame with one foot in its stance the figure stands on it: that ankle at `RUN_FLOOR`. In each of the stride's two
 * flights (both feet in their swing) it travels from its toe-off height to its landing height on a parabola that
 * rises `RUN_FLIGHT` above the straight line between them, so both feet leave the floor and mid_hip rises.
 */
function heightOf(gait: Gait, x: number): number {
  const s = GROUND_SWING;
  const stance = (side: 'r' | 'l', xr: number) => RUN_FLOOR - ankleY(gait, side === 'r' ? xr : (xr + 0.5) % 1, 2 * Math.PI * xr);
  const flight = (from: number, to: number, side0: 'r' | 'l', side1: 'r' | 'l') => {
    const w = (x - from) / (to - from);
    const h0 = stance(side0, from);
    const h1 = stance(side1, to % 1);
    return h0 + (h1 - h0) * w + 4 * RUN_FLIGHT * w * (1 - w);
  };
  if (x < s) return stance('r', x);
  if (x < 0.5) return flight(s, 0.5, 'r', 'l');
  if (x < 0.5 + s) return stance('l', x);
  return flight(0.5 + s, 1, 'l', 'r');
}

/**
 * The cycle, `cycles` strides of the gait, drawn by `view`'s camera. `ground` (rig-c/pose#369, the run only): the
 * figure is carried on a floor instead of hung from a fixed mid_hip — every joint moved up by `heightOf`, so the
 * stance ankle stays on the floor and the two flights of each stride lift both feet and the hips; the joints'
 * relations, depths and truth are the same as without it. `elevation`: the front camera tilted down (header).
 * `pushOff` (the walk only, rig-c/pose#379): the heel rises from heel-off to toe-off (`PushOff`).
 */
export function depthCycle(gait: Gait, view: View, cycles = 1, ground = false, elevation = 0, pushOff?: PushOff): DepthFrame[] {
  if (pushOff !== undefined && gait !== 'walk') throw new Error(`depthCycle: pushOff is the walk's; gait "${gait}" takes none`);
  if (elevation !== 0 && view !== 'front') throw new Error(`depthCycle: elevation ${elevation}° is the front camera's; view "${view}" takes 0`);
  const ce = Math.cos(elevation * RAD);
  const se = Math.sin(elevation * RAD);
  const P = STRIDE[gait];
  const armGain = gait === 'walk' ? -0.6 : -0.9;
  const elbow = gait === 'walk' ? 20 : 70;
  const mid = gait === 'walk' ? 0 : 7.5;
  return Array.from({ length: P * cycles }, (_, i) => {
    const phi = (2 * Math.PI * (i % P)) / P;
    const midHip: V3 = [0, 0, 0];
    const neck: V3 = [0, 150, 0];
    const j3: Record<string, V3> = { neck };
    const lifted: Array<'r' | 'l'> = [];
    for (const [side, s, du] of [['r', -1, 0], ['l', 1, 0.5]] as const) {
      const u = ((i % P) / P + du) % 1;
      const swing = ground ? GROUND_SWING : pushOff !== undefined ? pushOff.toeOff : SWING[gait];
      if (u >= swing - (ground ? 1e-9 : 0)) lifted.push(side);
      const { thigh, knee } = leg(gait, u, swing, pushOff);
      const legB = 6 * Math.sin(phi);
      const armB = 4 * Math.cos(phi);
      const hip = add(midHip, [s * 15, 0, 0]);
      const kneeP = add(hip, seg(LEN.thigh, thigh, legB, s));
      const ankle = add(kneeP, seg(LEN.shin, thigh - knee, legB, s));
      const sh = add(neck, [s * 30, -10, 0]);
      const ua = armGain * (thigh - mid);
      const el = add(sh, seg(LEN.upper, ua, armB, s));
      const wr = add(el, seg(LEN.fore, ua + elbow, armB, s));
      Object.assign(j3, { [`${side}_hip`]: hip, [`${side}_knee`]: kneeP, [`${side}_ankle`]: ankle, [`${side}_shoulder`]: sh, [`${side}_elbow`]: el, [`${side}_wrist`]: wr });
    }
    // The head: upright on the neck, the face forward.
    const nose = add(neck, [0, 30, 8]);
    Object.assign(j3, { nose, r_eye: add(nose, [-6, 5, -2]), l_eye: add(nose, [6, 5, -2]), r_ear: add(nose, [-14, 2, -10]), l_ear: add(nose, [14, 2, -10]) });
    if (ground) {
      const h = heightOf(gait, (i % P) / P);
      for (const k of Object.keys(j3)) j3[k] = add(j3[k]!, [0, h, 0]);
    }
    const tilted = view === 'front' && elevation !== 0;
    const draw = (p: V3): Pt => (tilted ? [200 + p[0], 400 - (p[1] * ce - p[2] * se)] : view === 'front' ? [200 + p[0], 400 - p[1]] : view === 'back' ? [200 - p[0], 400 - p[1]] : [200 + p[2], 400 - p[1]]);
    const near = (p: V3): number => (tilted ? p[1] * se + p[2] * ce : view === 'front' ? p[2] : view === 'back' ? -p[2] : -p[0]);
    const joints = Object.fromEntries(Object.entries(j3).map(([n, p]) => [n, draw(p)]));
    const z = Object.fromEntries(Object.entries(j3).map(([n, p]) => [n, near(p)]));
    const truth = {} as DepthFrame['truth'];
    for (const [name, [a, b]] of Object.entries(SEGMENTS) as Array<[Segment, readonly [string, string]]>) {
      const pa = joints[a]!;
      const pb = joints[b]!;
      const L = Math.hypot(...([0, 1, 2].map((k) => j3[b]![k]! - j3[a]![k]!) as V3));
      const ratio = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / L;
      const dz = z[b]! - z[a]!;
      truth[name] = { ratio, sign: ratio >= FLAT ? 0 : dz > 0 ? 1 : -1 };
    }
    const limb = Object.fromEntries((Object.entries(LIMBS) as Array<[Limb, readonly [string, string]]>).map(([l, [m, e]]) => [l, (z[m]! + z[e]!) / 2])) as Record<Limb, number>;
    return { joints, z, truth, limb, lifted };
  });
}

/** The true order between two limbs on a frame: +1 a in front, −1 b in front, 0 tied (closer than the band can tell). */
export function trueOrder(f: DepthFrame, a: Limb, b: Limb): -1 | 0 | 1 {
  const d = f.limb[a] - f.limb[b];
  return Math.abs(d) < TIE * Math.min(HIDDEN[a], HIDDEN[b]) ? 0 : d > 0 ? 1 : -1;
}

/** What a flat segment chain can hide at each leg joint, per unit of `TIE`: the knee the thigh's, the ankle the whole leg's. */
const JOINT_HIDDEN = { knee: LEN.thigh, ankle: LEN.thigh + LEN.shin } as const;

/**
 * The true order of the two legs at one joint (rig-c/pose#336): +1 the right leg's joint in front, −1 the left's, 0 tied
 * (closer than `TIE` × what a flat chain can hide there: 24.98 px at the knee, 46.84 at the ankle).
 */
export function trueJointOrder(f: DepthFrame, joint: 'knee' | 'ankle'): -1 | 0 | 1 {
  const d = f.z[`r_${joint}`]! - f.z[`l_${joint}`]!;
  return Math.abs(d) < TIE * JOINT_HIDDEN[joint] ? 0 : d > 0 ? 1 : -1;
}

/** The cycle as a rig-pose-sequence/1 document, before clean. */
export function depthDoc(cycle: DepthFrame[], source: string): Record<string, unknown> {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    spec: 'rig-pose-sequence/1',
    space: { units: 'picture-px', origin: 'top-left', y: 'down' },
    width: 400,
    height: 600,
    source,
    frames: cycle.map((f, i) => ({
      t: Math.round((i / FPS) * 1e6) / 1e6,
      people: [{ id: 'a', joints: Object.fromEntries(Object.entries(f.joints).map(([n, p]) => [n, { state: 'observed', at: [r2(p[0]), r2(p[1])], score: 1 }])) }],
    })),
  };
}

/** The three fixtures: the frontal run (3 strides), the frontal walk (2 strides) and the run seen from the side. */
export const FIXTURES = {
  run: () => depthCycle('run', 'front', 3),
  walk: () => depthCycle('walk', 'front', 2),
  side: () => depthCycle('run', 'side', 3),
} as const;

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined) {
    process.stderr.write('make-depth.ts: give the folder to write run.json, walk.json and side.json into\n');
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  for (const [name, make] of Object.entries(FIXTURES)) {
    const doc = depthDoc(make(), `examples/walk/make-depth.ts: ${name}, made in 3D from joint angles, no picture`);
    writeFileSync(join(out, `${name}.json`), `${JSON.stringify(doc)}\n`);
  }
  process.stdout.write(`wrote run.json, walk.json and side.json into ${out}\n`);
}
