/** Skeleton landmarks read through the named core poser; no source-format solver. */
import { openTrack, physicsClockStep, poseRawAnimationEach, type CompiledDocument, type RawPose } from '@rig-c/core/core';
import { BODY18, isBody18, type Body18 } from './joints.ts';
import { POSE_SPACE, POSE_SPEC, type Joint, type PoseSequence } from './pose.ts';
import { isObject, parseJson, Problems, Refusal, refuseUnknownKeys, typeName } from './problems.ts';

export const EXTRACT_MAP_SPEC = 'rig-pose-extract-map/1';
export interface ExtractMap {
  spec: typeof EXTRACT_MAP_SPEC;
  sidedness: { right: string; left: string };
  joints: Array<{ joint: Body18; bone: string; point: 'origin' | 'tip' }>;
}

export function readExtractMap(text: string, where: string): ExtractMap {
  const value = parseJson(text, where, 'EXTRACT_MAP');
  const p = new Problems();
  if (!isObject(value)) throw new Refusal([{ code: 'EXTRACT_MAP', text: `${where} is ${typeName(value)}; expected an extraction map object` }]);
  refuseUnknownKeys(p, 'EXTRACT_MAP_KEYS', where, value, ['spec', 'sidedness', 'joints']);
  if (value.spec !== EXTRACT_MAP_SPEC) p.add('EXTRACT_MAP_SPEC', `${where} spec is ${typeName(value.spec)}; required ${EXTRACT_MAP_SPEC}`);
  const sidedness = { right: '', left: '' };
  if (!isObject(value.sidedness)) p.add('EXTRACT_SIDEDNESS', `${where} sidedness is ${typeName(value.sidedness)}; required {right,left} declarations of the subject's sides`);
  else {
    refuseUnknownKeys(p, 'EXTRACT_MAP_KEYS', `${where} sidedness`, value.sidedness, ['right', 'left']);
    for (const side of ['right', 'left'] as const) {
      const v = value.sidedness[side];
      if (typeof v !== 'string' || v.trim() === '') p.add('EXTRACT_SIDEDNESS', `${where} sidedness.${side} is ${typeName(v)}; required a nonempty source-specific declaration`);
      else sidedness[side] = v;
    }
  }
  const joints: ExtractMap['joints'] = [];
  const seen = new Set<string>();
  if (!Array.isArray(value.joints) || value.joints.length === 0) p.add('EXTRACT_MAP', `${where} joints is ${typeName(value.joints)}; required a nonempty array of {joint,bone,point}`);
  else value.joints.forEach((row: unknown, i: number) => {
    const on = `${where} joints[${i}]`;
    if (!isObject(row)) { p.add('EXTRACT_MAP', `${on} is ${typeName(row)}; required {joint,bone,point}`); return; }
    refuseUnknownKeys(p, 'EXTRACT_MAP_KEYS', on, row, ['joint', 'bone', 'point']);
    if (typeof row.joint !== 'string' || !isBody18(row.joint)) p.add('EXTRACT_MAP_JOINT', `${on} joint is ${typeName(row.joint)}; required one of ${BODY18.join(', ')}`);
    else {
      if (seen.has(row.joint)) p.add('EXTRACT_MAP_DUPLICATE', `${on} maps joint "${row.joint}" twice; each body-18 joint may appear once`);
      seen.add(row.joint);
    }
    if (typeof row.bone !== 'string' || row.bone.trim() === '') p.add('EXTRACT_MAP_BONE', `${on} bone is ${typeName(row.bone)}; required a nonempty bone name`);
    if (row.point !== 'origin' && row.point !== 'tip') p.add('EXTRACT_MAP_POINT', `${on} point is ${typeName(row.point)}; required explicit origin or tip`);
    if (typeof row.joint === 'string' && isBody18(row.joint) && typeof row.bone === 'string' && (row.point === 'origin' || row.point === 'tip')) joints.push({ joint: row.joint, bone: row.bone, point: row.point });
  });
  p.throwIfAny();
  return { spec: EXTRACT_MAP_SPEC, sidedness, joints };
}

export interface ExtractOptions { animation: string; fps: number; loop: boolean }
export interface SampleBoundary {
  kind: 'sampled-last-to-first-gap';
  note: string;
  from: { frame: number; labelTime: number; trackTime: number; animationTime: number };
  to: { frame: 0; labelTime: 0; trackTime: number; animationTime: number };
  units: { world: 'core world units'; picture: 'picture px' };
  joints: Array<{ joint: Body18; bone: string; point: 'origin' | 'tip'; world: { dx: number; dy: number; distance: number }; picture: { dx: number; dy: number; distance: number } }>;
  summary: { maxDistance: number; joint: Body18; worldUnit: 'core world units'; pictureUnit: 'picture px' };
}
export interface Extraction {
  sequence: PoseSequence;
  envelope: { left: number; top: number; width: number; height: number; unit: 'one core world unit per picture pixel' };
  sampling: { fps: number; sourceDuration: number; period: number | null; loop: boolean; endpoint: 'included at first fixed-rate sample at or after duration' | 'excluded'; trackTimes: number[]; animationTimes: number[]; physics: { reset: 'animation'; clockLead: number; warmup: 0 } };
  boundary: SampleBoundary;
  depth: { boneZ: 'unavailable'; drawOrder: string[][]; note: string };
}

/** Each call opens a fresh sequential physics state, matching core render's clock. */
export function extractSequence(doc: CompiledDocument, map: ExtractMap, opts: ExtractOptions, where: string): Extraction {
  const p = new Problems();
  const animation = doc.animations.find(a => a.name === opts.animation);
  if (animation === undefined) p.add('EXTRACT_ANIMATION', `${where} has no animation "${opts.animation}"; available: ${doc.animations.map(a => a.name).join(', ') || 'none'}`);
  const product = (animation?.timelines.duration ?? 0) * opts.fps;
  if (!(Number.isFinite(opts.fps) && opts.fps > 0) || !Number.isSafeInteger(Math.ceil(product))) p.add('EXTRACT_RATE', `animation "${opts.animation}" fps ${opts.fps}, frame count ${product}; required a positive finite rate with a safe integer frame count`);
  const names = new Set(doc.bones.map(b => b.name));
  for (const row of map.joints) if (!names.has(row.bone)) p.add('EXTRACT_MAP_BONE', `${where} joint "${row.joint}" names bone "${row.bone}", which is absent; available: ${[...names].join(', ')}`);
  const count = Math.round(product);
  // Core holds durations as float32. Accept only uncertainty from one float32 rounding.
  if (opts.loop && animation !== undefined && (!(count > 0) || Math.abs(product - count) > Math.max(1, Math.abs(product)) * 2 ** -24)) p.add('EXTRACT_LOOP_RATE', `animation "${opts.animation}" duration ${animation.timelines.duration}s × fps ${opts.fps} = ${product}; a fixed-rate cycle requires a positive integral frame count within float32 duration rounding`);
  p.throwIfAny();
  const duration = animation!.timelines.duration;
  const times = opts.loop ? Array.from({ length: count }, (_, i) => i / opts.fps) : Array.from({ length: Math.ceil(product) + 1 }, (_, i) => i / opts.fps);
  const rows: Array<Partial<Record<Body18, Joint>>> = [];
  const trackTimes: number[] = [], animationTimes: number[] = [], drawOrder: string[][] = [];
  const lengths = new Map(doc.bones.map(b => [b.name, b.length ?? 0]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const visit = (pose: RawPose): void => {
    const joints: Partial<Record<Body18, Joint>> = {};
    const bones = new Map(pose.bones.map(b => [b.name, b]));
    for (const row of map.joints) {
      const b = bones.get(row.bone);
      if (b === undefined || !b.active) throw new Refusal([{ code: 'EXTRACT_INACTIVE', text: `${where} animation "${opts.animation}" frame ${rows.length}: joint "${row.joint}" bone "${row.bone}" is absent or inactive; an observed joint requires an active posed bone` }]);
      const length = row.point === 'tip' ? lengths.get(row.bone)! : 0;
      const x = b.worldX + b.a * length, y = b.worldY + b.c * length;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Refusal([{ code: 'EXTRACT_POSE', text: `${where} animation "${opts.animation}" frame ${rows.length} joint "${row.joint}" bone "${row.bone}" ${row.point} is [${x},${y}]; required finite coordinates` }]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      joints[row.joint] = { state: 'observed', at: [x, y] };
    }
    rows.push(joints); trackTimes.push(pose.trackTime); animationTimes.push(pose.animationTime); drawOrder.push([...pose.drawOrder]);
  };
  try {
    if (opts.loop) {
      const track = openTrack(doc, opts.animation, { loop: true, reset: 'animation', clock: physicsClockStep });
      visit(track.first);
      for (let i = 1; i < times.length; i++) visit(track.step(1 / opts.fps));
    } else poseRawAnimationEach(doc, opts.animation, times.slice(1).map(() => 1 / opts.fps), {}, 'animation', visit, physicsClockStep);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal([{ code: 'EXTRACT_POSE', text: `${where} animation "${opts.animation}" cannot be posed by core: ${(e as Error).message}` }]);
  }
  const left = Math.floor(minX), top = Math.ceil(maxY), width = Math.max(1, Math.ceil(maxX) - left), height = Math.max(1, top - Math.floor(minY));
  const frames = rows.map((row, i) => ({ t: times[i]!, people: [{ id: 'source', joints: Object.fromEntries(BODY18.map(joint => {
    const at = row[joint]?.at;
    return [joint, at === undefined ? { state: 'missing' } : { state: 'observed', at: [at[0] - left, top - at[1]] }];
  })) as Record<Body18, Joint> }] }));
  const last = rows.length - 1;
  const gaps = map.joints.map(row => {
    const a = rows[last]![row.joint]!.at!, b = rows[0]![row.joint]!.at!;
    const dx = b[0] - a[0], dy = b[1] - a[1], distance = Math.hypot(dx, dy);
    return { ...row, world: { dx, dy, distance }, picture: { dx, dy: -dy, distance } };
  });
  const worst = gaps.reduce((a, b) => b.world.distance > a.world.distance ? b : a);
  const boundary: SampleBoundary = {
    kind: 'sampled-last-to-first-gap',
    note: 'Unrounded mapped coordinates of the last and first samples; not the exact physical seam, not an endpoint equality or steady-state physics claim. Samples are not welded.',
    from: { frame: last, labelTime: times[last]!, trackTime: trackTimes[last]!, animationTime: animationTimes[last]! },
    to: { frame: 0, labelTime: 0, trackTime: trackTimes[0]!, animationTime: animationTimes[0]! },
    units: { world: 'core world units', picture: 'picture px' }, joints: gaps,
    summary: { maxDistance: worst.world.distance, joint: worst.joint, worldUnit: 'core world units', pictureUnit: 'picture px' },
  };
  return {
    sequence: { spec: POSE_SPEC, space: POSE_SPACE, width, height, source: `core animation ${opts.animation}`, frames },
    envelope: { left, top, width, height, unit: 'one core world unit per picture pixel' },
    sampling: { fps: opts.fps, sourceDuration: duration, period: opts.loop ? count / opts.fps : null, loop: opts.loop, endpoint: opts.loop ? 'excluded' : 'included at first fixed-rate sample at or after duration', trackTimes, animationTimes, physics: { reset: 'animation', clockLead: physicsClockStep(1) - 1, warmup: 0 } },
    boundary,
    depth: { boneZ: 'unavailable', drawOrder, note: 'Slot order is observed ordering, not signed limb depth or bone z; no depth is invented.' },
  };
}
