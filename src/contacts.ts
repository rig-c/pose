/**
 * `--contact-keys` (rig-c/pose#303): the support declared by hand, frame by
 * frame, for a clip no reading gets right — a drawn frontal walk. Seen from the
 * front, depth is drawn as height, so the ground is a band in the picture and
 * the nearer foot is drawn lower (#303's reading: no single floor line matches a
 * contact table); a slow drawn walk can also step under the vertical speed's
 * still tolerance, so #280 never takes over. The artist's key sheet already
 * carries the contact table: these keys are that data, not a guess.
 *
 * `rig-pose-contact-keys/1`: `{ spec, keys: [{ frame, side }], note? }`, `side`
 * one of `l | r | both | none`. Frames are the sequence's, may be fractional (a
 * key sheet timed off the frame grid, as `--pelvis-keys`, #294), and strictly
 * increase within [0, frames − 1].
 *
 * **A key holds until the next one** (a step function; the last holds to the
 * clip's end). Contact is a state, not an angle: a foot is down or it is not, and
 * there is no value between `l` and `r` to interpolate. A key at a fractional
 * frame takes effect on the first frame at or after it. Frames before the first
 * key are not covered: the support there is the reading without keys.
 *
 * Precedence: on every covered frame the keys decide, over #280's vertical
 * speed (a frontal clip) and ankle height. `l`/`r`: that foot supports. `none`:
 * flight, no foot supports. `both`: the foot that landed supports, as #280 hands
 * over on landing. The run's neighbours are read from the keys, not the frames,
 * so a key that reaches no frame counts (rig-c/pose#338): after an `l` or `r`
 * key, the other side; after a `none` key (flight), or where the run starts the
 * cover, the side the next `l` or `r` key names (the side that stays down after);
 * else, at the cover's start, the support on the frame before (the reading
 * without keys); a run none of those name keeps the reading without keys (`kept`).
 */
import type { Feet, Side } from './legs.ts';
import { isObject, parseJson, Problems, refuseUnknownKeys, typeName } from './problems.ts';

export const CONTACT_KEYS_SPEC = 'rig-pose-contact-keys/1';

/** A contact key's value: the foot down, both, or none (flight). */
export type ContactSide = Side | 'both' | 'none';
const VALUES: readonly ContactSide[] = ['l', 'r', 'both', 'none'];

export interface ContactKeys {
  /** The file's keys, as read: strictly increasing frames within the sequence's span. */
  keys: Array<{ frame: number; side: ContactSide }>;
  /** Per frame, the key in force (the last key at or before the frame), or null before the first key. */
  key: Array<ContactSide | null>;
  /** The frames of keys no frame takes: the next key comes before the next whole frame (two keys between two frames). */
  unreached: number[];
}

/**
 * `rig-pose-contact-keys/1`, read against a sequence of `frames` frames. Every
 * problem is collected and refused by name (`CONTACT_KEYS`): a file that is not
 * JSON or not the shape, a `spec` that is not this one, a `side` outside the
 * four, a frame outside [0, frames − 1], a frame not after the key before it.
 */
export function readContactKeys(text: string, where: string, frames: number): ContactKeys {
  const doc = parseJson(text, where, 'CONTACT_KEYS');
  const p = new Problems();
  const shape = `{ "spec": "${CONTACT_KEYS_SPEC}", "keys": [{ "frame", "side" }], "note"? }`;
  if (!isObject(doc)) {
    p.add('CONTACT_KEYS', `${where} is ${typeName(doc)}; it must be ${shape}`);
    p.throwIfAny();
    throw new Error('unreachable');
  }
  refuseUnknownKeys(p, 'CONTACT_KEYS', where, doc, ['spec', 'keys', 'note']);
  if (doc.spec !== CONTACT_KEYS_SPEC) p.add('CONTACT_KEYS', `${where} "spec" is ${typeName(doc.spec)}; it must be "${CONTACT_KEYS_SPEC}"`);
  if ('note' in doc && typeof doc.note !== 'string') p.add('CONTACT_KEYS', `${where} "note" is ${typeName(doc.note)}; it must be a string`);
  const keys: ContactKeys['keys'] = [];
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) p.add('CONTACT_KEYS', `${where} "keys" is ${typeName(doc.keys)}; it must be a non-empty array of { frame, side }`);
  else doc.keys.forEach((k: unknown, i: number) => {
    const kw = `${where} keys[${i}]`;
    if (!isObject(k)) {
      p.add('CONTACT_KEYS', `${kw} is ${typeName(k)}; a key is { frame, side }`);
      return;
    }
    refuseUnknownKeys(p, 'CONTACT_KEYS', kw, k, ['frame', 'side']);
    const okF = typeof k.frame === 'number' && Number.isFinite(k.frame) && k.frame >= 0 && k.frame <= frames - 1;
    const okS = typeof k.side === 'string' && (VALUES as readonly string[]).includes(k.side);
    if (!okF) p.add('CONTACT_KEYS', `${kw} "frame" is ${typeName(k.frame)}; it must be a frame of the sequence in [0, ${frames - 1}] (fractional allowed)`);
    if (!okS) p.add('CONTACT_KEYS', `${kw} "side" is ${typeName(k.side)}; it must be one of l, r, both, none (the foot down, both feet, or flight)`);
    if (!okF || !okS) return;
    const prev = keys[keys.length - 1];
    if (prev !== undefined && (k.frame as number) <= prev.frame) p.add('CONTACT_KEYS', `${kw} "frame" is ${k.frame as number}, not after the key before it (${prev.frame}); frames strictly increase`);
    else keys.push({ frame: k.frame as number, side: k.side as ContactSide });
  });
  p.throwIfAny();
  const key: Array<ContactSide | null> = [];
  const reached = new Set<number>();
  let at = -1;
  for (let i = 0; i < frames; i++) {
    while (at + 1 < keys.length && keys[at + 1]!.frame <= i) at++;
    key.push(at < 0 ? null : keys[at]!.side);
    if (at >= 0) reached.add(at);
  }
  return { keys, key, unreached: keys.filter((_, k) => !reached.has(k)).map((k) => k.frame) };
}

/** rig-c/pose#303: what the contact keys did to a clip's support, set on `Feet` by `contactKeysOf`. */
export interface ContactKeysReading {
  keys: ContactKeys['keys'];
  /** Per frame, the key in force, or null before the first key. */
  key: Array<ContactSide | null>;
  /** The first frame a key covers; every frame from it to the last is covered. */
  from: number;
  /** Per frame, the support read without the keys (#280's or ankle height's). */
  before: Array<Side | null>;
  /** Per frame, whether a key decided its support (false outside the cover, and on a `both` run no side names, `kept`). */
  keyed: boolean[];
  /** The frames of `both` runs that keep the reading without keys: no keyed support before, no single-foot key after. */
  kept: number[];
  /** Runs of frames whose support the keys changed: the support without them (`was`) and with them (`now`; null: flight). */
  changed: Array<{ frames: [number, number]; was: Side | null; now: Side | null }>;
  /** As `ContactKeys.unreached`. */
  unreached: number[];
}

/**
 * The support with the contact keys applied, last, over the reading `supportsOf`
 * made (the header's precedence), then rebuilt as #280's frontal reading
 * rebuilds it: support spans and changes from the per-frame support. Outside
 * the cover the support is the reading without keys, unchanged. A step that
 * released a plant (report only) and #113's `lowered` and #119's `tracked` runs
 * are kept where they start before the cover, cut at the frame before it
 * (rig-c/pose#338; a step's re-plant inside the cover is not read, null): inside
 * it a plant ends where the keys hand support over. Jumps are kept as read (the
 * hip's rise); on a jump frame a key still decides the support.
 */
export function contactKeysOf(feet: Feet, keys: ContactKeys): Feet {
  const n = feet.support.length;
  const before = feet.support.map((s) => s ?? null);
  const support = [...before];
  const keyed = new Array<boolean>(n).fill(false);
  const kept: number[] = [];
  const other = (s: Side): Side => (s === 'r' ? 'l' : 'r');
  const from = keys.key.findIndex((k) => k !== null);
  /** Per frame, the index in `keys.keys` of the key in force (−1 before the first). */
  const at: number[] = [];
  for (let i = 0, k = -1; i < n; i++) {
    while (k + 1 < keys.keys.length && keys.keys[k + 1]!.frame <= i) k++;
    at.push(k);
  }
  for (let i = 0; i < n; i++) {
    const k = keys.key[i] ?? null;
    if (k === null) continue;
    if (k !== 'both') {
      support[i] = k === 'none' ? null : k;
      keyed[i] = true;
      continue;
    }
    let b = i;
    while (b + 1 < n && keys.key[b + 1] === 'both') b++;
    // rig-c/pose#338: the states either side come from the keys themselves, not from the frames — a key that reaches no frame (none@1.1 before both@1.2) is the state the run follows.
    let k0 = at[i]!;
    while (k0 > 0 && keys.keys[k0 - 1]!.side === 'both') k0--;
    let k1 = at[b]! + 1;
    while (k1 < keys.keys.length && keys.keys[k1]!.side === 'both') k1++;
    const prevSide = k0 > 0 ? keys.keys[k0 - 1]!.side : null;
    const nextSide = k1 < keys.keys.length ? keys.keys[k1]!.side : null;
    const landed: Side | null = prevSide === 'r' || prevSide === 'l' ? other(prevSide) : nextSide === 'r' || nextSide === 'l' ? nextSide : prevSide === null && i > 0 ? support[i - 1]! : null;
    for (let f = i; f <= b; f++) {
      if (landed === null) kept.push(f);
      else {
        support[f] = landed;
        keyed[f] = true;
      }
    }
    i = b;
  }
  const supports: Feet['supports'] = [];
  const changes: Feet['changes'] = [];
  const changed: ContactKeysReading['changed'] = [];
  for (let i = 0; i < n; i++) {
    const s = support[i] ?? null;
    if (s !== before[i]) {
      const last = changed[changed.length - 1];
      if (last !== undefined && last.frames[1] === i - 1 && last.was === before[i] && last.now === s) last.frames[1] = i;
      else changed.push({ frames: [i, i], was: before[i]!, now: s });
    }
    if (s === null) continue;
    const prev = i > 0 ? (support[i - 1] ?? null) : null;
    if (prev !== s) changes.push({ frame: i, from: prev, to: s });
    const last = supports[supports.length - 1];
    if (last !== undefined && last.side === s && last.frames[1] === i - 1) last.frames[1] = i;
    else supports.push({ side: s, frames: [i, i] });
  }
  const cut = <T extends { frames: [number, number] }>(runs: readonly T[] | undefined): T[] => (runs ?? []).filter((r) => r.frames[0] < from).map((r) => ({ ...r, frames: [r.frames[0], Math.min(r.frames[1], from - 1)] as [number, number] }));
  const lowered = feet.lowered === undefined ? undefined : cut(feet.lowered);
  const tracked = feet.tracked === undefined ? undefined : cut(feet.tracked);
  return {
    legLength: feet.legLength,
    support,
    supports,
    jumps: feet.jumps,
    // rig-c/pose#338: a step running into the cover ends on the frame before it, as lowered and tracked do; a re-plant inside the cover is the keys' to decide, so it is not read (null).
    steps: cut(feet.steps).map((s) => (s.replant !== null && s.replant >= from ? { ...s, replant: null } : s)),
    changes,
    ...(lowered !== undefined && lowered.length > 0 ? { lowered } : {}),
    ...(tracked !== undefined && tracked.length > 0 ? { tracked } : {}),
    ...(feet.signal !== undefined ? { signal: feet.signal } : {}),
    contactKeys: { keys: keys.keys, key: keys.key, from, before, keyed, kept, changed, unreached: keys.unreached },
  };
}

/** The signal names a stride line uses for the frames a key did not decide. */
const SIGNAL_NAMES: Record<string, string> = { speed: 'ankle vertical speed', height: 'ankle height' };

/**
 * The FEET lines of a run with contact keys (rig-c/pose#303), in place of #280's
 * stride lines: one `support: contact keys` line — the keys, the frames they
 * cover, how many they changed, the flight they declare, what stands outside —
 * then one `stride` line per support span naming the signal that decided its
 * frames (`contact keys`, else the reading without keys) and what that reading
 * alone would have named.
 */
export function contactKeysLines(feet: Feet): string[] {
  const c = feet.contactKeys;
  if (c === undefined) return [];
  const n = feet.support.length;
  const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
  const changed = c.changed.reduce((s, r) => s + r.frames[1] - r.frames[0] + 1, 0);
  const flight = c.key.filter((k) => k === 'none').length;
  const tail = [
    ...(flight > 0 ? [`${flight} keyed none (flight, no foot supports)`] : []),
    ...(c.kept.length > 0 ? [`${c.kept.length} keyed both with no side to hold (no keyed support before, no single-foot key after) keep it`] : []),
    ...(c.from > 0 ? [`frames ${span([0, c.from - 1])}, before the first key, keep it`] : []),
    ...(c.unreached.length > 0 ? [`key(s) at ${c.unreached.join(', ')} reach no frame (the next key comes first)`] : []),
  ];
  const out = [`support: contact keys (rig-c/pose#303, --contact-keys) — ${c.keys.length} key(s) cover frames ${span([c.from, n - 1])} of ${n}, each holding until the next one; they change the reading without them on ${changed} frame(s)${tail.length > 0 ? `; ${tail.join('; ')}` : ''}`];
  const by = feet.signal?.by;
  for (const sp of feet.supports) {
    let keyed = 0;
    let differ = 0;
    const rest = new Map<string, number>();
    const was = new Set<string>();
    for (let i = sp.frames[0]; i <= sp.frames[1]; i++) {
      if (c.keyed[i]) keyed++;
      else {
        const name = SIGNAL_NAMES[by?.[i] ?? 'height'] ?? 'ankle height';
        rest.set(name, (rest.get(name) ?? 0) + 1);
      }
      if (c.before[i] !== sp.side) {
        differ++;
        was.add(c.before[i] ?? 'none');
      }
    }
    const parts = [...(keyed > 0 ? [`contact keys ${keyed}`] : []), ...[...rest].map(([k, v]) => `${k} ${v}`)];
    const alone = differ === 0 ? 'the reading without keys names the same' : `the reading without keys would name ${[...was].join(' or ')} on ${differ} of them`;
    out.push(`stride ${sp.side} ${span(sp.frames)}: of ${sp.frames[1] - sp.frames[0] + 1} frame(s), decided by ${parts.join(', ')}; ${alone}`);
  }
  return out;
}
