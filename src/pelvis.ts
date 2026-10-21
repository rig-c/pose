/**
 * `rig-pose pelvis` (rig-c/pose#288): the pelvis line read off the picture, per
 * frame, written into the sequence as its own track — `pelvisTilt` on every
 * frame and the sequence's `pelvisSource` (minor 1.1, `src/pose.ts`). It runs
 * before `clean`, which smooths the track as its own; `retarget` keys the map's
 * pelvis chain from it.
 *
 * A pose detector keeps little of a drawn pelvis tilt: on a frontal walk drawn
 * with the pelvis line in every key, its hips held 4.5° of a 30.5° swing. The
 * drawing has it, so the drawing is read. Two readers, on PNG frames (one per
 * sequence frame, read with rig-c's plate; no video), each placed by the hip
 * keypoints — where the hips are and which of them is the figure's right — but
 * not reading their angle:
 *
 * - `silhouette`: the straightest edge of the drawn figure across the hip span
 *   near the hips' height — an edge pixel is a figure pixel (one that differs
 *   from the background colour) beside a background pixel, so a drawn outline and
 *   a filled shape both have one. Every straight line within ±40° of level is
 *   scored by how many columns of the hip span (between the two hip keypoints)
 *   carry an edge pixel on it, over rows within one hip width of the hips; the
 *   best is fitted by least squares on its pixels.
 * - `waistband`: the top edge of a garment covering the hips — the colour at the
 *   hips' midpoint, where it is not the background's, and in each column of the
 *   hip span the first row from 1.5 hip widths above the hips where three pixels
 *   in a row carry it; the line fitted through those tops. The colour must hold
 *   (rig-c/pose#293): ≥ `HOLD` of the patch's pixels carry its median. A dithered
 *   or paletted garment does not hold pixel by pixel — its channels alternate
 *   between palette steps — so it is read through the mean of a 5×5 window,
 *   which does; hips on the band's top edge give a patch half garment, half
 *   ground, so the patch is tried below them (up to two patch radii), and the
 *   scan runs down to where the colour was found. The first patch that holds
 *   and is not the background is the garment; with none, the midpoint's median
 *   is read as it is.
 *   The line is fitted through the band's top edge (rig-c/pose#318): where a
 *   strip of the garment is too thin for the colour test (a waistband drawn as
 *   two ink lines), the tops step between the strip's lines, and each column
 *   is followed up to its topmost garment pixel; an edge that cuts across the
 *   band under it (a fold) is declined.
 *
 * The forearms are not read: pixels near the segments elbow → wrist (and the
 * hands) are masked, since a hanging arm passes the hips in a walk. A frame
 * either reader cannot read is declined with its reason and its tilt is null —
 * marked, not guessed; `retarget` keys the hip line there and says so.
 *
 * `--pelvis-keys` is the hand override, `rig-pose-pelvis-keys/1`: tilts at
 * frames (fractional ones too, #294), linear between them (the short way round)
 * and held outside them.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlate, type Plate } from 'rig-c/plate';
import type { Body18 } from './joints.ts';
import { personTrack, readPoseSequence, writePoseSequence, type Joint, type PelvisSource, type PoseSequence } from './pose.ts';
import { isObject, parseJson, Problems, refuseUnknownKeys, typeName } from './problems.ts';
import { pictureAngle, wrap } from './retarget.ts';
import { makeOutDirs, planOutDirs } from './outdir.ts';

type Pt = [number, number];
type RGB = [number, number, number];

/** The two readers. */
export const PELVIS_MODES = ['silhouette', 'waistband', 'below-cover'] as const;
export type PelvisMode = (typeof PELVIS_MODES)[number];
export const PELVIS_KEYS_SPEC = 'rig-pose-pelvis-keys/1';

/** A pixel is the figure's when a channel differs from the background colour's by more than this (0–255). */
export const FIGURE_DIFF = 64;
/** A pixel carries the garment's colour when no channel differs from it by more than this. */
export const GARMENT_DIFF = 40;
/** A garment's colour holds on a patch when at least this share of its pixels carry it (within `GARMENT_DIFF`). */
export const HOLD = 0.75;
/** A garment that does not hold pixel by pixel is read through the mean of the square window this many px either side of a pixel (5×5: a 4×4 ordered dither's period and a pixel more). */
export const DITHER_RADIUS = 2;
/** The silhouette reader scores lines within this many degrees of level. */
export const MAX_TILT = 40;
/** A line is read when it covers at least this share of the hip span's columns. */
export const MIN_COVER = 0.6;
/** ... and its pixels lie within this many px (root mean square) of the fitted line. */
export const MAX_RMS = 2.5;
/** A forearm is masked within this share of the hip span of its segment (at least 3 px), a hand within 1.5 times it of the wrist. */
export const ARM_RADIUS = 0.15;
/** Hips closer than this in the picture, px, have no span to read across (a figure seen side-on). */
export const MIN_SPAN = 6;
/** The band's top is taken above the scan's tops only when their climbs to it differ by more than this many rows (rig-c/pose#318): each end of a clean edge's climb is found to a row. */
export const CLIMB_SPREAD = 2;
/** The band's top is climbed against at most this many garment colours (rig-c/pose#318): a paletted garment's own, or a painted one's fullest cells. */
export const MAX_CLOTH = 16;
/** rig-c/pose#342: the below-cover cues read the same line when their tilts lie within this many degrees (max − min). */
export const CUE_SPREAD = 8;
/** ... a leg's colour is sampled this far along its thigh, hip → knee. */
export const LEG_AT = 0.7;
/** ... the hem and a thigh root are where the garment stops for this many px (rows, or along the thigh) in a row. */
export const LEAVE = 3;

/**
 * One frame's reading: the tilt (Spine degrees, r_hip → l_hip), or why it was declined. A waistband
 * read through the window mean says so (`mean`), and one whose colour was found below the hips says
 * how far (`below`, px); one whose band top lay above the colour's edge in some columns says how many (`raised`, #318).
 */
export type Reading = { tilt: number; cover: number; rms: number; mean?: true; below?: number; raised?: number; cues?: CueTilts } | { kind: string; why: string };

/**
 * rig-c/pose#342: the below-cover cues of one frame, Spine degrees r_hip → l_hip; null where the cue was not read. `band` is
 * "covered" when something other than the ground lies over the band's top. `hips` is the keypoints' line: reported, not fitted.
 */
export interface CueTilts {
  hem: number | null;
  roots: number | null;
  band: number | 'covered' | null;
  hips: number;
}

/** rig-c/pose#342: a below-cover reading's figures and points (the picture's), and why each cue not read was not. */
export interface CueDetail {
  tilts: CueTilts;
  why: { hem?: string; roots?: string; band?: string };
  garment: RGB;
  legs: { r: RGB | null; l: RGB | null };
  hem: { pts: Pt[]; fit: { m: number; q: number; rms: number } | null };
  roots: { r: Pt | null; l: Pt | null; paths: Array<[Pt, Pt]> };
  band: { m: number; q: number } | null;
}

/** The frame as RGB over white, its background colour, and which pixels are masked (forearms, hands). */
interface Frame {
  w: number;
  h: number;
  rgb: (x: number, y: number) => RGB;
  bg: RGB;
  masked: (x: number, y: number) => boolean;
}

const diff = (a: RGB, b: RGB) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Distance from p to the segment a → b. */
function toSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const u = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dy));
}

function frameOf(plate: Plate, arms: Array<[Pt, Pt]>, radius: number): Frame {
  const { width: w, height: h, data } = plate;
  const rgb = (x: number, y: number): RGB => {
    const i = (y * w + x) * 4;
    const a = data[i + 3]! / 255;
    return [data[i]! * a + 255 * (1 - a), data[i + 1]! * a + 255 * (1 - a), data[i + 2]! * a + 255 * (1 - a)];
  };
  // The background: the median of the border pixels, channel by channel.
  const border: RGB[] = [];
  for (let x = 0; x < w; x++) border.push(rgb(x, 0), rgb(x, h - 1));
  for (let y = 1; y < h - 1; y++) border.push(rgb(0, y), rgb(w - 1, y));
  const bg: RGB = [0, 1, 2].map((c) => median(border.map((p) => p[c]!))) as RGB;
  const masked = (x: number, y: number) => arms.some(([e, wr]) => toSegment([x, y], e, wr) <= radius || Math.hypot(x - wr[0], y - wr[1]) <= 1.5 * radius);
  return { w, h, rgb, bg, masked };
}

/** Least squares y = m·x + q, one pass rejecting points beyond 3 MADs (at least 0.5 px), refitted. */
function fitLine(pts: Pt[]): { m: number; q: number; rms: number; kept: Pt[] } | null {
  const fit = (ps: Pt[]) => {
    const n = ps.length;
    const sx = ps.reduce((s, p) => s + p[0], 0) / n;
    const sy = ps.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const p of ps) {
      sxx += (p[0] - sx) ** 2;
      sxy += (p[0] - sx) * (p[1] - sy);
    }
    if (sxx < 1e-9) return null;
    const m = sxy / sxx;
    return { m, q: sy - m * sx };
  };
  if (pts.length < 3) return null;
  const f0 = fit(pts);
  if (f0 === null) return null;
  const res = pts.map((p) => p[1] - (f0.m * p[0] + f0.q));
  const mad = Math.max(0.5, median(res.map((r) => Math.abs(r - median(res)))));
  const kept = pts.filter((_, i) => Math.abs(res[i]! - median(res)) <= 3 * mad);
  const f1 = kept.length >= 3 ? fit(kept) : null;
  if (f1 === null) return null;
  const rms = Math.sqrt(kept.reduce((s, p) => s + (p[1] - (f1.m * p[0] + f1.q)) ** 2, 0) / kept.length);
  return { ...f1, rms, kept };
}

/** The picture slope of a line, as the tilt: Spine degrees of the direction from the figure's right hip toward its left. */
function tiltOf(m: number, rHip: Pt, lHip: Pt): number {
  const d: Pt = lHip[0] >= rHip[0] ? [1, m] : [-1, -m];
  return pictureAngle([0, 0], d);
}

/**
 * Read one frame. `joints` are in the frame's own pixels (a sequence's camera
 * already undone). Pure: the same plate and joints read the same tilt.
 */
export function readPelvis(plate: Plate, joints: Partial<Record<Body18, Joint>>, mode: PelvisMode): Reading {
  const pt = (n: Body18): Pt | null => {
    const j = joints[n];
    return j === undefined || j.state === 'missing' || j.at === undefined ? null : [j.at[0], j.at[1]];
  };
  const rHip = pt('r_hip');
  const lHip = pt('l_hip');
  if (rHip === null || lHip === null) return { kind: 'no hips', why: `${rHip === null ? 'r_hip' : 'l_hip'} has no position on the frame; the hips place the reading` };
  const span = Math.hypot(lHip[0] - rHip[0], lHip[1] - rHip[1]);
  const x0 = Math.round(Math.min(rHip[0], lHip[0]));
  const x1 = Math.round(Math.max(rHip[0], lHip[0]));
  if (span < MIN_SPAN || x1 - x0 + 1 < MIN_SPAN) return { kind: 'hips side-on', why: `the hips are ${span.toFixed(1)} px apart (${x1 - x0 + 1} column(s)); a line across them needs ≥ ${MIN_SPAN} (a figure seen side-on)` };
  const c: Pt = [(rHip[0] + lHip[0]) / 2, (rHip[1] + lHip[1]) / 2];
  const arms: Array<[Pt, Pt]> = [];
  for (const [e, w] of [['r_elbow', 'r_wrist'], ['l_elbow', 'l_wrist']] as const) {
    const a = pt(e);
    const b = pt(w);
    if (a !== null && b !== null) arms.push([a, b]);
  }
  const f = frameOf(plate, arms, Math.max(3, ARM_RADIUS * span));
  if (x0 < 0 || x1 >= f.w || c[1] < 0 || c[1] >= f.h) return { kind: 'hips outside the frame', why: `the hips (${c[0].toFixed(1)}, ${c[1].toFixed(1)}) lie outside the ${f.w}×${f.h} frame` };
  const cols = x1 - x0 + 1;
  if (mode === 'silhouette') return silhouette(f, c, span, x0, x1, cols, rHip, lHip);
  if (mode === 'waistband') return waistband(f, c, span, x0, x1, cols, rHip, lHip);
  return belowCover(f, c, span, x0, x1, cols, rHip, lHip, pt).reading;
}

/**
 * rig-c/pose#342: the below-cover reading of one frame with every cue's figures and points, for a picture of it. Null when
 * the frame is declined before any cue is read (no hips, side-on, outside the frame); the reading is `readPelvis`'s.
 */
export function readBelowCover(plate: Plate, joints: Partial<Record<Body18, Joint>>): { reading: Reading; detail: CueDetail | null } {
  const reading = readPelvis(plate, joints, 'below-cover');
  const pt = (n: Body18): Pt | null => {
    const j = joints[n];
    return j === undefined || j.state === 'missing' || j.at === undefined ? null : [j.at[0], j.at[1]];
  };
  const rHip = pt('r_hip');
  const lHip = pt('l_hip');
  if (rHip === null || lHip === null) return { reading, detail: null };
  const span = Math.hypot(lHip[0] - rHip[0], lHip[1] - rHip[1]);
  const x0 = Math.round(Math.min(rHip[0], lHip[0]));
  const x1 = Math.round(Math.max(rHip[0], lHip[0]));
  if (span < MIN_SPAN || x1 - x0 + 1 < MIN_SPAN) return { reading, detail: null };
  const c: Pt = [(rHip[0] + lHip[0]) / 2, (rHip[1] + lHip[1]) / 2];
  const arms: Array<[Pt, Pt]> = [];
  for (const [e, w] of [['r_elbow', 'r_wrist'], ['l_elbow', 'l_wrist']] as const) {
    const a = pt(e);
    const b = pt(w);
    if (a !== null && b !== null) arms.push([a, b]);
  }
  const f = frameOf(plate, arms, Math.max(3, ARM_RADIUS * span));
  if (x0 < 0 || x1 >= f.w || c[1] < 0 || c[1] >= f.h) return { reading, detail: null };
  return { reading, detail: belowCover(f, c, span, x0, x1, x1 - x0 + 1, rHip, lHip, pt).detail };
}

function silhouette(f: Frame, c: Pt, span: number, x0: number, x1: number, cols: number, rHip: Pt, lHip: Pt): Reading {
  const yA = Math.max(1, Math.floor(c[1] - span));
  const yB = Math.min(f.h - 2, Math.ceil(c[1] + span));
  const figure = (x: number, y: number) => !f.masked(x, y) && diff(f.rgb(x, y), f.bg) > FIGURE_DIFF;
  const ground = (x: number, y: number) => !f.masked(x, y) && diff(f.rgb(x, y), f.bg) <= FIGURE_DIFF;
  const edges: Pt[] = [];
  for (let y = yA; y <= yB; y++) {
    for (let x = Math.max(1, x0); x <= Math.min(f.w - 2, x1); x++) {
      if (figure(x, y) && (ground(x - 1, y) || ground(x + 1, y) || ground(x, y - 1) || ground(x, y + 1))) edges.push([x, y]);
    }
  }
  if (edges.length === 0) return { kind: 'no edge near the hips', why: `no edge of the figure within ${span.toFixed(0)} px of the hips' height across the hip span (the pelvis blank, or the figure the background's colour there)` };
  // Every line within ±MAX_TILT of level, at 0.5° and 1 px: the edge pixels within 1 px of it (its score), and the columns of the span they cover.
  const R = Math.ceil(2 * span) + 2;
  const bins = 2 * R + 1;
  let best = { count: -1, cover: 0, a: 0, rho: 0 };
  const mark = new Uint8Array(bins * cols);
  const hist = new Int32Array(bins);
  for (let k = -2 * MAX_TILT; k <= 2 * MAX_TILT; k++) {
    const a = (k / 2) * (Math.PI / 180);
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    mark.fill(0);
    hist.fill(0);
    for (const [x, y] of edges) {
      const b = Math.round(nx * (x - c[0]) + ny * (y - c[1])) + R;
      if (b < 0 || b >= bins) continue;
      mark[b * cols + (x - x0)] = 1;
      hist[b]!++;
    }
    for (let b = 1; b < bins - 1; b++) {
      const count = hist[b - 1]! + hist[b]! + hist[b + 1]!;
      const rho = b - R;
      // Ties: the line nearer the hips, then the more level, then the lower angle — a fixed order.
      if (!(count > best.count || (count === best.count && (Math.abs(rho) < Math.abs(best.rho) || (Math.abs(rho) === Math.abs(best.rho) && Math.abs(k) < Math.abs(best.a)))))) continue;
      let cover = 0;
      for (let x = 0; x < cols; x++) if (mark[(b - 1) * cols + x]! | mark[b * cols + x]! | mark[(b + 1) * cols + x]!) cover++;
      best = { count, cover, a: k, rho };
    }
  }
  const share = best.cover / cols;
  if (share < MIN_COVER) return { kind: 'no straight edge spans the hips', why: `the best line covers ${best.cover} of the ${cols} columns between them (${(100 * share).toFixed(0)}% < ${100 * MIN_COVER}%)` };
  const a = (best.a / 2) * (Math.PI / 180);
  const on = edges.filter(([x, y]) => Math.abs(-Math.sin(a) * (x - c[0]) + Math.cos(a) * (y - c[1]) - best.rho) <= 2.5);
  const fit = fitLine(on);
  if (fit === null) return { kind: 'no line', why: 'the best line\'s pixels do not fit a line (fewer than three, or one column)' };
  if (fit.rms > MAX_RMS) return { kind: 'not a straight edge', why: `the best line's pixels lie ${fit.rms.toFixed(2)} px from it (root mean square > ${MAX_RMS}); not a straight edge` };
  return { tilt: tiltOf(fit.m, rHip, lHip), cover: share, rms: fit.rms };
}

/** The mean colour of the unmasked pixels in the window `DITHER_RADIUS` either side of (x, y), or null when all are masked. Cached per frame. */
function meanOf(f: Frame): (x: number, y: number) => RGB | null {
  const cache = new Map<number, RGB | null>();
  return (x, y) => {
    const key = y * f.w + x;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const s: RGB = [0, 0, 0];
    let n = 0;
    for (let v = Math.max(0, y - DITHER_RADIUS); v <= Math.min(f.h - 1, y + DITHER_RADIUS); v++) {
      for (let u = Math.max(0, x - DITHER_RADIUS); u <= Math.min(f.w - 1, x + DITHER_RADIUS); u++) {
        if (f.masked(u, v)) continue;
        const p = f.rgb(u, v);
        s[0] += p[0];
        s[1] += p[1];
        s[2] += p[2];
        n++;
      }
    }
    const m: RGB | null = n === 0 ? null : [s[0] / n, s[1] / n, s[2] / n];
    cache.set(key, m);
    return m;
  };
}

/** `out.fit`, when given, receives the edge read (rig-c/pose#342 looks at what lies above it). */
function waistband(f: Frame, c: Pt, span: number, x0: number, x1: number, cols: number, rHip: Pt, lHip: Pt, out?: { fit?: { m: number; q: number } }): Reading {
  // The garment's colour: the median over the unmasked pixels of a patch at the hips' midpoint (or below it), as they are or through the window mean.
  const r = Math.max(2, 0.3 * span);
  const raw = (x: number, y: number): RGB | null => f.rgb(x, y);
  const mean = meanOf(f);
  const patchAt = (cy: number, colour: (x: number, y: number) => RGB | null): { g: RGB; holds: boolean } | null => {
    const patch: RGB[] = [];
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(c[0] - r); x <= Math.ceil(c[0] + r); x++) {
        if (x < 0 || y < 0 || x >= f.w || y >= f.h || Math.hypot(x - c[0], y - cy) > r || f.masked(x, y)) continue;
        const p = colour(x, y);
        if (p !== null) patch.push(p);
      }
    }
    if (patch.length === 0) return null;
    const g: RGB = [0, 1, 2].map((k) => median(patch.map((p) => p[k]!))) as RGB;
    return { g, holds: patch.filter((p) => diff(p, g) <= GARMENT_DIFF).length >= HOLD * patch.length };
  };
  const mid = patchAt(c[1], raw);
  if (mid === null) return { kind: 'hips behind a forearm', why: 'the hips\' midpoint is covered by a forearm; no garment colour to read' };
  // The first patch that holds and is not the background: at the midpoint, then one and two patch radii below; as they are, then through the window mean.
  let found: { g: RGB; below: number; isMean: boolean } | null = null;
  for (const below of [0, r, 2 * r]) {
    for (const isMean of [false, true]) {
      const pa = below === 0 && !isMean ? mid : patchAt(c[1] + below, isMean ? mean : raw);
      if (pa !== null && pa.holds && diff(pa.g, f.bg) > FIGURE_DIFF) {
        found = { g: pa.g, below, isMean };
        break;
      }
    }
    if (found !== null) break;
  }
  // None: the midpoint's median as it is.
  const g = found?.g ?? mid.g;
  const isMean = found?.isMean ?? false;
  const below = found?.below ?? 0;
  if (diff(g, f.bg) <= FIGURE_DIFF) return { kind: 'no garment over the hips', why: `the colour at the hips' midpoint (${g.map((v) => v.toFixed(0)).join(', ')}) is the background's (${f.bg.map((v) => v.toFixed(0)).join(', ')})` };
  const top = Math.max(0, Math.floor(c[1] - 1.5 * span));
  const bottom = Math.floor(c[1] + below);
  const colourAt = isMean ? mean : raw;
  const garment = (x: number, y: number) => {
    if (y >= f.h) return false;
    const p = colourAt(x, y);
    return p !== null && diff(p, g) <= GARMENT_DIFF;
  };
  const tops: Pt[] = [];
  let above = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = top; y <= bottom; y++) {
      // A forearm crossing the column is passed over; a top edge right under it is hidden by it, and the column is not read.
      if (f.masked(x, y)) continue;
      if (garment(x, y) && garment(x, y + 1) && garment(x, y + 2)) {
        if (y === top) above++;
        else if (!f.masked(x, y - 1)) tops.push([x, y]);
        break;
      }
    }
  }
  const raised = toBandTop(f, tops, g, top, colourAt);
  const share = tops.length / cols;
  if (share < MIN_COVER) {
    return above > cols / 2 ? { kind: 'garment above the band', why: `the garment runs above the band read (${above} of ${cols} columns carry its colour ${(1.5 * span).toFixed(0)} px above the hips); no waistband edge` } : { kind: 'waistband edge too short', why: `the garment's top edge is found in ${tops.length} of the ${cols} columns between the hips (${(100 * share).toFixed(0)}% < ${100 * MIN_COVER}%)` };
  }
  const fit = fitLine(tops);
  if (fit === null) return { kind: 'no line', why: 'the garment\'s top edge does not fit a line (fewer than three columns)' };
  if (fit.rms > MAX_RMS) return { kind: 'not a straight waistband', why: `the garment's top edge lies ${fit.rms.toFixed(2)} px from its line (root mean square > ${MAX_RMS}); not a straight waistband` };
  if (Math.abs(Math.atan(fit.m)) * (180 / Math.PI) > 45) return { kind: 'waistband too steep', why: `the garment's top edge runs ${(Math.atan(fit.m) * (180 / Math.PI)).toFixed(1)}° from level; a waistband is within 45°` };
  const off = notTheBand(f, fit, tops, top, colourAt);
  if (off !== null) return off;
  if (out !== undefined) out.fit = { m: fit.m, q: fit.q };
  return { tilt: tiltOf(fit.m, rHip, lHip), cover: share, rms: fit.rms, ...(isMean ? { mean: true as const } : {}), ...(below > 0 ? { below } : {}), ...(raised > 0 ? { raised } : {}) };
}

/**
 * rig-c/pose#318: the band's top edge, the topmost garment boundary in each column. The three-row test misses garment
 * above the row it finds when a strip of it is too thin to carry the colour three rows deep (through the window mean,
 * a strip between two ink lines never does), so the tops step between a strip's top line and the cloth under its lower
 * line. The garment's colours are the picture's own: the pixels of three rows in each column `DITHER_RADIUS + 1` below
 * the row the scan found, clear of the edge's blend (an outline there would lend the colour above to the garment). The
 * thing above has one colour, `a`: the median, over the columns read, of the rows from the scan's top down to
 * `3 · (DITHER_RADIUS + 1)` above the topmost top — clear of the edge's blend, an outline and a window, and by area, so
 * a line crossing it or a tilted band's outline in a few of its rows does not move it. From each top
 * the column is followed up, pixel by pixel, while a pixel is no nearer to `a` than to the nearest garment pixel (cloth
 * of any shade, and the ink lines on it, are); a climb that reaches the scan's top or a forearm does not see the top.
 * The band's top is the topmost cloth pixel on the path (within `GARMENT_DIFF` of a garment pixel), from where the climb
 * stopped down to the scan's three rows: an outline above it, or a line leaving the band upward, is ink, not garment;
 * a thin strip's cloth between its two lines is garment. A clean edge climbs
 * about the same rows in every column — the distance between two boundaries each found to a row — so only when the
 * climbs differ by more than `CLIMB_SPREAD` rows (90th less 10th percentile) do the columns take their topmost garment
 * row — and a column whose top was not seen is then not read, since its scan top is the lower level; otherwise the
 * tops stay exactly as read. Nothing is done when the colour above is the garment's (its median
 * within `GARMENT_DIFF`). Rewrites `tops` in place; returns how many moved.
 */
function toBandTop(f: Frame, tops: Pt[], g: RGB, top: number, colourAt: (x: number, y: number) => RGB | null): number {
  if (tops.length === 0) return 0;
  const lift = DITHER_RADIUS + 1;
  const ya = Math.min(...tops.map((p) => p[1])) - 3 * lift;
  if (ya < top) return 0;
  // The garment's colours, at most `MAX_CLOTH`: a paletted garment's few, as they are; a painted one's many, as the mean
  // colours of the `MAX_CLOTH` fullest cells of a `GARMENT_DIFF / 2` grid (first filled first among equals). The climb
  // compares each pixel against them all, so their number is bounded whatever the span.
  const exact = new Map<string, RGB>();
  const cells = new Map<string, { s: RGB; n: number }>();
  const step = GARMENT_DIFF / 2;
  for (const [x, y0] of tops) {
    for (let k = 0; k < 3; k++) {
      const y = y0 + lift + k;
      if (y < 0 || y >= f.h || f.masked(x, y)) continue;
      const p = f.rgb(x, y);
      if (exact.size <= MAX_CLOTH) exact.set(p.join(','), p);
      const key = p.map((v) => Math.floor(v / step)).join(',');
      const c = cells.get(key);
      if (c === undefined) cells.set(key, { s: [p[0], p[1], p[2]], n: 1 });
      else {
        c.s[0] += p[0];
        c.s[1] += p[1];
        c.s[2] += p[2];
        c.n++;
      }
    }
  }
  const cloth: RGB[] = exact.size <= MAX_CLOTH ? [...exact.values()] : [...cells.values()].sort((u, v) => v.n - u.n).slice(0, MAX_CLOTH).map((c) => [c.s[0] / c.n, c.s[1] / c.n, c.s[2] / c.n]);
  if (cloth.length === 0) return 0;
  // The colour above: the median of the region, channel by channel, read twice over it rather than held.
  const a = regionMedian((visit) => {
    for (const [x] of tops) {
      for (let y = top; y <= ya; y++) {
        const p = f.masked(x, y) ? null : colourAt(x, y);
        if (p !== null) visit(p);
      }
    }
  });
  if (a === null) return 0;
  if (diff(a, g) <= GARMENT_DIFF) return 0;
  const nearest = (p: RGB, cs: RGB[]) => Math.min(...cs.map((q) => diff(p, q)));
  const climbs = tops.map(([x, y0]) => {
    let y = y0;
    while (true) {
      if (y - 1 < top || f.masked(x, y - 1)) return null;
      const p = f.rgb(x, y - 1);
      if (diff(p, a) < nearest(p, cloth)) break;
      y--;
    }
    // The band's top: the topmost cloth pixel on the path, from where the climb stopped down to the scan's three rows.
    for (let v = y; v <= y0 + 2; v++) if (v < f.h && nearest(f.rgb(x, v), cloth) <= GARMENT_DIFF) return y0 - v;
    return null;
  });
  const ks = climbs.filter((k): k is number => k !== null).sort((p, q) => p - q);
  if (ks.length === 0) return 0;
  const rank = (q: number) => ks[Math.min(ks.length - 1, Math.max(0, Math.ceil(q * ks.length) - 1))]!;
  if (rank(0.9) - rank(0.1) <= CLIMB_SPREAD) return 0;
  let moved = 0;
  const read = tops.flatMap((t, i): Pt[] => {
    const k = climbs[i];
    if (k === null || k === undefined) return [];
    if (k !== 0) moved++;
    return [[t[0], t[1] - k]];
  });
  tops.splice(0, tops.length, ...read);
  return moved;
}

/**
 * The median, channel by channel, of the colours a region yields (`median`'s value: the middle one, or the mean of the
 * two middle ones), without holding them: a first pass counts each channel's values by whole step (0–255), which names
 * the step the middle rank falls in; a second keeps only the values in that step, as distinct values and counts. Memory
 * is the 256 counts and the distinct values of one step. Null for an empty region.
 */
function regionMedian(each: (visit: (p: RGB) => void) => void): RGB | null {
  const bin = (v: number) => Math.max(0, Math.min(255, Math.floor(v)));
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  let n = 0;
  each((p) => {
    n++;
    for (let k = 0; k < 3; k++) hist[k]![bin(p[k]!)]!++;
  });
  if (n === 0) return null;
  const m = n >> 1;
  const ranks = n % 2 === 1 ? [m] : [m - 1, m];
  // For each channel and rank: the step it falls in and its rank within the step.
  const want = [0, 1, 2].map((k) => ranks.map((r) => {
    let below = 0;
    for (let b = 0; b < 256; b++) {
      const c = hist[k]![b]!;
      if (r < below + c) return { b, r: r - below };
      below += c;
    }
    throw new Error('unreachable: a rank beyond the count');
  }));
  const kept = [0, 1, 2].map(() => new Map<number, Map<number, number>>());
  for (let k = 0; k < 3; k++) for (const w of want[k]!) kept[k]!.set(w.b, new Map());
  each((p) => {
    for (let k = 0; k < 3; k++) {
      const vs = kept[k]!.get(bin(p[k]!));
      if (vs !== undefined) vs.set(p[k]!, (vs.get(p[k]!) ?? 0) + 1);
    }
  });
  const at = (k: number, w: { b: number; r: number }) => {
    let below = 0;
    for (const [v, c] of [...kept[k]!.get(w.b)!.entries()].sort((u, z) => u[0] - z[0])) {
      if (w.r < below + c) return v;
      below += c;
    }
    throw new Error('unreachable: a rank beyond the step');
  };
  return [0, 1, 2].map((k) => {
    const vs = want[k]!.map((w) => at(k, w));
    return vs.length === 1 ? vs[0]! : (vs[0]! + vs[1]!) / 2;
  }) as RGB;
}

/**
 * rig-c/pose#318: the edge the waistband reader fitted is declined when it cuts across the band instead of running
 * along it — a fold's edge under a band the colour test passed over. Above the edge, in each column read, the colour
 * `DITHER_RADIUS + 1` rows up (past the outline and the window's blend) is followed up while it holds within
 * `GARMENT_DIFF`; where it stops is the band's top. When at least `MIN_COVER` of the columns read show such a band (not
 * the ground, not open up to the scan's top), its top is fitted as a line. The two lines bound a strip of thickness
 * `ta` and `tb` at the read columns' ends. A line inside a band of thickness t across a width W departs from the band's
 * direction by at most atan(t / W); an edge whose strip more than doubles across the hips (|ta − tb| > min(ta, tb)), or
 * crosses the band's top, cuts across the garment instead of running along the band.
 *
 * Null when the edge is the band's (or nothing above it is a band to hold it to).
 */
function notTheBand(f: Frame, fit: { m: number; q: number }, tops: Pt[], top: number, colourAt: (x: number, y: number) => RGB | null): Reading | null {
  const edgeAt = (x: number) => fit.m * x + fit.q;
  const bandTops: Pt[] = [];
  for (const [x, y] of tops) {
    const s = y - (DITHER_RADIUS + 1);
    if (s < top || f.masked(x, s)) continue;
    const c0 = colourAt(x, s);
    if (c0 === null || diff(c0, f.bg) <= FIGURE_DIFF) continue;
    let v = s;
    let closed = false;
    while (v - 1 >= top) {
      if (f.masked(x, v - 1)) break;
      const p = colourAt(x, v - 1);
      if (p === null) break;
      if (diff(p, c0) > GARMENT_DIFF) {
        closed = true;
        break;
      }
      v--;
    }
    if (closed) bandTops.push([x, v]);
  }
  if (bandTops.length < MIN_COVER * tops.length) return null;
  const band = fitLine(bandTops);
  if (band === null || band.rms > MAX_RMS) return null;
  const xa = Math.min(...tops.map((p) => p[0]));
  const xb = Math.max(...tops.map((p) => p[0]));
  const ta = edgeAt(xa) - (band.m * xa + band.q);
  const tb = edgeAt(xb) - (band.m * xb + band.q);
  if (Math.abs(ta - tb) <= Math.min(ta, tb)) return null;
  const deg = (m: number) => Math.atan(m) * (180 / Math.PI);
  const allow = Math.max(0, Math.min(ta, tb));
  return {
    kind: 'edge leaves the band',
    why: `the garment's edge fitted across the hips runs ${Math.abs(deg(fit.m) - deg(band.m)).toFixed(1)}° from the top of the band above it (${bandTops.length} of ${tops.length} columns; the band ${ta.toFixed(1)} px thick at x ${xa} and ${tb.toFixed(1)} px at x ${xb}); an edge inside a band ${allow.toFixed(1)} px thick at its thinnest departs from it by at most ${deg(allow / (xb - xa)).toFixed(1)}° across the ${xb - xa} px read, so this edge cuts across the garment (a fold), not along the band`,
  };
}

/**
 * rig-c/pose#342: the pelvis read below a cover. A garment hanging over the waistband (a sweater's hem) hides the band's top
 * and hangs level whatever the pelvis does, so the band-top reader reads the cover. What the cover cannot hide is read:
 *
 * - `hem`: the bottomwear's lower hem across the hip span — in each column, from the hips' row down, the last garment row
 *   before `LEAVE` rows that are not garment; a line fitted through them (≥ `MIN_COVER` of the columns);
 * - `roots`: where each thigh leaves the garment — along hip → knee (keypoints), the last garment point before `LEAVE` px
 *   that are not; the line from the right root to the left;
 * - `band`: the waistband reader's band top, used only when the ground lies above it (nothing covers it);
 * - `hips`: the keypoints' line, reported but not fitted — a detector's hips keep a fraction of a drawn tilt (#288).
 *
 * Every colour is the window mean (`DITHER_RADIUS`); a pixel is garment when it is nearest the garment's colour among the
 * garment's, each leg's (sampled `LEG_AT` along its thigh) and the ground's, so both shades of a cloth and the ink on it
 * are garment and skin or ground under the hem are not. The tilt is the mean of the cues fitted (hem, roots, an
 * uncovered band); fewer than two, or two that differ by more than `CUE_SPREAD`, decline the frame by name.
 */
function belowCover(f: Frame, c: Pt, span: number, x0: number, x1: number, cols: number, rHip: Pt, lHip: Pt, pt: (n: Body18) => Pt | null): { reading: Reading; detail: CueDetail | null } {
  const r = Math.max(2, 0.3 * span);
  const mean = meanOf(f);
  const disc = (at: Pt): RGB | null => {
    const ps: RGB[] = [];
    for (let y = Math.floor(at[1] - r); y <= Math.ceil(at[1] + r); y++) {
      for (let x = Math.floor(at[0] - r); x <= Math.ceil(at[0] + r); x++) {
        if (x < 0 || y < 0 || x >= f.w || y >= f.h || Math.hypot(x - at[0], y - at[1]) > r || f.masked(x, y)) continue;
        const p = mean(x, y);
        if (p !== null) ps.push(p);
      }
    }
    return ps.length === 0 ? null : ([0, 1, 2].map((k) => median(ps.map((p) => p[k]!))) as RGB);
  };
  const holds = (at: Pt, g: RGB) => {
    let n = 0;
    let k = 0;
    for (let y = Math.floor(at[1] - r); y <= Math.ceil(at[1] + r); y++) {
      for (let x = Math.floor(at[0] - r); x <= Math.ceil(at[0] + r); x++) {
        if (x < 0 || y < 0 || x >= f.w || y >= f.h || Math.hypot(x - at[0], y - at[1]) > r || f.masked(x, y)) continue;
        const p = mean(x, y);
        if (p === null) continue;
        n++;
        if (diff(p, g) <= GARMENT_DIFF) k++;
      }
    }
    return n > 0 && k >= HOLD * n;
  };
  const mid = disc(c);
  if (mid === null) return { reading: { kind: 'hips behind a forearm', why: 'the hips\' midpoint is covered by a forearm; no garment colour to read' }, detail: null };
  let g: RGB = mid;
  for (const drop of [0, r, 2 * r]) {
    const at: Pt = [c[0], c[1] + drop];
    const p = drop === 0 ? mid : disc(at);
    if (p !== null && diff(p, f.bg) > FIGURE_DIFF && holds(at, p)) {
      g = p;
      break;
    }
  }
  if (diff(g, f.bg) <= FIGURE_DIFF) return { reading: { kind: 'no garment over the hips', why: `the colour at the hips' midpoint (${g.map((v) => v.toFixed(0)).join(', ')}) is the background's (${f.bg.map((v) => v.toFixed(0)).join(', ')})` }, detail: null };
  const knee = { r: pt('r_knee'), l: pt('l_knee') };
  const hip = { r: rHip, l: lHip };
  const legs = { r: null as RGB | null, l: null as RGB | null };
  for (const s of ['r', 'l'] as const) {
    const k = knee[s];
    if (k === null) continue;
    const L = disc([hip[s][0] + LEG_AT * (k[0] - hip[s][0]), hip[s][1] + LEG_AT * (k[1] - hip[s][1])]);
    if (L !== null && diff(L, g) > GARMENT_DIFF) legs[s] = L;
  }
  const others = [f.bg, ...(legs.r !== null ? [legs.r] : []), ...(legs.l !== null ? [legs.l] : [])];
  if (others.length === 1) return { reading: { kind: 'no leg below the garment', why: `neither thigh carries a colour of its own ${LEG_AT} of the way to its knee (${knee.r === null || knee.l === null ? 'a knee has no position' : 'both within ' + GARMENT_DIFF + ' of the garment\'s'}); nothing below the garment to tell its hem by` }, detail: null };
  // Garment: nearest the garment's colour among it, the legs' and the ground's (a tie is garment). Null where every pixel of the window is masked.
  const isGarment = (x: number, y: number): boolean | null => {
    if (x < 0 || y < 0 || x >= f.w || y >= f.h || f.masked(x, y)) return null;
    const p = mean(x, y);
    if (p === null) return null;
    return diff(p, g) <= Math.min(...others.map((o) => diff(p, o)));
  };
  const why: CueDetail['why'] = {};
  // The hem.
  const hemPts: Pt[] = [];
  const yEnd = Math.min(f.h - 1, Math.floor(c[1] + 2.5 * span));
  for (let x = x0; x <= x1; x++) {
    let inside = false;
    let last = -1;
    let out = 0;
    for (let y = Math.max(0, Math.round(c[1])); y <= yEnd; y++) {
      const gm = isGarment(x, y);
      if (gm === null) {
        if (inside) break;
        continue;
      }
      if (gm) {
        inside = true;
        last = y;
        out = 0;
      } else if (inside && ++out >= LEAVE) {
        hemPts.push([x, last]);
        break;
      }
    }
  }
  const hemFit = hemPts.length >= MIN_COVER * cols ? fitLine(hemPts) : null;
  let hem: number | null = null;
  if (hemFit === null) why.hem = hemPts.length < MIN_COVER * cols ? `the hem is found in ${hemPts.length} of the ${cols} columns between the hips (< ${100 * MIN_COVER}%)` : 'the hem rows do not fit a line';
  else hem = tiltOf(hemFit.m, rHip, lHip);
  // The thigh roots.
  const root = { r: null as Pt | null, l: null as Pt | null };
  const rootWhy: string[] = [];
  const paths: Array<[Pt, Pt]> = [];
  for (const s of ['r', 'l'] as const) {
    const k = knee[s];
    if (k === null) {
      rootWhy.push(`${s}_knee has no position`);
      continue;
    }
    const h = hip[s];
    paths.push([h, k]);
    const len = Math.hypot(k[0] - h[0], k[1] - h[1]);
    const n = Math.ceil(len / 0.5);
    let inside = false;
    let last: Pt | null = null;
    let out = 0;
    let hidden = false;
    for (let i = 0; i <= n; i++) {
      const p: Pt = [h[0] + (i / n) * (k[0] - h[0]), h[1] + (i / n) * (k[1] - h[1])];
      const gm = isGarment(Math.round(p[0]), Math.round(p[1]));
      if (gm === null) {
        if (inside) {
          hidden = true;
          break;
        }
        continue;
      }
      if (gm) {
        inside = true;
        last = p;
        out = 0;
      } else if (inside && ++out * (len / n) >= LEAVE) {
        root[s] = last;
        break;
      }
    }
    if (root[s] === null) rootWhy.push(hidden ? `the ${s} thigh's root is behind a forearm` : inside ? `the ${s} thigh does not leave the garment before its knee` : `the ${s} thigh's path carries no garment`);
  }
  let roots: number | null = null;
  if (root.r !== null && root.l !== null) {
    if (Math.abs(root.l[0] - root.r[0]) < MIN_SPAN) rootWhy.push(`the roots are ${Math.abs(root.l[0] - root.r[0]).toFixed(1)} px apart across (< ${MIN_SPAN})`);
    else roots = pictureAngle(root.r, root.l);
  }
  if (roots === null) why.roots = rootWhy.join('; ');
  // The band's top, when nothing covers it.
  const edge: { fit?: { m: number; q: number } } = {};
  const wb = waistband(f, c, span, x0, x1, cols, rHip, lHip, edge);
  let band: number | 'covered' | null = null;
  if (!('tilt' in wb) || edge.fit === undefined) why.band = 'kind' in wb ? `${wb.kind}` : 'no edge';
  else {
    const above: RGB[] = [];
    for (let x = x0; x <= x1; x++) {
      const y = Math.round(edge.fit.m * x + edge.fit.q) - 3 * (DITHER_RADIUS + 1);
      if (y < 0 || y >= f.h || f.masked(x, y)) continue;
      const p = mean(x, y);
      if (p !== null) above.push(p);
    }
    const a = above.length === 0 ? null : ([0, 1, 2].map((k) => median(above.map((p) => p[k]!))) as RGB);
    if (a !== null && diff(a, f.bg) <= FIGURE_DIFF) band = wb.tilt;
    else {
      band = 'covered';
      why.band = a === null ? 'nothing seen above the band\'s top' : `the band's top is covered (${a.map((v) => v.toFixed(0)).join(', ')} lies ${3 * (DITHER_RADIUS + 1)} px above it, not the ground)`;
    }
  }
  const hips = pictureAngle(rHip, lHip);
  const tilts: CueTilts = { hem, roots, band, hips };
  const detail: CueDetail = { tilts, why, garment: g, legs, hem: { pts: hemPts, fit: hemFit === null ? null : { m: hemFit.m, q: hemFit.q, rms: hemFit.rms } }, roots: { ...root, paths }, band: typeof band === 'number' ? edge.fit! : null };
  const fitted: Array<[string, number]> = [];
  if (hem !== null) fitted.push(['hem', hem]);
  if (roots !== null) fitted.push(['roots', roots]);
  if (typeof band === 'number') fitted.push(['band', band]);
  const fmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}°`;
  if (fitted.length < 2) {
    const missing = (['hem', 'roots', 'band'] as const).filter((k) => why[k] !== undefined).map((k) => `${k}: ${why[k]}`);
    return { reading: { kind: 'too few cues below the cover', why: `${fitted.length} of the cues read (${fitted.map(([n, v]) => `${n} ${fmt(v)}`).join(', ') || 'none'}); ${missing.join('; ')}` }, detail };
  }
  const base = fitted[0]![1];
  const about = fitted.map(([, v]) => base + wrap(v - base));
  const spread = Math.max(...about) - Math.min(...about);
  if (spread > CUE_SPREAD) return { reading: { kind: 'cues disagree', why: `${fitted.map(([n, v]) => `${n} ${fmt(v)}`).join(', ')}: ${spread.toFixed(1)}° apart (> ${CUE_SPREAD}°); they do not read one line (hips ${fmt(hips)}, not fitted)` }, detail };
  const tilt = wrap(about.reduce((s, v) => s + v, 0) / about.length);
  return { reading: { tilt, cover: hemPts.length / cols, rms: hemFit?.rms ?? 0, mean: true, cues: tilts }, detail };
}

/**
 * `rig-pose-pelvis-keys/1`: `{ spec, keys: [{ frame, deg }], note? }` — frames of the
 * sequence, strictly increasing, within its span [0, frames − 1]; `deg` the tilt in
 * the track's sense (Spine degrees of r_hip → l_hip, about 0 for a figure facing
 * the camera). The tilt on every frame: linear between keys, the short way round,
 * held outside.
 *
 * A frame may be fractional (rig-c/pose#294): a scan interpolated from drawn keys
 * puts them between its frames (k × 4.75 for 8 keys over 38 frames), and a key
 * rounded onto the grid moves up to half a frame and bends the tilt between. A
 * fractional frame is a value of the same key, so the format stays /1; a reader
 * from before #294 refuses it by name (`"frame" is number 4.75; it must be a frame
 * index in [0, N]`) rather than misreading it. An integer frame interpolates
 * exactly as before.
 */
export function readPelvisKeys(text: string, where: string, frames: number): number[] {
  const doc = parseJson(text, where, 'PELVIS_KEYS');
  const p = new Problems();
  const shape = `{ "spec": "${PELVIS_KEYS_SPEC}", "keys": [{ "frame", "deg" }], "note"? }`;
  if (!isObject(doc)) {
    p.add('PELVIS_KEYS', `${where} is ${typeName(doc)}; it must be ${shape}`);
    p.throwIfAny();
    throw new Error('unreachable');
  }
  refuseUnknownKeys(p, 'PELVIS_KEYS', where, doc, ['spec', 'keys', 'note']);
  if (doc.spec !== PELVIS_KEYS_SPEC) p.add('PELVIS_KEYS', `${where} "spec" is ${typeName(doc.spec)}; it must be "${PELVIS_KEYS_SPEC}"`);
  if ('note' in doc && typeof doc.note !== 'string') p.add('PELVIS_KEYS', `${where} "note" is ${typeName(doc.note)}; it must be a string`);
  const keys: Array<{ frame: number; deg: number }> = [];
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) p.add('PELVIS_KEYS', `${where} "keys" is ${typeName(doc.keys)}; it must be a non-empty array of { frame, deg }`);
  else doc.keys.forEach((k: unknown, i: number) => {
    const kw = `${where} keys[${i}]`;
    if (!isObject(k)) {
      p.add('PELVIS_KEYS', `${kw} is ${typeName(k)}; a key is { frame, deg }`);
      return;
    }
    refuseUnknownKeys(p, 'PELVIS_KEYS', kw, k, ['frame', 'deg']);
    // rig-c/pose#294: any finite frame within the span, fractional or not; one outside it is refused naming the key and the span.
    const okF = typeof k.frame === 'number' && Number.isFinite(k.frame) && k.frame >= 0 && k.frame <= frames - 1;
    const okD = typeof k.deg === 'number' && Number.isFinite(k.deg) && k.deg > -180 && k.deg <= 180;
    if (!okF) p.add('PELVIS_KEYS', `${kw} "frame" is ${typeName(k.frame)}; it must be a frame index in [0, ${frames - 1}]`);
    if (!okD) p.add('PELVIS_KEYS', `${kw} "deg" is ${typeName(k.deg)}; it must be Spine degrees in (-180, 180] (r_hip → l_hip, counter-clockwise, y up)`);
    if (!okF || !okD) return;
    const prev = keys[keys.length - 1];
    if (prev !== undefined && (k.frame as number) <= prev.frame) p.add('PELVIS_KEYS', `${kw} "frame" is ${k.frame as number}, not after the key before it (${prev.frame}); frames strictly increase`);
    else keys.push({ frame: k.frame as number, deg: k.deg as number });
  });
  p.throwIfAny();
  return Array.from({ length: frames }, (_, i) => {
    const after = keys.findIndex((k) => k.frame >= i);
    if (after < 0) return keys[keys.length - 1]!.deg;
    const b = keys[after]!;
    if (b.frame === i || after === 0) return b.deg;
    const a = keys[after - 1]!;
    return wrap(a.deg + ((i - a.frame) / (b.frame - a.frame)) * wrap(b.deg - a.deg));
  });
}

export interface PelvisArgs {
  pose: string;
  out: string;
  frames?: string;
  mode: PelvisMode;
  keys?: string;
  person?: string;
}

/** Runs of one kind of decline, as the DECLINED lines group them: the first frame's reason, and whether the others' figures differ. */
function declinedRuns(readings: Reading[]): Array<{ from: number; to: number; kind: string; why: string; same: boolean }> {
  const out: Array<{ from: number; to: number; kind: string; why: string; same: boolean }> = [];
  readings.forEach((r, i) => {
    if (!('why' in r)) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.to === i - 1 && last.kind === r.kind) {
      last.to = i;
      last.same &&= last.why === r.why;
    } else out.push({ from: i, to: i, kind: r.kind, why: r.why, same: true });
  });
  return out;
}

/** How the waistband found its colour where it was not the midpoint's pixels as they are (rig-c/pose#293); empty when every frame read them. */
function viaNote(readings: Reading[]): string {
  const ok = readings.flatMap((r) => ('tilt' in r ? [r] : []));
  const mean = ok.filter((r) => r.mean === true).length;
  const below = ok.filter((r) => r.below !== undefined).length;
  const parts: string[] = [];
  if (mean > 0) parts.push(`${mean} through the ${2 * DITHER_RADIUS + 1}×${2 * DITHER_RADIUS + 1} window mean (the garment's colour does not hold pixel by pixel: a dithered or paletted picture)`);
  if (below > 0) parts.push(`${below} with the colour found below the hips (up to ${Math.max(...ok.map((r) => r.below ?? 0)).toFixed(1)} px; the hips on the band's edge)`);
  const raised = ok.filter((r) => r.raised !== undefined);
  if (raised.length > 0) parts.push(`${raised.length} with the band's top read above the colour's edge in some columns (up to ${Math.max(...raised.map((r) => r.raised ?? 0))} columns: a strip too thin to carry the colour, read as its top line)`);
  return parts.length === 0 ? '' : `; of the frames read, ${parts.join(', ')}`;
}

/** The sequence with the track: the one person, `pelvisTilt` on every frame, `pelvisSource`. */
export function withPelvis(seq: PoseSequence, person: string, tilt: ReadonlyArray<number | null>, source: PelvisSource): PoseSequence {
  return {
    ...seq,
    pelvisSource: source,
    frames: seq.frames.map((f, i) => ({ t: f.t, people: f.people.filter((q) => q.id === person), pelvisTilt: tilt[i] ?? null })),
  };
}

/** `rig-pose pelvis` end to end: read, refuse (all at once), read every frame, print, write. */
export function runPelvis(a: PelvisArgs, say: (l: string) => void): void {
  const seq = readPoseSequence(readFileSync(a.pose, 'utf8'), a.pose);
  const p = new Problems();
  if (seq.cleaned !== undefined) p.add('PELVIS_AFTER_CLEAN', `${a.pose} carries a "cleaned" record; rig-pose pelvis reads a sequence before clean, so that clean smooths the track it writes — run it on the sequence clean read`);
  const outDirs = planOutDirs([['--out', a.out]], p);
  if (seq.pelvisSource !== undefined) p.add('PELVIS_TRACK', `${a.pose} already carries a pelvis track (pelvisSource "${seq.pelvisSource}"); a sequence is read once — run rig-pose pelvis on the sequence without it`);
  p.throwIfAny();
  const track = personTrack(seq, a.person, a.pose);
  const person = a.person ?? [...new Set(seq.frames.flatMap((f) => f.people.map((q) => q.id)))].sort()[0]!;
  const n = seq.frames.length;
  const swingOf = (vs: number[]) => {
    if (vs.length === 0) return 0;
    const first = vs[0]!;
    const about = vs.map((v) => first + wrap(v - first));
    return Math.max(...about) - Math.min(...about);
  };
  if (a.keys !== undefined) {
    const tilt = readPelvisKeys(readFileSync(a.keys, 'utf8'), a.keys, n);
    say(`rig-pose pelvis: ${n} frame(s) of person "${person}" from ${a.pose}, from the hand keys in ${a.keys}`);
    say(`  PELVIS keys: linear between the keys (the short way round) and held outside them, on all ${n} frame(s); swing ${swingOf(tilt).toFixed(2)}° (Spine degrees, r_hip → l_hip)`);
    makeOutDirs(outDirs, say);
    writeFileSync(a.out, writePoseSequence(withPelvis(seq, person, tilt, 'keys')));
    say(`  wrote ${a.out} (pelvisSource "keys", rig-pose-sequence/1.1)`);
    return;
  }
  const dir = a.frames!;
  const files = readdirSync(dir).filter((f) => /\.png$/i.test(f) && statSync(join(dir, f)).isFile()).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  if (files.length !== n) p.add('PELVIS_FRAMES', `--frames ${dir} holds ${files.length} PNG file(s) and ${a.pose} ${n} frame(s); the frames are read one PNG per sequence frame, in file-name order`);
  p.throwIfAny();
  const readings: Reading[] = files.map((file, i) => {
    const path = join(dir, file);
    let plate: Plate;
    try {
      plate = readPlate(path);
    } catch (e) {
      p.add('PELVIS_FRAME', `${path} (frame ${i}): ${(e as Error).message}`);
      return { kind: 'unreadable', why: 'unreadable' };
    }
    if (plate.width !== seq.width || plate.height !== seq.height) {
      p.add('PELVIS_FRAME', `${path} (frame ${i}) is ${plate.width}×${plate.height} and the sequence's picture ${seq.width}×${seq.height}; the joints are in the frames' pixels`);
      return { kind: 'size', why: 'size' };
    }
    // A sequence with a camera carries joints normalised to frame 0's: back into this frame's pixels, p = s·p′ + t.
    const cam = seq.camera?.[i];
    const joints = cam === undefined ? track[i]! : Object.fromEntries(Object.entries(track[i]!).map(([k, j]) => [k, j.at === undefined ? j : { ...j, at: [cam.s * j.at[0] + cam.tx, cam.s * j.at[1] + cam.ty] }]));
    return readPelvis(plate, joints, a.mode);
  });
  p.throwIfAny();
  const tilt = readings.map((r) => ('tilt' in r ? r.tilt : null));
  const read = tilt.filter((v): v is number => v !== null);
  say(`rig-pose pelvis: ${n} frame(s) of person "${person}" from ${a.pose}, read by ${a.mode} off ${dir} (${files.length} PNG)`);
  if (a.mode === 'below-cover') {
    // rig-c/pose#342: every frame's cues, read or not, so a decline or a reading can be checked cue by cue.
    const fmt = (v: number | 'covered' | null) => (v === null ? 'not read' : v === 'covered' ? 'covered' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}°`);
    readings.forEach((r, i) => {
      if (!('tilt' in r) || r.cues === undefined) return;
      // The hips stay out of the vote; their sign is printed beside the fit, and an opposite sign is warned.
      const sign = (v: number) => (Math.abs(v) < 0.5 ? '0' : v > 0 ? '+' : '−');
      say(`  CUES frame ${i}: hem ${fmt(r.cues.hem)}, roots ${fmt(r.cues.roots)}, band ${fmt(r.cues.band)}, hips ${fmt(r.cues.hips)} (not fitted) → ${fmt(r.tilt)}; hips sign ${sign(r.cues.hips)}, fit sign ${sign(r.tilt)}`);
      if (sign(r.cues.hips) !== '0' && sign(r.tilt) !== '0' && sign(r.cues.hips) !== sign(r.tilt)) say(`  HIPS-SIGN frame ${i}: the hip keypoints tilt ${fmt(r.cues.hips)}, opposite the fit's ${fmt(r.tilt)} (the hips are not fitted)`);
    });
  }
  for (const d of declinedRuns(readings)) say(`  DECLINED frame${d.from === d.to ? ` ${d.from}` : `s ${d.from}–${d.to}`} (${d.to - d.from + 1}): ${d.kind} — ${d.same ? d.why : `frame ${d.from}: ${d.why}; the figures differ frame to frame`}`);
  if (read.length > 0) {
    const covers = readings.flatMap((r) => ('tilt' in r ? [r.cover] : []));
    const rms = readings.flatMap((r) => ('tilt' in r ? [r.rms] : []));
    say(`  PELVIS ${a.mode} read ${read.length} of ${n} frame(s), ${n - read.length} declined (null: marked, not guessed); swing ${swingOf(read).toFixed(2)}° over the frames read (Spine degrees, r_hip → l_hip); cover ${(100 * Math.min(...covers)).toFixed(0)}–${(100 * Math.max(...covers)).toFixed(0)}% of the hip span, fit within ${Math.max(...rms).toFixed(2)} px${viaNote(readings)}`);
  } else {
    say(`  PELVIS ${a.mode} read none of the ${n} frame(s) (every frame null: marked, not guessed); retarget keys the hip line and its PELVIS line says so`);
  }
  makeOutDirs(outDirs, say);
  writeFileSync(a.out, writePoseSequence(withPelvis(seq, person, tilt, a.mode)));
  say(`  wrote ${a.out} (pelvisSource "${a.mode}", rig-pose-sequence/1.1)`);
}
