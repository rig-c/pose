/** #408: small real-reader pipeline, core gates and independent emitted world targets. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readModel } from 'rig-c/core';
import { Plate } from 'rig-c/plate';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { poseFrames } from '../src/verify.ts';
import { shoulderConfig, shoulderSequence } from './shoulderlift.test.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) if (!(process.env.POSE408_KEEP_INPUTS && d.split('/').at(-1)!.startsWith('shoulder-408-'))) rmSync(d, { recursive: true, force: true }); });
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function run(cli: string, args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  return { ...r, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
export function shoulderFixture(movingParent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'shoulder-408-')); made.push(dir);
  mkdirSync(join(dir, 'images'));
  const rig = join(dir, 'rig.json'), motion = join(dir, 'idle.json');
  writeFileSync(rig, JSON.stringify({ spec: 'rigc-rig/1', name: 'shoulder_control', images: 'images', skeleton: { width: 320, height: 240 }, bones: [
    { name: 'root' }, { name: 'parent', parent: 'root', x: 4, y: 6 }, { name: 'shoulder_ctl', parent: 'parent', y: 60 },
    { name: 'shoulder_r', parent: 'shoulder_ctl', x: -10 }, { name: 'shoulder_l', parent: 'shoulder_ctl', x: 10 },
    { name: 'ear_r', parent: 'shoulder_ctl', x: -5, y: 40 }, { name: 'ear_l', parent: 'shoulder_ctl', x: 5, y: 40 },
    { name: 'hip_r', parent: 'parent', x: -5 }, { name: 'hip_l', parent: 'parent', x: 5 }, { name: 'aim', parent: 'root', length: 10 },
  ], slots: [], skins: {} }));
  const targetIdle = { bone: 'shoulder_ctl', property: 'translate', keys: [{ t: 0, v: [0, 2] }, { t: .5, v: [1, 4] }, { t: 1.25, v: [0, 2] }] };
  writeFileSync(motion, JSON.stringify({ spec: 'rigc-motion/1', archetype: 'shoulder_control', cut: 'control', easings: {}, animations: { idle: { duration: 1.25, tracks: [targetIdle, ...(movingParent ? [
    { bone: 'parent', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: .5, v: [90] }, { t: 1.25, v: [0] }] },
    { bone: 'parent', property: 'scale', keys: [{ t: 0, v: [1, 1] }, { t: .5, v: [2, 2] }, { t: 1.25, v: [1, 1] }] },
    { bone: 'parent', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: .5, v: [10, -6] }, { t: 1.25, v: [0, 0] }] },
  ] : [])] } } }));
  const map = join(dir, 'map.json');
  writeFileSync(map, JSON.stringify({ spec: 'rig-pose-map/1', chains: [{ name: 'aim', bones: ['aim'], joints: ['neck', 'nose'] }] }));
  const writeRaw = (name: string, shifts: number[]) => {
    const d = JSON.parse(writePoseSequence(shoulderSequence(shifts))) as Record<string, unknown>; delete d.cleaned;
    const path = join(dir, name); writeFileSync(path, JSON.stringify(d)); return path;
  };
  const raw = writeRaw('raw.json', [0, 8, 16, -8, 0]), rawRest = writeRaw('rest-raw.json', [0, 0, 0]);
  const pose = join(dir, 'clean.json'), rest = join(dir, 'rest.json');
  for (const [input, output] of [[raw, pose], [rawRest, rest]]) {
    const r = run(CLI, ['clean', '--pose', input!, '--out', output!, '--legs', '1', '--rest', '1']);
    expect(r.status, r.stderr).toBe(0); readPoseSequence(readFileSync(output!, 'utf8'), output!);
  }
  const painting = join(dir, 'painting.png'); new Plate(640, 480).writePng(painting);
  const c = shoulderConfig(); c.sequenceSHA256 = sha(pose); c.rigSHA256 = sha(rig); c.rest.sequence.sha256 = sha(rest); c.painting.sha256 = sha(painting);
  const config = join(dir, 'shoulder.json'); writeFileSync(config, JSON.stringify(c));
  const args = ['retarget', '--rig', rig, '--base-motion', motion, '--map', map, '--pose', pose, '--name', 'calibrated', '--carry-idle'];
  return { dir, rig, motion, map, pose, rest, painting, config, c, args };
}
const load = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
test('CLI whole minimal chain: clean → config refs → gate → emitted poser/report/provenance; supplied idle adds in world axes', () => {
  for (const parent of [false, true]) {
    const f = shoulderFixture(parent), baseline = join(f.dir, 'baseline.json'), baseBuild = join(f.dir, 'baseline-build');
    const b = run(CLI, [...f.args, '--out', baseline, '--build', baseBuild]); expect(b.status, b.stderr).toBe(0);
    const out = join(f.dir, 'out.json'), build = join(f.dir, 'build'), report = join(f.dir, 'report.json');
    const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out, '--build', build, '--report', report]); expect(r.status, r.stderr).toBe(0);
    const times = [0, .25, .5, .75, 1], expected = [0, 4, 8, -4, 0];
    const old = poseFrames(readModel(readFileSync(join(baseBuild, 'skeleton.model.json'), 'utf8'), 'baseline'), 'calibrated', times);
    const actual = poseFrames(readModel(readFileSync(join(build, 'skeleton.model.json'), 'utf8'), 'emitted'), 'calibrated', times);
    for (let i = 0; i < times.length; i++) for (const name of ['shoulder_ctl', 'shoulder_r', 'shoulder_l']) {
      const before = old[i]!.get(name)!, after = actual[i]!.get(name)!;
      expect(Math.hypot(after.worldX - before.worldX, after.worldY - before.worldY - expected[i]!)).toBeLessThanOrEqual(.02);
    }
    const reading = load(report).shoulderLift;
    expect(reading.evidence).toBe('SUPPLIED'); expect(reading.landing.worst).toBeLessThanOrEqual(.01);
    expect(reading.rest.sampleIndices).toEqual([0]); expect(reading.rest).not.toHaveProperty('times');
    expect(reading.frames.map((v: { worldUnits: number }) => v.worldUnits)).toEqual(expected);
    expect(load(join(build, 'retarget.json')).inputs.shoulderLift.configuration.sha256).toBe(sha(f.config));
    const frozen = { motion: sha(out), report: sha(report), provenance: sha(join(build, 'retarget.json')) };
    const again = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out, '--build', build, '--report', report]); expect(again.status, again.stderr).toBe(0);
    expect({ motion: sha(out), report: sha(report), provenance: sha(join(build, 'retarget.json')) }).toEqual(frozen);
    if (process.env.POSE408_EVIDENCE) writeFileSync(join(process.env.POSE408_EVIDENCE, `control-${parent}.json`), JSON.stringify({ report: load(report), provenance: load(join(build, 'retarget.json')), hashes: frozen, expected, core: '2.61.0' }, null, 2));
    console.log(`SHOULDER_CONTROL parentMoving=${parent} exit=0 maxLanding=${reading.landing.worst} bound=.02 emitted=.01`);
  }
}, 60_000);
test('CLI missing actual input and missing calibration refuse by name, writing no output', () => {
  const f = shoulderFixture();
  const seq = readPoseSequence(readFileSync(f.pose, 'utf8'), 'actual cleaned'); seq.frames[2]!.people[0]!.joints.r_shoulder = { state: 'missing' };
  writeFileSync(f.pose, writePoseSequence(seq)); f.c.sequenceSHA256 = sha(f.pose); writeFileSync(f.config, JSON.stringify(f.c));
  const out = join(f.dir, 'refused.json');
  const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out]);
  expect(r.status).toBe(1); expect(r.stderr).toContain('SHOULDER_LIFT_JOINT'); expect(r.stderr).toContain('r_shoulder'); expect(existsSync(out)).toBe(false);
  const doc = load(f.config); delete doc.calibration; writeFileSync(f.config, JSON.stringify(doc));
  const unknown = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out]); expect(unknown.status).toBe(1); expect(unknown.stderr).toContain('calibration'); expect(existsSync(out)).toBe(false);
}, 30_000);

test('CLI resting source preserves composed idle bytes; reduced parent does not enlarge shoulder allowance', () => {
  const f = shoulderFixture(true);
  writeFileSync(f.pose, writePoseSequence(shoulderSequence([0, 0, 0, 0, 0], true))); f.c.sequenceSHA256 = sha(f.pose); f.c.sampling.pointErrorPx = 1; writeFileSync(f.config, JSON.stringify(f.c));
  const baseline = join(f.dir, 'rest-base.json'), out = join(f.dir, 'rest-lift.json');
  const flags = [...f.args, '--reduce', '1', '--reduce-hip', '3'];
  expect(run(CLI, [...flags, '--out', baseline]).status).toBe(0);
  const r = run(CLI, [...flags, '--shoulder-lift', f.config, '--out', out]); expect(r.status, r.stderr).toBe(0);
  expect(readFileSync(out, 'utf8')).toBe(readFileSync(baseline, 'utf8'));
  expect(load(out.replace('.json', '.report.json')).shoulderLift.landing.tolerance).toBe(.01);
}, 30_000);
test('CLI invalid parent scale and ambiguous fragment ownership refuse by name', () => {
  const f = shoulderFixture(); const rig = load(f.rig); rig.bones.find((b: {name:string}) => b.name === 'parent').scaleX = 2;
  writeFileSync(f.rig, JSON.stringify(rig)); f.c.rigSHA256 = sha(f.rig); writeFileSync(f.config, JSON.stringify(f.c));
  const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', join(f.dir, 'bad.json')]); expect(r.status).toBe(1); expect(r.stderr).toContain('SHOULDER_LIFT_RIG');
  delete rig.bones.find((b: {name:string}) => b.name === 'parent').scaleX;
  writeFileSync(f.rig, JSON.stringify(rig)); f.c.rigSHA256 = sha(f.rig); writeFileSync(f.config, JSON.stringify(f.c));
  const fragment = join(f.dir, 'fragment.json');
  writeFileSync(fragment, JSON.stringify({ spec: 'rig-pose-tracks/1', tracks: [{ bone: 'shoulder_ctl', property: 'translatey', keys: [{ t: 0, v: [5] }] }] }));
  const conflict = run(CLI, [...f.args, '--shoulder-lift', f.config, '--merge', fragment, '--out', join(f.dir, 'conflict.json')]);
  expect(conflict.status).toBe(1); expect(conflict.stderr).toMatch(/MERGE_CONFLICT|SHOULDER_LIFT_COMPOSITION/);
}, 30_000);
test('isolated source mutants: sign/scale/local-axis/idle/missing-held controls must turn red', () => {
  const base = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants'); mkdirSync(base, { recursive: true });
  const cases = [
    { name: 'sign', file: 'shoulderlift.ts', from: 'const span = activeSpan[frame]!, df = activeQ[frame]! - q0, d = (elevOf(s.points) - q0 * span) * (span0 / span);', to: 'const span = activeSpan[frame]!, df = q0 - activeQ[frame]!, d = (q0 * span - elevOf(s.points)) * (span0 / span);', test: 'shoulderlift.test.ts', filter: 'analytical normal' },
    { name: 'unnormalised-midpoint', file: 'shoulderlift.ts', from: 'const span = activeSpan[frame]!, df = activeQ[frame]! - q0, d = (elevOf(s.points) - q0 * span) * (span0 / span);', to: 'const span = activeSpan[frame]!, df = 0, d = (0.5 * span0 - q0 * span0) - (0.5 * span - elevOf(s.points));', test: 'shoulderlift.test.ts', filter: 'span-normalised' },
    { name: 'scale', file: 'shoulderlift.ts', from: 'const gain = ca * cb, dg', to: 'const gain = ca, dg', test: 'shoulderlift.test.ts', filter: 'analytical normal' },
    { name: 'local-axis', file: 'shoulderlift.ts', from: 'return [round(x), round(y)];', to: 'return [round(dx), round(dy)];', test: 'shoulderlift-cli.test.ts', filter: 'CLI whole minimal chain' },
    { name: 'idle', file: 'shoulderlift.ts', from: 'const dx = base[0] - neutral[0], dy = base[1] + lift - neutral[1];', to: 'const dx = 0, dy = lift;', test: 'shoulderlift-cli.test.ts', filter: 'CLI whole minimal chain' },
    { name: 'held-missing', file: 'shoulderlift.ts', from: 'const v = j[n];', to: "const v = j[n]?.state === 'missing' ? { state: 'observed' as const, at: [140,80] as [number,number] } : j[n];", test: 'shoulderlift.test.ts', filter: 'each actually missing joint' },
  ];
  for (const c of cases) {
    const dir = mkdtempSync(join(base, 'shoulder-mutant-')); made.push(dir);
    cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true }); mkdirSync(join(dir, 'test'));
    for (const file of ['cli.ts', 'package.json']) cpSync(join(ROOT, file), join(dir, file));
    for (const file of ['shoulderlift.test.ts', 'shoulderlift-cli.test.ts']) cpSync(join(ROOT, 'test', file), join(dir, 'test', file));
    const file = join(dir, 'src', c.file), original = readFileSync(file, 'utf8');
    expect(original.split(c.from)).toHaveLength(2); expect(statSync(file).nlink).toBe(1);
    writeFileSync(file, original.replace(c.from, c.to));
    const env = { ...process.env }; delete env.POSE408_EVIDENCE;
    const r = spawnSync(process.execPath, ['test', './test/' + c.test, '--test-name-pattern', c.filter], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, `${c.name} survived: ${r.stdout} ${r.stderr}`).not.toBe(0);
    expect(String(r.stdout) + String(r.stderr)).toContain('(fail)');
    writeFileSync(file, original); expect(sha(file)).toBe(sha(join(ROOT, 'src', c.file)));
    console.log(`SHOULDER_MUTANT ${c.name}: exit ${r.status}, actual control assertion red, source nlink 1, restored`);
  }
}, 60_000);

test('F1 rig calibration never passes a nonfinite intermediate from finite input', async () => {
  const f = shoulderFixture(), build = join(f.dir, 'guard-build');
  const b = run(CLI, [...f.args, '--out', join(f.dir, 'guard-base.json'), '--build', build]); expect(b.status, b.stderr).toBe(0);
  const doc = readModel(readFileSync(join(build, 'skeleton.model.json'), 'utf8'), 'actual build for calibration refusal');
  const { shoulderRigGuard, readShoulderConfig } = await import('../src/shoulderlift.ts');
  const { restOf } = await import('../src/rigc.ts'); const { readMap } = await import('../src/map.ts');
  for (const n of ['r_hip', 'l_hip'] as const) f.c.painting.points[n][0] = Number.MAX_VALUE;
  for (const n of ['r_ear', 'l_ear'] as const) f.c.painting.points[n][0] = -Number.MAX_VALUE;
  f.c.painting.pointErrorPx = Number.MAX_VALUE;
  const c = readShoulderConfig(JSON.stringify(f.c), 'finite overflowing painting');
  expect(() => shoulderRigGuard(c, restOf(doc), readMap(readFileSync(f.map, 'utf8'), 'actual map'), doc)).toThrow('SHOULDER_LIFT_CALIBRATION');
}, 30_000);

test('F2 actual rig allows disjoint descendant hair physics and non-normal inheritance', () => {
  const f = shoulderFixture(), rig = load(f.rig);
  rig.bones.push({ name: 'hair', parent: 'shoulder_ctl', x: 20, y: 50, length: 5, inherit: 'onlyTranslation' });
  rig.constraints = [{ name: 'hairPhysics', type: 'physics', bone: 'hair', rotate: 1, gravity: .1 }];
  writeFileSync(f.rig, JSON.stringify(rig)); f.c.rigSHA256 = sha(f.rig); writeFileSync(f.config, JSON.stringify(f.c));
  const build = join(f.dir, 'hair-build');
  const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', join(f.dir, 'hair.json'), '--build', build]);
  expect(r.status, r.stderr).toBe(0);
  const doc = readModel(readFileSync(join(build, 'skeleton.model.json'), 'utf8'), 'actual hair build');
  expect(doc.constraints.find(c => c.name === 'hairPhysics')?.record?.kind).toBe('physics');
}, 30_000);

test('F2 influencing physics and unresolved path dependencies are named refusals after actual rig build', () => {
  for (const kind of ['physics', 'path'] as const) {
    const f = shoulderFixture(), rig = load(f.rig);
    if (kind === 'physics') rig.constraints = [{ name: 'shoulderPhysics', type: 'physics', bone: 'shoulder_r', x: 1, y: 1 }];
    else {
      rig.bones.push({ name: 'pathFollower', parent: 'root', length: 5 });
      rig.slots = [{ name: 'guide', bone: 'root', attachment: 'guide' }];
      rig.skins = { default: { guide: { guide: { type: 'path', vertexCount: 6, vertices: [-5, 0, 0, 0, 3, 0, 7, 0, 10, 0, 15, 0] } } } };
      rig.constraints = [{ name: 'unresolvedPath', type: 'path', bones: ['pathFollower'], slot: 'guide' }];
    }
    writeFileSync(f.rig, JSON.stringify(rig)); f.c.rigSHA256 = sha(f.rig); writeFileSync(f.config, JSON.stringify(f.c));
    const out = join(f.dir, 'refused-constraint.json'); const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out]);
    expect(r.status, r.stderr).toBe(1); expect(r.stderr).toContain('SHOULDER_LIFT_RIG'); expect(r.stderr).toContain(kind === 'physics' ? 'shoulderPhysics' : 'unresolvedPath'); expect(existsSync(out)).toBe(false);
  }
}, 30_000);

test('CLI source, rig, rest and painting identity mismatches refuse the exact named input', () => {
  const f = shoulderFixture();
  const cases = [
    { field: 'sequenceSHA256', change: () => { f.c.sequenceSHA256 = '0'.repeat(64); } },
    { field: 'rigSHA256', change: () => { f.c.rigSHA256 = '0'.repeat(64); } },
    { field: 'rest.sequence.sha256', change: () => { f.c.rest.sequence.sha256 = '0'.repeat(64); } },
    { field: 'painting.sha256', change: () => { f.c.painting.sha256 = '0'.repeat(64); } },
  ];
  for (const c of cases) {
    const original = structuredClone(f.c); c.change(); writeFileSync(f.config, JSON.stringify(f.c));
    const out = join(f.dir, 'identity-refused.json'), r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out]);
    expect(r.status).toBe(1); expect(r.stderr).toContain(c.field); expect(existsSync(out)).toBe(false);
    Object.assign(f.c, original);
  }
  f.c.calibration.paintingToRig.value = .5; writeFileSync(f.config, JSON.stringify(f.c));
  const bad = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', join(f.dir, 'scale-refused.json')]);
  expect(bad.status).toBe(1); expect(bad.stderr).toContain('SHOULDER_LIFT_CALIBRATION'); expect(bad.stderr).toContain('rig hip→ear');
}, 30_000);

test('CLI separate rest sample indices remain on their own source clock in report and provenance', () => {
  const f = shoulderFixture(), seq = readPoseSequence(readFileSync(f.rest, 'utf8'), 'actual rest');
  seq.frames.forEach((frame, i) => { frame.t = 100 + i * 2; }); writeFileSync(f.rest, writePoseSequence(seq));
  f.c.rest.sequence.sha256 = sha(f.rest); f.c.rest.frames = [1, 2]; writeFileSync(f.config, JSON.stringify(f.c));
  const out = join(f.dir, 'clock.json'), build = join(f.dir, 'clock-build');
  const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out, '--build', build]); expect(r.status, r.stderr).toBe(0);
  const report = load(out.replace('.json', '.report.json'));
  expect(report.shoulderLift.rest.sampleIndices).toEqual([1, 2]); expect(report.shoulderLift.rest.states).toHaveLength(2);
  expect(report.shoulderLift.rest).not.toHaveProperty('times'); expect(report.shoulderLift.rest).not.toHaveProperty('t');
  expect(report.shoulderLift.frames.map((f: {sourceTime:number}) => f.sourceTime)).toEqual([5, 5.25, 5.5, 5.75, 6]);
  expect(load(join(build, 'retarget.json')).inputs.shoulderLift.rest.sha256).toBe(sha(f.rest));
}, 30_000);

test('B3 shoulder IO collects independent snapshot, hash and person refusals before work', () => {
  const f = shoulderFixture(); f.c.person = 'wrong-person'; f.c.sequenceSHA256 = '0'.repeat(64); f.c.rigSHA256 = '1'.repeat(64);
  f.c.rest.sequence.path = 'missing-rest.json'; f.c.painting.path = 'missing-painting.png'; writeFileSync(f.config, JSON.stringify(f.c));
  const out = join(f.dir, 'multi-invalid.json'), build = join(f.dir, 'multi-invalid-build');
  const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out, '--build', build]);
  expect(r.status).toBe(1);
  for (const name of ['rest.sequence.path', 'missing-rest.json', 'painting.path', 'missing-painting.png', 'sequenceSHA256', 'rigSHA256', 'person', 'wrong-person']) expect(r.stderr).toContain(name);
  expect(existsSync(out)).toBe(false); expect(existsSync(build)).toBe(false);
  f.c.rest.sequence.path = 'rest.json'; f.c.painting.path = 'painting.png'; f.c.rest.sequence.sha256 = '2'.repeat(64); f.c.painting.sha256 = '3'.repeat(64); writeFileSync(f.config, JSON.stringify(f.c));
  const hashes = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out]); expect(hashes.status).toBe(1);
  for (const name of ['sequenceSHA256', 'rigSHA256', 'rest.sequence.sha256', 'painting.sha256', 'wrong-person']) expect(hashes.stderr).toContain(name);
  // An invalid configuration cannot safely supply downstream paths.
  writeFileSync(f.config, '{'); const malformed = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out]);
  expect(malformed.status).toBe(1); expect(malformed.stderr).toContain('SHOULDER_LIFT_CONFIG'); expect(existsSync(out)).toBe(false);
}, 30_000);

test('B3 compiled inherit timeline allows a disjoint hair branch and refuses protected paths', () => {
  for (const bone of ['hair', 'parent', 'shoulder_r']) {
    const f = shoulderFixture(), rig = load(f.rig), idle = load(f.motion);
    rig.bones.push({ name: 'hair', parent: 'shoulder_ctl', length: 5 }); writeFileSync(f.rig, JSON.stringify(rig));
    idle.animations.idle.tracks.push({ bone, property: 'inherit', keys: [{ t: 0, v: 'normal' }, { t: .5, v: 'onlyTranslation' }, { t: 1.25, v: 'normal' }] });
    writeFileSync(f.motion, JSON.stringify(idle)); f.c.rigSHA256 = sha(f.rig); writeFileSync(f.config, JSON.stringify(f.c));
    const out = join(f.dir, 'inherit.json'), build = join(f.dir, 'inherit-build');
    const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out, '--build', build]);
    if (bone === 'hair') {
      expect(r.status, r.stderr).toBe(0);
      const doc = readModel(readFileSync(join(build, 'skeleton.model.json'), 'utf8'), 'actual compiled inherit timeline');
      expect(doc.animations.find(a => a.name === 'calibrated')!.timelines.bones.find(b => b.name === bone)!.timelines.some(t => t.kind === 'inherit')).toBe(true);
    } else { expect(r.status, r.stderr).toBe(1); expect(r.stderr).toContain('SHOULDER_LIFT_COMPOSITION'); expect(r.stderr).toContain(`bone "${bone}"`); expect(existsSync(out)).toBe(false); }
  }
}, 30_000);

test('B3 loop checks the emitted duration endpoint through independent poser with moving parent and idle', () => {
  const f = shoulderFixture(true), raw = join(f.dir, 'loop-raw.json');
  const source = load(f.pose); delete source.cleaned;
  const shifts = [8, 16, 24, 16, 8];
  source.frames.forEach((frame: {people: {joints: Record<string, {at: number[]}>}[]}, i: number) => { for (const n of ['r_shoulder', 'l_shoulder']) frame.people[0]!.joints[n]!.at[1] = 80 - shifts[i]!; });
  writeFileSync(raw, JSON.stringify(source));
  const cleaned = run(CLI, ['clean', '--pose', raw, '--out', f.pose, '--legs', '1', '--rest', '1', '--loop']); expect(cleaned.status, cleaned.stderr).toBe(0);
  f.c.sequenceSHA256 = sha(f.pose); writeFileSync(f.config, JSON.stringify(f.c));
  const baseline = join(f.dir, 'loop-baseline.json'), baseBuild = join(f.dir, 'loop-base-build');
  const b = run(CLI, [...f.args, '--out', baseline, '--build', baseBuild]); expect(b.status, b.stderr).toBe(0);
  const out = join(f.dir, 'loop-lift.json'), build = join(f.dir, 'loop-build');
  const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out, '--build', build]); expect(r.status, r.stderr).toBe(0);
  const animation = load(out).animations.calibrated, duration = animation.duration;
  expect(duration).toBe(1.25);
  const track = animation.tracks.find((tr: {bone:string;property:string}) => tr.bone === 'shoulder_ctl' && tr.property === 'translate');
  expect(track.keys.at(-1).t).toBe(duration);
  const times = [0, .25, .5, .75, 1, duration], expected = [4, 8, 12, 8, 4, 4];
  const old = poseFrames(readModel(readFileSync(join(baseBuild, 'skeleton.model.json'), 'utf8'), 'actual loop baseline'), 'calibrated', times);
  const actual = poseFrames(readModel(readFileSync(join(build, 'skeleton.model.json'), 'utf8'), 'actual loop emitted'), 'calibrated', times);
  for (const name of ['shoulder_ctl', 'shoulder_r', 'shoulder_l']) {
    for (let i = 0; i < times.length; i++) {
      const before = old[i]!.get(name)!, after = actual[i]!.get(name)!;
      expect(Math.hypot(after.worldX - before.worldX, after.worldY - before.worldY - expected[i]!)).toBeLessThanOrEqual(.01);
    }
    const first = actual[0]!.get(name)!, last = actual.at(-1)!.get(name)!;
    expect(Math.hypot(last.worldX - first.worldX, last.worldY - first.worldY)).toBeLessThanOrEqual(.01);
  }
  expect(load(out.replace('.json', '.report.json')).shoulderLift.landing.tolerance).toBe(.01);
}, 30_000);

test('B3 final world origins obey 8192 under a scale-15.5 parent without rejecting disjoint hair', () => {
  for (const lift of [7000, 96875]) {
    const f = shoulderFixture(true), idle = load(f.motion), rig = load(f.rig);
    idle.animations.idle.tracks.find((tr: {bone:string;property:string}) => tr.bone === 'parent' && tr.property === 'scale').keys.forEach((key: {v:number[]}) => { key.v = [15.5, 15.5]; });
    rig.bones.push({ name: 'unprotectedHair', parent: 'shoulder_ctl', x: 600, length: 5 });
    writeFileSync(f.motion, JSON.stringify(idle)); writeFileSync(f.rig, JSON.stringify(rig));
    writeFileSync(f.pose, writePoseSequence(shoulderSequence(Array(5).fill(lift * 2))));
    f.c.rigSHA256 = sha(f.rig); f.c.sequenceSHA256 = sha(f.pose); writeFileSync(f.config, JSON.stringify(f.c));
    const baseline = join(f.dir, 'bound-base.json'), baseBuild = join(f.dir, 'bound-base-build');
    const b = run(CLI, [...f.args, '--out', baseline, '--build', baseBuild]); expect(b.status, b.stderr).toBe(0);
    const posed = poseFrames(readModel(readFileSync(join(baseBuild, 'skeleton.model.json'), 'utf8'), 'actual scale15.5 baseline'), 'calibrated', [0])[0]!;
    expect(Math.hypot(posed.get('parent')!.a, posed.get('parent')!.c)).toBe(15.5);
    expect(Math.abs(posed.get('unprotectedHair')!.worldX)).toBeGreaterThan(8192);
    const out = join(f.dir, 'bound-output.json'), build = join(f.dir, 'bound-build');
    const r = run(CLI, [...f.args, '--shoulder-lift', f.config, '--out', out, '--build', build]);
    if (lift === 7000) {
      expect(r.status, r.stderr).toBe(0);
      const final = poseFrames(readModel(readFileSync(join(build, 'skeleton.model.json'), 'utf8'), 'actual allowed final world origin'), 'calibrated', [0])[0]!;
      expect(Math.abs(final.get('shoulder_ctl')!.worldY - posed.get('shoulder_ctl')!.worldY - lift)).toBeLessThanOrEqual(.01);
      expect(Math.abs(final.get('shoulder_ctl')!.worldY)).toBeLessThanOrEqual(8192);
    } else {
      // World displacement 96875 fits a 6250 local delta under this actual parent.
      expect(lift / 15.5).toBeLessThan(8192); expect(posed.get('shoulder_ctl')!.worldY + lift).toBeGreaterThan(8192);
      expect(r.status, r.stderr).toBe(1); expect(r.stderr).toContain('SHOULDER_LIFT_RIG'); expect(r.stderr).toContain('8192'); expect(r.stderr).toContain('shoulder_ctl');
      expect(existsSync(out)).toBe(false); expect(existsSync(build)).toBe(false);
    }
  }
}, 30_000);
