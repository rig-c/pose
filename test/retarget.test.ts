/**
 * The retarget, end to end through the CLI, held by a synthetic pose with known
 * angles and by mutants that must make that test red. Every check below has a
 * planted input that must make it fire beside a control that must not.
 *
 * Fixtures are written into a temp directory per test (under os.tmpdir()), and
 * mutants into node_modules/.cache/rig-pose-mutants/ so that `rig-c/...` still
 * resolves by walking up. Both are removed after each test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poseRawAnimation, poseRawSetup, readModel, type CompiledDocument, type RawBone } from 'rig-c/core';
import { Plate } from 'rig-c/plate';
import { capShortSteps, holdAcross, holdShort, isAcross, mergeRuns, shortLine, spreadFlips } from '../src/retarget.ts';
import { clampArt } from '../src/switch.ts';
import { clean } from '../src/clean.ts';
import { loopTrack, type RigcTrack } from '../src/idle.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { scaleSupport, type Feet, type LegScale } from '../src/legs.ts';
import type { Chain } from '../src/map.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const RIGC = join(ROOT, 'node_modules', 'rig-c', 'bin', 'rigc.cjs');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
/** The independent check's tolerances: degrees, and world units. */
const ANGLE_TOL = 0.01;
const ORIGIN_TOL = 0.01;
const SLOW = 60_000;

type Pt = [number, number];

const wrap = (d: number): number => {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
};

/** Project only the declared #209 additions; every legacy value stays exact. */
function legacyReportRows(value: unknown, additions: readonly string[], turnTimes = false): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('report rows must be an array');
  return value.map((row: unknown) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('report row must be an object');
    const projected = { ...row } as Record<string, unknown>;
    for (const key of additions) delete projected[key];
    if (turnTimes && 'turns' in projected) projected.turns = legacyReportRows(projected.turns, ['t']);
    return projected;
  });
}

test('legacy report projection retains wrong old values and nested signed diagnostics', () => {
  const rows = [{ frames: [1, 2], seconds: 0.25, times: [0.1, 0.2], moved: { on: { frames: -1, seconds: -0.1, t: 99 } } }];
  const projected = legacyReportRows(rows, ['times']);
  expect(projected).toEqual([{ frames: [1, 2], seconds: 0.25, moved: { on: { frames: -1, seconds: -0.1, t: 99 } } }]);
  expect(projected).not.toEqual([{ frames: [1, 2], seconds: 0.5, moved: rows[0]!.moved }]);
  expect(projected).not.toEqual([{ frames: [1, 2], seconds: 0.25, moved: { on: { frames: 1, seconds: -0.1, t: 99 } } }]);
  expect(rows[0]!.times).toEqual([0.1, 0.2]);
  expect(legacyReportRows([{ turns: [{ frame: 2, jump: 150, t: 0.2 }], times: [0.1, 0.2] }], ['times'], true)).toEqual([{ turns: [{ frame: 2, jump: 150 }] }]);
});

// --- temp directories ------------------------------------------------------

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-test-'));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

// --- the stick rig ---------------------------------------------------------

interface BoneSpec {
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
function stickBones(): BoneSpec[] {
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

const LIMBS = ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1'];

interface RigOpts {
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
}

/** Write `<dir>/rig/rig.json` and its images; returns the rig directory. */
function writeRig(dir: string, o: RigOpts = {}): string {
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
  writeFileSync(join(rigDir, 'rig.json'), JSON.stringify({ spec: 'rigc-rig/1', name: 'stick', images: 'images', skeleton: { width: 400, height: 600 }, bones, slots, skins: { default: skin } }, null, 2));
  if (o.motion !== undefined) writeFileSync(join(rigDir, 'motion.json'), JSON.stringify(o.motion, null, 2));
  if (o.sets !== undefined) writeFileSync(join(rigDir, 'sets.json'), JSON.stringify(o.sets, null, 2));
  return rigDir;
}

// --- the map ---------------------------------------------------------------

interface ChainSpec {
  name: string;
  bones: string[];
  joints: string[];
  aim?: string[];
  bend?: string;
}
function baseChains(): ChainSpec[] {
  return [
    { name: 'trunk', bones: ['chest'], joints: ['mid_hip', 'neck'], aim: ['neck'] },
    { name: 'arm_r', bones: ['sleeve_r0', 'sleeve_r1'], joints: ['r_shoulder', 'r_elbow', 'r_wrist'] },
    { name: 'arm_l', bones: ['sleeve_l0', 'sleeve_l1'], joints: ['l_shoulder', 'l_elbow', 'l_wrist'] },
    { name: 'leg_r', bones: ['leg_r0', 'leg_r1'], joints: ['r_hip', 'r_knee', 'r_ankle'] },
    { name: 'leg_l', bones: ['leg_l0', 'leg_l1'], joints: ['l_hip', 'l_knee', 'l_ankle'], bend: 'free' },
  ];
}
function baseMap(): Record<string, unknown> {
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
interface Motion {
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
const BASE: Motion = {
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
const POSE_TRUNK = 100;
const SCALE = 150 / POSE_TRUNK;

const BONE_ANGLE: Record<string, keyof Motion> = {
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
const angleOf = (m: Motion, bone: string, i: number): number => (m[BONE_ANGLE[bone]!] as (i: number) => number)(i);

const dir = (deg: number, len: number): Pt => [len * Math.cos(deg * RAD), -len * Math.sin(deg * RAD)];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];

/** Every body-18 joint's picture position on frame i. */
function positions(m: Motion, i: number): Record<string, Pt> {
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

type JointDoc = Record<string, unknown>;
type JointsDoc = Record<string, JointDoc>;

/** A rig-pose-sequence/1 document; `edit` may change a frame's joints in place. */
function poseDoc(m: Motion, edit?: (i: number, joints: JointsDoc) => void): Record<string, unknown> {
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
function cleanedDoc(doc: Record<string, unknown>): Record<string, unknown> {
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

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}
function cli(args: string[], cliPath = CLI): Ran {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface Case {
  dir: string;
  rig: string;
  map: string;
  pose: string;
  out: string;
  build: string;
}
/** Write a rig, a map and a pose into a fresh temp dir. */
function setup(o: { rig?: RigOpts; map?: Record<string, unknown>; pose?: Record<string, unknown> } = {}): Case {
  const dir = tempDir();
  const rig = writeRig(dir, o.rig);
  const map = join(dir, 'map.json');
  const pose = join(dir, 'pose.json');
  writeFileSync(map, JSON.stringify(o.map ?? baseMap(), null, 2));
  writeFileSync(pose, JSON.stringify(cleanedDoc(o.pose ?? poseDoc(BASE)), null, 2));
  return { dir, rig, map, pose, out: join(dir, 'motion.out.json'), build: join(dir, 'build') };
}
function retarget(c: Case, extra: string[] = [], cliPath = CLI): Ran {
  return cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', c.pose, '--out', c.out, '--build', c.build, ...extra], cliPath);
}
const fails = (r: Ran): string[] => r.stderr.split('\n').filter((l) => l.startsWith('FAIL  '));
const linesOf = (r: Ran, tag: string): string[] => r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${tag} `));

/**
 * The report's documented top level (#83): the README's `--report` paragraph, its names outside its
 * parentheses, and the demand lists below it. `conditional` holds the demand lists the README says are
 * present only when a set of the map declares `place` (#93).
 */
const COND_PLACE = 'Present only when a set of the map declares `place`; a run without one writes no `byHip` key.';
function documentedReport(): { para: string; all: string[]; conditional: string[] } {
  const readme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8');
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
  if (from < 0) throw new Error('README has no "The demand lists:" line');
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

function loadBuild(build: string): CompiledDocument {
  const path = join(build, 'skeleton.model.json');
  return readModel(readFileSync(path, 'utf8'), path);
}
const byName = (bones: RawBone[]): Map<string, RawBone> => new Map(bones.map((b) => [b.name, b]));
/** A bone's world angle as the map aims it: chest at neck, every limb along its x axis. */
function worldAngle(bones: Map<string, RawBone>, bone: string): number {
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
function misses(build: string, m: Motion, expected: (bone: string, i: number) => number = (b, i) => angleOf(m, b, i)): string[] {
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

interface MotionOut {
  animations: Record<string, { duration: number; tracks: Array<{ bone: string; property: string; keys: Array<{ t: number; v: number[] }> }> }>;
}
const motionOf = (path: string): MotionOut => JSON.parse(readFileSync(path, 'utf8')) as MotionOut;

/** The card's test, against a given CLI: green only when the CLI wrote and the rig lands on every known angle. */
function cardTest(cliPath = CLI, args: string[] = []): { ran: Ran; misses: string[]; c: Case } {
  const c = setup();
  const ran = retarget(c, args, cliPath);
  return { ran, misses: ran.status === 0 ? misses(c.build, BASE) : [], c };
}

// ===========================================================================

describe('the synthetic pose with known angles (the card\'s test)', () => {
  test('the rig lands on every known angle and the hip travels the known distance', () => {
    const { ran, misses: m, c } = cardTest();
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(m).toEqual([]);
    expect(existsSync(c.out)).toBe(true);
    expect(linesOf(ran, 'SCALE')[0]).toContain('1.50000 rig units per picture px (rig 150.00 / pose median 100.00)');
    expect(linesOf(ran, 'HOLD')).toEqual([]);
    expect(linesOf(ran, 'BEND')).toEqual([]);
    expect(linesOf(ran, 'LAND')).toHaveLength(10);
    // The pose starts away from rest: frame 0 is not the setup pose.
    expect(Math.abs(wrap(BASE.ru(0) - -100))).toBeGreaterThan(90);
    // ±180° is crossed between two frames: a world angle, and a key.
    expect(BASE.ru(7)).toBeLessThan(180);
    expect(BASE.ru(8)).toBeGreaterThan(180);
    const keys = (motionOf(c.out).animations.dance!.tracks.find((t) => t.bone === 'sleeve_l0')!.keys).map((k) => k.v[0]!);
    expect(Math.min(...keys)).toBeLessThan(180);
    expect(Math.max(...keys)).toBeGreaterThan(180);
    const motion = motionOf(c.out);
    expect(Object.keys(motion.animations)).toEqual(['dance']);
    expect(motion.animations.dance!.tracks.map((t) => `${t.bone}.${t.property}`)).toEqual([
      'chest.rotate', 'sleeve_r0.rotate', 'sleeve_r1.rotate', 'sleeve_l0.rotate', 'sleeve_l1.rotate',
      'leg_r0.rotate', 'leg_r1.rotate', 'leg_l0.rotate', 'leg_l1.rotate', 'hip.translate',
    ]);
  }, SLOW);

  test('control for the checker: a build posed against the wrong known angles is caught', () => {
    const c = setup();
    expect(retarget(c).status).toBe(0);
    const off = misses(c.build, BASE, (b, i) => angleOf(BASE, b, i) + (b === 'sleeve_l1' && i === 4 ? 0.05 : 0));
    expect(off).toEqual([expect.stringContaining('sleeve_l1 between frames 3 and 4'), expect.stringContaining('sleeve_l1 frame 4: world'), expect.stringContaining('sleeve_l1 between frames 4 and 5')]);
  }, SLOW);

  test('determinism: the same inputs write the same bytes', () => {
    const c = setup();
    expect(retarget(c).status).toBe(0);
    const first = readFileSync(c.out);
    rmSync(c.out);
    expect(retarget(c).status).toBe(0);
    expect(readFileSync(c.out).equals(first)).toBe(true);
  }, SLOW);
});

// ===========================================================================

interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  /** Extra retarget flags for this run. */
  args?: string[];
  /** The CLI writes (its own checks are blind to this mutant) and only the independent angle check is red. */
  onlyIndependent?: boolean;
}
const MUTATIONS: Mutation[] = [
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
    from: "poseRawAnimation(doc, animation, steps, {}, 'animation')",
    to: "poseRawAnimation(doc, animation, steps, {}, 'setup')",
  },
];

describe('mutants make the card\'s test red', () => {
  for (const mu of MUTATIONS) {
    test(mu.name, () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, mu.file);
        const before = readFileSync(path, 'utf8');
        expect(before.split(mu.from)).toHaveLength(2);
        const after = before.replace(mu.from, mu.to);
        expect(after).not.toBe(before);
        writeFileSync(path, after);
        expect(readFileSync(path, 'utf8')).not.toBe(readFileSync(join(ROOT, mu.file), 'utf8'));
        const { ran, misses: m } = cardTest(join(d, 'cli.ts'), mu.args);
        const red = ran.status !== 0 || m.length > 0;
        if (!red) throw new Error(`mutant "${mu.name}" survived: exit ${ran.status}, no miss`);
        expect(red).toBe(true);
        if (mu.onlyIndependent === true) {
          expect(ran.status).toBe(0);
          expect(m.length).toBeGreaterThan(0);
        }
        // Say which way it went red, for the record.
        console.log(`  mutant "${mu.name}": exit ${ran.status}${ran.status !== 0 ? `, ${fails(ran)[0] ?? ran.stderr.split('\n')[0]}` : `, ${m.length} miss(es), first: ${m[0]}`}`);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }
});

// ===========================================================================

describe('a hinge bent the wrong way', () => {
  const BENT: Motion = { ...BASE, rf: (i) => (i === 7 ? BASE.ru(7) - 15 : BASE.rf(i)) };

  test('refused naming the chain, the joint, the frame and the angle; nothing written', () => {
    const c = setup({ pose: poseDoc(BENT) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([
      'FAIL  POSE_BEND_ONE_WAY: chain "arm_r" hinge r_elbow, frame 7 (t=0.875s) — inner angle -15.0°; it bends counter-clockwise (+) at rest (20.0°), so the angle must stay ≥ 0',
    ]);
    expect(existsSync(c.out)).toBe(false);
    expect(existsSync(c.build)).toBe(false);
  }, SLOW);

  test('control: --bends clamp writes, lists the frame and lays the forearm along the upper arm', () => {
    const c = setup({ pose: poseDoc(BENT) });
    const r = retarget(c, ['--bends', 'clamp']);
    expect(r.status).toBe(0);
    const bends = linesOf(r, 'BEND');
    expect(bends).toHaveLength(1);
    expect(bends[0]).toContain('chain "arm_r" hinge r_elbow, frame 7 (t=0.875s) — inner angle -15.0°');
    expect(bends[0]).toContain('clamped straight');
    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: BENT.n - 1 }, () => BENT.dt));
    const f7 = byName(poses[7]!.bones);
    expect(Math.abs(wrap(worldAngle(f7, 'sleeve_r1') - worldAngle(f7, 'sleeve_r0')))).toBeLessThan(ANGLE_TOL);
    // Every other frame is the pose's.
    expect(misses(c.build, BENT, (b, i) => (b === 'sleeve_r1' && i === 7 ? BENT.ru(7) : angleOf(BENT, b, i))).filter((s) => !s.includes('between frames'))).toEqual([]);
  }, SLOW);

  test('control: --bend-tolerance above the bend lets it through unlisted', () => {
    const c = setup({ pose: poseDoc(BENT) });
    const r = retarget(c, ['--bend-tolerance', '20']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'BEND')).toEqual([]);
  }, SLOW);

  test('MAP_BEND_SIDE: a chain straight at rest with no "bend" stated', () => {
    const map = baseMap();
    map.chains = baseChains().map((c) => (c.name === 'leg_l' ? { name: c.name, bones: c.bones, joints: c.joints } : c));
    const c = setup({ map });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([
      'FAIL  MAP_BEND_SIDE: chain "leg_l" — the hinge at l_knee is straight at rest (inner angle 0.000°), so the rest pose does not say which way it bends; state "bend": "ccw", "cw" or "free"',
    ]);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('control: "bend": "free" on that chain is accepted (the card\'s map states it)', () => {
    expect(baseChains().find((c) => c.name === 'leg_l')!.bend).toBe('free');
    const c = setup();
    expect(retarget(c).status).toBe(0);
  }, SLOW);
});

// ===========================================================================

describe('holds', () => {
  /** Still everywhere but the left leg, so a held value is the true value. */
  const STILL: Motion = {
    ...BASE,
    trunk: () => 95,
    ru: () => 150,
    rf: () => 170,
    lu: () => -60,
    lf: () => -75,
    rt: () => -95,
    rs: () => -110,
    hip: () => [0, 0],
  };

  test('a missing and a low-score joint, and a leading gap, hold a good value and are listed', () => {
    const pose = poseDoc(STILL, (i, j) => {
      if (i >= 3 && i <= 5) {
        j.r_wrist = { state: 'missing' };
        j.l_wrist = { state: 'observed', at: [0, 0], score: 0.1 };
      }
      if (i <= 1) j.r_ankle = { state: 'occluded', at: [399, 0], score: 0.05 };
    });
    const c = setup({ pose });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'HOLD')).toEqual([
      'HOLD   point "l_wrist" frames 3–5 (t=0.375–0.625s): score 0.100 < 0.3; held frame 2\'s value',
      'HOLD   point "r_ankle" frames 0–1 (t=0.000–0.125s): score 0.050 < 0.3; held frame 2\'s value',
      'HOLD   point "r_wrist" frames 3–5 (t=0.375–0.625s): missing; held frame 2\'s value',
    ]);
    // The garbage positions were not used: the rig still lands on the known pose.
    expect(misses(c.build, STILL)).toEqual([]);
  }, SLOW);

  test('control: --min-score below the low score uses the positions it was given', () => {
    const pose = poseDoc(STILL, (i, j) => {
      if (i >= 3 && i <= 5) j.l_wrist = { state: 'observed', at: [0, 0], score: 0.1 };
    });
    const c = setup({ pose });
    const r = retarget(c, ['--min-score', '0.05', '--bends', 'clamp']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'HOLD')).toEqual([]);
    expect(misses(c.build, STILL).some((s) => s.startsWith('sleeve_l1 frame 3'))).toBe(true);
  }, SLOW);

  test('POSE_POINT_NEVER_GOOD: a joint the map needs is good on no frame', () => {
    const c = setup({ pose: poseDoc(BASE, (_i, j) => (j.r_wrist = { state: 'missing' })) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([
      'FAIL  POSE_POINT_NEVER_GOOD: point "r_wrist" is good on none of the 16 frames (missing); the map needs it, and there is no value to hold',
    ]);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);
});

// ===========================================================================

describe('the flip guard (#15): a segment that turns more than --flip degrees in one frame is spread', () => {
  /**
   * The left arm still (upper arm at −60°) and its forearm stepping 150°
   * counter-clockwise in one frame, from 140° to −70° (= 290°), at frame `at`.
   * The elbow's inner angle goes −160° → −10° on its rest side (clockwise)
   * the whole way, so the hinge check stays out of it.
   */
  const stepped = (at: number, to = -70): Motion => ({ ...BASE, lu: () => -60, lf: (i) => (i < at ? 140 : to) });
  /** The forearm's world angle on each frame of the gated build, by rig-c's poser. */
  const forearm = (build: string, m: Motion): number[] =>
    poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: m.n - 1 }, () => m.dt)).map((p) => worldAngle(byName(p.bones), 'sleeve_l1'));
  const turns = (xs: number[]): number[] => xs.slice(1).map((x, i) => wrap(x - xs[i]!));

  test('a 150° step: one FLIP line, and the rig turns at most 90° a frame, landing on the spread', () => {
    const m = stepped(8);
    const c = setup({ pose: poseDoc(m) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--flip', '90', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('flip 90°');
    expect(linesOf(r, 'FLIP')).toEqual([
      'FLIP   chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) turned +150.0° from frame 7 to 8 (t=0.875–1.000s), over 90° in one frame; spread over frames 7–8 (h=1), +50.0° per frame',
    ]);
    // The landing check (against the spread targets) is green for every bone.
    expect(linesOf(r, 'LAND')).toHaveLength(10);
    // Read back by rig-c: the spread is 140° → 190° → 240° → 290°, the frames either side are the input's.
    const spread = (b: string, i: number) => (b === 'sleeve_l1' && (i === 7 || i === 8) ? 140 + 50 * (i - 6) : angleOf(m, b, i));
    expect(misses(c.build, m, spread)).toEqual([]);
    const f = forearm(c.build, m);
    expect(Math.max(...turns(f).map(Math.abs))).toBeLessThanOrEqual(90 + ANGLE_TOL);
    expect(Math.abs(wrap(f[6]! - 140))).toBeLessThan(ANGLE_TOL);
    expect(Math.abs(wrap(f[9]! - -70))).toBeLessThan(ANGLE_TOL);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { options: { flip: unknown }; flips: unknown[] };
    expect(rep.options.flip).toBe(90);
    expect(legacyReportRows(rep.flips, ['times'], true)).toEqual([{ chain: 'arm_l', bone: 'sleeve_l1', joints: ['l_elbow', 'l_wrist'], jump: expect.closeTo(150, 6), turns: [{ frame: 8, jump: expect.closeTo(150, 6) }], frames: [7, 8], h: 1, step: expect.closeTo(50, 6), clipped: null }]);
  }, SLOW);

  test('control: without the guard the same build turns 150° in one frame (what the guard is for)', () => {
    const m = stepped(8);
    const c = setup({ pose: poseDoc(m) });
    const r = retarget(c, ['--flip', 'off']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('flip off');
    expect(linesOf(r, 'FLIP')).toEqual([]);
    expect(misses(c.build, m)).toEqual([]);
    expect(Math.abs(turns(forearm(c.build, m))[7]!)).toBeCloseTo(150, 2);
  }, SLOW);

  test('control: a 60° step is under the threshold, untouched and unlisted', () => {
    const m = stepped(8, -160);
    const c = setup({ pose: poseDoc(m) });
    const r = retarget(c, ['--flip', '90']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FLIP')).toEqual([]);
    expect(misses(c.build, m)).toEqual([]);
  }, SLOW);

  test('a step at frame 1: the window stops at the first frame, which keeps the input\'s angle', () => {
    const m = stepped(1);
    const c = setup({ pose: poseDoc(m) });
    const r = retarget(c, ['--flip', '90']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FLIP')).toEqual([
      'FLIP   chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) turned +150.0° from frame 0 to 1 (t=0.000–0.125s), over 90° in one frame; spread over frame 1 (h=1), +75.0° per frame; the window was cut short at the first frame of the pose',
    ]);
    expect(misses(c.build, m, (b, i) => (b === 'sleeve_l1' && i === 1 ? 215 : angleOf(m, b, i)))).toEqual([]);
  }, SLOW);

  test('--flip takes off or degrees in (0, 180); anything else is exit 2', () => {
    const c = setup();
    for (const v of ['0', '180', 'none', '-5']) {
      const r = retarget(c, ['--flip', v]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--flip is "${v}"; it must be off, or degrees in (0, 180)`);
    }
    expect(existsSync(c.out)).toBe(false);
  });

  test('spreadFlips: the smallest h, centred; ends kept; a series under the threshold untouched', () => {
    const a = [0, 0, 0, 0, 0, 170, 170, 170, 170, 170];
    expect(spreadFlips(a, 90)).toEqual([{ jump: 170, turns: [{ frame: 5, jump: 170 }], frames: [4, 5], h: 1, step: expect.closeTo(170 / 3, 9), clipped: null }]);
    expect(a.map((x) => Math.round(x * 1000) / 1000)).toEqual([0, 0, 0, 0, 56.667, 113.333, 170, 170, 170, 170]);
    // A step too big for h = 1 at a tighter threshold widens to h = 2 (5 turns of 34°).
    const b = [0, 0, 0, 0, 0, 170, 170, 170, 170, 170];
    expect(spreadFlips(b, 50)[0]).toMatchObject({ frames: [3, 6], h: 2 });
    expect(Math.max(...turns(b).map(Math.abs))).toBeLessThanOrEqual(50);
    const still = [10, 40, 70, 100, 130];
    expect(spreadFlips(still, 90)).toEqual([]);
    expect(still).toEqual([10, 40, 70, 100, 130]);
  });

  test('spreadFlips: neighbouring windows merge into one; a window at the last frame says so', () => {
    // Out by +150° at frame 4 and back by −150° at frame 5: the two windows overlap and become one line.
    const a = [0, 0, 0, 0, 150, 0, 0, 0];
    const s = spreadFlips(a, 90);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ turns: [{ frame: 4 }, { frame: 5 }], frames: [3, 5], h: 1, clipped: null });
    expect(a.every((x) => Math.abs(x) < 1e-9)).toBe(true);
    const e = [0, 0, 0, 0, 0, 150];
    expect(spreadFlips(e, 90)).toEqual([{ jump: 150, turns: [{ frame: 5, jump: 150 }], frames: [4, 4], h: 1, step: 75, clipped: 'end' }]);
    // A turn the short way round: 170° → −170° is +20°, not a flip.
    expect(spreadFlips([170, -170, -150], 90)).toEqual([]);
  });

  test('the guard is off unless --flip is given: a 150° step is keyed as the pose gives it', () => {
    const m = stepped(8);
    const c = setup({ pose: poseDoc(m) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FLIP')).toEqual([]);
    expect(Math.max(...turns(forearm(c.build, m)).map(Math.abs))).toBeGreaterThan(149);
  }, SLOW);
});

// ===========================================================================

describe('the short hold (#22): a segment under --short of its median picture length has its angle interpolated', () => {
  /** 30 fps; the left upper arm still at −60°, its forearm turning steadily 130° → 175°, on the elbow's rest side throughout. */
  const STEADY: Motion = { ...BASE, dt: 1 / 30, lu: () => -60, lf: (i) => 130 + 3 * i };
  /** Where the shrunken forearm points in the picture: noise, every value on the elbow's rest side (inner angle in (−180°, 0°)). */
  const NOISE = [200, 290, 130, 250, 170, 280];
  /** The forearm shrunk to 5 px of its 50 (0.1) on `len` frames from `from`, pointing NOISE's way. */
  const shrunk = (from: number, len: number): Record<string, unknown> => poseDoc(STEADY, (i, j) => {
    if (i < from || i >= from + len) return;
    j.l_wrist = { state: 'observed', at: add(j.l_elbow!.at as Pt, dir(NOISE[i - from]!, 5)), score: 0.9 };
  });
  /** The angles the pose gives: NOISE on the shrunken frames. */
  const asGiven = (from: number, len: number) => (b: string, i: number): number => (b === 'sleeve_l1' && i >= from && i < from + len ? NOISE[i - from]! : angleOf(STEADY, b, i));
  interface Report { options: { short: unknown }; short: unknown[]; endOn: unknown[] }

  test('a forearm at 0.1 of its length for 6 frames (0.2 s): SHORT and END-ON, and the rig follows the interpolated angle', () => {
    const c = setup({ pose: shrunk(5, 6) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--short', '0.35', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('short 0.35');
    expect(linesOf(r, 'SHORT')).toEqual([
      'SHORT  chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) frames 5–10 (t=0.167–0.333s): picture length down to 0.10 of its median, under 0.35; its direction is not read — interpolated from frame 4\'s angle to frame 11\'s, the short way round',
    ]);
    expect(linesOf(r, 'END-ON')).toEqual([
      'END-ON chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) frames 5–10 (t=0.167–0.333s): 0.200s under 0.35 of its median picture length (down to 0.10), ≥ 0.15s — seen end-on, a pose the rig cannot draw',
    ]);
    expect(linesOf(r, 'LAND')).toHaveLength(10);
    // Read back by rig-c: the forearm is linear in the pose, so the line from frame 4 to 11 is its true angle.
    expect(misses(c.build, STEADY)).toEqual([]);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as Report;
    expect(rep.options.short).toBe(0.35);
    expect(legacyReportRows(rep.short, ['times'])).toEqual([{ chain: 'arm_l', bone: 'sleeve_l1', joints: ['l_elbow', 'l_wrist'], frames: [5, 10], minFraction: expect.closeTo(0.1, 9) }]);
    expect(legacyReportRows(rep.endOn, ['times', 'spanSeconds'])).toEqual([{ chain: 'arm_l', bone: 'sleeve_l1', joints: ['l_elbow', 'l_wrist'], frames: [5, 10], seconds: 0.2, minFraction: expect.closeTo(0.1, 9) }]);
  }, SLOW);

  // Since #67 a 4-frame shrink, still under END-ON's 0.15 s: clean's 5-frame median takes a 2-frame collapse out as a
  // spike, and on this fixture (the arm moving ~12 px a frame) the last frame of a 3-frame run as well.
  test('a 4-frame shrink (0.133 s, a blur): SHORT, but not END-ON', () => {
    const c = setup({ pose: shrunk(7, 4) });
    const r = retarget(c, ['--short', '0.35']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SHORT')).toEqual([
      'SHORT  chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) frames 7–10 (t=0.233–0.333s): picture length down to 0.10 of its median, under 0.35; its direction is not read — interpolated from frame 6\'s angle to frame 11\'s, the short way round',
    ]);
    expect(linesOf(r, 'END-ON')).toEqual([]);
    expect(misses(c.build, STEADY)).toEqual([]);
  }, SLOW);

  test('control: without --short the same pose is keyed as given, and nothing is listed', () => {
    const c = setup({ pose: shrunk(5, 6) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('short off');
    expect(linesOf(r, 'SHORT')).toEqual([]);
    expect(linesOf(r, 'END-ON')).toEqual([]);
    expect(misses(c.build, STEADY, asGiven(5, 6))).toEqual([]);
    expect(misses(c.build, STEADY).some((m) => m.startsWith('sleeve_l1 frame 5'))).toBe(true);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as Report;
    expect(rep.options.short).toBe('off');
    expect(rep.short).toEqual([]);
    expect(rep.endOn).toEqual([]);
  }, SLOW);

  test('with --flip 90 as well, the held span is not also a FLIP; control: --flip 90 alone spreads its jumps', () => {
    const c = setup({ pose: shrunk(5, 6) });
    const both = retarget(c, ['--short', '0.35', '--flip', '90']);
    expect(both.status).toBe(0);
    expect(linesOf(both, 'SHORT')).toHaveLength(1);
    expect(linesOf(both, 'FLIP')).toEqual([]);
    expect(misses(c.build, STEADY)).toEqual([]);
    const flipOnly = retarget(c, ['--flip', '90', '--bends', 'clamp']);
    expect(flipOnly.status).toBe(0);
    expect(linesOf(flipOnly, 'SHORT')).toEqual([]);
    expect(linesOf(flipOnly, 'FLIP').length).toBeGreaterThan(0);
    expect(linesOf(flipOnly, 'FLIP').every((l) => l.includes('bone "sleeve_l1"'))).toBe(true);
  }, SLOW);

  test('--short takes off or a fraction in (0, 1); anything else is exit 2', () => {
    const c = setup();
    for (const v of ['0', '1', '1.5', '-0.2', 'none']) {
      const r = retarget(c, ['--short', v]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--short is "${v}"; it must be off, or a fraction in (0, 1)`);
    }
    expect(existsSync(c.out)).toBe(false);
  });

  test('POSE_SHORT_MEDIAN: a segment of zero length on most frames has no median to measure against', () => {
    // Since #67 frames 0–9: the collapsed wrist rides the elbow 12 px a frame, so on the run's last frame the
    // per-coordinate 5-frame median mixes in the far side of the step and clean takes it as a spike; 9 of 16 stay zero.
    const pose = poseDoc(STEADY, (i, j) => {
      if (i <= 9) j.l_wrist = { ...j.l_elbow! };
    });
    const c = setup({ pose });
    const r = retarget(c, ['--short', '0.35']);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([
      'FAIL  POSE_SHORT_MEDIAN: chain "arm_l" — bone "sleeve_l1"\'s segment l_elbow → l_wrist has median picture length 0px over the 16 frames; --short measures a frame\'s length against that median, and there is none to measure against',
    ]);
    expect(existsSync(c.out)).toBe(false);
    // Control: without --short the same pose writes.
    expect(retarget(c, ['--bends', 'clamp']).status).toBe(0);
  }, SLOW);

  test('holdShort: the short way round between the reliable ends; flat at either end; a series above the cutoff untouched', () => {
    const a = [170, 175, 0, 90, -175, -170];
    expect(holdShort(a, [1, 1, 0.1, 0.2, 1, 1], 0.35)).toEqual([{ frames: [2, 3], minFraction: 0.1 }]);
    // 175° → −175° is +10° the short way, over three steps.
    expect(a.map((x) => Math.round(x * 1000) / 1000)).toEqual([170, 175, 178.333, -178.333, -175, -170]);
    const start = [5, 99, 30, 40];
    expect(holdShort(start, [0.1, 0.3, 1, 1], 0.35)).toEqual([{ frames: [0, 1], minFraction: 0.1 }]);
    expect(start).toEqual([30, 30, 30, 40]);
    const end = [10, 20, 99, 5];
    expect(holdShort(end, [1, 1, 0.2, 0.3], 0.35)).toEqual([{ frames: [2, 3], minFraction: 0.2 }]);
    expect(end).toEqual([10, 20, 20, 20]);
    const fine = [1, 2, 3];
    expect(holdShort(fine, [0.35, 1, 0.9], 0.35)).toEqual([]);
    expect(fine).toEqual([1, 2, 3]);
  });

  test('mergeRuns: spans one frame apart merge, two apart do not', () => {
    expect(mergeRuns([{ frames: [2, 3], minFraction: 0.3 }, { frames: [5, 5], minFraction: 0.1 }, { frames: [8, 8], minFraction: 0.2 }], 1)).toEqual([
      { frames: [2, 5], minFraction: 0.1 },
      { frames: [8, 8], minFraction: 0.2 },
    ]);
  });
});

// ===========================================================================

describe('readers', () => {
  test('pose: every problem named in one run', () => {
    const pose = poseDoc(BASE, (i, j) => {
      if (i === 2) j.r_toe = { state: 'observed', at: [1, 1] };
      if (i === 3) j.nose = { state: 'observed', score: 0.9 };
    });
    pose.lens = 'front';
    pose.space = { units: 'picture-px', origin: 'top-left', y: 'up' };
    (pose.frames as Array<{ t: number }>)[5]!.t = (pose.frames as Array<{ t: number }>)[4]!.t;
    const c = setup({ pose });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const f = fails(r);
    const p = c.pose;
    expect(f).toContain(`FAIL  POSE_KEYS: ${p} has a key this reader does not know: "lens"; the keys it reads are spec, space, width, height, source, frames, cameraSource, camera, cleaned, travel`);
    expect(f).toContain(`FAIL  POSE_SPACE: ${p} "space" is {"units":"picture-px","origin":"top-left","y":"up"}; for "rig-pose-sequence/1" it must be exactly {"units":"picture-px","origin":"top-left","y":"down"}`);
    expect(f).toContain(`FAIL  POSE_TIME: ${p} frames[5] "t" is 0.5s, not after frame 4's 0.5s; times must strictly increase`);
    expect(f.some((l) => l.startsWith(`FAIL  POSE_JOINT_NAME: ${p} frames[2] people[0] names joint "r_toe", which body-18 does not have; the joints are nose, neck,`))).toBe(true);
    expect(f).toContain(`FAIL  POSE_JOINT_AT: ${p} frames[3] people[0] joint "nose" is "observed" and has no "at"; an observed joint has a position`);
    expect(f).toHaveLength(5);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  /** One map planted per case; the control is the card's map, green above. */
  const mapCases: Array<{ code: string; chains?: (c: ChainSpec[]) => ChainSpec[]; translate?: Record<string, unknown>; want: (map: string) => string }> = [
    {
      code: 'MAP_BONE_EXISTS',
      chains: (cs) => cs.map((c) => (c.name === 'arm_r' ? { ...c, bones: ['sleeve_r0', 'sleeve_r9'] } : c)),
      want: () => 'FAIL  MAP_BONE_EXISTS: chain "arm_r" — bone "sleeve_r9" is not in the rig; its bones are root, hip, chest, neck, sleeve_r0, sleeve_r1, sleeve_l0, sleeve_l1, leg_r0, leg_r1, leg_l0, leg_l1',
    },
    {
      code: 'MAP_CHAIN_ORDER',
      chains: (cs) => cs.map((c) => (c.name === 'arm_r' ? { ...c, bones: ['sleeve_r0', 'sleeve_l1'] } : c.name === 'arm_l' ? { ...c, bones: ['sleeve_l0', 'sleeve_r1'] } : c)),
      want: () => 'FAIL  MAP_CHAIN_ORDER: chain "arm_r" — bone "sleeve_l1" does not descend from "sleeve_r0"; its parent is "sleeve_l0"',
    },
    {
      code: 'MAP_AIM_DESCENDS',
      chains: (cs) => cs.map((c) => (c.name === 'arm_r' ? { ...c, aim: ['x', 'sleeve_r0'] } : c)),
      want: () => 'FAIL  MAP_AIM_DESCENDS: chain "arm_r" — bone "sleeve_r1" aims at "sleeve_r0", which does not descend from it; turning "sleeve_r1" would not turn that direction',
    },
    {
      code: 'MAP_TRANSLATE_PARENT',
      translate: { bone: 'neck', joint: 'neck', scale: { pose: ['mid_hip', 'neck'], rig: ['hip', 'neck'] } },
      want: () => 'FAIL  MAP_TRANSLATE_PARENT: "translate" — bone "neck" descends from "chest", which chain "trunk" turns; a translated bone\'s parent frame must not move',
    },
    {
      code: 'MAP_CHAIN_JOINTS',
      chains: (cs) => cs.map((c) => (c.name === 'arm_r' ? { ...c, joints: ['r_shoulder', 'r_elbow'] } : c)),
      want: (map) => `FAIL  MAP_CHAIN_JOINTS: chain "arm_r" has 2 bone(s) and 2 joint(s); bone k carries the segment from joint k to joint k+1, so it needs 3`,
    },
  ];
  for (const mc of mapCases) {
    test(`map: ${mc.code}`, () => {
      const map = baseMap();
      if (mc.chains) map.chains = mc.chains(baseChains());
      if (mc.translate) map.translate = mc.translate;
      const c = setup({ map });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toContain(mc.want(c.map));
      expect(fails(r).every((l) => l.startsWith(`FAIL  ${mc.code}:`) || l.startsWith('FAIL  MAP_RESOLVES:'))).toBe(true);
      if (mc.code !== 'MAP_CHAIN_JOINTS') expect(fails(r)[0]).toBe(`FAIL  MAP_RESOLVES: ${c.map} does not resolve against the rig`);
      expect(existsSync(c.out)).toBe(false);
    }, SLOW);
  }
});

// ===========================================================================

describe('the gate', () => {
  test('RIG_GATE_BASE: a rig red before any animation, with rigc\'s own lines', () => {
    const c = setup({ rig: { missingImage: true } });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const f = fails(r);
    expect(f[0]).toStartWith(`FAIL  RIG_GATE_BASE: ${join(c.rig, 'rig.json')} with no motion spec is red under rigc build --profile spine before any animation is added (exit `);
    expect(f.length).toBeGreaterThan(1);
    expect(f.slice(1).every((l) => l.startsWith('FAIL  RIGC: '))).toBe(true);
    expect(f.slice(1).join('\n')).toContain('ghost');
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  const idle = { duration: 1, tracks: [{ bone: 'chest', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 1, v: [5] }] }] };
  const motion = (animations: Record<string, unknown>) => ({ spec: 'rigc-motion/1', archetype: 'stick', cut: 'stick', easings: {}, animations });

  test('MOTION_NAME_FREE: the rig\'s motion spec already has the name', () => {
    const c = setup({ rig: { motion: motion({ dance: idle }) } });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual(['FAIL  MOTION_NAME_FREE: the rig\'s motion spec already has an animation "dance" (it has dance); name this one with --name']);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('control: the rig\'s own animation is kept beside the new one, and the pair builds green', () => {
    const c = setup({ rig: { motion: motion({ idle }) } });
    const r = retarget(c);
    expect(r.status).toBe(0);
    const out = JSON.parse(readFileSync(c.out, 'utf8')) as { animations: Record<string, unknown> };
    expect(Object.keys(out.animations)).toEqual(['idle', 'dance']);
    expect(out.animations.idle).toEqual(idle);
    const b = spawnSync(process.execPath, [RIGC, 'build', '--rig', join(c.rig, 'rig.json'), '--motion', c.out, '--out', join(c.dir, 'rebuild')], { encoding: 'utf8' });
    expect(b.status).toBe(0);
    expect(misses(join(c.dir, 'rebuild'), BASE)).toEqual([]);
  }, SLOW);
});

// ===========================================================================

describe('the landing check', () => {
  test('POSE_LANDS: a parent scaled non-uniformly breaks the key formula and is refused by bone and degrees', () => {
    const c = setup({ rig: { bones: (bs) => bs.map((b) => (b.name === 'chest' ? { ...b, scaleX: 2 } : b)) } });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const f = fails(r);
    expect(f.length).toBeGreaterThan(0);
    for (const l of f) expect(l).toMatch(/^FAIL {2}POSE_LANDS: bone "sleeve_[rl][01]" aim — worst \|reached − asked\| [\d.]+° at frame \d+ \(t=[\d.]+s\); the tolerance is 0\.01° — the rig does not turn the way the key formula assumes/);
    expect(f.some((l) => l.includes('bone "sleeve_r0"'))).toBe(true);
    const worst = Math.max(...f.map((l) => Number(/\| ([\d.]+)°/.exec(l)![1])));
    expect(worst).toBeGreaterThan(1);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);
});

// ===========================================================================

describe('folds', () => {
  test('a weighted mesh across the elbow bent hard folds, and the run lists it and still writes', () => {
    const hard = new Set([6, 7, 8, 9]);
    const HARD: Motion = { ...BASE, rf: (i) => (hard.has(i) ? BASE.ru(i) + 170 : BASE.rf(i)) };
    const c = setup({ rig: { mesh: true }, pose: poseDoc(HARD) });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const f = linesOf(r, 'FOLD');
    expect(f).toHaveLength(1);
    expect(f[0]).toStartWith('FOLD   mesh "arm_mesh" (slot "arm_mesh") folds on ');
    expect(f[0]).toContain('at 8 fps: t=');
    // The folded frames are among the hard ones.
    const ts = f[0]!.split('t=')[1]!.split(/,\s*|–/).map(Number);
    for (const t of ts) expect(t).toBeGreaterThanOrEqual(0.75 - 1e-9);
    for (const t of ts) expect(t).toBeLessThanOrEqual(1.125 + 1e-9);
    expect(existsSync(c.out)).toBe(true);
  }, SLOW);

  test('control: the same mesh under the card\'s gentle bends does not fold', () => {
    const c = setup({ rig: { mesh: true } });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FOLD')).toEqual(['FOLD   rigc render --folds at 8 fps: no mesh folds']);
  }, SLOW);
});

// ===========================================================================

const COCO17 = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];
const cocoName = (n: string): string => n.replace(/^left_/, 'l_').replace(/^right_/, 'r_');

function cocoDoc(m: Motion, frame: (i: number, triples: Array<[number, number, number]>) => unknown = (_i, t) => t): Record<string, unknown> {
  const frames = Array.from({ length: m.n }, (_, i) => {
    const pos = positions(m, i);
    const triples = COCO17.map((n) => [...pos[cocoName(n)]!, 0.9] as [number, number, number]);
    return { t: i * m.dt, keypoints: frame(i, triples) };
  });
  return { format: 'coco17-sequence/1', width: 400, height: 600, source: 'synthetic, test/retarget.test.ts', frames };
}

interface ReadJoint {
  state: string;
  at?: Pt;
  score?: number;
}
interface ReadSeq {
  spec: string;
  frames: Array<{ t: number; people: Array<{ id: string; joints: Record<string, ReadJoint> }> }>;
}

describe('COCO-17', () => {
  test('convert: sides, neck, score 0, null frames, flat and triple forms', () => {
    const dir = tempDir();
    const coco = cocoDoc({ ...BASE, n: 3 }, (i, t) => {
      if (i === 0) {
        t[5] = [10, 20, 0.8]; // left_shoulder
        t[6] = [30, 40, 0.6]; // right_shoulder
        t[9] = [1, 2, 0]; // left_wrist, score 0
        return t;
      }
      if (i === 1) return t.flat();
      return null;
    });
    const input = join(dir, 'coco.json');
    const out = join(dir, 'pose.json');
    writeFileSync(input, JSON.stringify(coco));
    const r = cli(['convert', '--coco', input, '--out', out]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('3 frame(s) of COCO-17 → body-18');
    const seq = JSON.parse(readFileSync(out, 'utf8')) as ReadSeq;
    expect(seq.spec).toBe('rig-pose-sequence/1');
    const f0 = seq.frames[0]!.people[0]!.joints;
    expect(f0.l_shoulder).toEqual({ state: 'observed', at: [10, 20], score: 0.8 });
    expect(f0.r_shoulder).toEqual({ state: 'observed', at: [30, 40], score: 0.6 });
    expect(f0.neck).toEqual({ state: 'observed', at: [20, 30], score: 0.6 });
    expect(f0.l_wrist).toEqual({ state: 'missing' });
    const want = positions(BASE, 0);
    expect(f0.r_elbow!.at![0]).toBeCloseTo(want.r_elbow![0], 2);
    expect(f0.l_knee!.at![1]).toBeCloseTo(want.l_knee![1], 2);
    expect(Object.keys(f0)).toHaveLength(18);
    // The flat 51-number form reads as the triples do.
    const f1 = seq.frames[1]!.people[0]!.joints;
    const want1 = positions(BASE, 1);
    for (const n of ['r_wrist', 'l_ankle', 'nose', 'l_eye', 'r_ear']) {
      expect(f1[n]!.at![0]).toBeCloseTo(want1[n]![0], 2);
      expect(f1[n]!.at![1]).toBeCloseTo(want1[n]![1], 2);
    }
    expect(seq.frames[2]).toEqual({ t: 0.25, people: [] });
  }, SLOW);

  test('convert: a frame that is neither form is refused by name', () => {
    const dir = tempDir();
    const input = join(dir, 'coco.json');
    writeFileSync(input, JSON.stringify(cocoDoc({ ...BASE, n: 2 }, (i, t) => (i === 1 ? t.slice(0, 16) : t))));
    const r = cli(['convert', '--coco', input, '--out', join(dir, 'pose.json')]);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  COCO_KEYPOINTS: ${input} frames[1] "keypoints" is an array; it must be 17 [x, y, score] triples, 51 numbers, or null`]);
    expect(existsSync(join(dir, 'pose.json'))).toBe(false);
  }, SLOW);

  test('retarget --coco is refused, naming clean --coco; clean --coco then retarget lands the known pose, a null frame holding every point', () => {
    const c = setup();
    const coco = join(c.dir, 'coco.json');
    writeFileSync(coco, JSON.stringify(cocoDoc(BASE, (i, t) => (i === 9 ? null : t))));
    const refused = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', coco, '--out', c.out, '--coco']);
    expect(refused.status).toBe(1);
    expect(fails(refused)).toEqual([`FAIL  POSE_NOT_CLEANED: ${coco} is COCO-17 (--coco), which carries no "cleaned" record; retarget reads a sequence rig-pose clean wrote (spikes, occlusion, smoothing; there is no flag to skip it). Run \`rig-pose clean --coco --pose ${coco} --out ${join(c.dir, 'coco.clean.json')}\` (add --loop for one cycle of a gait) and retarget --pose ${join(c.dir, 'coco.clean.json')}`]);
    expect(existsSync(c.out)).toBe(false);
    const cl = cli(['clean', '--coco', '--pose', coco, '--out', c.pose, '--legs', '1', '--rest', '1']);
    expect(cl.stderr).toBe('');
    expect(cl.status).toBe(0);
    expect(linesOf(cl, 'SPIKES')).toEqual(['SPIKES 0 replaced; frames 0, 1, 14, 15 untested (a clip end cuts the 5-frame window)']);
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const holds = linesOf(r, 'HOLD');
    expect(holds).toContain('HOLD   point "r_wrist" frame 9 (t=1.125s): missing; held frame 8\'s value');
    expect(holds).toContain('HOLD   point "neck" frame 9 (t=1.125s): missing; held frame 8\'s value');
    // Every frame but the held one is the known pose (the writer's 0.01 px rounding is inside the tolerance).
    const m = misses(c.build, BASE).filter((s) => !/frame 9\b|frames (8 and 9|9 and 10)/.test(s));
    expect(m).toEqual([]);
  }, SLOW);
});

// ===========================================================================

describe('the command line', () => {
  test('an unknown flag is exit 2, naming it', () => {
    const c = setup();
    const r = retarget(c, ['--wobble', '1']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown flag --wobble');
  });
  test('a missing --rig is exit 2', () => {
    const r = cli(['retarget', '--map', 'm.json', '--pose', 'p.json', '--out', 'o.json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--rig is required');
  });
  test('POSE_NOT_CLEANED (#67): a sequence clean did not write is refused by name, with the command to run; control: the cleaned one runs and prints CLEAN', () => {
    const c = setup();
    const raw = join(c.dir, 'scan.json');
    writeFileSync(raw, JSON.stringify(poseDoc(BASE), null, 2));
    const r = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', raw, '--out', c.out, '--build', c.build]);
    expect(r.status).toBe(1);
    const cleanOut = join(c.dir, 'scan.clean.json');
    expect(fails(r)).toEqual([`FAIL  POSE_NOT_CLEANED: ${raw} has no "cleaned" record; retarget reads a sequence rig-pose clean wrote (spikes, occlusion, smoothing; there is no flag to skip it). Run \`rig-pose clean --pose ${raw} --out ${cleanOut}\` (add --loop for one cycle of a gait) and retarget --pose ${cleanOut}`]);
    expect(existsSync(c.out)).toBe(false);
    // Running the named command makes the same file pass.
    expect(cli(['clean', '--pose', raw, '--out', cleanOut]).status).toBe(0);
    const ran = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', cleanOut, '--out', c.out, '--build', c.build]);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(linesOf(ran, 'CLEAN')).toHaveLength(1);
    expect(linesOf(ran, 'CLEAN')[0]).toStartWith('CLEAN  rig-pose-clean/1: legs 5, rest 7, no loop; no spike, frames 0, 1, 14, 15 untested (a clip end cuts the 5-frame window); jitter (mean |second difference| of y) ');
    // The fixture's own record (windows of 1) says so on the line.
    const r1 = retarget(c);
    expect(r1.status).toBe(0);
    expect(linesOf(r1, 'CLEAN')).toEqual([expect.stringContaining('CLEAN  rig-pose-clean/1: legs 1, rest 1 — no smoothing, no loop; no spike')]);
  }, SLOW);

  test('--smooth is an alias (#67): it prints so, and --smooth 7 lands byte-identical to --smooth 1', () => {
    const c = setup();
    const r7 = retarget(c, ['--smooth', '7', '--report', join(c.dir, 'r7.json')]);
    expect(r7.stderr).toBe('');
    expect(r7.status).toBe(0);
    const out7 = readFileSync(c.out);
    const build7 = readFileSync(join(c.build, 'skeleton.model.json'));
    expect(linesOf(r7, 'SMOOTH')).toEqual(['SMOOTH --smooth is carried by clean; ignored (given 7; this sequence was cleaned with legs 1, rest 1)']);
    rmSync(c.out);
    const r1 = retarget(c, ['--smooth', '1', '--report', join(c.dir, 'r1.json')]);
    expect(r1.status).toBe(0);
    expect(linesOf(r1, 'SMOOTH')).toEqual(['SMOOTH --smooth is carried by clean; ignored (given 1; this sequence was cleaned with legs 1, rest 1)']);
    expect(readFileSync(c.out).equals(out7)).toBe(true);
    expect(readFileSync(join(c.build, 'skeleton.model.json')).equals(build7)).toBe(true);
    expect(readFileSync(join(c.dir, 'r1.json')).equals(readFileSync(join(c.dir, 'r7.json')))).toBe(true);
    // Control: without --smooth, no alias line, and the same bytes again.
    rmSync(c.out);
    const r0 = retarget(c);
    expect(r0.status).toBe(0);
    expect(linesOf(r0, 'SMOOTH')).toEqual([]);
    expect(readFileSync(c.out).equals(out7)).toBe(true);
    // The known angles still land under the alias.
    expect(misses(c.build, BASE)).toEqual([]);
  }, SLOW);

  test('ARG_PATH: --out into a directory that does not exist is refused up front; nothing written', () => {
    const c = setup();
    const out = join(c.dir, 'no', 'such', 'motion.json');
    const r = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', c.pose, '--out', out, '--build', c.build]);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  ARG_PATH: --out ${out} — directory ${join(c.dir, 'no', 'such')} does not exist`]);
    expect(r.stdout).toBe('');
    expect(existsSync(join(c.dir, 'no'))).toBe(false);
    expect(existsSync(c.build)).toBe(false);
  });
  test('ARG_PATH: --report into a directory that does not exist, the same', () => {
    const c = setup();
    const report = join(c.dir, 'gone', 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  ARG_PATH: --report ${report} — directory ${join(c.dir, 'gone')} does not exist`]);
    expect(existsSync(c.out)).toBe(false);
    expect(existsSync(c.build)).toBe(false);
  });
  test('control: --build and --render into directories not there yet are made', () => {
    const c = setup();
    const build = join(c.dir, 'deep', 'er', 'build');
    const render = join(c.dir, 'deep', 'est', 'render');
    const r = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', c.pose, '--out', c.out, '--build', build, '--render', render]);
    expect(r.status).toBe(0);
    expect(existsSync(join(build, 'skeleton.model.json'))).toBe(true);
    expect(existsSync(render)).toBe(true);
  }, SLOW);
});

// --- a two-point aim: the head by its eye line -------------------------------

describe('an aim between two points ("eye_r>eye_l") turns the head by its eye line', () => {
  const headBones = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const tilt = (i: number): number => 25 * Math.sin(i * 0.6) + (i === 0 ? 30 : 0);
  /** The eyes tilted by tilt(i), Spine degrees, about their midpoint. */
  const eyes = (i: number, j: JointsDoc): void => {
    const r = j.r_eye!.at as Pt;
    const l = j.l_eye!.at as Pt;
    const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
    const d = dir(tilt(i), 6);
    j.r_eye = { state: 'observed', at: [mid[0] - d[0], mid[1] - d[1]], score: 0.9 };
    j.l_eye = { state: 'observed', at: [mid[0] + d[0], mid[1] + d[1]], score: 0.9 };
  };
  const mapWith = (aim: string): Record<string, unknown> => ({
    ...baseMap(),
    chains: [...baseChains(), { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: [aim] }],
  });

  test('the eye line lands on the pose\'s, read back by rig-c\'s poser', () => {
    const c = setup({ rig: { bones: headBones }, map: mapWith('eye_r>eye_l'), pose: poseDoc(BASE, eyes) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LAND').some((l) => l.startsWith('LAND   bone "head" aim'))).toBe(true);
    const doc = loadBuild(c.build);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: BASE.n - 1 }, () => BASE.dt));
    const off: string[] = [];
    poses.forEach((p, i) => {
      const b = byName(p.bones);
      const er = b.get('eye_r')!;
      const el = b.get('eye_l')!;
      const got = Math.atan2(el.worldY - er.worldY, el.worldX - er.worldX) * DEG;
      if (Math.abs(wrap(got - tilt(i))) > ANGLE_TOL) off.push(`frame ${i}: eye line ${got.toFixed(4)}° want ${tilt(i).toFixed(4)}°`);
    });
    expect(off).toEqual([]);
  }, SLOW);

  test('an end that does not turn with the bone is refused by name', () => {
    const c = setup({ rig: { bones: headBones }, map: mapWith('eye_r>neck'), pose: poseDoc(BASE, eyes) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.includes('MAP_AIM_DESCENDS') && l.includes('"neck"') && l.includes('bone "head"'))).toBe(true);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('two ends at one point are refused: the direction is undefined', () => {
    const c = setup({ rig: { bones: headBones }, map: mapWith('eye_r>eye_r'), pose: poseDoc(BASE, eyes) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.includes('MAP_AIM_LENGTH') && l.includes('"eye_r"'))).toBe(true);
  }, SLOW);
});

// --- the kept build stands on its own ----------------------------------------

describe('--build keeps a build rigc can draw where it was copied', () => {
  test('rigc render reads the kept build (its pages travel with it)', () => {
    const c = setup();
    const r = retarget(c);
    expect(r.status).toBe(0);
    const out = join(c.dir, 'render');
    const rr = spawnSync(process.execPath, [RIGC, 'render', '--candidate', c.build, '--animation', 'dance', '--out', out], { encoding: 'utf8' });
    expect(`${rr.stdout}${rr.stderr}`).not.toContain('nothing at');
    expect(rr.status).toBe(0);
    expect(existsSync(join(out, 'dance', 'contact.png'))).toBe(true);
  }, SLOW);
});

// --- smoothing: moved to clean (#67) ---------------------------------------------
// Retarget smooths nothing since #67; the Savitzky–Golay and its tests are in
// src/clean.ts and test/clean.test.ts.

// --- midpoints: "a+b" -----------------------------------------------------------

describe('a rig point may be the midpoint of two ("a+b")', () => {
  const midMap = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, aim: ['sleeve_r0+sleeve_l0'] } : c)),
    translate: { bone: 'hip', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['leg_r0+leg_l0', 'neck'] } },
  });

  test('the trunk aimed at the shoulders\' midpoint, and the scale from the legs\' midpoint: the card\'s pose lands', () => {
    // The stick rig's shoulders' midpoint is on the chest's y axis, as its neck is, and the legs' midpoint is the hip.
    const c = setup({ map: midMap() });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SCALE')[0]).toContain('1.50000 rig units per picture px (rig 150.00 / pose median 100.00)');
    expect(misses(c.build, BASE)).toEqual([]);
  }, SLOW);

  test('each half of a midpoint aim must turn with the bone', () => {
    const map = midMap();
    map.chains = baseChains().map((ch) => (ch.name === 'trunk' ? { ...ch, aim: ['sleeve_r0+hip'] } : ch));
    const c = setup({ map });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toContain('FAIL  MAP_AIM_DESCENDS: chain "trunk" — bone "chest" aims at "hip", which does not descend from it; turning "chest" would not turn that direction');
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('a missing half is named, in an aim and in the scale; three halves are not a point', () => {
    const map = midMap();
    map.chains = baseChains().map((ch) => (ch.name === 'trunk' ? { ...ch, aim: ['sleeve_r0+sleeve_x9'] } : ch));
    map.translate = { bone: 'hip', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['leg_r0+leg_x9', 'neck'] } };
    const c = setup({ map });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toContain('FAIL  MAP_AIM_EXISTS: chain "trunk" — bone "chest" aims at "sleeve_x9" (of "sleeve_r0+sleeve_x9"), which is not in the rig');
    expect(fails(r)).toContain('FAIL  MAP_BONE_EXISTS: "translate" "scale.rig" — "leg_r0+leg_x9" reads "leg_x9", which is not a bone in the rig (a point is a bone name, name:tip, or a+b)');
    const map3 = midMap();
    map3.chains = baseChains().map((ch) => (ch.name === 'trunk' ? { ...ch, aim: ['sleeve_r0+sleeve_l0+neck'] } : ch));
    const c3 = setup({ map: map3 });
    const r3 = retarget(c3);
    expect(r3.status).toBe(1);
    expect(fails(r3)).toEqual([`FAIL  MAP_POINT: chain "trunk" names the point "sleeve_r0+sleeve_l0+neck"; a point is a bone name, name:tip (the end of its x axis), or a+b (the midpoint of two of those)`]);
  }, SLOW);
});

// --- the pelvis: hip tilt, and a trunk that reaches ---------------------------------

describe('the pelvis tilts and the trunk reaches from the posed hip for the shoulders', () => {
  /** Hip-line tilt, Spine degrees; frame 0 is off level. */
  const tilt = (i: number): number => 12 * Math.sin(i * 0.5) + (i === 0 ? 5 : 0);
  /** The chest's world angle on the rig, Spine degrees, which the pose's mid-shoulder is built from. */
  const chestAngle = (i: number): number => 90 + 15 * Math.sin(i * 0.4 + 1);
  /**
   * The stick rig with a control bone between hip and chest, as @rig-c/parts
   * builds one (chest_ctl 40 above the hip, the chest 35 above that): the
   * chest's posed origin is reached through an unmapped bone. The shoulders'
   * midpoint is 65 above the chest.
   */
  const ctlBones = (bs: BoneSpec[]): BoneSpec[] => bs.flatMap((b) => (b.name === 'chest' ? [{ name: 'chest_ctl', parent: 'hip', x: 0, y: 40 }, { ...b, parent: 'chest_ctl', y: 35 }] : [b]));
  const CHEST: Pt = [0, 75];
  const SHOULDERS = 65;
  const rot = (deg: number, v: Pt): Pt => [Math.cos(deg * RAD) * v[0] - Math.sin(deg * RAD) * v[1], Math.sin(deg * RAD) * v[0] + Math.cos(deg * RAD) * v[1]];
  /** The rig's mid-shoulder relative to its hip, world (y up), on frame i — what the pose is drawn from. */
  const shoulderOffset = (i: number): Pt => add(rot(tilt(i), CHEST), [SHOULDERS * Math.cos(chestAngle(i) * RAD), SHOULDERS * Math.sin(chestAngle(i) * RAD)]);

  const pelvisPose = (): Record<string, unknown> =>
    poseDoc(BASE, (i, j) => {
      const h = BASE.hip(i);
      const mid: Pt = [200 + h[0], 400 + h[1]];
      const d = dir(tilt(i), 15);
      const o = shoulderOffset(i);
      const msh: Pt = [mid[0] + o[0] / SCALE, mid[1] - o[1] / SCALE];
      const set = (name: string, at: Pt) => (j[name] = { state: 'observed', at, score: 0.9 });
      const shift = (names: string[], from: Pt, to: Pt) => {
        for (const n of names) {
          const a = j[n]!.at as Pt;
          set(n, [a[0] + to[0] - from[0], a[1] + to[1] - from[1]]);
        }
      };
      // Each limb moves with its root, so every segment keeps the card's angle.
      shift(['r_knee', 'r_ankle'], j.r_hip!.at as Pt, add(mid, [-d[0], -d[1]]));
      shift(['l_knee', 'l_ankle'], j.l_hip!.at as Pt, add(mid, d));
      shift(['r_elbow', 'r_wrist'], j.r_shoulder!.at as Pt, add(msh, [-20, 0]));
      shift(['l_elbow', 'l_wrist'], j.l_shoulder!.at as Pt, add(msh, [20, 0]));
      set('r_hip', add(mid, [-d[0], -d[1]]));
      set('l_hip', add(mid, d));
      set('r_shoulder', add(msh, [-20, 0]));
      set('l_shoulder', add(msh, [20, 0]));
      // The scale's pose length stays 100 px, so the figure scale is exactly 1.5.
      set('neck', add(mid, [0, -POSE_TRUNK]));
    });
  const pelvisMap = (reach: boolean): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      { name: 'trunk', bones: ['chest'], joints: ['mid_hip', 'mid_shoulder'], aim: ['sleeve_r0+sleeve_l0'], ...(reach ? { reach: true } : {}) },
      ...baseChains().filter((c) => c.name !== 'trunk'),
    ],
  });

  /**
   * Read back by rig-c's poser, independently: the hip line's angle against
   * tilt(i), and the rig's mid-shoulder against where the pose puts it — the
   * hip's setup origin, plus its scaled travel, plus the pose's mid_hip →
   * mid_shoulder scaled. Tolerances: 0.01° and 0.01 units. A rotate key is
   * rounded to 0.001° (≤ 0.0005° each on the hip and the chest; levers of 140
   * and 65 units: ≤ 0.0018 units), a translate key to 0.001 (≤ 0.0007 units),
   * and rig-c stores float32 (≈ 3e-5 at 400 units): 0.01 is above three times
   * their sum.
   */
  function pelvisMisses(build: string): string[] {
    const doc = loadBuild(build);
    const setupHip = byName(poseRawSetup(doc).bones).get('hip')!;
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: BASE.n - 1 }, () => BASE.dt));
    const out: string[] = [];
    poses.forEach((p, i) => {
      const b = byName(p.bones);
      const lr = b.get('leg_r0')!;
      const ll = b.get('leg_l0')!;
      const line = Math.atan2(ll.worldY - lr.worldY, ll.worldX - lr.worldX) * DEG;
      if (Math.abs(wrap(line - tilt(i))) > ANGLE_TOL) out.push(`frame ${i}: hip line ${line.toFixed(4)}° want ${tilt(i).toFixed(4)}°`);
      const sr = b.get('sleeve_r0')!;
      const sl = b.get('sleeve_l0')!;
      const got: Pt = [(sr.worldX + sl.worldX) / 2, (sr.worldY + sl.worldY) / 2];
      const h = BASE.hip(i);
      const o = shoulderOffset(i);
      const want: Pt = [setupHip.worldX + h[0] * SCALE + o[0], setupHip.worldY - h[1] * SCALE + o[1]];
      const e = Math.hypot(got[0] - want[0], got[1] - want[1]);
      if (!(e <= ORIGIN_TOL)) out.push(`frame ${i}: mid-shoulder (${got[0].toFixed(3)}, ${got[1].toFixed(3)}) want (${want[0].toFixed(3)}, ${want[1].toFixed(3)}) (|e| ${e.toFixed(4)})`);
    });
    return out;
  }

  test('the hip line tilts with the pose and the rig\'s mid-shoulder lands on the pose\'s', () => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LAND').some((l) => l.startsWith('LAND   bone "chest" aim'))).toBe(true);
    expect(pelvisMisses(c.build)).toEqual([]);
  }, SLOW);

  test('control: the same trunk without "reach" points along the pose\'s segment, and its shoulders miss', () => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(false), pose: pelvisPose() });
    const r = retarget(c);
    expect(r.status).toBe(0);
    const m = pelvisMisses(c.build);
    expect(m.some((l) => l.includes('hip line'))).toBe(false);
    const worst = Math.max(...m.map((l) => Number(/\|e\| ([\d.]+)/.exec(l)?.[1] ?? 0)));
    expect(worst).toBeGreaterThan(1);
  }, SLOW);

  test('mutant: the reach\'s posed origin ignores the hip\'s turn, and the shoulders miss', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const r = turnAbove(parent, i) / DEG;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const r = 0;'));
      const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
      const r = retarget(c, [], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      expect(pelvisMisses(c.build).some((l) => l.includes('mid-shoulder'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('POSTURE lines and the report\'s posture: the rig\'s tilt and sway beside the reference\'s', () => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    const lines = linesOf(r, 'POSTURE');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('POSTURE hip tilt range (chain "pelvis", r_hip → l_hip, Spine degrees): reference ');
    expect(lines[1]).toContain('mid_hip = "hip", mid_shoulder = "sleeve_r0+sleeve_l0"');
    const q = (JSON.parse(readFileSync(report, 'utf8')) as { posture: { tilt: { reference: { range: number }; ratio: number }; sway: { ratio: number } } }).posture;
    const tilts = Array.from({ length: BASE.n }, (_, i) => tilt(i));
    expect(q.tilt!.reference.range).toBeCloseTo(Math.max(...tilts) - Math.min(...tilts), 6);
    expect(q.tilt!.ratio).toBeCloseTo(1, 3);
    // The rig's shoulders land on the pose's (above), so its sway is the reference's.
    expect(q.sway.ratio).toBeCloseTo(1, 3);
  }, SLOW);

  /**
   * #63: the same pelvis pose, cleaned by clean() with and without
   * `hipsInferred` (windows of 1, as the fixture's), written by the writer,
   * retargeted in the same directory so every path in the output is the same.
   */
  const inferredRuns = (edit?: (doc: Record<string, unknown>) => void) => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    const doc = pelvisPose();
    edit?.(doc);
    const run = (hipsInferred: boolean) => {
      const seq = clean(readPoseSequence(JSON.stringify(doc), 'fixture'), { loop: false, legs: 1, rest: 1, hipsInferred }, undefined, 'fixture').seq;
      const poseBytes = writePoseSequence(seq);
      writeFileSync(c.pose, poseBytes);
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      return { r, motion: readFileSync(c.out, 'utf8'), report: JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>, poseSHA: createHash('sha256').update(poseBytes).digest('hex') };
    };
    return { plain: run(false), flagged: run(true) };
  };

  test('#63 bar: with clean --hips-inferred, POSTURE reads no tilt and names why; the keys and every other line are the same as without it', () => {
    const { plain, flagged } = inferredRuns();
    expect(flagged.r.stderr).toBe('');
    expect(flagged.r.status).toBe(0);
    const lp = linesOf(plain.r, 'POSTURE');
    const lf = linesOf(flagged.r, 'POSTURE');
    expect(lp[0]).toStartWith('POSTURE hip tilt range (chain "pelvis", r_hip → l_hip, Spine degrees): reference ');
    expect(lf).toEqual(['POSTURE hip tilt not read: hips inferred (declared at clean)', lp[1]!]);
    expect(linesOf(flagged.r, 'CLEAN')).toEqual([`${linesOf(plain.r, 'CLEAN')[0]!}; hips inferred (declared at clean)`]);
    // Every other stdout line is the same, and the motion is byte-identical.
    const others = (r: Ran) => r.stdout.split('\n').filter((l) => !/^\s*(POSTURE hip tilt|CLEAN )/.test(l));
    expect(others(flagged.r)).toEqual(others(plain.r));
    expect(flagged.motion).toBe(plain.motion);
    // The report: the posture says tilt null and why; the clean record says who declared it; nothing else moves.
    const qp = plain.report.posture as Record<string, unknown>;
    const qf = flagged.report.posture as Record<string, unknown>;
    expect(Object.keys(qp)).toEqual(['pelvis', 'rigHip', 'rigShoulder', 'frames', 'tilt', 'sway']);
    expect(qf.tilt).toBeNull();
    expect(qf.tiltWhy).toBe('hips inferred (declared at clean)');
    expect(qf.hipsInferred).toEqual({ frames: BASE.n, source: 'declared at clean' });
    expect(qf.frames).toEqual({ ...(qp.frames as object), tilt: 0 });
    expect(qf.sway).toEqual(qp.sway);
    expect((flagged.report.cleaned as { params: unknown }).params).toEqual({ loop: false, legs: 1, rest: 1, hipsInferred: { by: 'declared' } });
    // Different cleaned input bytes must have different provenance, even when motion agrees.
    for (const run of [plain, flagged]) {
      const inputs = run.report.inputs as { pose: { sha256: string } };
      expect(inputs.pose.sha256).toBe(run.poseSHA);
    }
    const rest = (rep: Record<string, unknown>) => {
      const inputs = rep.inputs as { pose: Record<string, unknown> };
      return { ...rep, posture: null, cleaned: null, inputs: { ...inputs, pose: { ...inputs.pose, sha256: null } } };
    };
    expect(rest(flagged.report)).toEqual(rest(plain.report));
  }, SLOW);

  test('#63: hips inferred on some frames only — the tilt is read over the others and the line counts those left out', () => {
    const k = 5;
    const { plain } = inferredRuns((doc) => {
      (doc.frames as Array<{ people: Array<{ joints: Record<string, { state: string }> }> }>).forEach((f, i) => {
        if (i < k) f.people[0]!.joints.r_hip!.state = 'inferred';
      });
    });
    expect(plain.r.status).toBe(0);
    const l = linesOf(plain.r, 'POSTURE')[0]!;
    expect(l).toStartWith('POSTURE hip tilt range (chain "pelvis", r_hip → l_hip, Spine degrees): reference ');
    expect(l).toContain(` over ${BASE.n - k} of ${BASE.n} frames)`);
    expect(l).toEndWith(`; ${k} frame(s) with an inferred hip not read (source not stated)`);
    const q = plain.report.posture as { tilt: { reference: { range: number } }; hipsInferred: unknown; frames: { tilt: number } };
    const tilts = Array.from({ length: BASE.n - k }, (_, i) => tilt(i + k));
    // The writer rounds each hip to 0.01 px on a 30 px hip line: ≤ 0.027° an angle, ≤ 0.054° a range.
    expect(Math.abs(q.tilt.reference.range - (Math.max(...tilts) - Math.min(...tilts)))).toBeLessThan(0.054);
    expect(q.hipsInferred).toEqual({ frames: k, source: 'source not stated' });
    expect(q.frames.tilt).toBe(BASE.n - k);
  }, SLOW);

  /**
   * #86: the pelvis pose cleaned with `hipsInferred` (every hip inferred), its
   * record replaced by a `measured` one with the given classes. The positions
   * are the plain run's, so the keys are too; only the reading changes.
   */
  type Runs = Array<[number, number]>;
  const measuredRun = (classes: { read: Runs; interpolated: Runs; held: Runs; scaled?: Runs; unmeasured?: Runs; fit?: { frames: number; gain: number | null; corr: number | null } }) => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    const seq = clean(readPoseSequence(JSON.stringify(pelvisPose()), 'fixture'), { loop: false, legs: 1, rest: 1, hipsInferred: true }, undefined, 'fixture').seq;
    const doc = JSON.parse(writePoseSequence(seq)) as { cleaned: { params: Record<string, unknown> } };
    const declined = [...classes.interpolated, ...(classes.scaled ?? []), ...classes.held, ...(classes.unmeasured ?? [])].sort((x, y) => x[0] - y[0]).map((frames) => ({ frames, why: 'covered' }));
    doc.cleaned.params.hipsInferred = { by: 'measured', method: 'test method', ...classes, declined };
    writeFileSync(c.pose, JSON.stringify(doc));
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    return { r, motion: readFileSync(c.out, 'utf8'), report: JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown> };
  };
  type Measured = { tilt: { reference: { range: number } }; hipsInferred?: unknown; tiltMeasured: unknown; frames: { tilt: number } };
  const N = BASE.n;
  const allTilts = () => Array.from({ length: N }, (_, i) => tilt(i));
  const rangeOf = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

  test('#86 read: every frame read — the tilt is the plain run\'s, the line says so, and the keys are the same', () => {
    const { plain } = inferredRuns();
    const m = measuredRun({ read: [[0, N - 1]], interpolated: [], held: [] });
    expect(m.r.stderr).toBe('');
    expect(m.r.status).toBe(0);
    const l = linesOf(m.r, 'POSTURE')[0]!;
    expect(l).toStartWith('POSTURE hip tilt range (chain "pelvis", r_hip → l_hip, Spine degrees): reference ');
    expect(l).toEndWith(`; tilt measured (test method) on ${N} frame(s): ${N} read, 0 interpolated, 0 held (held: none)`);
    expect(linesOf(m.r, 'CLEAN')[0]).toEndWith('; hips inferred (measured by test method)');
    const q = m.report.posture as Measured;
    expect(q.tilt).toEqual((plain.report.posture as { tilt: unknown }).tilt as never);
    expect(q.hipsInferred).toBeUndefined();
    expect(q.tiltMeasured).toEqual({ method: 'test method', frames: N, read: N, interpolated: 0, held: 0, heldSpans: [] });
    expect(m.motion).toBe(plain.motion);
  }, SLOW);

  test('#86 interpolated: the interpolated frames are read into the tilt and counted', () => {
    const m = measuredRun({ read: [[0, 1], [5, N - 1]], interpolated: [[2, 4]], held: [] });
    expect(m.r.status).toBe(0);
    expect(linesOf(m.r, 'POSTURE')[0]).toEndWith(`; tilt measured (test method) on ${N} frame(s): ${N - 3} read, 3 interpolated, 0 held (held: none)`);
    const q = m.report.posture as Measured;
    expect(Math.abs(q.tilt.reference.range - rangeOf(allTilts()))).toBeLessThan(0.054);
    expect(q.frames.tilt).toBe(N);
  }, SLOW);

  test('#86 held: the held frames are read into the tilt, counted, and their spans printed; a reading that left them out would differ', () => {
    const k = 5;
    const m = measuredRun({ read: [[k, N - 2]], interpolated: [], held: [[0, k - 1], [N - 1, N - 1]] });
    expect(m.r.status).toBe(0);
    expect(linesOf(m.r, 'POSTURE')[0]).toEndWith(`; tilt measured (test method) on ${N} frame(s): ${N - k - 1} read, 0 interpolated, ${k + 1} held (held: 0–${k - 1}, ${N - 1})`);
    const q = m.report.posture as Measured;
    expect(q.tiltMeasured).toEqual({ method: 'test method', frames: N, read: N - k - 1, interpolated: 0, held: k + 1, heldSpans: [[0, k - 1], [N - 1, N - 1]] });
    // Over every frame, as read; the read frames alone give another range, so the held ones are in it.
    expect(Math.abs(q.tilt.reference.range - rangeOf(allTilts()))).toBeLessThan(0.054);
    expect(Math.abs(rangeOf(allTilts().slice(k, N - 1)) - rangeOf(allTilts()))).toBeGreaterThan(0.2);
  }, SLOW);

  test('#106 scaled and unmeasured: scaled frames are read into the tilt and named; unmeasured frames are left out, refused nowhere, and named on the line', () => {
    const k = 5;
    const sc = measuredRun({
      read: [[k, N - 2]],
      interpolated: [],
      scaled: [[0, k - 1], [N - 1, N - 1]],
      held: [],
      unmeasured: [],
      fit: { frames: N - k - 1, gain: 2.73, corr: 0.938 },
    });
    expect(sc.r.status).toBe(0);
    expect(linesOf(sc.r, 'POSTURE')[0]).toEndWith(`; tilt measured (test method) on ${N} frame(s): ${N - k - 1} read, 0 interpolated, ${k + 1} scaled (scaled: 0–${k - 1}, ${N - 1}, gain 2.73×, r=0.938), 0 held (held: none)`);
    expect(linesOf(sc.r, 'CLEAN')[0]).toEndWith(`; hips inferred (measured by test method, scaled 0–${k - 1}, ${N - 1} (gain 2.73×, r=0.938))`);
    const qSc = sc.report.posture as Measured;
    expect(qSc.frames.tilt).toBe(N);
    expect(Math.abs(qSc.tilt.reference.range - rangeOf(allTilts()))).toBeLessThan(0.054);

    const unm = measuredRun({
      read: [[k, N - 2]],
      interpolated: [],
      scaled: [],
      held: [],
      unmeasured: [[0, k - 1], [N - 1, N - 1]],
      fit: { frames: N - k - 1, gain: 0.04, corr: 0.078 },
    });
    expect(unm.r.status).toBe(0);
    expect(linesOf(unm.r, 'POSTURE')[0]).toEndWith(`; tilt measured (test method) on ${N - k - 1} frame(s): ${N - k - 1} read, 0 interpolated, 0 held (held: none); ${k + 1} unmeasured (0–${k - 1}, ${N - 1}, r=0.078 < 0.9)`);
    expect(linesOf(unm.r, 'CLEAN')[0]).toEndWith(`; hips inferred (measured by test method, unmeasured 0–${k - 1}, ${N - 1} (r=0.078 < 0.9))`);
    const qUnm = unm.report.posture as Measured;
    expect(qUnm.frames.tilt).toBe(N - k - 1);
    expect(Math.abs(qUnm.tilt.reference.range - rangeOf(allTilts().slice(k, N - 1)))).toBeLessThan(0.054);
  }, SLOW);

  test('control: a map without a pelvis chain prints no POSTURE line', () => {
    const c = setup();
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'POSTURE')).toEqual([]);
  }, SLOW);

  const reachCases: Array<{ what: string; map: () => Record<string, unknown>; want: string }> = [
    {
      what: 'on a chain of two bones',
      map: () => ({ ...pelvisMap(false), chains: [...baseChains().filter((c) => c.name !== 'arm_r'), { name: 'arm_r', bones: ['sleeve_r0', 'sleeve_r1'], joints: ['r_shoulder', 'r_elbow', 'r_wrist'], reach: true }] }),
      want: 'FAIL  MAP_REACH: chain "arm_r" has "reach" and 2 bones; a reach turns one bone from its posed origin, so the chain must have exactly one',
    },
    {
      what: 'from a joint other than the translated one',
      map: () => ({ ...baseMap(), chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, joints: ['neck', 'nose'], aim: ['neck'], reach: true } : c)) }),
      want: 'FAIL  MAP_REACH: chain "trunk" has "reach" and starts at joint "neck"; the reach is measured from the translated joint, so its first joint must be "mid_hip"',
    },
    {
      what: 'with no translate',
      map: () => ({ spec: 'rig-pose-map/1', chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, reach: true } : c)) }),
      want: 'FAIL  MAP_REACH: chain "trunk" has "reach" and the map has no "translate"; a reach is anchored at the translated bone\'s posed origin',
    },
    {
      what: 'with an aim that is not one point',
      map: () => ({ ...baseMap(), chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, aim: ['x'], reach: true } : c)) }),
      want: 'FAIL  MAP_REACH: chain "trunk" has "reach" and aims "x"; a reach aims from the bone\'s own origin at one point, so "aim" must name it (a bone, name:tip or a+b)',
    },
    {
      what: 'on a bone that does not ride the translated bone',
      map: () => ({ ...baseMap(), translate: { bone: 'leg_r0', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['hip', 'neck'] } }, chains: baseChains().filter((c) => c.name !== 'leg_r').map((c) => (c.name === 'trunk' ? { ...c, reach: true } : c)) }),
      want: 'FAIL  MAP_REACH: chain "trunk" — bone "chest" reaches from its posed origin, but it does not descend from the translated bone "leg_r0"; its origin would not travel with the anchor',
    },
  ];
  for (const rc of reachCases) {
    test(`MAP_REACH: refused ${rc.what}`, () => {
      const c = setup({ map: rc.map() });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toContain(rc.want);
      expect(existsSync(c.out)).toBe(false);
    }, SLOW);
  }
});

// --- the kept build is the same bytes wherever it is made (#18) ---------------

describe('--build writes the same bytes in any folder, and no path out of it', () => {
  test('two identical runs in two folders at different depths: byte-identical build, motion and report', () => {
    const root = tempDir();
    const runIn = (dir: string): string => {
      mkdirSync(dir, { recursive: true });
      writeRig(dir);
      writeFileSync(join(dir, 'map.json'), JSON.stringify(baseMap(), null, 2));
      writeFileSync(join(dir, 'pose.json'), JSON.stringify(cleanedDoc(poseDoc(BASE)), null, 2));
      const r = spawnSync(process.execPath, [CLI, 'retarget', '--rig', 'rig', '--map', 'map.json', '--pose', 'pose.json', '--out', 'motion.json', '--build', 'build', '--report', 'report.json'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      return dir;
    };
    const a = runIn(join(root, 'a'));
    const b = runIn(join(root, 'deep', 'er', 'b'));
    for (const f of ['build/skeleton.model.json', 'build/skeleton.json', 'build/skeleton.atlas', 'motion.json', 'report.json']) {
      expect(readFileSync(join(b, f)).equals(readFileSync(join(a, f)))).toBe(true);
    }
    const model = readFileSync(join(a, 'build', 'skeleton.model.json'), 'utf8');
    expect(model).not.toContain(root);
    expect(model).not.toContain(tmpdir());
    const pages = (JSON.parse(model) as { images: Array<{ page: string }> }).images.map((i) => i.page);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p.startsWith('../rig/images/')).toBe(true);
  }, SLOW);
});

// --- the example runs ------------------------------------------------------------

describe('examples/wave runs as the README says', () => {
  test('a bones-only rig, a 3 s wave and its map: green, every bone lands, written', () => {
    const out = join(tempDir(), 'wave.motion.json');
    const r = cli(['retarget', '--rig', 'examples/wave/rig', '--map', 'examples/wave/map.json', '--pose', 'examples/wave/pose.json', '--out', out]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LAND')).toHaveLength(11);
    expect(linesOf(r, 'FOLD')).toEqual(['FOLD   the rig has no slots, so it draws nothing to fold; not measured']);
    expect(existsSync(out)).toBe(true);
  }, SLOW);
});

describe('--short leaves a line across the body alone (the hip line, the eye line)', () => {
  test('isAcross: a left joint and its right twin, either way round, and nothing else', () => {
    expect(isAcross('r_hip', 'l_hip')).toBe(true);
    expect(isAcross('l_eye', 'r_eye')).toBe(true);
    expect(isAcross('r_hip', 'r_knee')).toBe(false);
    expect(isAcross('mid_hip', 'neck')).toBe(false);
  });
});

// --- skeleton.json's `images` resolves to the parts (#25) ---------------------------

describe('the kept skeleton.json names an images directory that holds the parts', () => {
  const imagesOf = (build: string): string => {
    const doc = JSON.parse(readFileSync(join(build, 'skeleton.json'), 'utf8')) as { skeleton: { images?: string } };
    expect(typeof doc.skeleton.images).toBe('string');
    return join(build, doc.skeleton.images!);
  };
  for (const name of ['build', 'wave-build', 'out/nested/wave', 'trailing/']) {
    test(`--build ${name}: skeleton.images, read from skeleton.json's own folder, is a folder holding every part image`, () => {
      const dir = tempDir();
      writeRig(dir);
      writeFileSync(join(dir, 'map.json'), JSON.stringify(baseMap(), null, 2));
      writeFileSync(join(dir, 'pose.json'), JSON.stringify(cleanedDoc(poseDoc(BASE)), null, 2));
      const r = spawnSync(process.execPath, [CLI, 'retarget', '--rig', 'rig', '--map', 'map.json', '--pose', 'pose.json', '--out', 'motion.json', '--build', name], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      const images = imagesOf(join(dir, name));
      expect(existsSync(images)).toBe(true);
      expect(existsSync(join(images, 'seg.png'))).toBe(true);
    }, SLOW);
  }
});

// --- alternate sets, ranges and turns (#6) ------------------------------------------

describe('alternates (#6): sets of attachments switched beside the bone keys', () => {
  /** The right arm away from its key skeleton except on frames `on`, where it is exactly it. */
  const KEY_RU = 150;
  const KEY_RF = 170;
  /**
   * Since #67 the trunk stands still here (the hip in place, the chest upright): with BASE's travel the
   * shoulder moves up to 9 px a frame, and on the first frame of a held pose the per-coordinate 5-frame
   * median mixes two frames' coordinates far enough (> 0.2 trunk) for clean to take it as a spike.
   */
  const armed = (on: (i: number) => boolean): Motion => ({ ...BASE, trunk: () => 90, hip: () => [0, 0], ru: (i) => (on(i) ? KEY_RU : 30), rf: (i) => (on(i) ? KEY_RF : 50) });
  /** A key skeleton of the right arm at another scale and place than the pose's. */
  const keySkeleton = (ru = KEY_RU, rf = KEY_RF): Record<string, Pt> => {
    const sh: Pt = [1000, 1000];
    const el = add(sh, dir(ru, 300));
    return { r_shoulder: sh, r_elbow: el, r_wrist: add(el, dir(rf, 250)) };
  };
  /** The rig's alternates: the upper arm drawn raised and drawn out, and a shoulder cap only the raised set shows (an extra slot, empty at setup). */
  const ALT_RIG: RigOpts = {
    extra: {
      sleeve_r0: { seg_up: { image: 'seg.png', x: 30, y: 0, rotation: -90 }, seg_out: { image: 'seg.png', x: 30, y: 0, rotation: 0 } },
      cap_r: { cap_up: { image: 'seg.png', x: 0, y: 0, rotation: 0 } },
    },
    extraSlots: [{ name: 'cap_r', bone: 'sleeve_r0', attachment: null }],
  };
  const up = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'up', slots: { sleeve_r0: 'seg_up', cap_r: 'cap_up' }, hides: ['sleeve_r1'], chains: ['arm_r'], pose: keySkeleton(), ...o });
  const out = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'out', slots: { sleeve_r0: 'seg_out' }, chains: ['arm_r'], pose: keySkeleton(60, 80), ...o });
  const altMap = (...sets: Array<Record<string, unknown>>): Record<string, unknown> => ({ ...baseMap(), alternates: sets });
  type SlotTrackOut = { slot: string; property: string; keys: Array<{ t: number; v: string | null }> };
  const slotTracks = (path: string): SlotTrackOut[] => (motionOf(path).animations.dance!.tracks as unknown as SlotTrackOut[]).filter((t) => 'slot' in t);
  /** What rig-c's own poser shows in a slot on every frame of the gated build. */
  const shows = (build: string, slot: string, n = BASE.n, dt = BASE.dt): Array<string | null> =>
    poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: n - 1 }, () => dt)).map((p) => p.slots.find((row) => row[0] === slot)![1]);
  const each = <T>(f: (i: number) => T, n = BASE.n): T[] => Array.from({ length: n }, (_, i) => f(i));
  interface ReportOut {
    options: Record<string, unknown>;
    switches: Array<Record<string, unknown>>;
    uncovered: Array<{ slot: string; attachment: string; chains: string[]; times: number[] }> | null;
    turns: Array<Record<string, unknown>>;
    range: Array<Record<string, unknown>>;
    artRange: Array<Record<string, unknown>>;
    endOn: unknown[];
  }
  const reportOf = (path: string): ReportOut => JSON.parse(readFileSync(path, 'utf8')) as ReportOut;

  test('a set shows on the span where the pose is its key skeleton: every slot of it, keyed, gated and read back by rig-c\'s poser', () => {
    const on = (i: number) => i >= 5 && i <= 10;
    const c = setup({ rig: ALT_RIG, map: altMap(up(), out()), pose: poseDoc(armed(on)) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')).toEqual([
      'SWITCH set "up" — shows "sleeve_r0" = "seg_up", "cap_r" = "cap_up", hides "sleeve_r1"; chains arm_r; frames 5–10 (t=0.625s until 1.375s) — distance max 0.0°, median 0.0°; moved on frame 5 stays (60.0°/frame; window frames 4–6), off frame 11 stays (60.0°/frame; window frames 10–12)',
    ]);
    // Keyed half a frame before the frame each change shows on; back to the setup attachment the model states (nothing, for the cap).
    expect(slotTracks(c.out)).toEqual([
      { slot: 'sleeve_r0', property: 'attachment', keys: [{ t: 0.5625, v: 'seg_up' }, { t: 1.3125, v: 'seg' }] },
      { slot: 'cap_r', property: 'attachment', keys: [{ t: 0.5625, v: 'cap_up' }, { t: 1.3125, v: null }] },
      { slot: 'sleeve_r1', property: 'attachment', keys: [{ t: 0.5625, v: null }, { t: 1.3125, v: 'seg' }] },
    ]);
    const rep = reportOf(report);
    expect(rep.options.switchTolerance).toBe(25);
    expect(rep.options.switchMin).toBe(0.25);
    expect(rep.options.switchAt).toBe('first');
    // `first` is the default (#31 round 2): each boundary is reported where the selection put it, with its window and its speed.
    const stay = (f: number) => ({ frame: [f, f], frames: 0, seconds: 0, window: [f - 1, f + 1], speed: { old: 60, new: 60 } });
    expect(legacyReportRows(rep.switches, ['times'])).toEqual([{ set: 'up', chains: ['arm_r'], slots: { sleeve_r0: 'seg_up', cap_r: 'cap_up' }, hides: ['sleeve_r1'], offsets: {}, from: 0.625, to: 1.375, frames: [5, 10], distance: { max: 0, median: 0 }, artTurn: {}, moved: { on: stay(5), off: stay(11) } }]);
    // The bones still land: a switch adds tracks, it moves no key.
    expect(misses(c.build, armed(on))).toEqual([]);
    expect(shows(c.build, 'sleeve_r0')).toEqual(each((i) => (on(i) ? 'seg_up' : 'seg')));
    expect(shows(c.build, 'cap_r')).toEqual(each((i) => (on(i) ? 'cap_up' : null)));
    expect(shows(c.build, 'sleeve_r1')).toEqual(each((i) => (on(i) ? null : 'seg')));
    // The written motion builds green on its own.
    const b = spawnSync(process.execPath, [RIGC, 'build', '--rig', join(c.rig, 'rig.json'), '--motion', c.out, '--out', join(c.dir, 'rebuild')], { encoding: 'utf8' });
    expect(b.status).toBe(0);
  }, SLOW);

  test('control: a pose never within the tolerance switches nothing and adds no track', () => {
    const c = setup({ rig: ALT_RIG, map: altMap(up(), out()), pose: poseDoc(armed(() => false)) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')).toEqual(['SWITCH none — no set within 25° of the pose for 0.25s']);
    expect(slotTracks(c.out)).toEqual([]);
  }, SLOW);

  test('set → set directly: the second set\'s frame puts the first set\'s slots back to setup (its extra slot empty)', () => {
    const pose = poseDoc({ ...BASE, ru: (i) => (i <= 7 ? KEY_RU : 60), rf: (i) => (i <= 7 ? KEY_RF : 80) });
    const c = setup({ rig: ALT_RIG, map: altMap(up(), out()), pose });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH').map((l) => l.split(' — ')[0])).toEqual(['SWITCH set "up"', 'SWITCH set "out"']);
    expect(slotTracks(c.out)).toEqual([
      { slot: 'sleeve_r0', property: 'attachment', keys: [{ t: 0, v: 'seg_up' }, { t: 0.9375, v: 'seg_out' }] },
      { slot: 'cap_r', property: 'attachment', keys: [{ t: 0, v: 'cap_up' }, { t: 0.9375, v: null }] },
      { slot: 'sleeve_r1', property: 'attachment', keys: [{ t: 0, v: null }, { t: 0.9375, v: 'seg' }] },
    ]);
    expect(shows(c.build, 'sleeve_r0')).toEqual(each((i) => (i <= 7 ? 'seg_up' : 'seg_out')));
    expect(shows(c.build, 'cap_r')).toEqual(each((i) => (i <= 7 ? 'cap_up' : null)));
    expect(shows(c.build, 'sleeve_r1')).toEqual(each((i) => (i <= 7 ? null : 'seg')));
  }, SLOW);

  // Since #67 every run and gap here is ≥ 3 frames: clean's 5-frame median takes a 1- or 2-frame pose out as a spike,
  // so the minimum is raised to 0.5 s (4 frames) to keep a run, and a gap, shorter than it.
  test('a run shorter than --switch-min is dropped (the base art shows there); control: under a smaller one it stays', () => {
    const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(armed((i) => (i >= 2 && i <= 4) || (i >= 9 && i <= 12))) });
    const r = retarget(c, ['--switch-min', '0.5']);
    expect(r.status).toBe(0);
    // Frames 2–4 are 0.375 s; frames 9–12 are 0.5 s, which is the minimum and stays (the gap, 0.5 s, is not bridged).
    expect(linesOf(r, 'SWITCH').map((l) => /frames? [\d–]+/.exec(l)![0])).toEqual(['frames 9–12']);
    expect(slotTracks(c.out)[0]!.keys).toEqual([{ t: 1.0625, v: 'seg_up' }, { t: 1.5625, v: 'seg' }]);
    const r2 = retarget(c, ['--switch-min', '0.25']);
    expect(r2.status).toBe(0);
    expect(linesOf(r2, 'SWITCH').map((l) => /frames? [\d–]+/.exec(l)![0])).toEqual(['frames 2–4', 'frames 9–12']);
  }, SLOW);

  test('a gap shorter than --switch-min between two runs of one set is bridged (no flash of the base art); control: a gap as long as it is not', () => {
    const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(armed((i) => (i >= 2 && i <= 5) || (i >= 9 && i <= 12))) });
    const r = retarget(c, ['--switch-min', '0.5']);
    expect(r.status).toBe(0);
    // Frames 6–8 are 0.375 s off the key skeleton: bridged, one span 2–12.
    expect(linesOf(r, 'SWITCH').map((l) => /frames? [\d–]+/.exec(l)![0])).toEqual(['frames 2–12']);
    expect(shows(c.build, 'sleeve_r0')).toEqual(each((i) => (i >= 2 && i <= 12 ? 'seg_up' : 'seg')));
    const c2 = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(armed((i) => (i >= 2 && i <= 5) || (i >= 10 && i <= 13))) });
    const r2 = retarget(c2, ['--switch-min', '0.5']);
    expect(r2.status).toBe(0);
    // Frames 6–9 are 0.5 s, the minimum itself: two spans.
    expect(linesOf(r2, 'SWITCH').map((l) => /frames? [\d–]+/.exec(l)![0])).toEqual(['frames 2–5', 'frames 10–13']);
  }, SLOW);

  test('frames (a stopgap): a set shows only inside its window, and there it is chosen over an equal set without one', () => {
    const on = (i: number) => i >= 2 && i <= 12;
    const twin = (o: Record<string, unknown> = {}) => ({ ...up(), name: 'twin', slots: { sleeve_r0: 'seg_out' }, ...o });
    const c = setup({ rig: ALT_RIG, map: altMap(up(), twin({ frames: [[4, 5], [6, 7]] })), pose: poseDoc(armed(on)) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    // Both sets match frames 2–12 exactly: "twin" takes its window 4–7, "up" the rest.
    expect(linesOf(r, 'SWITCH').map((l) => /set "(\w+)".*?frames? ([\d–]+)/.exec(l)!.slice(1).join(' '))).toEqual(['up 2–3', 'twin 4–7', 'up 8–12']);
    expect(shows(c.build, 'sleeve_r0')).toEqual(each((i) => (i >= 4 && i <= 7 ? 'seg_out' : on(i) ? 'seg_up' : 'seg')));
    const bad = setup({ rig: ALT_RIG, map: altMap(up(), twin({ frames: [[7, 4]] })), pose: poseDoc(armed(on)) });
    const rb = retarget(bad);
    expect(rb.status).toBe(1);
    expect(fails(rb).some((l) => l.includes('MAP_ALT_FRAMES'))).toBe(true);
  }, SLOW);

  test('FRAMES: a window that does not switch says why, frame by frame (#43)', () => {
    const on = (i: number) => i >= 6 && i <= 9;
    const c = setup({ rig: ALT_RIG, map: altMap(up({ frames: [[3, 12]] })), pose: poseDoc(armed(on)) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    const l = linesOf(r, 'FRAMES');
    expect(l).toHaveLength(1);
    expect(l[0]).toContain('set "up" window 3–12: frames 3–5 outside the tolerance');
    expect(l[0]).toContain('frames 10–12 outside the tolerance');
    expect(l[0]).toContain('a window restricts a set, it never forces one');
  }, SLOW);

  test('offsets: a stepped translate on the bone, the offset over the span and 0 outside, read back by rig-c\'s poser', () => {
    const on = (i: number) => i >= 5 && i <= 10;
    const c = setup({ rig: ALT_RIG, map: altMap(up({ offsets: { sleeve_r1: [3, -2] } })), pose: poseDoc(armed(on)) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')[0]).toContain('; offsets "sleeve_r1" (3, -2); moved on ');
    const tracks = motionOf(c.out).animations.dance!.tracks as unknown as Array<{ bone?: string; slot?: string; property: string; keys: unknown[] }>;
    expect(tracks.map((t) => `${t.bone ?? t.slot}.${t.property}`).slice(-5)).toEqual(['hip.translate', 'sleeve_r1.translate', 'sleeve_r0.attachment', 'cap_r.attachment', 'sleeve_r1.attachment']);
    expect(tracks.find((t) => t.bone === 'sleeve_r1' && t.property === 'translate')!.keys).toEqual([
      { t: 0, v: [0, 0], ease: 'stepped' },
      { t: 0.5625, v: [3, -2], ease: 'stepped' },
      { t: 1.3125, v: [0, 0] },
    ]);
    // The forearm's origin in its parent's axes: setup (70, 0), plus the offset over the span — on every frame and halfway between.
    const doc = loadBuild(c.build);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: 2 * (BASE.n - 1) }, () => BASE.dt / 2));
    const local = poses.map((p) => {
      const b = byName(p.bones);
      const pa = b.get('sleeve_r0')!;
      const ch = b.get('sleeve_r1')!;
      const dx = ch.worldX - pa.worldX;
      const dy = ch.worldY - pa.worldY;
      const det = pa.a * pa.d - pa.b * pa.c;
      return [Math.round(((pa.d * dx - pa.b * dy) / det) * 1000) / 1000 + 0, Math.round(((-pa.c * dx + pa.a * dy) / det) * 1000) / 1000 + 0];
    });
    expect(local).toEqual(Array.from({ length: 2 * BASE.n - 1 }, (_, k) => (k >= 9 && k <= 20 ? [73, -2] : [70, 0])));
    // An origin moved under an x aim turns nothing: every bone lands.
    expect(misses(c.build, armed(on))).toEqual([]);
    expect(reportOf(report).switches[0]!.offsets).toEqual({ sleeve_r1: [3, -2] });
  }, SLOW);

  describe('where a switch is keyed (#31): with --switch-at peak, each boundary at the fastest qualifying frame within ±switch-min/2', () => {
    /** 24 fps, 2 s: the right arm by its upper arm's world angle per frame, the forearm 20° past it (the key skeleton's elbow). */
    const N = 48;
    const DT = 1 / 24;
    const at24 = (ru: (i: number) => number): Motion => ({ ...BASE, n: N, dt: DT, ru, rf: (i) => ru(i) + 20 });
    interface MoveOut { frame: [number, number]; frames: number; seconds: number; window: [number, number]; speed: { old: number; new: number } }
    const movesOf = (path: string) => reportOf(path).switches.map((s) => ({ set: s.set as string, frames: s.frames as [number, number], moved: s.moved as { on: MoveOut | null; off: MoveOut | null } }));
    /** The run's times, rounded to the microsecond as the retarget reads them; a key half a frame before frame i; the seconds from frame a to b. */
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    const tOf = (i: number) => r6(i * DT);
    const keyAt = (i: number) => r6((tOf(i - 1) + tOf(i)) / 2);
    const secs = (a: number, b: number) => r6(tOf(b) - tOf(a));

    /**
     * The arm drifts onto the key skeleton at 1°/frame — within 25° from frame 12
     * (24.5° off), still slow there — then swings the last 23° in: the central
     * difference is 4.75°/frame on 13, 11.75 on 14, 7.5 on 15. It holds the key
     * pose to frame 30 and steps off to 100° on 31 (25°/frame on 30 and 31).
     */
    const DRIFT = at24((i) => (i <= 13 ? 113.5 + i : i === 14 ? 135 : i <= 30 ? 150 : 100));

    test('the pose reaches the key skeleton on a slow frame: the on-key moves to the speed peak 2 frames later, read back by rig-c\'s poser; the default (first) keeps it', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(DRIFT) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report, '--switch-at', 'peak']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(movesOf(report)).toEqual([{
        set: 'up',
        frames: [14, 30],
        moved: {
          on: { frame: [12, 14], frames: 2, seconds: secs(12, 14), window: [9, 15], speed: { old: 1, new: 11.75 } },
          // A tie on 30 and 31 (the step): the nearest, where it was.
          off: { frame: [31, 31], frames: 0, seconds: 0, window: [28, 34], speed: { old: 25, new: 25 } },
        },
      }]);
      expect(linesOf(r, 'SWITCH')[0]).toEndWith('; moved on frame 12 → 14 (+2 frames, +0.083s; 1.0°/frame → 11.8°/frame; window frames 9–15), off frame 31 stays (25.0°/frame; window frames 28–34)');
      // Keyed half a frame before the frame it now shows on.
      expect(slotTracks(c.out)[0]).toEqual({ slot: 'sleeve_r0', property: 'attachment', keys: [{ t: keyAt(14), v: 'seg_up' }, { t: keyAt(31), v: 'seg' }] });
      expect(shows(c.build, 'sleeve_r0', N, DT)).toEqual(each((i) => (i >= 14 && i <= 30 ? 'seg_up' : 'seg'), N));
      expect(misses(c.build, DRIFT)).toEqual([]);

      const first = join(c.dir, 'first.json');
      // The default keeps it.
      const f = retarget(c, ['--report', first]);
      expect(f.status).toBe(0);
      expect(reportOf(first).options.switchAt).toBe('first');
      expect(movesOf(first)).toEqual([{
        set: 'up',
        frames: [12, 30],
        moved: {
          on: { frame: [12, 12], frames: 0, seconds: 0, window: [9, 15], speed: { old: 1, new: 1 } },
          off: { frame: [31, 31], frames: 0, seconds: 0, window: [28, 34], speed: { old: 25, new: 25 } },
        },
      }]);
      expect(shows(c.build, 'sleeve_r0', N, DT)).toEqual(each((i) => (i >= 12 && i <= 30 ? 'seg_up' : 'seg'), N));
    }, SLOW);

    test('a window clipped by the minimum span: a span of exactly --switch-min cannot shrink to reach its peak; control: the same approach in a longer span moves', () => {
      // Within 25° from frame 10 at 1°/frame; the swing in peaks on 12 (11.75°/frame); the span ends where the arm steps off.
      const approach = (leave: number) => at24((i) => (i <= 11 ? 115.5 + i : i === 12 ? 140 : i < leave ? 150 : 100));
      const short = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(approach(16)) });
      const report = join(short.dir, 'report.json');
      expect(retarget(short, ['--report', report, '--switch-at', 'peak']).status).toBe(0);
      // Frames 10–15 are 0.25 s: the on-key may only move earlier (frames 7–10, all 1°/frame), the off-key only later.
      expect(movesOf(report)).toEqual([{
        set: 'up',
        frames: [10, 15],
        moved: {
          on: { frame: [10, 10], frames: 0, seconds: 0, window: [7, 10], speed: { old: 1, new: 1 } },
          off: { frame: [16, 16], frames: 0, seconds: 0, window: [16, 19], speed: { old: 25, new: 25 } },
        },
      }]);
      const long = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(approach(20)) });
      const report2 = join(long.dir, 'report.json');
      expect(retarget(long, ['--report', report2, '--switch-at', 'peak']).status).toBe(0);
      expect(movesOf(report2)[0]!.frames).toEqual([12, 19]);
      expect(movesOf(report2)[0]!.moved.on).toEqual({ frame: [10, 12], frames: 2, seconds: secs(10, 12), window: [7, 13], speed: { old: 1, new: 11.75 } });
    }, SLOW);

    test('set → set: the boundary between two sets moves once, one key per slot, no frame of base art between them', () => {
      // "up" (150°) eases toward "near" (110°): nearer "near" from frame 20 (129.5°), then the last 18° fast — 8°/frame on 22.
      const near = (o: Record<string, unknown> = {}) => out({ name: 'near', pose: keySkeleton(110, 130), ...o });
      const RU: Record<number, number> = { 16: 145, 17: 140, 18: 135, 19: 131, 20: 129.5, 21: 128, 22: 120, 23: 112 };
      const m = at24((i) => (i <= 15 ? 150 : RU[i] ?? 110));
      const c = setup({ rig: ALT_RIG, map: altMap(up(), near()), pose: poseDoc(m) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report, '--switch-at', 'peak']);
      expect(r.status).toBe(0);
      const mv = movesOf(report);
      expect(mv.map((s) => `${s.set} ${s.frames.join('–')}`)).toEqual(['up 0–21', 'near 22–47']);
      const boundary: MoveOut = { frame: [20, 22], frames: 2, seconds: secs(20, 22), window: [17, 23], speed: { old: 1.5, new: 8 } };
      expect(mv[0]!.moved).toEqual({ on: null, off: boundary });
      expect(mv[1]!.moved).toEqual({ on: boundary, off: null });
      expect(slotTracks(c.out)[0]).toEqual({ slot: 'sleeve_r0', property: 'attachment', keys: [{ t: 0, v: 'seg_up' }, { t: keyAt(22), v: 'seg_out' }] });
      expect(shows(c.build, 'sleeve_r0', N, DT)).toEqual(each((i) => (i <= 21 ? 'seg_up' : 'seg_out'), N));
    }, SLOW);

    test('a tie goes to the frame nearest the original', () => {
      // Within 25° from frame 12 (125.5°); 6°/frame on 10 and on 13 both, the window's fastest: 13 is one frame away, 10 two.
      const RU: Record<number, number> = { 10: 118, 11: 124, 12: 125.5, 13: 126, 14: 137.5, 15: 136 };
      const m = at24((i) => (i <= 9 ? 112 : i <= 15 ? RU[i]! : i <= 30 ? 137.5 : 100));
      const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(m) });
      const report = join(c.dir, 'report.json');
      expect(retarget(c, ['--report', report, '--switch-at', 'peak']).status).toBe(0);
      expect(movesOf(report)[0]!.moved.on).toEqual({ frame: [12, 13], frames: 1, seconds: secs(12, 13), window: [9, 15], speed: { old: 1, new: 6 } });
    }, SLOW);

    test('the bound: the window\'s peak would newly show the set 55° from its key skeleton (over 2 × 25°), so it is passed over for a slower frame that is within it', () => {
      // Within 25° from frame 12 (125.5°). Frame 10 is the window's fastest (25°/frame) but 55° off; frame 11 (40° off) is 15.25°/frame.
      const RU: Record<number, number> = { 10: 95, 11: 110, 12: 125.5, 13: 126.5, 14: 127.5, 15: 128.5 };
      const m = at24((i) => (i <= 9 ? 60 : i <= 15 ? RU[i]! : i <= 30 ? 150 : 60));
      const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(m) });
      const report = join(c.dir, 'report.json');
      expect(retarget(c, ['--report', report, '--switch-at', 'peak']).status).toBe(0);
      const mv = movesOf(report)[0]!;
      expect(mv.frames).toEqual([11, 30]);
      expect(mv.moved.on).toEqual({ frame: [12, 11], frames: -1, seconds: secs(12, 11), window: [9, 15], speed: { old: 8.25, new: 15.25 } });
      expect(reportOf(report).switches[0]!.distance).toEqual({ max: 40, median: expect.any(Number) });
      // Control: under a tolerance of 30° (bound 60°) frame 10 qualifies and the boundary goes to the peak.
      const r2 = join(c.dir, 'report2.json');
      expect(retarget(c, ['--report', r2, '--switch-at', 'peak', '--switch-tolerance', '30']).status).toBe(0);
      expect(movesOf(r2)[0]!.moved.on!.frame).toEqual([12, 10]);
    }, SLOW);

    test('--switch-at takes peak or first, nothing else', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(up()) });
      const r = retarget(c, ['--switch-at', 'last']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--switch-at is "last"; it must be peak or first');
    });
  });

  /** One planted map per case; the control is the first test above. */
  const withChain = (name: string, extra: Record<string, unknown>) => ({ ...altMap(up()), chains: baseChains().map((ch) => (ch.name === name ? { ...ch, ...extra } : ch)) });
  const altCases: Array<{ code: string; map: () => Record<string, unknown>; resolves: boolean; want: string }> = [
    { code: 'MAP_ALT_SLOT', map: () => altMap(up({ slots: { sleeve_r9: 'seg_up' } })), resolves: true, want: 'MAP_ALT_SLOT: set "up" — slot "sleeve_r9" is not in the rig; its slots are sleeve_r0, sleeve_r1, sleeve_l0, sleeve_l1, leg_r0, leg_r1, leg_l0, leg_l1, cap_r' },
    { code: 'MAP_ALT_ATTACHMENT', map: () => altMap(up({ slots: { sleeve_r0: 'seg_down', cap_r: 'cap_up' } })), resolves: true, want: 'MAP_ALT_ATTACHMENT: set "up" — slot "sleeve_r0" has no attachment "seg_down" under any skin; it has seg, seg_up, seg_out' },
    { code: 'MAP_ALT_HIDES', map: () => altMap(up({ hides: ['sleeve_r1', 'cuff_r'] })), resolves: true, want: 'MAP_ALT_HIDES: set "up" hides slot "cuff_r", which is not in the rig; its slots are sleeve_r0, sleeve_r1, sleeve_l0, sleeve_l1, leg_r0, leg_r1, leg_l0, leg_l1, cap_r' },
    { code: 'MAP_ALT_HIDES', map: () => altMap(up({ hides: ['sleeve_r0'] })), resolves: false, want: 'MAP_ALT_HIDES: set "up" hides slot "sleeve_r0", which "slots" shows "seg_up" in; a slot of a set either shows or hides' },
    { code: 'MAP_ALT_CHAIN', map: () => altMap(up({ chains: ['arm_x'] })), resolves: false, want: 'MAP_ALT_CHAIN: set "up" names chain "arm_x", which the map does not have; its chains are trunk, arm_r, arm_l, leg_r, leg_l' },
    { code: 'MAP_ALT_JOINT', map: () => altMap(up({ pose: { r_shoulder: [0, 0], r_elbow: [10, 0] } })), resolves: false, want: 'MAP_ALT_JOINT: set "up" "pose" has no "r_wrist"; chain "arm_r" uses r_shoulder, r_elbow, r_wrist, and every one of them must be in the key skeleton' },
    { code: 'MAP_ALT_DRAWN', map: () => altMap(up({ drawn: { sleeve_l0: 10 } })), resolves: false, want: 'MAP_ALT_DRAWN: set "up" "drawn" names bone "sleeve_l0", which is not a bone of its chains (arm_r: sleeve_r0, sleeve_r1)' },
    { code: 'MAP_ALT_OFFSET', map: () => altMap(up({ offsets: { leg_r0: [1, 1] } })), resolves: false, want: 'MAP_ALT_OFFSET: set "up" "offsets" names bone "leg_r0", which is not a bone of its chains (arm_r: sleeve_r0, sleeve_r1)' },
    { code: 'MAP_ALT_OFFSET', map: () => altMap(up({ offsets: { hip: [1, 1] } })), resolves: false, want: 'MAP_ALT_OFFSET: set "up" "offsets" names bone "hip", which "translate" already keys; a bone carries one translate track' },
    { code: 'MAP_RANGE', map: () => withChain('arm_r', { range: { sleeve_l0: [-10, 10] } }), resolves: false, want: 'MAP_RANGE: chain "arm_r" "range" names bone "sleeve_l0", which is not a bone of the chain; its bones are sleeve_r0, sleeve_r1' },
    { code: 'MAP_RANGE', map: () => withChain('arm_r', { range: { sleeve_r0: [10, -10] } }), resolves: false, want: 'MAP_RANGE: chain "arm_r" "range" bone "sleeve_r0" is [10,-10]; it must be [min, max], two finite numbers of degrees with min ≤ max' },
  ];
  altCases.forEach((ac, k) => {
    test(`map: ${ac.code} (${k + 1} of ${altCases.length}) — ${ac.resolves ? 'against the built rig' : 'as read'}`, () => {
      const c = setup({ rig: ALT_RIG, map: ac.map() });
      const r = retarget(c);
      expect(r.status).toBe(1);
      const f = fails(r);
      if (ac.resolves) expect(f).toEqual([`FAIL  MAP_RESOLVES: ${c.map} does not resolve against the rig`, `FAIL  ${ac.want}`]);
      else expect(f).toEqual([`FAIL  ${ac.want}`]);
      expect(existsSync(c.out)).toBe(false);
    }, SLOW);
  });

  describe('range: a rotate key past its range is clamped outside a set\'s span, and listed', () => {
    /** The chest still at 90°, so the right upper arm's key is its turn from rest (−100°): 10° everywhere, 50° on frames 4–7. */
    const lifted = (i: number) => i >= 4 && i <= 7;
    const RANGED: Motion = { ...BASE, trunk: () => 90, ru: (i) => -100 + (lifted(i) ? 50 : 10), rf: (i) => -100 + (lifted(i) ? 50 : 10) + 25 };
    const rangedMap = (limits: [number, number], ...sets: Array<Record<string, unknown>>) => ({ ...altMap(...sets), chains: baseChains().map((ch) => (ch.name === 'arm_r' ? { ...ch, range: { sleeve_r0: limits } } : ch)) });
    /** A set painted at the lifted arm (its key skeleton is frames 4–7's pose). */
    const lift = (o: Record<string, unknown> = {}) => ({ name: 'lift', slots: { sleeve_r0: 'seg_up' }, chains: ['arm_r'], pose: keySkeleton(-50, -25), ...o });

    test('frames 4–7 clamped at +30: the upper arm stops there, the forearm still lands on its pose angle, RANGE listed', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-30, 30]), pose: poseDoc(RANGED) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'RANGE')).toEqual([
        'RANGE  chain "arm_r" bone "sleeve_r0" frames 4–7 (t=0.500–0.875s): 0.500s the pose asks its rotate key past its range [-30, 30] (+50.0°, up to 20.0° past); clamped at the limit — demand for an alternate',
      ]);
      // Landing is measured against the clamped targets, and holds.
      expect(linesOf(r, 'LAND')).toHaveLength(10);
      // Read back by rig-c: the upper arm at −100 + 30 on the clamped frames, every other bone (the forearm below it too) on the pose.
      expect(misses(c.build, RANGED, (b, i) => (b === 'sleeve_r0' && lifted(i) ? -70 : angleOf(RANGED, b, i)))).toEqual([]);
      expect(misses(c.build, RANGED).every((m) => m.startsWith('sleeve_r0 '))).toBe(true);
      expect(legacyReportRows(reportOf(report).range, ['times', 'spanSeconds'])).toEqual([{ chain: 'arm_r', bone: 'sleeve_r0', frames: [4, 7], seconds: 0.5, maxOverflow: 20, key: 50, limits: [-30, 30] }]);
    }, SLOW);

    test('control: without a range the same pose is keyed as given, and nothing is listed', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(), pose: poseDoc(RANGED) });
      const r = retarget(c);
      expect(r.status).toBe(0);
      expect(linesOf(r, 'RANGE')).toEqual([]);
      expect(misses(c.build, RANGED)).toEqual([]);
    }, SLOW);

    test('inside a span of a set depicting the chain nothing is clamped; at the drawn angle the bone is posed exactly there (criterion 3)', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-30, 30], lift({ drawn: { sleeve_r0: -50, sleeve_r1: -25 } })), pose: poseDoc(RANGED) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'SWITCH')).toEqual([
        'SWITCH set "lift" — shows "sleeve_r0" = "seg_up"; chains arm_r; frames 4–7 (t=0.500s until 1.000s) — distance max 0.0°, median 0.0°; art turn "sleeve_r0" max 0.0°, median 0.0°; "sleeve_r1" max 0.0°, median 0.0°; moved on frame 4 stays (20.0°/frame; window frames 3–5), off frame 8 stays (20.0°/frame; window frames 7–9)',
      ]);
      expect(linesOf(r, 'RANGE')).toEqual([]);
      expect(linesOf(r, 'ART-RANGE')).toEqual([]);
      expect(misses(c.build, RANGED)).toEqual([]);
      // The reference equals `drawn` on the switched frames: rig-c's poser puts each bone at its drawn world angle.
      const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: BASE.n - 1 }, () => BASE.dt));
      for (let i = 4; i <= 7; i++) {
        const b = byName(poses[i]!.bones);
        expect(Math.abs(wrap(worldAngle(b, 'sleeve_r0') - -50))).toBeLessThanOrEqual(ANGLE_TOL);
        expect(Math.abs(wrap(worldAngle(b, 'sleeve_r1') - -25))).toBeLessThanOrEqual(ANGLE_TOL);
      }
      const rep = reportOf(report);
      expect(rep.switches[0]!.artTurn).toEqual({ sleeve_r0: { max: 0, median: 0 }, sleeve_r1: { max: 0, median: 0 } });
      expect(rep.range).toEqual([]);
    }, SLOW);

    test('ART-RANGE: inside the span the reference sits 30° off drawn, range ±10 — 20° past it, listed, and the bone not clamped', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-10, 10], lift({ drawn: { sleeve_r0: -80 } })), pose: poseDoc(RANGED) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'ART-RANGE')).toEqual([
        'ART-RANGE set "lift" chain "arm_r" bone "sleeve_r0" turned +30.0° from drawn (range [-10, 10]) frames 4–7 (t=0.500–0.875s): 0.500s, up to 20.0° past it; the bone follows the pose — demand for another drawing of the set',
      ]);
      // Outside the span the key is 10°, at the limit: nothing clamped there either.
      expect(linesOf(r, 'RANGE')).toEqual([]);
      expect(misses(c.build, RANGED)).toEqual([]);
      const rep = reportOf(report);
      expect(legacyReportRows(rep.artRange, ['times', 'spanSeconds'])).toEqual([{ set: 'lift', chain: 'arm_r', bone: 'sleeve_r0', frames: [4, 7], seconds: 0.5, maxOverflow: 20, turn: 30, limits: [-10, 10], clamped: false }]);
      expect(rep.switches[0]!.artTurn).toEqual({ sleeve_r0: { max: 30, median: 30 } });
    }, SLOW);

    test('the set\'s turn holds the art: drawn −80°, turn ±10, reference 30° past drawn — clamped at drawn +10°, listed, and the forearm keeps its own angle', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-10, 10], lift({ drawn: { sleeve_r0: -80 }, turn: { sleeve_r0: [-10, 10] } })), pose: poseDoc(RANGED) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'ART-RANGE')).toEqual([
        'ART-RANGE set "lift" chain "arm_r" bone "sleeve_r0" turned +30.0° from drawn (range [-10, 10]) frames 4–7 (t=0.500–0.875s): 0.500s, up to 20.0° past it; held at the limit — demand for another drawing of the set',
      ]);
      expect(reportOf(report).artRange[0]!.clamped).toBe(true);
      const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: BASE.n - 1 }, () => BASE.dt));
      for (let i = 4; i <= 7; i++) {
        const b = byName(poses[i]!.bones);
        expect(Math.abs(wrap(worldAngle(b, 'sleeve_r0') - -70))).toBeLessThanOrEqual(ANGLE_TOL);
        expect(Math.abs(wrap(worldAngle(b, 'sleeve_r1') - angleOf(RANGED, 'sleeve_r1', i)))).toBeLessThanOrEqual(ANGLE_TOL);
      }
      // Every frame and half-frame: the pose's own angles, the upper arm held at drawn +10° on the span.
      expect(misses(c.build, RANGED, (b, i) => (b === 'sleeve_r0' && i >= 4 && i <= 7 ? -70 : angleOf(RANGED, b, i)))).toEqual([]);
    }, SLOW);

    test('MAP_ALT_TURN: a turn on a bone the set has no drawn angle for is refused by name', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-10, 10], lift({ drawn: { sleeve_r0: -80 }, turn: { sleeve_r1: [-10, 10] } })), pose: poseDoc(RANGED) });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r).some((l) => l.includes('MAP_ALT_TURN') && l.includes('"sleeve_r1"'))).toBe(true);
    }, SLOW);
  });

  describe('TURN: a line across the body short or reversed for ≥ 0.15 s', () => {
    /** 30 fps, so 6 frames are 0.2 s and 2 are 0.067 s. */
    const T: Motion = { ...BASE, dt: 1 / 30 };
    /** The hips moved to `r` and `l` about their midpoint on `len` frames from `from`, each leg moved with its hip (every segment the map aims keeps its angle). */
    const hips = (from: number, len: number, r: Pt, l: Pt): Record<string, unknown> => poseDoc(T, (i, j) => {
      if (i < from || i >= from + len) return;
      const rh = j.r_hip!.at as Pt;
      const lh = j.l_hip!.at as Pt;
      const mid: Pt = [(rh[0] + lh[0]) / 2, (rh[1] + lh[1]) / 2];
      const move = (names: string[], from: Pt, to: Pt) => {
        for (const nm of names) {
          const a = j[nm]!.at as Pt;
          j[nm] = { state: 'observed', at: [a[0] + to[0] - from[0], a[1] + to[1] - from[1]], score: 0.9 };
        }
      };
      move(['r_knee', 'r_ankle', 'r_hip'], rh, add(mid, r));
      move(['l_knee', 'l_ankle', 'l_hip'], lh, add(mid, l));
    });

    test('the hip line at 0.3 of its length for 6 frames: TURN, and no key moves', () => {
      const c = setup({ pose: hips(5, 6, [-4.5, 0], [4.5, 0]) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'TURN')).toEqual([
        'TURN   line "hip" (r_hip → l_hip) frames 5–10 (t=0.167–0.333s): 0.200s picture length down to 0.30 of its median, under 0.5, ≥ 0.15s — the body or head turned, a pose the rig cannot draw',
      ]);
      expect(legacyReportRows(reportOf(report).turns, ['times', 'spanSeconds', 'bones'])).toEqual([{ line: 'hip', joints: ['r_hip', 'l_hip'], frames: [5, 10], seconds: 0.2, minFraction: expect.closeTo(0.3, 9), reversed: false }]);
      expect(misses(c.build, T)).toEqual([]);
    }, SLOW);

    test('control: 2 frames (0.067 s) is no TURN', () => {
      const c = setup({ pose: hips(7, 2, [-4.5, 0], [4.5, 0]) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.status).toBe(0);
      expect(linesOf(r, 'TURN')).toEqual([]);
      expect(reportOf(report).turns).toEqual([]);
    }, SLOW);

    test('the hips swapped for 6 frames (full length, pointing the other way): TURN, reversed', () => {
      const c = setup({ pose: hips(5, 6, [15, 0], [-15, 0]) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'TURN')).toEqual([
        'TURN   line "hip" (r_hip → l_hip) frames 5–10 (t=0.167–0.333s): 0.200s reversed (pointing more than 90° from r_hip → l_hip\'s own way), picture length down to 1.00 of its median, ≥ 0.15s — the body or head turned, a pose the rig cannot draw',
      ]);
      expect(legacyReportRows(reportOf(report).turns, ['times', 'spanSeconds', 'bones'])).toEqual([{ line: 'hip', joints: ['r_hip', 'l_hip'], frames: [5, 10], seconds: 0.2, minFraction: expect.closeTo(1, 9), reversed: true }]);
    }, SLOW);

    test('a line the map does not use is read too: the eye line at 0.3 for 6 frames', () => {
      const pose = poseDoc(T, (i, j) => {
        if (i < 5 || i > 10) return;
        const nose = j.nose!.at as Pt;
        j.r_eye = { state: 'observed', at: add(nose, [-1.8, -5]), score: 0.9 };
        j.l_eye = { state: 'observed', at: add(nose, [1.8, -5]), score: 0.9 };
      });
      const c = setup({ pose });
      const r = retarget(c);
      expect(r.status).toBe(0);
      expect(linesOf(r, 'TURN')).toEqual([
        'TURN   line "eye" (r_eye → l_eye) frames 5–10 (t=0.167–0.333s): 0.200s picture length down to 0.30 of its median, under 0.5, ≥ 0.15s — the body or head turned, a pose the rig cannot draw',
      ]);
    }, SLOW);
  });

  describe('uncovered folds', () => {
    /** The right forearm folded back on frames 6–9, as in the fold test above. */
    const HARD: Motion = { ...BASE, rf: (i) => (i >= 6 && i <= 9 ? BASE.ru(i) + 170 : BASE.rf(i)) };
    /** A key skeleton within 10° of frames 6 and 7 only (frame 8 is 12° off, 9 is 20°). */
    const folded = keySkeleton(172, 342);
    const MESH_RIG: RigOpts = { mesh: true, extra: { ...ALT_RIG.extra, arm_mesh: { arm_mesh_up: { image: 'seg.png', x: 30, y: 0, rotation: 90 } } }, extraSlots: ALT_RIG.extraSlots };
    const foldTimes = (r: Ran): number[] => {
      const l = linesOf(r, 'FOLD').find((x) => x.includes('"arm_mesh"'));
      return l === undefined ? [] : l.split('t=')[1]!.split(', ').flatMap((s) => {
        const [a, b] = s.split('–').map(Number);
        const ts: number[] = [];
        for (let t = a!; t <= (b ?? a!) + 1e-9; t += 0.125) ts.push(Math.round(t * 1000) / 1000);
        return ts;
      });
    };

    test('control: with no switch the mesh folds on frames 6–9, and every fold is uncovered', () => {
      const c = setup({ rig: MESH_RIG, pose: poseDoc(HARD) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.status).toBe(0);
      expect(foldTimes(r)).toEqual([0.75, 0.875, 1, 1.125]);
      expect(legacyReportRows(reportOf(report).uncovered, ['domain'])).toEqual([{ slot: 'arm_mesh', attachment: 'arm_mesh', chains: ['arm_r'], times: [0.75, 0.875, 1, 1.125] }]);
      // No map alternates, no UNCOVERED lines.
      expect(linesOf(r, 'UNCOVERED')).toEqual([]);
    }, SLOW);

    test('the folding mesh replaced on frames 6–7: rigc reads no fold there, and the folds on 8–9 are uncovered', () => {
      const set = { name: 'folded', slots: { arm_mesh: 'arm_mesh_up' }, chains: ['arm_r'], pose: folded };
      const c = setup({ rig: MESH_RIG, map: altMap(set), pose: poseDoc(HARD) });
      const report = join(c.dir, 'report.json');
      // Kept where the selection puts it (--switch-at first): what is read here is the coverage, not the timing.
      const r = retarget(c, ['--report', report, '--switch-tolerance', '10', '--switch-at', 'first']);
      expect(r.status).toBe(0);
      expect(linesOf(r, 'SWITCH')[0]).toContain('frames 6–7');
      expect(foldTimes(r)).toEqual([1, 1.125]);
      expect(legacyReportRows(reportOf(report).uncovered, ['domain'])).toEqual([{ slot: 'arm_mesh', attachment: 'arm_mesh', chains: ['arm_r'], times: [1, 1.125] }]);
      expect(linesOf(r, 'UNCOVERED')).toEqual(['UNCOVERED mesh "arm_mesh" (slot "arm_mesh"; chains arm_r) folds with no switch covering it on 2 frame(s): t=1.000–1.125']);
    }, SLOW);

    test('the folding mesh hidden by a set that shows another slot: no fold read on its span either', () => {
      const c = setup({ rig: MESH_RIG, map: altMap(up({ hides: ['arm_mesh'], pose: folded })), pose: poseDoc(HARD) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report, '--switch-tolerance', '10', '--switch-at', 'first']);
      expect(r.status).toBe(0);
      expect(slotTracks(c.out).map((t) => t.slot)).toEqual(['sleeve_r0', 'cap_r', 'arm_mesh']);
      expect(foldTimes(r)).toEqual([1, 1.125]);
      expect(legacyReportRows(reportOf(report).uncovered, ['domain'])).toEqual([{ slot: 'arm_mesh', attachment: 'arm_mesh', chains: ['arm_r'], times: [1, 1.125] }]);
    }, SLOW);
  });
});

// --- #43: what two independent solvers ran into ------------------------------------

describe('#43: the older pose name, --images, the rigc version, and why a window did not switch', () => {
  test('a rig-c-pose-frames/0 file (painting-px, an fps key) is read as it is; a wrong space for it is refused by name', () => {
    const doc = poseDoc(BASE) as Record<string, unknown>;
    const older = { ...doc, spec: 'rig-c-pose-frames/0', space: { units: 'painting-px', origin: 'top-left', y: 'down' }, fps: 8 };
    const c = setup({ pose: older });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(misses(c.build, BASE)).toEqual([]);
    const bad = setup({ pose: { ...older, space: doc.space } });
    const rb = retarget(bad);
    expect(rb.status).toBe(1);
    expect(fails(rb).some((l) => l.includes('POSE_SPACE') && l.includes('rig-c-pose-frames/0'))).toBe(true);
  }, SLOW);

  test('--images reaches a rig.json copied away from its images; without it the gate is red by name', () => {
    const c = setup();
    const copy = join(c.dir, 'copied');
    mkdirSync(copy, { recursive: true });
    cpSync(join(c.rig, 'rig.json'), join(copy, 'rig.json'));
    const without = cli(['retarget', '--rig', copy, '--map', c.map, '--pose', c.pose, '--out', c.out]);
    expect(without.status).toBe(1);
    expect(fails(without).some((l) => l.includes('RIG_GATE_BASE'))).toBe(true);
    const withImages = cli(['retarget', '--rig', copy, '--images', join(c.rig, 'images'), '--map', c.map, '--pose', c.pose, '--out', c.out]);
    expect(withImages.stderr).toBe('');
    expect(withImages.status).toBe(0);
  }, SLOW);

  test('the run and the report name the rigc that gated it', () => {
    const c = setup();
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    const v = (JSON.parse(readFileSync(join(ROOT, 'node_modules', 'rig-c', 'package.json'), 'utf8')) as { version: string }).version;
    expect(linesOf(r, 'RIGC')[0]).toContain(`rig-c ${v}`);
    expect((JSON.parse(readFileSync(report, 'utf8')) as { rigc: { version: string } }).rigc.version).toBe(v);
  }, SLOW);
});

// --- #47: the legs foreshorten, and the hip comes from the supporting foot ---------

describe('#47: --leg-scale and --plant-feet', () => {
  /** Both legs parallel, thigh at −95° and shin at −97° (Spine degrees), 80 and 70 px straight. */
  const THIGH = -95;
  const SHIN = -97;
  const N = 24;
  const DT = 1 / 24;
  /** The knees bend toward the camera: thigh and shin at f of their length in the picture, f 1 → 0.85 → 1. */
  const bendF = (i: number): number => (i < 6 || i > 18 ? 1 : 1 - 0.15 * Math.sin(((i - 6) / 12) * Math.PI));
  const STILL: Motion = { ...BASE, n: N, dt: DT, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };
  /** The leg vector hip → ankle in the picture at full length (y down). */
  const V = add(dir(THIGH, 80), dir(SHIN, 70));

  /**
   * A pose whose legs are scaled by `f(i)` with both ankles held where they are
   * at f = 1, plus `lift(i, side)` px up on each ankle (the knee stays); the
   * rest of the body travels with the hip.
   */
  function legsPose(f: (i: number) => number, lift: (i: number, side: 'r' | 'l') => number = () => 0, rise: (i: number) => number = () => 0): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const drop: Pt = [(1 - f(i)) * V[0], (1 - f(i)) * V[1] - rise(i)];
      for (const [name, at] of Object.entries(j)) {
        const a = at.at as Pt;
        if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
        j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
      }
      for (const s of ['r', 'l'] as const) {
        const hip = j[`${s}_hip`]!.at as Pt;
        const knee = add(hip, dir(THIGH, 80 * f(i)));
        const ankle = add(knee, dir(SHIN, 70 * f(i)));
        j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
        j[`${s}_ankle`] = { state: 'observed', at: [ankle[0], ankle[1] - lift(i, s)], score: 0.9 };
      }
    });
  }

  interface Posed {
    hip: Pt[];
    ankle: { r: Pt[]; l: Pt[] };
    len: { [bone: string]: number[] };
  }
  /** The gated build posed by rig-c, read independently: the hip's origin, each shin's tip, each leg bone's world x-axis length over setup. */
  function posedLegs(build: string): Posed {
    const doc = loadBuild(build);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const out: Posed = { hip: [], ankle: { r: [], l: [] }, len: { leg_r0: [], leg_r1: [], leg_l0: [], leg_l1: [] } };
    for (const p of poses) {
      const b = byName(p.bones);
      out.hip.push([b.get('hip')!.worldX, b.get('hip')!.worldY]);
      for (const s of ['r', 'l'] as const) {
        const shin = b.get(`leg_${s}1`)!;
        out.ankle[s].push([shin.worldX + shin.a * 70, shin.worldY + shin.c * 70]);
      }
      for (const n of Object.keys(out.len)) out.len[n]!.push(Math.hypot(b.get(n)!.a, b.get(n)!.c));
    }
    return out;
  }
  const spread = (ps: Pt[]): number => Math.max(...ps.map((p) => Math.hypot(p[0] - ps[0]![0], p[1] - ps[0]![1])));
  /** A rig leg, hip → ankle at full length, world units. */
  const LEG = 150;

  test('knees bending toward the camera: the legs shorten, the feet stay within 0.02 leg lengths, and the hip drops by the scaled amount', () => {
    const c = setup({ pose: legsPose(bendF) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LEG-SCALE')).toHaveLength(4);
    expect(linesOf(r, 'LEG-SCALE')[0]).toContain('chain "leg_r" bone "leg_r0" (r_hip → r_knee): straight length 80.0px');
    expect(linesOf(r, 'LEG-SCALE')[0]).toContain('none under 0.8; none over 1.05');
    // Every scale and both ankles land, by the package's own check.
    const lands = linesOf(r, 'LAND');
    expect(lands.filter((l) => l.includes(' scale — '))).toHaveLength(4);
    expect(lands.filter((l) => l.includes(' ankle — '))).toHaveLength(2);
    const p = posedLegs(c.build);
    // Independently: each segment's world length is f of setup's …
    for (let i = 0; i < N; i++) for (const n of Object.keys(p.len)) expect(Math.abs(p.len[n]![i]! - bendF(i))).toBeLessThan(1e-4);
    // … the feet do not move …
    expect(spread(p.ankle.r)).toBeLessThan(0.02 * LEG);
    expect(spread(p.ankle.l)).toBeLessThan(0.02 * LEG);
    expect(spread(p.ankle.r)).toBeLessThan(0.05);
    // … and the hip drops by (1 − f) of the rig's leg, along it (80 and 70 units at −95° and −97°).
    const W: Pt = [80 * Math.cos(THIGH * RAD) + 70 * Math.cos(SHIN * RAD), 80 * Math.sin(THIGH * RAD) + 70 * Math.sin(SHIN * RAD)];
    for (let i = 0; i < N; i++) {
      const want: Pt = [p.hip[0]![0] + (1 - bendF(i)) * W[0], p.hip[0]![1] + (1 - bendF(i)) * W[1]];
      expect(Math.hypot(p.hip[i]![0] - want[0], p.hip[i]![1] - want[1])).toBeLessThan(0.05);
    }
    expect(p.hip[0]![1] - Math.min(...p.hip.map((h) => h[1]))).toBeGreaterThan(0.14 * LEG);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { options: { legScale: unknown; plantFeet: boolean }; feet: { planted: boolean; supports: unknown[]; jumps: unknown[] }; legScale: Array<{ bone: string; low: unknown[] }> };
    expect(rep.options.legScale).toEqual([0.8, 1.05]);
    expect(rep.options.plantFeet).toBe(true);
    expect(rep.feet.planted).toBe(true);
    expect(rep.feet.jumps).toEqual([]);
    expect(rep.legScale.map((l) => l.bone)).toEqual(['leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']);
    // #83: the README's `--report` paragraph is the documented interface. Its `feet` keys are read from
    // the README itself and must equal the written ones, so a field added or dropped without the
    // README fails here; `gate` is documented as a string and written as one.
    const readme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8');
    const para = readme.split('\n').find((l) => l.startsWith('`--report <file>` writes all of it as JSON (`rig-pose-report/1`)'))!;
    const feetDoc = /`feet` \(([^;)]*)/.exec(para)![1]!;
    const documented = [...feetDoc.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!).sort();
    expect(Object.keys(rep.feet).sort()).toEqual(documented);
    // The report's top level: the paragraph's names outside its parentheses, and the demand lists below it.
    // A list the README marks as present only with `place` (#93) is absent here: this map declares none.
    // Its presence on a run that does is held by the "by-hip" block below.
    const doc = documentedReport();
    expect(doc.conditional).toEqual(['byHip']);
    expect(Object.keys(rep).sort()).toEqual(doc.all.filter((k) => !doc.conditional.includes(k)));
    expect('byHip' in rep).toBe(false);
    expect(para).toContain("`gate` (rig-c's gate summary, a string)");
    expect(typeof (rep as unknown as { gate: unknown }).gate).toBe('string');
  }, SLOW);

  test('control: without the two flags the same pose keys no scale, and the hip follows the pose\'s travel with the feet sliding', () => {
    const c = setup({ pose: legsPose(bendF) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LEG-SCALE')).toEqual([]);
    expect(motionOf(c.out).animations.dance!.tracks.map((t) => t.property)).not.toContain('scalex');
    const p = posedLegs(c.build);
    // The figure's legs are 1.5× the pose's (the scale is set by the trunk), and rigid: the ankles drop with the hip.
    expect(spread(p.ankle.r)).toBeGreaterThan(0.1 * LEG);
  }, SLOW);

  test('the scale is clamped at the declared limits, and the frames clamped are listed', () => {
    const c = setup({ pose: legsPose(bendF) });
    const r = retarget(c, ['--leg-scale', '0.9,1.05']);
    expect(r.status).toBe(0);
    const clamped = Array.from({ length: N }, (_, i) => i).filter((i) => bendF(i) < 0.9);
    const line = linesOf(r, 'LEG-SCALE')[0]!;
    expect(line).toContain(`${clamped.length} frame(s) under 0.9, clamped (frames ${clamped[0]}–${clamped[clamped.length - 1]})`);
    const p = posedLegs(c.build);
    for (const i of clamped) expect(Math.abs(p.len.leg_r0![i]! - 0.9)).toBeLessThan(1e-4);
  }, SLOW);

  test('mutant: the shin keyed by the unit-scale formula under a scaled thigh misses, and POSE_LANDS names it', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const solvedKey = (b: string, i: number) => legPoses?.[i]!.solved.get(b);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const solvedKey = (_b: string, _i: number): { rotate: number; scale: number } | undefined => undefined;'));
      // Knees bent in the picture (the shin 20° off the thigh), so the thigh's scale turns the shin.
      const bent: Motion = { ...STILL, rs: () => THIGH - 20 };
      const c = setup({ pose: poseDoc(bent, (i, j) => {
        for (const s of ['r', 'l'] as const) {
          const hip = j[`${s}_hip`]!.at as Pt;
          const knee = add(hip, dir(THIGH, 80 * bendF(i)));
          j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
          j[`${s}_ankle`] = { state: 'observed', at: add(knee, dir(s === 'r' ? THIGH - 20 : SHIN, 70 * bendF(i))), score: 0.9 };
        }
      }) });
      const r = retarget(c, ['--leg-scale', '0.8,1.05'], join(d, 'cli.ts'));
      expect(r.status).toBe(1);
      expect(fails(r).some((l) => l.startsWith('FAIL  POSE_LANDS: bone "leg_r1" aim'))).toBe(true);
      expect(fails(r).some((l) => l.startsWith('FAIL  POSE_LANDS: bone "leg_r1" scale'))).toBe(true);
      // Control: the package itself lands the same pose.
      const ok = retarget(c, ['--leg-scale', '0.8,1.05']);
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);
      expect(linesOf(ok, 'SHEAR').find((l) => l.startsWith('SHEAR  bone "leg_r1"'))).toMatch(/art sheared up to [1-9]/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('a jump (both ankles up) releases the plant: the hip follows the pose\'s travel, and re-plants on landing', () => {
    /** Frames 10–13: the whole figure 20 px up (0.13 of its 150 px legs). */
    const rise = (i: number): number => (i >= 10 && i <= 13 ? 20 : 0);
    const c = setup({ pose: legsPose(() => 1, () => 0, rise) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): 10–13');
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { jumps: unknown; changes: Array<{ frame: number; from: string | null; to: string }> } };
    expect(rep.feet.jumps).toEqual([[10, 13]]);
    // Landing on frame 14 moves both ankles 20 px (a step's speed), so the plant is taken on 15, the first still frame.
    expect(rep.feet.changes.map((x) => x.frame)).toEqual([0, 15]);
    const p = posedLegs(c.build);
    // In the air the hip rises by the pose's 20 px × the figure scale 1.5; on the ground, before and after, the feet hold.
    expect(p.hip[11]![1] - p.hip[9]![1]).toBeCloseTo(30, 2);
    expect(spread(p.ankle.r.slice(0, 10))).toBeLessThan(0.01);
    expect(spread(p.ankle.r.slice(14))).toBeLessThan(0.01);
    expect(p.ankle.r[11]![1] - p.ankle.r[9]![1]).toBeCloseTo(30, 2);
    // Control: the same lift on one frame is under the 2 frames a jump lasts.
    const blip = setup({ pose: legsPose(() => 1, () => 0, (i) => (i === 10 ? 20 : 0)) });
    const rb = retarget(blip, ['--plant-feet']);
    expect(rb.status).toBe(0);
    expect(linesOf(rb, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): none');
  }, SLOW);

  test('#101: a raised heel during a hand-over is not a jump, a real flight is, and a mutant without the cue calls the heel a jump', () => {
    /**
     * Hand-over on frames 10–12 (150 px legs; 0.05 leg lengths = 7.5 px):
     * - Front foot `r` swings on 6–12 (20, 20, 20, 20, 18, 15, 11 px up) and lands on 13 (0 px).
     * - `mid_hip` rises 9 px (0.06 leg lengths) on 10–12.
     * - Back foot `l`:
     *   - raised heel: lifts to 12 px (0.08 leg lengths) on 10–12, holds 12 px on 13–14 when `r` lands (|dy| = 0 < 0.01), then swings on 15–17 (24 px) and lands on 18;
     *   - real flight: rises through `r`'s landing (12, 18, 24, 30, 36, 24 px on 10–15, |dy| = 0.04 leg lengths/frame on 13–14) before landing on 16.
     */
    const handOver = (flight: boolean) => {
      const rUp = (i: number): number => (i >= 6 && i <= 9 ? 20 : i === 10 ? 18 : i === 11 ? 15 : i === 12 ? 11 : 0);
      const lUp = (i: number): number =>
        flight
          ? i === 10 ? 12 : i === 11 ? 18 : i === 12 ? 24 : i === 13 ? 30 : i === 14 ? 36 : i === 15 ? 24 : 0
          : i >= 10 && i <= 14 ? 12 : i >= 15 && i <= 17 ? 24 : 0;
      const mUp = (i: number): number => (i >= 10 && i <= 12 ? 9 : 0);
      return legsPose(() => 1, (i, s) => (s === 'r' ? rUp(i) : lUp(i)) - mUp(i), mUp);
    };
    const heel = setup({ pose: handOver(false) });
    const heelRep = join(heel.dir, 'report.json');
    const rh = retarget(heel, ['--plant-feet', '--report', heelRep]);
    expect(rh.stderr).toBe('');
    expect(rh.status).toBe(0);
    expect(linesOf(rh, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): none');
    expect((JSON.parse(readFileSync(heelRep, 'utf8')) as { feet: { jumps: unknown } }).feet.jumps).toEqual([]);

    const flight = setup({ pose: handOver(true) });
    const flightRep = join(flight.dir, 'report.json');
    const rf = retarget(flight, ['--plant-feet', '--report', flightRep]);
    expect(rf.stderr).toBe('');
    expect(rf.status).toBe(0);
    expect(linesOf(rf, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): 10–12');
    expect((JSON.parse(readFileSync(flightRep, 'utf8')) as { feet: { jumps: unknown } }).feet.jumps).toEqual([[10, 12]]);

    // Planted mutant without the front-foot landing cue: calls the raised heel on 10–12 a jump.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'const jumps = runs(lifted).filter(([a, b]) => b - a + 1 >= JUMP_FRAMES && !raisedHeel(a, b));';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const jumps = runs(lifted).filter(([a, b]) => b - a + 1 >= JUMP_FRAMES);'));
      const mRep = join(heel.dir, 'mutant-report.json');
      const rm = retarget(heel, ['--plant-feet', '--report', mRep], join(d, 'cli.ts'));
      expect(rm.status).toBe(0);
      expect((JSON.parse(readFileSync(mRep, 'utf8')) as { feet: { jumps: unknown } }).feet.jumps).toEqual([[10, 12]]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#103: a jump whose scaled travel from take-off would land under the floor is carried to land on it with no flight frame below the floor; mutant without the correction dips', () => {
    /**
     * Take-off on frame 7 with legs compressed to 0.85 (hip 22.5 units lower on the floor),
     * flight on frames 8–11 with legs extended to 1.0 (rise 25, 28, 22, 10 px > 7.5 px threshold),
     * landing on frame 12 at full leg length (in-place so frame 12 plants directly).
     * Without #103, raw travel from frame 7 puts frame 11's foot > 10 units below the floor and frame 12's raw landing 22.5 units below it.
     */
    const f = (i: number): number => (i === 7 ? 0.85 : 1);
    const rise = (i: number): number => (i === 7 ? 0.15 * V[1] : i === 8 ? 25 : i === 9 ? 28 : i === 10 ? 22 : i === 11 ? 8 : 0);
    const doc = { ...legsPose(f, () => 0, rise), travel: 'in-place' };
    const c = setup({ pose: doc });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { jumps: Array<[number, number]>; floor: number; blend: { over: unknown[] } } };
    expect(rep.feet.jumps).toEqual([[8, 11]]);
    expect(rep.feet.blend.over).toEqual([]);
    const p = posedLegs(c.build);
    const floorY = rep.feet.floor;
    // Every flight frame 8–11 keeps both feet at or above the floor, and landing frame 12 sits on the floor.
    for (let i = 8; i <= 11; i++) {
      const minFoot = Math.min(p.ankle.r[i]![1], p.ankle.l[i]![1]);
      expect(minFoot - floorY).toBeGreaterThanOrEqual(-0.05);
    }
    expect(Math.abs(Math.min(p.ankle.r[12]![1], p.ankle.l[12]![1]) - floorY)).toBeLessThan(0.05);

    // Planted mutant without the #103 jump carry/clamp: frame 11's foot dips below the floor, and travel outside 8–12 is unchanged.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm103-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'const isJump = floorY !== null && feet.jumps.some(([ja, jb]) => ja <= end && jb >= startFrame);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const isJump = false;'));
      const m = setup({ pose: doc });
      const mRep = join(m.dir, 'report.json');
      const rm = retarget(m, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', mRep], join(d, 'cli.ts'));
      expect(rm.status).toBe(0);
      const mp = posedLegs(m.build);
      const dip11 = Math.min(mp.ankle.r[11]![1], mp.ankle.l[11]![1]) - floorY;
      console.log(`  mutant "without #103 jump carry": frame 11 foot is ${dip11.toFixed(2)} units relative to floor`);
      expect(dip11).toBeLessThan(-10);
      // Outside the jump and its 3-frame landing blend (0..7 and 15..23), the hip's travel is unchanged.
      const kOurs = motionOf(c.out).animations.dance!.tracks.find((t) => t.bone === 'hip' && t.property === 'translate')!.keys;
      const kMut = motionOf(m.out).animations.dance!.tracks.find((t) => t.bone === 'hip' && t.property === 'translate')!.keys;
      for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
        expect(kOurs[i]).toEqual(kMut[i]);
        expect(Math.abs(p.hip[i]![1] - mp.hip[i]![1])).toBeLessThan(1e-3);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#147: the flight carry fades over the landing blend instead of dropping at land+1; mutant cutting carry at land drops the hip on land+1', () => {
    /**
     * Take-off on frame 7 with legs compressed to 0.85, flight on frames 8–11,
     * landing on frame 12 and standing still on frames 12–15 at full leg length.
     * The flight's carry (+45 units) stays on the travel derivation across the
     * 3-frame landing blend (12, 13, 14) so the posed hip y stays continuous across
     * 12 -> 13 -> 14 -> 15 instead of dropping on frame 13 (land+1).
     */
    const f = (i: number): number => (i === 7 ? 0.85 : 1);
    const rise = (i: number): number => (i === 7 ? 0.15 * V[1] : i === 8 ? 25 : i === 9 ? 28 : i === 10 ? 22 : i === 11 ? 8 : 0);
    const doc = { ...legsPose(f, () => 0, rise), travel: 'in-place' };
    const c = setup({ pose: doc });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const p = posedLegs(c.build);
    for (const i of [13, 14, 15]) {
      expect(Math.abs(p.hip[i]![1] - p.hip[i - 1]![1])).toBeLessThan(1e-2);
    }

    // Mutant that cuts carry at i <= mode.land drops the hip on land+1 (frame 13) by > 10 units while standing still.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm147-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'Math.min(i, mode.land)';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, '(i <= mode.land ? i : mode.from)'));
      const m = setup({ pose: doc });
      const rm = retarget(m, ['--leg-scale', '0.8,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(rm.status).toBe(0);
      const mp = posedLegs(m.build);
      const drop13 = mp.hip[13]![1] - mp.hip[12]![1];
      console.log(`  mutant "cut carry at land (#147)": frame 12->13 hip step is ${drop13.toFixed(2)} units`);
      expect(drop13).toBeLessThan(-10);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#142: a support span ends at its ankle\'s push-off when both ankles are above their rolling floor and mid_hip is rising; mutant waiting for mid_hip drags the lifted foot down', () => {
    /**
     * Running cycle with crouch bottom on frames 2 and 12 and push-off on frames 3 and 13:
     * - Grounded support on 0–2 (`r`) and 10–12 (`l`), with legs at full length (150 px) on 0–1 / 10–11 and crouched (`f = 0.92`, ankle on floor, hip lowered by `0.08 * V[1] + 6` px via `rise = -6`) on 2 / 12.
     * - Push-off on frames 3 and 13: `f = 0.84` and `rise = 0.10 * V[1]` (~15 px), so both ankles are `15 px` (`0.10 > 0.05` leg lengths) above the floor while `mid_hip` is rising from frame 2's crouch bottom (`drop[1]` goes from `0.08 * V[1] + 6 = 18 px` on frame 2 to `0.06 * V[1] = 9 px` on frame 3, still below the `> 0.05` jump threshold).
     * - Flight on frames 4–9 and 14–19 (`f = 1`, `rise = 25 px`).
     */
    const f = (i: number): number => {
      if (i === 2 || i === 12 || i === 22) return 0.92;
      if (i === 3 || i === 13) return 0.84;
      return 1;
    };
    const rise = (i: number): number => {
      if (i === 2 || i === 12 || i === 22) return 0.08 * V[1] - 5;
      if (i === 3 || i === 13) return 0.16 * V[1] - 2;
      if ((i >= 4 && i <= 9) || (i >= 14 && i <= 19)) return 25;
      return 0;
    };
    const lift = (i: number): number => (i === 2 || i === 12 || i === 22 ? -(0.08 * V[1] - 5) : 0);
    const doc = { ...legsPose(f, lift, rise), travel: 'in-place' };
    const c = setup({ pose: doc });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      feet: {
        jumps: Array<[number, number]>;
        supports: Array<{ side: string; frames: [number, number] }>;
        floor: number;
      };
    };
    expect(rep.feet.jumps).toEqual([
      [3, 9],
      [13, 19],
    ]);
    expect(rep.feet.supports.map((s) => s.frames)).toEqual([
      [0, 2],
      [10, 12],
      [20, 23],
    ]);

    const p = posedLegs(c.build);
    const floorY = rep.feet.floor;
    expect(p.ankle.r[3]![1] - floorY).toBeGreaterThan(5);
    expect(p.ankle.l[13]![1] - floorY).toBeGreaterThan(5);

    // Mutant waiting for mid_hip to cross JUMP_RISE keeps push-off frames 3 and 13 grounded, dragging the lifted ankle to the floor and pulling the hip down.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm142-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'for (const j of jumps) while (j[0] > 1 && up[0]![j[0] - 1] && up[1]![j[0] - 1] && midY[j[0] - 1]! < midY[j[0] - 2]!) j[0]--;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));

      const cMut = setup({ pose: doc });
      const mRep = join(cMut.dir, 'report.json');
      const rMut = retarget(cMut, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', mRep], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const repMut = JSON.parse(readFileSync(mRep, 'utf8')) as {
        feet: { jumps: Array<[number, number]> };
      };
      expect(repMut.feet.jumps).toEqual([
        [4, 9],
        [14, 19],
      ]);
      const pMut = posedLegs(cMut.build);
      const dip = p.hip[3]![1] - pMut.hip[3]![1];
      console.log(`  mutant "mid_hip start (#142)": frame 3 hipY=${pMut.hip[3]![1].toFixed(2)}u vs ours=${p.hip[3]![1].toFixed(2)}u, dragged down by ${dip.toFixed(2)}u`);
      expect(dip).toBeGreaterThan(10);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('standing while the ankles drift up the picture with depth (the hip does not lift) is not a jump', () => {
    /** Both ankles 20 px up by the last frame (0.13 leg lengths over a floor-wide rule's 0.05), 0.9 px a frame; the hip stays. */
    const depth = (i: number): number => (20 * i) / (N - 1);
    const c = setup({ pose: legsPose(() => 1, (i) => depth(i)) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // The ankles alone are above any floor taken over the sequence by more than 0.05 leg lengths on the late frames …
    expect(depth(N - 1)).toBeGreaterThan(0.05 * 150 * 2);
    // … but the body does not lift, so no jump, and no step: one support throughout.
    expect(linesOf(r, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): none');
    expect(linesOf(r, 'FEET')).toContain('FEET   supports: r 0–23');
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { jumps: unknown; steps: unknown } };
    expect(rep.feet.jumps).toEqual([]);
    expect(rep.feet.steps).toEqual([]);
  }, SLOW);

  test('a step: the supporting ankle moving > 0.03 leg lengths a frame is released, the other foot (6 px up) does not take support (#113), and it re-plants once still', () => {
    /** The right ankle (supporting: the left is 6 px up) slides 10 px left a frame on frames 8–10 (0.067 leg lengths a frame; its knee bends the way it bends at rest), then stays. */
    const slide = (i: number): number => -10 * Math.min(3, Math.max(0, i - 7));
    const stepPose = (both: boolean) => {
      const doc = legsPose(() => 1, (_, s) => (s === 'l' ? 6 : 0));
      const frames = doc.frames as Array<{ people: Array<{ joints: JointsDoc }> }>;
      frames.forEach((f, i) => {
        const j = f.people[0]!.joints;
        for (const s of both ? ['r', 'l'] : ['r']) {
          const a = j[`${s}_ankle`]!.at as Pt;
          j[`${s}_ankle`] = { ...j[`${s}_ankle`], at: [a[0] + slide(i), a[1]] };
        }
      });
      return doc;
    };
    const c = setup({ pose: stepPose(false) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // #113: the old assertion here (`r 8–11 → l supports`, `l 8–13`) was the bug — a 6 px-higher ankle took support.
    // Still on frames 11 and 12 (< 0.01): re-planted at 12, and the lower foot, it takes support there. #113: the left
    // ankle is 6 px (0.04 leg lengths) higher, so it does not take support on the step — before #113 it did (l 8–13);
    // the hip follows the pose's travel until the right foot is still.
    expect(linesOf(r, 'FEET')).toContain('FEET   steps (the supporting ankle > 0.03 leg lengths a frame; re-planted after 2 frames < 0.01): r 8–11 → the pose\'s travel, re-planted at 12');
    expect(linesOf(r, 'FEET')).toContain('FEET   supports: r 0–7, r 12–23');
    expect(linesOf(r, 'FEET')).toContain('FEET   support read from the lower ankle (a foot ≥ 0.02 leg lengths higher than the other does not take support, rig-c/pose#113): 4 frame(s) read differently from before — frames 8–11 l → none (the only foot free to take support was the higher one)');
    const p = posedLegs(c.build);
    expect(spread(p.ankle.r.slice(0, 8))).toBeLessThan(0.01);
    // Re-planted where it stepped to: held from the end of the blend on, well left of where it was (the rigid 70-unit
    // shin turned toward the 30 px the ankle slid; measured 15.9 units), not dragged back to its old anchor.
    expect(spread(p.ankle.r.slice(17))).toBeLessThan(0.01);
    expect(p.ankle.r[0]![0] - p.ankle.r[17]![0]).toBeGreaterThan(10);
    // Both feet stepping at once: nothing is planted, so the hip follows the pose's travel.
    const both = setup({ pose: stepPose(true) });
    const rb = retarget(both, ['--plant-feet']);
    expect(rb.status).toBe(0);
    expect(linesOf(rb, 'FEET').find((l) => l.startsWith('FEET   steps'))).toContain('r 8–11 → the pose\'s travel, re-planted at 12');
  }, SLOW);

  test('#92: travel "in-place" — the sliding foot is followed, not released; the loop is closed and reported; control: without it, today\'s step', () => {
    /** The right ankle (supporting: the left is 6 px up) slides 10 px left a frame on frames 8–10, then stays: a step's speed. */
    const slide = (i: number): number => -10 * Math.min(3, Math.max(0, i - 7));
    const doc = legsPose(() => 1, (_, s) => (s === 'l' ? 6 : 0));
    (doc.frames as Array<{ people: Array<{ joints: JointsDoc }> }>).forEach((f, i) => {
      const j = f.people[0]!.joints;
      const a = j.r_ankle!.at as Pt;
      j.r_ankle = { ...j.r_ankle, at: [a[0] + slide(i), a[1]] };
    });
    const c = setup({ pose: { ...doc, travel: 'in-place' } });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const feet = linesOf(r, 'FEET');
    expect(feet).toContain('FEET   supports: r 0–23');
    expect(feet.find((l) => l.startsWith('FEET   steps'))).toBeUndefined();
    expect(feet.find((l) => l.startsWith('FEET   in place (the sequence\'s travel "in-place"): each supporting foot follows its own ankle\'s picture x, scaled'))).toBeDefined();
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { steps: unknown; closure: { drift: number; frames: number } | null } };
    expect(rep.feet.steps).toEqual([]);
    expect(rep.feet.closure!.frames).toBe(N);
    const p = posedLegs(c.build);
    // Closed, as rig-c poses the build: the last frame's hip x is the first's.
    expect(Math.abs(p.hip[N - 1]![0] - p.hip[0]![0])).toBeLessThan(0.01);
    // The right ankle follows its track: 30 px left in the picture, 45 units on the rig (scale 1.5), less the closure's share.
    const moved = p.ankle.r[N - 1]![0] - p.ankle.r[0]![0];
    expect(Math.abs(moved - (-45 - rep.feet.closure!.drift))).toBeLessThan(0.01);
    // #113: the old assertion here (`r 8–11 → l supports`) was the bug — a 6 px-higher ankle took support.
    // Control: the same joints without the declaration read today's step (the left, 6 px up, not taking support: #113) and print no closure.
    const today = setup({ pose: doc });
    const rt = retarget(today, ['--plant-feet', '--report', report]);
    expect(rt.status).toBe(0);
    expect(linesOf(rt, 'FEET')).toContain('FEET   steps (the supporting ankle > 0.03 leg lengths a frame; re-planted after 2 frames < 0.01): r 8–11 → the pose\'s travel, re-planted at 12');
    expect((JSON.parse(readFileSync(report, 'utf8')) as { feet: { closure: unknown } }).feet.closure).toBeNull();
  }, SLOW);

  test('a change of support: the other ankle lower for 0.1 s takes over from landing, the hip blends in y over 3 frames, and each foot holds while it supports', () => {
    /** The left foot 6 px up (0.04 leg lengths) until frame 7, then the right one — 3 px a frame (0.02 leg lengths: not a step). */
    const lift = (i: number, s: 'r' | 'l'): number => {
      const l = i < 8 ? 6 : i === 8 ? 3 : 0;
      return s === 'l' ? l : 6 - l;
    };
    const c = setup({ pose: legsPose(() => 1, lift) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // Lower (by 6 px) from frame 9; 0.1 s is reached on frame 11 (frames 9–11 last 0.125 s, 9–10 0.083 s), so it takes support from frame 9 (#102).
    expect(linesOf(r, 'FEET')).toContain('FEET   supports: r 0–8, l 9–23');
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { changes: unknown; steps: unknown } };
    expect(legacyReportRows(rep.feet.changes, ['t'])).toEqual([{ frame: 0, from: null, to: 'r' }, { frame: 9, from: 'r', to: 'l' }]);
    expect(rep.feet.steps).toEqual([]);
    const p = posedLegs(c.build);
    expect(spread(p.ankle.r.slice(0, 9))).toBeLessThan(0.01);
    expect(spread(p.ankle.l.slice(9))).toBeLessThan(0.01);
    // Control: lower on one frame only (9), short of 0.1 s, changes nothing.
    const once = (i: number): number => (i < 8 || i > 10 ? 6 : i === 9 ? 0 : 3);
    const short = setup({ pose: legsPose(() => 1, (i, s) => (s === 'l' ? once(i) : 6 - once(i))) });
    const rs = retarget(short, ['--plant-feet']);
    expect(rs.status).toBe(0);
    expect(linesOf(rs, 'FEET')).toContain('FEET   supports: r 0–23');
  }, SLOW);

  test('PIVOT: the hip\'s origin against its thigh roots\' midpoint, in units and hip widths', () => {
    const c = setup();
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'PIVOT')[0]).toStartWith('PIVOT  bone "hip"\'s origin is 0.00 units (0.000 hip widths) from its thigh roots\' midpoint (leg_r0 + leg_l0)');
    const off = setup({ rig: { bones: (bs) => bs.map((b) => (b.name.startsWith('leg_') && b.name.endsWith('0') ? { ...b, y: -10 } : b)) } });
    const ro = retarget(off);
    expect(ro.status).toBe(0);
    expect(linesOf(ro, 'PIVOT')[0]).toContain('is 10.00 units (0.333 hip widths)');
  }, SLOW);

  test('--leg-scale takes off or min,max with 0 < min ≤ 1 ≤ max; anything else is exit 2', () => {
    const c = setup();
    for (const v of ['0.8', '1.1,1.2', '0,1', '0.8,0.9', 'a,b']) {
      const r = retarget(c, ['--leg-scale', v]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--leg-scale is "${v}"`);
    }
  }, SLOW);

  test('LEGS_MAP: --plant-feet with no chain ending at an ankle is refused by name', () => {
    const map = { ...baseMap(), chains: baseChains().filter((x) => x.name !== 'leg_l') };
    const c = setup({ map });
    const r = retarget(c, ['--plant-feet']);
    expect(r.status).toBe(1);
    expect(fails(r)).toContain('FAIL  LEGS_MAP: --plant-feet needs one chain ending at "l_ankle" (its last bone\'s x axis ends at the ankle); the map has none');
    // Control: the same map reads, without the flag.
    expect(retarget(c).status).toBe(0);
  }, SLOW);

  describe('#85: --plant-feet puts every support span on one floor', () => {
    /** 36 frames: three support spans of 12, the figure still within each. */
    const N85 = 36;
    const M85: Motion = { ...STILL, n: N85 };
    /**
     * The whole figure moved by `at(i)` px: frames 0–11 by `a`, 12–23 by `b`, 24–35 by `c`. Each move is ≥ 5 px
     * (0.033 leg lengths, a step: both ankles released, the hip on the pose's travel for a frame, then re-planted
     * where the picture puts it); every pair is within 6 px, under the 0.05 leg lengths (7.5 px) a jump rises.
     */
    const moved = (a: Pt, b: Pt, c: Pt) => poseDoc(M85, (i, j) => {
      const d = i < 12 ? a : i < 24 ? b : c;
      for (const [name, at] of Object.entries(j)) j[name] = { ...at, at: [(at.at as Pt)[0] + d[0], (at.at as Pt)[1] + d[1]] };
    });
    /** Three picture heights: 0, 6 px lower, 1 px lower (y down). */
    const threeHeights = () => moved([0, 0], [0, 6], [0, 1]);
    /** One height: the same moves made sideways. */
    const oneHeight = () => moved([0, 0], [6, 0], [1, 0]);
    /** Each ankle's world position on every frame of the gated build, posed by rig-c. */
    function ankles85(build: string): { r: Pt[]; l: Pt[] } {
      const poses = poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: N85 - 1 }, () => DT), {}, 'animation');
      const out = { r: [] as Pt[], l: [] as Pt[] };
      for (const p of poses) {
        const b = byName(p.bones);
        for (const s of ['r', 'l'] as const) {
          const shin = b.get(`leg_${s}1`)!;
          out[s].push([shin.worldX + shin.a * 70, shin.worldY + shin.c * 70]);
        }
      }
      return out;
    }
    interface Report85 { feet: { supports: Array<{ side: 'r' | 'l'; frames: [number, number] }>; floor: number | null; shifts: Array<{ side: string; frames: number[]; shift: number }> } }
    /** Each span's supporting ankle's world y on every frame of the span, blend frames included, posed by rig-c. */
    function plantedYs(build: string, report: string): number[][] {
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
      const a = ankles85(build);
      return rep.feet.supports.map((sp) => {
        const ys: number[] = [];
        for (let i = sp.frames[0]; i <= sp.frames[1]; i++) ys.push(a[sp.side][i]![1]);
        return ys;
      });
    }
    /** Each span's supporting ankle's world x on every frame of the span, blend frames included, posed by rig-c. */
    function plantedXs(build: string, report: string): number[][] {
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
      const a = ankles85(build);
      return rep.feet.supports.map((sp) => {
        const xs: number[] = [];
        for (let i = sp.frames[0]; i <= sp.frames[1]; i++) xs.push(a[sp.side][i]![0]);
        return xs;
      });
    }
    const spreadOf = (yss: number[][]): number => Math.max(...yss.flat()) - Math.min(...yss.flat());
    /** The tolerance the landing check holds an ankle to: 0.01 units plus 1e-4 of the 150-unit leg. */
    const FLOOR_TOL = 0.01 + 1e-4 * LEG;

    /** The three-heights test against a CLI: the spans read, and their planted ankles' spread across spans, world units. */
    function threeHeightsRun(cliPath: string): { status: number; supports: string[]; spread: number; perSpan: number[] } {
      const c = setup({ pose: threeHeights() });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report], cliPath);
      if (r.status !== 0) return { status: r.status, supports: [], spread: NaN, perSpan: [] };
      const yss = plantedYs(c.build, report);
      return { status: r.status, supports: linesOf(r, 'FEET').filter((l) => l.startsWith('FEET   supports')), spread: spreadOf(yss), perSpan: yss.map((ys) => Math.max(...ys) - Math.min(...ys)) };
    }

    test('three picture heights: every span\'s supporting ankle lands on one floor, posed by rig-c; FEET and the report give the shifts', () => {
      const c = setup({ pose: threeHeights() });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      // Three spans, each starting after a step (both ankles moved ≥ 5 px), and no jump.
      expect(linesOf(r, 'FEET')).toContain('FEET   supports: r 0–11, l 13–23, r 25–35');
      expect(linesOf(r, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): none');
      // Held where the picture puts them, the spans would sit 0, 9 and 1.5 units lower (6 px and 1 px × the figure scale 1.5):
      // the floor is their median, and each shift is floor − its height.
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
      expect(rep.feet.shifts.map((x) => [x.side, x.frames])).toEqual([['r', [0, 11]], ['l', [13, 23]], ['r', [25, 35]]]);
      const shifts = rep.feet.shifts.map((x) => x.shift);
      expect(shifts[0]!).toBeCloseTo(-1.5, 3);
      expect(shifts[1]!).toBeCloseTo(7.5, 3);
      expect(shifts[2]!).toBeCloseTo(0, 3);
      // Independently: every span's supporting ankle at one world y, and that y is the report's floor.
      const yss = plantedYs(c.build, report);
      expect(spreadOf(yss)).toBeLessThan(FLOOR_TOL);
      for (const ys of yss) for (const y of ys) expect(Math.abs(y - rep.feet.floor!)).toBeLessThan(FLOOR_TOL);
      // Both ankles land where the keys put them, by the package's own check.
      expect(linesOf(r, 'LAND').filter((l) => l.includes(' ankle — '))).toHaveLength(2);
      const line = linesOf(r, 'FEET').find((l) => l.startsWith('FEET   floor:'))!;
      expect(line).toContain(`floor: world y ${rep.feet.floor!.toFixed(2)} (the median of the 3 support span(s)' planted heights)`);
      expect(line).toContain('r 0–11 −1.50 (−0.0100), l 13–23 +7.50 (+0.0500), r 25–35 +0.00 (+0.0000); range −1.50 … +7.50 units = 0.0601 leg lengths');
    }, SLOW);

    test('--floor <y> puts every span on that world y; without --plant-feet, or not a number, it is exit 2', () => {
      const c = setup({ pose: threeHeights() });
      const report = join(c.dir, 'report.json');
      const r0 = retarget(c, ['--plant-feet', '--report', report]);
      expect(r0.status).toBe(0);
      const y = (JSON.parse(readFileSync(report, 'utf8')) as Report85).feet.floor! + 10;
      const r = retarget(c, ['--plant-feet', '--floor', String(y), '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
      expect(rep.feet.floor).toBe(y);
      expect(linesOf(r, 'FEET').find((l) => l.startsWith('FEET   floor:'))).toContain('(given by --floor)');
      for (const ys of plantedYs(c.build, report)) for (const v of ys) expect(Math.abs(v - y)).toBeLessThan(FLOOR_TOL);
      const no = retarget(c, ['--floor', '0']);
      expect(no.status).toBe(2);
      expect(no.stderr).toContain('--floor is "0" without --plant-feet');
      const nan = retarget(c, ['--plant-feet', '--floor', 'low']);
      expect(nan.status).toBe(2);
      expect(nan.stderr).toContain('--floor is "low"; it must be a world y in rig units (a finite number)');
    }, SLOW);

    test('mutant: the shift forced to 0 leaves the spans where the picture puts them, and the three-heights test is red; control: one height writes the same bytes as the mutant', () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'legs.ts');
        const from = 'const placed = placeHip(feet, offset, travel, start, y, follow);';
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, 'const placed = placeHip(feet, offset, travel, start, null, follow);'));
        const mutant = threeHeightsRun(join(d, 'cli.ts'));
        const pkg = threeHeightsRun(CLI);
        console.log(`  mutant "shift forced to 0": exit ${mutant.status}, planted ankles spread ${mutant.spread.toFixed(3)} units across spans (package ${pkg.spread.toFixed(4)})`);
        expect(pkg.spread).toBeLessThan(FLOOR_TOL);
        // Red: the same spans read, each held flat, but at three heights 9 units apart.
        expect(mutant.status).toBe(0);
        expect(mutant.supports).toEqual(pkg.supports);
        for (const s of mutant.perSpan) expect(s).toBeLessThan(FLOOR_TOL);
        expect(mutant.spread >= FLOOR_TOL).toBe(true);
        expect(mutant.spread).toBeCloseTo(9, 2);
        // Control: one picture height (the same steps, made sideways) — the shifts are 0 within 1e-5 units, and the motion is
        // byte-identical to the mutant's, which is the hip as it was before the floor.
        const one = setup({ pose: oneHeight() });
        const report = join(one.dir, 'report.json');
        const r = retarget(one, ['--plant-feet', '--report', report]);
        expect(r.status).toBe(0);
        const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
        expect(rep.feet.shifts).toHaveLength(3);
        for (const x of rep.feet.shifts) expect(Math.abs(x.shift)).toBeLessThan(1e-5);
        const ours = readFileSync(one.out, 'utf8');
        const rm = retarget(one, ['--plant-feet'], join(d, 'cli.ts'));
        expect(rm.status).toBe(0);
        expect(readFileSync(one.out, 'utf8')).toBe(ours);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);

    test('the blend: the supporting ankle stays on the floor and on its horizontal anchor while the hip blends, its leg stretched and landing-checked; mutants: without the stretch it leaves the floor, and without the horizontal compensation an angled leg drifts sideways', () => {
      const c = setup({ pose: threeHeights() });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      // The landing after each step blends the hip over frames 13–15 and 25–27, between two derivations 9 and 7.5 units apart.
      const held = linesOf(r, 'FEET').filter((l) => l.startsWith('FEET   blend held on the floor:'));
      expect(held).toHaveLength(2);
      expect(held[0]).toStartWith('FEET   blend held on the floor: supporting foot l frames 13–15 (t=0.542–0.625s)');
      expect(held[1]).toStartWith('FEET   blend held on the floor: supporting foot r frames 25–27');
      expect(linesOf(r, 'FEET').filter((l) => l.startsWith('FEET   past the bounds'))).toEqual([]);
      // The stretched scales are scale targets: the landing check holds all four.
      expect(linesOf(r, 'LAND').filter((l) => l.includes(' scale — '))).toHaveLength(4);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85 & { feet: { blend: { runs: Array<{ side: string; frames: number[] }>; over: unknown[] } } };
      expect(rep.feet.blend.runs.map((x) => [x.side, x.frames])).toEqual([['l', [13, 15]], ['r', [25, 27]]]);
      expect(rep.feet.blend.over).toEqual([]);
      for (const ys of plantedYs(c.build, report)) for (const y of ys) expect(Math.abs(y - rep.feet.floor!)).toBeLessThan(FLOOR_TOL);
      for (const xs of plantedXs(c.build, report)) expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(FLOOR_TOL);

      // Angled supporting legs (60° below horizontal: horizontal reach 75 units, vertical 130 units, k within [0.92, 1.08]):
      // stretching the chain along its bone axis scales its horizontal reach from the thigh root too, and the hip's x
      // compensation keeps the planted ankle on its horizontal anchor within FLOOR_TOL.
      const angled: Motion = { ...M85, rt: () => -60, rs: () => -60, lt: () => -120, ls: () => -120 };
      const angledPose = () => poseDoc(angled, (i, j) => {
        const d: Pt = i < 12 ? [0, 0] : i < 24 ? [0, 6] : [0, 1];
        for (const [name, at] of Object.entries(j)) j[name] = { ...at, at: [(at.at as Pt)[0] + d[0], (at.at as Pt)[1] + d[1]] };
      });
      const ca = setup({ pose: angledPose() });
      const areport = join(ca.dir, 'report.json');
      expect(retarget(ca, ['--plant-feet', '--report', areport]).status).toBe(0);
      for (const xs of plantedXs(ca.build, areport)) expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(FLOOR_TOL);

      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'retarget.ts');
        const from = '    stretchChain(blendHold.stretch);\n';
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, ''));
        const m = setup({ pose: threeHeights() });
        const mreport = join(m.dir, 'report.json');
        const rm = retarget(m, ['--plant-feet', '--report', mreport], join(d, 'cli.ts'));
        expect(rm.status).toBe(0);
        const floorY = (JSON.parse(readFileSync(mreport, 'utf8')) as Report85).feet.floor!;
        const worst = Math.max(...plantedYs(m.build, mreport).flat().map((y) => Math.abs(y - floorY)));
        console.log(`  mutant "no stretch on the blend": the supporting ankle up to ${worst.toFixed(3)} units off the floor`);
        // Red: on the first blend frame the ankle is 0.75 of the 9 units off.
        expect(worst >= FLOOR_TOL).toBe(true);
        expect(worst).toBeCloseTo(6.75, 1);

        // Second mutant: keep the stretch, remove the horizontal dx compensation on the hip.
        const fromDx = '      hip[i]![0] += dx;\n      travel[i]![0] += dx;\n';
        expect(before.split(fromDx)).toHaveLength(2);
        writeFileSync(path, before.replace(fromDx, ''));
        const ma = setup({ pose: angledPose() });
        const mareport = join(ma.dir, 'report.json');
        const rma = retarget(ma, ['--plant-feet', '--report', mareport], join(d, 'cli.ts'));
        expect(rma.status).toBe(0);
        const worstX = Math.max(...plantedXs(ma.build, mareport).map((xs) => Math.max(...xs) - Math.min(...xs)));
        console.log(`  mutant "no horizontal anchor compensation on the blend": the supporting ankle drifts ${worstX.toFixed(3)} units sideways`);
        expect(worstX).toBeGreaterThan(3);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);

    test('past the bounds: a blend the stretch cannot cover within [0.92, 1.08] is held at the bound, listed, and the rest is left to the blend', () => {
      /** Legs splayed straight 30° below the horizontal: the ankle 75 units under the root, so 7 px (10.5 units) between spans needs k past 1.08 on the first blend frame. */
      const splayed: Motion = { ...M85, rt: () => -30, rs: () => -30, lt: () => -150, ls: () => -150 };
      const pose = poseDoc(splayed, (i, j) => {
        const d: Pt = i < 12 ? [0, 0] : i < 24 ? [0, 7] : [0, 0];
        for (const [name, at] of Object.entries(j)) j[name] = { ...at, at: [(at.at as Pt)[0] + d[0], (at.at as Pt)[1] + d[1]] };
      });
      const c = setup({ pose });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const past = linesOf(r, 'FEET').filter((l) => l.startsWith('FEET   past the bounds:'));
      expect(past.length).toBeGreaterThan(0);
      expect(past[0]).toMatch(/^FEET {3}past the bounds: supporting foot [rl] frame 1[3-5] \(t=[0-9.]+s\) — the floor needed k (1\.(0[89]|[1-9])|0\.([0-8]|9[01]))\d*, past \[0\.92, 1\.08\]; held at the bound, the foot left up to [0-9.]+ units from the floor$/);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { blend: { runs: Array<{ k: { min: number; max: number } }>; over: Array<{ frames: number[]; left: number }> } } };
      expect(rep.feet.blend.over.length).toBeGreaterThan(0);
      expect(rep.feet.blend.over[0]!.left).toBeGreaterThan(FLOOR_TOL);
      // Held at the bound, not forced: a run's stretch reaches the bound and goes no further.
      const ks = rep.feet.blend.runs.flatMap((x) => [x.k.min, x.k.max]);
      expect(ks.some((k) => k === 1.08 || k === 0.92)).toBe(true);
      for (const k of ks) expect(k >= 0.92 && k <= 1.08).toBe(true);
      expect(linesOf(r, 'LAND').filter((l) => l.includes(' scale — '))).toHaveLength(4);
    }, SLOW);
  });

  describe('#60: --stance plants both feet when the free ankle is within the tolerance of the floor', () => {
    /** The picture leg, hip → ankle at full length, px: FEET's leg length when most frames are unlifted. */
    const PIC = Math.hypot(V[0], V[1]);
    /** The left ankle (free: the right is lower) lifted by `legs` of FEET's leg length on frames 8–15; under half the frames, so the median leg length stays PIC. */
    const lifted = (legs: number) => legsPose(() => 1, (i, s) => (s === 'l' && i >= 8 && i <= 15 ? legs * PIC : 0));
    const FLAGS = ['--leg-scale', '0.8,1.05', '--plant-feet'];
    /** The foot's tolerance in the landing check: 0.01 units plus 1e-4 of the 150-unit leg. */
    const PLANT_TOL = 0.01 + 1e-4 * LEG;
    const LIFT = [8, 9, 10, 11, 12, 13, 14, 15];

    /** The lift test: on the lifted frames, the left ankle is where the run without --stance puts it (the pose's height kept), and above the right. */
    function liftKept(cliPath: string): { status: number; stance: string[]; worst: number; above: number } {
      const c = setup({ pose: lifted(0.15) });
      const plain = retarget(c, FLAGS);
      expect(plain.status).toBe(0);
      const before = posedLegs(c.build);
      const r = retarget(c, [...FLAGS, '--stance', '0.07'], cliPath);
      const after = posedLegs(c.build);
      let worst = 0;
      let above = Infinity;
      for (const i of LIFT) {
        worst = Math.max(worst, Math.hypot(after.ankle.l[i]![0] - before.ankle.l[i]![0], after.ankle.l[i]![1] - before.ankle.l[i]![1]));
        above = Math.min(above, after.ankle.l[i]![1] - after.ankle.r[i]![1]);
      }
      return { status: r.status, stance: linesOf(r, 'STANCE'), worst, above };
    }

    test('a lift of 0.15 leg lengths stays a lift: the foot keeps the pose\'s height, and STANCE lists it', () => {
      const k = liftKept(CLI);
      expect(k.status).toBe(0);
      expect(k.stance).toHaveLength(3);
      expect(k.stance[0]).toStartWith('STANCE planted both: free foot l frames 0–7 (t=0.000–0.292s)');
      expect(k.stance[1]).toStartWith('STANCE lifted: free foot l frames 8–15 (t=0.333–0.625s) — its ankle up to 0.1500 leg lengths above the supporting one in the picture, over the tolerance 0.07 leg lengths (planted again under 0.8 of it, 0.0560); the pose\'s height kept');
      expect(k.stance[2]).toStartWith('STANCE planted both: free foot l frames 16–23');
      expect(k.worst).toBeLessThan(1e-3);
      // The lift shows on the rig (the shin scaled 0.8 at its clamp: 0.2 of its 70 units, along a near-vertical shin).
      expect(k.above).toBeGreaterThan(10);
    }, SLOW);

    test('0.03 leg lengths is planted both: the posed foot lands on the floor within the plant tolerance, and the stretch is held by the landing check', () => {
      const c = setup({ pose: lifted(0.03) });
      const plain = retarget(c, FLAGS);
      expect(plain.status).toBe(0);
      const before = posedLegs(c.build);
      const gap = Math.max(...LIFT.map((i) => before.ankle.l[i]![1] - before.ankle.r[i]![1]));
      // Control: without --stance the free foot floats.
      expect(gap).toBeGreaterThan(1);
      const report = join(c.dir, 'report.json');
      const r = retarget(c, [...FLAGS, '--stance', '0.07', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const st = linesOf(r, 'STANCE');
      expect(st).toHaveLength(1);
      expect(st[0]).toStartWith('STANCE planted both: free foot l frames 0–23 (t=0.000–0.958s) — its ankle up to 0.0300 leg lengths above the supporting one in the picture, within the tolerance 0.07 leg lengths; its leg stretched by k ');
      const kmax = Number(/\(largest ([0-9.]+)\)/.exec(st[0]!)![1]);
      expect(kmax).toBeGreaterThan(1);
      expect(kmax).toBeLessThan(1.08);
      // Every scale, both ankles and the hip land, by the package's own check; the stretched scales are the targets.
      expect(linesOf(r, 'LAND').filter((l) => l.includes(' scale — '))).toHaveLength(4);
      const after = posedLegs(c.build);
      for (const i of LIFT) expect(Math.abs(after.ankle.l[i]![1] - after.ankle.r[i]![1])).toBeLessThan(PLANT_TOL);
      // The supporting foot does not move for it.
      for (let i = 0; i < N; i++) expect(Math.hypot(after.ankle.r[i]![0] - before.ankle.r[i]![0], after.ankle.r[i]![1] - before.ankle.r[i]![1])).toBeLessThan(1e-3);
      // Independently: the left thigh's world length is its leg scale times k on a lifted frame.
      expect(after.len.leg_l0![10]! / before.len.leg_l0![10]!).toBeGreaterThan(1.01);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { options: { stance: unknown }; stance: { tolerance: number; bounds: number[]; runs: Array<{ state: string; side: string; frames: number[] }>; over: unknown[] } };
      expect(rep.options.stance).toBe(0.07);
      expect(rep.stance.tolerance).toBe(0.07);
      expect(rep.stance.bounds).toEqual([0.92, 1.08]);
      expect(rep.stance.runs.map((x) => [x.state, x.side, x.frames])).toEqual([['both', 'l', [0, 23]]]);
      expect(rep.stance.over).toEqual([]);
    }, SLOW);

    test('a difference that needs k > 1.08 is reported past the bounds, held at the bound, and not forced', () => {
      const c = setup({ pose: lifted(0.15) });
      const r = retarget(c, [...FLAGS, '--stance', '0.2']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const st = linesOf(r, 'STANCE');
      expect(st[0]).toContain('(largest 1.0800)');
      const over = st.filter((l) => l.startsWith('STANCE past the bounds: free foot l frames 8–15'));
      expect(over).toHaveLength(1);
      // #95: the lifted picture leg is folded, so its frames' lower bound is that fold (below 0.92); the upper stays 1.08.
      expect(over[0]).toMatch(/the floor needed k 1\.(0[89]|[1-9])\d*, past \[0\.\d{4}, 1\.08\]; held at the bound, the foot left up to [1-9][0-9.]* units from the floor/);
      const after = posedLegs(c.build);
      for (const i of LIFT) expect(after.ankle.l[i]![1] - after.ankle.r[i]![1]).toBeGreaterThan(PLANT_TOL);
    }, SLOW);

    test('--stance without --plant-feet is refused by name; anything but off or (0, 1) is exit 2', () => {
      const c = setup();
      const r = retarget(c, ['--stance', '0.07']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--stance is "0.07" without --plant-feet');
      for (const v of ['0', '1', '-0.1', 'a']) {
        const b = retarget(c, ['--plant-feet', '--stance', v]);
        expect(b.status).toBe(2);
        expect(b.stderr).toContain(`--stance is "${v}"; it must be off, or leg lengths in (0, 1)`);
      }
    }, SLOW);

    test('mutant: without the tolerance check every free leg is stretched, and the lift test is red', () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'legs.ts');
        const from = '(planted ? Math.abs(read[k]!.height) > tolerance :';
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, '(planted ? Math.abs(read[k]!.height) > Infinity :'));
        const k = liftKept(join(d, 'cli.ts'));
        const red = k.worst >= 1e-3 || !k.stance.some((l) => l.startsWith('STANCE lifted: free foot l frames 8–15'));
        console.log(`  mutant "no tolerance check": exit ${k.status}, lifted foot moved ${k.worst.toFixed(3)} units; STANCE ${k.stance.join(' | ').slice(0, 160)}`);
        expect(red).toBe(true);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  });

  describe('#94: --reduce composes with --leg-scale, --plant-feet and --stance', () => {
    /** The picture leg, hip → ankle at full length, px. */
    const PIC = Math.hypot(V[0], V[1]);
    /** Knees bending toward the camera (scaled legs, the hip planted over them) and the left, free ankle 0.03 leg lengths up on frames 8–15: --stance plants it, its leg stretched. */
    const gait = () => legsPose(bendF, (i, s) => (s === 'l' && i >= 8 && i <= 15 ? 0.03 * PIC : 0));
    const FLAGS = ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'];
    /** The landing check's foot tolerance without --reduce: 0.01 units plus 1e-4 of the 150-unit leg. */
    const PLANT_TOL = 0.01 + 1e-4 * LEG;
    /** Every key of every track of the animation. */
    const keysIn = (path: string) => motionOf(path).animations.dance!.tracks.reduce((s, t) => s + t.keys.length, 0);
    /** The free (left) ankle against the supporting (right) one on the stance frames, world y: the floor the stance plants it on. */
    const floorGap = (p: Posed) => Math.max(...Array.from({ length: N }, (_, i) => Math.abs(p.ankle.l[i]![1] - p.ankle.r[i]![1])));

    test('reduced last, on the final keys: the gate green; every bone, scale and ankle lands; the keys drop; each ankle and scale within its stated bound of the dense run', () => {
      const c = setup({ pose: gait() });
      const plain = retarget(c, FLAGS);
      expect(plain.status).toBe(0);
      expect(linesOf(plain, 'STANCE')[0]).toStartWith('STANCE planted both: free foot l frames 0–23');
      const dense = posedLegs(c.build);
      const before = keysIn(c.out);
      expect(floorGap(dense)).toBeLessThan(PLANT_TOL);
      const r = retarget(c, [...FLAGS, '--reduce', '1', '--reduce-hip', '0.5']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'GATE')[0]).toContain('green');
      const red = linesOf(r, 'REDUCE');
      // A rotate row per mapped bone, the hip, a scalex row per scaled bone, and the total.
      for (const b of ['leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
        expect(red.some((l) => l.startsWith(`REDUCE bone "${b}" rotate: 24 → `))).toBe(true);
        expect(red.some((l) => l.startsWith(`REDUCE bone "${b}" scalex: 24 → `))).toBe(true);
      }
      expect(red.some((l) => l.startsWith('REDUCE hip "hip" translate: 24 → '))).toBe(true);
      expect(red.at(-1)).toMatch(/^REDUCE rotate keys \d+ → \d+ \([0-9.]+×\) within 1°; scalex keys 96 → \d+ within 0\.00005 of the setup length$/);
      const lands = linesOf(r, 'LAND');
      expect(lands.filter((l) => l.includes(' scale — '))).toHaveLength(4);
      expect(lands.filter((l) => l.includes(' ankle — '))).toHaveLength(2);
      expect(keysIn(c.out)).toBeLessThan(before);
      const after = posedLegs(c.build);
      // Independently, posed by rig-c: every scaled bone's world length within 1e-4 of the dense run's …
      for (let i = 0; i < N; i++) for (const n of Object.keys(after.len)) expect(Math.abs(after.len[n]![i]! - dense.len[n]![i]!)).toBeLessThan(1e-4);
      // … each ankle within the stated bound of the dense run's (the hip's 0.5, plus the leg's 150 units × the largest scale × (1° + 5e-5)) …
      const bound = 0.5 + 150 * 1.08 * (RAD + 5e-5);
      for (const s of ['r', 'l'] as const) for (let i = 0; i < N; i++) expect(Math.hypot(after.ankle[s][i]![0] - dense.ankle[s][i]![0], after.ankle[s][i]![1] - dense.ankle[s][i]![1])).toBeLessThan(bound);
      // … and the planted free foot still on the supporting one's floor, within the tolerance its two ankles carry.
      expect(floorGap(after)).toBeLessThan(PLANT_TOL + 2 * bound);
    }, SLOW);

    test('the stated bound: the ankle\'s tolerance under --reduce is the plant\'s plus footReduce, printed on its LAND line', () => {
      const c = setup({ pose: gait() });
      const tolerances = (deg: string) => {
        const r = retarget(c, [...FLAGS, '--reduce', deg]);
        expect(r.status).toBe(0);
        const ankle = linesOf(r, 'LAND').filter((l) => l.includes(' ankle — '));
        expect(ankle).toHaveLength(2);
        return ankle.map((l) => Number(/the tolerance is ([0-9.]+) units$/.exec(l)![1]) - PLANT_TOL);
      };
      const a = tolerances('0.1');
      const b = tolerances('0.4');
      for (const [k, x] of a.entries()) {
        // A lever × the largest scale between the leg's 150 units and the hip-to-ankle path with its offset, …
        const lever = x / (0.1 * RAD + 5e-5);
        expect(lever).toBeGreaterThan(150);
        expect(lever).toBeLessThan(200 * 1.08);
        // … the same lever at four times the angle (the three printed digits allow 0.5 %).
        expect(Math.abs(b[k]! / (0.4 * RAD + 5e-5) / lever - 1)).toBeLessThan(5e-3);
      }
    }, SLOW);

    test('mutant: the scales reduced as they stood before the plant and the stance stretched them leave the free foot off the floor, and the run is refused naming that ankle', () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'run.ts');
        const from = 'const red = reduceScale(r.times, bone, r.scales.get(bone) ?? ';
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, 'const red = reduceScale(r.times, bone, r.legScale.find((l) => l.bone === bone)?.scale ?? r.scales.get(bone) ?? '));
        const c = setup({ pose: gait() });
        const m = retarget(c, [...FLAGS, '--reduce', '0.1'], join(d, 'cli.ts'));
        const foot = fails(m).find((l) => l.startsWith('FAIL  POSE_LANDS: bone "leg_l1:tip" ankle'));
        const gap = foot === undefined ? 0 : Number(/worst \|reached − asked\| ([0-9.e-]+) units/.exec(foot)![1]);
        console.log(`  mutant "reduce before the plant's stretch": exit ${m.status}; ${foot ?? fails(m)[0] ?? 'no refusal'}`);
        expect(m.status).toBe(1);
        // The floor row: the free ankle off where the stance planted it by more than the plant's tolerance and the reduction's bound together.
        expect(gap).toBeGreaterThan(PLANT_TOL + 150 * 1.08 * (0.1 * RAD + 5e-5));
        // Control: the package lands the same pose with the same flags.
        const ok = retarget(c, [...FLAGS, '--reduce', '0.1']);
        expect(ok.stderr).toBe('');
        expect(ok.status).toBe(0);
        expect(floorGap(posedLegs(c.build))).toBeLessThan(PLANT_TOL + 2 * 150 * 1.08 * (0.1 * RAD + 5e-5));
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  });
});

// ===========================================================================

describe('#43 item 2: the idle tracks a retarget drops, --carry-idle, --merge', () => {
  // The stick's idle (1 s): a bone scale track on "neck" (a raw curve, then a named easing), an
  // attachment track on a "face" slot (its last key before the idle's end, so a loop holds it), and
  // a rotate on "sleeve_r0", which the retarget keys itself. The card's pose runs 1.875 s, so the
  // second cycle is cut inside its eased segment.
  const D = 1;
  const T = (BASE.n - 1) * BASE.dt;
  const idle = {
    duration: D,
    tracks: [
      { bone: 'neck', property: 'scaley', keys: [{ t: 0, v: [1], curve: [0.2, 1, 0.3, 1.5] }, { t: 0.5, v: [1.5], ease: 'soft' }, { t: 1, v: [1] }] },
      { slot: 'face', property: 'attachment', keys: [{ t: 0, v: 'open' }, { t: 0.6, v: 'shut' }, { t: 0.8, v: 'open' }] },
      { bone: 'sleeve_r0', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 1, v: [10] }] },
    ],
  };
  const motion = { spec: 'rigc-motion/1', archetype: 'stick', cut: 'stick', easings: { soft: [0.25, 0.1, 0.25, 1] }, animations: { idle } };
  const rig: RigOpts = {
    motion,
    extraSlots: [{ name: 'face', bone: 'neck', attachment: 'open' }],
    extra: { face: { open: { image: 'seg.png' }, shut: { image: 'seg.png' } } },
  };
  const blink = (keys: Array<{ t: number; v: number[] }>, extra: Record<string, unknown> = {}) => ({ spec: 'rig-pose-tracks/1', tracks: [{ bone: 'neck', property: 'scalex', keys, ...extra }] });
  const writeFragment = (c: Case, doc: unknown): string => {
    const f = join(c.dir, 'blink.tracks.json');
    writeFileSync(f, JSON.stringify(doc, null, 2));
    return f;
  };
  /** Each time's pose of `anim` in the kept build, by rig-c's poser. */
  const poseAt = (build: string, anim: string, t: number) => {
    const p = poseRawAnimation(loadBuild(build), anim, t === 0 ? [] : [t]);
    return p[p.length - 1]!;
  };
  const neck = (build: string, anim: string, t: number, k: 'scaleX' | 'scaleY') => poseAt(build, anim, t).bones.find((b) => b.name === 'neck')![k];
  const face = (build: string, anim: string, t: number) => poseAt(build, anim, t).slots.find((row) => row[0] === 'face')![1];

  test('IDLE-DROPPED lists the bone scale and the slot attachment tracks; the retarget\'s own bone is IDLE-KEPT-OUT; the report says the same', () => {
    const c = setup({ rig });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'IDLE')).toEqual(['IDLE   animation "idle" (1.000s, 3 track(s)) against "dance": 2 dropped (not carried; --carry-idle loops them in), 1 kept out']);
    expect(linesOf(r, 'IDLE-DROPPED')).toEqual([
      'IDLE-DROPPED bone "neck" scaley: 3 key(s) over the idle\'s 1.000s; "dance" does not key it — not carried (no --carry-idle)',
      'IDLE-DROPPED slot "face" attachment: 3 key(s) over the idle\'s 1.000s; "dance" does not key it — not carried (no --carry-idle)',
    ]);
    expect(linesOf(r, 'IDLE-KEPT-OUT')).toEqual(['IDLE-KEPT-OUT bone "sleeve_r0" rotate: "dance"\'s own bone "sleeve_r0" rotate keys it, so the idle\'s track is not carried']);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { idleDropped: Array<{ target: unknown; property: string; keys: number; duration: number; carried: unknown }>; idleKeptOut: Array<{ target: unknown }> };
    expect(rep.idleDropped.map((d) => [d.target, d.property, d.keys, d.duration, d.carried])).toEqual([[{ kind: 'bone', name: 'neck' }, 'scaley', 3, 1, null], [{ kind: 'slot', name: 'face' }, 'attachment', 3, 1, null]]);
    expect(rep.idleKeptOut.map((k) => k.target)).toEqual([{ kind: 'bone', name: 'sleeve_r0' }]);
  }, SLOW);

  test('everything off: the motion written is the plain retarget\'s, byte for byte, beside the idle', () => {
    const c = setup({ rig });
    expect(retarget(c).status).toBe(0);
    const plain = setup();
    expect(retarget(plain).status).toBe(0);
    const a = motionOf(c.out);
    const b = motionOf(plain.out);
    expect(JSON.stringify(a.animations.dance)).toBe(JSON.stringify(b.animations.dance));
    expect(readFileSync(c.out, 'utf8')).toBe(`${JSON.stringify({ ...motion, animations: { idle, dance: b.animations.dance } }, null, 2)}\n`);
  }, SLOW);

  test('--carry-idle loops both into "dance": rig-c\'s poser reads the idle at t mod 1 s in the second cycle and at the cut; the gate is green and every bone lands', () => {
    const c = setup({ rig });
    const r = retarget(c, ['--carry-idle']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'IDLE-DROPPED')).toEqual([
      'IDLE-DROPPED bone "neck" scaley: 3 key(s) over the idle\'s 1.000s; "dance" does not key it — carried: 5 key(s), 2 cycle(s), cut at 1.875s',
      'IDLE-DROPPED slot "face" attachment: 3 key(s) over the idle\'s 1.000s; "dance" does not key it — carried: 6 key(s), 2 cycle(s), cut at 1.875s',
    ]);
    expect(linesOf(r, 'GATE')[0]).toStartWith('GATE   rigc build --profile spine: green');
    expect(fails(r)).toEqual([]);
    expect(misses(c.build, BASE)).toEqual([]);
    const tracks = motionOf(c.out).animations.dance.tracks as unknown as RigcTrack[];
    const scale = tracks.find((t) => t.bone === 'neck')!;
    // The seam at 1 s is one key (the idle's last and first agree); the cut key at 1.875 s carries no ease.
    expect(scale.keys.map((k) => k.t)).toEqual([0, 0.5, 1, 1.5, T]);
    expect(scale.keys[1]!.ease).toBe('soft');
    // The segment the cut falls in: its named easing becomes the raw curve of its first part.
    expect(scale.keys[3]!.ease).toBeUndefined();
    expect(scale.keys[3]!.curve).toHaveLength(4);
    expect(Object.keys(scale.keys[4]!).sort()).toEqual(['t', 'v']);
    // The attachment's last key (0.8 s) holds to the cycle's end, and the next cycle opens at 1 s.
    expect(tracks.find((t) => t.slot === 'face')!.keys.map((k) => [k.t, k.v])).toEqual([[0, 'open'], [0.6, 'shut'], [0.8, 'open'], [1, 'open'], [1.6, 'shut'], [1.8, 'open']]);
    // Off the cut segment, the second cycle is the idle at t − 1 s.
    for (const t of [0.25, 0.75, 1.25, 1.45]) expect(Math.abs(neck(c.build, 'dance', t, 'scaleY') - neck(c.build, 'idle', t - Math.floor(t), 'scaleY'))).toBeLessThan(1e-5);
    // On it (1.5 s to the cut), against the idle's eased segment as a continuous cubic — "soft" from (0.5, 1.5) to (1, 1),
    // handles (0.625, 1.45) and (0.625, 1). rig-c draws a Bézier as Spine's polyline, so both the carried part and the
    // idle's whole segment sit off the cubic by that alone: measured, the carried ≤ 9.3e-4 and the idle's own up to
    // 2.6e-3 (at 0.875 s). The cut key itself is the cubic's value.
    const cubic = (t: number): number => {
      const bez = (p: [number, number, number, number], s: number) => (1 - s) ** 3 * p[0] + 3 * (1 - s) ** 2 * s * p[1] + 3 * (1 - s) * s * s * p[2] + s ** 3 * p[3];
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) if (bez([0.5, 0.625, 0.625, 1], (lo + hi) / 2) < t) lo = (lo + hi) / 2; else hi = (lo + hi) / 2;
      return bez([1.5, 1.45, 1, 1], lo);
    };
    for (const t of [1.6, 1.7, 1.8]) {
      expect(Math.abs(neck(c.build, 'dance', t, 'scaleY') - cubic(t - 1))).toBeLessThan(1.5e-3);
      expect(Math.abs(neck(c.build, 'idle', t - 1, 'scaleY') - cubic(t - 1))).toBeLessThan(3e-3);
    }
    expect(Math.abs(neck(c.build, 'dance', T, 'scaleY') - cubic(T - 1))).toBeLessThan(1e-5);
    for (const t of [0.3, 0.7, 0.9, 1.3, 1.65, 1.85]) expect(face(c.build, 'dance', t)).toBe(face(c.build, 'idle', t - Math.floor(t)));
    expect([0.7, 1.65].map((t) => face(c.build, 'dance', t))).toEqual(['shut', 'shut']);
    // Control: without the flag the face never shuts in "dance", and the neck keeps its setup scale.
    const off = setup({ rig });
    expect(retarget(off).status).toBe(0);
    expect(face(off.build, 'dance', 0.7)).toBe('open');
    expect(neck(off.build, 'dance', 1.25, 'scaleY')).toBeCloseTo(1, 6);
    expect(neck(c.build, 'dance', 1.25, 'scaleY')).toBeCloseTo(1.25, 4);
  }, SLOW);

  test('--merge: a blink fragment shows on its frames; a conflicting track and a late key are refused by name, nothing written', () => {
    const c = setup({ rig });
    const ok = writeFragment(c, blink([{ t: 0.5, v: [1] }, { t: 0.625, v: [0.2] }, { t: 0.75, v: [1] }]));
    const r = retarget(c, ['--merge', ok]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'MERGE')).toEqual([`MERGE  ${ok}: bone "neck" scalex, 3 key(s) at t=0.5–0.75s`]);
    expect([0.375, 0.5, 0.5625, 0.625, 0.75, 0.875].map((t) => Number(neck(c.build, 'dance', t, 'scaleX').toFixed(4)))).toEqual([1, 1, 0.6, 0.2, 1, 1]);

    const conflict = writeFragment(c, { spec: 'rig-pose-tracks/1', tracks: [{ bone: 'sleeve_r0', property: 'rotate', keys: [{ t: 0, v: [0] }] }] });
    const rc = retarget(c, ['--merge', conflict]);
    expect(rc.status).toBe(1);
    expect(fails(rc)).toEqual([`FAIL  MERGE_CONFLICT: ${conflict} tracks[0] (bone "sleeve_r0" rotate) — "dance" already keys it: bone "sleeve_r0" rotate; a fragment adds a track where nothing keys that target and property, it never replaces one`]);

    // The carried idle keys the neck's scaley: a fragment on it conflicts with that, by name.
    const onIdle = writeFragment(c, { spec: 'rig-pose-tracks/1', tracks: [{ bone: 'neck', property: 'scale', keys: [{ t: 0.5, v: [1, 0.2] }] }] });
    const ri = retarget(c, ['--merge', onIdle, '--carry-idle']);
    expect(ri.status).toBe(1);
    expect(fails(ri)[0]).toBe(`FAIL  MERGE_CONFLICT: ${onIdle} tracks[0] (bone "neck" scale) — "dance" already keys it: bone "neck" scaley; a fragment adds a track where nothing keys that target and property, it never replaces one`);

    const late = writeFragment(c, blink([{ t: 1.5, v: [1] }, { t: 2, v: [0.2] }]));
    const rl = retarget(c, ['--merge', late]);
    expect(rl.status).toBe(1);
    expect(fails(rl)).toEqual([`FAIL  MERGE_TIME: ${late} tracks[0] (bone "neck" scalex) keys[1] at t=2s is past "dance"'s duration 1.875s; a fragment's times are absolute, from the animation's start, within [0, 1.875]`]);

    const bad = writeFragment(c, { spec: 'rig-pose-tracks/0', tracks: [] });
    const rb = retarget(c, ['--merge', bad]);
    expect(rb.status).toBe(1);
    expect(fails(rb)[0]).toStartWith(`FAIL  MERGE_SPEC: ${bad}: "spec" is the string "rig-pose-tracks/0"`);
    expect(existsSync(c.out)).toBe(true); // the first, green run's
    rmSync(c.out);
    expect(retarget(c, ['--merge', conflict]).status).toBe(1);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('rigc\'s gate judges a merged track like any other: a bone the rig does not have is red', () => {
    const c = setup({ rig });
    const f = writeFragment(c, { spec: 'rig-pose-tracks/1', tracks: [{ bone: 'nose', property: 'scaley', keys: [{ t: 0, v: [1] }] }] });
    const r = retarget(c, ['--merge', f]);
    expect(r.status).toBe(1);
    expect(fails(r)[0]).toStartWith('FAIL  RIG_GATE: rigc build --profile spine is red with "dance" in');
    expect(fails(r).join('\n')).toContain('nose');
  }, SLOW);

  test('IDLE_NAME: --idle naming an animation the motion spec lacks, and --carry-idle on a rig with no idle, are refused by name', () => {
    const c = setup({ rig });
    const r = retarget(c, ['--idle', 'breathe']);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  IDLE_NAME: --idle "breathe" the rig's motion spec ${join(c.rig, 'motion.json')} has no animation "breathe" (it has idle); name the rig's idle with --idle`]);
    const bare = setup();
    const rb = retarget(bare, ['--carry-idle']);
    expect(rb.status).toBe(1);
    expect(fails(rb)[0]).toStartWith('FAIL  IDLE_NAME: --carry-idle reads the animation "idle", and the rig\'s motion spec — there is none');
    // Control: no idle and no flag is a line, not a refusal.
    const rc = retarget(bare);
    expect(rc.status).toBe(0);
    expect(linesOf(rc, 'IDLE')).toEqual(['IDLE   the rig has no motion spec; no idle read (--idle names another)']);
  }, SLOW);

  test('a rotate, scale or shear above a mapped bone is IDLE-KEPT-OUT; a translate of it is carried, and every bone lands', () => {
    // "chest_ctl" between the hip and the chest, as on @rig-c/parts rigs: its rotate would turn the chest and the arms
    // off their keys, its translate only moves them. "root" sits above the first mapped bone (the translated hip).
    const ctl: RigOpts = {
      ...rig,
      bones: (bs) => bs.flatMap((b) => (b.name === 'chest' ? [{ name: 'chest_ctl', parent: 'hip', x: 0, y: 75 }, { ...b, parent: 'chest_ctl', y: 0 }] : [b])),
      motion: { ...motion, animations: { idle: { duration: D, tracks: [
        { bone: 'chest_ctl', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 0.5, v: [8] }, { t: 1, v: [0] }] },
        { bone: 'chest_ctl', property: 'translatey', keys: [{ t: 0, v: [0] }, { t: 0.5, v: [6] }, { t: 1, v: [0] }] },
        { bone: 'root', property: 'shear', keys: [{ t: 0, v: [0, 0] }, { t: 1, v: [3, 0] }] },
        { bone: 'neck', property: 'scaley', keys: [{ t: 0, v: [1] }, { t: 0.5, v: [1.5] }, { t: 1, v: [1] }] },
      ] } } },
    };
    const c = setup({ rig: ctl });
    const r = retarget(c, ['--carry-idle']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'IDLE-KEPT-OUT')).toEqual([
      'IDLE-KEPT-OUT bone "chest_ctl" rotate: moves mapped bone(s) "chest", "sleeve_r0", "sleeve_r1", "sleeve_l0", "sleeve_l1" below it; the retarget\'s keys assume it at setup, so the idle\'s track is not carried',
      'IDLE-KEPT-OUT bone "root" shear: moves mapped bone(s) "chest", "sleeve_r0", "sleeve_r1", "sleeve_l0", "sleeve_l1", "leg_r0", "leg_r1", "leg_l0", "leg_l1", "hip" below it; the retarget\'s keys assume it at setup, so the idle\'s track is not carried',
    ]);
    expect(linesOf(r, 'IDLE-DROPPED').map((l) => l.replace(/:.*— /, ': … — '))).toEqual([
      'IDLE-DROPPED bone "chest_ctl" translatey: … — carried: 5 key(s), 2 cycle(s), cut at 1.875s',
      'IDLE-DROPPED bone "neck" scaley: … — carried: 5 key(s), 2 cycle(s), cut at 1.875s',
    ]);
    expect(fails(r)).toEqual([]);
    expect(linesOf(r, 'LAND').length).toBeGreaterThan(0);
    // The chest moves up and down with the idle, at t mod 1 s, and still points where the pose asks.
    expect(misses(c.build, BASE)).toEqual([]);
    const chestY = (anim: string, t: number) => poseAt(c.build, anim, t).bones.find((b) => b.name === 'chest')!.worldY - poseAt(c.build, anim, t).bones.find((b) => b.name === 'hip')!.worldY;
    const setupY = chestY('idle', 0);
    for (const t of [0.5, 1.25, 1.5, 1.75]) {
      const want = chestY('idle', t - Math.floor(t)) - setupY;
      expect(Math.abs(chestY('dance', t) - setupY - want)).toBeLessThan(1e-4);
    }
    expect(chestY('dance', 1.5) - setupY).toBeGreaterThan(5);
  }, SLOW);

  test('a translate above the translated hip is kept out (it would move the origin the retarget places), and the run lands', () => {
    const moved = { ...motion, animations: { idle: { duration: D, tracks: [{ bone: 'root', property: 'translatey', keys: [{ t: 0, v: [0] }, { t: 0.5, v: [20] }, { t: 1, v: [0] }] }] } } };
    const c = setup({ rig: { ...rig, motion: moved } });
    const r = retarget(c, ['--carry-idle']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'IDLE-KEPT-OUT').some((l) => l.includes('bone "root" translatey') && l.includes('moves the translated bone "hip" below it; the retarget places its origin'))).toBe(true);
    expect(misses(c.build, BASE)).toEqual([]);
  }, SLOW);

  test('loopTrack: a hold to the cycle\'s end, a setup key where the first key is late, a seam that jumps, and what it does not carry', () => {
    const tr = (keys: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): RigcTrack => ({ bone: 'b', property: 'rotate', keys, ...extra }) as unknown as RigcTrack;
    const late = loopTrack(tr([{ t: 0.2, v: [5] }, { t: 0.8, v: [9] }]), 1, 2.5, {}, () => [0]);
    if ('reason' in late) throw new Error(late.reason);
    expect(late.track.keys).toEqual([
      { t: 0.2, v: [5] }, { t: 0.8, v: [9], ease: 'stepped' },
      { t: 1, v: [0], ease: 'stepped' }, { t: 1.2, v: [5] }, { t: 1.8, v: [9], ease: 'stepped' },
      { t: 2, v: [0], ease: 'stepped' }, { t: 2.2, v: [5] }, { t: 2.5, v: [7] },
    ]);
    expect(late.cycles).toBe(3);
    const jump = loopTrack(tr([{ t: 0, v: [0] }, { t: 1, v: [4] }]), 1, 1.5, {}, () => undefined);
    if ('reason' in jump) throw new Error(jump.reason);
    expect(jump.track.keys).toEqual([{ t: 0, v: [0] }, { t: 1, v: [0] }, { t: 1.5, v: [2] }]);
    expect(jump.seams).toBe('the idle\'s last key (t=1s, [4]) is not what it shows at its start ([0]); the loop keys the start at each seam, so it jumps at t=1.000s');
    expect(loopTrack(tr([{ t: 0, v: [0] }], { lag: 0.1 }), 1, 2, {}, () => undefined)).toEqual({ reason: 'it carries "lag", which shifts its keys per track or per member; a loop is cut by key time, so it is not carried' });
    expect('reason' in loopTrack({ slot: 's', property: 'rgba', keys: [{ t: 0.5, v: [1, 1, 1, 1] }] } as RigcTrack, 1, 2, {}, () => undefined)).toBe(true);
  });
});

// ===========================================================================

/** A longer, smooth dance for --reduce: 48 frames at 24 fps, every hinge on its rest side as in BASE. */
const SMOOTH: Motion = {
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
const REDUCE_MUTANT = {
  from: 'const targets = b.dense.map((d, i) => [eAbove === null ? d : d - eAbove[i]!]);',
  to: 'const targets = b.dense.map((d) => [d]);',
};

/** Pose the gated build at the frame times and return the worst world error per mapped bone (degrees) and of the hip's origin (units), against the known motion. */
function worstErrors(build: string, m: Motion): Map<string, number> {
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
const keysOf = (path: string, bone: string, property: string) => motionOf(path).animations.dance!.tracks.find((t) => t.bone === bone && t.property === property)!.keys as Array<{ t: number; v: number[]; curve?: number[] }>;

describe('--reduce: few keys with curves within a stated tolerance (rig-c/pose#32)', () => {
  test('every bone stays within the tolerance of the known angles on every frame, posed by rig-c; the keys drop; the hip stays dense without --reduce-hip', () => {
    const c = setup({ pose: poseDoc(SMOOTH) });
    const dense = retarget(c);
    expect(dense.status).toBe(0);
    const before = Object.keys(BONE_ANGLE).reduce((s, b) => s + keysOf(c.out, b, 'rotate').length, 0);
    expect(before).toBe(9 * 48);
    const r = retarget(c, ['--reduce', '1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const lines = linesOf(r, 'REDUCE');
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)).toContain('the hip stays dense (no --reduce-hip)');
    const after = Object.keys(BONE_ANGLE).reduce((s, b) => s + keysOf(c.out, b, 'rotate').length, 0);
    expect(after).toBeLessThan(before / 3);
    expect(lines.at(-1)).toContain(`rotate keys ${before} → ${after}`);
    expect(keysOf(c.out, 'hip', 'translate')).toHaveLength(48);
    for (const b of Object.keys(BONE_ANGLE)) {
      const keys = keysOf(c.out, b, 'rotate');
      expect(keys[0]!.t).toBe(0);
      expect(keys.at(-1)!.curve).toBeUndefined();
    }
    expect(Object.keys(BONE_ANGLE).some((b) => keysOf(c.out, b, 'rotate').some((k) => k.curve !== undefined))).toBe(true);
    const worst = worstErrors(c.build, SMOOTH);
    for (const b of Object.keys(BONE_ANGLE)) expect(worst.get(b)!).toBeLessThanOrEqual(1 + ANGLE_TOL);
    expect(worst.get('hip')!).toBeLessThanOrEqual(ORIGIN_TOL);
  }, SLOW);

  test('--reduce-hip thins the hip within its tolerance', () => {
    const c = setup({ pose: poseDoc(SMOOTH) });
    const r = retarget(c, ['--reduce', '1', '--reduce-hip', '0.5']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'REDUCE').some((l) => l.startsWith('REDUCE hip "hip" translate: 48 → '))).toBe(true);
    expect(keysOf(c.out, 'hip', 'translate').length).toBeLessThan(48);
    expect(worstErrors(c.build, SMOOTH).get('hip')!).toBeLessThanOrEqual(0.5 + ORIGIN_TOL);
  }, SLOW);

  test('control: a tolerance the reduction did not meet is caught by the independent check', () => {
    const c = setup({ pose: poseDoc(SMOOTH) });
    expect(retarget(c, ['--reduce', '3']).status).toBe(0);
    const worst = worstErrors(c.build, SMOOTH);
    expect(Math.max(...Object.keys(BONE_ANGLE).map((b) => worst.get(b)!))).toBeGreaterThan(1 + ANGLE_TOL);
  }, SLOW);

  test('refused: --reduce-hip alone (#94 lifted the refusal with --plant-feet and --leg-scale)', () => {
    const c = setup();
    const alone = retarget(c, ['--reduce-hip', '1']);
    expect(alone.status).toBe(2);
    expect(alone.stderr).toContain('--reduce-hip is given without --reduce');
    expect(existsSync(c.out)).toBe(false);
  });

  test('mutant: fitting each bone against its own dense keys (its parent\'s error ignored) piles errors down a chain, and the run is refused', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'reduce.ts');
      const before = readFileSync(path, 'utf8');
      expect(before.split(REDUCE_MUTANT.from)).toHaveLength(2);
      writeFileSync(path, before.replace(REDUCE_MUTANT.from, REDUCE_MUTANT.to));
      const c = setup({ pose: poseDoc(SMOOTH) });
      const r = retarget(c, ['--reduce', '1'], join(d, 'cli.ts'));
      const worst = r.status === 0 ? worstErrors(c.build, SMOOTH) : null;
      const red = r.status !== 0 || Object.keys(BONE_ANGLE).some((b) => worst!.get(b)! > 1 + ANGLE_TOL);
      console.log(`  mutant "reduce ignores the parent's error": exit ${r.status}${r.status !== 0 ? `, ${r.stderr.split('\n').find((l) => l.includes('POSE_LANDS')) ?? r.stderr.split('\n')[0]}` : ''}`);
      expect(red).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

// ===========================================================================

describe('#63: the camera a scan read, carried by the sequence', () => {
  /** A camera whose s steps where it is known: rising 0.002 a frame, dropping 0.05 into frame 6 and 0.04 into frame 11, 0.03 into 14. */
  const knownS = (i: number): number => 1 + 0.002 * i - (i >= 6 ? 0.05 : 0) - (i >= 11 ? 0.04 : 0) - (i >= 14 ? 0.03 : 0);
  const camera = (n: number) => Array.from({ length: n }, (_, i) => ({ s: Number(knownS(i).toFixed(6)), tx: 1.5 * i, ty: 0 - 0.25 * i, inliers: 40 + i }));
  const withCamera = (cam: unknown): Record<string, unknown> => ({ ...poseDoc(BASE), camera: cam });

  test('a valid camera is read; CAMERA names the s range and the three fastest frame-to-frame changes', () => {
    const c = setup({ pose: withCamera(camera(BASE.n)) });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'CAMERA')).toEqual([
      'CAMERA (source not stated): the sequence carries the picture\'s camera against frame 0\'s; its joints are normalised by it (p′ = (p − t) / s): s 0.9080 (frame 14) … 1.0100 (frame 5) over 16 frames; s changes fastest at frame 5→6 (t=0.750s) −0.0480, frame 10→11 (t=1.375s) −0.0380, frame 13→14 (t=1.750s) −0.0280; fewest background inliers 40',
    ]);
  }, SLOW);

  test('the camera is read, not applied: the motion is the same bytes with it and without it', () => {
    const plain = setup();
    const carried = setup({ pose: withCamera(camera(BASE.n)) });
    const r0 = retarget(plain);
    const r1 = retarget(carried);
    expect(r0.status).toBe(0);
    expect(r1.status).toBe(0);
    expect(readFileSync(carried.out).equals(readFileSync(plain.out))).toBe(true);
    // Every line but CAMERA is the same, paths aside.
    const rest = (r: Ran, c: Case) => r.stdout.split(c.dir).join('<dir>').split('\n').filter((l) => !l.trim().startsWith('CAMERA '));
    expect(rest(r1, carried)).toEqual(rest(r0, plain));
    expect(linesOf(r0, 'CAMERA')).toEqual([]);
  }, SLOW);

  test('a malformed camera is refused by name, every problem in one run; nothing written', () => {
    const cam: unknown[] = camera(BASE.n);
    cam[1] = { s: 0, tx: 0, ty: 0, inliers: 3 };
    cam[2] = { s: -1.2, tx: 'left', ty: 0, inliers: -1 };
    cam[3] = { s: 1, tx: 0, inliers: 2.5 };
    cam[4] = { s: 1, tx: 0, ty: 0, inliers: 5, rot: 0 };
    cam[5] = [1, 0, 0, 5];
    const c = setup({ pose: withCamera(cam.slice(0, BASE.n - 1)) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const p = c.pose;
    expect(fails(r)).toEqual([
      `FAIL  POSE_CAMERA: ${p} "camera" has 15 entries and "frames" 16; it must have one per frame`,
      `FAIL  POSE_CAMERA: ${p} camera[1] "s" is number 0; the scale must be a finite number > 0`,
      `FAIL  POSE_CAMERA: ${p} camera[2] "s" is number -1.2; the scale must be a finite number > 0`,
      `FAIL  POSE_CAMERA: ${p} camera[2] "tx" is the string "left"; it must be a finite number of picture px`,
      `FAIL  POSE_CAMERA: ${p} camera[2] "inliers" is number -1; it must be an integer ≥ 0`,
      `FAIL  POSE_CAMERA: ${p} camera[3] has no "ty"; a camera entry carries s, tx, ty, inliers`,
      `FAIL  POSE_CAMERA: ${p} camera[3] "inliers" is number 2.5; it must be an integer ≥ 0`,
      `FAIL  POSE_CAMERA: ${p} camera[4] has a key this reader does not know: "rot"; the keys it reads are s, tx, ty, inliers`,
      `FAIL  POSE_CAMERA: ${p} camera[5] is an array; a camera entry is { s, tx, ty, inliers }`,
    ]);
    expect(existsSync(c.out)).toBe(false);
    // Not an array at all.
    const d = setup({ pose: withCamera({ s: 1 }) });
    const rd = retarget(d);
    expect(rd.status).toBe(1);
    expect(fails(rd)).toEqual([`FAIL  POSE_CAMERA: ${d.pose} "camera" is an object; it must be an array with one { s, tx, ty, inliers } per frame`]);
  }, SLOW);

  test('the writer round-trips a camera, and writes none when there is none', () => {
    const text = JSON.stringify(withCamera(camera(BASE.n)));
    const seq = readPoseSequence(text, 'mem');
    expect(seq.camera).toEqual(camera(BASE.n));
    const written = writePoseSequence(seq);
    expect(readPoseSequence(written, 'mem').camera).toEqual(camera(BASE.n));
    expect(writePoseSequence(readPoseSequence(written, 'mem'))).toBe(written);
    expect(Object.keys(JSON.parse(written) as object)).toEqual(['spec', 'space', 'width', 'height', 'source', 'camera', 'frames']);
    const bare = writePoseSequence(readPoseSequence(JSON.stringify(poseDoc(BASE)), 'mem'));
    expect(Object.keys(JSON.parse(bare) as object)).toEqual(['spec', 'space', 'width', 'height', 'source', 'frames']);
  });

  test('cameraSource: the CAMERA line names it, the writer keeps it, and a malformed one is refused by name', () => {
    const tail = ': the sequence carries the picture\'s camera against frame 0\'s; its joints are normalised by it (p′ = (p − t) / s): s 0.9080 (frame 14) … 1.0100 (frame 5) over 16 frames; s changes fastest at frame 5→6 (t=0.750s) −0.0480, frame 10→11 (t=1.375s) −0.0380, frame 13→14 (t=1.750s) −0.0280; fewest background inliers 40';
    for (const source of ['tracked', 'hand-labelled, 6 keys', 'hand windows, floor-snapped: 5-6 (r+l, l/r 0.4 %)']) {
      const c = setup({ pose: { ...withCamera(camera(BASE.n)), cameraSource: source } });
      const r = retarget(c);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      // A camera by hand (a file or windows snapped on the floor) fitted no feature, so the line states no inlier count.
      expect(linesOf(r, 'CAMERA')).toEqual([`CAMERA ${source}${source === 'tracked' ? tail : tail.replace('; fewest background inliers 40', '')}`]);
      const seq = readPoseSequence(readFileSync(c.pose, 'utf8'), c.pose);
      expect(seq.cameraSource).toBe(source);
      const written = writePoseSequence(seq);
      expect(Object.keys(JSON.parse(written) as object)).toEqual(['spec', 'space', 'width', 'height', 'source', 'cameraSource', 'camera', 'cleaned', 'frames']);
      expect(readPoseSequence(written, 'mem').cameraSource).toBe(source);
    }
    // Planted: a source with no camera; a source that is not a string; an empty one.
    const lone = setup({ pose: { ...poseDoc(BASE), cameraSource: 'tracked' } });
    const rl = retarget(lone);
    expect(rl.status).toBe(1);
    expect(fails(rl)).toEqual([`FAIL  POSE_CAMERA_SOURCE: ${lone.pose} has "cameraSource" "tracked" and no "camera"; it states where a camera came from, so it needs one`]);
    for (const [bad, shown] of [[3, 'number 3'], ['', 'the string ""']] as const) {
      const c = setup({ pose: { ...withCamera(camera(BASE.n)), cameraSource: bad } });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toEqual([`FAIL  POSE_CAMERA_SOURCE: ${c.pose} "cameraSource" is ${shown}; it must be a non-empty string saying where the camera came from ("tracked", "hand-labelled, N keys")`]);
      expect(existsSync(c.out)).toBe(false);
    }
  }, SLOW);

  /** Standing still, both legs straight down: --plant-feet has a floor to hold. */
  const STAND: Motion = { ...BASE, n: 24, dt: 1 / 24, rt: () => -95, rs: () => -97, lt: () => -95, ls: () => -97, hip: () => [0, 0] };
  test('--plant-feet without a camera says the floor may step with the picture; with one, or without --plant-feet, it does not', () => {
    const note = 'CAMERA none in the sequence: --plant-feet reads the picture as a fixed camera, so a zoom or a pan in the video moves the floor with it and the floor may step with the picture (tools/scan.py reads the camera, rig-c/pose#63)';
    const bare = setup({ pose: poseDoc(STAND) });
    const rb = retarget(bare, ['--plant-feet']);
    expect(rb.status).toBe(0);
    expect(linesOf(rb, 'CAMERA')).toEqual([note]);
    const off = retarget(bare);
    expect(off.status).toBe(0);
    expect(linesOf(off, 'CAMERA')).toEqual([]);
    const carried = setup({ pose: { ...poseDoc(STAND), camera: camera(STAND.n) } });
    const rc = retarget(carried, ['--plant-feet']);
    expect(rc.status).toBe(0);
    expect(linesOf(rc, 'CAMERA')).toHaveLength(1);
    expect(linesOf(rc, 'CAMERA')[0]).toStartWith('CAMERA (source not stated): the sequence carries the picture\'s camera');
  }, SLOW);
});

// ===========================================================================

describe('--raised-by-head (#62): a raised arm\'s wrist placed against the head, in eye distances', () => {
  /** The stick rig with a head and two eye points 12 units apart, 30 above the neck; its right shoulder 10 below the neck and 30 out; the arm 70 + 60. */
  const headBones = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const RIG: RigOpts = { bones: headBones, extra: { sleeve_r0: { seg_up: { image: 'seg.png', x: 30, y: 0, rotation: -90 } } } };
  /** The rig's head centre and right shoulder at setup (the trunk and the head stand still in every pose below). */
  const RIG_CENTRE: Pt = [0, 480];
  const RIG_SHOULDER: Pt = [-30, 440];
  /**
   * The pose's proportions are not the rig's: its eyes are 12 px apart 35 px above the neck and its shoulder 20 px out
   * level with it (1.67, 2.92 eye distances from the shoulder to the head centre), where the rig's is (2.5, 3.33).
   * The right arm is raised on frames 4–11 (the set's key skeleton) and low elsewhere; the trunk stands still.
   */
  const ON = (i: number) => i >= 4 && i <= 11;
  const raisedMotion = (ru: (i: number) => number, rf: (i: number) => number): Motion => ({ ...BASE, trunk: () => 90, hip: () => [0, 0], ru: (i) => (ON(i) ? ru(i) : 30), rf: (i) => (ON(i) ? rf(i) : 50) });
  const RAISED = raisedMotion((i) => 110 + i, (i) => 70 - i);
  /** The eyes `half(i)` px either side of their midpoint (6 is the pose as positions() writes it). */
  const eyesApart = (half: (i: number) => number) => (i: number, j: JointsDoc): void => {
    const r = j.r_eye!.at as Pt;
    const l = j.l_eye!.at as Pt;
    const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
    j.r_eye = { state: 'observed', at: [mid[0] - half(i), mid[1]], score: 0.9 };
    j.l_eye = { state: 'observed', at: [mid[0] + half(i), mid[1]], score: 0.9 };
  };
  /** The key skeleton: the arm at the given angles, at another scale and place than the pose's. */
  const keySkeleton = (ru: number, rf: number): Record<string, Pt> => {
    const sh: Pt = [1000, 1000];
    const el = add(sh, dir(ru, 300));
    return { r_shoulder: sh, r_elbow: el, r_wrist: add(el, dir(rf, 250)) };
  };
  const set = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'up', slots: { sleeve_r0: 'seg_up' }, chains: ['arm_r'], pose: keySkeleton(117.5, 62.5), drawn: { sleeve_r0: 100, sleeve_r1: 60 }, turn: { sleeve_r0: [-90, 90], sleeve_r1: [-90, 90] }, ...o });
  const headChain = (aim = 'eye_r>eye_l'): ChainSpec => ({ name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: [aim] });
  const mapOf = (o: { sets?: Array<Record<string, unknown>>; head?: ChainSpec | null } = {}): Record<string, unknown> => ({
    ...baseMap(),
    // The right elbow bends the other way from the stick rig's rest, as a V sign does: "free", as HQ's map states it.
    chains: [...baseChains().map((c) => (c.name === 'arm_r' ? { ...c, bend: 'free' } : c)), ...(o.head === null ? [] : [o.head ?? headChain()])],
    alternates: o.sets ?? [set()],
  });
  /** The reference's wrist − head centre on frame i, in `eye` px (picture y turned up). */
  const refOffset = (m: Motion, i: number, eye = 12): Pt => {
    const p = positions(m, i);
    return [(p.r_wrist![0] - (p.r_eye![0] + p.l_eye![0]) / 2) / eye, -(p.r_wrist![1] - (p.r_eye![1] + p.l_eye![1]) / 2) / eye];
  };
  const posedBones = (build: string, m: Motion) => poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: m.n - 1 }, () => m.dt)).map((p) => byName(p.bones));
  const tipOf = (b: Map<string, RawBone>): Pt => {
    const f = b.get('sleeve_r1')!;
    return [f.worldX + f.a * 60, f.worldY + f.c * 60];
  };
  /** The rig's wrist − head centre in its eye distances (12 units), posed by rig-c from the gated build. */
  const rigOffsets = (build: string, m: Motion): Pt[] =>
    posedBones(build, m).map((b) => {
      const er = b.get('eye_r')!;
      const el = b.get('eye_l')!;
      const w = tipOf(b);
      return [(w[0] - (er.worldX + el.worldX) / 2) / 12, (w[1] - (er.worldY + el.worldY) / 2) / 12];
    });
  /** Every frame of the span where the rig's wrist is more than `tol` eye distances off `want(i)`, in x or y. */
  const offBy = (build: string, m: Motion, tol: number, want: (i: number) => Pt = (i) => refOffset(m, i)): string[] => {
    const rig = rigOffsets(build, m);
    const out: string[] = [];
    for (let i = 0; i < m.n; i++) {
      if (!ON(i)) continue;
      const r = want(i);
      if (!(Math.abs(rig[i]![0] - r[0]) <= tol && Math.abs(rig[i]![1] - r[1]) <= tol)) out.push(`frame ${i}: rig (${rig[i]![0].toFixed(3)}, ${rig[i]![1].toFixed(3)}) want (${r[0].toFixed(3)}, ${r[1].toFixed(3)})`);
    }
    return out;
  };
  /** The pose's right arm angles that put its wrist at `w` (picture px from the neck), the elbow bent clockwise. */
  const armTo = (w: Pt): { ru: number; rf: number } => {
    const v: Pt = [w[0] + 20, -w[1]];
    const d = Math.hypot(v[0], v[1]);
    const th = Math.atan2(v[1], v[0]) * DEG;
    const al = Math.acos((60 * 60 + d * d - 50 * 50) / (2 * 60 * d)) * DEG;
    const ru = th + al;
    const e: Pt = [60 * Math.cos(ru * RAD), 60 * Math.sin(ru * RAD)];
    return { ru, rf: Math.atan2(v[1] - e[1], v[0] - e[0]) * DEG };
  };
  type ReportOut = { options: Record<string, unknown>; raised: Array<{ eyes: { rig: number; reference: number }; placed: Pt[]; worst: { before: Pt; after: Pt; placed: number }; short: Array<{ frames: [number, number]; how: string; shortfall: { max: number } }>; upperHeld: number[]; reach: { min: number; max: number; farthest: number } }> };
  const reportOf = (path: string): ReportOut => JSON.parse(readFileSync(path, 'utf8')) as ReportOut;
  const rotateKeys = (path: string): Map<string, string[]> => new Map(motionOf(path).animations.dance!.tracks.map((t) => [`${t.bone}.${t.property}`, t.keys.map((k) => JSON.stringify(k))]));
  const angleBetween = (a: Pt, b: Pt): number => Math.abs(wrap((Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) * DEG));

  /** The card's test for #62, against a given CLI: written, and the wrist within 0.05 eye distances of the reference's on every frame of the span. */
  function raisedTest(cliPath = CLI): { ran: Ran; off: string[]; c: Case } {
    const c = setup({ rig: RIG, map: mapOf(), pose: poseDoc(RAISED) });
    const ran = retarget(c, ['--raised-by-head', '--report', join(c.dir, 'report.json')], cliPath);
    return { ran, off: ran.status === 0 ? offBy(c.build, RAISED, 0.05) : [], c };
  }

  test('the wrist lands on the reference\'s offset from the head within 0.05 eye distances; every other key is the run without the flag\'s', () => {
    const { ran, off, c } = raisedTest();
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(off).toEqual([]);
    expect(linesOf(ran, 'SWITCH')[0]).toContain('frames 4–11');
    const line = linesOf(ran, 'RAISED');
    expect(line).toHaveLength(1);
    expect(line[0]).toStartWith('RAISED set "up" chain "arm_r" frames 4–11 (t=0.500–1.375s): the wrist placed against the head; eye distance (median) rig 12.00 units, reference 12.00 px;');
    expect(line[0]).toEndWith('the upper arm within its turn on every frame; every target in reach');
    expect(linesOf(ran, 'REACH')).toEqual([]);
    expect(linesOf(ran, 'ART-RANGE')).toEqual([]);
    const rep = reportOf(join(c.dir, 'report.json'));
    expect(rep.options.raisedByHead).toBe(true);
    expect(rep.raised).toHaveLength(1);
    expect(rep.raised[0]!.eyes).toEqual({ rig: 12, reference: 12 });
    expect(Math.max(...rep.raised[0]!.worst.after)).toBeLessThanOrEqual(0.05);
    expect(rep.raised[0]!.short).toEqual([]);
    // Control: the pose's own angles, on these proportions, miss by more than the bar (what the flag is for).
    const plain = setup({ rig: RIG, map: mapOf(), pose: poseDoc(RAISED) });
    expect(retarget(plain).status).toBe(0);
    expect(Math.max(...rep.raised[0]!.worst.before)).toBeGreaterThan(0.5);
    expect(offBy(plain.build, RAISED, 0.05).length).toBe(8);
    // Outside the span, and on every other bone, the keys are the run without the flag's, byte for byte.
    const a = rotateKeys(plain.out);
    const b = rotateKeys(c.out);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [track, keys] of a) {
      keys.forEach((k, i) => {
        const moved = (track === 'sleeve_r0.rotate' || track === 'sleeve_r1.rotate') && ON(i);
        if (!moved) expect(`${track} ${i} ${b.get(track)![i]}`).toBe(`${track} ${i} ${k}`);
      });
    }
  }, SLOW);

  test('mutant: a solve that keeps the pose\'s angles fails the 0.05 bar', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = '          t0[i] = a0;\n          t1[i] = a1;\n';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));
      const { ran, off } = raisedTest(join(d, 'cli.ts'));
      expect(ran.status).toBe(0);
      expect(off.length).toBe(8);
      console.log(`  mutant "the solve keeps the pose's angles": exit ${ran.status}, ${off.length} frame(s) off, first: ${off[0]}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('the eye distance is each side\'s median over the span: two frames with the eyes half as far apart move nothing', () => {
    // Frames 5 and 6 read the eyes 6 px apart; read per frame, the wrist there would be twice as many eye distances out (past the arm).
    const narrow = (i: number) => (i === 5 || i === 6 ? 3 : 6);
    const c = setup({ rig: RIG, map: mapOf(), pose: poseDoc(RAISED, eyesApart(narrow)) });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'RAISED')[0]).toContain('eye distance (median) rig 12.00 units, reference 12.00 px;');
    expect(linesOf(r, 'REACH')).toEqual([]);
    expect(offBy(c.build, RAISED, 0.05)).toEqual([]);
  }, SLOW);

  test('too far: the wrist at the reach limit on the ray from the head centre toward the target; REACH, not ART-RANGE', () => {
    // Eyes 6 px apart in the pose: the same wrist is twice as many eye distances from the head, past the rig's 130 units of arm.
    const c = setup({ rig: RIG, map: mapOf(), pose: poseDoc(RAISED, eyesApart(() => 3)) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--raised-by-head', '--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'RAISED')[0]).toContain('reference 6.00 px');
    expect(linesOf(r, 'RAISED')[0]).toEndWith('out of reach on 8 frame(s) (REACH)');
    const reach = linesOf(r, 'REACH');
    expect(reach).toHaveLength(1);
    expect(reach[0]).toMatch(/^REACH {2}set "up" chain "arm_r": the target out of the arm's reach from the shoulder — frames 4–11 \(t=0\.500–1\.375s\) farther than l0 \+ l1 = 130\.0: up to [0-9.]+ eye distances short \(median [0-9.]+\); the wrist placed at the reach limit along the head-relative direction/);
    expect(reach[0]).toEndWith('Not ART-RANGE: the rig\'s proportions, not the art\'s range, were the limit');
    expect(linesOf(r, 'ART-RANGE')).toEqual([]);
    const rep = reportOf(report);
    expect(rep.raised[0]!.short).toHaveLength(1);
    expect(rep.raised[0]!.short[0]!.how).toBe('far');
    expect(rep.raised[0]!.short[0]!.shortfall.max).toBeGreaterThan(0);
    const rig = rigOffsets(c.build, RAISED);
    const bones = posedBones(c.build, RAISED);
    for (let i = 4; i <= 11; i++) {
      const ref = refOffset(RAISED, i, 6);
      // On the ray: the reference's direction from the head centre; at the limit: the arm straight, its tip l0 + l1 from the shoulder.
      expect(angleBetween(rig[i]!, ref)).toBeLessThanOrEqual(0.01);
      expect(Math.hypot(rig[i]![0], rig[i]![1])).toBeLessThan(Math.hypot(ref[0], ref[1]));
      const w = tipOf(bones[i]!);
      expect(Math.abs(Math.hypot(w[0] - RIG_SHOULDER[0], w[1] - RIG_SHOULDER[1]) - 130)).toBeLessThanOrEqual(ORIGIN_TOL);
    }
  }, SLOW);

  test('too near: the wrist at the inner limit |l0 − l1| on the ray from the head centre; REACH says so', () => {
    // The reference's wrist sits where, on the rig, it is 6 units above the shoulder: inside the 10 units a 70 + 60 arm cannot fold to.
    const want: Pt = [RIG_SHOULDER[0] - RIG_CENTRE[0], RIG_SHOULDER[1] + 6 - RIG_CENTRE[1]];
    // In the pose (eyes 12 px, centre 35 px above the neck), that offset is this wrist, from the neck, picture y down.
    // The set has no turn: a fully folded forearm is far from any drawn angle, and this test is about the reach.
    const a = armTo([want[0], -35 - want[1]]);
    const m = raisedMotion(() => a.ru, () => a.rf);
    const c = setup({ rig: RIG, map: mapOf({ sets: [set({ pose: keySkeleton(a.ru, a.rf), turn: {} })] }), pose: poseDoc(m) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--raised-by-head', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')[0]).toContain('frames 4–11');
    expect(linesOf(r, 'REACH')[0]).toContain('frames 4–11 (t=0.500–1.375s) nearer than |l0 − l1| = 10.0: up to');
    expect(linesOf(r, 'ART-RANGE')).toEqual([]);
    expect(reportOf(report).raised[0]!.short.map((x) => x.how)).toEqual(['near']);
    const rig = rigOffsets(c.build, m);
    const bones = posedBones(c.build, m);
    for (let i = 4; i <= 11; i++) {
      expect(angleBetween(rig[i]!, [want[0] / 12, want[1] / 12])).toBeLessThanOrEqual(0.01);
      const w = tipOf(bones[i]!);
      expect(Math.abs(Math.hypot(w[0] - RIG_SHOULDER[0], w[1] - RIG_SHOULDER[1]) - 10)).toBeLessThanOrEqual(ORIGIN_TOL);
    }
  }, SLOW);

  test('turn holds the upper arm and the re-aimed forearm leaves the wrist short: ART-RANGE on the upper arm with the shortfall in eye distances', () => {
    const c = setup({ rig: RIG, map: mapOf({ sets: [set({ drawn: { sleeve_r0: 70, sleeve_r1: 30 }, turn: { sleeve_r0: [-5, 5], sleeve_r1: [-90, 90] } })] }), pose: poseDoc(RAISED) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--raised-by-head', '--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'RAISED')[0]).toContain('the upper arm held by the set\'s turn on 8 frame(s) (4–11), the forearm re-aimed');
    expect(reportOf(report).raised[0]!.upperHeld).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    const art = linesOf(r, 'ART-RANGE');
    expect(art).toHaveLength(1);
    expect(art[0]).toMatch(/^ART-RANGE set "up" chain "arm_r" bone "sleeve_r0" held at its turn \(range \[-5, 5\]\) frames 4–11 \(t=0\.500–1\.375s\): 1\.000s the re-aimed forearm leaves the wrist up to [0-9.]+ eye distances short of its placed point \(the upper arm asked \+[0-9.]+° from drawn, [0-9.]+° past\) — demand for another drawing of the set$/);
    const entry = (JSON.parse(readFileSync(report, 'utf8')) as { artRange: Array<{ bone: string; shortfall?: number; clamped: boolean }> }).artRange;
    expect(entry).toHaveLength(1);
    expect(entry[0]!.bone).toBe('sleeve_r0');
    expect(entry[0]!.clamped).toBe(true);
    const bones = posedBones(c.build, RAISED);
    let worst = 0;
    for (let i = 4; i <= 11; i++) {
      const b = bones[i]!;
      // The upper arm at its limit.
      expect(Math.abs(Math.abs(wrap(worldAngle(b, 'sleeve_r0') - 70)) - 5)).toBeLessThanOrEqual(ANGLE_TOL);
      // The forearm pointing from the elbow at the target (in reach here: head centre + the reference's offset × 12).
      const ref = refOffset(RAISED, i);
      const target: Pt = [RIG_CENTRE[0] + ref[0] * 12, RIG_CENTRE[1] + ref[1] * 12];
      const e = b.get('sleeve_r1')!;
      const toTarget = Math.atan2(target[1] - e.worldY, target[0] - e.worldX) * DEG;
      expect(Math.abs(wrap(worldAngle(b, 'sleeve_r1') - toTarget))).toBeLessThanOrEqual(ANGLE_TOL);
      // ... and still short of it: the shortfall, read on rig-c's poser.
      const w = tipOf(b);
      worst = Math.max(worst, Math.hypot(w[0] - target[0], w[1] - target[1]) / 12);
    }
    expect(worst).toBeGreaterThan(0.01);
    expect(Math.abs(entry[0]!.shortfall! - worst)).toBeLessThanOrEqual(0.001);
  }, SLOW);

  test('control: turn holds the upper arm where the re-aimed forearm still reaches (the other elbow of the two-bone solve) — no ART-RANGE', () => {
    // A still arm, so the target is one point; the turn admits exactly the mirror elbow, which reaches it too.
    const m = raisedMotion(() => 115, () => 65);
    const ref = refOffset(m, 4);
    const target: Pt = [RIG_CENTRE[0] + ref[0] * 12, RIG_CENTRE[1] + ref[1] * 12];
    const d = Math.hypot(target[0] - RIG_SHOULDER[0], target[1] - RIG_SHOULDER[1]);
    const theta = Math.atan2(target[1] - RIG_SHOULDER[1], target[0] - RIG_SHOULDER[0]) * DEG;
    const alpha = Math.acos((70 * 70 + d * d - 60 * 60) / (2 * 70 * d)) * DEG;
    // The pose bends clockwise, so the solve's own elbow is at θ + α; the mirror at θ − α.
    const mirror = wrap(theta - alpha - 100);
    const c = setup({ rig: RIG, map: mapOf({ sets: [set({ pose: keySkeleton(115, 65), drawn: { sleeve_r0: 100, sleeve_r1: 60 }, turn: { sleeve_r0: [mirror, mirror], sleeve_r1: [-180, 180] } })] }), pose: poseDoc(m) });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'RAISED')[0]).toContain('the upper arm held by the set\'s turn on 8 frame(s) (4–11), the forearm re-aimed');
    expect(linesOf(r, 'ART-RANGE')).toEqual([]);
    expect(offBy(c.build, m, 0.01)).toEqual([]);
  }, SLOW);

  test('a forearm past its own turn after the re-aim: ART-RANGE on the forearm, held there; the upper arm only as a held arm leaving the wrist short', () => {
    const c = setup({ rig: RIG, map: mapOf({ sets: [set({ drawn: { sleeve_r0: 70, sleeve_r1: 30 }, turn: { sleeve_r0: [-5, 5], sleeve_r1: [-5, 5] } })] }), pose: poseDoc(RAISED) });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.status).toBe(0);
    const art = linesOf(r, 'ART-RANGE');
    // The forearm past its own turn, held there; the upper arm appears only as a held arm leaving the wrist short.
    expect(art.some((l) => l.startsWith('ART-RANGE set "up" chain "arm_r" bone "sleeve_r1" turned') && l.includes('held at the limit'))).toBe(true);
    expect(art.every((l) => l.startsWith('ART-RANGE set "up" chain "arm_r" bone "sleeve_r1" turned') || (l.startsWith('ART-RANGE set "up" chain "arm_r" bone "sleeve_r0" held at its turn') && l.includes('eye distances short of its placed point')))).toBe(true);
    const bones = posedBones(c.build, RAISED);
    const out: string[] = [];
    for (let i = 4; i <= 11; i++) {
      for (const [bone, drawn] of [['sleeve_r0', 70], ['sleeve_r1', 30]] as const) {
        const turn = wrap(worldAngle(bones[i]!, bone) - drawn);
        if (Math.abs(turn) > 5 + ANGLE_TOL) out.push(`${bone} frame ${i}: ${turn.toFixed(3)}° from drawn`);
      }
    }
    expect(out).toEqual([]);
  }, SLOW);

  test('RAISED_HEAD: the flag is refused without a head chain, and with one not aimed "a>b"; nothing written', () => {
    for (const [head, says] of [[null, 'no chain of the map carries the eye line'], [headChain('x'), 'chain "head" carries r_eye → l_eye on bone "head", and aims it "x"']] as const) {
      const c = setup({ rig: RIG, map: mapOf({ head }), pose: poseDoc(RAISED) });
      const r = retarget(c, ['--raised-by-head']);
      expect(r.status).toBe(1);
      expect(fails(r)).toHaveLength(1);
      expect(fails(r)[0]).toStartWith('FAIL  RAISED_HEAD: --raised-by-head places a raised arm\'s wrist against the head in eye distances');
      expect(fails(r)[0]).toContain(says);
      expect(existsSync(c.out)).toBe(false);
      // Control: the same map without the flag runs.
      expect(retarget(c).status).toBe(0);
    }
  }, SLOW);

  test('a map whose sets draw no arm raised: the flag writes the same bytes as without it', () => {
    const low = set({ drawn: { sleeve_r0: 30, sleeve_r1: 60 } });
    const a = setup({ rig: RIG, map: mapOf({ sets: [low] }), pose: poseDoc(RAISED) });
    expect(retarget(a).status).toBe(0);
    const first = readFileSync(a.out);
    rmSync(a.out);
    const r = retarget(a, ['--raised-by-head']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')[0]).toContain('frames 4–11');
    expect(linesOf(r, 'RAISED')).toEqual(['RAISED none — no set drawing an arm within 30° of straight up showed; no key moved']);
    expect(readFileSync(a.out).equals(first)).toBe(true);
  }, SLOW);
});

describe('"place": "by-hip" (#93): a hand that meets the body placed by its offset from the hip, in hip widths', () => {
  /**
   * The stick rig's hips are its legs' roots, 30 units apart at (∓15, 300): the mid-hip (0, 300), its right
   * shoulder at (−30, 440), the arm 70 + 60. The pose's hips are 30 px apart too, but its trunk is 100 px against
   * the rig's 150 and its arm 60 + 50: the pose's angles put the rig's hand far from where the reference's is
   * against the hip. The right wrist meets the body on frames 4–11 (the set's key skeleton) and is up elsewhere.
   */
  const RIG: RigOpts = { extra: { sleeve_r0: { seg_low: { image: 'seg.png', x: 30, y: 0, rotation: -90 } } } };
  const ON = (i: number) => i >= 4 && i <= 11;
  const RIG_SHOULDER: Pt = [-30, 440];
  /** The pose's right shoulder, and its mid-hip, picture px (the trunk stands still at 90°, the hip does not travel). */
  const SHOULDER: Pt = [180, 300];
  const MID: Pt = [200, 400];
  /** The pose's right arm angles that put its wrist at mid-hip + w (px, y up), the elbow out to the side. */
  const armTo = (w: Pt): { ru: number; rf: number } => {
    const v: Pt = [MID[0] + w[0] - SHOULDER[0], SHOULDER[1] - (MID[1] - w[1])];
    const d = Math.hypot(v[0], v[1]);
    const th = Math.atan2(v[1], v[0]) * DEG;
    const al = Math.acos((60 * 60 + d * d - 50 * 50) / (2 * 60 * d)) * DEG;
    const ru = th - al;
    const e: Pt = [60 * Math.cos(ru * RAD), 60 * Math.sin(ru * RAD)];
    return { ru, rf: Math.atan2(v[1] - e[1], v[0] - e[0]) * DEG };
  };
  /** The wrist at mid-hip + w(i) on the span, raised (30°, 50°) elsewhere. */
  const handMotion = (w: (i: number) => Pt): Motion => ({ ...BASE, trunk: () => 90, hip: () => [0, 0], ru: (i) => (ON(i) ? armTo(w(i)).ru : 30), rf: (i) => (ON(i) ? armTo(w(i)).rf : 50) });
  /** In front of the hips: (−0.6, 0.6) hip widths on frame 8, drifting. */
  const CLASP = handMotion((i) => [-18 + (i - 8) * 0.8, 18 - (i - 8) * 0.4]);
  /** The set's key skeleton: frame 8 of the motion at twice the scale, elsewhere; the hips are in it. */
  const keySkeleton = (m: Motion): Record<string, Pt> => {
    const p = positions(m, 8);
    const at = (q: Pt): Pt => [1000 + 2 * (q[0] - 200), 1000 + 2 * (q[1] - 400)];
    return Object.fromEntries(['r_shoulder', 'r_elbow', 'r_wrist', 'r_hip', 'l_hip'].map((j) => [j, at(p[j]!)]));
  };
  const set = (m: Motion, o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'clasp', slots: { sleeve_r0: 'seg_low' }, chains: ['arm_r'], pose: keySkeleton(m), place: 'by-hip', ...o });
  const mapOf = (sets: Array<Record<string, unknown>>, chains: ChainSpec[] = baseChains()): Record<string, unknown> => ({ ...baseMap(), chains, alternates: sets });
  /** The reference's wrist − mid-hip on frame i, in `width` px (picture y turned up). */
  const refOffset = (m: Motion, i: number, width = 30): Pt => {
    const p = positions(m, i);
    return [(p.r_wrist![0] - (p.r_hip![0] + p.l_hip![0]) / 2) / width, -(p.r_wrist![1] - (p.r_hip![1] + p.l_hip![1]) / 2) / width];
  };
  const posedBones = (build: string, m: Motion) => poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: m.n - 1 }, () => m.dt)).map((p) => byName(p.bones));
  const tipOf = (b: Map<string, RawBone>): Pt => {
    const f = b.get('sleeve_r1')!;
    return [f.worldX + f.a * 60, f.worldY + f.c * 60];
  };
  /** The rig's wrist − mid-hip (the legs' roots) in its hip widths (30 units), posed by rig-c from the gated build. */
  const rigOffsets = (build: string, m: Motion): Pt[] =>
    posedBones(build, m).map((b) => {
      const r = b.get('leg_r0')!;
      const l = b.get('leg_l0')!;
      const w = tipOf(b);
      return [(w[0] - (r.worldX + l.worldX) / 2) / 30, (w[1] - (r.worldY + l.worldY) / 2) / 30];
    });
  /** Every frame of the span where the rig's wrist is more than `tol` hip widths from the reference's offset, or on the other side of the mid-hip. */
  const offBy = (build: string, m: Motion, tol: number): string[] => {
    const rig = rigOffsets(build, m);
    const out: string[] = [];
    for (let i = 0; i < m.n; i++) {
      if (!ON(i)) continue;
      const r = refOffset(m, i);
      const g = rig[i]!;
      if (!(Math.hypot(g[0] - r[0], g[1] - r[1]) <= tol) || Math.sign(g[0]) !== Math.sign(r[0])) out.push(`frame ${i}: rig (${g[0].toFixed(3)}, ${g[1].toFixed(3)}) want (${r[0].toFixed(3)}, ${r[1].toFixed(3)})`);
    }
    return out;
  };
  type ReportOut = { raised: unknown[]; byHip: Array<{ set: string; chain: string; hips: { rig: number; reference: number }; worst: { before: Pt; after: Pt; placed: number }; short: Array<{ frames: [number, number]; how: string; shortfall: { max: number } }>; upperHeld: number[] }>; artRange: Array<{ bone: string; shortfall?: number; anchor?: string }> };
  const reportOf = (path: string): ReportOut => JSON.parse(readFileSync(path, 'utf8')) as ReportOut;
  const tracksOf = (path: string): Map<string, string[]> => new Map(motionOf(path).animations.dance!.tracks.map((t) => [`${t.bone}.${t.property}`, t.keys.map((k) => JSON.stringify(k))]));

  /** The card's synthetic bar, against a given CLI: written, and the wrist within 0.05 hip widths of the reference's offset on every frame of the span. */
  function byHipTest(cliPath = CLI): { ran: Ran; off: string[]; c: Case } {
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)]), pose: poseDoc(CLASP) });
    const ran = retarget(c, ['--report', join(c.dir, 'report.json')], cliPath);
    return { ran, off: ran.status === 0 ? offBy(c.build, CLASP, 0.05) : [], c };
  }

  test('the wrist lands on the reference\'s offset from the mid-hip within 0.05 hip widths; every key outside the span is the run without "place"\'s', () => {
    const { ran, off, c } = byHipTest();
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(off).toEqual([]);
    expect(linesOf(ran, 'SWITCH')[0]).toContain('frames 4–11');
    const line = linesOf(ran, 'BY-HIP');
    expect(line).toHaveLength(1);
    expect(line[0]).toStartWith('BY-HIP set "clasp" chain "arm_r" frames 4–11 (t=0.500–1.375s): the wrist placed against the hip; hip width (median) rig 30.00 units, reference 30.00 px; wrist − mid-hip in hip widths (x right, y up),');
    expect(line[0]).toEndWith('the upper arm within its turn on every frame; every target in reach');
    expect(linesOf(ran, 'RAISED')).toEqual([]);
    expect(linesOf(ran, 'REACH')).toEqual([]);
    expect(linesOf(ran, 'ART-RANGE')).toEqual([]);
    const rep = reportOf(join(c.dir, 'report.json'));
    expect(rep.raised).toEqual([]);
    expect(rep.byHip).toHaveLength(1);
    // The other direction of #84's control: with `place` declared, the report carries every documented key, `byHip` included.
    const doc = documentedReport();
    expect(doc.conditional).toEqual(['byHip']);
    expect(Object.keys(rep).sort()).toEqual(doc.all);
    expect(rep.byHip[0]!.hips).toEqual({ rig: 30, reference: 30 });
    expect(Math.max(...rep.byHip[0]!.worst.after)).toBeLessThanOrEqual(0.05);
    // Control: the same set without "place" — the pose's angles, on these proportions, miss by more than the bar on every frame.
    const plain = setup({ rig: RIG, map: mapOf([set(CLASP, { place: undefined })]), pose: poseDoc(CLASP) });
    const pr = retarget(plain, ['--report', join(plain.dir, 'report.json')]);
    expect(pr.status).toBe(0);
    // ... and its report has no `byHip` key, and is otherwise the documented set.
    const plainRep = JSON.parse(readFileSync(join(plain.dir, 'report.json'), 'utf8')) as Record<string, unknown>;
    expect('byHip' in plainRep).toBe(false);
    expect(Object.keys(plainRep).sort()).toEqual(doc.all.filter((k) => k !== 'byHip'));
    expect(linesOf(pr, 'BY-HIP')).toEqual([]);
    expect(Math.max(...rep.byHip[0]!.worst.before)).toBeGreaterThan(0.5);
    expect(offBy(plain.build, CLASP, 0.05).length).toBe(8);
    // Outside the span, and on every other track, the keys are the run without "place"'s, byte for byte.
    const a = tracksOf(plain.out);
    const b = tracksOf(c.out);
    expect([...b.keys()]).toEqual([...a.keys()]);
    let moved = 0;
    for (const [track, keys] of a) {
      keys.forEach((k, i) => {
        if ((track === 'sleeve_r0.rotate' || track === 'sleeve_r1.rotate') && ON(i)) moved += b.get(track)![i] === k ? 0 : 1;
        else expect(`${track} ${i} ${b.get(track)![i]}`).toBe(`${track} ${i} ${k}`);
      });
    }
    expect(moved).toBe(16);
  }, SLOW);

  test('mutant: a solve that keeps the pose\'s angles fails the 0.05 bar', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = '          t0[i] = a0;\n          t1[i] = a1;\n';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));
      const { ran, off } = byHipTest(join(d, 'cli.ts'));
      expect(ran.status).toBe(0);
      expect(off.length).toBe(8);
      console.log(`  mutant "the by-hip solve keeps the pose's angles": exit ${ran.status}, ${off.length} frame(s) off, first: ${off[0]}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('mutant: the offset measured in the reference\'s px scaled by the figure, not in hip widths, fails the 0.05 bar', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      // The target off the mid-hip by the reference's px times the figure scale (the trunk's, 1.5), as the pose's angles would put it.
      const from = 'const target: Pt = [h.centre[0] + ref[0] * rigEye, h.centre[1] + ref[1] * rigEye];';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const target: Pt = [h.centre[0] + ref[0] * refEye * (scale?.factor ?? 1), h.centre[1] + ref[1] * refEye * (scale?.factor ?? 1)];'));
      const { ran, off } = byHipTest(join(d, 'cli.ts'));
      expect(ran.status).toBe(0);
      expect(off.length).toBe(8);
      console.log(`  mutant "the offset in figure-scaled px, not hip widths": exit ${ran.status}, ${off.length} frame(s) off, first: ${off[0]}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('the hips may be a pelvis chain\'s "a>b" points: the same placement', () => {
    const pelvis: ChainSpec = { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] };
    const a = setup({ rig: RIG, map: mapOf([set(CLASP)]), pose: poseDoc(CLASP) });
    const b = setup({ rig: RIG, map: mapOf([set(CLASP)], [...baseChains(), pelvis]), pose: poseDoc(CLASP) });
    const ra = retarget(a);
    const rb = retarget(b);
    expect(rb.stderr).toBe('');
    expect(rb.status).toBe(0);
    expect(linesOf(rb, 'BY-HIP')).toEqual(linesOf(ra, 'BY-HIP'));
    expect(offBy(b.build, CLASP, 0.05)).toEqual([]);
  }, SLOW);

  test('out of reach below the shoulder: the ray from the mid-hip points away from the arm, so the wrist goes to the reach\'s point nearest the target; REACH in hip widths, not ART-RANGE', () => {
    // Just above the hips' line: on the rig, about 146 units from the shoulder, past its 130 units of arm. The ray
    // from the mid-hip through that target runs down and away from the shoulder and never enters the reach
    // ("missed"), the case #62's head-relative rule keeps for last; here it is the usual one.
    const m = handMotion((i) => [-10 + (i - 8) * 0.5, -5]);
    const c = setup({ rig: RIG, map: mapOf([set(m)]), pose: poseDoc(m) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'BY-HIP')[0]).toEndWith('out of reach on 8 frame(s) (REACH)');
    const reach = linesOf(r, 'REACH');
    expect(reach).toHaveLength(1);
    expect(reach[0]).toMatch(/^REACH {2}set "clasp" chain "arm_r": the target out of the arm's reach from the shoulder — frames 4–11 \(t=0\.500–1\.375s\) out of reach, and the ray from the mid-hip never enters the reach; placed at the reach's point nearest it: up to [0-9.]+ hip widths short \(median [0-9.]+\); the wrist placed at the reach limit along the hip-relative direction/);
    expect(linesOf(r, 'ART-RANGE')).toEqual([]);
    const rep = reportOf(report);
    expect(rep.byHip[0]!.short.map((s) => s.how)).toEqual(['missed']);
    const bones = posedBones(c.build, m);
    for (let i = 4; i <= 11; i++) {
      const ref = refOffset(m, i);
      // The target: the rig's mid-hip (0, 300) + the reference's offset × 30. The wrist on the line from the shoulder to it, the arm straight.
      const target: Pt = [ref[0] * 30, 300 + ref[1] * 30];
      const w = tipOf(bones[i]!);
      const toTarget = Math.atan2(target[1] - RIG_SHOULDER[1], target[0] - RIG_SHOULDER[0]);
      expect(Math.abs(wrap((Math.atan2(w[1] - RIG_SHOULDER[1], w[0] - RIG_SHOULDER[0]) - toTarget) * DEG))).toBeLessThanOrEqual(0.01);
      expect(Math.abs(Math.hypot(w[0] - RIG_SHOULDER[0], w[1] - RIG_SHOULDER[1]) - 130)).toBeLessThanOrEqual(ORIGIN_TOL);
    }
    // Control: the in-reach clasp prints no REACH (the first test).
  }, SLOW);

  test('turn holds the upper arm and the re-aimed forearm leaves the wrist short: ART-RANGE on the upper arm, in hip widths', () => {
    const c = setup({ rig: RIG, map: mapOf([set(CLASP, { drawn: { sleeve_r0: -160, sleeve_r1: -40 }, turn: { sleeve_r0: [-5, 5], sleeve_r1: [-90, 90] } })]), pose: poseDoc(CLASP) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'BY-HIP')[0]).toContain('the upper arm held by the set\'s turn on 8 frame(s) (4–11), the forearm re-aimed');
    const art = linesOf(r, 'ART-RANGE');
    expect(art).toHaveLength(1);
    expect(art[0]).toMatch(/^ART-RANGE set "clasp" chain "arm_r" bone "sleeve_r0" held at its turn \(range \[-5, 5\]\) frames 4–11 \(t=0\.500–1\.375s\): 1\.000s the re-aimed forearm leaves the wrist up to [0-9.]+ hip widths short of its placed point/);
    const entry = reportOf(report).artRange;
    expect(entry).toHaveLength(1);
    expect(entry[0]!.anchor).toBe('hip');
    // Control: a turn wide enough holds nothing, and no ART-RANGE.
    const wide = setup({ rig: RIG, map: mapOf([set(CLASP, { drawn: { sleeve_r0: -160, sleeve_r1: -40 }, turn: { sleeve_r0: [-90, 90], sleeve_r1: [-90, 90] } })]), pose: poseDoc(CLASP) });
    const rw = retarget(wide);
    expect(rw.status).toBe(0);
    expect(linesOf(rw, 'ART-RANGE')).toEqual([]);
    expect(offBy(wide.build, CLASP, 0.05)).toEqual([]);
  }, SLOW);

  test('a "by-hip" set that never shows: BY-HIP none, and the same bytes as without "place"', () => {
    // Its key skeleton is the clasp's, but the arm never leaves the raised pose.
    const still: Motion = { ...BASE, trunk: () => 90, hip: () => [0, 0], ru: () => 30, rf: () => 50 };
    const a = setup({ rig: RIG, map: mapOf([set(CLASP, { place: undefined })]), pose: poseDoc(still) });
    expect(retarget(a).status).toBe(0);
    const first = readFileSync(a.out);
    rmSync(a.out);
    writeFileSync(a.map, JSON.stringify(mapOf([set(CLASP)]), null, 2));
    const r = retarget(a);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'BY-HIP')).toEqual(['BY-HIP none — no set with "place": "by-hip" showed; no key moved']);
    expect(readFileSync(a.out).equals(first)).toBe(true);
  }, SLOW);

  test('MAP_ALT_PLACE: a placement other than "by-hip", a key skeleton without a hip or the wrist, hips that meet, or no wrist within one hip width — refused by name', () => {
    const without = (...js: string[]): Record<string, Pt> => {
      const k = keySkeleton(CLASP);
      for (const j of js) delete k[j];
      return k;
    };
    const far = keySkeleton(CLASP);
    far.r_wrist = [far.r_hip![0] - 80, far.r_hip![1]];
    const met = keySkeleton(CLASP);
    met.l_hip = [met.r_hip![0], met.r_hip![1]];
    for (const [o, says] of [
      [{ place: 'by-head' }, '"place" is "by-head"; the one placement a set may ask for is "by-hip"'],
      [{ pose: without('l_hip') }, 'its "pose" has no "l_hip"'],
      [{ pose: without('r_hip') }, 'its "pose" has no "r_hip"'],
      [{ pose: without('r_hip', 'l_hip') }, 'its "pose" has no "r_hip" or "l_hip"'],
      [{ pose: without('r_wrist') }, 'its "pose" has no "r_wrist", the wrist of chain "arm_r"'],
      [{ pose: met }, 'its "pose" puts r_hip and l_hip at the same point'],
      [{ pose: far }, 'its "pose" puts no wrist within one hip width of the mid-hip (chain "arm_r" r_wrist '],
    ] as const) {
      const c = setup({ rig: RIG, map: mapOf([set(CLASP, o)]), pose: poseDoc(CLASP) });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r).some((l) => l.includes('MAP_ALT_PLACE') && l.includes('set "clasp"') && l.includes(says))).toBe(true);
      expect(existsSync(c.out)).toBe(false);
      // Control: the same key skeleton without "place" — a hip missing is no refusal there (the chains do not use it).
      if ('pose' in o && !says.includes('r_wrist')) {
        writeFileSync(c.map, JSON.stringify(mapOf([set(CLASP, { ...o, place: undefined })]), null, 2));
        expect(retarget(c).status).toBe(0);
      }
    }
    // Control: the clasp's own key skeleton is read.
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)]), pose: poseDoc(CLASP) });
    expect(retarget(c).status).toBe(0);
  }, SLOW);

  test('PLACE_HIP: a map with neither a hip line aimed "a>b" nor two chains from the hips is refused; nothing written', () => {
    const noLegs = baseChains().filter((c) => !c.name.startsWith('leg'));
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)], noLegs), pose: poseDoc(CLASP) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toHaveLength(1);
    expect(fails(r)[0]).toStartWith('FAIL  PLACE_HIP: "place": "by-hip" places a wrist against the hip in hip widths');
    expect(fails(r)[0]).toEndWith('the map has neither (no chain starts at r_hip or l_hip)');
    expect(existsSync(c.out)).toBe(false);
    // Control: the same map without "place" runs.
    writeFileSync(c.map, JSON.stringify(mapOf([set(CLASP, { place: undefined })], noLegs), null, 2));
    expect(retarget(c).status).toBe(0);
  }, SLOW);

  test('PLACE_HIPS: a reference whose hips meet over the span (no unit) is refused', () => {
    const together = (i: number, j: JointsDoc): void => {
      if (!ON(i)) return;
      const r = j.r_hip!.at as Pt;
      const l = j.l_hip!.at as Pt;
      const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
      j.r_hip = { state: 'observed', at: mid, score: 0.9 };
      j.l_hip = { state: 'observed', at: [mid[0], mid[1]], score: 0.9 };
    };
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)], baseChains().map((x) => (x.name.startsWith('leg') ? { ...x, bend: 'free' } : x))), pose: poseDoc(CLASP, together) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.startsWith('FAIL  PLACE_HIPS: "place": "by-hip": set "clasp" places chain "arm_r"\'s wrist against the hip: over frames 4–11 the median hip width is 0px in the reference (r_hip, l_hip)'))).toBe(true);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('PLACE_CHAIN: a placed chain the two-bone solve cannot turn is refused', () => {
    const chains = baseChains().map((x) => (x.name === 'arm_r' ? { ...x, aim: ['x', 'sleeve_r1>sleeve_r1:tip'] } : x));
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)], chains), pose: poseDoc(CLASP) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.startsWith('FAIL  PLACE_CHAIN: "place": "by-hip": set "clasp" places chain "arm_r"\'s wrist against the hip, and it aims ["x","sleeve_r1>sleeve_r1:tip"]'))).toBe(true);
    // Control: without "place" the same aims run.
    writeFileSync(c.map, JSON.stringify(mapOf([set(CLASP, { place: undefined })], chains), null, 2));
    expect(retarget(c).status).toBe(0);
  }, SLOW);

  test('PLACE_BOTH: with --raised-by-head, a chain drawn raised that "by-hip" also places is refused', () => {
    const head = (b: BoneSpec[]): BoneSpec[] => [...b, { name: 'head', parent: 'neck', x: 0, y: 20 }, { name: 'eye_r', parent: 'head', x: -6, y: 10 }, { name: 'eye_l', parent: 'head', x: 6, y: 10 }];
    const rig: RigOpts = { ...RIG, bones: head };
    const chains = [...baseChains(), { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] }];
    const c = setup({ rig, map: mapOf([set(CLASP, { drawn: { sleeve_r0: 100 } })], chains), pose: poseDoc(CLASP) });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.startsWith('FAIL  PLACE_BOTH: set "clasp" chain "arm_r": --raised-by-head places its wrist against the head'))).toBe(true);
    expect(existsSync(c.out)).toBe(false);
    // Control: without the flag, "by-hip" alone places it.
    const ok = retarget(c);
    expect(ok.status).toBe(0);
    expect(linesOf(ok, 'BY-HIP')).toHaveLength(1);
  }, SLOW);
});

// --- #110: art-range edge easing and foreshortened step cap ----------------------

describe('#110: clampArt eases at set edges, and capShortSteps caps foreshortened steps', () => {
  test('clampArt eases in and out at set edges so the boundary step stays within 3° of the picture step, while interior and outside frames are unchanged', () => {
    const n = 28;
    // Reference sits at -55 outside [4, 23] and -50 inside [4, 23] (+5° picture step in, -5° picture step out).
    // Set "lift" has drawn -80 and turn [-10, 10], so the clamped angle inside is -70 (20° off the reference, eased over 6 frames).
    const asked = Array.from({ length: n }, (_, i) => (i >= 4 && i <= 23 ? -50 : -55));
    const targets = new Map<string, number[]>([['sleeve_r0', [...asked]]]);
    const sw = [{ set: 'lift', slots: { sleeve_r0: 'seg_up' }, hides: [], chains: ['arm_r'], frames: [4, 23] as [number, number], from: 0.5, to: 3, seconds: 2.5, distance: { max: 0, median: 0 }, artTurn: {}, offsets: {}, place: null, moved: { on: null, off: null } }];
    const map = { translate: null, chains: [], alternates: [{ name: 'lift', slots: { sleeve_r0: 'seg_up' }, hides: [], chains: ['arm_r'], pose: {}, drawn: { sleeve_r0: -80 }, turn: { sleeve_r0: [-10, 10] as [number, number] }, offsets: {}, place: null, frames: null }] };
    clampArt(sw, map, targets);
    const got = targets.get('sleeve_r0')!;
    // Outside [4, 23] and interior [10, 17] are unchanged from unclamped / fully clamped.
    for (let i = 0; i <= 3; i++) expect(got[i]).toBe(-55);
    for (let i = 10; i <= 17; i++) expect(got[i]).toBe(-70);
    for (let i = 24; i < n; i++) expect(got[i]).toBe(-55);
    // Entry step (3 -> 4) and exit step (23 -> 24): rig step minus picture step <= 3°.
    const inDiff = wrap(got[4]! - got[3]!) - wrap(asked[4]! - asked[3]!);
    const outDiff = wrap(got[24]! - got[23]!) - wrap(asked[24]! - asked[23]!);
    expect(Math.abs(inDiff)).toBeLessThanOrEqual(3);
    expect(Math.abs(outDiff)).toBeLessThanOrEqual(3);
  });

  test('mutant (#110): without edge easing in clampArt, the boundary step jumps by the full clamp offset and the <= 3° check is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm110-art-'));
    try {
      const src = readFileSync(join(ROOT, 'src', 'switch.ts'), 'utf8');
      const from = 'const easeIn = a > 0 && da !== 0 && Math.sign(delta(a - 1)) === Math.sign(da)';
      expect(src.split(from)).toHaveLength(2);
      const mutated = src
        .replace(from, 'const easeIn = false && a > 0 && da !== 0 && Math.sign(delta(a - 1)) === Math.sign(da)')
        .replace('const easeOut = b + 1 < n && db !== 0 && Math.sign(delta(b + 1)) === Math.sign(db)', 'const easeOut = false && b + 1 < n');
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      writeFileSync(join(d, 'src', 'switch.ts'), mutated);
      const mod = await import(join(d, 'src', 'switch.ts')) as typeof import('../src/switch.ts');
      const asked = Array.from({ length: 28 }, (_, i) => (i >= 4 && i <= 23 ? -50 : -55));
      const targets = new Map<string, number[]>([['sleeve_r0', [...asked]]]);
      const sw = [{ set: 'lift', slots: { sleeve_r0: 'seg_up' }, hides: [], chains: ['arm_r'], frames: [4, 23] as [number, number], from: 0.5, to: 3, seconds: 2.5, distance: { max: 0, median: 0 }, artTurn: {}, offsets: {}, place: null, moved: { on: null, off: null } }];
      const map = { translate: null, chains: [], alternates: [{ name: 'lift', slots: { sleeve_r0: 'seg_up' }, hides: [], chains: ['arm_r'], pose: {}, drawn: { sleeve_r0: -80 }, turn: { sleeve_r0: [-10, 10] as [number, number] }, offsets: {}, place: null, frames: null }] };
      mod.clampArt(sw, map, targets);
      const got = targets.get('sleeve_r0')!;
      const inDiff = wrap(got[4]! - got[3]!) - wrap(asked[4]! - asked[3]!);
      console.log(`  mutant "no clampArt edge easing": boundary step diff is ${inDiff.toFixed(2)}°`);
      expect(Math.abs(inDiff)).toBeGreaterThan(3);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('capShortSteps spreads a > 30° step when fraction < 0.60 to <= 30°/frame, stays inside uncovered spans, and leaves keys away from the step unchanged', () => {
    // 12 frames: angle steps from 0° to 54° between frame 4 and frame 5 while fraction dips to 0.50 (above 0.35, below 0.60).
    const angles = [0, 0, 0, 0, 0, 54, 54, 54, 54, 54, 54, 54];
    const fraction = [1, 1, 1, 1, 0.50, 0.55, 1, 1, 1, 1, 1, 1];
    expect(holdShort(angles, fraction, 0.35)).toEqual([]);
    const capped = capShortSteps(angles, fraction);
    expect(capped).toEqual([{ frames: [4, 5], minFraction: 0.5, step: 18, asked: 54 }]);
    for (let i = 1; i < angles.length; i++) {
      expect(Math.abs(wrap(angles[i]! - angles[i - 1]!))).toBeLessThanOrEqual(30);
    }
    // Frames outside [4, 5] are untouched.
    expect(angles.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(angles.slice(6)).toEqual([54, 54, 54, 54, 54, 54]);
    const times = angles.map((_, i) => i * 0.125);
    expect(shortLine({ chain: 'arm_l', bone: 'sleeve_l1', joints: ['l_elbow', 'l_wrist'], ...capped[0]! }, times, 0.35)).toBe(
      'chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) frames 4–5 (t=0.500–0.625s): picture length down to 0.50 of its median, under 0.60, turned +54.0° in one frame (over 30°); spread to +18.0° per frame',
    );
  });

  test('mutant (#110): without capShortSteps a foreshortened segment at 0.50 of median jumps > 30° in one frame', () => {
    const angles = [0, 0, 0, 0, 0, 54, 54, 54, 54, 54, 54, 54];
    const fraction = [1, 1, 1, 1, 0.50, 0.55, 1, 1, 1, 1, 1, 1];
    holdShort(angles, fraction, 0.35);
    let maxStep = 0;
    for (let i = 1; i < angles.length; i++) maxStep = Math.max(maxStep, Math.abs(wrap(angles[i]! - angles[i - 1]!)));
    console.log(`  mutant "no capShortSteps": max step is ${maxStep.toFixed(1)}°`);
    expect(maxStep).toBeGreaterThan(30);
  });
});

// --- #107: --leg-scale clamp floor does not lift the hip, and POSTURE bounce -----

describe('#107: --leg-scale clamp floor does not lift the hip, and POSTURE reads the bounce per support span', () => {
  const THIGH = -95;
  const SHIN = -97;
  const N = 24;
  const DT = 1 / 24;
  /** Knee bend asks down to 0.70 on frame 12, below the 0.85 clamp floor. */
  const askF = (i: number): number => (i < 6 || i > 18 ? 1 : 1 - 0.30 * Math.sin(((i - 6) / 12) * Math.PI));
  const STILL: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };
  const V = add(dir(THIGH, 80), dir(SHIN, 70));
  const W: Pt = [80 * Math.cos(THIGH * RAD) + 70 * Math.cos(SHIN * RAD), 80 * Math.sin(THIGH * RAD) + 70 * Math.sin(SHIN * RAD)];

  function bendPose(): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const drop: Pt = [(1 - askF(i)) * V[0], (1 - askF(i)) * V[1]];
      for (const [name, at] of Object.entries(j)) {
        const a = at.at as Pt;
        if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
        j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
      }
      for (const s of ['r', 'l'] as const) {
        const hip = j[`${s}_hip`]!.at as Pt;
        const knee = add(hip, dir(THIGH, 80 * askF(i)));
        const ankle = add(knee, dir(SHIN, 70 * askF(i)));
        j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
        j[`${s}_ankle`] = { state: 'observed', at: ankle, score: 0.9 };
      }
    });
  }

  function mapWithPelvis(): Record<string, unknown> {
    return {
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
      ],
    };
  }

  test('a leg asking below the clamp floor holds the bone at the floor without lifting the hip, every scale lands, and POSTURE prints the bounce per support span', () => {
    const c = setup({ map: mapWithPelvis(), pose: bendPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.85,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // Landing holds every scale.
    const lands = linesOf(r, 'LAND');
    expect(lands.filter((l) => l.includes(' scale — '))).toHaveLength(4);
    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const hip0 = byName(poses[0]!.bones).get('hip')!;
    for (let i = 0; i < N; i++) {
      const b = byName(poses[i]!.bones);
      // The supporting leg (r) scales to askF(i) so its ankle stays on #85's floor (#133); the free leg (l) is held at the 0.85 clamp floor.
      const wantSupport = askF(i);
      const wantFree = Math.max(0.85, askF(i));
      for (const seg of ['leg_r0', 'leg_r1']) {
        expect(Math.abs(Math.hypot(b.get(seg)!.a, b.get(seg)!.c) - wantSupport)).toBeLessThan(1e-4);
      }
      for (const seg of ['leg_l0', 'leg_l1']) {
        expect(Math.abs(Math.hypot(b.get(seg)!.a, b.get(seg)!.c) - wantFree)).toBeLessThan(1e-4);
      }
      // The hip is placed from the asked scale askF(i), not lifted by the 0.85 clamp floor.
      const wantHip: Pt = [hip0.worldX + (1 - askF(i)) * W[0], hip0.worldY + (1 - askF(i)) * W[1]];
      const h = b.get('hip')!;
      expect(Math.hypot(h.worldX - wantHip[0], h.worldY - wantHip[1])).toBeLessThan(0.05);
    }
    const posture = linesOf(r, 'POSTURE');
    const bounceLine = posture.find((l) => l.startsWith('POSTURE bounce r 0–23'));
    expect(bounceLine).toBeDefined();
    expect(bounceLine).toContain('r=1.000');
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { posture: { bounce: Array<{ side: string; frames: [number, number]; hip: { ratio: number; corr: number }; neck: { ratio: number; corr: number }; eyesNeck: { ratio: number; corr: number | null } }> } };
    expect(rep.posture.bounce).toHaveLength(1);
    expect(rep.posture.bounce[0]!.side).toBe('r');
    expect(rep.posture.bounce[0]!.frames).toEqual([0, 23]);
    expect(rep.posture.bounce[0]!.hip.corr).toBeCloseTo(1, 5);
    expect(rep.posture.bounce[0]!.neck.corr).toBeCloseTo(1, 5);
    expect(rep.posture.bounce[0]!.eyesNeck.ratio).toBeNull();
  }, SLOW);

  test('mutant (#107): placing the hip from the clamped scale lifts the hip when the leg asks below the floor', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm107-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const lp = poseLegsWith(i, askedScales);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const lp = poseLegs(i);'));
      const c = setup({ map: mapWithPelvis(), pose: bendPose() });
      const r = retarget(c, ['--leg-scale', '0.85,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const hip0 = byName(poses[0]!.bones).get('hip')!;
      const hip12 = byName(poses[12]!.bones).get('hip')!;
      const wantY = hip0.worldY + (1 - askF(12)) * W[1];
      const lift = hip12.worldY - wantY;
      console.log(`  mutant "plantHip from clamped scale": frame 12 hip lifted by +${lift.toFixed(2)} units`);
      expect(lift).toBeGreaterThan(20);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#111: the head chain nods from the eyes\' vertical travel against the neck', () => {
  const N = 24;
  const DT = 1 / 24;
  const headRig = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });
  const rollDeg = (i: number): number => 12 * Math.sin((i / N) * 2 * Math.PI);
  /** World vertical nod in rig units: 0 on frames [0, 2] and [21, 23] (<0.5s so clean's stillness hold does not blend), and a known -0.4 dip inside. */
  const nodY = (i: number): number => (i >= 2 && i <= 21 ? -0.4 * Math.sin(((i - 2) / 19) * Math.PI) : 0);

  function nodPose(withNod: boolean, withRoll = false): Record<string, unknown> {
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90 };
    return poseDoc(m, (i, j) => {
      // Keep right foot planted as support so --plant-feet emits POSTURE bounce r 0–23.
      j.r_ankle = { state: 'observed', at: [-20, 350], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [20, 320], score: 0.9 };
      const r = j.r_eye!.at as Pt;
      const l = j.l_eye!.at as Pt;
      const dyPic = withNod ? -nodY(i) / SCALE : 0;
      const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2 + dyPic];
      const d = dir(withRoll ? rollDeg(i) : 0, 6);
      j.r_eye = { state: 'observed', at: [mid[0] - d[0], mid[1] - d[1]], score: 0.9 };
      j.l_eye = { state: 'observed', at: [mid[0] + d[0], mid[1] + d[1]], score: 0.9 };
    });
  }

  test('a known nod is keyed on head.translate, POSTURE eyes − neck ratio is >= 0.5, and roll is unchanged where the reference does not nod', () => {
    const cNod = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: nodPose(true, false) });
    const report = join(cNod.dir, 'report.json');
    const rNod = retarget(cNod, ['--plant-feet', '--report', report]);
    expect(rNod.stderr).toBe('');
    expect(rNod.status).toBe(0);

    // Bar 2: roll is unchanged where the reference does not nod (and on every frame when roll is present).
    const cRollNod = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: nodPose(true, true) });
    const cRollFlat = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: nodPose(false, true) });
    expect(retarget(cRollNod, ['--plant-feet']).status).toBe(0);
    expect(retarget(cRollFlat, ['--plant-feet']).status).toBe(0);
    const tracksRollNod = motionOf(cRollNod.out).animations.dance!.tracks;
    const tracksRollFlat = motionOf(cRollFlat.out).animations.dance!.tracks;
    const headRotNod = tracksRollNod.find((t) => t.bone === 'head' && t.property === 'rotate')!;
    const headRotFlat = tracksRollFlat.find((t) => t.bone === 'head' && t.property === 'rotate')!;
    expect(headRotNod.keys).toEqual(headRotFlat.keys);
    expect(tracksRollFlat.find((t) => t.bone === 'head' && t.property === 'translate')).toBeUndefined();

    // Bar 3: a known nod is keyed on head.translate, and the posed eyes − neck vertical travel matches nodY(i).
    const tracksNod = motionOf(cNod.out).animations.dance!.tracks;
    const headTrans = tracksNod.find((t) => t.bone === 'head' && t.property === 'translate');
    expect(headTrans).toBeDefined();
    for (const i of [0, 1, 2, 21, 22, 23]) {
      expect(headTrans!.keys[i]!.v).toEqual([0, 0]);
    }
    const poses = poseRawAnimation(loadBuild(cNod.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const b0 = byName(poses[0]!.bones);
    const baseEN = (b0.get('eye_r')!.worldY + b0.get('eye_l')!.worldY) / 2 - b0.get('neck')!.worldY;
    poses.forEach((p, i) => {
      const b = byName(p.bones);
      const en = (b.get('eye_r')!.worldY + b.get('eye_l')!.worldY) / 2 - b.get('neck')!.worldY;
      expect(Math.abs(en - (baseEN + nodY(i)))).toBeLessThan(0.01);
    });

    // Bar 1: POSTURE bounce row reads eyes − neck ratio >= 0.5.
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { posture: { bounce: Array<{ eyesNeck: { rig: number; reference: number; ratio: number; corr: number } }> } };
    expect(rep.posture.bounce).toHaveLength(1);
    expect(rep.posture.bounce[0]!.eyesNeck.ratio).toBeGreaterThanOrEqual(0.5);
    expect(rep.posture.bounce[0]!.eyesNeck.ratio).toBeCloseTo(1, 3);
    expect(rep.posture.bounce[0]!.eyesNeck.corr).toBeCloseTo(1, 5);
  }, SLOW);

  test('mutant (#111): without the head nod channel, the posed head reads 0 vertical travel against the neck', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm111-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'if (headNodTrack !== null) tracks.push(headNodTrack);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));
      const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: nodPose(true, false) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { posture: { bounce: Array<{ eyesNeck: { rig: number; reference: number; ratio: number } }> } };
      console.log(`  mutant "without headNodTrack": eyesNeck rig sd ${rep.posture.bounce[0]!.eyesNeck.rig.toFixed(4)}u, ratio ${rep.posture.bounce[0]!.eyesNeck.ratio.toFixed(4)}`);
      expect(rep.posture.bounce[0]!.eyesNeck.rig).toBeCloseTo(0, 6);
      expect(rep.posture.bounce[0]!.eyesNeck.ratio).toBeCloseTo(0, 6);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#133: a supporting leg that asks under --leg-scale\'s floor is scaled to its own range so its ankle stays on #85\'s floor', () => {
  const THIGH = -90;
  const SHIN = -90;
  const N = 24;
  const DT = 1 / 24;
  /** Knee bend asks down to 0.60 on frame 12, below the 0.80 clamp floor. */
  const askF = (i: number): number => (i < 6 || i > 18 ? 1 : 1 - 0.40 * Math.sin(((i - 6) / 12) * Math.PI));
  const STILL: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };
  const V = add(dir(THIGH, 80), dir(SHIN, 70));
  const BONE_LEN = 80 + 70;

  /** Right foot is planted as the supporting leg on the floor; left foot is lifted in the air as the free leg; both legs ask askF(i) down to 0.60. */
  function supportAndFreeBendPose(): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const drop: Pt = [(1 - askF(i)) * V[0], (1 - askF(i)) * V[1]];
      for (const [name, at] of Object.entries(j)) {
        const a = at.at as Pt;
        if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
        j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
      }
      for (const s of ['r', 'l'] as const) {
        const hip = j[`${s}_hip`]!.at as Pt;
        const knee = add(hip, dir(THIGH, 80 * askF(i)));
        const ankle = add(knee, dir(SHIN, 70 * askF(i)));
        j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
        j[`${s}_ankle`] = { state: 'observed', at: ankle, score: 0.9 };
      }
    });
  }

  function mapWithPelvis(): Record<string, unknown> {
    return {
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
      ],
    };
  }

  test('supporting leg asking 0.6 with floor 0.8 scales to 0.6 and plants on #85\'s floor, while free leg asking 0.6 stays clamped at 0.8', () => {
    const c = setup({ map: mapWithPelvis(), pose: supportAndFreeBendPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    // Summary lines print LEG-SCALE past the floor (support) for leg_r0 and leg_r1, and not for free leg_l0/leg_l1.
    const supportLines = r.stdout.split('\n').filter((l) => l.includes('LEG-SCALE past the floor (support):'));
    expect(supportLines).toHaveLength(2);
    expect(supportLines[0]).toContain('chain "leg_r" bone "leg_r0" (supporting foot r) frames 9–15');
    expect(supportLines[0]).toContain('asked 0.6000–0.7172 under 0.8, used 0.6000–0.7172');
    expect(supportLines[1]).toContain('chain "leg_r" bone "leg_r1" (supporting foot r) frames 9–15');
    expect(supportLines.some((l) => l.includes('leg_l0') || l.includes('leg_l1'))).toBe(false);

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const b0 = byName(poses[0]!.bones);
    const ankleY = (b: Map<string, RawBone>): number => {
      const s1 = b.get('leg_r1')!;
      return s1.worldY + s1.c * 70;
    };
    const floorAnkleY = ankleY(b0);

    for (let i = 0; i < N; i++) {
      const b = byName(poses[i]!.bones);
      const wantSupport = askF(i);
      const wantFree = Math.max(0.8, askF(i));
      // Supporting right leg scales down to 0.60 (its own range) and its ankle stays on #85's floor.
      for (const seg of ['leg_r0', 'leg_r1']) {
        expect(Math.abs(Math.hypot(b.get(seg)!.a, b.get(seg)!.c) - wantSupport)).toBeLessThan(1e-4);
      }
      expect(Math.abs(ankleY(b) - floorAnkleY)).toBeLessThan(0.05);
      // Free left leg asking 0.60 stays clamped at 0.80.
      for (const seg of ['leg_l0', 'leg_l1']) {
        expect(Math.abs(Math.hypot(b.get(seg)!.a, b.get(seg)!.c) - wantFree)).toBeLessThan(1e-4);
      }
    }

    // Report JSON records support runs on leg_r0 and leg_r1, and not on leg_l0 or leg_l1.
    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      legScale: Array<{ chain: string; bone: string; support?: Array<{ side: string; frames: [number, number]; asked: { min: number; max: number }; used: { min: number; max: number } }> }>;
    };
    const r0 = rep.legScale.find((ls) => ls.bone === 'leg_r0')!;
    const r1 = rep.legScale.find((ls) => ls.bone === 'leg_r1')!;
    const l0 = rep.legScale.find((ls) => ls.bone === 'leg_l0')!;
    const l1 = rep.legScale.find((ls) => ls.bone === 'leg_l1')!;
    expect(r0.support).toBeDefined();
    expect(r0.support).toHaveLength(1);
    expect(r0.support![0]!.side).toBe('r');
    expect(r0.support![0]!.frames).toEqual([9, 15]);
    expect(r0.support![0]!.asked.min).toBeCloseTo(0.6, 3);
    expect(r0.support![0]!.used.min).toBeCloseTo(0.6, 3);
    expect(r1.support).toBeDefined();
    expect(l0.support).toBeUndefined();
    expect(l1.support).toBeUndefined();
  }, SLOW);

  test('when the lower bound is above asked on a supporting frame, scaleSupport clamps at the bound and lifts the hip by the remainder', () => {
    const legScale: LegScale[] = [
      {
        chain: 'leg_r',
        bone: 'leg_r0',
        joints: ['r_hip', 'r_knee'],
        straight: 80,
        ratio: { min: 0.6, median: 0.6, max: 0.6 },
        limits: [0.8, 1.05],
        low: [[0, 0]],
        high: [],
        scale: [0.8],
        asked: [0.6],
      },
      {
        chain: 'leg_r',
        bone: 'leg_r1',
        joints: ['r_knee', 'r_ankle'],
        straight: 70,
        ratio: { min: 0.6, median: 0.6, max: 0.6 },
        limits: [0.8, 1.05],
        low: [[0, 0]],
        high: [],
        scale: [0.8],
        asked: [0.6],
      },
    ];
    const scales = new Map<string, number[]>([
      ['leg_r0', [0.8]],
      ['leg_r1', [0.8]],
    ]);
    const feet: Feet = {
      legLength: { r: 150, l: 150 },
      support: ['r'],
      supports: [{ side: 'r', frames: [0, 0] }],
      jumps: [],
      steps: [],
      changes: [],
    };
    const rChain: Chain = { name: 'leg_r', bones: ['leg_r0', 'leg_r1'], joints: ['r_hip', 'r_knee', 'r_ankle'], aim: ['x', 'x'], reach: false, bend: 'free', range: {} };
    const lChain: Chain = { name: 'leg_l', bones: ['leg_l0', 'leg_l1'], joints: ['l_hip', 'l_knee', 'l_ankle'], aim: ['x', 'x'], reach: false, bend: 'free', range: {} };
    const hip: Pt[] = [[0, 100]];
    // Supporting leg asks 0.60, floor is 0.80, and an explicit lower bound of 0.70 clamps at max(0.60, min(0.80, 0.70)) = 0.70.
    // The remaining (0.70 - 0.60) = 0.10 of downward leg vector (0, -150) lifts the hip by +15u so the ankle still meets the floor.
    scaleSupport(
      legScale,
      scales,
      feet,
      { r: { chain: rChain, ankleBone: 'leg_r1' }, l: { chain: lChain, ankleBone: 'leg_l1' } },
      hip,
      () => [0, -0.6 * BONE_LEN],
      () => [0, -(scales.get('leg_r0')![0]! * 80 + scales.get('leg_r1')![0]! * 70)],
      { r: [0.7], l: [1.0] },
    );
    expect(scales.get('leg_r0')![0]).toBeCloseTo(0.7, 6);
    expect(scales.get('leg_r1')![0]).toBeCloseTo(0.7, 6);
    expect(hip[0]![1]).toBeCloseTo(115, 6);
    expect(legScale[0]!.support).toEqual([
      { side: 'r', frames: [0, 0], asked: { min: 0.6, max: 0.6 }, used: { min: 0.7, max: 0.7 }, clamped: { bound: 0.7, hipRise: 15 } },
    ]);
  });

  test('mutant (#133): clamping the supporting leg at 0.8 puts the ankle 0.2 * bone below #85\'s floor', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm133-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'scaleSupport(legScale, scales, feet, L, hip, (i, s) => offsets[i]![s], (i, s) => tipOf(rest, poseLegs(i), L[s].ankleBone));';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));
      const c = setup({ map: mapWithPelvis(), pose: supportAndFreeBendPose() });
      const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const ankleY = (b: Map<string, RawBone>): number => {
        const s1 = b.get('leg_r1')!;
        return s1.worldY + s1.c * 70;
      };
      const floorAnkleY = ankleY(byName(poses[0]!.bones));
      const ankle12Y = ankleY(byName(poses[12]!.bones));
      const dropBelowFloor = floorAnkleY - ankle12Y;
      console.log(`  mutant "supporting leg clamped at 0.8": frame 12 ankle is ${dropBelowFloor.toFixed(2)}u below floor (0.2 * ${BONE_LEN} = ${(0.2 * BONE_LEN).toFixed(2)}u)`);
      expect(Math.abs(dropBelowFloor - 0.2 * BONE_LEN)).toBeLessThan(0.05);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#137: under --stance and --leg-scale, a straight stance leg whose shin was shortened below STANCE_BOUNDS[0] restores its shin before stretching to the floor', () => {
  const THIGH = -90;
  const SHIN = -90;
  const N = 24;
  const DT = 1 / 24;
  const BONE_LEN = 80 + 70;
  const STILL: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };

  /**
   * Right foot (`r`) supports on every frame at full length (90 + 60 = 150 px).
   * Left foot (`l`, free) stands beside it in a `state = 'both'` stance:
   * - frames 0–11: thigh 90 px, shin 60 px, total 150 px (both sides share straight thigh 90 px, shin 60 px);
   * - frames 12–23 (held ending span): l_ankle is 10 px (0.0667 leg lengths, within `--stance 0.07`) above r_ankle while l_knee stays at 90 px below l_hip, so the whole leg is 140 / 150 = 0.9333 >= 0.92 (not folded), the thigh is 90 / 90 = 1.00 >= 0.92, and the shin is 50 / 60 = 0.8333 < 0.92.
   */
  function endingShortShinPose(): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const rHip = j.r_hip!.at as Pt;
      j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 90], score: 0.9 };
      j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150], score: 0.9 };
      const lHip = j.l_hip!.at as Pt;
      const ankleLen = i < 12 ? 150 : 140;
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 90], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + ankleLen], score: 0.9 };
    });
  }

  function mapWithPelvis(): Record<string, unknown> {
    return {
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
      ],
    };
  }

  test('restores the shortened shin on the ending span so both ankles land on #85\'s floor with no stance.over, while leaving earlier frames and the supporting leg unchanged', () => {
    const c = setup({ map: mapWithPelvis(), pose: endingShortShinPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      feet: { floor: number };
      stance: { over: unknown[]; runs: Array<{ state: string; side: string; frames: [number, number] }> };
    };
    expect(rep.stance.runs.map((x) => [x.state, x.side, x.frames])).toEqual([['both', 'l', [0, 23]]]);
    expect(rep.stance.over).toEqual([]);

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const ankleOf = (b: Map<string, RawBone>, side: 'r' | 'l'): Pt => {
      const s1 = b.get(`leg_${side}1`)!;
      return [s1.worldX + s1.a * 70, s1.worldY + s1.c * 70];
    };
    const floorY = rep.feet.floor;

    for (let i = 0; i < N; i++) {
      const b = byName(poses[i]!.bones);
      const ar = ankleOf(b, 'r');
      const al = ankleOf(b, 'l');
      // Both the supporting right ankle and the stance left ankle sit on #85's floor on every frame.
      expect(Math.abs(ar[1] - floorY)).toBeLessThan(0.05);
      expect(Math.abs(al[1] - floorY)).toBeLessThan(0.05);
      if (i >= 12) {
        // On the ending span (12–23), both thigh and shin of the stance leg are un-squashed (~1.00) and knees are level.
        expect(Math.hypot(b.get('leg_l0')!.a, b.get('leg_l0')!.c)).toBeCloseTo(1, 3);
        expect(Math.hypot(b.get('leg_l1')!.a, b.get('leg_l1')!.c)).toBeCloseTo(1, 3);
        expect(Math.abs(b.get('leg_l1')!.worldY - b.get('leg_r1')!.worldY)).toBeLessThan(0.05);
      }
    }
  }, SLOW);

  test('mutant (#137): without unshortenStanceShin the ending span exceeds STANCE_BOUNDS[1], floats off #85\'s floor, and leaves frames 0–11 and leg_r byte-identical', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm137-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'legScaleOn ? unshortenStanceShin(scales, L, posedFeet, lower) : posedFeet';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'posedFeet'));

      const cPkg = setup({ map: mapWithPelvis(), pose: endingShortShinPose() });
      const rPkg = retarget(cPkg, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07']);
      expect(rPkg.status).toBe(0);
      const pkgMotion = motionOf(cPkg.out);

      const cMut = setup({ map: mapWithPelvis(), pose: endingShortShinPose() });
      const mReport = join(cMut.dir, 'report.json');
      const rMut = retarget(cMut, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07', '--report', mReport], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutMotion = motionOf(cMut.out);

      // Bar 2: outside the ending span (frames 0–11), and on the supporting right leg across all frames, keys are byte-identical.
      for (let t = 0; t < pkgMotion.animations.dance!.tracks.length; t++) {
        const pt = pkgMotion.animations.dance!.tracks[t]!;
        const mt = mutMotion.animations.dance!.tracks[t]!;
        for (let i = 0; i < 12; i++) {
          expect(pt.keys[i]).toEqual(mt.keys[i]);
        }
        if ('bone' in pt && (pt.bone === 'leg_r0' || pt.bone === 'leg_r1' || pt.bone === 'hip')) {
          expect(pt.keys).toEqual(mt.keys);
        }
      }

      // Bar 3: on the mutant, frames 12–23 exceed 1.08 (stance.over non-empty) and the left ankle floats off #85's floor.
      const rep = JSON.parse(readFileSync(mReport, 'utf8')) as {
        feet: { floor: number };
        stance: { over: Array<{ side: string; frames: [number, number]; needed: number; left: number }> };
      };
      expect(rep.stance.over).toHaveLength(1);
      expect(rep.stance.over[0]!.side).toBe('l');
      expect(rep.stance.over[0]!.frames).toEqual([12, 23]);
      expect(rep.stance.over[0]!.needed).toBeGreaterThan(1.08);

      const poses = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const b15 = byName(poses[15]!.bones);
      const s1 = b15.get('leg_l1')!;
      const ankle15Y = s1.worldY + s1.c * 70;
      const gap = ankle15Y - rep.feet.floor;
      console.log(`  mutant "without unshortenStanceShin": frame 15 needed k ${rep.stance.over[0]!.needed.toFixed(4)} > 1.08, left ankle ${gap.toFixed(2)}u (${(gap / BONE_LEN).toFixed(4)} leg lengths) above floor`);
      expect(gap).toBeGreaterThan(0.3);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('leg-scale (#148): one straight length per segment for both legs, so consecutive landings on opposite feet place the hip at the same height', () => {
  const N = 24;
  const DT = 1 / 24;
  const THIGH = 90;
  const SHIN = 90;
  const BONE_LEN = 150;

  /**
   * Two consecutive landings on opposite feet (`r` on frames 0–3, flight on 4–9, `l` on frames 10–13, flight on 14–19, `r` on 20–23):
   * - On right-support frames (`0–3, 20–23`), `r_ankle` is at identical detector pixel distance (`141 px` below `r_hip`: thigh `76 px`, shin `65 px`), while on flight frames (`4–9, 14–19`) the right leg kicks out to `80 + 70 = 150 px`, giving right thigh/shin a 95th-percentile straight length of `80 px` / `70 px`.
   * - The left leg (`l`) reaches only `76 + 65 = 141 px` at its peak and lands at the exact same `141 px` pixel distance on `10–13` (`76 px` thigh, `65 px` shin).
   * With shared straight length (#148), both legs divide by `80 px` (thigh) and `70 px` (shin), so both landings place the hip at the exact same height (`141.00 u` above the floor). With per-side denominators, `l` gets `scale = 1.0` (`150.00 u`) while `r` gets `scale = 141 / 150 = 0.94` (`141.00 u`), creating a `9.00 u` (`6.0%`) alternating landing height step.
   */
  function asymmetricPeakSymmetricLandingPose(): Record<string, unknown> {
    const motion: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: () => 90,
      rt: () => THIGH,
      rs: () => SHIN,
      lt: () => THIGH,
      ls: () => SHIN,
      hip: (i) => {
        const flight = (i >= 4 && i <= 9) || (i >= 14 && i <= 19);
        return [0, flight ? -30 : 0];
      },
    };
    return poseDoc(motion, (i, j) => {
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      const rSupport = i <= 3 || i >= 20;
      const lSupport = i >= 10 && i <= 13;
      const flight = !rSupport && !lSupport;
      // Right leg: 76 + 65 = 141 px on support (0..3, 20..23) and during left support (lifted to 110 px); 80 + 70 = 150 px in flight (8 frames = 33% of 24 -> 95th percentile is 80 / 70).
      if (rSupport) {
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 76], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 141], score: 0.9 };
      } else if (flight) {
        j.r_knee = { state: 'observed', at: [rHip[0] + 64, rHip[1] + 48], score: 0.9 }; // hypot(64, 48) = 80
        j.r_ankle = { state: 'observed', at: [rHip[0] + 64 + 56, rHip[1] + 48 + 42], score: 0.9 }; // hypot(56, 42) = 70
      } else {
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 55], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 110], score: 0.9 };
      }

      // Left leg: never exceeds 76 + 65 = 141 px; on left support (10..13), identical vertical 76 + 65 = 141 px as right support!
      if (lSupport) {
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 76], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 141], score: 0.9 };
      } else if (flight) {
        j.l_knee = { state: 'observed', at: [lHip[0] + 60.8, lHip[1] + 45.6], score: 0.9 }; // hypot = 76
        j.l_ankle = { state: 'observed', at: [lHip[0] + 60.8 + 52, lHip[1] + 45.6 + 39], score: 0.9 }; // hypot = 65
      } else {
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 55], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 110], score: 0.9 };
      }
    });
  }

  test('shares the larger 95th-percentile straight length across both legs so consecutive landings on opposite feet place the hip at the same height', () => {
    const c = setup({ pose: asymmetricPeakSymmetricLandingPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.5,1.5', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('larger 95th percentile of 24 frames, both legs');

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      legScale: Array<{ bone: string; straight: number }>;
    };
    const byBone = new Map(rep.legScale.map((s) => [s.bone, s.straight]));
    expect(byBone.get('leg_r0')).toBeCloseTo(80, 3);
    expect(byBone.get('leg_l0')).toBeCloseTo(80, 3);
    expect(byBone.get('leg_r1')).toBeCloseTo(70, 3);
    expect(byBone.get('leg_l1')).toBeCloseTo(70, 3);

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const hipY0 = byName(poses[0]!.bones).get('hip')!.worldY;
    const hipY10 = byName(poses[10]!.bones).get('hip')!.worldY;
    expect(Math.abs(hipY0 - hipY10) / BONE_LEN).toBeLessThan(0.01);
  }, SLOW);

  test('mutant (per-side): taking each leg\'s 95th percentile separately gives opposite landings different hip heights', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm148-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const ls = legScaleOf(seg.lengths, limits, straightByKind.get(seg.kind)! * rigShareOf(seg));';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const ls = legScaleOf(seg.lengths, limits, seg.ownStraight);'));

      const cMut = setup({ pose: asymmetricPeakSymmetricLandingPose() });
      const rMut = retarget(cMut, ['--leg-scale', '0.5,1.5', '--plant-feet'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);

      const poses = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const hipY0 = byName(poses[0]!.bones).get('hip')!.worldY;
      const hipY10 = byName(poses[10]!.bones).get('hip')!.worldY;
      const diff = Math.abs(hipY10 - hipY0);
      console.log(`  mutant "per-side": landing hipY0=${hipY0.toFixed(2)}u vs hipY10=${hipY10.toFixed(2)}u, diff=${diff.toFixed(2)}u (${((diff / BONE_LEN) * 100).toFixed(2)}% > 1%)`);
      expect(diff / BONE_LEN).toBeGreaterThan(0.05);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('leg-scale (#153): respect noScale and noScaleOrReflection inheritance when solving a leg segment under a scaled parent', () => {
  /** A 16-frame pose where the right thigh shortens to ~0.75 of straight on frame 15 while the right shin turns 45° across it. */
  function foreshortenedPose(): Record<string, unknown> {
    return poseDoc(BASE, (i, j) => {
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150], score: 0.9 };
      if (i < 15) {
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150], score: 0.9 };
      } else {
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 60], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0] - 45, rHip[1] + 105], score: 0.9 };
      }
    });
  }

  test('lands scale, angle and ankle under direct noScale / noScaleOrReflection and under an unmapped noScale control bone (dense and --reduce)', () => {
    for (const mode of ['noScale', 'noScaleOrReflection', 'ctl-noScale'] as const) {
      const c = setup({
        pose: foreshortenedPose(),
        rig: {
          bones: (bs) => {
            if (mode !== 'ctl-noScale') {
              return bs.map((b) => (b.name === 'leg_r1' || b.name === 'leg_l1' ? { ...b, inherit: mode } : b));
            }
            const out: BoneSpec[] = [];
            for (const b of bs) {
              if (b.name === 'leg_r1' || b.name === 'leg_l1') {
                const ctl = `${b.name}_ctl`;
                out.push({ name: ctl, parent: b.parent, x: b.x, y: b.y, rotation: b.rotation, length: 0, inherit: 'noScale' });
                out.push({ ...b, parent: ctl, x: 0, y: 0, rotation: 0, inherit: 'normal' });
              } else {
                out.push(b);
              }
            }
            return out;
          },
        },
      });
      for (const extra of [[], ['--reduce', '0.5']]) {
        const report = join(c.dir, `report_${mode}_${extra.length}.json`);
        const r = retarget(c, ['--leg-scale', '0.55,1.05', '--plant-feet', '--report', report, ...extra]);
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
        const rep = JSON.parse(readFileSync(report, 'utf8')) as {
          landings: Array<{ bone: string; kind: string; worst: number; tolerance: number }>;
          shear: Array<{ bone: string; shear: number }>;
        };
        for (const l of rep.landings) expect(l.worst).toBeLessThanOrEqual(l.tolerance);
        const shinShear = rep.shear.find((s) => s.bone === 'leg_r1')!;
        expect(shinShear.shear).toBeLessThan(1e-3);
      }
    }
  }, SLOW);

  test('mutant (ignore-noscale): treating a noScale shin as normal divides by the stripped parent scale and fails POSE_LANDS', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm153-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = "const noScale = rb.inherit === 'noScale' || rb.inherit === 'noScaleOrReflection' ? rb.inherit : null;";
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const noScale = null;'));

      const cMut = setup({
        pose: foreshortenedPose(),
        rig: {
          bones: (bs) => bs.map((b) => (b.name === 'leg_r1' || b.name === 'leg_l1' ? { ...b, inherit: 'noScale' } : b)),
        },
      });
      const rMut = retarget(cMut, ['--leg-scale', '0.55,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(1);
      expect(rMut.stderr).toContain('POSE_LANDS: bone "leg_r1" scale');
      expect(rMut.stderr).toContain('POSE_LANDS: bone "leg_r1:tip" ankle');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('face direction (rig-c/pose#138)', () => {
  function facePose(rawYawDeg: (i: number) => number, rawPitchDeg: (i: number) => number = () => 0): Record<string, unknown> {
    return poseDoc(BASE, (i, joints) => {
      const neck = (joints.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      const dEye = 12;
      const dEar = 24;
      joints.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      joints.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      joints.r_ear = { state: 'observed', at: [midEye[0] - dEar / 2, midEye[1] + 5], score: 0.95 };
      joints.l_ear = { state: 'observed', at: [midEye[0] + dEar / 2, midEye[1] + 5], score: 0.95 };
      // For horizontal eyes (de = 12, da = 24), xne = (midEye.x - Nx) / 12 and xna = (midEye.x - Nx) / 24 = xne / 2,
      // so (2*xne + xna)/2 = 1.25 * (midEye.x - Nx) / 12 = tan(yaw).
      const ty = Math.tan(rawYawDeg(i) * RAD);
      const tp = Math.tan(rawPitchDeg(i) * RAD);
      const nx = midEye[0] - (ty * dEye) / 1.25;
      const ny = midEye[1] + 5 + tp * dEye;
      joints.nose = { state: 'observed', at: [nx, ny], score: 0.95 };
    });
  }

  test('refuses malformed face map entries and duplicate or missing face bones by name', () => {
    const badMaps: Array<{ face: unknown; code: string }> = [
      { face: 'yaw', code: 'MAP_FACE_SHAPE' },
      { face: {}, code: 'MAP_FACE_SHAPE' },
      { face: { yaw: 12 }, code: 'MAP_FACE_SHAPE' },
      { face: { yaw: { bone: '', range: [-15, 15] } }, code: 'MAP_FACE_BONE' },
      { face: { yaw: { bone: 'yaw', range: [5, 15] } }, code: 'MAP_FACE_RANGE' },
      { face: { yaw: { bone: 'yaw', range: [-15, -5] } }, code: 'MAP_FACE_RANGE' },
      { face: { yaw: { bone: 'yaw', range: [15, -15] } }, code: 'MAP_FACE_RANGE' },
      { face: { yaw: { bone: 'no_such_bone', range: [-15, 15] } }, code: 'MAP_BONE_EXISTS' },
      { face: { yaw: { bone: 'chest', range: [-15, 15] } }, code: 'MAP_BONE_ONCE' },
      { face: { yaw: { bone: 'yaw', range: [-15, 15] }, pitch: { bone: 'yaw', range: [-10, 15] } }, code: 'MAP_BONE_ONCE' },
    ];
    for (const { face, code } of badMaps) {
      const c = setup({
        rig: { bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }, { name: 'pitch', parent: 'root' }] },
        map: { ...baseMap(), face },
      });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(code);
    }
  }, SLOW);

  test('monotonic nose turn 0 → max yaw drives the yaw axis monotonically within range (r >= 0.9), and leaves every non-face track byte-identical', () => {
    // Raw yaw sweeps strictly monotonically from 0° to +30° across the 16 frames (compressed into [-15, 15] -> 0° to +15°),
    // and pitch sweeps from -15° to +15° (compressed into [-10, 15] -> -10° to +15°).
    const pose = facePose(
      (i) => (30 * i) / (BASE.n - 1),
      (i) => -15 + (30 * i) / (BASE.n - 1),
    );
    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }, { name: 'pitch', parent: 'root' }],
    };
    const withoutFace = setup({ rig: rigOpts, map: baseMap(), pose });
    const withFace = setup({
      rig: rigOpts,
      map: {
        ...baseMap(),
        face: {
          yaw: { bone: 'yaw', range: [-15, 15] },
          pitch: { bone: 'pitch', range: [-10, 15] },
        },
      },
      pose,
    });

    const r0 = retarget(withoutFace, ['--bends', 'clamp']);
    expect(r0.status).toBe(0);
    expect(linesOf(r0, 'FACE')).toEqual([]);

    const report = join(withFace.dir, 'report.json');
    const r1 = retarget(withFace, ['--bends', 'clamp', '--report', report]);
    expect(r1.stderr).toBe('');
    expect(r1.status).toBe(0);

    const faceLines = linesOf(r1, 'FACE');
    expect(faceLines).toHaveLength(1);
    expect(faceLines[0]).toContain('mapped yaw → bone "yaw" [-15, 15]°');
    expect(faceLines[0]).toContain('pitch → bone "pitch" [-10, 15]°');

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      face: {
        ears: boolean;
        yaw: { bone: string; limits: [number, number]; mapped: { min: number; max: number }; corr: number };
        pitch: { bone: string; limits: [number, number]; mapped: { min: number; max: number }; corr: number };
      };
    };
    expect(rep.face.ears).toBe(true);
    expect(rep.face.yaw.corr).toBeGreaterThanOrEqual(0.9);
    expect(rep.face.pitch.corr).toBeGreaterThanOrEqual(0.9);
    expect(rep.face.yaw.mapped.min).toBeGreaterThanOrEqual(-15);
    expect(rep.face.yaw.mapped.max).toBeLessThanOrEqual(15);
    expect(rep.face.pitch.mapped.min).toBeGreaterThanOrEqual(-10);
    expect(rep.face.pitch.mapped.max).toBeLessThanOrEqual(15);

    // Every non-face track is 100% byte-identical to the run without "face".
    const m0 = JSON.parse(readFileSync(withoutFace.out, 'utf8')) as { animations: { dance: { tracks: Array<{ bone?: string; slot?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } } };
    const m1 = JSON.parse(readFileSync(withFace.out, 'utf8')) as { animations: { dance: { tracks: Array<{ bone?: string; slot?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } } };
    const nonFace1 = m1.animations.dance.tracks.filter((tr) => tr.bone !== 'yaw' && tr.bone !== 'pitch');
    expect(JSON.stringify(nonFace1)).toBe(JSON.stringify(m0.animations.dance.tracks));

    // Yaw track keys increase strictly monotonically from 0° to +15°, and posed build matches.
    const yawTrack = m1.animations.dance.tracks.find((tr) => tr.bone === 'yaw' && tr.property === 'rotate')!;
    expect(yawTrack).toBeDefined();
    const yawKeys = yawTrack.keys.map((k) => k.v[0]!);
    expect(yawKeys[0]).toBeCloseTo(0, 2);
    expect(yawKeys[yawKeys.length - 1]).toBeCloseTo(15, 2);
    for (let i = 1; i < yawKeys.length; i++) {
      expect(yawKeys[i]!).toBeGreaterThan(yawKeys[i - 1]!);
    }
    const doc = loadBuild(withFace.build);
    const steps = Array.from({ length: BASE.n - 1 }, () => BASE.dt);
    const posed = poseRawAnimation(doc, 'dance', steps, {}, 'animation').map((p) => byName(p.bones));
    const posedYaw = posed.map((b) => worldAngle(b, 'yaw'));
    for (let i = 1; i < posedYaw.length; i++) {
      expect(posedYaw[i]!).toBeGreaterThan(posedYaw[i - 1]!);
    }
  }, SLOW);

  test('mutant (face-axis-unkeyed): leaving the face axis unkeyed fails POSE_LANDS and fails monotonic posed yaw', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm138-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = "tracks.push({ bone: ax.bone, property: 'rotate', keys: ax.keys.map((v, i) => ({ t: keyTimes[i]!, v: [v] })) });";
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, '// mutant: face axis unkeyed'));

      const pose = facePose((i) => (15 * i) / (BASE.n - 1));
      const cMut = setup({
        rig: { bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }] },
        map: { ...baseMap(), face: { yaw: { bone: 'yaw', range: [-15, 15] } } },
        pose,
      });
      const rMut = retarget(cMut, ['--bends', 'clamp'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(1);
      expect(rMut.stderr).toContain('POSE_LANDS: bone "yaw" aim');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('figure growth over the dance (#159): rolling leg-scale straight length and bounded head-nod translate keep neck and legs within ±3% across camera zoom drift', () => {
  const N = 60;
  const DT = 1 / 24;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function zoomDriftPose(): Record<string, unknown> {
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    return poseDoc(m, (i, j) => {
      // Camera zoom normalisation inflates the figure from 1.00x on frames 0..24 to 1.35x on frames 35..59,
      // while the shoulders drop relative to the eyes on the ending phrase.
      const z = i < 25 ? 1 : i < 35 ? 1 + (0.35 * (i - 25)) / 10 : 1.35;
      const cx = 100;
      const cy = 200;
      for (const k of Object.keys(j)) {
        const pt = j[k]!.at as Pt;
        j[k] = { ...j[k]!, at: [cx + (pt[0] - cx) * z, cy + (pt[1] - cy) * z] };
      }
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80 * z], score: 0.9 };
      j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150 * z], score: 0.9 };
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80 * z], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150 * z], score: 0.9 };
      if (i >= 40) {
        j.r_eye = { state: 'observed', at: [(j.r_eye!.at as Pt)[0], (j.r_eye!.at as Pt)[1] - 6], score: 0.9 };
        j.l_eye = { state: 'observed', at: [(j.l_eye!.at as Pt)[0], (j.l_eye!.at as Pt)[1] - 6], score: 0.9 };
      }
    });
  }

  test('keeps posed neck, thigh, shin, and whole-leg lengths at the ending within ±3% of frame 0 (and neck within ±2% on every frame)', () => {
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: zoomDriftPose() });
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const measureFrame = (idx: number) => {
      const b = byName(poses[idx]!.bones);
      const neck = Math.hypot(b.get('head')!.worldX - b.get('neck')!.worldX, b.get('head')!.worldY - b.get('neck')!.worldY);
      const rThigh = Math.hypot(b.get('leg_r1')!.worldX - b.get('leg_r0')!.worldX, b.get('leg_r1')!.worldY - b.get('leg_r0')!.worldY);
      const lThigh = Math.hypot(b.get('leg_l1')!.worldX - b.get('leg_l0')!.worldX, b.get('leg_l1')!.worldY - b.get('leg_l0')!.worldY);
      const r1 = b.get('leg_r1')!;
      const l1 = b.get('leg_l1')!;
      const rShin = Math.hypot(r1.a * 70, r1.c * 70);
      const lShin = Math.hypot(l1.a * 70, l1.c * 70);
      return { neck, rThigh, rShin, lThigh, lShin, rLeg: rThigh + rShin, lLeg: lThigh + lShin };
    };
    const f0 = measureFrame(0);
    const fEnd = measureFrame(55);
    for (const k of ['neck', 'rThigh', 'rShin', 'lThigh', 'lShin', 'rLeg', 'lLeg'] as const) {
      const ratio = fEnd[k] / f0[k];
      expect(ratio).toBeGreaterThanOrEqual(0.97);
      expect(ratio).toBeLessThanOrEqual(1.03);
    }
    for (let i = 0; i < N; i++) {
      const ratio = measureFrame(i).neck / f0.neck;
      expect(ratio).toBeGreaterThanOrEqual(0.98 - 1e-4);
      expect(ratio).toBeLessThanOrEqual(1.02 + 1e-4);
    }
  }, SLOW);

  test('mutant (#159): without rolling leg-scale normalisation and head-nod stretch bound, neck and legs grow > 20% at the ending', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm159-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const before = readFileSync(path, 'utf8');
      const fromLeg = 'if (!inPlace && n > 25) {';
      const fromNod = 'const maxNod = !inPlace && neckRestLen > 1e-6 ? 0.02 * neckRestLen : Infinity;';
      expect(before.split(fromLeg)).toHaveLength(2);
      expect(before.split(fromNod)).toHaveLength(2);
      writeFileSync(
        path,
        before
          .replace(fromLeg, 'if (false) {')
          .replace(fromNod, 'const maxNod = Infinity;'),
      );

      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: zoomDriftPose() });
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const poses = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const b0 = byName(poses[0]!.bones);
      const b55 = byName(poses[55]!.bones);
      const neck0 = Math.hypot(b0.get('head')!.worldX - b0.get('neck')!.worldX, b0.get('head')!.worldY - b0.get('neck')!.worldY);
      const neck55 = Math.hypot(b55.get('head')!.worldX - b55.get('neck')!.worldX, b55.get('head')!.worldY - b55.get('neck')!.worldY);
      const lThigh0 = Math.hypot(b0.get('leg_l1')!.worldX - b0.get('leg_l0')!.worldX, b0.get('leg_l1')!.worldY - b0.get('leg_l0')!.worldY);
      const lThigh55 = Math.hypot(b55.get('leg_l1')!.worldX - b55.get('leg_l0')!.worldX, b55.get('leg_l1')!.worldY - b55.get('leg_l0')!.worldY);
      expect(neck55 / neck0).toBeGreaterThan(1.2);
      expect(lThigh55 / lThigh0).toBeGreaterThan(1.2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('face knee (#164): 1:1 mapping inside FACE_KNEE * limit so a single outlier does not crush the rest of the clip', () => {
  function facePose(rawYawDeg: (i: number) => number, rawPitchDeg: (i: number) => number = () => 0): Record<string, unknown> {
    return poseDoc(BASE, (i, joints) => {
      const neck = (joints.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      const dEye = 12;
      const dEar = 24;
      joints.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      joints.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      joints.r_ear = { state: 'observed', at: [midEye[0] - dEar / 2, midEye[1] + 5], score: 0.95 };
      joints.l_ear = { state: 'observed', at: [midEye[0] + dEar / 2, midEye[1] + 5], score: 0.95 };
      const ty = Math.tan(rawYawDeg(i) * RAD);
      const tp = Math.tan(rawPitchDeg(i) * RAD);
      const nx = midEye[0] - (ty * dEye) / 1.25;
      const ny = midEye[1] + 5 + tp * dEye;
      joints.nose = { state: 'observed', at: [nx, ny], score: 0.95 };
    });
  }

  test('a 12° opening yaw with a single 43° outlier maps 1:1 at f0 (within 0.5° of raw), hits 15° at the peak, and stays monotone', () => {
    // Raw yaw is 12° at f0, rises through 12°..15°, spikes to 43° at frame 8, and settles back inside 12°.
    const rawTargets = [12, 11, 10, 9, 11, 13, 18, 28, 43, 25, 14, 12, 10, 8, 6, 4];
    const pose = facePose((i: number) => rawTargets[i]!);
    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }],
    };
    const c = setup({
      rig: rigOpts,
      map: { ...baseMap(), face: { yaw: { bone: 'yaw', range: [-15, 15] } } },
      pose,
    });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FACE')[0]).toContain('(knee [-12, 12]°)');

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      face: {
        read: { yaw: { min: number; max: number } };
        yaw: { knee: [number, number]; mapped: { min: number; max: number }; corr: number };
      };
    };
    expect(rep.face.yaw.knee).toEqual([-12, 12]);
    expect(rep.face.yaw.mapped.max).toBeCloseTo(15, 2);
    expect(rep.face.yaw.corr).toBeGreaterThanOrEqual(0.99);

    const m = JSON.parse(readFileSync(c.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
    };
    const yawKeys = m.animations.dance.tracks.find((tr) => tr.bone === 'yaw' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
    // f0 raw yaw is ~12°, so mapped f0 yaw must stay within 0.5° of raw (1:1 inside the 12° knee).
    expect( yawKeys[0]! ).toBeGreaterThan(11.5);
    expect( Math.abs(yawKeys[0]! - 12) ).toBeLessThanOrEqual(0.5);
    expect( yawKeys[8]! ).toBeCloseTo(15, 2);
  }, SLOW);

  test('mutant (#164): whole-sequence peak compression (FACE_KNEE = 0) crushes the 12° opening yaw down to ~4°', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm164-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'face.ts');
      const from = 'export const FACE_KNEE = 0.8;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const FACE_KNEE = 0;'));

      const rawTargets = [12, 11, 10, 9, 11, 13, 18, 28, 43, 25, 14, 12, 10, 8, 6, 4];
      const pose = facePose((i: number) => rawTargets[i]!);
      const cMut = setup({
        rig: { bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }] },
        map: { ...baseMap(), face: { yaw: { bone: 'yaw', range: [-15, 15] } } },
        pose,
      });
      const rMut = retarget(cMut, ['--bends', 'clamp'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const m = JSON.parse(readFileSync(cMut.out, 'utf8')) as {
        animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
      };
      const yaw0 = m.animations.dance.tracks.find((tr) => tr.bone === 'yaw' && tr.property === 'rotate')!.keys[0]!.v[0]!;
      expect(Math.abs(yaw0 - 12)).toBeGreaterThan(7);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('continuous figure scale (#163) and --camera sidecar track (#161)', () => {
  const N = 80;
  const DT = 1 / 24;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function cameraEventPose(): Record<string, unknown> {
    // Slow rise 0..20 (1.00 -> 1.18), fast drop 20..35 (1.18 -> 1.03), slow rise 35..60 (1.03 -> 1.28), frozen hold 60..79 (1.28).
    const scaleAt = (i: number): number => {
      if (i <= 20) return 1 + (0.18 * i) / 20;
      if (i <= 35) return 1.18 - (0.15 * (i - 20)) / 15;
      if (i <= 60) return 1.03 + (0.25 * (i - 35)) / 25;
      return 1.28;
    };
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    const doc = poseDoc(m, (i, j) => {
      const z = scaleAt(i);
      const cx = 100;
      const cy = 200;
      for (const k of Object.keys(j)) {
        const pt = j[k]!.at as Pt;
        j[k] = { ...j[k]!, at: [cx + (pt[0] - cx) * z, cy + (pt[1] - cy) * z] };
      }
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80 * z], score: 0.9 };
      j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150 * z], score: 0.9 };
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80 * z], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150 * z], score: 0.9 };
    });
    return {
      ...doc,
      cameraSource: 'hand',
      camera: Array.from({ length: N }, (_, i) => ({
        s: i < 20 ? 1 : i < 35 ? 0.92 : 0.78,
        tx: i * 0.5,
        ty: -i * 0.25,
        inliers: 100,
      })),
    };
  }

  test('continuous figure scale holds frozen spans within <= 0.5%, caps frame-to-frame steps at <= 1%, and --camera writes rig-pose-camera/1 while leaving motion.json 100% byte-identical', () => {
    const pose = cameraEventPose();
    const withoutCam = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const withCam = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const camFile = join(withCam.dir, 'camera.json');

    const flags = ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'];
    const r0 = retarget(withoutCam, flags);
    const r1 = retarget(withCam, [...flags, '--camera', camFile]);
    expect(r0.status).toBe(0);
    expect(r1.status).toBe(0);

    // #161 Bar 1: motion.json is 100% byte-identical with and without --camera.
    const bytes0 = readFileSync(withoutCam.out, 'utf8');
    const bytes1 = readFileSync(withCam.out, 'utf8');
    expect(bytes1).toBe(bytes0);

    // #161 Bar 2 & #163 Bars 1-3: inspect camera.json and posed standing height.
    const cam = JSON.parse(readFileSync(camFile, 'utf8')) as {
      spec: string;
      frames: Array<{ frame: number; t: number; s: number; rawS: number; tx: number; ty: number; videoS: number }>;
      summary: { minS: number; maxS: number; maxStep: { step: number; frame: number; t: number }; endOverStart: number };
    };
    expect(cam.spec).toBe('rig-pose-camera/1');
    expect(cam.frames).toHaveLength(N);
    expect(cam.summary.maxStep.step).toBeLessThanOrEqual(0.01 + 1e-6);
    expect(cam.summary.endOverStart).toBeCloseTo(1.28, 2);

    // On the frozen ending span 60..79, figure scale s is held constant (variation <= 0.5%) and posed standing height varies <= 0.5%.
    const frozenS = cam.frames.slice(60, 80).map((f) => f.s);
    expect((Math.max(...frozenS) - Math.min(...frozenS)) / frozenS[0]!).toBeLessThanOrEqual(0.005);

    const poses = poseRawAnimation(loadBuild(withCam.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const standingHeight = (idx: number): number => {
      const b = byName(poses[idx]!.bones);
      const headY = b.get('head')!.worldY;
      const r1 = b.get('leg_r1')!;
      const l1 = b.get('leg_l1')!;
      const rAnkY = r1.worldY + r1.c * 70;
      const lAnkY = l1.worldY + l1.c * 70;
      return headY - Math.min(rAnkY, lAnkY);
    };
    const frozenH = Array.from({ length: 20 }, (_, k) => standingHeight(60 + k));
    expect((Math.max(...frozenH) - Math.min(...frozenH)) / frozenH[0]!).toBeLessThanOrEqual(0.005);
    expect(Math.abs(standingHeight(N - 1) / standingHeight(0) - 1)).toBeLessThanOrEqual(0.02);

    // ARG_PATH refusal when --camera points to a missing directory.
    const bad = retarget(withCam, [...flags, '--camera', join(withCam.dir, 'no-such-dir', 'camera.json')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('ARG_PATH: --camera');
  }, SLOW);

  test('mutant (#163): without rate-limited projection (unsmoothed raw scale), a 15% single-frame spike violates the <= 1%/frame step bound', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm163-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'export const FIGURE_SCALE_STEP = 0.01;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const FIGURE_SCALE_STEP = 0.5;'));

      // Pose with a sharp 8% step between frames 20 and 21.
      const m: Motion = { ...BASE, n: 40, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
      const pose = poseDoc(m, (i, j) => {
        const z = i < 20 ? 1 : 1.08 + 0.004 * (i - 20);
        const cx = 100;
        const cy = 200;
        for (const k of Object.keys(j)) {
          const pt = j[k]!.at as Pt;
          j[k] = { ...j[k]!, at: [cx + (pt[0] - cx) * z, cy + (pt[1] - cy) * z] };
        }
      });
      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      const camFile = join(cMut.dir, 'camera.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--camera', camFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const cam = JSON.parse(readFileSync(camFile, 'utf8')) as { summary: { maxStep: { step: number } } };
      expect(cam.summary.maxStep.step).toBeGreaterThan(0.05);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('trunk smoothing under --reduce (#116): knot and handle smoothing keeps trunk local jitter <= 1.0 deg/f^2 under --leg-scale while leaving limbs within 0.05 and non-leg-scale runs byte-identical', () => {
  const N = 30;
  const DT = 1 / 30;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function noisyTrunkPose(): Record<string, unknown> {
    // Trunk and head carry high-frequency +/-0.75 deg jitter on top of a slow 2.5 deg sway.
    const trunkJitter = (i: number): number => 90 + 2.5 * Math.sin((2 * Math.PI * i) / 15) + (i % 2 === 0 ? 0.75 : -0.75);
    const headWave = (i: number): number => 2.5 * Math.sin((2 * Math.PI * i) / 15) + (i % 3 === 0 ? 0.75 : i % 3 === 1 ? -0.75 : 0.25);
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: trunkJitter };
    return poseDoc(m, (i, j) => {
      const neck = j.neck!.at as Pt;
      const hw = headWave(i) * RAD;
      const cx = neck[0];
      const cy = neck[1] - 20;
      const dx = 6 * Math.cos(hw);
      const dy = -6 * Math.sin(hw);
      j.r_eye = { state: 'observed', at: [cx - dx, cy - dy], score: 0.95 };
      j.l_eye = { state: 'observed', at: [cx + dx, cy + dy], score: 0.95 };
    });
  }

  function localRotateJitter(buildDir: string, boneName: string): number {
    const doc = loadBuild(buildDir);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation').map((p) => byName(p.bones));
    const setupParent = new Map<string, string | null>();
    for (const b of doc.bones) setupParent.set(b.name, b.parent ?? null);
    const parent = setupParent.get(boneName) ?? null;
    const angles = poses.map((b) => {
      const w = worldAngle(b, boneName);
      if (!parent) return w;
      let d = w - worldAngle(b, parent);
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    });
    let sum = 0;
    for (let i = 1; i < angles.length - 1; i++) {
      sum += Math.abs(angles[i + 1]! - 2 * angles[i]! + angles[i - 1]!);
    }
    return sum / (angles.length - 2);
  }

  test('smooths chest and head local jitter to <= 1.0 deg/f^2 under --leg-scale, holds limbs within 0.05, and leaves runs without --leg-scale byte-identical to mutant', () => {
    const pose = noisyTrunkPose();
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const repFile = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--reduce', '1', '--reduce-hip', '1', '--report', repFile]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const chestJit = localRotateJitter(c.build, 'chest');
    const headJit = localRotateJitter(c.build, 'head');
    const trunkMean = (chestJit + headJit) / 2;
    expect(trunkMean).toBeLessThanOrEqual(1.0);

    // Mutant without smoothTrunk leaves trunk mean jitter > 1.2 deg/f^2, while limbs stay within 0.05 and non-leg-scale runs are byte-identical.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm116-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'run.ts');
      const from = 'smoothTrunk(r.times, bones, tolerance, out, trunkBones);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, '// mutant: no smoothTrunk'));

      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      const mRepFile = join(cMut.dir, 'report.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--reduce', '1', '--reduce-hip', '1', '--report', mRepFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutChestJit = localRotateJitter(cMut.build, 'chest');
      const mutHeadJit = localRotateJitter(cMut.build, 'head');
      const mutTrunkMean = (mutChestJit + mutHeadJit) / 2;
      expect(mutTrunkMean).toBeGreaterThan(1.2);
      expect(trunkMean).toBeLessThan(mutTrunkMean - 0.3);

      // Every limb bone's jitter and landing are unchanged within 0.05.
      const repOurs = JSON.parse(readFileSync(repFile, 'utf8')) as { landings: Array<{ bone: string; kind: string; worst: number }> };
      const repMut = JSON.parse(readFileSync(mRepFile, 'utf8')) as { landings: Array<{ bone: string; kind: string; worst: number }> };
      for (const limb of ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
        expect(Math.abs(localRotateJitter(c.build, limb) - localRotateJitter(cMut.build, limb))).toBeLessThanOrEqual(0.05);
        const lOurs = repOurs.landings.find((b) => b.bone === limb && b.kind === 'angle')!.worst;
        const lMut = repMut.landings.find((b) => b.bone === limb && b.kind === 'angle')!.worst;
        expect(Math.abs(lOurs - lMut)).toBeLessThanOrEqual(0.05);
      }

      // Without --leg-scale (as on the dance under --reduce 1 alone), output is 100% byte-identical.
      const cNoLeg = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      const cNoLegMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      expect(retarget(cNoLeg, ['--bends', 'clamp', '--reduce', '1']).status).toBe(0);
      expect(retarget(cNoLegMut, ['--bends', 'clamp', '--reduce', '1'], join(d, 'cli.ts')).status).toBe(0);
      expect(readFileSync(cNoLeg.out, 'utf8')).toBe(readFileSync(cNoLegMut.out, 'utf8'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('tools/pelvis.ts: --camera sidecar and residual zoom warning (#170)', () => {
  const N = 36;
  const DT = 1 / 24;
  const PELVIS_TOOL = join(ROOT, 'tools', 'pelvis.ts');
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function runPelvis(args: string[]): { status: number; stdout: string; stderr: string } {
    const p = spawnSync(process.execPath, [PELVIS_TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { status: p.status ?? 1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
  }

  function zoomedPelvisPose(inPlace = false): Record<string, unknown> {
    // Window 0..17 has 16% camera zoom (1.00 -> 1.16); window 18..35 holds steady zoom (1.16 -> 1.18).
    // In both windows the dancer performs the same periodic crouch + lateral sway over a planted right foot.
    const zoomAt = (i: number): number => (i < 18 ? 1 + (0.16 * i) / 18 : 1.16 + (0.02 * (i - 18)) / 17);
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90 };
    const doc = poseDoc(m, (i, j) => {
      const z = inPlace ? 1 : zoomAt(i);
      const crouch = 1 - 0.08 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i % 9)) / 9));
      const swayDeg = 6 * Math.sin((2 * Math.PI * (i % 18)) / 18);
      const swayRad = swayDeg * RAD;
      // Right ankle planted at (200, 500) in canonical space; camera zooms around top-left (0, 0).
      const rAnk: Pt = [200, 500];
      const legLen = 150 * crouch;
      const dx = -legLen * Math.sin(swayRad);
      const dy = -legLen * Math.cos(swayRad);
      const rHip: Pt = [rAnk[0] + dx, rAnk[1] + dy];
      const rKnee: Pt = [rAnk[0] + dx * (70 / 150), rAnk[1] + dy * (70 / 150)];
      const lHip: Pt = [rHip[0] + 30, rHip[1]];
      const lKnee: Pt = [rKnee[0] + 30, rKnee[1]];
      const lAnk: Pt = [rAnk[0] + 30, rAnk[1]];
      const mh: Pt = [(rHip[0] + lHip[0]) / 2, (rHip[1] + lHip[1]) / 2];
      const origR = j.r_hip!.at as Pt;
      const origL = j.l_hip!.at as Pt;
      const origMh: Pt = [(origR[0] + origL[0]) / 2, (origR[1] + origL[1]) / 2];
      const shiftX = mh[0] - origMh[0];
      const shiftY = mh[1] - origMh[1];
      for (const k of Object.keys(j)) {
        const pt = j[k]!.at as Pt;
        j[k] = { ...j[k]!, at: [(pt[0] + shiftX) * z, (pt[1] + shiftY) * z] };
      }
      j.r_hip = { state: 'observed', at: [rHip[0] * z, rHip[1] * z], score: 0.95 };
      j.l_hip = { state: 'observed', at: [lHip[0] * z, lHip[1] * z], score: 0.95 };
      j.r_knee = { state: 'observed', at: [rKnee[0] * z, rKnee[1] * z], score: 0.95 };
      j.l_knee = { state: 'observed', at: [lKnee[0] * z, lKnee[1] * z], score: 0.95 };
      j.r_ankle = { state: 'observed', at: [rAnk[0] * z, rAnk[1] * z], score: 0.95 };
      j.l_ankle = { state: 'observed', at: [lAnk[0] * z, lAnk[1] * z], score: 0.95 };
    });
    return inPlace ? { ...doc, travel: 'in-place' } : doc;
  }

  test('with --camera, zoomed windows pass and agree within 0.01; without --camera, warns and keeps raw ratios; refuses malformed camera and fails on mutant camera', () => {
    const pose = zoomedPelvisPose(false);
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const repFile = join(c.dir, 'report.json');
    const camFile = join(c.dir, 'camera.json');
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--report', repFile, '--camera', camFile]);
    expect(r.status).toBe(0);

    const outCam = join(c.dir, 'bands_cam.json');
    const pCam = runPelvis(['--build', c.build, '--pose', c.pose, '--map', c.map, '--report', repFile, '--camera', camFile, '--windows', '0-17,18-35', '--out', outCam]);
    expect(pCam.status).toBe(0);
    expect(pCam.stdout).not.toContain('warning:');
    expect(pCam.stdout).not.toContain('FAIL');

    const bandsCam = JSON.parse(readFileSync(outCam, 'utf8')) as {
      bands: Array<{
        window: [number, number];
        vertical: { ratio: number };
        lateral: { ratio: number };
        rebound: { median: number };
      }>;
    };
    const [b0, b1] = bandsCam.bands as [typeof bandsCam.bands[0], typeof bandsCam.bands[0]];
    expect(b0.vertical.ratio).toBeGreaterThanOrEqual(0.85);
    expect(b0.vertical.ratio).toBeLessThanOrEqual(1.15);
    expect(b0.lateral.ratio).toBeGreaterThanOrEqual(0.85);
    expect(b0.lateral.ratio).toBeLessThanOrEqual(1.15);
    expect(Math.abs(b0.vertical.ratio - b1.vertical.ratio)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b0.lateral.ratio - b1.lateral.ratio)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b0.rebound.median - b1.rebound.median)).toBeLessThanOrEqual(0.01);

    // Without --camera on the zoomed sequence: warning line appears, raw ratios still print.
    const outRaw = join(c.dir, 'bands_raw.json');
    const pRaw = runPelvis(['--build', c.build, '--pose', c.pose, '--map', c.map, '--report', repFile, '--windows', '0-17,18-35', '--out', outRaw]);
    expect(pRaw.status).toBe(0);
    const rawLines = pRaw.stdout.trim().split('\n');
    expect(rawLines[0]).toMatch(/^warning: sequence has residual camera zoom s /);
    expect(rawLines.slice(1).join('\n')).toContain('window 0–17:');
    expect(pRaw.stdout).toContain('FAIL');
    const bandsRaw = JSON.parse(readFileSync(outRaw, 'utf8')) as typeof bandsCam;
    expect(bandsRaw.bands[0]!.vertical.ratio).toBeGreaterThan(1.15);

    // Negative control 1: mutant camera with flat s=1 fails the vertical band on 0-17.
    const mutCamFile = join(c.dir, 'camera_mut.json');
    const camObj = JSON.parse(readFileSync(camFile, 'utf8')) as { spec: string; frames: Array<{ frame: number; t: number; s: number }> };
    writeFileSync(mutCamFile, JSON.stringify({ ...camObj, frames: camObj.frames.map((f) => ({ ...f, s: 1 })) }));
    const pMut = runPelvis(['--build', c.build, '--pose', c.pose, '--map', c.map, '--report', repFile, '--camera', mutCamFile, '--windows', '0-17,18-35']);
    expect(pMut.status).toBe(0);
    expect(pMut.stdout).toContain('FAIL');

    // Negative control 2: invalid --camera spec is refused with exit 2.
    const badCamFile = join(c.dir, 'camera_bad.json');
    writeFileSync(badCamFile, JSON.stringify({ spec: 'wrong/1', frames: [] }));
    const pBad = runPelvis(['--build', c.build, '--pose', c.pose, '--map', c.map, '--report', repFile, '--camera', badCamFile, '--windows', '0-17']);
    expect(pBad.status).toBe(2);
    expect(pBad.stderr).toContain('expected "rig-pose-camera/1"');

    // In-place sequence without --camera: no warning line printed.
    const inPlaceFile = join(c.dir, 'pose_inplace.json');
    writeFileSync(inPlaceFile, JSON.stringify({ ...JSON.parse(readFileSync(c.pose, 'utf8')), travel: 'in-place' }));
    const pInPlace = runPelvis(['--build', c.build, '--pose', inPlaceFile, '--map', c.map, '--report', repFile, '--windows', '0-17']);
    expect(pInPlace.status).toBe(0);
    expect(pInPlace.stdout).not.toContain('warning:');
  }, SLOW);
});

describe('posture-invariant figure scale and trunk scaley foreshortening (#172)', () => {
  const N = 45;
  const DT = 1 / 24;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function trunkBendPose(): Record<string, unknown> {
    // Fixed camera (true s = 1.0):
    // - frames 0..14: upright standing (trunkLen = 100)
    // - frames 15..29: head thrown back (trunkLen = 106.5, +6.5%)
    // - frames 30..44: forward bend toward camera (trunkLen = 82, -18%)
    const trunkRatioAt = (i: number): number => {
      if (i < 15) return 1.0;
      if (i < 30) return 1.065;
      return 0.82;
    };
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    return poseDoc(m, (i, j) => {
      const ratio = trunkRatioAt(i);
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      const mh: Pt = [(rHip[0] + lHip[0]) / 2, (rHip[1] + lHip[1]) / 2];
      const origNeck = j.neck!.at as Pt;
      const trunkLen0 = mh[1] - origNeck[1];
      const newNeckY = mh[1] - trunkLen0 * ratio;
      const dy = newNeckY - origNeck[1];
      for (const k of ['neck', 'r_shoulder', 'l_shoulder', 'r_elbow', 'l_elbow', 'r_wrist', 'l_wrist', 'nose', 'r_eye', 'l_eye', 'r_ear', 'l_ear']) {
        if (j[k]) {
          const pt = j[k]!.at as Pt;
          j[k] = { ...j[k]!, at: [pt[0], pt[1] + dy] };
        }
      }
      j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80], score: 0.95 };
      j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150], score: 0.95 };
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80], score: 0.95 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150], score: 0.95 };
    });
  }

  test('holds s(t) within [0.98, 1.02] on a fixed-camera trunk bend and carries trunk foreshortening/extension on chest:scaley within 3%', () => {
    const pose = trunkBendPose();
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const camFile = join(c.dir, 'camera.json');
    const repFile = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--camera', camFile, '--report', repFile]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const cam = JSON.parse(readFileSync(camFile, 'utf8')) as {
      summary: { minS: number; maxS: number };
      frames: Array<{ frame: number; s: number }>;
    };
    expect(cam.summary.minS).toBeGreaterThanOrEqual(0.98);
    expect(cam.summary.maxS).toBeLessThanOrEqual(1.02);

    const motion = JSON.parse(readFileSync(c.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
    };
    const chestScaleY = motion.animations.dance.tracks.find((tr) => tr.bone === 'chest' && tr.property === 'scaley');
    expect(chestScaleY).toBeDefined();

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const rigTrunkLen = (idx: number): number => {
      const b = byName(poses[idx]!.bones);
      const ch = b.get('chest')!;
      const nk = b.get('neck')!;
      return Math.hypot(nk.worldX - ch.worldX, nk.worldY - ch.worldY);
    };
    const standLen = rigTrunkLen(0);
    // Frame 22 (head back, sequence ratio 1.065, clamped at 1.05): within 3% of 1.065.
    expect(Math.abs(rigTrunkLen(22) / standLen - 1.065) / 1.065).toBeLessThanOrEqual(0.03);
    // Frame 37 (forward bend, sequence ratio 0.82): within 3% of 0.82.
    expect(Math.abs(rigTrunkLen(37) / standLen - 0.82) / 0.82).toBeLessThanOrEqual(0.03);

    // Mutant: if rawFigureHeight reads nose-to-ankle instead of posture-invariant measures, forward bend drops s(t) below 0.95.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm172-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'if (ar !== null && al !== null && hr !== null && hl !== null) {';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(
        path,
        before.replace(
          from,
          "if (ar !== null && al !== null) { const ns = heldPt('nose')!; return ar.map((r, i) => Math.max(r[1], al[i]![1]) - ns[i]![1]); } if (false) {",
        ),
      );
      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      const mutCamFile = join(cMut.dir, 'camera_mut.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--camera', mutCamFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutCam = JSON.parse(readFileSync(mutCamFile, 'utf8')) as { summary: { minS: number } };
      expect(mutCam.summary.minS).toBeLessThan(0.95);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#173: body yaw reading from camera-normalised shoulder and hip width', () => {
  const N = 60;
  const DT = 1 / 30;

  function bodyTurnPose(): Record<string, unknown> {
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    return poseDoc(m, (i, j) => {
      // Frames 0..47: frontal standing (cos(yaw) = 1.0 -> yaw = 0°)
      // Frames 48..59: 75° turn to subject's right (cos(75°) ≈ 0.2588 -> yaw ≈ +75°)
      const deg = i < 48 ? 0 : 75;
      const c = Math.cos((deg * Math.PI) / 180);
      const rSh = j.r_shoulder!.at as Pt;
      const lSh = j.l_shoulder!.at as Pt;
      const mShX = (rSh[0] + lSh[0]) / 2;
      const halfSh = ((lSh[0] - rSh[0]) / 2) * c;
      j.r_shoulder = { ...j.r_shoulder!, at: [mShX - halfSh, rSh[1]] };
      j.l_shoulder = { ...j.l_shoulder!, at: [mShX + halfSh, lSh[1]] };

      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      const mHipX = (rHip[0] + lHip[0]) / 2;
      const halfHip = ((lHip[0] - rHip[0]) / 2) * c;
      j.r_hip = { ...j.r_hip!, at: [mHipX - halfHip, rHip[1]] };
      j.l_hip = { ...j.l_hip!, at: [mHipX + halfHip, lHip[1]] };

      if (deg > 0) {
        const nose = j.nose!.at as Pt;
        j.nose = { ...j.nose!, at: [nose[0] - 4, nose[1]] };
      }
    });
  }

  test('reports BODY yaw (<= 15° on opening, >= 60° on ending turn, frames >= 45° listed) without changing tracks when body is undeclared, and drives body.yaw when declared', () => {
    const pose = bodyTurnPose();
    const c = setup({ pose });
    const repFile = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--report', repFile]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const bodyLines = linesOf(r, 'BODY');
    expect(bodyLines).toHaveLength(1);
    expect(bodyLines[0]).toContain('opening (frames 0–47)');
    expect(bodyLines[0]).toContain('≥ 45° on 12 frame(s): frames 48–59');

    const rep = JSON.parse(readFileSync(repFile, 'utf8')) as {
      body: {
        standing: { shoulder: number; hip: number };
        read: { yaw: { min: number; max: number; range: number }; opening: { min: number; max: number } };
        over45: Array<[number, number]>;
        framesOver45: number[];
        yaw?: unknown;
      };
    };
    expect(Math.max(Math.abs(rep.body.read.opening.min), Math.abs(rep.body.read.opening.max))).toBeLessThanOrEqual(15);
    expect(rep.body.read.yaw.max).toBeGreaterThanOrEqual(60);
    expect(rep.body.over45).toEqual([[48, 59]]);
    expect(rep.body.framesOver45).toHaveLength(12);
    expect(rep.body.yaw).toBeUndefined();

    // With body.yaw declared in map.json, the dial bone is keyed with knee compression and reported.
    const dialMap = { ...baseMap(), body: { yaw: { bone: 'body_yaw', range: [-30, 30] } } };
    const cDial = setup({
      rig: { bones: (b) => [...b, { name: 'body_yaw', parent: 'chest', x: 0, y: 50, rotation: 0, length: 10 }] },
      map: dialMap,
      pose,
    });
    const repDialFile = join(cDial.dir, 'report_dial.json');
    const rDial = retarget(cDial, ['--bends', 'clamp', '--report', repDialFile]);
    expect(rDial.stderr).toBe('');
    expect(rDial.status).toBe(0);
    expect(linesOf(rDial, 'BODY')[0]).toContain('mapped yaw → bone "body_yaw" [-30, 30]°');

    const motionUndeclared = JSON.parse(readFileSync(c.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; slot?: string; property: string; keys: unknown[] }> } };
    };
    const motionDial = JSON.parse(readFileSync(cDial.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; slot?: string; property: string; keys: unknown[] }> } };
    };
    expect(motionDial.animations.dance.tracks.filter((tr) => tr.bone !== 'body_yaw')).toEqual(motionUndeclared.animations.dance.tracks);

    // Mutant: if readBodyYaw ignores width narrowing and returns 0, over45 is empty.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm173-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'face.ts');
      const from = 'const mag = Math.acos(w) * DEG;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const mag = 0;'));
      const cMut = setup({ pose });
      const mutRepFile = join(cMut.dir, 'report_mut.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--report', mutRepFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutRep = JSON.parse(readFileSync(mutRepFile, 'utf8')) as { body: { over45: unknown[] } };
      expect(mutRep.body.over45).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#173 Part 2: switches sets on face and body yaw with hysteresis and --switch-min, refuses unknown sets by name, and reports hides keyed by another track', () => {
    // 60 frames at 30 fps (dt = 1/30, switchMin = 0.25s = 8 frames):
    // - Face yaw:
    //   - frames 1..4 (4 frames < 8): 50° spike -> NOT entered
    //   - frames 5..14 (10 frames >= 8): 0°
    //   - frames 15..22 (8 frames >= 8): 50° -> ENTERED at f15
    //   - frame 23: 40° (>= 35° leave threshold) -> stays in T1!
    //   - frames 24..59: 0° (< 35° for >= 8 frames) -> LEAVES at f24 (active span 15..23, 2 swaps)
    // - Body yaw:
    //   - frames 0..47: 0°
    //   - frames 48..59 (12 frames >= 8): 75° -> ENTERED at f48, never leaves before end (active span 48..59, 1 swap)
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    const pose = poseDoc(m, (i, j) => {
      const neck = (j.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      const dEye = 12;
      const dEar = 24;
      j.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      j.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      j.r_ear = { state: 'observed', at: [midEye[0] - dEar / 2, midEye[1] + 5], score: 0.95 };
      j.l_ear = { state: 'observed', at: [midEye[0] + dEar / 2, midEye[1] + 5], score: 0.95 };

      const fYaw = (i >= 1 && i <= 4) || (i >= 15 && i <= 22) ? 50 : i === 23 ? 40 : 0;
      const ty = Math.tan(fYaw * RAD);
      j.nose = { state: 'observed', at: [midEye[0] - (ty * dEye) / 1.25, midEye[1] + 5], score: 0.95 };

      const bDeg = i >= 48 ? 75 : 0;
      const c = Math.cos((bDeg * Math.PI) / 180);
      const rSh = j.r_shoulder!.at as Pt;
      const lSh = j.l_shoulder!.at as Pt;
      const mShX = (rSh[0] + lSh[0]) / 2;
      const halfSh = ((lSh[0] - rSh[0]) / 2) * c;
      j.r_shoulder = { ...j.r_shoulder!, at: [mShX - halfSh, rSh[1]] };
      j.l_shoulder = { ...j.l_shoulder!, at: [mShX + halfSh, lSh[1]] };

      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      const mHipX = (rHip[0] + lHip[0]) / 2;
      const halfHip = ((lHip[0] - rHip[0]) / 2) * c;
      j.r_hip = { ...j.r_hip!, at: [mHipX - halfHip, rHip[1]] };
      j.l_hip = { ...j.l_hip!, at: [mHipX + halfHip, lHip[1]] };
      if (bDeg > 0) {
        j.neck = { ...j.neck!, at: [neck[0] - 4, neck[1]] };
      }
    });

    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw_dial', parent: 'root' }],
      extraSlots: [
        { name: 'head_slot', bone: 'neck', attachment: 'head_base' },
        { name: 'ear_l', bone: 'neck', attachment: 'ear_base' },
      ],
      extra: {
        head_slot: {
          head_base: { image: 'seg.png', x: 0, y: 0 },
          T1_head: { image: 'seg.png', x: 0, y: 0 },
          T8_head: { image: 'seg.png', x: 0, y: 0 },
        },
        ear_l: {
          ear_base: { image: 'seg.png', x: 0, y: 0 },
          T8_ear: { image: 'seg.png', x: 0, y: 0 },
        },
        sleeve_r0: {
          T8_sleeve_r0: { image: 'seg.png', x: 30, y: 0, rotation: 90 },
        },
      },
      sets: {
        spec: 'rig-parts-sets/1',
        sets: {
          T1: { slots: { head_slot: 'T1_head' }, hides: ['ear_l'] },
          T8: { slots: { head_slot: 'T8_head', ear_l: 'T8_ear', sleeve_r0: 'T8_sleeve_r0' }, hides: ['sleeve_l0'] },
        },
      },
    };

    // Unknown set in map.json is refused by name under MAP_SET_EXISTS.
    const cBad = setup({
      rig: rigOpts,
      map: {
        ...baseMap(),
        body: { sets: [{ set: 'NO_SUCH_SET', above: 45 }] },
      },
      pose,
    });
    const rBad = retarget(cBad, ['--bends', 'clamp']);
    expect(rBad.status).toBe(1);
    expect(rBad.stderr).toContain('MAP_SET_EXISTS: "body.sets" — set "NO_SUCH_SET" is not in the rig; its sets are T1, T8');

    // Valid map with T1 on face.yaw.sets and T8 on body.sets.
    const c = setup({
      rig: rigOpts,
      map: {
        ...baseMap(),
        face: {
          yaw: {
            bone: 'yaw_dial',
            range: [-15, 15],
            sets: [{ set: 'T1', above: 45 }],
          },
        },
        body: {
          sets: [{ set: 'T8', above: 45 }],
        },
      },
      pose,
    });
    const repFile = join(c.dir, 'report_sets.json');
    const r = retarget(c, ['--bends', 'clamp', '--switch-min', '0.25', '--report', repFile]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const faceLines = linesOf(r, 'FACE');
    const bodyLines = linesOf(r, 'BODY');
    expect(faceLines[0]).toContain('sets set "T1" (≥ 45°, leave < 35°): frames 15–23 (+40.0° … +50.0°) (2 swaps); hides keyed by another track: slot "ear_l" (slot "ear_l" attachment (set "T8"))');
    expect(bodyLines[0]).toContain('sets set "T8" (≥ 45°, leave < 35°): frames 48–59 (+75.1° … +75.1°) (1 swap)');

    // Check attachment keys on head_slot, ear_l, sleeve_r0, sleeve_l0.
    const motion = JSON.parse(readFileSync(c.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ slot?: string; property: string; keys: Array<{ t: number; v: string | null }> }> } };
    };
    const slotTrack = (s: string) => motion.animations.dance.tracks.find((tr) => tr.slot === s && tr.property === 'attachment');
    // head_slot enters T1 at f15 (t = 15/30 = 0.5), leaves T1 back to head_base at f24 (t = 24/30 = 0.8), and enters T8 at f48 (t = 48/30 = 1.6).
    expect(slotTrack('head_slot')?.keys).toEqual([
      { t: 0.5, v: 'T1_head' },
      { t: 0.8, v: 'head_base' },
      { t: 1.6, v: 'T8_head' },
    ]);
    // ear_l is hidden by T1 on 15..23, restored to ear_base at f24, and switched to T8_ear by T8 at f48.
    expect(slotTrack('ear_l')?.keys).toEqual([
      { t: 0.5, v: null },
      { t: 0.8, v: 'ear_base' },
      { t: 1.6, v: 'T8_ear' },
    ]);
    // sleeve_l0 is hidden by T8 at f48 and never left before the end (1 key).
    expect(slotTrack('sleeve_l0')?.keys).toEqual([
      { t: 1.6, v: null },
    ]);

    // Mutant: if selectYawSets ignores --switch-min and enters on any single frame >= above, the 4-frame spike 1..4 flips T1 (4 swaps > 2).
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm173p2-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'face.ts');
      const from = 'if (spanSec(i, j) >= switchMin - 1e-9) {';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from).length).toBeGreaterThanOrEqual(2);
      writeFileSync(path, before.replaceAll(from, 'if (true) {'));
      const cMut = setup({
        rig: rigOpts,
        map: {
          ...baseMap(),
          face: { yaw: { bone: 'yaw_dial', range: [-15, 15], sets: [{ set: 'T1', above: 45 }] } },
          body: { sets: [{ set: 'T8', above: 45 }] },
        },
        pose,
      });
      const mutRepFile = join(cMut.dir, 'report_mut.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--switch-min', '0.25', '--report', mutRepFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutRep = JSON.parse(readFileSync(mutRepFile, 'utf8')) as { face: { sets: Array<{ swaps: number }> } };
      expect(mutRep.face.sets[0]!.swaps).toBeGreaterThan(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#179 and #181: wrist-to-head distance gate for --raised-by-head and detrended running median baseline for head nod', () => {
  test('#179: --raised-by-head places a set whose key wrist lies within 2 eye distances of the head even when upper arm drawn is outside 60°..120°, and does not head-place a set whose wrist is farther; mutant re-enabling upper-arm gate fails', () => {
    const N = 16;
    const DT = 1 / 24;
    const headBones = (b: BoneSpec[]): BoneSpec[] => [
      ...b,
      { name: 'head', parent: 'neck', x: 0, y: 20 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    ];
    const rigOpts: RigOpts = {
      bones: headBones,
      extra: {
        sleeve_r0: { seg_up: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
        sleeve_l0: { seg_far: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
      },
    };
    // Right arm: drawn sleeve_r0 = 40° (outside 60°..120°!), key wrist at (-5, 65) within 1.5 eye_dist (18px) of head centre (0, 65).
    // Left arm: drawn sleeve_l0 = 80° (inside 60°..120°!), key wrist at (80, 65), 6.7 eye_dist (> 2) from head centre (0, 65).
    const m: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: () => 90,
      hip: () => [0, 0],
      ru: () => 115,
      rf: () => 65,
      lu: () => 80,
      lf: () => 0,
    };
    const keyPos = positions(m, 0);
    const mapSpec: Record<string, unknown> = {
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K_both',
          slots: { sleeve_r0: 'seg_up', sleeve_l0: 'seg_far' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_eye: keyPos.r_eye!,
            l_eye: keyPos.l_eye!,
            r_shoulder: keyPos.r_shoulder!,
            r_elbow: keyPos.r_elbow!,
            r_wrist: [keyPos.r_eye![0] + 2, keyPos.r_eye![1]],
            l_shoulder: keyPos.l_shoulder!,
            l_elbow: keyPos.l_elbow!,
            l_wrist: [keyPos.l_eye![0] + 60, keyPos.l_eye![1]],
          },
          drawn: { sleeve_r0: 40, sleeve_r1: 65, sleeve_l0: 80, sleeve_l1: 0 },
          turn: { sleeve_r0: [-90, 90], sleeve_r1: [-90, 90], sleeve_l0: [-90, 90], sleeve_l1: [-90, 90] },
        },
      ],
    };
    const pose = poseDoc(m, (_i, j) => {
      j.r_wrist = { state: 'observed', at: [keyPos.r_eye![0] + 2, keyPos.r_eye![1]], score: 0.9 };
      j.l_wrist = { state: 'observed', at: [keyPos.l_eye![0] + 60, keyPos.l_eye![1]], score: 0.9 };
    });
    const c = setup({ rig: rigOpts, map: mapSpec, pose });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const raised = linesOf(r, 'RAISED');
    expect(raised.some((l) => l.includes('chain "arm_r"'))).toBe(true);
    expect(raised.some((l) => l.includes('chain "arm_l"'))).toBe(false);

    // Mutant: re-enabling the upper-arm angle gate (isRaised(drawn) only) drops arm_r (drawn 40°) and head-places arm_l (drawn 80°).
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm179-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const up = isChainHeadPlaced(set, c, drawn);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const up = headOk !== null && drawn !== undefined && isRaised(drawn);'));
      const cMut = setup({ rig: rigOpts, map: mapSpec, pose });
      const rMut = retarget(cMut, ['--raised-by-head'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutRaised = linesOf(rMut, 'RAISED');
      expect(mutRaised.some((l) => l.includes('chain "arm_r"'))).toBe(false);
      expect(mutRaised.some((l) => l.includes('chain "arm_l"'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#181: detrended running median nod baseline preserves beat-to-beat oscillation across slow baseline drift with <= 10% frames at the ±2% clamp; mutant using frame 0 baseline pins >= 70% of frames at the clamp', () => {
    const N = 60;
    const DT = 1 / 24;
    const headRig: NonNullable<RigOpts['bones']> = (b) => [
      ...b,
      { name: 'head', parent: 'neck', x: 0, y: 50 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    ];
    const mapWithHead = (): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
    });
    // Slow baseline drift of -4 rig units after frame 10 + beat oscillation of ±0.7 rig units (within maxNod = 1.0u).
    const driftNodPose = () => {
      const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
      return poseDoc(m, (i, j) => {
        j.r_ankle = { state: 'observed', at: [-20, 350], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [20, 320], score: 0.9 };
        const drift = i < 10 ? (-4 * i) / 10 : -4;
        const beat = 0.7 * Math.sin((i / 6) * 2 * Math.PI);
        const dyPic = -(drift + beat) / SCALE;
        const r = j.r_eye!.at as Pt;
        const l = j.l_eye!.at as Pt;
        j.r_eye = { state: 'observed', at: [r[0], r[1] + dyPic], score: 0.9 };
        j.l_eye = { state: 'observed', at: [l[0], l[1] + dyPic], score: 0.9 };
      });
    };
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: driftNodPose() });
    const r = retarget(c, ['--bends', 'clamp', '--plant-feet']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const headTrans = motionOf(c.out).animations.dance!.tracks.find((t) => t.bone === 'head' && t.property === 'translate')!;
    const maxNod = 0.02 * 50; // 1.0u
    const clampedCount = headTrans.keys.filter((k) => Math.abs((k.v as number[])[1]!) >= maxNod - 1e-3).length;
    expect(clampedCount / N).toBeLessThanOrEqual(0.1);

    // Mutant: reverting nodBase to frame 0 pins >= 70% of frames at -maxNod.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm181-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const rawNod = refEN.map((v, i) => (v - nodBase[i]!) * nodScale!);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const rawNod = refEN.map((v) => (v - refEN[0]!) * nodScale!);\n        const p90Nod0 = 0;').replace('if (p90Nod > maxNod', 'if (p90Nod0 > maxNod'));
      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: driftNodPose() });
      const rMut = retarget(cMut, ['--bends', 'clamp', '--plant-feet'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutTrans = motionOf(cMut.out).animations.dance!.tracks.find((t) => t.bone === 'head' && t.property === 'translate')!;
      const mutClamped = mutTrans.keys.filter((k) => Math.abs((k.v as number[])[1]!) >= maxNod - 1e-3).length;
      expect(mutClamped / N).toBeGreaterThanOrEqual(0.7);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#184: a horizontal chain (pelvis) shorter than --short or reversed within a frame holds its last confident angle and interpolates; mutant disabling holdAcross flips hip.rotate past 100° and mirrors leg origins', () => {
    // Unit check: holdAcross holds frames below cutoff or reversed past threshold and interpolates the short way round.
    const u = [-5, -5.6, -5.6, 171.8, 174.6, 174.4, -5.0, -2.2, -2.0];
    const frac = [1, 1, 0.25, 0.17, 0.17, 0.18, 0.28, 1, 1];
    const spans = holdAcross(u, frac, 0.35, 90, 0);
    expect(spans).toEqual([
      {
        frames: [2, 6],
        minFraction: 0.17,
        across: true,
        reversed: expect.closeTo(-179.4, 5),
      },
    ]);
    for (const a of u) expect(Math.abs(a)).toBeLessThanOrEqual(6);

    // End-to-end check with mutant: pelvis foreshortens to 0.17 of median on frames 8–12 and crosses r_hip.x > l_hip.x on frames 9–11.
    const N = 20;
    const DT = 1 / 30;
    const pelvisMap = (): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
      ],
    });
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0] };
    const sideTurnPose = poseDoc(m, (i, j) => {
      // Base hip line is r_hip (-15, 300) → l_hip (+15, 300), length 30 px, slight tilt -5.6° before turn and -2.2° after.
      const tiltDeg = i <= 7 ? -5.6 : i >= 13 ? -2.2 : -4.0;
      const rad = -tiltDeg * RAD; // picture y-down
      if (i >= 8 && i <= 12) {
        // Collapses to 0.17 * 30 = 5.1 px, and on frames 9–11 crosses so r_hip.x > l_hip.x (reversed ~178°).
        const crossed = i >= 9 && i <= 11;
        const half = 2.55;
        const dx = crossed ? -half : half;
        const dy = Math.sin(rad) * half;
        j.r_hip = { state: 'observed', at: [-dx, 300 - dy], score: 0.9 };
        j.l_hip = { state: 'observed', at: [dx, 300 + dy], score: 0.9 };
      } else {
        const half = 15;
        const dx = Math.cos(rad) * half;
        const dy = Math.sin(rad) * half;
        j.r_hip = { state: 'observed', at: [-dx, 300 - dy], score: 0.9 };
        j.l_hip = { state: 'observed', at: [dx, 300 + dy], score: 0.9 };
      }
    });
    const c = setup({ map: pelvisMap(), pose: sideTurnPose });
    const r = retarget(c, ['--short', '0.35', '--flip', '90', '--bends', 'clamp']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FLIP')).toEqual([]);
    expect(linesOf(r, 'END-ON')).toEqual([]);
    const holds = linesOf(r, 'HOLD');
    expect(holds.some((l) => l.includes('chain "pelvis" bone "hip" (r_hip → l_hip) frames 8–12'))).toBe(true);
    const hipRot = motionOf(c.out).animations.dance!.tracks.find((t) => t.bone === 'hip' && t.property === 'rotate')!;
    for (const k of hipRot.keys) {
      const deg = (k.v as number[])[0]!;
      expect(deg).toBeGreaterThanOrEqual(-10);
      expect(deg).toBeLessThanOrEqual(10);
    }
    const doc = loadBuild(c.build);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    for (const p of poses) {
      const b = byName(p.bones);
      expect(b.get('leg_r0')!.worldX).toBeLessThan(b.get('leg_l0')!.worldX);
    }

    // Mutant: skipping across-body chains in the short/reverse hold lets the crossed 2D hip line flip hip.rotate > 100° and mirror leg_r0/leg_l0.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm184-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const spans = holdAcross(targets.get(b)!, fraction, opts.short, opts.flip, restDir);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const spans: ShortSpan[] = [];'));
      const cMut = setup({ map: pelvisMap(), pose: sideTurnPose });
      const rMut = retarget(cMut, ['--short', '0.35', '--flip', '90', '--bends', 'clamp'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      expect(linesOf(rMut, 'FLIP').length).toBeGreaterThan(0);
      const mutRot = motionOf(cMut.out).animations.dance!.tracks.find((t) => t.bone === 'hip' && t.property === 'rotate')!;
      const maxMutDeg = Math.max(...mutRot.keys.map((k) => Math.abs((k.v as number[])[0]!)));
      expect(maxMutDeg).toBeGreaterThan(100);
      const mutDoc = loadBuild(cMut.build);
      const mutPoses = poseRawAnimation(mutDoc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const anyMirrored = mutPoses.some((p) => {
        const b = byName(p.bones);
        return b.get('leg_r0')!.worldX >= b.get('leg_l0')!.worldX;
      });
      expect(anyMirrored).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#188: symmetric gesture set normalisation and declared support-arm anchoring', () => {
  const N = 16;
  const DT = 1 / 24;
  const headBones = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -15, y: 10 },
    { name: 'eye_l', parent: 'head', x: 15, y: 10 },
  ];
  const rigOpts: RigOpts = {
    bones: headBones,
    extra: {
      sleeve_r0: { k1_r: { image: 'seg.png', x: 30, y: 0, rotation: -90 }, k3_r: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
      sleeve_l0: { k1_l: { image: 'seg.png', x: 30, y: 0, rotation: -90 }, k3_l: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
    },
  };

  test('MAP_ALT_SYMMETRIC and MAP_ALT_SUPPORT refuse malformed declarations by name', () => {
    const m: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0] };
    const kp = positions(m, 0);
    const makeMap = (altPatch: Record<string, unknown>): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K_test',
          slots: { sleeve_r0: 'k1_r', sleeve_l0: 'k1_l' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp.r_shoulder!,
            r_elbow: kp.r_elbow!,
            r_wrist: kp.r_wrist!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_r0: 120, sleeve_r1: 30, sleeve_l0: 60, sleeve_l1: 150 },
          ...altPatch,
        },
      ],
    });
    const pose = poseDoc(m);

    const rSymFalse = retarget(setup({ rig: rigOpts, map: makeMap({ symmetric: false }), pose }));
    expect(rSymFalse.status).toBe(1);
    expect(rSymFalse.stderr).toContain('MAP_ALT_SYMMETRIC');

    const rSymMissingDrawn = retarget(
      setup({
        rig: rigOpts,
        map: makeMap({ symmetric: true, drawn: { sleeve_r0: 120, sleeve_r1: 30, sleeve_l0: 60 } }),
        pose,
      }),
    );
    expect(rSymMissingDrawn.status).toBe(1);
    expect(rSymMissingDrawn.stderr).toContain('MAP_ALT_SYMMETRIC');

    const rSupUnknown = retarget(setup({ rig: rigOpts, map: makeMap({ support: 'leg_r' }), pose }));
    expect(rSupUnknown.status).toBe(1);
    expect(rSupUnknown.stderr).toContain('MAP_ALT_SUPPORT');

    const rSupMissingDrawn = retarget(
      setup({
        rig: rigOpts,
        map: makeMap({ support: 'arm_l', drawn: { sleeve_r0: 120, sleeve_r1: 30, sleeve_l0: 60 } }),
        pose,
      }),
    );
    expect(rSupMissingDrawn.status).toBe(1);
    expect(rSupMissingDrawn.stderr).toContain('MAP_ALT_SUPPORT');
  });

  test('#188 symmetric rule + mutant: a "symmetric": true set normalises elbow heights (|elbow_l.y - elbow_r.y| <= 0.01u) and clamps wrists inside the head box while keeping lower-body tracks byte-identical', () => {
    // Symmetric key pose: ru=120°, rf=30°, lu=60°, lf=150°; sequence has asymmetric upper arms (ru=135°, lu=75°: sin(135°)=0.707 vs sin(75°)=0.966 -> 18u height diff) and wide forearms (rf=15°, lf=165°).
    const mKey: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 120, rf: () => 30, lu: () => 60, lf: () => 150 };
    const kp = positions(mKey, 0);
    const mSeq: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 135, rf: () => 15, lu: () => 75, lf: () => 165 };
    const pose = poseDoc(mSeq);
    const makeMap = (symmetric: boolean): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K1_sym',
          slots: { sleeve_r0: 'k1_r', sleeve_l0: 'k1_l' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp.r_shoulder!,
            r_elbow: kp.r_elbow!,
            r_wrist: kp.r_wrist!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_r0: 120, sleeve_r1: 30, sleeve_l0: 60, sleeve_l1: 150 },
          turn: { sleeve_r0: [-35, 35], sleeve_r1: [-35, 35], sleeve_l0: [-35, 35], sleeve_l1: [-35, 35] },
          ...(symmetric ? { symmetric: true } : {}),
        },
      ],
    });

    const cSym = setup({ rig: rigOpts, map: makeMap(true), pose });
    const rSym = retarget(cSym, ['--raised-by-head']);
    expect(rSym.stderr).toBe('');
    expect(rSym.status).toBe(0);

    const cBase = setup({ rig: rigOpts, map: makeMap(false), pose });
    const rBase = retarget(cBase, ['--raised-by-head']);
    expect(rBase.status).toBe(0);

    // Lower-body tracks are byte-identical.
    const motSym = motionOf(cSym.out).animations.dance!.tracks;
    const motBase = motionOf(cBase.out).animations.dance!.tracks;
    for (const lb of ['hip', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
      expect(motSym.filter((t) => 'bone' in t && t.bone === lb)).toEqual(motBase.filter((t) => 'bone' in t && t.bone === lb));
    }

    const posesSym = poseRawAnimation(loadBuild(cSym.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    let maxElbowDiffSym = 0;
    for (const p of posesSym) {
      const b = byName(p.bones);
      const er = b.get('sleeve_r1')!;
      const el = b.get('sleeve_l1')!;
      maxElbowDiffSym = Math.max(maxElbowDiffSym, Math.abs(el.worldY - er.worldY));
      const eyeR = b.get('eye_r')!;
      const eyeL = b.get('eye_l')!;
      const hcx = 0.5 * (eyeR.worldX + eyeL.worldX);
      const ed = Math.hypot(eyeL.worldX - eyeR.worldX, eyeL.worldY - eyeR.worldY);
      const wxR = er.worldX + er.a * 60;
      const wxL = el.worldX + el.a * 60;
      expect(Math.abs(wxR - hcx)).toBeLessThanOrEqual(0.35 * ed + 1e-3);
      expect(Math.abs(wxL - hcx)).toBeLessThanOrEqual(0.35 * ed + 1e-3);
    }
    expect(maxElbowDiffSym).toBeLessThanOrEqual(0.05);

    // Mutant: disabling solveSymmetricFrame leaves the elbows > 15u apart in height.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm188-sym-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'if (set.chains.length !== 2) return null;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'if (true) return null;'));
      const cMut = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rMut = retarget(cMut, ['--raised-by-head'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const posesMut = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      let maxElbowDiffMut = 0;
      for (const p of posesMut) {
        const b = byName(p.bones);
        maxElbowDiffMut = Math.max(maxElbowDiffMut, Math.abs(b.get('sleeve_l1')!.worldY - b.get('sleeve_r1')!.worldY));
      }
      expect(maxElbowDiffMut).toBeGreaterThan(15);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#188 support-arm rule + mutant: a declared "support" chain stays within ±3° of drawn and the active raised arm clears the head outward while keeping lower-body tracks byte-identical', () => {
    // K3_v_sign style: right arm raised (drawn 102°, 77°, wrist > 2 eye_dist from head), left arm on waist (drawn -50°, -125°).
    // On the sequence, left arm has noisy foreshortened swing (-30°, -107°, 20° off drawn).
    const mKey: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 102, rf: () => 77, lu: () => -50, lf: () => -125 };
    const kp = positions(mKey, 0);
    const mSeq: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 102, rf: () => 77, lu: () => -30, lf: () => -107 };
    const pose = poseDoc(mSeq);
    const makeMap = (withSupport: boolean): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K3_sup',
          slots: { sleeve_r0: 'k3_r', sleeve_l0: 'k3_l' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_eye: kp.r_eye!,
            l_eye: kp.l_eye!,
            r_shoulder: kp.r_shoulder!,
            r_elbow: kp.r_elbow!,
            r_wrist: kp.r_wrist!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_r0: 102, sleeve_r1: 77, sleeve_l0: -50, sleeve_l1: -125 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          ...(withSupport ? { support: 'arm_l' } : {}),
        },
      ],
    });

    const cSup = setup({ rig: rigOpts, map: makeMap(true), pose });
    const rSup = retarget(cSup, ['--raised-by-head']);
    expect(rSup.stderr).toBe('');
    expect(rSup.status).toBe(0);

    const posesSup = poseRawAnimation(loadBuild(cSup.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    for (const p of posesSup) {
      const b = byName(p.bones);
      const l0 = Math.atan2(b.get('sleeve_l0')!.c, b.get('sleeve_l0')!.a) * DEG;
      const l1 = Math.atan2(b.get('sleeve_l1')!.c, b.get('sleeve_l1')!.a) * DEG;
      const r0 = Math.atan2(b.get('sleeve_r0')!.c, b.get('sleeve_r0')!.a) * DEG;
      const r1 = Math.atan2(b.get('sleeve_r1')!.c, b.get('sleeve_r1')!.a) * DEG;
      expect(Math.abs(wrap(l0 - -50))).toBeLessThanOrEqual(3);
      expect(Math.abs(wrap(l1 - -125))).toBeLessThanOrEqual(3);
      expect(r0).toBeGreaterThanOrEqual(102 + 8);
      expect(r1).toBeGreaterThanOrEqual(77 + 12);
    }

    // Mutant: disabling solveSupportChainFrame and solveSupportActiveFrame lets arm_l swing > 15° from drawn and leaves arm_r at <= 105°.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm188-sup-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from1 = 'const solveSupportChainFrame = (set: (typeof map.alternates)[number], c: Chain, i: number): void => {';
      const from2 = 'if (c.bones.length < 2 || c.joints.length < 3) return null;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from1)).toHaveLength(2);
      expect(before.split(from2)).toHaveLength(2);
      writeFileSync(
        path,
        before
          .replace(from1, `${from1} if (true) return;`)
          .replace(from2, 'if (true) return null;'),
      );
      const cMut = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rMut = retarget(cMut, ['--raised-by-head'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const posesMut = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const b0 = byName(posesMut[0]!.bones);
      const l0Mut = Math.atan2(b0.get('sleeve_l0')!.c, b0.get('sleeve_l0')!.a) * DEG;
      const r0Mut = Math.atan2(b0.get('sleeve_r0')!.c, b0.get('sleeve_r0')!.a) * DEG;
      expect(Math.abs(wrap(l0Mut - -50))).toBeGreaterThan(15);
      expect(r0Mut).toBeLessThanOrEqual(105);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#189: read yaw from the ear chord when the eye span is foreshortened and the ear chord disagrees with the nose', () => {
  function sideGazeAndTurnPose(): Record<string, unknown> {
    return poseDoc({ ...BASE, n: 20 }, (i, joints) => {
      const neck = (joints.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      // 12 of 20 frames (f6..17) have dEye = de0 = 56.18 -> median(de) = 56.18.
      // - f0..1: held side gaze (de = 0.7972 * de0, xne = 0.0975, xea = 0.2016; w = 1.0)
      // - f2..4: exit ramp (de/de0 = 0.8014, 0.8145, 0.8352; w = 0.972, 0.711, 0.296)
      // - f5..7: post-exit smooth frames (de/de0 = 0.8508, 1.0, 1.0; w = 0)
      // - f18..19: foreshortened normal turn where nose and ear agree (de = 0.7921 * de0, xne = 0.16, xea = 0.20; |xea|/|xne| = 1.25 <= 1.8 -> w = 0)
      const de0 = 56.18;
      const dEar = 123.38;
      let dEye = de0;
      let xne = (i - 12) * 0.08;
      let xea = (i - 12) * 0.08;
      if (i <= 1) {
        dEye = 0.7972 * de0;
        xne = 0.0975;
        xea = 0.2016;
      } else if (i === 2) {
        dEye = 0.8014 * de0;
        xne = 0.1001;
        xea = 0.1953;
      } else if (i === 3) {
        dEye = 0.8145 * de0;
        xne = 0.0927;
        xea = 0.1852;
      } else if (i === 4) {
        dEye = 0.8352 * de0;
        xne = 0.0906;
        xea = 0.1707;
      } else if (i === 5) {
        dEye = 0.8508 * de0;
        xne = 0.0891;
        xea = 0.1471;
      } else if (i === 6) {
        dEye = de0;
        xne = 0.0915;
        xea = 0.1267;
      } else if (i === 7) {
        dEye = de0;
        xne = 0.08;
        xea = 0.08;
      } else if (i >= 18) {
        dEye = 0.7921 * de0;
        xne = 0.16;
        xea = 0.2;
      }
      joints.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      joints.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      const midEarX = midEye[0] + xea * dEar;
      joints.r_ear = { state: 'observed', at: [midEarX - dEar / 2, midEye[1] + 5], score: 0.95 };
      joints.l_ear = { state: 'observed', at: [midEarX + dEar / 2, midEye[1] + 5], score: 0.95 };
      const nx = midEye[0] - xne * dEye;
      joints.nose = { state: 'observed', at: [nx, midEye[1] + 5], score: 0.95 };
    });
  }

  test('reads yaw from the ear chord (+21.964°) on the foreshortened side-gaze opening with 0.000°/f jitter, ramps out smoothly across [0.80, 0.85]*median(de), and keeps outside frames byte-identical to the regime-off mutant', () => {
    const pose = sideGazeAndTurnPose();
    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw_dial', parent: 'root' }],
    };
    const map = { ...baseMap(), face: { yaw: { bone: 'yaw_dial', range: [-30, 30] } } };
    const c = setup({ rig: rigOpts, map, pose });
    const r = retarget(c, ['--bends', 'clamp']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const mot = motionOf(c.out).animations.dance!.tracks;
    const yawKeys = mot.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
    // On f0..1 (w = 1.0), yaw_dial reaches atan(2 * 0.2016) * DEG = 21.964° with 0.000°/f jitter.
    expect(yawKeys[0]!).toBeCloseTo(21.964, 2);
    expect(yawKeys[1]!).toBeCloseTo(21.964, 2);
    expect(Math.abs(yawKeys[1]! - yawKeys[0]!)).toBe(0);

    // Bar 2 boundary smoothness: across the regime exit (f4 -> f5), max |Δyaw| on boundary ±3 frames (f2..7) <= 5°/f (absolute ceiling) and <= max |Δyaw| inside regime (f0..4) + 2°.
    let maxInRegime = 0;
    for (let i = 1; i <= 4; i++) maxInRegime = Math.max(maxInRegime, Math.abs(yawKeys[i]! - yawKeys[i - 1]!));
    let maxBoundary = 0;
    for (let i = 2; i <= 7; i++) maxBoundary = Math.max(maxBoundary, Math.abs(yawKeys[i]! - yawKeys[i - 1]!));
    const exitStep = Math.abs(yawKeys[5]! - yawKeys[4]!);
    expect(exitStep).toBeLessThan(3.5);
    expect(maxBoundary).toBeLessThanOrEqual(5);
    expect(maxBoundary).toBeLessThanOrEqual(maxInRegime + 2);

    // Mutant 1: disabling the earChord regime drops f0..1 back down to ~12.2° while f5..19 are 100% byte-identical.
    mkdirSync(MUTANTS, { recursive: true });
    const d1 = mkdtempSync(join(MUTANTS, 'm189-off-'));
    try {
      cpSync(join(ROOT, 'src'), join(d1, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d1, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d1, 'package.json'));
      const path = join(d1, 'src', 'face.ts');
      const from = 'Math.abs(xea[i]!) > EAR_CHORD_K_MIN;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'false;'));

      const cOff = setup({ rig: rigOpts, map, pose });
      const rOff = retarget(cOff, ['--bends', 'clamp'], join(d1, 'cli.ts'));
      expect(rOff.status).toBe(0);
      const motOff = motionOf(cOff.out).animations.dance!.tracks;
      const yawOff = motOff.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
      for (let i = 0; i < 2; i++) {
        expect(yawOff[i]!).toBeLessThan(12.5);
      }
      // Every frame with w = 0 (frames 5..19) is byte-identical, and all non-yaw_dial tracks are byte-identical.
      expect(yawKeys.slice(5)).toEqual(yawOff.slice(5));
      expect(mot.filter((tr) => !('bone' in tr && tr.bone === 'yaw_dial'))).toEqual(
        motOff.filter((tr) => !('bone' in tr && tr.bone === 'yaw_dial')),
      );
    } finally {
      rmSync(d1, { recursive: true, force: true });
    }
  }, SLOW);

  test('mutant (#189): lowering EAR_CHORD_K_RATIO to 1.0 leaks onto normal foreshortened turns, and a step exit (EAR_CHORD_K_LO = 0.85) snaps by > 8° across the boundary', () => {
    const pose = sideGazeAndTurnPose();
    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw_dial', parent: 'root' }],
    };
    const map = { ...baseMap(), face: { yaw: { bone: 'yaw_dial', range: [-30, 30] } } };
    const c = setup({ rig: rigOpts, map, pose });
    const r = retarget(c, ['--bends', 'clamp']);
    expect(r.status).toBe(0);
    const yawKeys = motionOf(c.out).animations.dance!.tracks.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);

    mkdirSync(MUTANTS, { recursive: true });
    const d2 = mkdtempSync(join(MUTANTS, 'm189-kratio-'));
    try {
      cpSync(join(ROOT, 'src'), join(d2, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d2, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d2, 'package.json'));
      const path = join(d2, 'src', 'face.ts');
      const from = 'export const EAR_CHORD_K_RATIO = 1.8;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const EAR_CHORD_K_RATIO = 1.0;'));

      const cK1 = setup({ rig: rigOpts, map, pose });
      const rK1 = retarget(cK1, ['--bends', 'clamp'], join(d2, 'cli.ts'));
      expect(rK1.status).toBe(0);
      const motK1 = motionOf(cK1.out).animations.dance!.tracks;
      const yawK1 = motK1.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
      expect(yawK1.slice(5)).not.toEqual(yawKeys.slice(5));
      expect(Math.abs(yawK1[19]! - yawKeys[19]!)).toBeGreaterThan(4);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }

    const d3 = mkdtempSync(join(MUTANTS, 'm189-step-'));
    try {
      cpSync(join(ROOT, 'src'), join(d3, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d3, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d3, 'package.json'));
      const path = join(d3, 'src', 'face.ts');
      const from = 'export const EAR_CHORD_K_LO = 0.8;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const EAR_CHORD_K_LO = 0.85;'));

      const cStep = setup({ rig: rigOpts, map, pose });
      const rStep = retarget(cStep, ['--bends', 'clamp'], join(d3, 'cli.ts'));
      expect(rStep.status).toBe(0);
      const motStep = motionOf(cStep.out).animations.dance!.tracks;
      const yawStep = motStep.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
      let maxInStep = 0;
      for (let i = 1; i <= 4; i++) maxInStep = Math.max(maxInStep, Math.abs(yawStep[i]! - yawStep[i - 1]!));
      const snapStep = Math.abs(yawStep[5]! - yawStep[4]!);
      expect(snapStep).toBeGreaterThan(8);
      expect(snapStep).toBeGreaterThan(maxInStep + 2);
    } finally {
      rmSync(d3, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#190 / #205: beat nod: clamped head.translate.y drives pitch_dial and head.rotate in phase when the neck-length clamp acts', () => {
  test('couples clamped head.translate.y into pitch_dial.rotate (2.8 °/u) and head.rotate (1.6 °/u) within ≤ 0.5° in phase at the beat frequency, adds 0 on un-nodded frames, flattens when disabled, and fails Bar 1 when residual is put back in', () => {
    const N = 63;
    const DT = 1 / 24;
    const headRig: NonNullable<RigOpts['bones']> = (b) => [
      ...b,
      { name: 'head', parent: 'neck', x: 0, y: 50 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
      { name: 'pitch_dial', parent: 'head', x: 0, y: 0 },
    ];
    const mapSpec: Record<string, unknown> = {
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      face: {
        pitch: { bone: 'pitch_dial', range: [-25, 25] },
      },
    };
    // Frames 0..11: 0u vertical nod -> clampedY === 0 -> pitch_dial === 0° and head.rotate === 0°.
    // Frames 12..62: 2-cycle beat nod (bin 2 over 63 frames, 0.7619 Hz) with 12.0u amplitude on maxNod = 1.0u
    // (clampedY within ±1.0u, unbounded residual up to ±11.0u).
    // Nose moves vertically with the eyes so raw 2D face pitch (nose vs eyes/ears) is 0° on every frame.
    const beatNodSignal = (i: number): number => {
      if (i < 12) return 0;
      return 12.0 * Math.sin(((2 * i) / N) * 2 * Math.PI);
    };
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    const pose = poseDoc(m, (i, j) => {
      j.r_ankle = { state: 'observed', at: [-20, 350], score: 0.95 };
      j.l_ankle = { state: 'observed', at: [20, 320], score: 0.95 };
      const dyPic = -beatNodSignal(i) / SCALE;
      const rEye = j.r_eye!.at as Pt;
      const lEye = j.l_eye!.at as Pt;
      const midEyeY = (rEye[1] + lEye[1]) / 2 + dyPic;
      const midEyeX = (rEye[0] + lEye[0]) / 2;
      j.r_eye = { state: 'observed', at: [rEye[0], rEye[1] + dyPic], score: 0.95 };
      j.l_eye = { state: 'observed', at: [lEye[0], lEye[1] + dyPic], score: 0.95 };
      j.r_ear = { state: 'observed', at: [midEyeX - 18, midEyeY], score: 0.95 };
      j.l_ear = { state: 'observed', at: [midEyeX + 18, midEyeY], score: 0.95 };
      j.nose = { state: 'observed', at: [midEyeX, midEyeY], score: 0.95 };
    });

    const c = setup({ rig: { bones: headRig }, map: mapSpec, pose });
    const r = retarget(c, ['--bends', 'clamp']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const mot = motionOf(c.out).animations.dance!.tracks;
    const headTrans = mot.find((t) => 'bone' in t && t.bone === 'head' && t.property === 'translate')!.keys.map((k) => (k.v as number[])[1]!);
    const headRot = mot.find((t) => 'bone' in t && t.bone === 'head' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
    const pitchRot = mot.find((t) => 'bone' in t && t.bone === 'pitch_dial' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);

    // Bar 1 (#205): pitch_dial.rotate and head.rotate match 2.8 * clampedY and 1.6 * clampedY within ≤ 0.5° on every frame, and are 0 wherever clampedY is 0.
    expect(headTrans[0]).toBe(0);
    for (let i = 0; i < N; i++) {
      if (headTrans[i] === 0) {
        expect(pitchRot[i]).toBe(0);
        expect(headRot[i]).toBe(0);
      }
    }
    let maxErrPitch = 0;
    let maxErrHead = 0;
    for (let i = 0; i < N; i++) {
      maxErrPitch = Math.max(maxErrPitch, Math.abs(pitchRot[i]! - 2.8 * headTrans[i]!));
      maxErrHead = Math.max(maxErrHead, Math.abs(headRot[i]! - 1.6 * headTrans[i]!));
    }
    expect(maxErrPitch).toBeLessThanOrEqual(0.5);
    expect(maxErrHead).toBeLessThanOrEqual(0.5);
    const maxPitch = Math.max(...pitchRot.slice(12).map((v) => Math.abs(v)));
    const maxHeadRot = Math.max(...headRot.slice(12).map((v) => Math.abs(v)));
    expect(maxPitch).toBeGreaterThan(2.5);
    expect(maxPitch).toBeLessThanOrEqual(3.0);
    expect(maxHeadRot).toBeGreaterThan(1.4);
    expect(maxHeadRot).toBeLessThanOrEqual(1.8);
    for (let i = 12; i < N; i++) {
      if (Math.abs(pitchRot[i]!) > 0.5) {
        expect(Math.sign(pitchRot[i]!)).toBe(Math.sign(headRot[i]!));
        expect(Math.sign(pitchRot[i]!)).toBe(Math.sign(headTrans[i]!));
      }
    }

    // Bar 3 (#190 / #205): DFT peak frequency of pitch_dial matches the reference vertical head travel within 1 bin and in phase.
    const dftPeak = (sig: readonly number[]) => {
      const m0 = sig.reduce((a, b) => a + b, 0) / sig.length;
      const x = sig.map((v) => v - m0);
      let bestBin = 1;
      let bestMag = -1;
      let bestPhase = 0;
      for (let k = 1; k <= Math.floor(sig.length / 2); k++) {
        let re = 0;
        let im = 0;
        for (let n = 0; n < sig.length; n++) {
          const ang = (-2 * Math.PI * k * n) / sig.length;
          re += x[n]! * Math.cos(ang);
          im += x[n]! * Math.sin(ang);
        }
        const mag = (2 * Math.hypot(re, im)) / sig.length;
        if (mag > bestMag) {
          bestMag = mag;
          bestBin = k;
          bestPhase = Math.atan2(im, re) * DEG;
        }
      }
      return { bin: bestBin, mag: bestMag, phase: bestPhase };
    };
    const refPeak = dftPeak(Array.from({ length: N }, (_, i) => beatNodSignal(i)));
    const pitchPeak = dftPeak(pitchRot);
    expect(Math.abs(pitchPeak.bin - refPeak.bin)).toBeLessThanOrEqual(1);
    expect(pitchPeak.bin).toBe(2);
    expect(Math.abs(wrap(pitchPeak.phase - refPeak.phase))).toBeLessThan(15);

    // Mutant A: lower-body tracks are byte-identical, and disabling the coupling flattens pitch_dial and head.rotate to 0°.
    // Mutant B (#205 Bar 4): putting `headNodReading.residual` back in instead of `headNodReading.clampedY` fails Bar 1 (max |Δ| > 15° > 0.5°).
    mkdirSync(MUTANTS, { recursive: true });
    const dZero = mkdtempSync(join(MUTANTS, 'm190-zero-'));
    const dRes = mkdtempSync(join(MUTANTS, 'm205-res-'));
    try {
      cpSync(join(ROOT, 'src'), join(dZero, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(dZero, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(dZero, 'package.json'));
      const pathZero = join(dZero, 'src', 'retarget.ts');
      const fromPitch = 'export const NOD_RESIDUAL_PITCH_GAIN = 2.8;';
      const fromHead = 'export const NOD_RESIDUAL_HEAD_GAIN = 1.6;';
      const before = readFileSync(pathZero, 'utf8');
      expect(before.split(fromPitch)).toHaveLength(2);
      expect(before.split(fromHead)).toHaveLength(2);
      writeFileSync(
        pathZero,
        before
          .replace(fromPitch, 'export const NOD_RESIDUAL_PITCH_GAIN = 0;')
          .replace(fromHead, 'export const NOD_RESIDUAL_HEAD_GAIN = 0;'),
      );

      const cMut = setup({ rig: { bones: headRig }, map: mapSpec, pose });
      const rMut = retarget(cMut, ['--bends', 'clamp'], join(dZero, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const motMut = motionOf(cMut.out).animations.dance!.tracks;
      for (const lb of ['hip', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
        expect(mot.filter((t) => 'bone' in t && t.bone === lb)).toEqual(motMut.filter((t) => 'bone' in t && t.bone === lb));
      }
      const mutPitch = motMut.find((t) => 'bone' in t && t.bone === 'pitch_dial' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
      const mutHeadRot = motMut.find((t) => 'bone' in t && t.bone === 'head' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
      expect(Math.max(...mutPitch.map((v) => Math.abs(v)))).toBe(0);
      expect(Math.max(...mutHeadRot.map((v) => Math.abs(v)))).toBe(0);

      cpSync(join(ROOT, 'src'), join(dRes, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(dRes, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(dRes, 'package.json'));
      const pathRes = join(dRes, 'src', 'retarget.ts');
      const fromClamped = 'const nodCoupled = headNodReading !== null && headNodReading.residual.some((r) => r !== 0) ? headNodReading.clampedY : null;';
      expect(before.split(fromClamped)).toHaveLength(2);
      writeFileSync(
        pathRes,
        before.replace(
          fromClamped,
          'const nodCoupled = headNodReading !== null && headNodReading.residual.some((r) => r !== 0) ? headNodReading.residual : null;',
        ),
      );
      const cRes = setup({ rig: { bones: headRig }, map: mapSpec, pose });
      const rRes = retarget(cRes, ['--bends', 'clamp'], join(dRes, 'cli.ts'));
      expect(rRes.status).toBe(0);
      const motRes = motionOf(cRes.out).animations.dance!.tracks;
      const resPitch = motRes.find((t) => 'bone' in t && t.bone === 'pitch_dial' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
      const resHead = motRes.find((t) => 'bone' in t && t.bone === 'head' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
      const resErrPitch = Math.max(...resPitch.map((v, i) => Math.abs(v - 2.8 * headTrans[i]!)));
      const resErrHead = Math.max(...resHead.map((v, i) => Math.abs(v - 1.6 * headTrans[i]!)));
      expect(resErrPitch).toBeGreaterThan(15);
      expect(resErrHead).toBeGreaterThan(10);
    } finally {
      rmSync(dZero, { recursive: true, force: true });
      rmSync(dRes, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#191: head-anchored end-effector two-link IK inside art turn range', () => {
  const N = 16;
  const DT = 1 / 24;
  const rigOpts: RigOpts = {
    bones: (b) => [
      ...b,
      { name: 'head', parent: 'neck', x: 0, y: 20 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    ],
    extra: {
      sleeve_l0: { k4_l0: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
      sleeve_l1: { k4_l1: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
    },
  };

  test('MAP_ALT_ANCHOR and ANCHOR_HEAD refuse malformed declarations by name', () => {
    const m: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], lu: () => -35, lf: () => 90 };
    const kp = positions(m, 0);
    const makeMap = (altPatch: Record<string, unknown>, includeHeadChain = true): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        ...(includeHeadChain ? [{ name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] }] : []),
      ],
      alternates: [
        {
          name: 'K4_hand_up',
          slots: { sleeve_l0: 'k4_l0', sleeve_l1: 'k4_l1' },
          chains: ['arm_l'],
          pose: {
            r_eye: kp.r_eye!,
            l_eye: kp.l_eye!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_l0: -35, sleeve_l1: 90 },
          turn: { sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          ...altPatch,
        },
      ],
    });
    const pose = poseDoc(m);

    const rBadChain = retarget(setup({ rig: rigOpts, map: makeMap({ anchor: 'leg_l' }), pose }));
    expect(rBadChain.status).toBe(1);
    expect(rBadChain.stderr).toContain('MAP_ALT_ANCHOR');

    const rMissingDrawn = retarget(
      setup({
        rig: rigOpts,
        map: makeMap({ anchor: 'arm_l', drawn: { sleeve_l0: -35 } }),
        pose,
      }),
    );
    expect(rMissingDrawn.status).toBe(1);
    expect(rMissingDrawn.stderr).toContain('MAP_ALT_ANCHOR');

    const rConflictSup = retarget(
      setup({
        rig: rigOpts,
        map: makeMap({ anchor: 'arm_l', support: 'arm_l' }),
        pose,
      }),
    );
    expect(rConflictSup.status).toBe(1);
    expect(rConflictSup.stderr).toContain('MAP_ALT_ANCHOR');

    const rNoHead = retarget(setup({ rig: rigOpts, map: makeMap({ anchor: 'arm_l' }, false), pose }));
    expect(rNoHead.status).toBe(1);
    expect(rNoHead.stderr).toContain('ANCHOR_HEAD');
  });

  test('#191 head-local IK + mutants: holds hand-tip-to-head local offset at 0.00u on unclamped frames, reports saturated frames with residual, keeps all non-anchored tracks byte-identical, and distinguishes head-local from world-fixed and off', () => {
    // Drawn pose: trunk=90°, head=0°, lu=-35°, lf=90°.
    // Sequence:
    // - frames 0..11: trunk leans up to +6° and head rolls +10° while 2D wrist drifts away by +15° on lu/lf (reachable within ±20° turn -> 0.00u head-local residual).
    // - frames 12..15: trunk leans -18° and head rolls -22°, forcing sleeve_l0/l1 against the ±20° turn clamp -> reported in `saturated`.
    const mKey: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], lu: () => -35, lf: () => 90 };
    const kp = positions(mKey, 0);
    const mSeq: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      hip: () => [0, 0],
      trunk: (i) => (i < 12 ? 90 + 6 * Math.sin((i / 11) * Math.PI) : 72),
      lu: () => -22,
      lf: () => 104,
    };
    const pose = poseDoc(mSeq, (i, j) => {
      const headDeg = i < 12 ? 10 * Math.sin((i / 11) * Math.PI) : -22;
      const rad = (headDeg * Math.PI) / 180;
      const rE = j.r_eye!.at as Pt;
      const lE = j.l_eye!.at as Pt;
      const cx = 0.5 * (rE[0] + lE[0]);
      const cy = 0.5 * (rE[1] + lE[1]);
      const half = 0.5 * Math.hypot(lE[0] - rE[0], lE[1] - rE[1]);
      j.r_eye = { state: 'observed', at: [cx - half * Math.cos(rad), cy + half * Math.sin(rad)], score: 0.95 };
      j.l_eye = { state: 'observed', at: [cx + half * Math.cos(rad), cy - half * Math.sin(rad)], score: 0.95 };
    });
    const makeMap = (withAnchor: boolean): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K4_hand_up',
          slots: { sleeve_l0: 'k4_l0', sleeve_l1: 'k4_l1' },
          chains: ['arm_l'],
          pose: {
            r_eye: kp.r_eye!,
            l_eye: kp.l_eye!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_l0: -35, sleeve_l1: 90 },
          turn: { sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          ...(withAnchor ? { anchor: 'arm_l' } : {}),
        },
      ],
    });

    const cAnc = setup({ rig: rigOpts, map: makeMap(true), pose });
    const repFile = join(cAnc.dir, 'report.json');
    const rAnc = retarget(cAnc, ['--raised-by-head', '--report', repFile]);
    expect(rAnc.stderr).toBe('');
    expect(rAnc.status).toBe(0);
    expect(rAnc.stdout).toContain('residual f12');

    const rep = JSON.parse(readFileSync(repFile, 'utf8')) as {
      raised: Array<{ saturated?: Array<{ frame: number; residual: number }> }>;
    };
    const satFrames = new Set((rep.raised[0]?.saturated ?? []).map((s) => s.frame));
    expect(satFrames.has(12)).toBe(true);
    for (let i = 0; i < 12; i++) expect(satFrames.has(i)).toBe(false);

    // Measure posed hand-tip-to-head offset in head-local and world frames.
    const buildAnc = loadBuild(cAnc.build);
    const setupPose = byName(poseRawAnimation(buildAnc, 'dance', [0], {}, 'setup')[0]!.bones);
    const s0 = setupPose.get('sleeve_l0')!;
    const h0 = setupPose.get('head')!;
    const l0 = 70;
    const l1 = 60;
    const wDrawn: Pt = [
      s0.worldX + l0 * Math.cos((-35 * Math.PI) / 180) + l1 * Math.cos((90 * Math.PI) / 180),
      s0.worldY + l0 * Math.sin((-35 * Math.PI) / 180) + l1 * Math.sin((90 * Math.PI) / 180),
    ];
    const dDrawnWorld: Pt = [wDrawn[0] - h0.worldX, wDrawn[1] - h0.worldY];

    const measureOffsets = (buildDir: string) => {
      const poses = poseRawAnimation(loadBuild(buildDir), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const localErrs: number[] = [];
      const worldErrs: number[] = [];
      for (let i = 0; i < N; i++) {
        const b = byName(poses[i]!.bones);
        const sl0 = b.get('sleeve_l0')!;
        const sl1 = b.get('sleeve_l1')!;
        const hd = b.get('head')!;
        const a0 = Math.atan2(sl0.c, sl0.a) * DEG;
        const a1 = Math.atan2(sl1.c, sl1.a) * DEG;
        expect(Math.abs(wrap(a0 - -35))).toBeLessThanOrEqual(20.005);
        expect(Math.abs(wrap(a1 - 90))).toBeLessThanOrEqual(20.005);
        const w: Pt = [sl1.worldX + sl1.a * l1, sl1.worldY + sl1.c * l1];
        const dw: Pt = [w[0] - hd.worldX, w[1] - hd.worldY];
        worldErrs.push(Math.hypot(dw[0] - dDrawnWorld[0], dw[1] - dDrawnWorld[1]));
        const hRot = Math.atan2(hd.c, hd.a) - Math.atan2(h0.c, h0.a);
        const c = Math.cos(-hRot);
        const s = Math.sin(-hRot);
        const dLocal: Pt = [dw[0] * c - dw[1] * s, dw[0] * s + dw[1] * c];
        localErrs.push(Math.hypot(dLocal[0] - dDrawnWorld[0], dLocal[1] - dDrawnWorld[1]));
      }
      return { localErrs, worldErrs };
    };

    const mAnc = measureOffsets(cAnc.build);
    for (let i = 0; i < 12; i++) {
      expect(mAnc.localErrs[i]!).toBeLessThanOrEqual(0.05);
    }

    // Mutants: HEAD_ANCHOR_FRAME = 'off' and 'world-fixed'.
    mkdirSync(MUTANTS, { recursive: true });
    const dOff = mkdtempSync(join(MUTANTS, 'm191-off-'));
    const dWorld = mkdtempSync(join(MUTANTS, 'm191-world-'));
    try {
      for (const [d, mode] of [
        [dOff, 'off'],
        [dWorld, 'world-fixed'],
      ] as const) {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'retarget.ts');
        const from = "export const HEAD_ANCHOR_FRAME: 'head-local' | 'world-fixed' | 'off' = 'head-local';";
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, `export const HEAD_ANCHOR_FRAME: 'head-local' | 'world-fixed' | 'off' = '${mode}';`));
      }

      const cOff = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rOff = retarget(cOff, ['--raised-by-head'], join(dOff, 'cli.ts'));
      expect(rOff.status).toBe(0);
      const mOff = measureOffsets(cOff.build);
      expect(Math.max(...mOff.localErrs.slice(0, 12))).toBeGreaterThan(12);

      // Bar 3: every track other than sleeve_l0.rotate and sleeve_l1.rotate is byte-identical.
      const motAnc = motionOf(cAnc.out).animations.dance!.tracks;
      const motOff = motionOf(cOff.out).animations.dance!.tracks;
      const nonArm = (ts: typeof motAnc) =>
        ts.filter((t) => !('bone' in t && (t.bone === 'sleeve_l0' || t.bone === 'sleeve_l1') && t.property === 'rotate'));
      expect(nonArm(motAnc)).toEqual(nonArm(motOff));

      const cWorld = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rWorld = retarget(cWorld, ['--raised-by-head'], join(dWorld, 'cli.ts'));
      expect(rWorld.status).toBe(0);
      const mWorld = measureOffsets(cWorld.build);
      // On frame 5 (head rolled +10°), world-fixed holds worldErr ~ 0 while head-local drift exceeds 5u.
      expect(mWorld.worldErrs[5]!).toBeLessThanOrEqual(0.05);
      expect(mWorld.localErrs[5]!).toBeGreaterThan(5);
    } finally {
      rmSync(dOff, { recursive: true, force: true });
      rmSync(dWorld, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#206: gesture-set bridges interpolate in joint space, apply set.support only from loShow, and include extended holds in covered', () => {
  test('joint-space bridge, loShow support start, and extended hold coverage + 3 mutants', () => {
    const N = 36;
    const DT = 1 / 24;
    const att = { image: 'seg.png', x: 30, y: 0, rotation: -90 };
    const rigOpts: RigOpts = {
      bones: (b) => [
        ...b.map((x) => (x.name === 'sleeve_r1' || x.name === 'sleeve_l1' ? { ...x, rotation: 0 } : x)),
        { name: 'head', parent: 'neck', x: 0, y: 20 },
        { name: 'eye_r', parent: 'head', x: -6, y: 10 },
        { name: 'eye_l', parent: 'head', x: 6, y: 10 },
      ],
      extra: {
        sleeve_r0: { k1_r0: att, k2_r0: att, k3_r0: att },
        sleeve_r1: { k1_r1: att, k2_r1: att, k3_r1: att },
        sleeve_l0: { k1_l0: att, k2_l0: att, k3_l0: att },
        sleeve_l1: { k1_l1: att, k2_l1: att, k3_l1: att },
      },
    };
    // Key poses:
    // K1_sym (symmetric raised, frames 0..7): ru=120, rf=25 (local -95), lu=60, lf=155 (local +95)
    // K2_hips (hands on hips, frames 12..18, 32..35): ru=-70, rf=-30 (local +40), lu=-110, lf=-150 (local -40)
    // K3_sup (raised right + support left, frames 22..28): ru=95, rf=85 (local -10), lu=-85, lf=-165 (local -80)
    const kp1 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 120, rf: () => 25, lu: () => 60, lf: () => 155 }, 0);
    const kp2 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => -70, rf: () => -30, lu: () => -110, lf: () => -150 }, 0);
    const kp3 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 95, rf: () => 85, lu: () => -85, lf: () => -165 }, 0);

    const mSeq: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      hip: () => [0, 0],
      trunk: () => 90,
      ru: (i) => {
        if (i <= 7) return 120;
        if (i === 8) return 90;
        if (i === 9) return 80;
        if (i === 10) return 50;
        if (i === 11) return -55;
        if (i <= 18) return -70;
        if (i === 19) return -40;
        if (i === 20) return -25;
        if (i === 21) return 45;
        if (i <= 28) return 95;
        if (i === 29) return -20;
        if (i === 30) return -35;
        if (i === 31) return -50;
        return -70;
      },
      rf: (i) => {
        if (i <= 7) return 25;
        if (i === 8) return 35;
        if (i === 9) return 35;
        if (i === 10) return 35;
        if (i === 11) return -20;
        if (i <= 18) return -30;
        if (i === 19) return -20;
        if (i === 20) return 0;
        if (i === 21) return 45;
        if (i <= 28) return 85;
        if (i === 29) return -5;
        if (i === 30) return -10;
        if (i === 31) return -20;
        return -30;
      },
      lu: (i) => {
        if (i <= 7) return 60;
        if (i === 8) return 45;
        if (i === 9) return 40;
        if (i === 10) return 10;
        if (i === 11) return -85;
        if (i <= 18) return -110;
        if (i === 19) return -106;
        if (i === 20) return -102;
        if (i === 21) return -92;
        if (i <= 28) return -85;
        if (i === 29) return -105;
        if (i === 30) return -108;
        return -110;
      },
      lf: (i) => {
        if (i <= 7) return 155;
        if (i === 8) return 145;
        if (i === 9) return 145;
        if (i === 10) return 145;
        if (i === 11) return -135;
        if (i <= 18) return -150;
        if (i === 19) return -152;
        if (i === 20) return -155;
        if (i === 21) return -160;
        if (i <= 28) return -165;
        if (i <= 31) return -110; // 40° from K2_hips.drawn (-150°), so only syncBridgeClamp puts extended hold 29..31 into cClamp/covered
        return -150;
      },
    };
    const pose = poseDoc(mSeq);
    const mapDoc: Record<string, unknown> = {
      ...baseMap(),
      chains: [
        ...baseChains().map((c) =>
          c.name === 'arm_r'
            ? { ...c, bend: 'free', range: { sleeve_r0: [-130, 50], sleeve_r1: [-175, 50] } }
            : c.name === 'arm_l'
              ? { ...c, bend: 'free', range: { sleeve_l0: [-50, 130], sleeve_l1: [-50, 175] } }
              : c,
        ),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K1_sym',
          slots: { back_r0: 'k1_r0', back_r1: 'k1_r1', back_l0: 'k1_l0', back_l1: 'k1_l1', topwear: 'top_k1' },
          hides: ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp1.r_shoulder!,
            r_elbow: kp1.r_elbow!,
            r_wrist: kp1.r_wrist!,
            l_shoulder: kp1.l_shoulder!,
            l_elbow: kp1.l_elbow!,
            l_wrist: kp1.l_wrist!,
          },
          drawn: { sleeve_r0: 120, sleeve_r1: 25, sleeve_l0: 60, sleeve_l1: 155 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          symmetric: true,
        },
        {
          name: 'K2_hips',
          slots: { sleeve_r0: 'k2_r0', sleeve_r1: 'k2_r1', sleeve_l0: 'k2_l0', sleeve_l1: 'k2_l1', topwear: 'top_k2' },
          hides: ['back_r0', 'back_r1', 'back_l0', 'back_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp2.r_shoulder!,
            r_elbow: kp2.r_elbow!,
            r_wrist: kp2.r_wrist!,
            l_shoulder: kp2.l_shoulder!,
            l_elbow: kp2.l_elbow!,
            l_wrist: kp2.l_wrist!,
          },
          drawn: { sleeve_r0: -70, sleeve_r1: -30, sleeve_l0: -110, sleeve_l1: -150 },
          turn: { sleeve_r0: [-5, 5], sleeve_r1: [-5, 5], sleeve_l0: [-5, 5], sleeve_l1: [-5, 5] },
        },
        {
          name: 'K3_sup',
          slots: { back_r0: 'k3_r0', back_r1: 'k3_r1', back_l0: 'k3_l0', back_l1: 'k3_l1', topwear: 'top_k3' },
          hides: ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp3.r_shoulder!,
            r_elbow: kp3.r_elbow!,
            r_wrist: kp3.r_wrist!,
            l_shoulder: kp3.l_shoulder!,
            l_elbow: kp3.l_elbow!,
            l_wrist: kp3.l_wrist!,
          },
          drawn: { sleeve_r0: 95, sleeve_r1: 85, sleeve_l0: -85, sleeve_l1: -165 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-15, 15], sleeve_l1: [-15, 15] },
          support: 'arm_l',
        },
      ],
    };

    const makeCase = () => {
      const cs = setup({ rig: rigOpts, map: mapDoc, pose });
      const rigJsonPath = join(cs.rig, 'rig.json');
      const rigSpec = JSON.parse(readFileSync(rigJsonPath, 'utf8')) as {
        slots: Array<Record<string, unknown>>;
        skins: { default: Record<string, Record<string, unknown>> };
      };
      rigSpec.slots = [
        { name: 'back_r0', bone: 'sleeve_r0', attachment: null },
        { name: 'back_r1', bone: 'sleeve_r1', attachment: null },
        { name: 'back_l0', bone: 'sleeve_l0', attachment: null },
        { name: 'back_l1', bone: 'sleeve_l1', attachment: null },
        { name: 'topwear', bone: 'chest', attachment: 'seg' },
        ...rigSpec.slots,
      ];
      rigSpec.skins.default.back_r0 = { k1_r0: att, k3_r0: att };
      rigSpec.skins.default.back_r1 = { k1_r1: att, k3_r1: att };
      rigSpec.skins.default.back_l0 = { k1_l0: att, k3_l0: att };
      rigSpec.skins.default.back_l1 = { k1_l1: att, k3_l1: att };
      rigSpec.skins.default.topwear = { seg: att, top_k1: att, top_k2: att, top_k3: att };
      writeFileSync(rigJsonPath, JSON.stringify(rigSpec, null, 2));
      return cs;
    };

    const c = makeCase();
    const r = retarget(c, ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const tracks = motionOf(c.out).animations.dance!.tracks;
    const rotOf = (bone: string, f: number): number =>
      wrap((tracks.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);

    // 1. Across K1 -> K2 bridge (frames 8..11), forearms never invert through ±180° (|rot| stays <= 146°).
    for (let f = 8; f <= 11; f++) {
      expect(Math.abs(rotOf('sleeve_r1', f))).toBeLessThanOrEqual(146);
      expect(Math.abs(rotOf('sleeve_l1', f))).toBeLessThanOrEqual(146);
    }

    // 2. On frame 19 (first gap frame after K2 [12..18], while K2 is still shown before K3 switches at 21),
    //    support arm sleeve_l1 bridges smoothly instead of snapping early to K3's -80° support pose.
    expect(Math.abs(wrap(rotOf('sleeve_l1', 19) - rotOf('sleeve_l1', 18)))).toBeLessThanOrEqual(20);

    // 3. On frame 29..31 (gap between K3 [22..28] and K2 [32..35]), extended hold covers the tight K2_hips frames.
    expect(Math.abs(wrap(rotOf('sleeve_l1', 30) - rotOf('sleeve_l1', 32)))).toBeLessThanOrEqual(20);

    // Mutants 1, 2, 3:
    mkdirSync(MUTANTS, { recursive: true });
    const dM1 = mkdtempSync(join(MUTANTS, 'm206-1-'));
    const dM2 = mkdtempSync(join(MUTANTS, 'm206-2-'));
    const dM3 = mkdtempSync(join(MUTANTS, 'm206-3-'));
    try {
      for (const d of [dM1, dM2, dM3]) {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      }

      // Mutant 1: world-angle bridge interpolation in switch.ts / retarget.ts flips forearm past 160° on frames 8..11.
      {
        const pSw = join(dM1, 'src', 'switch.ts');
        const swSrc = readFileSync(pSw, 'utf8');
        const swFrom = 'const parentTg = parentBone !== undefined ? targets.get(parentBone) : undefined;';
        expect(swSrc.split(swFrom)).toHaveLength(2);
        writeFileSync(pSw, swSrc.replace(swFrom, 'const parentTg = undefined;'));
        const pRet = join(dM1, 'src', 'retarget.ts');
        const src = readFileSync(pRet, 'utf8');
        const from1 = 'const parentTg = bIdx > 0 ? targets.get(ch.bones[bIdx - 1]!) : undefined;';
        const from2 = 'targets.get(bR1)![i] = wrap(inR1 + 0.45 * wrap(aR0 - drawnR0));\n            targets.get(bL1)![i] = wrap(inL1 + 0.45 * wrap(aL0 - drawnL0));';
        const from3 = 'if (set.anchor === undefined && set.symmetric !== true && set.support === undefined && loShow < s.frames[0]) {';
        expect(src.split(from1)).toHaveLength(2);
        expect(src.split(from2)).toHaveLength(2);
        expect(src.split(from3)).toHaveLength(2);
        writeFileSync(pRet, src.replace(from1, 'const parentTg = undefined;').replace(from2, '').replace(from3, 'if (false) {'));
        const cM1 = makeCase();
        const rM1 = retarget(cM1, ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1'], join(dM1, 'cli.ts'));
        expect(rM1.status).toBe(0);
        const trM1 = motionOf(cM1.out).animations.dance!.tracks;
        const rotM1 = (bone: string, f: number): number =>
          wrap((trM1.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);
        const maxElbowM1 = Math.max(...[8, 9, 10, 11].flatMap((f) => [Math.abs(rotM1('sleeve_r1', f)), Math.abs(rotM1('sleeve_l1', f))]));
        expect(maxElbowM1).toBeGreaterThan(155);
      }

      // Mutant 2: set.support applied from Math.min(loGap, loShow) without bridging loGap..loShow-1, snapping frame 19 to K3's -80° support pose while K2 is still shown.
      {
        const pRet = join(dM2, 'src', 'retarget.ts');
        const src = readFileSync(pRet, 'utf8');
        const from = 'for (let i = loShow; i <= hiShow; i++) solveSupportChainFrame(set, c, i);\n          if (loGap < loShow && loGap >= 1) {';
        expect(src.split(from)).toHaveLength(2);
        writeFileSync(
          pRet,
          src.replace(
            from,
            'for (let i = Math.min(loGap, loShow); i <= hiShow; i++) solveSupportChainFrame(set, c, i);\n          if (false && loGap < loShow && loGap >= 1) {',
          ),
        );
        const cM2 = makeCase();
        const rM2 = retarget(cM2, ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1'], join(dM2, 'cli.ts'));
        expect(rM2.status).toBe(0);
        const trM2 = motionOf(cM2.out).animations.dance!.tracks;
        const rotM2 = (bone: string, f: number): number =>
          wrap((trM2.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);
        expect(Math.abs(wrap(rotM2('sleeve_l1', 19) - rotOf('sleeve_l1', 18)))).toBeGreaterThan(30);
      }

      // Mutant 3: syncBridgeClamp omitted in switch.ts and extended-hold forearm alignment omitted in retarget.ts so extended hold on frame 29..31 is not in cClamp/covered.
      {
        const pSw = join(dM3, 'src', 'switch.ts');
        const src = readFileSync(pSw, 'utf8');
        const from = 'if (isTightSet(picked, cn)) cClamp.get(cn)![i] = picked;';
        expect(src.split(from)).toHaveLength(2);
        writeFileSync(pSw, src.replace(from, ''));
        const pRet = join(dM3, 'src', 'retarget.ts');
        const retSrc = readFileSync(pRet, 'utf8');
        const retFrom = 'if (set.anchor === undefined && set.symmetric !== true && set.support === undefined && loShow < s.frames[0]) {';
        expect(retSrc.split(retFrom)).toHaveLength(2);
        writeFileSync(pRet, retSrc.replace(retFrom, 'if (false) {'));
        const cM3 = makeCase();
        const rM3 = retarget(cM3, ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1'], join(dM3, 'cli.ts'));
        expect(rM3.status).toBe(0);
        const trM3 = motionOf(cM3.out).animations.dance!.tracks;
        const rotM3 = (bone: string, f: number): number =>
          wrap((trM3.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);
        const maxJumpM3 = Math.max(
          Math.abs(wrap(rotM3('sleeve_l1', 29) - rotOf('sleeve_l1', 29))),
          Math.abs(wrap(rotM3('sleeve_l1', 30) - rotOf('sleeve_l1', 30))),
        );
        expect(maxJumpM3).toBeGreaterThan(30);
      }
    } finally {
      rmSync(dM1, { recursive: true, force: true });
      rmSync(dM2, { recursive: true, force: true });
      rmSync(dM3, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#207: symmetric gesture set solves the diamond in the chest-local frame so torso lean never collapses an arm into the ±20° clamp', () => {
  const N = 24;
  const DT = 1 / 24;
  const headBones = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -15, y: 10 },
    { name: 'eye_l', parent: 'head', x: 15, y: 10 },
  ];
  const rigOpts: RigOpts = {
    bones: headBones,
    extra: {
      sleeve_r0: { k1_r: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
      sleeve_l0: { k1_l: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
    },
  };

  test('#207 chest-local diamond + mutant: under a 12° torso lean, a "symmetric": true set has 0 clamp saturations at ±20° and keeps non-arm tracks byte-identical, while the world-Y mutant saturates the clamp', () => {
    const mKey: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 145, rf: () => 45, lu: () => 41, lf: () => 135 };
    const kp = positions(mKey, 0);
    // Torso leans up to 12° away from 90° while arms stay raised behind the head.
    const mSeq: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: (i) => 90 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
      hip: () => [0, 0],
      ru: (i) => 145 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
      rf: (i) => 45 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
      lu: (i) => 41 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
      lf: (i) => 135 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
    };
    const pose = poseDoc(mSeq);
    const drawn = { sleeve_r0: 145, sleeve_r1: 45, sleeve_l0: 41, sleeve_l1: 135 };
    const makeMap = (symmetric: boolean): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K1_lean',
          slots: { sleeve_r0: 'k1_r', sleeve_l0: 'k1_l' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp.r_shoulder!,
            r_elbow: kp.r_elbow!,
            r_wrist: kp.r_wrist!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn,
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          ...(symmetric ? { symmetric: true } : {}),
        },
      ],
    });

    const c = setup({ rig: rigOpts, map: makeMap(true), pose });
    const r = retarget(c, ['--raised-by-head', '--bends', 'clamp']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const cBase = setup({ rig: rigOpts, map: makeMap(false), pose });
    const rBase = retarget(cBase, ['--raised-by-head', '--bends', 'clamp']);
    expect(rBase.status).toBe(0);

    // Non-arm tracks are byte-identical.
    const motSym = motionOf(c.out).animations.dance!.tracks;
    const motBase = motionOf(cBase.out).animations.dance!.tracks;
    for (const lb of ['hip', 'chest', 'head', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
      expect(motSym.filter((t) => 'bone' in t && t.bone === lb)).toEqual(motBase.filter((t) => 'bone' in t && t.bone === lb));
    }

    const countSaturations = (buildDir: string): number => {
      const poses = poseRawAnimation(loadBuild(buildDir), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      let sat = 0;
      for (const p of poses) {
        const b = byName(p.bones);
        for (const bone of ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'] as const) {
          const bn = b.get(bone)!;
          // Bone world rotation + aim offset (0° in stickBones since each arm bone points along +x of its own frame).
          const wRot = Math.atan2(bn.c, bn.a) * DEG;
          const turn = Math.abs(wrap(wRot - drawn[bone]));
          if (turn >= 20 - 1e-3) sat++;
        }
      }
      return sat;
    };
    expect(countSaturations(c.build)).toBe(0);

    // Mutant: solving on world shoulder Y (sr[1], sl[1]) without chest-local diamond alignment saturates the ±20° clamp under torso lean.
    mkdirSync(MUTANTS, { recursive: true });
    const dM = mkdtempSync(join(MUTANTS, 'm207-lean-'));
    try {
      cpSync(join(ROOT, 'src'), join(dM, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(dM, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(dM, 'package.json'));
      const pRet = join(dM, 'src', 'retarget.ts');
      const src = readFileSync(pRet, 'utf8');
      const from1 = 'if (Math.abs(wrap(drawnR0 + drawnL0 - 180)) > 1 && (hc0[0] - erDrawnX > lR1 || elDrawnX - hc0[0] > lL1)) {';
      const from2 = 'const eyr = SR0[1] + lR0 * Math.sin((ar + dR0) / DEG);\n        const eyl = SL0[1] + lL0 * Math.sin((al + dL0) / DEG);';
      const from3 = 'const carry = 0.35 * chestTurn;';
      expect(src.split(from1)).toHaveLength(2);
      expect(src.split(from2)).toHaveLength(2);
      expect(src.split(from3)).toHaveLength(2);
      writeFileSync(
        pRet,
        src
          .replace(from1, 'if (false) {')
          .replace(from2, 'const eyr = sr[1] + lR0 * Math.sin((ar + dR0) / DEG);\n        const eyl = sl[1] + lL0 * Math.sin((al + dL0) / DEG);')
          .replace(from3, 'const carry = 0;'),
      );
      const cM = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rM = retarget(cM, ['--raised-by-head', '--bends', 'clamp'], join(dM, 'cli.ts'));
      expect(rM.status).toBe(0);
      expect(countSaturations(cM.build)).toBeGreaterThan(0);
    } finally {
      rmSync(dM, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#218: adjacent gesture-set bridges interpolate across the full gap in joint space, inner-reach wrist steps preserve upper-arm clamp sign, and short stance spans before flight arch-blend hip y', () => {
  const N = 36;
  const DT = 1 / 24;
  const att = { image: 'seg.png', x: 30, y: 0, rotation: -90 };
  const rigOpts: RigOpts = {
    bones: (b) => [
      ...b.map((x) => (x.name === 'sleeve_r1' || x.name === 'sleeve_l1' ? { ...x, rotation: 0 } : x)),
      { name: 'head', parent: 'neck', x: 0, y: 20 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    ],
    extra: {
      sleeve_r0: { k1_r0: att, k2_r0: att, k3_r0: att },
      sleeve_r1: { k1_r1: att, k2_r1: att, k3_r1: att },
      sleeve_l0: { k1_l0: att, k2_l0: att, k3_l0: att },
      sleeve_l1: { k1_l1: att, k2_l1: att, k3_l1: att },
    },
  };

  test('#218 full-gap joint-space bridge + short-stance arch blend + mutants', () => {
    const kp1 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 120, rf: () => 25, lu: () => 60, lf: () => 155 }, 0);
    const kp2 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => -70, rf: () => -30, lu: () => -110, lf: () => -150 }, 0);
    const kp3 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 95, rf: () => 85, lu: () => -85, lf: () => -165 }, 0);

    const mSeq: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      hip: () => [0, 0],
      trunk: () => 90,
      ru: (i) => {
        if (i <= 7) return 120;
        if (i === 8) return 90;
        if (i === 9) return 80;
        if (i === 10) return 50;
        if (i === 11) return -55;
        if (i <= 18) return -70;
        if (i === 19) return -40;
        if (i === 20) return -25;
        if (i === 21) return 45;
        if (i <= 28) return 95;
        if (i === 29) return -20;
        if (i === 30) return -35;
        if (i === 31) return -50;
        return -70;
      },
      rf: (i) => {
        if (i <= 7) return 25;
        if (i === 8) return 35;
        if (i === 9) return 35;
        if (i === 10) return 35;
        if (i === 11) return -20;
        if (i <= 18) return -30;
        if (i === 19) return -20;
        if (i === 20) return 0;
        if (i === 21) return 45;
        if (i <= 28) return 85;
        if (i === 29) return -5;
        if (i === 30) return -10;
        if (i === 31) return -20;
        return -30;
      },
      lu: (i) => {
        if (i <= 7) return 60;
        if (i === 8) return 45;
        if (i === 9) return 40;
        if (i === 10) return 10;
        if (i === 11) return -85;
        if (i <= 18) return -110;
        if (i === 19) return -106;
        if (i === 20) return -102;
        if (i === 21) return -92;
        if (i <= 28) return -85;
        if (i === 29) return -105;
        if (i === 30) return -108;
        return -110;
      },
      lf: (i) => {
        if (i <= 7) return 155;
        if (i === 8) return 145;
        if (i === 9) return 145;
        if (i === 10) return 145;
        if (i === 11) return -135;
        if (i <= 18) return -150;
        if (i === 19) return -152;
        if (i === 20) return -155;
        if (i === 21) return -160;
        if (i <= 28) return -165;
        if (i <= 31) return -110;
        return -150;
      },
    };
    const pose = poseDoc(mSeq);
    const mapDoc: Record<string, unknown> = {
      ...baseMap(),
      chains: [
        ...baseChains().map((c) =>
          c.name === 'arm_r'
            ? { ...c, bend: 'free', range: { sleeve_r0: [-130, 50], sleeve_r1: [-175, 50] } }
            : c.name === 'arm_l'
              ? { ...c, bend: 'free', range: { sleeve_l0: [-50, 130], sleeve_l1: [-50, 175] } }
              : c,
        ),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K1_sym',
          slots: { back_r0: 'k1_r0', back_r1: 'k1_r1', back_l0: 'k1_l0', back_l1: 'k1_l1', topwear: 'top_k1' },
          hides: ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp1.r_shoulder!,
            r_elbow: kp1.r_elbow!,
            r_wrist: kp1.r_wrist!,
            l_shoulder: kp1.l_shoulder!,
            l_elbow: kp1.l_elbow!,
            l_wrist: kp1.l_wrist!,
          },
          drawn: { sleeve_r0: 120, sleeve_r1: 25, sleeve_l0: 60, sleeve_l1: 155 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          symmetric: true,
        },
        {
          name: 'K2_hips',
          slots: { sleeve_r0: 'k2_r0', sleeve_r1: 'k2_r1', sleeve_l0: 'k2_l0', sleeve_l1: 'k2_l1', topwear: 'top_k2' },
          hides: ['back_r0', 'back_r1', 'back_l0', 'back_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp2.r_shoulder!,
            r_elbow: kp2.r_elbow!,
            r_wrist: kp2.r_wrist!,
            l_shoulder: kp2.l_shoulder!,
            l_elbow: kp2.l_elbow!,
            l_wrist: kp2.l_wrist!,
          },
          drawn: { sleeve_r0: -70, sleeve_r1: -30, sleeve_l0: -110, sleeve_l1: -150 },
          turn: { sleeve_r0: [-5, 5], sleeve_r1: [-5, 5], sleeve_l0: [-5, 5], sleeve_l1: [-5, 5] },
        },
        {
          name: 'K3_sup',
          slots: { back_r0: 'k3_r0', back_r1: 'k3_r1', back_l0: 'k3_l0', back_l1: 'k3_l1', topwear: 'top_k3' },
          hides: ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp3.r_shoulder!,
            r_elbow: kp3.r_elbow!,
            r_wrist: kp3.r_wrist!,
            l_shoulder: kp3.l_shoulder!,
            l_elbow: kp3.l_elbow!,
            l_wrist: kp3.l_wrist!,
          },
          drawn: { sleeve_r0: 95, sleeve_r1: 85, sleeve_l0: -85, sleeve_l1: -165 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-15, 15], sleeve_l1: [-15, 15] },
          support: 'arm_l',
        },
      ],
    };

    const makeCase = () => {
      const cs = setup({ rig: rigOpts, map: mapDoc, pose });
      const rigJsonPath = join(cs.rig, 'rig.json');
      const rigSpec = JSON.parse(readFileSync(rigJsonPath, 'utf8')) as {
        slots: Array<Record<string, unknown>>;
        skins: { default: Record<string, Record<string, unknown>> };
      };
      rigSpec.slots = [
        { name: 'back_r0', bone: 'sleeve_r0', attachment: null },
        { name: 'back_r1', bone: 'sleeve_r1', attachment: null },
        { name: 'back_l0', bone: 'sleeve_l0', attachment: null },
        { name: 'back_l1', bone: 'sleeve_l1', attachment: null },
        { name: 'topwear', bone: 'chest', attachment: 'seg' },
        ...rigSpec.slots,
      ];
      rigSpec.skins.default.back_r0 = { k1_r0: att, k3_r0: att };
      rigSpec.skins.default.back_r1 = { k1_r1: att, k3_r1: att };
      rigSpec.skins.default.back_l0 = { k1_l0: att, k3_l0: att };
      rigSpec.skins.default.back_l1 = { k1_l1: att, k3_l1: att };
      rigSpec.skins.default.topwear = { seg: att, top_k1: att, top_k2: att, top_k3: att };
      writeFileSync(rigJsonPath, JSON.stringify(rigSpec, null, 2));
      return cs;
    };

    const c = makeCase();
    const r = retarget(c, ['--raised-by-head', '--bends', 'clamp', '--short', '0.35', '--switch-min', '0.1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const tr = motionOf(c.out).animations.dance!.tracks;
    const rotOf = (bone: string, f: number): number =>
      wrap((tr.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);

    // Across the K3 [22..28] -> K2 [32..35] bridge (frames 28..32), sleeve_l1 interpolates linearly in joint space (interior |Δ²| ≈ 0 on 29..31, max step <= 9°).
    const maxBridgeD2 = (fn: (b: string, f: number) => number): number => {
      let mx = 0;
      for (let i = 29; i <= 31; i++) {
        const dPrev = wrap(fn('sleeve_l1', i) - fn('sleeve_l1', i - 1));
        const dNext = wrap(fn('sleeve_l1', i + 1) - fn('sleeve_l1', i));
        mx = Math.max(mx, Math.abs(dNext - dPrev));
      }
      return mx;
    };
    expect(maxBridgeD2(rotOf)).toBeLessThan(1e-2);
    expect(Math.abs(wrap(rotOf('sleeve_l1', 29) - rotOf('sleeve_l1', 28)))).toBeLessThanOrEqual(10);

    // Part 2: short stance span (frames 10..12) between two flights (4..9 and 13..18) arch-blends hip y so peak stance upward acceleration is lower than linear stepIn/(PLANT_BLEND+1).
    const THIGH_RUN = -95;
    const SHIN_RUN = -97;
    const STILL_RUN: Motion = { ...BASE, n: 24, dt: 1 / 24, rt: () => THIGH_RUN, rs: () => SHIN_RUN, lt: () => THIGH_RUN, ls: () => SHIN_RUN, hip: () => [0, 0] };
    const V_RUN = add(dir(THIGH_RUN, 80), dir(SHIN_RUN, 70));
    const fRun = (i: number): number => {
      if (i === 2 || i === 12 || i === 22) return 0.92;
      if (i === 3 || i === 13) return 0.84;
      return 1;
    };
    const riseRun = (i: number): number => {
      if (i === 2 || i === 12 || i === 22) return 0.08 * V_RUN[1] - 5;
      if (i === 3 || i === 13) return 0.16 * V_RUN[1] - 2;
      if ((i >= 4 && i <= 9) || (i >= 14 && i <= 19)) return 25;
      return 0;
    };
    const liftRun = (i: number): number => (i === 2 || i === 12 || i === 22 ? -(0.08 * V_RUN[1] - 5) : 0);
    const docRun = {
      ...poseDoc(STILL_RUN, (i, j) => {
        const drop: Pt = [(1 - fRun(i)) * V_RUN[0], (1 - fRun(i)) * V_RUN[1] - riseRun(i)];
        for (const [name, at] of Object.entries(j)) {
          const a = at.at as Pt;
          if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
          j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
        }
        for (const s of ['r', 'l'] as const) {
          const hip = j[`${s}_hip`]!.at as Pt;
          const knee = add(hip, dir(THIGH_RUN, 80 * fRun(i)));
          const ankle = add(knee, dir(SHIN_RUN, 70 * fRun(i)));
          j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
          j[`${s}_ankle`] = { state: 'observed', at: [ankle[0], ankle[1] - liftRun(i)], score: 0.9 };
        }
      }),
      travel: 'in-place',
    };
    const cRun = setup({ pose: docRun });
    const rRun = retarget(cRun, ['--leg-scale', '0.8,1.05', '--plant-feet']);
    expect(rRun.status).toBe(0);
    const hipYOf = (outPath: string): number[] =>
      (motionOf(outPath).animations.dance!.tracks.find((t) => 'bone' in t && t.bone === 'hip' && t.property === 'translate')!.keys as Array<{ v: number[] }>).map(
        (k) => k.v[1]!,
      );
    const hyOurs = hipYOf(cRun.out);
    const accOurs = hyOurs[10]! - 2 * hyOurs[11]! + hyOurs[12]!;

    mkdirSync(MUTANTS, { recursive: true });
    const dM1 = mkdtempSync(join(MUTANTS, 'm218-bridge-'));
    const dM2 = mkdtempSync(join(MUTANTS, 'm218-stance-'));
    try {
      for (const d of [dM1, dM2]) {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      }
      // Mutant 1: disabling full-gap joint-space bridge interpolation produces a > 10° |Δ²| kink on frames 29..31 and raises frame 29's step past 13.5°.
      const pRet = join(dM1, 'src', 'retarget.ts');
      const srcRet = readFileSync(pRet, 'utf8');
      const fromRet = 'if (i0 >= 0 && prevSw!.chains.includes(cn) && s.frames[0] - i0 >= 2 && chainShownInBridge) {';
      expect(srcRet.split(fromRet)).toHaveLength(2);
      writeFileSync(pRet, srcRet.replace(fromRet, 'if (false) {'));
      const cM1 = makeCase();
      const rM1 = retarget(cM1, ['--raised-by-head', '--bends', 'clamp', '--short', '0.35', '--switch-min', '0.1'], join(dM1, 'cli.ts'));
      expect(rM1.status).toBe(0);
      const trM1 = motionOf(cM1.out).animations.dance!.tracks;
      const rotM1 = (bone: string, f: number): number =>
        wrap((trM1.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);
      expect(maxBridgeD2(rotM1)).toBeGreaterThan(10);
      expect(Math.abs(wrap(rotM1('sleeve_l1', 29) - rotM1('sleeve_l1', 28)))).toBeGreaterThan(13.5);

      // Mutant 2: disabling short-stance arch blend raises stance upward hip acceleration on 10..12 by 0.5 * (planted - travel) = 1.24u.
      const pLegs = join(dM2, 'src', 'legs.ts');
      const srcLegs = readFileSync(pLegs, 'utf8');
      const fromLegs = 'const w = (blendToFlight && blendEnd - blendAt < PLANT_BLEND ? Math.min(stepIn, blendEnd - i + 1) : stepIn) / (PLANT_BLEND + 1);';
      expect(srcLegs.split(fromLegs)).toHaveLength(2);
      writeFileSync(pLegs, srcLegs.replace(fromLegs, 'const w = stepIn / (PLANT_BLEND + 1);'));
      const cM2 = setup({ pose: docRun });
      const rM2 = retarget(cM2, ['--leg-scale', '0.8,1.05', '--plant-feet'], join(dM2, 'cli.ts'));
      expect(rM2.status).toBe(0);
      const hyM2 = hipYOf(cM2.out);
      const accM2 = hyM2[10]! - 2 * hyM2[11]! + hyM2[12]!;
      expect(accM2 - accOurs).toBeCloseTo(1.24, 1);
    } finally {
      rmSync(dM1, { recursive: true, force: true });
      rmSync(dM2, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#225: per-leg setup-weighted straight length and clamped asked values in report', () => {
  const N = 24;
  const DT = 1 / 24;

  function makeAsymmetricLegCase() {
    const motion: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: () => 90,
      rt: () => -90,
      rs: () => -90,
      lt: () => -90,
      ls: () => -90,
      hip: () => [0, 0],
    };
    const pose = poseDoc(motion, (i, j) => {
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      if (i < 6) {
        // Left leg starts lower (150 px vs right 146 px) so left leg supports continuously from frame 0.
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150], score: 0.9 };
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 78], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 146], score: 0.9 };
      } else if (i < 18) {
        // Both legs straight at 80 + 70 = 150 px for 12/24 frames -> P95 straight is 80 / 70 px on both sides.
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150], score: 0.9 };
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150], score: 0.9 };
      } else {
        // On frames 18..23, left leg supports at 76.0 + 67.2 = 143.2 px while right leg lifts by 9.4 px (133.8 px: thigh 78.8 px, shin 55.0 px).
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 76.0], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 143.2], score: 0.9 };
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 78.8], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 133.8], score: 0.9 };
      }
    });
    // Setup rig has asymmetric legs: left leg 81.2 + 70.5 = 151.7 u (+2.29% longer than right leg 78.8 + 69.5 = 148.3 u).
    return setup({
      rig: {
        bones: (bs) =>
          bs.map((b) => {
            if (b.name === 'leg_r0') return { ...b, rotation: -90, length: 78.8 };
            if (b.name === 'leg_r1') return { ...b, x: 78.8, rotation: 0, length: 69.5 };
            if (b.name === 'leg_l0') return { ...b, rotation: -90, length: 81.2 };
            if (b.name === 'leg_l1') return { ...b, x: 81.2, rotation: 0, length: 70.5 };
            return b;
          }),
      },
      map: {
        ...baseMap(),
        chains: baseChains().map((ch) => (ch.name === 'leg_r' ? { ...ch, bend: 'free' } : ch)),
      },
      pose,
    });
  }

  function liftRatioOnSpan(buildDir: string): number {
    const doc = loadBuild(buildDir);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const ratios: number[] = [];
    const seqLift = 9.4; // 143.2 - 133.8 px (rig mean leg 150u / sequence straight leg 150px = 1.0 u/px)
    for (let i = 18; i < N; i++) {
      const b = byName(poses[i]!.bones);
      const rShin = b.get('leg_r1')!;
      const lShin = b.get('leg_l1')!;
      const rAnkleY = rShin.worldY + rShin.c * 69.5;
      const lAnkleY = lShin.worldY + lShin.c * 70.5;
      ratios.push((rAnkleY - lAnkleY) / seqLift);
    }
    ratios.sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length / 2)]!;
  }

  test('weights reference straight length by each leg segment\'s setup bone share and records clamped asked values in LEG-SCALE and report.json', () => {
    const c = makeAsymmetricLegCase();
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.04', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const legLines = linesOf(r, 'LEG-SCALE');
    expect(legLines[0]).toContain('chain "leg_r" bone "leg_r0" (r_hip → r_knee): straight length 78.8px');
    expect(legLines[1]).toContain('chain "leg_r" bone "leg_r1" (r_knee → r_ankle): straight length 69.5px');
    expect(legLines[1]).toContain('6 frame(s) under 0.8, clamped (frames 18–23) (asked 0.791)');
    expect(legLines[2]).toContain('chain "leg_l" bone "leg_l0" (l_hip → l_knee): straight length 81.2px');
    expect(legLines[3]).toContain('chain "leg_l" bone "leg_l1" (l_knee → l_ankle): straight length 70.5px');

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      legScale: Array<{
        bone: string;
        straight: number;
        clamped: Array<{ frames: [number, number]; times: [number, number]; limit: 'low' | 'high'; asked: { min: number; max: number } }>;
      }>;
    };
    const r0 = rep.legScale.find((s) => s.bone === 'leg_r0')!;
    const r1 = rep.legScale.find((s) => s.bone === 'leg_r1')!;
    const l0 = rep.legScale.find((s) => s.bone === 'leg_l0')!;
    const l1 = rep.legScale.find((s) => s.bone === 'leg_l1')!;
    expect(r0.straight).toBeCloseTo(78.8, 3);
    expect(r1.straight).toBeCloseTo(69.5, 3);
    expect(l0.straight).toBeCloseTo(81.2, 3);
    expect(l1.straight).toBeCloseTo(70.5, 3);
    expect(r1.clamped).toHaveLength(1);
    expect(r1.clamped[0]!.frames).toEqual([18, 23]);
    expect(r1.clamped[0]!.limit).toBe('low');
    expect(r1.clamped[0]!.times[0]).toBeCloseTo(18 * DT, 5);
    expect(r1.clamped[0]!.times[1]).toBeCloseTo(23 * DT, 5);
    expect(r1.clamped[0]!.asked.min).toBeCloseTo(55.0 / 69.5, 6);
    expect(r1.clamped[0]!.asked.max).toBeCloseTo(55.0 / 69.5, 6);

    const ratio = liftRatioOnSpan(c.build);
    expect(ratio).toBeCloseTo(8.8 / 9.4, 3);
    expect(ratio).toBeGreaterThanOrEqual(0.85);
    expect(ratio).toBeLessThanOrEqual(1.15);

    // Mutant (Bar 3): pooling the straight reference length across both legs without setup-bone weighting pushes the lifted foot ratio past 1.15.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm225-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const pRet = join(d, 'src', 'retarget.ts');
      const srcRet = readFileSync(pRet, 'utf8');
      const fromRet = 'const ls = legScaleOf(seg.lengths, limits, straightByKind.get(seg.kind)! * rigShareOf(seg));';
      expect(srcRet.split(fromRet)).toHaveLength(2);
      writeFileSync(pRet, srcRet.replace(fromRet, 'const ls = legScaleOf(seg.lengths, limits, straightByKind.get(seg.kind)!);'));

      const cMut = makeAsymmetricLegCase();
      const rMut = retarget(cMut, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.04'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const ratioMut = liftRatioOnSpan(cMut.build);
      expect(ratioMut).toBeGreaterThan(1.15);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});


