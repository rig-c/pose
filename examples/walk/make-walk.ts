/**
 * Writes examples/walk/pose.json: one walk cycle in place at 24 fps, made from
 * joint angles rather than from any picture. A front-facing figure with the
 * wave's proportions (examples/wave/rig) walks without travelling: one stride
 * of 24 frames (1 s) from a right foot strike to the next. Frame i is drawn at
 * the phase φ = 2π·i/24, so frame 24 would be frame 0 again; it is not
 * written, and the last frame runs into the first.
 *
 * Every joint is a function of φ (sin and cos of φ and 2φ), in degrees, Spine
 * sense (counter-clockwise, y up). The figure faces the camera, so a leg
 * swinging forward is mostly seen foreshortened, not turned in the picture:
 *
 * - swing: the right leg swings for φ in [π, 2π], the left for φ in [0, π].
 *   On its swing half a leg's weight is w = sin² φ ( = (1 − cos 2φ)/2 ), 0 on
 *   its supporting half, so the supporting leg keeps its full length;
 * - foreshortening: the swinging leg's thigh is drawn 80·(1 − 0.15·w) px and
 *   its shin 70·(1 − 0.03·w) px long, as the knee comes forward toward the
 *   camera with the shin hanging below it; the swinging ankle rises up to
 *   15.4 px above the supporting one;
 * - thighs: both −90 + 4·sin φ. Seen from the front the legs are in
 *   opposition, half a cycle apart: as the swinging leg turns out, the
 *   supporting one turns in under the body, so in the picture both tilt the
 *   same way (the right leg is the left one mirrored and half a cycle on);
 * - knees: the swinging shin turns outward from its thigh by 8·w, so a knee
 *   bends one way only, and the supporting knee is straight;
 * - pelvis: mid_hip x fixed at 200, y 400 + 3·cos 2φ (lowest at each foot
 *   strike, twice a cycle);
 * - trunk: leans 2·sin φ toward the supporting foot (the right for φ in [0, π]);
 *   the neck is 150 px from mid_hip along it, the head rigid and upright on it;
 * - arms: both upper arms −10·sin φ from the wave's resting −100° (right)
 *   and −80° (left), against the legs' swing, and both forearms the same swing
 *   3 frames (π/4) later from −80° and −100°, so an elbow bends one way only
 *   (20° ± 7.7°).
 *
 * The sequence then passes through `clean` with loop on (every window wraps,
 * last frame into first, and the sequence is written "travel": "in-place"),
 * legs 5, rest 7 and the stillness hold off, as every sequence must before
 * `retarget` (rig-c/pose#67), and the cleaned file is what is written.
 *
 * `walkCycle` takes an opt-in pelvis tilt (rig-c/pose#288, `make-pelvis.ts`): the
 * hips drawn turned by tilt(φ) about mid_hip and the legs hanging from them,
 * while the hip keypoints keep only `hipGain` of it — what a pose detector
 * keeps of a drawn pelvis. Without it the cycle above is unchanged, and so is
 * pose.json.
 *
 *   bun examples/walk/make-walk.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, cleanLine } from '../../src/clean.ts';
import { readPoseSequence, writePoseSequence } from '../../src/pose.ts';

const FPS = 24;
/** One stride, right strike to right strike, in frames; the sequence is exactly one of them. */
const P = 24;
const RAD = Math.PI / 180;
/** Thigh swing, degrees either side of straight down. */
const THIGH = 4;
/** The swinging knee's largest bend, degrees, at mid-swing. */
const KNEE = 8;
/** How much shorter the swinging thigh and shin are drawn at mid-swing (foreshortening), shares of their length. */
const THIGH_SHORT = 0.15;
const SHIN_SHORT = 0.03;
/** Pelvis bob, px, twice a cycle. */
const BOB = 3;
/** Trunk lean toward the supporting foot, degrees. */
const LEAN = 2;
/** Arm swing, degrees, and how far the forearm trails it, radians (3 frames). */
const ARM = 10;
const TRAIL = (2 * Math.PI * 3) / P;

type Pt = [number, number];
/** A segment of `len` px at `deg` (Spine sense: counter-clockwise, y up), in picture px (y down). */
const dir = (deg: number, len: number): Pt => [len * Math.cos(deg * RAD), -len * Math.sin(deg * RAD)];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const r2 = (p: Pt): Pt => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
/** A leg's swing weight: sin² φ on its swing half, 0 on its supporting half. */
const swingOf = (sinPhi: number): number => Math.max(0, sinPhi) ** 2;

/** rig-c/pose#288: a drawn pelvis tilt, degrees (Spine sense) at the phase φ, and the share of it the hip keypoints keep. */
export interface WalkTilt {
  tilt: (phi: number) => number;
  hipGain: number;
}
/** One frame: the joints as written, and the hips as drawn (with a tilt, where the legs hang from). */
export interface WalkFrame {
  phi: number;
  joints: Record<string, Pt>;
  drawn: { midHip: Pt; rHip: Pt; lHip: Pt; tilt: number };
}

/** The cycle, frame by frame; with `o` the pelvis is drawn tilted and the hip keypoints damped. */
export function walkCycle(o?: WalkTilt): WalkFrame[] {
  return Array.from({ length: P }, (_, i) => {
    const phi = (2 * Math.PI * i) / P;
    const s = Math.sin(phi);
    const midHip: Pt = [200, 400 + BOB * Math.cos(2 * phi)];
    const tilt = o === undefined ? 0 : o.tilt(phi);
    const neck = add(midHip, dir(90 + LEAN * s, 150));
    const rSh = add(neck, [-30, 10]);
    const lSh = add(neck, [30, 10]);
    const rEl = add(rSh, dir(-100 - ARM * s, 70));
    const lEl = add(lSh, dir(-80 - ARM * s, 70));
    // The hips as drawn: 15 px either side of mid_hip along the pelvis line (level without a tilt).
    const half: Pt = o === undefined ? [15, 0] : dir(tilt, 15);
    const rHip = add(midHip, [-half[0], -half[1]]);
    const lHip = add(midHip, half);
    const kept: Pt = o === undefined ? half : dir(o.hipGain * tilt, 15);
    const thigh = -90 + THIGH * s;
    const wr = swingOf(-s);
    const wl = swingOf(s);
    const rKnee = add(rHip, dir(thigh, 80 * (1 - THIGH_SHORT * wr)));
    const lKnee = add(lHip, dir(thigh, 80 * (1 - THIGH_SHORT * wl)));
    const nose = add(neck, [0, -30]);
    const j: Record<string, Pt> = {
      nose,
      neck,
      r_shoulder: rSh,
      r_elbow: rEl,
      r_wrist: add(rEl, dir(-80 - ARM * Math.sin(phi - TRAIL), 60)),
      l_shoulder: lSh,
      l_elbow: lEl,
      l_wrist: add(lEl, dir(-100 - ARM * Math.sin(phi - TRAIL), 60)),
      r_hip: add(midHip, [-kept[0], -kept[1]]),
      r_knee: rKnee,
      r_ankle: add(rKnee, dir(thigh - KNEE * wr, 70 * (1 - SHIN_SHORT * wr))),
      l_hip: add(midHip, kept),
      l_knee: lKnee,
      l_ankle: add(lKnee, dir(thigh + KNEE * wl, 70 * (1 - SHIN_SHORT * wl))),
      r_eye: add(nose, [-6, -5]),
      l_eye: add(nose, [6, -5]),
      r_ear: add(nose, [-14, -2]),
      l_ear: add(nose, [14, -2]),
    };
    return { phi, joints: j, drawn: { midHip, rHip, lHip, tilt } };
  });
}

/** The cycle as a rig-pose-sequence/1 document, before clean. */
export function walkDoc(cycle: WalkFrame[], source = 'examples/walk/make-walk.ts: one 1 s walk cycle in place made from joint angles, no picture'): Record<string, unknown> {
  const frames = cycle.map((f, i) => {
    const joints = Object.fromEntries(Object.entries(f.joints).map(([n, p]) => [n, { state: 'observed', at: r2(p), score: 1 }]));
    return { t: Math.round((i / FPS) * 1e6) / 1e6, people: [{ id: 'a', joints }] };
  });
  return {
    spec: 'rig-pose-sequence/1',
    space: { units: 'picture-px', origin: 'top-left', y: 'down' },
    width: 400,
    height: 600,
    source,
    frames,
  };
}

if (import.meta.main) {
  const doc = walkDoc(walkCycle());
  const c = clean(readPoseSequence(JSON.stringify(doc), 'make-walk.ts'), { loop: true, legs: 5, rest: 7, hold: 'off' }, undefined, 'make-walk.ts');
  // The writer's key order and rounding, on one line.
  writeFileSync(join(import.meta.dir, 'pose.json'), `${JSON.stringify(JSON.parse(writePoseSequence(c.seq)))}\n`);
  process.stdout.write(`wrote ${(doc.frames as unknown[]).length} frames, cleaned: ${cleanLine(c.record)}\n`);
}
