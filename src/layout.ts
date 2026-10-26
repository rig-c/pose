/**
 * The limb layout (rig-c/pose#346): `--draw-order depth` also keys each forearm
 * against the trunk, from @rig-c/parts' `layout.json` companion and a binding in
 * the map.
 *
 * - **The companion.** `rig-parts-layout/1`, written by `rig-parts rig` beside
 *   `rig.json` when the config declares a limb `layout` (parts#647):
 *   `{ spec, rig: { file: "rig.json", sha256 }, sets?: { file: "sets.json",
 *   sha256 }, setup_slots, placements: [{ limb, parts, before | after, slots,
 *   target_slots }] }`. Each placement is one declared group: the slots of a
 *   limb's segment parts (`slots`), drawn immediately before or after a
 *   stationary target block (`target_slots`, a `{ limb }` or `{ part }`).
 *   It is read only with `--draw-order depth`, and only when it is beside the
 *   rig. It is read whole or refused: its `rig.sha256` must be the SHA-256 of
 *   the `rig.json` bytes this run reads (`LAYOUT_RIG_SHA`), its `sets` the
 *   `sets.json` beside it, or none when there is none (`LAYOUT_SETS_SHA`), its
 *   `setup_slots` the rig's slots in order (`LAYOUT_SETUP`). The producer's
 *   adjacency is not taken as proof: pose reads each placement's blocks in the
 *   rig's compiled draw order again. Blocks must be unbroken and adjacent, except
 *   explicitly bound forearms against a mapped hip-line target (#431). Those
 *   may be separated and share an identical target; their declared setup side
 *   must still match. Only the forearms move, preserving every other slot
 *   pair's relative order (including the legs).
 * - **The binding.** The map names each group's depth source explicitly, in
 *   `"layout": [{ "limb", "parts", "depth", "against" }]`: `limb` and `parts`
 *   the placement's own (exactly), `depth` the body-18 segment whose depth the
 *   group follows, `against` what its target is. This reader keys `depth`
 *   `r_forearm` or `l_forearm` `against` `"trunk"` (the shoulders' and hips'
 *   plane, depth 0): any other is refused when the map is read (`MAP_LAYOUT`).
 *   A placement the map does not bind is refused by name (`LAYOUT_UNBOUND`);
 *   pose does not find a source by its name, a nearest bone or a zero depth. A
 *   binding no placement has is refused (`LAYOUT_BINDING_UNKNOWN`), and so is a
 *   map binding with no companion beside the rig (`LAYOUT_MISSING`). Each slot
 *   of a bound group must hang on the bone the map gives the segment (or under
 *   it, through no other chain's bone), and no target slot on a limb's
 *   (`LAYOUT_BINDING_BONES`).
 * - **The rule.** Per frame, the forearm's depth: what its segment adds to the
 *   wrist over the elbow, sign × rest × √(1 − ratio²) px (#281's
 *   `segmentDepth`; + toward the camera). In front of its target where that
 *   depth is toward the camera by at least the tie, behind it otherwise, for
 *   adjacent chest targets; an unnamed segment holds setup there. At an explicit
 *   hip-line target (#434), only nonzero depth at or beyond the signed tie
 *   decides front or back; inside the tie or unread holds the previous order.
 *   Leading undecided frames use setup, or the final decided order on a loop.
 *   An entirely undecided clip retains setup. The tie is the
 *   legs' (#281, #336), scaled to what is read: √(1 − 0.95²) × the forearm's
 *   rest length, what a forearm inside the flat band can hide. The forearm's
 *   own lean is read, not the wrist's depth from the shoulder: the trunk is
 *   near the picture plane through the shoulder, and the upper arm's derived
 *   sign is a gait's reading, not a measurement (rig-c/pose#358: a sign says
 *   which way a segment points, not which part is nearer). A group's block and
 *   its target change places in their run; a key is written where the whole
 *   order changes, half a frame before the frame it shows on, as the legs'
 *   (`keyAtFrame`). The legs' keys are complete statements, and a group's run
 *   is kept apart from a keyed leg pair's (else the group is not keyed), so
 *   the two merge into one timeline. For an explicit hip-line target, the trunk
 *   includes pelvis art (#431): the map's consecutive r_hip/l_hip joints identify
 *   its bone, not a slot name. Nonadjacent forearms compose over the legs' total
 *   order and are encoded once against setup. No layout means an explicit
 *   not-keyed reading, with no target guessed.
 *
 * Pure but for `readLayout`, which reads the files beside the rig.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Body18 } from './joints.ts';
import { segmentDepth } from './depth.ts';
import type { DrawOrderKey, DrawOrderOffset, DrawOrderReading } from './draworder.ts';
import type { JointMap, Rest } from './map.ts';
import { DEPTH_SEGMENTS, type DepthSegment, type FrameDepth, type Joint } from './pose.ts';
import { isObject, parseJson, Problems, refuseUnknownKeys, typeName } from './problems.ts';
import { keyAtFrame } from './switch.ts';
import { groupName, LAYOUT_DEPTHS, sameList, stringList, type LayoutAgainst, type LayoutBinding, type LayoutDepth } from './layoutmap.ts';

export { groupName, LAYOUT_AGAINST, LAYOUT_DEPTHS, readLayoutBindings, type LayoutAgainst, type LayoutBinding, type LayoutDepth } from './layoutmap.ts';

export const LAYOUT_FILE = 'layout.json';
export const LAYOUT_SPEC = 'rig-parts-layout/1';
/** √(1 − 0.95²): what a segment inside the flat band can hide, per unit of its rest length (the legs' tie, #281). */
const TIE_PER_LENGTH = Math.sqrt(1 - 0.95 * 0.95);
/** The group lines' cap, characters (the DRAWORDER lines'). */
const LINE_MAX = 260;

export type LayoutTarget = { limb: string } | { part: string };
export interface LayoutPlacement {
  limb: string;
  parts: string[];
  before?: LayoutTarget;
  after?: LayoutTarget;
  slots: string[];
  target_slots: string[];
}
export interface Layout {
  /** The companion's path, and the SHA-256 of its bytes. */
  path: string;
  sha256: string;
  setup: string[];
  placements: LayoutPlacement[];
}
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const targetText = (t: LayoutTarget): string => ('limb' in t ? `limb "${t.limb}"` : `part "${t.part}"`);

/**
 * The companion beside the rig, read and validated against the bytes this run reads; null when there is none.
 * `rig` is the rig.json path; its `slots` (the setup order) are read from those same bytes.
 */
export function readLayout(rig: string): Layout | null {
  const dir = dirname(rig);
  const path = join(dir, LAYOUT_FILE);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const doc = parseJson(bytes.toString('utf8'), path, 'LAYOUT_JSON');
  const p = new Problems();
  if (!isObject(doc) || doc.spec !== LAYOUT_SPEC) {
    p.add('LAYOUT_SPEC', `${path} is not a ${LAYOUT_SPEC} companion: "spec" is ${isObject(doc) ? typeName(doc.spec) : typeName(doc)}`);
    p.throwIfAny();
  }
  const d = doc as Record<string, unknown>;
  refuseUnknownKeys(p, 'LAYOUT_SHAPE', path, d, ['spec', 'rig', 'sets', 'setup_slots', 'placements']);
  const hashOf = (k: 'rig' | 'sets', file: string): string | null => {
    const v = d[k];
    if (!isObject(v) || v.file !== file || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) {
      p.add('LAYOUT_SHAPE', `${path} "${k}" is ${JSON.stringify(v) ?? typeName(v)}; it is { "file": "${file}", "sha256": <64 hex> }`);
      return null;
    }
    refuseUnknownKeys(p, 'LAYOUT_SHAPE', `${path} "${k}"`, v, ['file', 'sha256']);
    return v.sha256;
  };
  const rigBytes = readFileSync(rig);
  const rigSha = hashOf('rig', 'rig.json');
  const rigHave = sha(rigBytes);
  if (rigSha !== null && rigSha !== rigHave) p.add('LAYOUT_RIG_SHA', `${path} is bound to rig.json sha256 ${rigSha}, and ${rig} is ${rigHave}: the layout was written for other rig bytes (rig-parts rig writes both); a stale layout is not read`);
  const setsPath = join(dir, 'sets.json');
  if ('sets' in d) {
    const want = hashOf('sets', 'sets.json');
    if (want !== null) {
      if (!existsSync(setsPath)) p.add('LAYOUT_SETS_SHA', `${path} is bound to sets.json sha256 ${want}, and there is no ${setsPath}`);
      else if (sha(readFileSync(setsPath)) !== want) p.add('LAYOUT_SETS_SHA', `${path} is bound to sets.json sha256 ${want}, and ${setsPath} is ${sha(readFileSync(setsPath))}: the layout was written for other set bytes`);
    }
  } else if (existsSync(setsPath)) p.add('LAYOUT_SETS_SHA', `${path} is bound to no sets.json, and ${setsPath} is beside the rig: the layout was written for a rig without those sets`);
  const rigDoc = parseJson(rigBytes.toString('utf8'), rig, 'RIG_JSON');
  const rigSlots = isObject(rigDoc) && Array.isArray(rigDoc.slots) ? rigDoc.slots.map((s: unknown) => (isObject(s) && typeof s.name === 'string' ? s.name : '')) : [];
  const setup = stringList(d.setup_slots) ? d.setup_slots : null;
  if (setup === null) p.add('LAYOUT_SHAPE', `${path} "setup_slots" is ${typeName(d.setup_slots)}; it is the rig's slot names in setup order`);
  else if (!sameList(setup, rigSlots)) p.add('LAYOUT_SETUP', `${path} "setup_slots" (${setup.length}) is not ${rig}'s slots in order (${rigSlots.length}); first difference at index ${setup.findIndex((s, i) => s !== rigSlots[i])}`);
  const placements: LayoutPlacement[] = [];
  if (!Array.isArray(d.placements)) p.add('LAYOUT_SHAPE', `${path} "placements" is ${typeName(d.placements)}; it is an array`);
  else
    d.placements.forEach((x: unknown, i: number) => {
      const pw = `${path} placements[${i}]`;
      if (!isObject(x)) return p.add('LAYOUT_SHAPE', `${pw} is ${typeName(x)}; a placement is { limb, parts, before | after, slots, target_slots }`);
      refuseUnknownKeys(p, 'LAYOUT_SHAPE', pw, x, ['limb', 'parts', 'before', 'after', 'slots', 'target_slots']);
      const target = (v: unknown): LayoutTarget | null => (isObject(v) && Object.keys(v).length === 1 && typeof (v.limb ?? v.part) === 'string' ? (typeof v.limb === 'string' ? { limb: v.limb } : { part: v.part as string }) : null);
      const side = 'before' in x === 'after' in x ? null : 'before' in x ? 'before' : 'after';
      const t = side === null ? null : target(x[side]);
      if (typeof x.limb !== 'string' || !stringList(x.parts) || side === null || t === null || !stringList(x.slots) || !stringList(x.target_slots)) {
        return p.add('LAYOUT_SHAPE', `${pw} is ${JSON.stringify(x)}; a placement is { "limb", "parts": [...], exactly one of "before" / "after": { "limb" } | { "part" }, "slots": [...], "target_slots": [...] }`);
      }
      placements.push({ limb: x.limb, parts: [...x.parts], [side]: t, slots: [...x.slots], target_slots: [...x.target_slots] });
    });
  p.throwIfAny();
  return { path, sha256: sha(bytes), setup: setup!, placements };
}

/** Each placement's adjacency, read again in the rig's compiled draw order: problems by name (the producer's word is not taken). */
function adjacencyProblems(p: Problems, layout: Layout, names: readonly string[], pelvis: ReadonlySet<string>): void {
  const seen = new Map<string, LayoutPlacement>();
  for (const pl of layout.placements) {
    const where = `${layout.path}: ${groupName(pl)} ${pl.before !== undefined ? `before ${targetText(pl.before)}` : `after ${targetText(pl.after!)}`}`;
    const idx = (ns: readonly string[]) => ns.map((n) => names.indexOf(n));
    const [s, t] = [idx(pl.slots), idx(pl.target_slots)];
    const run = (ix: number[]) => ix.every((v, i) => v >= 0 && (i === 0 || v === ix[i - 1]! + 1));
    const missing = [...pl.slots, ...pl.target_slots].filter((n) => !names.includes(n));
    if (missing.length > 0) p.add('LAYOUT_ADJACENCY', `${where}: slot(s) ${missing.map((n) => `"${n}"`).join(', ')} are not in the rig's draw order`);
    else if (!run(s) || !run(t)) p.add('LAYOUT_ADJACENCY', `${where}: its ${run(s) ? 'target' : 'group'} slots (${(run(s) ? pl.target_slots : pl.slots).join(', ')}) are not one unbroken run of the rig's draw order`);
    else if (pl.before !== undefined ? s[s.length - 1]! + 1 !== t[0] : t[t.length - 1]! + 1 !== s[0]) {
      // #431: only an explicitly bound hip-line target may be separated from its forearm.
      // The declared setup side must still be true; no other adjacency rule is relaxed.
      const separated = pl.before !== undefined ? s[s.length - 1]! < t[0]! : t[t.length - 1]! < s[0]!;
      if (!separated || !pl.target_slots.every((n) => pelvis.has(n))) p.add('LAYOUT_ADJACENCY', `${where}: the group is not drawn immediately ${pl.before !== undefined ? 'before' : 'after'} its target in the rig's draw order`);
    }
    for (const n of [...pl.slots, ...pl.target_slots]) {
      const other = seen.get(n);
      const sharedPelvis = other !== undefined && pl.target_slots.includes(n) && other.target_slots.includes(n) && !pl.slots.includes(n) && !other.slots.includes(n) && sameList(pl.target_slots, other.target_slots) && pl.target_slots.every((x) => pelvis.has(x));
      if (other !== undefined && !sharedPelvis) p.add('LAYOUT_ADJACENCY', `${where}: slot "${n}" is also in ${groupName(other)}; placements are disjoint except for an identical hip-line target`);
      else seen.set(n, pl);
    }
  }
}

/** A bound group, resolved: its blocks in the setup order, and the two arrangements. */
export interface LayoutGroup {
  limb: string;
  parts: string[];
  depth: LayoutDepth;
  against: LayoutAgainst;
  /** Where the producer put the group at setup; null when no layout declares a target. */
  setup: 'before' | 'after' | null;
  slots: string[];
  target: string[];
  keyed: boolean;
  /** √(1 − 0.95²) × the forearm's rest length, px; null where it is never read. */
  tie: number | null;
  why?: string;
}
interface Resolved {
  group: LayoutGroup;
  /** Offsets with the group in front of its target, and behind it; empty = the setup order. */
  front: DrawOrderOffset[];
  back: DrawOrderOffset[];
  lo: number;
  hi: number;
  /** #431: move only the declared forearm; keep all other slots' relative order. */
  pelvis?: boolean;
}

/** The run lo.. with `behind`'s slots first: each moved slot's offset from its setup index. */
function arrangement(names: readonly string[], lo: number, behind: readonly string[], front: readonly string[]): DrawOrderOffset[] {
  return [...behind, ...front].flatMap((slot, k) => (lo + k - names.indexOf(slot) === 0 ? [] : [{ slot, offset: lo + k - names.indexOf(slot) }])).sort((x, y) => names.indexOf(x.slot) - names.indexOf(y.slot));
}

/** The map bone that carries `segment` (the chain naming its two joints in a row), or null. */
function segmentBone(map: JointMap, segment: DepthSegment): string | null {
  const [a, b] = DEPTH_SEGMENTS[segment];
  for (const c of map.chains) {
    const k = c.joints.indexOf(a);
    if (k >= 0 && c.joints[k + 1] === b && c.bones[k] !== undefined) return c.bones[k]!;
  }
  return null;
}

/** The limb joints: a chain naming one maps a limb (an arm or a leg). */
const LIMB_JOINTS = new Set(['r_elbow', 'r_wrist', 'l_elbow', 'l_wrist', 'r_knee', 'r_ankle', 'l_knee', 'l_ankle']);

/**
 * The bindings against the companion, before the gate: every placement bound, every binding a placement's. Problems by
 * name; nothing is guessed. `bindings` undefined is a map with no `layout`.
 */
export function bindingProblems(layout: Layout | null, bindings: readonly LayoutBinding[] | undefined, rig: string, map: string): Problems {
  const p = new Problems();
  if (layout === null) {
    if (bindings !== undefined) p.add('LAYOUT_MISSING', `${map} binds ${bindings.map(groupName).join(', ')} in "layout", and there is no ${join(dirname(rig), LAYOUT_FILE)} beside ${rig} (rig-parts rig writes it where the config declares a limb layout); a binding with no placement is not read`);
    return p;
  }
  const bound = (pl: LayoutPlacement) => bindings?.find((b) => b.limb === pl.limb && sameList(b.parts, pl.parts));
  for (const pl of layout.placements) {
    if (bound(pl) !== undefined) continue;
    p.add('LAYOUT_UNBOUND', `${layout.path} places ${groupName(pl)} ${pl.before !== undefined ? `before ${targetText(pl.before)}` : `after ${targetText(pl.after!)}`}, and ${map} binds no depth source for it: --draw-order depth keys a group only by the source its map names — add { "limb": "${pl.limb}", "parts": ${JSON.stringify(pl.parts)}, "depth": ${LAYOUT_DEPTHS.map((d) => `"${d}"`).join(' | ')}, "against": "trunk" } to the map's "layout"; no source is taken from a name, a nearest bone or a zero depth`);
  }
  for (const b of bindings ?? []) {
    if (!layout.placements.some((pl) => pl.limb === b.limb && sameList(pl.parts, b.parts))) p.add('LAYOUT_BINDING_UNKNOWN', `${map} "layout" binds ${groupName(b)}, and ${layout.path} has no such placement (it places ${layout.placements.map(groupName).join(', ') || 'none'})`);
  }
  return p;
}

/**
 * The bound groups, resolved on the built rig: problems by name for a placement whose blocks are not adjacent in the
 * compiled order, or whose slots are not on the bones its binding names. `order` is the compiled model's slots in setup
 * order; `legRuns` the setup-index runs of the keyed leg pairs (a group overlapping one is not keyed, said why).
 */
export function resolveGroups(layout: Layout, bindings: readonly LayoutBinding[], map: JointMap, rest: Rest, order: ReadonlyArray<{ name: string; bone: string }>, legRuns: ReadonlyArray<[number, number]>): { groups: Resolved[]; problems: Problems } {
  const p = new Problems();
  const names = order.map((s) => s.name);
  const boneOf = new Map(order.map((s) => [s.name, s.bone]));
  const mapped = new Map(map.chains.flatMap((c) => c.bones.map((b) => [b, c] as const)));
  /** The first chain-mapped bone at or above `bone`, and its chain. */
  const owner = (bone: string) => {
    for (let b: string | null = bone; b !== null; b = rest.get(b)?.parent ?? null) {
      const c = mapped.get(b);
      if (c !== undefined) return { bone: b, chain: c };
    }
    return null;
  };
  // Anatomy comes from explicit consecutive hip joints, never from a chain, slot or bone name.
  const hipBones = new Set(map.chains.flatMap((c) => c.bones.filter((_, i) => (c.joints[i] === 'r_hip' && c.joints[i + 1] === 'l_hip') || (c.joints[i] === 'l_hip' && c.joints[i + 1] === 'r_hip'))));
  const pelvisSlots = new Set(order.filter((s) => hipBones.has(owner(s.bone)?.bone ?? '')).map((s) => s.name));
  adjacencyProblems(p, layout, names, pelvisSlots);
  const groups: Resolved[] = [];
  for (const pl of layout.placements) {
    const b = bindings.find((x) => x.limb === pl.limb && sameList(x.parts, pl.parts))!;
    const where = `${groupName(pl)} (bound to ${b.depth} against the ${b.against})`;
    const seg = segmentBone(map, b.depth);
    if (seg === null) {
      p.add('LAYOUT_BINDING_BONES', `${where}: no chain of the map names ${DEPTH_SEGMENTS[b.depth].join(' then ')}, so no bone carries ${b.depth}`);
      continue;
    }
    // Each group slot on the segment's bone or under it through no other chain's bone: the forearm's own art (a hand under it rides along).
    const off = pl.slots.filter((n) => {
      const bone = boneOf.get(n);
      if (bone === undefined) return false;
      return owner(bone)?.bone !== seg;
    });
    if (off.length > 0) p.add('LAYOUT_BINDING_BONES', `${where}: slot(s) ${off.map((n) => `"${n}" on bone "${boneOf.get(n) ?? '?'}"`).join(', ')} hang on neither bone "${seg}" (the map's ${b.depth}) nor under it; the group's depth source is the bone its art is on`);
    // The target is the trunk: no slot of it under a chain naming a limb joint.
    const limbTarget = pl.target_slots.filter((n) => {
      const o = boneOf.get(n) === undefined ? null : owner(boneOf.get(n)!);
      return o !== null && o.chain.joints.some((j) => LIMB_JOINTS.has(j));
    });
    if (limbTarget.length > 0) p.add('LAYOUT_BINDING_BONES', `${where}: target slot(s) ${limbTarget.map((n) => `"${n}" (chain "${owner(boneOf.get(n)!)!.chain.name}")`).join(', ')} are a limb's, not the trunk's`);
    const s = pl.slots.map((n) => names.indexOf(n));
    const t = pl.target_slots.map((n) => names.indexOf(n));
    const lo = Math.min(...s, ...t);
    const hi = Math.max(...s, ...t);
    const setup = pl.before !== undefined ? 'before' : 'after';
    const group: LayoutGroup = { limb: pl.limb, parts: [...pl.parts], depth: b.depth, against: b.against, setup, slots: [...pl.slots], target: [...pl.target_slots], keyed: true, tie: null };
    const pelvis = pl.target_slots.every((n) => pelvisSlots.has(n));
    const leg = legRuns.find(([a, z]) => pelvis ? [...s, ...t].some((i) => a <= i && i <= z) : a <= hi && lo <= z);
    if (leg !== undefined) {
      group.keyed = false;
      group.why = `its run (setup slots ${lo}–${hi}) overlaps a keyed leg pair's (${leg[0]}–${leg[1]}), and one key cannot order both`;
    }
    groups.push({ group, lo, hi, front: arrangement(names, lo, pl.target_slots, pl.slots), back: arrangement(names, lo, pl.slots, pl.target_slots), ...(pelvis ? { pelvis: true } : {}) });
  }
  return { groups, problems: p };
}

type Joints = Partial<Record<Body18, Joint>>;
const drawnOf = (j: Joints, s: DepthSegment): number | null => {
  const [a, b] = DEPTH_SEGMENTS[s].map((n) => j[n]);
  return a?.at === undefined || b?.at === undefined || a.state === 'missing' || b.state === 'missing' ? null : Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
};

/** The segment's rest length as the depth states it (drawn ÷ ratio), the median over the frames that name it; null where none does. */
function restLength(track: readonly Joints[], depth: ReadonlyArray<FrameDepth | undefined>, s: DepthSegment): number | null {
  const vals = track.flatMap((j, i) => {
    const d = depth[i]?.[s];
    const len = drawnOf(j, s);
    return d === undefined || !(d.ratio > 0) || len === null ? [] : [len / d.ratio];
  });
  if (vals.length === 0) return null;
  vals.sort((x, y) => x - y);
  const m = vals.length >> 1;
  return vals.length % 2 === 1 ? vals[m]! : (vals[m - 1]! + vals[m]!) / 2;
}

/** One group's readable frames in the chosen order (including held ties), and unread.
 * Missing depth can hold an emitted pelvis order but stays unread, outside front/back runs. */
export interface GroupOrder extends LayoutGroup {
  front: Array<[number, number]>;
  back: Array<[number, number]>;
  frames: { front: number; back: number; unread: number };
  /** Each frame's depth, px (+ toward the camera; rounded to 0.01), null where the segment is not named. */
  depthPx: Array<number | null>;
}

const runsOf = (on: readonly boolean[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  on.forEach((v, f) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === f - 1) last[1] = f;
    else out.push([f, f]);
  });
  return out;
};

/** #431: absent layout is an explicit not-keyed reading, never a guessed target or depth source. */
export function missingLayoutGroups(map: JointMap, rest: Rest, order: ReadonlyArray<{ name: string; bone: string }>, frames: number): GroupOrder[] {
  const mapped = new Set(map.chains.flatMap((c) => c.bones));
  return LAYOUT_DEPTHS.flatMap((depth) => {
    const bone = segmentBone(map, depth);
    if (bone === null) return [];
    const own = (name: string): boolean => {
      for (let b: string | null = name; b !== null; b = rest.get(b)?.parent ?? null) {
        if (b === bone) return true;
        if (mapped.has(b)) return false;
      }
      return false;
    };
    const slots = order.filter((s) => own(s.bone)).map((s) => s.name);
    if (slots.length === 0) return [];
    const limb = map.chains.find((c) => c.bones.includes(bone))!.name;
    return [{ limb, parts: [], depth, against: 'trunk' as const, setup: null, slots, target: [], keyed: false, tie: null,
      why: 'no limb layout; rig-parts rig writes layout.json beside rig.json from the config limb layout; bind its depth in the map layout',
      front: [], back: [], frames: { front: 0, back: 0, unread: frames }, depthPx: Array<number | null>(frames).fill(null) }];
  });
}

/**
 * The groups' order per frame, merged with the legs' keys into one timeline. `legs` is `drawOrderFromDepth`'s reading;
 * its keys are complete statements, so the legs' offsets on a frame are the last key's at or before it. Returns the
 * reading with the merged keys (its pairs, spans and gaps the legs' own) and each group's frames.
 */
export function keyGroups(legs: DrawOrderReading, resolved: readonly Resolved[], track: readonly Joints[], depth: ReadonlyArray<FrameDepth | undefined>, times: readonly number[], order: ReadonlyArray<{ name: string }>, loop = false): { reading: DrawOrderReading; groups: GroupOrder[] } {
  const names = order.map((s) => s.name);
  const groups: GroupOrder[] = [];
  const perFrame: Array<Array<DrawOrderOffset[]>> = [];
  const states: Array<Array<'front' | 'back' | null>> = [];
  for (const r of resolved) {
    const rest = restLength(track, depth, r.group.depth);
    const tie = rest === null ? null : Math.round(TIE_PER_LENGTH * rest * 100) / 100;
    const z = track.map((j, i) => {
      const d = depth[i]?.[r.group.depth];
      const len = drawnOf(j, r.group.depth);
      return d === undefined || len === null ? null : Math.round(segmentDepth(d, len) * 100) / 100;
    });
    // Preserve adjacent chest semantics; only an explicit pelvis target holds undecided depths (#434).
    const chest = z.map((v): 'front' | 'back' | null => (v === null || tie === null ? null : v > 0 && v >= tie ? 'front' : 'back'));
    const pass = (start: 'front' | 'back'): Array<'front' | 'back'> => {
      let chosen = start;
      return z.map((v) => {
        if (v !== null && tie !== null && v !== 0 && Math.abs(v) >= tie) chosen = v > 0 ? 'front' : 'back';
        return chosen;
      });
    };
    const first = r.pelvis ? pass(r.group.setup === 'after' ? 'front' : 'back') : chest;
    const state = r.pelvis && loop && first.length > 0 ? pass(first[first.length - 1]!) : first;
    // Held missing depth is an order decision, never a measured front/back frame in the report.
    const reported = state.map((s, f) => z[f] === null || tie === null ? null : s);
    states.push(state);
    perFrame.push(state.map((s) => (!r.group.keyed || r.pelvis || s === null ? [] : s === 'front' ? r.front : r.back)));
    groups.push({ ...r.group, tie, front: runsOf(reported.map((s) => s === 'front')), back: runsOf(reported.map((s) => s === 'back')), frames: { front: reported.filter((s) => s === 'front').length, back: reported.filter((s) => s === 'back').length, unread: reported.filter((s) => s === null).length }, depthPx: z });
  }
  const sorted = [...legs.keys].sort((a, b) => a.frame - b.frame);
  const legAt = (f: number): DrawOrderOffset[] => [...sorted].reverse().find((k) => k.frame <= f)?.offsets ?? [];
  const keys: DrawOrderReading['keys'] = [];
  let last = '[]';
  for (let f = 0; f < times.length; f++) {
    let offs = [...legAt(f), ...perFrame.flatMap((g) => g[f] ?? [])].sort((x, y) => names.indexOf(x.slot) - names.indexOf(y.slot));
    if (resolved.some((r) => r.pelvis && r.group.keyed)) {
      // Decode the legs' complete statement first, then compose all forearms in one total order.
      // Only forearms that must cross their target move; all non-forearm slots keep their relative order.
      const placed: Array<string | undefined> = Array(names.length).fill(undefined);
      for (const o of offs) placed[names.indexOf(o.slot) + o.offset] = o.slot;
      const moved = new Set(offs.map((o) => o.slot));
      const remaining = names.filter((n) => !moved.has(n));
      let total = placed.map((n) => n ?? remaining.shift()!);
      const targets = new Map<string, number[]>();
      resolved.forEach((r, i) => {
        if (!r.pelvis || !r.group.keyed) return;
        const id = JSON.stringify(r.group.target);
        targets.set(id, [...(targets.get(id) ?? []), i]);
      });
      for (const indexes of targets.values()) {
        const target = resolved[indexes[0]!]!.group.target;
        const before: string[] = [];
        const after: string[] = [];
        for (const i of [...indexes].sort((a, b) => names.indexOf(resolved[a]!.group.slots[0]!) - names.indexOf(resolved[b]!.group.slots[0]!))) {
          const r = resolved[i]!;
          const state = states[i]![f];
          const own = r.group.slots.map((n) => total.indexOf(n));
          const ts = target.map((n) => total.indexOf(n));
          if (state === 'front' && Math.min(...own) < Math.max(...ts)) after.push(...r.group.slots);
          if (state === 'back' && Math.max(...own) > Math.min(...ts)) before.push(...r.group.slots);
        }
        if (before.length + after.length === 0) continue;
        const moving = new Set([...before, ...after]);
        total = total.filter((n) => !moving.has(n));
        total.splice(Math.min(...target.map((n) => total.indexOf(n))), 0, ...before);
        total.splice(Math.max(...target.map((n) => total.indexOf(n))) + 1, 0, ...after);
      }
      // Re-encode once against setup: one offset per slot, no collisions or out-of-range destinations.
      offs = names.flatMap((slot, i) => total.indexOf(slot) === i ? [] : [{ slot, offset: total.indexOf(slot) - i }]);
    }
    const text = JSON.stringify(offs);
    if (text === last) continue;
    last = text;
    // A leg key on this frame that the groups leave as it is, is written as it is (whatever fields the legs' reading
    // marks it with); one they change keeps those fields, with the merged offsets.
    const leg = sorted.find((k) => k.frame === f);
    if (leg !== undefined && JSON.stringify(leg.offsets ?? []) === text) keys.push(leg);
    else {
      const { offsets: _o, ...own } = leg ?? { frame: f, t: keyAtFrame(times, f) };
      keys.push(offs.length === 0 ? { ...own, frame: f, t: keyAtFrame(times, f) } : { ...own, frame: f, t: keyAtFrame(times, f), offsets: offs });
    }
  }
  return { reading: { ...legs, keys }, groups };
}

const spanText = (runs: ReadonlyArray<[number, number]>): string => runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');

/** The group lines: one per group, keyed or not, cut to 260 characters (the report's `drawOrder.groups` carries every run). */
export function groupLines(groups: readonly GroupOrder[], keys: readonly DrawOrderKey[], prefix = 'DRAWORDER '): string[] {
  return groups.map((g) => {
    if (!g.keyed && g.target.length === 0) return `${prefix}${g.limb} / ${g.against} by ${g.depth} not keyed: ${g.why}`.slice(0, LINE_MAX);
    const head = `${prefix}${groupName(g)} by ${g.depth} against the ${g.against} ("${g.target.join('", "')}", the group ${g.setup} it at setup; tie ${g.tie === null ? 'none' : `${g.tie} px`})`;
    if (!g.keyed) return `${head} not keyed: ${g.why}`.slice(0, LINE_MAX);
    const tail = `; behind on ${g.frames.back}, unread on ${g.frames.unread}; ${keys.length} key(s) in the timeline`;
    let runs = g.front.length;
    const line = (n: number) => `${head}: in front on ${g.frames.front} of ${g.frames.front + g.frames.back + g.frames.unread} frame(s)${g.front.length === 0 ? '' : ` (${spanText(g.front.slice(0, n))}${n < g.front.length ? `, … +${g.front.length - n} more in the report's drawOrder.groups` : ''})`}${tail}`;
    while (runs > 1 && line(runs).length > LINE_MAX) runs--;
    return line(runs).slice(0, LINE_MAX);
  });
}

/** The report's `drawOrder.groups` and `drawOrder.layout`: each group without its per-frame depth list. */
export function groupsReport(layout: Layout | null, groups: readonly GroupOrder[]): { layout?: { path: string; sha256: string }; groups: Array<Omit<GroupOrder, 'depthPx'>> } {
  return { ...(layout === null ? {} : { layout: { path: layout.path, sha256: layout.sha256 } }), groups: groups.map(({ depthPx: _d, ...g }) => g) };
}
