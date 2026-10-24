/** #408: supplied, calibrated bilateral shoulder elevation. Pure; no IO or held substitutes. */
import type { CompiledDocument, RawBone } from 'rig-c/core';
import { partBone, pointAt, pointParts, type JointMap, type Rest } from './map.ts';
import type { Joint, PoseSequence } from './pose.ts';
import { personTrack } from './pose.ts';
import { isObject, parseJson, Problems, Refusal, refuseUnknownKeys, type Problem } from './problems.ts';

export const SHOULDER_LIFT_SPEC = 'rig-pose-shoulder-lift/1';
export const SHOULDER_JOINTS = ['r_shoulder', 'l_shoulder', 'r_hip', 'l_hip', 'r_ear', 'l_ear'] as const;
type Name = typeof SHOULDER_JOINTS[number];
type Pt = [number, number];
type Points = Record<Name, Pt>;
type States = Record<Name, 'observed' | 'inferred'>;
interface Sampling { resolutionPx: number; pointErrorPx: number }
interface Calibration { value: number; absoluteError: number; source: string }
export interface ShoulderConfig {
  spec: typeof SHOULDER_LIFT_SPEC;
  sequenceSHA256: string;
  rigSHA256: string;
  person: string;
  camera: { mode: 'fixed' | 'normalised'; domain: string; source: string; residualPx: number };
  sampling: Sampling;
  rest: Sampling & { sequence: { path: string; sha256: string }; person: string; frames: number[]; armsDown: true };
  painting: Sampling & { path: string; sha256: string; width: number; height: number; armsDown: true; points: Points };
  calibration: { cameraToPainting: Calibration; paintingToRig: Calibration };
  target: { bone: string; shoulders: { r: string; l: string }; hips: { r: string; l: string }; ears: { r: string; l: string }; idle: 'add' };
}
const code = 'SHOULDER_LIFT_CONFIG';
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const pt = (v: unknown): v is Pt => Array.isArray(v) && v.length === 2 && v.every(finite);
const fail = (kind: string, message: string): never => { throw new Refusal([{ code: `SHOULDER_LIFT_${kind}`, text: `unknown — ${message}` }]); };

/** Every object is closed. A missing numeric bound is not a zero bound. */
export function readShoulderConfig(source: string, where: string): ShoulderConfig {
  let d: unknown;
  try { d = parseJson(source, where, code); } catch (e) { return fail('CONFIG', `${where}: ${String(e)}`); }
  const p = new Problems();
  const obj = (v: unknown, path: string, keys: string[]): Record<string, unknown> => {
    if (!isObject(v)) { p.add(code, `unknown — ${where} ${path}: expected object with ${keys.join(', ')}`); return {}; }
    refuseUnknownKeys(p, code, `${where} ${path}`, v, keys);
    for (const k of keys) if (!(k in v)) p.add(code, `unknown — ${where} ${path}.${k}: required field missing`);
    return v;
  };
  const str = (v: unknown, at: string) => { if (!text(v)) p.add(code, `unknown — ${where} ${at}: expected nonempty supplied string`); };
  const num = (v: unknown, at: string, positive = false) => { if (!finite(v) || (positive ? v <= 0 : v < 0)) p.add(code, `unknown — ${where} ${at}: expected finite ${positive ? 'positive' : 'nonnegative'} number, found ${String(v)}`); };
  const hash = (v: unknown, at: string) => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) p.add(code, `unknown — ${where} ${at}: expected supplied SHA-256`); };
  const sample = (v: Record<string, unknown>, at: string) => { num(v.resolutionPx, `${at}.resolutionPx`, true); num(v.pointErrorPx, `${at}.pointErrorPx`); };
  const root = obj(d, '', ['spec', 'sequenceSHA256', 'rigSHA256', 'person', 'camera', 'sampling', 'rest', 'painting', 'calibration', 'target']);
  if (root.spec !== SHOULDER_LIFT_SPEC) p.add(code, `unknown — ${where} spec: expected ${SHOULDER_LIFT_SPEC}, found ${String(root.spec)}`);
  hash(root.sequenceSHA256, 'sequenceSHA256'); hash(root.rigSHA256, 'rigSHA256'); str(root.person, 'person');
  const camera = obj(root.camera, 'camera', ['mode', 'domain', 'source', 'residualPx']);
  if (camera.mode !== 'fixed' && camera.mode !== 'normalised') p.add(code, `unknown — ${where} camera.mode: expected fixed or normalised`);
  str(camera.domain, 'camera.domain'); str(camera.source, 'camera.source'); num(camera.residualPx, 'camera.residualPx');
  sample(obj(root.sampling, 'sampling', ['resolutionPx', 'pointErrorPx']), 'sampling');
  const rest = obj(root.rest, 'rest', ['sequence', 'person', 'frames', 'armsDown', 'resolutionPx', 'pointErrorPx']);
  sample(rest, 'rest'); str(rest.person, 'rest.person');
  const ri = obj(rest.sequence, 'rest.sequence', ['path', 'sha256']); str(ri.path, 'rest.sequence.path'); hash(ri.sha256, 'rest.sequence.sha256');
  if (rest.armsDown !== true) p.add(code, `unknown — ${where} rest.armsDown: explicit true declaration required`);
  if (!Array.isArray(rest.frames) || rest.frames.length === 0 || rest.frames.some((v, i, a) => !Number.isSafeInteger(v) || v < 0 || (i > 0 && v <= a[i - 1]))) p.add(code, `unknown — ${where} rest.frames: expected nonempty strictly increasing nonnegative integer sample indices`);
  const painting = obj(root.painting, 'painting', ['path', 'sha256', 'width', 'height', 'armsDown', 'points', 'resolutionPx', 'pointErrorPx']);
  sample(painting, 'painting'); str(painting.path, 'painting.path'); hash(painting.sha256, 'painting.sha256'); num(painting.width, 'painting.width', true); num(painting.height, 'painting.height', true);
  if (painting.armsDown !== true) p.add(code, `unknown — ${where} painting.armsDown: explicit true declaration required`);
  const points = obj(painting.points, 'painting.points', [...SHOULDER_JOINTS]);
  for (const n of SHOULDER_JOINTS) if (!pt(points[n])) p.add(code, `unknown — ${where} painting.points.${n}: expected two finite picture coordinates`);
  const calibration = obj(root.calibration, 'calibration', ['cameraToPainting', 'paintingToRig']);
  for (const n of ['cameraToPainting', 'paintingToRig']) {
    const c = obj(calibration[n], `calibration.${n}`, ['value', 'absoluteError', 'source']);
    num(c.value, `${n}.value`, true); num(c.absoluteError, `${n}.absoluteError`); str(c.source, `${n}.source`);
    if (finite(c.value) && finite(c.absoluteError) && c.absoluteError >= c.value) p.add(code, `unknown — ${where} calibration.${n}: absoluteError must be smaller than value`);
  }
  const target = obj(root.target, 'target', ['bone', 'shoulders', 'hips', 'ears', 'idle']); str(target.bone, 'target.bone');
  if (target.idle !== 'add') p.add(code, `unknown — ${where} target.idle: expected explicit add`);
  for (const n of ['shoulders', 'hips', 'ears']) { const sides = obj(target[n], `target.${n}`, ['r', 'l']); str(sides.r, `target.${n}.r`); str(sides.l, `target.${n}.l`); }
  p.throwIfAny();
  return d as ShoulderConfig;
}
export interface ShoulderSample { frame: number; sourceTime: number; t: number; states: States; sequencePx: number; paintingPx: number; worldUnits: number; sourceBoundUnits: number; toleranceUnits: number }
export interface ShoulderReading {
  status: 'read'; method: 'bilateral-hip-ear-rest'; axis: 'world-up'; evidence: 'SUPPLIED'; target: ShoulderConfig['target'];
  camera: ShoulderConfig['camera']; calibration: ShoulderConfig['calibration']; sampling: Sampling;
  rest: { sampleIndices: number[]; q0: number; states: States[] };
  frames: ShoulderSample[];
}
export type ShoulderResult = ShoulderReading | { status: 'unknown'; problems: readonly Problem[] };
const mid = (a: Pt, b: Pt): Pt => [a[0] / 2 + b[0] / 2, a[1] / 2 + b[1] / 2];
const vector = (v: Points): Pt => { const h = mid(v.r_hip, v.l_hip), e = mid(v.r_ear, v.l_ear); return [e[0] - h[0], e[1] - h[1]]; };
const spanOf = (v: Points) => (v.r_hip[1] / 2 + v.l_hip[1] / 2) - (v.r_ear[1] / 2 + v.l_ear[1] / 2);
const elevOf = (v: Points) => (v.r_hip[1] / 2 + v.l_hip[1] / 2) - (v.r_shoulder[1] / 2 + v.l_shoulder[1] / 2);
const qOf = (v: Points) => { const span = spanOf(v); return span <= 0 ? Number.NaN : elevOf(v) / span; };
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1]! : s[s.length / 2 - 1]! / 2 + s[s.length / 2]! / 2; };
const errorOf = (s: Sampling, residual: number) => s.resolutionPx / 2 + s.pointErrorPx + residual;
/** Reject unrepresentable intermediates before comparisons: Infinity > Infinity is false. */
function calibrationFinite(p: Problems, at: string, values: Record<string, number>): boolean {
  let good = true;
  for (const [name, value] of Object.entries(values)) if (!finite(value)) {
    p.add('SHOULDER_LIFT_CALIBRATION', `unknown — ${at}: nonfinite ${name}=${value}; supplied calibration must be representable`); good = false;
  }
  return good;
}

/** The new reading inspects actual supplied input, before retarget can hold a missing point. */
export function readShoulderSignal(c: ShoulderConfig, seq: PoseSequence, rest: PoseSequence, minScore: number): ShoulderResult {
  const p = new Problems();
  if (!seq.cleaned || !rest.cleaned) p.add('SHOULDER_LIFT_INPUT', 'unknown — active and rest sequences must both have the actual cleaned record');
  if (seq.width !== rest.width || seq.height !== rest.height) p.add('SHOULDER_LIFT_CALIBRATION', `unknown — rest dimensions ${rest.width}x${rest.height} differ from active ${seq.width}x${seq.height}; require a common declared camera domain`);
  for (const [name, s] of [['active', seq], ['rest', rest]] as const) {
    if (c.camera.mode === 'normalised' && (!s.camera || !s.cameraSource)) p.add('SHOULDER_LIFT_CALIBRATION', `unknown — ${name} camera is absent or untraceable; normalised requires supplied camera and cameraSource`);
    if (c.camera.mode === 'fixed' && s.camera) p.add('SHOULDER_LIFT_CALIBRATION', `unknown — ${name} carries camera normalization but configuration declares fixed`);
  }
  const track = (s: PoseSequence, person: string, domain: string) => { try { return personTrack(s, person, domain); } catch (e) { p.add('SHOULDER_LIFT_INPUT', `unknown — ${domain} person "${person}": ${String(e)}`); return []; } };
  const active = track(seq, c.person, 'shoulder active'), resting = track(rest, c.rest.person, 'shoulder rest');
  const sample = (j: Partial<Record<string, Joint>>, i: number, t: number, domain: string): { points: Points; states: States } => {
    const points = {} as Points, states = {} as States;
    for (const n of SHOULDER_JOINTS) {
      const v = j[n];
      if (!v || (v.state !== 'observed' && v.state !== 'inferred') || !pt(v.at) || (v.score !== undefined && (!finite(v.score) || v.score < minScore))) p.add('SHOULDER_LIFT_JOINT', `unknown — ${domain} joint "${n}" frame ${i} (t=${t}s): found ${v?.state ?? 'absent'}${v?.score === undefined ? '' : ` score ${v.score}`}; require observed or inferred finite position with no supplied score below ${minScore}, no retarget hold`);
      else { points[n] = v.at; states[n] = v.state; }
    }
    return { points, states };
  };
  const a = active.map((j, i) => sample(j, i, seq.frames[i]!.t, 'active'));
  const r = c.rest.frames.flatMap(i => { if (i >= resting.length) { p.add('SHOULDER_LIFT_INPUT', `unknown — rest sampleIndex ${i} outside ${resting.length} supplied frames`); return []; } return [sample(resting[i]!, i, rest.frames[i]!.t, 'rest')]; });
  if (p.any) return { status: 'unknown', problems: p.list };
  const first = seq.frames[0]!.t;
  const times = seq.frames.map(f => Math.round((f.t - first) * 1e6) / 1e6);
  for (let i = 1; i < times.length; i++) if (times[i]! <= times[i - 1]!) p.add('POSE_TIME', `shoulder frames ${i - 1}/${i} collide after microsecond rounding`);
  const restSpan = r.map(s => spanOf(s.points)), activeSpan = a.map(s => spanOf(s.points));
  const restQ = r.map(s => qOf(s.points)), activeQ = a.map(s => qOf(s.points));
  restQ.forEach((q, i) => calibrationFinite(p, `rest sampleIndex ${c.rest.frames[i]}`, { span: restSpan[i]!, q }));
  activeQ.forEach((q, i) => calibrationFinite(p, `active frame ${i}`, { span: activeSpan[i]!, q }));
  times.forEach((t, i) => { if (!finite(t)) p.add('POSE_TIME', `shoulder frame ${i}: nonrepresentable source-relative microsecond time`); });
  if (p.any) return { status: 'unknown', problems: p.list };
  const q0 = median(restQ), span0 = median(restSpan);
  const { value: ca, absoluteError: da } = c.calibration.cameraToPainting, { value: cb, absoluteError: db } = c.calibration.paintingToRig;
  const gain = ca * cb, dg = cb * da + ca * db + da * db;
  const eR = errorOf(c.rest, c.camera.residualPx), eF = errorOf(c.sampling, c.camera.residualPx), ep = errorOf(c.painting, 0);
  const pv = vector(c.painting.points), pvNorm = Math.hypot(...pv);
  const maxA = ca + da, maxGain = gain + dg, pointErrorSum = eF + eR;
  calibrationFinite(p, 'calibration products', { q0, span0, gain, errorProductBA: cb * da, errorProductAB: ca * db, errorProductDADB: da * db, dg, maxA, maxGain, eR, eF, ep, pointErrorSum, paintingX: pv[0], paintingY: pv[1], paintingNorm: pvNorm });
  if (gain <= 0) p.add('SHOULDER_LIFT_CALIBRATION', 'unknown — nonrepresentable positive calibration gain');
  if (p.any) return { status: 'unknown', problems: p.list };
  for (const [index, s] of r.entries()) {
    const rv = vector(s.points), rvNorm = Math.hypot(...rv), scaledX = ca * rv[0], scaledY = ca * rv[1];
    const residualX = pv[0] - scaledX, residualY = pv[1] - scaledY, residual = Math.hypot(residualX, residualY);
    const scaledError = maxA * eR, coordinateError = ep + scaledError, coordinateBound = 2 * Math.SQRT2 * coordinateError, scaleBound = da * rvNorm;
    const bound = coordinateBound + scaleBound;
    if (!calibrationFinite(p, `rest sampleIndex ${c.rest.frames[index]}`, { restX: rv[0], restY: rv[1], restNorm: rvNorm, scaledX, scaledY, residualX, residualY, residual, scaledError, coordinateError, coordinateBound, scaleBound, bound })) continue;
    if (rvNorm === 0 || pvNorm === 0 || residual > bound) p.add('SHOULDER_LIFT_CALIBRATION', `unknown — rest sampleIndex ${c.rest.frames[index]} hip→ear calibration residual ${residual}px exceeds supplied bound ${bound}px`);
  }
  if (p.any) return { status: 'unknown', problems: p.list };
  const frames = a.map((s, frame): ShoulderSample => {
    const span = activeSpan[frame]!, df = activeQ[frame]! - q0, d = (elevOf(s.points) - q0 * span) * (span0 / span);
    const twiceGain = maxGain * 2, coordinateBound = twiceGain * pointErrorSum, scaleBound = Math.abs(d) * dg;
    const bound = coordinateBound + scaleBound, worldUnits = gain * d, paintingPx = ca * d, toleranceUnits = bound + 0.01;
    calibrationFinite(p, `frame ${frame}`, { df, d, twiceGain, coordinateBound, scaleBound, bound, worldUnits, paintingPx, toleranceUnits });
    return { frame, sourceTime: seq.frames[frame]!.t, t: times[frame]!, states: s.states, sequencePx: d, paintingPx, worldUnits, sourceBoundUnits: bound, toleranceUnits };
  });
  if (p.any) return { status: 'unknown', problems: p.list };
  if (seq.cleaned?.params.loop && frames.length > 1 && Math.abs(frames[0]!.worldUnits - frames.at(-1)!.worldUnits) > 0.01) p.add('SHOULDER_LIFT_LOOP', 'unknown — supplied shoulder endpoints disagree by more than 0.01 units; no inferred loop seam');
  if (p.any) return { status: 'unknown', problems: p.list };
  return { status: 'read', method: 'bilateral-hip-ear-rest', axis: 'world-up', evidence: 'SUPPLIED', target: c.target, camera: c.camera, calibration: c.calibration, sampling: c.sampling, rest: { sampleIndices: c.rest.frames, q0, states: r.map(s => s.states) }, frames };
}

export function shoulderRigGuard(c: ShoulderConfig, rest: Rest, map: JointMap, doc: CompiledDocument): void {
  const p = new Problems(), lengths = new Map([...rest].map(([n, v]) => [n, v.length]));
  const below = (bone: string, ancestor: string): boolean => { for (let b: string | null = bone; b !== null; b = rest.get(b)?.parent ?? null) if (b === ancestor) return true; return false; };
  if (!rest.has(c.target.bone)) p.add('SHOULDER_LIFT_RIG', `unknown — target bone "${c.target.bone}" is absent`);
  const rp = {} as Points;
  for (const [kind, r, l] of [['shoulders', 'r_shoulder', 'l_shoulder'], ['hips', 'r_hip', 'l_hip'], ['ears', 'r_ear', 'l_ear']] as const) for (const [side, joint] of [['r', r], ['l', l]] as const) {
    const name = c.target[kind][side], found = pointAt(rest, lengths, name);
    if (!found) p.add('SHOULDER_LIFT_RIG', `unknown — ${kind}.${side} rig point "${name}" is absent`);
    else rp[joint] = found;
    for (const part of pointParts(name)) {
      const bone = partBone(part);
      if (kind === 'shoulders' && !below(bone, c.target.bone)) p.add('SHOULDER_LIFT_RIG', `unknown — shoulder "${bone}" is not carried by target "${c.target.bone}"`);
      if (kind === 'hips' && below(bone, c.target.bone)) p.add('SHOULDER_LIFT_RIG', `unknown — target "${c.target.bone}" would move hip point "${bone}"`);
    }
  }
  // Translation moves the entire subtree, but only these ancestor paths carry
  // the target/shoulder world points. A separate hair branch cannot move them.
  const protectedBones = new Set<string>();
  const protect = (bone: string) => { for (let b: string | null = bone; b !== null; b = rest.get(b)?.parent ?? null) protectedBones.add(b); };
  protect(c.target.bone);
  for (const point of Object.values(c.target.shoulders)) for (const part of pointParts(point)) protect(partBone(part));
  const moved = new Set([...rest.keys()].filter(b => below(b, c.target.bone)));
  const affected = new Set([...protectedBones, ...moved]); // positional-solver conflicts remain conservative
  for (const bone of protectedBones) { const inherit = rest.get(bone)?.inherit; if (inherit !== undefined && inherit !== 'normal') p.add('SHOULDER_LIFT_RIG', `unknown — bone "${bone}" inherit ${inherit}; require normal on the protected shoulder path`); }
  for (const ct of doc.constraints) {
    const r = ct.record;
    // Exact 2.61.0 records distinguish reads from writes. Path geometry and
    // slider-driven physics are conservatively unresolved in this feature.
    const writes = !r || r.kind === 'path' || (r.kind === 'slider' && r.physics.length > 0) ? null : r.kind === 'physics' ? [r.bone] : r.kind === 'ik' || r.kind === 'transform' ? r.bones : r.timelines.bones.map(b => b.name);
    const reads = !r || r.kind === 'path' ? [] : r.kind === 'physics' ? [r.bone] : r.kind === 'ik' ? [...r.bones, r.target] : r.kind === 'transform' ? [...r.bones, r.source] : [r.bone, ...r.timelines.bones.map(b => b.name)].filter((b): b is string => b !== null);
    if (writes === null || reads.some(b => !rest.has(b)) || writes.some(b => !rest.has(b) || protectedBones.has(b))) p.add('SHOULDER_LIFT_RIG', `unknown — constraint "${ct.name}" (${ct.kind}) writes a protected shoulder path or its dependency is unresolved`);
  }
  if (map.translate && below(map.translate.bone, c.target.bone)) p.add('SHOULDER_LIFT_COMPOSITION', `unknown — target "${c.target.bone}" moves translated hip "${map.translate.bone}"`);
  for (const chain of map.chains) {
    if (chain.joints.some(j => /_(knee|ankle)$/.test(j)) && chain.bones.some(b => below(b, c.target.bone))) p.add('SHOULDER_LIFT_COMPOSITION', `unknown — target moves leg chain "${chain.name}"`);
    if (chain.reach && chain.bones.some(b => affected.has(b))) p.add('SHOULDER_LIFT_COMPOSITION', `unknown — reach chain "${chain.name}" depends on target "${c.target.bone}"`);
  }
  for (const set of map.alternates) if ((set.place || set.anchor || set.symmetric || set.support || Object.keys(set.offsets).some(b => affected.has(b))) && set.chains.some(n => map.chains.find(ch => ch.name === n)?.bones.some(b => affected.has(b)))) p.add('SHOULDER_LIFT_COMPOSITION', `unknown — positional/offset set "${set.name}" depends on target "${c.target.bone}"`);
  p.throwIfAny();
  const pv = vector(c.painting.points), rv = vector(rp), { value: b, absoluteError: db } = c.calibration.paintingToRig;
  const maxB = b + db, ep = errorOf(c.painting, 0), pvNorm = Math.hypot(...pv), rvNorm = Math.hypot(...rv);
  const scaledX = b * pv[0], scaledY = b * pv[1], residualX = rv[0] - scaledX, residualY = rv[1] + scaledY;
  const coordinateGain = 2 * Math.SQRT2 * maxB, coordinateBound = coordinateGain * ep, scaleBound = db * pvNorm;
  const bound = coordinateBound + scaleBound + 0.01, residual = Math.hypot(residualX, residualY);
  calibrationFinite(p, 'rig hip→ear calibration', { paintingX: pv[0], paintingY: pv[1], paintingNorm: pvNorm, rigX: rv[0], rigY: rv[1], rigNorm: rvNorm, maxB, ep, scaledX, scaledY, residualX, residualY, coordinateGain, coordinateBound, scaleBound, bound, residual });
  p.throwIfAny();
  if (residual > bound || rvNorm === 0 || pvNorm === 0) fail('CALIBRATION', `rig hip→ear residual ${residual} units exceeds supplied bound ${bound}`);
}
/** The same declared 8192 component bound applies after composing world lift. */
export function shoulderOrigin(point: string, at: readonly [number, number], frame: number): void {
  if (!at.every(finite) || Math.max(Math.abs(at[0]), Math.abs(at[1])) > 8192) fail('RIG', `point "${point}" frame ${frame}: final world origin [${at.join(', ')}] must have finite component magnitudes <= 8192 units`);
}
/** Guard actual matrices, never infer world-up from a local axis. */
export function shoulderMatrix(b: RawBone, frame: number): void {
  const x = Math.hypot(b.a, b.c), y = Math.hypot(b.b, b.d);
  if (![b.a, b.b, b.c, b.d, b.worldX, b.worldY].every(finite) || Math.max(Math.abs(b.worldX), Math.abs(b.worldY)) > 8192 || x < 1 / 16 || x > 16 || y < 1 / 16 || y > 16 || b.a * b.d - b.b * b.c <= 0 || Math.abs(x - y) > 1e-6 * Math.max(x, y) || Math.abs(b.a * b.b + b.c * b.d) > 1e-6 * x * y) fail('RIG', `bone "${b.name}" frame ${frame}: matrix must be finite, positive uniform scale [1/16,16], no shear/reflection, origins within 8192 units`);
}
export function shoulderLocal(parent: RawBone | null, base: Pt, neutral: Pt, lift: number, frame: number): Pt {
  if (parent) shoulderMatrix(parent, frame);
  const dx = base[0] - neutral[0], dy = base[1] + lift - neutral[1];
  const det = parent ? parent.a * parent.d - parent.b * parent.c : 1;
  const x = parent ? (parent.d * dx - parent.b * dy) / det : dx;
  const y = parent ? (-parent.c * dx + parent.a * dy) / det : dy;
  if (![x, y].every(finite) || Math.max(Math.abs(x), Math.abs(y)) > 8192) fail('RIG', `target local translation frame ${frame}: nonfinite or outside 8192 units`);
  const round = (v: number) => { const n = Math.round(v * 1e6) / 1e6; return Object.is(n, -0) ? 0 : n; };
  return [round(x), round(y)];
}
