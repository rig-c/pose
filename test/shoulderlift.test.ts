/** #408: analytical constants declared on the issue before these controls ran. */
import { expect, test } from 'bun:test';
import { clean } from '../src/clean.ts';
import { readPoseSequence, writePoseSequence, type PoseSequence } from '../src/pose.ts';
import { readShoulderConfig, readShoulderSignal, shoulderLocal, shoulderMatrix, SHOULDER_JOINTS, type ShoulderConfig } from '../src/shoulderlift.ts';

export function shoulderSequence(shifts = [0, 8, 16, -8, 0], inferred = false): PoseSequence {
  const d = { spec: 'rig-pose-sequence/1', space: { units: 'picture-px', origin: 'top-left', y: 'down' }, width: 320, height: 240, source: 'analytical bilateral shoulder control, declared before evaluation', frames: shifts.map((s, i) => ({ t: 5 + i / 4, people: [{ id: 'p', joints: {
    neck: { state: 'observed', at: [160, 100] }, nose: { state: 'observed', at: [180, 100] },
    r_shoulder: { state: 'observed', at: [140, 80 - s] }, l_shoulder: { state: 'observed', at: [180, 80 - s] },
    r_hip: { state: inferred ? 'inferred' : 'observed', at: [150, 200] }, l_hip: { state: inferred ? 'inferred' : 'observed', at: [170, 200] },
    r_ear: { state: 'observed', at: [150, 0] }, l_ear: { state: 'observed', at: [170, 0] },
  } }] })) };
  return readPoseSequence(writePoseSequence(clean(readPoseSequence(JSON.stringify(d), 'analytical raw'), { legs: 1, rest: 1, loop: false }, 'p', 'analytical raw').seq), 'actual cleaned writer');
}
export function shoulderConfig(): ShoulderConfig {
  return readShoulderConfig(JSON.stringify({
    spec: 'rig-pose-shoulder-lift/1', sequenceSHA256: '0'.repeat(64), rigSHA256: '1'.repeat(64), person: 'p',
    camera: { mode: 'fixed', domain: 'analytical fixed camera', source: 'exact fixture coordinates', residualPx: 0 },
    sampling: { resolutionPx: .01, pointErrorPx: 0 },
    rest: { sequence: { path: 'rest.json', sha256: '2'.repeat(64) }, person: 'p', frames: [0], armsDown: true, resolutionPx: .01, pointErrorPx: 0 },
    painting: { path: 'painting.png', sha256: '3'.repeat(64), width: 640, height: 480, armsDown: true, resolutionPx: .01, pointErrorPx: 0, points: {
      r_shoulder: [280, 160], l_shoulder: [360, 160], r_hip: [300, 400], l_hip: [340, 400], r_ear: [300, 0], l_ear: [340, 0],
    } },
    calibration: { cameraToPainting: { value: 2, absoluteError: 0, source: 'analytical 2 painting px per sequence px' }, paintingToRig: { value: .25, absoluteError: 0, source: 'analytical quarter world unit per painting px' } },
    target: { bone: 'shoulder_ctl', shoulders: { r: 'shoulder_r', l: 'shoulder_l' }, hips: { r: 'hip_r', l: 'hip_l' }, ears: { r: 'ear_r', l: 'ear_l' }, idle: 'add' },
  }), 'analytical configuration through actual reader');
}
const read = (c = shoulderConfig(), s = shoulderSequence(), r = shoulderSequence([0, 0, 0])) => readShoulderSignal(readShoulderConfig(JSON.stringify(c), 'control configuration'), readPoseSequence(JSON.stringify(s), 'control active through actual reader'), readPoseSequence(JSON.stringify(r), 'control rest through actual reader'), .3);
test('analytical normal: 0/8/16/-8/0 pixels recover 0/4/8/-4/0 within predeclared .02 units', () => {
  const r = read(); expect(r.status).toBe('read'); if (r.status !== 'read') return;
  expect(r.frames.map(f => f.worldUnits)).toEqual([0, 4, 8, -4, 0]);
  for (const f of r.frames) expect(f.toleranceUnits).toBe(.02);
  expect(r.frames.map(f => f.t)).toEqual([0, .25, .5, .75, 1]);
  expect(r.evidence).toBe('SUPPLIED');
});
test('rest control adds no lift, unscored and inferred coordinates remain supplied', () => {
  const r = read(shoulderConfig(), shoulderSequence([0, 0, 0], true)); expect(r.status).toBe('read'); if (r.status !== 'read') return;
  expect(r.frames.every(f => f.worldUnits === 0)).toBe(true); expect(r.frames[0]!.states.r_hip).toBe('inferred');
});
test('valid declared clean transformations are read with the supplied cleaning-inclusive bound', () => {
  const s = shoulderSequence(); s.cleaned!.spikes.found.push({ frame: 1, joint: 'r_shoulder' });
  const c = shoulderConfig(); c.sampling.pointErrorPx = 2;
  const r = read(c, s); expect(r.status).toBe('read'); if (r.status !== 'read') return;
  expect(r.frames[1]!.worldUnits).toBe(4); expect(r.frames[1]!.sourceBoundUnits).toBeGreaterThan(2);
});
test('each actually missing joint stays unknown before any retarget hold substitution', () => {
  for (const n of SHOULDER_JOINTS) for (const state of ['missing', 'occluded'] as const) {
    const s = shoulderSequence(); s.frames[2]!.people[0]!.joints[n] = { state };
    const r = read(shoulderConfig(), readPoseSequence(writePoseSequence(s), 'missing source'));
    expect(r.status).toBe('unknown'); if (r.status === 'unknown') expect(r.problems.some(p => p.code === 'SHOULDER_LIFT_JOINT' && p.text.includes(n) && p.text.includes('frame 2'))).toBe(true);
  }
});
test('provided low score and absent position are unknown, not interpolated', () => {
  const s = shoulderSequence(); s.frames[1]!.people[0]!.joints.r_ear = { state: 'observed', at: [150, 0], score: .1 };
  expect(read(shoulderConfig(), s).status).toBe('unknown');
  s.frames[1]!.people[0]!.joints.r_ear = { state: 'occluded' }; expect(read(shoulderConfig(), s).status).toBe('unknown');
});
test('missing calibration and point error bound are named, closed input refuses invented fields', () => {
  for (const field of ['calibration', 'sampling']) { const c = structuredClone(shoulderConfig()) as unknown as Record<string, unknown>; delete c[field]; expect(() => readShoulderConfig(JSON.stringify(c), 'absent ' + field)).toThrow('SHOULDER_LIFT_CONFIG'); }
  const c = shoulderConfig(); const sample = c.sampling as unknown as Record<string, unknown>; delete sample.pointErrorPx;
  expect(() => readShoulderConfig(JSON.stringify(c), 'unbounded point')).toThrow('pointErrorPx');
  expect(() => readShoulderConfig(JSON.stringify({ ...shoulderConfig(), defaultLift: 17 }), 'unknown field')).toThrow('defaultLift');
});
test('rest indices, odd/even median, calibration and source clocks have explicit edge behavior', () => {
  const c = shoulderConfig(); c.rest.frames = [0, 1]; const rest = shoulderSequence([0, 4, 4]);
  const r = read(c, shoulderSequence([0, 0, 0]), rest); expect(r.status).toBe('read'); if (r.status === 'read') expect(r.frames[0]!.worldUnits).toBe(-1);
  c.rest.frames = [50]; expect(read(c).status).toBe('unknown');
  const wrong = shoulderConfig(); wrong.calibration.cameraToPainting.value = 1; expect(read(wrong).status).toBe('unknown');
  const camera = shoulderConfig(); camera.camera.mode = 'normalised'; expect(read(camera).status).toBe('unknown');
});
test('common motion cancels and a unilateral lift is the explicit bilateral mean', () => {
  const s = shoulderSequence([0, 0, 0]);
  for (const n of SHOULDER_JOINTS) s.frames[1]!.people[0]!.joints[n]!.at![1] += 10;
  const r = read(shoulderConfig(), s); expect(r.status).toBe('read'); if (r.status === 'read') expect(r.frames[1]!.worldUnits).toBe(0);
  s.frames[2]!.people[0]!.joints.r_shoulder!.at![1] -= 8;
  const u = read(shoulderConfig(), s); if (u.status === 'read') expect(u.frames[2]!.worldUnits).toBe(2); else throw Error('unilateral refused');
});
test('posed inverse supports translated/rotated/uniform-scaled parent; invalid matrices refuse by name', () => {
  const parent = { name: 'parent', parent: null, active: true, a: 0, b: -2, c: 2, d: 0, worldX: 10, worldY: -20, rotationX: 90, rotationY: 180, scaleX: 2, scaleY: 2 };
  expect(shoulderLocal(parent, [4, 6], [4, 4], 8, 1)).toEqual([5, 0]);
  for (const change of [{ d: 1 }, { b: 2 }, { a: 0, b: 0, c: 0, d: 0 }]) expect(() => shoulderMatrix({ ...parent, ...change }, 1)).toThrow('SHOULDER_LIFT_RIG');
});

test('irregular times and microsecond collisions, one frame and loop seam have named behavior', () => {
  const s = shoulderSequence([0, 0, 0]); s.frames[1]!.t = 5.125; s.frames[2]!.t = 5.9;
  const r = read(shoulderConfig(), s); expect(r.status).toBe('read'); if (r.status === 'read') expect(r.frames.map(f => f.t)).toEqual([0,.125,.9]);
  s.frames[1]!.t = 5.0000004; const collision = read(shoulderConfig(), s); expect(collision.status).toBe('unknown'); if (collision.status === 'unknown') expect(collision.problems[0]!.code).toBe('POSE_TIME');
  expect(read(shoulderConfig(), shoulderSequence([0])).status).toBe('read');
  const loop = shoulderSequence([0,8,8]); loop.cleaned!.params.loop = true;
  const bad = read(shoulderConfig(), loop); expect(bad.status).toBe('unknown'); if (bad.status === 'unknown') expect(bad.problems.some(p => p.code === 'SHOULDER_LIFT_LOOP')).toBe(true);
});

test('actual clean stillness-hold output is eligible with its supplied cleaning bound', () => {
  const seq = shoulderSequence(Array(12).fill(0)); delete seq.cleaned;
  const held = clean(seq, { loop: false, legs: 1, rest: 1, hold: { speed: .01, reach: .01 } }, 'p', 'actual stillness control').seq;
  expect(held.cleaned!.holds!.some(h => h.joint === 'r_shoulder')).toBe(true);
  const c = shoulderConfig(); c.sampling.pointErrorPx = 2;
  const r = read(c, held); expect(r.status).toBe('read'); if (r.status === 'read') expect(r.frames.every(f => f.worldUnits === 0)).toBe(true);
});

test('F1 finite inputs whose calibration intermediates overflow are named unknown', () => {
  for (const mode of ['vector', 'uncertainty', 'gain'] as const) {
    const c = shoulderConfig();
    if (mode === 'vector') {
      for (const n of ['r_hip', 'l_hip'] as const) c.painting.points[n][0] = Number.MAX_VALUE;
      for (const n of ['r_ear', 'l_ear'] as const) c.painting.points[n][0] = -Number.MAX_VALUE;
      c.painting.pointErrorPx = Number.MAX_VALUE;
    } else if (mode === 'uncertainty') c.painting.pointErrorPx = Number.MAX_VALUE;
    else c.calibration.cameraToPainting.value = Number.MAX_VALUE;
    const r = read(c); expect(r.status).toBe('unknown');
    if (r.status === 'unknown') expect(r.problems.some(p => p.code === 'SHOULDER_LIFT_CALIBRATION' && /nonfinite|nonrepresentable/.test(p.text))).toBe(true);
  }
});

test('span-normalised: pure hip-to-ear span changes at fixed shoulder fraction read 0 within .02u; single-anchor shifts scale by f', () => {
  const s = shoulderSequence([0, 0, 0, 0, 0]);
  const spans: [number, number, number][] = [[200, 0, 80], [250, 0, 100], [150, 0, 60], [320, 20, 140], [200, 0, 80]];
  spans.forEach(([hipY, earY, shY], i) => {
    const j = s.frames[i]!.people[0]!.joints;
    for (const n of ['r_hip', 'l_hip'] as const) j[n]!.at![1] = hipY;
    for (const n of ['r_ear', 'l_ear'] as const) j[n]!.at![1] = earY;
    for (const n of ['r_shoulder', 'l_shoulder'] as const) j[n]!.at![1] = shY;
  });
  const r = read(shoulderConfig(), s); expect(r.status).toBe('read');
  if (r.status === 'read') {
    expect(r.rest.q0).toBe(.6);
    expect(r.frames.map(f => f.sequencePx)).toEqual([0, 0, 0, 0, 0]);
    expect(r.frames.map(f => f.worldUnits)).toEqual([0, 0, 0, 0, 0]);
    for (const f of r.frames) expect(Math.abs(f.worldUnits)).toBeLessThanOrEqual(f.toleranceUnits);
  }
  for (const [pair, seqPx, world] of [[['r_hip', 'l_hip'], 80 / 21, 40 / 21], [['r_ear', 'l_ear'], 120 / 19, 60 / 19]] as const) {
    const a = shoulderSequence([0, 0, 0]);
    for (const n of pair) a.frames[1]!.people[0]!.joints[n]!.at![1] += 10;
    const u = read(shoulderConfig(), a); expect(u.status).toBe('read');
    if (u.status === 'read') { expect(u.frames[1]!.sequencePx).toBeCloseTo(seqPx, 12); expect(u.frames[1]!.worldUnits).toBeCloseTo(world, 12); }
  }
});

test('nonzero calibration uncertainties use the declared worst-case formula without fitting', () => {
  const c = shoulderConfig(); c.sampling.pointErrorPx = .1; c.rest.pointErrorPx = .2; c.camera.residualPx = .05; c.painting.pointErrorPx = .1;
  c.calibration.cameraToPainting.absoluteError = .02; c.calibration.paintingToRig.absoluteError = .003;
  const r = read(c); expect(r.status).toBe('read');
  // Independently expanded constants: dg=.25*.02 + 2*.003 + .02*.003=.01106,
  // eF=.155, eR=.255, d=16: B=.51106*.82 + 16*.01106=.5960292.
  if (r.status === 'read') { expect(r.frames[2]!.sourceBoundUnits).toBeCloseTo(.5960292, 12); expect(r.frames[2]!.toleranceUnits).toBeCloseTo(.6060292, 12); expect(r.frames[2]!.worldUnits).toBe(8); }
});

test('first, last and all-frame missing points remain named unknown', () => {
  for (const n of SHOULDER_JOINTS) for (const indices of [[0], [4], [0, 1, 2, 3, 4]]) {
    const s = shoulderSequence(); for (const i of indices) s.frames[i]!.people[0]!.joints[n] = { state: 'missing' };
    const r = read(shoulderConfig(), s); expect(r.status).toBe('unknown');
    if (r.status === 'unknown') for (const i of indices) expect(r.problems.some(p => p.code === 'SHOULDER_LIFT_JOINT' && p.text.includes(n) && p.text.includes(`frame ${i}`))).toBe(true);
  }
});

test('normalised supplied camera is valid and a conflicting fixed declaration is unknown', () => {
  const s = shoulderSequence(), r = shoulderSequence([0, 0, 0]);
  for (const seq of [s, r]) { seq.camera = seq.frames.map(() => ({ s: 1, tx: 0, ty: 0, inliers: 12 })); seq.cameraSource = 'analytical already-normalised supplied camera'; }
  const c = shoulderConfig(); c.camera.mode = 'normalised'; expect(read(c, s, r).status).toBe('read');
  c.camera.mode = 'fixed'; const bad = read(c, s, r); expect(bad.status).toBe('unknown');
  if (bad.status === 'unknown') expect(bad.problems.some(p => p.code === 'SHOULDER_LIFT_CALIBRATION' && p.text.includes('declares fixed'))).toBe(true);
});
