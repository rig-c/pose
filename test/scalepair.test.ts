/** #384/#387: scale-pair advice must not change the retarget's outputs. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Body18 } from '../src/joints.ts';
import { readMap, type JointMap, type Rest, type RestBone } from '../src/map.ts';
import { clean } from '../src/clean.ts';
import { personTrack, readPoseSequence, writePoseSequence, type Joint } from '../src/pose.ts';
import { pointOn } from '../src/retarget.ts';
import { SCALE_PAIR_GAIN, SCALE_PAIR_VARIATION, scalePairWarning } from '../src/scalepair.ts';
import { sequence } from './flight-fixture.ts';

const ROOT = join(import.meta.dir, '..');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Frame = Partial<Record<Body18, Joint>>;
const observed = (x: number, y: number): Joint => ({ state: 'observed', at: [x, y], score: 1 });
function noRecommendation(line: string | null): void {
  expect(line).not.toBeNull();
  expect(line).toContain('see docs/REFERENCE.md "The map: rig-pose-map/1", translate.scale rule');
  expect(line).not.toContain('steadier mapped pair:');
  expect(line).not.toContain('no steadier viable pair');
}

const framesOf = (lengths: number[]): Frame[] => lengths.map((l) => ({
  r_hip: observed(-10, 0), l_hip: observed(10, 0), neck: observed(0, -l),
  r_shoulder: observed(-30, -l), l_shoulder: observed(30, -l),
}));
function bone(name: string, worldX: number, worldY: number, length = 50): RestBone {
  return { name, parent: null, active: true, a: 1, b: 0, c: 0, d: 1, worldX, worldY,
    rotationX: 0, rotationY: 90, scaleX: 1, scaleY: 1, length };
}
const REST: Rest = new Map([
  ['hip', bone('hip', 0, 0)], ['chest', bone('chest', 0, 0)], ['neck', bone('neck', 0, 150)],
  ['sleeve_r0', bone('sleeve_r0', -30, 140)], ['sleeve_l0', bone('sleeve_l0', 30, 140)],
]);
function mapOf(): JointMap {
  return readMap(JSON.stringify({ spec: 'rig-pose-map/1', chains: [
    { name: 'trunk', bones: ['chest'], joints: ['mid_hip', 'neck'], aim: ['neck'] },
    { name: 'right', bones: ['sleeve_r0'], joints: ['r_shoulder', 'r_elbow'] },
    { name: 'left', bones: ['sleeve_l0'], joints: ['l_shoulder', 'l_elbow'] },
  ], translate: { bone: 'hip', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['hip', 'neck'] } } }), 'fixture');
}

test('#384: inverse-length derivation, exact bound, below/above controls and no translation', () => {
  expect(SCALE_PAIR_GAIN).toBe(1.15);
  expect(SCALE_PAIR_VARIATION).toBeCloseTo(3 / 23, 15);
  expect(1 / (1 - SCALE_PAIR_VARIATION)).toBeCloseTo(1.15, 15);
  const m = mapOf();
  for (const lengths of [[100, 100], [100, 114], [100, 115], [100]]) expect(scalePairWarning(REST, m, framesOf(lengths), 0.3)).toBeNull();
  // Adjacent representable lengths either side of 115: do not gate on rounded percentages.
  const ulp = 64 * Number.EPSILON;
  expect(115 - ulp).toBeLessThan(115);
  expect(115 + ulp).toBeGreaterThan(115);
  expect(scalePairWarning(REST, m, framesOf([100, 115 - ulp]), 0.3)).toBeNull();
  const adjacent = scalePairWarning(REST, m, framesOf([100, 115 + ulp]), 0.3)!;
  expect(adjacent).not.toBeNull();
  const inequality = adjacent.match(/variation \(max-min\)\/max ([\d.]+)% > ([\d.]+)%/)!;
  expect(Number(inequality[1])).toBeGreaterThan(Number(inequality[2]));
  const line = scalePairWarning(REST, m, framesOf([100, 116]), 0.3)!;
  expect(line).toContain('mid_hip → neck (rig hip → neck)');
  expect(line).toContain('variation (max-min)/max 13.793103% > 13.043478%');
  noRecommendation(line);
  expect(line).toContain('advisory only, scale unchanged');
  m.translate = null;
  expect(scalePairWarning(REST, m, framesOf([100, 150]), 0.3)).toBeNull();
});

test('#384: lengths are Euclidean; in-plane lean is silent; collapse is measured without inventing a suggestion', () => {
  const frames = framesOf([100, 100, 100]);
  frames[1]!.neck = observed(60, -80);
  frames[2]!.neck = observed(100, 0);
  expect(scalePairWarning(REST, mapOf(), frames, 0.3)).toBeNull();
  const m = mapOf();
  m.chains = m.chains.slice(0, 1);
  const line = scalePairWarning(REST, m, framesOf([0, 100]), 0.3)!;
  expect(line).toContain('100.000000%');
  noRecommendation(line);
  expect(line).not.toContain('steadier mapped pair:');
  expect(scalePairWarning(REST, m, framesOf([0, 0]), 0.3)).toBeNull();
});

test('#384: missing/low-score/virtual points are not held into measured stability; other pairs cannot supply missing observations', () => {
  const frames = framesOf([100, 150, 120]);
  frames[1]!.neck = { state: 'missing' };
  frames[2]!.r_hip!.score = 0.1;
  expect(scalePairWarning(REST, mapOf(), frames, 0.3)).toBeNull();
  const partial = framesOf([100, 150, 120]);
  partial[1]!.r_shoulder = { state: 'missing' };
  noRecommendation(scalePairWarning(REST, mapOf(), partial, 0.3));
  partial[1]!.r_shoulder = { ...observed(-30, -150), score: 0.1 };
  noRecommendation(scalePairWarning(REST, mapOf(), partial, 0.3));
  const chosenMissing = framesOf([100, 150, 120, 140]);
  chosenMissing[3]!.neck = { state: 'missing' };
  chosenMissing[3]!.l_shoulder = observed(300, -140);
  // Other pairs cannot change which chosen-pair frames are observed.
  const missing = scalePairWarning(REST, mapOf(), chosenMissing, 0.3);
  noRecommendation(missing);
  expect(missing).toContain('3/4 good frames');
});

test('#384/#387: other map correspondences and collapsed alternative spans cannot change the warning; order is deterministic', () => {
  const frames = framesOf([100, 150, 120]);
  const m = mapOf();
  const line = scalePairWarning(REST, m, frames, 0.3);
  m.chains.reverse();
  expect(scalePairWarning(REST, m, frames, 0.3)).toBe(line);
  const conflict = mapOf();
  conflict.chains.push({ ...conflict.chains[1]!, name: 'conflict', bones: ['chest'] });
  expect(scalePairWarning(REST, conflict, frames, 0.3)).toBe(line);
  const collapsed = new Map(REST);
  collapsed.set('sleeve_l0', bone('sleeve_l0', -30, 140));
  expect(scalePairWarning(collapsed, mapOf(), frames, 0.3)).toBe(line);
  for (const f of frames) f.l_shoulder = f.r_shoulder;
  expect(scalePairWarning(REST, mapOf(), frames, 0.3)).toBe(line);
});

test('#387 option (b): neither a steadier mismatched correspondence nor a genuinely better pair is recommended', () => {
  const frames = framesOf([150, 150, 150]);
  for (const [i, width] of [60, 40, 50].entries()) {
    frames[i]!.r_shoulder = observed(-width / 2, -150);
    frames[i]!.l_shoulder = observed(width / 2, -150);
  }
  const map = mapOf();
  map.translate!.scale = { pose: ['r_shoulder', 'l_shoulder'], rig: ['sleeve_r0', 'sleeve_l0'] };
  const mismatch = new Map(REST);
  mismatch.set('chest', bone('chest', 0, 75));
  // The explicit trunk chain is perfectly steady but implies 75/150 = 0.5,
  // while hip-to-neck implies 150/150 = 1 and shoulders imply 60/50 = 1.2.
  const trunkScale = (mismatch.get('neck')!.worldY - mismatch.get('chest')!.worldY) / 150;
  const bodyScale = (mismatch.get('neck')!.worldY - mismatch.get('hip')!.worldY) / 150;
  expect(bodyScale / trunkScale).toBeGreaterThan(SCALE_PAIR_GAIN);
  const wrong = scalePairWarning(mismatch, map, frames, 0.3);
  noRecommendation(wrong);
  expect(wrong).toContain('r_shoulder → l_shoulder (rig sleeve_r0 → sleeve_l0)');
  expect(wrong).toContain('33.333333% > 13.043478%');
  expect(wrong).not.toContain('mid_hip → neck');
  // Matching shoulders are genuinely steadier than this chosen variable trunk;
  // option (b) still offers no replacement.
  const better = scalePairWarning(REST, mapOf(), framesOf([100, 150, 120]), 0.3);
  noRecommendation(better);
  expect(better).not.toContain('r_shoulder → l_shoulder');
  console.log(`SCALE_PAIR_387 generated mismatch: trunk variation 0%, implied ${trunkScale}; body ${bodyScale}; shoulders 40..60px, implied 1.2; recommends none; matching steady shoulders with variable trunk also recommends none`);
});

/** Check the actual JSON example's pair against its adjacent safety condition. */
function exampleAgrees(text: string): boolean {
  const section = text.split('## The map: `rig-pose-map/1`')[1]?.split('\n### ')[0] ?? '';
  const block = section.match(/```json\n([\s\S]*?)\n```/);
  if (block === null) return false;
  const map = readMap(block[1]!, 'REFERENCE map');
  const pose = map.translate?.scale.pose;
  if (pose?.join(',') !== 'mid_hip,neck') return false;
  const adjacent = section.slice(section.indexOf('```', section.indexOf('```') + 3) + 3).split('\n- A chain')[0]!;
  return adjacent.includes("This example's trunk scale pair is safe only when its picture length stays steady")
    && adjacent.includes('and the trunk is not foreshortened')
    && section.includes('Choose a long span whose picture length stays steady through the clip')
    && section.includes('mostly frontal') && section.includes('1-1/1.15 = 3/23')
    && section.includes('recommends no alternative pair')
    && section.includes('Steadiness alone cannot validate pose-to-rig proportions');
}

test('#384 docs: the example pair and adjacent rule agree; unqualified trunk or contradictory example goes red', () => {
  const text = readFileSync(join(ROOT, 'docs', 'REFERENCE.md'), 'utf8');
  expect(exampleAgrees(text)).toBe(true);
  expect(exampleAgrees(text.replace("This example's trunk scale pair is safe only when its picture length stays steady", 'The trunk pair is always safe'))).toBe(false);
  expect(exampleAgrees(text.replace('and the trunk is not foreshortened', 'even if the trunk is foreshortened'))).toBe(false);
  expect(exampleAgrees(text.replace('recommends no alternative pair', 'recommends the steadiest pair'))).toBe(false);
  expect(exampleAgrees(text.replace('"pose": ["mid_hip", "neck"], "rig": ["hip", "neck"]', '"pose": ["r_hip", "neck"], "rig": ["hip", "neck"]'))).toBe(false);
});

/** Known foreshortening planted on #375's public generated run, leaving shoulder width steady. */
function variableRun(): string {
  const seq = readPoseSequence(sequence(), 'fixture');
  seq.frames.forEach((frame, i) => {
    const joints = frame.people[0]!.joints;
    const dy = 25 * (1 - Math.cos(2 * Math.PI * i / 20));
    for (const joint of ['neck', 'nose', 'r_eye', 'l_eye', 'r_ear', 'l_ear', 'r_shoulder', 'l_shoulder', 'r_elbow', 'l_elbow', 'r_wrist', 'l_wrist'] as const) joints[joint]!.at![1] += dy;
  });
  return writePoseSequence(clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture').seq);
}

/** Turning shoulder width on a derivative only; trunk and lower body stay exact. */
function turningRun(): string {
  const seq = readPoseSequence(sequence(), 'fixture');
  seq.frames.forEach((frame, i) => {
    const joints = frame.people[0]!.joints;
    const dx = 5 * (1 - Math.cos(2 * Math.PI * i / 20));
    for (const joint of ['r_shoulder', 'r_elbow', 'r_wrist'] as const) joints[joint]!.at![0] += dx;
    for (const joint of ['l_shoulder', 'l_elbow', 'l_wrist'] as const) joints[joint]!.at![0] -= dx;
  });
  return writePoseSequence(clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture').seq);
}

test('#384 fixture applicability: original generated run trunk is constant; the controlled derivative foreshortens only its upper-body height', () => {
  const span = (text: string, pair: [string, string]) => {
    const seq = readPoseSequence(text, 'fixture');
    const lengths = personTrack(seq, undefined, 'fixture').map((f) => {
      const a = pointOn(f, pair[0], 0.3), b = pointOn(f, pair[1], 0.3);
      if (typeof a === 'string' || typeof b === 'string') throw new Error('fixture needs both points observed');
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    });
    return { min: Math.min(...lengths), max: Math.max(...lengths), frames: lengths.length };
  };
  const original = sequence(), derivative = variableRun();
  const trunk = span(original, ['mid_hip', 'neck']);
  const variable = span(derivative, ['mid_hip', 'neck']);
  const shoulder = span(derivative, ['r_shoulder', 'l_shoulder']);
  for (const [measured, min, max] of [[trunk, 150, 150], [variable, 100, 150], [shoulder, 60, 60]] as const) {
    expect(measured.frames).toBe(200);
    // Coordinate subtraction/hypot can retain floating roundoff from generator translations.
    const roundoff = 16 * Number.EPSILON * Math.max(1, min, max);
    expect(Math.abs(measured.min - min)).toBeLessThanOrEqual(roundoff);
    expect(Math.abs(measured.max - max)).toBeLessThanOrEqual(roundoff);
  }
  const lower = (text: string) => personTrack(readPoseSequence(text, 'fixture'), undefined, 'fixture').map((f) => Object.fromEntries(
    (['r_hip', 'l_hip', 'r_knee', 'l_knee', 'r_ankle', 'l_ankle'] as const).map((j) => [j, f[j]]),
  ));
  expect(lower(derivative)).toEqual(lower(original));
  console.log(`SCALE_PAIR_MEASURED ${JSON.stringify({ trunk, variable, shoulder })}; original fixture unchanged; derivative lower-body joints exact`);
});

test('#384 CLI control: generated run variable trunk warns in summary; original trunk and steady shoulders are silent; outputs equal the warning-disabled control', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-pose-scale-pair-'));
  const original = readFileSync(join(ROOT, 'src', 'run.ts'), 'utf8');
  const before = hash(original);
  try {
    const pose = join(dir, 'pose.json'), mapPath = join(dir, 'map.json');
    const out = join(dir, 'motion.json'), report = join(dir, 'report.json');
    const map = readMap(readFileSync(join(ROOT, 'examples', 'walk', 'map.json'), 'utf8'), 'fixture');
    const run = (cli: string) => spawnSync(process.execPath, [cli, 'retarget', '--rig', join(ROOT, 'examples', 'wave', 'rig'), '--map', mapPath, '--pose', pose, '--out', out, '--report', report, '--name', 'run', '--plant-feet', '--stance', '0.07', '--leg-scale', '0.5,1.05', '--floor', '0', '--flip', '45', '--summary'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const warn = (stdout: string) => stdout.split('\n').filter((l) => l.includes('SCALE-PAIR WARN'));
    writeFileSync(mapPath, JSON.stringify({ spec: 'rig-pose-map/1', ...map }));
    writeFileSync(pose, sequence());
    const plain = run(join(ROOT, 'cli.ts'));
    expect(plain.status, plain.stderr).toBe(0);
    expect(warn(plain.stdout)).toEqual([]);
    const variable = variableRun();
    writeFileSync(pose, variable);
    const current = run(join(ROOT, 'cli.ts'));
    expect(current.status, current.stderr).toBe(0);
    expect(warn(current.stdout)).toHaveLength(1);
    expect(current.stdout).toContain('mid_hip → neck');
    expect(current.stdout).toContain('picture length 100.00–150.00px');
    expect(current.stdout).toContain('33.333333% > 13.043478%');
    noRecommendation(warn(current.stdout)[0]!);
    const motion = readFileSync(out, 'utf8'), reportText = readFileSync(report, 'utf8');
    const copy = join(dir, 'copy');
    mkdirSync(copy);
    cpSync(join(ROOT, 'src'), join(copy, 'src'), { recursive: true });
    for (const name of ['cli.ts', 'package.json']) cpSync(join(ROOT, name), join(copy, name));
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const needle = 'const pairWarning = scalePairWarning(rest, map, frames, a.minScore);';
    expect(original.split(needle)).toHaveLength(2);
    writeFileSync(join(copy, 'src', 'run.ts'), original.replace(needle, 'const pairWarning: string | null = null;'));
    const disabled = run(join(copy, 'cli.ts'));
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(warn(disabled.stdout)).toEqual([]);
    expect(readFileSync(out, 'utf8')).toBe(motion);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(JSON.parse(reportText));
    writeFileSync(join(copy, 'src', 'run.ts'), original);
    expect(hash(readFileSync(join(copy, 'src', 'run.ts'), 'utf8'))).toBe(before);
    const restored = run(join(copy, 'cli.ts'));
    expect(restored.status, restored.stderr).toBe(0);
    expect(warn(restored.stdout)).toEqual(warn(current.stdout));
    map.translate!.scale = { pose: ['r_shoulder', 'l_shoulder'], rig: ['sleeve_r0', 'sleeve_l0'] };
    writeFileSync(mapPath, JSON.stringify({ spec: 'rig-pose-map/1', ...map }));
    const steady = run(join(ROOT, 'cli.ts'));
    expect(steady.status, steady.stderr).toBe(0);
    expect(warn(steady.stdout)).toEqual([]);
    // #387: the same public run, now with varying shoulders and a steady trunk.
    // The trunk chain's chest-to-neck rig span is not hip-to-neck: steadiness
    // alone must not promote that different correspondence.
    const turning = turningRun();
    writeFileSync(pose, turning);
    const mismatch = run(join(ROOT, 'cli.ts'));
    expect(mismatch.status, mismatch.stderr).toBe(0);
    const lines = warn(mismatch.stdout);
    expect(lines).toHaveLength(1);
    noRecommendation(lines[0]!);
    expect(lines[0]).toContain('r_shoulder → l_shoulder (rig sleeve_r0 → sleeve_l0)');
    expect(lines[0]).toContain('picture length 40.00–60.00px');
    expect(lines[0]).toContain('33.333333% > 13.043478%');
    expect(lines[0]).not.toContain('mid_hip → neck');
    const turningFrames = personTrack(readPoseSequence(turning, 'fixture'), undefined, 'fixture');
    const originalFrames = personTrack(readPoseSequence(sequence(), 'fixture'), undefined, 'fixture');
    for (let i = 0; i < turningFrames.length; i++) {
      for (const joint of ['neck', 'r_hip', 'l_hip', 'r_knee', 'l_knee', 'r_ankle', 'l_ankle'] as const) {
        expect(turningFrames[i]![joint]).toEqual(originalFrames[i]![joint]);
      }
    }
    const mismatchMotion = readFileSync(out, 'utf8'), mismatchReport = readFileSync(report, 'utf8');
    writeFileSync(join(copy, 'src', 'run.ts'), original.replace(needle, 'const pairWarning: string | null = null;'));
    const mismatchDisabled = run(join(copy, 'cli.ts'));
    expect(mismatchDisabled.status, mismatchDisabled.stderr).toBe(0);
    expect(warn(mismatchDisabled.stdout)).toEqual([]);
    expect(readFileSync(out, 'utf8')).toBe(mismatchMotion);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(JSON.parse(mismatchReport));
    writeFileSync(join(copy, 'src', 'run.ts'), original);
    expect(hash(readFileSync(join(copy, 'src', 'run.ts'), 'utf8'))).toBe(before);
    console.log('SCALE_PAIR_CONTROL run: original trunk 150..150px silent; planted trunk 100..150px variation 33.333333% warns; shoulder 60..60px silent; disabled control exact motion bytes and report semantics; restored warning identical');
    console.log('SCALE_PAIR_387_CLI turning derivative shoulders 40..60px variation 33.333333% warns without alternatives; all 200 trunk/lower-body frames exact; disabled control exact motion bytes and report semantics');
  } finally {
    expect(hash(readFileSync(join(ROOT, 'src', 'run.ts'), 'utf8'))).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test('#384 mutant: disabling the warning makes the CLI control red; copied source restored and original hash unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-pose-scale-mutant-'));
  const path = join(ROOT, 'src', 'run.ts'), original = readFileSync(path, 'utf8');
  const before = hash(original);
  try {
    for (const name of ['src', 'test', 'examples']) cpSync(join(ROOT, name), join(dir, name), { recursive: true });
    for (const name of ['cli.ts', 'package.json', 'README.md']) cpSync(join(ROOT, name), join(dir, name));
    cpSync(join(ROOT, 'docs'), join(dir, 'docs'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const control = () => spawnSync(process.execPath, ['test', 'test/scalepair.test.ts', '--test-name-pattern', '^#384 CLI control:'], { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const needle = 'const pairWarning = scalePairWarning(rest, map, frames, a.minScore);';
    expect(original.split(needle)).toHaveLength(2);
    writeFileSync(join(dir, 'src', 'run.ts'), original.replace(needle, 'const pairWarning: string | null = null;'));
    const red = control();
    expect(red.status).toBe(1);
    expect(red.stdout + red.stderr).toContain('toHaveLength(1)');
    writeFileSync(join(dir, 'src', 'run.ts'), original);
    expect(hash(readFileSync(join(dir, 'src', 'run.ts'), 'utf8'))).toBe(before);
    const green = control();
    expect(green.status, green.stdout + green.stderr).toBe(0);
    console.log(`SCALE_PAIR_MUTANT disabled control exit 1; restored control exit 0; original/restored src/run.ts sha256 ${before}`);
  } finally {
    expect(hash(readFileSync(path, 'utf8'))).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
