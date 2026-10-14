/**
 * The retarget: a pose sequence and a joint map, over a rig's setup pose, to one
 * animation in rig-c's motion format. Pure — no file, no clock, no process.
 *
 * Per frame and per mapped bone, the segment the bone carries points somewhere
 * in the picture. Its angle in Spine's world (y up, counter-clockwise; the flip
 * is rig-c's `screenToSpineDegrees`) minus the bone's rest angle (its aim at
 * the setup pose, by rig-c's poser) is how far the bone must turn in the world,
 * `D`. rig-c's `rotate` key ADDS to the setup rotation, and a child with the
 * `normal` inherit mode turns with its parent, so the key is the bone's turn
 * less the turn of the nearest mapped bone above it: `key = D(bone) − D(parent)`.
 * Keys are unwrapped across frames, because the runtime interpolates an angle as
 * a plain number (350 → 10 passes through 180).
 *
 * A chain with `reach` (a trunk from mid_hip) is the one exception to "the
 * bone points along the pose's segment": its bone is aimed from where its
 * origin is posed — the translated bone moved by the hip's travel, and every
 * bone between turned by the nearest mapped bone above it — at the point the
 * pose puts the segment's end, relative to the translated joint and scaled. So
 * the hip and its travel are computed before any bone's target.
 *
 * Smoothing is not done here: the sequence comes cleaned (`clean.ts`, #67 —
 * spikes, occlusion, a per-joint Savitzky–Golay), and its record says how.
 *
 * The short hold (rig-c/pose#22) comes next: a segment whose picture length on
 * a frame is under `short` of its own median length over the sequence is seen
 * end-on, or collapsed by blur, and its picture direction there is noise. Its
 * angle on those frames is not read from the pose but interpolated, the short
 * way round, between the frames either side at or above the cutoff (flat at the
 * ends: `holdShort`). A run under the cutoff lasting ≥ `END_ON_SECONDS` (spans
 * merged across a gap of `END_ON_GAP` frame) is listed as `endOn`: a pose the
 * rig cannot draw, the demand for an alternate drawing (#6).
 *
 * The flip guard (rig-c/pose#15) then spreads a segment's turn greater than
 * `flip` degrees in one frame over the frames around it, linearly and centred on
 * the jump (`spreadFlips`). It reads the mapped segments' target angles after
 * holds and the short hold, and before the hinge check. A reach's
 * target is aimed later, from posed positions, and is neither held short nor
 * guarded.
 *
 * Then the switches (rig-c/pose#6, `switch.ts`): with every target known —
 * reaches included — each alternate set's distance to the pose is read, and the
 * spans each set shows are chosen, each boundary keyed at its window's speed
 * peak (#31). Only then the range clamp: outside the spans
 * of a set depicting its chain, a bone whose rotate key would leave its
 * `range` is clamped at the limit (its target becomes the clamped world angle),
 * in depth order, so a bone below takes the clamped parent into its own key
 * and still follows the pose; a reach below is aimed again from where the
 * clamped bones put its origin. Every overflow is listed as `range` demand.
 * Inside a span nothing is clamped, but a bone with a `drawn` angle is read
 * against it (`artTurn`, and `artRange` where it leaves its range).
 *
 * With `raisedByHead` (rig-c/pose#62), after the range clamp and before the art
 * turn is read: inside each span of a set that draws an arm raised, the arm is
 * solved last, so its wrist lands where the reference's is against the head, in
 * eye distances (each side's median over the span). The head and the shoulder
 * are posed from the final targets of the bones above. A target out of reach
 * goes to the reach limit along the head-relative direction (REACH); the set's
 * `turn` is part of the solve, and only a forearm it still holds is ART-RANGE.
 * A set with `place: "by-hip"` (rig-c/pose#93) gets the same solve against the
 * hip, in the same pass: each of its chains whose key skeleton puts the wrist
 * within one hip width of the mid-hip lands where the reference's wrist is from
 * its mid-hip, in hip widths.
 *
 * The lines across the body — hips, shoulders, eyes — are read from the pose
 * after holds, whether the map uses them or not: a line under
 * `TURN_FRACTION` of its median picture length, or reversed (pointing more
 * than 90° from the subject's right to left), for ≥ `TURN_SECONDS`, is a `TURN`:
 * the body or head turned, a pose a flat rig cannot draw. It changes no key.
 *
 * What this cannot know is held to account afterwards: `verify.ts` poses the
 * gated build with rig-c's poser and measures where each bone landed.
 */
import { screenToSpineDegrees } from 'rig-c/transform';
import type { Body18 } from './joints.ts';
import { isBody18, VIRTUAL } from './joints.ts';
import type { Chain, JointMap, Rest, RigSlots } from './map.ts';
import { aimAngle, aimEnds, descends, partBone, pointParts, rigPoint } from './map.ts';
import type { Joint, Travel } from './pose.ts';
import { TRAVEL_IN_PLACE } from './pose.ts';
import { Problems, Refusal } from './problems.ts';
import type { ArtRange, ByHip, Raised, ReachShort, SlotTrack, Switch, SwitchOptions } from './switch.ts';
import { clampArt, coveredChains, isRaised, measureArt, overflow, RANGE_SLACK, reachLimit, runsOf, selectSwitches, twoBone } from './switch.ts';
import type { BlendHold, Closure, Feet, Floor, LegScale, PathPose, Posing, Side, Stance } from './legs.ts';
import { holdBlend, isLegSegment, legScaleOf, legsOf, pathFrom, plantHip, posePath, rootOf, SIDES, stanceOf, stanceRangeOf, supportsOf, tipOf } from './legs.ts';

const DEG = 180 / Math.PI;

/**
 * --raised-by-head (#62): a held upper arm whose re-aimed forearm leaves the
 * wrist farther than this from its placed point, in eye distances, "cannot
 * reach within turn" — ART-RANGE. It sits at the float and rounding scale, so
 * any real miss counts: the solve itself closes to ~1e-12, and the writer's
 * 0.001° rounding of two keys moves a wrist by ≤ 2 × 1.75e-5 × (l0 + l1), which
 * is 0.0004 eye distances on the tests' stick rig (a 130-unit arm, 12-unit eyes).
 */
export const HELD_MISS = 0.01;

export interface RetargetOptions extends SwitchOptions {
  /** A joint with a score below this is not good on that frame (a joint with no score is). */
  minScore: number;
  /** What a hinge bent the wrong way does: refuse the run, or straighten that hinge on that frame. */
  bends: 'refuse' | 'clamp';
  /** Degrees past straight a hinge may bend the wrong way before it counts. */
  bendTolerance: number;
  /** A segment turning more than this many degrees in one frame is spread (`spreadFlips`); 'off' keeps every turn. */
  flip: number | 'off';
  /** A segment shorter in the picture than this fraction of its median length has its angle held there (`holdShort`); 'off' reads every frame. */
  short: number | 'off';
  /** Leg segments scaled along their x axis by picture length over straight length, clamped to [min, max] (`legs.ts`); 'off' (the default) scales nothing. */
  legScale?: [number, number] | 'off';
  /** The hip derived from the supporting foot (`legs.ts`); false (the default) moves it by the pose's travel. */
  plantFeet?: boolean;
  /** With plantFeet: a free ankle within this many leg lengths of the floor plants both feet, its leg stretched to reach it (`legs.ts` stanceOf, #60); 'off' (the default) plants one. */
  stance?: number | 'off';
  /** With plantFeet: the floor's world y every support span is planted on (#85); absent, the median of the spans' planted heights. */
  floor?: number;
  /** While a set whose arm is drawn raised shows, its wrist is placed against the rig's head in eye distances (rig-c/pose#62); false (the default) keeps the pose's angles. */
  raisedByHead?: boolean;
  /** The sequence's `travel` (rig-c/pose#92): "in-place" makes --plant-feet let the supporting foot follow its own track and close the loop; absent, nothing changes. */
  travel?: Travel;
}

export interface Hold {
  point: string;
  /** First and last frame index held. */
  from: number;
  to: number;
  /** The frame whose value was used. */
  source: number;
  why: string;
}

export interface BendEvent {
  chain: string;
  joint: string;
  frame: number;
  t: number;
  /** The inner angle found, degrees, Spine's sense (counter-clockwise +). */
  angle: number;
  /** The side the hinge may bend: +1 counter-clockwise, −1 clockwise. */
  side: 1 | -1;
  rest: number;
}

/** One spread: a segment's turn over the threshold, and the frames whose angle was replaced. */
export interface Flip {
  chain: string;
  bone: string;
  /** The segment the bone carries: from joint, to joint. */
  joints: [string, string];
  /** The largest input turn in the spread, degrees, signed (Spine's sense, counter-clockwise +). */
  jump: number;
  /** Every input turn over the threshold the spread covers: `frame` is k, the turn is from frame k−1 to k. */
  turns: Array<{ frame: number; jump: number }>;
  /** First and last frame whose angle was replaced; the frames either side keep the input's. */
  frames: [number, number];
  /** The half-width the spread needed (for spreads merged from neighbouring turns, the widest). */
  h: number;
  /** The one-frame turn across the spread, degrees, signed. */
  step: number;
  /** Which end of the series cut the window short, if one did. */
  clipped: 'start' | 'end' | 'both' | null;
}

/**
 * One span of frames under `--short` (angle interpolated, `holdShort`) or under
 * `SHORT_STEP_FRACTION` with a one-frame step over `SHORT_STEP_CAP` (step
 * capped, `capShortSteps`, #110).
 */
export interface Short {
  chain: string;
  bone: string;
  /** The segment the bone carries: from joint, to joint. */
  joints: [string, string];
  /** First and last frame whose angle was replaced; the frames either side keep the input's. */
  frames: [number, number];
  /** The lowest picture length on those frames, as a fraction of the segment's median picture length. */
  minFraction: number;
  /** Present when a foreshortened segment (< `SHORT_STEP_FRACTION`) had its per-frame step capped (#110): the one-frame step after capping and the largest step asked, degrees, signed. */
  step?: number;
  asked?: number;
}

/** A limb segment shorter than this fraction of its median picture length has its per-frame angle step capped at `SHORT_STEP_CAP` degrees (rig-c/pose#110). */
export const SHORT_STEP_FRACTION = 0.6;
export const SHORT_STEP_CAP = 30;

/**
 * A segment under the short cutoff long enough to be a pose (the limb pointing
 * at the camera), not a blur: short spans merged across a gap of `END_ON_GAP`
 * frame, lasting ≥ `END_ON_SECONDS`. The demand for an alternate drawing (#6).
 */
export interface EndOn {
  chain: string;
  bone: string;
  joints: [string, string];
  /** First and last frame of the merged run (a gap frame inside it is at or above the cutoff). */
  frames: [number, number];
  /** How long it lasts: from the first frame's key time to the end of the last frame (the next frame's key time; for the pose's last frame, one frame on). */
  seconds: number;
  minFraction: number;
}

/** A run under the short cutoff lasting at least this long, in seconds, is listed as `endOn` (rig-c/pose#22). */
export const END_ON_SECONDS = 0.15;
/** Short spans this many frames apart or fewer merge into one `endOn` run. */
export const END_ON_GAP = 1;

export interface MotionKey {
  t: number;
  v: number[];
  /** `stepped`: the value holds until the next key (the offsets' translate keys). */
  ease?: 'stepped';
  /** A raw Bézier to the next key: four absolute (time, value) numbers per channel (`--reduce`, #32). */
  curve?: number[];
}
export interface MotionTrack {
  bone: string;
  property: 'rotate' | 'translate' | 'scalex';
  keys: MotionKey[];
}
export interface Animation {
  duration: number;
  /** The bone tracks, then any slot `attachment` tracks the switches add (`switch.ts`). */
  tracks: Array<MotionTrack | SlotTrack>;
}

/** A line across the body turned: short in the picture, or reversed, long enough to be a pose (the demand for a turned-body drawing). */
export interface Turn {
  /** `hip`, `shoulder` or `eye`. */
  line: string;
  /** The subject's right joint, then its left twin. */
  joints: [string, string];
  /** First and last frame of the run (merged across a gap of `TURN_GAP` frame). */
  frames: [number, number];
  seconds: number;
  /** The lowest picture length on the run's turned frames, as a fraction of the line's median. */
  minFraction: number;
  /** Whether the line points from the right joint to the left more than 90° off the subject's right-to-left on any frame of the run. */
  reversed: boolean;
}

/** A bone's rotate key past its range outside every span of a set depicting its chain: clamped there, and the demand for an alternate. */
export interface RangeDemand {
  chain: string;
  bone: string;
  /** First and last frame of the run (merged across a gap of one frame; a gap frame inside is within range or inside a span). */
  frames: [number, number];
  seconds: number;
  /** Degrees past the range, the most on any frame of the run. */
  maxOverflow: number;
  /** The rotate key the pose asked for on that frame, degrees relative to setup, before the clamp. */
  key: number;
  /** The bone's range, degrees. */
  limits: [number, number];
}

/** The lines across the body a `TURN` is read on: the subject's right joint, then its left twin. */
export const TURN_LINES: ReadonlyArray<[string, string, string]> = [['hip', 'r_hip', 'l_hip'], ['shoulder', 'r_shoulder', 'l_shoulder'], ['eye', 'r_eye', 'l_eye']];
/** A line shorter in the picture than this fraction of its median is turned (rig-c/pose#6: between the front-facing dance's floor, 0.81, and a side-on body's 0.17–0.49). */
export const TURN_FRACTION = 0.5;
/** A turned run lasting at least this long, in seconds, is listed (as `endOn`). */
export const TURN_SECONDS = 0.15;
/** Turned spans this many frames apart or fewer merge into one run. */
export const TURN_GAP = 1;
/** Range overflow and art-range spans this many frames apart or fewer merge into one run. */
export const RANGE_GAP = 1;

export interface Retarget {
  animation: Animation;
  /** Key times, seconds from the first frame, as written. */
  times: number[];
  /** Per mapped bone, the world angle (Spine degrees) its aim must reach on each frame. */
  targets: Map<string, number[]>;
  /** The translated bone's world origin on each frame, when the map translates one. */
  origin: { bone: string; at: Array<[number, number]> } | null;
  holds: Hold[];
  bends: BendEvent[];
  /** The short hold's spans, per segment in map order. */
  short: Short[];
  /** The short runs long enough to be a pose seen end-on. */
  endOn: EndOn[];
  flips: Flip[];
  /** The figure scale, rig units per picture pixel, and the lengths it came from. */
  scale: { factor: number; pose: number; rig: number } | null;
  /** The spans each alternate set shows, with their art turn. */
  switches: Switch[];
  /** Per switched or hidden slot, what it shows on each frame (null: nothing). */
  shown: Map<string, Array<string | null>>;
  /** Per set, its distance to the pose on each frame, degrees. */
  distances: Map<string, number[]>;
  /** The lines across the body turned long enough to be a pose. */
  turns: Turn[];
  /** The lines across the body that could not be read, and why. */
  turnsUnread: Array<{ line: string; joints: [string, string]; why: string }>;
  /** Every run a bone's key was clamped at its range. */
  range: RangeDemand[];
  /** Every run a bone inside a span turned from its drawn angle past its range. */
  artRange: ArtRange[];
  /** With --leg-scale: each leg segment's scale, straight length and clamped runs. */
  legScale: LegScale[];
  /** Per scaled bone, the scale its x axis must reach on each frame (relative to setup); the scalex key of a bone under a scaled bone differs from it. */
  scales: Map<string, number[]>;
  /** The supports and jumps read off the reference ankles, when the map has both legs (whether or not --plant-feet used them). */
  feet: Feet | null;
  /** Whether the hip was derived from the supporting foot. */
  planted: boolean;
  /** With --stance: the frames planted both and lifted, and the free leg's stretch (#60). */
  stance: Stance | null;
  /** With --plant-feet: the one floor every support span was planted on, and each span's shift onto it (#85). */
  floor: Floor | null;
  /** With --plant-feet: the supporting leg stretched on the blend frames so its ankle stays on the floor (#85). */
  blendHold: BlendHold | null;
  /** With --plant-feet on an in-place sequence: the hip's x drift closed over the loop (#92). */
  closure: Closure | null;
  /** Each ankle's world position on every frame, as the keys put it, when legs are scaled or feet planted. */
  ankles: { bones: Record<Side, string>; at: Record<Side, Pt[]> } | null;
  /** The translated bone's origin against its thigh roots' midpoint, at setup. */
  pivot: Pivot | null;
  /** With --raised-by-head: each raised set's span on each raised chain, its wrist placed against the head. */
  raised: Raised[];
  /** Each span of a `place: "by-hip"` set on each chain it places, its wrist placed against the hip (#93). */
  byHip: ByHip[];
}

/** The hip's pivot against the thigh roots, at setup (rig-c/pose#47). */
export interface Pivot {
  bone: string;
  roots: [string, string];
  /** Hip origin − the roots' midpoint, world units. */
  offset: Pt;
  distance: number;
  /** The distance in hip widths (the roots' distance apart). */
  hipWidths: number;
}

type Pt = [number, number];

/** The value of a point on one frame, or why it is not good. */
export function pointOn(joints: Partial<Record<Body18, Joint>>, name: string, minScore: number): Pt | string {
  if (isBody18(name)) {
    const j = joints[name];
    if (j === undefined || j.state === 'missing') return 'missing';
    if (j.at === undefined) return `${j.state} without a position`;
    if (j.score !== undefined && j.score < minScore) return `score ${j.score.toFixed(3)} < ${minScore}`;
    return j.at;
  }
  const pair = VIRTUAL[name];
  if (pair === undefined) return 'not a point';
  const a = pointOn(joints, pair[0], minScore);
  const b = pointOn(joints, pair[1], minScore);
  if (typeof a === 'string') return `${pair[0]} ${a}`;
  if (typeof b === 'string') return `${pair[1]} ${b}`;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

export function wrap(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Spine world degrees of a picture-space direction (y down). */
export function pictureAngle(from: Pt, to: Pt): number {
  return screenToSpineDegrees(Math.atan2(to[1] - from[1], to[0] - from[0]) * DEG);
}

/** The rest angle of a mapped bone's aim, Spine world degrees, from rig-c's setup pose. */
export function restAngle(rest: Rest, bone: string, aim: string): number {
  return aimAngle(rest, new Map([...rest].map(([n, b]) => [n, b.length])), bone, aim);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const r3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
/** A scale key: to 1e-6, so its rounding moves an ankle 500 units out by at most 0.00025. */
const r6 = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

/** The translated bone's origin against the midpoint of the two legs' first bones, at setup. */
function pivotOf(rest: Rest, bone: string | null, legs: ReturnType<typeof legsOf> | null): Pivot | null {
  if (bone === null || legs === null || !('legs' in legs)) return null;
  const roots: [string, string] = [legs.legs.r.chain.bones[0]!, legs.legs.l.chain.bones[0]!];
  const a = rest.get(roots[0])!;
  const b = rest.get(roots[1])!;
  const h = rest.get(bone)!;
  const offset: Pt = [h.worldX - (a.worldX + b.worldX) / 2, h.worldY - (a.worldY + b.worldY) / 2];
  const width = Math.hypot(b.worldX - a.worldX, b.worldY - a.worldY);
  const distance = Math.hypot(offset[0], offset[1]);
  return { bone, roots, offset, distance, hipWidths: width > 1e-9 ? distance / width : NaN };
}

/**
 * Retarget. Refuses (every reason at once) when a point the map needs is never
 * good, when a hinge's side cannot be read off a straight rest, and — with
 * `bends: 'refuse'` — when a hinge bends the wrong way.
 */
export function retarget(rest: Rest, map: JointMap, frames: ReadonlyArray<Partial<Record<Body18, Joint>>>, times: readonly number[], opts: RetargetOptions, slots: RigSlots = new Map()): Retarget {
  const p = new Problems();
  const n = frames.length;
  const t0 = times[0]!;
  const keyTimes = times.map((t) => Math.round((t - t0) * 1e6) / 1e6);
  for (let i = 1; i < n; i++) {
    if (keyTimes[i]! <= keyTimes[i - 1]!) p.add('POSE_TIME', `frames ${i - 1} and ${i} are ${keyTimes[i - 1]}s and ${keyTimes[i]}s after rounding to the microsecond; keys must strictly increase`);
  }
  /** The end of frame i: the next frame's key time; the last frame lasts as long as the one before it. */
  const endOf = (i: number): number => (i + 1 < n ? keyTimes[i + 1]! : n > 1 ? 2 * keyTimes[i]! - keyTimes[i - 1]! : keyTimes[i]!);
  const secondsOf = (run: [number, number]): number => Math.round((endOf(run[1]) - keyTimes[run[0]]!) * 1e6) / 1e6;

  // --raised-by-head (#62) measures against the head in eye distances: the map's head chain must carry the
  // eye line with an "a>b" aim, whose two ends are the rig's eyes.
  const head = opts.raisedByHead === true ? headOf(map) : null;
  if (head !== null && 'problem' in head) p.add('RAISED_HEAD', head.problem);
  // `place: "by-hip"` (#93) measures against the hip in hip widths: the map must name the rig's two hip points.
  const hips = map.alternates.some((a) => a.place !== undefined && a.place !== null) ? hipOf(map) : null;
  if (hips !== null && 'problem' in hips) p.add('PLACE_HIP', hips.problem);

  // Every point the map reads, held where it is not good.
  const needed = new Set<string>();
  for (const c of map.chains) c.joints.forEach((j) => needed.add(j));
  if (map.translate !== null) {
    needed.add(map.translate.joint);
    map.translate.scale.pose.forEach((j) => needed.add(j));
  }
  const series = new Map<string, Pt[]>();
  const good = new Map<string, boolean[]>();
  const holds: Hold[] = [];
  /** A point held where it is not good; or why it is good on no frame. */
  const heldOf = (name: string): { at: Pt[]; good: boolean[]; holds: Hold[] } | { never: string } => {
    const raw = frames.map((f) => pointOn(f, name, opts.minScore));
    const firstGood = raw.findIndex((v) => typeof v !== 'string');
    if (firstGood < 0) return { never: [...new Set(raw as string[])].slice(0, 3).join('; ') };
    const out: Pt[] = [];
    const spans: Hold[] = [];
    let last = firstGood;
    let span: Hold | null = null;
    for (let i = 0; i < n; i++) {
      const v = raw[i]!;
      if (typeof v !== 'string') {
        out.push(v);
        last = i;
        span = null;
        continue;
      }
      out.push(raw[last]! as Pt);
      if (span !== null && span.source === last && span.why === v) span.to = i;
      else {
        span = { point: name, from: i, to: i, source: last, why: v };
        spans.push(span);
      }
    }
    return { at: out, good: raw.map((v) => typeof v !== 'string'), holds: spans };
  };
  for (const name of [...needed].sort()) {
    const h = heldOf(name);
    if ('never' in h) {
      p.add('POSE_POINT_NEVER_GOOD', `point "${name}" is good on none of the ${n} frames (${h.never}); the map needs it, and there is no value to hold`);
      continue;
    }
    holds.push(...h.holds);
    series.set(name, h.at);
    good.set(name, h.good);
  }
  p.throwIfAny();

  // TURN: the lines across the body, read from the pose (held as the
  // map's points are, whether or not the map uses them). A reading; no key moves.
  const turns: Turn[] = [];
  const turnsUnread: Retarget['turnsUnread'] = [];
  for (const [line, a, b] of TURN_LINES) {
    const ends: Pt[][] = [];
    for (const j of [a, b]) {
      const known = series.get(j);
      if (known !== undefined) ends.push(known);
      else {
        const h = heldOf(j);
        if ('never' in h) {
          turnsUnread.push({ line, joints: [a, b], why: `${j} is good on none of the ${n} frames (${h.never})` });
          break;
        }
        ends.push(h.at);
      }
    }
    if (ends.length < 2) continue;
    const [A, B] = ends as [Pt[], Pt[]];
    const lengths = A.map((f, i) => Math.hypot(B[i]![0] - f[0], B[i]![1] - f[1]));
    const med = median(lengths);
    if (med < 1e-6) {
      turnsUnread.push({ line, joints: [a, b], why: `its median picture length is ${med}px; a fraction of it is not a measure` });
      continue;
    }
    const fraction = lengths.map((l) => l / med);
    const reversed = A.map((f, i) => lengths[i]! > 1e-9 && Math.abs(pictureAngle(f, B[i]!)) > 90);
    const turned = fraction.map((f, i) => f < TURN_FRACTION || reversed[i]!);
    for (const run of runsOf(turned, TURN_GAP)) {
      const seconds = secondsOf(run);
      if (seconds < TURN_SECONDS - 1e-9) continue;
      let minFraction = Infinity;
      let rev = false;
      for (let i = run[0]; i <= run[1]; i++) {
        if (!turned[i]) continue;
        minFraction = Math.min(minFraction, fraction[i]!);
        rev ||= reversed[i]!;
      }
      turns.push({ line, joints: [a, b], frames: run, seconds, minFraction, reversed: rev });
    }
  }

  // The hip: the travel of one point, scaled, in its parent's axes. It comes
  // first, because a reach is aimed from where the hip has put its bone.
  let origin: Retarget['origin'] = null;
  let scale: Retarget['scale'] = null;
  let translateTrack: MotionTrack | null = null;
  /** The translated bone's world travel from its setup origin, per frame. */
  const travel: Pt[] = [];
  const t = map.translate;
  if (t !== null) {
    const [pa, pb] = t.scale.pose;
    const ga = good.get(pa)!;
    const gb = good.get(pb)!;
    const lengths: number[] = [];
    const A = series.get(pa)!;
    const B = series.get(pb)!;
    for (let i = 0; i < n; i++) if (ga[i] && gb[i]) lengths.push(Math.hypot(B[i]![0] - A[i]![0], B[i]![1] - A[i]![1]));
    const [ra, rb] = t.scale.rig.map((r) => rigPoint(rest, r)!) as [Pt, Pt];
    const rigLen = Math.hypot(rb[0] - ra[0], rb[1] - ra[1]);
    if (lengths.length === 0) p.add('POSE_SCALE', `"translate" "scale.pose" ${pa} → ${pb} is good on no frame where both points are; the figure scale cannot be measured`);
    else {
      const poseLen = median(lengths);
      if (poseLen < 1e-6) p.add('POSE_SCALE', `"translate" "scale.pose" ${pa} → ${pb} has median length ${poseLen}px; the figure scale cannot be measured`);
      else {
        const s = rigLen / poseLen;
        scale = { factor: s, pose: poseLen, rig: rigLen };
        const P = series.get(t.joint)!;
        for (let i = 0; i < n; i++) {
          const wx = (P[i]![0] - P[0]![0]) * s;
          const wy = -(P[i]![1] - P[0]![1]) * s;
          travel.push([wx, wy]);
        }
      }
    }
  }
  p.throwIfAny();
  /** The pose's own travel of the hip, world, before --plant-feet replaces it. */
  const poseTravel: Pt[] = travel.map((v) => [v[0], v[1]]);

  // Each mapped bone's target world angle per frame, reaches last.
  const targets = new Map<string, number[]>();
  const restOf = new Map<string, number>();
  for (const c of map.chains) {
    c.bones.forEach((b, k) => {
      restOf.set(b, restAngle(rest, b, c.aim[k]!));
      if (c.reach) return;
      const from = series.get(c.joints[k]!)!;
      const to = series.get(c.joints[k + 1]!)!;
      const angles: number[] = [];
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(to[i]![0] - from[i]![0], to[i]![1] - from[i]![1]);
        angles.push(d > 1e-9 ? pictureAngle(from[i]!, to[i]!) : (angles[i - 1] ?? NaN));
      }
      fillLeading(angles, () => p.add('POSE_SEGMENT_ZERO', `chain "${c.name}" — bone "${b}"'s segment ${c.joints[k]} → ${c.joints[k + 1]} has zero length on every frame; it has no direction`));
      targets.set(b, angles);
    });
  }
  p.throwIfAny();

  // The short hold, on every limb segment the pose aims directly (not a reach, and
  // not a line across the body from a left joint to its right twin — the hip line,
  // the eye line — whose shortening is the body or head turning, not a limb seen
  // end-on; #22's cutoff was measured on limb segments only): its picture length
  // against its own median, on the points the angle was read from.
  const short: Short[] = [];
  const endOn: EndOn[] = [];
  const fractions = new Map<string, { chain: string; joints: [string, string]; fraction: number[] }>();
  if (opts.short !== 'off') {
    const cutoff = opts.short;
    for (const c of map.chains) {
      if (c.reach) continue;
      c.bones.forEach((b, k) => {
        const joints: [string, string] = [c.joints[k]!, c.joints[k + 1]!];
        if (isAcross(joints[0], joints[1])) return;
        const from = series.get(joints[0])!;
        const to = series.get(joints[1])!;
        const lengths = from.map((f, i) => Math.hypot(to[i]![0] - f[0], to[i]![1] - f[1]));
        const med = median(lengths);
        if (med < 1e-6) {
          p.add('POSE_SHORT_MEDIAN', `chain "${c.name}" — bone "${b}"'s segment ${joints[0]} → ${joints[1]} has median picture length ${med}px over the ${n} frames; --short measures a frame's length against that median, and there is none to measure against`);
          return;
        }
        const fraction = lengths.map((l) => l / med);
        fractions.set(b, { chain: c.name, joints, fraction });
        const spans = holdShort(targets.get(b)!, fraction, cutoff);
        for (const s of spans) short.push({ chain: c.name, bone: b, joints, ...s });
        for (const run of mergeRuns(spans, END_ON_GAP)) {
          const seconds = Math.round((endOf(run.frames[1]) - keyTimes[run.frames[0]]!) * 1e6) / 1e6;
          if (seconds >= END_ON_SECONDS - 1e-9) endOn.push({ chain: c.name, bone: b, joints, frames: run.frames, seconds, minFraction: run.minFraction });
        }
      });
    }
  }
  p.throwIfAny();

  // The flip guard, on every segment the pose aims directly (not a reach).
  const flips: Flip[] = [];
  if (opts.flip !== 'off') {
    const threshold = opts.flip;
    for (const c of map.chains) {
      if (c.reach) continue;
      c.bones.forEach((b, k) => {
        for (const s of spreadFlips(targets.get(b)!, threshold)) {
          flips.push({ chain: c.name, bone: b, joints: [c.joints[k]!, c.joints[k + 1]!], ...s });
        }
      });
    }
  }

  // Hinges: each joint strictly inside a chain (a reach has one bone, so none).
  const bends: BendEvent[] = [];
  for (const c of map.chains) {
    for (let k = 1; k < c.bones.length; k++) checkHinge(c, k, targets, restOf, keyTimes, opts, bends, p);
  }
  if (opts.bends === 'refuse' && bends.length > 0) {
    for (const e of bends) p.add('POSE_BEND_ONE_WAY', bendLine(e));
  }
  p.throwIfAny();

  // The legs (#47): each leg segment's scale, the supports and jumps, and with
  // --plant-feet the hip derived from the supporting foot — before the reaches,
  // which are aimed from where the hip is.
  const legScaleOn = opts.legScale !== undefined && opts.legScale !== 'off';
  const plantOn = opts.plantFeet === true;
  /** #92: an in-place sequence under --plant-feet — the supporting foot follows its own track, no step releases, the loop closed. */
  const inPlace = plantOn && opts.travel === TRAVEL_IN_PLACE;
  let closure: Closure | null = null;
  const legScale: LegScale[] = [];
  const scales = new Map<string, number[]>();
  let stance: Stance | null = null;
  let floor: Floor | null = null;
  let blendHold: BlendHold | null = null;
  let feet: Feet | null = null;
  let legs: ReturnType<typeof legsOf> | null = null;
  let legPath: string[] | null = null;
  let legTop: string | null = null;
  const restTurn = (b: string, i: number): number => targets.get(b)![i]! - restOf.get(b)!;
  const aimX = new Map<string, boolean>();
  for (const c of map.chains) c.bones.forEach((b, k) => aimX.set(b, c.aim[k] === 'x'));
  {
    const why = plantOn ? '--plant-feet' : legScaleOn ? '--leg-scale' : 'reading the feet';
    legs = legsOf(map, why);
    if ('problems' in legs) {
      if (plantOn || legScaleOn) for (const x of legs.problems) p.add('LEGS_MAP', x);
    } else {
      const L = legs.legs;
      const top = t !== null && SIDES.every((s) => L[s].ankleBone === t.bone || descends(rest, L[s].ankleBone, t.bone)) ? t.bone : rootOf(rest, L.r.ankleBone);
      if (plantOn && (t === null || top !== t.bone)) p.add('LEGS_MAP', t === null ? '--plant-feet places the hip, and the map has no "translate"' : `--plant-feet places the translated bone "${t.bone}", and the legs' last bones (${L.r.ankleBone}, ${L.l.ankleBone}) do not both descend from it`);
      const path = pathFrom(rest, top, [L.r.ankleBone, L.l.ankleBone]);
      if (path === null || rootOf(rest, L.l.ankleBone) !== rootOf(rest, L.r.ankleBone)) {
        if (plantOn || legScaleOn) p.add('LEGS_MAP', `the legs' last bones ${L.r.ankleBone} and ${L.l.ankleBone} do not hang from one bone`);
      } else {
        legPath = path;
        legTop = top;
      }
      const hipOf = (s: Side) => series.get(`${s}_hip`);
      const ankleOf = (s: Side) => series.get(`${s}_ankle`);
      const hr = hipOf('r'), hl = hipOf('l'), ar = ankleOf('r'), al = ankleOf('l');
      if (hr !== undefined && hl !== undefined && ar !== undefined && al !== undefined) feet = supportsOf({ r: ar, l: al }, { r: hr, l: hl }, keyTimes, secondsOf, inPlace, plantOn); // #113: planted, the support is read from the lower ankle
      else if (plantOn) p.add('LEGS_MAP', `--plant-feet reads both hips and both ankles from the pose; the map's chains use ${['r_hip', 'l_hip', 'r_ankle', 'l_ankle'].filter((j) => !series.has(j)).join(', ')} nowhere`);
    }
  }
  if (legScaleOn) {
    const limits = opts.legScale as [number, number];
    for (const c of map.chains) {
      if (c.reach) continue;
      c.bones.forEach((b, k) => {
        const joints: [string, string] = [c.joints[k]!, c.joints[k + 1]!];
        if (!isLegSegment(joints[0], joints[1])) return;
        if (c.aim[k] !== 'x') {
          p.add('LEGS_MAP', `--leg-scale scales chain "${c.name}" bone "${b}" (${joints[0]} → ${joints[1]}) along its own x axis, and the map aims it ${JSON.stringify(c.aim[k])}; a leg segment it scales must be aimed "x"`);
          return;
        }
        const from = series.get(joints[0])!;
        const to = series.get(joints[1])!;
        const ls = legScaleOf(from.map((f, i) => Math.hypot(to[i]![0] - f[0], to[i]![1] - f[1])), limits);
        if (!(ls.straight > 1e-6)) {
          p.add('LEGS_MAP', `--leg-scale: chain "${c.name}" bone "${b}"'s segment ${joints[0]} → ${joints[1]} has a straight length (95th percentile) of ${ls.straight}px; there is nothing to scale against`);
          return;
        }
        legScale.push({ chain: c.name, bone: b, joints, ...ls });
        scales.set(b, ls.scale);
      });
    }
    if (legScale.length === 0 && !p.any) p.add('LEGS_MAP', '--leg-scale scales the leg segments (two of one side\'s hip, knee and ankle), and the map aims none');
  }
  if (opts.stance !== undefined && opts.stance !== 'off' && !plantOn) p.add('STANCE', `--stance ${opts.stance} plants the free foot beside the supporting one that --plant-feet holds, and --plant-feet is not given`);
  if (opts.floor !== undefined && !plantOn) p.add('FLOOR', `--floor ${opts.floor} is the floor --plant-feet plants every support span on, and --plant-feet is not given`);
  if (opts.floor !== undefined && !Number.isFinite(opts.floor)) p.add('FLOOR', `--floor is ${opts.floor}; it must be a finite world y`);
  p.throwIfAny();
  const askedScales = new Map<string, number[]>();
  for (const ls of legScale) askedScales.set(ls.bone, ls.asked);
  /** Every bone on the legs' path posed on frame i, by the targets and the given scale series. */
  const poseLegsWith = (i: number, sc: ReadonlyMap<string, number[]>): PathPose => {
    const r = posePath(rest, legPath!, (b): Posing | null => (targets.has(b) ? { turn: restTurn(b, i), target: targets.get(b)![i]!, aimX: aimX.get(b)! } : null), (b) => sc.get(b)?.[i] ?? null);
    if (typeof r === 'string') throw new Refusal([{ code: 'LEGS_MAP', text: r }]);
    return r;
  };
  /** Every bone on the legs' path posed on frame i, by the targets as they stand. */
  const poseLegs = (i: number): PathPose => poseLegsWith(i, scales);
  if (plantOn) {
    // The plant is derived from the targets before the range clamp, so nothing after may turn a bone on the legs' path.
    const onPath = new Set(legPath!);
    for (const c of map.chains) for (const b of Object.keys(c.range)) if (onPath.has(b)) p.add('LEGS_RANGE', `--plant-feet places the hip through chain "${c.name}" bone "${b}", which has a "range"; a clamp after the plant would move the planted foot — drop the range or --plant-feet`);
    for (const a of map.alternates) {
      for (const b of [...Object.keys(a.turn), ...Object.keys(a.offsets)]) if (onPath.has(b)) p.add('LEGS_RANGE', `--plant-feet places the hip through bone "${b}", which set "${a.name}" turns or offsets; that would move the planted foot — drop it from the set or --plant-feet`);
    }
    p.throwIfAny();
    // #107: the clamp floor holds the bone, not the hip; the plant places the hip from the scale the pose asked for.
    const offsets = Array.from({ length: n }, (_, i) => {
      const lp = poseLegsWith(i, askedScales);
      return { r: tipOf(rest, lp, legs !== null && 'legs' in legs ? legs.legs.r.ankleBone : ''), l: tipOf(rest, lp, legs !== null && 'legs' in legs ? legs.legs.l.ankleBone : '') };
    });
    const tb = rest.get(t!.bone)!;
    // #85: every support span on one floor — the median of their planted heights, or --floor.
    // #92: in place, the supporting ankle's own picture x, scaled, is the track its anchor follows.
    // #119: a tracked support follows the lower ankle's own picture x, scaled, on the floor until it is still.
    const track = (i: number, s: Side) => series.get(`${s}_ankle`)![i]![0] * scale!.factor;
    const follow = inPlace ? track : undefined;
    const planted = plantHip(feet!, (i, s) => offsets[i]![s], (i) => poseTravel[i]!, [tb.worldX, tb.worldY], opts.floor, follow, track);
    const hip = planted.hip;
    floor = planted.floor;
    closure = planted.closure;
    for (let i = 0; i < n; i++) travel[i] = [hip[i]![0] - tb.worldX, hip[i]![1] - tb.worldY];
    const L = (legs as { legs: Record<Side, { chain: Chain; ankleBone: string }> }).legs;
    const world = (i: number, v: Pt): Pt => [hip[i]![0] + v[0], hip[i]![1] + v[1]];
    /** Both legs posed on frame i by the scales as they stand, world (y up): each chain's root and ankle. */
    const posedFeet = (i: number) => {
      const lp = poseLegs(i);
      return {
        root: { r: world(i, lp.origin.get(L.r.chain.bones[0]!)!), l: world(i, lp.origin.get(L.l.chain.bones[0]!)!) },
        ankle: { r: world(i, tipOf(rest, lp, L.r.ankleBone)), l: world(i, tipOf(rest, lp, L.l.ankleBone)) },
      };
    };
    /** Every bone of a side's chain has its scalex multiplied by the stretch keyed on that side. */
    const stretchChain = (stretch: ReadonlyArray<{ side: Side; k: number } | null>) => {
      for (const side of SIDES) {
        if (!stretch.some((x) => x?.side === side)) continue;
        for (const b of L[side].chain.bones) {
          const own = scales.get(b);
          const s = own === undefined ? new Array<number>(n).fill(1) : [...own];
          stretch.forEach((x, i) => {
            if (x?.side === side) s[i] = s[i]! * x.k;
          });
          scales.set(b, s);
        }
      }
    };
    // #85: on a blend frame the hip is between two derivations; the supporting leg is stretched
    // (stanceOf's mechanism, its bounds) so its ankle stays on the floor. Before --stance, whose
    // floor is that supporting ankle. #95: the lower bound on a frame is the leg's own range there.
    const ankleSeries = { r: series.get('r_ankle')!, l: series.get('l_ankle')! };
    const lower = stanceRangeOf(ankleSeries, { r: series.get('r_hip')!, l: series.get('l_hip')! });
    blendHold = holdBlend(planted.blends, n, posedFeet, lower);
    stretchChain(blendHold.stretch);
    // --stance (#60): with the hip placed, a free ankle within the tolerance of the floor has its leg
    // stretched (every bone of its chain's scalex, about the chain's root) until it reaches it.
    if (opts.stance !== undefined && opts.stance !== 'off') {
      stance = stanceOf(feet!, ankleSeries, opts.stance, posedFeet, secondsOf, lower);
      // The supporting leg (the blend's) and the free leg (the stance's) are different chains on a frame.
      for (let i = 0; i < n; i++) {
        const b = blendHold.stretch[i];
        if (b !== null && b !== undefined && stance.stretch[i]?.side === b.side) p.add('LEGS_STRETCH', `frame ${i}: chain "${L[b.side].chain.name}" is stretched both as the supporting leg of a blend (k ${b.k}) and as the free leg of --stance (k ${stance.stretch[i]!.k}); one chain takes one stretch`);
      }
      p.throwIfAny();
      stretchChain(stance.stretch);
    }
  }
  if (t !== null && scale !== null) {
    const bone = rest.get(t.bone)!;
    const parent = bone.parent === null ? null : rest.get(bone.parent)!;
    const keys: MotionKey[] = [];
    const at: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const [wx, wy] = travel[i]!;
      let lx = wx;
      let ly = wy;
      if (parent !== null) {
        const det = parent.a * parent.d - parent.b * parent.c;
        lx = (parent.d * wx - parent.b * wy) / det;
        ly = (-parent.c * wx + parent.a * wy) / det;
      }
      keys.push({ t: keyTimes[i]!, v: [r3(lx), r3(ly)] });
      at.push([bone.worldX + wx, bone.worldY + wy]);
    }
    translateTrack = { bone: t.bone, property: 'translate', keys };
    origin = { bone: t.bone, at };
  }

  // Reaches: from the bone's posed origin at the pose's end point, anchored at
  // the translated bone. A reach above another is aimed first.
  const depth = (b: string): number => {
    let d = 0;
    for (let a = rest.get(b)!.parent; a !== null; a = rest.get(a)!.parent) d++;
    return d;
  };
  /** The world turn of `b`'s nearest mapped bone-or-ancestor, degrees, on frame i, by the targets as they stand. */
  const turnAbove = (b: string, i: number): number => {
    for (let a: string | null = b; a !== null; a = rest.get(a)!.parent) {
      const tg = targets.get(a);
      if (tg !== undefined) return tg[i]! - restOf.get(a)!;
    }
    return 0;
  };
  /**
   * Where the poser will put `b`'s origin on frame i: forward from the
   * translated bone (moved by its travel) or the root (at setup), each rest
   * offset turned by the nearest mapped bone above — the key formula's own
   * assumption (unit scale, no shear), which the landing check holds to account.
   */
  let headNodBone: string | null = null;
  let headNod: Pt[] | null = null;
  let headNodTrack: MotionTrack | null = null;
  const posedOrigin = (b: string, i: number): Pt => {
    const own = rest.get(b)!;
    if (t !== null && b === t.bone) return [own.worldX + (travel[i]?.[0] ?? 0), own.worldY + (travel[i]?.[1] ?? 0)];
    const nod = b === headNodBone ? (headNod?.[i] ?? [0, 0]) : [0, 0];
    if (own.parent === null) return [own.worldX + nod[0], own.worldY + nod[1]];
    const parent = own.parent;
    const po = posedOrigin(parent, i);
    const r = turnAbove(parent, i) / DEG;
    const ox = own.worldX - rest.get(parent)!.worldX;
    const oy = own.worldY - rest.get(parent)!.worldY;
    return [po[0] + Math.cos(r) * ox - Math.sin(r) * oy + nod[0], po[1] + Math.sin(r) * ox + Math.cos(r) * oy + nod[1]];
  };
  /** A rig point (a bone, `name:tip`, `a+b`) posed on frame i the same way. */
  const posedPoint = (spec: string, i: number): Pt => {
    let x = 0;
    let y = 0;
    const parts = pointParts(spec);
    for (const part of parts) {
      const name = partBone(part);
      const o = posedOrigin(name, i);
      const bone = rest.get(name)!;
      const l = part.endsWith(':tip') ? bone.length : 0;
      const r = turnAbove(name, i) / DEG;
      x += o[0] + l * (Math.cos(r) * bone.a - Math.sin(r) * bone.c);
      y += o[1] + l * (Math.sin(r) * bone.a + Math.cos(r) * bone.c);
    }
    return [x / parts.length, y / parts.length];
  };
  const reaches = map.chains.filter((c) => c.reach).sort((x, y) => depth(x.bones[0]!) - depth(y.bones[0]!));
  let aimReach: ((c: Chain) => void) | null = null;
  if (reaches.length > 0 && t !== null && scale !== null) {
    const s = scale.factor;
    const tb = rest.get(t.bone)!;
    aimReach = (c: Chain): void => {
      const b = c.bones[0]!;
      const anchor = series.get(c.joints[0]!)!;
      const end = series.get(c.joints[1]!)!;
      const angles: number[] = [];
      for (let i = 0; i < n; i++) {
        const o = posedOrigin(b, i);
        const tx = tb.worldX + travel[i]![0] + (end[i]![0] - anchor[i]![0]) * s;
        const ty = tb.worldY + travel[i]![1] - (end[i]![1] - anchor[i]![1]) * s;
        const d = Math.hypot(tx - o[0], ty - o[1]);
        angles.push(d > 1e-9 ? Math.atan2(ty - o[1], tx - o[0]) * DEG : (angles[i - 1] ?? NaN));
      }
      fillLeading(angles, () => p.add('POSE_SEGMENT_ZERO', `chain "${c.name}" — bone "${b}" reaches for ${c.joints[1]}, which the pose puts on the bone's posed origin on every frame; it has no direction`));
      targets.set(b, angles);
    };
    for (const c of reaches) aimReach(c);
  }
  p.throwIfAny();

  // The switches: with every target known, each set's distance and its spans.
  const sw = selectSwitches(map, targets, keyTimes, keyTimes[n - 1]!, slots, opts);

  // The range clamp, outside the spans of a set depicting the bone's chain. Parents
  // first, so a bone below takes its clamped parent into its key; a reach is aimed
  // again from where the clamped bones above put its origin.
  const mappedAbove = (b: string): string | null => {
    for (let a = rest.get(b)!.parent; a !== null; a = rest.get(a)!.parent) if (targets.has(a)) return a;
    return null;
  };
  const turn = (bone: string, i: number) => targets.get(bone)![i]! - restOf.get(bone)!;
  const covered = coveredChains(sw.switches, n);
  if (opts.short !== 'off') {
    for (const [b, info] of fractions) {
      for (const s of capShortSteps(targets.get(b)!, info.fraction, covered.get(info.chain))) {
        short.push({ chain: info.chain, bone: b, joints: info.joints, ...s });
      }
    }
  }
  const range: RangeDemand[] = [];
  const order = map.chains.flatMap((c) => c.bones.map((b) => ({ c, b }))).filter(({ c, b }) => c.reach || b in c.range);
  order.sort((x, y) => depth(x.b) - depth(y.b));
  for (const { c, b } of order) {
    if (c.reach && aimReach !== null) aimReach(c);
    const limits = c.range[b];
    if (limits === undefined) continue;
    const above = mappedAbove(b);
    const tg = targets.get(b)!;
    const cov = covered.get(c.name);
    const over: number[] = [];
    const asked: number[] = [];
    for (let i = 0; i < n; i++) {
      const key = wrap(turn(b, i) - (above === null ? 0 : turn(above, i)));
      asked.push(key);
      const o = cov?.[i] === true ? 0 : overflow(key, limits);
      over.push(o);
      if (o > RANGE_SLACK) tg[i] = wrap(tg[i]! + Math.min(Math.max(key, limits[0]), limits[1]) - key);
    }
    for (const run of runsOf(over.map((o) => o > RANGE_SLACK), RANGE_GAP)) {
      let worst = run[0];
      for (let i = run[0]; i <= run[1]; i++) if (over[i]! > over[worst]!) worst = i;
      range.push({ chain: c.name, bone: b, frames: run, seconds: secondsOf(run), maxOverflow: r3(over[worst]!), key: r3(asked[worst]!), limits });
    }
  }
  p.throwIfAny();

  // #111: the head chain's nod channel — the eyes' vertical travel against the
  // neck, measured in the rig's own units, keyed as a translate on the head bone
  // (whose rotate track carries roll only).
  for (const c of map.chains) {
    for (let k = 0; k + 1 < c.joints.length; k++) {
      const ja = c.joints[k]!;
      const jb = c.joints[k + 1]!;
      if (!((ja === 'r_eye' && jb === 'l_eye') || (ja === 'l_eye' && jb === 'r_eye'))) continue;
      const hb = c.bones[k]!;
      const ha = c.aim[k]!;
      if (t?.bone === hb || sw.offsetTracks.some((tr) => tr.bone === hb)) break;
      let underScaled = false;
      for (let a = rest.get(hb)!.parent; a !== null; a = rest.get(a)!.parent) if (scales.has(a)) underScaled = true;
      if (underScaled) break;
      const rEye = series.get('r_eye')!;
      const lEye = series.get('l_eye')!;
      const neckSeries = series.get('neck') ?? (() => {
        const h = heldOf('neck');
        return 'never' in h ? undefined : h.at;
      })();
      let nodScale: number | null = scale?.factor ?? null;
      if (nodScale === null && ha.includes('>')) {
        const [pa, pb] = aimEnds(hb, ha);
        const a0 = rigPoint(rest, pa)!;
        const b0 = rigPoint(rest, pb)!;
        const rigEye = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]);
        const refEye = median(rEye.map((re, i) => Math.hypot(lEye[i]![0] - re[0], lEye[i]![1] - re[1])));
        if (refEye > 1e-6 && rigEye > 1e-6) nodScale = rigEye / refEye;
      }
      if (neckSeries !== undefined && nodScale !== null) {
        const refEN = rEye.map((re, i) => -((re[1] + lEye[i]![1]) / 2 - neckSeries[i]![1]));
        const dy = refEN.map((v) => (v - refEN[0]!) * nodScale);
        if (dy.some((v) => Math.abs(r3(v)) > 0)) {
          const bone = rest.get(hb)!;
          const parent = bone.parent === null ? null : rest.get(bone.parent)!;
          const keys: MotionKey[] = [];
          const nod: Pt[] = [];
          for (let i = 0; i < n; i++) {
            const wy = dy[i]!;
            let lx = 0;
            let ly = r3(wy);
            let awx = 0;
            let awy = ly;
            if (parent !== null) {
              const r = turnAbove(parent.name, i) / DEG;
              const pa = Math.cos(r) * parent.a - Math.sin(r) * parent.c;
              const pb = Math.cos(r) * parent.b - Math.sin(r) * parent.d;
              const pc = Math.sin(r) * parent.a + Math.cos(r) * parent.c;
              const pd = Math.sin(r) * parent.b + Math.cos(r) * parent.d;
              const det = pa * pd - pb * pc;
              lx = r3((-pb * wy) / det);
              ly = r3((pa * wy) / det);
              awx = pa * lx + pb * ly;
              awy = pc * lx + pd * ly;
            }
            keys.push({ t: keyTimes[i]!, v: [lx, ly] });
            nod.push([awx, awy]);
          }
          headNodBone = hb;
          headNod = nod;
          headNodTrack = { bone: hb, property: 'translate', keys };
        }
      }
      break;
    }
    if (headNodTrack !== null) break;
  }

  // --raised-by-head (#62, HQ's ruling): while a set whose arm is drawn raised shows, its wrist goes where
  // the reference's is against the head, in eye distances (each side's median over the span). Solved last
  // of the bones: every bone above the arm, the head and the trunk's reach included, has its final target
  // (range clamp done), so the head and the shoulder are posed from them frame by frame; the arm moves
  // neither. A target out of reach is placed at the reach limit along the head-relative direction
  // (`reachLimit`, a REACH line). The set's `turn` is part of the solve: a held upper arm has its forearm
  // re-aimed at the placed wrist, and only a forearm the turn still holds is ART-RANGE.
  // `place: "by-hip"` (#93) is the same solve against the hip: while a set that asks for it shows, each chain
  // its key skeleton puts the wrist within one hip width of the mid-hip (`byHipChains`) has its wrist placed
  // at the rig's mid-hip + the reference's offset from its mid-hip, in hip widths (each side's median over the
  // span). The rig's hips are the two points `hipOf` reads off the map, posed as the eyes are.
  const raised: Raised[] = [];
  const byHip: ByHip[] = [];
  const raisedArt: Array<{ sw: Switch; entries: ArtRange[] }> = [];
  const raisedJobs: Array<{ anchor: Anchor; sw: Switch; chain: Chain; wrist: (i: number) => Pt; before: Pt[]; reference: Pt[]; placed: Pt[]; refEye: number; rigEye: number; short: Array<{ i: number; how: 'far' | 'near' | 'missed'; shortfall: number }>; upperHeld: number[]; l0: number; l1: number; farthest: number }> = [];
  const headOk: Anchor | null = head !== null && !('problem' in head) ? { kind: 'head', joints: head.joints, points: head.points } : null;
  const hipsOk: Anchor | null = hips !== null && !('problem' in hips) ? { kind: 'hip', joints: hips.joints, points: hips.points } : null;
  if (headOk !== null || hipsOk !== null) {
    /** The anchor's two rig points posed on frame i: their midpoint and their distance apart. */
    const pairOn = (an: Anchor, i: number): { centre: Pt; dist: number } => {
      const a = posedPoint(an.points[0], i);
      const b = posedPoint(an.points[1], i);
      return { centre: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    };
    for (const s of sw.switches) {
      const set = map.alternates.find((a) => a.name === s.set)!;
      const art: ArtRange[] = [];
      for (const cn of s.chains) {
        const c = map.chains.find((x) => x.name === cn)!;
        const drawn = set.drawn[c.bones[0]!];
        const up = headOk !== null && drawn !== undefined && isRaised(drawn);
        const low = hipsOk !== null && set.place?.chains.includes(c.name) === true;
        if (up && low) {
          p.add('PLACE_BOTH', `set "${set.name}" chain "${c.name}": --raised-by-head places its wrist against the head (bone "${c.bones[0]}" drawn at ${drawn}°, raised), and "place": "by-hip" against the hip (its key skeleton's wrist within one hip width of the mid-hip); a wrist is placed against one — drop "place" from the set or the flag`);
          continue;
        }
        const anchor = up ? headOk : low ? hipsOk : null;
        if (anchor === null) continue;
        const ra = series.get(anchor.joints[0])!;
        const rb = series.get(anchor.joints[1])!;
        const refCentre = (i: number): Pt => [(ra[i]![0] + rb[i]![0]) / 2, (ra[i]![1] + rb[i]![1]) / 2];
        const anchorBones = new Set([...anchor.points.flatMap((x) => pointParts(x).map(partBone))]);
        const label = up ? `--raised-by-head: set "${set.name}" draws chain "${c.name}" raised (bone "${c.bones[0]}" at ${drawn}°)` : `"place": "by-hip": set "${set.name}" places chain "${c.name}"'s wrist against the hip`;
        const CHAIN = up ? 'RAISED_CHAIN' : 'PLACE_CHAIN';
        if (c.bones.length !== 2) {
          p.add(CHAIN, `${label}, and the chain has ${c.bones.length} bone(s); the wrist is placed by a two-bone solve, so it must have two (upper arm, forearm)`);
          continue;
        }
        if (c.reach || c.aim.some((x) => x.includes('>'))) {
          p.add(CHAIN, `${label}, and it aims ${JSON.stringify(c.aim)}${c.reach ? ' with "reach"' : ''}; the solve turns each bone about its own origin toward the next point, so each must aim "x" or at one point`);
          continue;
        }
        const [b0, b1] = c.bones as [string, string];
        const moved = [...anchorBones].filter((h) => h === b0 || h === b1 || descends(rest, h, b0));
        if (moved.length > 0) {
          p.add(CHAIN, up ? `${label}, and the head's eye point ${moved.map((h) => `"${h}"`).join(', ')} turns with it; the wrist cannot be placed against a head the arm moves` : `${label}, and the hip point ${moved.map((h) => `"${h}"`).join(', ')} turns with it; the wrist cannot be placed against a hip the arm moves`);
          continue;
        }
        const wristSpec = c.aim[1] === 'x' ? `${b1}:tip` : c.aim[1]!;
        if (c.aim[1] === 'x' && !(rest.get(b1)!.length > 1e-9)) {
          p.add(CHAIN, `${label}, and its last bone "${b1}" aims "x" with no length; its wrist (the tip) is its origin, so there is nothing to place`);
          continue;
        }
        const wristOf = (i: number): Pt => posedPoint(wristSpec, i);
        const refWrist = series.get(c.joints[2]!)!;
        // The unit, each side's median over the span (HQ's ruling).
        const span: number[] = [];
        for (let i = s.frames[0]; i <= s.frames[1]; i++) span.push(i);
        const refEye = median(span.map((i) => Math.hypot(rb[i]![0] - ra[i]![0], rb[i]![1] - ra[i]![1])));
        const rigEye = median(span.map((i) => pairOn(anchor, i).dist));
        if (!(refEye > 1e-9) || !(rigEye > 1e-9)) {
          if (up) p.add('RAISED_EYES', `${label}: over frames ${s.frames[0]}–${s.frames[1]} the median eye distance is ${refEye > 1e-9 ? `${rigEye} units on the rig (points "${anchor.points[0]}", "${anchor.points[1]}")` : `${refEye}px in the reference (${anchor.joints[0]}, ${anchor.joints[1]})`}; an eye distance of 0 is no unit`);
          else p.add('PLACE_HIPS', `${label}: over frames ${s.frames[0]}–${s.frames[1]} the median hip width is ${refEye > 1e-9 ? `${rigEye} units on the rig (points "${anchor.points[0]}", "${anchor.points[1]}")` : `${refEye}px in the reference (${anchor.joints[0]}, ${anchor.joints[1]})`}; a hip width of 0 is no unit`);
          continue;
        }
        // The rig's own lengths, and each bone's aim against the vector it carries, at setup.
        const S0 = rigPoint(rest, b0)!;
        const E0 = rigPoint(rest, b1)!;
        const W0 = rigPoint(rest, wristSpec)!;
        const l0 = Math.hypot(E0[0] - S0[0], E0[1] - S0[1]);
        const l1 = Math.hypot(W0[0] - E0[0], W0[1] - E0[1]);
        const d0 = wrap(Math.atan2(E0[1] - S0[1], E0[0] - S0[0]) * DEG - restOf.get(b0)!);
        const d1 = wrap(Math.atan2(W0[1] - E0[1], W0[0] - E0[0]) * DEG - restOf.get(b1)!);
        const t0 = targets.get(b0)!;
        const t1 = targets.get(b1)!;
        const turn0 = set.turn[b0];
        const turn1 = set.turn[b1];
        const job: (typeof raisedJobs)[number] = { anchor, sw: s, chain: c, wrist: wristOf, before: [], reference: [], placed: [], refEye, rigEye, short: [], upperHeld: [], l0, l1, farthest: 0 };
        /** Per frame of the span: the forearm's art turn the re-aim asked, and how far past its turn. */
        const foreAsked: number[] = [];
        const foreOver: number[] = [];
        /** Per frame of the span: the upper arm's art turn the solve asked, how far past its turn, and — where the turn held it — how far the wrist ends from its placed point, eye distances (0 elsewhere). */
        const upperAsked: number[] = [];
        const upperOver: number[] = [];
        const heldMiss: number[] = [];
        for (const i of span) {
          const h = pairOn(anchor, i);
          const rc = refCentre(i);
          // The reference's wrist from its head centre, in its eye distances, y turned up.
          const ref: Pt = [(refWrist[i]![0] - rc[0]) / refEye, -(refWrist[i]![1] - rc[1]) / refEye];
          const w = wristOf(i);
          job.reference.push(ref);
          job.before.push([(w[0] - h.centre[0]) / rigEye, (w[1] - h.centre[1]) / rigEye]);
          const target: Pt = [h.centre[0] + ref[0] * rigEye, h.centre[1] + ref[1] * rigEye];
          const shoulder = posedOrigin(b0, i);
          job.farthest = Math.max(job.farthest, Math.hypot(target[0] - shoulder[0], target[1] - shoulder[1]));
          const place = reachLimit(h.centre, target, shoulder, l0, l1);
          const P = place.point;
          job.placed.push([(P[0] - h.centre[0]) / rigEye, (P[1] - h.centre[1]) / rigEye]);
          if (place.how !== 'in') job.short.push({ i, how: place.how, shortfall: Math.hypot(target[0] - P[0], target[1] - P[1]) / rigEye });
          // The pose's bend side, read on the vectors the two bones carry.
          const side: 1 | -1 = wrap(t1[i]! + d1 - (t0[i]! + d0)) >= 0 ? 1 : -1;
          const sol = twoBone(shoulder, P, l0, l1, side);
          if (sol.upper === null) {
            foreAsked.push(wrap(t1[i]! - (set.drawn[b1] ?? 0)));
            foreOver.push(0);
            upperAsked.push(0);
            upperOver.push(0);
            heldMiss.push(0);
            continue;
          }
          let a0 = wrap(sol.upper - d0);
          let a1 = wrap(sol.fore - d1);
          // The set's turn holds the upper arm; the forearm is then re-aimed at the placed wrist from where the held upper arm puts the elbow.
          let held = false;
          const tt = turn0 === undefined ? 0 : wrap(a0 - set.drawn[b0]!);
          upperAsked.push(tt);
          upperOver.push(turn0 === undefined ? 0 : overflow(tt, turn0));
          if (turn0 !== undefined) {
            const cl = Math.min(Math.max(tt, turn0[0]), turn0[1]);
            if (Math.abs(cl - tt) > RANGE_SLACK) {
              held = true;
              a0 = wrap(set.drawn[b0]! + cl);
              job.upperHeld.push(i);
              const r = (a0 + d0) / DEG;
              const E: Pt = [shoulder[0] + l0 * Math.cos(r), shoulder[1] + l0 * Math.sin(r)];
              a1 = wrap(Math.atan2(P[1] - E[1], P[0] - E[0]) * DEG - d1);
            }
          }
          // A forearm the turn still holds: the re-aim failed within the art's range — ART-RANGE.
          const asked = turn1 === undefined ? 0 : wrap(a1 - set.drawn[b1]!);
          const over = turn1 === undefined ? 0 : overflow(asked, turn1);
          foreAsked.push(asked);
          foreOver.push(over);
          if (turn1 !== undefined && over > RANGE_SLACK) a1 = wrap(set.drawn[b1]! + Math.min(Math.max(asked, turn1[0]), turn1[1]));
          // Where the held arm leaves the wrist: the re-aimed forearm points at the placed point, but from a held
          // elbow its length need not reach it (rule 3, "cannot reach within turn").
          const r0 = (a0 + d0) / DEG;
          const r1 = (a1 + d1) / DEG;
          const W: Pt = [shoulder[0] + l0 * Math.cos(r0) + l1 * Math.cos(r1), shoulder[1] + l0 * Math.sin(r0) + l1 * Math.sin(r1)];
          heldMiss.push(held ? Math.hypot(W[0] - P[0], W[1] - P[1]) / rigEye : 0);
          t0[i] = a0;
          t1[i] = a1;
        }
        // A held upper arm whose re-aimed forearm leaves the wrist more than HELD_MISS short of its placed point: ART-RANGE on the upper arm, with the shortfall.
        if (turn0 !== undefined) {
          for (const [a, b] of runsOf(heldMiss.map((m) => m > HELD_MISS), RANGE_GAP)) {
            let worst = a;
            for (let k = a; k <= b; k++) if (heldMiss[k]! > heldMiss[worst]!) worst = k;
            const first = s.frames[0] + a;
            const last = s.frames[0] + b;
            art.push({ set: set.name, chain: c.name, bone: b0, frames: [first, last], seconds: r6(endOf(last) - keyTimes[first]!), maxOverflow: r3(upperOver[worst]!), turn: r3(upperAsked[worst]!), limits: turn0, clamped: true, shortfall: r3(heldMiss[worst]!), ...(up ? {} : { anchor: 'hip' as const }) });
          }
        }
        if (turn1 !== undefined) {
          for (const [a, b] of runsOf(foreOver.map((o) => o > RANGE_SLACK), RANGE_GAP)) {
            let worst = a;
            for (let k = a; k <= b; k++) if (foreOver[k]! > foreOver[worst]!) worst = k;
            const first = s.frames[0] + a;
            const last = s.frames[0] + b;
            art.push({ set: set.name, chain: c.name, bone: b1, frames: [first, last], seconds: r6(endOf(last) - keyTimes[first]!), maxOverflow: r3(foreOver[worst]!), turn: r3(foreAsked[worst]!), limits: turn1, clamped: true });
          }
        }
        raisedJobs.push(job);
      }
      art.sort((x, y) => x.frames[0] - y.frames[0]);
      if (art.length > 0) raisedArt.push({ sw: s, entries: art });
    }
  }
  p.throwIfAny();
  // The art turn of every span; a raised chain's bones were held by the solve, and only its re-aimed forearm is listed (above).
  const measured = measureArt(sw.switches, map, targets, endOf, keyTimes, RANGE_GAP);
  const solvedBy = (e: ArtRange, s: Switch) => raisedJobs.some((j) => j.sw === s && j.chain.name === e.chain);
  const artRange: ArtRange[] = [];
  for (const s of sw.switches) {
    const own = measured.filter((e) => e.set === s.set && e.frames[0] >= s.frames[0] && e.frames[1] <= s.frames[1]);
    artRange.push(...own.filter((e) => !solvedBy(e, s)), ...(raisedArt.find((x) => x.sw === s)?.entries ?? []));
  }
  clampArt(sw.switches, map, targets);
  // Where each raised wrist lands as keyed: after the solve and the set's `turn`.
  for (const job of raisedJobs) {
    const after: Pt[] = [];
    for (let i = job.sw.frames[0]; i <= job.sw.frames[1]; i++) {
      const a = posedPoint(job.anchor.points[0], i);
      const b = posedPoint(job.anchor.points[1], i);
      const w = job.wrist(i);
      after.push([(w[0] - (a[0] + b[0]) / 2) / job.rigEye, (w[1] - (a[1] + b[1]) / 2) / job.rigEye]);
    }
    const worst = (rig: readonly Pt[]): Pt => [Math.max(...rig.map((v, k) => Math.abs(v[0] - job.reference[k]![0]))), Math.max(...rig.map((v, k) => Math.abs(v[1] - job.reference[k]![1])))].map(r6) as Pt;
    const round = (vs: readonly Pt[]): Pt[] => vs.map((v) => [r6(v[0]), r6(v[1])]);
    const short: ReachShort[] = [];
    for (let k = 0; k < job.short.length;) {
      let m = k;
      while (m + 1 < job.short.length && job.short[m + 1]!.i === job.short[m]!.i + 1 && job.short[m + 1]!.how === job.short[k]!.how) m++;
      const fs = job.short.slice(k, m + 1).map((x) => x.shortfall);
      short.push({ frames: [job.short[k]!.i, job.short[m]!.i], how: job.short[k]!.how, shortfall: { max: r6(Math.max(...fs)), median: r6(median(fs)) } });
      k = m + 1;
    }
    const unit = { rig: r6(job.rigEye), reference: r6(job.refEye) };
    const entry = {
      set: job.sw.set,
      chain: job.chain.name,
      frames: job.sw.frames,
      seconds: secondsOf(job.sw.frames),
      reference: round(job.reference),
      placed: round(job.placed),
      before: round(job.before),
      after: round(after),
      worst: { before: worst(job.before), after: worst(after), placed: r6(Math.max(...after.map((v, k) => Math.hypot(v[0] - job.placed[k]![0], v[1] - job.placed[k]![1])))) },
      short,
      upperHeld: job.upperHeld,
      reach: { min: r6(Math.abs(job.l0 - job.l1)), max: r6(job.l0 + job.l1), farthest: r6(job.farthest) },
    };
    // The unit sits after `seconds`, as the report has always written it.
    const { set, chain, frames, seconds, ...body } = entry;
    if (job.anchor.kind === 'head') raised.push({ set, chain, frames, seconds, eyes: unit, ...body });
    else byHip.push({ set, chain, frames, seconds, hips: unit, ...body });
  }

  // The legs on their final targets: a bone under a scaled bone is keyed through
  // its parent's posed matrix (legs.ts), and each ankle's world position is read.
  const legPoses: PathPose[] | null = legPath !== null && (legScaleOn || plantOn) ? Array.from({ length: n }, (_, i) => poseLegs(i)) : null;
  let ankles: Retarget['ankles'] = null;
  if (legPoses !== null && legs !== null && 'legs' in legs) {
    const L = legs.legs;
    const topRest = rest.get(legTop!)!;
    const at = { r: [] as Pt[], l: [] as Pt[] };
    legPoses.forEach((lp, i) => {
      const o: Pt = origin !== null && origin.bone === legTop ? origin.at[i]! : [topRest.worldX, topRest.worldY];
      for (const sd of SIDES) {
        const tip = tipOf(rest, lp, L[sd].ankleBone);
        at[sd].push([o[0] + tip[0], o[1] + tip[1]]);
      }
    });
    ankles = { bones: { r: L.r.ankleBone, l: L.l.ankleBone }, at };
  }
  const solvedKey = (b: string, i: number) => legPoses?.[i]!.solved.get(b);

  // Keys: the bone's turn less the turn of the nearest mapped bone above it.
  const tracks: Array<MotionTrack | SlotTrack> = [];
  for (const c of map.chains) {
    for (const b of c.bones) {
      const above = mappedAbove(b);
      let prev = 0;
      const keys: MotionKey[] = [];
      for (let i = 0; i < n; i++) {
        const raw = turn(b, i) - (above === null ? 0 : turn(above, i));
        const v = i === 0 ? wrap(raw) : prev + wrap(raw - prev);
        prev = v;
        keys.push({ t: keyTimes[i]!, v: [r3(v)] });
      }
      tracks.push({ bone: b, property: 'rotate', keys });
      // A bone under a scaled bone: the rotate key that lands it through its parent's scale (legs.ts).
      if (solvedKey(b, 0) !== undefined) {
        let last = 0;
        keys.forEach((k, i) => {
          const raw = solvedKey(b, i)!.rotate;
          last = i === 0 ? wrap(raw) : last + wrap(raw - last);
          k.v = [r3(last)];
        });
      }
    }
  }
  // Scale keys: a scaled leg segment's own scale, or the scale that lands a bone under one at its asked length.
  for (const c of map.chains) {
    for (const b of c.bones) {
      if (!scales.has(b) && solvedKey(b, 0) === undefined) continue;
      tracks.push({ bone: b, property: 'scalex', keys: Array.from({ length: n }, (_, i) => ({ t: keyTimes[i]!, v: [r6(solvedKey(b, i)?.scale ?? scales.get(b)?.[i] ?? 1)] })) });
    }
  }
  if (translateTrack !== null) tracks.push(translateTrack);
  if (headNodTrack !== null) tracks.push(headNodTrack);
  tracks.push(...sw.offsetTracks, ...sw.slotTracks);

  return {
    animation: { duration: keyTimes[n - 1]!, tracks },
    times: keyTimes, targets, origin, holds, bends, short, endOn, flips, scale,
    switches: sw.switches, shown: sw.shown, distances: sw.distances, turns, turnsUnread, range, artRange,
    legScale, scales, feet, planted: plantOn, stance, floor, blendHold, closure, ankles, pivot: pivotOf(rest, t?.bone ?? null, legs), raised, byHip,
  };
}

/** What a placed wrist is measured against: the head (#62, the eyes) or the hip (#93, the hips) — two pose joints and the rig's two points. */
interface Anchor {
  kind: 'head' | 'hip';
  joints: [string, string];
  points: [string, string];
}

/** The hips as `place: "by-hip"` reads them: two pose joints (r_hip, l_hip) and the rig's two hip points. */
interface Hips {
  joints: [string, string];
  points: [string, string];
}

/**
 * The rig's hip points for `place: "by-hip"` (#93): the two points a chain
 * carrying the hip line (r_hip → l_hip, either way round) names with an "a>b"
 * aim — a pelvis turned by its hip line; else the origins of the first bones of
 * the two chains that start at r_hip and at l_hip — the legs, whose roots are
 * the hip joints; or why the map names neither.
 */
function hipOf(map: JointMap): Hips | { problem: string } {
  for (const c of map.chains) {
    for (let k = 0; k + 1 < c.joints.length; k++) {
      const a = c.joints[k]!;
      const b = c.joints[k + 1]!;
      if (!((a === 'r_hip' && b === 'l_hip') || (a === 'l_hip' && b === 'r_hip'))) continue;
      const aim = c.aim[k]!;
      if (!aim.includes('>')) continue;
      const [pa, pb] = aimEnds(c.bones[k]!, aim);
      return { joints: [a, b], points: [pa, pb] };
    }
  }
  const from = (j: string, other: string) => map.chains.find((c) => c.joints[0] === j && c.joints[1] !== other);
  const r = from('r_hip', 'l_hip');
  const l = from('l_hip', 'r_hip');
  if (r !== undefined && l !== undefined) return { joints: ['r_hip', 'l_hip'], points: [r.bones[0]!, l.bones[0]!] };
  return { problem: `"place": "by-hip" places a wrist against the hip in hip widths, read on the rig between two hip points: the two a chain carrying the hip line (r_hip → l_hip) names with an "a>b" aim, or else the first bones' origins of the two chains starting at r_hip and l_hip (the legs); the map has neither (${r === undefined && l === undefined ? 'no chain starts at r_hip or l_hip' : `no chain starts at ${r === undefined ? 'r_hip' : 'l_hip'}`})` };
}

/** The head as --raised-by-head reads it: the chain carrying the eye line, its two pose joints and the rig's two eye points. */
interface Head {
  chain: string;
  joints: [string, string];
  points: [string, string];
}

/** The map's head chain (the one carrying r_eye → l_eye, either way round) and its "a>b" aim; or why there is none to read. */
function headOf(map: JointMap): Head | { problem: string } {
  const lead = '--raised-by-head places a raised arm\'s wrist against the head in eye distances, read on the rig between the two points the head chain\'s "a>b" aim names';
  for (const c of map.chains) {
    for (let k = 0; k + 1 < c.joints.length; k++) {
      const a = c.joints[k]!;
      const b = c.joints[k + 1]!;
      if (!((a === 'r_eye' && b === 'l_eye') || (a === 'l_eye' && b === 'r_eye'))) continue;
      const aim = c.aim[k]!;
      if (!aim.includes('>')) return { problem: `${lead}; chain "${c.name}" carries ${a} → ${b} on bone "${c.bones[k]}", and aims it ${JSON.stringify(aim)}, not "a>b" between the rig's eye points` };
      const [pa, pb] = aimEnds(c.bones[k]!, aim);
      return { chain: c.name, joints: [a, b], points: [pa, pb] };
    }
  }
  return { problem: `${lead}; no chain of the map carries the eye line (joints r_eye → l_eye), so the rig has no eye points to measure` };
}

type ShortSpan = Omit<Short, 'chain' | 'bone' | 'joints'>;

/**
 * The short hold on one angle series (degrees), in place. `fraction` is the
 * segment's picture length on each frame over its median. Each run of frames
 * under `cutoff` has its angles replaced by the line from the last frame before
 * it at or above the cutoff to the first one after it, the short way round; a
 * run at the start or the end of the series holds the one reliable end flat.
 * With the fraction against the median and a cutoff under 1, half the frames
 * at least are at or above it, so every run has a reliable end. Returns the runs.
 */
/** A line across the body: a left joint and its right twin (r_hip → l_hip, r_eye → l_eye). */
export function isAcross(a: string, b: string): boolean {
  const twin = (x: string): string | null => (x.startsWith('r_') ? `l_${x.slice(2)}` : x.startsWith('l_') ? `r_${x.slice(2)}` : null);
  return twin(a) === b;
}

export function holdShort(angles: number[], fraction: readonly number[], cutoff: number): ShortSpan[] {
  const n = angles.length;
  const out: ShortSpan[] = [];
  for (let i = 0; i < n; i++) {
    if (!(fraction[i]! < cutoff)) continue;
    let j = i;
    while (j + 1 < n && fraction[j + 1]! < cutoff) j++;
    const lo = i - 1;
    const hi = j + 1;
    let minFraction = fraction[i]!;
    for (let k = i + 1; k <= j; k++) minFraction = Math.min(minFraction, fraction[k]!);
    if (lo >= 0 || hi < n) {
      const a = lo >= 0 ? angles[lo]! : angles[hi]!;
      const b = hi < n ? angles[hi]! : a;
      const turn = wrap(b - a);
      for (let k = i; k <= j; k++) angles[k] = lo < 0 ? b : wrap(a + (turn * (k - lo)) / (hi - lo));
    }
    out.push({ frames: [i, j], minFraction });
    i = j;
  }
  return out;
}

/** Short spans `gap` frames apart or fewer, as one run each: its first and last frame, and the lowest fraction. */
export function mergeRuns(spans: readonly ShortSpan[], gap: number): ShortSpan[] {
  const out: ShortSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && s.frames[0] - last.frames[1] - 1 <= gap) {
      last.frames = [last.frames[0], s.frames[1]];
      last.minFraction = Math.min(last.minFraction, s.minFraction);
    } else out.push({ frames: [s.frames[0], s.frames[1]], minFraction: s.minFraction });
  }
  return out;
}

/**
 * Cap one-frame steps on a foreshortened segment (#110), in place. Where a
 * segment's picture length is under `SHORT_STEP_FRACTION` (0.60) of its median
 * on either side of a frame step (above `--short`'s hold cutoff, where two end-on
 * pixels still swing the angle faster than the limb moved) and the one-frame turn
 * exceeds `SHORT_STEP_CAP` (30°), spread the turn across a symmetric window of
 * frames the same way `spreadFlips` does (`lo = k - h - 1`, `hi = k + h`), bounded
 * by the ends of the pose and by any active alternate set on the chain (`covered`).
 */
export function capShortSteps(
  angles: number[],
  fraction: readonly number[],
  covered?: readonly boolean[],
  fractionCutoff: number = SHORT_STEP_FRACTION,
  stepCap: number = SHORT_STEP_CAP,
): ShortSpan[] {
  const n = angles.length;
  if (n < 2) return [];
  const out: ShortSpan[] = [];
  for (let segStart = 0; segStart < n;) {
    if (covered?.[segStart] === true) {
      segStart++;
      continue;
    }
    let segEnd = segStart;
    while (segEnd + 1 < n && covered?.[segEnd + 1] !== true) segEnd++;
    if (segEnd - segStart >= 1) {
      const u: number[] = new Array<number>(n).fill(0);
      u[segStart] = angles[segStart]!;
      for (let i = segStart + 1; i <= segEnd; i++) u[i] = u[i - 1]! + wrap(angles[i]! - angles[i - 1]!);
      const fits = (lo: number, hi: number) => Math.abs(u[hi]! - u[lo]!) <= stepCap * (hi - lo);
      interface Win { lo: number; hi: number; asked: number }
      const wins: Win[] = [];
      for (let k = segStart + 1; k <= segEnd; k++) {
        if (!(Math.min(fraction[k - 1]!, fraction[k]!) < fractionCutoff)) continue;
        const jump = u[k]! - u[k - 1]!;
        if (Math.abs(jump) <= stepCap) continue;
        let h = 1;
        let lo = Math.max(segStart, k - h - 1);
        let hi = Math.min(segEnd, k + h);
        while (!fits(lo, hi) && (lo > segStart || hi < segEnd)) {
          h++;
          lo = Math.max(segStart, k - h - 1);
          hi = Math.min(segEnd, k + h);
        }
        wins.push({ lo, hi, asked: jump });
      }
      for (let changed = true; changed;) {
        changed = false;
        wins.sort((a, b) => a.lo - b.lo);
        for (let i = 0; i + 1 < wins.length; i++) {
          const a = wins[i]!;
          const b = wins[i + 1]!;
          if (b.lo >= a.hi) continue;
          wins.splice(i, 2, { lo: a.lo, hi: Math.max(a.hi, b.hi), asked: Math.abs(b.asked) > Math.abs(a.asked) ? b.asked : a.asked });
          changed = true;
          break;
        }
        if (changed) continue;
        for (const w of wins) {
          if (fits(w.lo, w.hi) || (w.lo === segStart && w.hi === segEnd)) continue;
          w.lo = Math.max(segStart, w.lo - 1);
          w.hi = Math.min(segEnd, w.hi + 1);
          changed = true;
        }
      }
      for (const w of wins) {
        if (w.lo + 1 > w.hi - 1) continue;
        const step = (u[w.hi]! - u[w.lo]!) / (w.hi - w.lo);
        for (let i = w.lo + 1; i < w.hi; i++) angles[i] = wrap(u[w.lo]! + step * (i - w.lo));
        let minFraction = Infinity;
        for (let i = w.lo + 1; i <= w.hi - 1; i++) minFraction = Math.min(minFraction, fraction[i]!);
        if (!(minFraction < fractionCutoff)) {
          minFraction = Math.min(minFraction, fraction[w.lo]!, fraction[w.hi]!);
        }
        out.push({ frames: [w.lo + 1, w.hi - 1], minFraction, step: r3(step), asked: r3(w.asked) });
      }
    }
    segStart = segEnd + 1;
  }
  return out;
}

const spanOf = (frames: [number, number], times: readonly number[]): string =>
  frames[0] === frames[1] ? `frame ${frames[0]} (t=${times[frames[0]]!.toFixed(3)}s)` : `frames ${frames[0]}–${frames[1]} (t=${times[frames[0]]!.toFixed(3)}–${times[frames[1]]!.toFixed(3)}s)`;

export function shortLine(s: Short, times: readonly number[], cutoff: number): string {
  if (s.step !== undefined && s.asked !== undefined) {
    const sg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
    return `chain "${s.chain}" bone "${s.bone}" (${s.joints[0]} → ${s.joints[1]}) ${spanOf(s.frames, times)}: picture length down to ${s.minFraction.toFixed(2)} of its median, under ${SHORT_STEP_FRACTION.toFixed(2)}, turned ${sg(s.asked)} in one frame (over ${SHORT_STEP_CAP}°); spread to ${sg(s.step)} per frame`;
  }
  const lo = s.frames[0] - 1;
  const hi = s.frames[1] + 1;
  const held = lo < 0 && hi >= times.length
    ? 'no frame of the pose is at or above it, so nothing was held'
    : lo < 0 ? `held flat at frame ${hi}'s angle (the pose starts short)`
      : hi >= times.length ? `held flat at frame ${lo}'s angle (the pose ends short)`
        : `interpolated from frame ${lo}'s angle to frame ${hi}'s, the short way round`;
  return `chain "${s.chain}" bone "${s.bone}" (${s.joints[0]} → ${s.joints[1]}) ${spanOf(s.frames, times)}: picture length down to ${s.minFraction.toFixed(2)} of its median, under ${cutoff}; its direction is not read — ${held}`;
}

export function turnLine(e: Turn, times: readonly number[]): string {
  const how = e.reversed ? `reversed (pointing more than 90° from ${e.joints[0]} → ${e.joints[1]}'s own way), picture length down to ${e.minFraction.toFixed(2)} of its median` : `picture length down to ${e.minFraction.toFixed(2)} of its median, under ${TURN_FRACTION}`;
  return `line "${e.line}" (${e.joints[0]} → ${e.joints[1]}) ${spanOf(e.frames, times)}: ${e.seconds.toFixed(3)}s ${how}, ≥ ${TURN_SECONDS}s — the body or head turned, a pose the rig cannot draw`;
}

export function rangeLine(e: RangeDemand, times: readonly number[]): string {
  const sg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
  return `chain "${e.chain}" bone "${e.bone}" ${spanOf(e.frames, times)}: ${e.seconds.toFixed(3)}s the pose asks its rotate key past its range [${e.limits[0]}, ${e.limits[1]}] (${sg(e.key)}, up to ${e.maxOverflow.toFixed(1)}° past); clamped at the limit — demand for an alternate`;
}

export function endOnLine(e: EndOn, times: readonly number[], cutoff: number): string {
  return `chain "${e.chain}" bone "${e.bone}" (${e.joints[0]} → ${e.joints[1]}) ${spanOf(e.frames, times)}: ${e.seconds.toFixed(3)}s under ${cutoff} of its median picture length (down to ${e.minFraction.toFixed(2)}), ≥ ${END_ON_SECONDS}s — seen end-on, a pose the rig cannot draw`;
}

type Spread = Omit<Flip, 'chain' | 'bone' | 'joints'>;

/**
 * The flip guard on one angle series (degrees), in place. A turn greater than
 * `threshold` from frame k−1 to frame k is spread: for the smallest h ≥ 1, the
 * angles of frames k−h…k+h−1 are replaced by the straight line from frame
 * k−h−1 to frame k+h, taken through the unwrapped series (each one-frame turn
 * the short way round, so the jump keeps its own direction), such that every
 * one-frame turn in frames k−h…k+h is at or under the threshold. It is centred
 * on the jump, so the step happens when the input put it, spread over 2h frames,
 * and both ends are the input's own angles. A window that would cross the first
 * or the last frame stops there (`clipped`). Windows that overlap — one replaces
 * a frame the other ends on — merge into one line over both, widened again
 * while that line still turns faster than the threshold. Returns the spreads.
 */
export function spreadFlips(angles: number[], threshold: number): Spread[] {
  const n = angles.length;
  if (n < 2) return [];
  const u: number[] = [angles[0]!];
  for (let i = 1; i < n; i++) u.push(u[i - 1]! + wrap(angles[i]! - angles[i - 1]!));
  const fits = (lo: number, hi: number) => Math.abs(u[hi]! - u[lo]!) <= threshold * (hi - lo);
  interface Win { lo: number; hi: number; h: number; start: boolean; end: boolean; turns: Array<{ frame: number; jump: number }> }
  const wins: Win[] = [];
  for (let k = 1; k < n; k++) {
    const jump = u[k]! - u[k - 1]!;
    if (Math.abs(jump) <= threshold) continue;
    let h = 1;
    let lo = Math.max(0, k - h - 1);
    let hi = Math.min(n - 1, k + h);
    while (!fits(lo, hi) && (lo > 0 || hi < n - 1)) {
      h++;
      lo = Math.max(0, k - h - 1);
      hi = Math.min(n - 1, k + h);
    }
    wins.push({ lo, hi, h, start: k - h - 1 < 0, end: k + h > n - 1, turns: [{ frame: k, jump }] });
  }
  // Merge overlapping windows; a merged line that turns too fast widens by one on each side, then merges again.
  for (let changed = true; changed;) {
    changed = false;
    wins.sort((a, b) => a.lo - b.lo);
    for (let i = 0; i + 1 < wins.length; i++) {
      const a = wins[i]!;
      const b = wins[i + 1]!;
      if (b.lo >= a.hi) continue;
      wins.splice(i, 2, { lo: a.lo, hi: Math.max(a.hi, b.hi), h: Math.max(a.h, b.h), start: a.start || b.start, end: a.end || b.end, turns: [...a.turns, ...b.turns].sort((x, y) => x.frame - y.frame) });
      changed = true;
      break;
    }
    if (changed) continue;
    for (const w of wins) {
      if (w.turns.length < 2 || fits(w.lo, w.hi) || (w.lo === 0 && w.hi === n - 1)) continue;
      if (w.lo === 0) w.start = true;
      if (w.hi === n - 1) w.end = true;
      w.lo = Math.max(0, w.lo - 1);
      w.hi = Math.min(n - 1, w.hi + 1);
      w.h++;
      changed = true;
    }
  }
  return wins.map((w) => {
    const step = (u[w.hi]! - u[w.lo]!) / (w.hi - w.lo);
    for (let i = w.lo + 1; i < w.hi; i++) angles[i] = wrap(u[w.lo]! + step * (i - w.lo));
    const top = w.turns.reduce((m, t) => (Math.abs(t.jump) > Math.abs(m.jump) ? t : m));
    return {
      jump: top.jump,
      turns: w.turns,
      frames: [w.lo + 1, w.hi - 1] as [number, number],
      h: w.h,
      step,
      clipped: w.start && w.end ? 'both' : w.start ? 'start' : w.end ? 'end' : null,
    };
  });
}

export function flipLine(f: Flip, times: readonly number[], threshold: number): string {
  const sg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
  const turns = f.turns.map((t) => `${sg(t.jump)} from frame ${t.frame - 1} to ${t.frame} (t=${times[t.frame - 1]!.toFixed(3)}–${times[t.frame]!.toFixed(3)}s)`).join(', ');
  const span = f.frames[0] > f.frames[1] ? 'no frame (the pose has none between the two)' : f.frames[0] === f.frames[1] ? `frame ${f.frames[0]}` : `frames ${f.frames[0]}–${f.frames[1]}`;
  const clip = f.clipped === null ? '' : f.clipped === 'both' ? '; the window was cut short by both ends of the pose' : `; the window was cut short at the ${f.clipped === 'start' ? 'first' : 'last'} frame of the pose`;
  const still = Math.abs(f.step) > threshold ? ` — still over ${threshold}°: the pose is too short to spread it` : '';
  return `chain "${f.chain}" bone "${f.bone}" (${f.joints[0]} → ${f.joints[1]}) turned ${turns}, over ${threshold}° in one frame; spread over ${span} (h=${f.h}), ${sg(f.step)} per frame${clip}${still}`;
}

/** Frames before the first with a direction take its value; none at all is a problem. */
function fillLeading(angles: number[], none: () => void): void {
  const firstReal = angles.findIndex((a) => !Number.isNaN(a));
  if (firstReal < 0) {
    none();
    return;
  }
  for (let i = 0; i < firstReal; i++) angles[i] = angles[firstReal]!;
}

function checkHinge(c: Chain, k: number, targets: Map<string, number[]>, restOf: Map<string, number>, times: readonly number[], opts: RetargetOptions, out: BendEvent[], p: Problems): void {
  if (c.bend === 'free') return;
  const upper = c.bones[k - 1]!;
  const lower = c.bones[k]!;
  const joint = c.joints[k]!;
  const restInner = wrap(restOf.get(lower)! - restOf.get(upper)!);
  let side: 1 | -1;
  if (c.bend === 'ccw') side = 1;
  else if (c.bend === 'cw') side = -1;
  else {
    if (Math.abs(restInner) < 0.5) {
      p.add('MAP_BEND_SIDE', `chain "${c.name}" — the hinge at ${joint} is straight at rest (inner angle ${restInner.toFixed(3)}°), so the rest pose does not say which way it bends; state "bend": "ccw", "cw" or "free"`);
      return;
    }
    side = restInner > 0 ? 1 : -1;
  }
  const up = targets.get(upper)!;
  const lo = targets.get(lower)!;
  for (let i = 0; i < up.length; i++) {
    const inner = wrap(lo[i]! - up[i]!);
    if (inner * side < -opts.bendTolerance) {
      out.push({ chain: c.name, joint, frame: i, t: times[i]!, angle: inner, side, rest: restInner });
      if (opts.bends === 'clamp') lo[i] = up[i]!;
    }
  }
}

export function bendLine(e: BendEvent): string {
  const sense = e.side > 0 ? 'counter-clockwise (+)' : 'clockwise (−)';
  return `chain "${e.chain}" hinge ${e.joint}, frame ${e.frame} (t=${e.t.toFixed(3)}s) — inner angle ${e.angle.toFixed(1)}°; it bends ${sense} at rest (${e.rest.toFixed(1)}°), so the angle must stay ${e.side > 0 ? '≥' : '≤'} 0`;
}

/** Holds grouped per point, one line each span. */
export function holdLine(h: Hold, times: readonly number[]): string {
  const span = h.from === h.to ? `frame ${h.from} (t=${times[h.from]!.toFixed(3)}s)` : `frames ${h.from}–${h.to} (t=${times[h.from]!.toFixed(3)}–${times[h.to]!.toFixed(3)}s)`;
  return `point "${h.point}" ${span}: ${h.why}; held frame ${h.source}'s value`;
}
