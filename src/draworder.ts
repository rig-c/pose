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
 * - **The pairs.** The legs (`r_leg`, `l_leg`); the arms crossing the trunk are
 *   a later card. A limb is the map's chains naming its middle or end joint
 *   (knee, ankle), their bones and every bone under them no other chain maps;
 *   its slots are the slots on those bones, and an alternate set's slot on none
 *   of them goes with the limb whose chain the set depicts, when it depicts one
 *   of the two (a set keeps its own switch and takes the order of the limb it
 *   replaces). A pair is keyed when its slots overlap in the rig's draw order:
 *   together they fill one unbroken run of the setup order. A slot of anything
 *   else drawn between them would be re-layered by the swap — that is changing
 *   the setup order, not keying the pair — so the pair is not keyed and the line
 *   names the slot.
 * - **The rule.** On each frame the limb whose depth is the lower (farther from
 *   the camera) is drawn behind: its slots first in the pair's run, in their
 *   setup order, then the other's — when the two depths differ by at least
 *   #281's tie: the depth a limb can hold while both its segments read flat,
 *   √(1 − 0.95²) × (upper + lower ÷ 2) of its rest lengths, the smaller limb's of
 *   the two (a flat segment carries no depth, so closer than that the band
 *   cannot tell them). A frame inside the tie, or where either limb is not
 *   ordered, holds the order before; before the first decided frame, the setup
 *   order — or, on a looped sequence, the order the clip ends in, held across
 *   the seam. A key is written where the order changes, and none while it is the
 *   setup order from the start. Its time is half a frame before the frame it
 *   shows on (0 on frame 0), the rule the switches' attachment keys follow
 *   (`keyAtFrame` in `switch.ts`): a key exactly on a frame time is a tie the
 *   render breaks a frame late about half the time (rig-c/pose#325).
 *
 * Pure: no clock, no randomness, no disk.
 */
import type { Body18 } from './joints.ts';
import { FLAT_BAND, LIMBS, type FrameLayers, type Limb } from './depth.ts';
import { knownSetsOf, type JointMap, type Rest, type RigSets } from './map.ts';
import { DEPTH_SEGMENTS, type DepthSegment, type FrameDepth, type Joint } from './pose.ts';
import { keyAtFrame } from './switch.ts';

/** The limb pairs `--draw-order depth` keys. */
export const DRAW_ORDER_PAIRS: ReadonlyArray<readonly [Limb, Limb]> = [['r_leg', 'l_leg']];
/** What one segment inside the flat band can hide out of the picture, per unit of its rest length: √(1 − 0.95²). */
export const TIE_PER_LENGTH = Math.sqrt(1 - FLAT_BAND[0] * FLAT_BAND[0]);
/** The DRAWORDER line's cap, characters (the span list is cut to it; the report carries every span). */
export const DRAW_ORDER_LINE_MAX = 260;

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
  /** Why the pair is not keyed. */
  why?: string;
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
  const between = names.slice(lo, hi + 1).filter((n) => !slotsA.has(n) && !slotsB.has(n));
  if (between.length > 0) return none(`their slots do not overlap in the draw order: ${between.map((n) => `"${n}"`).join(', ')} ${between.length === 1 ? 'is' : 'are'} drawn between them, and a swap would re-layer ${between.length === 1 ? 'it' : 'them'} (the setup order is not changed here)`);
  return { pair: { ...pair, keyed: true }, lo, hi, aBehind: arrangement(names, lo, a, b), bBehind: arrangement(names, lo, b, a) };
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

/** #281's tie for two limbs, px: √(1 − 0.95²) × (upper + lower ÷ 2), the smaller limb's; null where a rest length is unread. */
function tieOf(track: readonly Joints[], depth: ReadonlyArray<FrameDepth | undefined>, limbs: readonly [Limb, Limb]): number | null {
  const hidden = limbs.map((l) => {
    const [u, w] = LIMBS[l].map((s) => restOf(track, depth, s));
    return u === null || u === undefined || w === null || w === undefined ? null : u + w / 2;
  });
  return hidden.some((h) => h === null) ? null : Math.round(TIE_PER_LENGTH * Math.min(hidden[0]!, hidden[1]!) * 100) / 100;
}

/**
 * The draw-order keys from the frames' layers. `track` and `depth` are the sequence's
 * joints and depth per frame (the rest lengths the tie reads); `order` is the rig's
 * setup draw order (the compiled model's slots); `times` the frames' times.
 */
export function drawOrderFromDepth(layers: readonly FrameLayers[], track: readonly Joints[], depth: ReadonlyArray<FrameDepth | undefined>, times: readonly number[], map: JointMap, rest: Rest, order: ReadonlyArray<{ name: string; bone: string }>, sets?: RigSets, loop = false): DrawOrderReading {
  const resolved = DRAW_ORDER_PAIRS.map((p) => resolvePair(p, map, rest, order, sets));
  for (const r of resolved) r.pair.tie = tieOf(track, depth, r.pair.limbs);
  const names = order.map((s) => s.name);
  // Per pair, per frame: who is behind ('a' | 'b'), or null for the setup order before any decision.
  const states = resolved.map((r) => {
    const tie = r.pair.tie ?? 0;
    const pass = (start: 'a' | 'b' | null): Array<'a' | 'b' | null> => {
      let state = start;
      return layers.map((l) => {
        if (!r.pair.keyed) return null;
        const za = l.depth[r.pair.limbs[0]];
        const zb = l.depth[r.pair.limbs[1]];
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
  for (let f = 0; f < layers.length; f++) {
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
  return { pairs: resolved.map((r) => r.pair), keys, spans };
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
  const head = `${prefix}from depth, ${d.keys.length} key(s) over ${keyed.length} span(s)`;
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
  for (const p of d.pairs) if (!p.keyed) lines.push(`${prefix}${p.a} / ${p.b} not keyed: ${p.why}`.slice(0, DRAW_ORDER_LINE_MAX));
  return lines;
}
