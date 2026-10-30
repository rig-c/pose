/** #472: original-angle oracle, independently wrong extraction map, and live constraints. */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { linkSync, symlinkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poseRawAnimation, readModel, underNoSkin, type CompiledDocument } from '@rig-c/core/core';
import { extractSequence, readExtractMap, type ExtractMap } from '../src/extract.ts';
import { runExtract } from '../src/runextract.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { runRigc } from '../src/rigc.ts';

const ROOT = join(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temporary = (): string => { const dir = mkdtempSync(join(tmpdir(), 'pose-extract-')); dirs.push(dir); return dir; };
const json = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value));
const mapOf = (joints: ExtractMap['joints']): ExtractMap => ({ spec: 'rig-pose-extract-map/1', sidedness: { right: 'subject right, named r', left: 'subject left, named l' }, joints });
const makeMap = (): ExtractMap => mapOf([
  { joint: 'neck', bone: 'neck', point: 'origin' },
  { joint: 'r_hip', bone: 'hip_r', point: 'origin' }, { joint: 'l_hip', bone: 'hip_l', point: 'origin' },
  ...(['r', 'l'] as const).flatMap(side => [
    { joint: `${side}_shoulder` as const, bone: `upper_${side}`, point: 'origin' as const },
    { joint: `${side}_elbow` as const, bone: `upper_${side}`, point: 'tip' as const },
    { joint: `${side}_wrist` as const, bone: `lower_${side}`, point: 'tip' as const },
  ]),
]);

function fixture(extra: { constraints?: object[]; tracks?: object[]; bones?: object[] } = {}): { dir: string; doc: CompiledDocument; model: string } {
  const dir = temporary();
  const bones = [
    { name: 'root' }, { name: 'hip', parent: 'root', y: 500 },
    { name: 'neck', parent: 'hip', y: 220 }, { name: 'hip_r', parent: 'hip', x: -20 }, { name: 'hip_l', parent: 'hip', x: 20 },
    { name: 'upper_r', parent: 'hip', x: -40, y: 180, rotation: -100, length: 140 },
    { name: 'lower_r', parent: 'upper_r', x: 140, rotation: 25, length: 120 },
    { name: 'upper_l', parent: 'hip', x: 40, y: 180, rotation: -80, length: 140 },
    { name: 'lower_l', parent: 'upper_l', x: 140, rotation: -25, length: 120 },
    ...(extra.bones ?? []),
  ];
  json(join(dir, 'rig.json'), { spec: 'rigc-rig/1', name: 'extract', skeleton: { width: 800, height: 1200 }, bones, slots: [], skins: {}, constraints: extra.constraints ?? [] });
  const tracks = extra.tracks ?? ['upper_r', 'lower_r', 'upper_l', 'lower_l'].map((bone, i) => ({ bone, property: 'rotate', keys: [{ t: 0, v: [i * 2] }, { t: 0.5, v: [(i % 2 ? -1 : 1) * (8 + i)] }, { t: 1, v: [i * 2] }] }));
  json(join(dir, 'motion.json'), { spec: 'rigc-motion/1', archetype: 'extract', cut: 'extract', easings: {}, animations: { source: { duration: 1, tracks } } });
  const run = runRigc(['build', '--rig', join(dir, 'rig.json'), '--motion', join(dir, 'motion.json'), '--out', join(dir, 'build'), '--profile', 'spine']);
  expect(run.status, run.out).toBe(0);
  const model = join(dir, 'build/skeleton.model.json');
  return { dir, model, doc: underNoSkin(readModel(readFileSync(model, 'utf8'))) };
}

test('identity: every mapped carrier matches the original source on every frame at fixed 0.05 degrees', () => {
  const { dir, model, doc } = fixture();
  const map = makeMap();
  const targetMap = { spec: 'rig-pose-map/1', chains: (['r', 'l'] as const).map(side => ({ name: `arm_${side}`, bones: [`upper_${side}`, `lower_${side}`], joints: [`${side}_shoulder`, `${side}_elbow`, `${side}_wrist`], bend: 'free' })) };
  // The source document and target map stay fixed. Only the extractor's map is planted.
  if (process.env.EXTRACT_WRONG_MAP === '1') for (const row of map.joints) if (/^(upper|lower)_[rl]$/.test(row.bone)) row.bone = row.bone.endsWith('_r') ? row.bone.slice(0, -1) + 'l' : row.bone.slice(0, -1) + 'r';
  json(join(dir, 'extract-map.json'), map); json(join(dir, 'target-map.json'), targetMap);
  const raw = join(dir, 'pose.json'), cleaned = join(dir, 'clean.json');
  runExtract({ model, map: join(dir, 'extract-map.json'), animation: 'source', fps: 60, loop: false, out: raw }, () => {});
  const cli = (args: string[]): void => { const r = spawnSync(process.execPath, [join(ROOT, 'cli.ts'), ...args], { encoding: 'utf8' }); expect(r.status, r.stdout + r.stderr).toBe(0); };
  cli(['clean', '--pose', raw, '--out', cleaned, '--legs', '1', '--rest', '1', '--hold', 'off']);
  const seq = readPoseSequence(readFileSync(cleaned, 'utf8'), cleaned);
  expect(seq.cleaned!.spikes.found).toHaveLength(0);
  cli(['retarget', '--rig', join(dir, 'rig.json'), '--map', join(dir, 'target-map.json'), '--sequence', cleaned, '--animation', 'copy', '--out', join(dir, 'copy.motion.json'), '--build', join(dir, 'copy')]);
  const result = underNoSkin(readModel(readFileSync(join(dir, 'copy/skeleton.model.json'), 'utf8')));
  const times = seq.frames.map(f => f.t), steps = times.slice(1).map((t, i) => t - times[i]!);
  const original = poseRawAnimation(doc, 'source', steps), copied = poseRawAnimation(result, 'copy', steps);
  const carriers = [...new Set(makeMap().joints.map(row => row.bone))];
  let max = 0;
  original.forEach((pose, i) => {
    for (const name of carriers) {
      const a = pose.bones.find(b => b.name === name)!.rotationX, b = copied[i]!.bones.find(b => b.name === name)!.rotationX;
      const error = Math.abs(((a - b + 540) % 360) - 180); max = Math.max(max, error);
      expect(error, `source oracle bone ${name} frame ${i}`).toBeLessThanOrEqual(0.05);
    }
  });
  console.log(`EXTRACT_IDENTITY frames=${times.length} bones=${carriers.length} maxDegrees=${max} tolerance=0.05`);
}, 120_000);

test('observed origins/tips, missing face, declared framing and deterministic provenance', () => {
  const { dir, model, doc } = fixture(); const map = makeMap(); const mapPath = join(dir, 'map.json'); json(mapPath, map);
  const args = { model, map: mapPath, animation: 'source', fps: 30, loop: false, out: join(dir, 'pose.json') };
  runExtract(args, () => {}); const first = readFileSync(args.out, 'utf8'), record = readFileSync(`${args.out}.extract.json`, 'utf8'); runExtract(args, () => {});
  expect(readFileSync(args.out, 'utf8')).toBe(first); expect(readFileSync(`${args.out}.extract.json`, 'utf8')).toBe(record);
  const seq = readPoseSequence(first, 'output');expect(Object.keys(seq.frames[0]!.people[0]!.joints)).toHaveLength(18);expect(seq.frames[0]!.people[0]!.joints.nose).toEqual({ state: 'missing' });
  const x = extractSequence(doc, map, { animation: 'source', fps: 30, loop: false }, 'model');
  const bone = poseRawAnimation(doc, 'source', [])[0]!.bones.find(b => b.name === 'upper_r')!;
  expect(x.sequence.frames[0]!.people[0]!.joints.r_elbow!.at![0]).toBeCloseTo(bone.worldX + bone.a * 140 - x.envelope.left, 8);
  expect(JSON.parse(record).map.sidedness).toEqual(map.sidedness);expect(JSON.parse(record).sourceSHA256).toHaveLength(64);
  expect(writePoseSequence(x.sequence)).toBe(first);
}, 30_000);

test('named IK is applied before sampling; omitting the constraint changes the result', () => {
  const { doc } = fixture({ bones: [{ name: 'ik_upper', parent: 'root', length: 100 }, { name: 'ik_lower', parent: 'ik_upper', x: 100, length: 100 }, { name: 'target', parent: 'root', x: 130, y: 80 }], constraints: [{ type: 'ik', name: 'reach', bones: ['ik_upper', 'ik_lower'], target: 'target', mix: 1, bendPositive: true }] });
  const map = mapOf([{ joint: 'r_wrist', bone: 'ik_lower', point: 'tip' }]);
  const result = extractSequence(doc, map, { animation: 'source', fps: 30, loop: false }, 'ik');
  const at = result.sequence.frames[0]!.people[0]!.joints.r_wrist!.at!;
  expect(at[0] + result.envelope.left).toBeCloseTo(130, 3); expect(result.envelope.top - at[1]).toBeCloseTo(80, 3);
  const planted = extractSequence({ ...doc, constraints: [] }, map, { animation: 'source', fps: 30, loop: false }, 'no-ik');
  const wrong = planted.sequence.frames[0]!.people[0]!.joints.r_wrist!.at!;
  expect(Math.hypot(wrong[0] + planted.envelope.left - 130, planted.envelope.top - wrong[1] - 80)).toBeGreaterThan(50);
}, 30_000);

test('physics keeps history: sequential samples differ from a fresh single jump and an absent constraint', () => {
  const { doc } = fixture({ bones: [{ name: 'pendulum', parent: 'hip', length: 130, rotation: -90 }], constraints: [{ type: 'physics', name: 'sway', bone: 'pendulum', rotate: 1, inertia: 0.8, strength: 20, damping: 0.9, mass: 1, mix: 1 }], tracks: [{ bone: 'hip', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: 0.25, v: [60, 0] }, { t: 0.5, v: [-60, 0] }, { t: 1, v: [0, 0] }] }] });
  const map = mapOf([{ joint: 'r_wrist', bone: 'pendulum', point: 'tip' }]);
  const seq = extractSequence(doc, map, { animation: 'source', fps: 60, loop: false }, 'physics');
  const plain = extractSequence({ ...doc, constraints: [] }, map, { animation: 'source', fps: 60, loop: false }, 'no-physics');
  const world = (r: typeof seq, i: number): number[] => { const p = r.sequence.frames[i]!.people[0]!.joints.r_wrist!.at!;return [p[0] + r.envelope.left, r.envelope.top - p[1]]; };
  const error = seq.sequence.frames.map((_, i) => { const a = world(seq, i), b = world(plain, i);return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!); });
  expect(Math.max(...error)).toBeGreaterThan(1);
  const i = error.indexOf(Math.max(...error)), jumped = poseRawAnimation(doc, 'source', [seq.sequence.frames[i]!.t])[1]!.bones.find(b => b.name === 'pendulum')!;
  const at = world(seq, i);expect(Math.hypot(at[0]! - jumped.worldX - jumped.a * 130, at[1]! - jumped.worldY - jumped.c * 130)).toBeGreaterThan(0.1);
  expect(extractSequence(doc, map, { animation: 'source', fps: 60, loop: false }, 'physics')).toEqual(seq);
  console.log(`EXTRACT_PHYSICS maxVsAbsent=${Math.max(...error)} worstFrame=${i}`);
}, 30_000);

test('planted map refusals name duplicates, unknown joints/bones and missing point/sides', () => {
  const m = makeMap();
  expect(() => readExtractMap(JSON.stringify({ ...m, joints: [m.joints[0], m.joints[0]] }), 'map')).toThrow('EXTRACT_MAP_DUPLICATE');
  expect(() => readExtractMap(JSON.stringify({ ...m, joints: [{ joint: 'elbow', bone: 'x', point: 'origin' }] }), 'map')).toThrow('EXTRACT_MAP_JOINT');
  expect(() => readExtractMap(JSON.stringify({ ...m, joints: [{ joint: 'neck', bone: 'x' }] }), 'map')).toThrow('EXTRACT_MAP_POINT');
  expect(() => readExtractMap(JSON.stringify({ ...m, sidedness: {} }), 'map')).toThrow('EXTRACT_SIDEDNESS');
  const { doc } = fixture();
  expect(() => extractSequence(doc, mapOf([{ joint: 'neck', bone: 'absent', point: 'origin' }]), { animation: 'source', fps: 30, loop: false }, 'model')).toThrow('EXTRACT_MAP_BONE');
  expect(() => extractSequence(doc, m, { animation: 'absent', fps: 30, loop: false }, 'model')).toThrow('EXTRACT_ANIMATION');
}, 30_000);

test('raw generations refused with real atlas conversion remedy; refused outputs stay absent', () => {
  const dir = temporary(); json(join(dir, 'raw.json'), { skeleton: { spine: '4.2.0' }, bones: [] });json(join(dir, 'map.json'), makeMap());
  expect(() => runExtract({ model: join(dir, 'raw.json'), map: join(dir, 'map.json'), animation: 'x', fps: 30, loop: false, out: join(dir, 'result.json') }, () => {})).toThrow('EXTRACT_MODEL');
  try { runExtract({ model: join(dir, 'raw.json'), map: join(dir, 'map.json'), animation: 'x', fps: 30, loop: false, out: join(dir, 'result.json') }, () => {}); } catch (e) { expect(String(e)).toContain('--atlas-in source.atlas'); }
  expect(readdirSync(dir)).not.toContain('result.json');
});

test('loop boundary and mismatched rate are explicit; nonloop always stays on the declared grid', () => {
  const { doc } = fixture();const map = makeMap();
  const loop = extractSequence(doc, map, { animation: 'source', fps: 30, loop: true }, 'loop');expect(loop.sequence.frames).toHaveLength(30);expect(loop.sampling.period).toBe(1);expect(loop.sampling.endpoint).toBe('excluded');
  expect(() => extractSequence(doc, map, { animation: 'source', fps: 2.5, loop: true }, 'loop')).toThrow('EXTRACT_LOOP_RATE');
  const plain = extractSequence(doc, map, { animation: 'source', fps: 2.5, loop: false }, 'nonloop');expect(plain.sequence.frames.map(f => f.t)).toEqual([0, 0.4, 0.8, 1.2]);expect(plain.sampling.animationTimes[3]).toBe(1);
}, 30_000);


test('all uses numbered safe names, preflights destinations and preserves input files', () => {
  const { dir, model } = fixture();const map = join(dir, 'map.json');json(map, makeMap());
  const raw = JSON.parse(readFileSync(model, 'utf8'));
  raw.animations.push({ ...raw.animations[0], name: '../source' });
  raw.editorOrder.animations.push('../source');
  json(model, raw);
  const out = join(dir, 'all');
  runExtract({ model, map, animation: 'all', fps: 30, loop: false, out }, () => {});
  expect(readdirSync(out).sort()).toEqual(['0000.pose.json', '0000.pose.json.extract.json', '0001.pose.json', '0001.pose.json.extract.json']);
  expect(JSON.parse(readFileSync(join(out, '0001.pose.json.extract.json'), 'utf8')).animation).toBe('../source');
  const before = readFileSync(model, 'utf8');
  expect(() => runExtract({ model, map, animation: 'source', fps: 30, loop: false, out: model }, () => {})).toThrow('ARG_PATH');
  expect(readFileSync(model, 'utf8')).toBe(before);
  const blocked = join(dir, 'file');writeFileSync(blocked, 'unchanged');
  expect(() => runExtract({ model, map, animation: 'all', fps: 30, loop: false, out: blocked }, () => {})).toThrow('ARG_PATH');
  expect(readFileSync(blocked, 'utf8')).toBe('unchanged');
}, 30_000);


test('loop record measures a nonzero sampled gap without welding either sample', () => {
  const { doc, dir, model } = fixture(); const map = makeMap();
  const loop = extractSequence(doc, map, { animation: 'source', fps: 30, loop: true }, 'loop');
  const gap = loop.boundary;
  expect(gap.kind).toBe('sampled-last-to-first-gap');expect(gap.note).toContain('not the exact physical seam');
  expect(gap.from.frame).toBe(29);expect(gap.from.labelTime).toBe(29 / 30);expect(gap.to.frame).toBe(0);
  expect(gap.joints).toHaveLength(map.joints.length);expect(gap.summary.maxDistance).toBeGreaterThan(0.1);
  for (const row of gap.joints) {
    const a = loop.sequence.frames[29]!.people[0]!.joints[row.joint]!.at!, b = loop.sequence.frames[0]!.people[0]!.joints[row.joint]!.at!;
    expect(row.picture.dx).toBeCloseTo(b[0] - a[0], 8);expect(row.picture.dy).toBeCloseTo(b[1] - a[1], 8);
    expect(row.world.dy).toBe(-row.picture.dy);expect(row.world.distance).toBe(row.picture.distance);
  }
  const plain = extractSequence(doc, map, { animation: 'source', fps: 30, loop: false }, 'nonloop');
  expect(loop.sequence.frames[29]).toEqual(plain.sequence.frames[29]);expect(loop.sequence.frames[0]).toEqual(plain.sequence.frames[0]);
  json(join(dir, 'map.json'), map);
  runExtract({ model, map: join(dir, 'map.json'), animation: 'source', fps: 30, loop: true, out: join(dir, 'loop.json') }, () => {});
  expect(JSON.parse(readFileSync(join(dir, 'loop.json.extract.json'), 'utf8')).boundary).toEqual(JSON.parse(JSON.stringify(gap)));
}, 30_000);

for (const kind of ['symlink', 'hardlink'] as const) test(`${kind} output aliases cannot overwrite model/map inputs or sidecars`, () => {
  const { dir, model } = fixture();const map = join(dir, 'map.json');json(map, makeMap());
  for (const input of [model, map]) for (const sidecar of [false, true]) {
    const out = join(dir, `${kind}-${input === map ? 'map' : 'model'}-${sidecar}.json`);
    const alias = sidecar ? `${out}.extract.json` : out;
    if (kind === 'symlink') symlinkSync(input, alias);else linkSync(input, alias);
    const before = readFileSync(input);
    expect(() => runExtract({ model, map, animation: 'source', fps: 30, loop: false, out }, () => {})).toThrow('ARG_PATH');
    expect(readFileSync(input)).toEqual(before);
  }
}, 30_000);
