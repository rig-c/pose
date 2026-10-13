/**
 * Writes examples/wave/pose.json: a 3-second wave at 24 fps, made from joint
 * angles rather than from any picture. The right upper arm rises from the side
 * to above the shoulder over the first second, the forearm waves (±35°, 1.5
 * Hz) for the next two, and the hips sway a little side to side.
 *
 *   bun examples/wave/make-pose.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FPS = 24;
const SECONDS = 3;
const RAD = Math.PI / 180;
type Pt = [number, number];
/** A segment of `len` px at `deg` (Spine sense: counter-clockwise, y up), in picture px (y down). */
const dir = (deg: number, len: number): Pt => [len * Math.cos(deg * RAD), -len * Math.sin(deg * RAD)];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const r2 = (p: Pt): Pt => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

const frames = Array.from({ length: FPS * SECONDS + 1 }, (_, i) => {
  const t = i / FPS;
  const rise = Math.min(1, t); // 0 → 1 over the first second
  const sway = 6 * Math.sin(2 * Math.PI * 0.75 * t);
  const midHip: Pt = [200 + sway, 400];
  const neck = add(midHip, dir(90 - sway / 4, 150));
  const rSh = add(neck, [-30, 10]);
  const lSh = add(neck, [30, 10]);
  const upper = -100 + rise * 150; // −100° hanging, 50° raised
  const fore = upper + 20 + rise * (30 + (t > 1 ? 35 * Math.sin(2 * Math.PI * 1.5 * (t - 1)) : 0));
  const rEl = add(rSh, dir(upper, 70));
  const lEl = add(lSh, dir(-80, 70));
  const nose = add(neck, [0, -30]);
  const j: Record<string, Pt> = {
    nose,
    neck,
    r_shoulder: rSh,
    r_elbow: rEl,
    r_wrist: add(rEl, dir(fore, 60)),
    l_shoulder: lSh,
    l_elbow: lEl,
    l_wrist: add(lEl, dir(-100, 60)),
    r_hip: add(midHip, [-15, 0]),
    r_knee: add(midHip, [-22, 80]),
    r_ankle: add(midHip, [-26, 150]),
    l_hip: add(midHip, [15, 0]),
    l_knee: add(midHip, [22, 80]),
    l_ankle: add(midHip, [26, 150]),
    r_eye: add(nose, [-6, -5]),
    l_eye: add(nose, [6, -5]),
  };
  const joints = Object.fromEntries(Object.entries(j).map(([n, p]) => [n, { state: 'observed', at: r2(p), score: 1 }]));
  return { t: Math.round(t * 1e6) / 1e6, people: [{ id: 'a', joints }] };
});

const doc = {
  spec: 'rig-pose-sequence/1',
  space: { units: 'picture-px', origin: 'top-left', y: 'down' },
  width: 400,
  height: 600,
  source: 'examples/wave/make-pose.ts: a 3 s wave made from joint angles, no picture',
  frames,
};
writeFileSync(join(import.meta.dir, 'pose.json'), `${JSON.stringify(doc)}\n`);
process.stdout.write(`wrote ${frames.length} frames\n`);
