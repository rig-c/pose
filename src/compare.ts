/**
 * `rig-pose compare` (rig-c/pose#38): the reference (the source video's
 * keypoints) against the rig's render (the same detector run on rigc's render
 * of the retargeted motion), frame for frame on one time base, reported per
 * body unit: head, arms, body, legs, cloth.
 *
 * Pure: it reads parsed inputs and returns findings; the files are read and
 * written by `runcompare.ts`. The bars below were fixed in the issue before any
 * render-side keypoints existed, and they are grading lines (rig-c/exam): a
 * change to one is a new comment on the issue first, then a change here and in
 * the README together.
 *
 * A finding is a run of frames over a measure's bar lasting ≥ 0.15 s (from the
 * first frame's time to the end of the last frame's, as `endOn`), spans merged
 * across a gap of one frame; findings are listed worst first within a measure.
 */
import { isBody18, VIRTUAL, type Body18 } from './joints.ts';
import type { JointMap } from './map.ts';
import type { Joint } from './pose.ts';
import { isObject, parseJson, Problems, Refusal, refuseUnknownKeys, typeName } from './problems.ts';
import { pictureAngle, wrap } from './retarget.ts';
import { runsOf } from './switch.ts';

export const COMPARE_SPEC = 'rig-pose-compare/1';
/** Seconds: two frames are one time base when their times differ by at most this. */
export const TIME_TOLERANCE = 0.001;
/** A run over a bar lasting at least this long, in seconds, is a finding. */
export const FINDING_SECONDS = 0.15;
/** Runs over a bar this many frames apart or fewer merge into one. */
export const FINDING_GAP = 1;

/** The bars, fixed in rig-c/pose#38 before the dancer was measured. */
export const BARS = {
  /** Degrees: |direction difference| of a mapped arm segment over which it is a different arm. */
  armDirection: 20,
  /** Degrees: the same for a mapped leg segment. */
  legDirection: 20,
  /** Degrees: |eye-line tilt difference|. */
  headTilt: 15,
  /** Mean hand-point (or wrist) score: the reference at or above this sees the hand… */
  handSeen: 0.6,
  /** …while the render under this does not. */
  handHidden: 0.4,
  /** Hip widths per frame: the render's ankle moving faster than this… */
  footMoving: 0.05,
  /** …while the reference's is slower than this, is a foot sliding. */
  footStill: 0.02,
  /** The render's range of torso length (or hip height) under this fraction of the reference's: no bounce. */
  bounce: 0.5,
  /** Cloth (#34's bands): lag within the reference's ± this many frames. */
  clothLag: 1.0,
  /** Cloth: swing ratio within the reference's ± this fraction of it. */
  clothSwing: 0.25,
  /** Cloth: overshoot within the reference's ± this, absolute, floored at 0. */
  clothOvershoot: 0.1,
} as const;

/** #34's measure of a skirt's swing (HQ's CRITERIA.md and its `tools/metrics.py`), as ported here. */
export const CLOTH = {
  /** Gaussian smoothing before differentiating: σ in frames, the kernel's half-width in frames. */
  sigma: 1,
  kernel: 4,
  /** The lag search, frames: hem after hip is positive. */
  lagFrom: -6,
  lagTo: 12,
  /** A hip stroke counts from this many reference hip widths (CRITERIA Revision 1: one physical size). */
  stroke: 0.2,
  /** Frames past the last reversal the overshoot looks at, when there is no next one. */
  carryLookahead: 12,
} as const;

export const UNITS = ['head', 'arms', 'body', 'legs', 'cloth'] as const;
export type Unit = (typeof UNITS)[number];
export type Measure = 'tilt' | 'direction' | 'visibility' | 'torsoLength' | 'hipTravel' | 'footPlant' | 'lag' | 'swingRatio' | 'overshoot';
/** What a finding suggests fixing: the rig, the motion, a new drawing, the depth order (#33). Null when not derivable. */
export type FixClass = 'rig' | 'motion' | 'paint' | 'depth';

type Pt = [number, number];
export type Frames = ReadonlyArray<Partial<Record<Body18, Joint>>>;

/** One side of the comparison: its joints per frame, the frame times, and what it is called in a message. */
export interface Side {
  where: string;
  times: readonly number[];
  frames: Frames;
}

/** A set's span from the retarget's report: the frames it shows on and the chains it depicts. */
export interface Span {
  set: string;
  chains: string[];
  frames: [number, number];
}

/** Per frame, the mean score of each hand's 21 points; null where the file has nobody. */
export interface HandScores {
  where: string;
  times: number[];
  r: Array<number | null>;
  l: Array<number | null>;
}

/** A cloth track as read: per frame the hips' midpoint x and the hem's midpoint x, in the subject's own median hip widths. */
export interface ClothTrack {
  where: string;
  /** What the median hip width was measured in, and its value. */
  unit: 'picture px' | 'rig world units';
  hipWidth: number;
  times: number[];
  hip: number[];
  hem: number[];
}
export interface ClothWindow {
  name: string;
  from: number;
  to: number;
}

export interface CompareInput {
  reference: Side;
  render: Side;
  map: JointMap;
  /** The retarget's report's spans, or null when no --retarget-report was given. */
  spans: Span[] | null;
  /** The retarget's scale, rig units per reference picture px (its report's `scale.factor`), or null. */
  retargetScale: number | null;
  hands: { reference: HandScores; render: HandScores } | null;
  cloth: { reference: ClothTrack; render: ClothTrack; windows: ClothWindow[] } | null;
}

export interface Worst {
  frame: number;
  t: number;
  /** The figure the finding is ranked by (see `figureUnit`). */
  figure: number;
  /** The reference's and the render's own reading on that frame (angle, score, speed, range), when the figure is a difference. */
  reference: number | null;
  render: number | null;
}

export interface Finding {
  unit: Unit;
  measure: Measure;
  /** What was measured: `arm_r/sleeve_r1`, `hand_r`, `foot_l`, `eye line`, `torso`, `hip`, a cloth window. */
  subject: string;
  /** The points it was read from (body-18, `mid_hip`, `mid_shoulder`, or the hand's points). */
  points: string[];
  chain: string | null;
  frames: [number, number];
  seconds: number;
  /** Frames of the run over the bar (a merged gap is not). */
  over: number;
  worst: Worst;
  figureUnit: 'deg' | 'score gap' | 'hip widths per frame' | 'range ratio' | 'frames' | 'ratio' | 'fraction of the hip stroke';
  bar: string;
  fix: FixClass | null;
  /** Why that class, or why none. */
  fixWhy: string;
}

export interface MeasureResult {
  measure: Measure;
  /** What the summary line calls it. */
  label: string;
  subjects: string[];
  /** Frames over the bar, summed over its subjects, in runs of any length. */
  overBar: number;
  findings: Finding[];
  /** Why it was not measured, or null. */
  notMeasured: string | null;
  /** Its bar, as the summary line states it. */
  bar: string;
  /** Where its figures came from, when that is a choice the run made (hand points or wrists). */
  source: string | null;
  /** The body unit's ranges, per subject. */
  ranges?: Record<string, { reference: number; render: number }>;
}

export interface ClothFigures {
  lag: number;
  xcorrPeak: number;
  swingRatio: number | null;
  overshoot: number | null;
  strokes: number;
}
export interface ClothWindowResult {
  name: string;
  t: [number, number];
  frames: [number, number];
  reference: ClothFigures;
  render: ClothFigures;
  band: { lag: [number, number]; swingRatio: [number, number] | null; overshoot: [number, number] | null };
}

export interface UnitResult {
  unit: Unit;
  measures: MeasureResult[];
  /** Why the whole unit was not measured, or null. */
  notMeasured: string | null;
}

export interface Comparison {
  frames: number;
  duration: number;
  times: number[];
  /** Median |r_hip − l_hip| per side, picture px: the unit positions are compared in. */
  hipWidth: { reference: number | null; render: number | null };
  /** Median |mid_shoulder − mid_hip| per side, picture px. */
  torso: { reference: number | null; render: number | null };
  units: UnitResult[];
  /** Every finding, units in order, each measure's worst first. */
  findings: Finding[];
  /** Per window both sides' figures and the bands; the stroke threshold on each side (hip widths) and how the render's was carried. */
  cloth: { windows: ClothWindowResult[]; stroke: { reference: number; render: number; carried: string } } | null;
}

// --- readers ---------------------------------------------------------------

export const HANDS_SPEC = 'coco-wholebody-133';
/** COCO-WholeBody's hand points: the subject's left hand 91–111, the right 112–132. */
export const HAND_POINTS = { l: [91, 111], r: [112, 132] } as const;

/**
 * A COCO-WholeBody keypoint file, as HQ's extraction writes it:
 * `{ spec?: "coco-wholebody-133", fps?, width?, height?, source?, frames: [{ t, points: [[x, y, score] × 133] | null }] }`.
 * Only the hands' scores are read.
 */
export function readHands(text: string, where: string): HandScores {
  const doc = parseJson(text, where, 'COMPARE_HANDS_JSON');
  const p = new Problems();
  if (!isObject(doc)) {
    p.add('COMPARE_HANDS', `${where} is ${typeName(doc)}; a hands file is an object { frames: [{ t, points }] }`);
    p.throwIfAny();
  }
  const d = doc as Record<string, unknown>;
  refuseUnknownKeys(p, 'COMPARE_HANDS', where, d, ['spec', 'fps', 'width', 'height', 'source', 'frames']);
  if ('spec' in d && d.spec !== HANDS_SPEC) p.add('COMPARE_HANDS', `${where} "spec" is ${typeName(d.spec)}; this reader reads "${HANDS_SPEC}" (133 points, hands at 91–132)`);
  const out: HandScores = { where, times: [], r: [], l: [] };
  if (!Array.isArray(d.frames) || d.frames.length === 0) {
    p.add('COMPARE_HANDS', `${where} "frames" is ${typeName(d.frames)}; it must be a non-empty array of { t, points }`);
  } else {
    d.frames.forEach((f: unknown, i: number) => {
      const fw = `${where} frames[${i}]`;
      if (!isObject(f) || typeof f.t !== 'number' || !Number.isFinite(f.t)) {
        p.add('COMPARE_HANDS', `${fw} is ${isObject(f) ? `{ t: ${typeName(f.t)} }` : typeName(f)}; a frame is { t: seconds, points }`);
        return;
      }
      refuseUnknownKeys(p, 'COMPARE_HANDS', fw, f, ['t', 'points']);
      out.times.push(f.t);
      if (f.points === null) {
        out.r.push(null);
        out.l.push(null);
        return;
      }
      const pts = f.points;
      if (!Array.isArray(pts) || pts.length !== 133 || !pts.every((q) => Array.isArray(q) && q.length === 3 && q.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
        p.add('COMPARE_HANDS', `${fw} "points" is ${typeName(pts)}${Array.isArray(pts) ? ` of ${pts.length}` : ''}; it must be 133 [x, y, score] triples (COCO-WholeBody), or null`);
        out.r.push(null);
        out.l.push(null);
        return;
      }
      const mean = ([a, b]: readonly [number, number]) => {
        let s = 0;
        for (let k = a; k <= b; k++) s += (pts[k] as number[])[2]!;
        return s / (b - a + 1);
      };
      out.r.push(mean(HAND_POINTS.r));
      out.l.push(mean(HAND_POINTS.l));
    });
  }
  p.throwIfAny();
  return out;
}

export const CLOTH_SPEC = 'rig-c-cloth-track/0';
const CLOTH_TOP = ['spec', 'subject', 'method', 'source', 'fps', 'frames_count', 'units', 'hipWidth', 'origin', 'axes', 'skirtSwing', 'frames'];
const CLOTH_FRAME = ['i', 't', 'hip_x', 'hip_y', 'hip_w', 'tilt_deg', 'hem_mid', 'hem_l', 'hem_r', 'hem_l_y', 'hem_r_y', 'hem_band_cx', 'skirt_cx', 'skirt_top', 'skirt_bottom'];
/** The units a track's median hip width may be stated in. */
export const CLOTH_UNITS = ['picture px', 'rig world units'] as const;

/**
 * A cloth track, HQ's `rig-c-cloth-track/0` (#34's skirt measure): per frame `{ i, t, hip_x, hip_y, hip_w, tilt_deg,
 * hem_mid, hem_l, hem_r, … }`, every position already divided by the subject's own median hip width, origin at its
 * median mid-hip, x right, y down; `hipWidth: { median, unit }` says what that width was. Only `t`, `hip_x` (the
 * hips' midpoint) and `hem_mid` (the midpoint of the hem's leftmost and rightmost points, #34's hem) are read; the
 * other keys are known and checked to be numbers, and an unknown key is refused.
 */
export function readCloth(text: string, where: string): ClothTrack {
  const doc = parseJson(text, where, 'COMPARE_CLOTH_JSON');
  const p = new Problems();
  if (!isObject(doc)) {
    p.add('COMPARE_CLOTH', `${where} is ${typeName(doc)}; a cloth track (${CLOTH_SPEC}) is an object`);
    p.throwIfAny();
  }
  const d = doc as Record<string, unknown>;
  refuseUnknownKeys(p, 'COMPARE_CLOTH', where, d, CLOTH_TOP);
  if (d.spec !== CLOTH_SPEC) p.add('COMPARE_CLOTH', `${where} "spec" is ${typeName(d.spec)}; --cloth-reference and --cloth-render read "${CLOTH_SPEC}"`);
  let hipWidth = NaN;
  let unit: ClothTrack['unit'] = 'picture px';
  const hw = d.hipWidth;
  if (!isObject(hw) || typeof hw.median !== 'number' || !(hw.median > 0) || !Number.isFinite(hw.median) || typeof hw.unit !== 'string' || !(CLOTH_UNITS as readonly string[]).includes(hw.unit)) {
    p.add('COMPARE_CLOTH', `${where} "hipWidth" is ${JSON.stringify(hw) ?? typeName(hw)}; it must be { median: > 0, unit: ${CLOTH_UNITS.map((u) => `"${u}"`).join(' or ')} }`);
  } else {
    hipWidth = hw.median;
    unit = hw.unit as ClothTrack['unit'];
  }
  const out: ClothTrack = { where, unit, hipWidth, times: [], hip: [], hem: [] };
  if (!Array.isArray(d.frames) || d.frames.length === 0) {
    p.add('COMPARE_CLOTH', `${where} "frames" is ${typeName(d.frames)}; it must be a non-empty array of { i, t, hip_x, hem_mid, … }`);
  } else {
    if ('frames_count' in d && d.frames_count !== d.frames.length) p.add('COMPARE_CLOTH', `${where} "frames_count" is ${typeName(d.frames_count)} and "frames" holds ${d.frames.length}`);
    d.frames.forEach((f: unknown, i: number) => {
      const fw = `${where} frames[${i}]`;
      if (!isObject(f)) {
        p.add('COMPARE_CLOTH', `${fw} is ${typeName(f)}; a frame is { i, t, hip_x, hem_mid, … }`);
        return;
      }
      refuseUnknownKeys(p, 'COMPARE_CLOTH', fw, f, CLOTH_FRAME);
      const bad: string[] = [];
      for (const k of ['t', 'hip_x', 'hem_mid']) if (typeof f[k] !== 'number' || !Number.isFinite(f[k])) bad.push(`"${k}" is ${typeName(f[k])}`);
      for (const k of CLOTH_FRAME) if (k in f && !['t', 'hip_x', 'hem_mid'].includes(k) && (typeof f[k] !== 'number' || !Number.isFinite(f[k]))) bad.push(`"${k}" is ${typeName(f[k])}`);
      if (bad.length > 0) {
        p.add('COMPARE_CLOTH', `${fw}: ${bad.join(', ')}; every value is a finite number (t in seconds, positions in hip widths)`);
        return;
      }
      out.times.push(f.t as number);
      out.hip.push(f.hip_x as number);
      out.hem.push(f.hem_mid as number);
    });
  }
  p.throwIfAny();
  return out;
}

/** The spans of a `rig-pose-report/1` (`switches[].{ set, chains, frames }`), how many frames it ran over, and its `scale.factor` (null when the map had no translate). */
export function readSpans(text: string, where: string): { frames: number; spans: Span[]; scale: number | null } {
  const doc = parseJson(text, where, 'COMPARE_REPORT_JSON');
  const p = new Problems();
  if (!isObject(doc)) {
    p.add('COMPARE_REPORT', `${where} is ${typeName(doc)}; a retarget report (rig-pose-report/1) is an object`);
    p.throwIfAny();
  }
  const d = doc as Record<string, unknown>;
  if (d.spec !== 'rig-pose-report/1') p.add('COMPARE_REPORT', `${where} "spec" is ${typeName(d.spec)}; --retarget-report reads "rig-pose-report/1" (rig-pose retarget --report)`);
  if (!Number.isInteger(d.frames) || (d.frames as number) < 1) p.add('COMPARE_REPORT', `${where} "frames" is ${typeName(d.frames)}; a retarget report states its frame count`);
  const spans: Span[] = [];
  if (!Array.isArray(d.switches)) {
    p.add('COMPARE_REPORT', `${where} "switches" is ${typeName(d.switches)}; it must be the array the retarget wrote (empty when nothing switched)`);
  } else {
    d.switches.forEach((s: unknown, i: number) => {
      const sw = `${where} switches[${i}]`;
      if (!isObject(s) || typeof s.set !== 'string' || !Array.isArray(s.chains) || !s.chains.every((c) => typeof c === 'string')
        || !Array.isArray(s.frames) || s.frames.length !== 2 || !s.frames.every((v) => Number.isInteger(v)) || (s.frames[0] as number) > (s.frames[1] as number)) {
        p.add('COMPARE_REPORT', `${sw} is not { set: string, chains: [string], frames: [first, last] }`);
        return;
      }
      spans.push({ set: s.set, chains: s.chains as string[], frames: [s.frames[0] as number, s.frames[1] as number] });
    });
  }
  p.throwIfAny();
  const sc = isObject(d.scale) && typeof d.scale.factor === 'number' && d.scale.factor > 0 && Number.isFinite(d.scale.factor) ? d.scale.factor : null;
  return { frames: d.frames as number, spans, scale: sc };
}

/** `--cloth-windows`: `t0-t1[,t0-t1…]` in seconds, named A, B, C… in the order given. */
export function parseWindows(text: string): ClothWindow[] | string {
  const out: ClothWindow[] = [];
  const parts = text.split(',');
  for (const [i, part] of parts.entries()) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (m === null) return `"${part}" is not t0-t1 in seconds`;
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (!(to > from)) return `"${part}" does not end after it starts`;
    if (i >= 26) return 'more than 26 windows';
    out.push({ name: String.fromCharCode(65 + i), from, to });
  }
  return out;
}

// --- reading the sides -----------------------------------------------------

/** A point's position on one frame, whatever its score; null when the frame has none. */
export function positionOf(joints: Partial<Record<Body18, Joint>>, name: string): Pt | null {
  if (isBody18(name)) {
    const j = joints[name];
    return j === undefined || j.state === 'missing' || j.at === undefined ? null : j.at;
  }
  const pair = VIRTUAL[name];
  if (pair === undefined) return null;
  const a = positionOf(joints, pair[0]);
  const b = positionOf(joints, pair[1]);
  return a === null || b === null ? null : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** A wrist's score on one frame: 0 when absent or missing (COCO's v = 0), null when it has a position but no score. */
function wristScore(joints: Partial<Record<Body18, Joint>>, name: Body18): number | null {
  const j = joints[name];
  if (j === undefined || j.state === 'missing') return 0;
  return j.score ?? null;
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function medianLength(frames: Frames, a: string, b: string): number | null {
  const ls: number[] = [];
  for (const f of frames) {
    const pa = positionOf(f, a);
    const pb = positionOf(f, b);
    if (pa !== null && pb !== null) ls.push(dist(pa, pb));
  }
  if (ls.length === 0) return null;
  const m = median(ls);
  return m > 1e-9 ? m : null;
}

/** Which unit a mapped segment belongs to: two of one side's shoulder, elbow, wrist (arms) or hip, knee, ankle (legs). */
export function limbOf(a: string, b: string): 'arms' | 'legs' | null {
  const side = (x: string) => (x.startsWith('r_') ? 'r' : x.startsWith('l_') ? 'l' : null);
  if (a === b || side(a) === null || side(a) !== side(b)) return null;
  const pa = a.slice(2);
  const pb = b.slice(2);
  const ARM = ['shoulder', 'elbow', 'wrist'];
  const LEG = ['hip', 'knee', 'ankle'];
  if (ARM.includes(pa) && ARM.includes(pb)) return 'arms';
  if (LEG.includes(pa) && LEG.includes(pb)) return 'legs';
  return null;
}

// --- the comparison --------------------------------------------------------

interface Series {
  /** The figure on each frame, NaN where it is not measured. */
  figure: number[];
  over: boolean[];
  reference: number[];
  render: number[];
}

/** Compare the render with the reference. Refuses (by name) inputs that are not one time base or lack a mapped segment's joints. */
export function compare(input: CompareInput): Comparison {
  const { reference: A, render: B, map } = input;
  const p = new Problems();
  const n = A.frames.length;
  if (B.frames.length !== n) {
    p.add('COMPARE_FRAMES', `the reference ${A.where} has ${n} frame(s) and the render ${B.where} ${B.frames.length}; compare reads one time base — render the motion at the reference's rate, frame for frame`);
  } else {
    sameTimes(p, 'COMPARE_TIMES', A.where, A.times, B.where, B.times);
  }
  if (input.hands !== null) {
    for (const h of [input.hands.reference, input.hands.render]) {
      if (h.times.length !== n) p.add('COMPARE_HANDS_FRAMES', `${h.where} has ${h.times.length} frame(s) and the reference ${A.where} ${n}; a hands file is read frame for frame against its sequence`);
      else sameTimes(p, 'COMPARE_HANDS_TIMES', A.where, A.times, h.where, h.times);
    }
  }
  if (input.cloth !== null) {
    for (const c of [input.cloth.reference, input.cloth.render]) {
      if (c.times.length !== n) p.add('COMPARE_CLOTH_FRAMES', `${c.where} has ${c.times.length} frame(s) and the reference ${A.where} ${n}; a cloth track is read frame for frame against its sequence`);
      else sameTimes(p, 'COMPARE_CLOTH_TIMES', A.where, A.times, c.where, c.times);
    }
  }
  if (input.spans !== null) {
    for (const s of input.spans) {
      if (s.frames[1] >= n) p.add('COMPARE_REPORT', `set "${s.set}"'s span, frames ${s.frames[0]}–${s.frames[1]}, runs past the ${n} frames compared; the retarget report is of another run`);
    }
  }
  // Every mapped arm and leg segment, and its points on both sides.
  const segments: Array<{ unit: 'arms' | 'legs'; chain: string; bone: string; joints: [string, string] }> = [];
  for (const c of map.chains) {
    c.bones.forEach((bone, k) => {
      const joints: [string, string] = [c.joints[k]!, c.joints[k + 1]!];
      const unit = limbOf(joints[0], joints[1]);
      if (unit !== null) segments.push({ unit, chain: c.name, bone, joints });
    });
  }
  const told = new Set<string>();
  for (const s of segments) {
    for (const side of [A, B]) {
      for (const j of s.joints) {
        if (told.has(`${side.where}\u0000${j}`)) continue;
        if (side.frames.some((f) => positionOf(f, j) !== null)) continue;
        told.add(`${side.where}\u0000${j}`);
        p.add('COMPARE_JOINT_MISSING', `chain "${s.chain}" bone "${s.bone}" (${s.joints[0]} → ${s.joints[1]}): "${j}" has a position on no frame of ${side === A ? 'the reference' : 'the render'} ${side.where}; the map's segment cannot be compared`);
      }
    }
  }
  p.throwIfAny();

  const times = [...A.times];
  const endOf = (i: number): number => (i + 1 < n ? times[i + 1]! : n > 1 ? 2 * times[i]! - times[i - 1]! : times[i]!);
  const secondsOf = (run: [number, number]) => Math.round((endOf(run[1]) - times[run[0]]!) * 1e6) / 1e6;
  const duration = secondsOf([0, n - 1]);
  const hipWidth = { reference: medianLength(A.frames, 'r_hip', 'l_hip'), render: medianLength(B.frames, 'r_hip', 'l_hip') };
  const torso = { reference: medianLength(A.frames, 'mid_hip', 'mid_shoulder'), render: medianLength(B.frames, 'mid_hip', 'mid_shoulder') };

  /** Runs over the bar lasting ≥ FINDING_SECONDS, each with its worst frame. */
  const findingsOf = (s: Series, make: (run: [number, number], over: number, worst: Worst) => Finding): Finding[] => {
    const out: Finding[] = [];
    for (const run of runsOf(s.over, FINDING_GAP)) {
      if (secondsOf(run) < FINDING_SECONDS - 1e-9) continue;
      let w = -1;
      let over = 0;
      for (let i = run[0]; i <= run[1]; i++) {
        if (!s.over[i]) continue;
        over++;
        if (w < 0 || s.figure[i]! > s.figure[w]!) w = i;
      }
      out.push(make(run, over, { frame: w, t: times[w]!, figure: s.figure[w]!, reference: s.reference[w]!, render: s.render[w]! }));
    }
    return out;
  };
  const byWorst = (a: Finding, b: Finding) => b.worst.figure - a.worst.figure || a.frames[0] - b.frames[0] || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0);
  const count = (xs: readonly boolean[]) => xs.reduce((k, x) => k + (x ? 1 : 0), 0);

  const angleSeries = (from: string, to: string, bar: number): Series => {
    const s: Series = { figure: [], over: [], reference: [], render: [] };
    for (let i = 0; i < n; i++) {
      const a0 = positionOf(A.frames[i]!, from);
      const a1 = positionOf(A.frames[i]!, to);
      const b0 = positionOf(B.frames[i]!, from);
      const b1 = positionOf(B.frames[i]!, to);
      if (a0 === null || a1 === null || b0 === null || b1 === null || dist(a0, a1) < 1e-9 || dist(b0, b1) < 1e-9) {
        s.figure.push(NaN);
        s.over.push(false);
        s.reference.push(NaN);
        s.render.push(NaN);
        continue;
      }
      const ra = pictureAngle(a0, a1);
      const rb = pictureAngle(b0, b1);
      const d = Math.abs(wrap(rb - ra));
      s.figure.push(d);
      s.over.push(d > bar);
      s.reference.push(ra);
      s.render.push(rb);
    }
    return s;
  };

  // Fix class of a limb direction finding: inside a span of a set depicting its chain → paint; outside every one → rig.
  const directionFix = (chain: string, frame: number): [FixClass | null, string] => {
    if (input.spans === null) {
      const depicting = map.alternates.filter((a) => a.chains.includes(chain)).map((a) => a.name);
      if (depicting.length === 0) return ['rig', `no set of the map depicts chain "${chain}": the art does not show the bone's direction`];
      return [null, `sets ${depicting.map((x) => `"${x}"`).join(', ')} depict chain "${chain}" and no --retarget-report says where they show`];
    }
    const inside = input.spans.find((s) => s.chains.includes(chain) && s.frames[0] <= frame && frame <= s.frames[1]);
    if (inside !== undefined) return ['paint', `frame ${frame} is inside set "${inside.set}"'s span (frames ${inside.frames[0]}–${inside.frames[1]}): its drawing is not this pose`];
    return ['rig', `frame ${frame} is outside every span of a set depicting chain "${chain}": the art does not show the bone's direction`];
  };

  const units: UnitResult[] = [];

  // Head: the eye line's tilt.
  {
    const m: MeasureResult = { measure: 'tilt', label: 'eye-line tilt', subjects: ['eye line'], overBar: 0, findings: [], notMeasured: null, bar: `> ${BARS.headTilt}°`, source: null };
    const s = angleSeries('r_eye', 'l_eye', BARS.headTilt);
    if (s.figure.every((v) => Number.isNaN(v))) m.notMeasured = 'r_eye and l_eye are on no frame of both sides together';
    else {
      m.overBar = count(s.over);
      m.findings = findingsOf(s, (frames, over, worst) => ({
        unit: 'head', measure: 'tilt', subject: 'eye line', points: ['r_eye', 'l_eye'], chain: null, frames, seconds: secondsOf(frames), over, worst,
        figureUnit: 'deg', bar: `> ${BARS.headTilt}°`, fix: null, fixWhy: 'a head tilt names no fix class in #38',
      })).sort(byWorst);
    }
    units.push({ unit: 'head', measures: [m], notMeasured: null });
  }

  // Arms and legs: every mapped segment's direction.
  const directions = (unit: 'arms' | 'legs'): MeasureResult => {
    const bar = unit === 'arms' ? BARS.armDirection : BARS.legDirection;
    const segs = segments.filter((s) => s.unit === unit);
    const m: MeasureResult = { measure: 'direction', label: `direction (${segs.length} segment${segs.length === 1 ? '' : 's'})`, subjects: segs.map((s) => `${s.chain}/${s.bone}`), overBar: 0, findings: [], notMeasured: null, bar: `> ${bar}°`, source: null };
    if (segs.length === 0) m.notMeasured = `the map has no ${unit === 'arms' ? 'arm' : 'leg'} segment (two of one side's ${unit === 'arms' ? 'shoulder, elbow, wrist' : 'hip, knee, ankle'})`;
    for (const sg of segs) {
      const s = angleSeries(sg.joints[0], sg.joints[1], bar);
      m.overBar += count(s.over);
      m.findings.push(...findingsOf(s, (frames, over, worst) => {
        const [fix, fixWhy] = directionFix(sg.chain, worst.frame);
        return { unit, measure: 'direction', subject: `${sg.chain}/${sg.bone}`, points: [...sg.joints], chain: sg.chain, frames, seconds: secondsOf(frames), over, worst, figureUnit: 'deg', bar: `> ${bar}°`, fix, fixWhy };
      }));
    }
    m.findings.sort(byWorst);
    return m;
  };

  // Arms: hand visibility.
  const visibility = (): MeasureResult => {
    const fromHands = input.hands !== null;
    const m: MeasureResult = {
      measure: 'visibility', label: 'hand visibility', subjects: ['hand_r', 'hand_l'], overBar: 0, findings: [], notMeasured: null, bar: `reference ≥ ${BARS.handSeen} while render < ${BARS.handHidden}`,
      source: fromHands ? 'hand points (COCO-WholeBody 91–132)' : 'wrist scores (no --reference-hands/--render-hands; the hand points were not read)',
    };
    for (const side of ['r', 'l'] as const) {
      const wrist: Body18 = side === 'r' ? 'r_wrist' : 'l_wrist';
      const scoreA = (i: number) => (fromHands ? input.hands!.reference[side][i]! : wristScore(A.frames[i]!, wrist));
      const scoreB = (i: number) => (fromHands ? input.hands!.render[side][i]! : wristScore(B.frames[i]!, wrist));
      const s: Series = { figure: [], over: [], reference: [], render: [] };
      for (let i = 0; i < n; i++) {
        const a = scoreA(i);
        const b = scoreB(i);
        if (a === null || b === null) {
          s.figure.push(NaN);
          s.over.push(false);
          s.reference.push(NaN);
          s.render.push(NaN);
          continue;
        }
        s.figure.push(a - b);
        s.over.push(a >= BARS.handSeen && b < BARS.handHidden);
        s.reference.push(a);
        s.render.push(b);
      }
      m.overBar += count(s.over);
      m.findings.push(...findingsOf(s, (frames, over, worst) => ({
        unit: 'arms', measure: 'visibility', subject: `hand_${side}`,
        points: fromHands ? [`wholebody ${HAND_POINTS[side][0]}–${HAND_POINTS[side][1]}`] : [wrist], chain: null, frames, seconds: secondsOf(frames), over, worst,
        figureUnit: 'score gap', bar: `reference ≥ ${BARS.handSeen} while render < ${BARS.handHidden}`, fix: 'depth', fixWhy: 'a hand seen in the video and not in the render is drawn behind something (#33)',
      })));
    }
    m.findings.sort(byWorst);
    return m;
  };
  units.push({ unit: 'arms', measures: [directions('arms'), visibility()], notMeasured: null });

  // Body: torso length and hip height, each over the whole run.
  {
    const ranged = (measure: 'torsoLength' | 'hipTravel', label: string, subject: string, points: string[], valueOf: (side: Side, i: number) => number | null, why: string | null): MeasureResult => {
      const m: MeasureResult = { measure, label, subjects: [subject], overBar: 0, findings: [], notMeasured: why, bar: `render range < ${BARS.bounce} × reference range`, source: null };
      if (why !== null) return m;
      const va = Array.from({ length: n }, (_, i) => valueOf(A, i));
      const vb = Array.from({ length: n }, (_, i) => valueOf(B, i));
      const ga = va.filter((v): v is number => v !== null);
      const gb = vb.filter((v): v is number => v !== null);
      if (ga.length === 0 || gb.length === 0) {
        m.notMeasured = `${points.join(' and ')} on no frame of ${ga.length === 0 ? 'the reference' : 'the render'}`;
        return m;
      }
      const ra = Math.max(...ga) - Math.min(...ga);
      const rb = Math.max(...gb) - Math.min(...gb);
      m.ranges = { [subject]: { reference: ra, render: rb } };
      if (rb < BARS.bounce * ra) {
        const med = median(ga);
        let w = -1;
        for (let i = 0; i < n; i++) if (va[i] !== null && (w < 0 || Math.abs(va[i]! - med) > Math.abs(va[w]! - med))) w = i;
        m.overBar = 1;
        m.findings.push({
          unit: 'body', measure, subject, points, chain: null, frames: [0, n - 1], seconds: duration, over: n,
          worst: { frame: w, t: times[w]!, figure: rb / ra, reference: ra, render: rb },
          figureUnit: 'range ratio', bar: `render range < ${BARS.bounce} × reference range`, fix: 'motion', fixWhy: 'the render does not carry the reference\'s bounce: the motion lacks it',
        });
      }
      return m;
    };
    const torsoOf = (side: Side, i: number) => {
      const med = side === A ? torso.reference : torso.render;
      const a = positionOf(side.frames[i]!, 'mid_hip');
      const b = positionOf(side.frames[i]!, 'mid_shoulder');
      return med === null || a === null || b === null ? null : dist(a, b) / med;
    };
    const hipOf = (side: Side, i: number) => {
      const hw = side === A ? hipWidth.reference : hipWidth.render;
      const a = positionOf(side.frames[i]!, 'mid_hip');
      return hw === null || a === null ? null : a[1] / hw;
    };
    const torsoWhy = torso.reference === null || torso.render === null ? `mid_hip → mid_shoulder has no length on any frame of ${torso.reference === null ? 'the reference' : 'the render'}` : null;
    const hipWhy = hipWidth.reference === null || hipWidth.render === null ? `r_hip → l_hip has no length on any frame of ${hipWidth.reference === null ? 'the reference' : 'the render'}, so there is no hip width to normalise by` : null;
    units.push({
      unit: 'body',
      measures: [
        ranged('torsoLength', 'torso length', 'torso', ['mid_hip', 'mid_shoulder'], torsoOf, torsoWhy),
        ranged('hipTravel', 'hip vertical travel', 'hip', ['mid_hip'], hipOf, hipWhy),
      ],
      notMeasured: null,
    });
  }

  // Legs: directions, and the foot plant.
  const footPlant = (): MeasureResult => {
    const m: MeasureResult = { measure: 'footPlant', label: 'foot plant', subjects: ['foot_r', 'foot_l'], overBar: 0, findings: [], notMeasured: null, bar: `render > ${BARS.footMoving} while reference < ${BARS.footStill} hip widths/frame`, source: null };
    if (hipWidth.reference === null || hipWidth.render === null) {
      m.notMeasured = `r_hip → l_hip has no length on any frame of ${hipWidth.reference === null ? 'the reference' : 'the render'}, so there is no hip width to measure speed in`;
      return m;
    }
    for (const side of ['r', 'l'] as const) {
      const ankle = side === 'r' ? 'r_ankle' : 'l_ankle';
      const speed = (s: Side, hw: number, i: number): number | null => {
        if (i === 0) return null;
        const a = positionOf(s.frames[i - 1]!, ankle);
        const b = positionOf(s.frames[i]!, ankle);
        return a === null || b === null ? null : dist(a, b) / hw;
      };
      const s: Series = { figure: [], over: [], reference: [], render: [] };
      for (let i = 0; i < n; i++) {
        const a = speed(A, hipWidth.reference, i);
        const b = speed(B, hipWidth.render, i);
        if (a === null || b === null) {
          s.figure.push(NaN);
          s.over.push(false);
          s.reference.push(NaN);
          s.render.push(NaN);
          continue;
        }
        s.figure.push(b);
        s.over.push(b > BARS.footMoving && a < BARS.footStill);
        s.reference.push(a);
        s.render.push(b);
      }
      m.overBar += count(s.over);
      m.findings.push(...findingsOf(s, (frames, over, worst) => ({
        unit: 'legs', measure: 'footPlant', subject: `foot_${side}`, points: [ankle], chain: null, frames, seconds: secondsOf(frames), over, worst,
        figureUnit: 'hip widths per frame', bar: `render > ${BARS.footMoving} while reference < ${BARS.footStill} hip widths per frame`, fix: 'motion', fixWhy: 'the foot is still in the video and slides in the render: the motion moves it',
      })));
    }
    m.findings.sort(byWorst);
    return m;
  };
  units.push({ unit: 'legs', measures: [directions('legs'), footPlant()], notMeasured: null });

  // Cloth.
  let cloth: Comparison['cloth'] = null;
  if (input.cloth === null) {
    units.push({ unit: 'cloth', measures: [], notMeasured: 'no cloth tracks (--cloth-reference and --cloth-render)' });
  } else {
    const { measures, result, why } = compareCloth(input.cloth, input.retargetScale, times, torso, secondsOf);
    cloth = result;
    units.push({ unit: 'cloth', measures, notMeasured: why });
  }

  const findings = units.flatMap((u) => u.measures.flatMap((m) => m.findings));
  return { frames: n, duration, times, hipWidth, torso, units, findings, cloth };
}

function sameTimes(p: Problems, code: string, aw: string, a: readonly number[], bw: string, b: readonly number[]): void {
  const off: string[] = [];
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > TIME_TOLERANCE + 1e-12) {
      k++;
      if (off.length < 5) off.push(`frame ${i}: ${a[i]}s against ${b[i]}s (${(d * 1000).toFixed(2)} ms)`);
    }
  }
  if (k > 0) p.add(code, `${bw} is not on the time base of ${aw}: ${k} frame(s) differ by more than ${TIME_TOLERANCE * 1000} ms — ${off.join('; ')}${k > off.length ? '; …' : ''}`);
}

// --- cloth (#34's three figures) -------------------------------------------

/** HQ's `smooth`: a Gaussian of σ = 1 frame over ±4 frames, the ends padded with the edge value. */
export function gaussSmooth(a: readonly number[]): number[] {
  const K = CLOTH.kernel;
  const g: number[] = [];
  for (let k = -K; k <= K; k++) g.push(Math.exp(-(k * k) / (2 * CLOTH.sigma * CLOTH.sigma)));
  const sum = g.reduce((s, v) => s + v, 0);
  const at = (i: number) => a[Math.min(a.length - 1, Math.max(0, i))]!;
  return a.map((_, i) => {
    let s = 0;
    for (let k = -K; k <= K; k++) s += (g[k + K]! / sum) * at(i + k);
    return s;
  });
}

/** numpy's `gradient`: central differences inside, one-sided at the ends. */
export function gradient(a: readonly number[]): number[] {
  const n = a.length;
  if (n < 2) return a.map(() => 0);
  return a.map((_, i) => (i === 0 ? a[1]! - a[0]! : i === n - 1 ? a[n - 1]! - a[n - 2]! : (a[i + 1]! - a[i - 1]!) / 2));
}

/** The lag (frames, the hem after the hip positive) at the peak of the normalised cross-correlation, refined by a parabola. */
export function xcorrLag(x: readonly number[], y: readonly number[], lo: number = CLOTH.lagFrom, hi: number = CLOTH.lagTo): { lag: number; peak: number } {
  const z = (v: readonly number[]) => {
    const m = v.reduce((s, q) => s + q, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, q) => s + (q - m) * (q - m), 0) / v.length);
    return v.map((q) => (q - m) / (sd + 1e-12));
  };
  const X = z(x);
  const Y = z(y);
  const cs = new Map<number, number>();
  for (let L = lo; L <= hi; L++) {
    let s = 0;
    let k = 0;
    for (let i = Math.max(0, -L); i < X.length && i + L < Y.length; i++) {
      s += X[i]! * Y[i + L]!;
      k++;
    }
    cs.set(L, k > 0 ? s / k : NaN);
  }
  let best = lo;
  for (let L = lo; L <= hi; L++) if (cs.get(L)! > cs.get(best)!) best = L;
  let off = 0;
  if (lo < best && best < hi) {
    const c0 = cs.get(best - 1)!;
    const c1 = cs.get(best)!;
    const c2 = cs.get(best + 1)!;
    const d = c0 - 2 * c1 + c2;
    off = d !== 0 ? (0.5 * (c0 - c2)) / d : 0;
  }
  return { lag: best + off, peak: cs.get(best)! };
}

/** HQ's `reversals`: hip-velocity zero crossings in [f0, f1); a wiggle (two adjacent turns closer than `minexc`) is dropped as a pair. */
export function reversals(hip: readonly number[], f0: number, f1: number, minexc: number): number[] {
  const v = gradient(hip);
  const idx: number[] = [];
  for (let i = f0 + 1; i < f1; i++) {
    if (v[i - 1] === 0 || Math.sign(v[i]!) !== Math.sign(v[i - 1]!)) idx.push(Math.abs(v[i]!) < Math.abs(v[i - 1]!) ? i : i - 1);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < idx.length - 1; k++) {
      if (Math.abs(hip[idx[k + 1]!]! - hip[idx[k]!]!) < minexc) {
        if (k > 0 && k + 2 < idx.length) idx.splice(k, 2);
        else idx.splice(k === 0 ? k + 1 : k, 1);
        changed = true;
        break;
      }
    }
  }
  return idx;
}

/** Python's `round`: half to even. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * #34's three figures over one window [f0, f1) of a hip-x and hem-x series (in hip widths): the lag, the median
 * swing ratio and the median overshoot over the window's hip strokes of at least `minexc`. HQ's `analyse`.
 */
export function clothFigures(hipRaw: readonly number[], hemRaw: readonly number[], f0: number, f1: number, minexc: number): ClothFigures {
  const hip = gaussSmooth(hipRaw);
  const hem = gaussSmooth(hemRaw);
  const n = hem.length;
  const dh = gradient(hip).slice(f0, f1);
  const de = gradient(hem).slice(f0, f1);
  const { lag, peak } = xcorrLag(dh, de);
  const rev = reversals(hip, f0, f1, minexc);
  const Lr = roundHalfEven(lag);
  const clamp = (i: number) => Math.min(n - 1, Math.max(0, i));
  const ratios: number[] = [];
  const carries: number[] = [];
  for (let k = 0; k < rev.length - 1; k++) {
    const r0 = rev[k]!;
    const r1 = rev[k + 1]!;
    const dH = hip[r1]! - hip[r0]!;
    if (Math.abs(dH) < minexc) continue;
    const s = Math.sign(dH);
    ratios.push((hem[clamp(r1 + Lr)]! - hem[clamp(r0 + Lr)]!) / dH);
    const nxt = k + 2 < rev.length ? rev[k + 2]! : Math.min(n - 1, r1 + CLOTH.carryLookahead);
    const end = Math.min(n, r1 + Math.max(2, Math.floor((nxt - r1) / 2)) + 1);
    let carry = -Infinity;
    for (let i = r1; i < end; i++) carry = Math.max(carry, s * (hem[i]! - hem[r1]!));
    carries.push(Math.max(0, carry) / Math.abs(dH));
  }
  return {
    lag,
    xcorrPeak: peak,
    swingRatio: ratios.length > 0 ? median(ratios) : null,
    overshoot: carries.length > 0 ? median(carries) : null,
    strokes: ratios.length,
  };
}

function compareCloth(
  c: NonNullable<CompareInput['cloth']>,
  retargetScale: number | null,
  times: readonly number[],
  torso: Comparison['torso'],
  secondsOf: (run: [number, number]) => number,
): { measures: MeasureResult[]; result: Comparison['cloth']; why: string | null } {
  const n = times.length;
  const mk = (measure: 'lag' | 'swingRatio' | 'overshoot', label: string, bar: string): MeasureResult => ({ measure, label, subjects: c.windows.map((w) => `window ${w.name}`), overBar: 0, findings: [], notMeasured: null, bar, source: null });
  const measures = [
    mk('lag', 'lag', `outside the reference's ± ${BARS.clothLag} frame`),
    mk('swingRatio', 'swing ratio', `outside the reference's ± ${BARS.clothSwing * 100}%`),
    mk('overshoot', 'overshoot', `outside the reference's ± ${BARS.clothOvershoot}, floored at 0`),
  ];
  // The stroke threshold is one physical size, 0.2 reference hip widths (CRITERIA Revision 1), expressed in the
  // render's own hip widths. A render track in rig world units is carried by the retarget's own scale (rig units per
  // reference px); one in picture px by the torso (each side's median mid_hip → mid_shoulder), as the retarget scales the rig.
  const ra = c.reference;
  const rb = c.render;
  let strokeRender: number;
  let carried: string;
  if (ra.unit !== 'picture px') {
    throw new Refusal([{ code: 'COMPARE_CLOTH_UNITS', text: `the reference cloth track ${ra.where} states its hip width in ${ra.unit}; the reference is the video, measured in picture px` }]);
  }
  if (rb.unit === 'rig world units') {
    if (retargetScale === null) {
      throw new Refusal([{ code: 'COMPARE_CLOTH_SCALE', text: `the render cloth track ${rb.where} is in rig world units (hip width ${rb.hipWidth}), and the reference's in picture px; the stroke threshold is carried between them by the retarget's scale, so --retarget-report (with its scale) is needed` }]);
    }
    strokeRender = (CLOTH.stroke * ra.hipWidth * retargetScale) / rb.hipWidth;
    carried = `0.2 × ${ra.hipWidth} px × ${retargetScale.toFixed(5)} rig units/px (the retarget's scale) ÷ ${rb.hipWidth} rig units`;
  } else {
    if (torso.reference === null || torso.render === null) {
      return { measures: [], result: null, why: `mid_hip → mid_shoulder has no length on ${torso.reference === null ? 'the reference' : 'the render'}, and the stroke threshold is carried between the sides by it (CRITERIA Revision 1)` };
    }
    strokeRender = (CLOTH.stroke * (ra.hipWidth / torso.reference)) / (rb.hipWidth / torso.render);
    carried = `0.2 × (${ra.hipWidth} ÷ ${torso.reference.toFixed(2)} px torso) ÷ (${rb.hipWidth} ÷ ${torso.render.toFixed(2)} px torso)`;
  }
  const dts = times.slice(1).map((t, i) => t - times[i]!);
  const fps = dts.length === 0 ? 1 : 1 / median(dts);
  const frameOf = (t: number) => Math.min(n, Math.max(0, Math.round((t - times[0]!) * fps)));
  const windows: ClothWindowResult[] = [];
  const p = new Problems();
  for (const w of c.windows) {
    const f0 = frameOf(w.from);
    const f1 = frameOf(w.to);
    if (f1 - f0 <= CLOTH.lagTo) p.add('COMPARE_CLOTH_WINDOW', `window ${w.name} (${w.from}–${w.to} s) is frames ${f0}–${f1 - 1} of the ${n} compared, ${Math.max(0, f1 - f0)} frame(s); the lag search reaches ${CLOTH.lagTo} frames, so a window needs more than ${CLOTH.lagTo}`);
  }
  p.throwIfAny();
  for (const w of c.windows) {
    const f0 = frameOf(w.from);
    const f1 = frameOf(w.to);
    const fa = clothFigures(ra.hip, ra.hem, f0, f1, CLOTH.stroke);
    const fb = clothFigures(rb.hip, rb.hem, f0, f1, strokeRender);
    const band: ClothWindowResult['band'] = {
      lag: [fa.lag - BARS.clothLag, fa.lag + BARS.clothLag],
      swingRatio: fa.swingRatio === null ? null : [Math.min(fa.swingRatio * (1 - BARS.clothSwing), fa.swingRatio * (1 + BARS.clothSwing)), Math.max(fa.swingRatio * (1 - BARS.clothSwing), fa.swingRatio * (1 + BARS.clothSwing))],
      overshoot: fa.overshoot === null ? null : [Math.max(0, fa.overshoot - BARS.clothOvershoot), fa.overshoot + BARS.clothOvershoot],
    };
    windows.push({ name: w.name, t: [w.from, w.to], frames: [f0, f1 - 1], reference: fa, render: fb, band });
    const frames: [number, number] = [f0, f1 - 1];
    const check = (m: MeasureResult, ref: number | null, ren: number | null, b: [number, number] | null, unit: Finding['figureUnit'], barText: string) => {
      if (ref === null || b === null) {
        m.notMeasured = [m.notMeasured, `window ${w.name}: no hip stroke ≥ ${CLOTH.stroke} hip widths on the reference`].filter((x) => x !== null).join('; ');
        return;
      }
      if (ren === null) {
        m.notMeasured = [m.notMeasured, `window ${w.name}: no hip stroke ≥ ${strokeRender.toFixed(4)} of its hip widths on the render`].filter((x) => x !== null).join('; ');
        return;
      }
      if (ren >= b[0] - 1e-12 && ren <= b[1] + 1e-12) return;
      m.overBar++;
      m.findings.push({
        unit: 'cloth', measure: m.measure, subject: `window ${w.name}`, points: ['hem', 'hip'], chain: null, frames, seconds: secondsOf(frames), over: f1 - f0,
        worst: { frame: f0, t: times[f0]!, figure: Math.abs(ren - ref), reference: ref, render: ren },
        figureUnit: unit, bar: `${barText}: [${b[0].toFixed(3)}, ${b[1].toFixed(3)}]`, fix: 'rig', fixWhy: 'the cloth is the rig\'s physics',
      });
    };
    check(measures[0]!, fa.lag, fb.lag, band.lag, 'frames', `reference ± ${BARS.clothLag} frame`);
    check(measures[1]!, fa.swingRatio, fb.swingRatio, band.swingRatio, 'ratio', `reference ± ${BARS.clothSwing * 100}%`);
    check(measures[2]!, fa.overshoot, fb.overshoot, band.overshoot, 'fraction of the hip stroke', `reference ± ${BARS.clothOvershoot}, floored at 0`);
  }
  for (const m of measures) m.findings.sort((a, b) => b.worst.figure - a.worst.figure || a.frames[0] - b.frames[0]);
  return { measures, result: { windows, stroke: { reference: CLOTH.stroke, render: strokeRender, carried } }, why: null };
}

// --- lines -----------------------------------------------------------------

const deg = (v: number) => `${v.toFixed(1)}°`;
const spanOf = (frames: [number, number], times: readonly number[]): string =>
  frames[0] === frames[1] ? `frame ${frames[0]} (t=${times[frames[0]]!.toFixed(3)}s)` : `frames ${frames[0]}–${frames[1]} (t=${times[frames[0]]!.toFixed(3)}–${times[frames[1]]!.toFixed(3)}s)`;

/** A finding's figure as a line reads it. */
export function figureText(f: Finding): string {
  const w = f.worst;
  switch (f.figureUnit) {
    case 'deg':
      return `${deg(w.figure)} (reference ${deg(w.reference!)}, render ${deg(w.render!)})`;
    case 'score gap':
      return `render ${w.render!.toFixed(2)} where the reference is ${w.reference!.toFixed(2)}`;
    case 'hip widths per frame':
      return `render ${w.render!.toFixed(3)} hip widths/frame where the reference is ${w.reference!.toFixed(3)}`;
    case 'range ratio':
      return `render range ${w.render!.toFixed(3)} = ${w.figure.toFixed(2)} × the reference's ${w.reference!.toFixed(3)}`;
    default:
      return `render ${w.render!.toFixed(3)}, reference ${w.reference!.toFixed(3)}`;
  }
}

export function findingLine(f: Finding, times: readonly number[]): string {
  const at = f.unit === 'cloth' ? '' : ` at frame ${f.worst.frame} (t=${f.worst.t.toFixed(3)}s)`;
  const what = f.unit === 'body' ? `${f.subject}: no bounce — ${figureText(f)}`
    : f.unit === 'cloth' ? `${f.subject} — ${figureText(f)}`
      : `${f.subject} (${f.points.join(' → ')}) — worst ${figureText(f)}${at}`;
  const fix = f.fix === null ? `fix: not derivable (${f.fixWhy})` : `fix: ${f.fix} (${f.fixWhy})`;
  return `${f.unit} ${f.measure} ${what}; ${spanOf(f.frames, times)}, ${f.seconds.toFixed(3)}s, ${f.over} frame(s) over the bar ${f.bar}; ${fix}`;
}

/** One line per unit: its findings, each measure's worst figure, and the frames over the bar. */
export function summaryLine(u: UnitResult, times: readonly number[]): string {
  const k = u.measures.reduce((s, m) => s + m.findings.length, 0);
  const head = `${k} finding${k === 1 ? '' : 's'}`;
  if (u.notMeasured !== null) return `${head} — not measured: ${u.notMeasured}`;
  const parts = u.measures.map((m) => {
    const src = m.source === null ? '' : ` from ${m.source}`;
    if (m.notMeasured !== null && m.findings.length === 0 && m.ranges === undefined) return `${m.label}${src}: not measured (${m.notMeasured})`;
    const nm = m.notMeasured === null ? '' : `; not measured: ${m.notMeasured}`;
    if (m.ranges !== undefined) {
      const r = Object.values(m.ranges)[0]!;
      return `${m.label}: ${m.findings.length} finding${m.findings.length === 1 ? '' : 's'}, render range ${r.render.toFixed(3)} against the reference's ${r.reference.toFixed(3)}${r.reference > 0 ? ` (${(r.render / r.reference).toFixed(2)} ×)` : ''}, bar ${m.bar}${nm}`;
    }
    const worst = m.findings[0];
    const w = worst === undefined ? 'worst —' : `worst ${figureText(worst)} on ${worst.subject}${worst.unit === 'cloth' ? '' : ` at frame ${worst.worst.frame} (t=${times[worst.worst.frame]!.toFixed(3)}s)`}`;
    const overText = u.unit === 'cloth' ? `${m.overBar} window(s) over the bar` : `${m.overBar} frame(s) over the bar`;
    return `${m.label}${src}: ${m.findings.length} finding${m.findings.length === 1 ? '' : 's'}, ${w}, ${overText} (${m.bar})${nm}`;
  });
  return `${head} — ${parts.join('; ')}`;
}

/** The comparison as `rig-pose-compare/1` JSON, numbers rounded once here. */
export function writeComparison(c: Comparison, inputs: Record<string, string | null>): string {
  const r = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null);
  const doc = {
    spec: COMPARE_SPEC,
    inputs,
    frames: c.frames,
    duration: c.duration,
    hipWidth: c.hipWidth,
    torso: c.torso,
    rule: { findingSeconds: FINDING_SECONDS, findingGap: FINDING_GAP, timeTolerance: TIME_TOLERANCE },
    bars: BARS,
    units: c.units.map((u) => ({
      unit: u.unit,
      findings: u.measures.reduce((s, m) => s + m.findings.length, 0),
      notMeasured: u.notMeasured,
      measures: u.measures.map((m) => ({
        measure: m.measure,
        subjects: m.subjects,
        source: m.source,
        findings: m.findings.length,
        overBar: m.overBar,
        notMeasured: m.notMeasured,
        bar: m.bar,
        ...(m.ranges !== undefined ? { ranges: m.ranges } : {}),
      })),
    })),
    findings: c.findings.map((f) => ({
      unit: f.unit, measure: f.measure, subject: f.subject, points: f.points, chain: f.chain, frames: f.frames, seconds: f.seconds, over: f.over,
      worst: f.worst, figureUnit: f.figureUnit, bar: f.bar, fix: f.fix, fixWhy: f.fixWhy,
    })),
    cloth: c.cloth,
  };
  return `${JSON.stringify(doc, (_k, v: unknown) => (typeof v === 'number' ? r(v) : v), 2)}\n`;
}
