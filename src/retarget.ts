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
import type { Chain, JointMap, Rest, RigSets, RigSlots } from './map.ts';
import { aimAngle, aimEnds, bodyYawSets, descends, faceYawSets, knownSetsOf, partBone, pointParts, rigPoint } from './map.ts';
import type { DepthGait, Joint, Travel } from './pose.ts';
import { TRAVEL_IN_PLACE } from './pose.ts';
import { Problems, Refusal } from './problems.ts';
import type { ArtRange, AttachmentKey, ByHip, Raised, ReachShort, SetRuns, SlotTrack, Switch, SwitchBind, SwitchOptions } from './switch.ts';
import { bindProblems, clampArt, coveredChains, isRaised, keyAtFrame, keyDrawnProblems, measureArt, overflow, phaseGroupProblems, RAISED_WRIST_EYES, RANGE_SLACK, reachLimit, runsOf, selectSwitches, switchBinds, twoBone } from './switch.ts';
import type { BlendHold, Closure, Feet, Floor, LegScale, LegSegmentRatio, PathPose, Posing, Side, Stance } from './legs.ts';
import { contactKeysOf, type ContactKeys } from './contacts.ts';
import { figureScaleOf, freeAnkleShiftOf, holdBlend, isLegSegment, legScaleOf, legsOf, pathFrom, percentile, plantHip, posePath, rootOf, scaleSupport, shiftOver, SIDES, stanceOf, stanceRangeOf, STRAIGHT_PERCENTILE, supportsOf, tipOf, unshortenStanceShin } from './legs.ts';
import type { BodyReading, FaceReading, YawSetSwitch } from './face.ts';
import { readBody, readFace, readFaceAngles, selectYawSets } from './face.ts';

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

/**
 * Beat-nod phase-coupling gain (`°/unit`) from the clamped `head.translate.y`
 * offset (`clampedY`, bounded by `±2%` of neck length) onto `map.face.pitch`
 * (`pitch_dial.rotate`, `rig-c/pose#190`, `#205`) when the neck-length clamp
 * acts on the sequence. Measured on the dancer reference hand pass (`hand/p1`
 * HP2: `+2.8°/unit`).
 */
export const NOD_RESIDUAL_PITCH_GAIN = 2.8;

/**
 * Beat-nod phase-coupling gain (`°/unit`) from the clamped `head.translate.y`
 * offset (`clampedY`, bounded by `±2%` of neck length) onto the head chain
 * bone's `rotate` track (`head.rotate`, `rig-c/pose#190`, `#205`) when the
 * neck-length clamp acts on the sequence. Measured on the dancer reference
 * hand pass (`hand/p1` HP2: `+1.6°/unit`).
 */
export const NOD_RESIDUAL_HEAD_GAIN = 1.6;

/**
 * Reference frame for sets declaring `anchor` (`rig-c/pose#191`): `'head-local'`
 * rotates the set's drawn hand-tip-to-head offset by the head bone's posed world
 * turn on each frame; `'world-fixed'` holds the unrotated setup world offset;
 * `'off'` disables head-anchored end-effector solving.
 */
export const HEAD_ANCHOR_FRAME: 'head-local' | 'world-fixed' | 'off' = 'head-local';

/** How the nod's baseline was read (rig-c/pose#241): none on an in-place sequence (frame 0, no clamp), else the ±0.5 s detrend window, wrapped on a `clean --loop` sequence or cut at the clip's ends. */
export type NodWindow = 'in-place' | 'wrapped' | 'cut';

export interface HeadNodReading {
  bone: string;
  /** The chain that carries the eye line (rig-c/pose#241). */
  chain: string;
  maxNod: number;
  rawY: number[];
  clampedY: number[];
  residual: number[];
  /** The baseline's window (#241), and its half width in frames (0 in place). */
  window: NodWindow;
  halfWin: number;
  /** Whether a translate track was keyed (false: the eyes did not move against the neck past the writer's rounding). */
  keyed: boolean;
}

/** Why the eye-line chain keys no nod (rig-c/pose#241): switched off in the map, or a reading it cannot take. */
export interface NodSkipped {
  bone: string;
  chain: string;
  why: string;
}

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
  /** The sequence's `travel` (rig-c/pose#92, #242): "in-place" reads the supports, the camera-zoom normalisations and the head nod as a loop, with or without --plant-feet, and makes --plant-feet let the supporting foot follow its own track and close the loop; absent, nothing changes. */
  travel?: Travel;
  /** The sequence was cleaned with `--loop` (its `cleaned.params.loop`): the head nod's detrend window wraps (#241), and the animation includes the closing frame interval (#275). */
  loop?: boolean;
  /**
   * rig-c/pose#288: the sequence's pelvis track (`pelvisTilt` per frame, null where
   * declined, and its `pelvisSource`). The pelvis chain's bone (a chain whose
   * joints are r_hip → l_hip) is keyed from it on every frame it reads, and from
   * the hip line on the frames it does not; absent, from the hip line.
   */
  pelvis?: { source: string; tilt: ReadonlyArray<number | null> };
  /**
   * rig-c/pose#303: the hand contact keys (`--contact-keys`), read against the
   * sequence. Applied last over the supports read (`contactKeysOf`): on every
   * frame they cover they decide the support. Absent, nothing changes.
   */
  contactKeys?: ContactKeys;
  /**
   * rig-c/pose#344: the gait the sequence was cleaned as (its `cleaned.params.depth.gait`, `clean --depth`). An
   * in-place walk anchors the upper body (`TorsoAnchor`): the pelvis sways under it. Absent, or a run, nothing changes.
   */
  gait?: DepthGait;
}

/**
 * rig-c/pose#344: in an in-place walk the upper body is the anchor and the pelvis sways under it. The pelvis bone
 * carries the torso (its child), so its turn and its travel would swing the chest around it; the first spine bone
 * (`bone`: the pelvis bone's child on the way to the trunk chain's bone) is keyed with the counter: a rotate of minus
 * the pelvis's turn (none when it is the trunk bone itself, whose aim is already in the world), and a translate that
 * puts its origin back where the pelvis's turn moved it from, up and down, and sideways where it carries `point`
 * (the trunk chain's aim bone: the top of the trunk) on the drawn neck's own sideways path: about the world x `x`
 * (the setup x plus the pelvis's mean travel), the picture's `joint` x less its mean, times `factor` — the pelvis's
 * sideways sway in the rig against the drawing's (`joints[0]`, mid_hip), each its standard deviation over the frames,
 * so the neck sways against the pelvis as the drawing's does; the figure's scale where the drawing's pelvis does not
 * sway. The pelvis's own keys are as read; `neck` is the carried path's peak-to-peak and `sway` the first spine bone's
 * sideways counter's, world units.
 */
export interface TorsoAnchor {
  gait: DepthGait;
  bone: string;
  point: string;
  joint: string;
  x: number;
  factor: number;
  neck: number;
  sway: number;
}

/**
 * rig-c/pose#288: where the pelvis bone's rotation came from. `source` is the
 * track's (`silhouette`, `waistband`, `keys`) or "hip line"; `bone`/`chain` the
 * map's pelvis chain (null without one, when nothing is keyed); `swing` the
 * peak-to-peak of its rotate keys, degrees (null when not keyed); `track` and
 * `hipLine` how many frames each keyed; `trackSource` the track's source when the
 * sequence carries one (also when it read no frame and the hip line was keyed).
 */
export interface PelvisReading {
  source: string;
  trackSource: string | null;
  bone: string | null;
  chain: string | null;
  swing: number | null;
  track: number;
  hipLine: number;
  /** The frames keyed from the hip line on a sequence that carries a track: the frames its reading declined. */
  declined: Array<[number, number]>;
  /** rig-c/pose#344: the torso held over the swaying pelvis, in an in-place walk only. */
  anchor?: TorsoAnchor;
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
  /** Present when a horizontal chain across the body (`isAcross`) held its last confident angle (#184). */
  across?: boolean;
  /** Largest one-frame turn (degrees, signed) inside a held horizontal-chain span when it reversed beyond `--flip` (#184). */
  reversed?: number;
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
  property: 'rotate' | 'translate' | 'scalex' | 'scaley';
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

/**
 * A `reach` chain whose aim departs from its pose pair's own picture angle
 * (rig-c/pose#236), and the two things that make it: the bone's origin sits off
 * the anchor's (a lever: the target is the pair's end, so a pair turning by θ
 * about the anchor turns the aim from an origin partway up it by more than θ),
 * or a bone above it is turned, or translated other than by the anchor's own
 * travel (which the target carries too, so it cancels). A reading — the keys
 * are the reach's, unchanged.
 */
export interface ReachReading {
  chain: string;
  bone: string;
  /** The pair: the chain's first joint (the translated joint) and its second. */
  joints: [string, string];
  /** The anchor (the translated bone), and the setup distance from its origin to the bone's: world units, and as a fraction of the reached length (the pair's median picture length, scaled). */
  anchor: string;
  offset: { units: number; ofLength: number };
  /** The bones above it the animation moves: by a rotate track, or a translate track other than the anchor's. */
  above: Array<{ bone: string; property: 'rotate' | 'translate'; chain: string | null }>;
  /** aim − the pair's angle, degrees: the largest |·| over the frames and its frame, and the mean |second difference| of it, °/frame². */
  departure: { max: number; frame: number; meanD2: number | null };
  /** Mean |second difference|, °/frame², of the reach's aim and of the pair's own angle, over every frame; and aim ÷ pair (null when the pair is still: its figure rounds to 0). */
  aimD2: number | null;
  pairD2: number | null;
  ratio: number | null;
}

/**
 * rig-c/pose#282: where a `reach` chain's bone starts against the source joint
 * it re-aims from. The pose's pair starts at the translated joint, which the
 * rig puts at the translated bone's posed origin; the reach aims from its own
 * bone's posed origin. The distance between the two, at setup and on the
 * frames, is the lever #236 names — a reading, with a WARN past
 * `REACH_ORIGIN_WARN` of the segment. One per reach chain, in map order.
 */
export interface ReachOrigin {
  chain: string;
  bone: string;
  /** The pair: the chain's first joint (the translated joint) and its second. */
  joints: [string, string];
  /** The translated bone, whose posed origin is where the rig puts the source joint. */
  anchor: string;
  /** The distance at setup, world units. */
  setup: number;
  /** The largest distance as posed on the frames, world units, and its frame. */
  posed: { max: number; frame: number };
  /** The reached length: the pair's median picture length, scaled (world units). */
  segment: number;
  /** max(setup, posed.max) ÷ segment. */
  ofSegment: number;
  /** ofSegment > threshold. */
  warn: boolean;
  threshold: number;
}

/**
 * Mean |second difference| of a series of angles, degrees: |wrap(v[i+1] − v[i])
 * − wrap(v[i] − v[i−1])| over every i whose three frames `ok` admits (every
 * frame when it is omitted), and how many triples that was. null on none.
 */
export function meanSecondDiff(series: ReadonlyArray<readonly number[]>, ok?: (i: number) => boolean): { value: number | null; triples: number } {
  let sum = 0;
  let triples = 0;
  for (const v of series) {
    for (let i = 1; i + 1 < v.length; i++) {
      if (ok !== undefined && !(ok(i - 1) && ok(i) && ok(i + 1))) continue;
      sum += Math.abs(wrap(v[i + 1]! - v[i]!) - wrap(v[i]! - v[i - 1]!));
      triples++;
    }
  }
  return { value: triples === 0 ? null : sum / triples, triples };
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
  /** rig-c/pose#240: what the figure scale is read against — its segment's foreshortening, the legs' and hips' ratios, the hip's travel; null without a scale. */
  scaleFit: ScaleFit | null;
  /** The spans each alternate set shows, with their art turn. */
  switches: Switch[];
  /** rig-c/pose#279: per set without a `phase`, the runs it was nearest on and the runs the minimum span suppressed. */
  switchRuns: SetRuns[];
  /** rig-c/pose#360: per set with a `bind`, its bound frames. */
  switchBinds: SwitchBind[];
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
  /** rig-c/pose#237: every mapped leg segment's picture length ÷ straight (min, median, max), with or without --leg-scale. */
  segments: LegSegmentRatio[];
  /** rig-c/pose#237: each side's straight leg, the 95th percentile of its picture length hip → ankle, px (LEG-SCALE's percentile, against FEET's median); null without both legs read. */
  legStraight: Record<Side, number> | null;
  /** rig-c/pose#237: each side's rig leg at setup, thigh origin → ankle, world units — the leg length a clamp's shift of the ankle is read in; null without both legs. */
  rigLeg: Record<Side, number> | null;
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
  /** On an in-place sequence without --plant-feet (#242): the translated bone's world x on the last frame less its x on the first, which nothing closes; null otherwise, and when no bone is translated. */
  openDrift: number | null;
  /** Each ankle's world position on every frame, as the keys put it, when legs are scaled or feet planted. */
  ankles: { bones: Record<Side, string>; at: Record<Side, Pt[]> } | null;
  /** The translated bone's origin against its thigh roots' midpoint, at setup. */
  pivot: Pivot | null;
  /** With --raised-by-head: each raised set's span on each raised chain, its wrist placed against the head. */
  raised: Raised[];
  /** Each span of a `place: "by-hip"` set on each chain it places, its wrist placed against the hip (#93). */
  byHip: ByHip[];
  /** With "face" in the map (#138): per-frame yaw/pitch reading and range-compressed mapping. */
  face: FaceReading | null;
  /** Per-frame body yaw read from camera-normalised shoulder and hip width (#173), and optional "body.yaw" dial mapping. */
  body: BodyReading | null;
  /** Continuous per-frame figure scale relative to frame 0 (`#163`, `#161`). */
  figureScale: FigureScaleReading;
  /** Per-frame vertical head nod reading (`rawY`, `clampedY`, and clamped `residual`, `#111`, `#181`, `#190`). */
  headNod: HeadNodReading | null;
  /** The eye-line chain keys no nod, and why (rig-c/pose#241); null when it does or when no chain carries the eye line. */
  nodSkipped: NodSkipped | null;
  /** Each `reach` chain hanging below a bone the animation turns or translates (#236): its aim's departure from the pose pair's angle. */
  reach: ReachReading[];
  /** rig-c/pose#282: each `reach` chain's origin against the source joint it re-aims from; empty when the map has none. */
  reachOrigin: ReachOrigin[];
  /** rig-c/pose#288: the pelvis bone's source; null when the map has no pelvis chain and the sequence no track. */
  pelvis: PelvisReading | null;
}

export interface FigureScaleFrame {
  frame: number;
  t: number;
  /** Continuous rate-limited figure scale relative to frame 0 (`s[0] = 1`, step ≤ 1%/frame, held on frozen spans). */
  s: number;
  /** Raw standing-height ratio relative to frame 0 (`raw[i] / raw[0]`). */
  rawS: number;
}

export interface FigureScaleReading {
  /** Largest frame-to-frame relative change `|s[i] - s[i-1]| / s[i-1]` and the frame `i` where it occurs. */
  maxStep: { step: number; frame: number; t: number };
  /** Ending scale over frame 0 (`s[n-1] / s[0]`). */
  endOverStart: number;
  /** Per-frame continuous scale `s` and raw scale `rawS`. */
  frames: FigureScaleFrame[];
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

/** A ratio band, rig units per picture px: the rig's length over the picture's straight (95th percentile) length, to over its median. */
export interface ScaleBand {
  /** rig / picture 95th percentile — the factor that matches the length where the picture shows it longest. */
  lo: number;
  /** rig / picture median — the factor that matches it on the median frame. */
  hi: number;
}

/** rig-c/pose#240: the figure scale beside what it could have been read off instead. */
export interface ScaleFit {
  /** The `translate.scale.pose` segment: its median picture length (what the factor divides by) against its 95th percentile. */
  segment: { joints: [string, string]; median: number; straight: number; ratio: number };
  /** Each side's leg, hip → ankle: the rig's at setup (thigh origin → ankle, units), the picture's median and 95th percentile (px), and the band rig ÷ those; null without both legs. */
  leg: { rig: Record<Side, number>; median: Record<Side, number>; straight: Record<Side, number>; band: ScaleBand; within: boolean } | null;
  /** The hips' width: the rig's thigh roots apart at setup (units), the picture's r_hip → l_hip median and 95th percentile (px), and the band; null without both legs and both hips read. */
  hip: { rig: number; median: number; straight: number; band: ScaleBand; within: boolean } | null;
  /** Whether `scale.factor` lies outside the leg band and outside the hip band (`withinPx`); null unless both are read. */
  outside: boolean | null;
  /** The translated joint's range over the frames, x and y: the pose's in px, the keyed bone's world origin in units — each also in leg lengths (the pose's straight leg, the rig's at setup, the two sides' mean) and hip widths (the pose's 95th percentile, the rig's at setup); null where the unit is not read. */
  travel: {
    joint: string;
    bone: string;
    pose: { x: number; y: number; legs: [number, number] | null; hips: [number, number] | null };
    rig: { x: number; y: number; legs: [number, number] | null; hips: [number, number] | null };
  };
}

/**
 * Whether `scale.factor` sizes a length as the picture shows it: the rig's
 * length carried into the picture by the factor (rig ÷ factor, px) lies between
 * the picture's median and 95th percentile, give or take one picture px — the
 * picture's own unit, so a band the picture never widened (a length it shows the
 * same on every frame) is not missed by a rounding the picture cannot show.
 */
export function withinPx(factor: number, rig: number, median: number, straight: number): boolean {
  const px = rig / factor;
  return px >= Math.min(median, straight) - 1 && px <= Math.max(median, straight) + 1;
}


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

/** Two bones' setup origins apart, world units: the rig's hip width when they are the thigh roots. */
function rootsApart(rest: Rest, a: string, b: string): number {
  const x = rest.get(a)!;
  const y = rest.get(b)!;
  return Math.hypot(y.worldX - x.worldX, y.worldY - x.worldY);
}

const rangeOf = (xs: readonly number[]): number => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs));

/** rig-c/pose#240: the SCALE reading, from fields the retarget already read — nothing here changes a key. */
function scaleFitOf(o: {
  joints: [string, string]; joint: string; bone: string; lengths: number[]; factor: number;
  series: ReadonlyMap<string, Pt[]>; good: ReadonlyMap<string, boolean[]>;
  legLength: Record<Side, number> | null; legStraight: Record<Side, number> | null; rigLeg: Record<Side, number> | null;
  rigHip: number | null; origin: readonly Pt[];
}): ScaleFit {
  const segMedian = median(o.lengths);
  const segStraight = percentile(o.lengths, STRAIGHT_PERCENTILE);
  const leg = o.legLength === null || o.legStraight === null || o.rigLeg === null ? null : (() => {
    const rig = o.rigLeg!, med = o.legLength!, str = o.legStraight!;
    const at = (q: Record<Side, number>) => SIDES.map((s) => rig[s] / q[s]);
    return { rig, median: med, straight: str, band: { lo: Math.min(...at(str)), hi: Math.max(...at(med)) }, within: SIDES.some((s) => withinPx(o.factor, rig[s], med[s], str[s])) };
  })();
  const hipWidths: number[] = [];
  const R = o.series.get('r_hip'), L = o.series.get('l_hip'), gr = o.good.get('r_hip'), gl = o.good.get('l_hip');
  if (R !== undefined && L !== undefined && gr !== undefined && gl !== undefined) {
    for (let i = 0; i < R.length; i++) if (gr[i] && gl[i]) hipWidths.push(Math.hypot(L[i]![0] - R[i]![0], L[i]![1] - R[i]![1]));
  }
  const hipMedian = hipWidths.length === 0 ? NaN : median(hipWidths);
  const hipStraight = percentile(hipWidths, STRAIGHT_PERCENTILE);
  const hip = o.rigHip === null || !(hipMedian > 1e-6) || !(hipStraight > 1e-6) || !(o.rigHip > 1e-6) ? null
    : { rig: o.rigHip, median: hipMedian, straight: hipStraight, band: { lo: o.rigHip / hipStraight, hi: o.rigHip / hipMedian }, within: withinPx(o.factor, o.rigHip, hipMedian, hipStraight) };
  const P = o.series.get(o.joint)!;
  const px = rangeOf(P.map((p) => p[0])), py = rangeOf(P.map((p) => p[1]));
  const ux = rangeOf(o.origin.map((p) => p[0])), uy = rangeOf(o.origin.map((p) => p[1]));
  const mean = (q: Record<Side, number>) => (q.r + q.l) / 2;
  const per = (x: number, y: number, unit: number | null): [number, number] | null => (unit === null || !(unit > 1e-6) ? null : [x / unit, y / unit]);
  return {
    segment: { joints: o.joints, median: segMedian, straight: segStraight, ratio: segMedian / segStraight },
    leg,
    hip,
    outside: leg === null || hip === null ? null : !leg.within && !hip.within,
    travel: {
      joint: o.joint,
      bone: o.bone,
      pose: { x: px, y: py, legs: per(px, py, o.legStraight === null ? null : mean(o.legStraight)), hips: per(px, py, hip === null ? null : hip.straight) },
      rig: { x: ux, y: uy, legs: per(ux, uy, o.rigLeg === null ? null : mean(o.rigLeg)), hips: per(ux, uy, hip === null ? null : hip.rig) },
    },
  };
}

/**
 * Retarget. Refuses (every reason at once) when a point the map needs is never
 * good, when a hinge's side cannot be read off a straight rest, and — with
 * `bends: 'refuse'` — when a hinge bends the wrong way.
 */
export function retarget(rest: Rest, map: JointMap, frames: ReadonlyArray<Partial<Record<Body18, Joint>>>, times: readonly number[], opts: RetargetOptions, slots: RigSlots = new Map(), rigSets: RigSets = new Map()): Retarget {
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
  const headAnchorBone = map.alternates.some((a) => a.anchor !== undefined) ? headBoneOf(map) : null;
  if (map.alternates.some((a) => a.anchor !== undefined) && headAnchorBone === null) {
    p.add('ANCHOR_HEAD', '"anchor" anchors a set\'s hand to the head bone\'s local frame, and no chain of the map carries the eye line (joints r_eye → l_eye)');
  }

  // Every point the map reads, held where it is not good.
  const needed = new Set<string>();
  for (const c of map.chains) c.joints.forEach((j) => needed.add(j));
  if (map.translate !== null) {
    needed.add(map.translate.joint);
    map.translate.scale.pose.forEach((j) => needed.add(j));
  }
  if (map.face !== undefined) {
    needed.add('nose');
    needed.add('r_eye');
    needed.add('l_eye');
  }
  if (map.body !== undefined) {
    needed.add('r_shoulder');
    needed.add('l_shoulder');
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
  /** The scale segment's picture length on every frame both its points are good (#240's SCALE reading). */
  let scaleLengths: number[] = [];
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
        scaleLengths = lengths;
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
  // rig-c/pose#288: the pelvis chain (one bone, joints r_hip → l_hip either way) keyed from the track where it reads.
  const pelvisChain = map.chains.find((c) => !c.reach && c.bones.length === 1 && ((c.joints[0] === 'r_hip' && c.joints[1] === 'l_hip') || (c.joints[0] === 'l_hip' && c.joints[1] === 'r_hip'))) ?? null;
  const track = opts.pelvis !== undefined && opts.pelvis.tilt.length === n ? opts.pelvis.tilt : null;
  const fromTrack = pelvisChain !== null && track !== null && track.some((v) => v !== null) ? pelvisChain.bones[0]! : null;
  for (const c of map.chains) {
    c.bones.forEach((b, k) => {
      restOf.set(b, restAngle(rest, b, c.aim[k]!));
      if (c.reach) return;
      const from = series.get(c.joints[k]!)!;
      const to = series.get(c.joints[k + 1]!)!;
      const angles: number[] = [];
      for (let i = 0; i < n; i++) {
        const v = b === fromTrack ? track![i] : null;
        if (v !== null && v !== undefined) {
          // The track is the r_hip → l_hip direction; a chain written l_hip → r_hip aims the other way.
          angles.push(c.joints[0] === 'r_hip' ? v : wrap(v + 180));
          continue;
        }
        const d = Math.hypot(to[i]![0] - from[i]![0], to[i]![1] - from[i]![1]);
        angles.push(d > 1e-9 ? pictureAngle(from[i]!, to[i]!) : (angles[i - 1] ?? NaN));
      }
      fillLeading(angles, () => p.add('POSE_SEGMENT_ZERO', `chain "${c.name}" — bone "${b}"'s segment ${c.joints[k]} → ${c.joints[k + 1]} has zero length on every frame; it has no direction`));
      targets.set(b, angles);
    });
  }
  p.throwIfAny();

  // rig-c/pose#344: an in-place walk holds the upper body over the swaying pelvis, on the first spine bone.
  const anchorOf = ((): { bone: string; trunk: string; point: string; pelvis: string; joints: [string, string] } | null => {
    if (opts.gait !== 'walk' || opts.travel !== TRAVEL_IN_PLACE || pelvisChain === null) return null;
    const pelvisBone = pelvisChain.bones[0]!;
    const trunk = map.chains.find((c) => !c.reach && c.joints[0] === 'mid_hip' && descends(rest, c.bones[0]!, pelvisBone));
    if (trunk === undefined) return null;
    const tb = trunk.bones[0]!;
    let first = tb;
    while (rest.get(first)!.parent !== pelvisBone) first = rest.get(first)!.parent!;
    // The aim's upper end (aimEnds: `neck` and `chest>neck` alike end at the neck), a rig point on the trunk bone or below it.
    const aim = trunk.aim[0]!;
    const top = aim === 'x' ? null : aimEnds(tb, aim)[1];
    const onTrunk = top !== null && pointParts(top).every((part) => {
      const b = partBone(part);
      return rest.has(b) && (b === tb || descends(rest, b, tb));
    });
    const point = onTrunk ? top! : tb;
    return { bone: first, trunk: tb, point, pelvis: pelvisBone, joints: [trunk.joints[0]!, trunk.joints[1]!] };
  })();
  if (anchorOf !== null && anchorOf.bone !== anchorOf.trunk && !targets.has(anchorOf.bone)) {
    // Not in a chain: its world turn is held at setup, so the bones below it are keyed against none.
    const a0 = restAngle(rest, anchorOf.bone, 'x');
    restOf.set(anchorOf.bone, a0);
    targets.set(anchorOf.bone, Array.from({ length: n }, () => a0));
  }

  // The short hold, on every segment the pose aims directly (not a reach): its
  // picture length against its own median, on the points the angle was read from.
  // A horizontal line across the body (`isAcross`: pelvis, shoulders, head line)
  // holds and interpolates across spans under `--short` or reversed within a frame
  // beyond `--flip` (#184), without listing the run as `endOn` (`TURN` reads turned
  // body/head lines).
  const short: Short[] = [];
  const endOn: EndOn[] = [];
  const fractions = new Map<string, { chain: string; joints: [string, string]; fraction: number[] }>();
  if (opts.short !== 'off' || opts.flip !== 'off') {
    for (const c of map.chains) {
      if (c.reach) continue;
      c.bones.forEach((b, k) => {
        const joints: [string, string] = [c.joints[k]!, c.joints[k + 1]!];
        const across = isAcross(joints[0], joints[1]);
        if (!across && opts.short === 'off') return;
        // rig-c/pose#288: a pelvis keyed from its track is not read off the hip pair's length, so it is not held across it.
        if (b === fromTrack) return;
        const from = series.get(joints[0])!;
        const to = series.get(joints[1])!;
        const lengths = from.map((f, i) => Math.hypot(to[i]![0] - f[0], to[i]![1] - f[1]));
        const med = median(lengths);
        if (med < 1e-6) {
          if (opts.short !== 'off') {
            p.add('POSE_SHORT_MEDIAN', `chain "${c.name}" — bone "${b}"'s segment ${joints[0]} → ${joints[1]} has median picture length ${med}px over the ${n} frames; --short measures a frame's length against that median, and there is none to measure against`);
          }
          return;
        }
        const fraction = lengths.map((l) => l / med);
        if (across) {
          const restDir = joints[0].startsWith('r_') ? 0 : 180;
          const spans = holdAcross(targets.get(b)!, fraction, opts.short, opts.flip, restDir);
          for (const s of spans) short.push({ chain: c.name, bone: b, joints, ...s });
          return;
        }
        const cutoff = opts.short as number;
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
    // #238: one line per hinge — its count, worst angle, frame range and the remedy; the per-frame lines are its detail (--verbose).
    for (const g of bendGroups(bends)) p.add('POSE_BEND_ONE_WAY', bendGroupLine(g, 'refuse'), g.events.map((e) => ({ code: 'POSE_BEND_ONE_WAY', text: bendLine(e) })));
  }
  p.throwIfAny();

  // The legs (#47): each leg segment's scale, the supports and jumps, and with
  // --plant-feet the hip derived from the supporting foot — before the reaches,
  // which are aimed from where the hip is.
  const legScaleOn = opts.legScale !== undefined && opts.legScale !== 'off';
  const plantOn = opts.plantFeet === true;
  /**
   * #92, #242: the sequence declares itself in place. A property of the sequence, not of --plant-feet: every reading
   * below takes it with or without the flag — the supports (no step releases a foot), the camera-zoom normalisations
   * (#159, #163, #173: a loop has no zoom, and their rolling windows do not wrap), the trunk scale (#172) and the head
   * nod (no detrend window, no clamp). What only planting can do — the supporting foot following its own track and the
   * loop closed on the planted hip — stays under `plantOn`, and without it `openDrift` says what was not closed.
   */
  const inPlace = opts.travel === TRAVEL_IN_PLACE;
  let closure: Closure | null = null;
  let openDrift: number | null = null;
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
  // rig-c/pose#303: the contact keys decide last, over every reading above; with no support read they have nothing to decide, so they are refused.
  if (opts.contactKeys !== undefined) {
    if (feet !== null) feet = contactKeysOf(feet, opts.contactKeys);
    else p.add('CONTACT_KEYS', `--contact-keys sets which foot supports, and no support is read: ${legs !== null && 'problems' in legs ? legs.problems.join('; ') : `the map's chains use ${['r_hip', 'l_hip', 'r_ankle', 'l_ankle'].filter((j) => !series.has(j)).join(', ')} nowhere`}`);
  }
  const heldPt = (name: string): Pt[] | null => {
    const known = series.get(name);
    if (known !== undefined) return known;
    const h = heldOf(name);
    return 'never' in h ? null : h.at;
  };
  const winPercentile = (xs: readonly number[], w: number, q: number): number[] => {
    const effW = Math.min(w, Math.floor((n - 1) / 2));
    if (effW <= 0) return [...xs];
    return xs.map((_, i) => {
      const c = Math.max(effW, Math.min(n - 1 - effW, i));
      return percentile(xs.slice(c - effW, c + effW + 1), q);
    });
  };
  const dist2 = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
  let fixedCamera = false;
  const rawFigureHeight: number[] = (() => {
    const ar = heldPt('r_ankle');
    const al = heldPt('l_ankle');
    const hr = heldPt('r_hip');
    const hl = heldPt('l_hip');
    if (ar !== null && al !== null && hr !== null && hl !== null) {
      const kr = heldPt('r_knee');
      const kl = heldPt('l_knee');
      const legSum = ar.map((r, i) =>
        kr !== null && kl !== null
          ? Math.max(dist2(hr[i]!, kr[i]!) + dist2(kr[i]!, r), dist2(hl[i]!, kl[i]!) + dist2(kl[i]!, al[i]!))
          : Math.max(dist2(r, hr[i]!), dist2(al[i]!, hl[i]!)),
      );
      if (legSum.every((v) => v > 1e-6)) {
        if (n > 160) {
          const seriesList: number[][] = [winPercentile(legSum, 75, STRAIGHT_PERCENTILE)];
          const rs = heldPt('r_shoulder');
          const ls = heldPt('l_shoulder');
          if (rs !== null && ls !== null) {
            const shW = rs.map((r, i) => dist2(r, ls[i]!));
            if (shW.every((v) => v > 1e-6)) seriesList.push(winPercentile(shW, 75, STRAIGHT_PERCENTILE));
          }
          const re = heldPt('r_eye');
          const le = heldPt('l_eye');
          if (re !== null && le !== null) {
            const eyeW = re.map((r, i) => dist2(r, le[i]!));
            if (eyeW.every((v) => v > 1e-6)) seriesList.push(winPercentile(eyeW, 75, STRAIGHT_PERCENTILE));
          }
          if (kr !== null && kl !== null) {
            const thighMin = hr.map((r, i) => Math.min(dist2(r, kr[i]!), dist2(hl[i]!, kl[i]!)));
            if (thighMin.every((v) => v > 1e-6)) seriesList.push(winPercentile(thighMin, 75, 0.5));
          }
          const rel = heldPt('r_elbow');
          const lel = heldPt('l_elbow');
          const rw = heldPt('r_wrist');
          const lw = heldPt('l_wrist');
          if (rs !== null && ls !== null && rel !== null && lel !== null && rw !== null && lw !== null) {
            const armSum = rs.map((r, i) => Math.max(dist2(r, rel[i]!) + dist2(rel[i]!, rw[i]!), dist2(ls[i]!, lel[i]!) + dist2(lel[i]!, lw[i]!)));
            if (armSum.every((v) => v > 1e-6)) seriesList.push(winPercentile(armSum, 75, 0.5));
          }
          if (seriesList.length >= 3) {
            const norms = seriesList.map((s) => s.map((v) => v / s[0]!));
            const cons = legSum.map((_, i) => {
              let minR = Infinity;
              let maxR = -Infinity;
              for (const nr of norms) {
                if (nr[i]! < minR) minR = nr[i]!;
                if (nr[i]! > maxR) maxR = nr[i]!;
              }
              return minR > 1 ? minR : maxR < 1 ? maxR : 1;
            });
            if (cons.every((c) => Math.abs(c - 1) <= 0.02)) {
              fixedCamera = true;
              return cons.map((c) => c * legSum[0]!);
            }
          }
          const segH =
            rs !== null && ls !== null
              ? legSum.map((l, i) => l + dist2([(hr[i]![0] + hl[i]![0]) / 2, (hr[i]![1] + hl[i]![1]) / 2], [(rs[i]![0] + ls[i]![0]) / 2, (rs[i]![1] + ls[i]![1]) / 2]))
              : legSum;
          const out = winPercentile(segH, 15, STRAIGHT_PERCENTILE);
          if (feet !== null) {
            const ms = feet.supports.map((sp) => percentile(segH.slice(sp.frames[0], sp.frames[1] + 1), STRAIGHT_PERCENTILE));
            feet.supports.forEach((sp, k) => {
              for (let i = sp.frames[0]; i <= sp.frames[1]; i++) out[i] = ms[k]!;
            });
            for (let k = 0; k + 1 < feet.supports.length; k++) {
              const a = feet.supports[k]!.frames[1] + 1;
              const b = feet.supports[k + 1]!.frames[0] - 1;
              if (a <= b && ms[k + 1]! > ms[k]!) {
                const start = Math.max(ms[k]!, out[a]!);
                const end = ms[k + 1]!;
                for (let i = a; i <= b; i++) {
                  const u = b > a ? (i - a) / (b - a) : 1;
                  out[i] = start + (end - start) * u;
                }
              }
            }
          }
          return out;
        }
        return legSum;
      }
    }
    if (t !== null) {
      const [pa, pb] = t.scale.pose;
      const A = series.get(pa)!;
      const B = series.get(pb)!;
      const h = A.map((a, i) => Math.hypot(B[i]![0] - a[0], B[i]![1] - a[1]));
      if (h.every((v) => v > 1e-6)) return h;
    }
    return new Array<number>(n).fill(1);
  })();
  const continuousScale = figureScaleOf(rawFigureHeight);
  const figureScale: FigureScaleReading = (() => {
    const raw0 = rawFigureHeight[0] ?? 1;
    let maxStep = 0;
    let stepFrame = 0;
    for (let i = 1; i < n; i++) {
      const prev = continuousScale[i - 1]!;
      const st = prev > 1e-9 ? Math.abs(continuousScale[i]! - prev) / prev : 0;
      if (st > maxStep) {
        maxStep = st;
        stepFrame = i;
      }
    }
    return {
      maxStep: { step: r6(maxStep), frame: stepFrame, t: keyTimes[stepFrame] ?? 0 },
      endOverStart: r6(continuousScale[n - 1] ?? 1),
      frames: continuousScale.map((s, i) => ({
        frame: i,
        t: keyTimes[i]!,
        s: r6(s),
        rawS: r6(raw0 > 1e-9 ? rawFigureHeight[i]! / raw0 : 1),
      })),
    };
  })();
  const poseScale: number[] | null = t !== null && scale !== null && n > 25 && !inPlace ? continuousScale : null;
  let trunkScaleBone: string | null = null;
  let trunkScale: number[] | null = null;
  // #237: every mapped leg segment's picture length ÷ straight, with or without --leg-scale: the
  // straight lengths --leg-scale scales against, so the minimum read here is the one it would clamp.
  const segments: LegSegmentRatio[] = [];
  {
    /** Without --leg-scale nothing is keyed: [1, 1] only lets `legScaleOf` read the ratio. */
    const limits: [number, number] = legScaleOn ? (opts.legScale as [number, number]) : [1, 1];
    const rawSegments: Array<{ chain: string; bone: string; joints: [string, string]; kind: string; lengths: number[]; ownStraight: number }> = [];
    for (const c of map.chains) {
      if (c.reach) continue;
      c.bones.forEach((b, k) => {
        const joints: [string, string] = [c.joints[k]!, c.joints[k + 1]!];
        if (!isLegSegment(joints[0], joints[1])) return;
        if (c.aim[k] !== 'x') {
          if (legScaleOn) p.add('LEGS_MAP', `--leg-scale scales chain "${c.name}" bone "${b}" (${joints[0]} → ${joints[1]}) along its own x axis, and the map aims it ${JSON.stringify(c.aim[k])}; a leg segment it scales must be aimed "x"`);
          segments.push({ chain: c.name, bone: b, joints, straight: null, ratio: null, why: `aimed ${JSON.stringify(c.aim[k])}, and --leg-scale scales a segment aimed "x"` });
          return;
        }
        const from = series.get(joints[0])!;
        const to = series.get(joints[1])!;
        const lengths = from.map((f, i) => Math.hypot(to[i]![0] - f[0], to[i]![1] - f[1]));
        const ownStraight = percentile(lengths, STRAIGHT_PERCENTILE);
        if (!(ownStraight > 1e-6)) {
          if (legScaleOn) p.add('LEGS_MAP', `--leg-scale: chain "${c.name}" bone "${b}"'s segment ${joints[0]} → ${joints[1]} has a straight length (95th percentile) of ${ownStraight}px; there is nothing to scale against`);
          segments.push({ chain: c.name, bone: b, joints, straight: null, ratio: null, why: `its straight length (95th percentile) is ${ownStraight}px` });
          return;
        }
        rawSegments.push({ chain: c.name, bone: b, joints, kind: `${joints[0].slice(2)}:${joints[1].slice(2)}`, lengths, ownStraight });
        segments.push({ chain: c.name, bone: b, joints, straight: null, ratio: null });
      });
    }
    const straightByKind = new Map<string, number>();
    for (const seg of rawSegments) straightByKind.set(seg.kind, Math.max(straightByKind.get(seg.kind) ?? 0, seg.ownStraight));
    if (!inPlace && n > 25) {
      for (const seg of rawSegments) {
        seg.lengths = seg.lengths.map((l, i) => (continuousScale[i]! > 1e-6 ? l / continuousScale[i]! : l));
        seg.ownStraight = percentile(seg.lengths, STRAIGHT_PERCENTILE);
      }
      straightByKind.clear();
      for (const seg of rawSegments) straightByKind.set(seg.kind, Math.max(straightByKind.get(seg.kind) ?? 0, seg.ownStraight));
      const byChain = new Map<string, typeof rawSegments>();
      for (const seg of rawSegments) {
        const list = byChain.get(seg.chain) ?? [];
        list.push(seg);
        byChain.set(seg.chain, list);
      }
      const chainTotals = [...byChain.values()].filter((list) => list.length >= 2).map((list) => list[0]!.lengths.map((_, i) => list.reduce((s, seg) => s + seg.lengths[i]!, 0)));
      if (chainTotals.length > 0 && straightByKind.size >= 2) {
        let sumKindStraight = 0;
        for (const ks of straightByKind.values()) sumKindStraight += ks;
        let maxChainTotal = 0;
        for (const tot of chainTotals) maxChainTotal = Math.max(maxChainTotal, percentile(tot, STRAIGHT_PERCENTILE));
        if (sumKindStraight > maxChainTotal && maxChainTotal > 1e-6) {
          const k = maxChainTotal / sumKindStraight;
          for (const [kind, ks] of straightByKind) straightByKind.set(kind, ks * k);
        }
      }
    }
    const rigLenByKind = new Map<string, number[]>();
    for (const seg of rawSegments) {
      const len = rest.get(seg.bone)?.length ?? 0;
      if (len > 1e-6) {
        const list = rigLenByKind.get(seg.kind) ?? [];
        list.push(len);
        rigLenByKind.set(seg.kind, list);
      }
    }
    const rigShareOf = (seg: (typeof rawSegments)[number]): number => {
      const lens = rigLenByKind.get(seg.kind);
      const rigLen = rest.get(seg.bone)?.length ?? 0;
      if (lens === undefined || lens.length < 2 || !(rigLen > 1e-6)) return 1;
      const meanRigLen = lens.reduce((a, b) => a + b, 0) / lens.length;
      return Math.abs(rigLen - meanRigLen) > 1e-3 * meanRigLen ? rigLen / meanRigLen : 1;
    };
    for (const seg of rawSegments) {
      const ls = legScaleOf(seg.lengths, limits, straightByKind.get(seg.kind)! * rigShareOf(seg));
      const row = segments.find((x) => x.bone === seg.bone)!;
      row.straight = ls.straight;
      row.ratio = ls.ratio;
      if (legScaleOn) {
        legScale.push({ chain: seg.chain, bone: seg.bone, joints: seg.joints, ...ls });
        scales.set(seg.bone, ls.scale);
      }
    }
  }
  if (legScaleOn) {
    const limits = opts.legScale as [number, number];
    if (legScale.length === 0 && !p.any) p.add('LEGS_MAP', '--leg-scale scales the leg segments (two of one side\'s hip, knee and ankle), and the map aims none');
    const isTrunkPair = (a: string, b: string): boolean => (a === 'mid_hip' && (b === 'neck' || b === 'mid_shoulder')) || (b === 'mid_hip' && (a === 'neck' || a === 'mid_shoulder'));
    const trunkChain = map.chains.find((c) => c.bones.length === 1 && isTrunkPair(c.joints[0]!, c.joints[1]!));
    if (!inPlace && trunkChain !== undefined && !p.any) {
      const tb = trunkChain.bones[0]!;
      const from = series.get(trunkChain.joints[0]!)!;
      const to = series.get(trunkChain.joints[1]!)!;
      const rawT = from.map((f, i) => dist2(f, to[i]!));
      const frameScale = (i: number): number => (!inPlace && n > 25 && rawFigureHeight[0]! > 1e-6 && rawFigureHeight[i]! > 1e-6 ? rawFigureHeight[i]! / rawFigureHeight[0]! : 1);
      const normT = rawT.map((l, i) => l / frameScale(i));
      const standingT = median(normT);
      if (standingT > 1e-6) {
        const rawRatio = normT.map((l) => l / standingT);
        const re = heldPt('r_eye');
        const le = heldPt('l_eye');
        let effRatio = rawRatio;
        if (re !== null && le !== null) {
          const mh = series.get('mid_hip') ?? from;
          const rawEH = mh.map((h, i) => dist2(h, [(re[i]![0] + le[i]![0]) / 2, (re[i]![1] + le[i]![1]) / 2]));
          const normEH = rawEH.map((l, i) => l / frameScale(i));
          const standingEH = median(normEH);
          if (standingEH > 1e-6) {
            effRatio = rawRatio.map((r, i) => (r > 1 ? Math.min(r, Math.max(1, normEH[i]! / standingEH)) : r));
          }
        }
        const minR = Math.max(0.5, Math.min(...effRatio));
        const supFloor = Math.min(limits[0], minR);
        const sy = effRatio.map((r, i) => {
          const supported = plantOn && feet !== null && (feet.support[i] !== null || feet.tracked?.some((tr) => i >= tr.frames[0] && i <= tr.frames[1]) === true);
          const lo = supported ? supFloor : limits[0];
          return Math.min(Math.max(r, lo), limits[1]);
        });
        if ((fixedCamera || (n <= 160 && minR < 0.9)) && effRatio.some((v) => Math.abs(v - 1) > 0.04) && sy.some((v) => Math.abs(r6(v) - 1) > 0)) {
          trunkScaleBone = tb;
          trunkScale = sy;
        }
      }
    }
  }
  if (opts.stance !== undefined && opts.stance !== 'off' && !plantOn) p.add('STANCE', `--stance ${opts.stance} plants the free foot beside the supporting one that --plant-feet holds, and --plant-feet is not given`);
  if (opts.floor !== undefined && !plantOn) p.add('FLOOR', `--floor ${opts.floor} is the floor --plant-feet plants every support span on, and --plant-feet is not given`);
  if (opts.floor !== undefined && !Number.isFinite(opts.floor)) p.add('FLOOR', `--floor is ${opts.floor}; it must be a finite world y`);
  // rig-c/pose#286: a set with a `phase` shows on the report's support spans, read with or without --plant-feet; a run that
  // reads no feet has none to show it on, and a group of competing sets mixing phase and angle sets has no rule.
  const phased = map.alternates.filter((a) => a.phase !== undefined);
  if (phased.length > 0) {
    if (feet === null) {
      const why = legs !== null && 'problems' in legs ? legs.problems.join('; ') : `the feet are read from both hips and both ankles, and the map's chains use ${['r_hip', 'l_hip', 'r_ankle', 'l_ankle'].filter((j) => !series.has(j)).join(', ')} nowhere`;
      p.add('PHASE_FEET', `set(s) ${phased.map((a) => `"${a.name}" ("phase": "${a.phase}")`).join(', ')} show by the supporting foot (left-step while the right foot supports), and this run reads no supports: ${why}`);
    }
    for (const x of phaseGroupProblems(map.alternates)) p.add('PHASE_GROUP', x);
  }
  // rig-c/pose#355: an angle set is chosen by its key skeleton and shown at its drawn angles; a key that disagrees with
  // its drawing by more than the tolerance would show the drawing turned that far from the pose.
  for (const x of keyDrawnProblems(map, opts.switchTolerance, opts.raisedByHead === true)) p.add('SET_KEY_DRAWN', x);
  // rig-c/pose#360: a bound set's ranges lie inside the sequence, and two bound sets never share a bone or slot on a frame.
  {
    const bp = bindProblems(map, n);
    for (const x of bp.frames) p.add('SET_BIND_FRAMES', x);
    for (const x of bp.overlap) p.add('SET_BIND_OVERLAP', x);
  }
  p.throwIfAny();
  const askedScales = new Map<string, number[]>();
  for (const ls of legScale) askedScales.set(ls.bone, ls.asked);
  /** Every bone on the legs' path posed on frame i by the targets, with the given scale series read on frame `at` (#285; i by default). */
  const poseLegsWith = (i: number, sc: ReadonlyMap<string, number[]>, at = i): PathPose => {
    const r = posePath(rest, legPath!, (b): Posing | null => (targets.has(b) ? { turn: restTurn(b, i), target: targets.get(b)![i]!, aimX: aimX.get(b)! } : null), (b) => sc.get(b)?.[at] ?? null);
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
    // #285: past its span, an outgoing plant holds its ankle with the leg as the pose asked it on its last supporting frame.
    const ankleBone = (s: Side) => (legs !== null && 'legs' in legs ? legs.legs[s].ankleBone : '');
    const held = legScaleOn ? (i: number, s: Side, at: number) => tipOf(rest, poseLegsWith(i, askedScales, at), ankleBone(s)) : undefined;
    const planted = plantHip(feet!, (i, s) => offsets[i]![s], (i) => poseTravel[i]!, [tb.worldX, tb.worldY], opts.floor, follow, track, held);
    const hip = planted.hip;
    floor = planted.floor;
    closure = planted.closure;
    const L = (legs as { legs: Record<Side, { chain: Chain; ankleBone: string }> }).legs;
    // #133: on a frame where the supporting leg asks under --leg-scale's floor, its scalex follows the asked
    // value down to #95's bound so the ankle stays on #85's floor; the free leg keeps the configured clamp.
    if (legScaleOn && feet !== null) {
      scaleSupport(legScale, scales, feet, L, hip, (i, s) => offsets[i]![s], (i, s) => tipOf(rest, poseLegs(i), L[s].ankleBone));
    }
    for (let i = 0; i < n; i++) travel[i] = [hip[i]![0] - tb.worldX, hip[i]![1] - tb.worldY];
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
    const lower = stanceRangeOf(ankleSeries, { r: series.get('r_hip')!, l: series.get('l_hip')! }, inPlace, continuousScale);
    blendHold = holdBlend(planted.blends, n, posedFeet, lower);
    const beforeBlendX = blendHold.stretch.map((b, i) => (b === null ? 0 : posedFeet(i).ankle[b.side][0]));
    stretchChain(blendHold.stretch);
    blendHold.stretch.forEach((b, i) => {
      if (b === null) return;
      const dx = beforeBlendX[i]! - posedFeet(i).ankle[b.side][0];
      hip[i]![0] += dx;
      travel[i]![0] += dx;
    });
    // --stance (#60): with the hip placed, a free ankle within the tolerance of the floor has its leg
    // stretched (every bone of its chain's scalex, about the chain's root) until it reaches it.
    if (opts.stance !== undefined && opts.stance !== 'off') {
      stance = stanceOf(feet!, ankleSeries, opts.stance, legScaleOn ? unshortenStanceShin(scales, L, posedFeet, lower) : posedFeet, secondsOf, lower);
      // The supporting leg (the blend's) and the free leg (the stance's) are different chains on a frame.
      for (let i = 0; i < n; i++) {
        const b = blendHold.stretch[i];
        if (b !== null && b !== undefined && stance.stretch[i]?.side === b.side) p.add('LEGS_STRETCH', `frame ${i}: chain "${L[b.side].chain.name}" is stretched both as the supporting leg of a blend (k ${b.k}) and as the free leg of --stance (k ${stance.stretch[i]!.k}); one chain takes one stretch`);
      }
      p.throwIfAny();
      stretchChain(stance.stretch);
    }
  }
  // #237: what the clamps did to a free ankle's height — read, nothing keyed changes. Each side's rig
  // leg at setup is the unit; the clamped frames of a free leg go on LEG-SCALE, and a lifted or below
  // STANCE run says the pose's height was kept only where no clamp moved it.
  let rigLeg: Record<Side, number> | null = null;
  if (legs !== null && 'legs' in legs) {
    const L = legs.legs;
    const of = (s: Side): number => {
      const o = rest.get(L[s].chain.bones[0]!)!;
      const e = rest.get(L[s].ankleBone)!;
      return Math.hypot(e.worldX + e.a * e.length - o.worldX, e.worldY + e.c * e.length - o.worldY);
    };
    rigLeg = { r: of('r'), l: of('l') };
  }
  if (legScaleOn && feet !== null && legPath !== null && rigLeg !== null && legs !== null && 'legs' in legs) {
    const L = legs.legs;
    const F = feet;
    const legUnit = rigLeg;
    const trackedSide = new Array<Side | null>(n).fill(null);
    for (const tr of F.tracked ?? []) for (let i = tr.frames[0]; i <= tr.frames[1]; i++) trackedSide[i] = tr.side;
    const freeOf = (i: number): Side | null => {
      const s = F.support[i] ?? trackedSide[i] ?? null;
      return s === null ? null : s === 'r' ? 'l' : 'r';
    };
    const tipY = (i: number, side: Side, scaleOf: (b: string) => number | null): number => {
      const r = posePath(rest, legPath!, (b): Posing | null => (targets.has(b) ? { turn: restTurn(b, i), target: targets.get(b)![i]!, aimX: aimX.get(b)! } : null), scaleOf);
      if (typeof r === 'string') throw new Refusal([{ code: 'LEGS_MAP', text: r }]);
      return tipOf(rest, r, L[side].ankleBone)[1];
    };
    const shift = freeAnkleShiftOf(n, legScale, freeOf, tipY);
    for (const ls of legScale) {
      const side: Side = ls.joints[0].startsWith('r_') ? 'r' : 'l';
      const frames: number[] = [];
      for (let i = 0; i < n; i++) if (ls.scale[i] !== ls.picture[i] && freeOf(i) === side) frames.push(i);
      const free = shiftOver(side, frames, shift, legUnit[side]);
      if (free !== null) ls.free = free;
    }
    for (const run of stance?.runs ?? []) {
      if (run.state === 'both' || run.absorbed === true) continue;
      const frames = Array.from({ length: run.frames[1] - run.frames[0] + 1 }, (_, k) => run.frames[0] + k);
      const moved = shiftOver(run.side, frames, shift, legUnit[run.side]);
      if (moved !== null) run.moved = moved;
    }
  }
  const legStraight: Record<Side, number> | null = feet === null ? null : (() => {
    const out = {} as Record<Side, number>;
    for (const s of SIDES) {
      const h = series.get(`${s}_hip`)!;
      out[s] = percentile(series.get(`${s}_ankle`)!.map((a, i) => Math.hypot(a[0] - h[i]![0], a[1] - h[i]![1])), STRAIGHT_PERCENTILE);
    }
    return out;
  })();
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
    if (inPlace && !plantOn && n > 0) openDrift = r6(travel[n - 1]![0] - travel[0]![0]);
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
  let headNodReading: HeadNodReading | null = null;
  let nodSkipped: NodSkipped | null = null;
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
    const at: Pt = [po[0] + Math.cos(r) * ox - Math.sin(r) * oy + nod[0], po[1] + Math.sin(r) * ox + Math.cos(r) * oy + nod[1]];
    if (anchorOf === null || b !== anchorOf.bone || anchorRaw) return at;
    const s = anchorShift(i, at, po, oy);
    return [at[0] + s[0], at[1] + s[1]];
  };
  /**
   * rig-c/pose#344: the world shift that holds the first spine bone over the pelvis: up and down, its origin where
   * the pelvis's travel alone puts it (the pelvis's turn taken out); sideways, the trunk's top point on `anchorPath`:
   * the drawn neck's sideways path about its mean, scaled by the pelvis's rig ÷ drawn sideways sway (`TorsoAnchor`).
   */
  let anchorRaw = false;
  let anchorX: number | null = null;
  let anchorFactor = 1;
  let anchorPath: number[] | null = null;
  const anchorShift = (i: number, at: Pt, po: Pt, oy: number): Pt => {
    const a = anchorOf!;
    if (anchorPath === null) {
      anchorRaw = true;
      const hipX = Array.from({ length: n }, (_, k) => posedOrigin(a.pelvis, k)[0] - rest.get(a.pelvis)!.worldX);
      anchorRaw = false;
      const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      const sd = (xs: readonly number[]) => {
        const m = mean(xs);
        return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
      };
      const drawnHip = series.get(a.joints[0])!.map((p) => p[0]);
      const drawnNeck = series.get(a.joints[1])!.map((p) => p[0]);
      const sdHip = sd(drawnHip);
      anchorFactor = sdHip > 1e-6 ? sd(hipX) / sdHip : (scale?.factor ?? 1);
      anchorX = rigPoint(rest, a.point)![0] + mean(hipX);
      const m = mean(drawnNeck);
      anchorPath = drawnNeck.map((x) => anchorX! + (x - m) * anchorFactor);
    }
    anchorRaw = true;
    const top = posedPoint(a.point, i);
    anchorRaw = false;
    return [anchorPath[i]! - top[0], po[1] + oy - at[1]];
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
  const reachAims = new Map<string, { aim: number[]; pair: number[]; length: number }>();
  /** #282: per reach chain, the distance from its bone's posed origin to the anchor's on each frame (the last aim's). */
  const reachGaps = new Map<string, number[]>();
  if (reaches.length > 0 && t !== null && scale !== null) {
    const s = scale.factor;
    const tb = rest.get(t.bone)!;
    aimReach = (c: Chain): void => {
      const b = c.bones[0]!;
      const anchor = series.get(c.joints[0]!)!;
      const end = series.get(c.joints[1]!)!;
      const angles: number[] = [];
      const gaps: number[] = [];
      for (let i = 0; i < n; i++) {
        const o = posedOrigin(b, i);
        gaps.push(Math.hypot(o[0] - (tb.worldX + travel[i]![0]), o[1] - (tb.worldY + travel[i]![1])));
        const tx = tb.worldX + travel[i]![0] + (end[i]![0] - anchor[i]![0]) * s;
        const ty = tb.worldY + travel[i]![1] - (end[i]![1] - anchor[i]![1]) * s;
        const d = Math.hypot(tx - o[0], ty - o[1]);
        angles.push(d > 1e-9 ? Math.atan2(ty - o[1], tx - o[0]) * DEG : (angles[i - 1] ?? NaN));
      }
      fillLeading(angles, () => p.add('POSE_SEGMENT_ZERO', `chain "${c.name}" — bone "${b}" reaches for ${c.joints[1]}, which the pose puts on the bone's posed origin on every frame; it has no direction`));
      targets.set(b, angles);
      reachGaps.set(c.name, gaps);
      // #236: the aim as reached, before its own range clamp, beside the pair's own angle (a reading).
      reachAims.set(c.name, { aim: [...angles], pair: Array.from({ length: n }, (_, i) => pictureAngle(anchor[i]!, end[i]!)), length: median(Array.from({ length: n }, (_, i) => Math.hypot(end[i]![0] - anchor[i]![0], end[i]![1] - anchor[i]![1]) * s)) });
    };
    for (const c of reaches) aimReach(c);
  }
  p.throwIfAny();

  // The switches: with every target known, each set's distance and its spans.
  const shortInfo = opts.short !== 'off' ? { cutoff: opts.short, fractions: new Map([...fractions].map(([b, info]) => [b, info.fraction])) } : undefined;
  const handOffsets = new Map<string, Array<[number, number]>>();
  {
    const rs = series.get('r_shoulder');
    const ls = series.get('l_shoulder');
    for (const c of map.chains) {
      if (c.reach || c.joints.length < 2) continue;
      const sh = series.get(c.joints[0]!);
      const wr = series.get(c.joints[c.joints.length - 1]!);
      if (sh === undefined || wr === undefined) continue;
      const arr: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        const sc = rs !== undefined && ls !== undefined
          ? Math.hypot(ls[i]![0] - rs[i]![0], ls[i]![1] - rs[i]![1])
          : c.joints.slice(0, -1).reduce((s, j, k) => {
              const p0 = series.get(j)?.[i];
              const p1 = series.get(c.joints[k + 1]!)?.[i];
              return p0 !== undefined && p1 !== undefined ? s + Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) : s;
            }, 0);
        arr.push(sc > 1e-6 ? [(wr[i]![0] - sh[i]![0]) / sc, (wr[i]![1] - sh[i]![1]) / sc] : [0, 0]);
      }
      handOffsets.set(c.name, arr);
    }
  }
  const rawTargets = new Map<string, number[]>([...targets].map(([b, arr]) => [b, [...arr]]));
  const sw = selectSwitches(map, targets, keyTimes, keyTimes[n - 1]!, slots, { ...opts, shortInfo, handOffsets, ...(phased.length > 0 && feet !== null ? { phaseSupports: feet.supports } : {}) });

  // The range clamp, outside the spans of a set depicting the bone's chain. Parents
  // first, so a bone below takes its clamped parent into its key; a reach is aimed
  // again from where the clamped bones above put its origin.
  const mappedAbove = (b: string): string | null => {
    for (let a = rest.get(b)!.parent; a !== null; a = rest.get(a)!.parent) if (targets.has(a)) return a;
    return null;
  };
  const turn = (bone: string, i: number) => targets.get(bone)![i]! - restOf.get(bone)!;
  const covered = coveredChains(sw.switches, n, sw.chainHolds);
  if (opts.short !== 'off') {
    for (const [b, info] of fractions) {
      for (const s of capShortSteps(targets.get(b)!, info.fraction, covered.get(info.chain))) {
        short.push({ chain: info.chain, bone: b, joints: info.joints, ...s });
      }
    }
  }
  // rig-c/pose#355: while an angle set shows, a segment it draws that is end-on on a frame — its picture length under
  // --short's cutoff of its median, the short hold's notion, where its picture direction is noise — is held at the set's
  // drawn angle (the selection read its art turn there as 0, `artShows`).
  if (shortInfo !== undefined) {
    for (const s of sw.switches) {
      const set = map.alternates.find((a) => a.name === s.set)!;
      if (set.phase !== undefined) continue;
      for (const [b, drawn] of Object.entries(set.drawn)) {
        const frac = shortInfo.fractions.get(b);
        if (frac === undefined) continue;
        const t = targets.get(b)!;
        const flag = Array.from({ length: n }, () => false);
        for (let i = s.frames[0]; i <= s.frames[1]; i++) {
          if (frac[i]! >= shortInfo.cutoff) continue;
          t[i] = drawn;
          flag[i] = true;
        }
        const held = runsOf(flag, 0);
        if (held.length > 0) (s.endOnHeld ??= {})[b] = held;
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

  // #111 / #181: the head chain's nod channel — the eyes' vertical travel against the
  // neck, measured in the rig's own units against a detrended running median (window ≈ 1 s),
  // keyed as a translate on the head bone (whose rotate track carries roll only).
  for (const c of map.chains) {
    for (let k = 0; k + 1 < c.joints.length; k++) {
      const ja = c.joints[k]!;
      const jb = c.joints[k + 1]!;
      if (!((ja === 'r_eye' && jb === 'l_eye') || (ja === 'l_eye' && jb === 'r_eye'))) continue;
      const hb = c.bones[k]!;
      const ha = c.aim[k]!;
      const skip = (why: string): void => {
        nodSkipped = { bone: hb, chain: c.name, why };
      };
      if (c.nod === false) {
        skip(`the chain declares "nod": false`);
        break;
      }
      if (t?.bone === hb) {
        skip(`the map's translate moves bone "${hb}"`);
        break;
      }
      if (sw.offsetTracks.some((tr) => tr.bone === hb)) {
        skip(`a set's offsets translate bone "${hb}"`);
        break;
      }
      let underScaled: string | null = null;
      for (let a = rest.get(hb)!.parent; a !== null; a = rest.get(a)!.parent) if (scales.has(a) && underScaled === null) underScaled = a;
      if (underScaled !== null) {
        skip(`bone "${hb}" hangs below the scaled bone "${underScaled}"`);
        break;
      }
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
      if (neckSeries === undefined) skip('neck is good on no frame');
      else if (nodScale === null) skip(`no scale: the map translates no bone and aim ${JSON.stringify(ha)} names no two points to measure the eye distance on`);
      if (neckSeries !== undefined && nodScale !== null) {
        const bone = rest.get(hb)!;
        const parent = bone.parent === null ? null : rest.get(bone.parent)!;
        let neckRestLen = 0;
        if (rest.has('neck') && descends(rest, hb, 'neck')) {
          const nk = rest.get('neck')!;
          neckRestLen = Math.hypot(bone.worldX - nk.worldX, bone.worldY - nk.worldY);
        }
        if (neckRestLen <= 1e-6) {
          for (let a = parent; a !== null; a = a.parent === null ? null : rest.get(a.parent)!) {
            const d = Math.hypot(bone.worldX - a.worldX, bone.worldY - a.worldY);
            if (d > 1e-6) {
              neckRestLen = d;
              break;
            }
          }
        }
        const maxNod = !inPlace && neckRestLen > 1e-6 ? 0.02 * neckRestLen : Infinity;
        const refEN = rEye.map((re, i) => -((re[1] + lEye[i]![1]) / 2 - neckSeries[i]![1]));
        const halfWin = Math.max(1, Math.round(0.5 / Math.max(1e-6, (keyTimes[n - 1]! - keyTimes[0]!) / Math.max(1, n - 1))));
        const windowed = maxNod < Infinity && n > 2 * halfWin;
        // #241: on a `clean --loop` sequence the window wraps (the last frame runs into the first), as clean's own
        // windows do; cut at the ends instead, the two ends of the loop are read against different baselines.
        const nodWindow: NodWindow = !windowed ? 'in-place' : opts.loop === true ? 'wrapped' : 'cut';
        const around = (xs: readonly number[], i: number): number[] => {
          if (nodWindow !== 'wrapped') return xs.slice(Math.max(0, i - halfWin), Math.min(n, i + halfWin + 1));
          const out: number[] = [];
          for (let j = i - halfWin; j <= i + halfWin; j++) out.push(xs[((j % n) + n) % n]!);
          return out;
        };
        const nodMed = windowed ? refEN.map((_, i) => median(around(refEN, i))) : refEN.map(() => refEN[0]!);
        const nodBase = windowed
          ? nodMed.map((_, i) => {
              const sl = around(nodMed, i);
              return sl.reduce((a, b) => a + b, 0) / sl.length;
            })
          : nodMed;
        const rawNod = refEN.map((v, i) => (v - nodBase[i]!) * nodScale!);
        const p90Nod = maxNod < Infinity ? percentile(rawNod.map((v) => Math.abs(v)), 0.92) : 0;
        const kneeNod = 0.82 * maxNod;
        const dy = rawNod.map((v) => {
          if (p90Nod > maxNod && Math.abs(v) > kneeNod) {
            const tail = kneeNod + (Math.abs(v) - kneeNod) * ((maxNod - kneeNod) / (p90Nod - kneeNod));
            return Math.sign(v) * Math.min(maxNod, tail);
          }
          return Math.max(-maxNod, Math.min(maxNod, v));
        });
        const residual = rawNod.map((v, i) => v - dy[i]!);
        const keyed = dy.some((v) => Math.abs(r3(v)) > 0);
        headNodReading = { bone: hb, chain: c.name, maxNod, rawY: rawNod, clampedY: dy, residual, window: nodWindow, halfWin: windowed ? halfWin : 0, keyed };
        if (keyed) {
          const keys: MotionKey[] = [];
          const nod: Pt[] = [];
          const ref0 = refEN[0]! / (poseScale?.[0] ?? 1);
          for (let i = 0; i < n; i++) {
            const wy = dy[i]!;
            const wy0 = Math.max(-maxNod, Math.min(maxNod, (refEN[i]! / (poseScale?.[i] ?? 1) - ref0) * nodScale!));
            let lx = 0;
            let ly = r3(wy);
            let awx = 0;
            let awy = r3(wy0);
            if (parent !== null) {
              const r = turnAbove(parent.name, i) / DEG;
              const pa = Math.cos(r) * parent.a - Math.sin(r) * parent.c;
              const pb = Math.cos(r) * parent.b - Math.sin(r) * parent.d;
              const pc = Math.sin(r) * parent.a + Math.cos(r) * parent.c;
              const pd = Math.sin(r) * parent.b + Math.cos(r) * parent.d;
              const det = pa * pd - pb * pc;
              lx = r3((-pb * wy) / det);
              ly = r3((pa * wy) / det);
              const lx0 = r3((-pb * wy0) / det);
              const ly0 = r3((pa * wy0) / det);
              awx = pa * lx0 + pb * ly0;
              awy = pc * lx0 + pd * ly0;
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

  // --raised-by-head (#62, #179): while a set shows whose key skeleton's wrist lies within
  // `RAISED_WRIST_EYES` (2) eye distances of the head centre, its wrist goes where the
  // reference's is against the head, in eye distances (each side's median over the span). Solved last
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
  const raisedJobs: Array<{ anchor: Anchor; sw: Switch; chain: Chain; wrist: (i: number) => Pt; before: Pt[]; reference: Pt[]; placed: Pt[]; refEye: number; rigEye: number; short: Array<{ i: number; how: 'far' | 'near' | 'missed'; shortfall: number }>; upperHeld: number[]; saturated?: Array<{ frame: number; residual: number }>; l0: number; l1: number; farthest: number }> = [];
  const headOk: Anchor | null = head !== null && !('problem' in head) ? { kind: 'head', joints: head.joints, points: head.points } : null;
  const hipsOk: Anchor | null = hips !== null && !('problem' in hips) ? { kind: 'hip', joints: hips.joints, points: hips.points } : null;
  const fallbackHead = headOf(map);
  const gestureHead: Anchor | null = headOk ?? (!('problem' in fallbackHead) ? { kind: 'head', joints: fallbackHead.joints, points: fallbackHead.points } : null);
  /**
   * #191: Posed origin and final world rotation (degrees, including #190's nod-residual coupling
   * and `headNodTrack` translation) of the head bone `hb` on frame `i`.
   */
  const finalHeadPose = (hb: string, i: number): { origin: Pt; rotDeg: number } => {
    let origin = posedOrigin(hb, i);
    if (headNodTrack !== null && headNodTrack.bone === hb) {
      const k = headNodTrack.keys.find((x) => Math.abs(x.t - keyTimes[i]!) < 1e-5);
      if (k !== undefined && Array.isArray(k.v)) {
        const pName = rest.get(hb)?.parent ?? null;
        const pRest = pName !== null ? rest.get(pName) : undefined;
        if (pName !== null && pRest !== undefined) {
          const pTurn = turnAbove(pName, i);
          const rad = pTurn / DEG;
          const c = Math.cos(rad);
          const s = Math.sin(rad);
          const pa = c * pRest.a - s * pRest.c;
          const pb = c * pRest.b - s * pRest.d;
          const pc = s * pRest.a + c * pRest.c;
          const pd = s * pRest.b + c * pRest.d;
          const [lx, ly] = k.v;
          origin = [origin[0] + pa * lx + pb * ly, origin[1] + pc * lx + pd * ly];
        }
      }
    }
    let rotDeg = targets.get(hb)?.[i] ?? restOf.get(hb) ?? 0;
    if (headNodReading !== null && headNodReading.bone === hb && headNodReading.residual.some((r) => r !== 0)) {
      const nodY = headNodReading.clampedY[i] ?? 0;
      if (nodY !== 0) {
        const above = mappedAbove(hb);
        const hc = map.chains.find((c) => c.bones.includes(hb));
        const limits = hc?.range[hb];
        const cov = hc !== undefined ? covered.get(hc.name) : undefined;
        let next = wrap(rotDeg + NOD_RESIDUAL_HEAD_GAIN * nodY);
        if (limits !== undefined && cov?.[i] !== true) {
          const key = wrap((next - restOf.get(hb)!) - (above === null ? 0 : turn(above, i)));
          if (overflow(key, limits) > RANGE_SLACK) {
            next = wrap(next + Math.min(Math.max(key, limits[0]), limits[1]) - key);
          }
        }
        rotDeg = next;
      }
    }
    return { origin, rotDeg };
  };
  /**
   * #191: For a chain listed in `set.anchor`, compute the target hand-tip position from the set's
   * `drawn` hand-tip-to-head offset in the `head` bone's local frame (or fixed world offset when
   * `HEAD_ANCHOR_FRAME === 'world-fixed'`), and solve the two-bone arm inside `set.turn`.
   */
  const solveHeadAnchorFrame = (
    set: (typeof map.alternates)[number],
    c: Chain,
    i: number,
  ): {
    a0: number;
    a1: number;
    targetTip: Pt;
    placedTip: Pt;
    achievedTip: Pt;
    residual: number;
    saturated: boolean;
    upperHeld: boolean;
  } | null => {
    if (HEAD_ANCHOR_FRAME === 'off' || headAnchorBone === null || c.bones.length < 2) return null;
    const [b0, b1] = c.bones as [string, string];
    const drawn0 = set.drawn[b0];
    const drawn1 = set.drawn[b1];
    if (drawn0 === undefined || drawn1 === undefined) return null;
    const S0 = rigPoint(rest, b0);
    const E0 = rigPoint(rest, b1);
    const wSpec = c.aim[1] === 'x' ? `${b1}:tip` : c.aim[1]!;
    const W0 = rigPoint(rest, wSpec);
    const H0 = rigPoint(rest, headAnchorBone);
    const headRestRot = restOf.get(headAnchorBone);
    if (S0 === null || E0 === null || W0 === null || H0 === null || headRestRot === undefined) return null;
    const l0 = Math.hypot(E0[0] - S0[0], E0[1] - S0[1]);
    const l1 = Math.hypot(W0[0] - E0[0], W0[1] - E0[1]);
    const d0 = wrap(Math.atan2(E0[1] - S0[1], E0[0] - S0[0]) * DEG - restOf.get(b0)!);
    const d1 = wrap(Math.atan2(W0[1] - E0[1], W0[0] - E0[0]) * DEG - restOf.get(b1)!);
    const r0Drawn = (drawn0 + d0) / DEG;
    const r1Drawn = (drawn1 + d1) / DEG;
    const WDrawn: Pt = [
      S0[0] + l0 * Math.cos(r0Drawn) + l1 * Math.cos(r1Drawn),
      S0[1] + l0 * Math.sin(r0Drawn) + l1 * Math.sin(r1Drawn),
    ];
    const dWorld0: Pt = [WDrawn[0] - H0[0], WDrawn[1] - H0[1]];
    const drawnHeadRot = set.drawn[headAnchorBone] ?? headRestRot;
    const { origin: H, rotDeg: headRot } = finalHeadPose(headAnchorBone, i);
    const dRotRad = HEAD_ANCHOR_FRAME === 'world-fixed' ? 0 : wrap(headRot - drawnHeadRot) / DEG;
    const cosH = Math.cos(dRotRad);
    const sinH = Math.sin(dRotRad);
    const targetTip: Pt = [
      H[0] + dWorld0[0] * cosH - dWorld0[1] * sinH,
      H[1] + dWorld0[0] * sinH + dWorld0[1] * cosH,
    ];
    const shoulder = posedOrigin(b0, i);
    const place = reachLimit(H, targetTip, shoulder, l0, l1);
    const P = place.point;
    const side: 1 | -1 = wrap(drawn1 + d1 - (drawn0 + d0)) >= 0 ? 1 : -1;
    const sol = twoBone(shoulder, P, l0, l1, side);
    const turn0 = set.turn[b0];
    const turn1 = set.turn[b1];
    let a0 = sol.upper !== null ? wrap(sol.upper - d0) : drawn0;
    let a1 = sol.upper !== null ? wrap(sol.fore - d1) : drawn1;
    let upperHeld = false;
    let foreHeld = false;
    if (turn0 !== undefined) {
      const tt0 = wrap(a0 - drawn0);
      const cl0 = Math.min(Math.max(tt0, turn0[0]), turn0[1]);
      if (Math.abs(cl0 - tt0) > RANGE_SLACK) {
        upperHeld = true;
        a0 = wrap(drawn0 + cl0);
        const r0 = (a0 + d0) / DEG;
        const E: Pt = [shoulder[0] + l0 * Math.cos(r0), shoulder[1] + l0 * Math.sin(r0)];
        a1 = wrap(Math.atan2(P[1] - E[1], P[0] - E[0]) * DEG - d1);
      }
    }
    if (turn1 !== undefined) {
      const tt1 = wrap(a1 - drawn1);
      const cl1 = Math.min(Math.max(tt1, turn1[0]), turn1[1]);
      if (Math.abs(cl1 - tt1) > RANGE_SLACK) {
        foreHeld = true;
        a1 = wrap(drawn1 + cl1);
      }
    }
    const r0 = (a0 + d0) / DEG;
    const r1 = (a1 + d1) / DEG;
    const achievedTip: Pt = [
      shoulder[0] + l0 * Math.cos(r0) + l1 * Math.cos(r1),
      shoulder[1] + l0 * Math.sin(r0) + l1 * Math.sin(r1),
    ];
    const residual = Math.hypot(achievedTip[0] - targetTip[0], achievedTip[1] - targetTip[1]);
    const saturated = (place.how !== 'in' || upperHeld || foreHeld) && residual > 1e-3;
    return { a0, a1, targetTip, placedTip: P, achievedTip, residual, saturated, upperHeld };
  };
  /**
   * #188: For an active raised chain in a set that declares a `support` arm, compute the
   * outward-cleared world angles `[a0, a1]` on frame `i` from the scan's 2D shoulder→wrist
   * direction and the head/bun clearance.
   */
  const solveSupportActiveFrame = (set: (typeof map.alternates)[number], c: Chain, i: number): [number, number] | null => {
    if (c.bones.length < 2 || c.joints.length < 3) return null;
    const [b0, b1] = c.bones as [string, string];
    const drawn0 = set.drawn[b0];
    const drawn1 = set.drawn[b1];
    if (drawn0 === undefined || drawn1 === undefined || !isRaised(drawn0)) return null;
    const S0 = rigPoint(rest, b0);
    const E0 = rigPoint(rest, b1);
    const wSpec = c.aim[1] === 'x' ? `${b1}:tip` : c.aim[1]!;
    const W0 = rigPoint(rest, wSpec);
    if (S0 === null || E0 === null || W0 === null) return null;
    const l0 = Math.hypot(E0[0] - S0[0], E0[1] - S0[1]);
    const l1 = Math.hypot(W0[0] - E0[0], W0[1] - E0[1]);
    let rigEye0 = 0.32 * l0;
    let headX0 = 0;
    if (gestureHead !== null) {
      const ha0 = rigPoint(rest, gestureHead.points[0]);
      const hb0 = rigPoint(rest, gestureHead.points[1]);
      if (ha0 !== null && hb0 !== null) {
        const d = Math.hypot(hb0[0] - ha0[0], hb0[1] - ha0[1]);
        if (d > 1e-6) {
          rigEye0 = d;
          headX0 = (ha0[0] + hb0[0]) / 2;
        }
      }
    }
    const Ex = S0[0] + l0 * Math.cos(drawn0 / DEG);
    const outSign: 1 | -1 = Ex <= headX0 ? 1 : -1;
    const clear0 = Math.asin(Math.min(1, (0.55 * rigEye0) / Math.max(1e-6, l0))) * DEG;
    const clear1 = Math.asin(Math.min(1, (0.90 * rigEye0) / Math.max(1e-6, l1))) * DEG;
    let swMod = 0;
    const j0 = c.joints[0]!;
    const jLast = c.joints[c.joints.length - 1]!;
    const kp0 = set.pose[j0];
    const kpLast = set.pose[jLast];
    const shS = series.get(j0);
    const wrS = series.get(jLast);
    if (kp0 !== undefined && kpLast !== undefined && shS !== undefined && wrS !== undefined) {
      const keySW = pictureAngle(kp0, kpLast);
      const scanSW = pictureAngle(shS[i]!, wrS[i]!);
      swMod = Math.max(0, Math.min(6, outSign * wrap(scanSW - keySW)));
    }
    const lim0 = set.turn[b0];
    const lim1 = set.turn[b1];
    const off0 = outSign * (clear0 + 0.5 * swMod);
    const off1 = outSign * (clear1 + 0.5 * swMod);
    const cl0 = lim0 !== undefined ? Math.min(Math.max(off0, lim0[0]), lim0[1]) : off0;
    const cl1 = lim1 !== undefined ? Math.min(Math.max(off1, lim1[0]), lim1[1]) : off1;
    return [wrap(drawn0 + cl0), wrap(drawn1 + cl1)];
  };
  /**
   * #188: For a support chain in `set.support`, anchor its bones on frame `i` to `set.drawn`
   * within a ±2.5° (≤ ±3°) breathing tolerance from the pose's delta relative to the set's
   * reference pose.
   */
  const solveSupportChainFrame = (set: (typeof map.alternates)[number], c: Chain, i: number): void => {
    for (let k = 0; k < c.bones.length; k++) {
      const b = c.bones[k]!;
      const dr = set.drawn[b];
      if (dr === undefined) continue;
      const kp0 = c.joints[k] !== undefined ? set.pose[c.joints[k]!] : undefined;
      const kp1 = c.joints[k + 1] !== undefined ? set.pose[c.joints[k + 1]!] : undefined;
      const keyAng = kp0 !== undefined && kp1 !== undefined ? pictureAngle(kp0, kp1) : dr;
      const raw = rawTargets.get(b)?.[i] ?? keyAng;
      const diff = Math.max(-2.5, Math.min(2.5, 0.1 * wrap(raw - keyAng)));
      targets.get(b)![i] = wrap(dr + diff);
    }
  };
  /**
   * #188 / #207: For a `set.symmetric === true` gesture set, solve its two two-bone arm chains
   * on frame `i` in the chest-local frame so the diamond is symmetric about the torso axis and
   * torso lean carries the whole diamond without collapsing one arm into the ±20° turn clamp.
   */
  const solveSymmetricFrame = (set: (typeof map.alternates)[number], i: number): { cR: Chain; cL: Chain; wR: Pt; wL: Pt; hc: Pt; ed: number } | null => {
    if (set.chains.length !== 2) return null;
    const c0 = map.chains.find((x) => x.name === set.chains[0]!);
    const c1 = map.chains.find((x) => x.name === set.chains[1]!);
    if (c0 === undefined || c1 === undefined || c0.bones.length !== 2 || c1.bones.length !== 2) return null;
    const S0_0 = rigPoint(rest, c0.bones[0]!);
    const S0_1 = rigPoint(rest, c1.bones[0]!);
    if (S0_0 === null || S0_1 === null) return null;
    const [cR, cL] = S0_0[0] <= S0_1[0] ? [c0, c1] : [c1, c0];
    const [bR0, bR1] = cR.bones as [string, string];
    const [bL0, bL1] = cL.bones as [string, string];
    const wSpecR = cR.aim[1] === 'x' ? `${bR1}:tip` : cR.aim[1]!;
    const wSpecL = cL.aim[1] === 'x' ? `${bL1}:tip` : cL.aim[1]!;
    const SR0 = rigPoint(rest, bR0)!;
    const ER0 = rigPoint(rest, bR1)!;
    const WR0 = rigPoint(rest, wSpecR)!;
    const SL0 = rigPoint(rest, bL0)!;
    const EL0 = rigPoint(rest, bL1)!;
    const WL0 = rigPoint(rest, wSpecL)!;
    const lR0 = Math.hypot(ER0[0] - SR0[0], ER0[1] - SR0[1]);
    const lR1 = Math.hypot(WR0[0] - ER0[0], WR0[1] - ER0[1]);
    const lL0 = Math.hypot(EL0[0] - SL0[0], EL0[1] - SL0[1]);
    const lL1 = Math.hypot(WL0[0] - EL0[0], WL0[1] - EL0[1]);
    const dR0 = wrap(Math.atan2(ER0[1] - SR0[1], ER0[0] - SR0[0]) * DEG - restOf.get(bR0)!);
    const dR1 = wrap(Math.atan2(WR0[1] - ER0[1], WR0[0] - ER0[0]) * DEG - restOf.get(bR1)!);
    const dL0 = wrap(Math.atan2(EL0[1] - SL0[1], EL0[0] - SL0[0]) * DEG - restOf.get(bL0)!);
    const dL1 = wrap(Math.atan2(WL0[1] - EL0[1], WL0[0] - EL0[0]) * DEG - restOf.get(bL1)!);
    const sr = posedOrigin(bR0, i);
    const sl = posedOrigin(bL0, i);
    let hc: Pt = [(sr[0] + sl[0]) / 2, (sr[1] + sl[1]) / 2 + 0.85 * Math.hypot(sl[0] - sr[0], sl[1] - sr[1])];
    let ed = Math.max(1e-3, 0.30 * Math.hypot(sl[0] - sr[0], sl[1] - sr[1]));
    if (gestureHead !== null) {
      const ha = posedPoint(gestureHead.points[0], i);
      const hb = posedPoint(gestureHead.points[1], i);
      const d = Math.hypot(hb[0] - ha[0], hb[1] - ha[1]);
      if (d > 1e-6) {
        hc = [(ha[0] + hb[0]) / 2, (ha[1] + hb[1]) / 2];
        ed = d;
      }
    }
    let hc0: Pt = [(SR0[0] + SL0[0]) / 2, (SR0[1] + SL0[1]) / 2 + 0.85 * Math.hypot(SL0[0] - SR0[0], SL0[1] - SR0[1])];
    let ed0 = Math.max(1e-3, 0.30 * Math.hypot(SL0[0] - SR0[0], SL0[1] - SR0[1]));
    if (gestureHead !== null) {
      const ha0 = rigPoint(rest, gestureHead.points[0]);
      const hb0 = rigPoint(rest, gestureHead.points[1]);
      if (ha0 !== null && hb0 !== null) {
        const d0 = Math.hypot(hb0[0] - ha0[0], hb0[1] - ha0[1]);
        if (d0 > 1e-6) {
          hc0 = [(ha0[0] + hb0[0]) / 2, (ha0[1] + hb0[1]) / 2];
          ed0 = d0;
        }
      }
    }
    const above0 = mappedAbove(bR0);
    const chestTurn = above0 === null ? 0 : turn(above0, i);
    const drawnR0 = set.drawn[bR0]!;
    const drawnR1 = set.drawn[bR1]!;
    const drawnL0 = set.drawn[bL0]!;
    const drawnL1 = set.drawn[bL1]!;
    const turnR0 = set.turn[bR0] ?? [-20, 20];
    const turnR1 = set.turn[bR1] ?? [-20, 20];
    const turnL0 = set.turn[bL0] ?? [-20, 20];
    const turnL1 = set.turn[bL1] ?? [-20, 20];
    const erDrawnX = SR0[0] + lR0 * Math.cos((drawnR0 + dR0) / DEG);
    const elDrawnX = SL0[0] + lL0 * Math.cos((drawnL0 + dL0) / DEG);
    let aR0_c: number;
    let aL0_c: number;
    let aR1_c: number;
    let aL1_c: number;
    if (Math.abs(wrap(drawnR0 + drawnL0 - 180)) > 1 && (hc0[0] - erDrawnX > lR1 || elDrawnX - hc0[0] > lL1)) {
      const eyTarget = hc0[1] - 0.30 * ed0;
      const sR = Math.max(-1, Math.min(1, (eyTarget - SR0[1]) / Math.max(1e-6, lR0)));
      const sL = Math.max(-1, Math.min(1, (eyTarget - SL0[1]) / Math.max(1e-6, lL0)));
      const wantR0 = wrap(180 - Math.asin(sR) * DEG - dR0);
      const wantL0 = wrap(Math.asin(sL) * DEG - dL0);
      const offR0_c = Math.min(Math.max(wrap(wantR0 - drawnR0), turnR0[0]), turnR0[1]);
      const offL0_c = Math.min(Math.max(wrap(wantL0 - drawnL0), turnL0[0]), turnL0[1]);
      aR0_c = wrap(drawnR0 + offR0_c);
      aL0_c = wrap(drawnL0 + offL0_c);
      const offR1_c = Math.min(Math.max(-0.35 * offR0_c, turnR1[0]), turnR1[1]);
      const offL1_c = Math.min(Math.max(-0.35 * offL0_c, turnL1[0]), turnL1[1]);
      aR1_c = wrap(drawnR1 + offR1_c);
      aL1_c = wrap(drawnL1 + offL1_c);
    } else {
      const rawR0 = wrap((rawTargets.get(bR0)?.[i] ?? drawnR0) - chestTurn);
      const rawL0 = wrap((rawTargets.get(bL0)?.[i] ?? drawnL0) - chestTurn);
      const offR0 = wrap(rawR0 - drawnR0);
      const offL0 = wrap(rawL0 - drawnL0);
      const cOpen = Math.max(-4, Math.min(2, 0.15 * 0.5 * (offR0 - offL0)));
      const evalDiff = (deg: number) => {
        const dR = deg < 0 ? 0.25 * deg : deg;
        const dL = deg > 0 ? 0.25 * deg : deg;
        const ar = drawnR0 + Math.min(Math.max(cOpen + dR, turnR0[0]), turnR0[1]);
        const al = drawnL0 + Math.min(Math.max(-cOpen + dL, turnL0[0]), turnL0[1]);
        const eyr = SR0[1] + lR0 * Math.sin((ar + dR0) / DEG);
        const eyl = SL0[1] + lL0 * Math.sin((al + dL0) / DEG);
        return eyl - eyr;
      };
      let lo = -45;
      let hi = 45;
      let fLo = evalDiff(lo);
      const fHi = evalDiff(hi);
      let deg: number;
      if ((fLo <= 0 && fHi <= 0) || (fLo > 0 && fHi > 0)) {
        deg = Math.abs(fLo) <= Math.abs(fHi) ? lo : hi;
      } else {
        for (let it = 0; it < 36; it++) {
          const mid = 0.5 * (lo + hi);
          const fMid = evalDiff(mid);
          if ((fLo <= 0 && fMid <= 0) || (fLo > 0 && fMid > 0)) {
            lo = mid;
            fLo = fMid;
          } else {
            hi = mid;
          }
        }
        deg = 0.5 * (lo + hi);
      }
      const dR = deg < 0 ? 0.25 * deg : deg;
      const dL = deg > 0 ? 0.25 * deg : deg;
      aR0_c = drawnR0 + Math.min(Math.max(cOpen + dR, turnR0[0]), turnR0[1]);
      aL0_c = drawnL0 + Math.min(Math.max(-cOpen + dL, turnL0[0]), turnL0[1]);
      const eyR0 = SR0[1] + lR0 * Math.sin((aR0_c + dR0) / DEG);
      const eyL0 = SL0[1] + lL0 * Math.sin((aL0_c + dL0) / DEG);
      if (Math.abs(eyL0 - eyR0) > 1e-4) {
        const sL = Math.max(-1, Math.min(1, (eyR0 - SL0[1]) / Math.max(1e-6, lL0)));
        const candL = wrap(Math.asin(sL) * DEG - dL0);
        const tL = wrap(candL - drawnL0);
        if (tL >= turnL0[0] && tL <= turnL0[1]) aL0_c = candL;
      }
      aR0_c = wrap(aR0_c);
      aL0_c = wrap(aL0_c);
      const rR0_c = (aR0_c + dR0) / DEG;
      const rL0_c = (aL0_c + dL0) / DEG;
      const exR_c = SR0[0] + lR0 * Math.cos(rR0_c);
      const eyR_c = SR0[1] + lR0 * Math.sin(rR0_c);
      const exL_c = SL0[0] + lL0 * Math.cos(rL0_c);
      const eyL_c = SL0[1] + lL0 * Math.sin(rL0_c);
      const aimFore0 = (ex: number, ey: number, l1: number, d1: number, drawn1: number, turn1: readonly [number, number], tx: number, ty: number): number => {
        const want = wrap(Math.atan2(ty - ey, tx - ex) * DEG - d1);
        const off = Math.min(Math.max(wrap(want - drawn1), turn1[0]), turn1[1]);
        let a1 = wrap(drawn1 + off);
        const r1 = (a1 + d1) / DEG;
        const wx = ex + l1 * Math.cos(r1);
        const wy = ey + l1 * Math.sin(r1);
        const xMin = hc0[0] - 0.30 * ed0;
        const xMax = hc0[0] + 0.30 * ed0;
        const yMin = hc0[1] + 0.15 * ed0;
        const yMax = hc0[1] + 0.95 * ed0;
        if (wx < xMin || wx > xMax || wy < yMin || wy > yMax) {
          let bestA = a1;
          let bestErr = Infinity;
          for (let step = -200; step <= 200; step++) {
            const candOff = turn1[0] + ((turn1[1] - turn1[0]) * (step + 200)) / 400;
            const candA = wrap(drawn1 + candOff);
            const cr = (candA + d1) / DEG;
            const cwx = ex + l1 * Math.cos(cr);
            const cwy = ey + l1 * Math.sin(cr);
            const ox = cwx < xMin ? xMin - cwx : cwx > xMax ? cwx - xMax : 0;
            const oy = cwy < yMin ? yMin - cwy : cwy > yMax ? cwy - yMax : 0;
            const err = (ox + oy) * 1000 + Math.hypot(cwx - tx, cwy - ty);
            if (err < bestErr) {
              bestErr = err;
              bestA = candA;
            }
          }
          a1 = bestA;
        }
        return a1;
      };
      aR1_c = aimFore0(exR_c, eyR_c, lR1, dR1, drawnR1, turnR1, hc0[0] - 0.20 * ed0, hc0[1] + 0.65 * ed0);
      aL1_c = aimFore0(exL_c, eyL_c, lL1, dL1, drawnL1, turnL1, hc0[0] + 0.20 * ed0, hc0[1] + 0.65 * ed0);
    }
    const carry = 0.35 * chestTurn;
    const aR0 = wrap(aR0_c + carry);
    const aR1 = wrap(aR1_c + carry);
    const aL0 = wrap(aL0_c + carry);
    const aL1 = wrap(aL1_c + carry);
    const rR0 = (aR0 + dR0) / DEG;
    const rR1 = (aR1 + dR1) / DEG;
    const rL0 = (aL0 + dL0) / DEG;
    const rL1 = (aL1 + dL1) / DEG;
    const wR: Pt = [sr[0] + lR0 * Math.cos(rR0) + lR1 * Math.cos(rR1), sr[1] + lR0 * Math.sin(rR0) + lR1 * Math.sin(rR1)];
    const wL: Pt = [sl[0] + lL0 * Math.cos(rL0) + lL1 * Math.cos(rL1), sl[1] + lL0 * Math.sin(rL0) + lL1 * Math.sin(rL1)];
    targets.get(bR0)![i] = aR0;
    targets.get(bR1)![i] = aR1;
    targets.get(bL0)![i] = aL0;
    targets.get(bL1)![i] = aL1;
    return { cR, cL, wR, wL, hc, ed };
  };
  if (headOk !== null || hipsOk !== null) {
    /** The anchor's two rig points posed on frame i: their midpoint and their distance apart. */
    const pairOn = (an: Anchor, i: number): { centre: Pt; dist: number } => {
      const a = posedPoint(an.points[0], i);
      const b = posedPoint(an.points[1], i);
      return { centre: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    };
    const isChainHeadPlaced = (set: (typeof map.alternates)[number], c: Chain, drawn: number | undefined): boolean => {
      if (headOk === null) return false;
      if (set.anchor?.includes(c.name) === true) return true;
      const wJoint = c.joints[c.joints.length - 1];
      const ea = set.pose[headOk.joints[0]];
      const eb = set.pose[headOk.joints[1]];
      const wr = wJoint !== undefined ? set.pose[wJoint] : undefined;
      if (ea !== undefined && eb !== undefined && wr !== undefined) {
        const ed = Math.hypot(eb[0] - ea[0], eb[1] - ea[1]);
        if (ed > 1e-6) {
          const hc: Pt = [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2];
          return Math.hypot(wr[0] - hc[0], wr[1] - hc[1]) <= RAISED_WRIST_EYES * ed;
        }
      }
      if (c.bones.length === 2 && !c.reach && !c.aim.some((x) => x.includes('>')) && c.joints.length >= 3) {
        const ha0 = rigPoint(rest, headOk.points[0]);
        const hb0 = rigPoint(rest, headOk.points[1]);
        const S0 = rigPoint(rest, c.bones[0]!);
        const E0 = rigPoint(rest, c.bones[1]!);
        const wSpec = c.aim[1] === 'x' ? `${c.bones[1]!}:tip` : c.aim[1]!;
        const W0 = rigPoint(rest, wSpec);
        const p0 = set.pose[c.joints[0]!];
        const p1 = set.pose[c.joints[1]!];
        const p2 = set.pose[c.joints[2]!];
        if (ha0 !== null && hb0 !== null && S0 !== null && E0 !== null && W0 !== null && p0 !== undefined && p1 !== undefined && p2 !== undefined) {
          const rigEye0 = Math.hypot(hb0[0] - ha0[0], hb0[1] - ha0[1]);
          const l0 = Math.hypot(E0[0] - S0[0], E0[1] - S0[1]);
          const l1 = Math.hypot(W0[0] - E0[0], W0[1] - E0[1]);
          if (rigEye0 > 1e-6) {
            if (l0 / rigEye0 > 3.5) return drawn !== undefined && isRaised(drawn);
            const H0: Pt = [(ha0[0] + hb0[0]) / 2, (ha0[1] + hb0[1]) / 2];
            const k0 = pictureAngle(p0, p1) / DEG;
            const k1 = pictureAngle(p1, p2) / DEG;
            const Wx = S0[0] + l0 * Math.cos(k0) + l1 * Math.cos(k1);
            const Wy = S0[1] + l0 * Math.sin(k0) + l1 * Math.sin(k1);
            return (
              Math.hypot(Wx - H0[0], Wy - H0[1]) <= RAISED_WRIST_EYES * rigEye0 ||
              (Math.abs(Wy - H0[1]) <= RAISED_WRIST_EYES * rigEye0 && Math.hypot(Wx - S0[0], Wy - S0[1]) <= RAISED_WRIST_EYES * rigEye0)
            );
          }
        }
      }
      return drawn !== undefined && isRaised(drawn);
    };
    for (const s of sw.switches) {
      const set = map.alternates.find((a) => a.name === s.set)!;
      const art: ArtRange[] = [];
      for (const cn of s.chains) {
        if (sw.chainHolds?.some((h) => h.chain === cn && h.set !== s.set && h.frames[0] <= s.frames[0] && h.frames[1] >= s.frames[1]) === true) continue;
        const c = map.chains.find((x) => x.name === cn)!;
        if (set.support?.includes(c.name) === true) {
          for (let i = s.frames[0]; i <= s.frames[1]; i++) solveSupportChainFrame(set, c, i);
          continue;
        }
        const drawn = set.drawn[c.bones[0]!];
        const up = isChainHeadPlaced(set, c, drawn);
        const low = hipsOk !== null && set.place?.chains.includes(c.name) === true;
        if (!up && !low && headOk !== null && drawn !== undefined && isRaised(drawn) && c.bones.length >= 1 && c.joints.length >= 2) {
          if (set.support !== undefined && c.bones.length >= 2) {
            const t0 = targets.get(c.bones[0]!)!;
            const t1 = targets.get(c.bones[1]!)!;
            for (let i = s.frames[0]; i <= s.frames[1]; i++) {
              const pair = solveSupportActiveFrame(set, c, i);
              if (pair !== null) {
                t0[i] = pair[0];
                t1[i] = pair[1];
              }
            }
          } else {
            const p0 = set.pose[c.joints[0]!];
            const p1 = set.pose[c.joints[1]!];
            if (p0 !== undefined && p1 !== undefined) {
              const key0 = pictureAngle(p0, p1);
              const t0 = targets.get(c.bones[0]!)!;
              for (let i = s.frames[0]; i <= s.frames[1]; i++) {
                const diff = Math.max(-3, Math.min(3, wrap(t0[i]! - key0)));
                t0[i] = wrap(drawn + diff);
              }
            }
          }
        }
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
        const isHeadAnchored = HEAD_ANCHOR_FRAME !== 'off' && set.anchor?.includes(c.name) === true;
        if (isHeadAnchored) job.saturated = [];
        let prevUpperClampSign: -1 | 0 | 1 = 0;
        for (const i of span) {
          const h = pairOn(anchor, i);
          const rc = refCentre(i);
          // The reference's wrist from its head centre, in its eye distances, y turned up.
          const ref: Pt = [(refWrist[i]![0] - rc[0]) / refEye, -(refWrist[i]![1] - rc[1]) / refEye];
          const w = wristOf(i);
          job.reference.push(ref);
          job.before.push([(w[0] - h.centre[0]) / rigEye, (w[1] - h.centre[1]) / rigEye]);
          const shoulder = posedOrigin(b0, i);
          if (isHeadAnchored) {
            const ha = solveHeadAnchorFrame(set, c, i);
            if (ha !== null) {
              job.farthest = Math.max(job.farthest, Math.hypot(ha.targetTip[0] - shoulder[0], ha.targetTip[1] - shoulder[1]));
              job.placed.push([(ha.placedTip[0] - h.centre[0]) / rigEye, (ha.placedTip[1] - h.centre[1]) / rigEye]);
              if (ha.upperHeld) job.upperHeld.push(i);
              if (ha.saturated) job.saturated!.push({ frame: i, residual: r3(ha.residual) });
              const tt0 = turn0 === undefined ? 0 : wrap(ha.a0 - set.drawn[b0]!);
              const tt1 = turn1 === undefined ? 0 : wrap(ha.a1 - set.drawn[b1]!);
              upperAsked.push(tt0);
              upperOver.push(0);
              foreAsked.push(tt1);
              foreOver.push(0);
              heldMiss.push(ha.saturated ? ha.residual / rigEye : 0);
              t0[i] = ha.a0;
              t1[i] = ha.a1;
              continue;
            }
          }
          const target: Pt = [h.centre[0] + ref[0] * rigEye, h.centre[1] + ref[1] * rigEye];
          let solveTarget: Pt = target;
          if (up && l0 / rigEye <= 3.5 && (turn0 !== undefined || turn1 !== undefined)) {
            const side0: 1 | -1 = wrap(t1[i]! + d1 - (t0[i]! + d0)) >= 0 ? 1 : -1;
            const place0 = reachLimit(h.centre, solveTarget, shoulder, l0, l1);
            const sol0 = twoBone(shoulder, place0.point, l0, l1, side0);
            if (sol0.upper !== null) {
              let a0Cl = wrap(sol0.upper - d0);
              let a1Cl = wrap(sol0.fore - d1);
              if (turn0 !== undefined && set.drawn[b0] !== undefined) {
                const tt0 = wrap(a0Cl - set.drawn[b0]!);
                let cl0 = Math.min(Math.max(tt0, turn0[0]), turn0[1]);
                if (Math.abs(cl0 - tt0) > RANGE_SLACK) {
                  const sign0: 1 | -1 = cl0 < tt0 ? 1 : -1;
                  if (place0.how === 'in' && prevUpperClampSign !== 0 && sign0 !== prevUpperClampSign) {
                    cl0 = prevUpperClampSign > 0 ? turn0[1] : turn0[0];
                  }
                  a0Cl = wrap(set.drawn[b0]! + cl0);
                  const r0Cl = (a0Cl + d0) / DEG;
                  const ECl: Pt = [shoulder[0] + l0 * Math.cos(r0Cl), shoulder[1] + l0 * Math.sin(r0Cl)];
                  a1Cl = wrap(Math.atan2(place0.point[1] - ECl[1], place0.point[0] - ECl[0]) * DEG - d1);
                }
              }
              if (turn1 !== undefined && set.drawn[b1] !== undefined) {
                const asked1 = wrap(a1Cl - set.drawn[b1]!);
                if (overflow(asked1, turn1) > RANGE_SLACK) {
                  a1Cl = wrap(set.drawn[b1]! + Math.min(Math.max(asked1, turn1[0]), turn1[1]));
                }
              }
              const r0Cl = (a0Cl + d0) / DEG;
              const r1Cl = (a1Cl + d1) / DEG;
              const WCl: Pt = [shoulder[0] + l0 * Math.cos(r0Cl) + l1 * Math.cos(r1Cl), shoulder[1] + l0 * Math.sin(r0Cl) + l1 * Math.sin(r1Cl)];
              const miss0 = Math.hypot(place0.point[0] - WCl[0], place0.point[1] - WCl[1]) / rigEye;
              if (miss0 > 0.86) {
                const k = (0.86 * rigEye) / Math.hypot(place0.point[0] - WCl[0], place0.point[1] - WCl[1]);
                solveTarget = [WCl[0] + (place0.point[0] - WCl[0]) * k, WCl[1] + (place0.point[1] - WCl[1]) * k];
              }
            }
          }
          job.farthest = Math.max(job.farthest, Math.hypot(solveTarget[0] - shoulder[0], solveTarget[1] - shoulder[1]));
          const place = reachLimit(h.centre, solveTarget, shoulder, l0, l1);
          const P = place.point;
          job.placed.push([(P[0] - h.centre[0]) / rigEye, (P[1] - h.centre[1]) / rigEye]);
          if (place.how !== 'in') job.short.push({ i, how: place.how, shortfall: Math.hypot(solveTarget[0] - P[0], solveTarget[1] - P[1]) / rigEye });
          // The pose's bend side, read on the vectors the two bones carry.
          const side: 1 | -1 = wrap(t1[i]! + d1 - (t0[i]! + d0)) >= 0 ? 1 : -1;
          const sol = twoBone(shoulder, P, l0, l1, side);
          if (sol.upper === null) {
            foreAsked.push(wrap(t1[i]! - (set.drawn[b1] ?? 0)));
            foreOver.push(0);
            upperAsked.push(0);
            upperOver.push(0);
            heldMiss.push(0);
            prevUpperClampSign = 0;
            continue;
          }
          let a0 = wrap(sol.upper - d0);
          let a1 = wrap(sol.fore - d1);
          // The set's turn holds the upper arm; the forearm is then re-aimed at the placed wrist from where the held upper arm puts the elbow.
          let held = false;
          let tt = turn0 === undefined ? 0 : wrap(a0 - set.drawn[b0]!);
          if (turn0 !== undefined) {
            let cl = Math.min(Math.max(tt, turn0[0]), turn0[1]);
            if (Math.abs(cl - tt) > RANGE_SLACK) {
              const sign: 1 | -1 = cl < tt ? 1 : -1;
              if (place.how === 'in' && prevUpperClampSign !== 0 && sign !== prevUpperClampSign) {
                cl = prevUpperClampSign > 0 ? turn0[1] : turn0[0];
                tt += prevUpperClampSign * 360;
              }
              held = true;
              prevUpperClampSign = cl < tt ? 1 : -1;
              a0 = wrap(set.drawn[b0]! + cl);
              job.upperHeld.push(i);
              const r = (a0 + d0) / DEG;
              const E: Pt = [shoulder[0] + l0 * Math.cos(r), shoulder[1] + l0 * Math.sin(r)];
              a1 = wrap(Math.atan2(P[1] - E[1], P[0] - E[0]) * DEG - d1);
            } else {
              prevUpperClampSign = 0;
            }
          }
          upperAsked.push(tt);
          upperOver.push(turn0 === undefined ? 0 : overflow(tt, turn0));
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
          if (up && l0 / rigEye <= 3.5 && Math.hypot(W[0] - P[0], W[1] - P[1]) / rigEye > 0.86) {
            const k = (0.86 * rigEye) / Math.hypot(W[0] - P[0], W[1] - P[1]);
            const Pc: Pt = [W[0] + (P[0] - W[0]) * k, W[1] + (P[1] - W[1]) * k];
            job.placed[job.placed.length - 1] = [(Pc[0] - h.centre[0]) / rigEye, (Pc[1] - h.centre[1]) / rigEye];
            heldMiss.push(held ? 0.86 : 0);
          } else {
            heldMiss.push(held ? Math.hypot(W[0] - P[0], W[1] - P[1]) / rigEye : 0);
          }
          t0[i] = a0;
          t1[i] = a1;
        }
        // A held upper arm whose re-aimed forearm leaves the wrist more than HELD_MISS short of its placed point: ART-RANGE on the upper arm, with the shortfall.
        if (turn0 !== undefined && set.symmetric !== true) {
          for (const [a, b] of runsOf(heldMiss.map((m) => m > HELD_MISS), RANGE_GAP)) {
            let worst = a;
            for (let k = a; k <= b; k++) if (heldMiss[k]! > heldMiss[worst]!) worst = k;
            const first = s.frames[0] + a;
            const last = s.frames[0] + b;
            art.push({ set: set.name, chain: c.name, bone: b0, frames: [first, last], seconds: r6(endOf(last) - keyTimes[first]!), maxOverflow: r3(upperOver[worst]!), turn: r3(upperAsked[worst]!), limits: turn0, clamped: true, shortfall: r3(heldMiss[worst]!), ...(up ? {} : { anchor: 'hip' as const }) });
          }
        }
        if (turn1 !== undefined && set.symmetric !== true) {
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
      if (set.symmetric === true) {
        for (let i = s.frames[0]; i <= s.frames[1]; i++) {
          const sym = solveSymmetricFrame(set, i);
          if (sym === null) continue;
          const k = i - s.frames[0];
          for (const job of raisedJobs) {
            if (job.sw !== s) continue;
            const w = job.chain.name === sym.cR.name ? sym.wR : job.chain.name === sym.cL.name ? sym.wL : null;
            if (w !== null && k >= 0 && k < job.placed.length) {
              job.placed[k] = [(w[0] - sym.hc[0]) / job.rigEye, (w[1] - sym.hc[1]) / job.rigEye];
              job.upperHeld = [];
              job.short = [];
            }
          }
        }
      }
      art.sort((x, y) => x.frames[0] - y.frames[0]);
      if (art.length > 0) raisedArt.push({ sw: s, entries: art });
    }
  }
  // #188 / #191: Even without --raised-by-head, apply symmetric normalisation, support-arm anchoring, and head-anchored IK on each switch's span.
  for (const s of sw.switches) {
    const set = map.alternates.find((a) => a.name === s.set)!;
    if (set.symmetric === true && headOk === null && hipsOk === null) {
      for (let i = s.frames[0]; i <= s.frames[1]; i++) solveSymmetricFrame(set, i);
    }
    if (set.anchor !== undefined && headOk === null && hipsOk === null && HEAD_ANCHOR_FRAME !== 'off') {
      for (const cn of set.anchor) {
        if (!s.chains.includes(cn)) continue;
        const c = map.chains.find((x) => x.name === cn);
        if (!c || c.bones.length < 2) continue;
        const t0 = targets.get(c.bones[0]!)!;
        const t1 = targets.get(c.bones[1]!)!;
        for (let i = s.frames[0]; i <= s.frames[1]; i++) {
          const ha = solveHeadAnchorFrame(set, c, i);
          if (ha !== null) {
            t0[i] = ha.a0;
            t1[i] = ha.a1;
          }
        }
      }
    }
    if (set.support !== undefined) {
      for (const cn of s.chains) {
        const c = map.chains.find((x) => x.name === cn)!;
        if (set.support.includes(c.name)) {
          for (let i = s.frames[0]; i <= s.frames[1]; i++) solveSupportChainFrame(set, c, i);
        } else if (headOk === null && hipsOk === null && c.bones.length >= 2) {
          const t0 = targets.get(c.bones[0]!)!;
          const t1 = targets.get(c.bones[1]!)!;
          for (let i = s.frames[0]; i <= s.frames[1]; i++) {
            const pair = solveSupportActiveFrame(set, c, i);
            if (pair !== null) {
              t0[i] = pair[0];
              t1[i] = pair[1];
            }
          }
        }
      }
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
  clampArt(sw.switches, map, targets, sw.chainHolds);
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
      ...(job.saturated !== undefined ? { saturated: job.saturated } : {}),
      reach: { min: r6(Math.abs(job.l0 - job.l1)), max: r6(job.l0 + job.l1), farthest: r6(job.farthest) },
    };
    // The unit sits after `seconds`, as the report has always written it.
    const { set, chain, frames, seconds, ...body } = entry;
    if (job.anchor.kind === 'head') raised.push({ set, chain, frames, seconds, eyes: unit, ...body });
    else byHip.push({ set, chain, frames, seconds, hips: unit, ...body });
  }
  if (opts.short !== 'off') {
    for (const s of short) {
      if (s.step === undefined || s.across === true) continue;
      const cov = covered.get(s.chain);
      const [lo, hi] = s.frames;
      if (lo <= 0 || hi + 1 >= n) continue;
      if (cov?.[lo - 1] !== true && cov?.[hi + 1] !== true) continue;
      if (cov?.[lo - 1] === true && cov?.[hi + 1] === true && hi - lo + 1 <= 10) continue;
      const ch = map.chains.find((c) => c.name === s.chain);
      const bIdx = ch !== undefined ? ch.bones.indexOf(s.bone) : -1;
      const parentTg = ch !== undefined && bIdx > 0 ? targets.get(ch.bones[bIdx - 1]!) : undefined;
      const tg = targets.get(s.bone)!;
      const startA = parentTg !== undefined ? wrap(tg[lo - 1]! - parentTg[lo - 1]!) : tg[lo - 1]!;
      const endA = parentTg !== undefined ? wrap(tg[hi + 1]! - parentTg[hi + 1]!) : tg[hi + 1]!;
      const total = wrap(endA - startA);
      const steps = hi - lo + 2;
      for (let k = lo; k <= hi; k++) {
        const localA = wrap(startA + ((k - lo + 1) / steps) * total);
        tg[k] = parentTg !== undefined ? wrap(parentTg[k]! + localA) : localA;
      }
      s.step = r3(total / steps);
    }
    const interpolateChainInJointSpace = (ch: Chain, i0: number, i1: number) => {
      const steps = i1 - i0;
      if (steps < 2 || i0 < 0 || i1 >= n) return;
      for (let bIdx = 0; bIdx < ch.bones.length; bIdx++) {
        const b = ch.bones[bIdx]!;
        const tg = targets.get(b);
        if (!tg) continue;
        const parentTg = bIdx > 0 ? targets.get(ch.bones[bIdx - 1]!) : undefined;
        const startA = parentTg !== undefined ? wrap(tg[i0]! - parentTg[i0]!) : tg[i0]!;
        const endA = parentTg !== undefined ? wrap(tg[i1]! - parentTg[i1]!) : tg[i1]!;
        const total = wrap(endA - startA);
        for (let k = i0 + 1; k < i1; k++) {
          const localA = wrap(startA + ((k - i0) / steps) * total);
          tg[k] = parentTg !== undefined ? wrap(parentTg[k]! + localA) : localA;
        }
      }
    };
    const holds = sw.chainHolds ?? [];
    for (const h of holds) {
      const swParent = sw.switches.find((s) => s.set === h.set && s.frames[0] === h.frames[0] && s.frames[1] > h.frames[1]);
      if (!swParent) continue;
      const nextH = holds.find((nh) => nh.chain === h.chain && nh.frames[0] > h.frames[1] && nh.frames[0] - h.frames[1] <= 10);
      if (!nextH) continue;
      const lo = h.frames[1] + 1;
      const hi = nextH.frames[0] - 1;
      if (lo > hi || lo <= 0 || hi + 1 >= n) continue;
      const ch = map.chains.find((c) => c.name === h.chain);
      if (!ch) continue;
      interpolateChainInJointSpace(ch, lo - 1, hi + 1);
    }
  }
  // #188 / #191 / #206 / #218: Cover the full shown/bridged span of symmetric sets, support-arm sets, and head-anchored chains after short interpolation.
  for (let sIdx = 0; sIdx < sw.switches.length; sIdx++) {
    const s = sw.switches[sIdx]!;
    const set = map.alternates.find((a) => a.name === s.set)!;
    const setSlots = Object.entries(set.slots);
    const isSetShownAt = (i: number): boolean =>
      setSlots.length > 0 && setSlots.every(([sl, att]) => sw.shown.get(sl)?.[i] === att);
    let loShow = s.frames[0];
    while (loShow - 1 >= 0 && isSetShownAt(loShow - 1)) loShow--;
    if (
      loShow === s.frames[0] &&
      s.frames[0] > 0 &&
      set.anchor === undefined &&
      set.symmetric !== true &&
      set.support === undefined &&
      setSlots.some(([sl, att]) => sw.shown.get(sl)?.[s.frames[0] - 1] === att)
    ) {
      loShow = s.frames[0] - 1;
    }
    let hiShow = s.frames[1];
    while (hiShow + 1 < n && isSetShownAt(hiShow + 1)) hiShow++;
    if (set.anchor !== undefined && HEAD_ANCHOR_FRAME !== 'off') {
      const prevSw = sIdx > 0 ? sw.switches[sIdx - 1] : undefined;
      const i0Bridge = prevSw !== undefined && s.frames[0] - prevSw.frames[1] <= 10 ? prevSw.frames[1] : -1;
      for (const cn of set.anchor) {
        const c = map.chains.find((x) => x.name === cn);
        if (!c || c.bones.length < 2) continue;
        const chainSlots = setSlots.filter(([sl]) => {
          const sb = slots.get(sl)?.bone;
          return sb !== undefined && c.bones.includes(sb);
        });
        const isChainShownAt = (i: number): boolean =>
          chainSlots.length > 0
            ? chainSlots.every(([sl, att]) => sw.shown.get(sl)?.[i] === att)
            : isSetShownAt(i);
        let loC = s.frames[0];
        while (loC - 1 >= 0 && isChainShownAt(loC - 1)) loC--;
        let hiC = s.frames[1];
        while (hiC + 1 < n && isChainShownAt(hiC + 1)) hiC++;
        const t0 = targets.get(c.bones[0]!)!;
        const t1 = targets.get(c.bones[1]!)!;
        for (let i = loC; i <= hiC; i++) {
          const ha = solveHeadAnchorFrame(set, c, i);
          if (ha !== null) {
            t0[i] = ha.a0;
            t1[i] = ha.a1;
          }
        }
        if (i0Bridge >= 0 && prevSw!.chains.includes(cn) && s.frames[0] - i0Bridge >= 2) {
          const i1Bridge = s.frames[0];
          const steps = i1Bridge - i0Bridge;
          for (let bIdx = 0; bIdx < c.bones.length; bIdx++) {
            const b = c.bones[bIdx]!;
            const tg = targets.get(b)!;
            const parentTg = bIdx > 0 ? targets.get(c.bones[bIdx - 1]!) : undefined;
            const startA = parentTg !== undefined ? wrap(tg[i0Bridge]! - parentTg[i0Bridge]!) : tg[i0Bridge]!;
            const endA = parentTg !== undefined ? wrap(tg[i1Bridge]! - parentTg[i1Bridge]!) : tg[i1Bridge]!;
            const total = wrap(endA - startA);
            for (let k = i0Bridge + 1; k < i1Bridge; k++) {
              const localA = wrap(startA + ((k - i0Bridge) / steps) * total);
              tg[k] = parentTg !== undefined ? wrap(parentTg[k]! + localA) : localA;
            }
          }
        } else if (loC >= 2 && covered.get(cn)?.[loC - 1] === true) {
          t0[loC - 1] = t0[loC - 2]!;
          t1[loC - 1] = t1[loC - 2]!;
        }
        if (hiC + 2 < n && covered.get(cn)?.[hiC + 1] === true) {
          t0[hiC + 1] = t0[hiC + 2]!;
          t1[hiC + 1] = t1[hiC + 2]!;
        }
      }
    }
    if (set.symmetric === true) {
      for (let i = loShow; i <= s.frames[1]; i++) solveSymmetricFrame(set, i);
      if (loShow < s.frames[0]) {
        const loRamp = Math.max(0, loShow - 6);
        const steps = loShow - loRamp;
        if (steps >= 2) {
          for (const cn of set.chains) {
            const c = map.chains.find((x) => x.name === cn);
            if (!c) continue;
            for (let bIdx = 0; bIdx < c.bones.length; bIdx++) {
              const b = c.bones[bIdx]!;
              const tg = targets.get(b)!;
              const parentTg = bIdx > 0 ? targets.get(c.bones[bIdx - 1]!) : undefined;
              const startA = parentTg !== undefined ? wrap(tg[loRamp]! - parentTg[loRamp]!) : tg[loRamp]!;
              const endA = parentTg !== undefined ? wrap(tg[loShow]! - parentTg[loShow]!) : tg[loShow]!;
              const total = wrap(endA - startA);
              for (let k = loRamp + 1; k < loShow; k++) {
                const localA = wrap(startA + ((k - loRamp) / steps) * total);
                tg[k] = parentTg !== undefined ? wrap(parentTg[k]! + localA) : localA;
              }
            }
          }
        }
      }
      if (hiShow > s.frames[1] && set.chains.length === 2) {
        const c0 = map.chains.find((x) => x.name === set.chains[0]!);
        const c1 = map.chains.find((x) => x.name === set.chains[1]!);
        if (c0 !== undefined && c1 !== undefined && c0.bones.length === 2 && c1.bones.length === 2) {
          const S0_0 = rigPoint(rest, c0.bones[0]!)!;
          const S0_1 = rigPoint(rest, c1.bones[0]!)!;
          const [cR, cL] = S0_0[0] <= S0_1[0] ? [c0, c1] : [c1, c0];
          const bR0 = cR.bones[0]!;
          const bL0 = cL.bones[0]!;
          const bR1 = cR.bones[1]!;
          const bL1 = cL.bones[1]!;
          const SR0 = rigPoint(rest, bR0)!;
          const ER0 = rigPoint(rest, bR1)!;
          const SL0 = rigPoint(rest, bL0)!;
          const EL0 = rigPoint(rest, bL1)!;
          const lR0 = Math.hypot(ER0[0] - SR0[0], ER0[1] - SR0[1]);
          const lL0 = Math.hypot(EL0[0] - SL0[0], EL0[1] - SL0[1]);
          const dR0 = wrap(Math.atan2(ER0[1] - SR0[1], ER0[0] - SR0[0]) * DEG - restOf.get(bR0)!);
          const dL0 = wrap(Math.atan2(EL0[1] - SL0[1], EL0[0] - SL0[0]) * DEG - restOf.get(bL0)!);
          const iEnd = s.frames[1];
          const iNext = Math.min(n - 1, hiShow + 1);
          const spanOut = Math.max(1, iNext - iEnd);
          const startR0 = targets.get(bR0)![iEnd]!;
          const startL0 = targets.get(bL0)![iEnd]!;
          const drawnR0 = set.drawn[bR0] ?? startR0;
          const drawnL0 = set.drawn[bL0] ?? startL0;
          const drawnR1 = set.drawn[bR1] ?? targets.get(bR1)![iEnd]!;
          const drawnL1 = set.drawn[bL1] ?? targets.get(bL1)![iEnd]!;
          const inR1 = wrap(drawnR1 + (set.turn[bR1]?.[0] ?? 0));
          const inL1 = wrap(drawnL1 + 0.6 * (set.turn[bL1]?.[1] ?? 0));
          const endR0 = targets.get(bR0)![iNext]!;
          const endL0 = targets.get(bL0)![iNext]!;
          for (let i = iEnd + 1; i <= hiShow; i++) {
            const u = (i - iEnd) / spanOut;
            const w = 1 - u;
            const alpha = 0.25 * u + 0.75 * u * u;
            const sr = posedOrigin(bR0, i);
            const sl = posedOrigin(bL0, i);
            const baseR = wrap(startR0 + alpha * wrap(endR0 - startR0));
            const baseL = wrap(startL0 + alpha * wrap(endL0 - startL0));
            let lo = -30;
            let hi = 30;
            const dR = (deg: number) => (deg < 0 ? 0.25 * deg : deg);
            const dL = (deg: number) => (deg > 0 ? 0.25 * deg : deg);
            const evalD = (deg: number) =>
              0.4 * w * (sl[1] - sr[1]) + lL0 * Math.sin((baseL + dL(deg) + dL0) / DEG) - lR0 * Math.sin((baseR + dR(deg) + dR0) / DEG);
            let fLo = evalD(lo);
            for (let it = 0; it < 32; it++) {
              const mid = 0.5 * (lo + hi);
              const fMid = evalD(mid);
              if ((fLo <= 0 && fMid <= 0) || (fLo > 0 && fMid > 0)) {
                lo = mid;
                fLo = fMid;
              } else hi = mid;
            }
            const deg = 0.5 * (lo + hi);
            const aR0 = wrap(baseR + dR(deg));
            const aL0 = wrap(baseL + dL(deg));
            targets.get(bR0)![i] = aR0;
            targets.get(bL0)![i] = aL0;
            targets.get(bR1)![i] = wrap(inR1 + 0.45 * wrap(aR0 - drawnR0));
            targets.get(bL1)![i] = wrap(inL1 + 0.45 * wrap(aL0 - drawnL0));
          }
        }
      }
    }
    if (set.anchor === undefined && set.symmetric !== true && set.support === undefined && loShow < s.frames[0]) {
      const prevSw = sIdx > 0 ? sw.switches[sIdx - 1] : undefined;
      const i0 = prevSw !== undefined && s.frames[0] - prevSw.frames[1] <= 10 ? prevSw.frames[1] : -1;
      for (const cn of s.chains) {
        const c = map.chains.find((x) => x.name === cn);
        if (!c || c.bones.length < 2) continue;
        const chainSlots = setSlots.filter(([sl]) => {
          const sb = slots.get(sl)?.bone;
          return sb !== undefined && c.bones.includes(sb);
        });
        const chainShownInBridge =
          chainSlots.length === 0 ||
          chainSlots.some(([sl, att]) => {
            for (let k = Math.max(0, i0 + 1); k < s.frames[0]; k++) if (sw.shown.get(sl)?.[k] === att) return true;
            return false;
          });
        if (i0 >= 0 && prevSw!.chains.includes(cn) && s.frames[0] - i0 >= 2 && chainShownInBridge) {
          const i1 = s.frames[0];
          const steps = i1 - i0;
          for (let bIdx = 0; bIdx < c.bones.length; bIdx++) {
            const b = c.bones[bIdx]!;
            const tg = targets.get(b)!;
            const parentTg = bIdx > 0 ? targets.get(c.bones[bIdx - 1]!) : undefined;
            const startA = parentTg !== undefined ? wrap(tg[i0]! - parentTg[i0]!) : tg[i0]!;
            const endA = parentTg !== undefined ? wrap(tg[i1]! - parentTg[i1]!) : tg[i1]!;
            const total = wrap(endA - startA);
            for (let k = i0 + 1; k < i1; k++) {
              const localA = wrap(startA + ((k - i0) / steps) * total);
              tg[k] = parentTg !== undefined ? wrap(parentTg[k]! + localA) : localA;
            }
          }
        } else {
          const b1 = c.bones[1]!;
          const t1 = targets.get(b1)!;
          const entryWorld1 = t1[s.frames[0]]!;
          for (let i = loShow; i < s.frames[0]; i++) {
            t1[i] = entryWorld1;
          }
        }
      }
    }
    if (set.support !== undefined) {
      const prevSw = sIdx > 0 ? sw.switches[sIdx - 1] : undefined;
      const loGap = prevSw !== undefined && s.frames[0] - prevSw.frames[1] <= 10 ? prevSw.frames[1] + 1 : loShow;
      for (const cn of s.chains) {
        const c = map.chains.find((x) => x.name === cn)!;
        if (set.support.includes(c.name)) {
          for (let i = loShow; i <= hiShow; i++) solveSupportChainFrame(set, c, i);
          if (loGap < loShow && loGap >= 1) {
            const i0 = loGap - 1;
            const i1 = loShow;
            const steps = i1 - i0;
            for (let bIdx = 0; bIdx < c.bones.length; bIdx++) {
              const b = c.bones[bIdx]!;
              const tg = targets.get(b)!;
              const parentTg = bIdx > 0 ? targets.get(c.bones[bIdx - 1]!) : undefined;
              const startA = parentTg !== undefined ? wrap(tg[i0]! - parentTg[i0]!) : tg[i0]!;
              const endA = parentTg !== undefined ? wrap(tg[i1]! - parentTg[i1]!) : tg[i1]!;
              const total = wrap(endA - startA);
              for (let k = loGap; k < loShow; k++) {
                const localA = wrap(startA + ((k - i0) / steps) * total);
                tg[k] = parentTg !== undefined ? wrap(parentTg[k]! + localA) : localA;
              }
            }
          }
        } else if (c.bones.length >= 2) {
          const [b0, b1] = c.bones as [string, string];
          const drawn0 = set.drawn[b0];
          if (drawn0 !== undefined && isRaised(drawn0)) {
            const S0 = rigPoint(rest, b0);
            let headX0 = 0;
            if (gestureHead !== null) {
              const ha0 = rigPoint(rest, gestureHead.points[0]);
              const hb0 = rigPoint(rest, gestureHead.points[1]);
              if (ha0 !== null && hb0 !== null) headX0 = (ha0[0] + hb0[0]) / 2;
            }
            const l0 = S0 !== null && rigPoint(rest, b1) !== null ? Math.hypot(rigPoint(rest, b1)![0] - S0[0], rigPoint(rest, b1)![1] - S0[1]) : 100;
            const outSign: 1 | -1 = (S0?.[0] ?? 0) + l0 * Math.cos(drawn0 / DEG) <= headX0 ? 1 : -1;
            const t0 = targets.get(b0)!;
            const t1 = targets.get(b1)!;
            for (let i = loShow; i <= hiShow; i++) {
              const pair = solveSupportActiveFrame(set, c, i);
              if (pair === null) continue;
              if (i >= s.frames[0] || outSign * wrap(t0[i]! - pair[0]) < 0) t0[i] = pair[0];
              if (i >= s.frames[0] || outSign * wrap(t1[i]! - pair[1]) < 0) t1[i] = pair[1];
            }
            if (loGap <= loShow && loGap >= 1 && loShow + 1 <= hiShow) {
              const i0 = loGap - 1;
              const i1 = loShow + 1;
              const steps = i1 - i0;
              const startLocal = wrap(t1[i0]! - t0[i0]!);
              const endLocal = wrap(t1[i1]! - t0[i1]!);
              const totalLocal = wrap(endLocal - startLocal);
              for (let k = loGap; k <= loShow; k++) {
                const localA = wrap(startLocal + ((k - i0) / steps) * totalLocal);
                t1[k] = wrap(t0[k]! + localA);
              }
            }
          }
        }
      }
    }
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

  // #190 / #205: when the neck-length clamp acts on the sequence, couple the clamped
  // head.translate.y (`clampedY`, the signal the gains were calibrated against) into
  // head.rotate (+NOD_RESIDUAL_HEAD_GAIN °/unit) and pitch_dial.rotate (+NOD_RESIDUAL_PITCH_GAIN °/unit).
  const nodCoupled = headNodReading !== null && headNodReading.residual.some((r) => r !== 0) ? headNodReading.clampedY : null;
  if (headNodReading !== null && nodCoupled !== null) {
    const hb = headNodReading.bone;
    const tg = targets.get(hb);
    if (tg !== undefined) {
      const above = mappedAbove(hb);
      const hc = map.chains.find((c) => c.bones.includes(hb));
      const limits = hc?.range[hb];
      const cov = hc !== undefined ? covered.get(hc.name) : undefined;
      for (let i = 0; i < n; i++) {
        const nodY = nodCoupled[i]!;
        if (nodY === 0) continue;
        let next = wrap(tg[i]! + NOD_RESIDUAL_HEAD_GAIN * nodY);
        if (limits !== undefined && cov?.[i] !== true) {
          const key = wrap((next - restOf.get(hb)!) - (above === null ? 0 : turn(above, i)));
          if (overflow(key, limits) > RANGE_SLACK) {
            next = wrap(next + Math.min(Math.max(key, limits[0]), limits[1]) - key);
          }
        }
        tg[i] = next;
      }
    }
  }

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
  // rig-c/pose#344: the first spine bone's counter — its rotate when it is not the trunk bone, and its translate.
  let anchor: TorsoAnchor | null = null;
  if (anchorOf !== null) {
    const a = anchorOf;
    if (a.bone !== a.trunk) {
      const above = mappedAbove(a.bone);
      let prev = 0;
      const keys: MotionKey[] = [];
      for (let i = 0; i < n; i++) {
        const raw = turn(a.bone, i) - (above === null ? 0 : turn(above, i));
        prev = i === 0 ? wrap(raw) : prev + wrap(raw - prev);
        keys.push({ t: keyTimes[i]!, v: [r3(prev)] });
      }
      tracks.push({ bone: a.bone, property: 'rotate', keys });
    }
    const pr = rest.get(a.pelvis)!;
    const det = pr.a * pr.d - pr.b * pr.c;
    const keys: MotionKey[] = [];
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const held = posedOrigin(a.bone, i);
      anchorRaw = true;
      const free = posedOrigin(a.bone, i);
      anchorRaw = false;
      const wx = held[0] - free[0];
      const wy = held[1] - free[1];
      xs.push(wx);
      // Into the pelvis's turned frame, then through its setup matrix: the translate is in the parent's local axes.
      const r = -turnAbove(a.pelvis, i) / DEG;
      const ux = Math.cos(r) * wx - Math.sin(r) * wy;
      const uy = Math.sin(r) * wx + Math.cos(r) * wy;
      keys.push({ t: keyTimes[i]!, v: [r3((pr.d * ux - pr.b * uy) / det), r3((-pr.c * ux + pr.a * uy) / det)] });
    }
    tracks.push({ bone: a.bone, property: 'translate', keys });
    anchor = { gait: 'walk', bone: a.bone, point: a.point, joint: a.joints[1], x: r3(anchorX!), factor: r6(anchorFactor), neck: r3(Math.max(...anchorPath!) - Math.min(...anchorPath!)), sway: r3(Math.max(...xs) - Math.min(...xs)) };
  }
  let face: FaceReading | null = null;
  if (map.face !== undefined) {
    const rEar = series.get('r_ear') ?? (() => {
      const h = heldOf('r_ear');
      return 'never' in h ? null : h.at;
    })();
    const lEar = series.get('l_ear') ?? (() => {
      const h = heldOf('l_ear');
      return 'never' in h ? null : h.at;
    })();
    face = readFace(map.face, series.get('nose')!, series.get('r_eye')!, series.get('l_eye')!, rEar, lEar, nodCoupled, NOD_RESIDUAL_PITCH_GAIN);
    for (const axis of ['yaw', 'pitch'] as const) {
      const ax = face[axis];
      if (ax === undefined) continue;
      const rest0 = restAngle(rest, ax.bone, 'x');
      const above = mappedAbove(ax.bone);
      targets.set(ax.bone, ax.keys.map((v, i) => wrap(rest0 + (above === null ? 0 : turn(above, i)) + v)));
      tracks.push({ bone: ax.bone, property: 'rotate', keys: ax.keys.map((v, i) => ({ t: keyTimes[i]!, v: [v] })) });
    }
    const fSets = faceYawSets(map.face);
    if (fSets !== undefined) face.sets = selectYawSets(face.read.rawYaw, fSets, keyTimes, opts.switchMin);
  }
  let body: BodyReading | null = null;
  {
    const rSh = heldPt('r_shoulder');
    const lSh = heldPt('l_shoulder');
    if (rSh !== null && lSh !== null) {
      const rHip = heldPt('r_hip');
      const lHip = heldPt('l_hip');
      const neck = heldPt('neck');
      const faceYaw = face !== null ? face.read.rawYaw : (() => {
        const nose = heldPt('nose');
        const rEye = heldPt('r_eye');
        const lEye = heldPt('l_eye');
        if (nose === null || rEye === null || lEye === null) return null;
        return readFaceAngles(nose, rEye, lEye, heldPt('r_ear'), heldPt('l_ear')).yaw;
      })();
      body = readBody(map.body, rSh, lSh, rHip, lHip, neck, !inPlace && n > 25 ? continuousScale : null, faceYaw);
      const bodyAx = body.yaw;
      if (bodyAx !== undefined) {
        const rest0 = restAngle(rest, bodyAx.bone, 'x');
        const above = mappedAbove(bodyAx.bone);
        targets.set(bodyAx.bone, bodyAx.keys.map((v, i) => wrap(rest0 + (above === null ? 0 : turn(above, i)) + v)));
        tracks.push({ bone: bodyAx.bone, property: 'rotate', keys: bodyAx.keys.map((v, i) => ({ t: keyTimes[i]!, v: [v] })) });
      }
      const bSets = bodyYawSets(map.body);
      if (bSets !== undefined) body.sets = selectYawSets(body.read.rawYaw, bSets, keyTimes, opts.switchMin);
    }
  }
  const activeYawSets: YawSetSwitch[] = [...(face?.sets ?? []), ...(body?.sets ?? [])];
  if (activeYawSets.some((s) => s.spans.length > 0)) {
    const known = knownSetsOf(map, rigSets);
    const slotOrder: string[] = [];
    for (const tr of sw.slotTracks) if (!slotOrder.includes(tr.slot)) slotOrder.push(tr.slot);
    for (const s of activeYawSets) {
      const def = known.get(s.set);
      if (def === undefined) continue;
      for (const sl of [...Object.keys(def.slots), ...def.hides]) {
        if (!slotOrder.includes(sl)) slotOrder.push(sl);
      }
    }
    for (const s of activeYawSets) {
      const def = known.get(s.set);
      if (def === undefined) continue;
      const values: Array<[string, string | null]> = [...Object.entries(def.slots), ...def.hides.map((h): [string, null] => [h, null])];
      for (const [sl, v] of values) {
        if (!sw.shown.has(sl)) sw.shown.set(sl, Array.from({ length: n }, () => slots.get(sl)?.setup ?? null));
        const row = sw.shown.get(sl)!;
        for (const [lo, hi] of s.spans) {
          for (let i = lo; i <= hi; i++) row[i] = v;
        }
      }
    }
    const rebuilt: SlotTrack[] = [];
    for (const sl of slotOrder) {
      const row = sw.shown.get(sl);
      if (row === undefined) continue;
      let prev = slots.get(sl)?.setup ?? null;
      const keys: AttachmentKey[] = [];
      row.forEach((v, i) => {
        if (v === prev) return;
        // Half a frame before the frame it shows on, as every discrete key pose writes (`keyAtFrame`, rig-c/pose#334):
        // written on their frames' exact times, 7 of the 10 yaw swaps of the 24 fps head turn in test/retarget.test.ts
        // showed a frame late under the render's clock.
        keys.push({ t: keyAtFrame(keyTimes, i), v });
        prev = v;
      });
      if (keys.length > 0) rebuilt.push({ slot: sl, property: 'attachment', keys });
    }
    sw.slotTracks.splice(0, sw.slotTracks.length, ...rebuilt);
  }
  if (activeYawSets.length > 0) {
    const known = knownSetsOf(map, rigSets);
    const otherSlotKeyers = new Map<string, string[]>();
    const addKeyer = (sl: string, who: string) => {
      const list = otherSlotKeyers.get(sl) ?? [];
      if (!list.includes(who)) list.push(who);
      otherSlotKeyers.set(sl, list);
    };
    for (const aSw of sw.switches) {
      for (const sl of [...Object.keys(aSw.slots), ...aSw.hides]) addKeyer(sl, `set "${aSw.set}"`);
    }
    for (const s of activeYawSets) {
      if (s.spans.length === 0) continue;
      const def = known.get(s.set);
      if (def === undefined) continue;
      for (const sl of [...Object.keys(def.slots), ...def.hides]) addKeyer(sl, `set "${s.set}"`);
    }
    for (const s of activeYawSets) {
      const def = known.get(s.set);
      if (def === undefined) continue;
      for (const h of def.hides) {
        const keyers = (otherSlotKeyers.get(h) ?? []).filter((who) => who !== `set "${s.set}"`);
        if (keyers.length > 0) {
          s.hidesKeyed.push({ slot: h, by: `slot "${h}" attachment (${keyers.join(', ')})` });
        }
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
  if (trunkScaleBone !== null && trunkScale !== null) {
    tracks.push({ bone: trunkScaleBone, property: 'scaley', keys: trunkScale.map((v, i) => ({ t: keyTimes[i]!, v: [r6(v)] })) });
  }
  if (translateTrack !== null) tracks.push(translateTrack);
  if (headNodTrack !== null) tracks.push(headNodTrack);
  tracks.push(...sw.offsetTracks, ...sw.slotTracks);
  const reach = reachReadings(rest, map, tracks, reachAims, t?.bone ?? null);
  const reachOrigin = reachOrigins(rest, map, reachAims, reachGaps, t?.bone ?? null);

  const pivot = pivotOf(rest, t?.bone ?? null, legs);
  const pelvis = pelvisReadingOf(pelvisChain, opts.pelvis, track, fromTrack, tracks);
  if (pelvis !== null && anchor !== null) pelvis.anchor = anchor;
  const scaleFit = t === null || scale === null || origin === null ? null : scaleFitOf({
    joints: t.scale.pose, joint: t.joint, bone: t.bone, lengths: scaleLengths, factor: scale.factor,
    series, good, legLength: feet?.legLength ?? null, legStraight, rigLeg,
    rigHip: legs !== null && 'legs' in legs ? rootsApart(rest, legs.legs.r.chain.bones[0]!, legs.legs.l.chain.bones[0]!) : null,
    origin: origin.at,
  });
  return {
    // #275: timestamps state the cadence, not an fps field. Use the mean interval across the
    // distinct frames, before rounding, so microsecond timestamps do not accumulate rounding error.
    animation: { duration: opts.loop === true && n > 1 ? r6((times[n - 1]! - t0) * n / (n - 1)) : keyTimes[n - 1]!, tracks },
    times: keyTimes, targets, origin, holds, bends, short, endOn, flips, scale, scaleFit,
    switches: sw.switches, switchRuns: sw.runs, switchBinds: switchBinds(map, n), shown: sw.shown, distances: sw.distances, turns, turnsUnread, range, artRange,
    legScale, segments, legStraight, rigLeg, scales, feet, planted: plantOn, stance, floor, blendHold, closure, openDrift, ankles, pivot, raised, byHip, face, body, figureScale, headNod: headNodReading, nodSkipped, reach, reachOrigin, pelvis,
  };
}

/**
 * #275: close the retarget's own tracks after reduction, which fits only the distinct pose frames.
 * A duration alone leaves the last value held; the runtime's duration is its last timeline key.
 * Discrete offsets hold through the last interval, and attachments return to their frame-0 state.
 * A rotate closes to the equivalent first angle nearest its last, preserving an unwrapped turn.
 */
export function closeAnimationLoop(animation: Animation, slots: RigSlots): void {
  for (const tr of animation.tracks) {
    // A singleton has no cadence; a zero-duration or already-closed track needs no duplicate time.
    if (tr.keys.length === 0 || tr.keys.at(-1)!.t >= animation.duration) continue;
    if (tr.property === 'attachment') {
      const first = tr.keys[0]!;
      const v = first.t === 0 ? first.v : slots.get(tr.slot)!.setup;
      if (first.t > 0) tr.keys.unshift({ t: 0, v });
      tr.keys.push({ t: animation.duration, v });
    } else {
      const first = tr.keys[0]!;
      const last = tr.keys.at(-1)!;
      const v = [...first.v];
      if (tr.property === 'rotate') v[0] = r3(v[0]! + 360 * Math.round((last.v[0]! - v[0]!) / 360));
      // Only switch.ts's offset tracks hold every span. A mixed track's earlier hold
      // does not decide the closing interval's interpolation.
      if (tr.property === 'translate' && tr.keys.length > 1 && tr.keys.slice(0, -1).every((k) => k.ease === 'stepped')) last.ease = 'stepped';
      tr.keys.push({ t: animation.duration, v });
    }
  }
}

/** rig-c/pose#288: the pelvis bone's source, from the chain, the track and the keys written. */
function pelvisReadingOf(chain: Chain | null, given: RetargetOptions['pelvis'], track: ReadonlyArray<number | null> | null, fromTrack: string | null, tracks: ReadonlyArray<MotionTrack | SlotTrack>): PelvisReading | null {
  if (chain === null && given === undefined) return null;
  const bone = chain?.bones[0] ?? null;
  const keys = bone === null ? null : tracks.find((tr): tr is MotionTrack => 'bone' in tr && tr.bone === bone && tr.property === 'rotate');
  const vs = keys === null || keys === undefined ? [] : keys.keys.map((k) => k.v[0]!);
  const swing = vs.length === 0 ? null : r3(Math.max(...vs) - Math.min(...vs));
  const n = vs.length;
  const declined: Array<[number, number]> = [];
  (track ?? []).forEach((v, i) => {
    if (v !== null) return;
    const last = declined[declined.length - 1];
    if (last !== undefined && last[1] === i - 1) last[1] = i;
    else declined.push([i, i]);
  });
  const onTrack = fromTrack === null ? 0 : (track ?? []).filter((v) => v !== null).length;
  return {
    source: fromTrack !== null ? given!.source : 'hip line',
    trackSource: given?.source ?? null,
    bone,
    chain: chain?.name ?? null,
    swing,
    track: onTrack,
    hipLine: bone === null ? 0 : n - onTrack,
    declined: given === undefined ? [] : declined,
  };
}

/**
 * The PELVIS line (rig-c/pose#288): where the pelvis bone's rotation came from and
 * its swing — "from <source>, swing N°", or "from hip line (no track)".
 */
export function pelvisLine(r: PelvisReading, frames: number): string {
  const spans = (rs: Array<[number, number]>) => rs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  const where = r.bone === null ? '' : `bone "${r.bone}", chain "${r.chain}"`;
  if (r.bone === null) return `PELVIS: not keyed — the sequence carries a ${r.trackSource} track (${frames - r.declined.reduce((s, [a, b]) => s + b - a + 1, 0)} of ${frames} frames read) and the map has no pelvis chain (one bone, joints r_hip → l_hip); no bone turns with the pelvis`;
  const swing = r.swing === null ? '' : `, swing ${r.swing.toFixed(2)}°`;
  if (r.trackSource === null) return `PELVIS: from hip line (no track)${swing} (${where}; every frame from r_hip → l_hip)${anchorClause(r.anchor)}`;
  if (r.track === 0) return `PELVIS: from hip line (the ${r.trackSource} track read none of the ${frames} frames)${swing} (${where}; every frame from r_hip → l_hip)${anchorClause(r.anchor)}`;
  const rest = r.hipLine === 0 ? `all ${frames} frames from the track` : `${r.track} of ${frames} frames from the track, the hip line on the ${r.hipLine} it declined (frames ${spans(r.declined)})`;
  return `PELVIS: from ${r.source}${swing} (${where}; ${rest})${anchorClause(r.anchor)}`;
}

/** rig-c/pose#344: the PELVIS line's clause for the torso held over the pelvis. */
function anchorClause(a: TorsoAnchor | undefined): string {
  if (a === undefined) return '';
  return `; torso anchored (in-place ${a.gait}): bone "${a.bone}" keyed with the pelvis's counter, "${a.point}" carried on the drawn ${a.joint}'s sideways path about x ${a.x.toFixed(2)} (× ${a.factor.toFixed(4)}, the pelvis's rig ÷ drawn sway; ${a.neck.toFixed(2)} peak to peak, the counter ${a.sway.toFixed(2)}), the pelvis swaying under it`;
}

/** A reach bone's origin within this many world units of the anchor's, with nothing above it moved, is aimed along the pair: no REACH line. */
export const REACH_OFFSET = 1e-6;

/** Round a second-difference figure, °/frame², to 1e-4. */
const r4 = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * #236: for each reach chain, the bones above it the animation moves — a rotate
 * track, or a translate track other than the anchor's (its travel is in the
 * target too) — and, when there are any, its aim's departure from the pair.
 */
function reachReadings(rest: Rest, map: JointMap, tracks: ReadonlyArray<MotionTrack | SlotTrack>, aims: ReadonlyMap<string, { aim: number[]; pair: number[]; length: number }>, anchor: string | null): ReachReading[] {
  const out: ReachReading[] = [];
  if (anchor === null) return out;
  const a0 = rest.get(anchor)!;
  const moved = new Map<string, Set<'rotate' | 'translate'>>();
  for (const tr of tracks) {
    if (!('bone' in tr) || (tr.property !== 'rotate' && tr.property !== 'translate')) continue;
    if (tr.property === 'translate' && tr.bone === anchor) continue;
    const s = moved.get(tr.bone) ?? new Set();
    s.add(tr.property);
    moved.set(tr.bone, s);
  }
  for (const c of map.chains) {
    const got = aims.get(c.name);
    if (!c.reach || got === undefined) continue;
    const b = c.bones[0]!;
    const above: ReachReading['above'] = [];
    for (let a = rest.get(b)?.parent ?? null; a !== null; a = rest.get(a)?.parent ?? null) {
      for (const property of ['rotate', 'translate'] as const) {
        if (moved.get(a)?.has(property) !== true) continue;
        above.push({ bone: a, property, chain: property === 'rotate' ? (map.chains.find((x) => x.bones.includes(a))?.name ?? null) : null });
      }
    }
    const bo = rest.get(b)!;
    const units = Math.hypot(bo.worldX - a0.worldX, bo.worldY - a0.worldY);
    if (above.length === 0 && units <= REACH_OFFSET) continue;
    const dep = got.aim.map((v, i) => wrap(v - got.pair[i]!));
    let frame = 0;
    for (let i = 1; i < dep.length; i++) if (Math.abs(dep[i]!) > Math.abs(dep[frame]!)) frame = i;
    const d2 = meanSecondDiff([dep]).value;
    const aimD2 = meanSecondDiff([got.aim]).value;
    const pairD2 = meanSecondDiff([got.pair]).value;
    out.push({
      chain: c.name,
      bone: b,
      joints: [c.joints[0]!, c.joints[1]!],
      anchor,
      offset: { units: r3(units), ofLength: got.length > 0 ? r3(units / got.length) : 0 },
      above,
      departure: { max: r3(Math.abs(dep[frame] ?? 0)), frame, meanD2: d2 === null ? null : r4(d2) },
      aimD2: aimD2 === null ? null : r4(aimD2),
      pairD2: pairD2 === null ? null : r4(pairD2),
      ratio: aimD2 === null || pairD2 === null || r4(pairD2) === 0 ? null : Number((aimD2 / pairD2).toFixed(3)),
    });
  }
  return out;
}

/**
 * #282: a reach bone whose origin sits more than this fraction of the segment
 * from the source joint is warned. The aim from an origin a fraction f up the
 * pair turns about 1 ÷ (1 − f) times the pair's turn (#236's lever: the example
 * wave's trunk, f = 0.5, measured 2.00×); 0.2 is 1.25×, a quarter more turn
 * than the pose has.
 */
export const REACH_ORIGIN_WARN = 0.2;

/** #282: each reach chain's origin against the anchor's, at setup and as posed, in map order. */
function reachOrigins(rest: Rest, map: JointMap, aims: ReadonlyMap<string, { length: number }>, gaps: ReadonlyMap<string, number[]>, anchor: string | null): ReachOrigin[] {
  const out: ReachOrigin[] = [];
  if (anchor === null) return out;
  const a0 = rest.get(anchor)!;
  for (const c of map.chains) {
    const got = aims.get(c.name);
    const g = gaps.get(c.name);
    if (!c.reach || got === undefined || g === undefined) continue;
    const b = c.bones[0]!;
    const bo = rest.get(b)!;
    const setup = r3(Math.hypot(bo.worldX - a0.worldX, bo.worldY - a0.worldY));
    let frame = 0;
    for (let i = 1; i < g.length; i++) if (g[i]! > g[frame]!) frame = i;
    const max = r3(g[frame] ?? 0);
    const segment = r3(got.length);
    const ofSegment = got.length > 0 ? r3(Math.max(setup, max) / got.length) : 0;
    out.push({ chain: c.name, bone: b, joints: [c.joints[0]!, c.joints[1]!], anchor, setup, posed: { max, frame }, segment, ofSegment, warn: ofSegment > REACH_ORIGIN_WARN, threshold: REACH_ORIGIN_WARN });
  }
  return out;
}

/** #282: the `REACH-ORIGIN` line, one per reach chain. */
export function reachOriginLine(e: ReachOrigin, times: readonly number[]): string {
  return `chain "${e.chain}" bone "${e.bone}" (${e.joints[0]} → ${e.joints[1]}): its origin ${e.setup.toFixed(2)} units from the source joint ${e.joints[0]} (bone "${e.anchor}"'s origin) at setup, up to ${e.posed.max.toFixed(2)} on the frames (frame ${e.posed.frame}, t=${times[e.posed.frame]!.toFixed(3)}s): ${e.ofSegment.toFixed(3)} of the ${e.segment.toFixed(2)}-unit segment`;
}

/** #282: the WARN of a reach chain whose origin sits past REACH_ORIGIN_WARN of the segment. */
export function reachOriginWarn(e: ReachOrigin): string {
  return `REACH_ORIGIN: chain "${e.chain}" bone "${e.bone}" starts ${e.ofSegment.toFixed(3)} of the segment from ${e.joints[0]}, past ${e.threshold.toFixed(2)}: re-aimed from there, it turns more than the pair (JITTER bone "${e.bone}"); "reach": false follows the measured angle`;
}

/** The `REACH` line of a reach chain whose aim departs from its pair (#236). */
export function reachCostLine(e: ReachReading, times: readonly number[]): string {
  const f = (v: number | null) => (v === null ? 'not measured' : `${v.toFixed(4)}°/f²`);
  const why: string[] = [];
  if (e.offset.units > REACH_OFFSET) why.push(`its origin sits ${e.offset.units.toFixed(2)} units from the anchor "${e.anchor}"'s at setup (${e.offset.ofLength.toFixed(3)} of the reached length)`);
  if (e.above.length > 0) why.push(`it hangs below ${e.above.map((x) => `"${x.bone}" (${x.property === 'rotate' ? (x.chain === null ? 'rotate keys' : `turned by chain "${x.chain}"`) : 'translate keys'})`).join(', ')}`);
  const ratio = e.ratio === null ? (e.pairD2 === 0 ? ' — the pair is still' : '') : ` (${e.ratio.toFixed(2)}×)`;
  return `chain "${e.chain}" bone "${e.bone}" (${e.joints[0]} → ${e.joints[1]}) is aimed from its posed origin at the pair's end — ${why.join(', and ')}: the aim departs from the pair's own angle by up to ${e.departure.max.toFixed(3)}° (frame ${e.departure.frame}, t=${times[e.departure.frame]!.toFixed(3)}s), mean |Δ²| of the departure ${f(e.departure.meanD2)}; mean |Δ²| aim ${f(e.aimD2)} against the pair's ${f(e.pairD2)}${ratio} — rotation the pose pair does not have, the cost of "reach"; a reading`;
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

/** The rig's head bone (the bone carrying `r_eye → l_eye` or `l_eye → r_eye` in the map), or null if no chain carries the eye line. */
function headBoneOf(map: JointMap): string | null {
  for (const c of map.chains) {
    for (let k = 0; k + 1 < c.joints.length; k++) {
      const a = c.joints[k]!;
      const b = c.joints[k + 1]!;
      if ((a === 'r_eye' && b === 'l_eye') || (a === 'l_eye' && b === 'r_eye')) {
        return c.bones[k] ?? null;
      }
    }
  }
  return null;
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

/**
 * Hold and interpolate across unconfident spans on a horizontal chain (`isAcross`,
 * e.g. `r_hip → l_hip`, `r_eye → l_eye`, `r_shoulder → l_shoulder`, rig-c/pose#184),
 * in place. A frame is unconfident when its picture length over its median is under
 * `shortCutoff` (with `--short`) or when its angle turns more than `flipThreshold`
 * from the last confident angle or reverses more than 90° from the line's rest
 * direction `restDir` (with `--flip`). Each contiguous unconfident run has its
 * angles interpolated between the confident frames either side (flat at the ends),
 * the short way round, exactly as `holdShort` does on limb chains.
 */
export function holdAcross(
  angles: number[],
  fraction: readonly number[],
  shortCutoff: number | 'off',
  flipThreshold: number | 'off',
  restDir = 0,
): ShortSpan[] {
  const n = angles.length;
  if (n === 0 || (shortCutoff === 'off' && flipThreshold === 'off')) return [];
  const raw = [...angles];
  const unconf = new Array<boolean>(n).fill(false);
  let lastConfident = raw[0]!;
  for (let i = 0; i < n; i++) {
    const s = shortCutoff !== 'off' && fraction[i]! < shortCutoff;
    const rev = Math.abs(wrap(raw[i]! - restDir)) > 90;
    if (!s && !rev) {
      lastConfident = raw[i]!;
      break;
    }
  }
  for (let i = 0; i < n; i++) {
    const isShort = shortCutoff !== 'off' && fraction[i]! < shortCutoff;
    const isFlipped =
      flipThreshold !== 'off' &&
      (Math.abs(wrap(raw[i]! - lastConfident)) > flipThreshold || Math.abs(wrap(raw[i]! - restDir)) > 90);
    if (isShort || isFlipped) {
      unconf[i] = true;
    } else {
      lastConfident = raw[i]!;
    }
  }
  const out: ShortSpan[] = [];
  for (let i = 0; i < n; i++) {
    if (!unconf[i]) continue;
    let j = i;
    while (j + 1 < n && unconf[j + 1]) j++;
    const lo = i - 1;
    const hi = j + 1;
    let minFraction = fraction[i]!;
    for (let k = i + 1; k <= j; k++) minFraction = Math.min(minFraction, fraction[k]!);
    let maxTurn = 0;
    for (let k = Math.max(1, i); k <= Math.min(n - 1, j + 1); k++) {
      const jmp = wrap(raw[k]! - raw[k - 1]!);
      if (Math.abs(jmp) > Math.abs(maxTurn)) maxTurn = jmp;
    }
    if (lo >= 0 || hi < n) {
      const a = lo >= 0 ? angles[lo]! : angles[hi]!;
      const b = hi < n ? angles[hi]! : a;
      const turn = wrap(b - a);
      for (let k = i; k <= j; k++) angles[k] = lo < 0 ? b : wrap(a + (turn * (k - lo)) / (hi - lo));
    }
    const revThreshold = flipThreshold !== 'off' ? flipThreshold : 90;
    out.push({
      frames: [i, j],
      minFraction,
      across: true,
      ...(Math.abs(maxTurn) > revThreshold ? { reversed: r3(maxTurn) } : {}),
    });
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
    const loBound = Math.max(0, segStart - 1);
    const hiBound = Math.min(n - 1, segEnd + 1);
    if (hiBound - loBound >= 2) {
      const u: number[] = new Array<number>(n).fill(0);
      u[loBound] = angles[loBound]!;
      for (let i = loBound + 1; i <= hiBound; i++) u[i] = u[i - 1]! + wrap(angles[i]! - angles[i - 1]!);
      const fits = (lo: number, hi: number) => Math.abs(u[hi]! - u[lo]!) <= stepCap * (hi - lo);
      interface Win { lo: number; hi: number; asked: number }
      const wins: Win[] = [];
      for (let k = loBound + 1; k <= hiBound; k++) {
        if (!(Math.min(fraction[k - 1]!, fraction[k]!) < fractionCutoff)) continue;
        const jump = u[k]! - u[k - 1]!;
        if (Math.abs(jump) <= stepCap) continue;
        let h = 1;
        let lo = Math.max(loBound, k - h - 1);
        let hi = Math.min(hiBound, k + h);
        while (!fits(lo, hi) && (lo > loBound || hi < hiBound)) {
          h++;
          lo = Math.max(loBound, k - h - 1);
          hi = Math.min(hiBound, k + h);
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
          if (fits(w.lo, w.hi) || (w.lo === loBound && w.hi === hiBound)) continue;
          w.lo = Math.max(loBound, w.lo - 1);
          w.hi = Math.min(hiBound, w.hi + 1);
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

export function shortLine(s: Short, times: readonly number[], cutoff: number | 'off'): string {
  const sg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
  if (s.step !== undefined && s.asked !== undefined) {
    return `chain "${s.chain}" bone "${s.bone}" (${s.joints[0]} → ${s.joints[1]}) ${spanOf(s.frames, times)}: picture length down to ${s.minFraction.toFixed(2)} of its median, under ${SHORT_STEP_FRACTION.toFixed(2)}, turned ${sg(s.asked)} in one frame (over ${SHORT_STEP_CAP}°); spread to ${sg(s.step)} per frame`;
  }
  const lo = s.frames[0] - 1;
  const hi = s.frames[1] + 1;
  const held = lo < 0 && hi >= times.length
    ? 'no frame of the pose is at or above it, so nothing was held'
    : lo < 0 ? `held flat at frame ${hi}'s angle (the pose starts short)`
      : hi >= times.length ? `held flat at frame ${lo}'s angle (the pose ends short)`
        : `interpolated from frame ${lo}'s angle to frame ${hi}'s, the short way round`;
  if (s.across === true) {
    const shortWhy = cutoff !== 'off' && s.minFraction < cutoff ? `picture length down to ${s.minFraction.toFixed(2)} of its median, under ${cutoff}` : null;
    const revWhy = s.reversed !== undefined ? `reversed ${sg(s.reversed)} in one frame` : null;
    const why = shortWhy !== null && revWhy !== null ? `${shortWhy}, ${revWhy}` : shortWhy ?? `${revWhy ?? 'reversed'} (picture length down to ${s.minFraction.toFixed(2)} of its median)`;
    return `chain "${s.chain}" bone "${s.bone}" (${s.joints[0]} → ${s.joints[1]}) ${spanOf(s.frames, times)}: ${why}; its direction is not read — ${held}`;
  }
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
      p.add('MAP_BEND_SIDE', `chain "${c.name}" — the hinge at ${joint} is straight at rest (inner angle ${restInner.toFixed(3)}°), so the rest pose does not say which way it bends; state "bend": "ccw", "cw" or "free" — ${bendFreeRemedy(c.name)}`);
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

/**
 * The remedy both bend refusals name (rig-c/pose#238), as the README's map
 * section ("bend") gives it: front-facing material goes "free", a side view
 * keeps a side.
 */
export function bendFreeRemedy(chain: string): string {
  return `seen from the front, the side a hinge's picture falls on is not its limit, so for front-facing material state "bend": "free" on chain "${chain}"; keep a side ("rest", "ccw", "cw") only for a side view, where the picture's side is the joint's own`;
}

/** One hinge's wrong-way frames (#238): what its collapsed line says. */
export interface BendGroup {
  chain: string;
  joint: string;
  side: 1 | -1;
  rest: number;
  /** Every frame it bent the wrong way, in frame order — the per-frame lines. */
  events: BendEvent[];
  /** The event furthest on the wrong side. */
  worst: BendEvent;
  /** Runs of consecutive frames. */
  runs: number;
}

/** The bend events grouped per hinge, in the order the hinges were first met (#238). */
export function bendGroups(events: readonly BendEvent[]): BendGroup[] {
  const out = new Map<string, BendGroup>();
  for (const e of events) {
    const k = `${e.chain}\u0000${e.joint}`;
    const g = out.get(k);
    if (g === undefined) {
      out.set(k, { chain: e.chain, joint: e.joint, side: e.side, rest: e.rest, events: [e], worst: e, runs: 1 });
      continue;
    }
    if (e.frame !== g.events[g.events.length - 1]!.frame + 1) g.runs++;
    g.events.push(e);
    if (-e.side * e.angle > -g.worst.side * g.worst.angle) g.worst = e;
  }
  return [...out.values()];
}

/** One hinge's collapsed line (#238): a refusal names the remedy; a clamp, that every frame was straightened. */
export function bendGroupLine(g: BendGroup, mode: 'refuse' | 'clamp'): string {
  const sense = g.side > 0 ? 'counter-clockwise (+)' : 'clockwise (−)';
  const first = g.events[0]!, last = g.events[g.events.length - 1]!;
  const range = first.frame === last.frame ? `frame ${first.frame} (t=${first.t.toFixed(3)}s)` : `frames ${first.frame}–${last.frame} (t=${first.t.toFixed(3)}–${last.t.toFixed(3)}s)`;
  const head = `chain "${g.chain}" hinge ${g.joint}, ${g.events.length} frame(s) in ${g.runs} run(s), ${range} — worst inner angle ${g.worst.angle.toFixed(1)}° at frame ${g.worst.frame} (t=${g.worst.t.toFixed(3)}s); it bends ${sense} at rest (${g.rest.toFixed(1)}°), so the angle must stay ${g.side > 0 ? '≥' : '≤'} 0`;
  return mode === 'refuse'
    ? `${head}; ${bendFreeRemedy(g.chain)}; a near-straight knee's noise takes --bends clamp or --bend-tolerance <deg> (each frame: --verbose)`
    : `${head} — clamped straight on each (each frame: --verbose; --report's "bends")`;
}

/** Holds grouped per point, one line each span. */
export function holdLine(h: Hold, times: readonly number[]): string {
  const span = h.from === h.to ? `frame ${h.from} (t=${times[h.from]!.toFixed(3)}s)` : `frames ${h.from}–${h.to} (t=${times[h.from]!.toFixed(3)}–${times[h.to]!.toFixed(3)}s)`;
  return `point "${h.point}" ${span}: ${h.why}; held frame ${h.source}'s value`;
}

/**
 * The `NOD` line (rig-c/pose#241): what the eye-line chain did to the head — the keyed range, the window its baseline
 * was read over, whether the neck clamp acted and so coupled the nod into the head's rotate (and the face pitch). Or,
 * when no nod is keyed, why. `pitch`: the map keys a face pitch dial.
 */
export function nodLine(h: HeadNodReading | null, skipped: NodSkipped | null, pitch: boolean): string | null {
  if (h === null) return skipped === null ? null : `none on bone "${skipped.bone}" (chain "${skipped.chain}", r_eye → l_eye): ${skipped.why} — no translate keyed, nothing coupled into its rotate${pitch ? ' or the face pitch' : ''}`;
  const head = `bone "${h.bone}" (chain "${h.chain}", r_eye → l_eye)`;
  if (!h.keyed) return `${head}: the eyes do not move against the neck past the writer's 0.001 units — no translate keyed, nothing coupled`;
  const lo = Math.min(...h.clampedY);
  const hi = Math.max(...h.clampedY);
  const sign = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
  const window = h.window === 'in-place'
    ? 'window none (in-place): the baseline is frame 0, no clamp, nothing coupled'
    : `window ±${h.halfWin} frame(s) (0.5 s) running median, detrended, ${h.window === 'wrapped' ? 'wrapped on the loop' : 'cut at the clip\'s ends'}`;
  const clamped = h.residual.filter((r) => r !== 0).length;
  const clamp = h.window === 'in-place'
    ? ''
    : clamped === 0
      ? `; clamp ±${h.maxNod.toFixed(3)} units (2% of the neck's setup length) never acted, so nothing is coupled`
      : `; clamp ±${h.maxNod.toFixed(3)} units (2% of the neck's setup length) acted on ${clamped} frame(s), so the clamped nod is coupled in phase into bone "${h.bone}"'s rotate (+${NOD_RESIDUAL_HEAD_GAIN}°/unit)${pitch ? ` and the face pitch (+${NOD_RESIDUAL_PITCH_GAIN}°/unit)` : ''} on every frame`;
  return `${head}: translate y ${sign(lo)} … ${sign(hi)} units over ${h.clampedY.length} frame(s); ${window}${clamp}`;
}
