/**
 * `rig-pose cloth` (rig-c/pose#34): measure a cloth track (`rig-c-cloth-track/0`)
 * from a built rig's posed skirt slots (Mode 1, `--rig`) or from isolated skirt
 * PNG frames beside a pose sequence (Mode 2, `--frames` + `--pose`), normalised
 * by the subject's own median hip width (`W_hip`), origin at its median mid-hip,
 * x right, y down.
 *
 * The per-window figures (lag, swing ratio, overshoot) reuse `compare.ts`'s
 * `clothFigures` (`gaussSmooth`, `gradient`, `xcorrLag`, `reversals`) so the
 * instrument and the grader run one implementation.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  physicsClockStep,
  poseRawAnimationEach,
  poseRawSetup,
  readModel,
  type CompiledDocument,
  type RawPose,
} from '@rig-c/core/core';
import { readPlate, type Plate } from '@rig-c/core/plate';
import { BARS, CLOTH, CLOTH_SPEC, clothFigures, median, readCloth, type ClothFigures, type ClothWindow } from './compare.ts';
import { pointAt, readMap, resolveMap, type JointMap } from './map.ts';
import { makeOutDirs, planOutDirs } from './outdir.ts';
import { personTrack, readPoseSequence, type PoseSequence } from './pose.ts';
import { isObject, parseJson, Problems, Refusal } from './problems.ts';
import { hipOf, holdLine, wrap, type Hold } from './retarget.ts';
import { attachmentBones, baseMotionOf, gate, readBuild, resolveRig, restOf, slotsOf } from './rigc.ts';

type CorePhysicsRecord = Extract<NonNullable<CompiledDocument['constraints'][number]['record']>, { kind: 'physics' }>;
type CorePhysicsTimeline = NonNullable<CompiledDocument['animations'][number]['constraints']['physicsKeyed']>[number];

const DEG = 180 / Math.PI;

export interface ClothFrameRow {
  i: number;
  t: number;
  hip_x: number;
  hip_y: number;
  hip_w: number;
  tilt_deg: number;
  hem_mid: number;
  hem_l: number;
  hem_r: number;
  hem_l_y: number;
  hem_r_y: number;
  hem_band_cx: number;
  skirt_cx: number;
  skirt_top: number;
  skirt_bottom: number;
}

export interface ClothSwingWindow {
  name: string;
  t: [number, number];
  frames: [number, number];
  stroke: number;
  lag: number;
  xcorrPeak: number;
  swingRatio: number | null;
  overshoot: number | null;
  strokes: number;
}

export interface ClothTrackDocument {
  spec: typeof CLOTH_SPEC;
  subject: string;
  method: string;
  source: string;
  fps: number;
  frames_count: number;
  units: 'hip-widths';
  hipWidth: { median: number; unit: 'picture px' | 'rig world units' };
  origin: [number, number];
  axes: { x: 'right'; y: 'down' };
  skirtSwing?: Record<string, { t: [number, number]; frames: [number, number]; stroke: number; lag: number; xcorrPeak: number; swingRatio: number | null; overshoot: number | null; strokes: number }>;
  frames: ClothFrameRow[];
}

export interface RigClothArgs {
  kind: 'rig';
  rig: string;
  map: string;
  skirtSlots: string[];
  animation: string;
  fps: number;
  windows?: ClothWindow[];
  out: string;
}

export interface FramesClothArgs {
  kind: 'frames';
  frames: string;
  pose: string;
  person?: string;
  alphaMin: number;
  windows?: ClothWindow[];
  out: string;
}

export type ClothArgs = RigClothArgs | FramesClothArgs;

interface RawFrame {
  i: number;
  t: number;
  hipX: number;
  hipY: number;
  hipW: number;
  tiltDeg: number;
  hemL: number;
  hemR: number;
  hemLY: number;
  hemRY: number;
  hemBandCx: number;
  skirtCx: number;
  skirtTop: number;
  skirtBottom: number;
}

type Pt = [number, number];

export interface ClothPlant {
  /** `'upper'` plants the upper-half skirt band (`y <= y_mid`) in place of the lower half (`y >= y_mid`). */
  half?: 'lower' | 'upper';
  /** `-1` plants the sign-flipped cross-correlation (`Y[i - L]`) in `xcorrLag`. */
  lagSign?: 1 | -1;
  /** Custom physics clock step (`dt => dt` plants the unshifted frame clock in place of `physicsClockStep`). */
  clock?: (dt: number) => number;
}

/** Clip triangle `(a, b, c)` (already in y-down coordinates) to the half-plane `y >= yMid` (`half = 'lower'`) or `y <= yMid` (`half = 'upper'`). */
function clipTriBand(a: Pt, b: Pt, c: Pt, yMid: number, half: 'lower' | 'upper' = 'lower'): Pt[] {
  const pts: Pt[] = [a, b, c];
  const out: Pt[] = [];
  const inside = (y: number) => (half === 'lower' ? y >= yMid : y <= yMid);
  for (let k = 0; k < 3; k++) {
    const p = pts[k]!;
    const q = pts[(k + 1) % 3]!;
    const pIn = inside(p[1]);
    const qIn = inside(q[1]);
    if (pIn && qIn) {
      out.push(q);
    } else if (pIn && !qIn) {
      const dy = q[1] - p[1];
      const u = dy === 0 ? 0 : (yMid - p[1]) / dy;
      out.push([p[0] + u * (q[0] - p[0]), yMid]);
    } else if (!pIn && qIn) {
      const dy = q[1] - p[1];
      const u = dy === 0 ? 0 : (yMid - p[1]) / dy;
      out.push([p[0] + u * (q[0] - p[0]), yMid], q);
    }
  }
  return out;
}

/** Twice the unsigned area and the area-weighted x sum of a triangle `(a, b, c)`. */
function triMomentX(a: Pt, b: Pt, c: Pt): { area2: number; mx2: number } {
  const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
  return { area2, mx2: area2 * ((a[0] + b[0] + c[0]) / 3) };
}

/**
 * Measure the skirt envelope and centroids from posed triangles in y-down world coordinates.
 * Each triangle is `[p0, p1, p2]`.
 */
export function measureSkirtTriangles(
  triangles: ReadonlyArray<readonly [Pt, Pt, Pt]>,
  vertices: ReadonlyArray<Pt>,
  half: 'lower' | 'upper' = 'lower',
): { skirtTop: number; skirtBottom: number; skirtCx: number; hemL: number; hemR: number; hemLY: number; hemRY: number; hemBandCx: number } | null {
  if (vertices.length === 0) return null;
  let skirtTop = Infinity;
  let skirtBottom = -Infinity;
  for (const [, y] of vertices) {
    if (y < skirtTop) skirtTop = y;
    if (y > skirtBottom) skirtBottom = y;
  }
  const yMid = 0.5 * (skirtTop + skirtBottom);
  let totalArea2 = 0;
  let totalMx2 = 0;
  let bandArea2 = 0;
  let bandMx2 = 0;
  const bandPts: Pt[] = [];
  for (const p of vertices) if (half === 'lower' ? p[1] >= yMid : p[1] <= yMid) bandPts.push(p);
  for (const [a, b, c] of triangles) {
    const m = triMomentX(a, b, c);
    totalArea2 += m.area2;
    totalMx2 += m.mx2;
    const clipped = clipTriBand(a, b, c, yMid, half);
    for (const p of clipped) bandPts.push(p);
    for (let k = 1; k + 1 < clipped.length; k++) {
      const bm = triMomentX(clipped[0]!, clipped[k]!, clipped[k + 1]!);
      bandArea2 += bm.area2;
      bandMx2 += bm.mx2;
    }
  }
  const pts = bandPts.length > 0 ? bandPts : vertices;
  let hemL = Infinity;
  let hemR = -Infinity;
  let hemLY = yMid;
  let hemRY = yMid;
  for (const [x, y] of pts) {
    if (x < hemL || (x === hemL && y > hemLY)) {
      hemL = x;
      hemLY = y;
    }
    if (x > hemR || (x === hemR && y > hemRY)) {
      hemR = x;
      hemRY = y;
    }
  }
  const skirtCx = totalArea2 > 1e-12 ? totalMx2 / totalArea2 : vertices.reduce((s, p) => s + p[0], 0) / vertices.length;
  const hemBandCx = bandArea2 > 1e-12 ? bandMx2 / bandArea2 : 0.5 * (hemL + hemR);
  return { skirtTop, skirtBottom, skirtCx, hemL, hemR, hemLY, hemRY, hemBandCx };
}

/**
 * Measure the skirt envelope and centroids from a raster PNG plate (`alpha >= alphaMin`, y down).
 * On an opaque uniform background (where the border's median alpha is `>= alphaMin`, such as `rigc render --slot`'s
 * `[232, 232, 232, 255]`), `alphaMin` also serves as the RGB colour-distance threshold against the border median.
 */
export function measureSkirtPlate(
  plate: Plate,
  alphaMin: number,
  half: 'lower' | 'upper' = 'lower',
): { skirtTop: number; skirtBottom: number; skirtCx: number; hemL: number; hemR: number; hemLY: number; hemRY: number; hemBandCx: number } | null {
  const { width, height, data } = plate;
  // Detect whether the plate has a transparent background or an opaque uniform background (such as `rigc render --slot`'s [232, 232, 232, 255]):
  const borderAlphas: number[] = [];
  const borderR: number[] = [];
  const borderG: number[] = [];
  const borderB: number[] = [];
  const pushBorder = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    borderR.push(data[idx]!);
    borderG.push(data[idx + 1]!);
    borderB.push(data[idx + 2]!);
    borderAlphas.push(data[idx + 3]!);
  };
  for (let x = 0; x < width; x++) {
    pushBorder(x, 0);
    if (height > 1) pushBorder(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    pushBorder(0, y);
    if (width > 1) pushBorder(width - 1, y);
  }
  const opaqueBg = borderAlphas.length > 0 && median(borderAlphas) >= alphaMin;
  const bgR = opaqueBg ? median(borderR) : 0;
  const bgG = opaqueBg ? median(borderG) : 0;
  const bgB = opaqueBg ? median(borderB) : 0;
  const pixelWeight = (x: number, y: number): number => {
    const idx = (y * width + x) * 4;
    const a = data[idx + 3]!;
    if (a < alphaMin) return 0;
    if (!opaqueBg) return a;
    const diff = Math.max(Math.abs(data[idx]! - bgR), Math.abs(data[idx + 1]! - bgG), Math.abs(data[idx + 2]! - bgB));
    return diff >= alphaMin ? a : 0;
  };

  let skirtTop = Infinity;
  let skirtBottom = -Infinity;
  let totalWeight = 0;
  let totalWx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = pixelWeight(x, y);
      if (w === 0) continue;
      if (y < skirtTop) skirtTop = y;
      if (y > skirtBottom) skirtBottom = y;
      totalWeight += w;
      totalWx += w * x;
    }
  }
  if (totalWeight === 0) return null;
  const yMid = skirtTop + 0.5 * (skirtBottom - skirtTop);
  const yStart = half === 'lower' ? Math.max(0, Math.ceil(yMid - 1e-9)) : skirtTop;
  const yEnd = half === 'lower' ? skirtBottom : Math.min(height - 1, Math.floor(yMid + 1e-9));
  let hemL = Infinity;
  let hemR = -Infinity;
  let hemLY = yStart;
  let hemRY = yStart;
  let bandWeight = 0;
  let bandWx = 0;
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = 0; x < width; x++) {
      const w = pixelWeight(x, y);
      if (w === 0) continue;
      bandWeight += w;
      bandWx += w * x;
      if (x < hemL || (x === hemL && y > hemLY)) {
        hemL = x;
        hemLY = y;
      }
      if (x > hemR || (x === hemR && y > hemRY)) {
        hemR = x;
        hemRY = y;
      }
    }
  }
  const skirtCx = totalWx / totalWeight;
  const hemBandCx = bandWeight > 0 ? bandWx / bandWeight : 0.5 * (hemL + hemR);
  return { skirtTop, skirtBottom, skirtCx, hemL, hemR, hemLY, hemRY, hemBandCx };
}

/** Normalise raw per-frame readings by the median hip width `W_hip` and median mid-hip `(originX, originY)`, and compute window summaries. */
export function buildClothTrack(
  rawFrames: readonly RawFrame[],
  meta: { subject: string; method: string; source: string; fps: number; unit: 'picture px' | 'rig world units' },
  windows: readonly ClothWindow[] | undefined,
  p: Problems,
  plant?: ClothPlant,
): { doc: ClothTrackDocument; windows: ClothSwingWindow[] } {
  const widths = rawFrames.map((f) => f.hipW).filter((w) => Number.isFinite(w) && w > 0);
  if (widths.length === 0) {
    p.add('CLOTH_HIP', `${meta.source} has no positive hip width across ${rawFrames.length} frame(s)`);
    p.throwIfAny();
  }
  const hipWidth = median(widths);
  const originX = median(rawFrames.map((f) => f.hipX));
  const originY = median(rawFrames.map((f) => f.hipY));
  const normX = (x: number) => (x - originX) / hipWidth;
  const normY = (y: number) => (y - originY) / hipWidth;

  const frames: ClothFrameRow[] = rawFrames.map((f) => {
    const hemL = normX(f.hemL);
    const hemR = normX(f.hemR);
    return {
      i: f.i,
      t: Number(f.t.toFixed(5)),
      hip_x: Number(normX(f.hipX).toFixed(5)),
      hip_y: Number(normY(f.hipY).toFixed(5)),
      hip_w: Number((f.hipW / hipWidth).toFixed(5)),
      tilt_deg: Number(f.tiltDeg.toFixed(5)),
      hem_mid: Number((0.5 * (hemL + hemR)).toFixed(5)),
      hem_l: Number(hemL.toFixed(5)),
      hem_r: Number(hemR.toFixed(5)),
      hem_l_y: Number(normY(f.hemLY).toFixed(5)),
      hem_r_y: Number(normY(f.hemRY).toFixed(5)),
      hem_band_cx: Number(normX(f.hemBandCx).toFixed(5)),
      skirt_cx: Number(normX(f.skirtCx).toFixed(5)),
      skirt_top: Number(normY(f.skirtTop).toFixed(5)),
      skirt_bottom: Number(normY(f.skirtBottom).toFixed(5)),
    };
  });

  const n = frames.length;
  const times = frames.map((f) => f.t);
  const dts = times.slice(1).map((t, i) => t - times[i]!);
  const fpsEff = dts.length === 0 ? meta.fps : 1 / median(dts);
  const frameOf = (t: number) => Math.min(n, Math.max(0, Math.round((t - (times[0] ?? 0)) * fpsEff)));
  const swingWindows: ClothSwingWindow[] = [];

  if (windows !== undefined && windows.length > 0) {
    for (const w of windows) {
      const f0 = frameOf(w.from);
      const f1 = frameOf(w.to);
      if (f1 - f0 <= CLOTH.lagTo) {
        p.add('CLOTH_WINDOW', `window ${w.name} (${w.from}–${w.to} s) is frames ${f0}–${f1 - 1} of the ${n} measured, ${Math.max(0, f1 - f0)} frame(s); the lag search reaches ${CLOTH.lagTo} frames, so a window needs more than ${CLOTH.lagTo}`);
      }
    }
    p.throwIfAny();
    const hipSeries = frames.map((f) => f.hip_x);
    const hemSeries = frames.map((f) => f.hem_mid);
    for (const w of windows) {
      const f0 = frameOf(w.from);
      const f1 = frameOf(w.to);
      const fig: ClothFigures = clothFigures(hipSeries, hemSeries, f0, f1, CLOTH.stroke, plant?.lagSign ?? 1);
      swingWindows.push({
        name: w.name,
        t: [w.from, w.to],
        frames: [f0, f1 - 1],
        stroke: CLOTH.stroke,
        lag: fig.lag,
        xcorrPeak: fig.xcorrPeak,
        swingRatio: fig.swingRatio,
        overshoot: fig.overshoot,
        strokes: fig.strokes,
      });
    }
  }

  const skirtSwing = swingWindows.length === 0
    ? undefined
    : Object.fromEntries(
        swingWindows.map((w) => [
          w.name,
          {
            t: w.t,
            frames: w.frames,
            stroke: w.stroke,
            lag: w.lag,
            xcorrPeak: w.xcorrPeak,
            swingRatio: w.swingRatio,
            overshoot: w.overshoot,
            strokes: w.strokes,
          },
        ]),
      );

  const doc: ClothTrackDocument = {
    spec: CLOTH_SPEC,
    subject: meta.subject,
    method: meta.method,
    source: meta.source,
    fps: meta.fps,
    frames_count: frames.length,
    units: 'hip-widths',
    hipWidth: { median: hipWidth, unit: meta.unit },
    origin: [originX, originY],
    axes: { x: 'right', y: 'down' },
    ...(skirtSwing === undefined ? {} : { skirtSwing }),
    frames,
  };
  return { doc, windows: swingWindows };
}

/** Write `rig-c-cloth-track/0` JSON, numbers rounded once to 5 decimals at the writer (matching `docs/REFERENCE.md`). */
export function writeClothTrack(doc: ClothTrackDocument): string {
  const r = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(5)) : null);
  return `${JSON.stringify(doc, (_k, v: unknown) => (typeof v === 'number' ? r(v) : v), 2)}\n`;
}

/** Load a compiled `CompiledDocument` from `--rig`: a `.model.json`, a build directory holding `skeleton.model.json`, or a `rig.json` / directory built in a scratch directory. */
function loadCompiledRig(rigPath: string, p: Problems): { doc: CompiledDocument; cleanup: (() => void) | null } {
  const resolved = resolve(rigPath);
  if (!existsSync(resolved)) {
    p.add('ARG_PATH', `--rig ${rigPath} does not exist`);
    p.throwIfAny();
  }
  const st = statSync(resolved);
  if (st.isFile() && resolved.endsWith('.model.json')) {
    return { doc: readModel(readFileSync(resolved, 'utf8'), resolved), cleanup: null };
  }
  if (st.isDirectory() && existsSync(join(resolved, 'skeleton.model.json')) && !existsSync(join(resolved, 'rig.json'))) {
    return { doc: readBuild(resolved), cleanup: null };
  }
  const input = resolveRig(rigPath, undefined);
  const motion = baseMotionOf(input);
  const scratch = mkdtempSync(join(tmpdir(), 'rig-pose-cloth-'));
  const g = gate(input.rig, motion, scratch, 'spine');
  if (!g.green) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Refusal([{ code: 'RIG_GATE_BASE', text: `rigc build refused ${rigPath}: ${g.fails.join('; ') || g.run.out.trim()}` }]);
  }
  return { doc: readBuild(g.build), cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

/** Pose one frame's skirt slots into y-down triangles and vertices. */
function poseSkirtFrame(pose: RawPose, slotSet: ReadonlySet<string>): { triangles: Array<[Pt, Pt, Pt]>; vertices: Pt[] } {
  const triangles: Array<[Pt, Pt, Pt]> = [];
  const vertices: Pt[] = [];
  for (const d of pose.drawn) {
    if (!slotSet.has(d.slot)) continue;
    const pts: Pt[] = [];
    for (let k = 0; k + 1 < d.vertices.length; k += 2) {
      const pt: Pt = [d.vertices[k]!, -d.vertices[k + 1]!];
      pts.push(pt);
      vertices.push(pt);
    }
    for (let k = 0; k + 2 < d.triangles.length; k += 3) {
      const a = pts[d.triangles[k]!];
      const b = pts[d.triangles[k + 1]!];
      const c = pts[d.triangles[k + 2]!];
      if (a !== undefined && b !== undefined && c !== undefined) triangles.push([a, b, c]);
    }
  }
  return { triangles, vertices };
}

/** Measure a cloth track from a compiled rig or rig directory (Mode 1). */
export function measureRigCloth(
  doc: CompiledDocument,
  map: JointMap,
  mapWhere: string,
  opts: { rigWhere: string; animation: string; skirtSlots: readonly string[]; fps: number; windows?: readonly ClothWindow[]; plant?: ClothPlant },
): { doc: ClothTrackDocument; windows: ClothSwingWindow[] } {
  const p = new Problems();
  const rest = restOf(doc);
  const slots = slotsOf(doc);
  resolveMap(map, rest, mapWhere, slots);

  const hips = hipOf(map);
  if ('problem' in hips) {
    p.add('CLOTH_HIP', `${mapWhere}: ${hips.problem}`);
  }
  const declaredSlots = doc.slots.map((s) => s.name);
  const missingSlots = opts.skirtSlots.filter((s) => !declaredSlots.includes(s));
  if (missingSlots.length > 0) {
    p.add('CLOTH_SLOT', `--skirt-slots names ${missingSlots.map((s) => `"${s}"`).join(', ')}, which ${opts.rigWhere} does not have; its slots are ${declaredSlots.length === 0 ? 'none' : declaredSlots.join(', ')}`);
  }
  const anim = doc.animations.find((a) => a.name === opts.animation);
  if (anim === undefined) {
    const names = doc.animations.map((a) => a.name);
    p.add('CLOTH_ANIMATION', `${opts.rigWhere} has no animation "${opts.animation}"; its animations are ${names.length === 0 ? 'none' : names.join(', ')}`);
  } else if (!(anim.timelines.duration > 0)) {
    p.add('CLOTH_ANIMATION', `animation "${opts.animation}" in ${opts.rigWhere} has duration ${anim.timelines.duration} s; a cloth track needs a non-zero duration`);
  }
  p.throwIfAny();

  const duration = anim!.timelines.duration;
  const stepCount = Math.max(1, Math.round(duration * opts.fps));
  const dt = 1 / opts.fps;
  const steps = Array.from({ length: stepCount }, () => dt);
  const poses: RawPose[] = [];
  poseRawAnimationEach(doc, opts.animation, steps, {}, 'animation', (pose) => poses.push(pose), opts.plant?.clock ?? physicsClockStep);
  const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
  const slotSet = new Set(opts.skirtSlots);
  const [rSpec, lSpec] = (hips as { joints: [string, string]; points: [string, string] }).joints[0] === 'r_hip'
    ? (hips as { points: [string, string] }).points
    : [(hips as { points: [string, string] }).points[1], (hips as { points: [string, string] }).points[0]];

  const rawFrames: RawFrame[] = [];
  poses.forEach((pose, i) => {
    const t = i / opts.fps;
    const bones = new Map(pose.bones.map((b) => [b.name, b]));
    const pr = pointAt(bones, lengths, rSpec);
    const pl = pointAt(bones, lengths, lSpec);
    if (pr === null || pl === null) {
      p.add('CLOTH_HIP', `frame ${i} (t=${t.toFixed(3)}s): hip point ${pr === null ? `"${rSpec}"` : `"${lSpec}"`} could not be posed`);
      return;
    }
    // Convert Spine y-up world coordinates to y-down.
    const rHip: Pt = [pr[0], -pr[1]];
    const lHip: Pt = [pl[0], -pl[1]];
    const hipX = 0.5 * (rHip[0] + lHip[0]);
    const hipY = 0.5 * (rHip[1] + lHip[1]);
    const hipW = Math.hypot(lHip[0] - rHip[0], lHip[1] - rHip[1]);
    const tiltDeg = wrap(Math.atan2(-(lHip[1] - rHip[1]), lHip[0] - rHip[0]) * DEG);

    const { triangles, vertices } = poseSkirtFrame(pose, slotSet);
    const m = measureSkirtTriangles(triangles, vertices, opts.plant?.half);
    if (m === null) {
      p.add('CLOTH_EMPTY_FRAME', `frame ${i} (t=${t.toFixed(3)}s): slot(s) ${opts.skirtSlots.map((s) => `"${s}"`).join(', ')} drew no vertices`);
      return;
    }
    rawFrames.push({
      i,
      t,
      hipX,
      hipY,
      hipW,
      tiltDeg,
      hemL: m.hemL,
      hemR: m.hemR,
      hemLY: m.hemLY,
      hemRY: m.hemRY,
      hemBandCx: m.hemBandCx,
      skirtCx: m.skirtCx,
      skirtTop: m.skirtTop,
      skirtBottom: m.skirtBottom,
    });
  });
  p.throwIfAny();

  return buildClothTrack(
    rawFrames,
    {
      subject: `${basename(opts.rigWhere)}:${opts.animation}`,
      method: `rigc-core-posed-slots(${opts.skirtSlots.join(',')})`,
      source: opts.rigWhere,
      fps: opts.fps,
      unit: 'rig world units',
    },
    opts.windows,
    p,
    opts.plant,
  );
}

/**
 * Hold a joint's missing/unplaced frames in camera-normalised space from the nearest good frame
 * (last good, or first good before it), recording each held span, then apply each frame's own camera transform.
 */
function holdJointTrack(
  seq: PoseSequence,
  track: ReturnType<typeof personTrack>,
  joint: 'r_hip' | 'l_hip',
): { at: Pt[]; holds: Hold[] } | null {
  const raw: Array<Pt | string> = track.map((joints) => {
    const j = joints[joint];
    if (j === undefined || j.state === 'missing') return 'missing';
    if (j.at === undefined) return `${j.state} without a position`;
    return [j.at[0], j.at[1]];
  });
  const firstGood = raw.findIndex((x): x is Pt => typeof x !== 'string');
  if (firstGood < 0) return null;
  let last = firstGood;
  let span: Hold | null = null;
  const holds: Hold[] = [];
  const normAt: Pt[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]!;
    if (typeof v !== 'string') {
      normAt.push(v);
      last = i;
      span = null;
      continue;
    }
    normAt.push(raw[last]! as Pt);
    if (span !== null && span.source === last && span.why === v) span.to = i;
    else {
      span = { point: joint, from: i, to: i, source: last, why: v };
      holds.push(span);
    }
  }
  const at: Pt[] = normAt.map((pt, i) => {
    const cam = seq.camera?.[i];
    return cam === undefined ? [pt[0], pt[1]] : [cam.s * pt[0] + cam.tx, cam.s * pt[1] + cam.ty];
  });
  return { at, holds };
}

/** Measure a cloth track from isolated skirt PNG frames and a pose sequence (Mode 2). */
export function measureFramesCloth(
  plates: ReadonlyArray<{ name: string; plate: Plate }>,
  seq: PoseSequence,
  poseWhere: string,
  framesWhere: string,
  opts: { person?: string; alphaMin: number; windows?: readonly ClothWindow[]; plant?: ClothPlant },
): { doc: ClothTrackDocument; windows: ClothSwingWindow[]; holds: Hold[] } {
  const p = new Problems();
  const track = personTrack(seq, opts.person, poseWhere);
  const n = seq.frames.length;
  if (plates.length !== n) {
    p.add('CLOTH_FRAMES', `--frames ${framesWhere} holds ${plates.length} PNG file(s) and ${poseWhere} ${n} frame(s); the frames are read one PNG per sequence frame, in file-name order`);
    p.throwIfAny();
  }
  const rHips = holdJointTrack(seq, track, 'r_hip');
  const lHips = holdJointTrack(seq, track, 'l_hip');
  if (rHips === null || lHips === null) {
    p.add('CLOTH_HIP', `${poseWhere}: ${rHips === null && lHips === null ? '"r_hip" and "l_hip" have positions' : rHips === null ? '"r_hip" has a position' : '"l_hip" has a position'} on no frame`);
    p.throwIfAny();
  }
  const holds: Hold[] = [...rHips!.holds, ...lHips!.holds];

  const rawFrames: RawFrame[] = [];
  plates.forEach(({ name, plate }, i) => {
    const t = seq.frames[i]!.t;
    if (plate.width !== seq.width || plate.height !== seq.height) {
      p.add('CLOTH_FRAMES', `${name} (frame ${i}) is ${plate.width}×${plate.height} and ${poseWhere} is ${seq.width}×${seq.height}; the joints are in the frames' pixels`);
      return;
    }
    const m = measureSkirtPlate(plate, opts.alphaMin, opts.plant?.half);
    if (m === null) {
      p.add('CLOTH_EMPTY_FRAME', `${name} (frame ${i}, t=${t.toFixed(3)}s) has no pixel with alpha ≥ ${opts.alphaMin} (or colour distance ≥ ${opts.alphaMin} from an opaque border background)`);
      return;
    }
    const rHip = rHips!.at[i]!;
    const lHip = lHips!.at[i]!;
    const hipX = 0.5 * (rHip[0] + lHip[0]);
    const hipY = 0.5 * (rHip[1] + lHip[1]);
    const hipW = Math.hypot(lHip[0] - rHip[0], lHip[1] - rHip[1]);
    const tiltDeg = wrap(Math.atan2(-(lHip[1] - rHip[1]), lHip[0] - rHip[0]) * DEG);
    rawFrames.push({
      i,
      t,
      hipX,
      hipY,
      hipW,
      tiltDeg,
      hemL: m.hemL,
      hemR: m.hemR,
      hemLY: m.hemLY,
      hemRY: m.hemRY,
      hemBandCx: m.hemBandCx,
      skirtCx: m.skirtCx,
      skirtTop: m.skirtTop,
      skirtBottom: m.skirtBottom,
    });
  });
  p.throwIfAny();

  const times = seq.frames.map((f) => f.t);
  const dts = times.slice(1).map((t, i) => t - times[i]!);
  const fps = dts.length === 0 ? 24 : Number((1 / median(dts)).toFixed(3));

  const built = buildClothTrack(
    rawFrames,
    {
      subject: basename(framesWhere),
      method: `png-alpha-silhouette(alpha>=${opts.alphaMin})`,
      source: framesWhere,
      fps,
      unit: 'picture px',
    },
    opts.windows,
    p,
    opts.plant,
  );
  return { ...built, holds };
}

/** `rig-pose cloth` end to end: read inputs, measure, print `CLOTH` lines, write `rig-c-cloth-track/0`. */
export function runCloth(a: ClothArgs, say: (l: string) => void): ClothTrackDocument {
  const p = new Problems();
  const outDirs = planOutDirs([['--out', a.out]], p);
  if (a.kind === 'rig') {
    if (!existsSync(a.rig)) p.add('ARG_PATH', `--rig ${a.rig} does not exist`);
    if (!existsSync(a.map)) p.add('ARG_PATH', `--map ${a.map} does not exist`);
    else if (!statSync(a.map).isFile()) p.add('ARG_PATH', `--map ${a.map} is not a file`);
  } else {
    if (!existsSync(a.frames)) p.add('ARG_PATH', `--frames ${a.frames} does not exist`);
    else if (!statSync(a.frames).isDirectory()) p.add('ARG_PATH', `--frames ${a.frames} is not a directory`);
    if (!existsSync(a.pose)) p.add('ARG_PATH', `--pose ${a.pose} does not exist`);
    else if (!statSync(a.pose).isFile()) p.add('ARG_PATH', `--pose ${a.pose} is not a file`);
  }
  p.throwIfAny();

  let res: { doc: ClothTrackDocument; windows: ClothSwingWindow[]; holds?: Hold[] };
  if (a.kind === 'rig') {
    const map = readMap(readFileSync(a.map, 'utf8'), a.map);
    const loaded = loadCompiledRig(a.rig, p);
    try {
      res = measureRigCloth(loaded.doc, map, a.map, {
        rigWhere: a.rig,
        animation: a.animation,
        skirtSlots: a.skirtSlots,
        fps: a.fps,
        windows: a.windows,
      });
    } finally {
      loaded.cleanup?.();
    }
    say(`rig-pose cloth: ${res.doc.frames_count} frame(s) at ${res.doc.fps} fps from ${a.rig} (animation "${a.animation}", slot(s) ${a.skirtSlots.join(', ')}); median hip width ${res.doc.hipWidth.median.toFixed(3)} ${res.doc.hipWidth.unit}`);
  } else {
    const seq = readPoseSequence(readFileSync(a.pose, 'utf8'), a.pose);
    const allPngs = readdirSync(a.frames).filter((f) => /\.png$/i.test(f) && statSync(join(a.frames, f)).isFile()).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const files = allPngs.length === seq.frames.length + 1 && allPngs.some((f) => /^(contact|sheet)\.png$/i.test(f))
      ? allPngs.filter((f) => !/^(contact|sheet)\.png$/i.test(f))
      : allPngs;
    if (files.length !== seq.frames.length) {
      throw new Refusal([{ code: 'CLOTH_FRAMES', text: `--frames ${a.frames} holds ${files.length} PNG file(s) and ${a.pose} ${seq.frames.length} frame(s); the frames are read one PNG per sequence frame, in file-name order` }]);
    }
    const plates: Array<{ name: string; plate: Plate }> = [];
    for (const [i, file] of files.entries()) {
      const path = join(a.frames, file);
      try {
        plates.push({ name: path, plate: readPlate(path) });
      } catch (e) {
        p.add('CLOTH_FRAMES', `${path} (frame ${i}): ${(e as Error).message}`);
      }
    }
    p.throwIfAny();
    const framesRes = measureFramesCloth(plates, seq, a.pose, a.frames, {
      person: a.person,
      alphaMin: a.alphaMin,
      windows: a.windows,
    });
    res = framesRes;
    say(`rig-pose cloth: ${res.doc.frames_count} frame(s) at ${res.doc.fps} fps from ${a.frames} + ${a.pose} (alpha ≥ ${a.alphaMin}); median hip width ${res.doc.hipWidth.median.toFixed(1)} ${res.doc.hipWidth.unit}`);
    const times = seq.frames.map((f) => f.t);
    for (const h of framesRes.holds) say(`  HOLD   ${holdLine(h, times)}`);
  }

  const hipXs = res.doc.frames.map((f) => f.hip_x);
  const hemXs = res.doc.frames.map((f) => f.hem_mid);
  const range = (xs: number[]) => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs));
  say(`  CLOTH  hip_x range ${range(hipXs).toFixed(3)} hip widths, hem_mid range ${range(hemXs).toFixed(3)} hip widths`);
  for (const w of res.windows) {
    say(`  CLOTH  window ${w.name} ${w.t[0]}–${w.t[1]}s (frames ${w.frames[0]}–${w.frames[1]}): lag ${w.lag.toFixed(3)} frames (r=${w.xcorrPeak.toFixed(3)}), swing ${w.swingRatio === null ? '—' : w.swingRatio.toFixed(3)}, overshoot ${w.overshoot === null ? '—' : w.overshoot.toFixed(3)} (${w.strokes} strokes ≥ ${w.stroke} hip widths)`);
  }
  makeOutDirs(outDirs, say);
  writeFileSync(a.out, writeClothTrack(res.doc));
  say(`  wrote ${a.out} (${CLOTH_SPEC})`);
  return res.doc;
}

// ---------------------------------------------------------------------------
// Skirt physics fitting (`retarget --cloth-track`, rig-c/pose#34)
// ---------------------------------------------------------------------------

/** `rig-c`'s triangle degeneracy threshold (`src/folds.ts`). */
const DEGENERATE_SHARE = 2 ** -30;

export interface SkirtPhysicsLinkParams {
  inertia: number;
  strength: number;
  damping: number;
  mass: number;
  mix: number;
}

export interface SkirtPhysicsGridEntry {
  family: 'cone' | 'uniform' | 'taper';
  root: SkirtPhysicsLinkParams;
  lower: SkirtPhysicsLinkParams;
}

/**
 * Default parameter grid for `--cloth-track` skirt physics fitting (rig-c/pose#34).
 * These values come from a parameter sweep on one reference dance (an 8-link cone-like
 * rig and a 3-link multi-chain rig), not a physical law:
 * - Family 1 (`cone`, 36 entries): soft root link (`k = 0`) with `inertia` in `{0.50, 0.75}`,
 *   `strength` in `{90, 100, 115}`, `damping` in `{0.975, 0.980, 0.985}`, `mass = 1`,
 *   `mix` in `{0.5, 0.6}`, and stiff lower links (`k >= 1`) with `inertia = 0.1, strength = 400,
 *   damping = 0.95, mass = 1` and matching `mix`.
 * - Family 2 (`uniform`, 36 entries, and `taper`, 12 entries): full-chain wave with `mix = 1.0,
 *   mass = 1` — uniform `inertia` in `{0.50, 0.60, 0.75}` x `strength` in `{100, 108, 115, 122}`
 *   x `damping` in `{0.975, 0.980, 0.985}`, plus a mild root-to-tip taper (`inertia` in `{0.50, 0.75}`
 *   x `strength` in `{120, 135, 150}` x `damping` in `{0.970, 0.980}` on link 0 with `1.5x` strength
 *   and `0.5x` inertia on lower links `k >= 1`).
 * Candidate 0 in `fitSkirtPhysics` always evaluates the rig's own setup values before stepping
 * through this grid.
 */
export const SKIRT_PHYSICS_GRID: ReadonlyArray<SkirtPhysicsGridEntry> = Object.freeze([
  // Family 1: cone-like (soft root link k = 0, stiff lower links k >= 1), 36 candidates
  ...([0.5, 0.6] as const).flatMap((mix) =>
    ([0.5, 0.75] as const).flatMap((inertia) =>
      ([90, 100, 115] as const).flatMap((strength) =>
        ([0.975, 0.98, 0.985] as const).map(
          (damping): SkirtPhysicsGridEntry => ({
            family: 'cone',
            root: { inertia, strength, damping, mass: 1, mix },
            lower: { inertia: 0.1, strength: 400, damping: 0.95, mass: 1, mix },
          }),
        ),
      ),
    ),
  ),
  // Family 2a: uniform full-chain wave (mix = 1.0 across all links), 36 candidates
  ...([0.5, 0.6, 0.75] as const).flatMap((inertia) =>
    ([100, 108, 115, 122] as const).flatMap((strength) =>
      ([0.975, 0.98, 0.985] as const).map((damping): SkirtPhysicsGridEntry => {
        const params: SkirtPhysicsLinkParams = { inertia, strength, damping, mass: 1, mix: 1 };
        return { family: 'uniform', root: params, lower: params };
      }),
    ),
  ),
  // Family 2b: mild root-to-tip taper (1.5x strength, 0.5x inertia on lower links k >= 1), 12 candidates
  ...([0.5, 0.75] as const).flatMap((inertia) =>
    ([120, 135, 150] as const).flatMap((strength) =>
      ([0.97, 0.98] as const).map(
        (damping): SkirtPhysicsGridEntry => ({
          family: 'taper',
          root: { inertia, strength, damping, mass: 1, mix: 1 },
          lower: {
            inertia: Number((0.5 * inertia).toFixed(5)),
            strength: Number((1.5 * strength).toFixed(5)),
            damping,
            mass: 1,
            mix: 1,
          },
        }),
      ),
    ),
  ),
]);

export interface FittedPhysicsConstraint extends SkirtPhysicsLinkParams {
  name: string;
  bone: string;
  link: number;
}

export interface ClothFitWindowReport {
  t: [number, number];
  frames: [number, number];
  reference: { lag: number; swingRatio: number; overshoot: number };
  fitted: { lag: number; swingRatio: number; overshoot: number };
  bands: { lag: [number, number]; swingRatio: [number, number]; overshoot: [number, number] };
  pass: { lag: boolean; swingRatio: boolean; overshoot: boolean };
}

export interface ClothFitReport {
  slots: string[];
  constraints: Record<string, { bone: string; link: number; inertia: number; strength: number; damping: number; mass: number; mix: number }>;
  family: 'rig' | 'cone' | 'uniform' | 'taper';
  candidate: number;
  evaluated: number;
  foldFree: number;
  score: number;
  passes: number;
  checks: number;
  maxLinkDeg: number;
  folds: { frames: number; worstTriangles: number };
  windows: Record<string, ClothFitWindowReport>;
}

export interface ClothFitResult {
  report: ClothFitReport;
  constraints: FittedPhysicsConstraint[];
  lines: string[];
}

export interface ClothFitPlant {
  /** Skip the fold-free filter during candidate selection so a folding candidate can win. */
  ignoreFolds?: boolean;
}

export interface FitSkirtPhysicsOptions {
  rigWhere: string;
  animation: string;
  skirtSlots?: readonly string[];
  windows?: readonly ClothWindow[];
  retargetScale?: number | null;
  grid?: ReadonlyArray<SkirtPhysicsGridEntry>;
  plant?: ClothFitPlant;
}

/** Twice the signed area of triangle `t` in `xy` (`x, y` per vertex). */
function foldCross2(xy: readonly number[], triangles: readonly number[], t: number): number {
  const a = triangles[3 * t]! * 2;
  const b = triangles[3 * t + 1]! * 2;
  const c = triangles[3 * t + 2]! * 2;
  return (xy[b]! - xy[a]!) * (xy[c + 1]! - xy[a + 1]!) - (xy[c]! - xy[a]!) * (xy[b + 1]! - xy[a + 1]!);
}

/** Longest edge of triangle `t` in `xy`. */
function foldLongestEdge(xy: readonly number[], triangles: readonly number[], t: number): number {
  const ids = [triangles[3 * t]! * 2, triangles[3 * t + 1]! * 2, triangles[3 * t + 2]! * 2];
  let most = 0;
  for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
    const dx = xy[ids[j]!]! - xy[ids[i]!]!;
    const dy = xy[ids[j]! + 1]! - xy[ids[i]! + 1]!;
    most = Math.max(most, Math.hypot(dx, dy));
  }
  return most;
}

/** Largest coordinate magnitude in `xy`. */
function foldMagnitude(xy: readonly number[]): number {
  let most = 0;
  for (const v of xy) most = Math.max(most, Math.abs(v));
  return most;
}

/** Orientation sign (`+1`, `-1`, or `0` when degenerate) of triangle `t` in `xy`. */
function foldOrientation(xy: readonly number[], triangles: readonly number[], t: number, scale: number): -1 | 0 | 1 {
  const twice = foldCross2(xy, triangles, t);
  const edge = foldLongestEdge(xy, triangles, t);
  if (edge === 0 || Math.abs(twice) / edge <= DEGENERATE_SHARE * scale) return 0;
  return twice > 0 ? 1 : -1;
}

/** Setup-pose triangle signs for one mesh attachment (`0` for setup-degenerate or UV-inverted triangles, matching `rig-c`'s `setupReading`). */
function meshSetupSigns(vertices: readonly number[], triangles: readonly number[], uvs: readonly number[]): Int8Array {
  const count = Math.floor(triangles.length / 3);
  const signs = new Int8Array(count);
  const world: number[] = [];
  const uvSigns: number[] = [];
  const worldScale = foldMagnitude(vertices);
  const uvScale = foldMagnitude(uvs);
  let sense = 0;
  for (let t = 0; t < count; t++) {
    const w = foldOrientation(vertices, triangles, t, worldScale);
    const u = uvs.length === vertices.length ? foldOrientation(uvs, triangles, t, uvScale) : 1;
    world.push(w);
    uvSigns.push(u);
    if (w === 0 || u === 0) continue;
    sense += w * u * Math.abs(foldCross2(vertices, triangles, t));
  }
  for (let t = 0; t < count; t++) {
    const w = world[t]!;
    const u = uvSigns[t]!;
    if (w === 0 || u === 0) continue;
    if (sense !== 0 && Math.sign(w * u) !== Math.sign(sense)) continue;
    signs[t] = w;
  }
  return signs;
}

/** Count how many non-fault triangles of a mesh attachment are flipped relative to `setupSigns`. */
function countFoldedTriangles(vertices: readonly number[], triangles: readonly number[], setupSigns: Int8Array): number {
  if (vertices.length === 0 || setupSigns.length === 0) return 0;
  const scale = foldMagnitude(vertices);
  let folded = 0;
  for (let t = 0; t < setupSigns.length; t++) {
    const before = setupSigns[t]!;
    if (before === 0) continue;
    const now = foldOrientation(vertices, triangles, t, scale);
    if (now === -before) folded++;
  }
  return folded;
}

/** Slot-name pattern used when `--skirt-slots` is omitted on `retarget --cloth-track`. */
export const SKIRT_SLOT_PATTERN = /skirt|bottomwear|dress|hem|kilt|gown/i;

/** The five physics constraint properties `fitSkirtPhysics` searches and `emitPhysicsTracks` keys at `t = 0`. */
const FITTED_PHYSICS_PROPS = ['inertia', 'strength', 'damping', 'mass', 'mix'] as const;

/** Discover the skirt mesh slot(s) and the `rotate > 0` physics constraints driving them, ordered root-to-tip by bone hierarchy. */
export function discoverSkirtPhysics(
  doc: CompiledDocument,
  map: JointMap,
  skirtSlotsOption: readonly string[] | undefined,
  rigWhere: string,
): { slots: string[]; constraints: Array<{ record: CorePhysicsRecord; link: number }> } {
  const p = new Problems();
  const declaredSlots = doc.slots.map((s) => s.name);
  const boneParent = new Map<string, string | null>(doc.bones.map((b) => [b.name, b.parent ?? null]));
  const boneIndex = new Map<string, number>(doc.bones.map((b, i) => [b.name, i]));
  const mappedBones = new Set<string>([
    ...map.chains.flatMap((c) => c.bones),
    ...(map.translate !== null ? [map.translate.bone] : []),
  ]);

  // Map each slot to its mesh attachments and the bones that move them.
  const slotMeshBones = new Map<string, Set<string>>();
  for (const s of doc.slots) {
    const bones = new Set<string>();
    let hasMesh = false;
    for (const skin of doc.skins) {
      const perSlot = skin.attachments[s.name];
      if (perSlot === undefined) continue;
      for (const [attName, att] of Object.entries(perSlot)) {
        const g = att.geometry;
        if (g !== undefined && (g.kind === 'mesh' || g.kind === 'linkedmesh')) {
          hasMesh = true;
          for (const b of attachmentBones(doc, s.name, attName)) bones.add(b);
        }
      }
    }
    if (hasMesh) slotMeshBones.set(s.name, bones);
  }

  const allPhysics = doc.constraints
    .map((c) => c.record)
    .filter((r): r is CorePhysicsRecord => r !== undefined && r.kind === 'physics' && r.rotate > 0);
  const physicsByBone = new Map<string, CorePhysicsRecord[]>();
  for (const c of allPhysics) {
    physicsByBone.set(c.bone, [...(physicsByBone.get(c.bone) ?? []), c]);
  }
  const hasPhysicsOnOrAbove = (bone: string): boolean => {
    for (let cur: string | null = bone; cur !== null && !mappedBones.has(cur); cur = boneParent.get(cur) ?? null) {
      if (physicsByBone.has(cur)) return true;
    }
    return false;
  };

  let slots: string[] = [];
  if (skirtSlotsOption !== undefined && skirtSlotsOption.length > 0) {
    const missing = skirtSlotsOption.filter((s) => !declaredSlots.includes(s));
    if (missing.length > 0) {
      p.add(
        'CLOTH_FIT_SLOTS',
        `--skirt-slots names ${missing.map((s) => `"${s}"`).join(', ')}, which ${rigWhere} does not have; its slots are ${declaredSlots.length === 0 ? 'none' : declaredSlots.join(', ')}`,
      );
      p.throwIfAny();
    }
    const noMesh = skirtSlotsOption.filter((s) => !slotMeshBones.has(s));
    if (noMesh.length > 0) {
      p.add(
        'CLOTH_FIT_SLOTS',
        `--skirt-slots names ${noMesh.map((s) => `"${s}"`).join(', ')}, which has no mesh attachment in ${rigWhere} (mesh slots: ${[...slotMeshBones.keys()].join(', ') || 'none'}); skirt physics fitting reads mesh attachments on the skirt slot(s)`,
      );
      p.throwIfAny();
    }
    slots = [...skirtSlotsOption];
  } else {
    const matchingMeshSlots = [...slotMeshBones.keys()].filter((slot) => SKIRT_SLOT_PATTERN.test(slot));
    const withPhysics = matchingMeshSlots.filter((slot) =>
      [...(slotMeshBones.get(slot) ?? [])].some((b) => hasPhysicsOnOrAbove(b)),
    );
    slots = withPhysics.length > 0 ? withPhysics : matchingMeshSlots;
    if (slots.length === 0) {
      p.add(
        'CLOTH_FIT_SLOTS',
        `${rigWhere} has no mesh slot matching ${SKIRT_SLOT_PATTERN} (slots: ${declaredSlots.join(', ') || 'none'}); pass --skirt-slots <s1,s2,...> to name the skirt slot(s)`,
      );
      p.throwIfAny();
    }
  }

  // Collect all bones bound to the chosen skirt slots, then include every rotate > 0 physics constraint on those bones
  // or in the same unmapped physics chain above/below them, stopping at mapped bones.
  const directBones = new Set<string>();
  for (const s of slots) {
    for (const b of slotMeshBones.get(s) ?? []) directBones.add(b);
  }
  const chainBones = new Set<string>();
  for (const b of directBones) {
    for (let cur: string | null = b; cur !== null && !mappedBones.has(cur); cur = boneParent.get(cur) ?? null) {
      if (physicsByBone.has(cur)) chainBones.add(cur);
    }
  }
  // Include any descendant physics bone under a discovered chain bone, stopping at mapped bones.
  for (const c of allPhysics) {
    for (let cur: string | null = c.bone; cur !== null && !mappedBones.has(cur); cur = boneParent.get(cur) ?? null) {
      if (chainBones.has(cur)) {
        chainBones.add(c.bone);
        break;
      }
    }
  }

  const matched = allPhysics.filter((c) => chainBones.has(c.bone));
  if (matched.length === 0) {
    p.add(
      'CLOTH_FIT_CONSTRAINTS',
      `slot(s) ${slots.map((s) => `"${s}"`).join(', ')} in ${rigWhere} have no rotate > 0 physics constraint on their unmapped mesh bones (${[...directBones].join(', ') || 'none'}); declare a physics constraint with rotate > 0 in the rig spec before fitting with --cloth-track`,
    );
    p.throwIfAny();
  }

  const constrainedBones = new Set(matched.map((c) => c.bone));
  const withLinks = matched.map((record) => {
    let link = 0;
    for (let cur = boneParent.get(record.bone) ?? null; cur !== null && !mappedBones.has(cur); cur = boneParent.get(cur) ?? null) {
      if (constrainedBones.has(cur)) link++;
    }
    return { record, link };
  });
  withLinks.sort((a, b) => (boneIndex.get(a.record.bone) ?? 0) - (boneIndex.get(b.record.bone) ?? 0) || a.link - b.link);
  return { slots, constraints: withLinks };
}

/** Read a reference `rig-c-cloth-track/0` along with its `fps` and any `skirtSwing` window ranges. */
function readClothForFit(
  text: string,
  where: string,
): ReturnType<typeof readCloth> & { fps: number; dts: number[]; windows: ClothWindow[] } {
  const base = readCloth(text, where);
  const raw = parseJson(text, where, 'CLOTH_JSON') as Record<string, unknown>;
  const dts = base.times.slice(1).map((t, i) => t - base.times[i]!);
  const fpsRaw = typeof raw.fps === 'number' && Number.isFinite(raw.fps) && raw.fps > 0 ? raw.fps : dts.length === 0 ? 24 : Number((1 / median(dts)).toFixed(3));
  const windows: ClothWindow[] = [];
  if (isObject(raw.skirtSwing)) {
    for (const [name, entry] of Object.entries(raw.skirtSwing)) {
      if (
        isObject(entry) &&
        Array.isArray(entry.t) &&
        entry.t.length === 2 &&
        typeof entry.t[0] === 'number' &&
        typeof entry.t[1] === 'number' &&
        Number.isFinite(entry.t[0]) &&
        Number.isFinite(entry.t[1]) &&
        entry.t[0] >= 0 &&
        entry.t[1] > entry.t[0]
      ) {
        windows.push({ name, from: entry.t[0], to: entry.t[1] });
      }
    }
  }
  return { ...base, fps: fpsRaw, dts, windows };
}

/** Format a link parameter set for `CLOTH` stdout lines. */
function formatLinkParams(p: SkirtPhysicsLinkParams): string {
  return `inertia=${p.inertia}, strength=${p.strength}, damping=${p.damping}, mass=${p.mass}, mix=${p.mix}`;
}

/**
 * Fit the skirt's physics constraints on `doc` (animation `opts.animation`) against a reference
 * `rig-c-cloth-track/0` (`refText` from `refWhere`). Pure in-memory search over Candidate 0 (the rig's
 * own setup values) and `opts.grid ?? SKIRT_PHYSICS_GRID` using `poseRawAnimationEach(..., physicsClockStep)`.
 */
export function fitSkirtPhysics(
  doc: CompiledDocument,
  map: JointMap,
  mapWhere: string,
  refText: string,
  refWhere: string,
  opts: FitSkirtPhysicsOptions,
): ClothFitResult {
  const ref = readClothForFit(refText, refWhere);
  const p = new Problems();
  const windows = opts.windows !== undefined && opts.windows.length > 0 ? [...opts.windows] : ref.windows;
  if (windows.length === 0) {
    p.add(
      'CLOTH_FIT_WINDOWS',
      `--cloth-track ${refWhere} carries no "skirtSwing" windows and --cloth-windows was not given; pass --cloth-windows <t0-t1,...> or measure the reference track with rig-pose cloth --windows <t0-t1,...>`,
    );
    p.throwIfAny();
  }

  const { slots: skirtSlots, constraints: discovered } = discoverSkirtPhysics(doc, map, opts.skirtSlots, opts.rigWhere);
  const hips = hipOf(map);
  if ('problem' in hips) {
    p.add('CLOTH_HIP', `${mapWhere}: ${hips.problem}`);
  }
  const animIndex = doc.animations.findIndex((a) => a.name === opts.animation);
  if (animIndex < 0) {
    const names = doc.animations.map((a) => a.name);
    p.add('CLOTH_ANIMATION', `${opts.rigWhere} has no animation "${opts.animation}"; its animations are ${names.length === 0 ? 'none' : names.join(', ')}`);
  } else if (!(doc.animations[animIndex]!.timelines.duration > 0)) {
    p.add('CLOTH_ANIMATION', `animation "${opts.animation}" in ${opts.rigWhere} has duration ${doc.animations[animIndex]!.timelines.duration} s; a cloth fit needs a non-zero duration`);
  }
  p.throwIfAny();

  const anim = doc.animations[animIndex]!;
  const fps = ref.fps;
  const duration = anim.timelines.duration;
  const stepCount = Math.max(1, Math.round(duration * fps));
  const dt = 1 / fps;
  const steps = Array.from({ length: stepCount }, () => dt);
  const nRig = stepCount + 1;
  const nRef = ref.times.length;
  const fpsRef = ref.dts.length === 0 ? ref.fps : 1 / median(ref.dts);
  const frameOfRef = (t: number) => Math.min(nRef, Math.max(0, Math.round((t - (ref.times[0] ?? 0)) * fpsRef)));
  const frameOfRig = (t: number) => Math.min(nRig, Math.max(0, Math.round(t * fps)));

  const refWindows: Array<{
    name: string;
    from: number;
    to: number;
    f0Ref: number;
    f1Ref: number;
    f0Rig: number;
    f1Rig: number;
    lag: number;
    swingRatio: number;
    overshoot: number;
  }> = [];

  for (const w of windows) {
    const f0Ref = frameOfRef(w.from);
    const f1Ref = frameOfRef(w.to);
    const f0Rig = frameOfRig(w.from);
    const f1Rig = frameOfRig(w.to);
    if (f1Ref - f0Ref <= CLOTH.lagTo) {
      p.add(
        'CLOTH_FIT_WINDOWS',
        `window ${w.name} (${w.from}–${w.to} s) is frames ${f0Ref}–${f1Ref - 1} of the ${nRef} in ${refWhere}, ${Math.max(0, f1Ref - f0Ref)} frame(s); the lag search reaches ${CLOTH.lagTo} frames, so a window needs more than ${CLOTH.lagTo}`,
      );
      continue;
    }
    if (f1Rig - f0Rig <= CLOTH.lagTo) {
      p.add(
        'CLOTH_FIT_WINDOWS',
        `window ${w.name} (${w.from}–${w.to} s) is frames ${f0Rig}–${f1Rig - 1} of the ${nRig} on animation "${opts.animation}" (${duration.toFixed(3)} s at ${fps} fps), ${Math.max(0, f1Rig - f0Rig)} frame(s); the lag search reaches ${CLOTH.lagTo} frames, so a window needs more than ${CLOTH.lagTo}`,
      );
      continue;
    }
    const fig = clothFigures(ref.hip, ref.hem, f0Ref, f1Ref, CLOTH.stroke);
    if (fig.swingRatio === null || !(fig.swingRatio > 0) || fig.overshoot === null) {
      p.add(
        'CLOTH_FIT_WINDOWS',
        `window ${w.name} (${w.from}–${w.to} s) in ${refWhere} has ${fig.strokes} reference hip stroke(s) ≥ ${CLOTH.stroke} hip widths (swingRatio ${fig.swingRatio ?? 'null'}, overshoot ${fig.overshoot ?? 'null'}); fitting requires at least one reference hip stroke per window`,
      );
      continue;
    }
    refWindows.push({
      name: w.name,
      from: w.from,
      to: w.to,
      f0Ref,
      f1Ref,
      f0Rig,
      f1Rig,
      lag: fig.lag,
      swingRatio: fig.swingRatio,
      overshoot: fig.overshoot,
    });
  }
  p.throwIfAny();

  // Setup pose for fold orientation signs (read from the setup rest pose for every mesh attachment on the
  // skirt slots, even when a slot shows another attachment or null at setup, matching rig-c's rest table)
  // and initial relative bone angles.
  const setupPose = poseRawSetup(doc);
  const slotSet = new Set(skirtSlots);
  const setupSignsByAttachment = new Map<string, Int8Array>();
  for (const d of setupPose.drawn) {
    if (!slotSet.has(d.slot) || d.kind !== 'mesh') continue;
    setupSignsByAttachment.set(`${d.slot}\u0000${d.attachment}`, meshSetupSigns(d.vertices, d.triangles, d.uvs));
  }
  for (const slot of skirtSlots) {
    const attNames = new Set<string>();
    for (const skin of doc.skins) {
      const perSlot = skin.attachments[slot];
      if (perSlot === undefined) continue;
      for (const [attName, att] of Object.entries(perSlot)) {
        const g = att.geometry;
        if (g !== undefined && (g.kind === 'mesh' || g.kind === 'linkedmesh')) {
          attNames.add(attName);
        }
      }
    }
    for (const attName of attNames) {
      const key = `${slot}\u0000${attName}`;
      if (setupSignsByAttachment.has(key)) continue;
      const restPose = poseRawSetup({
        ...doc,
        slots: doc.slots.map((s) => (s.name === slot ? { ...s, setup: attName } : s)),
      });
      const d = restPose.drawn.find((x) => x.slot === slot && x.attachment === attName && x.kind === 'mesh');
      if (d !== undefined) {
        setupSignsByAttachment.set(key, meshSetupSigns(d.vertices, d.triangles, d.uvs));
      }
    }
  }
  const setupBones = new Map(setupPose.bones.map((b) => [b.name, b]));
  const setupRelDegByBone = new Map<string, number>();
  for (const { record } of discovered) {
    const b = setupBones.get(record.bone);
    const parent = b?.parent ? setupBones.get(b.parent) : undefined;
    setupRelDegByBone.set(record.bone, b === undefined ? 0 : wrap(b.rotationX - (parent?.rotationX ?? 0)));
  }

  const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
  const [rSpec, lSpec] = (hips as { joints: [string, string]; points: [string, string] }).joints[0] === 'r_hip'
    ? (hips as { points: [string, string] }).points
    : [(hips as { points: [string, string] }).points[1], (hips as { points: [string, string] }).points[0]];

  // Build Candidate 0 (rig's own setup values) + grid candidates (1 .. grid.length).
  const grid = opts.grid ?? SKIRT_PHYSICS_GRID;
  const candidateDefs: Array<{
    candidate: number;
    family: 'rig' | 'cone' | 'uniform' | 'taper';
    rootSummary: SkirtPhysicsLinkParams;
    lowerSummary: SkirtPhysicsLinkParams;
    constraints: FittedPhysicsConstraint[];
  }> = [];

  const rigConstraints: FittedPhysicsConstraint[] = discovered.map(({ record, link }) => ({
    name: record.name,
    bone: record.bone,
    link,
    inertia: Number(record.inertia.toFixed(5)),
    strength: Number(record.strength.toFixed(5)),
    damping: Number(record.damping.toFixed(5)),
    mass: Number((1 / record.massInverse).toFixed(5)),
    mix: Number(record.mix.toFixed(5)),
  }));
  const rigRoot = rigConstraints.find((c) => c.link === 0) ?? rigConstraints[0]!;
  const rigLower = rigConstraints.find((c) => c.link >= 1) ?? rigRoot;
  candidateDefs.push({
    candidate: 0,
    family: 'rig',
    rootSummary: { inertia: rigRoot.inertia, strength: rigRoot.strength, damping: rigRoot.damping, mass: rigRoot.mass, mix: rigRoot.mix },
    lowerSummary: { inertia: rigLower.inertia, strength: rigLower.strength, damping: rigLower.damping, mass: rigLower.mass, mix: rigLower.mix },
    constraints: rigConstraints,
  });

  grid.forEach((entry, idx) => {
    candidateDefs.push({
      candidate: idx + 1,
      family: entry.family,
      rootSummary: entry.root,
      lowerSummary: entry.lower,
      constraints: discovered.map(({ record, link }) => {
        const params = link === 0 ? entry.root : entry.lower;
        return {
          name: record.name,
          bone: record.bone,
          link,
          inertia: params.inertia,
          strength: params.strength,
          damping: params.damping,
          mass: params.mass,
          mix: params.mix,
        };
      }),
    });
  });

  const fittedNames = new Set(discovered.map((d) => d.record.name));
  // Keep every existing physics timeline except the five fitted properties on the fitted constraints,
  // matching `emitPhysicsTracks` (so `wind`, `gravity`, `reset`, and other constraints stay in place).
  const isFittedTimeline = (tl: CorePhysicsTimeline): boolean =>
    tl.name !== null && fittedNames.has(tl.name) && (FITTED_PHYSICS_PROPS as readonly string[]).includes(tl.kind);
  const keptPhysByAnim = doc.animations.map((a) => (a.constraints.physicsKeyed ?? []).filter((tl) => !isFittedTimeline(tl)));
  const stepsByAnim = doc.animations.map((a) =>
    a.timelines.duration > 0 ? Array.from({ length: Math.max(1, Math.round(a.timelines.duration * fps)) }, () => dt) : [],
  );

  let rigHipWidth = 0;
  let originX = 0;
  let hipSeries: number[] = [];
  let renStroke: number = CLOTH.stroke;

  interface EvaluatedCandidate {
    def: (typeof candidateDefs)[number];
    score: number;
    passes: number;
    checks: number;
    maxLinkDeg: number;
    folds: { frames: number; worstTriangles: number };
    windows: Record<string, ClothFitWindowReport>;
  }

  const evaluated: EvaluatedCandidate[] = [];

  for (const def of candidateDefs) {
    const candidatePhysTimelines: CorePhysicsTimeline[] = def.constraints.flatMap((c) =>
      FITTED_PHYSICS_PROPS.map((kind) => ({
        name: c.name,
        kind,
        keys: [{ time: 0, values: [Math.fround(c[kind])], stated: { time: 0, values: [c[kind]] }, curve: 'linear' as const }],
      })),
    );
    const docCandidate: CompiledDocument = {
      ...doc,
      animations: doc.animations.map((a, idx) => {
        const physTimelines = [...keptPhysByAnim[idx]!, ...candidatePhysTimelines];
        return {
          ...a,
          constraints: {
            ...a.constraints,
            physics: physTimelines.length,
            physicsKeyed: physTimelines,
          },
        };
      }),
    };

    const rawHipX: number[] = [];
    const rawHipW: number[] = [];
    const rawHemMidWorld: number[] = [];
    let foldFrames = 0;
    let worstTriangles = 0;
    let maxLinkDeg = 0;

    const checkPoseFolds = (pose: RawPose) => {
      let frameFolded = 0;
      for (const d of pose.drawn) {
        if (!slotSet.has(d.slot) || d.kind !== 'mesh') continue;
        const signs = setupSignsByAttachment.get(`${d.slot}\u0000${d.attachment}`);
        if (signs !== undefined) {
          frameFolded += countFoldedTriangles(d.vertices, d.triangles, signs);
        }
      }
      if (frameFolded > 0) {
        foldFrames++;
        if (frameFolded > worstTriangles) worstTriangles = frameFolded;
      }
    };

    // Step the fitted animation for scoring, link deflection, and fold checks:
    poseRawAnimationEach(
      docCandidate,
      opts.animation,
      steps,
      {},
      'animation',
      (pose, i) => {
        const bones = new Map(pose.bones.map((b) => [b.name, b]));
        if (def.candidate === 0) {
          const pr = pointAt(bones, lengths, rSpec);
          const pl = pointAt(bones, lengths, lSpec);
          if (pr === null || pl === null) {
            throw new Refusal([{ code: 'CLOTH_HIP', text: `frame ${i} (t=${(i / fps).toFixed(3)}s): hip point ${pr === null ? `"${rSpec}"` : `"${lSpec}"`} could not be posed` }]);
          }
          const rHip: Pt = [pr[0], -pr[1]];
          const lHip: Pt = [pl[0], -pl[1]];
          rawHipX.push(0.5 * (rHip[0] + lHip[0]));
          rawHipW.push(Math.hypot(lHip[0] - rHip[0], lHip[1] - rHip[1]));
        }

        checkPoseFolds(pose);

        // Measure max link deflection relative to parent bone.
        for (const { record } of discovered) {
          const b = bones.get(record.bone);
          if (b === undefined) continue;
          const parent = b.parent ? bones.get(b.parent) : undefined;
          const relDeg = wrap(b.rotationX - (parent?.rotationX ?? 0));
          const dev = Math.abs(wrap(relDeg - (setupRelDegByBone.get(record.bone) ?? 0)));
          if (dev > maxLinkDeg) maxLinkDeg = dev;
        }

        const { triangles, vertices } = poseSkirtFrame(pose, slotSet);
        const m = measureSkirtTriangles(triangles, vertices);
        if (m === null) {
          throw new Refusal([{ code: 'CLOTH_EMPTY_FRAME', text: `frame ${i} (t=${(i / fps).toFixed(3)}s): slot(s) ${skirtSlots.map((s) => `"${s}"`).join(', ')} drew no vertices` }]);
        }
        rawHemMidWorld.push(0.5 * (m.hemL + m.hemR));
      },
      physicsClockStep,
    );

    // Also step every other animation in `doc.animations` (such as `idle`) with the candidate physics
    // so the fold-free filter covers every animation that `emitPhysicsTracks` writes the winner onto.
    for (let idx = 0; idx < docCandidate.animations.length; idx++) {
      if (idx === animIndex) continue;
      const otherAnim = docCandidate.animations[idx]!;
      poseRawAnimationEach(
        docCandidate,
        otherAnim.name,
        stepsByAnim[idx]!,
        {},
        'animation',
        (pose) => {
          checkPoseFolds(pose);
        },
        physicsClockStep,
      );
    }

    if (def.candidate === 0) {
      const validWidths = rawHipW.filter((w) => Number.isFinite(w) && w > 0);
      if (validWidths.length === 0) {
        throw new Refusal([{ code: 'CLOTH_HIP', text: `${opts.rigWhere} has no positive hip width across ${rawHipW.length} frame(s)` }]);
      }
      rigHipWidth = median(validWidths);
      originX = median(rawHipX);
      hipSeries = rawHipX.map((x) => Number(((x - originX) / rigHipWidth).toFixed(5)));
      renStroke =
        ref.unit === 'picture px' && opts.retargetScale !== undefined && opts.retargetScale !== null
          ? (CLOTH.stroke * ref.hipWidth * opts.retargetScale) / rigHipWidth
          : CLOTH.stroke;
    }

    const hemSeries = rawHemMidWorld.map((x) => Number(((x - originX) / rigHipWidth).toFixed(5)));
    let totalScore = 0;
    let passes = 0;
    const checks = 3 * refWindows.length;
    const winReports: Record<string, ClothFitWindowReport> = {};

    for (const rw of refWindows) {
      const fig = clothFigures(hipSeries, hemSeries, rw.f0Rig, rw.f1Rig, renStroke);
      const lagBand: [number, number] = [
        Number((rw.lag - BARS.clothLag).toFixed(5)),
        Number((rw.lag + BARS.clothLag).toFixed(5)),
      ];
      const swingBand: [number, number] = [
        Number((rw.swingRatio * (1 - BARS.clothSwing)).toFixed(5)),
        Number((rw.swingRatio * (1 + BARS.clothSwing)).toFixed(5)),
      ];
      const overshootBand: [number, number] = [
        Number(Math.max(0, rw.overshoot - BARS.clothOvershoot).toFixed(5)),
        Number((rw.overshoot + BARS.clothOvershoot).toFixed(5)),
      ];
      const fittedSwing = fig.swingRatio ?? 0;
      const fittedOvershoot = fig.overshoot ?? 0;
      const hasStrokes = fig.swingRatio !== null && fig.overshoot !== null;
      const passLag = Math.abs(fig.lag - rw.lag) <= BARS.clothLag + 1e-9;
      const passSwing = hasStrokes && Math.abs(fittedSwing - rw.swingRatio) <= BARS.clothSwing * rw.swingRatio + 1e-9;
      const passOvershoot = hasStrokes && fittedOvershoot >= overshootBand[0] - 1e-9 && fittedOvershoot <= overshootBand[1] + 1e-9;
      if (passLag) passes++;
      if (passSwing) passes++;
      if (passOvershoot) passes++;

      const lagTerm = Math.abs(fig.lag - rw.lag) / BARS.clothLag;
      const swingTerm = hasStrokes ? Math.abs(fittedSwing - rw.swingRatio) / (BARS.clothSwing * rw.swingRatio) : 1e6;
      const overshootTerm = hasStrokes ? Math.abs(fittedOvershoot - rw.overshoot) / BARS.clothOvershoot : 1e6;
      totalScore += lagTerm + swingTerm + overshootTerm;

      winReports[rw.name] = {
        t: [rw.from, rw.to],
        frames: [rw.f0Rig, rw.f1Rig - 1],
        reference: {
          lag: Number(rw.lag.toFixed(5)),
          swingRatio: Number(rw.swingRatio.toFixed(5)),
          overshoot: Number(rw.overshoot.toFixed(5)),
        },
        fitted: {
          lag: Number(fig.lag.toFixed(5)),
          swingRatio: Number(fittedSwing.toFixed(5)),
          overshoot: Number(fittedOvershoot.toFixed(5)),
        },
        bands: {
          lag: lagBand,
          swingRatio: swingBand,
          overshoot: overshootBand,
        },
        pass: {
          lag: passLag,
          swingRatio: passSwing,
          overshoot: passOvershoot,
        },
      };
    }

    evaluated.push({
      def,
      score: checks > 0 ? totalScore / checks : 0,
      passes,
      checks,
      maxLinkDeg,
      folds: { frames: foldFrames, worstTriangles },
      windows: winReports,
    });
  }

  const foldFreeList = evaluated.filter((c) => c.folds.frames === 0);
  const eligible = opts.plant?.ignoreFolds === true ? evaluated : foldFreeList;
  if (eligible.length === 0) {
    const leastFolded = [...evaluated].sort(
      (a, b) =>
        a.folds.frames - b.folds.frames ||
        a.folds.worstTriangles - b.folds.worstTriangles ||
        a.def.candidate - b.def.candidate,
    )[0]!;
    const totalSteppedFrames = stepsByAnim.reduce((s, st) => s + st.length + 1, 0);
    const animLabels = doc.animations.map((a) => `"${a.name}"`).join(', ');
    throw new Refusal([
      {
        code: 'CLOTH_FIT_FOLDS',
        text: `every candidate of ${evaluated.length} folded slot(s) ${skirtSlots.map((s) => `"${s}"`).join(', ')} across animation(s) ${animLabels} (fewest: candidate #${leastFolded.def.candidate} (${leastFolded.def.family}) folded on ${leastFolded.folds.frames} of ${totalSteppedFrames} stepped frame(s), worst frame ${leastFolded.folds.worstTriangles} triangle(s)); adjust the skirt mesh weights or rest pose before fitting`,
      },
    ]);
  }

  const chosen = [...eligible].sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-12) return a.score - b.score;
    if (a.passes !== b.passes) return b.passes - a.passes;
    if (Math.abs(a.maxLinkDeg - b.maxLinkDeg) > 1e-9) return a.maxLinkDeg - b.maxLinkDeg;
    return a.def.candidate - b.def.candidate;
  })[0]!;

  const constraintsMap: ClothFitReport['constraints'] = Object.fromEntries(
    chosen.def.constraints.map((c) => [
      c.name,
      {
        bone: c.bone,
        link: c.link,
        inertia: c.inertia,
        strength: c.strength,
        damping: c.damping,
        mass: c.mass,
        mix: c.mix,
      },
    ]),
  );

  const report: ClothFitReport = {
    slots: skirtSlots,
    constraints: constraintsMap,
    family: chosen.def.family,
    candidate: chosen.def.candidate,
    evaluated: evaluated.length,
    foldFree: foldFreeList.length,
    score: Number(chosen.score.toFixed(5)),
    passes: chosen.passes,
    checks: chosen.checks,
    maxLinkDeg: Number(chosen.maxLinkDeg.toFixed(3)),
    folds: chosen.folds,
    windows: chosen.windows,
  };

  const hasLower = chosen.def.constraints.some((c) => c.link >= 1);
  const paramSummary = hasLower
    ? `root ${formatLinkParams(chosen.def.rootSummary)}; lower ${formatLinkParams(chosen.def.lowerSummary)}`
    : formatLinkParams(chosen.def.rootSummary);
  const cNames = chosen.def.constraints.map((c) => c.name);
  const cLabel = cNames.length <= 2 ? cNames.join(', ') : `${cNames[0]} .. ${cNames[cNames.length - 1]}`;
  const lines: string[] = [
    `CLOTH  fit slot(s) ${skirtSlots.join(', ')} (${cNames.length} constraint(s): ${cLabel}) over ${evaluated.length} candidate(s) (${foldFreeList.length} fold-free): picked #${chosen.def.candidate} (${chosen.def.family}: ${paramSummary}) — score ${chosen.score.toFixed(3)} (${chosen.passes}/${chosen.checks} in band), max link turn ${chosen.maxLinkDeg.toFixed(1)}°, ${chosen.folds.frames} fold frame(s)`,
  ];
  for (const [wName, w] of Object.entries(chosen.windows)) {
    lines.push(
      `CLOTH  window ${wName} ${w.t[0]}–${w.t[1]}s: lag ${w.fitted.lag.toFixed(2)}f vs ref ${w.reference.lag.toFixed(2)}f [${w.bands.lag[0].toFixed(2)}, ${w.bands.lag[1].toFixed(2)}] ${w.pass.lag ? 'pass' : 'MISS'}, swingRatio ${w.fitted.swingRatio.toFixed(3)} vs ref ${w.reference.swingRatio.toFixed(3)} [${w.bands.swingRatio[0].toFixed(3)}, ${w.bands.swingRatio[1].toFixed(3)}] ${w.pass.swingRatio ? 'pass' : 'MISS'}, overshoot ${w.fitted.overshoot.toFixed(3)} vs ref ${w.reference.overshoot.toFixed(3)} [${w.bands.overshoot[0].toFixed(3)}, ${w.bands.overshoot[1].toFixed(3)}] ${w.pass.overshoot ? 'pass' : 'MISS'}`,
    );
  }

  return { report, constraints: chosen.def.constraints, lines };
}

/**
 * Emit `t = 0` physics timeline tracks (`inertia`, `strength`, `damping`, `mass`, `mix`) for each
 * fitted constraint onto EVERY animation in `motion.animations`, keeping any non-fitted tracks
 * (`wind`, `gravity`, `reset`, and other constraints) in place so the rebuilt rig plays bit-for-bit
 * what `fitSkirtPhysics` stepped.
 */
export function emitPhysicsTracks<T extends { animations: Record<string, unknown> }>(
  motion: T,
  constraints: readonly FittedPhysicsConstraint[],
): T {
  const targetSet = new Set(constraints.map((c) => c.name));
  const physicsTracks = constraints.flatMap((c) =>
    FITTED_PHYSICS_PROPS.map((property) => ({
      physics: c.name,
      property,
      keys: [{ t: 0, v: [c[property]] }],
    })),
  );

  const rawAnims = isObject(motion.animations) ? motion.animations : {};
  const animations: Record<string, unknown> = {};
  for (const [animName, animVal] of Object.entries(rawAnims)) {
    if (!isObject(animVal)) {
      animations[animName] = animVal;
      continue;
    }
    const existingTracks = Array.isArray(animVal.tracks) ? animVal.tracks : [];
    const kept = existingTracks.filter(
      (tr) => !(isObject(tr) && typeof tr.physics === 'string' && targetSet.has(tr.physics) && typeof tr.property === 'string' && (FITTED_PHYSICS_PROPS as readonly string[]).includes(tr.property)),
    );
    animations[animName] = {
      ...animVal,
      tracks: [...kept, ...physicsTracks],
    };
  }

  return {
    ...motion,
    animations,
  } as T;
}

