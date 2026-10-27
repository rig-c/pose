/**
 * The tracks a retarget drops, and the two ways to put them back (rig-c/pose#43
 * item 2): the rig's idle read against the new animation, its dropped tracks
 * looped into it with `--carry-idle`, and a timed fragment merged with `--merge`.
 *
 * Pure: the motion spec's own track objects in, track objects out. What a
 * merged or carried track means (its bone, its property, its values) is rig-c's
 * to judge, and its gate judges it with the animation in.
 *
 * A key's `ease` or `curve` describes the segment from that key to the next
 * (rig-c docs/AUTHORING.md §4.5), so a loop is built key by key: where one
 * cycle meets the next, the key that ends a cycle and the one that starts the
 * next must not share a time, and the segment into the seam must ease toward
 * the value the loop shows there. A raw `curve` states absolute times, so a
 * repeated one is shifted with its key. The last key of the whole track carries
 * neither.
 */
import { isObject, Problems, typeName, type Problem } from './problems.ts';

/** A rigc-motion track as the motion spec states it: one target field, a property, keys, and whatever else it carries. */
export type RigcTrack = Record<string, unknown> & { property: string; keys: RigcKey[] };
export type RigcKey = Record<string, unknown> & { t: number; v: unknown; ease?: string; curve?: number[] };

/** The six target fields of a track (AUTHORING §4.4). */
const TARGET_FIELDS = ['bone', 'slot', 'group', 'physics', 'path', 'slider'] as const;
type TargetKind = (typeof TARGET_FIELDS)[number];

/** What each bone and slot property poses, channel by channel: two tracks that share a channel key the same thing. */
const BONE_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  translate: ['translatex', 'translatey'], translatex: ['translatex'], translatey: ['translatey'],
  scale: ['scalex', 'scaley'], scalex: ['scalex'], scaley: ['scaley'],
  shear: ['shearx', 'sheary'], shearx: ['shearx'], sheary: ['sheary'],
  rotate: ['rotate'], inherit: ['inherit'],
};
const SLOT_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  attachment: ['attachment'], rgba: ['rgb', 'alpha'], rgb: ['rgb'], alpha: ['alpha'], rgba2: ['rgb', 'alpha', 'dark'], rgb2: ['rgb', 'dark'],
};
/** A bone property whose setup value, as a key states it, is known without reading the rig: translate and shear add to setup (0), scale multiplies it (1). */
const BONE_IDENTITY: Readonly<Record<string, number>> = {
  translate: 0, translatex: 0, translatey: 0, shear: 0, shearx: 0, sheary: 0, rotate: 0, scale: 1, scalex: 1, scaley: 1,
};
/** The bone properties that only move a bone: a child's angle is unchanged, so one on a bone above a mapped bone is carried. */
const TRANSLATES = new Set(['translate', 'translatex', 'translatey']);
/** Timelines stepped by the format: a key carries no ease and no curve, and no value lies between two keys. */
const STEPPED_BY_NATURE = new Set(['attachment', 'inherit', 'reset']);

/** A target and its name: `bone "neck"`, `group "eyes"`. */
export interface Target {
  kind: TargetKind;
  name: string;
}

export function targetOf(track: Record<string, unknown>): Target | null {
  const found = TARGET_FIELDS.filter((f) => typeof track[f] === 'string');
  return found.length === 1 ? { kind: found[0]!, name: track[found[0]!] as string } : null;
}

/** `group "eyes" (eye_r, eye_l) scaley`, `bone "chest_ctl" translatey`. */
export function trackLabel(track: RigcTrack, groups: Readonly<Record<string, readonly string[]>>): string {
  const t = targetOf(track);
  if (t === null) return `a track with no single target, property ${JSON.stringify(track.property)}`;
  const members = t.kind === 'group' && groups[t.name] !== undefined ? ` (${groups[t.name]!.join(', ')})` : '';
  return `${t.kind} "${t.name}"${members} ${track.property}`;
}

/**
 * Every channel a track poses, as `family:name:channel`: a group's members are
 * bones, slots or physics constraints by its property (AUTHORING §4.3), so a
 * group track collides with a bone track on one of its members.
 */
function cellsOf(track: RigcTrack, groups: Readonly<Record<string, readonly string[]>>): string[] {
  const t = targetOf(track);
  if (t === null) return [];
  const p = track.property;
  const family = (kind: TargetKind): 'bone' | 'slot' | 'physics' | 'path' | 'slider' => {
    if (kind !== 'group') return kind;
    if (p in BONE_CHANNELS) return 'bone';
    if (p in SLOT_CHANNELS) return 'slot';
    return 'physics';
  };
  const fam = family(t.kind);
  const channels = fam === 'bone' ? BONE_CHANNELS[p] ?? [p] : fam === 'slot' ? SLOT_CHANNELS[p] ?? [p] : [p];
  const names = t.kind === 'group' ? groups[t.name] ?? [] : [t.name];
  return names.flatMap((n) => channels.map((c) => `${fam}:${n}:${c}`));
}

/** Which channels the tracks pose, each with the label of the track posing it. */
export function keyedBy(tracks: readonly RigcTrack[], groups: Readonly<Record<string, readonly string[]>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const tr of tracks) for (const c of cellsOf(tr, groups)) if (!out.has(c)) out.set(c, trackLabel(tr, groups));
  return out;
}

/** The labels of the tracks in `keyed` that pose a channel `track` poses. */
function collisions(track: RigcTrack, keyed: ReadonlyMap<string, string>, groups: Readonly<Record<string, readonly string[]>>): string[] {
  return [...new Set(cellsOf(track, groups).flatMap((c) => (keyed.has(c) ? [keyed.get(c)!] : [])))];
}

/** The colliding cells (`family:name:channel`) and the labels of the tracks in `keyed` that pose them. */
function collisionCells(track: RigcTrack, keyed: ReadonlyMap<string, string>, groups: Readonly<Record<string, readonly string[]>>): Array<{ cell: string; by: string }> {
  return cellsOf(track, groups).flatMap((cell) => (keyed.has(cell) ? [{ cell, by: keyed.get(cell)! }] : []));
}

export interface IdleDropped {
  target: Target;
  /** A group's members, as the motion spec's `groups` names them. */
  members: string[] | null;
  property: string;
  /** The track's keys in the idle. */
  keys: number;
  /** The idle's duration, seconds. */
  duration: number;
  /** With --carry-idle: the looped track's keys, the cycles they span, and where a seam jumps. */
  carried: { keys: number; cycles: number; seams: string | null } | null;
  /** With --carry-idle: why this track was not carried. */
  notCarried: string | null;
}

export interface IdleKeptOut {
  target: Target;
  property: string;
  reason: string;
}

export interface IdleReading {
  animation: string;
  duration: number;
  tracks: number;
  dropped: IdleDropped[];
  keptOut: IdleKeptOut[];
  /** The idle's timelines that are not tracks (drawOrder, events, ik, transform, deform, sequence): never compared, never carried. */
  notTracks: string[];
  /** With --carry-idle: the looped tracks, in the idle's order. */
  carriedTracks: RigcTrack[];
  /** With --carry-idle: `newTracks` with any slot `rgb` track folded into a carried `rgba2`/`rgb2` track removed so each channel is keyed once. */
  ownTracks: RigcTrack[];
}

const NOT_TRACKS = ['drawOrder', 'events', 'ik', 'transform', 'deform', 'sequence'] as const;

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
/** Two times this close are one time (key times are written to 1e-6 s). */
const EPS = 1e-7;

const numeric = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Slice channels `[start, end)` from a numeric track's values and raw curves. */
function sliceTrackChannels(track: RigcTrack, property: string, start: number, end: number): RigcTrack {
  return {
    ...track,
    property,
    keys: track.keys.map((k) => {
      const out: RigcKey = { ...k };
      if (numeric(k.v)) out.v = k.v.slice(start, end);
      if (Array.isArray(k.curve)) out.curve = k.curve.slice(start * 4, end * 4);
      return out;
    }),
  };
}

/** Sample a linear/stepped/Bézier numeric track at `t`. */
export function sampleNumericTrack(track: RigcTrack, t: number, width: number, easings: Readonly<Record<string, readonly number[]>>): number[] {
  const keys = track.keys;
  if (keys.length === 0) return Array(width).fill(1) as number[];
  if (t <= keys[0]!.t + EPS) return [...(keys[0]!.v as number[]).slice(0, width)];
  const last = keys[keys.length - 1]!;
  if (t >= last.t - EPS) return [...(last.v as number[]).slice(0, width)];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (Math.abs(t - a.t) <= EPS) return [...(a.v as number[]).slice(0, width)];
    if (Math.abs(t - b.t) <= EPS) return [...(b.v as number[]).slice(0, width)];
    if (t > a.t && t < b.t) {
      const c = cutAt({ ...a }, b, t, easings);
      if ('v' in c) return c.v.slice(0, width);
      const va = a.v as number[];
      const vb = b.v as number[];
      return va.slice(0, width).map((v0, idx) => r6(v0 + ((t - a.t) / (b.t - a.t)) * (vb[idx]! - v0)));
    }
  }
  return [...(last.v as number[]).slice(0, width)];
}

/** Split `track` at any extra times so its keys sit on the union of its own times and `extraTimes`, preserving every curve segment. */
function refineTrackAtTimes(track: RigcTrack, extraTimes: readonly number[], easings: Readonly<Record<string, readonly number[]>>): { track: RigcTrack } | { reason: string } {
  const keys: RigcKey[] = track.keys.map((k) => ({ ...k, ...(Array.isArray(k.v) ? { v: [...(k.v as number[])] } : {}), ...(Array.isArray(k.curve) ? { curve: [...k.curve] } : {}) }));
  if (keys.length === 0) return { track: { ...track, keys } };
  const tFirst = keys[0]!.t;
  const tLast = keys[keys.length - 1]!.t;
  const vFirst = [...(keys[0]!.v as number[])];
  const vLast = [...(keys[keys.length - 1]!.v as number[])];
  const sorted = [...extraTimes].map(r6).sort((x, y) => x - y);
  const before: RigcKey[] = [];
  const after: RigcKey[] = [];
  for (const rawT of sorted) {
    const t = r6(rawT);
    if (t < tFirst - EPS) {
      if (!before.some((k) => Math.abs(k.t - t) <= EPS)) before.push({ t, v: [...vFirst] });
      continue;
    }
    if (t > tLast + EPS) {
      if (!after.some((k) => Math.abs(k.t - t) <= EPS)) after.push({ t, v: [...vLast] });
      continue;
    }
    if (keys.some((k) => Math.abs(k.t - t) <= EPS)) continue;
    const idx = keys.findIndex((k, i) => i < keys.length - 1 && k.t < t - EPS && keys[i + 1]!.t > t + EPS);
    if (idx < 0) continue;
    const a = keys[idx]!;
    const b = keys[idx + 1]!;
    const va = a.v as number[];
    const vb = b.v as number[];
    if (a.ease === 'stepped') {
      keys.splice(idx + 1, 0, { t, v: [...va], ease: 'stepped' });
      continue;
    }
    let fullCurve: number[] | null = null;
    if (Array.isArray(a.curve)) fullCurve = [...a.curve];
    else if (typeof a.ease === 'string') {
      const h = easings[a.ease];
      if (h === undefined || h.length !== 4) return { reason: `its easing "${a.ease}" is not in the motion spec's easings` };
      fullCurve = va.flatMap((v0, c) => [a.t + (b.t - a.t) * h[0]!, v0 + (vb[c]! - v0) * h[1]!, a.t + (b.t - a.t) * h[2]!, v0 + (vb[c]! - v0) * h[3]!]);
    }
    if (fullCurve === null) {
      const vMid = va.map((v0, c) => r6(v0 + ((t - a.t) / (b.t - a.t)) * (vb[c]! - v0)));
      keys.splice(idx + 1, 0, { t, v: vMid });
      continue;
    }
    const leftCurve: number[] = [];
    const rightCurve: number[] = [];
    const vMid: number[] = [];
    va.forEach((v0, c) => {
      const [x1, y1, x2, y2] = fullCurve.slice(c * 4, c * 4 + 4) as [number, number, number, number];
      const bez = (p0: number, p1: number, p2: number, p3: number, s: number) => {
        const u = 1 - s;
        return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3;
      };
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (bez(a.t, x1, x2, b.t, mid) < t) lo = mid;
        else hi = mid;
      }
      const s = (lo + hi) / 2;
      const lerp = (p: number, q: number) => p + (q - p) * s;
      const splitBoth = (p0: number, p1: number, p2: number, p3: number): [number, number, number, number, number] => {
        const p01 = lerp(p0, p1);
        const p12 = lerp(p1, p2);
        const p23 = lerp(p2, p3);
        const p012 = lerp(p01, p12);
        const p123 = lerp(p12, p23);
        const p0123 = lerp(p012, p123);
        return [p01, p012, p0123, p123, p23];
      };
      const xs = splitBoth(a.t, x1, x2, b.t);
      const ys = splitBoth(v0, y1, y2, vb[c]!);
      leftCurve.push(r6(xs[0]), r6(ys[0]), r6(xs[1]), r6(ys[1]));
      vMid.push(r6(ys[2]));
      rightCurve.push(r6(xs[3]), r6(ys[3]), r6(xs[4]), r6(ys[4]));
    });
    delete a.ease;
    a.curve = leftCurve;
    keys.splice(idx + 1, 0, { t, v: vMid, curve: rightCurve });
  }
  if (keys.length > 0) {
    delete keys[keys.length - 1]!.ease;
    delete keys[keys.length - 1]!.curve;
  }
  const allKeys = [...before, ...keys, ...after];
  if (allKeys.length > 0) {
    delete allKeys[allKeys.length - 1]!.ease;
    delete allKeys[allKeys.length - 1]!.curve;
  }
  return { track: { ...track, keys: allKeys } };
}

type SegmentCurve = { kind: 'linear'; flat: boolean } | { kind: 'stepped-jump' } | { kind: 'bezier'; curve: number[] } | { reason: string };

function segmentCurveOf(
  key: RigcKey,
  v0: readonly number[],
  v1: readonly number[],
  t0: number,
  dt: number,
  chStart: number,
  chEnd: number,
  easings: Readonly<Record<string, readonly number[]>>,
): SegmentCurve {
  const flat = v0.every((x, c) => x === v1[c]);
  if (key.ease === 'stepped') return flat ? { kind: 'linear', flat: true } : { kind: 'stepped-jump' };
  if (Array.isArray(key.curve)) return { kind: 'bezier', curve: key.curve.slice(chStart * 4, chEnd * 4) };
  if (typeof key.ease === 'string') {
    const h = easings[key.ease];
    if (h === undefined || h.length !== 4) return { reason: `its easing "${key.ease}" is not in the motion spec's easings` };
    return {
      kind: 'bezier',
      curve: v0.flatMap((c0, c) => {
        const dv = v1[c]! - c0;
        return [r6(t0 + dt * h[0]!), r6(c0 + dv * h[1]!), r6(t0 + dt * h[2]!), r6(c0 + dv * h[3]!)];
      }),
    };
  }
  return { kind: 'linear', flat };
}

/**
 * Fold an `own` slot `rgb` track into channels `0..2` of a looped `rgba2` or `rgb2`
 * track on the union of their key times, keeping each channel group's own interpolation.
 *
 * Per rig-c `src/timelines.ts:29-33, 47-54, 915-921` and `src/compile.ts:1176-1181,
 * 1213-1223, 1580-1594, 1634-1646, 8064-8080, 9722-9754`:
 * - `rgba2` has 7 channels `[lr,lg,lb,la,dr,dg,db]` (28 raw curve numbers: `0..11` light RGB, `12..27` alpha + dark RGB).
 * - `rgb2` has 6 channels `[lr,lg,lb,dr,dg,db]` (24 raw curve numbers: `0..11` light RGB, `12..23` dark RGB).
 * - A named easing (`key.ease` in `motion.easings`) converts to its exact per-channel Bézier (`bezierForChannel`).
 * - `"stepped"` is key-wide only (`rawCurve` accepts `"stepped"` or `channels * 4` finite numbers): a stepped hold
 *   (`v0 === v1` on those channels) is flat and equals linear/collinear Bézier; a stepped jump (`v0 !== v1`) where the
 *   other channel group is flat stays `ease: "stepped"`; a stepped jump coinciding with a moving segment on the other
 *   channel group cannot be encoded in `rigc-motion/1` and is refused by name.
 */
function foldRgbIntoTwoColour(carried: RigcTrack, rgbTrack: RigcTrack, easings: Readonly<Record<string, readonly number[]>>): { track: RigcTrack } | { reason: string } {
  const idleRefined = refineTrackAtTimes(carried, rgbTrack.keys.map((k) => k.t), easings);
  if ('reason' in idleRefined) return idleRefined;
  const rgbRefined = refineTrackAtTimes(rgbTrack, carried.keys.map((k) => k.t), easings);
  if ('reason' in rgbRefined) return rgbRefined;
  const idleKeys = idleRefined.track.keys;
  const rgbKeys = rgbRefined.track.keys;
  const outKeys: RigcKey[] = [];
  for (let i = 0; i < idleKeys.length; i++) {
    const ik = idleKeys[i]!;
    const rk = rgbKeys[i]!;
    const t0 = ik.t;
    const rgb0 = (rk.v as number[]).slice(0, 3);
    const rest0 = (ik.v as number[]).slice(3);
    const v = [...rgb0, ...rest0];
    const inext = idleKeys[i + 1];
    const rnext = rgbKeys[i + 1];
    if (inext === undefined || rnext === undefined) {
      outKeys.push({ t: t0, v });
      continue;
    }
    const t1 = inext.t;
    const dt = t1 - t0;
    const rgb1 = (rnext.v as number[]).slice(0, 3);
    const rest1 = (inext.v as number[]).slice(3);
    const rgbSeg = segmentCurveOf(rk, rgb0, rgb1, t0, dt, 0, 3, easings);
    if ('reason' in rgbSeg) return rgbSeg;
    const restSeg = segmentCurveOf(ik, rest0, rest1, t0, dt, 3, 3 + rest0.length, easings);
    if ('reason' in restSeg) return restSeg;
    if (rgbSeg.kind === 'stepped-jump' || restSeg.kind === 'stepped-jump') {
      const rgbCanStep = rgbSeg.kind === 'stepped-jump' || (rgbSeg.kind === 'linear' && rgbSeg.flat);
      const restCanStep = restSeg.kind === 'stepped-jump' || (restSeg.kind === 'linear' && restSeg.flat);
      if (rgbCanStep && restCanStep) {
        outKeys.push({ t: t0, v, ease: 'stepped' });
        continue;
      }
      return {
        reason: `its stepped segment [${t0}, ${t1}]s jumps ${carried.property}'s non-rgb channels (${JSON.stringify(rest0)} -> ${JSON.stringify(rest1)}) while rgb moves (${JSON.stringify(rgb0)} -> ${JSON.stringify(rgb1)}), and rigc-motion/1 has no per-channel "stepped" curve`,
      };
    }
    if (rgbSeg.kind === 'linear' && restSeg.kind === 'linear') {
      outKeys.push({ t: t0, v });
      continue;
    }
    const linearBezier = (v0: readonly number[], v1: readonly number[]): number[] =>
      v0.flatMap((c0, c) => {
        const dv = v1[c]! - c0;
        return [r6(t0 + dt / 3), r6(c0 + dv / 3), r6(t0 + (2 * dt) / 3), r6(c0 + (2 * dv) / 3)];
      });
    const rgbCurve = rgbSeg.kind === 'bezier' ? rgbSeg.curve : linearBezier(rgb0, rgb1);
    const restCurve = restSeg.kind === 'bezier' ? restSeg.curve : linearBezier(rest0, rest1);
    outKeys.push({ t: t0, v, curve: [...rgbCurve, ...restCurve] });
  }
  return { track: { ...carried, keys: outKeys } };
}

/**
 * The idle against the new animation: every idle track the new one does not
 * key on any channel is dropped (and, with `carry`, looped into it); every one
 * it keys is kept out, naming the track that keys it. A slot `rgba` or `rgba2`/`rgb2`
 * track whose slot has only `rgb` keyed in `newTracks` merges channel-wise (#451):
 * `rgb` is kept out while `alpha` (and `dark` on `rgba2`/`rgb2`) stays the idle's.
 */
export function readIdle(
  name: string,
  /** The new animation's name. */
  into: string,
  idle: Record<string, unknown>,
  newTracks: readonly RigcTrack[],
  duration: number,
  motion: { groups: Readonly<Record<string, readonly string[]>>; easings: Readonly<Record<string, readonly number[]>> },
  /** The setup value a key on this target and property states (`sample` is one of its keys' values), or undefined when it is not read. */
  setupOf: (target: Target, property: string, sample: unknown) => unknown,
  carry: boolean,
  /** The mapped bones (chains and the translated bone) under a bone, in map order. */
  mappedBelow: (bone: string) => readonly string[] = () => [],
  /** The translated bone (the hip) when it lies under this bone, else null: a translate above it moves the origin the retarget places. */
  translatedBelow: (bone: string) => string | null = () => null,
): IdleReading {
  const D = idle.duration as number;
  const tracks = (Array.isArray(idle.tracks) ? idle.tracks : []) as RigcTrack[];
  const keyed = keyedBy(newTracks, motion.groups);
  const dropped: IdleDropped[] = [];
  const keptOut: IdleKeptOut[] = [];
  const carriedTracks: RigcTrack[] = [];
  const absorbedOwn = new Set<RigcTrack>();
  for (const tr of tracks) {
    const target = targetOf(tr);
    if (target === null) continue;
    const hitCells = collisionCells(tr, keyed, motion.groups);
    if (hitCells.length > 0) {
      // #451: a slot `rgba`, `rgba2` or `rgb2` track whose only collision is `rgb`
      // keeps its non-colliding `alpha` / `dark` channels instead of losing the whole track.
      if (target.kind === 'slot' && (tr.property === 'rgba' || tr.property === 'rgba2' || tr.property === 'rgb2')) {
        const hitChannelNames = [...new Set(hitCells.map((x) => x.cell.split(':')[2]!))];
        const hitBy = [...new Set(hitCells.map((x) => x.by))];
        if (hitChannelNames.length === 1 && hitChannelNames[0] === 'rgb') {
          keptOut.push({ target, property: 'rgb', reason: `"${into}"'s own ${hitBy.join(', ')} keys it` });
          if (tr.property === 'rgba') {
            const alphaTr = sliceTrackChannels(tr, 'alpha', 3, 4);
            const entry: IdleDropped = { target, members: null, property: 'alpha', keys: alphaTr.keys.length, duration: D, carried: null, notCarried: null };
            if (carry) {
              const c = loopTrack(alphaTr, D, duration, motion.easings, () => setupOf(target, 'alpha', alphaTr.keys[0]?.v));
              if ('reason' in c) entry.notCarried = c.reason;
              else {
                entry.carried = { keys: c.track.keys.length, cycles: c.cycles, seams: c.seams };
                carriedTracks.push(c.track);
              }
            }
            dropped.push(entry);
            continue;
          }
          // `rgba2` or `rgb2`: `rigc-motion/1` has no standalone `dark` timeline, so with `carry`
          // the looped track takes `own`'s `rgb` on channels 0..2 and replaces the standalone `rgb` track.
          const ownRgb = newTracks.find((o) => {
            const ot = targetOf(o);
            return o.property === 'rgb' && ((ot?.kind === 'slot' && ot.name === target.name) || (ot?.kind === 'group' && (motion.groups[ot.name] ?? []).includes(target.name)));
          });
          const entry: IdleDropped = { target, members: null, property: tr.property, keys: tr.keys.length, duration: D, carried: null, notCarried: null };
          if (carry) {
            const c = loopTrack(tr, D, duration, motion.easings, () => setupOf(target, tr.property, tr.keys[0]?.v));
            if ('reason' in c) entry.notCarried = c.reason;
            else if (ownRgb !== undefined && targetOf(ownRgb)?.kind === 'slot') {
              const folded = foldRgbIntoTwoColour(c.track, ownRgb, motion.easings);
              if ('reason' in folded) entry.notCarried = folded.reason;
              else {
                absorbedOwn.add(ownRgb);
                entry.carried = { keys: folded.track.keys.length, cycles: c.cycles, seams: c.seams };
                carriedTracks.push(folded.track);
              }
            } else {
              entry.carried = { keys: c.track.keys.length, cycles: c.cycles, seams: c.seams };
              carriedTracks.push(c.track);
            }
          }
          dropped.push(entry);
          continue;
        }
      }
      const hit = [...new Set(hitCells.map((x) => x.by))];
      keptOut.push({ target, property: tr.property, reason: `"${into}"'s own ${hit.join(', ')} keys it` });
      continue;
    }
    // A rotate, scale or shear above a mapped bone turns it off the angle its keys assume (the key formula holds unmapped bones at setup).
    const bones = target.kind === 'bone' ? [target.name] : target.kind === 'group' && tr.property in BONE_CHANNELS ? [...(motion.groups[target.name] ?? [])] : [];
    const under = TRANSLATES.has(tr.property) ? [] : [...new Set(bones.flatMap((b) => mappedBelow(b)))];
    const hipBelow = TRANSLATES.has(tr.property) ? bones.map((b) => translatedBelow(b)).find((h) => h !== null) ?? null : null;
    if (hipBelow !== null) {
      keptOut.push({ target, property: tr.property, reason: `moves the translated bone "${hipBelow}" below it; the retarget places its origin` });
      continue;
    }
    if (under.length > 0) {
      keptOut.push({ target, property: tr.property, reason: `moves mapped bone(s) ${under.map((b) => `"${b}"`).join(', ')} below it; the retarget's keys assume it at setup` });
      continue;
    }
    const entry: IdleDropped = { target, members: target.kind === 'group' ? [...(motion.groups[target.name] ?? [])] : null, property: tr.property, keys: tr.keys.length, duration: D, carried: null, notCarried: null };
    if (carry) {
      const c = loopTrack(tr, D, duration, motion.easings, () => setupOf(target, tr.property, tr.keys[0]?.v));
      if ('reason' in c) entry.notCarried = c.reason;
      else {
        entry.carried = { keys: c.track.keys.length, cycles: c.cycles, seams: c.seams };
        carriedTracks.push(c.track);
      }
    }
    dropped.push(entry);
  }
  const notTracks = NOT_TRACKS.filter((k) => idle[k] !== undefined);
  const ownTracks = absorbedOwn.size === 0 ? [...newTracks] : newTracks.filter((t) => !absorbedOwn.has(t));
  return { animation: name, duration: D, tracks: tracks.length, dropped, keptOut, notTracks, carriedTracks, ownTracks };
}

/**
 * One idle track looped to `T` seconds: its keys repeated every `D` seconds and
 * cut at `T`, with the value interpolated there.
 *
 * - Where the idle's last key is at `D` and its first at 0 (a closed loop), the
 *   two are one key at each seam: the next cycle's first. A last key that
 *   differs from the first is a jump in the idle as a player loops it (at `D`
 *   it shows the first key), and the seam keys the first; `seams` says so.
 * - Where the last key is before `D`, the player holds it to `D`: it is keyed
 *   `stepped` (a timeline stepped by the format holds anyway).
 * - Where the first key is after 0, the player shows the setup value from each
 *   cycle's start to that key: a stepped setup key opens each later cycle. That
 *   needs the setup value as a key states it, which this reads only for a bone's
 *   translate, scale, shear and rotate (0, 1, 0, 0) and a slot's attachment.
 */
export function loopTrack(
  track: RigcTrack,
  D: number,
  T: number,
  easings: Readonly<Record<string, readonly number[]>>,
  setup: () => unknown,
): { track: RigcTrack; cycles: number; seams: string | null } | { reason: string } {
  if (track.lag !== undefined || track.stagger !== undefined) return { reason: `it carries ${track.lag !== undefined ? '"lag"' : '"stagger"'}, which shifts its keys per track or per member; a loop is cut by key time, so it is not carried` };
  const keys = track.keys;
  if (keys.length === 0) return { reason: 'it has no keys' };
  const nature = STEPPED_BY_NATURE.has(track.property);
  if (!nature && !keys.every((k) => numeric(k.v))) return { reason: 'a key\'s value is not a list of numbers (a per-member map or a model), and a cut needs the value between two keys' };
  if (!(D > 0)) return { reason: `the idle's duration is ${D}` };
  const first = keys[0]!.t;
  const last = keys[keys.length - 1]!.t;
  let setupKey: unknown;
  if (first > EPS) {
    setupKey = setup();
    if (setupKey === undefined) return { reason: `its first key is at t=${first}s, so a loop shows the setup value of ${track.property} before it in every cycle, and this package does not read that value for this target` };
  }

  const shift = (k: RigcKey, off: number): RigcKey => {
    const out: RigcKey = { ...k, t: r6(off + k.t) };
    if (Array.isArray(k.curve)) out.curve = k.curve.map((x, i) => (i % 2 === 0 ? r6(off + x) : x));
    return out;
  };
  const hold = (k: RigcKey): void => {
    if (nature) return;
    delete k.curve;
    k.ease = 'stepped';
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: RigcKey[] = [];
  const jumps: number[] = [];
  let cycles = 0;
  for (let k = 0; k * D <= T + EPS; k++) {
    const off = k * D;
    if (k > 0) {
      const prev = out[out.length - 1]!;
      const opens: unknown = first > EPS ? setupKey : keys[0]!.v;
      if (prev.t >= r6(off) - EPS) {
        // The key that ends the last cycle sits on the seam: the loop shows the next cycle's start there.
        out.pop();
        if (!same(prev.v, opens)) jumps.push(r6(off));
      } else hold(prev);
      if (first > EPS) {
        const s: RigcKey = { t: r6(off), v: setupKey };
        if (!nature) s.ease = 'stepped';
        out.push(s);
      }
    }
    for (const key of keys) out.push(shift(key, off));
    cycles++;
    if (out[out.length - 1]!.t > T + EPS) break;
  }

  // The cut at T.
  const kept = out.filter((x) => x.t <= T + EPS);
  if (kept.length === 0) return { reason: `its first key, at t=${first}s, is past the new animation's ${T}s` };
  for (const x of kept) if (Math.abs(x.t - T) <= EPS) x.t = T;
  const after = out[kept.length];
  const end = kept[kept.length - 1]!;
  if (after !== undefined && end.t < T - EPS && !nature) {
    const c = cutAt(end, after, T, easings);
    if ('reason' in c) return c;
    kept.push({ t: T, v: c.v });
  }
  const tail = kept[kept.length - 1]!;
  delete tail.ease;
  delete tail.curve;
  const seams = jumps.length === 0 ? null : `the idle's last key (t=${last}s, ${JSON.stringify(keys[keys.length - 1]!.v)}) is not what it shows at its start (${JSON.stringify(first > EPS ? setupKey : keys[0]!.v)}); the loop keys the start at each seam, so it jumps at t=${jumps.map((t) => t.toFixed(3)).join(', ')}s`;
  return { track: { ...track, keys: kept }, cycles, seams };
}

/**
 * The value at `T` inside the segment from `a` to `b`, and `a`'s segment cut
 * there: stepped holds `a`; linear interpolates; a Bézier (a raw `curve`, or a
 * named easing turned into one as rigc turns it, AUTHORING §4.1) is split at
 * `T` by de Casteljau, so the part kept is the same curve.
 */
function cutAt(a: RigcKey, b: RigcKey, T: number, easings: Readonly<Record<string, readonly number[]>>): { v: number[] } | { reason: string } {
  const va = a.v as number[];
  const vb = b.v as number[];
  if (a.ease === 'stepped') return { v: [...va] };
  let curve: number[] | null = null;
  if (Array.isArray(a.curve)) curve = a.curve;
  else if (typeof a.ease === 'string') {
    const h = easings[a.ease];
    if (h === undefined || h.length !== 4) return { reason: `its easing "${a.ease}" is not in the motion spec's easings` };
    curve = va.flatMap((v0, c) => [a.t + (b.t - a.t) * h[0]!, v0 + (vb[c]! - v0) * h[1]!, a.t + (b.t - a.t) * h[2]!, v0 + (vb[c]! - v0) * h[3]!]);
  }
  if (curve === null) return { v: va.map((v0, c) => r6(v0 + ((T - a.t) / (b.t - a.t)) * (vb[c]! - v0))) };
  const kept: number[] = [];
  const v: number[] = [];
  va.forEach((v0, c) => {
    const [x1, y1, x2, y2] = curve.slice(c * 4, c * 4 + 4) as [number, number, number, number];
    const bez = (p0: number, p1: number, p2: number, p3: number, s: number) => {
      const u = 1 - s;
      return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3;
    };
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (bez(a.t, x1, x2, b.t, mid) < T) lo = mid;
      else hi = mid;
    }
    const s = (lo + hi) / 2;
    const lerp = (p: number, q: number) => p + (q - p) * s;
    const split = (p0: number, p1: number, p2: number, p3: number): [number, number, number] => {
      const p01 = lerp(p0, p1);
      const p12 = lerp(p1, p2);
      const p23 = lerp(p2, p3);
      const p012 = lerp(p01, p12);
      return [p01, p012, lerp(p012, lerp(p12, p23))];
    };
    const xs = split(a.t, x1, x2, b.t);
    const ys = split(v0, y1, y2, vb[c]!);
    kept.push(r6(xs[0]), r6(ys[0]), r6(xs[1]), r6(ys[1]));
    v.push(r6(ys[2]));
  });
  delete a.ease;
  a.curve = kept;
  return { v };
}

/** The setup value a key states for a bone's translate, scale, shear and rotate (`numbers` channels), or undefined. */
export function boneIdentity(property: string, channels: number): number[] | undefined {
  const v = BONE_IDENTITY[property];
  return v === undefined ? undefined : Array.from({ length: channels }, () => v);
}

// --- the fragment ------------------------------------------------------------

export const FRAGMENT_SPEC = 'rig-pose-tracks/1';

/**
 * A `rig-pose-tracks/1` fragment: `{ "spec": "rig-pose-tracks/1", "tracks": [ … ] }`,
 * each a rigc-motion track at absolute times from the animation's start. The
 * shape is read here (one target, a property, keys with a time); what a track
 * means is rigc's gate's to judge.
 */
export function readFragment(doc: unknown, where: string): RigcTrack[] {
  const p = new Problems();
  if (!isObject(doc) || doc.spec !== FRAGMENT_SPEC || !Array.isArray(doc.tracks)) {
    p.add('MERGE_SPEC', `${where}: "spec" is ${isObject(doc) ? typeName(doc.spec) : typeName(doc)} and "tracks" ${isObject(doc) ? typeName(doc.tracks) : '-'}; a fragment is { "spec": "${FRAGMENT_SPEC}", "tracks": [ <rigc-motion track> … ] }`);
    p.throwIfAny();
  }
  const tracks = (doc as { tracks: unknown[] }).tracks;
  if (tracks.length === 0) p.add('MERGE_SPEC', `${where}: "tracks" is empty; a fragment adds at least one track`);
  tracks.forEach((tr, i) => {
    const at = `${where} tracks[${i}]`;
    if (!isObject(tr)) {
      p.add('MERGE_SPEC', `${at} is ${typeName(tr)}; a track is an object`);
      return;
    }
    const fields = TARGET_FIELDS.filter((f) => tr[f] !== undefined);
    if (fields.length !== 1 || typeof tr[fields[0]!] !== 'string') p.add('MERGE_SPEC', `${at} names ${fields.length === 0 ? 'no target' : fields.map((f) => `"${f}" (${typeName(tr[f])})`).join(' and ')}; a track names exactly one of ${TARGET_FIELDS.join(', ')}, as a string`);
    if (typeof tr.property !== 'string') p.add('MERGE_SPEC', `${at} "property" is ${typeName(tr.property)}; it is the timeline's name, a string`);
    if (!Array.isArray(tr.keys) || tr.keys.length === 0) {
      p.add('MERGE_SPEC', `${at} "keys" is ${typeName(tr.keys)}; it is a non-empty array of { "t": <seconds>, "v": … }`);
      return;
    }
    tr.keys.forEach((k, j) => {
      if (!isObject(k) || typeof k.t !== 'number' || !Number.isFinite(k.t)) p.add('MERGE_SPEC', `${at} keys[${j}] ${isObject(k) ? `"t" is ${typeName(k.t)}` : `is ${typeName(k)}`}; a key states its time "t" in seconds`);
    });
  });
  p.throwIfAny();
  return tracks as RigcTrack[];
}

/**
 * A fragment against the new animation: a track posing a channel the animation
 * (or an earlier fragment track) already keys is MERGE_CONFLICT, and a key
 * before 0 or past the duration is MERGE_TIME — each named.
 */
export function mergeProblems(fragment: readonly RigcTrack[], where: string, animation: string, tracks: readonly RigcTrack[], duration: number, groups: Readonly<Record<string, readonly string[]>>): Problem[] {
  const out: Problem[] = [];
  const keyed = keyedBy(tracks, groups);
  fragment.forEach((tr, i) => {
    const label = trackLabel(tr, groups);
    const hitCells = collisionCells(tr, keyed, groups);
    if (hitCells.length > 0) {
      const hit = [...new Set(hitCells.map((x) => x.by))];
      const channels = [...new Set(hitCells.map((x) => x.cell.split(':')[2]!))];
      const channelSuffix = tr.property in SLOT_CHANNELS ? ` (channel ${channels.map((c) => `"${c}"`).join(', ')})` : '';
      out.push({ code: 'MERGE_CONFLICT', text: `${where} tracks[${i}] (${label}) — "${animation}" already keys it: ${hit.join(', ')}${channelSuffix}; a fragment adds a track where nothing keys that target and property, it never replaces one` });
    }
    for (const c of cellsOf(tr, groups)) if (!keyed.has(c)) keyed.set(c, `${where} tracks[${i}] (${label})`);
    tr.keys.forEach((k, j) => {
      if (k.t < 0 || k.t > duration) out.push({ code: 'MERGE_TIME', text: `${where} tracks[${i}] (${label}) keys[${j}] at t=${k.t}s is ${k.t < 0 ? 'before 0' : `past "${animation}"'s duration ${duration}s`}; a fragment's times are absolute, from the animation's start, within [0, ${duration}]` });
    });
  });
  return out;
}

// --- lines ---------------------------------------------------------------

const targetText = (t: Target, members: readonly string[] | null) => `${t.kind} "${t.name}"${members !== null && members.length > 0 ? ` (${members.join(', ')})` : ''}`;

export function droppedLine(d: IdleDropped, animation: string, carry: boolean, duration: number): string {
  const head = `${targetText(d.target, d.members)} ${d.property}: ${d.keys} key(s) over the idle's ${d.duration.toFixed(3)}s; "${animation}" does not key it`;
  if (!carry) return `${head} — not carried (no --carry-idle)`;
  if (d.carried !== null) return `${head} — carried: ${d.carried.keys} key(s), ${d.carried.cycles} cycle(s), cut at ${duration.toFixed(3)}s${d.carried.seams === null ? '' : `; ${d.carried.seams}`}`;
  return `${head} — not carried: ${d.notCarried}`;
}

export function keptOutLine(k: IdleKeptOut): string {
  return `${targetText(k.target, null)} ${k.property}: ${k.reason}, so the idle's track is not carried`;
}
