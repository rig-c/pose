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
 *   in a row carry it; the line fitted through those tops.
 *
 * The forearms are not read: pixels near the segments elbow → wrist (and the
 * hands) are masked, since a hanging arm passes the hips in a walk. A frame
 * either reader cannot read is declined with its reason and its tilt is null —
 * marked, not guessed; `retarget` keys the hip line there and says so.
 *
 * `--pelvis-keys` is the hand override, `rig-pose-pelvis-keys/1`: tilts at
 * frames, linear between them (the short way round) and held outside them.
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
export const PELVIS_MODES = ['silhouette', 'waistband'] as const;
export type PelvisMode = (typeof PELVIS_MODES)[number];
export const PELVIS_KEYS_SPEC = 'rig-pose-pelvis-keys/1';

/** A pixel is the figure's when a channel differs from the background colour's by more than this (0–255). */
export const FIGURE_DIFF = 64;
/** A pixel carries the garment's colour when no channel differs from it by more than this. */
export const GARMENT_DIFF = 40;
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

/** One frame's reading: the tilt (Spine degrees, r_hip → l_hip), or why it was declined. */
export type Reading = { tilt: number; cover: number; rms: number } | { kind: string; why: string };

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
  return mode === 'silhouette' ? silhouette(f, c, span, x0, x1, cols, rHip, lHip) : waistband(f, c, span, x0, x1, cols, rHip, lHip);
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

function waistband(f: Frame, c: Pt, span: number, x0: number, x1: number, cols: number, rHip: Pt, lHip: Pt): Reading {
  // The garment's colour: the median over the unmasked pixels near the hips' midpoint.
  const r = Math.max(2, 0.3 * span);
  const patch: RGB[] = [];
  for (let y = Math.floor(c[1] - r); y <= Math.ceil(c[1] + r); y++) {
    for (let x = Math.floor(c[0] - r); x <= Math.ceil(c[0] + r); x++) {
      if (x < 0 || y < 0 || x >= f.w || y >= f.h || Math.hypot(x - c[0], y - c[1]) > r || f.masked(x, y)) continue;
      patch.push(f.rgb(x, y));
    }
  }
  if (patch.length === 0) return { kind: 'hips behind a forearm', why: 'the hips\' midpoint is covered by a forearm; no garment colour to read' };
  const g: RGB = [0, 1, 2].map((k) => median(patch.map((p) => p[k]!))) as RGB;
  if (diff(g, f.bg) <= FIGURE_DIFF) return { kind: 'no garment over the hips', why: `the colour at the hips' midpoint (${g.map((v) => v.toFixed(0)).join(', ')}) is the background's (${f.bg.map((v) => v.toFixed(0)).join(', ')})` };
  const top = Math.max(0, Math.floor(c[1] - 1.5 * span));
  const bottom = Math.floor(c[1]);
  const garment = (x: number, y: number) => y < f.h && diff(f.rgb(x, y), g) <= GARMENT_DIFF;
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
  const share = tops.length / cols;
  if (share < MIN_COVER) {
    return above > cols / 2 ? { kind: 'garment above the band', why: `the garment runs above the band read (${above} of ${cols} columns carry its colour ${(1.5 * span).toFixed(0)} px above the hips); no waistband edge` } : { kind: 'waistband edge too short', why: `the garment's top edge is found in ${tops.length} of the ${cols} columns between the hips (${(100 * share).toFixed(0)}% < ${100 * MIN_COVER}%)` };
  }
  const fit = fitLine(tops);
  if (fit === null) return { kind: 'no line', why: 'the garment\'s top edge does not fit a line (fewer than three columns)' };
  if (fit.rms > MAX_RMS) return { kind: 'not a straight waistband', why: `the garment's top edge lies ${fit.rms.toFixed(2)} px from its line (root mean square > ${MAX_RMS}); not a straight waistband` };
  if (Math.abs(Math.atan(fit.m)) * (180 / Math.PI) > 45) return { kind: 'waistband too steep', why: `the garment's top edge runs ${(Math.atan(fit.m) * (180 / Math.PI)).toFixed(1)}° from level; a waistband is within 45°` };
  return { tilt: tiltOf(fit.m, rHip, lHip), cover: share, rms: fit.rms };
}

/**
 * `rig-pose-pelvis-keys/1`: `{ spec, keys: [{ frame, deg }], note? }` — frames of the
 * sequence, integers strictly increasing; `deg` the tilt in the track's sense
 * (Spine degrees of r_hip → l_hip, about 0 for a figure facing the camera). The
 * tilt on every frame: linear between keys, the short way round, held outside.
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
    const okF = Number.isInteger(k.frame) && (k.frame as number) >= 0 && (k.frame as number) < frames;
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
  for (const d of declinedRuns(readings)) say(`  DECLINED frame${d.from === d.to ? ` ${d.from}` : `s ${d.from}–${d.to}`} (${d.to - d.from + 1}): ${d.kind} — ${d.same ? d.why : `frame ${d.from}: ${d.why}; the figures differ frame to frame`}`);
  if (read.length > 0) {
    const covers = readings.flatMap((r) => ('tilt' in r ? [r.cover] : []));
    const rms = readings.flatMap((r) => ('tilt' in r ? [r.rms] : []));
    say(`  PELVIS ${a.mode} read ${read.length} of ${n} frame(s), ${n - read.length} declined (null: marked, not guessed); swing ${swingOf(read).toFixed(2)}° over the frames read (Spine degrees, r_hip → l_hip); cover ${(100 * Math.min(...covers)).toFixed(0)}–${(100 * Math.max(...covers)).toFixed(0)}% of the hip span, fit within ${Math.max(...rms).toFixed(2)} px`);
  } else {
    say(`  PELVIS ${a.mode} read none of the ${n} frame(s) (every frame null: marked, not guessed); retarget keys the hip line and its PELVIS line says so`);
  }
  makeOutDirs(outDirs, say);
  writeFileSync(a.out, writePoseSequence(withPelvis(seq, person, tilt, a.mode)));
  say(`  wrote ${a.out} (pelvisSource "${a.mode}", rig-pose-sequence/1.1)`);
}
