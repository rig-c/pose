/**
 * Draw a pose sequence as limbs: one PNG per frame, the picture's own aspect,
 * scaled to `--height`, on a plain background. It is the demo's left pane, so
 * the reference footage itself is never shown. Not shipped.
 *
 *   bun tools/skeleton.ts --pose <rig-pose-sequence/1> --out <dir> [--height 480] [--min-score 0.3] [--person <id>]
 *
 * Colours follow the pose sheets the joints were checked on: the subject's
 * right red, left blue, the shoulder and hip lines and the neck grey. A joint
 * that is missing, or scored under --min-score, is not drawn on that frame
 * (no hold: this pane shows the input as it is, before the retarget's holds).
 * Writes s0000.png, s0001.png, …
 *
 * A sequence that carries depth (rig-c/pose#281, `clean --depth walk|run`) is
 * drawn by it instead: each limb segment the frame's `depth` names is coloured
 * toward the camera (warm), away (cool) or flat (neutral grey), the rest of the
 * figure thin and dark, an R and an L at the wrists and ankles, and a legend in
 * the frame's top-left corner. Without depth the frames are what they were.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plate } from 'rig-c/plate';
import type { Body18 } from '../src/joints.ts';
import { DEPTH_SEGMENTS, DEPTH_SEGMENT_NAMES, personTrack, readPoseSequence, type FrameDepth, type Joint } from '../src/pose.ts';

type RGBA = [number, number, number, number];
const RIGHT: RGBA = [214, 69, 65, 255];
const LEFT: RGBA = [52, 120, 214, 255];
const MID: RGBA = [120, 120, 120, 255];
const BACKGROUND: RGBA = [232, 232, 232, 255];
const JOINT: RGBA = [40, 40, 40, 255];
/** rig-c/pose#281: a segment's derived depth — toward the camera warm, away cool, flat neutral. */
export const TOWARD: RGBA = [236, 112, 20, 255];
export const AWAY: RGBA = [20, 150, 190, 255];
export const FLAT: RGBA = [150, 150, 150, 255];
const INK: RGBA = [30, 30, 30, 255];
const PAPER: RGBA = [250, 250, 250, 255];

const LIMBS: Array<[Body18, Body18, RGBA]> = [
  ['r_shoulder', 'r_elbow', RIGHT], ['r_elbow', 'r_wrist', RIGHT],
  ['r_hip', 'r_knee', RIGHT], ['r_knee', 'r_ankle', RIGHT],
  ['l_shoulder', 'l_elbow', LEFT], ['l_elbow', 'l_wrist', LEFT],
  ['l_hip', 'l_knee', LEFT], ['l_knee', 'l_ankle', LEFT],
  ['r_shoulder', 'l_shoulder', MID], ['r_hip', 'l_hip', MID],
  ['r_shoulder', 'r_hip', RIGHT], ['l_shoulder', 'l_hip', LEFT],
  ['neck', 'nose', MID], ['nose', 'r_eye', RIGHT], ['nose', 'l_eye', LEFT],
  ['r_eye', 'r_ear', RIGHT], ['l_eye', 'l_ear', LEFT],
];

/** A segment's colour by its depth's sign. */
export const depthColour = (sign: -1 | 0 | 1): RGBA => (sign > 0 ? TOWARD : sign < 0 ? AWAY : FLAT);

export interface SkeletonOptions {
  height: number;
  minScore: number;
  /** The legend's second line, e.g. "derived, run"; only with depth. */
  depthLabel?: string;
}

/** The plate's width for a picture drawn `height` px tall: the picture's aspect, even. */
export const skeletonWidth = (size: { width: number; height: number }, height: number): number => Math.round((size.width * (height / size.height)) / 2) * 2;

/** One frame as a plate: the limbs as the sheets colour them, or by depth when the frame carries it. */
export function drawSkeleton(joints: Partial<Record<Body18, Joint>>, size: { width: number; height: number }, o: SkeletonOptions, depth?: FrameDepth): Plate {
  const height = o.height;
  const k = height / size.height;
  const width = skeletonWidth(size, height);
  const t = Math.max(2, Math.round(height / 120));
  const plate = new Plate(width, height);
  plate.rect(0, 0, width, height, BACKGROUND);
  const at = (n: Body18): [number, number] | null => {
    const j = joints[n];
    if (j === undefined || j.state === 'missing' || j.at === undefined) return null;
    if (j.score !== undefined && j.score < o.minScore) return null;
    return [j.at[0] * k, j.at[1] * k];
  };
  if (depth === undefined) {
    for (const [a, b, colour] of LIMBS) {
      const pa = at(a);
      const pb = at(b);
      if (pa !== null && pb !== null) plate.line(pa[0], pa[1], pb[0], pb[1], t, colour);
    }
  } else {
    // The figure thin and dark under the depth-coloured segments, which are drawn thicker on top.
    const coloured = new Set(DEPTH_SEGMENT_NAMES.filter((s) => depth[s] !== undefined).map((s) => DEPTH_SEGMENTS[s].join('>')));
    for (const [a, b] of LIMBS) {
      if (coloured.has(`${a}>${b}`)) continue;
      const pa = at(a);
      const pb = at(b);
      if (pa !== null && pb !== null) plate.line(pa[0], pa[1], pb[0], pb[1], Math.max(1, Math.round(t / 2)), JOINT);
    }
    for (const s of DEPTH_SEGMENT_NAMES) {
      const d = depth[s];
      if (d === undefined) continue;
      const pa = at(DEPTH_SEGMENTS[s][0]);
      const pb = at(DEPTH_SEGMENTS[s][1]);
      if (pa !== null && pb !== null) plate.line(pa[0], pa[1], pb[0], pb[1], t * 2, depthColour(d.sign));
    }
  }
  for (const n of Object.keys(joints) as Body18[]) {
    const p = at(n);
    if (p !== null) plate.disc(p[0], p[1], t * 1.2, JOINT);
  }
  if (depth !== undefined) {
    const scale = legendScale(height);
    for (const n of ['r_wrist', 'l_wrist', 'r_ankle', 'l_ankle'] as const) {
      const p = at(n);
      if (p !== null) plate.text(n[0]!.toUpperCase(), p[0] + t * 2, p[1] - 4 * scale, scale, INK);
    }
    legend(plate, scale, o.depthLabel);
  }
  return plate;
}

/** The labels' and the legend's text scale for a plate `height` px tall. */
export const legendScale = (height: number): number => Math.max(1, Math.round(height / 320));
/** The legend's box, top left, in px at a scale: x, y, width, height. */
export const legendBox = (scale: number, label: boolean): [number, number, number, number] => [4 * scale, 4 * scale, 90 * scale, 10 * scale * (label ? 5 : 4) + 6 * scale];

/** The legend: what the colours mean. */
function legend(plate: Plate, scale: number, label: string | undefined): void {
  const line = 10 * scale;
  const rows: Array<[RGBA, string]> = [[TOWARD, 'TOWARD'], [FLAT, 'FLAT'], [AWAY, 'AWAY']];
  const [x, y0, w, h] = legendBox(scale, label !== undefined);
  plate.rect(x, y0, w, h, PAPER);
  plate.frame(x, y0, w, h, 1, INK);
  let y = 7 * scale;
  plate.text('DEPTH', 8 * scale, y, scale, INK);
  y += line;
  if (label !== undefined) {
    plate.text(label.toUpperCase().replace(/[^A-Z0-9 ,.:/()-]/g, ' '), 8 * scale, y, scale, INK);
    y += line;
  }
  for (const [colour, text] of rows) {
    plate.rect(8 * scale, y, 16 * scale, 7 * scale, colour);
    plate.text(text, 30 * scale, y, scale, INK);
    y += line;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string, dflt?: string): string => {
    const i = args.indexOf(`--${name}`);
    const v = i >= 0 ? args[i + 1] : dflt;
    if (v === undefined) {
      process.stderr.write(`skeleton.ts: --${name} is required\n`);
      process.exit(2);
    }
    return v;
  };
  const posePath = flag('pose');
  const out = flag('out');
  const height = Number(flag('height', '480'));
  const minScore = Number(flag('min-score', '0.3'));
  const person = args.includes('--person') ? flag('person') : undefined;

  const seq = readPoseSequence(readFileSync(posePath, 'utf8'), posePath);
  const frames = personTrack(seq, person, posePath);
  // rig-c/pose#281: the legend names the depth's source, and the gait clean derived it for.
  const gait = seq.cleaned?.params.depth?.gait;
  const source = seq.frames.flatMap((f) => Object.values(f.depth ?? {}))[0]?.source;
  const depthLabel = source === undefined ? undefined : gait === undefined ? source : `${source}, ${gait}`;
  mkdirSync(out, { recursive: true });
  frames.forEach((joints, i) => {
    drawSkeleton(joints, seq, { height, minScore, ...(depthLabel !== undefined ? { depthLabel } : {}) }, seq.frames[i]!.depth).writePng(join(out, `s${String(i).padStart(4, '0')}.png`));
  });
  process.stdout.write(`skeleton: ${frames.length} frame(s), ${skeletonWidth(seq, height)}x${height}, into ${out}${depthLabel !== undefined ? ` (coloured by depth: ${depthLabel})` : ''}\n`);
}
