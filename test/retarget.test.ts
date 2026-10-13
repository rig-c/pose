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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poseRawAnimation, poseRawSetup, readModel, type CompiledDocument, type RawBone } from 'rig-c/core';
import { Plate } from 'rig-c/plate';

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
  if (o.missingImage === true) {
    slots.push({ name: 'ghost', bone: 'chest', attachment: 'ghost' });
    skin.ghost = { ghost: { image: 'ghost.png' } };
  }
  writeFileSync(join(rigDir, 'rig.json'), JSON.stringify({ spec: 'rigc-rig/1', name: 'stick', images: 'images', skeleton: { width: 400, height: 600 }, bones, slots, skins: { default: skin } }, null, 2));
  if (o.motion !== undefined) writeFileSync(join(rigDir, 'motion.json'), JSON.stringify(o.motion, null, 2));
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
  writeFileSync(pose, JSON.stringify(o.pose ?? poseDoc(BASE), null, 2));
  return { dir, rig, map, pose, out: join(dir, 'motion.out.json'), build: join(dir, 'build') };
}
function retarget(c: Case, extra: string[] = [], cliPath = CLI): Ran {
  return cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', c.pose, '--out', c.out, '--build', c.build, ...extra], cliPath);
}
const fails = (r: Ran): string[] => r.stderr.split('\n').filter((l) => l.startsWith('FAIL  '));
const linesOf = (r: Ran, tag: string): string[] => r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${tag} `));

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

describe('readers', () => {
  test('pose: every problem named in one run', () => {
    const pose = poseDoc(BASE, (i, j) => {
      if (i === 2) j.r_toe = { state: 'observed', at: [1, 1] };
      if (i === 3) j.nose = { state: 'observed', score: 0.9 };
    });
    pose.camera = 'front';
    pose.space = { units: 'picture-px', origin: 'top-left', y: 'up' };
    (pose.frames as Array<{ t: number }>)[5]!.t = (pose.frames as Array<{ t: number }>)[4]!.t;
    const c = setup({ pose });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const f = fails(r);
    const p = c.pose;
    expect(f).toContain(`FAIL  POSE_KEYS: ${p} has a key this reader does not know: "camera"; the keys it reads are spec, space, width, height, source, frames`);
    expect(f).toContain(`FAIL  POSE_SPACE: ${p} "space" is {"units":"picture-px","origin":"top-left","y":"up"}; it must be exactly {"units":"picture-px","origin":"top-left","y":"down"}`);
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

  test('retarget --coco lands the known pose; a null frame holds every point', () => {
    const c = setup();
    writeFileSync(c.pose, JSON.stringify(cocoDoc(BASE, (i, t) => (i === 9 ? null : t))));
    const r = retarget(c, ['--coco']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const holds = linesOf(r, 'HOLD');
    expect(holds).toContain('HOLD   point "r_wrist" frame 9 (t=1.125s): missing; held frame 8\'s value');
    expect(holds).toContain('HOLD   point "neck" frame 9 (t=1.125s): missing; held frame 8\'s value');
    // Every frame but the held one is the known pose.
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
  test('an even --smooth is exit 2, naming the value', () => {
    const c = setup();
    const r = retarget(c, ['--smooth', '4']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--smooth is "4"; it must be an odd whole number ≥ 1');
    expect(existsSync(c.out)).toBe(false);
  });
  test('control: an odd --smooth over a still pose is accepted', () => {
    const c = setup({ pose: poseDoc({ ...BASE, n: 4, trunk: () => 90, ru: () => 150, rf: () => 170, hip: () => [0, 0] }) });
    const r = retarget(c, ['--smooth', '3']);
    expect(r.status).toBe(0);
  }, SLOW);
});
