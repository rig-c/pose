/**
 * rig-c/pose#304: `retarget --draw-order depth` keys rig-c's `drawOrder`
 * timeline from the sequence's derived depth: the leg that reads farther from
 * the camera is drawn behind the other, a frame inside the tie holding the order
 * before. rig-c/pose#336: the depth is read at the joint the owner's statement
 * for the gait names — a walk's lifted foot is behind the supporting leg (the
 * ankle), a run's lifted leg is in front, its knee protruding (the knee).
 *
 * The fixtures are #281's (examples/walk/make-depth.ts): the frontal run in place
 * (the swinging shin kicked back to 0.41 of its length while the raised thigh
 * brings the knee forward) and the frontal walk in place (the lifted foot
 * behind), cleaned with `--depth`, retargeted onto a synthetic limb-cut rig whose
 * leg slots overlap in the draw order — the left leg drawn first at setup. The
 * bars (#336): (1) on the run, the lifted leg is drawn in front on every frame
 * one leg is lifted (#343: its knee protrudes from toe-off), and the order
 * agrees with the generator's knees wherever they differ by the tie; (2) on the walk, the lifted leg is drawn behind on
 * every lifted frame, and the order agrees with the generator's ankles; (3)
 * without the flag nothing changes (the sha256 table is the PR's evidence; here,
 * the control's own output); (4) the render at the run's frame 5 draws no pixel
 * of the standing right leg over the lifted left leg; (5) two runs are
 * byte-equal.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plate, readPlate } from '@rig-c/core/plate';
import { depthDoc, FIXTURES, trueJointOrder, type DepthFrame } from '../examples/walk/make-depth.ts';
import { layersOf, limbJointDepths } from '../src/depth.ts';
import { drawOrderFromDepth, drawOrderLines, type DrawOrderKey } from '../src/draworder.ts';
import { readMap, type JointMap, type Rest } from '../src/map.ts';
import { personTrack, readPoseSequence, type PoseSequence } from '../src/pose.ts';
import { rigcCli } from '../src/rigc.ts';
import { keysOnFrameTimes, type MotionDoc } from './discrete.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const WAVE = join(ROOT, 'examples', 'wave', 'rig', 'rig.json');
const MAP = join(ROOT, 'examples', 'walk', 'map.json');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const SLOW = 180_000;

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-draworder-'));
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

/** The colours: the right leg red, the left blue, the torso green. */
const RED: [number, number, number, number] = [220, 60, 60, 255];
const RED_SHIN: [number, number, number, number] = [150, 30, 30, 255];
const BLUE: [number, number, number, number] = [60, 100, 230, 255];
const BLUE_SHIN: [number, number, number, number] = [30, 50, 150, 255];

interface RigOpts {
  /** The slot order (default: torso, the left leg, the right leg — the legs overlapping, the left drawn first). */
  order?: string[];
}
/** The walk's figure (examples/wave/rig) with a torso and four leg slots; returns the rig directory. */
function writeRig(dir: string, o: RigOpts = {}): string {
  const rigDir = join(dir, 'rig');
  mkdirSync(join(rigDir, 'images'), { recursive: true });
  const img = (name: string, w: number, h: number, c: [number, number, number, number]) => {
    const p = new Plate(w, h);
    p.rect(0, 0, w, h, c);
    p.writePng(join(rigDir, 'images', `${name}.png`));
  };
  img('torso', 60, 160, [90, 160, 90, 255]);
  img('thigh_r', 24, 84, RED);
  img('shin_r', 24, 74, RED_SHIN);
  img('thigh_l', 24, 84, BLUE);
  img('shin_l', 24, 74, BLUE_SHIN);
  const rig = JSON.parse(readFileSync(WAVE, 'utf8')) as Record<string, unknown>;
  const slot: Record<string, Record<string, unknown>> = {
    torso: { name: 'torso', bone: 'chest', attachment: 'torso' },
    leg_l0: { name: 'leg_l0', bone: 'leg_l0', attachment: 'thigh_l' },
    leg_l1: { name: 'leg_l1', bone: 'leg_l1', attachment: 'shin_l' },
    leg_r0: { name: 'leg_r0', bone: 'leg_r0', attachment: 'thigh_r' },
    leg_r1: { name: 'leg_r1', bone: 'leg_r1', attachment: 'shin_r' },
  };
  const order = o.order ?? ['torso', 'leg_l0', 'leg_l1', 'leg_r0', 'leg_r1'];
  rig.images = 'images';
  rig.slots = order.map((n) => slot[n]!);
  rig.skins = {
    default: {
      torso: { torso: { image: 'torso.png', x: 0, y: 0 } },
      leg_r0: { thigh_r: { image: 'thigh_r.png', x: 40, y: 0, rotation: 90 } },
      leg_r1: { shin_r: { image: 'shin_r.png', x: 35, y: 0, rotation: 90 } },
      leg_l0: { thigh_l: { image: 'thigh_l.png', x: 40, y: 0, rotation: 90 } },
      leg_l1: { shin_l: { image: 'shin_l.png', x: 35, y: 0, rotation: 90 } },
    },
  };
  writeFileSync(join(rigDir, 'rig.json'), JSON.stringify(rig, null, 2));
  return rigDir;
}

/** A fixture through `rig-pose clean --loop --legs 1 --rest 1 --hold off [--depth gait]`. */
function cleaned(frames: DepthFrame[], gait: 'walk' | 'run' | null, dir: string, name: string): string {
  const raw = join(dir, `${name}.json`);
  writeFileSync(raw, JSON.stringify(depthDoc(frames, 'examples/walk/make-depth.ts (test/draworder.test.ts)')));
  const path = join(dir, `${name}.clean.json`);
  const r = cli(['clean', '--pose', raw, '--out', path, '--loop', '--legs', '1', '--rest', '1', '--hold', 'off', ...(gait === null ? [] : ['--depth', gait])]);
  expect(r.status).toBe(0);
  return path;
}

interface Motion {
  animations: Record<string, { duration: number; tracks: unknown[]; drawOrder?: DrawOrderKey[] }>;
}
interface Report {
  frameTimes: number[];
  options: Record<string, unknown>;
  feet: { supports: Array<{ side: 'r' | 'l'; frames: [number, number] }>; changes: Array<{ frame: number; from: string | null; to: string }> };
  layers: Array<{ frame: number; depth: Record<string, number> }>;
  drawOrder?: { source: string; pairs: Array<{ a: string; b: string; limbs: string[]; keyed: boolean; tie: number | null; by?: string; why?: string; slots: { a: string[]; b: string[] } }>; keys: Array<DrawOrderKey & { frame: number }>; spans: Array<{ behind: string; front: string; frames: [number, number]; keyed: boolean }> };
}

/** The setup slot order with a key's offsets applied, as rig-c's parser rebuilds it (each key against the setup order). */
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
/** The render's frame rate (bar 4's `--fps 24`, the fixtures' rate). */
const RENDER_FPS = 24;
/**
 * The key in force on each frame, read the way the render reads it (rig-c/pose#325): the track time of frame `i`
 * is the running sum of `i` steps of 1/fps (rig-c's `render`, as spine's AnimationState), each key's time is held
 * as float32, and a key applies when its time ≤ the track time — no epsilon. A key written exactly on a frame
 * time is a tie this reading breaks the way the render does, so a late key shows here.
 */
function keyPerFrame<K extends DrawOrderKey>(keys: readonly K[], frames: number): Array<K | undefined> {
  let clock = 0;
  return Array.from({ length: frames }, (_, i) => {
    if (i > 0) clock += 1 / RENDER_FPS;
    return [...keys].reverse().find((k) => Math.fround(k.t) <= clock);
  });
}
/**
 * The motion's keys that do not first show on the frame the report gives them (`keyFrames`, one per key, in order)
 * under the render's reading: "frame f (t=…): shows on g".
 */
function keysOffFrame(keys: readonly DrawOrderKey[], keyFrames: readonly number[], frames: number): string[] {
  const on = keyPerFrame(keys, frames);
  expect(keyFrames).toHaveLength(keys.length);
  return keys.flatMap((k, i) => {
    const first = on.indexOf(k);
    return first === keyFrames[i] ? [] : [`frame ${keyFrames[i]} (t=${k.t}): shows on ${first}`];
  });
}
/** Per frame, which leg the keyed order draws behind: 'r' when the right leg's slots are all before the left's. */
function behindPerFrame(setup: readonly string[], keys: readonly DrawOrderKey[], times: readonly number[]): Array<'r' | 'l'> {
  const on = keyPerFrame(keys, times.length);
  return times.map((t, i) => {
    const key = on[i];
    const o = applyKey(setup, key);
    const r = ['leg_r0', 'leg_r1'].map((s) => o.indexOf(s));
    const l = ['leg_l0', 'leg_l1'].map((s) => o.indexOf(s));
    return Math.max(...r) < Math.min(...l) ? 'r' : Math.max(...l) < Math.min(...r) ? 'l' : (() => { throw new Error(`frame at ${t}: the legs interleave`); })();
  });
}

interface Retargeted {
  ran: Ran;
  dir: string;
  motion: Motion;
  report: Report;
  seq: PoseSequence;
  out: string;
  build: string;
}
function retargeted(name: 'run' | 'walk', flag: boolean, o: RigOpts & { dir?: string; sequence?: string } = {}): Retargeted {
  const dir = o.dir ?? tempDir();
  const rig = writeRig(dir, o);
  const sequence = o.sequence ?? cleaned(FIXTURES[name](), name, dir, name);
  const out = join(dir, `${name}.motion.json`);
  const report = join(dir, `${name}.report.json`);
  const build = join(dir, `${name}.build`);
  const ran = cli(['retarget', '--rig', rig, '--map', MAP, '--sequence', sequence, '--out', out, '--name', name, '--report', report, '--build', build, ...(flag ? ['--draw-order', 'depth'] : [])]);
  const ok = ran.status === 0;
  return { ran, dir, out, build, seq: readPoseSequence(readFileSync(sequence, 'utf8'), sequence), motion: ok ? (JSON.parse(readFileSync(out, 'utf8')) as Motion) : { animations: {} }, report: ok ? (JSON.parse(readFileSync(report, 'utf8')) as Report) : ({} as Report) };
}

const SETUP = ['torso', 'leg_l0', 'leg_l1', 'leg_r0', 'leg_r1'];
/** The DRAWORDER lines and the run's knee tie on the fixtures (#336), as measured. */
const RUN_LINE = 'DRAWORDER from depth by the knee (run; tie 24.96 px), 6 key(s) over 3 span(s) (leg_r behind leg_l 0–9, 20–29, 40–49)';
const WALK_LINE = 'DRAWORDER from depth by the ankle (walk; tie 46.83 px), 5 key(s) over 3 span(s) (leg_r behind leg_l 0–2, 15–26, 39–47)';
const RUN_TIE = 24.96;
/**
 * #336's reading: on every frame the generator lifts one leg (its swing; a run's flight frames lift both and are not
 * counted), whether the keyed order draws the lifted leg in front or behind. `want` is the owner's statement for the
 * gait. Returns the frames that miss, the count, and the per-frame table.
 */
function liftedOrder(seq: PoseSequence, behind: Array<'r' | 'l'>, truth: DepthFrame[], want: 'front' | 'behind'): { misses: number[]; table: string[]; lifted: number } {
  const table = ['| frame | lifted | r thigh / shin | l thigh / shin | knee r / l (px) | ankle r / l (px) | keyed behind | generator knee | generator ankle |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const misses: number[] = [];
  let lifted = 0;
  const track = personTrack(seq, undefined, 'fixture');
  seq.frames.forEach((f, i) => {
    const up = truth[i]!.lifted;
    const one = up.length === 1 ? up[0]! : null;
    if (one !== null) {
      lifted++;
      if ((behind[i] === one) !== (want === 'behind')) misses.push(i);
    }
    const d = f.depth!;
    const z = (s: 'r' | 'l') => limbJointDepths(track[i]!, d, `${s}_leg`)!;
    const t = (j: 'knee' | 'ankle') => ({ 1: 'r front', 0: 'tied', [-1]: 'l front' })[trueJointOrder(truth[i]!, j)];
    table.push(`| ${i} | ${up.join('') || '—'} | ${d.r_thigh!.sign} / ${d.r_shin?.sign ?? '—'} | ${d.l_thigh!.sign} / ${d.l_shin?.sign ?? '—'} | ${z('r').mid.toFixed(1)} / ${z('l').mid.toFixed(1)} | ${z('r').end?.toFixed(1) ?? '—'} / ${z('l').end?.toFixed(1) ?? '—'} | ${behind[i]}${one !== null && (behind[i] === one) !== (want === 'behind') ? ' ✗' : ''} | ${t('knee')} | ${t('ankle')} |`);
  });
  return { misses, table, lifted };
}
/** The frames the generator orders the legs at `joint`, on which the keyed order draws the other leg in front. */
const againstGenerator = (truth: DepthFrame[], behind: Array<'r' | 'l'>, joint: 'knee' | 'ankle'): number[] =>
  truth.flatMap((f, i) => {
    const t = trueJointOrder(f, joint);
    return t !== 0 && behind[i] !== (t > 0 ? 'l' : 'r') ? [i] : [];
  });

describe('bar (1): the run — the lifted leg in front, by the knee (#336)', () => {
  test('every frame with one leg lifted draws that leg in front, its knee protruding from toe-off (#343); the generator\'s knees agree wherever they differ by the tie', () => {
    const truth = FIXTURES.run();
    const r = retargeted('run', true);
    expect(r.ran.stderr).toBe('');
    expect(r.ran.status).toBe(0);
    const keys = r.motion.animations.run!.drawOrder!;
    expect(keys.length).toBeGreaterThan(0);
    const behind = behindPerFrame(SETUP, keys, r.report.frameTimes);
    // #325: every key first shows on the frame it was decided on, read as the render reads it.
    expect(keysOffFrame(keys, r.report.drawOrder!.keys.map((x) => x.frame), r.report.frameTimes.length)).toEqual([]);
    // #334: no discrete key of the motion sits on a frame time.
    expect(keysOnFrameTimes(r.motion as MotionDoc, r.report.frameTimes)).toEqual([]);
    const k = liftedOrder(r.seq, behind, truth, 'front');
    // The knee protrudes when the lifted leg's thigh leans forward past the band (the generator's own sign).
    const protrudes = (i: number) => truth[i]!.lifted.length === 1 && truth[i]!.truth[`${truth[i]!.lifted[0]!}_thigh`].sign === 1;
    const raised = truth.flatMap((_, i) => (protrudes(i) ? [i] : []));
    console.log(`  #336 bar 2 — run, per frame (setup: the left leg behind):\n${k.table.join('\n')}`);
    console.log(`  #336 bar 2 — run: ${k.lifted} frames with one leg lifted, ${k.lifted - k.misses.length} draw it in front; of the ${raised.length} whose knee protrudes, ${raised.filter((i) => !k.misses.includes(i)).length} in front; misses at ${k.misses.join(', ') || 'none'}; keys at frames ${r.report.drawOrder!.keys.map((x) => x.frame).join(', ')}`);
    // #343: the swing thigh flexes forward from toe-off, so every lifted frame's knee protrudes and none is missed —
    // the early-swing exemption #336 allowed (the lifted thigh inside the band, the knees within the tie) is gone.
    expect(k.lifted).toBe(42);
    expect(raised.length).toBe(k.lifted);
    expect(k.misses).toEqual([]);
    // The generator's own knees: the lifted one in front of the supporting one on every such frame (#343 bar 1).
    const lifted = truth.flatMap((f, i) => (f.lifted.length === 1 ? [i] : []));
    const kneeFront = lifted.filter((i) => {
      const up = truth[i]!.lifted[0]!;
      return truth[i]!.z[`${up}_knee`]! > truth[i]!.z[`${up === 'r' ? 'l' : 'r'}_knee`]!;
    });
    console.log(`  #343 bar 1 — run: the generator's lifted knee in front of the supporting knee on ${kneeFront.length}/${lifted.length} one-leg-lifted frames`);
    expect(kneeFront).toEqual(lifted);
    expect(againstGenerator(truth, behind, 'knee')).toEqual([]);
    console.log(`  #336 bar 2 — run: the generator orders the knees on ${truth.filter((f) => trueJointOrder(f, 'knee') !== 0).length} of ${truth.length} frames, the keyed order agrees on all`);
    // The DRAWORDER line, ≤ 260 characters, names the joint and its tie.
    const line = linesOf(r.ran, 'DRAWORDER');
    console.log(`  #336 bar 2 — ${line.join(' | ')}`);
    expect(line).toEqual([RUN_LINE]);
    expect(r.report.drawOrder!.pairs).toEqual([{ a: 'leg_r', b: 'leg_l', limbs: ['r_leg', 'l_leg'], slots: { a: ['leg_r0', 'leg_r1'], b: ['leg_l0', 'leg_l1'] }, keyed: true, tie: RUN_TIE, by: 'knee' }]);
    expect(r.report.options.drawOrder).toBe('depth');
  }, SLOW);
});

describe('bar (2): the walk — the lifted foot behind, by the ankle (#336)', () => {
  test('every frame with one leg lifted draws that leg behind; the generator\'s ankles agree wherever they differ by the tie', () => {
    const truth = FIXTURES.walk();
    const r = retargeted('walk', true);
    expect(r.ran.stderr).toBe('');
    expect(r.ran.status).toBe(0);
    const keys = r.motion.animations.walk!.drawOrder!;
    const behind = behindPerFrame(SETUP, keys, r.report.frameTimes);
    expect(keysOffFrame(keys, r.report.drawOrder!.keys.map((x) => x.frame), r.report.frameTimes.length)).toEqual([]);
    expect(keysOnFrameTimes(r.motion as MotionDoc, r.report.frameTimes)).toEqual([]);
    const k = liftedOrder(r.seq, behind, truth, 'behind');
    console.log(`  #336 bar 1 — walk, per frame:\n${k.table.join('\n')}`);
    console.log(`  #336 bar 1 — walk: ${k.lifted} frames with one leg lifted, ${k.lifted - k.misses.length} draw it behind (misses: ${k.misses.join(', ') || 'none'}); keys at frames ${r.report.drawOrder!.keys.map((x) => x.frame).join(', ')}`);
    expect(k.lifted).toBeGreaterThan(30);
    expect(k.misses).toEqual([]);
    expect(againstGenerator(truth, behind, 'ankle')).toEqual([]);
    console.log(`  #336 bar 1 — walk: the generator orders the ankles on ${truth.filter((f) => trueJointOrder(f, 'ankle') !== 0).length} of ${truth.length} frames, the keyed order agrees on all`);
    const line = linesOf(r.ran, 'DRAWORDER');
    console.log(`  #336 bar 1 — ${line.join(' | ')}`);
    expect(line).toEqual([WALK_LINE]);
    expect(r.report.drawOrder!.pairs[0]!.by).toBe('ankle');
  }, SLOW);
});

describe('bar (3): without the flag nothing changes', () => {
  test('control: no drawOrder in the motion, no DRAWORDER line, no drawOrder key or option in the report; the tracks are the same with and without it', () => {
    const dir = tempDir();
    const off = retargeted('run', false, { dir });
    expect(off.ran.status).toBe(0);
    expect('drawOrder' in off.motion.animations.run!).toBe(false);
    expect(linesOf(off.ran, 'DRAWORDER')).toEqual([]);
    expect('drawOrder' in off.report).toBe(false);
    expect('drawOrder' in off.report.options).toBe(false);
    const on = retargeted('run', true, { dir: join(dir, 'on'), sequence: join(dir, 'run.clean.json') });
    expect(on.ran.status).toBe(0);
    const { drawOrder: _d, ...rest } = on.motion.animations.run!;
    expect(JSON.stringify({ ...on.motion, animations: { run: rest } })).toBe(JSON.stringify(off.motion));
  }, SLOW);
});

describe('bar (4): the render at the run\'s frame 12 draws no pixel of the standing leg over the lifted leg', () => {
  test('on a rig that draws the right leg first: of the pixels the right (lifted, knee forward) leg draws on its own, none shows the left leg\'s colours with the flag; without it the standing left leg covers some (control)', () => {
    const dir = tempDir();
    const FRAME = 12;
    const order = ['torso', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1'];
    const count = (r: Retargeted, tag: string): { mask: number; over: number } => {
      const out = join(r.dir, `render-${tag}`);
      const outR = join(r.dir, `render-${tag}-r`);
      for (const [o, extra] of [[out, []], [outR, ['--slot', 'leg_r0,leg_r1']]] as const) {
        const ran = spawnSync(process.execPath, [rigcCli(), 'render', '--candidate', r.build, '--animation', 'run', '--fps', '24', '--max', '512', '--out', o, ...extra], { encoding: 'utf8', cwd: ROOT });
        expect(ran.status).toBe(0);
      }
      const name = `f${String(FRAME).padStart(4, '0')}.png`;
      const full = readPlate(join(out, 'run@24fps', name));
      const right = readPlate(join(outR, 'run@24fps', name));
      const bg = right.get(0, 0);
      const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      let mask = 0;
      let over = 0;
      for (let y = 0; y < right.height; y++) for (let x = 0; x < right.width; x++) {
        if (same(right.get(x, y), bg)) continue;
        mask++;
        const c = full.get(x, y);
        if (same(c, BLUE) || same(c, BLUE_SHIN)) over++;
      }
      return { mask, over };
    };
    const on = retargeted('run', true, { dir, order });
    const off = retargeted('run', false, { dir: join(dir, 'off'), sequence: join(dir, 'run.clean.json'), order });
    expect(on.ran.status).toBe(0);
    expect(off.ran.status).toBe(0);
    // Frame 12: the right leg lifted, its knee forward (the generator's lifted thigh leans toward the camera).
    const truth = FIXTURES.run()[FRAME]!;
    expect(truth.lifted).toEqual(['r']);
    expect(truth.truth.r_thigh.sign).toBe(1);
    const a = count(on, 'on');
    const b = count(off, 'off');
    console.log(`  #336 bar 4 — frame ${FRAME}: the lifted right leg draws ${a.mask} px; the standing left leg's colours over them: ${a.over} with --draw-order depth, ${b.over} without`);
    expect(a.mask).toBeGreaterThan(1000);
    expect(a.over).toBe(0);
    expect(b.over).toBeGreaterThan(100);
  }, SLOW);
});

describe('bar (5): determinism', () => {
  test('two runs of the same command write the same motion and report bytes', () => {
    const dir = tempDir();
    const a = retargeted('run', true, { dir });
    expect(a.ran.status).toBe(0);
    const [motion, report] = [readFileSync(a.out, 'utf8'), readFileSync(join(dir, 'run.report.json'), 'utf8')];
    const b = retargeted('run', true, { dir, sequence: join(dir, 'run.clean.json') });
    expect(b.ran.status).toBe(0);
    expect(readFileSync(b.out, 'utf8')).toBe(motion);
    expect(readFileSync(join(dir, 'run.report.json'), 'utf8')).toBe(report);
    expect(motion).toContain('"drawOrder"');
  }, SLOW);
});

describe('refusals, the pair rule and the sets', () => {
  test('--draw-order depth on a sequence without depth is refused by name (exit 1); any value but depth is a usage error (exit 2)', () => {
    const dir = tempDir();
    const plain = cleaned(FIXTURES.run(), null, dir, 'plain');
    const r = retargeted('run', true, { dir, sequence: plain });
    expect(r.ran.status).toBe(1);
    expect(r.ran.stderr).toContain(`DRAWORDER_NO_DEPTH: --draw-order depth keys the draw order from the sequence's depth, and ${plain} carries none (rig-pose-sequence/1 or 1.1, no "depth" on any frame); clean it with --depth walk|run, or retarget without --draw-order`);
    expect(existsSync(join(dir, 'run.motion.json'))).toBe(false);
    const u = cli(['retarget', '--rig', writeRig(join(dir, 'u')), '--map', MAP, '--sequence', plain, '--out', join(dir, 'u.json'), '--draw-order', 'z']);
    expect(u.status).toBe(2);
    expect(u.stderr).toContain('--draw-order is "z"; it must be depth');
  }, SLOW);

  test('a slot of anything else drawn between the legs: the pair is not keyed, the line names the slot, no drawOrder is written', () => {
    const r = retargeted('run', true, { order: ['leg_l0', 'leg_l1', 'torso', 'leg_r0', 'leg_r1'] });
    expect(r.ran.status).toBe(0);
    expect(linesOf(r.ran, 'DRAWORDER')).toEqual([
      'DRAWORDER from depth, 0 key(s) over 0 span(s) (no pair keyed)',
      'DRAWORDER leg_r / leg_l not keyed: 1 slot: "torso" is drawn between them, and a swap would re-layer it (the setup order is not changed here)',
    ]);
    expect('drawOrder' in r.motion.animations.run!).toBe(false);
  }, SLOW);

  test('interleaved setup (thighs, then shins): both orders are keyed swaps', () => {
    const r = retargeted('run', true, { order: ['torso', 'leg_l0', 'leg_r0', 'leg_l1', 'leg_r1'] });
    expect(r.ran.status).toBe(0);
    const keys = r.motion.animations.run!.drawOrder!;
    expect(keys.every((k) => k.offsets !== undefined)).toBe(true);
    expect(r.report.drawOrder!.spans.every((s) => s.keyed)).toBe(true);
  }, SLOW);

  test('a set\'s slot on no leg bone goes with the leg its set depicts (pure): it moves with the right leg', () => {
    const seq = readPoseSequence(readFileSync(cleaned(FIXTURES.run(), 'run', tempDir(), 'run'), 'utf8'), 'run');
    const track = personTrack(seq, undefined, 'run');
    const layers = track.map((j, i) => layersOf(j, seq.frames[i]!.depth!));
    const base = readMap(readFileSync(MAP, 'utf8'), MAP);
    const map = { ...base, alternates: [{ name: 'kick', slots: { kick_r: 'kick' }, hides: [], chains: ['leg_r'], pose: {}, drawn: {}, offsets: {}, turn: {}, frames: null }] } as JointMap;
    const wave = JSON.parse(readFileSync(WAVE, 'utf8')) as { bones: Array<{ name: string; parent?: string }> };
    const rest = new Map(wave.bones.map((b) => [b.name, { parent: b.parent ?? null }])) as unknown as Rest;
    const order = [
      { name: 'torso', bone: 'chest' },
      { name: 'leg_l0', bone: 'leg_l0' },
      { name: 'leg_l1', bone: 'leg_l1' },
      { name: 'leg_r0', bone: 'leg_r0' },
      { name: 'leg_r1', bone: 'leg_r1' },
      { name: 'kick_r', bone: 'hip' },
    ];
    // Read by the run's joint, the knee (#336), as `retarget` reads this sequence: #343's run keeps its limb means within the limb tie.
    const d = drawOrderFromDepth(layers, track, seq.frames.map((f) => f.depth), seq.frames.map((f) => f.t), map, rest, order, undefined, true, 'run');
    expect(d.pairs[0]!.slots).toEqual({ a: ['leg_r0', 'leg_r1', 'kick_r'], b: ['leg_l0', 'leg_l1'] });
    const swap = d.keys.find((k) => k.offsets !== undefined)!;
    expect(swap.offsets).toEqual([
      { slot: 'leg_l0', offset: 3 },
      { slot: 'leg_l1', offset: 3 },
      { slot: 'leg_r0', offset: -2 },
      { slot: 'leg_r1', offset: -2 },
      { slot: 'kick_r', offset: -2 },
    ]);
    // A set depicting both legs is neither's: its slot stays out, and between the legs it stops the pair.
    const both = { ...map, alternates: [{ ...map.alternates[0]!, chains: ['leg_r', 'leg_l'] }] } as JointMap;
    const between = [order[0]!, order[1]!, order[2]!, order[5]!, order[3]!, order[4]!];
    const d2 = drawOrderFromDepth(layers, track, seq.frames.map((f) => f.depth), seq.frames.map((f) => f.t), both, rest, between, undefined, true, 'run');
    expect(d2.pairs[0]!.keyed).toBe(false);
    expect(d2.keys).toEqual([]);
    expect(drawOrderLines(d2)[1]).toContain('"kick_r" is drawn between them');
  });

  test('the line is cut to 260 characters, the rest counted', () => {
    const spans = Array.from({ length: 40 }, (_, i) => ({ behind: 'leg_r', front: 'leg_l', frames: [i * 10, i * 10 + 4] as [number, number], keyed: true }));
    const lines = drawOrderLines({ pairs: [{ a: 'leg_r', b: 'leg_l', limbs: ['r_leg', 'l_leg'], slots: { a: ['x'], b: ['y'] }, keyed: true, tie: 1 }], keys: [], spans });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(260);
    expect(lines[0]).toMatch(/ … \+\d+ more in the report's drawOrder\)$/);
  });
});

/** The pure draw order on a retargeted fixture's own sequence, through `mod` (the real module or a mutant). */
function pureBehind(mod: { drawOrderFromDepth: typeof drawOrderFromDepth }, r: Retargeted, gait: 'walk' | 'run' | null, depth?: PoseSequence['frames'][number]['depth'][]): { behind: Array<'r' | 'l'>; tie: number | null } {
  const track = personTrack(r.seq, undefined, 'run');
  const ds = depth ?? r.seq.frames.map((f) => f.depth);
  const layers = track.map((j, i) => layersOf(j, ds[i]!));
  const map = readMap(readFileSync(MAP, 'utf8'), MAP);
  const wave = JSON.parse(readFileSync(WAVE, 'utf8')) as { bones: Array<{ name: string; parent?: string }> };
  const rest = new Map(wave.bones.map((b) => [b.name, { parent: b.parent ?? null }])) as unknown as Rest;
  const order = SETUP.map((n) => ({ name: n, bone: n === 'torso' ? 'chest' : n }));
  const d = mod.drawOrderFromDepth(layers, track, ds, r.report.frameTimes, map, rest, order, undefined, true, gait);
  return { behind: behindPerFrame(SETUP, d.keys, r.report.frameTimes), tie: d.pairs[0]!.tie };
}
/** Bar (1)'s misses (the run: a frame whose lifted knee protrudes, drawn behind) and bar (2)'s (the walk: a lifted frame drawn in front). */
function barMisses(name: 'run' | 'walk', r: Retargeted, behind: Array<'r' | 'l'>): number[] {
  const truth = FIXTURES[name]();
  const k = liftedOrder(r.seq, behind, truth, name === 'run' ? 'front' : 'behind');
  // #343: every lifted run frame's knee protrudes, so both gaits count every miss.
  return k.misses;
}

describe('mutants: the rule\'s direction, the gait\'s joint and the limb mean, each making a bar red', () => {
  const MUTS = [
    { name: 'the nearer leg drawn behind (direction flipped)', from: "state = za < zb ? 'a' : 'b';", to: "state = za < zb ? 'b' : 'a';", red: ['run', 'walk'] },
    { name: 'the joints swapped: a walk by the knee, a run by the ankle (#281\'s swapped record; the run half is #335\'s reading)', from: "export const ORDER_JOINT: Record<DepthGait, LegJoint> = { walk: 'ankle', run: 'knee' };", to: "export const ORDER_JOINT: Record<DepthGait, LegJoint> = { walk: 'knee', run: 'ankle' };", red: ['run', 'walk'] },
    { name: 'the limb mean for every gait (#304\'s rule)', from: 'const by = gait === null ? undefined : ORDER_JOINT[gait];', to: 'const by = gait === null ? undefined : (undefined as LegJoint | undefined);', red: ['run', 'walk'] },
  ] as const;
  for (const mu of MUTS) {
    test(`mutant: ${mu.name}`, async () => {
      const refs = { run: retargeted('run', true), walk: retargeted('walk', true) };
      expect(refs.run.ran.status).toBe(0);
      expect(refs.walk.ran.status).toBe(0);
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm336-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        const path = join(d, 'src', 'draworder.ts');
        const src = readFileSync(path, 'utf8');
        expect(src.split(mu.from)).toHaveLength(2);
        writeFileSync(path, src.replace(mu.from, mu.to));
        const m = (await import(path)) as { drawOrderFromDepth: typeof drawOrderFromDepth };
        for (const name of ['run', 'walk'] as const) {
          // The control: the real module, the same call, no miss.
          expect(barMisses(name, refs[name], pureBehind({ drawOrderFromDepth }, refs[name], name).behind)).toEqual([]);
          const misses = barMisses(name, refs[name], pureBehind(m, refs[name], name).behind);
          console.log(`  #336 mutant "${mu.name}" — ${name}: ${misses.length} frame(s) against the owner's statement (${misses.join(', ') || 'none'})`);
          if ((mu.red as readonly string[]).includes(name)) expect(misses.length).toBeGreaterThan(0);
        }
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }

  test('the tie, planted: knees 10 px apart (inside the knee tie) hold the order before; mutant: no tie, and they swap it', async () => {
    const ref = retargeted('run', true);
    expect(ref.ran.status).toBe(0);
    const track = personTrack(ref.seq, undefined, 'run');
    // Frames 3–6: the left leg lifted, its knee forward (decided on frame 2). Plant the standing right thigh leaning
    // forward too, its knee 10 px in front of the left's: closer than the knee tie, so the left stays in front.
    const PLANTED = [3, 4, 5, 6];
    const depth = ref.seq.frames.map((f, i) => {
      if (!PLANTED.includes(i)) return f.depth;
      const lKnee = limbJointDepths(track[i]!, f.depth!, 'l_leg')!.mid;
      const [a, b] = [track[i]!.r_hip!.at!, track[i]!.r_knee!.at!];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ratio = 1 / Math.sqrt(1 + ((lKnee + 10) / len) ** 2);
      return { ...f.depth, r_thigh: { ratio, sign: 1 as const, source: 'derived' as const } };
    });
    for (const i of PLANTED) {
      const z = (s: 'r' | 'l') => limbJointDepths(track[i]!, depth[i]!, `${s}_leg`)!.mid;
      expect(z('r') - z('l')).toBeCloseTo(10, 6);
    }
    const real = pureBehind({ drawOrderFromDepth }, ref, 'run', depth);
    expect(real.tie! > 10).toBe(true);
    expect(PLANTED.map((i) => real.behind[i])).toEqual(['r', 'r', 'r', 'r']);
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm336-tie-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'draworder.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'const tie = r.pair.tie ?? 0;';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'const tie = 0;'));
      const m = (await import(path)) as { drawOrderFromDepth: typeof drawOrderFromDepth };
      const mut = pureBehind(m, ref, 'run', depth);
      console.log(`  #336 mutant "no tie": the planted frames ${PLANTED.join(', ')} draw the right leg ${PLANTED.map((i) => (mut.behind[i] === 'r' ? 'behind' : 'in front')).join(', ')} (with the tie of ${real.tie} px: behind on all)`);
      expect(PLANTED.map((i) => mut.behind[i])).toEqual(['l', 'l', 'l', 'l']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#336 review: the knee without the ankle, and a record cleaned with the table before #336', () => {
  /** The run's sequence with both ankles missing (and the shins' depth gone, as clean writes none there) on `drop` frames. */
  const withoutAnkles = (seq: PoseSequence, drop: (i: number) => boolean): PoseSequence => ({
    ...seq,
    frames: seq.frames.map((f, i) => {
      if (!drop(i)) return f;
      const { r_shin: _r, l_shin: _l, ...depth } = f.depth!;
      return { ...f, depth, people: f.people.map((p) => ({ ...p, joints: { ...p.joints, r_ankle: { state: 'missing' as const }, l_ankle: { state: 'missing' as const } } })) };
    }),
  });

  test('a run frame without its ankles still orders the legs at the knee; with no ankle on any frame the knee tie still reads; mutant: the knee requiring the shin holds the order instead', async () => {
    const ref = retargeted('run', true);
    expect(ref.ran.status).toBe(0);
    const base = pureBehind({ drawOrderFromDepth }, ref, 'run');
    const cases = [
      { name: 'frames 0–6, 10–16, … (every swing a key decides on)', drop: (i: number) => i % 10 <= 6 },
      { name: 'every frame (no ankle anywhere: a knee-only sequence)', drop: () => true },
    ];
    for (const c of cases) {
      const r2 = { ...ref, seq: withoutAnkles(ref.seq, c.drop) };
      const got = pureBehind({ drawOrderFromDepth }, r2, 'run', r2.seq.frames.map((f) => f.depth));
      console.log(`  #336 review 1 — ankles missing on ${c.name}: tie ${got.tie} px, ${got.behind.filter((b, i) => b !== base.behind[i]).length} frame(s) ordered otherwise than with the ankles`);
      expect(got.tie).toBe(base.tie);
      expect(got.behind).toEqual(base.behind);
      expect(barMisses('run', r2, got.behind)).toEqual([]);
    }
    // Mutant: the knee depth given only where the shin is named too (the helper before the review).
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm336-knee-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'depth.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'if (du === undefined || lu === null) return null;';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'if (du === undefined || dl === undefined || lu === null || ll === null) return null;'));
      const m = (await import(join(d, 'src', 'draworder.ts'))) as { drawOrderFromDepth: typeof drawOrderFromDepth };
      const r2 = { ...ref, seq: withoutAnkles(ref.seq, cases[0]!.drop) };
      const got = pureBehind(m, r2, 'run', r2.seq.frames.map((f) => f.depth));
      const misses = barMisses('run', r2, got.behind);
      console.log(`  #336 review 1 mutant "knee needs the shin": ${misses.length} knee-protruding frame(s) drawn behind (${misses.join(', ')})`);
      expect(misses.length).toBeGreaterThan(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('a walk record with the shin signs of the table before #336 is refused by name with --draw-order depth (DEPTH_RECLEAN), read without it; a run record from before (the same signs) and a measured depth are read', () => {
    const dir = tempDir();
    const fresh = cleaned(FIXTURES.walk(), 'walk', dir, 'walk');
    // The table before #336 leaned a walk's foreshortened shin forward: the same record with every shin sign the other way.
    const doc = JSON.parse(readFileSync(fresh, 'utf8')) as { frames: Array<{ depth: Record<string, { sign: number }> }> };
    let flipped = 0;
    for (const f of doc.frames) for (const s of ['r_shin', 'l_shin']) if (f.depth[s] !== undefined && f.depth[s]!.sign !== 0) {
      f.depth[s]!.sign = -f.depth[s]!.sign;
      flipped++;
    }
    expect(flipped).toBe(28);
    const old = join(dir, 'walk.old.clean.json');
    writeFileSync(old, JSON.stringify(doc, null, 2));
    const r = retargeted('walk', true, { dir: join(dir, 'old'), sequence: old });
    console.log(`  #336 review 2 — ${r.ran.stderr.trim()}`);
    expect(r.ran.status).toBe(1);
    expect(r.ran.stderr).toContain(`DEPTH_RECLEAN: ${old} carries derived depth (clean --depth walk) whose foreshortened shin leans forward, the way the trunk faces, on 28 frame(s) (3, 4, 5, 6, 7, … +23 more): the sign table before rig-c/pose#336, where a walk's lifted foot read forward. --draw-order depth reads a walk at the ankle and would draw that foot in front of the supporting leg. Clean it again with this version (rig-pose clean --depth walk), which leans a foreshortened shin back in both gaits; a sequence cleaned with --depth run by an earlier release is read as it is (its signs did not change), and measured depth is not checked`);
    expect(existsSync(join(dir, 'old', 'walk.motion.json'))).toBe(false);
    // Without the flag nothing reads the order, and the record is read as before.
    expect(retargeted('walk', false, { dir: join(dir, 'old-off'), sequence: old }).ran.status).toBe(0);
    // Cleaned again, it is read.
    expect(retargeted('walk', true, { dir: join(dir, 'again'), sequence: cleaned(FIXTURES.walk(), 'walk', join(dir), 'walk2') }).ran.status).toBe(0);
    // A run record: the run's signs did not change, so a release before #336 wrote these bytes (the PR's sha256 table); read.
    const run = retargeted('run', true, { dir: join(dir, 'run') });
    expect(run.ran.status).toBe(0);
    expect(run.ran.stderr).not.toContain('DEPTH_RECLEAN');
    // Measured depth is a detector's, not the table's: the same forward shins marked measured are read.
    const measured = structuredClone(doc) as unknown as { frames: Array<{ depth: Record<string, { source: string }> }>; cleaned: { params: Record<string, unknown> } };
    for (const f of measured.frames) for (const v of Object.values(f.depth)) v.source = 'measured';
    delete measured.cleaned.params.depth;
    const mpath = join(dir, 'walk.measured.json');
    writeFileSync(mpath, JSON.stringify(measured, null, 2));
    const m = retargeted('walk', true, { dir: join(dir, 'measured'), sequence: mpath });
    expect(m.ran.stderr).not.toContain('DEPTH_RECLEAN');
    expect(m.ran.status).toBe(0);
  }, SLOW);
});

describe('rig-c/pose#324: why nothing keyed — the slot count first, and the leg depth gap against the tie', () => {
  type Gap = { a: string; b: string; median: number | null; max: number | null; medianLegs: number | null; maxLegs: number | null; tie: number | null; tieLegs: number | null; passed: number; frames: number };
  const gapsOf = (r: Retargeted): Gap[] => (r.report.drawOrder as unknown as { gaps: Gap[] }).gaps;
  const gapLine = (g: Gap, by: string): string =>
    `DRAWGAP ${g.a} / ${g.b}: leg depth gap at the ${by} median ${g.median} px (${g.medianLegs} leg), max ${g.max} px (${g.maxLegs} leg), against the tie of ${g.tie} px (${g.tieLegs} leg); ${g.passed} of ${g.frames} frame(s) passed it`;

  test('bar 1: slots between the pair — the count is in stdout, and the not-keyed pair still gets its gap line', () => {
    const r = retargeted('run', true, { order: ['leg_l0', 'leg_l1', 'torso', 'leg_r0', 'leg_r1'] });
    expect(r.ran.status).toBe(0);
    expect(r.ran.stdout).toContain('not keyed: 1 slot: "torso" is drawn between them');
    expect(r.report.drawOrder!.pairs[0]!.why).toBe('1 slot: "torso" is drawn between them, and a swap would re-layer it (the setup order is not changed here)');
    const gaps = gapsOf(r);
    expect(gaps).toHaveLength(1);
    expect(linesOf(r.ran, 'DRAWGAP')).toEqual([gapLine(gaps[0]!, 'knee')]);
  }, SLOW);

  test('bar 2: the keyed run — the gap line\'s figures match the report, and the report\'s match the knee depths the rule reads (#336)', () => {
    const r = retargeted('run', true);
    expect(r.ran.status).toBe(0);
    const [g] = gapsOf(r);
    const line = linesOf(r.ran, 'DRAWGAP');
    console.log(`  #324 bar 2 — ${line[0]}`);
    expect(line).toEqual([gapLine(g!, 'knee')]);
    expect(line[0]!.length).toBeLessThanOrEqual(260);
    // The report against the depths it reads, a run's at the knee (#336): |r − l| per frame, its median and max, the frames at or past the tie.
    const track = personTrack(r.seq, undefined, 'run');
    const knee = (i: number, s: 'r' | 'l') => Math.round(limbJointDepths(track[i]!, r.seq.frames[i]!.depth!, `${s}_leg`)!.mid * 100) / 100;
    const d = r.seq.frames.map((_, i) => Math.abs(knee(i, 'r') - knee(i, 'l'))).sort((x, y) => x - y);
    const m = d.length >> 1;
    const median = d.length % 2 === 1 ? d[m]! : (d[m - 1]! + d[m]!) / 2;
    expect(g!.frames).toBe(d.length);
    // The report rounds once, to 0.01 px (a median of two may sit on the half).
    expect(Math.abs(g!.median! - median)).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(Math.abs(g!.max! - d[d.length - 1]!)).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(g!.tie).toBe(r.report.drawOrder!.pairs[0]!.tie);
    expect(g!.passed).toBe(d.filter((x) => x > 0 && x >= g!.tie!).length);
    expect(g!.passed).toBeGreaterThan(0);
    expect(g!.medianLegs! / g!.median!).toBeCloseTo(g!.tieLegs! / g!.tie!, 3);
  }, SLOW);

  test('many slots between the pair: the count survives the 260 cut, the list is cut with "+N more"', () => {
    const between = Array.from({ length: 19 }, (_, i) => `between_slot_${String(i).padStart(2, '0')}`);
    const reading = { pairs: [{ a: 'leg_r', b: 'leg_l', limbs: ['r_leg', 'l_leg'] as ['r_leg', 'l_leg'], slots: { a: ['x'], b: ['y'] }, keyed: false, tie: 1, why: 'full', between }], keys: [], spans: [] };
    const line = drawOrderLines(reading)[1]!;
    console.log(`  #324 many — ${line}`);
    expect(line.length).toBeLessThanOrEqual(260);
    expect(line).toStartWith('DRAWORDER leg_r / leg_l not keyed: 19 slots are drawn between them ("between_slot_00", ');
    expect(line).toMatch(/, … \+\d+ more\), and a swap would re-layer them \(the setup order is not changed here\)$/);
    const shown = (line.match(/"between_slot_\d+"/g) ?? []).length;
    expect(line).toContain(`… +${19 - shown} more`);
  });

  test('without the flag: no DRAWGAP line', () => {
    const off = retargeted('run', false);
    expect(off.ran.status).toBe(0);
    expect(linesOf(off.ran, 'DRAWGAP')).toEqual([]);
  }, SLOW);
});

describe('rig-c/pose#424: contiguous leg runs separated by non-leg slots, and a walk leg foreshortened across thigh and shin', () => {
  test('two contiguous leg runs with a non-leg slot between them: each run swaps in place, and the non-leg slot is never moved', () => {
    const seq = readPoseSequence(readFileSync(cleaned(FIXTURES.walk(), 'walk', tempDir(), 'walk'), 'utf8'), 'walk');
    const track = personTrack(seq, undefined, 'run');
    const layers = track.map((j, i) => layersOf(j, seq.frames[i]!.depth!));
    const base = readMap(readFileSync(MAP, 'utf8'), MAP);
    const wave = JSON.parse(readFileSync(WAVE, 'utf8')) as { bones: Array<{ name: string; parent?: string }> };
    const rest = new Map(wave.bones.map((b) => [b.name, { parent: b.parent ?? null }])) as unknown as Rest;
    // Run 1 (indices 0..3): leg_r0, leg_r1, leg_l0, leg_l1. Index 4: non-leg torso. Run 2 (indices 5..6): shoe_top_r, shoe_top_l on the shin bones.
    const order = [
      { name: 'leg_r0', bone: 'leg_r0' },
      { name: 'leg_r1', bone: 'leg_r1' },
      { name: 'leg_l0', bone: 'leg_l0' },
      { name: 'leg_l1', bone: 'leg_l1' },
      { name: 'torso', bone: 'chest' },
      { name: 'shoe_top_r', bone: 'leg_r1' },
      { name: 'shoe_top_l', bone: 'leg_l1' },
    ];
    const setup = order.map((s) => s.name);
    const d = drawOrderFromDepth(layers, track, seq.frames.map((f) => f.depth), seq.frames.map((f) => f.t), base, rest, order, undefined, true, 'walk');
    expect(d.pairs[0]!.keyed).toBe(true);
    expect(d.pairs[0]!.slots).toEqual({ a: ['leg_r0', 'leg_r1', 'shoe_top_r'], b: ['leg_l0', 'leg_l1', 'shoe_top_l'] });
    expect(d.keys.length).toBeGreaterThan(0);
    for (const k of d.keys) {
      expect((k.offsets ?? []).some((o) => o.slot === 'torso')).toBe(false);
      const applied = applyKey(setup, k);
      // The non-leg slot between the two runs stays at its exact setup index (4) on every key.
      expect(applied[4]).toBe('torso');
      const rBehind = applied.slice(0, 4).join(',') === 'leg_r0,leg_r1,leg_l0,leg_l1' && applied.slice(5, 7).join(',') === 'shoe_top_r,shoe_top_l';
      const lBehind = applied.slice(0, 4).join(',') === 'leg_l0,leg_l1,leg_r0,leg_r1' && applied.slice(5, 7).join(',') === 'shoe_top_l,shoe_top_r';
      expect(rBehind || lBehind).toBe(true);
    }
  });

  test('walk foreshortening split across thigh and shin: the lifted foot is drawn behind (not cancelled by the thigh\'s run-rule forward sign), and a flipped shin sign makes it red', () => {
    const seq = readPoseSequence(readFileSync(cleaned(FIXTURES.walk(), 'walk', tempDir(), 'walk'), 'utf8'), 'walk');
    const track = personTrack(seq, undefined, 'run');
    const base = readMap(readFileSync(MAP, 'utf8'), MAP);
    const wave = JSON.parse(readFileSync(WAVE, 'utf8')) as { bones: Array<{ name: string; parent?: string }> };
    const rest = new Map(wave.bones.map((b) => [b.name, { parent: b.parent ?? null }])) as unknown as Rest;
    const order = SETUP.map((n) => ({ name: n, bone: n === 'torso' ? 'chest' : n }));
    // Split each lifted walk leg's foreshortening across both thigh (ratio 0.86, sign +1) and shin (ratio 0.85, sign -1):
    // under `limbJointDepths.end`, +|z_thigh| and -|z_shin| cancel inside the ankle tie; under the walk rule, both fold the ankle back.
    const splitDepth = seq.frames.map((f) => {
      const d = structuredClone(f.depth!);
      for (const side of ['r', 'l'] as const) {
        const sh = d[`${side}_shin`];
        if (sh !== undefined && sh.sign !== 0) {
          d[`${side}_thigh`] = { ratio: 0.86, sign: 1, source: 'derived' };
          d[`${side}_shin`] = { ratio: 0.85, sign: -1, source: 'derived' };
        }
      }
      return d;
    });
    const layers = track.map((j, i) => layersOf(j, splitDepth[i]!));
    const walkOut = drawOrderFromDepth(layers, track, splitDepth, seq.frames.map((f) => f.t), base, rest, order, undefined, true, 'walk');
    const walkBehind = behindPerFrame(SETUP, walkOut.keys, seq.frames.map((f) => f.t));
    expect(liftedOrder(seq, walkBehind, FIXTURES.walk(), 'behind').misses).toEqual([]);
    // On a run (ordered at the knee), the same foreshortened thigh (sign +1) draws the lifted leg in front.
    const runOut = drawOrderFromDepth(layers, track, splitDepth, seq.frames.map((f) => f.t), base, rest, order, undefined, true, 'run');
    const runBehind = behindPerFrame(SETUP, runOut.keys, seq.frames.map((f) => f.t));
    expect(liftedOrder(seq, runBehind, FIXTURES.walk(), 'front').misses).toEqual([]);
    // Planted sign flip: flipping the lifted shin's sign to +1 puts the lifted foot in front and makes the walk bar red.
    const flippedDepth = splitDepth.map((d) => {
      const next = structuredClone(d);
      for (const side of ['r', 'l'] as const) {
        const sh = next[`${side}_shin`];
        if (sh !== undefined && sh.sign !== 0) sh.sign = 1;
      }
      return next;
    });
    const flippedOut = drawOrderFromDepth(layers, track, flippedDepth, seq.frames.map((f) => f.t), base, rest, order, undefined, true, 'walk');
    const flippedBehind = behindPerFrame(SETUP, flippedOut.keys, seq.frames.map((f) => f.t));
    expect(liftedOrder(seq, flippedBehind, FIXTURES.walk(), 'behind').misses.length).toBeGreaterThan(0);
  });
});
