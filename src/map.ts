/**
 * The joint map: `rig-pose-map/1` — which bones of the rig carry which joints.
 *
 *   { "spec": "rig-pose-map/1",
 *     "chains": [
 *       { "name": "arm_r", "bones": ["sleeve_r0", "sleeve_r1"], "joints": ["r_shoulder", "r_elbow", "r_wrist"] },
 *       { "name": "trunk", "bones": ["chest"], "joints": ["mid_hip", "neck"], "aim": ["neck"] } ],
 *     "translate": { "bone": "hip", "joint": "mid_hip",
 *                    "scale": { "pose": ["mid_hip", "neck"], "rig": ["hip", "neck"] } } }
 *
 * A chain's bone k carries the segment from joint k to joint k+1, so a chain
 * has one joint more than it has bones; each bone after the first must descend
 * from the one before it. Each joint strictly inside a chain is a hinge, and
 * `bend` says which way it may bend (see `checkBends`).
 *
 * `aim` says which direction of the rig's bone the segment is, one entry per
 * bone: `"x"` (the default) is the bone's own x axis — right for a chain link
 * @rig-c/parts turned along its limb; a bone name is the direction from this
 * bone's origin to that descendant's origin — right for a trunk bone, whose
 * own axis @rig-c/parts leaves at world 0°; and `"a>b"` is the direction from
 * point a to point b, each the bone itself or a descendant (`name:tip` is the
 * end of a bone's x axis) — right for a head, whose eye line
 * (`"eye_r>eye_l"` against the joints `r_eye`, `l_eye`) turns with it.
 *
 * Wherever the map names a point of the rig — an aim's end, a scale's end — it
 * may also be `"a+b"`, the midpoint of two points (each a bone or `name:tip`):
 * `"sleeve_r0+sleeve_l0"` is the rig's mid-shoulder.
 *
 * `reach: true` on a one-bone chain whose first joint is the translated joint
 * (a trunk from mid_hip) aims the bone not along the pose's segment but from
 * where its origin is posed — the hip moved and turned — at the point where the
 * pose puts the segment's end, relative to the translated joint and scaled: so a
 * tilted pelvis does not carry the chest off the shoulders' line. Its aim is one
 * point (a bone, `name:tip` or `a+b`), measured from the bone's own origin.
 *
 * `translate` moves one bone by the travel of one point, scaled by the ratio of
 * a length measured on the rig (between two points: a bone's origin, `name:tip`
 * the end of a bone's x axis, or `a+b`) to the same length measured in the pose
 * (its median over the frames where both points are good).
 *
 * A chain may carry `range: { "<bone>": [min, max] }`: the rotate key, degrees
 * relative to the bone's setup rotation, within which its cut art still reads
 * well. Outside a set's span the retarget clamps the key there, and lists the
 * overflow as demand (`RANGE`).
 *
 * `alternates` lists the rig's alternate drawings as sets: `{ name, slots,
 * hides, chains, pose, drawn?, offsets? }`. While a set shows, every slot in
 * `slots` shows its attachment and every slot in `hides` is empty; `pose` is the
 * key skeleton it is selected by (picture px, y down, any scale — only its
 * directions are read), holding every joint its `chains` use; `drawn` is each
 * bone's world angle as painted (a reading: `artTurn`); `offsets` is a
 * translate per bone, in its parent's axes, held while the set shows.
 * `switch.ts` decides when each one shows.
 */
import type { RawBone } from 'rig-c/core';
import { POINT_NAMES } from './joints.ts';
import { isObject, parseJson, Problems, refuseUnknownKeys, typeName } from './problems.ts';

export const MAP_SPEC = 'rig-pose-map/1';
export const BENDS = ['rest', 'ccw', 'cw', 'free'] as const;
export type Bend = (typeof BENDS)[number];

export interface Chain {
  name: string;
  bones: string[];
  joints: string[];
  aim: string[];
  bend: Bend;
  /** Aim from the bone's posed origin at the pose's end point, anchored at the translated bone. */
  reach: boolean;
  /** Per bone of the chain: the rotate key's range, degrees relative to setup, [min, max]. */
  range: Record<string, [number, number]>;
}
export interface Translate {
  bone: string;
  joint: string;
  scale: { pose: [string, string]; rig: [string, string] };
}
/** An alternate drawing: a set of slots switched together, and the key skeleton it is selected by. */
export interface AlternateSet {
  name: string;
  /** Slot → the attachment it shows while the set shows. */
  slots: Record<string, string>;
  /** Slots that are empty while the set shows. */
  hides: string[];
  /** Names of the map's chains whose pose the drawing depicts. */
  chains: string[];
  /** The key skeleton the drawing was painted from: picture px, y down, any scale. */
  pose: Record<string, [number, number]>;
  /** Bone → its world angle as painted, Spine degrees. */
  drawn: Record<string, number>;
  /** Bone → a translate, in its parent's axes, held while the set shows. */
  offsets: Record<string, [number, number]>;
  /** Bone → how far its art may turn from `drawn` while the set shows, [min, max] degrees: the bone is clamped there, and the overflow is ART-RANGE demand. */
  turn: Record<string, [number, number]>;
}
export interface JointMap {
  chains: Chain[];
  translate: Translate | null;
  alternates: AlternateSet[];
}

/** What a slot of the built rig shows at setup, and every attachment any skin gives it. */
export interface RigSlot {
  setup: string | null;
  attachments: ReadonlySet<string>;
}
export type RigSlots = ReadonlyMap<string, RigSlot>;

/** The rig as the map is resolved against it: each bone's setup pose, by rig-c's poser. */
export interface RestBone extends RawBone {
  /** The bone's `length` in the compiled model (0 when it has none). */
  length: number;
}
export type Rest = ReadonlyMap<string, RestBone>;

export function readMap(text: string, where: string): JointMap {
  const doc = parseJson(text, where, 'MAP_JSON');
  const p = new Problems();
  if (!isObject(doc)) {
    p.add('MAP_SHAPE', `${where} is ${typeName(doc)}; a ${MAP_SPEC} document is an object`);
    p.throwIfAny();
    throw new Error('unreachable');
  }
  refuseUnknownKeys(p, 'MAP_KEYS', where, doc, ['spec', 'note', 'chains', 'translate', 'alternates']);
  if (doc.spec !== MAP_SPEC) p.add('MAP_SPEC', `${where} "spec" is ${typeName(doc.spec)}; this reader reads "${MAP_SPEC}"`);
  const chains: Chain[] = [];
  if (!Array.isArray(doc.chains) || doc.chains.length === 0) {
    p.add('MAP_CHAINS', `${where} "chains" is ${typeName(doc.chains)}; it must be a non-empty array of chains`);
  } else {
    const names = new Set<string>();
    doc.chains.forEach((c: unknown, i: number) => {
      const cw = `${where} chains[${i}]`;
      if (!isObject(c)) {
        p.add('MAP_CHAIN_SHAPE', `${cw} is ${typeName(c)}; a chain is { name, bones, joints, aim?, bend?, reach?, range? }`);
        return;
      }
      refuseUnknownKeys(p, 'MAP_KEYS', cw, c, ['name', 'bones', 'joints', 'aim', 'bend', 'reach', 'range']);
      const name = typeof c.name === 'string' && c.name !== '' ? c.name : null;
      if (name === null) p.add('MAP_CHAIN_NAME', `${cw} "name" is ${typeName(c.name)}; it must be a non-empty string`);
      else if (names.has(name)) p.add('MAP_CHAIN_NAME', `${cw} "name" "${name}" names two chains`);
      if (name !== null) names.add(name);
      const label = name === null ? cw : `chain "${name}"`;
      const bones = strings(c.bones);
      const joints = strings(c.joints);
      if (bones === null || bones.length === 0) p.add('MAP_CHAIN_BONES', `${label} "bones" is ${typeName(c.bones)}; it must be a non-empty array of bone names`);
      if (joints === null || joints.length < 2) p.add('MAP_CHAIN_JOINTS', `${label} "joints" is ${typeName(c.joints)}; it must be an array of at least two joint names`);
      if (bones !== null && joints !== null && bones.length > 0 && joints.length !== bones.length + 1) {
        p.add('MAP_CHAIN_JOINTS', `${label} has ${bones.length} bone(s) and ${joints.length} joint(s); bone k carries the segment from joint k to joint k+1, so it needs ${bones.length + 1}`);
      }
      for (const j of joints ?? []) {
        if (!POINT_NAMES.includes(j)) p.add('MAP_JOINT_NAME', `${label} names joint "${j}", which is not a point this package reads; they are ${POINT_NAMES.join(', ')}`);
      }
      let aim = bones === null ? [] : bones.map(() => 'x');
      if ('aim' in c) {
        const a = strings(c.aim);
        if (a === null || bones === null || a.length !== bones.length) p.add('MAP_CHAIN_AIM', `${label} "aim" is ${typeName(c.aim)}; it must be one entry per bone ("x", a descendant point, or "a>b")`);
        else {
          aim = a;
          for (const x of a) if (x !== 'x') for (const end of x.split('>')) pointProblem(p, label, end);
        }
      }
      let bend: Bend = 'rest';
      if ('bend' in c) {
        if (typeof c.bend !== 'string' || !(BENDS as readonly string[]).includes(c.bend)) p.add('MAP_CHAIN_BEND', `${label} "bend" is ${typeName(c.bend)}; it must be one of ${BENDS.join(', ')}`);
        else bend = c.bend as Bend;
      }
      let reach = false;
      if ('reach' in c) {
        if (typeof c.reach !== 'boolean') p.add('MAP_REACH', `${label} "reach" is ${typeName(c.reach)}; it must be true or false`);
        else reach = c.reach;
      }
      const range: Record<string, [number, number]> = {};
      if ('range' in c) {
        if (!isObject(c.range)) p.add('MAP_RANGE', `${label} "range" is ${typeName(c.range)}; it is { "<bone>": [min, max] }, the rotate key's range in degrees relative to setup, per bone of the chain`);
        else {
          for (const [b, v] of Object.entries(c.range)) {
            if (bones !== null && !bones.includes(b)) p.add('MAP_RANGE', `${label} "range" names bone "${b}", which is not a bone of the chain; its bones are ${bones.join(', ')}`);
            else if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x)) || (v[0] as number) > (v[1] as number)) {
              p.add('MAP_RANGE', `${label} "range" bone "${b}" is ${JSON.stringify(v)}; it must be [min, max], two finite numbers of degrees with min ≤ max`);
            } else range[b] = [v[0] as number, v[1] as number];
          }
        }
      }
      chains.push({ name: name ?? cw, bones: bones ?? [], joints: joints ?? [], aim, bend, reach, range });
    });
  }
  let translate: Translate | null = null;
  if ('translate' in doc) {
    const t = doc.translate;
    const tw = `${where} "translate"`;
    if (!isObject(t)) {
      p.add('MAP_TRANSLATE', `${tw} is ${typeName(t)}; it is { bone, joint, scale: { pose: [a, b], rig: [a, b] } }`);
    } else {
      refuseUnknownKeys(p, 'MAP_KEYS', tw, t, ['bone', 'joint', 'scale']);
      if (typeof t.bone !== 'string' || t.bone === '') p.add('MAP_TRANSLATE', `${tw} "bone" is ${typeName(t.bone)}; it must name a bone`);
      if (typeof t.joint !== 'string' || !POINT_NAMES.includes(t.joint)) p.add('MAP_JOINT_NAME', `${tw} "joint" is ${typeName(t.joint)}; it must be one of ${POINT_NAMES.join(', ')}`);
      const s = t.scale;
      const pose = isObject(s) ? strings(s.pose) : null;
      const rig = isObject(s) ? strings(s.rig) : null;
      if (isObject(s)) refuseUnknownKeys(p, 'MAP_KEYS', `${tw} "scale"`, s, ['pose', 'rig']);
      if (pose === null || pose.length !== 2 || rig === null || rig.length !== 2) {
        p.add('MAP_TRANSLATE_SCALE', `${tw} "scale" is ${JSON.stringify(s)}; it must be { pose: [joint, joint], rig: [bone, bone] }, the same length measured in each`);
      } else {
        for (const j of pose) if (!POINT_NAMES.includes(j)) p.add('MAP_JOINT_NAME', `${tw} "scale.pose" names "${j}"; the points are ${POINT_NAMES.join(', ')}`);
        for (const r of rig) pointProblem(p, `${tw} "scale.rig"`, r);
        if (typeof t.bone === 'string' && typeof t.joint === 'string') translate = { bone: t.bone, joint: t.joint, scale: { pose: [pose[0]!, pose[1]!], rig: [rig[0]!, rig[1]!] } };
      }
    }
  }
  for (const c of chains) {
    if (!c.reach) continue;
    const label = `chain "${c.name}"`;
    if (c.bones.length !== 1) p.add('MAP_REACH', `${label} has "reach" and ${c.bones.length} bones; a reach turns one bone from its posed origin, so the chain must have exactly one`);
    const aim = c.aim[0];
    if (aim !== undefined && (aim === 'x' || aim.includes('>'))) {
      p.add('MAP_REACH', `${label} has "reach" and aims ${JSON.stringify(aim)}; a reach aims from the bone's own origin at one point, so "aim" must name it (a bone, name:tip or a+b)`);
    }
    if (!('translate' in doc)) p.add('MAP_REACH', `${label} has "reach" and the map has no "translate"; a reach is anchored at the translated bone's posed origin`);
    else if (translate !== null && c.joints[0] !== translate.joint) {
      p.add('MAP_REACH', `${label} has "reach" and starts at joint "${c.joints[0]}"; the reach is measured from the translated joint, so its first joint must be "${translate.joint}"`);
    }
  }
  const alternates = 'alternates' in doc ? readAlternates(p, where, doc.alternates, chains, translate) : [];
  p.throwIfAny();
  return { chains, translate, alternates };
}

const SET_SHAPE = '{ name, slots: { "<slot>": "<attachment>" }, hides?: [slot], chains: [chain], pose: { "<joint>": [x, y] }, drawn?: { "<bone>": deg }, offsets?: { "<bone>": [dx, dy] }, turn?: { "<bone>": [min, max] } }';

/** `alternates`: each set's shape, its chains against the map's, its key skeleton against those chains' joints, and its bones against those chains' bones. */
function readAlternates(p: Problems, where: string, raw: unknown, chains: readonly Chain[], translate: Translate | null): AlternateSet[] {
  const out: AlternateSet[] = [];
  if (!Array.isArray(raw)) {
    p.add('MAP_ALT_SHAPE', `${where} "alternates" is ${typeName(raw)}; it is an array of sets, ${SET_SHAPE}`);
    return out;
  }
  const names = new Set<string>();
  const chainNames = chains.map((c) => c.name);
  raw.forEach((a: unknown, i: number) => {
    const aw = `${where} alternates[${i}]`;
    if (!isObject(a)) {
      p.add('MAP_ALT_SHAPE', `${aw} is ${typeName(a)}; a set is ${SET_SHAPE}`);
      return;
    }
    refuseUnknownKeys(p, 'MAP_KEYS', aw, a, ['name', 'note', 'slots', 'hides', 'chains', 'pose', 'drawn', 'offsets', 'turn']);
    const name = typeof a.name === 'string' && a.name !== '' ? a.name : null;
    if (name === null) p.add('MAP_ALT_NAME', `${aw} "name" is ${typeName(a.name)}; it must be a non-empty string`);
    else if (names.has(name)) p.add('MAP_ALT_NAME', `${aw} "name" "${name}" names two sets`);
    if (name !== null) names.add(name);
    const label = name === null ? aw : `set "${name}"`;
    let ok = name !== null;

    const slots: Record<string, string> = {};
    if (!isObject(a.slots)) {
      p.add('MAP_ALT_SLOT', `${label} "slots" is ${typeName(a.slots)}; it is { "<slot>": "<attachment>" }, what each slot of the set shows while it shows`);
      ok = false;
    } else {
      for (const [s, att] of Object.entries(a.slots)) {
        if (typeof att !== 'string' || att === '') {
          p.add('MAP_ALT_ATTACHMENT', `${label} "slots" slot "${s}" is ${typeName(att)}; it must name an attachment of that slot`);
          ok = false;
        } else slots[s] = att;
      }
    }
    let hides: string[] = [];
    if ('hides' in a) {
      const h = strings(a.hides);
      if (h === null) {
        p.add('MAP_ALT_HIDES', `${label} "hides" is ${typeName(a.hides)}; it must be an array of slot names`);
        ok = false;
      } else hides = h;
    }
    for (const h of hides) if (h in slots) p.add('MAP_ALT_HIDES', `${label} hides slot "${h}", which "slots" shows "${slots[h]}" in; a slot of a set either shows or hides`);
    if (isObject(a.slots) && Object.keys(slots).length + hides.length === 0) p.add('MAP_ALT_SLOT', `${label} shows no slot and hides none; a set switches at least one slot`);

    const cs = strings(a.chains);
    if (cs === null || cs.length === 0) {
      p.add('MAP_ALT_CHAIN', `${label} "chains" is ${typeName(a.chains)}; it must be a non-empty array of the map's chain names (${chainNames.join(', ')})`);
      ok = false;
    }
    for (const c of cs ?? []) {
      if (!chainNames.includes(c)) p.add('MAP_ALT_CHAIN', `${label} names chain "${c}", which the map does not have; its chains are ${chainNames.join(', ')}`);
    }
    if (cs !== null && new Set(cs).size !== cs.length) p.add('MAP_ALT_CHAIN', `${label} "chains" names a chain twice: ${cs.join(', ')}`);
    const own = chains.filter((c) => (cs ?? []).includes(c.name));
    const ownBones = own.flatMap((c) => c.bones);
    const ownList = own.length === 0 ? 'none' : own.map((c) => `${c.name}: ${c.bones.join(', ')}`).join('; ');

    const pose: Record<string, [number, number]> = {};
    if (!isObject(a.pose)) {
      p.add('MAP_ALT_POSE', `${label} "pose" is ${typeName(a.pose)}; it is the key skeleton the set was painted from, { "<joint>": [x, y], … } in picture px, y down`);
      ok = false;
    } else {
      for (const [j, at] of Object.entries(a.pose)) {
        if (!POINT_NAMES.includes(j)) p.add('MAP_ALT_JOINT', `${label} "pose" names joint "${j}", which is not a point this package reads; they are ${POINT_NAMES.join(', ')}`);
        else if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => typeof v === 'number' && Number.isFinite(v))) p.add('MAP_ALT_POSE', `${label} "pose" joint "${j}" is ${JSON.stringify(at)}; it must be [x, y], two finite numbers`);
        else pose[j] = [at[0] as number, at[1] as number];
      }
      for (const c of own) {
        const missing = c.joints.filter((j) => !(j in (a.pose as Record<string, unknown>)));
        if (missing.length > 0) p.add('MAP_ALT_JOINT', `${label} "pose" has no ${missing.map((j) => `"${j}"`).join(', ')}; chain "${c.name}" uses ${c.joints.join(', ')}, and every one of them must be in the key skeleton`);
        else {
          c.bones.forEach((_, k) => {
            const f = pose[c.joints[k]!];
            const t = pose[c.joints[k + 1]!];
            if (f !== undefined && t !== undefined && Math.hypot(t[0] - f[0], t[1] - f[1]) < 1e-9) p.add('MAP_ALT_POSE', `${label} "pose" puts ${c.joints[k]} and ${c.joints[k + 1]} at the same point; chain "${c.name}"'s segment between them has no direction`);
          });
        }
      }
    }

    const drawn: Record<string, number> = {};
    if ('drawn' in a) {
      if (!isObject(a.drawn)) p.add('MAP_ALT_DRAWN', `${label} "drawn" is ${typeName(a.drawn)}; it is { "<bone>": degrees }, each bone's world angle as painted`);
      else {
        for (const [b, v] of Object.entries(a.drawn)) {
          if (!ownBones.includes(b)) p.add('MAP_ALT_DRAWN', `${label} "drawn" names bone "${b}", which is not a bone of its chains (${ownList})`);
          else if (typeof v !== 'number' || !Number.isFinite(v)) p.add('MAP_ALT_DRAWN', `${label} "drawn" bone "${b}" is ${typeName(v)}; it must be a finite number of degrees`);
          else drawn[b] = v;
        }
      }
    }
    const offsets: Record<string, [number, number]> = {};
    if ('offsets' in a) {
      if (!isObject(a.offsets)) p.add('MAP_ALT_OFFSET', `${label} "offsets" is ${typeName(a.offsets)}; it is { "<bone>": [dx, dy] }, a translate in the bone's parent's axes`);
      else {
        for (const [b, v] of Object.entries(a.offsets)) {
          if (translate !== null && b === translate.bone) p.add('MAP_ALT_OFFSET', `${label} "offsets" names bone "${b}", which "translate" already keys; a bone carries one translate track`);
          else if (!ownBones.includes(b)) p.add('MAP_ALT_OFFSET', `${label} "offsets" names bone "${b}", which is not a bone of its chains (${ownList})`);
          else if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) p.add('MAP_ALT_OFFSET', `${label} "offsets" bone "${b}" is ${JSON.stringify(v)}; it must be [dx, dy], two finite numbers`);
          else offsets[b] = [v[0] as number, v[1] as number];
        }
      }
    }
    const turn: Record<string, [number, number]> = {};
    if ('turn' in a) {
      if (!isObject(a.turn)) p.add('MAP_ALT_TURN', `${label} "turn" is ${typeName(a.turn)}; it is { "<bone>": [min, max] }, how far each bone's art may turn from its drawn angle, degrees`);
      else {
        for (const [b, v] of Object.entries(a.turn)) {
          if (!(b in drawn)) p.add('MAP_ALT_TURN', `${label} "turn" names bone "${b}", which has no "drawn" angle in the set; a turn is measured from the drawn angle (the set draws ${Object.keys(drawn).join(', ') || 'none'})`);
          else if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x)) || (v[0] as number) > (v[1] as number)) p.add('MAP_ALT_TURN', `${label} "turn" bone "${b}" is ${JSON.stringify(v)}; it must be [min, max], two finite numbers of degrees with min ≤ max`);
          else turn[b] = [v[0] as number, v[1] as number];
        }
      }
    }
    if (ok && name !== null && cs !== null) out.push({ name, slots, hides, chains: cs, pose, drawn, offsets, turn });
  });
  return out;
}

/** A rig point as the map spells it: `name`, `name:tip`, or `a+b`, the midpoint of two such. */
function pointProblem(p: Problems, label: string, spec: string): void {
  const parts = spec.split('+');
  if (parts.length > 2 || parts.some((x) => x === '' || x === ':tip')) {
    p.add('MAP_POINT', `${label} names the point ${JSON.stringify(spec)}; a point is a bone name, name:tip (the end of its x axis), or a+b (the midpoint of two of those)`);
  }
}

/** The points a point spec averages: one (`name`, `name:tip`) or two (`a+b`). */
export function pointParts(spec: string): string[] {
  return spec.split('+');
}

/** The bone a point part is read off (`name:tip` → `name`). */
export function partBone(part: string): string {
  return part.endsWith(':tip') ? part.slice(0, -4) : part;
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : null;
}

/** Whether `bone` descends from `ancestor` (strictly). */
export function descends(rest: Rest, bone: string, ancestor: string): boolean {
  for (let b = rest.get(bone)?.parent ?? null; b !== null; b = rest.get(b)?.parent ?? null) if (b === ancestor) return true;
  return false;
}

/** The two points a non-`x` aim runs between: `"a>b"`, or the bone's origin to a descendant point. */
export function aimEnds(bone: string, aim: string): [string, string] {
  const i = aim.indexOf('>');
  return i < 0 ? [bone, aim] : [aim.slice(0, i), aim.slice(i + 1)];
}

/** What an aim reads off a bone: its world x axis column and origin. */
export interface AimBone {
  a: number;
  c: number;
  worldX: number;
  worldY: number;
}

/**
 * A mapped bone's aim, Spine world degrees, on any pose of the rig: the setup
 * pose (the rest angle) or a posed frame (where it landed). `lengths` are the
 * model's bone lengths, for `name:tip`.
 */
export function aimAngle(bones: ReadonlyMap<string, AimBone>, lengths: ReadonlyMap<string, number>, bone: string, aim: string): number {
  const DEG = 180 / Math.PI;
  if (aim === 'x') {
    const b = bones.get(bone)!;
    return Math.atan2(b.c, b.a) * DEG;
  }
  const [f, t] = aimEnds(bone, aim).map((e) => pointAt(bones, lengths, e)!) as [[number, number], [number, number]];
  return Math.atan2(t[1] - f[1], t[0] - f[0]) * DEG;
}

/**
 * A rig point on any pose of the rig: a bone's origin, `name:tip` (the end of
 * its x axis), or `a+b` (their midpoint); null when a bone is not there.
 */
export function pointAt(bones: ReadonlyMap<string, AimBone>, lengths: ReadonlyMap<string, number>, spec: string): [number, number] | null {
  let x = 0;
  let y = 0;
  const parts = pointParts(spec);
  for (const part of parts) {
    const name = partBone(part);
    const b = bones.get(name);
    if (b === undefined) return null;
    const l = part.endsWith(':tip') ? lengths.get(name) ?? 0 : 0;
    x += b.worldX + b.a * l;
    y += b.worldY + b.c * l;
  }
  return [x / parts.length, y / parts.length];
}

/** A rig point at the setup pose: a bone's origin, `name:tip`, or `a+b`. */
export function rigPoint(rest: Rest, spec: string): [number, number] | null {
  return pointAt(rest, new Map([...rest].map(([n, b]) => [n, b.length])), spec);
}

/** Check every name the map gives against the rig; every miss is named. */
export function resolveMap(map: JointMap, rest: Rest, where: string, slots: RigSlots = new Map()): void {
  const p = new Problems();
  const all = [...rest.keys()];
  const listed = all.length <= 40 ? all.join(', ') : `${all.slice(0, 40).join(', ')} … (${all.length} in all)`;
  const owner = new Map<string, string>();
  for (const c of map.chains) {
    c.bones.forEach((b, k) => {
      if (!rest.has(b)) {
        p.add('MAP_BONE_EXISTS', `chain "${c.name}" — bone "${b}" is not in the rig; its bones are ${listed}`);
        return;
      }
      const prev = owner.get(b);
      if (prev !== undefined) p.add('MAP_BONE_ONCE', `bone "${b}" is in chain "${prev}" and in chain "${c.name}"; a bone carries one segment`);
      owner.set(b, c.name);
      if (k > 0 && rest.has(c.bones[k - 1]!) && !descends(rest, b, c.bones[k - 1]!)) {
        p.add('MAP_CHAIN_ORDER', `chain "${c.name}" — bone "${b}" does not descend from "${c.bones[k - 1]}"; its parent is "${rest.get(b)!.parent}"`);
      }
      const aim = c.aim[k]!;
      if (aim === 'x') {
        const o = rest.get(b)!;
        if (Math.hypot(o.a, o.c) < 1e-9) p.add('MAP_AIM_LENGTH', `chain "${c.name}" — bone "${b}" has a collapsed x axis at setup (scale 0); aim it at a descendant`);
        return;
      }
      const [from, to] = aimEnds(b, aim);
      const verb = aim.includes('>') ? 'aims through' : 'aims at';
      let ok = true;
      for (const end of [from, to]) {
        for (const part of pointParts(end)) {
          const name = partBone(part);
          const which = part === end ? `"${end}"` : `"${part}" (of "${end}")`;
          if (!rest.has(name)) {
            p.add('MAP_AIM_EXISTS', `chain "${c.name}" — bone "${b}" ${verb} ${which}, which is not in the rig`);
            ok = false;
          } else if (name !== b && !descends(rest, name, b)) {
            p.add('MAP_AIM_DESCENDS', `chain "${c.name}" — bone "${b}" ${verb} "${name}", which does not descend from it; turning "${b}" would not turn that direction`);
            ok = false;
          }
        }
      }
      if (ok) {
        const pf = rigPoint(rest, from)!;
        const pt = rigPoint(rest, to)!;
        if (Math.hypot(pt[0] - pf[0], pt[1] - pf[1]) < 1e-6) p.add('MAP_AIM_LENGTH', `chain "${c.name}" — bone "${b}" aims from "${from}" to "${to}", which are at the same point; the direction is undefined`);
      }
    });
  }
  const t = map.translate;
  if (t !== null) {
    if (!rest.has(t.bone)) p.add('MAP_BONE_EXISTS', `"translate" — bone "${t.bone}" is not in the rig; its bones are ${listed}`);
    else {
      for (const b of owner.keys()) {
        if (descends(rest, t.bone, b)) p.add('MAP_TRANSLATE_PARENT', `"translate" — bone "${t.bone}" descends from "${b}", which chain "${owner.get(b)}" turns; a translated bone's parent frame must not move`);
      }
    }
    for (const r of t.scale.rig) {
      for (const part of pointParts(r)) if (!rest.has(partBone(part))) p.add('MAP_BONE_EXISTS', `"translate" "scale.rig" — "${r}"${part === r ? '' : ` reads "${partBone(part)}", which`} is not a bone in the rig (a point is a bone name, name:tip, or a+b)`);
    }
    const [r0, r1] = t.scale.rig.map((r) => rigPoint(rest, r));
    if (r0 && r1 && Math.hypot(r1[0] - r0[0], r1[1] - r0[1]) < 1e-6) p.add('MAP_TRANSLATE_SCALE', `"translate" "scale.rig" — "${t.scale.rig[0]}" and "${t.scale.rig[1]}" are at the same point; the length is 0`);
  }
  for (const c of map.chains) {
    const b = c.bones[0];
    if (!c.reach || t === null || b === undefined || !rest.has(b) || !rest.has(t.bone)) continue;
    if (b !== t.bone && !descends(rest, b, t.bone)) {
      p.add('MAP_REACH', `chain "${c.name}" — bone "${b}" reaches from its posed origin, but it does not descend from the translated bone "${t.bone}"; its origin would not travel with the anchor`);
    }
  }
  resolveAlternates(p, map.alternates, slots);
  if (p.any) p.list.unshift({ code: 'MAP_RESOLVES', text: `${where} does not resolve against the rig` });
  p.throwIfAny();
}

/** Every slot and attachment a set names, against the built rig: each slot exists, each attachment is in its slot under some skin, each hidden slot exists, once. */
function resolveAlternates(p: Problems, alternates: readonly AlternateSet[], slots: RigSlots): void {
  const all = [...slots.keys()];
  const listed = all.length === 0 ? 'none' : all.length <= 40 ? all.join(', ') : `${all.slice(0, 40).join(', ')} … (${all.length} in all)`;
  for (const a of alternates) {
    for (const [slot, att] of Object.entries(a.slots)) {
      const s = slots.get(slot);
      if (s === undefined) p.add('MAP_ALT_SLOT', `set "${a.name}" — slot "${slot}" is not in the rig; its slots are ${listed}`);
      else if (!s.attachments.has(att)) {
        const has = [...s.attachments];
        p.add('MAP_ALT_ATTACHMENT', `set "${a.name}" — slot "${slot}" has no attachment "${att}" under any skin; it has ${has.length === 0 ? 'none' : has.join(', ')}`);
      }
    }
    const seen = new Set<string>();
    for (const h of a.hides) {
      if (!slots.has(h)) p.add('MAP_ALT_HIDES', `set "${a.name}" hides slot "${h}", which is not in the rig; its slots are ${listed}`);
      else if (seen.has(h)) p.add('MAP_ALT_HIDES', `set "${a.name}" hides slot "${h}" twice`);
      seen.add(h);
    }
  }
}
