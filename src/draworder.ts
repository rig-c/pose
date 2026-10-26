/**
 * Draw order from depth (rig-c/pose#304): `retarget --draw-order depth` keys
 * rig-c's `drawOrder` timeline from the limbs' derived depth (`layers`, #281),
 * so the limb that reads farther from the camera is drawn behind the nearer one
 * on that frame.
 *
 * - **The format.** rig-c's motion spec carries one `drawOrder` timeline per
 *   animation, beside `tracks`: keys of `{ t, offsets? }`, each offset
 *   `{ slot, offset }` = how many places later than its SETUP index the slot is
 *   drawn, every key a complete statement against the setup order, and a key
 *   with no `offsets` the setup order again. Keys are stepped.
 * - **The pairs.** The legs (`r_leg`, `l_leg`); each forearm against the trunk
 *   is keyed from the rig's limb layout (`layout.ts`, rig-c/pose#346). A limb
 *   is the map's chains naming its middle or end joint (knee, ankle), their
 *   bones and every bone under them no other chain maps;
 *   its slots are the slots on those bones, and an alternate set's slot on none
 *   of them goes with the limb whose chain the set depicts, when it depicts one
 *   of the two (a set keeps its own switch and takes the order of the limb it
 *   replaces). A pair's slots are partitioned into maximal contiguous runs of
 *   the setup order (rig-c/pose#424): when every contiguous run carries slots of
 *   both limbs, each run is swapped in place without touching any non-pair slot
 *   drawn between runs. When a contiguous run carries only one limb's slots, a
 *   swap would cross the non-pair slots between the runs — that is changing the
 *   setup order, not keying the pair — so the pair is not keyed and the line
 *   counts the slots between them first, then names them as far as the line's
 *   cap allows (#324; the report's `why` and `between` carry every one).
 * - **The gap (#324).** Per pair, keyed or not, the leg depth gap |depth a −
 *   depth b| over the frames both limbs read — its median and max, in px and as
 *   a fraction of the leg (upper + lower rest length of the limb the tie is read
 *   from) — against the tie, and the frames that passed it: the `DRAWGAP` line
 *   and the report's `drawOrder.gaps`.
 * - **The rule.** On each frame the limb whose depth is the lower (farther from
 *   the camera) is drawn behind: in each contiguous run of the pair, its slots
 *   first in their setup order, then the other's — when the two depths differ by
 *   at least #281's tie: the depth a limb can hold while both its segments read
 *   flat, √(1 − 0.95²) × (upper + lower ÷ 2) of its rest lengths, the smaller
 *   limb's of the two (a flat segment carries no depth, so closer than that the
 *   band cannot tell them). A frame inside the tie, or where either limb is not
 *   ordered, holds the order before; before the first decided frame, the setup
 *   order — or, on a looped sequence, the order the clip ends in, held across
 *   the seam. A key is written where the order changes, and none while it is the
 *   setup order from the start. Its time is half a frame before the frame it
 *   shows on (0 on frame 0), the rule the switches' attachment keys follow
 *   (`keyAtFrame` in `switch.ts`): a key exactly on a frame time is a tie the
 *   render breaks a frame late about half the time (rig-c/pose#325).
 * - **By the joint the gait names** (rig-c/pose#336, rig-c/pose#424, the owner's
 *   two statements). On a sequence cleaned with `--depth walk` the pair is
 *   ordered by each leg's ankle depth under the walk rule (#424): when a leg's
 *   shin folds back (`dl.sign !== 0`), both segments fold in the shin's sense
 *   (`dl.sign × (|thigh| + |shin|)`), and when the thigh sits inside the flat
 *   band (`du.sign === 0`) while the whole leg's foreshortening ratio is under
 *   `WALK_FLAT_THIGH_LEG_RATIO` (`0.94`), the thigh's geometric tilt folds in
 *   the shin's sense as well (0 when the shin reads flat) — in a walk the lifted
 *   foot is behind the supporting leg; with `--depth run` by the knee depth (the
 *   thigh's: its middle) — in a run the lifted leg is in front, its knee
 *   protruding. The limb mean cannot say either: a lifted leg's thigh forward
 *   and shin back cancel in it, and a walk's flat thigh leaves it at most half a
 *   shin (35 px on the fixtures), under the limb tie. The tie is scaled to the
 *   joint, what a flat chain can hold there: √(1 − 0.95²) × thigh at the knee,
 *   × (thigh + shin) at the ankle, the smaller leg's. Measured depth names no
 *   gait and keeps the limb mean and its tie (#304).
 *
 * Pure: no clock, no randomness, no disk.
 */
import type { Body18 } from './joints.ts';
import { FLAT_BAND, LIMBS, limbJointDepths, segmentDepth, type FrameLayers, type Limb } from './depth.ts';
import { knownSetsOf, type JointMap, type Rest, type RigSets } from './map.ts';
import { DEPTH_SEGMENTS, type DepthGait, type DepthSegment, type FrameDepth, type Joint } from './pose.ts';
import { keyAtFrame } from './switch.ts';

/** The limb pairs `--draw-order depth` keys. */
export const DRAW_ORDER_PAIRS: ReadonlyArray<readonly [Limb, Limb]> = [['r_leg', 'l_leg']];
/** What one segment inside the flat band can hide out of the picture, per unit of its rest length: √(1 − 0.95²). */
export const TIE_PER_LENGTH = Math.sqrt(1 - FLAT_BAND[0] * FLAT_BAND[0]);
/** The joint a gait's legs are ordered by (rig-c/pose#336): a walk's lifted foot is behind, a run's lifted knee in front. */
export const ORDER_JOINT: Record<DepthGait, LegJoint> = { walk: 'ankle', run: 'knee' };
export type LegJoint = 'knee' | 'ankle';
/** The DRAWORDER line's cap, characters (the span list is cut to it; the report carries every span). */
export const DRAW_ORDER_LINE_MAX = 260;
/**
 * Whole-leg foreshortening ceiling below which a flat-band walk thigh (`du.sign === 0`) adds its geometric tilt
 * to the shin's backward fold (rig-c/pose#424): `FLAT_BAND[0] - 0.01 = 0.94`. On #348's 38-frame walk stride,
 * the lifted left-step swing peak on frames 8–10 has `l_thigh` just inside the flat band (`0.951–0.960`) with
 * whole-leg ratio `0.9303–0.9388 < 0.94`, while near-level stance frames 7 (`r_ank_y − l_ank_y = +2.7 px`,
 * `legRatio = 0.9423`) and 17 (`−2.7 px`, `legRatio = 0.9478`) stay above `0.94`; at `0.95` (`FLAT_BAND[0]`),
 * frames 7 (`96.71 px`) and 17 (`89.00 px`) cross the `87.27 px` ankle tie and flip 60 of 380 frames (`f=7, 17–21`
 * per cycle) against the gait phase (`320/380` phase frames and `290/300` lifted frames instead of `380/380` and `300/300`).
 */
export const WALK_FLAT_THIGH_LEG_RATIO = 0.94;

export interface DrawOrderOffset {
  slot: string;
  offset: number;
}
/** One key as written into the animation (`t` half a frame before the frame it shows on, 0 on frame 0: rig-c/pose#325). */
export interface DrawOrderKey {
  t: number;
  offsets?: DrawOrderOffset[];
}
export interface DrawOrderPair {
  /** The map chain names standing for the two limbs (the first chain of each). */
  a: string;
  b: string;
  limbs: [Limb, Limb];
  /** Each limb's slots, in setup order. */
  slots: { a: string[]; b: string[] };
  keyed: boolean;
  /** #281's tie for the pair, px: depths closer than this hold the order before (null where a rest length is unread: no tie, equal depths only). */
  tie: number | null;
  /** #336: the joint the pair is ordered by, from the gait clean recorded (the tie then the joint's); absent, the limb mean (#304). */
  by?: LegJoint;
  /** Why the pair is not keyed. */
  why?: string;
  /** The slots of anything else drawn between the pair's slots, in setup order (#324: the line counts them first and cuts this list). */
  between?: string[];
}
/** One pair's leg depth gap against its tie (#324): the figures that say why a pair keyed little or nothing. */
export interface DrawOrderGap {
  a: string;
  b: string;
  /** |depth a − depth b| over the frames both limbs read, px: the median and the largest (at the pair's joint, when it has one). */
  median: number | null;
  max: number | null;
  /** The same as a fraction of the leg (upper + lower rest length of the limb the tie is read from); null where a rest length is unread. */
  medianLegs: number | null;
  maxLegs: number | null;
  /** The pair's tie, px and as a fraction of the leg. */
  tie: number | null;
  tieLegs: number | null;
  /** Frames whose gap passed the tie (decided an order), of the frames both limbs read. */
  passed: number;
  frames: number;
}
export interface DrawOrderSpan {
  /** The chain drawn behind, and the one in front. */
  behind: string;
  front: string;
  frames: [number, number];
  /** False where the setup order already draws it so (no key needed). */
  keyed: boolean;
}
export interface DrawOrderReading {
  pairs: DrawOrderPair[];
  /** The `drawOrder` timeline as written, with the frame each key first shows on. */
  keys: Array<DrawOrderKey & { frame: number }>;
  /** Every span of one decided order, setup or keyed, in frame order per pair. */
  spans: DrawOrderSpan[];
  /** Per pair, the leg depth gap against the tie (#324); keyed or not. */
  gaps?: DrawOrderGap[];
}

interface Resolved {
  pair: DrawOrderPair;
  /** Setup index of every slot of the pair's run. */
  lo: number;
  hi: number;
  /** Offsets with `a` behind, and with `b` behind; empty = the setup order. */
  aBehind: DrawOrderOffset[];
  bBehind: DrawOrderOffset[];
}

/** The joints of a limb that name its chains: the middle and the end. */
function limbJoints(limb: Limb): string[] {
  const [upper, lower] = LIMBS[limb];
  return [DEPTH_SEGMENTS[upper][1], DEPTH_SEGMENTS[lower][1]];
}

/** The pair's run with `behind`'s slots first: each moved slot's offset from its setup index. */
function arrangement(order: readonly string[], lo: number, behind: readonly string[], front: readonly string[]): DrawOrderOffset[] {
  const placed = [...behind, ...front];
  const out: DrawOrderOffset[] = [];
  placed.forEach((slot, k) => {
    const offset = lo + k - order.indexOf(slot);
    if (offset !== 0) out.push({ slot, offset });
  });
  return out.sort((x, y) => order.indexOf(x.slot) - order.indexOf(y.slot));
}

function resolvePair(pairLimbs: readonly [Limb, Limb], map: JointMap, rest: Rest, order: ReadonlyArray<{ name: string; bone: string }>, sets: RigSets | undefined): Resolved {
  const names = order.map((s) => s.name);
  const chainsOf = (limb: Limb) => map.chains.filter((c) => limbJoints(limb).some((j) => (c.joints as readonly string[]).includes(j)));
  const mapped = new Map(map.chains.flatMap((c) => c.bones.map((b) => [b, c.name] as const)));
  const [ca, cb] = [chainsOf(pairLimbs[0]), chainsOf(pairLimbs[1])];
  const pair: DrawOrderPair = { a: ca[0]?.name ?? pairLimbs[0], b: cb[0]?.name ?? pairLimbs[1], limbs: [pairLimbs[0], pairLimbs[1]], slots: { a: [], b: [] }, keyed: false, tie: null };
  const none = (why: string): Resolved => ({ pair: { ...pair, why }, lo: 0, hi: -1, aBehind: [], bBehind: [] });
  for (const [limb, cs] of [[pairLimbs[0], ca], [pairLimbs[1], cb]] as const) {
    if (cs.length === 0) return none(`no chain of the map names ${limbJoints(limb).join(' or ')} (the ${limb.replace('_', ' ')})`);
  }
  // The limb's bones: its chains' and every bone under them that no other chain maps.
  const bonesOf = (cs: typeof ca): Set<string> => {
    const own = new Set(cs.flatMap((c) => c.bones));
    const chainNames = new Set(cs.map((c) => c.name));
    const out = new Set(own);
    for (const [b] of rest) {
      if (out.has(b)) continue;
      const m = mapped.get(b);
      if (m !== undefined && !chainNames.has(m)) continue;
      for (let p = rest.get(b)?.parent ?? null; p !== null; p = rest.get(p)?.parent ?? null) {
        if (own.has(p)) {
          out.add(b);
          break;
        }
        const pm = mapped.get(p);
        if (pm !== undefined && !chainNames.has(pm)) break;
      }
    }
    return out;
  };
  const [ba, bb] = [bonesOf(ca), bonesOf(cb)];
  const slotsA = new Set(order.filter((s) => ba.has(s.bone)).map((s) => s.name));
  const slotsB = new Set(order.filter((s) => bb.has(s.bone)).map((s) => s.name));
  // An alternate set's slot on neither limb's bones goes with the limb whose chain the set depicts (one of the two).
  const known = knownSetsOf(map, sets);
  const [na, nb] = [new Set(ca.map((c) => c.name)), new Set(cb.map((c) => c.name))];
  for (const alt of map.alternates) {
    const depictsA = alt.chains.some((c) => na.has(c));
    const depictsB = alt.chains.some((c) => nb.has(c));
    if (depictsA === depictsB) continue;
    for (const slot of Object.keys(known.get(alt.name)?.slots ?? alt.slots)) {
      if (!names.includes(slot) || slotsA.has(slot) || slotsB.has(slot)) continue;
      (depictsA ? slotsA : slotsB).add(slot);
    }
  }
  const a = names.filter((n) => slotsA.has(n));
  const b = names.filter((n) => slotsB.has(n));
  pair.slots = { a, b };
  if (a.length === 0 || b.length === 0) return none(`${a.length === 0 ? pair.a : pair.b} has no slot (no slot on its bones or on a set depicting it)`);
  const idx = [...a, ...b].map((n) => names.indexOf(n)).sort((x, y) => x - y);
  const lo = idx[0]!;
  const hi = idx[idx.length - 1]!;
  // Partition (a ∪ b) into maximal contiguous setup-order runs (rig-c/pose#424):
  // when every contiguous run carries both limbs' slots, each run swaps in place without touching non-leg slots between runs.
  const runs: Array<[number, number]> = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last !== undefined && i === last[1] + 1) last[1] = i;
    else runs.push([i, i]);
  }
  const ras = runs.map(([rLo, rHi]) => names.slice(rLo, rHi + 1).filter((n) => slotsA.has(n)));
  const rbs = runs.map(([rLo, rHi]) => names.slice(rLo, rHi + 1).filter((n) => slotsB.has(n)));
  const between = names.slice(lo, hi + 1).filter((n) => !slotsA.has(n) && !slotsB.has(n));
  if (runs.some((_, m) => ras[m]!.length === 0 || rbs[m]!.length === 0)) {
    return { ...none(betweenWhy(between, between.length)), pair: { ...pair, why: betweenWhy(between, between.length), between } };
  }
  const arrangeRuns = (first: readonly string[][], second: readonly string[][]): DrawOrderOffset[] =>
    runs
      .flatMap(([rLo], m) => arrangement(names, rLo, first[m]!, second[m]!))
      .sort((x, y) => names.indexOf(x.slot) - names.indexOf(y.slot));
  return { pair: { ...pair, keyed: true }, lo, hi, aBehind: arrangeRuns(ras, rbs), bBehind: arrangeRuns(rbs, ras) };
}

/** The not-keyed reason for slots drawn between the pair: the count first, then the first `shown` of the list (#324). */
function betweenWhy(between: readonly string[], shown: number): string {
  const tail = 'the setup order is not changed here';
  if (between.length === 1) return shown > 0 ? `1 slot: "${between[0]}" is drawn between them, and a swap would re-layer it (${tail})` : `1 slot is drawn between them (… +1 more), and a swap would re-layer it (${tail})`;
  const more = between.length - shown;
  const list = `${between.slice(0, shown).map((n) => `"${n}"`).join(', ')}${more > 0 ? `${shown > 0 ? ', ' : ''}… +${more} more` : ''}`;
  return `${between.length} slots are drawn between them (${list}), and a swap would re-layer them (${tail})`;
}

type Joints = Partial<Record<Body18, Joint>>;

/** A segment's rest length as the depth states it (drawn ÷ ratio), the median over the frames that name it; null where none does. */
function restOf(track: readonly Joints[], depth: ReadonlyArray<FrameDepth | undefined>, s: DepthSegment): number | null {
  const [p, q] = DEPTH_SEGMENTS[s];
  const vals: number[] = [];
  track.forEach((j, i) => {
    const d = depth[i]?.[s];
    const a = j[p];
    const b = j[q];
    if (d === undefined || !(d.ratio > 0) || a?.at === undefined || b?.at === undefined || a.state === 'missing' || b.state === 'missing') return;
    vals.push(Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]) / d.ratio);
  });
  if (vals.length === 0) return null;
  vals.sort((x, y) => x - y);
  const m = vals.length >> 1;
  return vals.length % 2 === 1 ? vals[m]! : (vals[m - 1]! + vals[m]!) / 2;
}

/**
 * #281's tie for two limbs, px: √(1 − 0.95²) × (upper + lower ÷ 2), the smaller limb's; null where a rest length is unread.
 * By a joint (#336): √(1 − 0.95²) × upper at the knee, × (upper + lower) at the ankle — what a flat chain can hold there.
 * `leg` is that limb's upper + lower rest length (#324's unit for the gap).
 */
function tieOf(track: readonly Joints[], depth: ReadonlyArray<FrameDepth | undefined>, limbs: readonly [Limb, Limb], by: LegJoint | undefined): { tie: number | null; leg: number | null } {
  const rests = limbs.map((l) => {
    const [u, w] = LIMBS[l].map((s) => restOf(track, depth, s));
    // The knee's tie needs the upper segment alone (#336: a leg whose ankle is never placed still orders at the knee).
    if (by === 'knee') return u === null || u === undefined ? null : { hidden: u, leg: w === null || w === undefined ? null : u + w };
    return u === null || u === undefined || w === null || w === undefined ? null : { hidden: by === 'ankle' ? u + w : u + w / 2, leg: u + w };
  });
  if (rests[0] == null || rests[1] == null) return { tie: null, leg: null };
  const r = rests[1].hidden < rests[0].hidden ? rests[1] : rests[0];
  return { tie: Math.round(TIE_PER_LENGTH * r.hidden * 100) / 100, leg: r.leg };
}

const round = (x: number, k: number): number => Math.round(x * 10 ** k) / 10 ** k;

/**
 * A walk leg's ankle depth on one frame, px (+ toward the camera), unrounded (rig-c/pose#424):
 * in a walk, the lifted foot goes behind the supporting leg (#336), so both segments of a leg
 * whose shin folds back contribute in the shin's sense rather than the thigh's run-rule forward sense.
 * When the thigh sits inside the flat band while the leg as a whole is foreshortened below
 * `WALK_FLAT_THIGH_LEG_RATIO` (`0.94`), its geometric tilt folds with the shin as well.
 */
function walkAnkleDepth(joints: Joints, depth: FrameDepth, limb: Limb): number | null {
  const [upper, lower] = LIMBS[limb];
  const du = depth[upper];
  const dl = depth[lower];
  const [up, uq] = DEPTH_SEGMENTS[upper];
  const [lp, lq] = DEPTH_SEGMENTS[lower];
  const [ua, ub, la, lb] = [joints[up], joints[uq], joints[lp], joints[lq]];
  if (du === undefined || dl === undefined || !(du.ratio > 0) || !(dl.ratio > 0)) return null;
  if (ua?.at === undefined || ub?.at === undefined || la?.at === undefined || lb?.at === undefined) return null;
  if (ua.state === 'missing' || ub.state === 'missing' || la.state === 'missing' || lb.state === 'missing') return null;
  if (dl.sign === 0) return 0;
  const lu = Math.hypot(ub.at[0] - ua.at[0], ub.at[1] - ua.at[1]);
  const ll = Math.hypot(lb.at[0] - la.at[0], lb.at[1] - la.at[1]);
  const legRatio = (lu + ll) / (lu / du.ratio + ll / dl.ratio);
  const r = Math.min(du.ratio, 1);
  const th = du.sign !== 0 ? Math.abs(segmentDepth(du, lu)) : legRatio < WALK_FLAT_THIGH_LEG_RATIO ? (lu / du.ratio) * Math.sqrt(Math.max(0, 1 - r * r)) : 0;
  return dl.sign * (th + Math.abs(segmentDepth(dl, ll)));
}

/** One pair's leg depth gap against its tie over the frames (the rule's own test: unequal and at least the tie). */
function gapOf(pair: DrawOrderPair, zs: ReadonlyArray<Partial<Record<Limb, number>>>, leg: number | null): DrawOrderGap {
  const tie = pair.tie ?? 0;
  const gaps: number[] = [];
  let passed = 0;
  for (const z of zs) {
    const za = z[pair.limbs[0]];
    const zb = z[pair.limbs[1]];
    if (za === undefined || zb === undefined) continue;
    gaps.push(Math.abs(za - zb));
    if (za !== zb && Math.abs(za - zb) >= tie) passed++;
  }
  gaps.sort((x, y) => x - y);
  const m = gaps.length >> 1;
  const median = gaps.length === 0 ? null : gaps.length % 2 === 1 ? gaps[m]! : (gaps[m - 1]! + gaps[m]!) / 2;
  const max = gaps.length === 0 ? null : gaps[gaps.length - 1]!;
  const legs = (x: number | null): number | null => (x === null || leg === null || !(leg > 0) ? null : round(x / leg, 3));
  return { a: pair.a, b: pair.b, median: median === null ? null : round(median, 2), max: max === null ? null : round(max, 2), medianLegs: legs(median), maxLegs: legs(max), tie: pair.tie, tieLegs: legs(pair.tie), passed, frames: gaps.length };
}

/**
 * The draw-order keys from the frames' layers. `track` and `depth` are the sequence's
 * joints and depth per frame (the rest lengths the tie reads); `order` is the rig's
 * setup draw order (the compiled model's slots); `times` the frames' times. `gait` is
 * the gait clean recorded for its derived depth: a walk orders by the ankle, a run by
 * the knee (#336); none (measured depth) by the limb mean (#304).
 */
export function drawOrderFromDepth(layers: readonly FrameLayers[], track: readonly Joints[], depth: ReadonlyArray<FrameDepth | undefined>, times: readonly number[], map: JointMap, rest: Rest, order: ReadonlyArray<{ name: string; bone: string }>, sets?: RigSets, loop = false, gait: DepthGait | null = null): DrawOrderReading {
  const by = gait === null ? undefined : ORDER_JOINT[gait];
  const resolved = DRAW_ORDER_PAIRS.map((p) => resolvePair(p, map, rest, order, sets));
  const legs = resolved.map((r) => {
    const t = tieOf(track, depth, r.pair.limbs, by);
    r.pair.tie = t.tie;
    if (by !== undefined) r.pair.by = by;
    return t.leg;
  });
  // #336: per frame, each limb's depth at the gait's joint (rounded as the layers are); without a gait, the layers' limb means.
  const zs: ReadonlyArray<Partial<Record<Limb, number>>> =
    by === undefined
      ? layers.map((l) => l.depth)
      : track.map((j, i) => {
          const z: Partial<Record<Limb, number>> = {};
          for (const limb of new Set(DRAW_ORDER_PAIRS.flat())) {
            const v =
              depth[i] === undefined
                ? null
                : by === 'knee'
                  ? (limbJointDepths(j, depth[i]!, limb)?.mid ?? null)
                  : walkAnkleDepth(j, depth[i]!, limb);
            if (v !== null) z[limb] = Math.round(v * 100) / 100;
          }
          return z;
        });
  const names = order.map((s) => s.name);
  // Per pair, per frame: who is behind ('a' | 'b'), or null for the setup order before any decision.
  const states = resolved.map((r) => {
    const tie = r.pair.tie ?? 0;
    const pass = (start: 'a' | 'b' | null): Array<'a' | 'b' | null> => {
      let state = start;
      return zs.map((z) => {
        if (!r.pair.keyed) return null;
        const za = z[r.pair.limbs[0]];
        const zb = z[r.pair.limbs[1]];
        if (za !== undefined && zb !== undefined && za !== zb && Math.abs(za - zb) >= tie) state = za < zb ? 'a' : 'b';
        return state;
      });
    };
    const first = pass(null);
    // A loop's first frames continue its last: a tie at the start holds the order the clip ends in.
    return loop && first.length > 0 ? pass(first[first.length - 1]!) : first;
  });
  const offsetsAt = (f: number): DrawOrderOffset[] =>
    resolved
      .flatMap((r, k) => {
        const s = states[k]![f];
        return s === null || s === undefined ? [] : s === 'a' ? r.aBehind : r.bBehind;
      })
      .sort((x, y) => names.indexOf(x.slot) - names.indexOf(y.slot));
  const keys: DrawOrderReading['keys'] = [];
  let last = '[]';
  for (let f = 0; f < zs.length; f++) {
    const offs = offsetsAt(f);
    const text = JSON.stringify(offs);
    if (text === last) continue;
    last = text;
    // Half a frame before the frame it shows on, as the switches' keys (`keyAtFrame`, rig-c/pose#325).
    const t = keyAtFrame(times, f);
    keys.push(offs.length === 0 ? { frame: f, t } : { frame: f, t, offsets: offs });
  }
  const spans: DrawOrderSpan[] = [];
  resolved.forEach((r, k) => {
    const st = states[k]!;
    st.forEach((s, f) => {
      if (s === null) return;
      if (f > 0 && st[f - 1] === s) spans[spans.length - 1]!.frames[1] = f;
      else spans.push({ behind: s === 'a' ? r.pair.a : r.pair.b, front: s === 'a' ? r.pair.b : r.pair.a, frames: [f, f], keyed: (s === 'a' ? r.aBehind : r.bBehind).length > 0 });
    });
  });
  return { pairs: resolved.map((r) => r.pair), keys, spans, gaps: resolved.map((r, k) => gapOf(r.pair, zs, legs[k]!)) };
}

/** The animation's `drawOrder` value: the keys without their frames. */
export const drawOrderKeys = (d: DrawOrderReading): DrawOrderKey[] => d.keys.map(({ frame: _frame, ...k }) => k);

/** Frame runs as text: "3–12". */
const span = (f: [number, number]): string => (f[0] === f[1] ? `${f[0]}` : `${f[0]}–${f[1]}`);

/**
 * The DRAWORDER lines (rig-c/pose#304): the keys and the spans they key, per
 * "behind" relation, cut to `DRAW_ORDER_LINE_MAX` characters; then one line per
 * pair not keyed, saying why.
 */
export function drawOrderLines(d: DrawOrderReading, prefix = 'DRAWORDER '): string[] {
  const keyed = d.spans.filter((s) => s.keyed);
  // #336: a keyed pair ordered by a joint names it and its joint-scaled tie.
  const joint = d.pairs.find((p) => p.by !== undefined && p.keyed);
  const head = `${prefix}from depth${joint === undefined ? '' : ` by the ${joint.by} (${joint.by === 'ankle' ? 'walk' : 'run'}; tie ${joint.tie === null ? 'none' : `${joint.tie} px`})`}, ${d.keys.length} key(s) over ${keyed.length} span(s)`;
  const groups = new Map<string, string[]>();
  for (const s of keyed) {
    const g = `${s.behind} behind ${s.front}`;
    groups.set(g, [...(groups.get(g) ?? []), span(s.frames)]);
  }
  // The spans as text, grouped by relation, cut where the next one would pass the cap with its "more" tail.
  const text = (n: number): string => {
    const parts: string[] = [];
    let left = n;
    for (const [g, list] of groups) {
      if (left === 0) break;
      parts.push(`${g} ${list.slice(0, left).join(', ')}`);
      left -= Math.min(left, list.length);
    }
    const more = keyed.length - n;
    return `${head} (${parts.join('; ')}${more > 0 ? ` … +${more} more in the report's drawOrder` : ''})`;
  };
  let n = keyed.length;
  while (n > 1 && text(n).length > DRAW_ORDER_LINE_MAX) n--;
  const why = d.pairs.every((p) => !p.keyed) ? 'no pair keyed' : 'the setup order holds on every frame';
  const lines = [keyed.length === 0 ? `${head} (${why})` : text(n)];
  for (const p of d.pairs) {
    if (p.keyed) continue;
    const line = (why: string | undefined): string => `${prefix}${p.a} / ${p.b} not keyed: ${why}`;
    // Slots between the pair: the count first, the list cut until the line fits (#324).
    let shown = p.between?.length ?? 0;
    while (p.between !== undefined && shown > 0 && line(betweenWhy(p.between, shown)).length > DRAW_ORDER_LINE_MAX) shown--;
    lines.push(line(p.between === undefined ? p.why : betweenWhy(p.between, shown)).slice(0, DRAW_ORDER_LINE_MAX));
  }
  return lines;
}

/** px with its fraction of the leg: "12.3 px (0.084 leg)". */
const pxLeg = (px: number | null, legs: number | null): string => (px === null ? 'unread' : `${px} px${legs === null ? '' : ` (${legs} leg)`}`);

/** " at the knee" / " at the ankle" for a pair ordered by a joint (#336), else nothing. */
const gapAt = (d: DrawOrderReading, g: DrawOrderGap): string => {
  const j = d.pairs.find((p) => p.a === g.a && p.b === g.b)?.by;
  return j === undefined ? '' : ` at the ${j}`;
};

/**
 * The DRAWGAP lines (rig-c/pose#324): one per pair, keyed or not — the leg depth gap's median and
 * max against the tie, and how many frames passed it. Cut to `DRAW_ORDER_LINE_MAX` characters.
 */
export function drawGapLines(d: DrawOrderReading, prefix = 'DRAWGAP '): string[] {
  return (d.gaps ?? []).map((g) =>
    `${prefix}${g.a} / ${g.b}: leg depth gap${gapAt(d, g)} median ${pxLeg(g.median, g.medianLegs)}, max ${pxLeg(g.max, g.maxLegs)}, against the tie of ${g.tie === null ? 'none (a rest length is unread; equal depths only)' : pxLeg(g.tie, g.tieLegs)}; ${g.passed} of ${g.frames} frame(s) passed it`.slice(0, DRAW_ORDER_LINE_MAX),
  );
}
