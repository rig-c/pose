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
}

const NOT_TRACKS = ['drawOrder', 'events', 'ik', 'transform', 'deform', 'sequence'] as const;

/**
 * The idle against the new animation: every idle track the new one does not
 * key on any channel is dropped (and, with `carry`, looped into it); every one
 * it keys is kept out, naming the track that keys it.
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
  for (const tr of tracks) {
    const target = targetOf(tr);
    if (target === null) continue;
    const hit = collisions(tr, keyed, motion.groups);
    if (hit.length > 0) {
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
  return { animation: name, duration: D, tracks: tracks.length, dropped, keptOut, notTracks, carriedTracks };
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
/** Two times this close are one time (key times are written to 1e-6 s). */
const EPS = 1e-7;

const numeric = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

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
    const hit = collisions(tr, keyed, groups);
    if (hit.length > 0) out.push({ code: 'MERGE_CONFLICT', text: `${where} tracks[${i}] (${label}) — "${animation}" already keys it: ${hit.join(', ')}; a fragment adds a track where nothing keys that target and property, it never replaces one` });
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
