/**
 * Derived depth (rig-c/pose#281): which way each limb segment leans out of the
 * picture, read off its 2D length, and the limbs' front-to-back order from it.
 *
 * A sequence carries x and y only, so nothing downstream can say which limb is
 * nearer the camera. A segment drawn shorter than its rest length is tilted out
 * of the picture plane, and by how much its length says: `ratio` = drawn length
 * ÷ rest length, the rest length being the larger of the two sides' 95th
 * percentile picture lengths of that segment over the clip — the straight length
 * the leg scale reads (`STRAIGHT_PERCENTILE`, #148), per segment. Which way it
 * tilts the length cannot say; the sign comes from the body:
 *
 * | segment   | sense when foreshortened | why |
 * | --------- | ------------------------ | --- |
 * | thigh     | forward                  | a hip flexes forward; it extends back too little to foreshorten past the band |
 * | shin      | back                     | the owner's walk statement (rig-c/pose#336): the lifted foot is behind the supporting leg — a knee folds the shin back |
 * | upper arm | with the opposite leg    | in a gait each arm swings with the opposite leg: forward when the other side's thigh is the more foreshortened of the two, back when its own is; forward (a shoulder flexes forward) when neither thigh is foreshortened |
 * | forearm   | forward                  | an elbow bends toward the back of the body, so the forearm folds forward |
 *
 * The thigh's row is the owner's run statement (rig-c/pose#336): the lifted leg
 * is in front, its knee protruding — a raised thigh brings the knee forward.
 * The table is the same in a walk and a run, so `clean --depth walk|run` writes
 * the same signs for both; the gait it records decides which joint
 * `--draw-order depth` orders the legs by (`src/draworder.ts`): a walk by the
 * ankle (the lifted foot behind), a run by the knee (the lifted knee in front).
 *
 * "Forward" is the trunk's facing: toward the camera (+1) when the figure faces
 * it (its left shoulder and hip drawn right of its right ones), away (−1) when
 * it faces away, and undecided (sign 0) when the trunk is side-on — shoulders
 * and hips drawn less than `SIDE_ON` trunk lengths wide — since forward is then
 * across the picture, not into it. A ratio within `FLAT_BAND` is flat, sign 0,
 * and so is one above it (drawn longer than rest is not a tilt).
 *
 * The layers: each joint's depth is its parent's plus its segment's,
 * sign × rest × √(1 − ratio²) px (rest = drawn ÷ ratio), from the shoulders and
 * hips at 0; a limb's depth is the mean of its middle and end joints'; the limbs
 * are ordered nearest first, equal depths (to 0.01 px) sharing a layer. A limb
 * whose segments are not both named on a frame is not ordered on it.
 *
 * Pure: no clock, no randomness, no disk.
 */
import type { Body18 } from './joints.ts';
import { percentile, STRAIGHT_PERCENTILE } from './legs.ts';
import { DEPTH_SEGMENT_NAMES, DEPTH_SEGMENTS, type DepthGait, type DepthSegment, type DepthSource, type FrameDepth, type Joint, type SegmentDepth } from './pose.ts';

/** A ratio within this band is flat (sign 0): cos 18.2° = 0.95, so a segment within about 18° of the picture plane reads flat. */
export const FLAT_BAND: readonly [number, number] = [0.95, 1.05];
/** The trunk is side-on when its shoulders and hips are drawn, on average, less than this many trunk lengths (neck → mid_hip) wide. */
export const SIDE_ON = 0.1;
/** The limbs `layers` orders, each by its segments from the trunk out. */
export const LIMBS = {
  r_arm: ['r_upper_arm', 'r_forearm'],
  l_arm: ['l_upper_arm', 'l_forearm'],
  r_leg: ['r_thigh', 'r_shin'],
  l_leg: ['l_thigh', 'l_shin'],
} as const satisfies Record<string, readonly [DepthSegment, DepthSegment]>;
export type Limb = keyof typeof LIMBS;
export const LIMB_NAMES = Object.keys(LIMBS) as Limb[];

type Pt = [number, number];
type Joints = Partial<Record<Body18, Joint>>;
const at = (j: Joint | undefined): Pt | null => (j === undefined || j.state === 'missing' || j.at === undefined ? null : j.at);
const kindOf = (s: DepthSegment) => s.slice(2) as 'upper_arm' | 'forearm' | 'thigh' | 'shin';
const other = (s: DepthSegment): DepthSegment => `${s.startsWith('r_') ? 'l' : 'r'}_${s.slice(2)}` as DepthSegment;

/** A segment's drawn length on a frame; null where a joint is not placed. */
function drawn(joints: Joints, s: DepthSegment): number | null {
  const [a, b] = DEPTH_SEGMENTS[s];
  const pa = at(joints[a]);
  const pb = at(joints[b]);
  return pa === null || pb === null ? null : Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
}

/** The trunk's facing on a frame: +1 toward the camera, −1 away, 0 side-on or not placed. */
export function facingOf(joints: Joints): -1 | 0 | 1 {
  const p = (n: Body18) => at(joints[n]);
  const [rs, ls, rh, lh, neck] = [p('r_shoulder'), p('l_shoulder'), p('r_hip'), p('l_hip'), p('neck')];
  if (rs === null || ls === null || rh === null || lh === null || neck === null) return 0;
  const trunk = Math.hypot(neck[0] - (rh[0] + lh[0]) / 2, neck[1] - (rh[1] + lh[1]) / 2);
  if (!(trunk > 0)) return 0;
  const width = (ls[0] - rs[0] + (lh[0] - rh[0])) / 2 / trunk;
  return width > SIDE_ON ? 1 : width < -SIDE_ON ? -1 : 0;
}

export interface DerivedDepth {
  /** Per frame, each segment whose joints are placed. */
  frames: FrameDepth[];
  /** Each segment kind's rest length, px (the larger side's 95th percentile); null where neither side is ever placed. */
  rest: Record<'upper_arm' | 'forearm' | 'thigh' | 'shin', number | null>;
  /** Frames the trunk faced the camera, faced away, and was side-on (or not placed). */
  facing: { toward: number; away: number; side: number };
  /** Segment-frames by sign. */
  signs: { toward: number; away: number; flat: number };
}

/** Each frame's depth, derived from the picture's lengths (the table above; the same for every gait). */
export function deriveDepth(track: readonly Joints[]): DerivedDepth {
  const lengths = new Map(DEPTH_SEGMENT_NAMES.map((s) => [s, track.map((j) => drawn(j, s))]));
  const rest = {} as DerivedDepth['rest'];
  for (const k of ['upper_arm', 'forearm', 'thigh', 'shin'] as const) {
    const sides = (['r', 'l'] as const).map((side) => percentile(lengths.get(`${side}_${k}`)!.filter((v): v is number => v !== null), STRAIGHT_PERCENTILE)).filter((v) => Number.isFinite(v) && v > 0);
    rest[k] = sides.length === 0 ? null : Math.max(...sides);
  }
  const facing = { toward: 0, away: 0, side: 0 };
  const signs = { toward: 0, away: 0, flat: 0 };
  const frames = track.map((joints, i) => {
    const face = facingOf(joints);
    if (face === 1) facing.toward++;
    else if (face === -1) facing.away++;
    else facing.side++;
    const ratio = (s: DepthSegment): number | null => {
      const d = lengths.get(s)![i];
      const r = rest[kindOf(s)];
      return d === null || d === undefined || r === null ? null : d / r;
    };
    const out: FrameDepth = {};
    for (const s of DEPTH_SEGMENT_NAMES) {
      const r = ratio(s);
      if (r === null) continue;
      let sense: -1 | 1;
      const kind = kindOf(s);
      if (kind === 'shin') sense = -1;
      else if (kind === 'upper_arm') {
        // The arm swings with the opposite leg: its own thigh and the other side's, by how foreshortened each is.
        const own = ratio(`${s.slice(0, 2)}thigh` as DepthSegment);
        const opp = ratio(other(`${s.slice(0, 2)}thigh` as DepthSegment));
        sense = own === null || opp === null || Math.min(own, opp) >= FLAT_BAND[0] || own === opp ? 1 : opp < own ? 1 : -1;
      } else sense = 1;
      const sign = (r < FLAT_BAND[0] ? face * sense : 0) as -1 | 0 | 1;
      if (sign === 1) signs.toward++;
      else if (sign === -1) signs.away++;
      else signs.flat++;
      out[s] = { ratio: r, sign: sign === 0 ? 0 : sign, source: 'derived' };
    }
    return out;
  });
  return { frames, rest, facing, signs };
}

/** One frame's layers: the limbs nearest first, equal depths sharing a layer, and each limb's depth (px, + toward the camera). */
export interface FrameLayers {
  order: Limb[][];
  depth: Partial<Record<Limb, number>>;
}

/** The depth one segment adds to its distal joint over its proximal one, px: sign × rest × √(1 − ratio²). */
export function segmentDepth(d: SegmentDepth, length: number): number {
  if (d.sign === 0 || !(d.ratio > 0)) return 0;
  const r = Math.min(d.ratio, 1);
  return d.sign * (length / d.ratio) * Math.sqrt(1 - r * r);
}

/**
 * A limb's two joint depths on one frame, px (+ toward the camera): its middle joint (the upper segment's) and its end
 * joint (the middle's plus the lower segment's), from the shoulder or hip at 0, unrounded; null where its segments are
 * not both named and placed.
 */
export function limbJointDepths(joints: Joints, depth: FrameDepth, limb: Limb): { mid: number; end: number } | null {
  const [upper, lower] = LIMBS[limb];
  const du = depth[upper];
  const dl = depth[lower];
  const lu = drawn(joints, upper);
  const ll = drawn(joints, lower);
  if (du === undefined || dl === undefined || lu === null || ll === null) return null;
  const mid = segmentDepth(du, lu);
  return { mid, end: mid + segmentDepth(dl, ll) };
}

/** The limbs' front-to-back order on one frame, from its depth and its joints' drawn lengths. */
export function layersOf(joints: Joints, depth: FrameDepth): FrameLayers {
  const z: Partial<Record<Limb, number>> = {};
  for (const limb of LIMB_NAMES) {
    const j = limbJointDepths(joints, depth, limb);
    if (j === null) continue;
    z[limb] = Math.round(((j.mid + j.end) / 2) * 100) / 100;
  }
  const placed = LIMB_NAMES.filter((l) => z[l] !== undefined).sort((a, b) => z[b]! - z[a]! || LIMB_NAMES.indexOf(a) - LIMB_NAMES.indexOf(b));
  const order: Limb[][] = [];
  for (const l of placed) {
    const last = order[order.length - 1];
    if (last !== undefined && z[last[0]!] === z[l]) last.push(l);
    else order.push([l]);
  }
  return { order, depth: z };
}

/** A frame's layers as text: "r_arm > l_arm = r_leg > l_leg". */
export const orderText = (order: Limb[][]): string => order.map((g) => g.join(' = ')).join(' > ');

/** The source a sequence's depth came from, or null when its frames carry none. */
export function depthSourceOf(frames: ReadonlyArray<{ depth?: FrameDepth }>): DepthSource | null {
  for (const f of frames) for (const d of Object.values(f.depth ?? {})) return d.source;
  return null;
}

/**
 * retarget's DEPTH line (rig-c/pose#281): where the depth came from, on how many
 * frames the limbs were ordered, and which limb was in front alone how often.
 */
export function depthLine(layers: readonly FrameLayers[], frames: ReadonlyArray<{ depth?: FrameDepth }>, gait: DepthGait | null): string {
  const source = depthSourceOf(frames);
  const from = source === null ? 'the sequence\'s depth (no segment named)' : source === 'derived' ? `the sequence's derived depth (clean --depth ${gait ?? '?'})` : 'the sequence\'s measured depth';
  const ordered = layers.filter((l) => l.order.length > 0).length;
  const front = LIMB_NAMES.map((limb) => `${limb} ${layers.filter((l) => l.order[0]?.length === 1 && l.order[0][0] === limb).length}`).join(', ');
  const tied = layers.filter((l) => (l.order[0]?.length ?? 0) > 1).length;
  return `DEPTH  layers from ${from}: the limbs ordered front to back on ${ordered} of ${layers.length} frame(s); in front alone: ${front}; tied in front on ${tied} (the report's layers)`;
}
