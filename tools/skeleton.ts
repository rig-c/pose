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
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plate } from 'rig-c/plate';
import type { Body18 } from '../src/joints.ts';
import { personTrack, readPoseSequence } from '../src/pose.ts';

type RGBA = [number, number, number, number];
const RIGHT: RGBA = [214, 69, 65, 255];
const LEFT: RGBA = [52, 120, 214, 255];
const MID: RGBA = [120, 120, 120, 255];
const BACKGROUND: RGBA = [232, 232, 232, 255];
const JOINT: RGBA = [40, 40, 40, 255];

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

const args = process.argv.slice(2);
function flag(name: string, dflt?: string): string {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : dflt;
  if (v === undefined) {
    process.stderr.write(`skeleton.ts: --${name} is required\n`);
    process.exit(2);
  }
  return v;
}
const posePath = flag('pose');
const out = flag('out');
const height = Number(flag('height', '480'));
const minScore = Number(flag('min-score', '0.3'));
const person = args.includes('--person') ? flag('person') : undefined;

const seq = readPoseSequence(readFileSync(posePath, 'utf8'), posePath);
const frames = personTrack(seq, person, posePath);
const k = height / seq.height;
const width = Math.round((seq.width * k) / 2) * 2;
const t = Math.max(2, Math.round(height / 120));
mkdirSync(out, { recursive: true });
frames.forEach((joints, i) => {
  const plate = new Plate(width, height);
  plate.rect(0, 0, width, height, BACKGROUND);
  const at = (n: Body18): [number, number] | null => {
    const j = joints[n];
    if (j === undefined || j.state === 'missing' || j.at === undefined) return null;
    if (j.score !== undefined && j.score < minScore) return null;
    return [j.at[0] * k, j.at[1] * k];
  };
  for (const [a, b, colour] of LIMBS) {
    const pa = at(a);
    const pb = at(b);
    if (pa !== null && pb !== null) plate.line(pa[0], pa[1], pb[0], pb[1], t, colour);
  }
  for (const n of Object.keys(joints) as Body18[]) {
    const p = at(n);
    if (p !== null) plate.disc(p[0], p[1], t * 1.2, JOINT);
  }
  plate.writePng(join(out, `s${String(i).padStart(4, '0')}.png`));
});
process.stdout.write(`skeleton: ${frames.length} frame(s), ${width}x${height}, into ${out}\n`);
