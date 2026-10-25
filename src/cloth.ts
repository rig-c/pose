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
import { poseRawAnimation, readModel, type CompiledDocument, type RawPose } from 'rig-c/core';
import { readPlate, type Plate } from 'rig-c/plate';
import { CLOTH, CLOTH_SPEC, clothFigures, median, type ClothFigures, type ClothWindow } from './compare.ts';
import { pointAt, readMap, resolveMap, type JointMap } from './map.ts';
import { makeOutDirs, planOutDirs } from './outdir.ts';
import { personTrack, readPoseSequence, type PoseSequence } from './pose.ts';
import { Problems, Refusal } from './problems.ts';
import { hipOf, wrap } from './retarget.ts';
import { baseMotionOf, gate, readBuild, resolveRig, restOf, slotsOf } from './rigc.ts';

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

/** Clip triangle `(a, b, c)` (already in y-down coordinates) to the half-plane `y >= yMid`, returning a polygon of 0, 3, or 4 vertices. */
function clipTriLower(a: Pt, b: Pt, c: Pt, yMid: number): Pt[] {
  const pts: Pt[] = [a, b, c];
  const out: Pt[] = [];
  for (let k = 0; k < 3; k++) {
    const p = pts[k]!;
    const q = pts[(k + 1) % 3]!;
    const pIn = p[1] >= yMid;
    const qIn = q[1] >= yMid;
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
  const lowerPts: Pt[] = [];
  for (const p of vertices) if (p[1] >= yMid) lowerPts.push(p);
  for (const [a, b, c] of triangles) {
    const m = triMomentX(a, b, c);
    totalArea2 += m.area2;
    totalMx2 += m.mx2;
    const clipped = clipTriLower(a, b, c, yMid);
    for (const p of clipped) lowerPts.push(p);
    for (let k = 1; k + 1 < clipped.length; k++) {
      const bm = triMomentX(clipped[0]!, clipped[k]!, clipped[k + 1]!);
      bandArea2 += bm.area2;
      bandMx2 += bm.mx2;
    }
  }
  const pts = lowerPts.length > 0 ? lowerPts : vertices;
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
 */
export function measureSkirtPlate(
  plate: Plate,
  alphaMin: number,
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
  const yStart = Math.ceil(yMid - 1e-9);
  let hemL = Infinity;
  let hemR = -Infinity;
  let hemLY = yStart;
  let hemRY = yStart;
  let bandWeight = 0;
  let bandWx = 0;
  for (let y = Math.max(0, yStart); y <= skirtBottom; y++) {
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
      t: f.t,
      hip_x: normX(f.hipX),
      hip_y: normY(f.hipY),
      hip_w: f.hipW / hipWidth,
      tilt_deg: f.tiltDeg,
      hem_mid: 0.5 * (hemL + hemR),
      hem_l: hemL,
      hem_r: hemR,
      hem_l_y: normY(f.hemLY),
      hem_r_y: normY(f.hemRY),
      hem_band_cx: normX(f.hemBandCx),
      skirt_cx: normX(f.skirtCx),
      skirt_top: normY(f.skirtTop),
      skirt_bottom: normY(f.skirtBottom),
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
      const fig: ClothFigures = clothFigures(hipSeries, hemSeries, f0, f1, CLOTH.stroke);
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
  opts: { rigWhere: string; animation: string; skirtSlots: readonly string[]; fps: number; windows?: readonly ClothWindow[] },
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
  const poses = poseRawAnimation(doc, opts.animation, steps, {}, 'animation');
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
    const m = measureSkirtTriangles(triangles, vertices);
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
  );
}

/** Hold a joint's missing/unplaced frames from the nearest good frame (last good, or first good before it). */
function holdJointTrack(seq: PoseSequence, track: ReturnType<typeof personTrack>, joint: 'r_hip' | 'l_hip'): Pt[] | null {
  const raw: Array<Pt | null> = track.map((joints, i) => {
    const j = joints[joint];
    if (j === undefined || j.state === 'missing' || j.at === undefined) return null;
    const cam = seq.camera?.[i];
    return cam === undefined ? [j.at[0], j.at[1]] : [cam.s * j.at[0] + cam.tx, cam.s * j.at[1] + cam.ty];
  });
  const firstGood = raw.find((x): x is Pt => x !== null);
  if (firstGood === undefined) return null;
  let last: Pt = firstGood;
  return raw.map((x) => {
    if (x !== null) last = x;
    return last;
  });
}

/** Measure a cloth track from isolated skirt PNG frames and a pose sequence (Mode 2). */
export function measureFramesCloth(
  plates: ReadonlyArray<{ name: string; plate: Plate }>,
  seq: PoseSequence,
  poseWhere: string,
  framesWhere: string,
  opts: { person?: string; alphaMin: number; windows?: readonly ClothWindow[] },
): { doc: ClothTrackDocument; windows: ClothSwingWindow[] } {
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

  const rawFrames: RawFrame[] = [];
  plates.forEach(({ name, plate }, i) => {
    const t = seq.frames[i]!.t;
    if (plate.width !== seq.width || plate.height !== seq.height) {
      p.add('CLOTH_FRAMES', `${name} (frame ${i}) is ${plate.width}×${plate.height} and ${poseWhere} is ${seq.width}×${seq.height}; the joints are in the frames' pixels`);
      return;
    }
    const m = measureSkirtPlate(plate, opts.alphaMin);
    if (m === null) {
      p.add('CLOTH_EMPTY_FRAME', `${name} (frame ${i}, t=${t.toFixed(3)}s) has no pixel with alpha ≥ ${opts.alphaMin}`);
      return;
    }
    const rHip = rHips![i]!;
    const lHip = lHips![i]!;
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

  return buildClothTrack(
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
  );
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

  let res: { doc: ClothTrackDocument; windows: ClothSwingWindow[] };
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
    res = measureFramesCloth(plates, seq, a.pose, a.frames, {
      person: a.person,
      alphaMin: a.alphaMin,
      windows: a.windows,
    });
    say(`rig-pose cloth: ${res.doc.frames_count} frame(s) at ${res.doc.fps} fps from ${a.frames} + ${a.pose} (alpha ≥ ${a.alphaMin}); median hip width ${res.doc.hipWidth.median.toFixed(1)} ${res.doc.hipWidth.unit}`);
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
