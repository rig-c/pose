/**
 * rig-c/pose#346: `--draw-order depth` also keys each forearm against the trunk, from @rig-c/parts' `layout.json`
 * companion (`rig-parts-layout/1`, parts#647) and the map's explicit `layout` binding (`src/layout.ts`).
 *
 * The fixtures are #281's (examples/walk/make-depth.ts): the run and the walk in place, seen by the front camera, and
 * the same 3D motion seen by a camera turned 40° toward the figure's right (rig-c/pose#358's angle), rebuilt here
 * from the front camera's joints (x − 200, 400 − y) and true depths (Z). The rig is the walk's figure
 * (examples/wave/rig) with a torso cut in two halves, an arm on each, and the legs: each forearm drawn immediately
 * behind its torso half at setup — what parts writes for `"layout": { "parts": ["forearm_r"], "before": { "part":
 * "torso_r" } }`. (One torso slot cannot be the target of both forearms: parts refuses two placements sharing a slot,
 * RIG_LAYOUT_CONFLICT.)
 *
 * The truth: a forearm is in front of the trunk when its true forward depth (Z, the mean of its elbow's and wrist's)
 * is above the trunk's plane, Z = 0 — the same in every view, since the cameras are orthographic.
 *
 * The bars: (1) on the frontal run with a layout, both forearms are drawn in front of their torso half on every
 * frame their depth says so (N/N), the setup order elsewhere, and the legs as without a layout; (2) a walk on which
 * no forearm passes the tie writes the same motion with and without a layout; (3) without the flag the output is
 * byte-identical with and without a layout and a binding; (4) refusals by name: no binding, a stale SHA, a binding
 * with no layout, an unsupported source, a slot not on the source's bone, a block not adjacent; (5) the reader reads
 * a real `rig-parts-layout/1` written by parts 1.56.0 (test/fixtures/parts-layout, its public limb fixture) and
 * refuses it against other rig bytes; (6) a mutant without the forearm writer keys no forearm.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plate } from '@rig-c/core/plate';
import { depthCycle, depthDoc, TIE, type DepthFrame } from '../examples/walk/make-depth.ts';
import { segmentDepth } from '../src/depth.ts';
import type { DrawOrderKey } from '../src/draworder.ts';
import { bindingProblems, keyGroups, readLayout, resolveGroups } from '../src/layout.ts';
import { readMap, type Rest } from '../src/map.ts';
import { personTrack, readPoseSequence, type PoseSequence } from '../src/pose.ts';
import { Refusal } from '../src/problems.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const WAVE = join(ROOT, 'examples', 'wave', 'rig', 'rig.json');
const MAP = join(ROOT, 'examples', 'walk', 'map.json');
const PRODUCER = join(import.meta.dir, 'fixtures', 'parts-layout');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const SLOW = 240_000;
const RAD = Math.PI / 180;
const TURN = 40;

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-forearms-'));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}
function cli(args: string[]): Ran {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const linesOf = (r: Ran, tag: string): string[] => r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(tag));
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Setup: the upper arms, each forearm immediately behind its torso half, then the legs (the left drawn first). */
const SETUP = ['arm_r0', 'arm_l0', 'arm_r1', 'torso_r', 'arm_l1', 'torso_l', 'leg_l0', 'leg_l1', 'leg_r0', 'leg_r1'];
const PLACEMENTS = [
  { limb: 'arm_r', parts: ['forearm_r'], before: { part: 'torso_r' }, slots: ['arm_r1'], target_slots: ['torso_r'] },
  { limb: 'arm_l', parts: ['forearm_l'], before: { part: 'torso_l' }, slots: ['arm_l1'], target_slots: ['torso_l'] },
];
const BINDINGS = [
  { limb: 'arm_r', parts: ['forearm_r'], depth: 'r_forearm', against: 'trunk' },
  { limb: 'arm_l', parts: ['forearm_l'], depth: 'l_forearm', against: 'trunk' },
];

interface RigOpts {
  order?: string[];
  /** Write layout.json beside rig.json (default true); `placements` overrides its placements. */
  layout?: boolean;
  placements?: unknown[];
}
/** The figure with the torso halves, the arms and the legs; returns the rig directory. */
function writeRig(dir: string, o: RigOpts = {}): string {
  const rigDir = join(dir, 'rig');
  mkdirSync(join(rigDir, 'images'), { recursive: true });
  const img = (name: string, w: number, h: number, c: [number, number, number, number]) => {
    const p = new Plate(w, h);
    p.rect(0, 0, w, h, c);
    p.writePng(join(rigDir, 'images', `${name}.png`));
  };
  img('torso_r', 30, 160, [90, 160, 90, 255]);
  img('torso_l', 30, 160, [70, 140, 70, 255]);
  img('upper_r', 20, 70, [200, 120, 40, 255]);
  img('fore_r', 18, 60, [240, 200, 40, 255]);
  img('upper_l', 20, 70, [120, 40, 200, 255]);
  img('fore_l', 18, 60, [200, 40, 240, 255]);
  img('thigh_r', 24, 84, [220, 60, 60, 255]);
  img('shin_r', 24, 74, [150, 30, 30, 255]);
  img('thigh_l', 24, 84, [60, 100, 230, 255]);
  img('shin_l', 24, 74, [30, 50, 150, 255]);
  const rig = JSON.parse(readFileSync(WAVE, 'utf8')) as Record<string, unknown>;
  const bone: Record<string, string> = { torso_r: 'chest', torso_l: 'chest', arm_r0: 'sleeve_r0', arm_r1: 'sleeve_r1', arm_l0: 'sleeve_l0', arm_l1: 'sleeve_l1', leg_l0: 'leg_l0', leg_l1: 'leg_l1', leg_r0: 'leg_r0', leg_r1: 'leg_r1' };
  const att: Record<string, [string, Record<string, number>]> = {
    torso_r: ['torso_r', { x: -15, y: 0 }],
    torso_l: ['torso_l', { x: 15, y: 0 }],
    arm_r0: ['upper_r', { x: 35, y: 0, rotation: 90 }],
    arm_r1: ['fore_r', { x: 30, y: 0, rotation: 90 }],
    arm_l0: ['upper_l', { x: 35, y: 0, rotation: 90 }],
    arm_l1: ['fore_l', { x: 30, y: 0, rotation: 90 }],
    leg_r0: ['thigh_r', { x: 40, y: 0, rotation: 90 }],
    leg_r1: ['shin_r', { x: 35, y: 0, rotation: 90 }],
    leg_l0: ['thigh_l', { x: 40, y: 0, rotation: 90 }],
    leg_l1: ['shin_l', { x: 35, y: 0, rotation: 90 }],
  };
  const order = o.order ?? SETUP;
  rig.images = 'images';
  rig.slots = order.map((n) => ({ name: n, bone: bone[n]!, attachment: att[n]![0] }));
  rig.skins = { default: Object.fromEntries(order.map((n) => [n, { [att[n]![0]]: { image: `${att[n]![0]}.png`, ...att[n]![1] } }])) };
  const text = JSON.stringify(rig, null, 2);
  writeFileSync(join(rigDir, 'rig.json'), text);
  if (o.layout !== false) {
    const doc = { spec: 'rig-parts-layout/1', rig: { file: 'rig.json', sha256: createHash('sha256').update(text).digest('hex') }, setup_slots: order, placements: o.placements ?? PLACEMENTS };
    writeFileSync(join(rigDir, 'layout.json'), JSON.stringify(doc, null, 1));
  }
  return rigDir;
}
/** The walk's map, with `layout` bindings when given. */
function writeMap(dir: string, bindings: unknown[] | null = BINDINGS): string {
  const map = JSON.parse(readFileSync(MAP, 'utf8')) as Record<string, unknown>;
  if (bindings !== null) map.layout = bindings;
  const path = join(dir, bindings === null ? 'plain.map.json' : 'layout.map.json');
  writeFileSync(path, JSON.stringify(map, null, 2));
  return path;
}

/** The front fixture's 3D motion seen by a camera in front of the figure swung `deg`° toward its right (#358's camera). */
function turned(frames: DepthFrame[], deg = TURN): DepthFrame[] {
  const [c, s] = [Math.cos(deg * RAD), Math.sin(deg * RAD)];
  return frames.map((f) => {
    const joints: Record<string, [number, number]> = {};
    const z: Record<string, number> = {};
    for (const [n, p] of Object.entries(f.joints)) {
      const [X, Y, Z] = [p[0] - 200, 400 - p[1], f.z[n]!];
      joints[n] = [200 + X * c + Z * s, 400 - Y];
      z[n] = Z * c - X * s;
    }
    return { ...f, joints, z };
  });
}
type Fixture = 'run' | 'walk' | 'run-turned' | 'walk-turned';
/** The fixture as drawn, and per frame each forearm's true forward depth Z (the mean of its elbow's and wrist's). */
function fixture(name: Fixture): { frames: DepthFrame[]; Z: Array<Record<'r' | 'l', number>>; gait: 'run' | 'walk' } {
  const gait = name.startsWith('run') ? 'run' : 'walk';
  const front = depthCycle(gait, 'front', gait === 'run' ? 3 : 2);
  const Z = front.map((f) => ({ r: (f.z.r_elbow! + f.z.r_wrist!) / 2, l: (f.z.l_elbow! + f.z.l_wrist!) / 2 }));
  return { frames: name.endsWith('turned') ? turned(front) : front, Z, gait };
}
/** A fixture through `rig-pose clean --loop --legs 1 --rest 1 --hold off --depth <gait>`. */
function cleaned(name: Fixture, dir: string): string {
  const f = fixture(name);
  const raw = join(dir, `${name}.json`);
  writeFileSync(raw, JSON.stringify(depthDoc(f.frames, `examples/walk/make-depth.ts (test/forearms.test.ts, ${name})`)));
  const path = join(dir, `${name}.clean.json`);
  const r = cli(['clean', '--pose', raw, '--out', path, '--loop', '--legs', '1', '--rest', '1', '--hold', 'off', '--depth', f.gait]);
  expect(r.status).toBe(0);
  return path;
}

interface Motion {
  animations: Record<string, { tracks: unknown[]; drawOrder?: DrawOrderKey[] }>;
}
interface GroupReport {
  limb: string;
  parts: string[];
  depth: string;
  setup: string;
  slots: string[];
  target: string[];
  keyed: boolean;
  tie: number | null;
  frames: { front: number; back: number; unread: number };
  front: Array<[number, number]>;
}
interface Report {
  frameTimes: number[];
  drawOrder?: { keys: Array<DrawOrderKey & { frame: number }>; groups?: GroupReport[]; layout?: { path: string; sha256: string }; pairs: unknown[] };
}
interface Retargeted {
  ran: Ran;
  dir: string;
  out: string;
  reportPath: string;
  motion: Motion;
  report: Report;
  seq: PoseSequence;
}
function retargeted(name: Fixture, o: RigOpts & { dir?: string; sequence?: string; flag?: boolean; bindings?: unknown[] | null } = {}): Retargeted {
  const dir = o.dir ?? tempDir();
  mkdirSync(dir, { recursive: true });
  const rig = writeRig(dir, o);
  const map = writeMap(dir, o.bindings === undefined ? BINDINGS : o.bindings);
  const sequence = o.sequence ?? cleaned(name, dir);
  const out = join(dir, `${name}.motion.json`);
  const reportPath = join(dir, `${name}.report.json`);
  const ran = cli(['retarget', '--rig', rig, '--map', map, '--sequence', sequence, '--out', out, '--name', 'go', '--report', reportPath, ...(o.flag === false ? [] : ['--draw-order', 'depth'])]);
  const ok = ran.status === 0;
  return { ran, dir, out, reportPath, seq: readPoseSequence(readFileSync(sequence, 'utf8'), sequence), motion: ok ? (JSON.parse(readFileSync(out, 'utf8')) as Motion) : { animations: {} }, report: ok ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Report) : ({} as Report) };
}

/** The setup order with a key's offsets applied, as rig-c rebuilds it (each key against the setup order). */
function applyKey(setup: readonly string[], key: DrawOrderKey | undefined): string[] {
  if (key?.offsets === undefined) return [...setup];
  const out: Array<string | undefined> = new Array(setup.length).fill(undefined);
  const moved = new Set<string>();
  for (const o of key.offsets) {
    out[setup.indexOf(o.slot) + o.offset] = o.slot;
    moved.add(o.slot);
  }
  const rest = setup.filter((s) => !moved.has(s));
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = rest.shift();
  return out as string[];
}
/** The key in force on each frame, read as the render reads it (24 fps running clock, float32 key times: rig-c/pose#325). */
function keyPerFrame(keys: readonly DrawOrderKey[], frames: number): Array<DrawOrderKey | undefined> {
  let clock = 0;
  return Array.from({ length: frames }, (_, i) => {
    if (i > 0) clock += 1 / 24;
    return [...keys].reverse().find((k) => Math.fround(k.t) <= clock);
  });
}
/** Per frame, the drawn order. */
const ordersOf = (keys: readonly DrawOrderKey[] | undefined, frames: number): string[][] => keyPerFrame(keys ?? [], frames).map((k) => applyKey(SETUP, k));
/** Per frame, whether each forearm is drawn after (in front of) its torso half. */
const forearmFront = (orders: string[][], side: 'r' | 'l'): boolean[] => orders.map((o) => o.indexOf(`arm_${side}1`) > o.indexOf(`torso_${side}`));
/** Per frame, the legs' relative order (the slots of the legs only). */
const legsOf = (orders: string[][]): string[] => orders.map((o) => o.filter((s) => s.startsWith('leg_')).join(' '));

/** The rule, read independently off the sequence: per frame, the forearm's depth (px, + toward the camera) and its tie. */
function depthSays(seq: PoseSequence, side: 'r' | 'l'): { z: Array<number | null>; tie: number } {
  const track = personTrack(seq, undefined, 'fixture');
  const seg = `${side}_forearm` as const;
  const len = (i: number) => {
    const [a, b] = [track[i]![`${side}_elbow`]!.at!, track[i]![`${side}_wrist`]!.at!];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  const rests = seq.frames.flatMap((f, i) => (f.depth?.[seg] === undefined ? [] : [len(i) / f.depth[seg]!.ratio])).sort((x, y) => x - y);
  const m = rests.length >> 1;
  const rest = rests.length % 2 === 1 ? rests[m]! : (rests[m - 1]! + rests[m]!) / 2;
  const z = seq.frames.map((f, i) => (f.depth?.[seg] === undefined ? null : Math.round(segmentDepth(f.depth[seg]!, len(i)) * 100) / 100));
  return { z, tie: Math.round(TIE * rest * 100) / 100 };
}
const front = (z: number | null, tie: number) => z !== null && z > 0 && z >= tie;

/**
 * The agreement with the generator's truth, as the legs' is read (#336: wherever the truth differs by the tie): of the
 * frames truly in front of the trunk by the tie (Z ≥ tie), how many are drawn in front; of those truly behind by it
 * (Z ≤ −tie), how many behind; and, past the tie's reach, every frame by the sign of Z alone (Z > 0, Z ≤ 0).
 */
function agreement(name: Fixture, drawn: boolean[], side: 'r' | 'l', tie: number): Record<'pastFront' | 'pastBehind' | 'inFront' | 'behind', [number, number]> {
  const Z = fixture(name).Z.map((z) => z[side]);
  const count = (pick: (z: number) => boolean, want: boolean): [number, number] => {
    const fr = Z.flatMap((z, i) => (pick(z) ? [i] : []));
    return [fr.filter((i) => drawn[i] === want).length, fr.length];
  };
  return { pastFront: count((z) => z >= tie, true), pastBehind: count((z) => z <= -tie, false), inFront: count((z) => z > 0, true), behind: count((z) => z <= 0, false) };
}

describe('bar (1): the frontal run — each forearm in front of the trunk where its depth says so, the setup order elsewhere', () => {
  test('N/N frames keyed in front for both forearms, the rest behind (setup), the legs as without a layout, every key half a frame early', () => {
    const dir = tempDir();
    const on = retargeted('run', { dir: join(dir, 'on') });
    expect(on.ran.stderr).toBe('');
    expect(on.ran.status).toBe(0);
    const n = on.report.frameTimes.length;
    const orders = ordersOf(on.motion.animations.go!.drawOrder, n);
    for (const side of ['r', 'l'] as const) {
      const says = depthSays(on.seq, side);
      const want = says.z.map((z) => front(z, says.tie));
      const got = forearmFront(orders, side);
      const N = want.filter(Boolean).length;
      const hit = want.filter((w, i) => w && got[i]).length;
      const elsewhere = want.filter((w, i) => !w && !got[i]).length;
      console.log(`  #346 bar 1 — run, ${side} forearm: depth says in front on ${N} of ${n} frames (tie ${says.tie} px); keyed in front on ${hit}/${N}; setup order (behind) on ${elsewhere}/${n - N} of the rest`);
      expect(N).toBeGreaterThan(30);
      expect(got).toEqual(want);
      const g = on.report.drawOrder!.groups!.find((x) => x.depth === `${side}_forearm`)!;
      expect(g.keyed).toBe(true);
      expect(g.tie).toBe(says.tie);
      expect(g.frames).toEqual({ front: N, back: n - N, unread: 0 });
    }
    // The legs keep the order they have without a layout.
    const off = retargeted('run', { dir: join(dir, 'off'), sequence: join(dir, 'on', 'run.clean.json'), layout: false, bindings: null });
    expect(off.ran.status).toBe(0);
    expect(legsOf(orders)).toEqual(legsOf(ordersOf(off.motion.animations.go!.drawOrder, n)));
    expect(legsOf(orders).some((l) => l !== legsOf(orders)[0])).toBe(true);
    // Every key first shows on the frame the report gives it, and none sits on a frame time (#325, #334).
    const keys = on.motion.animations.go!.drawOrder!;
    const at = keyPerFrame(keys, n);
    expect(on.report.drawOrder!.keys.map((k) => k.frame)).toEqual(keys.map((k) => at.indexOf(k)));
    const times = on.report.frameTimes;
    expect(keys.filter((k) => k.t !== 0 && times.some((t) => Math.abs(t - k.t) < 1e-9))).toEqual([]);
    const lines = linesOf(on.ran, 'DRAWORDER');
    console.log(`  #346 bar 1 — ${lines.join('\n    ')}`);
    expect(lines.filter((l) => l.includes(' by r_forearm against the trunk') || l.includes(' by l_forearm against the trunk'))).toHaveLength(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(260);
    expect(on.report.drawOrder!.layout!.sha256).toBe(sha(join(dir, 'on', 'rig', 'layout.json')));
  }, SLOW);
});

describe('the truth: the forearm\'s depth against the generator\'s, frontal and turned', () => {
  for (const name of ['run', 'run-turned', 'walk', 'walk-turned'] as const) {
    test(`${name}: never in front where the truth is behind by the tie; in front wherever it is in front by it (but the turned walk, measured); the agreement is printed`, () => {
      const r = retargeted(name);
      expect(r.ran.status).toBe(0);
      const orders = ordersOf(r.motion.animations.go!.drawOrder, r.report.frameTimes.length);
      for (const side of ['r', 'l'] as const) {
        const tie = depthSays(r.seq, side).tie;
        const a = agreement(name, forearmFront(orders, side), side, tie);
        const z = fixture(name).Z.map((x) => x[side]);
        const wrong = z.flatMap((v, i) => (v <= 0 && forearmFront(orders, side)[i] ? [`${i} (Z ${v.toFixed(1)})`] : []));
        console.log(`  #346 truth — ${name}, ${side} forearm (tie ${tie} px): truly in front by the tie drawn in front ${a.pastFront[0]}/${a.pastFront[1]}, truly behind by the tie drawn behind ${a.pastBehind[0]}/${a.pastBehind[1]}; by the sign alone: Z > 0 drawn in front ${a.inFront[0]}/${a.inFront[1]}, Z ≤ 0 drawn behind ${a.behind[0]}/${a.behind[1]}${wrong.length === 0 ? '' : ` (drawn in front while behind: frames ${wrong.join(', ')})`}`);
        // Measured: seen turned, the walk's forearm leans ~20 px forward on 4 frames, but drawn turned it is
        // foreshortened less than the tie needs: it stays behind (the rule errs toward the setup order, never forward).
        expect(a.pastFront).toEqual(name === 'walk-turned' ? [0, 4] : [a.pastFront[1], a.pastFront[1]]);
        expect(a.pastBehind[0]).toBe(a.pastBehind[1]);
        // Drawn in front only where the truth is in front or within the tie of the trunk.
        expect(z.filter((v, i) => v < -tie && forearmFront(orders, side)[i])).toEqual([]);
      }
    }, SLOW);
  }
});

describe('bar (2): a walk on which no forearm passes the tie writes the same motion with and without a layout', () => {
  test('the turned walk: no forearm frame passes, the motion bytes are equal; the frontal walk: forearms keyed, the legs unchanged', () => {
    const dir = tempDir();
    const on = retargeted('walk-turned', { dir: join(dir, 'on') });
    expect(on.ran.status).toBe(0);
    for (const g of on.report.drawOrder!.groups!) expect(g.frames.front).toBe(0);
    const off = retargeted('walk-turned', { dir: join(dir, 'off'), sequence: join(dir, 'on', 'walk-turned.clean.json'), layout: false, bindings: null });
    expect(off.ran.status).toBe(0);
    console.log(`  #346 bar 2 — turned walk, no forearm past the tie: motion sha256 with the layout ${sha(on.out)}, without ${sha(off.out)}`);
    expect(readFileSync(on.out, 'utf8')).toBe(readFileSync(off.out, 'utf8'));
    // The frontal walk does lean its forearms past the tie: they are keyed, and the legs keep their order.
    const fOn = retargeted('walk', { dir: join(dir, 'fon') });
    const fOff = retargeted('walk', { dir: join(dir, 'foff'), sequence: join(dir, 'fon', 'walk.clean.json'), layout: false, bindings: null });
    const n = fOn.report.frameTimes.length;
    const fronts = fOn.report.drawOrder!.groups!.map((g) => g.frames.front);
    console.log(`  #346 bar 2 — frontal walk: forearms in front on ${fronts.join(' and ')} of ${n} frames`);
    expect(Math.min(...fronts)).toBeGreaterThan(0);
    expect(legsOf(ordersOf(fOn.motion.animations.go!.drawOrder, n))).toEqual(legsOf(ordersOf(fOff.motion.animations.go!.drawOrder, n)));
  }, SLOW);
});

describe('bar (3): without the flag nothing changes', () => {
  test('a layout beside the rig and a binding in the map, no --draw-order: the motion and the report are byte for byte those with neither', () => {
    const dir = tempDir();
    const seqDir = join(dir, 'seq');
    mkdirSync(seqDir);
    const sequence = cleaned('run', seqDir);
    // The same paths for both, so the report's input paths agree: only the layout beside the rig differs.
    const run = (withLayout: boolean): { motion: string; report: string } => {
      const d = join(dir, 'same');
      rmSync(d, { recursive: true, force: true });
      const r = retargeted('run', { dir: d, sequence, flag: false, layout: withLayout, bindings: null });
      expect(r.ran.status).toBe(0);
      expect(existsSync(join(d, 'rig', 'layout.json'))).toBe(withLayout);
      return { motion: readFileSync(r.out, 'utf8'), report: readFileSync(r.reportPath, 'utf8') };
    };
    const plain = run(false);
    const withLayout = run(true);
    expect(withLayout.motion).toBe(plain.motion);
    expect(withLayout.report).toBe(plain.report);
    expect(plain.motion).not.toContain('"drawOrder"');
    // A binding in the map is read (and checked) but changes nothing without the flag.
    const b = retargeted('run', { dir: join(dir, 'bound'), sequence, flag: false });
    expect(b.ran.status).toBe(0);
    expect(readFileSync(b.out, 'utf8')).toBe(plain.motion);
  }, SLOW);
});

describe('bar (4): refusals by name', () => {
  test('a layout and no binding in the map: LAYOUT_UNBOUND, each placement named, nothing written', () => {
    const r = retargeted('run', { bindings: null });
    expect(r.ran.status).toBe(1);
    console.log(`  #346 bar 4 — ${r.ran.stderr.trim().split('\n').join('\n    ')}`);
    expect(r.ran.stderr).toContain('LAYOUT_UNBOUND: ');
    expect(r.ran.stderr).toContain('places arm_r [forearm_r] before part "torso_r", and ');
    expect(r.ran.stderr).toContain('places arm_l [forearm_l] before part "torso_l", and ');
    expect(r.ran.stderr).toContain('binds no depth source for it: --draw-order depth keys a group only by the source its map names');
    expect(r.ran.stderr).toContain('no source is taken from a name, a nearest bone or a zero depth');
    expect(existsSync(r.out)).toBe(false);
    // One placement bound, the other not: the other is named.
    const one = retargeted('run', { bindings: [BINDINGS[0]] });
    expect(one.ran.status).toBe(1);
    expect(one.ran.stderr).toContain('places arm_l [forearm_l]');
    expect(one.ran.stderr).not.toContain('places arm_r [forearm_r]');
  }, SLOW);

  test('a layout bound to other rig bytes: LAYOUT_RIG_SHA; a binding with no layout: LAYOUT_MISSING; a binding no placement has: LAYOUT_BINDING_UNKNOWN', () => {
    const dir = tempDir();
    const seqDir = join(dir, 'seq');
    mkdirSync(seqDir);
    const sequence = cleaned('run', seqDir);
    const rigDir = writeRig(join(dir, 'stale'));
    const rigPath = join(rigDir, 'rig.json');
    writeFileSync(rigPath, `${readFileSync(rigPath, 'utf8')}\n`);
    const map = writeMap(join(dir, 'stale'));
    const stale = cli(['retarget', '--rig', rigDir, '--map', map, '--sequence', sequence, '--out', join(dir, 'stale.json'), '--name', 'go', '--draw-order', 'depth']);
    console.log(`  #346 bar 4 — ${stale.stderr.trim()}`);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(`LAYOUT_RIG_SHA: ${join(rigDir, 'layout.json')} is bound to rig.json sha256 `);
    expect(stale.stderr).toContain(`and ${rigPath} is ${sha(rigPath)}: the layout was written for other rig bytes (rig-parts rig writes both); a stale layout is not read`);
    expect(existsSync(join(dir, 'stale.json'))).toBe(false);
    const missing = retargeted('run', { dir: join(dir, 'missing'), sequence, layout: false });
    expect(missing.ran.status).toBe(1);
    expect(missing.ran.stderr).toContain('LAYOUT_MISSING: ');
    expect(missing.ran.stderr).toContain('binds arm_r [forearm_r], arm_l [forearm_l] in "layout", and there is no ');
    // arm_x takes the left forearm's source: arm_l is unbound and arm_x unknown, both named.
    const unknown = retargeted('run', { dir: join(dir, 'unknown'), sequence, bindings: [BINDINGS[0], { limb: 'arm_x', parts: ['forearm_x'], depth: 'l_forearm', against: 'trunk' }] });
    expect(unknown.ran.status).toBe(1);
    expect(unknown.ran.stderr).toContain('LAYOUT_BINDING_UNKNOWN: ');
    expect(unknown.ran.stderr).toContain('binds arm_x [forearm_x], and ');
  }, SLOW);

  test('an unsupported depth source or target is refused when the map is read (MAP_LAYOUT); a slot not on the source\'s bone: LAYOUT_BINDING_BONES; blocks not adjacent: LAYOUT_ADJACENCY', () => {
    const dir = tempDir();
    const seqDir = join(dir, 'seq');
    mkdirSync(seqDir);
    const sequence = cleaned('run', seqDir);
    const shin = retargeted('run', { dir: join(dir, 'shin'), sequence, bindings: [{ ...BINDINGS[0], depth: 'r_shin' }, BINDINGS[1]] });
    expect(shin.ran.status).toBe(1);
    expect(shin.ran.stderr).toContain('MAP_LAYOUT: ');
    expect(shin.ran.stderr).toContain('"depth" is the string "r_shin"; the depth sources --draw-order depth keys a group by are r_forearm, l_forearm (a forearm against the trunk, rig-c/pose#346): a group with no supported source is not keyed by a guess');
    const against = retargeted('run', { dir: join(dir, 'against'), sequence, bindings: [{ ...BINDINGS[0], against: 'arm_l' }, BINDINGS[1]] });
    expect(against.ran.stderr).toContain('"against" is the string "arm_l"; it must be "trunk"');
    // The right forearm bound to the left forearm's depth: its slot hangs on the right sleeve, not the left.
    const crossed = retargeted('run', { dir: join(dir, 'crossed'), sequence, bindings: [{ ...BINDINGS[0], depth: 'l_forearm' }, { ...BINDINGS[1], depth: 'r_forearm' }] });
    console.log(`  #346 bar 4 — ${crossed.ran.stderr.trim().split('\n')[0]}`);
    expect(crossed.ran.status).toBe(1);
    expect(crossed.ran.stderr).toContain('LAYOUT_BINDING_BONES: arm_r [forearm_r] (bound to l_forearm against the trunk): slot(s) "arm_r1" on bone "sleeve_r1" hang on neither bone "sleeve_l1" (the map\'s l_forearm) nor under it');
    // The layout says before, the rig draws the torso half first: the producer's word is not taken.
    const swapped = SETUP.map((s) => (s === 'arm_r1' ? 'torso_r' : s === 'torso_r' ? 'arm_r1' : s));
    const apart = retargeted('run', { dir: join(dir, 'apart'), sequence, order: swapped });
    expect(apart.ran.status).toBe(1);
    expect(apart.ran.stderr).toContain('LAYOUT_ADJACENCY: ');
    expect(apart.ran.stderr).toContain('arm_r [forearm_r] before part "torso_r": the group is not drawn immediately before its target in the rig\'s draw order');
  }, SLOW);
});

describe('bar (5): a real rig-parts-layout/1, written by parts 1.56.0', () => {
  test('its public limb fixture\'s layout (the forearm before an unrelated part) is read whole; against other rig bytes it is refused', () => {
    const dir = tempDir();
    cpSync(PRODUCER, dir, { recursive: true });
    const l = readLayout(join(dir, 'rig.json'))!;
    expect(l.placements).toEqual([{ limb: 'arm_r', parts: ['forearm_r'], before: { part: 'screen' }, slots: ['forearm_r'], target_slots: ['screen'] }]);
    expect(l.setup).toEqual(['foot_r', 'shin_r', 'thigh_r', 'crest_r', 'foot_l', 'shin_l', 'thigh_l', 'crest_l', 'upperarm_r', 'forearm_r', 'screen']);
    expect(l.sha256).toBe(sha(join(PRODUCER, 'layout.json')));
    const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as { name: string };
    writeFileSync(join(dir, 'rig.json'), JSON.stringify({ ...rig, name: 'other' }, null, 1));
    let message = '';
    try {
      readLayout(join(dir, 'rig.json'));
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      message = e.message;
    }
    expect(message).toContain('LAYOUT_RIG_SHA: ');
    expect(message).toContain('is bound to rig.json sha256 79cdf148d72663be5dea196d4ea86eb0d6f4464eeb65e6fd7134df2ccad33fc7');
    // A sets.json beside a layout bound to none.
    cpSync(join(PRODUCER, 'rig.json'), join(dir, 'rig.json'));
    writeFileSync(join(dir, 'sets.json'), '{"spec":"rig-parts-sets/1","sets":{}}');
    expect(() => readLayout(join(dir, 'rig.json'))).toThrow(/LAYOUT_SETS_SHA: .* is bound to no sets\.json/);
  });
});

describe('bar (6): a mutant without the forearm writer keys no forearm', () => {
  test('the writer\'s front rule removed: the frames the depth says are in front are drawn behind', async () => {
    const ref = retargeted('run');
    expect(ref.ran.status).toBe(0);
    const n = ref.report.frameTimes.length;
    const real = forearmFront(ordersOf(ref.motion.animations.go!.drawOrder, n), 'r').filter(Boolean).length;
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm346-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'layout.ts');
      const src = readFileSync(path, 'utf8');
      const from = "v > 0 && v >= tie ? 'front' : 'back'";
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, "'back'"));
      const m = (await import(path)) as { keyGroups: typeof keyGroups; readLayout: typeof readLayout; resolveGroups: (typeof import('../src/layout.ts'))['resolveGroups'] };
      const { readMap } = (await import(join(d, 'src', 'map.ts'))) as typeof import('../src/map.ts');
      const map = readMap(readFileSync(join(ref.dir, 'layout.map.json'), 'utf8'), 'map');
      const wave = JSON.parse(readFileSync(WAVE, 'utf8')) as { bones: Array<{ name: string; parent?: string }> };
      const rest = new Map(wave.bones.map((b) => [b.name, { parent: b.parent ?? null }])) as unknown as import('../src/map.ts').Rest;
      const order = SETUP.map((s) => ({ name: s, bone: ({ torso_r: 'chest', torso_l: 'chest', arm_r0: 'sleeve_r0', arm_r1: 'sleeve_r1', arm_l0: 'sleeve_l0', arm_l1: 'sleeve_l1' } as Record<string, string>)[s] ?? s }));
      const layout = m.readLayout(join(ref.dir, 'rig', 'rig.json'))!;
      const track = personTrack(ref.seq, undefined, 'run');
      const depth = ref.seq.frames.map((f) => f.depth);
      const legs = { pairs: [], keys: [], spans: [] };
      const pure = (mod: typeof m) => {
        const res = mod.resolveGroups(layout, map.layout!, map, rest, order, []);
        expect(res.problems.any).toBe(false);
        const k = mod.keyGroups(legs, res.groups, track, depth, ref.report.frameTimes, order);
        return forearmFront(ordersOf(k.reading.keys, n), 'r').filter(Boolean).length;
      };
      const control = pure((await import('../src/layout.ts')) as typeof m);
      const mutant = pure(m);
      console.log(`  #346 bar 6 — the right forearm in front on ${real} frames in the run, ${control} by the pure writer, ${mutant} by the mutant without its front rule`);
      expect(control).toBe(real);
      expect(real).toBeGreaterThan(30);
      expect(mutant).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

/**
 * AGENTS.md: a gate nobody has seen fail is not a gate. Every refusal code this card adds, planted by one change beside
 * the unchanged control (which must refuse nothing), and each check removed in a mutant (its `p.add` made a no-op, or
 * the parse error swallowed), under which the planted input no longer carries that code.
 */
describe('every #346 refusal: one planted change beside its control, and a mutant without the check', () => {
  type Mod = { readLayout: typeof readLayout; bindingProblems: typeof bindingProblems; resolveGroups: typeof resolveGroups; readMap: typeof readMap };
  /** The codes a call refuses with (thrown, or a Problems it returns), sorted; [] when it refuses nothing. */
  const codesOf = (run: () => unknown): string[] => {
    try {
      const r = run();
      if (r !== null && typeof r === 'object' && 'list' in r) return [...new Set((r as { list: Array<{ code: string }> }).list.map((x) => x.code))].sort();
      return [];
    } catch (e) {
      if (e instanceof Refusal || (e as Error).name === 'Refusal') return [...new Set((e as Refusal).problems.map((x) => x.code))].sort();
      throw e;
    }
  };
  /** The real parts 1.56.0 companion, copied; `plant` changes one thing in the copy. */
  const producer = (plant?: (dir: string) => void): string => {
    const dir = tempDir();
    cpSync(PRODUCER, dir, { recursive: true });
    plant?.(dir);
    return join(dir, 'rig.json');
  };
  const editLayout = (dir: string, edit: (doc: Record<string, unknown>) => void): void => {
    const doc = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as Record<string, unknown>;
    edit(doc);
    writeFileSync(join(dir, 'layout.json'), JSON.stringify(doc, null, 1));
  };
  const PRODUCER_BINDING = [{ limb: 'arm_r', parts: ['forearm_r'], depth: 'r_forearm' as const, against: 'trunk' as const }];
  /** The pose-side inputs of resolveGroups on this file's rig: its layout, the bound map, the wave's bones, the setup order with bones. */
  const BONE: Record<string, string> = { torso_r: 'chest', torso_l: 'chest', arm_r0: 'sleeve_r0', arm_r1: 'sleeve_r1', arm_l0: 'sleeve_l0', arm_l1: 'sleeve_l1' };
  const resolveInputs = (m: Mod) => {
    const dir = tempDir();
    const rigDir = writeRig(dir);
    const map = m.readMap(readFileSync(writeMap(dir), 'utf8'), 'map');
    const wave = JSON.parse(readFileSync(WAVE, 'utf8')) as { bones: Array<{ name: string; parent?: string }> };
    const rest = new Map(wave.bones.map((b) => [b.name, { parent: b.parent ?? null }])) as unknown as Rest;
    const order = SETUP.map((n) => ({ name: n, bone: BONE[n] ?? n }));
    return { layout: m.readLayout(join(rigDir, 'rig.json'))!, map, rest, order };
  };
  const mapText = (layout: unknown): string => JSON.stringify({ ...(JSON.parse(readFileSync(MAP, 'utf8')) as object), layout });
  const withoutAdd = (code: string) => ({ file: code === 'MAP_LAYOUT' ? 'layoutmap.ts' : 'layout.ts', from: `p.add('${code}',`, to: `void ('${code}',` });
  const CASES: Array<{ code: string; name: string; change: string; control: (m: Mod) => string[]; planted: (m: Mod) => string[]; mutant: { file: string; from: string; to: string } }> = [
    {
      code: 'LAYOUT_JSON', name: 'a companion that is not JSON', change: 'layout.json\'s last byte cut off',
      control: (m) => codesOf(() => m.readLayout(producer())),
      planted: (m) => codesOf(() => m.readLayout(producer((d) => writeFileSync(join(d, 'layout.json'), readFileSync(join(d, 'layout.json'), 'utf8').trimEnd().slice(0, -1))))),
      mutant: { file: 'layout.ts', from: "parseJson(bytes.toString('utf8'), path, 'LAYOUT_JSON')", to: "(() => { try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return {}; } })()" },
    },
    {
      code: 'LAYOUT_SPEC', name: 'another spec', change: '"spec" "rig-parts-layout/2"',
      control: (m) => codesOf(() => m.readLayout(producer())),
      planted: (m) => codesOf(() => m.readLayout(producer((d) => editLayout(d, (x) => (x.spec = 'rig-parts-layout/2'))))),
      mutant: withoutAdd('LAYOUT_SPEC'),
    },
    {
      code: 'LAYOUT_SHAPE', name: 'a placement without its target', change: 'placements[0].target_slots deleted',
      control: (m) => codesOf(() => m.readLayout(producer())),
      planted: (m) => codesOf(() => m.readLayout(producer((d) => editLayout(d, (x) => delete (x.placements as Array<Record<string, unknown>>)[0]!.target_slots)))),
      mutant: withoutAdd('LAYOUT_SHAPE'),
    },
    {
      code: 'LAYOUT_RIG_SHA', name: 'other rig bytes', change: 'a newline appended to rig.json (same slots)',
      control: (m) => codesOf(() => m.readLayout(producer())),
      planted: (m) => codesOf(() => m.readLayout(producer((d) => writeFileSync(join(d, 'rig.json'), `${readFileSync(join(d, 'rig.json'), 'utf8')}\n`)))),
      mutant: withoutAdd('LAYOUT_RIG_SHA'),
    },
    {
      code: 'LAYOUT_SETS_SHA', name: 'a sets.json beside a layout bound to none', change: 'a sets.json written beside the rig',
      control: (m) => codesOf(() => m.readLayout(producer())),
      planted: (m) => codesOf(() => m.readLayout(producer((d) => writeFileSync(join(d, 'sets.json'), '{"spec":"rig-parts-sets/1","sets":{}}')))),
      mutant: withoutAdd('LAYOUT_SETS_SHA'),
    },
    {
      code: 'LAYOUT_SETS_SHA', name: 'a layout bound to other set bytes', change: '"sets" sha256 of other bytes (sets.json beside, the rig hash kept)',
      control: (m) => codesOf(() => m.readLayout(producer((d) => {
        const text = '{"spec":"rig-parts-sets/1","sets":{}}';
        writeFileSync(join(d, 'sets.json'), text);
        editLayout(d, (x) => (x.sets = { file: 'sets.json', sha256: createHash('sha256').update(text).digest('hex') }));
      }))),
      planted: (m) => codesOf(() => m.readLayout(producer((d) => {
        writeFileSync(join(d, 'sets.json'), '{"spec":"rig-parts-sets/1","sets":{}}');
        editLayout(d, (x) => (x.sets = { file: 'sets.json', sha256: createHash('sha256').update('other').digest('hex') }));
      }))),
      mutant: withoutAdd('LAYOUT_SETS_SHA'),
    },
    {
      code: 'LAYOUT_SETUP', name: 'setup_slots out of the rig\'s order', change: 'the last two setup_slots swapped (the rig hash kept)',
      control: (m) => codesOf(() => m.readLayout(producer())),
      planted: (m) => codesOf(() => m.readLayout(producer((d) => editLayout(d, (x) => {
        const s = x.setup_slots as string[];
        [s[s.length - 2], s[s.length - 1]] = [s[s.length - 1]!, s[s.length - 2]!];
      })))),
      mutant: withoutAdd('LAYOUT_SETUP'),
    },
    {
      code: 'MAP_LAYOUT', name: 'an unsupported depth source', change: 'one binding\'s "depth" "r_shin"',
      control: (m) => codesOf(() => m.readMap(mapText(BINDINGS), 'map')),
      planted: (m) => codesOf(() => m.readMap(mapText([{ ...BINDINGS[0], depth: 'r_shin' }, BINDINGS[1]]), 'map')),
      mutant: withoutAdd('MAP_LAYOUT'),
    },
    {
      code: 'LAYOUT_UNBOUND', name: 'a placement the map does not bind', change: 'the map\'s "layout" left out',
      control: (m) => codesOf(() => m.bindingProblems(m.readLayout(producer()), PRODUCER_BINDING, 'rig.json', 'map')),
      planted: (m) => codesOf(() => m.bindingProblems(m.readLayout(producer()), undefined, 'rig.json', 'map')),
      mutant: withoutAdd('LAYOUT_UNBOUND'),
    },
    {
      code: 'LAYOUT_MISSING', name: 'a binding with no layout beside the rig', change: 'layout.json removed',
      control: (m) => codesOf(() => m.bindingProblems(m.readLayout(producer()), PRODUCER_BINDING, 'rig.json', 'map')),
      planted: (m) => codesOf(() => m.bindingProblems(m.readLayout(producer((d) => rmSync(join(d, 'layout.json')))), PRODUCER_BINDING, 'rig.json', 'map')),
      mutant: withoutAdd('LAYOUT_MISSING'),
    },
    {
      code: 'LAYOUT_BINDING_UNKNOWN', name: 'a binding no placement has', change: 'a second binding, arm_x [forearm_x] → l_forearm',
      control: (m) => codesOf(() => m.bindingProblems(m.readLayout(producer()), PRODUCER_BINDING, 'rig.json', 'map')),
      planted: (m) => codesOf(() => m.bindingProblems(m.readLayout(producer()), [...PRODUCER_BINDING, { limb: 'arm_x', parts: ['forearm_x'], depth: 'l_forearm', against: 'trunk' }], 'rig.json', 'map')),
      mutant: withoutAdd('LAYOUT_BINDING_UNKNOWN'),
    },
    {
      code: 'LAYOUT_ADJACENCY', name: 'a group not next to its target in the compiled order', change: 'the compiled order with arm_r1 and torso_r swapped (the layout unchanged)',
      control: (m) => {
        const x = resolveInputs(m);
        return codesOf(() => m.resolveGroups(x.layout, x.map.layout!, x.map, x.rest, x.order, []).problems);
      },
      planted: (m) => {
        const x = resolveInputs(m);
        const swapped = x.order.map((o) => (o.name === 'arm_r1' ? x.order[3]! : o.name === 'torso_r' ? x.order[2]! : o));
        return codesOf(() => m.resolveGroups(x.layout, x.map.layout!, x.map, x.rest, swapped, []).problems);
      },
      mutant: withoutAdd('LAYOUT_ADJACENCY'),
    },
    {
      code: 'LAYOUT_BINDING_BONES', name: 'a group slot not on its source\'s bone', change: 'arm_r bound to l_forearm (one field)',
      control: (m) => {
        const x = resolveInputs(m);
        return codesOf(() => m.resolveGroups(x.layout, x.map.layout!, x.map, x.rest, x.order, []).problems);
      },
      planted: (m) => {
        const x = resolveInputs(m);
        return codesOf(() => m.resolveGroups(x.layout, [{ ...x.map.layout![0]!, depth: 'l_forearm' }, x.map.layout![1]!], x.map, x.rest, x.order, []).problems);
      },
      mutant: { file: 'layout.ts', from: "if (off.length > 0) p.add('LAYOUT_BINDING_BONES',", to: "if (off.length > 0) void ('LAYOUT_BINDING_BONES'," },
    },
    {
      code: 'LAYOUT_BINDING_BONES', name: 'a target slot on a limb', change: 'torso_r\'s bone given as sleeve_l0 in the compiled order',
      control: (m) => {
        const x = resolveInputs(m);
        return codesOf(() => m.resolveGroups(x.layout, x.map.layout!, x.map, x.rest, x.order, []).problems);
      },
      planted: (m) => {
        const x = resolveInputs(m);
        return codesOf(() => m.resolveGroups(x.layout, x.map.layout!, x.map, x.rest, x.order.map((o) => (o.name === 'torso_r' ? { ...o, bone: 'sleeve_l0' } : o)), []).problems);
      },
      mutant: { file: 'layout.ts', from: "if (limbTarget.length > 0) p.add('LAYOUT_BINDING_BONES',", to: "if (limbTarget.length > 0) void ('LAYOUT_BINDING_BONES'," },
    },
  ];
  const real: Mod = { readLayout, bindingProblems, resolveGroups, readMap };
  for (const c of CASES) {
    test(`${c.code}: ${c.name} — the control refuses nothing, the plant (${c.change}) refuses with ${c.code} alone; mutant: without the check it does not`, async () => {
      expect(c.control(real)).toEqual([]);
      expect(c.planted(real)).toEqual([c.code]);
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm346-gate-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        const path = join(d, 'src', c.mutant.file);
        const src = readFileSync(path, 'utf8');
        expect(src.split(c.mutant.from).length).toBeGreaterThan(1);
        writeFileSync(path, src.split(c.mutant.from).join(c.mutant.to));
        const lay = (await import(join(d, 'src', 'layout.ts'))) as Mod;
        const mp = (await import(join(d, 'src', 'map.ts'))) as Pick<Mod, 'readMap'>;
        const mut: Mod = { readLayout: lay.readLayout, bindingProblems: lay.bindingProblems, resolveGroups: lay.resolveGroups, readMap: mp.readMap };
        const got = c.planted(mut);
        console.log(`  #346 gate — ${c.code} (${c.name}): control [], planted [${c.planted(real).join(', ')}], mutant without the check [${got.join(', ')}]`);
        expect(got).not.toContain(c.code);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });
  }
});
