/**
 * rig-c/pose#304: `retarget --draw-order depth` keys rig-c's `drawOrder`
 * timeline from the sequence's derived depth (#281's `layers`): the leg that
 * reads farther from the camera is drawn behind the other, a frame inside #281's
 * tie holding the order before.
 *
 * The fixtures are #281's (examples/walk/make-depth.ts): the frontal run in place
 * (the swinging shin kicked back to 0.41 of its length) and the frontal walk (the
 * lifted foot forward), cleaned with `--depth`, retargeted onto a synthetic
 * limb-cut rig whose leg slots overlap in the draw order — the left leg drawn
 * first at setup, so the run's kicked-back right leg is a keyed swap. The bars
 * (the card): (1) the run's kicked-back leg is behind the standing leg on every
 * frame its shin reads away, and the order returns to setup at the hand-over;
 * (2) the walk's forward foot is in front on its toward frames; (3) without the
 * flag nothing changes (the 13-file sha256 table is the PR's evidence; here, the
 * control's own output); (4) the render at the run's frame 12 draws no pixel of
 * the right leg over the standing left leg; (5) two runs are byte-equal.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plate, readPlate } from 'rig-c/plate';
import { depthDoc, FIXTURES, trueOrder, type DepthFrame } from '../examples/walk/make-depth.ts';
import { layersOf } from '../src/depth.ts';
import { drawOrderFromDepth, drawOrderLines, type DrawOrderKey } from '../src/draworder.ts';
import { readMap, type JointMap, type Rest } from '../src/map.ts';
import { personTrack, readPoseSequence, type PoseSequence } from '../src/pose.ts';
import { rigcCli } from '../src/rigc.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const WAVE = join(ROOT, 'examples', 'wave', 'rig', 'rig.json');
const MAP = join(ROOT, 'examples', 'walk', 'map.json');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const SLOW = 180_000;
/** Bar (1)'s kicked-back shin: at or under this share of its rest length. */
const KICKED = 0.5;

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
  drawOrder?: { source: string; pairs: Array<{ a: string; b: string; limbs: string[]; keyed: boolean; tie: number | null; why?: string; slots: { a: string[]; b: string[] } }>; keys: Array<DrawOrderKey & { frame: number }>; spans: Array<{ behind: string; front: string; frames: [number, number]; keyed: boolean }> };
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
/** Per frame, which leg the keyed order draws behind: 'r' when the right leg's slots are all before the left's. */
function behindPerFrame(setup: readonly string[], keys: readonly DrawOrderKey[], times: readonly number[]): Array<'r' | 'l'> {
  return times.map((t) => {
    const key = [...keys].reverse().find((k) => k.t <= t + 1e-9);
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
const supportAt = (rep: Report, f: number): 'r' | 'l' | null => rep.feet.supports.find((s) => f >= s.frames[0] && f <= s.frames[1])?.side ?? null;

/**
 * Bar (1)'s reading: on every frame the swinging leg's shin reads away (sign −1), its slots behind the
 * standing leg's. Returns the frames that miss, and the per-frame table.
 */
function kickedBehind(seq: PoseSequence, rep: Report, behind: Array<'r' | 'l'>, truth: DepthFrame[]): { misses: number[]; table: string[]; away: number } {
  const table = ['| frame | support | r shin (ratio, sign) | l shin | depth r / l (px) | keyed behind | generator |', '| --- | --- | --- | --- | --- | --- | --- |'];
  const misses: number[] = [];
  let away = 0;
  seq.frames.forEach((f, i) => {
    const stand = supportAt(rep, i);
    const swing = stand === 'r' ? 'l' : stand === 'l' ? 'r' : null;
    const kicked = swing !== null && f.depth![`${swing}_shin`]!.sign === -1;
    if (kicked) {
      away++;
      if (behind[i] !== swing) misses.push(i);
    }
    const t = trueOrder(truth[i]!, 'r_leg', 'l_leg');
    const d = (s: 'r' | 'l') => `${f.depth![`${s}_shin`]!.ratio.toFixed(2)} ${f.depth![`${s}_shin`]!.sign}`;
    table.push(`| ${i} | ${stand ?? '—'} | ${d('r')} | ${d('l')} | ${rep.layers[i]!.depth.r_leg} / ${rep.layers[i]!.depth.l_leg} | ${behind[i]}${kicked ? ' (kicked: ' + swing + ')' : ''} | ${t === 0 ? 'tied' : t > 0 ? 'l behind' : 'r behind'} |`);
  });
  return { misses, table, away };
}

describe('bar (1): the run — the kicked-back leg behind the standing leg on every away frame, the order back to setup at the hand-over', () => {
  test('every frame whose swinging shin reads away draws that leg behind; each key sits within a frame of a hand-over; the generator agrees wherever it orders the legs', () => {
    const truth = FIXTURES.run();
    const r = retargeted('run', true);
    expect(r.ran.stderr).toBe('');
    expect(r.ran.status).toBe(0);
    const keys = r.motion.animations.run!.drawOrder!;
    expect(keys.length).toBeGreaterThan(0);
    const behind = behindPerFrame(SETUP, keys, r.report.frameTimes);
    const k = kickedBehind(r.seq, r.report, behind, truth);
    console.log(`  #304 bar 1 — run, per frame (setup: the left leg behind):\n${k.table.join('\n')}`);
    console.log(`  #304 bar 1 — ${k.away} kicked-back frames, ${k.misses.length} drawn in front (${k.misses.join(', ') || 'none'}); keys at frames ${r.report.drawOrder!.keys.map((x) => x.frame).join(', ')}; support changes at ${r.report.feet.changes.filter((c) => c.from !== null).map((c) => c.frame).join(', ')}`);
    expect(k.away).toBeGreaterThan(20);
    expect(k.misses).toEqual([]);
    // Back to setup at the hand-over: every key (swap or restore) sits within one frame of a change of support FEET
    // reads; the last key, within two of the loop's seam (the clip is cleaned --loop, so its last support hands over to
    // its first at frame n; FEET reads that last span 11 frames long against the stride's 10, the first 9).
    const changes = r.report.feet.changes.filter((c) => c.from !== null).map((c) => c.frame);
    const sup = r.report.feet.supports;
    expect(sup[0]!.side).not.toBe(sup[sup.length - 1]!.side);
    const keyFrames = r.report.drawOrder!.keys.map((x) => x.frame);
    for (const f of keyFrames.slice(0, -1)) expect(changes.some((c) => Math.abs(c - f) <= 1)).toBe(true);
    expect(truth.length - keyFrames[keyFrames.length - 1]!).toBeLessThanOrEqual(2);
    expect(r.report.drawOrder!.keys.filter((x) => x.offsets === undefined).length).toBeGreaterThan(0);
    // Against the generator (true 3D depth), on the frames it orders the legs: a disagreement is only ever a frame
    // inside #281's tie, where the order was held (the late swing: the knee comes forward of the push-off leg by more
    // than the tie in 3D, by less in the derived depth). Their count is the tie's cost, printed.
    const tie = r.report.drawOrder!.pairs[0]!.tie!;
    const wrong = truth.flatMap((f, i) => {
      const t = trueOrder(f, 'r_leg', 'l_leg');
      return t !== 0 && behind[i] !== (t > 0 ? 'l' : 'r') ? [i] : [];
    });
    console.log(`  #304 bar 1 — generator-ordered frames ${truth.filter((f) => trueOrder(f, 'r_leg', 'l_leg') !== 0).length}, keyed against it ${wrong.length} (${wrong.join(', ') || 'none'}), every one inside the tie of ${tie} px`);
    for (const i of wrong) expect(Math.abs(r.report.layers[i]!.depth.r_leg! - r.report.layers[i]!.depth.l_leg!)).toBeLessThan(tie);
    // The DRAWORDER line, ≤ 260 characters.
    const line = linesOf(r.ran, 'DRAWORDER');
    expect(line).toEqual(['DRAWORDER from depth, 6 key(s) over 3 span(s) (leg_r behind leg_l 8–17, 28–37, 48–57)']);
    expect(r.report.drawOrder!.pairs).toEqual([{ a: 'leg_r', b: 'leg_l', limbs: ['r_leg', 'l_leg'], slots: { a: ['leg_r0', 'leg_r1'], b: ['leg_l0', 'leg_l1'] }, keyed: true, tie: 35.89 }]);
    expect(r.report.options.drawOrder).toBe('depth');
  }, SLOW);
});

describe('bar (2): the walk — the forward foot in front on its toward frames', () => {
  test('every frame a shin reads toward (sign +1) draws that leg in front', () => {
    const truth = FIXTURES.walk();
    const r = retargeted('walk', true);
    expect(r.ran.status).toBe(0);
    const behind = behindPerFrame(SETUP, r.motion.animations.walk!.drawOrder!, r.report.frameTimes);
    const table = ['| frame | r thigh / shin | l thigh / shin | depth r / l (px) | keyed in front | generator |', '| --- | --- | --- | --- | --- | --- |'];
    const misses: number[] = [];
    let toward = 0;
    r.seq.frames.forEach((f, i) => {
      const d = f.depth!;
      const fwd = (['r', 'l'] as const).filter((s) => d[`${s}_shin`]!.sign === 1);
      for (const s of fwd) {
        toward++;
        if (behind[i] === s) misses.push(i);
      }
      const t = trueOrder(truth[i]!, 'r_leg', 'l_leg');
      table.push(`| ${i} | ${d.r_thigh!.sign} / ${d.r_shin!.sign} | ${d.l_thigh!.sign} / ${d.l_shin!.sign} | ${r.report.layers[i]!.depth.r_leg} / ${r.report.layers[i]!.depth.l_leg} | ${behind[i] === 'r' ? 'l' : 'r'} | ${t === 0 ? 'tied' : t > 0 ? 'r front' : 'l front'} |`);
    });
    console.log(`  #304 bar 2 — walk, per frame:\n${table.join('\n')}`);
    console.log(`  #304 bar 2 — ${toward} toward shin-frames, ${misses.length} drawn behind`);
    expect(toward).toBeGreaterThan(20);
    expect(misses).toEqual([]);
    const wrong = truth.flatMap((f, i) => {
      const t = trueOrder(f, 'r_leg', 'l_leg');
      return t !== 0 && behind[i] !== (t > 0 ? 'l' : 'r') ? [i] : [];
    });
    expect(wrong).toEqual([]);
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

describe('bar (4): the render at the run\'s frame 12 draws no shin through the standing leg', () => {
  test('of the pixels the left (standing) leg draws on its own, none shows the right leg\'s colours with the flag; without it the kicked-back shin covers some (control)', () => {
    const dir = tempDir();
    const count = (r: Retargeted, tag: string): { mask: number; over: number } => {
      const out = join(r.dir, `render-${tag}`);
      const outL = join(r.dir, `render-${tag}-l`);
      for (const [o, extra] of [[out, []], [outL, ['--slot', 'leg_l0,leg_l1']]] as const) {
        const ran = spawnSync(process.execPath, [rigcCli(), 'render', '--candidate', r.build, '--animation', 'run', '--fps', '24', '--max', '512', '--out', o, ...extra], { encoding: 'utf8', cwd: ROOT });
        expect(ran.status).toBe(0);
      }
      const png = join(out, 'run@24fps', 'f0012.png');
      const full = readPlate(png);
      const l = readPlate(join(outL, 'run@24fps', 'f0012.png'));
      const bg = l.get(0, 0);
      const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      let mask = 0;
      let over = 0;
      for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) {
        if (same(l.get(x, y), bg)) continue;
        mask++;
        const c = full.get(x, y);
        if (same(c, RED) || same(c, RED_SHIN)) over++;
      }
      return { mask, over };
    };
    const on = retargeted('run', true, { dir });
    const off = retargeted('run', false, { dir: join(dir, 'off'), sequence: join(dir, 'run.clean.json') });
    expect(on.ran.status).toBe(0);
    expect(off.ran.status).toBe(0);
    const a = count(on, 'on');
    const b = count(off, 'off');
    console.log(`  #304 bar 4 — frame 12: the left leg draws ${a.mask} px; the right leg's colours over them: ${a.over} with --draw-order depth, ${b.over} without`);
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
    const d = drawOrderFromDepth(layers, track, seq.frames.map((f) => f.depth), seq.frames.map((f) => f.t), map, rest, order, undefined, true);
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
    const d2 = drawOrderFromDepth(layers, track, seq.frames.map((f) => f.depth), seq.frames.map((f) => f.t), both, rest, between, undefined, true);
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

describe('mutants: the rule\'s direction and its tie, each making bar (1) red', () => {
  const MUTS = [
    { name: 'the nearer leg drawn behind (direction flipped)', from: "state = za < zb ? 'a' : 'b';", to: "state = za < zb ? 'b' : 'a';" },
    { name: 'no tie (any difference decides)', from: 'const tie = r.pair.tie ?? 0;', to: 'const tie = 0;' },
  ];
  for (const mu of MUTS) {
    test(`mutant: ${mu.name}`, async () => {
      const truth = FIXTURES.run();
      const ref = retargeted('run', true);
      expect(ref.ran.status).toBe(0);
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm304-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        const path = join(d, 'src', 'draworder.ts');
        const src = readFileSync(path, 'utf8');
        expect(src.split(mu.from)).toHaveLength(2);
        writeFileSync(path, src.replace(mu.from, mu.to));
        const m = (await import(path)) as { drawOrderFromDepth: typeof drawOrderFromDepth };
        const track = personTrack(ref.seq, undefined, 'run');
        const layers = track.map((j, i) => layersOf(j, ref.seq.frames[i]!.depth!));
        const map = readMap(readFileSync(MAP, 'utf8'), MAP);
        const wave = JSON.parse(readFileSync(WAVE, 'utf8')) as { bones: Array<{ name: string; parent?: string }> };
        const rest = new Map(wave.bones.map((b) => [b.name, { parent: b.parent ?? null }])) as unknown as Rest;
        const order = SETUP.map((n) => ({ name: n, bone: n === 'torso' ? 'chest' : n }));
        const dd = m.drawOrderFromDepth(layers, track, ref.seq.frames.map((f) => f.depth), ref.report.frameTimes, map, rest, order, undefined, true);
        const behind = behindPerFrame(SETUP, dd.keys, ref.report.frameTimes);
        const k = kickedBehind(ref.seq, ref.report, behind, truth);
        console.log(`  #304 mutant "${mu.name}": ${k.misses.length} of ${k.away} kicked-back frames drawn in front (${k.misses.join(', ')})`);
        expect(k.misses.length).toBeGreaterThan(0);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }
});

describe('rig-c/pose#324: why nothing keyed — the slot count first, and the leg depth gap against the tie', () => {
  type Gap = { a: string; b: string; median: number | null; max: number | null; medianLegs: number | null; maxLegs: number | null; tie: number | null; tieLegs: number | null; passed: number; frames: number };
  const gapsOf = (r: Retargeted): Gap[] => (r.report.drawOrder as unknown as { gaps: Gap[] }).gaps;
  const gapLine = (g: Gap): string =>
    `DRAWGAP ${g.a} / ${g.b}: leg depth gap median ${g.median} px (${g.medianLegs} leg), max ${g.max} px (${g.maxLegs} leg), against the tie of ${g.tie} px (${g.tieLegs} leg); ${g.passed} of ${g.frames} frame(s) passed it`;

  test('bar 1: slots between the pair — the count is in stdout, and the not-keyed pair still gets its gap line', () => {
    const r = retargeted('run', true, { order: ['leg_l0', 'leg_l1', 'torso', 'leg_r0', 'leg_r1'] });
    expect(r.ran.status).toBe(0);
    expect(r.ran.stdout).toContain('not keyed: 1 slot: "torso" is drawn between them');
    expect(r.report.drawOrder!.pairs[0]!.why).toBe('1 slot: "torso" is drawn between them, and a swap would re-layer it (the setup order is not changed here)');
    const gaps = gapsOf(r);
    expect(gaps).toHaveLength(1);
    expect(linesOf(r.ran, 'DRAWGAP')).toEqual([gapLine(gaps[0]!)]);
  }, SLOW);

  test('bar 2: the keyed run — the gap line\'s figures match the report, and the report\'s match the layers', () => {
    const r = retargeted('run', true);
    expect(r.ran.status).toBe(0);
    const [g] = gapsOf(r);
    const line = linesOf(r.ran, 'DRAWGAP');
    console.log(`  #324 bar 2 — ${line[0]}`);
    expect(line).toEqual([gapLine(g!)]);
    expect(line[0]!.length).toBeLessThanOrEqual(260);
    // The report against the layers it reads: |r_leg − l_leg| per frame, its median and max, the frames at or past the tie.
    const d = r.report.layers.map((l) => Math.abs(l.depth.r_leg! - l.depth.l_leg!)).sort((x, y) => x - y);
    const m = d.length >> 1;
    const median = d.length % 2 === 1 ? d[m]! : (d[m - 1]! + d[m]!) / 2;
    expect(g!.frames).toBe(d.length);
    expect(g!.median).toBeCloseTo(median, 2);
    expect(g!.max).toBeCloseTo(d[d.length - 1]!, 2);
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
