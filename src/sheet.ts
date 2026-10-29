/**
 * The comparison's sheet (rig-c/pose#38): for each finding, the reference
 * skeleton beside the render skeleton at its worst frame, one row per finding,
 * worst first within each unit. Skeletons only — no video frame is ever drawn.
 * The finding's own points are drawn over the limbs in yellow.
 *
 * A cloth finding is a figure over a window with no single frame, so it has no
 * row. Pure: it returns the plate; the caller writes it.
 */
import { textWidth } from '@rig-c/core/font5x7';
import { Plate, type RGBA } from '@rig-c/core/plate';
import type { Body18 } from './joints.ts';
import { positionOf, type Finding, type Frames } from './compare.ts';

const RIGHT: RGBA = [214, 69, 65, 255];
const LEFT: RGBA = [52, 120, 214, 255];
const MID: RGBA = [120, 120, 120, 255];
const MARK: RGBA = [236, 180, 20, 255];
const PANE: RGBA = [232, 232, 232, 255];
const PAPER: RGBA = [255, 255, 255, 255];
const INK: RGBA = [30, 30, 30, 255];

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

export interface SheetSide {
  frames: Frames;
  width: number;
  height: number;
}

/** The pane height in px; each pane keeps its picture's aspect. */
export const SHEET_PANE = 320;
const LABEL = 28;
const GAP = 8;

/** The findings a sheet draws: every one with a frame (not cloth). */
export function drawable(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.unit !== 'cloth');
}

/** The sheet as a plate, or null when no finding has a frame to draw. */
export function drawSheet(reference: SheetSide, render: SheetSide, findings: readonly Finding[]): Plate | null {
  const rows = drawable(findings);
  if (rows.length === 0) return null;
  const wa = Math.round((reference.width * SHEET_PANE) / reference.height);
  const wb = Math.round((render.width * SHEET_PANE) / render.height);
  const width = Math.max(wa + GAP + wb, 480) + 2 * GAP;
  const rowH = LABEL + SHEET_PANE + GAP;
  const plate = new Plate(width, GAP + rows.length * rowH);
  plate.rect(0, 0, plate.width, plate.height, PAPER);
  rows.forEach((f, k) => {
    const y = GAP + k * rowH;
    const title = label(`${k + 1} ${f.unit} ${f.measure} ${f.subject} frame ${f.worst.frame} t=${f.worst.t.toFixed(3)}`);
    plate.text(title, GAP, y, textWidth(title, 2) <= width - 2 * GAP ? 2 : 1, INK);
    plate.text('reference', GAP, y + 16, 1, INK);
    plate.text('render', GAP + wa + GAP, y + 16, 1, INK);
    pane(plate, reference, f, GAP, y + LABEL, wa);
    pane(plate, render, f, GAP + wa + GAP, y + LABEL, wb);
  });
  return plate;
}

function pane(plate: Plate, side: SheetSide, f: Finding, x0: number, y0: number, w: number): void {
  plate.rect(x0, y0, w, SHEET_PANE, PANE);
  const k = SHEET_PANE / side.height;
  const joints = side.frames[f.worst.frame] ?? {};
  const at = (n: string): [number, number] | null => {
    const p = positionOf(joints, n);
    if (p === null) return null;
    const x = x0 + p[0] * k;
    const y = y0 + p[1] * k;
    // A point outside the picture is not drawn outside its pane.
    return x < x0 || x >= x0 + w || y < y0 || y >= y0 + SHEET_PANE ? null : [x, y];
  };
  const t = 3;
  for (const [a, b, colour] of LIMBS) {
    const pa = at(a);
    const pb = at(b);
    if (pa !== null && pb !== null) plate.line(pa[0], pa[1], pb[0], pb[1], t, colour);
  }
  // A hand's points are not body-18: its wrist is marked.
  const marks = f.measure === 'visibility' ? [f.subject === 'hand_r' ? 'r_wrist' : 'l_wrist'] : f.points;
  for (let i = 0; i + 1 < marks.length; i++) {
    const pa = at(marks[i]!);
    const pb = at(marks[i + 1]!);
    if (pa !== null && pb !== null) plate.line(pa[0], pa[1], pb[0], pb[1], t + 2, MARK);
  }
  for (const q of marks) {
    const pq = at(q);
    if (pq !== null) plate.disc(pq[0], pq[1], t * 2, MARK);
  }
}

/** The 5×7 font has capitals, digits and a little punctuation; anything else becomes a space. */
function label(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 _\-.,:/()!+=<>]/g, ' ');
}
