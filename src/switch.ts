/**
 * Attachment switches: when the pose is in a pose the rig has an alternate set
 * of drawings for, show that set. Pure — no file, no clock, no process.
 *
 * The metric, per frame and per set: the largest |wrap(pose − key)| over every
 * segment of the set's chains, where "pose" is the segment's angle exactly as
 * the retarget asked the bone for it (after holds, smoothing, the short hold,
 * the flip guard and the hinge check; before any range clamp) and "key" is the
 * same segment's angle in the set's key skeleton, both by `pictureAngle`. Per
 * frame the candidate is the set with the smallest distance within the
 * tolerance (ties: map order); a run of one candidate shorter than the minimum
 * span is dropped, and the base art shows there; a gap shorter than the minimum
 * span between two runs of one set is bridged by that set. No other hysteresis.
 *
 * Sets compete only with the sets they share a slot with (shown or hidden,
 * transitively), or a bone they offset: two that touch nothing in common — a
 * drawing of each arm — can show at once, and two that do never overlap, so
 * each slot has one value per frame and one `attachment` track, and each
 * offset bone one `translate` track.
 *
 * While a set shows, every slot in its `slots` shows that attachment and every
 * slot in its `hides` is empty; everywhere else a slot shows its setup
 * attachment, as the compiled model states it. A direct switch from one set to
 * another therefore puts the first set's slots back to setup (an extra slot
 * whose setup is empty goes empty) on the frame the second set shows.
 *
 * Keys are stepped (rig-c's attachment timeline has no curve; the offsets'
 * `translate` keys are written `stepped`). A switch onto frame i is keyed half
 * a frame before it, at the midpoint of frames i−1 and i: a stepped key that
 * sits ON a frame's time fires a frame late wherever the sampler's accumulated
 * time lands below it (rig-c docs/AUTHORING.md §4.5), and the pose's times and
 * a renderer's `i / fps` are two grids that disagree by more than that.
 * Halfway, both see it on frame i.
 *
 * Where a switch is keyed (rig-c/pose#31): a boundary — a frame where a set
 * starts showing, or where the base art or the next set comes back — is moved,
 * after the selection above, to the fastest frame within ±`switchMin`/2 of it,
 * so the change of drawing lands in motion, not on an arm slowing into the
 * pose. The speed on a frame is the largest |angular speed|, degrees per frame
 * (central difference of the target world angles; one-sided on the first and
 * last frame), over the segments of the chains the boundary changes, the
 * leaving set's and the arriving set's; read on the same targets as the
 * distance, before the range clamp and any set's `turn`, which depend on where
 * the spans are. The window is clipped so every span keeps `switchMin` (a gap
 * between two spans of one set too, so the bridging holds), no boundary
 * reaches its neighbour, and a set with `frames` shows only inside them; and
 * a frame qualifies only if the set the move newly shows is within twice the
 * tolerance of its key skeleton on every frame it newly shows it on (speed
 * alone showed art up to 135° from its pose on the dancer). Ties
 * go to the frame nearest the original, then the earlier. A boundary between
 * two sets moves once. `switchAt: 'first'` keeps every boundary where the
 * selection put it; it is the CLI's default, because on HQ's dancer the bounded
 * peak still raised the sets' ART-RANGE runs from 24 to 31 (#31, round 2).
 */
import type { AlternateSet, JointMap, Rest, RigSlots } from './map.ts';
import { descends } from './map.ts';
import type { MotionKey, MotionTrack } from './retarget.ts';
import { pictureAngle, wrap } from './retarget.ts';
import type { MeshFolds } from './rigc.ts';

export interface SwitchOptions {
  /** Degrees: the largest segment difference at which a set may show. */
  switchTolerance: number;
  /** Seconds: a run of one set shorter than this is dropped. */
  switchMin: number;
  /** Where a boundary is keyed: 'first' (the CLI's default) keeps the frame the selection gave it; 'peak' moves it to the fastest qualifying frame of its window (#31). */
  switchAt: 'peak' | 'first';
}

/** One boundary of a span: where the selection put it, where it is keyed, and how fast the chains it changes move on each. */
export interface Move {
  /** The frame the boundary showed on as selected, then as keyed. */
  frame: [number, number];
  /** Signed: frames, and the seconds between the two frames' times. */
  frames: number;
  seconds: number;
  /** The frames it could move to, after clipping: first and last. */
  window: [number, number];
  /** Degrees per frame on the old and the new frame: the largest |angular speed| over the segments of the chains it changes. */
  speed: { old: number; new: number };
}

export interface Switch {
  set: string;
  chains: string[];
  /** Slot → the attachment it shows over the span. */
  slots: Record<string, string>;
  /** Slots empty over the span. */
  hides: string[];
  /** Bone → the translate it holds over the span. */
  offsets: Record<string, [number, number]>;
  /** The frame time it shows from, and the time the base art comes back (the animation's end when it runs to the end). */
  from: number;
  to: number;
  /** First and last frame index shown. */
  frames: [number, number];
  /** Over the frames shown, degrees. */
  distance: { max: number; median: number };
  /** Per bone the set has a `drawn` angle for: |wrap(target − drawn)| over the frames shown, degrees. */
  artTurn: Record<string, { max: number; median: number }>;
  /** The boundary it starts on (null from the first frame) and the one it ends on (null to the end); a boundary between two sets is in both. */
  moved: { on: Move | null; off: Move | null };
}

export interface AttachmentKey {
  t: number;
  /** The attachment shown from `t`, or null for nothing. */
  v: string | null;
}
export interface SlotTrack {
  slot: string;
  property: 'attachment';
  keys: AttachmentKey[];
}

/** Inside a set's span, a bone turned from its drawn angle past its range: the demand for another drawing of that set. */
export interface ArtRange {
  set: string;
  chain: string;
  bone: string;
  /** First and last frame of the run (spans merged across a gap of one frame). */
  frames: [number, number];
  seconds: number;
  /** Degrees past the range, the most on any frame of the run. */
  maxOverflow: number;
  /** The signed art turn, wrap(target − drawn), on that frame. */
  turn: number;
  /** The bone's range, degrees. */
  limits: [number, number];
  /** Whether the bone was held at the limit (the set's `turn`) or followed the pose (its chain's `range` only). */
  clamped: boolean;
}

export interface Uncovered {
  slot: string;
  attachment: string;
  /** The map's chains that move the mesh (the deepest of them). */
  chains: string[];
  /** The fold times, seconds, on which the slot still shows this mesh. */
  times: number[];
}

export interface Switches {
  switches: Switch[];
  /** The `attachment` tracks, one per slot whose picture changes. */
  slotTracks: SlotTrack[];
  /** The offsets' `translate` tracks, one per bone a shown set offsets. */
  offsetTracks: MotionTrack[];
  /** Per switched or hidden slot, what it shows on each frame (null: nothing). */
  shown: Map<string, Array<string | null>>;
  /** Per set, its distance on each frame, degrees. */
  distances: Map<string, number[]>;
}

/** Per set, its distance to the pose on every frame: the largest segment difference over its chains. */
export function setDistances(map: JointMap, targets: ReadonlyMap<string, readonly number[]>, n: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const a of map.alternates) {
    const segs: Array<{ asked: readonly number[]; key: number }> = [];
    for (const cn of a.chains) {
      const c = map.chains.find((x) => x.name === cn)!;
      c.bones.forEach((b, k) => segs.push({ asked: targets.get(b)!, key: pictureAngle(a.pose[c.joints[k]!]!, a.pose[c.joints[k + 1]!]!) }));
    }
    const d: number[] = [];
    for (let i = 0; i < n; i++) d.push(Math.max(...segs.map((s) => Math.abs(wrap(s.asked[i]! - s.key)))));
    out.set(a.name, d);
  }
  return out;
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

/** What a set switches: its slots shown or hidden, and the bones it offsets — each a value that has one track. */
function touches(a: AlternateSet): string[] {
  return [...Object.keys(a.slots), ...a.hides].map((s) => `slot:${s}`).concat(Object.keys(a.offsets).map((b) => `bone:${b}`));
}

/** Groups of sets that switch a common slot or offset a common bone, transitively; each in map order. */
function competing(sets: readonly AlternateSet[]): AlternateSet[][] {
  const parent = sets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  sets.forEach((a, i) => {
    for (const s of touches(a)) {
      const j = owner.get(s);
      if (j === undefined) owner.set(s, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, AlternateSet[]>();
  sets.forEach((a, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(a);
  });
  return [...groups.values()];
}

/**
 * Per frame, the largest |angular speed| over the given bones' target world
 * angles, degrees per frame: a central difference, one-sided on the first and
 * the last frame.
 */
export function speeds(bones: readonly string[], targets: ReadonlyMap<string, readonly number[]>, n: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - 1);
    const hi = Math.min(n - 1, k + 1);
    let v = 0;
    if (hi > lo) for (const b of bones) v = Math.max(v, Math.abs(wrap(targets.get(b)![hi]! - targets.get(b)![lo]!)) / (hi - lo));
    out.push(v);
  }
  return out;
}

/** A moved boundary may newly show a set only on frames within this many times the tolerance of its key skeleton (#31). */
export const MOVE_BOUND = 2;

/**
 * Move each boundary of one group's segments to the fastest frame of its
 * window (`switchAt: 'peak'`), in time order, each clipped against its
 * neighbours as they stand; `vals[s]` is what segment s shows (null: the base
 * art) and `pos[m]` the frame boundary m shows on, between segments m and m+1.
 * A candidate frame qualifies only if every frame the move newly shows a set
 * on is within `MOVE_BOUND` × the tolerance of it; none qualifying, the
 * boundary stays. Returns one `Move` per boundary.
 */
function moveBoundaries(vals: ReadonlyArray<AlternateSet | null>, pos: readonly number[], map: JointMap, targets: ReadonlyMap<string, readonly number[]>, distances: ReadonlyMap<string, readonly number[]>, times: readonly number[], duration: number, opts: SwitchOptions): Move[] {
  const n = times.length;
  const at = [...pos];
  const end = (b: number) => (b < n ? times[b]! : duration);
  const len = (a: number, b: number) => end(b) - times[a]!;
  /** What a segment must keep: the minimum span for a set's, and for a gap between two spans of one set (the bridging); never less than it had. */
  const need = (s: number, had: number): number => {
    const v = vals[s];
    const kept = v !== null || (s > 0 && s + 1 < vals.length && vals[s - 1] !== null && vals[s - 1] === vals[s + 1]);
    return kept ? Math.min(opts.switchMin, had) : 0;
  };
  const allowed = (a: AlternateSet | null, k: number) => a === null || a.frames === null || a.frames.some(([f, l]) => k >= f && k <= l);
  const bonesOf = (a: AlternateSet | null): string[] => (a === null ? [] : a.chains.flatMap((cn) => map.chains.find((c) => c.name === cn)!.bones));
  const moves: Move[] = [];
  for (let m = 0; m < at.length; m++) {
    const b = at[m]!;
    const prev = m === 0 ? 0 : at[m - 1]!;
    const next = m + 1 < at.length ? at[m + 1]! : n;
    const leaving = vals[m] ?? null;
    const arriving = vals[m + 1] ?? null;
    const needPrev = need(m, len(prev, b));
    const needNext = need(m + 1, len(b, next));
    // The pose's times are read to the microsecond, so a frame exactly half a minimum span away may read a hair past it.
    const half = opts.switchMin / 2 + 1e-6;
    // Earlier: frames b' … b−1 show the arriving segment.
    let lo = b;
    while (lo - 1 > prev && times[b]! - times[lo - 1]! <= half && len(prev, lo - 1) >= needPrev - 1e-9 && allowed(arriving, lo - 1)) lo--;
    // Later: frames b … b'−1 show the leaving one.
    let hi = b;
    while (hi + 1 < next && times[hi + 1]! - times[b]! <= half && len(hi + 1, next) >= needNext - 1e-9 && allowed(leaving, hi)) hi++;
    const sp = speeds([...new Set([...bonesOf(leaving), ...bonesOf(arriving)])], targets, n);
    // A frame qualifies only if the set it newly shows is within twice the tolerance of its key skeleton on every
    // frame it newly shows it on (round 1 on the dancer: speed alone showed a set up to 135° from its pose).
    const near = (a: AlternateSet | null, from: number, to: number): boolean => {
      if (a === null) return true;
      const d = distances.get(a.name)!;
      for (let k = from; k < to; k++) if (d[k]! > MOVE_BOUND * opts.switchTolerance) return false;
      return true;
    };
    const qualifies = (k: number) => (k < b ? near(arriving, k, b) : near(leaving, b, k));
    let best = b;
    if (opts.switchAt === 'peak') {
      for (let k = lo; k <= hi; k++) {
        if (!qualifies(k)) continue;
        const d = sp[k]! - sp[best]!;
        if (d > 1e-9 || (Math.abs(d) <= 1e-9 && (Math.abs(k - b) < Math.abs(best - b) || (Math.abs(k - b) === Math.abs(best - b) && k < best)))) best = k;
      }
    }
    at[m] = best;
    moves.push({ frame: [b, best], frames: best - b, seconds: r6(times[best]! - times[b]!), window: [lo, hi], speed: { old: r3(sp[b]!), new: r3(sp[best]!) } });
  }
  return moves;
}

/** The key time for a change that shows on frame i: half a frame before it, 0 on the first frame. */
const changeAt = (times: readonly number[], i: number): number => (i === 0 ? 0 : r6((times[i - 1]! + times[i]!) / 2));

/**
 * Select the switches, and key them: per frame and per group of competing
 * sets, the nearest within the tolerance; runs shorter than the minimum span
 * dropped; one `attachment` track per slot whose picture changes, back to the
 * slot's setup attachment at each end; one stepped `translate` track per bone
 * a shown set offsets, 0 outside its spans.
 */
export function selectSwitches(map: JointMap, targets: ReadonlyMap<string, readonly number[]>, times: readonly number[], duration: number, slots: RigSlots, opts: SwitchOptions): Switches {
  const n = times.length;
  const distances = setDistances(map, targets, n);
  const switches: Switch[] = [];
  for (const group of competing(map.alternates)) {
    const pick: Array<AlternateSet | null> = [];
    for (let i = 0; i < n; i++) {
      // A set with a `frames` window shows only inside it, and there it is chosen
      // over any set without one (a stopgap for what the angles cannot tell apart).
      let best: AlternateSet | null = null;
      let bestD = Infinity;
      let bestWindowed = false;
      for (const a of group) {
        if (a.frames !== null && !a.frames.some(([f, l]) => i >= f && i <= l)) continue;
        const d = distances.get(a.name)![i]!;
        if (d > opts.switchTolerance) continue;
        const windowed = a.frames !== null;
        if ((windowed && !bestWindowed) || (windowed === bestWindowed && d < bestD)) {
          best = a;
          bestD = d;
          bestWindowed = windowed;
        }
      }
      pick.push(best);
    }
    // A gap shorter than the minimum span between two runs of one set is that set
    // too: the base art flashing for a frame between them is the flicker the
    // minimum span exists to prevent (measured on the dancer: one-frame breaks at
    // a blurred frame inside a span of one set).
    for (let i = 0; i < n;) {
      const a = pick[i];
      let j = i;
      while (j + 1 < n && pick[j + 1] === a) j++;
      const before = i > 0 ? pick[i - 1] : null;
      const after = j + 1 < n ? pick[j + 1] : null;
      if (before !== null && before !== undefined && before === after && a !== before) {
        const gap = times[j + 1]! - times[i]!;
        if (gap < opts.switchMin - 1e-9) for (let k = i; k <= j; k++) pick[k] = before;
      }
      i = j + 1;
    }
    // A run shorter than the minimum span shows the base art.
    for (let i = 0; i < n;) {
      const a = pick[i];
      let j = i;
      while (j + 1 < n && pick[j + 1] === a) j++;
      const to = j + 1 < n ? times[j + 1]! : duration;
      if (a !== null && a !== undefined && to - times[i]! < opts.switchMin - 1e-9) for (let k = i; k <= j; k++) pick[k] = null;
      i = j + 1;
    }
    // The segments between boundaries, then each boundary moved (#31).
    const vals: Array<AlternateSet | null> = [pick[0] ?? null];
    const pos: number[] = [];
    for (let i = 1; i < n; i++) {
      if (pick[i] === pick[i - 1]) continue;
      pos.push(i);
      vals.push(pick[i] ?? null);
    }
    const moves = moveBoundaries(vals, pos, map, targets, distances, times, duration, opts);
    for (let s = 0; s < vals.length; s++) {
      const a = vals[s];
      if (a === null || a === undefined) continue;
      const i = s === 0 ? 0 : moves[s - 1]!.frame[1];
      const j = s < pos.length ? moves[s]!.frame[1] - 1 : n - 1;
      const from = times[i]!;
      const to = j + 1 < n ? times[j + 1]! : duration;
      const ds = distances.get(a.name)!.slice(i, j + 1);
      switches.push({ set: a.name, chains: a.chains, slots: a.slots, hides: a.hides, offsets: a.offsets, from, to, frames: [i, j], distance: { max: r3(Math.max(...ds)), median: r3(median(ds)) }, artTurn: {}, moved: { on: s === 0 ? null : moves[s - 1]!, off: s < pos.length ? moves[s]! : null } });
    }
  }
  const order = (name: string) => map.alternates.findIndex((a) => a.name === name);
  switches.sort((x, y) => x.frames[0] - y.frames[0] || order(x.set) - order(y.set));

  // What each touched slot shows per frame, then a key wherever that changes.
  const slotOrder: string[] = [];
  const boneOrder: string[] = [];
  for (const a of map.alternates) {
    for (const s of [...Object.keys(a.slots), ...a.hides]) if (!slotOrder.includes(s)) slotOrder.push(s);
    for (const b of Object.keys(a.offsets)) if (!boneOrder.includes(b)) boneOrder.push(b);
  }
  const shown = new Map<string, Array<string | null>>();
  const moved = new Map<string, Array<[number, number]>>();
  for (const sw of switches) {
    const values: Array<[string, string | null]> = [...Object.entries(sw.slots), ...sw.hides.map((h): [string, null] => [h, null])];
    for (const [s, v] of values) {
      if (!shown.has(s)) shown.set(s, Array.from({ length: n }, () => slots.get(s)!.setup));
      const row = shown.get(s)!;
      for (let i = sw.frames[0]; i <= sw.frames[1]; i++) row[i] = v;
    }
    for (const [b, o] of Object.entries(sw.offsets)) {
      if (!moved.has(b)) moved.set(b, Array.from({ length: n }, (): [number, number] => [0, 0]));
      const row = moved.get(b)!;
      for (let i = sw.frames[0]; i <= sw.frames[1]; i++) row[i] = o;
    }
  }
  const slotTracks: SlotTrack[] = [];
  for (const s of slotOrder) {
    const row = shown.get(s);
    if (row === undefined) continue;
    let prev = slots.get(s)!.setup;
    const keys: AttachmentKey[] = [];
    row.forEach((v, i) => {
      if (v === prev) return;
      keys.push({ t: changeAt(times, i), v });
      prev = v;
    });
    if (keys.length > 0) slotTracks.push({ slot: s, property: 'attachment', keys });
  }
  const offsetTracks: MotionTrack[] = [];
  for (const b of boneOrder) {
    const row = moved.get(b);
    if (row === undefined) continue;
    const keys: MotionKey[] = [{ t: 0, v: [r3(row[0]![0]), r3(row[0]![1])] }];
    row.forEach((v, i) => {
      const prev = row[i - 1];
      if (i === 0 || (prev![0] === v[0] && prev![1] === v[1])) return;
      keys.push({ t: changeAt(times, i), v: [r3(v[0]), r3(v[1])] });
    });
    // Every key but the last holds until the next (a stepped curve on the last has nothing to ease to).
    for (let k = 0; k + 1 < keys.length; k++) keys[k]!.ease = 'stepped';
    offsetTracks.push({ bone: b, property: 'translate', keys });
  }
  return { switches, slotTracks, offsetTracks, shown, distances };
}

/** Per chain, the frames on which a switch of a set depicting it shows: its art was painted for that pose. */
export function coveredChains(switches: readonly Switch[], n: number): Map<string, boolean[]> {
  const out = new Map<string, boolean[]>();
  for (const sw of switches) {
    for (const c of sw.chains) {
      if (!out.has(c)) out.set(c, Array.from({ length: n }, () => false));
      const row = out.get(c)!;
      for (let i = sw.frames[0]; i <= sw.frames[1]; i++) row[i] = true;
    }
  }
  return out;
}

/** Runs of flagged frames, merged across a gap of `gap` frames or fewer. */
export function runsOf(flag: readonly boolean[], gap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < flag.length; i++) {
    if (!flag[i]) continue;
    let j = i;
    while (j + 1 < flag.length && flag[j + 1]) j++;
    const last = out[out.length - 1];
    if (last !== undefined && i - last[1] - 1 <= gap) last[1] = j;
    else out.push([i, j]);
    i = j;
  }
  return out;
}

/**
 * Degrees past a range that do not count: the writer rounds a rotate key to
 * 0.001°, and the rest angles come from rig-c's float32 model (≈ 1e-5° here),
 * so a key the pose puts exactly on a limit can read a hair past it.
 */
export const RANGE_SLACK = 0.001;

/** How far a value is past [min, max], degrees; 0 inside. */
export const overflow = (v: number, [min, max]: readonly [number, number]): number => (v > max ? v - max : v < min ? min - v : 0);

/**
 * The art turn of each switch, in place (`artTurn`), and the art-range demand:
 * inside a span, per bone with a `drawn` angle in the set and limits — the
 * set's `turn` for it, else its chain's `range` — every frame whose signed art
 * turn wrap(target − drawn) falls outside them, in runs merged across a gap of
 * `gap` frames. Measured on the targets as the pose asks them, before
 * `clampArt` holds the set's `turn` limits.
 */
export function measureArt(switches: Switch[], map: JointMap, targets: ReadonlyMap<string, readonly number[]>, endOf: (i: number) => number, times: readonly number[], gap: number): ArtRange[] {
  const out: ArtRange[] = [];
  for (const sw of switches) {
    const set = map.alternates.find((a) => a.name === sw.set)!;
    for (const [bone, drawn] of Object.entries(set.drawn)) {
      const target = targets.get(bone)!;
      const turns: number[] = [];
      for (let i = sw.frames[0]; i <= sw.frames[1]; i++) turns.push(wrap(target[i]! - drawn));
      const abs = turns.map(Math.abs);
      sw.artTurn[bone] = { max: r3(Math.max(...abs)), median: r3(median(abs)) };
      const chain = map.chains.find((c) => c.bones.includes(bone))!;
      const limits = set.turn[bone] ?? chain.range[bone];
      if (limits === undefined) continue;
      const flag = turns.map((t) => overflow(t, limits) > RANGE_SLACK);
      for (const [a, b] of runsOf(flag, gap)) {
        let worst = a;
        for (let k = a; k <= b; k++) if (overflow(turns[k]!, limits) > overflow(turns[worst]!, limits)) worst = k;
        const first = sw.frames[0] + a;
        const last = sw.frames[0] + b;
        out.push({ set: sw.set, chain: chain.name, bone, frames: [first, last], seconds: r6(endOf(last) - times[first]!), maxOverflow: r3(overflow(turns[worst]!, limits)), turn: r3(turns[worst]!), limits, clamped: bone in set.turn });
      }
    }
  }
  return out;
}

/** The frame nearest a time: the one whose half-frame-either-side window holds it, as the switch keys are placed. */
function nearestFrame(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid + 1]! <= t) lo = mid + 1;
    else if (times[mid]! >= t) hi = mid;
    else return t - times[mid]! < times[mid + 1]! - t ? mid : mid + 1;
  }
  return lo;
}

/**
 * The folds no switch covers: every fold time on which the slot still shows
 * the folding attachment. A fold of a slot's base mesh while a set (or
 * nothing) shows there is covered; a fold of the set's own mesh while it
 * shows is not.
 */
export function uncoveredFolds(meshes: readonly MeshFolds[], shown: ReadonlyMap<string, ReadonlyArray<string | null>>, times: readonly number[], slots: RigSlots, chainsOf: (slot: string, attachment: string) => string[]): Uncovered[] {
  const out: Uncovered[] = [];
  for (const m of meshes) {
    const row = shown.get(m.slot);
    const left = m.times.filter((t) => (row === undefined ? slots.get(m.slot)?.setup ?? null : row[nearestFrame(times, t)]) === m.attachment);
    if (left.length > 0) out.push({ slot: m.slot, attachment: m.attachment, chains: chainsOf(m.slot, m.attachment), times: left });
  }
  return out;
}

/**
 * The map's chains that move a set of bones: for each bone, the chain owning
 * it or its nearest mapped ancestor, keeping only the deepest (a chain another
 * listed chain hangs from is dropped — the arm, not the trunk it hangs from).
 */
export function chainsMoving(bones: readonly string[], rest: Rest, map: JointMap): string[] {
  const owner = new Map<string, string>();
  for (const c of map.chains) for (const b of c.bones) owner.set(b, c.name);
  const found = new Set<string>();
  for (const bone of bones) {
    for (let b: string | null = bone; b !== null; b = rest.get(b)?.parent ?? null) {
      const c = owner.get(b);
      if (c !== undefined) {
        found.add(c);
        break;
      }
    }
  }
  const chainOf = (name: string) => map.chains.find((c) => c.name === name)!;
  return map.chains
    .map((c) => c.name)
    .filter((x) => found.has(x))
    .filter((x) => ![...found].some((y) => y !== x && chainOf(x).bones.some((b) => descends(rest, chainOf(y).bones[0]!, b))));
}

const deg = (v: number) => `${v.toFixed(1)}°`;
const sg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
const spanOf = (frames: [number, number], times: readonly number[]): string =>
  frames[0] === frames[1] ? `frame ${frames[0]} (t=${times[frames[0]]!.toFixed(3)}s)` : `frames ${frames[0]}–${frames[1]} (t=${times[frames[0]]!.toFixed(3)}–${times[frames[1]]!.toFixed(3)}s)`;

export function switchLine(s: Switch, times: readonly number[]): string {
  const span = s.frames[0] === s.frames[1] ? `frame ${s.frames[0]}` : `frames ${s.frames[0]}–${s.frames[1]}`;
  const shows = Object.entries(s.slots).map(([slot, att]) => `"${slot}" = "${att}"`);
  const parts = [
    `set "${s.set}" — ${shows.length === 0 ? 'shows no slot' : `shows ${shows.join(', ')}`}${s.hides.length > 0 ? `, hides ${s.hides.map((h) => `"${h}"`).join(', ')}` : ''}`,
    `chains ${s.chains.join(', ')}`,
    `${span} (t=${times[s.frames[0]]!.toFixed(3)}s until ${s.to.toFixed(3)}s) — distance max ${deg(s.distance.max)}, median ${deg(s.distance.median)}`,
  ];
  const offs = Object.entries(s.offsets);
  if (offs.length > 0) parts.push(`offsets ${offs.map(([b, o]) => `"${b}" (${o[0]}, ${o[1]})`).join(', ')}`);
  const art = Object.entries(s.artTurn);
  if (art.length > 0) parts.push(`art turn ${art.map(([b, a]) => `"${b}" max ${deg(a.max)}, median ${deg(a.median)}`).join('; ')}`);
  const moves = (['on', 'off'] as const).filter((k) => s.moved[k] !== null).map((k) => `${k} ${moveText(s.moved[k]!)}`);
  if (moves.length > 0) parts.push(`moved ${moves.join(', ')}`);
  return parts.join('; ');
}

const spd = (v: number) => `${v.toFixed(1)}°/frame`;
const win = (w: [number, number]) => (w[0] === w[1] ? `window frame ${w[0]}` : `window frames ${w[0]}–${w[1]}`);
function moveText(m: Move): string {
  if (m.frames === 0) return `frame ${m.frame[0]} stays (${spd(m.speed.old)}; ${win(m.window)})`;
  return `frame ${m.frame[0]} → ${m.frame[1]} (${m.frames > 0 ? '+' : '−'}${Math.abs(m.frames)} frame${Math.abs(m.frames) === 1 ? '' : 's'}, ${m.seconds > 0 ? '+' : '−'}${Math.abs(m.seconds).toFixed(3)}s; ${spd(m.speed.old)} → ${spd(m.speed.new)}; ${win(m.window)})`;
}

export function artRangeLine(e: ArtRange, times: readonly number[]): string {
  return `set "${e.set}" chain "${e.chain}" bone "${e.bone}" turned ${sg(e.turn)} from drawn (range [${e.limits[0]}, ${e.limits[1]}]) ${spanOf(e.frames, times)}: ${e.seconds.toFixed(3)}s, up to ${deg(e.maxOverflow)} past it; ${e.clamped ? 'held at the limit' : 'the bone follows the pose'} — demand for another drawing of the set`;
}

/**
 * Inside each span, a bone with a `turn` in the set is held within it: its
 * target world angle is drawn + clamp(wrap(target − drawn), min, max). Each
 * bone is clamped on its own world angle, and keys are differences of world
 * angles, so a forearm under a clamped upper arm keeps its own target.
 */
export function clampArt(switches: readonly Switch[], map: JointMap, targets: Map<string, number[]>): void {
  for (const sw of switches) {
    const set = map.alternates.find((a) => a.name === sw.set)!;
    for (const [bone, limits] of Object.entries(set.turn)) {
      const drawn = set.drawn[bone]!;
      const target = targets.get(bone)!;
      for (let i = sw.frames[0]; i <= sw.frames[1]; i++) {
        const t = wrap(target[i]! - drawn);
        const c = Math.min(Math.max(t, limits[0]), limits[1]);
        if (Math.abs(c - t) > RANGE_SLACK) target[i] = wrap(drawn + c);
      }
    }
  }
}
