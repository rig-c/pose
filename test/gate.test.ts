/**
 * #208: Two-reference regression gate and standing continuity assertions.
 * #375 adds the generated grounded run shared with #369, with support-foot
 * height held to generator truth, never to the report's selected supports.
 *
 * Every PR retargets both synthetic public reference scans (`dancer` — multi-set
 * gesture switching, symmetric hands-behind-head diamond, hands-on-hips short runs,
 * support-arm raised-arm entry, and beat-nod head excursion; `second` —
 * single-sheet continuous dance with large 2D head-to-neck nod excursions and
 * face pitch dial) and checks:
 *
 * 1. Standing continuity assertions on both references:
 *    - `GATE_DELTA_CEILING`: per-frame `|Δ|` of every `rotate` track <= declared ceiling,
 *      printing the maximum and its bone + frame.
 *    - `GATE_BRIDGE_ELBOW_INVERT`: elbow local angle (`sleeve_r1.rotate`, `sleeve_l1.rotate`) never
 *      crosses `±180°` (or exceeds `146°` local bend) inside a gesture-set bridge.
 *    - `GATE_SWITCH_DELTA`: no attachment switch frame with `|Δ|` on its chain's rotate tracks
 *      above its `±3` window ceiling.
 *    - `GATE_CLAMP_SATURATION`: clamp saturations at `±20°` on symmetric gesture sets counted and
 *      printed (`0` required).
 *    - `GATE_REFERENCE_FOLDS` (#231): `folds = 0` across all mesh attachments on every posed frame;
 *      a reference with no mesh attachments reports `SKIP` (never counted as a pass).
 * 2. Two-reference regression diff against the base output:
 *    - Every track that moved must be claimed by a `Claim-Track: <ref> <track> <frames> #<issue>`
 *      line in the PR body (`GATE_PR_BODY`) or commit messages; any unclaimed track or frame is
 *      refused as `GATE_UNCLAIMED_TRACK`.
 *    - Unclaimed tracks must be byte-identical.
 * 3. Mutants for every assertion:
 *    - Reintroducing #205's unbounded nod residual (`headNodReading.residual`) goes red by name on
 *      BOTH references (`dancer` and `second`).
 *    - Reintroducing #206's world-space bridge interpolation goes red by name
 *      (`GATE_BRIDGE_ELBOW_INVERT` and `GATE_UNCLAIMED_TRACK`).
 *    - Planted mutants for `GATE_DELTA_CEILING`, `GATE_SWITCH_DELTA`, `GATE_CLAMP_SATURATION`, and
 *      `GATE_REFERENCE_FOLDS` each go red by name.
 *    - A PR change that claims its moved track is green; the same change with the claim removed
 *      is red (`GATE_UNCLAIMED_TRACK`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { poseRawAnimation, poseRawSetup, readModel, type CompiledDocument, type RawBone } from '@rig-c/core/core';
import { Plate } from '@rig-c/core/plate';
import { clean } from '../src/clean.ts';
import { assertReportSurfaces } from './surface.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { pointAt } from '../src/map.ts';
import { poseFrames } from '../src/verify.ts';
import { RUN_FLOOR } from '../examples/walk/make-depth.ts';
import { FPS, run as groundedRun, sequence as groundedSequence } from './flight-fixture.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const SLOW = 60_000;
const POSE_TRUNK = 100;
const SCALE = 150 / POSE_TRUNK;

type Pt = [number, number];

const wrap = (d: number): number => {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
};

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-gate-'));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface BoneSpec {
  name: string;
  parent?: string;
  x?: number;
  y?: number;
  rotation?: number;
  length?: number;
}

function stickBones(headY = 20): BoneSpec[] {
  return [
    { name: 'root' },
    { name: 'hip', parent: 'root', x: 0, y: 300 },
    { name: 'chest', parent: 'hip', x: 0, y: 75, rotation: 0 },
    { name: 'neck', parent: 'chest', x: 0, y: 75 },
    { name: 'sleeve_r0', parent: 'chest', x: -30, y: 65, rotation: -100, length: 70 },
    { name: 'sleeve_r1', parent: 'sleeve_r0', x: 70, y: 0, rotation: 0, length: 60 },
    { name: 'sleeve_l0', parent: 'chest', x: 30, y: 65, rotation: -80, length: 70 },
    { name: 'sleeve_l1', parent: 'sleeve_l0', x: 70, y: 0, rotation: 0, length: 60 },
    { name: 'leg_r0', parent: 'hip', x: -15, y: 0, rotation: -95, length: 80 },
    { name: 'leg_r1', parent: 'leg_r0', x: 80, y: 0, rotation: -10, length: 70 },
    { name: 'leg_l0', parent: 'hip', x: 15, y: 0, rotation: -85, length: 80 },
    { name: 'leg_l1', parent: 'leg_l0', x: 80, y: 0, rotation: 0, length: 70 },
    { name: 'head', parent: 'neck', x: 0, y: headY },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    { name: 'pitch_dial', parent: 'head', x: 0, y: 0 },
  ];
}

const LIMBS = ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1'];

interface ChainSpec {
  name: string;
  bones: string[];
  joints: string[];
  aim?: string[];
  bend?: string;
  range?: Record<string, [number, number]>;
}

function baseChains(): ChainSpec[] {
  return [
    { name: 'trunk', bones: ['chest'], joints: ['mid_hip', 'neck'], aim: ['neck'] },
    {
      name: 'arm_r',
      bones: ['sleeve_r0', 'sleeve_r1'],
      joints: ['r_shoulder', 'r_elbow', 'r_wrist'],
      bend: 'free',
      range: { sleeve_r0: [-130, 50], sleeve_r1: [-175, 50] },
    },
    {
      name: 'arm_l',
      bones: ['sleeve_l0', 'sleeve_l1'],
      joints: ['l_shoulder', 'l_elbow', 'l_wrist'],
      bend: 'free',
      range: { sleeve_l0: [-50, 130], sleeve_l1: [-50, 175] },
    },
    { name: 'leg_r', bones: ['leg_r0', 'leg_r1'], joints: ['r_hip', 'r_knee', 'r_ankle'] },
    { name: 'leg_l', bones: ['leg_l0', 'leg_l1'], joints: ['l_hip', 'l_knee', 'l_ankle'], bend: 'free' },
    { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
  ];
}

function baseMap(): Record<string, unknown> {
  return {
    spec: 'rig-pose-map/1',
    chains: baseChains(),
    translate: { bone: 'hip', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['hip', 'neck'] } },
    face: {
      pitch: { bone: 'pitch_dial', range: [-25, 25] },
    },
  };
}

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

const dir = (deg: number, len: number): Pt => [len * Math.cos(deg * RAD), -len * Math.sin(deg * RAD)];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];

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

function poseDoc(m: Motion, edit?: (i: number, joints: JointsDoc) => void): string {
  const frames = Array.from({ length: m.n }, (_, i) => {
    const joints: JointsDoc = {};
    for (const [name, at] of Object.entries(positions(m, i))) joints[name] = { state: 'observed', at, score: 0.95 };
    edit?.(i, joints);
    return { t: i * m.dt, people: [{ id: 'a', joints }] };
  });
  const doc = {
    spec: 'rig-pose-sequence/1',
    space: { units: 'picture-px', origin: 'top-left', y: 'down' },
    width: 400,
    height: 600,
    source: 'synthetic, test/gate.test.ts',
    frames,
  };
  const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
  const c = clean(seq, { loop: false, legs: 1, rest: 1 }, undefined, 'fixture');
  return writePoseSequence(c.seq);
}

interface RefCase {
  name: 'dancer' | 'second' | 'run';
  dir: string;
  rigDir: string;
  posePath: string;
  mapPath: string;
  outPath: string;
  buildDir: string;
  reportPath: string;
  args: string[];
  n: number;
  dt: number;
}

/**
 * Reference 1 (`dancer`): 36-frame multi-set gesture reference with:
 * - `K1_sym` (`symmetric: true`, frames 0..7),
 * - `K1 -> K2` bridge (frames 8..11) and `K2_hips` (frames 12..18),
 * - `K2 -> K3` entry bridge with `loShow` delay (frames 19..21) and `K3_sup` (`support: 'arm_l'`, frames 22..28),
 * - Extended hold gap (frames 29..31) back to `K2_hips` (frames 32..35),
 * - Head nod vertical excursions on frames 13..17 (clamped at ±2% of neck length) + `face.pitch` dial.
 */
function setupDancerRef(rootDir: string): RefCase {
  const dir = join(rootDir, 'dancer');
  const rigDir = join(dir, 'rig');
  mkdirSync(join(rigDir, 'images'), { recursive: true });
  const plate = new Plate(20, 60);
  plate.rect(0, 0, 20, 60, [200, 80, 80, 255]);
  plate.writePng(join(rigDir, 'images', 'seg.png'));

  const N = 36;
  const DT = 1 / 24;
  const att = { image: 'seg.png', x: 30, y: 0, rotation: -90 };
  const slots: Array<Record<string, unknown>> = [
    { name: 'back_r0', bone: 'sleeve_r0', attachment: null },
    { name: 'back_r1', bone: 'sleeve_r1', attachment: null },
    { name: 'back_l0', bone: 'sleeve_l0', attachment: null },
    { name: 'back_l1', bone: 'sleeve_l1', attachment: null },
    { name: 'topwear', bone: 'chest', attachment: 'seg' },
    { name: 'skirt', bone: 'hip', attachment: 'skirt' },
    ...LIMBS.map((b) => ({ name: b, bone: b, attachment: 'seg' })),
  ];
  const skin: Record<string, Record<string, unknown>> = Object.fromEntries(
    LIMBS.map((b) => [b, { seg: { image: 'seg.png', x: 30, y: 0, rotation: 90 } }]),
  );
  skin.back_r0 = { k1_r0: att, k3_r0: att };
  skin.back_r1 = { k1_r1: att, k3_r1: att };
  skin.back_l0 = { k1_l0: att, k3_l0: att };
  skin.back_l1 = { k1_l1: att, k3_l1: att };
  skin.topwear = { seg: att, top_k1: att, top_k2: att, top_k3: att };
  skin.skirt = {
    skirt: {
      type: 'mesh',
      image: 'seg.png',
      uvs: [0, 0, 0, 1, 1, 1, 1, 0],
      triangles: [0, 1, 3, 1, 2, 3],
      weights: [
        [{ bone: 'hip', x: -15, y: 0, weight: 1 }],
        [{ bone: 'leg_r0', x: 40, y: 0, weight: 1 }],
        [{ bone: 'leg_l0', x: 40, y: 0, weight: 1 }],
        [{ bone: 'hip', x: 15, y: 0, weight: 1 }],
      ],
    },
  };
  skin.sleeve_r0 = { ...skin.sleeve_r0, k1_r0: att, k2_r0: att, k3_r0: att };
  skin.sleeve_r1 = { ...skin.sleeve_r1, k1_r1: att, k2_r1: att, k3_r1: att };
  skin.sleeve_l0 = { ...skin.sleeve_l0, k1_l0: att, k2_l0: att, k3_l0: att };
  skin.sleeve_l1 = { ...skin.sleeve_l1, k1_l1: att, k2_l1: att, k3_l1: att };

  writeFileSync(
    join(rigDir, 'rig.json'),
    JSON.stringify(
      {
        spec: 'rigc-rig/1',
        name: 'dancer_ref',
        images: 'images',
        skeleton: { width: 400, height: 600 },
        bones: stickBones(42),
        slots,
        skins: { default: skin },
      },
      null,
      2,
    ),
  );

  const baseM: Motion = {
    n: N,
    dt: DT,
    hip: () => [0, 0],
    trunk: () => 90,
    ru: () => 116,
    rf: () => 25,
    lu: () => 62,
    lf: () => 155,
    rt: () => -90,
    rs: () => -90,
    lt: () => -90,
    ls: () => -90,
  };
  const kp1 = positions({ ...baseM, n: 1, ru: () => 116, rf: () => 25, lu: () => 62, lf: () => 155 }, 0);
  const kp2 = positions({ ...baseM, n: 1, ru: () => -70, rf: () => -30, lu: () => -110, lf: () => -150 }, 0);
  const kp3 = positions({ ...baseM, n: 1, ru: () => 95, rf: () => 85, lu: () => -85, lf: () => -145 }, 0);

  const mSeq: Motion = {
    ...baseM,
    ru: (i) => {
      if (i <= 7) return 116;
      if (i === 8) return 90;
      if (i === 9) return 80;
      if (i === 10) return 50;
      if (i === 11) return -25;
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
      if (i === 11) return 10;
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
      if (i <= 7) return 62;
      if (i === 8) return 45;
      if (i === 9) return 40;
      if (i === 10) return 10;
      if (i === 11) return -55;
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
      if (i === 11) return -95;
      if (i <= 18) return -150;
      if (i === 19) return -149;
      if (i === 20) return -148;
      if (i === 21) return -146;
      if (i <= 28) return -145;
      if (i <= 31) return -135;
      return -150;
    },
  };

  const poseText = poseDoc(mSeq, (i, j) => {
    const nod = i >= 12 && i <= 18 ? 8.0 * Math.sin(((i - 12) / 6) * 2 * Math.PI) : 0;
    if (nod === 0) return;
    const dyPic = -nod / SCALE;
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

  const mapDoc: Record<string, unknown> = {
    ...baseMap(),
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
        drawn: { sleeve_r0: 116, sleeve_r1: 25, sleeve_l0: 62, sleeve_l1: 155 },
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
        drawn: { sleeve_r0: 95, sleeve_r1: 85, sleeve_l0: -85, sleeve_l1: -145 },
        turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-15, 15], sleeve_l1: [-15, 15] },
        support: 'arm_l',
      },
    ],
  };

  const posePath = join(dir, 'pose.json');
  const mapPath = join(dir, 'map.json');
  const outPath = join(dir, 'motion.json');
  const buildDir = join(dir, 'build');
  const reportPath = join(dir, 'report.json');
  writeFileSync(posePath, poseText);
  writeFileSync(mapPath, JSON.stringify(mapDoc, null, 2));

  return {
    name: 'dancer',
    dir,
    rigDir,
    posePath,
    mapPath,
    outPath,
    buildDir,
    reportPath,
    args: ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1'],
    n: N,
    dt: DT,
  };
}

/**
 * Reference 2 (`second`): 32-frame single-sheet continuous reference with large
 * 2D head-to-neck vertical excursions (clamped at ±2% of neck length, leaving a
 * ±11u residual on `head.translate.y`), continuous arm waves, and a `face.pitch`
 * dial. Exercises #205 on a second, non-switching rig.
 */
function setupSecondRef(rootDir: string): RefCase {
  const dir = join(rootDir, 'second');
  const rigDir = join(dir, 'rig');
  mkdirSync(join(rigDir, 'images'), { recursive: true });
  const plate = new Plate(20, 60);
  plate.rect(0, 0, 20, 60, [80, 160, 200, 255]);
  plate.writePng(join(rigDir, 'images', 'seg.png'));

  const N = 32;
  const DT = 1 / 24;
  const slots: Array<Record<string, unknown>> = LIMBS.map((b) => ({ name: b, bone: b, attachment: 'seg' }));
  const skin: Record<string, Record<string, unknown>> = Object.fromEntries(
    LIMBS.map((b) => [b, { seg: { image: 'seg.png', x: 30, y: 0, rotation: 90 } }]),
  );

  writeFileSync(
    join(rigDir, 'rig.json'),
    JSON.stringify(
      {
        spec: 'rigc-rig/1',
        name: 'second_ref',
        images: 'images',
        skeleton: { width: 400, height: 600 },
        bones: stickBones(50),
        slots,
        skins: { default: skin },
      },
      null,
      2,
    ),
  );

  const mSeq: Motion = {
    n: N,
    dt: DT,
    hip: (i) => [2 * Math.sin((2 * Math.PI * i) / (N - 1)), 0],
    trunk: (i) => 90 + 4 * Math.sin((2 * Math.PI * i) / (N - 1)),
    ru: (i) => -95 + 10 * Math.sin((2 * Math.PI * i) / (N - 1)),
    rf: (i) => -75 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
    lu: (i) => -85 - 10 * Math.sin((2 * Math.PI * i) / (N - 1)),
    lf: (i) => -105 - 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
    rt: () => -90,
    rs: () => -90,
    lt: () => -90,
    ls: () => -90,
  };

  const poseText = poseDoc(mSeq, (i, j) => {
    j.r_ankle = { state: 'observed', at: [-20, 350], score: 0.95 };
    j.l_ankle = { state: 'observed', at: [20, 320], score: 0.95 };
    const nod = i < 6 ? 0 : 12.0 * Math.sin(((2 * i) / N) * 2 * Math.PI);
    const dyPic = -nod / SCALE;
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

  const posePath = join(dir, 'pose.json');
  const mapPath = join(dir, 'map.json');
  const outPath = join(dir, 'motion.json');
  const buildDir = join(dir, 'build');
  const reportPath = join(dir, 'report.json');
  writeFileSync(posePath, poseText);
  writeFileSync(mapPath, JSON.stringify(baseMap(), null, 2));

  return {
    name: 'second',
    dir,
    rigDir,
    posePath,
    mapPath,
    outPath,
    buildDir,
    reportPath,
    args: ['--bends', 'clamp', '--short', '0.35'],
    n: N,
    dt: DT,
  };
}

/** #375: reuse #369's generated floor-carried run, not an exam solve. */
function setupRunRef(rootDir: string): RefCase {
  const dir = join(rootDir, 'run');
  mkdirSync(dir, { recursive: true });
  const posePath = join(dir, 'pose.json');
  writeFileSync(posePath, groundedSequence());
  return {
    name: 'run', dir,
    rigDir: join(ROOT, 'examples', 'wave', 'rig'),
    mapPath: join(ROOT, 'examples', 'walk', 'map.json'),
    posePath, outPath: join(dir, 'motion.json'), buildDir: join(dir, 'build'),
    reportPath: join(dir, 'report.json'),
    // The frontal arm foreshortening needs the existing flip guard to satisfy
    // the standing 45°/frame continuity ceiling; no ceiling is relaxed.
    args: ['--plant-feet', '--stance', '0.07', '--leg-scale', '0.5,1.05', '--floor', '0', '--flip', '45'],
    n: groundedRun().length, dt: 1 / FPS,
  };
}

interface TrackSpec {
  bone?: string;
  slot?: string;
  property: string;
  keys: Array<{ t: number; v: unknown; curve?: unknown }>;
}

interface RefRunOutput {
  ref: RefCase;
  tracks: TrackSpec[];
  report: Record<string, unknown>;
  buildDoc: CompiledDocument;
}

function runReference(ref: RefCase, cliPath = CLI): RefRunOutput {
  const res = spawnSync(
    'bun',
    [
      cliPath,
      'retarget',
      '--rig',
      ref.rigDir,
      '--pose',
      ref.posePath,
      '--map',
      ref.mapPath,
      '--name',
      'dance',
      '--out',
      ref.outPath,
      '--build',
      ref.buildDir,
      '--report',
      ref.reportPath,
      ...ref.args,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`retarget failed on ${ref.name} (exit ${res.status}):\n${res.stderr}`);
  }
  const motion = JSON.parse(readFileSync(ref.outPath, 'utf8')) as {
    animations: Record<string, { tracks: TrackSpec[] }>;
  };
  const report = JSON.parse(readFileSync(ref.reportPath, 'utf8')) as Record<string, unknown>;
  const buildDoc = readModel(readFileSync(join(ref.buildDir, 'skeleton.model.json'), 'utf8'));
  return {
    ref,
    tracks: motion.animations.dance!.tracks,
    report,
    buildDoc,
  };
}

interface SupportHeightVerdict {
  grounded: number;
  airborne: number;
  worst: number;
  frame: number;
  bone: string;
  failures: string[];
}

/**
 * #375: the generator's true supporting foot against the declared world floor.
 * RUN_FLOOR = -150 in the generator's y-up space (picture y = 400 - Y).
 * --floor 0 translates that plane to world y = 0; it does not estimate a floor
 * from output. L is mean setup thigh-root -> shin-tip distance. Neither the
 * grounded frame set nor the floor depends on report.jumps/supports/floor.
 */
function checkRunSupport(out: RefRunOutput, posed = poseFrames(
  out.buildDoc, 'dance', readPoseSequence(readFileSync(out.ref.posePath, 'utf8'), 'fixture').frames.map((f) => f.t),
)): SupportHeightVerdict {
  const truth = groundedRun();
  const lengths = new Map(out.buildDoc.bones.map((b) => [b.name, b.length ?? 0]));
  const setup = new Map(poseRawSetup(out.buildDoc).bones.map((b) => [b.name, b]));
  const legLength = ['r', 'l'].map((side) => {
    const root = setup.get(`leg_${side}0`)!;
    const tip = pointAt(setup, lengths, `leg_${side}1:tip`)!;
    return Math.hypot(root.worldX - tip[0], root.worldY - tip[1]);
  }).reduce((a, b) => a + b) / 2;
  const verdict: SupportHeightVerdict = { grounded: 0, airborne: 0, worst: 0, frame: 0, bone: 'none', failures: [] };
  if (posed.length !== truth.length || !(legLength > 0 && Number.isFinite(legLength))) {
    throw new Error(`GATE_SUPPORT_FOOT_HEIGHT: run has ${posed.length} posed frames for ${truth.length} truth frames, setup leg length ${legLength}; require matching frames and a positive finite length`);
  }
  for (let i = 0; i < truth.length; i++) {
    const frame = truth[i]!;
    if (frame.lifted.length === 2) { verdict.airborne++; continue; }
    if (frame.lifted.length !== 1) throw new Error(`GATE_SUPPORT_FOOT_HEIGHT: run truth frame ${i} requires one support or flight`);
    const side = frame.lifted[0] === 'r' ? 'l' : 'r';
    // Guard the fixture's ground truth too: picture y = 400 - RUN_FLOOR.
    if (Math.abs(frame.joints[`${side}_ankle`]![1] - (400 - RUN_FLOOR)) > 1e-9) {
      throw new Error(`GATE_SUPPORT_FOOT_HEIGHT: run truth frame ${i} ankle ${side} is not on generator floor ${RUN_FLOOR}`);
    }
    verdict.grounded++;
    const bone = `leg_${side}1:tip`;
    const tip = pointAt(posed[i]!, lengths, bone);
    const y = tip?.[1] ?? NaN;
    const error = Math.abs(y) / legLength;
    if (error > verdict.worst) { verdict.worst = error; verdict.frame = i; verdict.bone = bone; }
    if (!(error <= 0.01)) verdict.failures.push(
      `GATE_SUPPORT_FOOT_HEIGHT: run bone "${bone}" frame ${i} (generator support ${side}) height ${y.toFixed(6)}, required world floor 0 ± 0.01 L; error ${error.toFixed(6)} L`,
    );
  }
  return verdict;
}

function trackId(t: TrackSpec): string {
  if (t.bone !== undefined) return `${t.bone}.${t.property}`;
  if (t.slot !== undefined) return `slot:${t.slot}.${t.property}`;
  return t.property;
}

export interface ContinuityVerdict {
  ref: string;
  maxDelta: number;
  maxDeltaWhere: string;
  maxBridgeElbow: number;
  maxBridgeWhere: string;
  maxSwitchDelta: number;
  maxSwitchWhere: string;
  clampSaturations: number;
  foldsStatus: 'PASS' | 'FAIL' | 'SKIP';
  foldedFrames: number | null;
  meshCount: number;
  failures: string[];
}

const DEGENERATE_SHARE = 2 ** -30;

function cross2(xy: readonly number[], triangles: readonly number[], t: number): number {
  const a = triangles[3 * t]! * 2;
  const b = triangles[3 * t + 1]! * 2;
  const c = triangles[3 * t + 2]! * 2;
  return (xy[b]! - xy[a]!) * (xy[c + 1]! - xy[a + 1]!) - (xy[c]! - xy[a]!) * (xy[b + 1]! - xy[a + 1]!);
}

function longestEdge(xy: readonly number[], triangles: readonly number[], t: number): number {
  const ids = [triangles[3 * t]! * 2, triangles[3 * t + 1]! * 2, triangles[3 * t + 2]! * 2] as const;
  let most = 0;
  for (const [i, j] of [
    [0, 1],
    [1, 2],
    [2, 0],
  ] as const) {
    const dx = xy[ids[j]]! - xy[ids[i]]!;
    const dy = xy[ids[j] + 1]! - xy[ids[i] + 1]!;
    most = Math.max(most, Math.hypot(dx, dy));
  }
  return most;
}

function maxMagnitude(xy: readonly number[]): number {
  let most = 0;
  for (const v of xy) most = Math.max(most, Math.abs(v));
  return most;
}

function triSign(xy: readonly number[], triangles: readonly number[], t: number, scale: number): -1 | 0 | 1 {
  const twice = cross2(xy, triangles, t);
  const edge = longestEdge(xy, triangles, t);
  if (edge === 0 || Math.abs(twice) / edge <= DEGENERATE_SHARE * scale) return 0;
  return twice > 0 ? 1 : -1;
}

export interface ContinuityOptions {
  /** Maximum per-frame `|Δ|` (°/frame) allowed across all continuous (non-reindexed) `rotate` frames. */
  deltaCeiling?: number;
  /** Maximum local elbow angle (`|rot|`, °) allowed inside a gesture-set bridge (`< 180°`). */
  bridgeElbowCeiling?: number;
  /** Maximum per-frame `|Δ|` (°/frame) allowed on a support-arm rotate track at an attachment switch frame. */
  switchDeltaCeiling?: number;
}

/**
 * Evaluate standing continuity assertions on one reference output:
 * 1. `GATE_DELTA_CEILING`: per-frame `|Δ|` of every continuous `rotate` track <= `deltaCeiling` (default `45°/f`).
 * 2. `GATE_BRIDGE_ELBOW_INVERT`: elbow local angle (`sleeve_r1.rotate`, `sleeve_l1.rotate`) never
 *    crosses `±180°` (or exceeds `bridgeElbowCeiling`, default `148°`) inside a gesture-set bridge.
 * 3. `GATE_SWITCH_DELTA`: no attachment switch frame with `|Δ|` on the support arm (`sleeve_l0`, `sleeve_l1`)
 *    above `switchDeltaCeiling` (default `25°/f`).
 * 4. `GATE_CLAMP_SATURATION`: clamp saturations at `±20°` on symmetric gesture sets counted (`0` required).
 * 5. `GATE_REFERENCE_FOLDS` (#231): `folds = 0` across all mesh attachments on every posed frame;
 *    a reference with no mesh attachments reports `SKIP` (never counted as a pass).
 */
export function checkContinuity(out: RefRunOutput, opts: ContinuityOptions = {}): ContinuityVerdict {
  const deltaCeiling = opts.deltaCeiling ?? 45;
  const bridgeElbowCeiling = opts.bridgeElbowCeiling ?? 148;
  const switchDeltaCeiling = opts.switchDeltaCeiling ?? 25;
  const failures: string[] = [];

  const mapDoc = JSON.parse(readFileSync(out.ref.mapPath, 'utf8')) as {
    alternates?: Array<{ name: string; symmetric?: boolean; support?: string | string[]; drawn: Record<string, number> }>;
  };
  const supportSetNames = new Set(
    (mapDoc.alternates ?? []).filter((a) => a.support !== undefined).map((a) => a.name),
  );

  // Gesture-set switches from report.json: identify bridge frames (gaps <= 10 frames between switches)
  // and switch boundary frames.
  const switches = (out.report.switches as Array<{ set: string; frames: [number, number] }> | undefined) ?? [];
  const bridgeFrames = new Set<number>();
  const switchFrames = new Set<number>();
  const supportSwitchFrames = new Set<number>();
  for (let s = 0; s < switches.length; s++) {
    const cur = switches[s]!;
    if (cur.frames[0] > 0) {
      switchFrames.add(cur.frames[0]);
      if (supportSetNames.has(cur.set)) supportSwitchFrames.add(cur.frames[0]);
    }
    if (cur.frames[1] + 1 < out.ref.n) {
      switchFrames.add(cur.frames[1] + 1);
      if (supportSetNames.has(cur.set)) supportSwitchFrames.add(cur.frames[1] + 1);
    }
    if (s > 0) {
      const prev = switches[s - 1]!;
      const gap = cur.frames[0] - prev.frames[1] - 1;
      if (gap > 0 && gap <= 10) {
        for (let f = prev.frames[1] + 1; f < cur.frames[0]; f++) bridgeFrames.add(f);
      }
    }
  }
  const armBones = new Set(['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1']);

  let maxDelta = 0;
  let maxDeltaWhere = 'none';
  for (const t of out.tracks) {
    if (t.property !== 'rotate' || t.bone === undefined) continue;
    const id = trackId(t);
    const isSwitchedArm = switches.length > 0 && armBones.has(t.bone);
    for (let f = 1; f < t.keys.length; f++) {
      // On a switched arm bone, attachment re-indexing happens at switch/bridge boundaries;
      // check GATE_DELTA_CEILING on non-boundary frames (and on all frames of non-switched tracks).
      if (isSwitchedArm && (switchFrames.has(f) || bridgeFrames.has(f) || bridgeFrames.has(f - 1))) continue;
      const prev = (t.keys[f - 1]!.v as number[])[0]!;
      const curr = (t.keys[f]!.v as number[])[0]!;
      const d = Math.abs(wrap(curr - prev));
      if (d > maxDelta) {
        maxDelta = d;
        maxDeltaWhere = `${id} f${f}`;
      }
      if (d > deltaCeiling) {
        failures.push(
          `GATE_DELTA_CEILING: ${out.ref.name} track "${id}" frame ${f} stepped by ${d.toFixed(2)}° (ceiling ${deltaCeiling.toFixed(2)}°)`,
        );
      }
    }
  }

  let maxBridgeElbow = 0;
  let maxBridgeWhere = 'none';
  for (const elbow of ['sleeve_r1', 'sleeve_l1']) {
    const tr = out.tracks.find((t) => t.bone === elbow && t.property === 'rotate');
    if (tr === undefined) continue;
    for (const f of bridgeFrames) {
      if (f < 0 || f >= tr.keys.length) continue;
      const rot = Math.abs(wrap((tr.keys[f]!.v as number[])[0]!));
      if (rot > maxBridgeElbow) {
        maxBridgeElbow = rot;
        maxBridgeWhere = `${elbow}.rotate f${f}`;
      }
      if (rot > bridgeElbowCeiling) {
        failures.push(
          `GATE_BRIDGE_ELBOW_INVERT: ${out.ref.name} "${elbow}.rotate" frame ${f} inside bridge reached |localRot| = ${rot.toFixed(2)}° (> ${bridgeElbowCeiling.toFixed(2)}°, crossing toward ±180°)`,
        );
      }
    }
  }

  let maxSwitchDelta = 0;
  let maxSwitchWhere = 'none';
  for (const supBone of ['sleeve_l0', 'sleeve_l1']) {
    const tr = out.tracks.find((t) => t.bone === supBone && t.property === 'rotate');
    if (tr === undefined) continue;
    for (const f of supportSwitchFrames) {
      if (f <= 0 || f >= tr.keys.length) continue;
      const prev = (tr.keys[f - 1]!.v as number[])[0]!;
      const curr = (tr.keys[f]!.v as number[])[0]!;
      const d = Math.abs(wrap(curr - prev));
      if (d > maxSwitchDelta) {
        maxSwitchDelta = d;
        maxSwitchWhere = `${supBone}.rotate f${f}`;
      }
      if (d > switchDeltaCeiling) {
        failures.push(
          `GATE_SWITCH_DELTA: ${out.ref.name} "${supBone}.rotate" switch frame ${f} stepped by ${d.toFixed(2)}° (> ±3 window ceiling ${switchDeltaCeiling.toFixed(2)}°)`,
        );
      }
    }
  }

  const poses = poseRawAnimation(
    out.buildDoc,
    'dance',
    Array.from({ length: out.ref.n - 1 }, () => out.ref.dt),
    {},
    'animation',
  );

  // Count ±20° clamp saturations on symmetric gesture-set frames.
  const symSets = new Map<string, Record<string, number>>();
  for (const alt of mapDoc.alternates ?? []) {
    if (alt.symmetric === true) symSets.set(alt.name, alt.drawn);
  }
  let clampSaturations = 0;
  if (symSets.size > 0) {
    const byName = (bones: readonly RawBone[]) => new Map(bones.map((b) => [b.name, b]));
    for (const sw of switches) {
      const drawn = symSets.get(sw.set);
      if (drawn === undefined) continue;
      for (let f = sw.frames[0]; f <= sw.frames[1]; f++) {
        const b = byName(poses[f]!.bones);
        for (const [bone, dr] of Object.entries(drawn)) {
          const bn = b.get(bone);
          if (bn === undefined) continue;
          const wRot = Math.atan2(bn.c, bn.a) * DEG;
          const turn = Math.abs(wrap(wRot - dr));
          if (turn >= 20 - 1e-3) {
            clampSaturations++;
            failures.push(
              `GATE_CLAMP_SATURATION: ${out.ref.name} symmetric set "${sw.set}" bone "${bone}" frame ${f} saturated ±20° turn clamp (${turn.toFixed(2)}°)`,
            );
          }
        }
      }
    }
  }

  // #231: standing GATE_REFERENCE_FOLDS check across all mesh attachments; SKIP when the rig has no meshes.
  const setupPose = poseRawSetup(out.buildDoc);
  const setupMeshes = new Map<string, { slot: string; attachment: string; signs: Int8Array; frames: number[] }>();
  for (const d of setupPose.drawn) {
    if (d.kind !== 'mesh') continue;
    const triCount = Math.floor(d.triangles.length / 3);
    const scale = maxMagnitude(d.vertices);
    const signs = new Int8Array(triCount);
    for (let t = 0; t < triCount; t++) signs[t] = triSign(d.vertices, d.triangles, t, scale);
    setupMeshes.set(`${d.slot}:${d.attachment}`, { slot: d.slot, attachment: d.attachment, signs, frames: [] });
  }
  const meshCount = setupMeshes.size;
  let foldsStatus: 'PASS' | 'FAIL' | 'SKIP' = 'SKIP';
  let foldedFrames: number | null = null;
  if (meshCount > 0) {
    const foldedFrameSet = new Set<number>();
    for (let f = 0; f < poses.length; f++) {
      for (const d of poses[f]!.drawn) {
        if (d.kind !== 'mesh') continue;
        const entry = setupMeshes.get(`${d.slot}:${d.attachment}`);
        if (entry === undefined) continue;
        const triCount = Math.floor(d.triangles.length / 3);
        const scale = maxMagnitude(d.vertices);
        let frameFolded = false;
        for (let t = 0; t < triCount; t++) {
          const s0 = entry.signs[t]!;
          if (s0 === 0) continue;
          const sf = triSign(d.vertices, d.triangles, t, scale);
          if (sf === -s0) {
            frameFolded = true;
            break;
          }
        }
        if (frameFolded) {
          entry.frames.push(f);
          foldedFrameSet.add(f);
        }
      }
    }
    foldedFrames = foldedFrameSet.size;
    foldsStatus = foldedFrames === 0 ? 'PASS' : 'FAIL';
    for (const entry of setupMeshes.values()) {
      if (entry.frames.length > 0) {
        failures.push(
          `GATE_REFERENCE_FOLDS: ${out.ref.name} mesh "${entry.attachment}" (slot "${entry.slot}") folded on ${entry.frames.length} frame(s) [${entry.frames.join(', ')}] (0 required)`,
        );
      }
    }
  }

  return {
    ref: out.ref.name,
    maxDelta,
    maxDeltaWhere,
    maxBridgeElbow,
    maxBridgeWhere,
    maxSwitchDelta,
    maxSwitchWhere,
    clampSaturations,
    foldsStatus,
    foldedFrames,
    meshCount,
    failures,
  };
}

export interface TrackClaim {
  ref: string; // 'dancer' | 'second' | '*'
  track: string; // e.g. 'sleeve_r1.rotate' or '*'
  frames: [number, number] | '*';
  issue: string; // e.g. '#206'
}

/**
 * Parse `Claim-Track: <ref> <track> <start>..<end>|* #<issue>` lines from PR body / commit messages.
 */
export function parseTrackClaims(text: string): TrackClaim[] {
  const claims: TrackClaim[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const m = /^\s*Claim-Track:\s*(\S+)\s+(\S+)\s+(\*|\d+\.\.\d+|\d+)\s+(#\d+)\s*$/i.exec(rawLine);
    if (m === null) continue;
    const [, ref, track, rangeStr, issue] = m as unknown as [string, string, string, string, string];
    let frames: [number, number] | '*';
    if (rangeStr === '*') {
      frames = '*';
    } else if (rangeStr.includes('..')) {
      const [lo, hi] = rangeStr.split('..').map((x) => Number.parseInt(x, 10)) as [number, number];
      frames = [lo, hi];
    } else {
      const f = Number.parseInt(rangeStr, 10);
      frames = [f, f];
    }
    claims.push({ ref, track, frames, issue });
  }
  return claims;
}

function isFrameClaimed(claims: readonly TrackClaim[], ref: string, track: string, frame: number): boolean {
  for (const c of claims) {
    if (c.ref !== '*' && c.ref !== ref) continue;
    if (c.track !== '*' && c.track !== track) continue;
    if (c.frames === '*' || (frame >= c.frames[0] && frame <= c.frames[1])) return true;
  }
  return false;
}

export interface RefDiffVerdict {
  ref: string;
  totalTracks: number;
  movedTracks: string[];
  claimedTracks: string[];
  unclaimedTracks: string[];
  failures: string[];
}

/**
 * Compare every track of `candidate` against `base` on one reference scan.
 * Unclaimed track changes (or non-byte-identical tracks outside claimed frames) are refused as `GATE_UNCLAIMED_TRACK`.
 */
export function diffReferenceTracks(base: RefRunOutput, candidate: RefRunOutput, claims: readonly TrackClaim[]): RefDiffVerdict {
  const ref = candidate.ref.name;
  const baseMap = new Map(base.tracks.map((t) => [trackId(t), t]));
  const candMap = new Map(candidate.tracks.map((t) => [trackId(t), t]));
  const allIds = [...new Set([...baseMap.keys(), ...candMap.keys()])];

  const movedTracks: string[] = [];
  const claimedTracks: string[] = [];
  const unclaimedTracks: string[] = [];
  const failures: string[] = [];

  for (const id of allIds) {
    const bt = baseMap.get(id);
    const ct = candMap.get(id);
    if (bt === undefined || ct === undefined) {
      movedTracks.push(id);
      if (isFrameClaimed(claims, ref, id, 0)) {
        claimedTracks.push(id);
      } else {
        unclaimedTracks.push(id);
        failures.push(`GATE_UNCLAIMED_TRACK: ${ref} track "${id}" was ${bt === undefined ? 'added' : 'removed'} without a Claim-Track declaration`);
      }
      continue;
    }
    if (JSON.stringify(bt) === JSON.stringify(ct)) continue;

    movedTracks.push(id);
    const len = Math.max(bt.keys.length, ct.keys.length);
    const unclaimedFrames: number[] = [];
    let maxDiff = 0;
    for (let f = 0; f < len; f++) {
      const bk = bt.keys[f];
      const ck = ct.keys[f];
      if (JSON.stringify(bk) === JSON.stringify(ck)) continue;
      if (bk !== undefined && ck !== undefined && Array.isArray(bk.v) && Array.isArray(ck.v)) {
        for (let k = 0; k < Math.min(bk.v.length, ck.v.length); k++) {
          const bv = bk.v[k];
          const cv = ck.v[k];
          if (typeof bv === 'number' && typeof cv === 'number') {
            const d = bt.property === 'rotate' ? Math.abs(wrap(cv - bv)) : Math.abs(cv - bv);
            if (d > maxDiff) maxDiff = d;
          }
        }
      }
      if (!isFrameClaimed(claims, ref, id, f)) {
        unclaimedFrames.push(f);
      }
    }
    if (unclaimedFrames.length === 0) {
      claimedTracks.push(id);
    } else {
      unclaimedTracks.push(id);
      const span =
        unclaimedFrames.length === 1
          ? `${unclaimedFrames[0]}`
          : `${unclaimedFrames[0]}..${unclaimedFrames[unclaimedFrames.length - 1]} (${unclaimedFrames.length}f)`;
      failures.push(
        `GATE_UNCLAIMED_TRACK: ${ref} track "${id}" moved on unclaimed frame(s) ${span} (max |Δ| = ${maxDiff.toFixed(2)}) — declare "Claim-Track: ${ref} ${id} ${unclaimedFrames[0]}..${unclaimedFrames[unclaimedFrames.length - 1]} #<issue>" in the PR body if intentional`,
      );
    }
  }

  return {
    ref,
    totalTracks: allIds.length,
    movedTracks,
    claimedTracks,
    unclaimedTracks,
    failures,
  };
}

export function formatGateTable(rows: ReadonlyArray<{ diff?: RefDiffVerdict; cont: ContinuityVerdict }>): string {
  const header =
    'ref      | tracks | moved | claimed | unclaimed | max |Δ| (°/f)              | max bridge |elbow| | max switch |Δ| | clamp sat | folds';
  const sep =
    '---------+--------+-------+---------+-----------+----------------------------+--------------------+----------------+-----------+---------';
  const body = rows.map(({ diff, cont }) => {
    if (diff === undefined) {
      return `${cont.ref.padEnd(8)} |   SKIP |  SKIP |    SKIP |      SKIP | ${`${cont.maxDelta.toFixed(2)}° (${cont.maxDeltaWhere})`.padEnd(26)} | ${cont.maxBridgeElbow.toFixed(2)}° | ${cont.maxSwitchDelta.toFixed(2)}° | ${cont.clampSaturations} | ${cont.foldsStatus}`;
    }
    const cRef = diff.ref.padEnd(8);
    const cTr = String(diff.totalTracks).padStart(6);
    const cMv = String(diff.movedTracks.length).padStart(5);
    const cCl = String(diff.claimedTracks.length).padStart(7);
    const cUn = String(diff.unclaimedTracks.length).padStart(9);
    const cDl = `${cont.maxDelta.toFixed(2)}° (${cont.maxDeltaWhere})`.padEnd(26);
    const cBr = `${cont.maxBridgeElbow.toFixed(2)}°`.padStart(18);
    const cSw = `${cont.maxSwitchDelta.toFixed(2)}°`.padStart(14);
    const cSa = String(cont.clampSaturations).padStart(9);
    const cFo = (cont.foldsStatus === 'SKIP' ? 'SKIP' : `${cont.foldedFrames}/${cont.meshCount}m`).padStart(8);
    return `${cRef} | ${cTr} | ${cMv} | ${cCl} | ${cUn} | ${cDl} | ${cBr} | ${cSw} | ${cSa} | ${cFo}`;
  });
  return [header, sep, ...body].join('\n');
}

interface GateBaseInput {
  cli?: string;
  baseSha?: string;
  headSha?: string;
  body?: string;
  baseRepo?: string;
  baseRef?: string;
  /** Test-only dependency seed for a synthetic origin with byte-identical manifest and lock. */
  dependencyFixture?: string;
}

const DEFAULT_BASE_REPO = 'https://github.com/rig-c/pose.git';

/** Historical sources run with their own frozen dependencies, outside the candidate's ancestors. */
function installGateBase(tree: string, dependencyFixture?: string): void {
  const manifest = join(tree, 'package.json');
  const lock = ['bun.lock', 'bun.lockb'].map((name) => join(tree, name)).find(existsSync);
  if (!existsSync(manifest) || lock === undefined) {
    throw new Error('GATE_BASE_UNAVAILABLE: base snapshot requires its own package.json and Bun lockfile');
  }
  const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = [hash(manifest), hash(lock)];
  if (dependencyFixture !== undefined) {
    // The synthetic origin is copied from this same source and lock. Keep its
    // default-suite control offline; a historical base cannot borrow these bytes.
    const fixtureLock = join(dependencyFixture, lock.endsWith('bun.lockb') ? 'bun.lockb' : 'bun.lock');
    if (hash(join(dependencyFixture, 'package.json')) !== before[0] || hash(fixtureLock) !== before[1]) {
      throw new Error('GATE_BASE_UNAVAILABLE: dependency fixture manifest or lock differs from the base');
    }
    cpSync(join(dependencyFixture, 'node_modules'), join(tree, 'node_modules'), {
      recursive: true, verbatimSymlinks: true,
      filter: (source) => source !== join(dependencyFixture, 'node_modules', '.cache'),
    });
  }
  const install = spawnSync(process.execPath, [
    'install', '--frozen-lockfile', '--ignore-scripts', ...(dependencyFixture === undefined ? [] : ['--offline']),
  ], {
    cwd: tree, encoding: 'utf8', timeout: 45_000,
    env: {
      ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1',
      BUN_INSTALL_CACHE_DIR: join(tree, '.gate-cache', 'bun'),
      npm_config_cache: join(tree, '.gate-cache', 'npm'),
    },
  });
  if (install.status !== 0) {
    throw new Error(`GATE_BASE_UNAVAILABLE: base frozen dependency install failed (exit ${install.status}): ${install.error ?? ''} ${install.stdout} ${install.stderr}`);
  }
  if (hash(manifest) !== before[0] || hash(lock) !== before[1]) {
    throw new Error('GATE_BASE_UNAVAILABLE: frozen install changed the base manifest or lockfile');
  }
  writeFileSync(join(tree, 'node_modules', '.metadata_never_index'), '');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> };
  const identities = Object.entries(pkg.dependencies ?? {}).map(([name, range]) => {
    const installed = join(tree, 'node_modules', name, 'package.json');
    if (!existsSync(installed)) throw new Error(`GATE_BASE_UNAVAILABLE: base dependency "${name}" was not installed in its snapshot`);
    const dep = JSON.parse(readFileSync(installed, 'utf8')) as { name: string; version: string };
    return `${name}@${range} -> ${dep.name}@${dep.version} (package sha256 ${hash(installed)})`;
  });
  console.log(`GATE_BASE_DEPENDENCIES: manifest sha256 ${before[0]}; lock sha256 ${before[1]}; ${identities.join('; ')}`);
}

/** A missing optional base is SKIP; a requested base that cannot be read is red. */
function withGateBase<T>(read: (cli: string | undefined, claims: string) => T, input: GateBaseInput = {
  cli: process.env.GATE_BASE_CLI, baseSha: process.env.GATE_BASE_SHA,
  headSha: process.env.GATE_HEAD_SHA, body: process.env.GATE_PR_BODY,
  baseRepo: process.env.GATE_BASE_REPO, baseRef: process.env.GATE_BASE_REF,
}): T {
  const body = input.body ?? '';
  const cli = input.cli?.trim() ?? '';
  if (cli.length > 0) {
    // An explicit source snapshot is the adapter for runners without .git.
    // Supply commit-message claims via GATE_PR_BODY when using that adapter.
    if (!existsSync(cli) || resolve(cli) === resolve(CLI)) {
      throw new Error('GATE_BASE_UNAVAILABLE: GATE_BASE_CLI must name an existing, separate base CLI; no self-comparison');
    }
    console.log('GATE_BASE: comparing all references against the explicit GATE_BASE_CLI snapshot');
    return read(cli, body);
  }
  const baseSha = input.baseSha?.trim() ?? '';
  const baseRef = input.baseRef?.trim() ?? '';
  const hasGit = existsSync(join(ROOT, '.git'));
  if (baseRef.length > 0 || (!hasGit && baseSha.length > 0)) {
    const repo = (input.baseRepo ?? process.env.GATE_BASE_REPO ?? DEFAULT_BASE_REPO).trim();
    const ref = baseSha || baseRef;
    if (repo.length === 0) {
      throw new Error('GATE_BASE_UNAVAILABLE: GATE_BASE_REPO must be non-empty');
    }
    const tree = mkdtempSync(join(tmpdir(), 'rig-pose-gate-base-'));
    try {
      const init = spawnSync('git', ['init', '-q'], { cwd: tree, encoding: 'utf8' });
      if (init.status !== 0) {
        throw new Error(`GATE_BASE_UNAVAILABLE: cannot initialize base snapshot in ${tree}: ${init.stderr}`);
      }
      const fetch = spawnSync('git', ['fetch', '--depth', '1', '--no-tags', '--', repo, ref], {
        cwd: tree,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (fetch.status !== 0) {
        throw new Error(`GATE_BASE_UNAVAILABLE: cannot fetch base ${ref} from ${repo}: ${fetch.stderr}`);
      }
      const checkout = spawnSync('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: tree, encoding: 'utf8' });
      if (checkout.status !== 0) {
        throw new Error(`GATE_BASE_UNAVAILABLE: cannot checkout base ${ref} from ${repo}: ${checkout.stderr}`);
      }
      rmSync(join(tree, '.git'), { recursive: true, force: true });
      installGateBase(tree, input.dependencyFixture);
      return withGateBase(read, { cli: join(tree, 'cli.ts'), body });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
  if (baseSha.length === 0) {
    console.log('GATE_BASE_UNAVAILABLE: track comparison SKIP (no GATE_BASE_SHA or GATE_BASE_CLI); continuity and support height are still measured');
    return read(undefined, body);
  }
  const headSha = input.headSha?.trim() || 'HEAD';
  const mb = spawnSync('git', ['merge-base', baseSha, headSha], { cwd: ROOT, encoding: 'utf8' });
  if (mb.status !== 0 || !/^[a-f0-9]{40,64}$/.test(mb.stdout.trim())) {
    throw new Error(`GATE_BASE_UNAVAILABLE: cannot resolve merge base of ${baseSha} and ${headSha}; no track comparison: ${mb.stderr}`);
  }
  const mergeBase = mb.stdout.trim();
  const log = spawnSync('git', ['log', '--format=%B', `${mergeBase}..${headSha}`], { cwd: ROOT, encoding: 'utf8' });
  if (log.status !== 0) throw new Error(`GATE_BASE_UNAVAILABLE: cannot read claims for ${mergeBase}..${headSha}: ${log.stderr}`);
  const tree = mkdtempSync(join(tmpdir(), 'rig-pose-gate-base-'));
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', mergeBase], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(`GATE_BASE_UNAVAILABLE: cannot archive base ${mergeBase}: ${archive.stderr.toString()}`);
    const tar = spawnSync('tar', ['-x', '-C', tree], { input: archive.stdout, encoding: 'utf8' });
    const baseCLI = join(tree, 'cli.ts');
    if (tar.status !== 0 || !existsSync(baseCLI)) throw new Error(`GATE_BASE_UNAVAILABLE: base ${mergeBase} extraction has no usable CLI: ${tar.stderr}`);
    installGateBase(tree);
    console.log(`GATE_BASE: comparing all references against merge base ${mergeBase}`);
    return read(baseCLI, `${body}\n${log.stdout}`);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

describe('#208: two-reference regression gate and standing continuity assertions with mutants', () => {
  test('Bar 1 & Bar 3 and #375: both references and the generated run are green; compare every track to an available PR base', () => {
    const work = tempDir();
    const outputs = [setupDancerRef(work), setupSecondRef(work), setupRunRef(work)].map((ref) => runReference(ref));
    assertReportSurfaces(outputs.map((out) => [out.ref.name, out.report] as const));
    const continuity = outputs.map((out) => checkContinuity(out));
    const support = checkRunSupport(outputs[2]!);
    console.log(`GATE_SUPPORT_FOOT_HEIGHT: run ${support.grounded} generator-grounded / ${support.airborne} airborne frames, floor 0; max ${support.worst.toFixed(8)} L at ${support.bone} frame ${support.frame} (bar ≤ 0.01 L)`);
    expect(support.grounded).toBe(80);
    expect(support.airborne).toBe(120);
    expect(support.failures).toEqual([]);

    withGateBase((baseCLI, claimSource) => {
      const claims = parseTrackClaims(claimSource);
      const baseWork = tempDir();
      const base = baseCLI === undefined ? undefined
        : [setupDancerRef(baseWork), setupSecondRef(baseWork), setupRunRef(baseWork)].map((ref) => runReference(ref, baseCLI));
      const rows = outputs.map((out, i) => ({
        cont: continuity[i]!, diff: base === undefined ? undefined : diffReferenceTracks(base[i]!, out, claims),
      }));
      console.log(`\n=== GATE (#208, #375): reference regression & continuity ===\n${formatGateTable(rows)}\n`);
      for (const row of rows) {
        expect(row.cont.failures).toEqual([]);
        if (row.diff !== undefined) expect(row.diff.failures).toEqual([]);
      }
    });
    expect(continuity[0]!.foldsStatus).toBe('PASS');
    expect(continuity[0]!.foldedFrames).toBe(0);
    expect(continuity[0]!.meshCount).toBe(1);
    for (const cont of continuity.slice(1)) {
      expect(cont.foldsStatus).toBe('SKIP');
      expect(cont.foldedFrames).toBeNull();
      expect(cont.meshCount).toBe(0);
    }
  }, SLOW);

  test('#375 & #410: optional base absence is SKIP; GATE_BASE_REF extracts a separate origin snapshot and catches a planted track change; a missing or self base fails by name', () => {
    withGateBase((cli) => expect(cli).toBeUndefined(), {});
    expect(() => withGateBase(() => {}, { cli: join(tempDir(), 'missing.ts') })).toThrow('GATE_BASE_UNAVAILABLE');
    expect(() => withGateBase(() => {}, { cli: CLI })).toThrow('no self-comparison');
    expect(() => withGateBase(() => {}, { baseRepo: join(tempDir(), 'missing-repo'), baseRef: 'refs/heads/main' })).toThrow('GATE_BASE_UNAVAILABLE');
    expect(() => withGateBase(() => {}, { baseRepo: '', baseRef: 'refs/heads/main' })).toThrow('GATE_BASE_UNAVAILABLE');

    const originRepo = join(tempDir(), 'origin-repo');
    mkdirSync(originRepo, { recursive: true });
    cpSync(join(ROOT, 'src'), join(originRepo, 'src'), { recursive: true });
    cpSync(join(ROOT, 'cli.ts'), join(originRepo, 'cli.ts'));
    cpSync(join(ROOT, 'package.json'), join(originRepo, 'package.json'));
    cpSync(join(ROOT, 'bun.lock'), join(originRepo, 'bun.lock'));
    expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: originRepo }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: originRepo }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.name', 'test'], { cwd: originRepo }).status).toBe(0);
    expect(spawnSync('git', ['add', '.'], { cwd: originRepo }).status).toBe(0);
    expect(spawnSync('git', ['commit', '-q', '-m', 'base snapshot'], { cwd: originRepo }).status).toBe(0);

    expect(() => withGateBase(() => {}, { baseRepo: originRepo, baseRef: 'refs/heads/missing' })).toThrow('GATE_BASE_UNAVAILABLE');

    let extractedCLI = '';
    withGateBase((baseCLI, claims) => {
      expect(baseCLI).toBeDefined();
      extractedCLI = baseCLI!;
      expect(existsSync(extractedCLI)).toBe(true);
      expect(resolve(extractedCLI)).not.toBe(resolve(CLI));
      expect(claims).toBe('Claim-Track: run hip.translate 2 #410');
      const snapshot = resolve(extractedCLI, '..');
      const baseDependency = join(snapshot, 'node_modules', '@rig-c', 'core', 'package.json');
      expect(realpathSync(baseDependency).startsWith(`${snapshot}/node_modules/`)).toBe(true);
      expect(realpathSync(join(snapshot, 'node_modules', '.bin', 'rigc')).startsWith(`${snapshot}/node_modules/`)).toBe(true);
      expect(readFileSync(join(snapshot, 'bun.lock'), 'utf8')).toBe(readFileSync(join(originRepo, 'bun.lock'), 'utf8'));
      console.log('GATE_BASE_ISOLATION control: separate snapshot dependency installed offline from identical fixture manifest and lock; frozen lock bytes unchanged');

      const baseOut = runReference(setupRunRef(tempDir()), extractedCLI);
      const planted: RefRunOutput = { ...baseOut, tracks: structuredClone(baseOut.tracks) };
      const hip = planted.tracks.find((t) => t.bone === 'hip' && t.property === 'translate')!;
      (hip.keys[2]!.v as number[])[1]! += 1.5;

      const unclaimed = diffReferenceTracks(baseOut, planted, []);
      expect(unclaimed.failures.some((f) => f.includes('GATE_UNCLAIMED_TRACK: run track "hip.translate"'))).toBe(true);
      const claimed = diffReferenceTracks(baseOut, planted, parseTrackClaims(claims));
      expect(claimed.failures).toEqual([]);
      console.log(`GATE_BASE_TRACK_MUTANT: ${unclaimed.failures.join('; ')}; exact frame claim accepted with ${claimed.failures.length} findings`);
    }, { baseRepo: originRepo, baseRef: 'refs/heads/main', body: 'Claim-Track: run hip.translate 2 #410', dependencyFixture: ROOT });
    expect(existsSync(extractedCLI)).toBe(false);
  }, SLOW);

  test('#467: missing or inconsistent base dependencies refuse instead of borrowing the candidate installation', () => {
    const tree = tempDir();
    cpSync(join(ROOT, 'package.json'), join(tree, 'package.json'));
    expect(() => installGateBase(tree)).toThrow('requires its own package.json and Bun lockfile');
    cpSync(join(ROOT, 'bun.lock'), join(tree, 'bun.lock'));
    const pkg = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    // This dependency exists in the candidate but disagrees with the snapshot's lock.
    pkg.dependencies['@rig-c/core'] = '0.0.0';
    writeFileSync(join(tree, 'package.json'), JSON.stringify(pkg));
    expect(() => installGateBase(tree, ROOT)).toThrow('dependency fixture manifest or lock differs from the base');
    expect(existsSync(join(tree, 'node_modules', '@rig-c', 'core'))).toBe(false);
    console.log('GATE_BASE_ISOLATION mutant: missing lock and mismatched dependency refused; candidate dependency not borrowed');
  }, SLOW);

  test('#375 controls: generator ground survives false jump labels, a common vertical shift fails, and run track changes still require claims', () => {
    const out = runReference(setupRunRef(tempDir()));
    const truth = checkRunSupport(out);
    // Plant a report that declares every frame airborne and invents a floor.
    const mislabeled = { ...out, report: { ...out.report, feet: { jumps: [[0, out.ref.n - 1]], supports: [], floor: { y: 999 } } } };
    expect(checkRunSupport(mislabeled)).toEqual(truth);
    expect(truth.failures).toEqual([]);
    const times = readPoseSequence(readFileSync(out.ref.posePath, 'utf8'), 'fixture').frames.map((f) => f.t);
    const shifted = poseFrames(out.buildDoc, 'dance', times).map((frame) => new Map(
      [...frame].map(([name, bone]) => [name, { ...bone, worldY: bone.worldY + 10 }]),
    ));
    const bad = checkRunSupport(mislabeled, shifted);
    expect(bad.grounded).toBe(80);
    expect(bad.failures).toHaveLength(80);
    expect(bad.failures[0]).toContain('GATE_SUPPORT_FOOT_HEIGHT: run bone "leg_r1:tip" frame 0');
    console.log(`GATE_SUPPORT_FOOT_HEIGHT control: all feet shifted +10 world units with false all-air report; ${bad.failures.length}/80 grounded frames refused, max ${bad.worst.toFixed(6)} L`);
    const candidate: RefRunOutput = { ...out, tracks: structuredClone(out.tracks) };
    const track = candidate.tracks.find((t) => t.bone === 'hip' && t.property === 'translate')!;
    (track.keys[3]!.v as number[])[1]! += 1;
    const noClaim = diffReferenceTracks(out, candidate, []);
    expect(noClaim.failures.some((f) => f.includes('GATE_UNCLAIMED_TRACK: run track "hip.translate"'))).toBe(true);
    const claim = parseTrackClaims('Claim-Track: run hip.translate 3 #375');
    expect(diffReferenceTracks(out, candidate, claim).failures).toEqual([]);
    expect(diffReferenceTracks(out, candidate, parseTrackClaims('Claim-Track: run hip.translate 4 #375')).failures).toHaveLength(1);
    const spike: RefRunOutput = { ...out, tracks: structuredClone(out.tracks) };
    const rotate = spike.tracks.find((t) => t.bone === 'head' && t.property === 'rotate')!;
    (rotate.keys[3]!.v as number[])[0]! += 90;
    expect(checkContinuity(spike).failures.some((f) => f.includes('GATE_DELTA_CEILING: run track "head.rotate"'))).toBe(true);
  }, SLOW);

  test('Bar 1 mutants: reapplying #205 is red by name on BOTH references; reapplying #206 is red by name; each continuity assertion has a mutant that makes it fire', () => {
    const baseWork = tempDir();
    const baseDancer = runReference(setupDancerRef(baseWork));
    const baseSecond = runReference(setupSecondRef(baseWork));

    mkdirSync(MUTANTS, { recursive: true });
    const d205 = mkdtempSync(join(MUTANTS, 'm208-205-'));
    const d206 = mkdtempSync(join(MUTANTS, 'm208-206-'));
    try {
      for (const d of [d205, d206]) {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      }

      // Mutant #205: reintroduce unbounded headNodReading.residual instead of clampedY.
      // Must go red by name on BOTH references (dancer and second).
      {
        const pRet = join(d205, 'src', 'retarget.ts');
        const src = readFileSync(pRet, 'utf8');
        const from1 = 'const nodY = headNodReading.clampedY[i] ?? 0;';
        const from2 =
          'const nodCoupled = headNodReading !== null && headNodReading.residual.some((r) => r !== 0) ? headNodReading.clampedY : null;';
        expect(src.split(from1)).toHaveLength(2);
        expect(src.split(from2)).toHaveLength(2);
        writeFileSync(
          pRet,
          src
            .replace(from1, 'const nodY = headNodReading.residual[i] ?? 0;')
            .replace(from2, 'const nodCoupled = headNodReading !== null ? headNodReading.residual : null;'),
        );

        const mWork = tempDir();
        const mDancer = runReference(setupDancerRef(mWork), join(d205, 'cli.ts'));
        const mSecond = runReference(setupSecondRef(mWork), join(d205, 'cli.ts'));

        const diffD = diffReferenceTracks(baseDancer, mDancer, []);
        const diffS = diffReferenceTracks(baseSecond, mSecond, []);

        expect(diffD.failures.some((f) => f.includes('GATE_UNCLAIMED_TRACK') && f.includes('head.rotate'))).toBe(true);
        expect(diffD.failures.some((f) => f.includes('GATE_UNCLAIMED_TRACK') && f.includes('pitch_dial.rotate'))).toBe(true);
        expect(diffS.failures.some((f) => f.includes('GATE_UNCLAIMED_TRACK') && f.includes('head.rotate'))).toBe(true);
        expect(diffS.failures.some((f) => f.includes('GATE_UNCLAIMED_TRACK') && f.includes('pitch_dial.rotate'))).toBe(true);
      }

      // Mutant #206: reintroduce world-space bridge interpolation in switch.ts / retarget.ts.
      // Must go red by name (`GATE_BRIDGE_ELBOW_INVERT` and `GATE_UNCLAIMED_TRACK`).
      {
        const pSw = join(d206, 'src', 'switch.ts');
        const swSrc = readFileSync(pSw, 'utf8');
        const swFrom = 'const parentTg = parentBone !== undefined ? targets.get(parentBone) : undefined;';
        expect(swSrc.split(swFrom)).toHaveLength(2);
        writeFileSync(pSw, swSrc.replace(swFrom, 'const parentTg = undefined;'));

        const pRet = join(d206, 'src', 'retarget.ts');
        const retSrc = readFileSync(pRet, 'utf8');
        const from1 = 'const parentTg = bIdx > 0 ? targets.get(ch.bones[bIdx - 1]!) : undefined;';
        const from2 =
          'targets.get(bR1)![i] = wrap(inR1 + 0.45 * wrap(aR0 - drawnR0));\n            targets.get(bL1)![i] = wrap(inL1 + 0.45 * wrap(aL0 - drawnL0));';
        const from3 = 'if (set.anchor === undefined && set.symmetric !== true && set.support === undefined && loShow < s.frames[0]) {';
        expect(retSrc.split(from1)).toHaveLength(2);
        expect(retSrc.split(from2)).toHaveLength(2);
        expect(retSrc.split(from3)).toHaveLength(2);
        writeFileSync(
          pRet,
          retSrc.replace(from1, 'const parentTg = undefined;').replace(from2, '').replace(from3, 'if (false) {'),
        );

        const mWork = tempDir();
        const mDancer = runReference(setupDancerRef(mWork), join(d206, 'cli.ts'));
        const contD = checkContinuity(mDancer);
        const diffD = diffReferenceTracks(baseDancer, mDancer, []);

        expect(contD.failures.some((f) => f.includes('GATE_BRIDGE_ELBOW_INVERT'))).toBe(true);
        expect(diffD.failures.some((f) => f.includes('GATE_UNCLAIMED_TRACK') && f.includes('sleeve_r1.rotate'))).toBe(true);
      }

      // Mutant for GATE_DELTA_CEILING: a single-frame spike > 55° on a rotate track is refused by name.
      {
        const mutDelta: RefRunOutput = {
          ...baseSecond,
          tracks: baseSecond.tracks.map((t) => {
            if (t.bone !== 'head' || t.property !== 'rotate') return t;
            const keys = t.keys.map((k, idx) => (idx === 15 ? { ...k, v: [wrap((k.v as number[])[0]! + 65)] } : k));
            return { ...t, keys };
          }),
        };
        const contDl = checkContinuity(mutDelta);
        expect(contDl.failures.some((f) => f.includes('GATE_DELTA_CEILING'))).toBe(true);
      }

      // Mutant for GATE_SWITCH_DELTA: a switch boundary step > 25° on a support arm bone is refused by name.
      {
        const mutSwitch: RefRunOutput = {
          ...baseDancer,
          tracks: baseDancer.tracks.map((t) => {
            if (t.bone !== 'sleeve_l1' || t.property !== 'rotate') return t;
            const keys = t.keys.map((k, idx) => (idx === 22 ? { ...k, v: [wrap((k.v as number[])[0]! + 65)] } : k));
            return { ...t, keys };
          }),
        };
        const contSw = checkContinuity(mutSwitch);
        expect(contSw.failures.some((f) => f.includes('GATE_SWITCH_DELTA'))).toBe(true);
      }

      // Mutant for GATE_CLAMP_SATURATION: a symmetric gesture-set frame hitting the ±20° turn clamp is refused by name.
      {
        const mWork = tempDir();
        const refSat = setupDancerRef(mWork);
        const mapSat = JSON.parse(readFileSync(refSat.mapPath, 'utf8')) as {
          alternates: Array<{ name: string; drawn: Record<string, number> }>;
        };
        // Shift drawn angle on K1_sym so the posed world rotation is >= 20° from drawn, triggering GATE_CLAMP_SATURATION.
        mapSat.alternates[0]!.drawn.sleeve_r0 = 90;
        writeFileSync(refSat.mapPath, JSON.stringify(mapSat, null, 2));
        const contSat = checkContinuity({ ...baseDancer, ref: refSat });
        expect(contSat.clampSaturations).toBeGreaterThan(0);
        expect(contSat.failures.some((f) => f.includes('GATE_CLAMP_SATURATION'))).toBe(true);
      }

      // Mutant for GATE_REFERENCE_FOLDS (#231): a frame that folds a skirt mesh triangle is refused by name,
      // while a reference with no mesh attachments reports SKIP (never PASS).
      {
        const contNoMesh = checkContinuity(baseSecond);
        expect(contNoMesh.foldsStatus).toBe('SKIP');
        expect(contNoMesh.foldedFrames).toBeNull();

        const foldDoc: CompiledDocument = structuredClone(baseDancer.buildDoc);
        const anim = foldDoc.animations.find((a) => a.name === 'dance')!;
        const r0 = anim.timelines.bones.find((b) => b.name === 'leg_r0')!.timelines.find((t) => t.kind === 'rotate')!;
        const l0 = anim.timelines.bones.find((b) => b.name === 'leg_l0')!.timelines.find((t) => t.kind === 'rotate')!;
        r0.keys[15]!.values[0] = 60;
        r0.keys[15]!.stated.values[0] = 60;
        l0.keys[15]!.values[0] = -60;
        l0.keys[15]!.stated.values[0] = -60;
        const contFold = checkContinuity({ ...baseDancer, buildDoc: foldDoc });
        expect(contFold.foldsStatus).toBe('FAIL');
        expect(contFold.foldedFrames).toBe(1);
        expect(contFold.failures.some((f) => f.includes('GATE_REFERENCE_FOLDS') && f.includes('slot "skirt"') && f.includes('[15]'))).toBe(true);
      }
    } finally {
      rmSync(d205, { recursive: true, force: true });
      rmSync(d206, { recursive: true, force: true });
    }
  }, SLOW);

  test('Bar 2: a PR that changes one track and claims it is green; the same PR with the claim removed is red by name', () => {
    const work = tempDir();
    const baseDancer = runReference(setupDancerRef(work));

    // Candidate moves sleeve_r1.rotate on frames 8..11 by +3.5°.
    const candDancer: RefRunOutput = {
      ...baseDancer,
      tracks: baseDancer.tracks.map((t) => {
        if (t.bone !== 'sleeve_r1' || t.property !== 'rotate') return t;
        const keys = t.keys.map((k, idx) =>
          idx >= 8 && idx <= 11 ? { ...k, v: [+(wrap((k.v as number[])[0]! + 3.5)).toFixed(4)] } : k,
        );
        return { ...t, keys };
      }),
    };

    const claims = parseTrackClaims('Summary\nClaim-Track: dancer sleeve_r1.rotate 8..11 #206\n');
    const withClaim = diffReferenceTracks(baseDancer, candDancer, claims);
    expect(withClaim.movedTracks).toEqual(['sleeve_r1.rotate']);
    expect(withClaim.claimedTracks).toEqual(['sleeve_r1.rotate']);
    expect(withClaim.unclaimedTracks).toEqual([]);
    expect(withClaim.failures).toEqual([]);

    const withoutClaim = diffReferenceTracks(baseDancer, candDancer, []);
    expect(withoutClaim.movedTracks).toEqual(['sleeve_r1.rotate']);
    expect(withoutClaim.claimedTracks).toEqual([]);
    expect(withoutClaim.unclaimedTracks).toEqual(['sleeve_r1.rotate']);
    expect(withoutClaim.failures).toHaveLength(1);
    expect(withoutClaim.failures[0]).toContain('GATE_UNCLAIMED_TRACK: dancer track "sleeve_r1.rotate" moved on unclaimed frame(s) 8..11');
  }, SLOW);
});
