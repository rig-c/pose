/** #404: valid reader inputs, planted advisory warnings, and their controls. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean as cleanPose, type CleanParams } from '../src/clean.ts';
import { figureScaleLines, measureFigureScale } from '../src/figurescale.ts';
import { FIGURE_SCALE_SPEC, figureScalePath, readFigureScaleRecord, writeFigureScaleRecord } from '../src/figurescalerecord.ts';
import { personTrack, readPoseSequence, writePoseSequence, type PoseSequence } from '../src/pose.ts';

const ROOT = join(import.meta.dir, '..');
const scratch = process.env.POSE404_OUTPUT ?? join(ROOT, 'node_modules', '.cache', 'pose404');
const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** Two plateaus expose the median's actual extrema; all fixtures enter the real reader. */
function fixture(scales: number[], camera = false): PoseSequence {
  return readPoseSequence(JSON.stringify({
    spec: 'rig-pose-sequence/1', space: { units: 'picture-px', origin: 'top-left', y: 'down' },
    width: 640, height: 480, source: 'synthetic trunk span, fixture for an advisory scale reading',
    ...(camera ? { camera: scales.map(() => ({ s: 1, tx: 0, ty: 0, inliers: 0 })) } : {}),
    frames: scales.map((scale, i) => ({ t: i / 24, people: [{ id: 'a', joints: {
      neck: { state: 'observed', score: 1, at: [200, 100] },
      r_shoulder: { state: 'observed', score: 1, at: [170, 100] },
      l_shoulder: { state: 'observed', score: 1, at: [230, 100] },
      r_hip: { state: 'observed', score: 1, at: [180, 100 + 100 * scale] },
      l_hip: { state: 'observed', score: 1, at: [220, 100 + 100 * scale] },
    } }] })),
  }), 'figure-scale fixture');
}
const steps = (min: number) => [...Array<number>(8).fill(min), ...Array<number>(8).fill(1)];
const measure = (seq: PoseSequence) => measureFigureScale(personTrack(seq, undefined, 'reader-checked fixture'));
const warns = (seq: PoseSequence) => figureScaleLines(measure(seq), seq.camera !== undefined).some((l) => l.startsWith('CAMERA_UNDECLARED WARN:'));
const reread = (seq: PoseSequence) => readPoseSequence(JSON.stringify(seq), 'edited fixture through real reader');
const params = { loop: false, legs: 1, rest: 1, hold: 'off' } as const;
const clean = (seq: PoseSequence, params: CleanParams, person?: string) => cleanPose(seq, params, person, 'reader-checked fixture');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function recordOf(c: ReturnType<typeof clean>, input = ''): string {
  return writeFigureScaleRecord({ spec: FIGURE_SCALE_SPEC, inputSHA256: sha256(input), sequenceSHA256: sha256(writePoseSequence(c.seq)), person: c.person, cameraDeclared: c.seq.camera !== undefined, figureScale: c.figureScale });
}
const roundTrip = (c: ReturnType<typeof clean>) => readFigureScaleRecord(recordOf(c), 'sidecar round trip', c.seq.frames.length);


test('planted scale drift warns with measured extrema and leaves cleaning and camera alone', () => {
  const seq = fixture(steps(0.75));
  const c = clean(seq, params);
  const r = c.figureScale;
  expect(r).toEqual({ source: 'measured', method: 'trunk-median-5', minScore: .3, threshold: .1, referencePx: 100, scale: [null, null, ...Array<number>(6).fill(.75), ...Array<number>(6).fill(1), null, null], minFrame: 2, maxFrame: 8, variation: .25 });
  expect(c.seq.camera).toBeUndefined();
  const declared = clean(fixture(steps(.75), true), params);
  expect(c.seq.frames).toEqual(declared.seq.frames);
  expect(declared.figureScale).toEqual(r);
  expect(c.figureScale).toEqual(measure(seq));
  expect(figureScaleLines(measure(seq), false).join('\n')).toContain('scale 0.750000 at frame 2 (min) to 1.000000 at frame 8 (max)');
  const warning = figureScaleLines(measure(seq), false)[1]!;
  for (const text of ['CAMERA_UNDECLARED WARN', '25.0000%', '10.0%', 'declare camera', 'zoom can read as motion', 'foreshortening']) expect(warning).toContain(text);
  expect(warning).toContain('declare camera before clean (acquisition → camera declaration → clean)');
  expect(warning).not.toContain('scan →');
  expect(warns(fixture(steps(.75), true))).toBe(false);
});

test.each([.90001, .9, .89999])('strict 10%% boundary at minimum %s, before formatting', (min) => {
  const seq = fixture(steps(min));
  expect(warns(seq)).toBe(min < .9);
  expect(measure(seq).variation).toBeCloseTo(1 - min, 14);
});

test('a rigid translating and turning trunk stays steady', () => {
  const seq = fixture(Array<number>(16).fill(1));
  seq.frames.forEach((f, i) => {
    for (const j of Object.values(f.people[0]!.joints)) {
      if (j.at === undefined) continue;
      const [x, y] = j.at; const a = i * .2;
      j.at = [x * Math.cos(a) - y * Math.sin(a) + i * 10, x * Math.sin(a) + y * Math.cos(a) + i * 5];
    }
  });
  const checked = reread(seq);
  expect(measure(checked).variation!).toBeLessThan(1e-12);
  expect(warns(checked)).toBe(false);
});

test('an isolated spike does not turn into a camera warning', () => {
  const seq = fixture([1, 1, 1, 1, 5, 1, 1, 1, 1, 1, 1, 1]);
  expect(measure(seq).scale).toEqual([null, null, 1, 1, 1, 1, 1, 1, 1, 1, null, null]);
  expect(warns(seq)).toBe(false);
});

test.each(['missing', 'absent', 'unscored', 'low-score', 'occluded', 'zero'] as const)('unknown %s spans leave their full windows null', (why) => {
  const seq = fixture(Array<number>(18).fill(1));
  const joints = seq.frames[8]!.people[0]!.joints;
  if (why === 'missing') joints.r_shoulder = { state: 'missing' };
  if (why === 'absent') delete joints.r_shoulder;
  if (why === 'unscored') delete joints.r_shoulder!.score;
  if (why === 'low-score') joints.r_shoulder!.score = .29999;
  if (why === 'occluded') joints.r_shoulder!.state = 'occluded';
  if (why === 'zero') { joints.r_hip!.at = [180, 100]; joints.l_hip!.at = [220, 100]; }
  const checked = reread(seq);
  const r = measure(checked);
  expect(r.scale.slice(6, 11)).toEqual([null, null, null, null, null]);
  expect(r.scale[5]).toBe(1);
  expect(r.scale[11]).toBe(1);
  expect(warns(checked)).toBe(false);
});

test('explicit score boundary and inferred positions remain measurable', () => {
  const seq = fixture(steps(.75));
  for (const f of seq.frames) for (const j of Object.values(f.people[0]!.joints)) { j.score = .3; j.state = 'inferred'; }
  expect(warns(reread(seq))).toBe(true);
});

test('fewer than two full windows is explicit unknown, even under loop', () => {
  const seq = fixture([.75, 1, 1, 1, 1]);
  const r = measure(seq);
  expect(r.referencePx).toBeNull(); expect(r.scale).toEqual([null, null, null, null, null]);
  expect(r.minFrame).toBeNull(); expect(r.maxFrame).toBeNull(); expect(r.variation).toBeNull();
  const c = clean(seq, { ...params, loop: true });
  expect(c.figureScale).toEqual(r);
  expect(figureScaleLines(r, false)).toHaveLength(1);
  expect(figureScaleLines(r, false)[0]).toContain('unavailable');
  expect(roundTrip(c).figureScale).toEqual(r);
  expect(readPoseSequence(writePoseSequence(c.seq), 'unknown sequence round trip').cleaned).not.toHaveProperty('figureScale');
});

test('no shoulder measurements do not add a refusal to clean', () => {
  const seq = fixture(steps(.75));
  for (const f of seq.frames) delete f.people[0]!.joints.r_shoulder;
  const c = clean(reread(seq), params);
  expect(c.figureScale?.variation).toBeNull();
  expect(figureScaleLines(c.figureScale!, false)[0]).toContain('unavailable');
});

test('selecting one person does not measure another person or fill absence', () => {
  const seq = fixture(steps(.75));
  const stable = fixture(Array<number>(16).fill(1));
  seq.frames.forEach((f, i) => f.people.push({ ...stable.frames[i]!.people[0]!, id: 'b' }));
  seq.frames[6]!.people = seq.frames[6]!.people.filter((p) => p.id !== 'a');
  const checked = reread(seq);
  expect(clean(checked, params, 'b').figureScale?.variation).toBe(0);
  expect(clean(checked, params, 'a').figureScale?.scale.slice(4, 9)).toEqual([null, null, null, null, null]);
});

test('public wave is the pinned, reader-valid negative control', () => {
  const text = readFileSync(join(ROOT, 'examples/wave/pose.json'), 'utf8');
  expect(createHash('sha256').update(text).digest('hex')).toBe('5185ccc4abbc2434f0218b8b038b9026a78026e6290a49775256334bb962b0bf');
  const seq = readPoseSequence(text, 'public wave');
  expect(warns(seq)).toBe(false);
  expect(measure(seq).variation).toBeCloseTo(.00004947991130563501, 12);
});

test('pose schema stays unchanged; external measured records round trip deterministically', () => {
  const c = clean(fixture(steps(.75)), params);
  const text = writePoseSequence(c.seq);
  const loaded = readPoseSequence(text, 'unchanged pose format');
  expect(loaded.cleaned).not.toHaveProperty('figureScale');
  expect(writePoseSequence(loaded)).toBe(text);
  const record = roundTrip(c);
  expect(record.figureScale).toEqual(c.figureScale);
  expect(writeFigureScaleRecord(record)).toBe(recordOf(c));
});

test.each(['source', 'method', 'threshold', 'minScore', 'referencePx', 'scale', 'minFrame', 'maxFrame', 'variation', 'unknown-key', 'missing-key', 'unknown-mixed'] as const)('sidecar reader refuses malformed measurement by name: %s', (key) => {
  const doc = JSON.parse(recordOf(clean(fixture(steps(.75)), params)));
  const r = doc.figureScale;
  if (key === 'unknown-key') r.extra = 1;
  else if (key === 'missing-key') delete r.scale;
  else if (key === 'unknown-mixed') r.referencePx = null;
  else r[key] = key === 'scale' ? [2] : 'bad';
  expect(() => readFigureScaleRecord(JSON.stringify(doc), 'planted measured-record failure', 16)).toThrow('FIGURE_SCALE_RECORD');
  expect(() => readFigureScaleRecord(JSON.stringify(doc), 'planted measured-record failure', 16)).toThrow('figureScale');
});

test.each(['spec', 'inputSHA256', 'sequenceSHA256', 'person', 'cameraDeclared', 'missing-key', 'unknown-key'] as const)('sidecar binding is checked by name: %s', (key) => {
  const doc = JSON.parse(recordOf(clean(fixture(steps(.75)), params)));
  if (key === 'missing-key') delete doc.figureScale;
  else if (key === 'unknown-key') doc.extra = true;
  else doc[key] = key === 'person' ? '' : 12;
  expect(() => readFigureScaleRecord(JSON.stringify(doc), 'bad sidecar binding')).toThrow('FIGURE_SCALE_RECORD');
});

test('strict pose input readers still refuse figureScale at root and inside cleaned, including newer minors', () => {
  for (const spec of ['rig-pose-sequence/1', 'rig-pose-sequence/1.99']) {
    const c = clean(fixture(steps(.75)), params);
    const doc = JSON.parse(writePoseSequence(c.seq)); doc.spec = spec;
    doc.figureScale = c.figureScale;
    expect(() => readPoseSequence(JSON.stringify(doc), 'strict root')).toThrow('POSE_KEYS');
    delete doc.figureScale; doc.cleaned.figureScale = c.figureScale;
    expect(() => readPoseSequence(JSON.stringify(doc), 'strict cleaned')).toThrow('POSE_CLEANED');
  }
});

/** Preserve the actual double-valued pixel spans through the real input reader. */
function spanFixture(spans: number[]): PoseSequence {
  const seq = fixture(spans.map(() => 1));
  seq.frames.forEach((f, i) => {
    const j = f.people[0]!.joints;
    j.neck!.at = [0, 0];
    j.r_shoulder!.at = [-10, 0]; j.l_shoulder!.at = [10, 0];
    j.r_hip!.at = [-5, spans[i]!]; j.l_hip!.at = [5, spans[i]!];
  });
  return reread(seq);
}
const plateauSpans = (...spans: number[]) => spans.flatMap((v) => Array<number>(8).fill(v));
const tiedMinimum = () => spanFixture(plateauSpans(65.40000000000013, 65.40000000000012, 260.6699999999979));
const tiedMaximum = () => spanFixture(plateauSpans(260.66999999999786, 260.6699999999979, 260.6699999999979));

test('distinct raw minimum plateaus that serialize to one ratio round trip at the first normalized tie', () => {
  const c = clean(tiedMinimum(), params);
  const text = writePoseSequence(c.seq);
  const loaded = readPoseSequence(text, 'own double-valued minimum-tie output');
  const r = roundTrip(c).figureScale;
  expect(r.scale[2]).toBe(0.2508919323282336);
  expect(r.scale[8]).toBe(0.2508919323282336);
  expect(r.minFrame).toBe(2);
  expect(r.maxFrame).toBe(16);
  expect(r.referencePx).toBe(260.6699999999979);
  expect(r.variation).toBe(c.figureScale!.variation);
  expect(writePoseSequence(loaded)).toBe(text);
});

test('a nearby ratio below 1 does not displace the first of two maximum plateaus', () => {
  const c = clean(tiedMaximum(), params);
  const text = writePoseSequence(c.seq);
  const loaded = readPoseSequence(text, 'own maximum-tie output');
  const r = roundTrip(c).figureScale;
  expect(r.scale[2]!).toBeLessThan(1);
  expect(r.scale[8]).toBe(1); expect(r.scale[16]).toBe(1);
  expect(r.minFrame).toBe(2); expect(r.maxFrame).toBe(8);
  expect(r.referencePx).toBe(260.6699999999979);
  expect(writePoseSequence(loaded)).toBe(text);
});

test.each([['minimum', tiedMinimum, 2, 16], ['maximum', tiedMaximum, 2, 8]] as const)('real CLI output with a normalized %s tie re-enters the reader with deterministic bytes', (_name, make, minFrame, maxFrame) => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'ratio-cli-')); made.push(dir);
  const input = join(dir, 'input.json'), output = join(dir, 'clean.json');
  // Input serialization uses the detector's full double precision, not the pose writer's px rounding.
  writeFileSync(input, JSON.stringify(make()));
  const run = () => spawnSync(process.execPath, [join(ROOT, 'cli.ts'), 'clean', '--pose', input, '--out', output, '--legs', '1', '--rest', '1', '--hold', 'off'], { cwd: ROOT, encoding: 'utf8' });
  const first = run(); expect(first.status).toBe(0); expect(first.stderr).toBe('');
  const bytes = readFileSync(output, 'utf8');
  const loaded = readPoseSequence(bytes, 'CLI double-valued tie output');
  const recordBytes = readFileSync(figureScalePath(output), 'utf8');
  const record = readFigureScaleRecord(recordBytes, 'CLI tie sidecar', loaded.frames.length);
  expect(record.figureScale.minFrame).toBe(minFrame);
  expect(record.figureScale.maxFrame).toBe(maxFrame);
  expect(writePoseSequence(loaded)).toBe(bytes);
  const second = run(); expect(second.status).toBe(0);
  expect(second.stdout).toBe(first.stdout); expect(readFileSync(output, 'utf8')).toBe(bytes);
  expect(readFileSync(figureScalePath(output), 'utf8')).toBe(recordBytes);
});

test('real CLI warns, exits 0, writes the measured record, and repeats identical bytes and lines', () => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'cli-')); made.push(dir);
  const input = join(dir, 'input.json'), out = join(dir, 'clean.json');
  writeFileSync(input, writePoseSequence(fixture(steps(.75))));
  const run = () => spawnSync(process.execPath, [join(ROOT, 'cli.ts'), 'clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1', '--hold', 'off'], { cwd: ROOT, encoding: 'utf8' });
  const first = run();
  expect(first.status).toBe(0); expect(first.stderr).toBe('');
  expect(first.stdout).toContain('CAMERA_UNDECLARED WARN:');
  const bytes = readFileSync(out, 'utf8');
  const loaded = readPoseSequence(bytes, 'CLI output');
  expect(loaded.cleaned).not.toHaveProperty('figureScale');
  const recordBytes = readFileSync(figureScalePath(out), 'utf8');
  const record = readFigureScaleRecord(recordBytes, 'CLI sidecar', loaded.frames.length);
  expect(record.figureScale.source).toBe('measured');
  expect(record.inputSHA256).toBe(sha256(readFileSync(input, 'utf8')));
  expect(record.sequenceSHA256).toBe(sha256(bytes));
  expect(record.person).toBe('a'); expect(record.cameraDeclared).toBe(false);
  const second = run();
  expect(second.status).toBe(0); expect(second.stdout).toBe(first.stdout); expect(readFileSync(out, 'utf8')).toBe(bytes);
  expect(readFileSync(figureScalePath(out), 'utf8')).toBe(recordBytes);
  writeFileSync(input, writePoseSequence(fixture(steps(.75), true)));
  const declared = run();
  expect(declared.status).toBe(0); expect(declared.stdout).not.toContain('CAMERA_UNDECLARED');
  expect(declared.stdout).toContain('FIGURE-SCALE');
  const declaredRecord = readFigureScaleRecord(readFileSync(figureScalePath(out), 'utf8'), 'declared sidecar', 16);
  expect(declaredRecord.cameraDeclared).toBe(true);
  expect(declaredRecord.figureScale).toEqual(record.figureScale);
});


test.each(['primary', 'sidecar'] as const)('blocked %s output is ARG_PATH before either output is written', (blocked) => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'blocked-')); made.push(dir);
  const input = join(dir, 'input.json'), out = join(dir, 'clean.json');
  writeFileSync(input, JSON.stringify(fixture(steps(.75))));
  const target = blocked === 'primary' ? out : figureScalePath(out);
  mkdirSync(target);
  const r = spawnSync(process.execPath, [join(ROOT, 'cli.ts'), 'clean', '--pose', input, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  expect(r.status).toBe(1); expect(r.stdout).toBe('');
  expect(r.stderr).toContain('FAIL  ARG_PATH:'); expect(r.stderr).toContain(target);
  expect(existsSync(blocked === 'primary' ? figureScalePath(out) : out)).toBe(false);
});

test('an unmeasurable CLI input still writes the explicit all-null sidecar', () => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'unknown-cli-')); made.push(dir);
  const input = join(dir, 'input.json'), out = join(dir, 'clean.json');
  writeFileSync(input, JSON.stringify(fixture([1, 1, 1, 1, 1])));
  const r = spawnSync(process.execPath, [join(ROOT, 'cli.ts'), 'clean', '--pose', input, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  expect(r.status).toBe(0); expect(r.stdout).toContain('FIGURE-SCALE unavailable');
  const record = readFigureScaleRecord(readFileSync(figureScalePath(out), 'utf8'), 'unknown CLI sidecar', 5);
  expect(record.figureScale.scale).toEqual([null, null, null, null, null]);
  expect(record.figureScale.variation).toBeNull(); expect(record.sequenceSHA256).toBe(sha256(readFileSync(out, 'utf8')));
});


test('a drifting wave-derived pose passes the real reader, warns and keeps a strict sequence', () => {
  const doc = JSON.parse(readFileSync(join(ROOT, 'examples/wave/pose.json'), 'utf8'));
  delete doc.cleaned;
  for (let i = 0; i < doc.frames.length; i++) {
    const factor = i < Math.floor(doc.frames.length / 2) ? .75 : 1;
    for (const person of doc.frames[i].people) {
      for (const joint of Object.values(person.joints) as Array<{ at?: [number, number] }>) {
        if (joint.at !== undefined) joint.at = [factor * joint.at[0], factor * joint.at[1]];
      }
    }
  }
  const raw = readPoseSequence(JSON.stringify(doc), 'drifting wave, real reader before metric');
  expect(warns(raw)).toBe(true);
  const c = clean(raw, params);
  expect(c.figureScale.variation!).toBeGreaterThan(.24);
  expect(c.figureScale.variation!).toBeLessThan(.26);
  const output = readPoseSequence(writePoseSequence(c.seq), 'drifting wave clean output');
  expect(output.cleaned).not.toHaveProperty('figureScale');
  expect(roundTrip(c).figureScale).toEqual(c.figureScale);
});

test('a blocked sidecar leaves an existing primary output byte-identical', () => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'preserved-')); made.push(dir);
  const input = join(dir, 'input.json'), out = join(dir, 'clean.json');
  writeFileSync(input, JSON.stringify(fixture(steps(.75))));
  const before = 'previous primary output\n'; writeFileSync(out, before);
  mkdirSync(figureScalePath(out));
  const r = spawnSync(process.execPath, [join(ROOT, 'cli.ts'), 'clean', '--pose', input, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  expect(r.status).toBe(1); expect(r.stderr).toContain('ARG_PATH:');
  expect(readFileSync(out, 'utf8')).toBe(before);
});


/** Numeric stress fixtures still enter the actual pose reader before measurement. */
function vectorFixture(dx: number, dy: number, shoulder: [number, number] = [0, 0]): PoseSequence {
  const seq = fixture(Array<number>(8).fill(1));
  for (const f of seq.frames) {
    const j = f.people[0]!.joints;
    j.r_shoulder!.at = [...shoulder]; j.l_shoulder!.at = [...shoulder];
    j.r_hip!.at = [dx, dy]; j.l_hip!.at = [dx, dy];
  }
  return reread(seq);
}

test.each([[3e200, 4e200, 5e200], [3e307, 4e307, 5e307], [3e-200, 4e-200, 5e-200], [3e-300, 4e-300, 5e-300]])('robust Euclidean norm preserves finite 3:4:5 lengths at %s, %s', (dx, dy, expected) => {
  const r = measure(vectorFixture(dx, dy));
  expect(r.referencePx).not.toBeNull();
  expect(Math.abs(r.referencePx! / expected - 1)).toBeLessThan(3e-16);
  expect(r.scale.slice(2, 6)).toEqual([1, 1, 1, 1]);
  expect(r.variation).toBe(0);
});

test.each([[0, 0, 0], [1.7e308, 1.7e308, 0], [1e308, 0, -1e308]])('zero or unrepresentable Euclidean span stays explicitly unknown: %s, %s', (dx, dy, sx) => {
  const r = measure(vectorFixture(dx, dy, [sx, 0]));
  expect(r.referencePx).toBeNull(); expect(r.variation).toBeNull();
  expect(r.minFrame).toBeNull(); expect(r.maxFrame).toBeNull();
  expect(r.scale).toEqual(Array<null>(8).fill(null));
});

test('a paired-platform regression vector has one exact measured span, without output quantization', () => {
  // Same reader-valid vector: Math.hypot returned 343.88138943536916 on arm64
  // and 343.8813894353691 on x64 (Bun 1.4.2); fixed arithmetic agrees on both.
  const r = measure(vectorFixture(-40.39999999999998, 341.5));
  expect(r.referencePx).toBe(343.88138943536916);
  expect(r.scale.slice(2, 6)).toEqual([1, 1, 1, 1]);
});
