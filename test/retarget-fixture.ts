/**
 * The retarget, end to end through the CLI, held by a synthetic pose with known
 * angles and by mutants that must make that test red. Every check below has a
 * planted input that must make it fire beside a control that must not.
 *
 * Fixtures are written into a temp directory per test (under os.tmpdir()), and
 * mutants into node_modules/.cache/rig-pose-mutants/ so that `@rig-c/core/...` still
 * resolves by walking up. Both are removed after each test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poseRawAnimation, poseRawSetup, readModel, type CompiledDocument, type RawBone } from '@rig-c/core/core';
import { Plate } from '@rig-c/core/plate';
import { capShortSteps, holdAcross, holdShort, isAcross, mergeRuns, shortLine, spreadFlips } from '../src/retarget.ts';
import { clampArt } from '../src/switch.ts';
import { clean } from '../src/clean.ts';
import { loopTrack, type RigcTrack } from '../src/idle.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { scaleSupport, type Feet, type LegScale } from '../src/legs.ts';
import { readMap, type Chain } from '../src/map.ts';
import { overFloor, projectSeams, readSeamPairs } from '../src/seams.ts';
import { writeReport, type RenderDomain, type ReportInputs } from '../src/report.ts';
import { walkCycle, walkDoc } from '../examples/walk/make-walk.ts';
import { firstFrames, keysOnFrameTimes, type MotionDoc } from './discrete.ts';

export { afterEach, describe, expect, test } from 'bun:test';
export { spawnSync } from 'node:child_process';
export { createHash } from 'node:crypto';
export { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
export { tmpdir } from 'node:os';
export { join } from 'node:path';
export { poseRawAnimation, poseRawSetup, readModel, type CompiledDocument, type RawBone } from '@rig-c/core/core';
export { Plate } from '@rig-c/core/plate';
export { capShortSteps, holdAcross, holdShort, isAcross, mergeRuns, shortLine, spreadFlips } from '../src/retarget.ts';
export { clampArt } from '../src/switch.ts';
export { clean } from '../src/clean.ts';
export { loopTrack, type RigcTrack } from '../src/idle.ts';
export { readPoseSequence, writePoseSequence } from '../src/pose.ts';
export { scaleSupport, type Feet, type LegScale } from '../src/legs.ts';
export { readMap, type Chain } from '../src/map.ts';
export { overFloor, projectSeams, readSeamPairs } from '../src/seams.ts';
export { writeReport, type RenderDomain, type ReportInputs } from '../src/report.ts';
export { walkCycle, walkDoc } from '../examples/walk/make-walk.ts';
export { firstFrames, keysOnFrameTimes, type MotionDoc } from './discrete.ts';


export const ROOT = join(import.meta.dir, '..');
export const CLI = join(ROOT, 'cli.ts');
export const RIGC = join(ROOT, 'node_modules', '@rig-c', 'core', 'bin', 'rigc.cjs');
export const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;
/** The independent check's tolerances: degrees, and world units. */
export const ANGLE_TOL = 0.01;
export const ORIGIN_TOL = 0.01;
export const SLOW = 60_000;

export type Pt = [number, number];

export const wrap = (d: number): number => {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
};

/** Project only the declared #209 additions; every legacy value stays exact. */
export function legacyReportRows(value: unknown, additions: readonly string[], turnTimes = false): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('report rows must be an array');
  return value.map((row: unknown) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('report row must be an object');
    const projected = { ...row } as Record<string, unknown>;
    for (const key of additions) delete projected[key];
    if (turnTimes && 'turns' in projected) projected.turns = legacyReportRows(projected.turns, ['t']);
    return projected;
  });
}

// --- temp directories ------------------------------------------------------

export const made: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-test-'));
  made.push(d);
  return d;
}

// --- the stick rig ---------------------------------------------------------

export interface BoneSpec {
  name: string;
  parent?: string;
  x?: number;
  y?: number;
  rotation?: number;
  length?: number;
  scaleX?: number;
  inherit?: string;
}

/**
 * A stick figure the way @rig-c/parts turns one: the trunk bones at world 0°,
 * each limb link turned along its limb. Rest hinges: the right elbow bends
 * counter-clockwise (+20°), the left elbow clockwise (−20°), the right knee
 * clockwise (−10°); the left knee is straight.
 */
export function stickBones(): BoneSpec[] {
  return [
    { name: 'root' },
    { name: 'hip', parent: 'root', x: 0, y: 300 },
    { name: 'chest', parent: 'hip', x: 0, y: 75, rotation: 0 },
    { name: 'neck', parent: 'chest', x: 0, y: 75 },
    { name: 'sleeve_r0', parent: 'chest', x: -30, y: 65, rotation: -100, length: 70 },
    { name: 'sleeve_r1', parent: 'sleeve_r0', x: 70, y: 0, rotation: 20, length: 60 },
    { name: 'sleeve_l0', parent: 'chest', x: 30, y: 65, rotation: -80, length: 70 },
    { name: 'sleeve_l1', parent: 'sleeve_l0', x: 70, y: 0, rotation: -20, length: 60 },
    { name: 'leg_r0', parent: 'hip', x: -15, y: 0, rotation: -95, length: 80 },
    { name: 'leg_r1', parent: 'leg_r0', x: 80, y: 0, rotation: -10, length: 70 },
    { name: 'leg_l0', parent: 'hip', x: 15, y: 0, rotation: -85, length: 80 },
    { name: 'leg_l1', parent: 'leg_l0', x: 80, y: 0, rotation: 0, length: 70 },
  ];
}

export const LIMBS = ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1'];

export interface RigOpts {
  /** Edit the bones before writing. */
  bones?: (b: BoneSpec[]) => BoneSpec[];
  /** Add a weighted mesh across the right elbow, in its own slot. */
  mesh?: boolean;
  /** Add a slot whose image file does not exist. */
  missingImage?: boolean;
  /** A motion.json to write beside rig.json. */
  motion?: Record<string, unknown>;
  /** More attachments, by slot then name, beside each slot's setup one. */
  extra?: Record<string, Record<string, Record<string, unknown>>>;
  /** More slots, after the limbs' (one with no `attachment` shows nothing at setup). */
  extraSlots?: Array<Record<string, unknown>>;
  /** A sets.json (`rig-parts-sets/1`) to write beside rig.json. */
  sets?: Record<string, unknown>;
  /** Optional constraints array for rig.json. */
  constraints?: Array<Record<string, unknown>>;
}

/** Write `<dir>/rig/rig.json` and its images; returns the rig directory. */
export function writeRig(dir: string, o: RigOpts = {}): string {
  const rigDir = join(dir, 'rig');
  mkdirSync(join(rigDir, 'images'), { recursive: true });
  const plate = new Plate(20, 60);
  plate.rect(0, 0, 20, 60, [200, 80, 80, 255]);
  plate.writePng(join(rigDir, 'images', 'seg.png'));
  const bones = (o.bones ?? ((b) => b))(stickBones());
  const slots: Array<Record<string, unknown>> = LIMBS.map((b) => ({ name: b, bone: b, attachment: 'seg' }));
  const skin: Record<string, Record<string, unknown>> = Object.fromEntries(LIMBS.map((b) => [b, { seg: { image: 'seg.png', x: 30, y: 0, rotation: 90 } }]));
  if (o.mesh === true) {
    slots.push({ name: 'arm_mesh', bone: 'sleeve_r0', attachment: 'arm_mesh' });
    const one = (bone: string, x: number, y: number) => [{ bone, x, y, weight: 1 }];
    const half = (y: number) => [
      { bone: 'sleeve_r0', x: 70, y, weight: 0.5 },
      { bone: 'sleeve_r1', x: 0, y, weight: 0.5 },
    ];
    skin.arm_mesh = {
      arm_mesh: {
        type: 'mesh',
        image: 'seg.png',
        // The outline, walked: upper arm (+), elbow (+), wrist (+), wrist (−), elbow (−), upper arm (−).
        uvs: [0, 0, 0, 0.5, 0, 1, 1, 1, 1, 0.5, 1, 0],
        triangles: [0, 1, 5, 1, 4, 5, 1, 2, 4, 2, 3, 4],
        weights: [one('sleeve_r0', 0, 10), half(10), one('sleeve_r1', 60, 10), one('sleeve_r1', 60, -10), half(-10), one('sleeve_r0', 0, -10)],
      },
    };
  }
  slots.push(...(o.extraSlots ?? []));
  for (const [slot, atts] of Object.entries(o.extra ?? {})) skin[slot] = { ...skin[slot], ...atts };
  if (o.missingImage === true) {
    slots.push({ name: 'ghost', bone: 'chest', attachment: 'ghost' });
    skin.ghost = { ghost: { image: 'ghost.png' } };
  }
  writeFileSync(join(rigDir, 'rig.json'), JSON.stringify({ spec: 'rigc-rig/1', name: 'stick', images: 'images', skeleton: { width: 400, height: 600 }, bones, slots, ...(o.constraints === undefined ? {} : { constraints: o.constraints }), skins: { default: skin } }, null, 2));
  if (o.motion !== undefined) writeFileSync(join(rigDir, 'motion.json'), JSON.stringify(o.motion, null, 2));
  if (o.sets !== undefined) writeFileSync(join(rigDir, 'sets.json'), JSON.stringify(o.sets, null, 2));
  return rigDir;
}

// --- the map ---------------------------------------------------------------

export interface ChainSpec {
  name: string;
  bones: string[];
  joints: string[];
  aim?: string[];
  bend?: string;
}
export function baseChains(): ChainSpec[] {
  return [
    { name: 'trunk', bones: ['chest'], joints: ['mid_hip', 'neck'], aim: ['neck'] },
    { name: 'arm_r', bones: ['sleeve_r0', 'sleeve_r1'], joints: ['r_shoulder', 'r_elbow', 'r_wrist'] },
    { name: 'arm_l', bones: ['sleeve_l0', 'sleeve_l1'], joints: ['l_shoulder', 'l_elbow', 'l_wrist'] },
    { name: 'leg_r', bones: ['leg_r0', 'leg_r1'], joints: ['r_hip', 'r_knee', 'r_ankle'] },
    { name: 'leg_l', bones: ['leg_l0', 'leg_l1'], joints: ['l_hip', 'l_knee', 'l_ankle'], bend: 'free' },
  ];
}
export function baseMap(): Record<string, unknown> {
  return {
    spec: 'rig-pose-map/1',
    chains: baseChains(),
    translate: { bone: 'hip', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['hip', 'neck'] } },
  };
}

// --- the synthetic pose ----------------------------------------------------

/**
 * Known world angles per frame, Spine degrees (y up, counter-clockwise), and
 * the hip's travel in picture px (y down).
 */
export interface Motion {
  n: number;
  dt: number;
  trunk: (i: number) => number;
  ru: (i: number) => number;
  rf: (i: number) => number;
  lu: (i: number) => number;
  lf: (i: number) => number;
  rt: (i: number) => number;
  rs: (i: number) => number;
  lt: (i: number) => number;
  ls: (i: number) => number;
  hip: (i: number) => Pt;
}

/**
 * The card's pose. Frame 0 is far from rest (the right upper arm at 120° where
 * its rest is −100°): the regression control for a landing check that compared
 * frame 0 against the setup pose. The right upper arm and forearm cross ±180° in
 * the world (120° → 240°); the left upper arm's KEY crosses ±180° (its turn from
 * rest −80°, less the chest's: 140° → 215°), which is what unwrapping is for — a
 * world angle crossing ±180° alone does not exercise it. Every hinge stays on
 * its rest side; the left knee is free.
 */
export const BASE: Motion = {
  n: 16,
  dt: 0.125,
  trunk: (i) => 90 + 10 * Math.sin(i * 0.5),
  ru: (i) => 120 + 8 * i,
  rf: (i) => 120 + 8 * i + 5 + 3 * i,
  lu: (i) => 60 + 5 * i,
  lf: (i) => 60 + 5 * i - 10 - 2 * i,
  rt: (i) => -90 + 15 * Math.sin(i * 0.4),
  rs: (i) => -90 + 15 * Math.sin(i * 0.4) - 5 - 2 * i,
  lt: (i) => -90 - 10 * Math.sin(i * 0.4),
  ls: (i) => -90 - 10 * Math.sin(i * 0.4) + 3 * Math.sin(i),
  hip: (i) => [4 * i, -1.5 * i],
};
/** The pose's trunk length, px, against the rig's hip → neck, 150 units. */
export const POSE_TRUNK = 100;
export const SCALE = 150 / POSE_TRUNK;

export const BONE_ANGLE: Record<string, keyof Motion> = {
  chest: 'trunk',
  sleeve_r0: 'ru',
  sleeve_r1: 'rf',
  sleeve_l0: 'lu',
  sleeve_l1: 'lf',
  leg_r0: 'rt',
  leg_r1: 'rs',
  leg_l0: 'lt',
  leg_l1: 'ls',
};
export const angleOf = (m: Motion, bone: string, i: number): number => (m[BONE_ANGLE[bone]!] as (i: number) => number)(i);

export const dir = (deg: number, len: number): Pt => [len * Math.cos(deg * RAD), -len * Math.sin(deg * RAD)];
export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];

/** Every body-18 joint's picture position on frame i. */
export function positions(m: Motion, i: number): Record<string, Pt> {
  const h = m.hip(i);
  const mid: Pt = [200 + h[0], 400 + h[1]];
  const rHip = add(mid, [-15, 0]);
  const lHip = add(mid, [15, 0]);
  const neck = add(mid, dir(m.trunk(i), POSE_TRUNK));
  const rSh = add(neck, [-20, 0]);
  const lSh = add(neck, [20, 0]);
  const rEl = add(rSh, dir(m.ru(i), 60));
  const lEl = add(lSh, dir(m.lu(i), 60));
  const rKn = add(rHip, dir(m.rt(i), 80));
  const lKn = add(lHip, dir(m.lt(i), 80));
  const nose = add(neck, [0, -30]);
  return {
    nose,
    neck,
    r_shoulder: rSh,
    r_elbow: rEl,
    r_wrist: add(rEl, dir(m.rf(i), 50)),
    l_shoulder: lSh,
    l_elbow: lEl,
    l_wrist: add(lEl, dir(m.lf(i), 50)),
    r_hip: rHip,
    r_knee: rKn,
    r_ankle: add(rKn, dir(m.rs(i), 70)),
    l_hip: lHip,
    l_knee: lKn,
    l_ankle: add(lKn, dir(m.ls(i), 70)),
    r_eye: add(nose, [-6, -5]),
    l_eye: add(nose, [6, -5]),
    r_ear: add(nose, [-12, 0]),
    l_ear: add(nose, [12, 0]),
  };
}

export type JointDoc = Record<string, unknown>;
export type JointsDoc = Record<string, JointDoc>;

/** A rig-pose-sequence/1 document; `edit` may change a frame's joints in place. */
export function poseDoc(m: Motion, edit?: (i: number, joints: JointsDoc) => void): Record<string, unknown> {
  const frames = Array.from({ length: m.n }, (_, i) => {
    const joints: JointsDoc = {};
    for (const [name, at] of Object.entries(positions(m, i))) joints[name] = { state: 'observed', at, score: 0.9 };
    edit?.(i, joints);
    return { t: i * m.dt, people: [{ id: 'a', joints }] };
  });
  return { spec: 'rig-pose-sequence/1', space: { units: 'picture-px', origin: 'top-left', y: 'down' }, width: 400, height: 600, source: 'synthetic, test/retarget.test.ts', frames };
}

/**
 * The fixture as `rig-pose clean --legs 1 --rest 1` leaves it (#67): retarget
 * reads only a cleaned sequence. Windows of 1 smooth nothing, so a fixture's
 * known angles stay exact; the spike and occlusion steps still run, and the
 * positions they leave are written unrounded. A document the reader refuses,
 * or one already cleaned, is returned as it is, so the reader's own refusals
 * stay the ones a test sees.
 */
export function cleanedDoc(doc: Record<string, unknown>): Record<string, unknown> {
  let seq;
  try {
    seq = readPoseSequence(JSON.stringify(doc), 'fixture');
  } catch {
    return doc;
  }
  if (seq.cleaned !== undefined) return doc;
  const c = clean(seq, { loop: false, legs: 1, rest: 1 }, undefined, 'fixture');
  type Frame = { people: Array<{ joints: Record<string, Record<string, unknown>> }> };
  const frames = (doc.frames as Frame[]).map((f, i) => ({
    ...f,
    people: f.people.map((q) => ({
      ...q,
      joints: Object.fromEntries(Object.entries(q.joints).map(([n, j]) => {
        const at = (c.seq.frames[i]!.people[0]?.joints as Record<string, { at?: Pt }> | undefined)?.[n]?.at;
        return [n, at === undefined ? j : { ...j, at }];
      })),
    })),
  }));
  return { ...doc, cleaned: c.record, frames };
}

// --- running the CLI -------------------------------------------------------

export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}
export function cli(args: string[], cliPath = CLI): Ran {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export interface Case {
  dir: string;
  rig: string;
  map: string;
  pose: string;
  out: string;
  build: string;
}
/** Write a rig, a map and a pose into a fresh temp dir. */
export function setup(o: { rig?: RigOpts; map?: Record<string, unknown>; pose?: Record<string, unknown> } = {}): Case {
  const dir = tempDir();
  const rig = writeRig(dir, o.rig);
  const map = join(dir, 'map.json');
  const pose = join(dir, 'pose.json');
  writeFileSync(map, JSON.stringify(o.map ?? baseMap(), null, 2));
  writeFileSync(pose, JSON.stringify(cleanedDoc(o.pose ?? poseDoc(BASE)), null, 2));
  return { dir, rig, map, pose, out: join(dir, 'motion.out.json'), build: join(dir, 'build') };
}
export function retarget(c: Case, extra: string[] = [], cliPath = CLI): Ran {
  return cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', c.pose, '--out', c.out, '--build', c.build, ...extra], cliPath);
}
export const fails = (r: Ran): string[] => r.stderr.split('\n').filter((l) => l.startsWith('FAIL  '));
export const linesOf = (r: Ran, tag: string): string[] => r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${tag} `));
/** The STANCE lines past the #237 `unit` line, which every --stance run prints first. */
export const stanceRuns = (r: Ran): string[] => linesOf(r, 'STANCE').filter((l) => !l.startsWith('STANCE unit: '));

/**
 * The report's documented top level (#83): docs/REFERENCE.md's `--report` paragraph (the README's until
 * rig-c/pose#400), its names outside its parentheses, and the demand lists below it. `conditional` holds the demand lists the reference says are
 * present only when a set of the map declares `place` (#93).
 */
export const COND_PLACE = 'Present only when a set of the map declares `place`; a run without one writes no `byHip` key.';
export function documentedReport(): { para: string; all: string[]; conditional: string[] } {
  const readme = readFileSync(join(import.meta.dir, '..', 'docs', 'REFERENCE.md'), 'utf8');
  const para = readme.split('\n').find((l) => l.startsWith('`--report <file>` writes all of it as JSON (`rig-pose-report/1`)'))!;
  let depth = 0;
  const top: string[] = [];
  for (const m of para.matchAll(/[()]|`([^`]*)`/g)) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth--;
    else if (depth === 0 && /^[A-Za-z]+$/.test(m[1]!)) top.push(m[1]!);
  }
  const lines = readme.split('\n');
  const from = lines.indexOf('The demand lists:');
  if (from < 0) throw new Error('docs/REFERENCE.md has no "The demand lists:" line');
  const conditional: string[] = [];
  for (const l of lines.slice(from + 2)) {
    const d = /^- `([A-Za-z]+)[`:]/.exec(l);
    if (d === null) break;
    top.push(d[1]!);
    if (l.includes(COND_PLACE)) conditional.push(d[1]!);
  }
  return { para, all: [...new Set(top)].sort(), conditional };
}

// --- the independent check -------------------------------------------------

export function loadBuild(build: string): CompiledDocument {
  const path = join(build, 'skeleton.model.json');
  return readModel(readFileSync(path, 'utf8'), path);
}
export const byName = (bones: RawBone[]): Map<string, RawBone> => new Map(bones.map((b) => [b.name, b]));
/** A bone's world angle as the map aims it: chest at neck, every limb along its x axis. */
export function worldAngle(bones: Map<string, RawBone>, bone: string): number {
  const o = bones.get(bone)!;
  if (bone === 'chest') {
    const n = bones.get('neck')!;
    return Math.atan2(n.worldY - o.worldY, n.worldX - o.worldX) * DEG;
  }
  return Math.atan2(o.c, o.a) * DEG;
}

/**
 * Pose the gated build with rig-c's poser, independently of the package's own
 * landing check, and list every way it misses the known motion: each mapped
 * bone's world angle on every frame and halfway between frames (where a key
 * that was not unwrapped across ±180° interpolates the long way round), and the
 * hip's world origin against its known, scaled travel.
 */
export function misses(build: string, m: Motion, expected: (bone: string, i: number) => number = (b, i) => angleOf(m, b, i)): string[] {
  const out: string[] = [];
  if (!existsSync(join(build, 'skeleton.model.json'))) return [`no build at ${build}`];
  const doc = loadBuild(build);
  const setupHip = byName(poseRawSetup(doc).bones).get('hip')!;
  const half = Array.from({ length: 2 * (m.n - 1) }, () => m.dt / 2);
  const poses = poseRawAnimation(doc, 'dance', half);
  if (poses.length !== 2 * m.n - 1) return [`posed ${poses.length} frames, expected ${2 * m.n - 1}`];
  for (let k = 0; k < poses.length; k++) {
    const bones = byName(poses[k]!.bones);
    const i = k >> 1;
    for (const bone of Object.keys(BONE_ANGLE)) {
      const want = k % 2 === 0 ? expected(bone, i) : expected(bone, i) + wrap(expected(bone, i + 1) - expected(bone, i)) / 2;
      const got = worldAngle(bones, bone);
      const e = Math.abs(wrap(got - want));
      if (!(e <= ANGLE_TOL)) out.push(`${bone} ${k % 2 === 0 ? `frame ${i}` : `between frames ${i} and ${i + 1}`}: world ${got.toFixed(4)}° want ${want.toFixed(4)}° (|e| ${e.toFixed(4)}°)`);
    }
    if (k % 2 === 0) {
      const h = m.hip(i);
      const want: Pt = [setupHip.worldX + h[0] * SCALE, setupHip.worldY - h[1] * SCALE];
      const hip = bones.get('hip')!;
      const e = Math.hypot(hip.worldX - want[0], hip.worldY - want[1]);
      if (!(e <= ORIGIN_TOL)) out.push(`hip frame ${i}: origin (${hip.worldX.toFixed(3)}, ${hip.worldY.toFixed(3)}) want (${want[0].toFixed(3)}, ${want[1].toFixed(3)}) (|e| ${e.toFixed(4)})`);
    }
  }
  return out;
}

export interface MotionOut {
  animations: Record<string, { duration: number; tracks: Array<{ bone: string; property: string; keys: Array<{ t: number; v: number[] }> }> }>;
}
export const motionOf = (path: string): MotionOut => JSON.parse(readFileSync(path, 'utf8')) as MotionOut;

/** The card's test, against a given CLI: green only when the CLI wrote and the rig lands on every known angle. */
export function cardTest(cliPath = CLI, args: string[] = []): { ran: Ran; misses: string[]; c: Case } {
  const c = setup();
  const ran = retarget(c, args, cliPath);
  return { ran, misses: ran.status === 0 ? misses(c.build, BASE) : [], c };
}

// ===========================================================================

export interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  /** Extra retarget flags for this run. */
  args?: string[];
  /** The CLI writes (its own checks are blind to this mutant) and only the independent angle check is red. */
  onlyIndependent?: boolean;
}
export const MUTATIONS: Mutation[] = [
  {
    name: 'pictureAngle drops the y flip',
    file: 'src/retarget.ts',
    from: 'return screenToSpineDegrees(Math.atan2(to[1] - from[1], to[0] - from[0]) * DEG);',
    to: 'return Math.atan2(to[1] - from[1], to[0] - from[0]) * DEG;',
  },
  {
    // The package measures landing against its own targets, which this mutant
    // flipped; with the hinge check out of the way only the known angles see it.
    name: 'pictureAngle drops the y flip, under --bends clamp',
    file: 'src/retarget.ts',
    from: 'return screenToSpineDegrees(Math.atan2(to[1] - from[1], to[0] - from[0]) * DEG);',
    to: 'return Math.atan2(to[1] - from[1], to[0] - from[0]) * DEG;',
    args: ['--bends', 'clamp'],
    onlyIndependent: true,
  },
  {
    name: 'the key adds the parent\'s turn instead of subtracting it',
    file: 'src/retarget.ts',
    from: 'const raw = turn(b, i) - (above === null ? 0 : turn(above, i));',
    to: 'const raw = turn(b, i) + (above === null ? 0 : turn(above, i));',
  },
  {
    name: 'the keys are not unwrapped across frames',
    file: 'src/retarget.ts',
    from: 'const v = i === 0 ? wrap(raw) : prev + wrap(raw - prev);',
    to: 'const v = wrap(raw);',
  },
  {
    name: 'the landing check poses frame 0 as the setup pose',
    file: 'src/verify.ts',
    from: "const poses = poseRawAnimation(doc, animation, steps, {}, 'animation');",
    to: "const poses = poseRawAnimation(doc, animation, steps, {}, 'setup');",
  },
];

// ===========================================================================

export const COCO17 = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];
export const cocoName = (n: string): string => n.replace(/^left_/, 'l_').replace(/^right_/, 'r_');

export function cocoDoc(m: Motion, frame: (i: number, triples: Array<[number, number, number]>) => unknown = (_i, t) => t): Record<string, unknown> {
  const frames = Array.from({ length: m.n }, (_, i) => {
    const pos = positions(m, i);
    const triples = COCO17.map((n) => [...pos[cocoName(n)]!, 0.9] as [number, number, number]);
    return { t: i * m.dt, keypoints: frame(i, triples) };
  });
  return { format: 'coco17-sequence/1', width: 400, height: 600, source: 'synthetic, test/retarget.test.ts', frames };
}

export interface ReadJoint {
  state: string;
  at?: Pt;
  score?: number;
}
export interface ReadSeq {
  spec: string;
  frames: Array<{ t: number; people: Array<{ id: string; joints: Record<string, ReadJoint> }> }>;
}

// ===========================================================================

/** A longer, smooth dance for --reduce: 48 frames at 24 fps, every hinge on its rest side as in BASE. */
export const SMOOTH: Motion = {
  n: 48,
  dt: 1 / 24,
  trunk: (i) => 90 + 10 * Math.sin(i * 0.12),
  ru: (i) => 120 + 30 * Math.sin(i * 0.2),
  rf: (i) => 120 + 30 * Math.sin(i * 0.2) + 20 + 10 * Math.sin(i * 0.3),
  lu: (i) => 60 + 25 * Math.sin(i * 0.15),
  lf: (i) => 60 + 25 * Math.sin(i * 0.15) - 20 - 10 * Math.sin(i * 0.25),
  rt: (i) => -90 + 15 * Math.sin(i * 0.2),
  rs: (i) => -90 + 15 * Math.sin(i * 0.2) - 10 - 5 * Math.sin(i * 0.3),
  lt: (i) => -90 - 10 * Math.sin(i * 0.2),
  ls: (i) => -90 - 10 * Math.sin(i * 0.2) + 3 * Math.sin(i * 0.1),
  hip: (i) => [20 * Math.sin(i * 0.1), -5 * Math.sin(i * 0.2)],
};

/** Fitting each bone against its own dense keys, its parent's error ignored (the reducer's top-down rule removed). */
export const REDUCE_MUTANT = {
  from: 'const targets = b.dense.map((d, i) => [eAbove === null ? d : d - eAbove[i]!]);',
  to: 'const targets = b.dense.map((d) => [d]);',
};

/** Pose the gated build at the frame times and return the worst world error per mapped bone (degrees) and of the hip's origin (units), against the known motion. */
export function worstErrors(build: string, m: Motion): Map<string, number> {
  const doc = loadBuild(build);
  const setupHip = byName(poseRawSetup(doc).bones).get('hip')!;
  const poses = poseRawAnimation(doc, 'dance', Array.from({ length: m.n - 1 }, () => m.dt), {}, 'animation');
  const worst = new Map<string, number>();
  const note = (k: string, e: number) => worst.set(k, Math.max(worst.get(k) ?? 0, e));
  poses.forEach((p, i) => {
    const bones = byName(p.bones);
    for (const bone of Object.keys(BONE_ANGLE)) note(bone, Math.abs(wrap(worldAngle(bones, bone) - angleOf(m, bone, i))));
    const h = m.hip(i);
    const hip = bones.get('hip')!;
    note('hip', Math.hypot(hip.worldX - (setupHip.worldX + h[0] * SCALE), hip.worldY - (setupHip.worldY - h[1] * SCALE)));
  });
  return worst;
}
export const keysOf = (path: string, bone: string, property: string) => motionOf(path).animations.dance!.tracks.find((t) => t.bone === bone && t.property === property)!.keys as Array<{ t: number; v: number[]; curve?: number[] }>;
