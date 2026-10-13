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
 * `translate` moves one bone by the travel of one point, scaled by the ratio of
 * a length measured on the rig (between two bones' origins; `name:tip` is the
 * end of a bone's x axis) to the same length measured in the pose (its median
 * over the frames where both points are good).
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
}
export interface Translate {
  bone: string;
  joint: string;
  scale: { pose: [string, string]; rig: [string, string] };
}
export interface JointMap {
  chains: Chain[];
  translate: Translate | null;
}

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
  refuseUnknownKeys(p, 'MAP_KEYS', where, doc, ['spec', 'note', 'chains', 'translate']);
  if (doc.spec !== MAP_SPEC) p.add('MAP_SPEC', `${where} "spec" is ${typeName(doc.spec)}; this reader reads "${MAP_SPEC}"`);
  const chains: Chain[] = [];
  if (!Array.isArray(doc.chains) || doc.chains.length === 0) {
    p.add('MAP_CHAINS', `${where} "chains" is ${typeName(doc.chains)}; it must be a non-empty array of chains`);
  } else {
    const names = new Set<string>();
    doc.chains.forEach((c: unknown, i: number) => {
      const cw = `${where} chains[${i}]`;
      if (!isObject(c)) {
        p.add('MAP_CHAIN_SHAPE', `${cw} is ${typeName(c)}; a chain is { name, bones, joints, aim?, bend? }`);
        return;
      }
      refuseUnknownKeys(p, 'MAP_KEYS', cw, c, ['name', 'bones', 'joints', 'aim', 'bend']);
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
        if (a === null || bones === null || a.length !== bones.length) p.add('MAP_CHAIN_AIM', `${label} "aim" is ${typeName(c.aim)}; it must be one entry per bone ("x", a descendant bone's name, or "a>b")`);
        else aim = a;
      }
      let bend: Bend = 'rest';
      if ('bend' in c) {
        if (typeof c.bend !== 'string' || !(BENDS as readonly string[]).includes(c.bend)) p.add('MAP_CHAIN_BEND', `${label} "bend" is ${typeName(c.bend)}; it must be one of ${BENDS.join(', ')}`);
        else bend = c.bend as Bend;
      }
      chains.push({ name: name ?? cw, bones: bones ?? [], joints: joints ?? [], aim, bend });
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
        if (typeof t.bone === 'string' && typeof t.joint === 'string') translate = { bone: t.bone, joint: t.joint, scale: { pose: [pose[0]!, pose[1]!], rig: [rig[0]!, rig[1]!] } };
      }
    }
  }
  p.throwIfAny();
  return { chains, translate };
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : null;
}

/** Whether `bone` descends from `ancestor` (strictly). */
export function descends(rest: Rest, bone: string, ancestor: string): boolean {
  for (let b = rest.get(bone)?.parent ?? null; b !== null; b = rest.get(b)?.parent ?? null) if (b === ancestor) return true;
  return false;
}

/** The two points a non-`x` aim runs between: `"a>b"`, or the bone's origin to a descendant's. */
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
  const at = (spec: string): [number, number] => {
    const tip = spec.endsWith(':tip');
    const name = tip ? spec.slice(0, -4) : spec;
    const b = bones.get(name)!;
    const l = tip ? lengths.get(name) ?? 0 : 0;
    return [b.worldX + b.a * l, b.worldY + b.c * l];
  };
  const [f, t] = aimEnds(bone, aim).map(at) as [[number, number], [number, number]];
  return Math.atan2(t[1] - f[1], t[0] - f[0]) * DEG;
}

/** A rig point: a bone's origin, or `name:tip`, the end of its x axis. */
export function rigPoint(rest: Rest, spec: string): [number, number] | null {
  const tip = spec.endsWith(':tip');
  const b = rest.get(tip ? spec.slice(0, -4) : spec);
  if (b === undefined) return null;
  return tip ? [b.worldX + b.a * b.length, b.worldY + b.c * b.length] : [b.worldX, b.worldY];
}

/** Check every name the map gives against the rig; every miss is named. */
export function resolveMap(map: JointMap, rest: Rest, where: string): void {
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
        const name = end.endsWith(':tip') ? end.slice(0, -4) : end;
        if (!rest.has(name)) {
          p.add('MAP_AIM_EXISTS', `chain "${c.name}" — bone "${b}" ${verb} "${end}", which is not in the rig`);
          ok = false;
        } else if (name !== b && !descends(rest, name, b)) {
          p.add('MAP_AIM_DESCENDS', `chain "${c.name}" — bone "${b}" ${verb} "${name}", which does not descend from it; turning "${b}" would not turn that direction`);
          ok = false;
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
    for (const r of t.scale.rig) if (rigPoint(rest, r) === null) p.add('MAP_BONE_EXISTS', `"translate" "scale.rig" — "${r}" is not a bone in the rig (a bone name, or name:tip)`);
    const [r0, r1] = t.scale.rig.map((r) => rigPoint(rest, r));
    if (r0 && r1 && Math.hypot(r1[0] - r0[0], r1[1] - r0[1]) < 1e-6) p.add('MAP_TRANSLATE_SCALE', `"translate" "scale.rig" — "${t.scale.rig[0]}" and "${t.scale.rig[1]}" are at the same point; the length is 0`);
  }
  if (p.any) p.list.unshift({ code: 'MAP_RESOLVES', text: `${where} does not resolve against the rig` });
  p.throwIfAny();
}
