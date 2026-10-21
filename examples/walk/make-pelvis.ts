/**
 * The walk with a drawn pelvis tilt (rig-c/pose#288): line-art PNG frames of the
 * walk's figure, drawn with rig-c's plate, beside the sequence a pose detector
 * would give of them — hips that keep only a share of the tilt.
 *
 * The figure is `make-walk.ts`'s, with its pelvis turned by
 *
 *   tilt(φ) = −15·sin φ   (degrees, Spine sense: counter-clockwise, y up)
 *
 * about mid_hip — 30° peak to peak, the swinging side's hip low (the right leg
 * swings for φ in [π, 2π], so the figure's right hip, on the picture's left,
 * drops there) — and its legs hanging from the drawn hips. The hip keypoints
 * keep `HIP_GAIN` (0.15) of the tilt, the rest of the joints are the drawing's.
 * Three variants:
 *
 * - `drawn`: the pelvis drawn as an outlined trapezoid whose top and bottom
 *   lines carry the tilt;
 * - `covered`: a filled garment band over the pelvis, its top edge (the
 *   waistband) turned by `bandTilt(φ)` = 12·cos φ — not the pelvis's own
 *   phase, so a reading that follows it read the band — and its hem level;
 * - `masked`: `drawn` with the pelvis region painted over in the background's
 *   colour, so no reader can read it.
 *
 * Two more, opt-in (rig-c/pose#293), for a paletted picture:
 *
 * - `dithered`: `covered` reduced to the 216-colour web palette (every channel
 *   a multiple of 51) by a 4×4 ordered (Bayer) dither, as a paletted GIF is —
 *   the garment's channels alternate between two palette steps pixel by pixel;
 * - `dithered-edge`: `dithered` with the hip keypoints moved up onto the
 *   band's top edge (their midpoint on the edge, their damped tilt kept), as a
 *   detector places them under a high waistband.
 *
 * Every frame is drawn from formulae (no randomness, no clock): the same call
 * writes the same bytes.
 *
 *   bun examples/walk/make-pelvis.ts <out-dir> [drawn|covered|masked]
 *
 * writes <out-dir>/frames/f00.png … f23.png and <out-dir>/pose.json (before
 * clean); the test (test/pelvis.test.ts) writes them into a temporary folder.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plate, type RGBA } from 'rig-c/plate';
import { walkCycle, walkDoc, type WalkFrame } from './make-walk.ts';

export const VARIANTS = ['drawn', 'covered', 'masked', 'dithered', 'dithered-edge'] as const;
export type Variant = (typeof VARIANTS)[number];
/** The drawn pelvis tilt, degrees (Spine sense), at the phase φ. */
export const pelvisTilt = (phi: number): number => -15 * Math.sin(phi);
/** The covered variant's waistband tilt, degrees (Spine sense), at the phase φ. */
export const bandTilt = (phi: number): number => 12 * Math.cos(phi);
/** The share of the drawn tilt the hip keypoints keep: a detector's damped hip line. */
export const HIP_GAIN = 0.15;

type Pt = [number, number];
const RAD = Math.PI / 180;
/** The waistband's height above the hip line, px. */
const BAND_TOP = 24;
const INK: RGBA = [20, 20, 20, 255];
const PAPER: RGBA = [255, 255, 255, 255];
const CLOTH: RGBA = [70, 110, 190, 255];
/** The 4×4 ordered-dither (Bayer) thresholds, 0–15. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
/** The web palette's step: 216 colours, six levels per channel (0, 51, …, 255). */
export const PALETTE_STEP = 51;
const dir = (deg: number, len: number): Pt => [len * Math.cos(deg * RAD), -len * Math.sin(deg * RAD)];
const add = (...ps: Pt[]): Pt => ps.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0] as Pt);

/** A filled polygon: each pixel whose centre is inside (even–odd). */
function fill(plate: Plate, pts: Pt[], colour: RGBA): void {
  const ys = pts.map((p) => p[1]);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    const xs: number[] = [];
    pts.forEach((a, k) => {
      const b = pts[(k + 1) % pts.length]!;
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    });
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k]!); x <= Math.floor(xs[k + 1]!); x++) plate.set(x, y, colour);
  }
}

function polyline(plate: Plate, pts: Pt[], closed = false): void {
  for (let k = 0; k + 1 < pts.length + (closed ? 1 : 0); k++) {
    const a = pts[k]!;
    const b = pts[(k + 1) % pts.length]!;
    plate.line(a[0], a[1], b[0], b[1], 1, INK);
  }
}

/** The plate reduced in place to the 216-colour palette by the 4×4 ordered dither, channel by channel (alpha untouched). */
export function dither216(plate: Plate): Plate {
  const { width: w, height: h, data } = plate;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (BAYER[y & 3]![x & 3]! + 0.5) / 16;
      for (let c = 0; c < 3; c++) {
        const i = (y * w + x) * 4 + c;
        const v = data[i]! / PALETTE_STEP;
        const q = Math.floor(v);
        data[i] = Math.min(255, PALETTE_STEP * (q + (v - q > t ? 1 : 0)));
      }
    }
  }
  return plate;
}

/** One frame of a variant, as a plate. */
export function drawFrame(f: WalkFrame, variant: Variant): Plate {
  if (variant === 'dithered' || variant === 'dithered-edge') return dither216(drawFrame(f, 'covered'));
  const plate = new Plate(400, 600);
  plate.rect(0, 0, 400, 600, PAPER);
  const j = f.joints;
  const { midHip, rHip, lHip, tilt } = f.drawn;
  /** A point of the pelvis's own frame: u along the pelvis line (toward the left hip), v up from it. */
  const at = (u: number, v: number, deg = tilt): Pt => add(midHip, dir(deg, u), dir(deg + 90, v));
  // Head, trunk, legs.
  plate.ring(j.nose![0], j.nose![1] - 4, 16, 1, INK);
  polyline(plate, [j.neck!, at(0, 10)]);
  polyline(plate, [rHip, j.r_knee!, j.r_ankle!]);
  polyline(plate, [lHip, j.l_knee!, j.l_ankle!]);
  // The pelvis: a trapezoid, its top line 10 px above the hip line and its bottom 8 below, both along the tilt.
  polyline(plate, [at(-20, 10), at(20, 10), at(24, -8), at(-24, -8)], true);
  if (variant === 'covered') {
    // The garment: its top edge (a high waistband, 24 px above the hip line) turned by the band's own tilt, its hem level 28 px below mid_hip.
    const b = bandTilt(f.phi);
    const band: Pt[] = [at(-30, BAND_TOP, b), at(30, BAND_TOP, b), [midHip[0] + 34, midHip[1] + 28], [midHip[0] - 34, midHip[1] + 28]];
    fill(plate, band, CLOTH);
    polyline(plate, band, true);
  }
  // Arms last: they hang in front, beside the hips.
  polyline(plate, [j.r_shoulder!, j.l_shoulder!]);
  polyline(plate, [j.r_shoulder!, j.r_elbow!, j.r_wrist!]);
  polyline(plate, [j.l_shoulder!, j.l_elbow!, j.l_wrist!]);
  if (variant === 'masked') plate.rect(Math.round(midHip[0] - 40), Math.round(midHip[1] - 22), 80, 44, PAPER);
  return plate;
}

/** The cycle with the tilt drawn and the hips damped. */
export const tiltedCycle = (): WalkFrame[] => walkCycle({ tilt: pelvisTilt, hipGain: HIP_GAIN });

/** The waistband's top edge above mid_hip: the band's top line passes through this point (px, y down). */
export const bandEdgeMid = (f: WalkFrame): Pt => add(f.drawn.midHip, dir(bandTilt(f.phi) + 90, BAND_TOP));

/** The cycle a variant's sequence is written from: for `dithered-edge`, the hip keypoints moved so their midpoint lies on the band's top edge. */
export function variantCycle(variant: Variant): WalkFrame[] {
  const cycle = tiltedCycle();
  if (variant !== 'dithered-edge') return cycle;
  return cycle.map((f) => {
    const [ex, ey] = bandEdgeMid(f);
    const [mx, my] = f.drawn.midHip;
    const up = (p: Pt): Pt => [p[0] + ex - mx, p[1] + ey - my];
    return { ...f, joints: { ...f.joints, r_hip: up(f.joints.r_hip!), l_hip: up(f.joints.l_hip!) } };
  });
}

/** Write a variant's frames and its sequence (before clean) into `dir`; returns their paths. */
export function writePelvisFixture(dir: string, variant: Variant): { frames: string; pose: string } {
  const cycle = variantCycle(variant);
  const frames = join(dir, 'frames');
  mkdirSync(frames, { recursive: true });
  cycle.forEach((f, i) => drawFrame(f, variant).writePng(join(frames, `f${String(i).padStart(2, '0')}.png`)));
  const pose = join(dir, 'pose.json');
  writeFileSync(pose, `${JSON.stringify(walkDoc(cycle, `examples/walk/make-pelvis.ts: the walk with a drawn pelvis tilt (−15·sin φ), its hip keypoints keeping ${HIP_GAIN} of it (${variant})`), null, 2)}\n`);
  return { frames, pose };
}

if (import.meta.main) {
  const [out, v = 'drawn'] = process.argv.slice(2);
  if (out === undefined || !(VARIANTS as readonly string[]).includes(v)) {
    process.stderr.write(`usage: bun examples/walk/make-pelvis.ts <out-dir> [${VARIANTS.join('|')}]\n`);
    process.exit(2);
  }
  const w = writePelvisFixture(out, v as Variant);
  process.stdout.write(`wrote ${w.frames} (24 PNG) and ${w.pose}\n`);
}
