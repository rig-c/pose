/**
 * rig-c/pose#288: the pelvis tilt read off the picture, carried by clean as its
 * own track and keyed onto the map's pelvis chain by retarget.
 *
 * The fixture is the walk with a drawn pelvis tilt (examples/walk/make-pelvis.ts):
 * line-art PNG frames drawn with rig-c's plate, written per test into a
 * temporary folder, beside hip keypoints that keep 0.15 of the drawn tilt — a
 * detector's damped hip line. The bars (the card): the retargeted pelvis, posed
 * by rig-c's poser, swings ≥ 0.5 of the drawn swing and correlates ≥ 0.7 with
 * the drawn line frame by frame; on the covered variant, read by the waistband,
 * ≥ 0.7 with the band's edge; on the masked variant the PELVIS line names the
 * hip line and the keys are the hip line's. The control — the same frames with
 * no track — must fail the first two, so the track is what carries the tilt.
 * rig-c/pose#293: the covered variant reduced to the 216-colour palette by an
 * ordered dither, and the same with the hip keypoints on the band's top edge —
 * the waistband reads ≥ 90% of frames on the same bars, and two mutants (no
 * window mean, no patch below the hips) read none.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poseRawAnimation, readModel, type RawBone } from '@rig-c/core/core';
import { bandTilt, drawFrame, PALETTE_STEP, pelvisTilt, tiltedCycle, variantCycle, writePelvisFixture, type Variant } from '../examples/walk/make-pelvis.ts';
import { walkDoc } from '../examples/walk/make-walk.ts';
import { clean } from '../src/clean.ts';
import { CUE_SPREAD, readPelvis, readPelvisKeys } from '../src/pelvis.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { reduceKeys, smoothTrunk, type Reduced } from '../src/reduce.ts';
import { unsmoothedLine } from '../src/run.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const RIG = join(ROOT, 'examples', 'wave', 'rig');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const DEG = 180 / Math.PI;
const SLOW = 120_000;
const N = 24;
const DT = 1 / 24;

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-pelvis-'));
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
function cli(args: string[], cliPath = CLI): Ran {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const linesOf = (r: Ran, tag: string): string[] => r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(tag));

/** The walk's map with a pelvis chain: the hip bone aimed thigh root to thigh root, keyed from r_hip → l_hip. */
function pelvisMap(dir: string): string {
  const map = JSON.parse(readFileSync(join(ROOT, 'examples', 'walk', 'map.json'), 'utf8')) as { chains: unknown[] };
  map.chains.unshift({ name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] });
  const path = join(dir, 'map.json');
  writeFileSync(path, JSON.stringify(map, null, 2));
  return path;
}

interface Pipeline {
  dir: string;
  read: Ran | null;
  clean: Ran;
  retarget: Ran;
  pelvisSeq: string | null;
  cleaned: string;
  motion: string;
  build: string;
}
/**
 * Draw a variant, read it (`mode`, or no `pelvis` step at all with null), clean it as the walk is
 * cleaned (loop, legs 5, rest 7, hold off) and retarget it onto the wave's rig with the pelvis chain.
 */
function pipeline(variant: Variant, mode: 'silhouette' | 'waistband' | 'below-cover' | null, dir = tempDir(), cliPath = CLI, extra: string[] = []): Pipeline {
  const fx = writePelvisFixture(join(dir, 'fixture'), variant);
  const pelvisSeq = mode === null ? null : join(dir, 'pose.pelvis.json');
  const read = mode === null ? null : cli(['pelvis', '--pose', fx.pose, '--frames', fx.frames, '--mode', mode, '--out', pelvisSeq!, ...extra], cliPath);
  const cleaned = join(dir, 'pose.clean.json');
  const c = cli(['clean', '--pose', pelvisSeq ?? fx.pose, '--out', cleaned, '--loop', '--legs', '5', '--rest', '7', '--hold', 'off'], cliPath);
  const motion = join(dir, 'motion.json');
  const build = join(dir, 'build');
  const r = cli(['retarget', '--rig', RIG, '--map', pelvisMap(dir), '--sequence', cleaned, '--out', motion, '--name', 'walk', '--build', build, '--report', join(dir, 'report.json')], cliPath);
  return { dir, read, clean: c, retarget: r, pelvisSeq, cleaned, motion, build };
}

/** The posed rig's hip line on every frame — world degrees of leg_r0 → leg_l0, posed by rig-c's poser from the gated build. */
function posedHipLine(build: string): number[] {
  const path = join(build, 'skeleton.model.json');
  const doc = readModel(readFileSync(path, 'utf8'), path);
  return poseRawAnimation(doc, 'walk', Array.from({ length: N - 1 }, () => DT)).map((p) => {
    const b = new Map<string, RawBone>(p.bones.map((x) => [x.name, x]));
    const r = b.get('leg_r0')!;
    const l = b.get('leg_l0')!;
    return Math.atan2(l.worldY - r.worldY, l.worldX - r.worldX) * DEG;
  });
}
const pp = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
function corr(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  a.forEach((x, i) => {
    sab += (x - ma) * (b[i]! - mb);
    saa += (x - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  });
  return sab / Math.sqrt(saa * sbb);
}
const drawn = () => tiltedCycle().map((f) => pelvisTilt(f.phi));
const band = () => tiltedCycle().map((f) => bandTilt(f.phi));
/** The bar's two figures against a drawn line: swing ratio (posed p-p ÷ drawn p-p) and Pearson r, signed. */
function bars(build: string, truth: number[]): { ratio: number; r: number } {
  const posed = posedHipLine(build);
  return { ratio: pp(posed) / pp(truth), r: corr(posed, truth) };
}

describe('the readers, frame by frame', () => {
  test('silhouette reads the drawn pelvis line on every frame of the drawn walk, within 1.5° of it', () => {
    const cycle = tiltedCycle();
    const seq = readPoseSequence(JSON.stringify((() => {
      const d = tempDir();
      return JSON.parse(readFileSync(writePelvisFixture(d, 'drawn').pose, 'utf8')) as unknown;
    })()), 'fixture');
    const errs = cycle.map((f, i) => {
      const r = readPelvis(drawFrame(f, 'drawn'), seq.frames[i]!.people[0]!.joints, 'silhouette');
      if (!('tilt' in r)) throw new Error(`frame ${i} declined: ${r.why}`);
      return Math.abs(r.tilt - pelvisTilt(f.phi));
    });
    expect(Math.max(...errs)).toBeLessThan(1.5);
  });

  test('waistband reads the band edge on the covered walk, and declines a frame with no garment (the drawn walk) by name', () => {
    const cycle = tiltedCycle();
    const d = tempDir();
    const seq = readPoseSequence(readFileSync(writePelvisFixture(d, 'covered').pose, 'utf8'), 'fixture');
    const errs = cycle.map((f, i) => {
      const r = readPelvis(drawFrame(f, 'covered'), seq.frames[i]!.people[0]!.joints, 'waistband');
      if (!('tilt' in r)) throw new Error(`frame ${i} declined: ${r.why}`);
      return Math.abs(r.tilt - bandTilt(f.phi));
    });
    expect(Math.max(...errs)).toBeLessThan(1.5);
    const none = readPelvis(drawFrame(cycle[0]!, 'drawn'), seq.frames[0]!.people[0]!.joints, 'waistband');
    expect('kind' in none && none.kind).toBe('no garment over the hips');
  });

  test('planted: the masked pelvis is declined by both readers, never guessed', () => {
    const cycle = tiltedCycle();
    const d = tempDir();
    const seq = readPoseSequence(readFileSync(writePelvisFixture(d, 'masked').pose, 'utf8'), 'fixture');
    for (const mode of ['silhouette', 'waistband'] as const) {
      cycle.forEach((f, i) => expect('why' in readPelvis(drawFrame(f, 'masked'), seq.frames[i]!.people[0]!.joints, mode)).toBe(true));
    }
  });

  test('rig-c/pose#293: on the 216-colour dithered band, and with the hips on its edge, waistband reads every frame within 1.5° of the band', () => {
    for (const v of ['dithered', 'dithered-edge'] as const) {
      const cycle = variantCycle(v);
      const seq = readPoseSequence(readFileSync(writePelvisFixture(tempDir(), v).pose, 'utf8'), 'fixture');
      const errs = cycle.map((f, i) => {
        const plate = drawFrame(f, v);
        // The fixture is paletted: every channel a multiple of the palette's step.
        if (i === 0) expect(plate.data.every((x, k) => k % 4 === 3 || x % PALETTE_STEP === 0)).toBe(true);
        const r = readPelvis(plate, seq.frames[i]!.people[0]!.joints, 'waistband');
        if (!('tilt' in r)) throw new Error(`${v} frame ${i} declined: ${r.why}`);
        expect(r.mean).toBe(true);
        expect(r.below !== undefined).toBe(v === 'dithered-edge');
        return Math.abs(r.tilt - bandTilt(f.phi));
      });
      expect(Math.max(...errs)).toBeLessThan(1.5);
    }
  });

  test('the hand keys: linear between keys the short way round, held outside; malformed keys refused by name', () => {
    const doc = (keys: unknown) => JSON.stringify({ spec: 'rig-pose-pelvis-keys/1', keys });
    expect(readPelvisKeys(doc([{ frame: 2, deg: 10 }, { frame: 6, deg: -10 }]), 'k.json', 8)).toEqual([10, 10, 10, 5, 0, -5, -10, -10]);
    expect(readPelvisKeys(doc([{ frame: 0, deg: 170 }, { frame: 2, deg: -170 }]), 'k.json', 3)).toEqual([170, 180, -170]);
    let err = '';
    try {
      readPelvisKeys(doc([{ frame: 3, deg: 1 }, { frame: 3, deg: 2 }, { frame: 9, deg: 0 }, { frame: 1, deg: 400 }]), 'k.json', 8);
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err.split('\n')).toEqual([
      'PELVIS_KEYS: k.json keys[1] "frame" is 3, not after the key before it (3); frames strictly increase',
      'PELVIS_KEYS: k.json keys[2] "frame" is number 9; it must be a frame index in [0, 7]',
      'PELVIS_KEYS: k.json keys[3] "deg" is number 400; it must be Spine degrees in (-180, 180] (r_hip → l_hip, counter-clockwise, y up)',
    ]);
  });
});

/**
 * rig-c/pose#294: hand keys at fractional frames. The fixture is synthetic: a
 * 38-frame, 24 fps sequence (the walk's frames repeated, t = i/24) and 8 drawn
 * keys at frames k × 4.75 — off the integer grid but k = 0, 4 — carrying a known
 * tilt sampled at those times. The bar (the card): the tilt written on every
 * sequence frame equals the linear interpolation between the keys, in seconds
 * from the frames' own times, to ≤ 0.01°; held after the last key. The control:
 * the same keys rounded onto the grid miss it by more, so the bar can fail.
 */
describe('hand keys at fractional frames (rig-c/pose#294)', () => {
  const FRAMES = 38;
  const STEP = 4.75;
  const PERIOD = FRAMES / 24;
  /** The known tilt, degrees, at t seconds. */
  const known = (t: number) => 18 * Math.sin((2 * Math.PI * t) / PERIOD) + 6 * Math.cos((4 * Math.PI * t) / PERIOD);
  const drawn = Array.from({ length: 8 }, (_, k) => ({ frame: k * STEP, deg: Math.round(known((k * STEP) / 24) * 1e6) / 1e6 }));
  /** The linear interpolation between keys at t seconds, keys placed at frame / 24 s; held outside them. */
  const lerp = (keys: Array<{ frame: number; deg: number }>, t: number) => {
    const at = keys.map((k) => ({ t: k.frame / 24, deg: k.deg }));
    if (t <= at[0]!.t) return at[0]!.deg;
    if (t >= at[at.length - 1]!.t) return at[at.length - 1]!.deg;
    const j = at.findIndex((k) => k.t >= t);
    const a = at[j - 1]!;
    const b = at[j]!;
    return a.deg + ((t - a.t) / (b.t - a.t)) * (b.deg - a.deg);
  };
  /** The 38-frame sequence, written to dir. */
  function sequence(dir: string): string {
    const cycle = tiltedCycle();
    const path = join(dir, 'pose.json');
    writeFileSync(path, `${JSON.stringify(walkDoc(Array.from({ length: FRAMES }, (_, i) => cycle[i % cycle.length]!), 'the walk repeated to 38 frames at 24 fps (rig-c/pose#294)'), null, 2)}\n`);
    return path;
  }
  const keysFile = (dir: string, name: string, keys: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ spec: 'rig-pose-pelvis-keys/1', keys }));
    return path;
  };

  test('8 keys at k × 4.75 over 38 frames: the written tilt is the keys\' linear interpolation to ≤ 0.01° on every frame; the keys rounded onto the grid are not', () => {
    const dir = tempDir();
    const pose = sequence(dir);
    const out = join(dir, 'pose.pelvis.json');
    const r = cli(['pelvis', '--pose', pose, '--pelvis-keys', keysFile(dir, 'keys.json', drawn), '--out', out]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(out, 'utf8')) as { spec: string; pelvisSource: string; frames: Array<{ t: number; pelvisTilt: number }> };
    expect(doc.spec).toBe('rig-pose-sequence/1.1');
    expect(doc.pelvisSource).toBe('keys');
    expect(doc.frames).toHaveLength(FRAMES);
    const err = doc.frames.map((f) => Math.abs(f.pelvisTilt - lerp(drawn, f.t)));
    expect(Math.max(...err)).toBeLessThanOrEqual(0.01);
    // On a key's own frame (0, 19) the tilt is the key's; after the last key (33.25) it is held.
    expect(doc.frames[19]!.pelvisTilt).toBeCloseTo(drawn[4]!.deg, 3);
    for (const i of [34, 35, 36, 37]) expect(doc.frames[i]!.pelvisTilt).toBeCloseTo(drawn[7]!.deg, 3);

    const rounded = drawn.map((k) => ({ frame: Math.round(k.frame), deg: k.deg }));
    const outR = join(dir, 'pose.rounded.json');
    expect(cli(['pelvis', '--pose', pose, '--pelvis-keys', keysFile(dir, 'rounded.json', rounded), '--out', outR]).status).toBe(0);
    const docR = JSON.parse(readFileSync(outR, 'utf8')) as { frames: Array<{ t: number; pelvisTilt: number }> };
    expect(Math.max(...docR.frames.map((f) => Math.abs(f.pelvisTilt - lerp(drawn, f.t))))).toBeGreaterThan(0.5);
  });

  test('a fractional key interpolates the short way round; a key outside the span [0, frames − 1] is refused by name, nothing written', () => {
    const doc = (keys: unknown) => JSON.stringify({ spec: 'rig-pose-pelvis-keys/1', keys });
    expect(readPelvisKeys(doc([{ frame: 0.5, deg: 170 }, { frame: 2.5, deg: -170 }]), 'k.json', 4)).toEqual([170, 175, -175, -170]);
    let err = '';
    try {
      readPelvisKeys(doc([{ frame: -0.25, deg: 0 }, { frame: 2.5, deg: 1 }, { frame: 7.5, deg: 2 }, { frame: '3', deg: 0 }]), 'k.json', 8);
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err.split('\n')).toEqual([
      'PELVIS_KEYS: k.json keys[0] "frame" is number -0.25; it must be a frame index in [0, 7]',
      'PELVIS_KEYS: k.json keys[2] "frame" is number 7.5; it must be a frame index in [0, 7]',
      'PELVIS_KEYS: k.json keys[3] "frame" is the string "3"; it must be a frame index in [0, 7]',
    ]);
    const dir = tempDir();
    const out = join(dir, 'never.json');
    const r = cli(['pelvis', '--pose', sequence(dir), '--pelvis-keys', keysFile(dir, 'late.json', [...drawn, { frame: 37.25, deg: 0 }]), '--out', out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`FAIL  PELVIS_KEYS: ${join(dir, 'late.json')} keys[8] "frame" is number 37.25; it must be a frame index in [0, 37]`);
    expect(r.stderr).toContain('nothing written');
    expect(() => readFileSync(out)).toThrow();
  });
});

describe('the sequence format: minor 1.1 carries the track', () => {
  const base = () => {
    const d = tempDir();
    return JSON.parse(readFileSync(writePelvisFixture(d, 'drawn').pose, 'utf8')) as Record<string, unknown> & { frames: Array<Record<string, unknown>> };
  };
  const refusal = (doc: unknown): string[] => {
    try {
      readPoseSequence(JSON.stringify(doc), 'p.json');
      return [];
    } catch (e) {
      return (e as Error).message.split('\n');
    }
  };

  test('the writer writes /1.1 exactly when the track is there, /1 otherwise, and reads its own bytes back', () => {
    const doc = base();
    const plain = readPoseSequence(JSON.stringify(doc), 'p.json');
    expect(JSON.parse(writePoseSequence(plain)).spec).toBe('rig-pose-sequence/1');
    const tracked = { ...plain, pelvisSource: 'silhouette' as const, frames: plain.frames.map((f, i) => ({ ...f, pelvisTilt: i === 3 ? null : 1.23456 })) };
    const text = writePoseSequence(tracked);
    const back = JSON.parse(text) as { spec: string; pelvisSource: string; frames: Array<{ pelvisTilt: number | null }> };
    expect(back.spec).toBe('rig-pose-sequence/1.1');
    expect(back.pelvisSource).toBe('silhouette');
    expect(back.frames[0]!.pelvisTilt).toBe(1.235);
    expect(back.frames[3]!.pelvisTilt).toBeNull();
    expect(writePoseSequence(readPoseSequence(text, 'p.json'))).toBe(text);
  });

  test('planted: a /1 file carrying the track is refused naming the minor; a partial track and a source without a track are refused', () => {
    const doc = base();
    doc.pelvisSource = 'silhouette';
    doc.frames.forEach((f) => (f.pelvisTilt = 0));
    expect(refusal(doc)).toEqual([
      'POSE_SPEC: p.json carries "pelvisSource", a key of "rig-pose-sequence/1.1", and the file says "rig-pose-sequence/1"; a sequence carrying the pelvis track is written as "rig-pose-sequence/1.1" (rig-pose pelvis)',
      'POSE_SPEC: p.json 24 frames (0–23) carries "pelvisTilt", a key of "rig-pose-sequence/1.1", and the file says "rig-pose-sequence/1"; a sequence carrying the pelvis track is written as "rig-pose-sequence/1.1" (rig-pose pelvis)',
    ]);
    doc.spec = 'rig-pose-sequence/1.1';
    expect(refusal(doc)).toEqual([]);
    delete doc.frames[5]!.pelvisTilt;
    doc.frames[6]!.pelvisTilt = 'level';
    doc.pelvisSource = 'eyeballed';
    expect(refusal(doc)).toEqual([
      'POSE_PELVIS: p.json frames[6] "pelvisTilt" is the string "level"; it must be Spine degrees in (-180, 180] (the direction r_hip → l_hip, counter-clockwise, y up), or null where the reading declined the frame',
      'POSE_PELVIS: p.json "pelvisSource" is the string "eyeballed"; it must be one of "silhouette", "waistband", "below-cover", "keys" (where every frame\'s "pelvisTilt" came from)',
      'POSE_PELVIS: p.json has "pelvisSource" and frame(s) 5 carry no "pelvisTilt"; with a pelvis track every frame carries one (null where the reading declined it)',
    ]);
    delete doc.pelvisSource;
    doc.frames[6]!.pelvisTilt = 0;
    expect(refusal(doc)).toEqual(['POSE_PELVIS: p.json has "pelvisTilt" on 23 frame(s) and no "pelvisSource"; a pelvis track says where it came from (silhouette, waistband, below-cover, keys)']);
  });

  test('a file of a newer minor is read, and each key it adds is refused naming the minor the file says wrote it', () => {
    const doc = base();
    doc.spec = 'rig-pose-sequence/1.3';
    expect(refusal(doc)).toEqual([]);
    doc.lens = 'front';
    doc.frames[2]!.blur = 0.3;
    const note = '; the file says it was written as "rig-pose-sequence/1.3", a newer minor than this reader\'s "rig-pose-sequence/1.2" — read it with a rig-pose that reads that minor';
    expect(refusal(doc)).toEqual([
      `POSE_KEYS: p.json has a key this reader does not know: "lens"; the keys it reads are spec, space, width, height, source, frames, cameraSource, camera, cleaned, travel, pelvisSource${note}`,
      `POSE_KEYS: p.json frames[2] has a key this reader does not know: "blur"; the keys it reads are t, people, pelvisTilt, depth${note}`,
    ]);
    // Control: the same unknown key in a file of a minor this reader reads names no newer minor — the key is simply not in the format.
    doc.spec = 'rig-pose-sequence/1';
    delete doc.frames[2]!.blur;
    expect(refusal(doc)).toEqual(['POSE_KEYS: p.json has a key this reader does not know: "lens"; the keys it reads are spec, space, width, height, source, frames, cameraSource, camera, cleaned, travel']);
  });

  test('clean smooths the track as its own (the legs\' window, wrapped with loop), keeps a null null, and records it', () => {
    const doc = base();
    const seq = readPoseSequence(JSON.stringify(doc), 'p.json');
    const tilt = Array.from({ length: N }, (_, i) => (i === 7 ? null : 179 * (i % 2 === 0 ? 1 : -1)));
    const c = clean({ ...seq, pelvisSource: 'keys', frames: seq.frames.map((f, i) => ({ ...f, pelvisTilt: tilt[i]! })) }, { loop: true, legs: 5, rest: 7, hold: 'off' }, undefined, 'p.json');
    expect(c.record.params.pelvis).toEqual({ window: 5 });
    expect(c.seq.frames[7]!.pelvisTilt).toBeNull();
    // ±179 alternating is ±1° about 180: smoothed about 180, not about 0 (the wrap is taken).
    for (const f of c.seq.frames) if (f.pelvisTilt !== null) expect(Math.abs(Math.abs(f.pelvisTilt!) - 180)).toBeLessThan(1);
    const text = writePoseSequence(c.seq);
    expect(JSON.parse(text).cleaned.params.pelvis).toEqual({ window: 5 });
    // A track added after clean (no record of smoothing it) is refused by name.
    const after = JSON.parse(text) as { cleaned: { params: Record<string, unknown> } };
    delete after.cleaned.params.pelvis;
    expect(refusal(after)).toEqual(['POSE_PELVIS: p.json carries a pelvis track and its "cleaned" record has no "params" "pelvis"; clean smooths the track and records it, so the track was added after clean — run rig-pose pelvis before rig-pose clean']);
  });
});

describe('rig-pose pelvis → clean → retarget on the walk with a drawn pelvis tilt', () => {
  test('drawn, read by silhouette: the posed pelvis swings ≥ 0.5 of the drawn swing and correlates ≥ 0.7 with it; the control without the track does not', () => {
    const run = pipeline('drawn', 'silhouette');
    expect(run.read!.stderr).toBe('');
    expect(run.read!.status).toBe(0);
    expect(run.clean.status).toBe(0);
    expect(linesOf(run.clean, 'PELVIS')[0]).toStartWith('PELVIS pelvisTilt (silhouette) smoothed as its own track over 5 frames (the legs\' window), circular, on the 24 of 24 frame(s)');
    expect(run.retarget.stderr).toBe('');
    expect(run.retarget.status).toBe(0);
    const line = linesOf(run.retarget, 'PELVIS:');
    expect(line).toHaveLength(1);
    expect(line[0]).toMatch(/^PELVIS: from silhouette, swing \d+\.\d\d° \(bone "hip", chain "pelvis"; all 24 frames from the track\)$/);
    const b = bars(run.build, drawn());
    expect(b.ratio).toBeGreaterThanOrEqual(0.5);
    expect(b.r).toBeGreaterThanOrEqual(0.7);
    const report = JSON.parse(readFileSync(join(run.dir, 'report.json'), 'utf8')) as { pelvis: Record<string, unknown> };
    expect(report.pelvis).toMatchObject({ source: 'silhouette', trackSource: 'silhouette', bone: 'hip', chain: 'pelvis', track: 24, hipLine: 0, declined: [] });

    const control = pipeline('drawn', null);
    expect(control.retarget.status).toBe(0);
    expect(linesOf(control.retarget, 'PELVIS:')[0]).toMatch(/^PELVIS: from hip line \(no track\), swing \d+\.\d\d° \(bone "hip", chain "pelvis"; every frame from r_hip → l_hip\)$/);
    const c = bars(control.build, drawn());
    expect(c.ratio).toBeLessThan(0.5);
  }, SLOW);

  /**
   * rig-c/pose#295: POSTURE reads the tilt off the track the pelvis was keyed from, and its sway says what the
   * track's turn carries. The bars (the card): the tilt line's reference is the track's swing within 1° and names
   * the track; the sway line states that the turn includes the pelvis track. The control — the same frames with no
   * track — reads the hip line, which misses the track's swing by more than 1°, and prints no carry line.
   */
  test('POSTURE reads the tilt from the track and names it; the sway states that the rig\'s turn includes the pelvis track (#295)', () => {
    const run = pipeline('drawn', 'silhouette');
    expect(run.retarget.status).toBe(0);
    const tilt = (doc: string) => (JSON.parse(readFileSync(doc, 'utf8')) as { frames: Array<{ pelvisTilt: number }> }).frames.map((f) => f.pelvisTilt);
    const swing = pp(tilt(run.cleaned));
    const posture = linesOf(run.retarget, 'POSTURE');
    const t = /^POSTURE hip tilt range \(chain "pelvis", r_hip → l_hip, Spine degrees\): reference (\d+\.\d)° from silhouette \([^;]*; all 24 frames from the track\), rig /.exec(posture[0]!);
    expect(t).not.toBeNull();
    expect(Math.abs(Number(t![1]) - swing)).toBeLessThanOrEqual(1);
    const report = JSON.parse(readFileSync(join(run.dir, 'report.json'), 'utf8')) as { posture: { tilt: { reference: { range: number } }; tiltTrack: unknown; sway: { reference: { range: number }; rig: { range: number }; carried: { bone: string; origins: string[]; carry: number; trunk: { range: number } } } } };
    expect(Math.abs(report.posture.tilt.reference.range - swing)).toBeLessThanOrEqual(1);
    expect(report.posture.tiltTrack).toEqual({ source: 'silhouette', frames: 24, declined: [] });
    expect(posture[1]).toStartWith('POSTURE sway, x-range of mid_hip − mid_shoulder: ');
    expect(posture[2]).toMatch(/^POSTURE sway: the rig's \d+\.\d units include the pelvis track's turn — bone "hip" \(keyed from silhouette\) carries "chest" over \d+\.\d units of x; the trunk alone \(mid_shoulder about that origin\) \d+\.\d units — rig\/reference \d\.\d{3} in units$/);
    const c = report.posture.sway.carried;
    expect(c).toMatchObject({ bone: 'hip', origins: ['chest'] });
    // The carry is what moved the rig's sway past the reference's: taken out, the trunk alone is below it.
    expect(report.posture.sway.rig.range / report.posture.sway.reference.range).toBeGreaterThan(1.5);
    expect(c.trunk.range).toBeLessThan(report.posture.sway.reference.range);

    const control = pipeline('drawn', null);
    expect(control.retarget.status).toBe(0);
    const cp = linesOf(control.retarget, 'POSTURE');
    const ct = /reference (\d+\.\d)° \(/.exec(cp[0]!);
    expect(ct).not.toBeNull();
    expect(Math.abs(Number(ct![1]) - swing)).toBeGreaterThan(1);
    expect(cp.join('\n')).not.toContain('from the track');
    expect(cp.some((l) => l.startsWith('POSTURE sway: the rig'))).toBe(false);
  }, SLOW);

  test('covered, read by the waistband: the posed pelvis correlates ≥ 0.7 with the band\'s edge', () => {
    const run = pipeline('covered', 'waistband');
    expect(run.read!.status).toBe(0);
    expect(run.retarget.status).toBe(0);
    expect(linesOf(run.retarget, 'PELVIS:')[0]).toStartWith('PELVIS: from waistband, swing ');
    const b = bars(run.build, band());
    expect(b.r).toBeGreaterThanOrEqual(0.7);
    expect(b.ratio).toBeGreaterThanOrEqual(0.5);
  }, SLOW);

  for (const v of ['dithered', 'dithered-edge'] as const) {
    test(`rig-c/pose#293 ${v}: the waistband reads ≥ 90% of the frames and the posed pelvis swings ≥ 0.5× the band's edge and correlates ≥ 0.7 with it`, () => {
      const run = pipeline(v, 'waistband');
      expect(run.read!.stderr).toBe('');
      expect(run.read!.status).toBe(0);
      const tilt = (JSON.parse(readFileSync(run.pelvisSeq!, 'utf8')) as { frames: Array<{ pelvisTilt: number | null }> }).frames.map((f) => f.pelvisTilt);
      expect(tilt.filter((t) => t !== null).length).toBeGreaterThanOrEqual(0.9 * N);
      expect(linesOf(run.read!, 'PELVIS')[0]).toContain('of the frames read, 24 through the 5×5 window mean');
      if (v === 'dithered-edge') expect(linesOf(run.read!, 'PELVIS')[0]).toContain('24 with the colour found below the hips');
      expect(run.retarget.status).toBe(0);
      expect(linesOf(run.retarget, 'PELVIS:')[0]).toStartWith('PELVIS: from waistband, swing ');
      const b = bars(run.build, band());
      expect(b.ratio).toBeGreaterThanOrEqual(0.5);
      expect(b.r).toBeGreaterThanOrEqual(0.7);
    }, SLOW);
  }

  test('mutants (rig-c/pose#293): without the window mean the dithered band reads no frame; without the patches below the hips the band under hips on its edge reads none', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      const cases = [
        { name: 'no-mean', from: 'for (const isMean of [false, true])', to: 'for (const isMean of [false])', variant: 'dithered' as const },
        { name: 'no-below', from: 'for (const below of [0, r, 2 * r])', to: 'for (const below of [0])', variant: 'dithered-edge' as const },
      ];
      for (const m of cases) {
        const src = readFileSync(join(ROOT, 'src', 'pelvis.ts'), 'utf8');
        expect(src.split(m.from)).toHaveLength(2);
        const dir = join(d, m.name);
        cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'pelvis.ts'), src.replace(m.from, m.to));
        cpSync(join(ROOT, 'cli.ts'), join(dir, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
        const run = pipeline(m.variant, 'waistband', tempDir(), join(dir, 'cli.ts'));
        expect(run.read!.status).toBe(0);
        expect(linesOf(run.read!, 'PELVIS')[0]).toStartWith('PELVIS waistband read none of the 24 frame(s)');
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('masked: no frame is read, the PELVIS line names the hip line, and the motion is the no-track run\'s byte for byte', () => {
    const run = pipeline('masked', 'silhouette');
    expect(run.read!.status).toBe(0);
    expect(linesOf(run.read!, 'DECLINED')[0]).toStartWith('DECLINED frames 0–23 (24): no straight edge spans the hips');
    expect(run.retarget.status).toBe(0);
    expect(linesOf(run.retarget, 'PELVIS:')[0]).toMatch(/^PELVIS: from hip line \(the silhouette track read none of the 24 frames\), swing \d+\.\d\d° \(bone "hip", chain "pelvis"; every frame from r_hip → l_hip\)$/);
    const control = pipeline('masked', null);
    expect(readFileSync(run.motion, 'utf8')).toBe(readFileSync(control.motion, 'utf8'));
  }, SLOW);

  test('determinism: a second run writes the same bytes — sequence, cleaned sequence, motion and output', () => {
    const a = pipeline('drawn', 'silhouette');
    const b = pipeline('drawn', 'silhouette');
    for (const k of ['pelvisSeq', 'cleaned', 'motion'] as const) expect(readFileSync(b[k]!, 'utf8')).toBe(readFileSync(a[k]!, 'utf8'));
    const out = (p: Pipeline) => [p.read!.stdout, p.clean.stdout, p.retarget.stdout].join('\n').split(p.dir).join('<dir>');
    expect(out(b)).toBe(out(a));
  }, SLOW);

  test('the hand keys set pelvisSource "keys", and retarget names them', () => {
    const dir = tempDir();
    const fx = writePelvisFixture(join(dir, 'fixture'), 'masked');
    const keys = join(dir, 'keys.json');
    writeFileSync(keys, JSON.stringify({ spec: 'rig-pose-pelvis-keys/1', keys: [{ frame: 0, deg: 0 }, { frame: 6, deg: 15 }, { frame: 18, deg: -15 }, { frame: 23, deg: -3.75 }] }));
    const seq = join(dir, 'pose.pelvis.json');
    const r = cli(['pelvis', '--pose', fx.pose, '--pelvis-keys', keys, '--out', seq]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(seq, 'utf8')).pelvisSource).toBe('keys');
    const cleaned = join(dir, 'pose.clean.json');
    expect(cli(['clean', '--pose', seq, '--out', cleaned, '--loop', '--hold', 'off']).status).toBe(0);
    const rt = cli(['retarget', '--rig', RIG, '--map', pelvisMap(dir), '--sequence', cleaned, '--out', join(dir, 'm.json'), '--name', 'walk', '--build', join(dir, 'build')]);
    expect(rt.status).toBe(0);
    expect(linesOf(rt, 'PELVIS:')[0]).toStartWith('PELVIS: from keys, swing ');
  }, SLOW);

  test('a track and a map without a pelvis chain: the PELVIS line says nothing is keyed; refusals and usage errors by name', () => {
    const dir = tempDir();
    const fx = writePelvisFixture(join(dir, 'fixture'), 'drawn');
    const seq = join(dir, 'pose.pelvis.json');
    expect(cli(['pelvis', '--pose', fx.pose, '--frames', fx.frames, '--out', seq]).status).toBe(0);
    const cleaned = join(dir, 'pose.clean.json');
    expect(cli(['clean', '--pose', seq, '--out', cleaned, '--loop', '--hold', 'off']).status).toBe(0);
    const rt = cli(['retarget', '--rig', RIG, '--map', join(ROOT, 'examples', 'walk', 'map.json'), '--sequence', cleaned, '--out', join(dir, 'm.json'), '--name', 'walk']);
    expect(rt.status).toBe(0);
    expect(linesOf(rt, 'PELVIS:')).toEqual(['PELVIS: not keyed — the sequence carries a silhouette track (24 of 24 frames read) and the map has no pelvis chain (one bone, joints r_hip → l_hip); no bone turns with the pelvis']);
    // Twice, or after clean: refused, nothing written.
    const again = cli(['pelvis', '--pose', cleaned, '--frames', fx.frames, '--out', join(dir, 'x.json')]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('FAIL  PELVIS_AFTER_CLEAN: ');
    expect(again.stderr).toContain('FAIL  PELVIS_TRACK: ');
    // The frame count must match.
    const few = join(dir, 'few');
    mkdirSync(few);
    cpSync(join(fx.frames, 'f00.png'), join(few, 'f00.png'));
    const short = cli(['pelvis', '--pose', fx.pose, '--frames', few, '--out', join(dir, 'y.json')]);
    expect(short.status).toBe(1);
    expect(short.stderr).toContain(`FAIL  PELVIS_FRAMES: --frames ${few} holds 1 PNG file(s) and ${fx.pose} 24 frame(s)`);
    // Usage: exactly one of --frames and --pelvis-keys; --mode only with the frames.
    expect(cli(['pelvis', '--pose', fx.pose, '--out', join(dir, 'z.json')]).status).toBe(2);
    expect(cli(['pelvis', '--pose', fx.pose, '--out', join(dir, 'z.json'), '--frames', fx.frames, '--pelvis-keys', 'k.json']).status).toBe(2);
    expect(cli(['pelvis', '--pose', fx.pose, '--out', join(dir, 'z.json'), '--frames', fx.frames, '--mode', 'hem']).stderr).toContain('--mode is "hem"; it must be silhouette or waistband or below-cover');
  }, SLOW);

  test('mutant: the reader\'s right-to-left sense flipped makes the drawn walk\'s correlation negative (the bar is signed)', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'pelvis.ts');
      const before = readFileSync(path, 'utf8');
      const from = 'lHip[0] >= rHip[0] ? [1, m] : [-1, -m]';
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'lHip[0] >= rHip[0] ? [1, -m] : [-1, m]'));
      const run = pipeline('drawn', 'silhouette', tempDir(), join(d, 'cli.ts'));
      expect(run.retarget.status).toBe(0);
      expect(bars(run.build, drawn()).r).toBeLessThan(-0.7);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

// --- #320: --reduce holds a reduced parent to its tightest planted or aimed child ----------------

describe('#320: a per-chain --reduce holds the pelvis to the legs\' tolerance under a pelvis track', () => {
  /**
   * The drawn walk read by the silhouette and cleaned as above: the pelvis chain carries the drawn ±15° on bone
   * "hip", above both legs. Under `--plant-feet` each leg carries an ankle the landing check holds, within an allowance
   * that counts the hip's lever to the thigh at the leg's own degrees (#94, #283) — so the hip must be reduced within
   * them too, or its error moves both ankles past it.
   */
  function tracked(dir = tempDir()): { dir: string; map: string; cleaned: string } {
    const fx = writePelvisFixture(join(dir, 'fixture'), 'drawn');
    const read = join(dir, 'pose.pelvis.json');
    expect(cli(['pelvis', '--pose', fx.pose, '--frames', fx.frames, '--mode', 'silhouette', '--out', read]).status).toBe(0);
    const cleaned = join(dir, 'pose.clean.json');
    expect(cli(['clean', '--pose', read, '--out', cleaned, '--loop', '--legs', '5', '--rest', '7', '--hold', 'off']).status).toBe(0);
    return { dir, map: pelvisMap(dir), cleaned };
  }
  interface HeldReport {
    landings: Array<{ bone: string; kind: string; worst: number; tolerance: number }>;
    reduce: { held?: unknown[] };
  }
  function run(c: { dir: string; map: string; cleaned: string }, reduce: string, name: string, cliPath = CLI): { ran: Ran; rep: HeldReport | null; motion: string } {
    const motion = join(c.dir, `${name}.motion.json`);
    const report = join(c.dir, `${name}.report.json`);
    const ran = cli(['retarget', '--rig', RIG, '--map', c.map, '--sequence', c.cleaned, '--out', motion, '--name', 'walk', '--plant-feet', '--reduce', reduce, '--report', report], cliPath);
    return { ran, rep: ran.status === 0 ? (JSON.parse(readFileSync(report, 'utf8')) as HeldReport) : null, motion };
  }
  const LEGS = '3,leg_r=0.2,leg_l=0.2';

  test('the legs\' 0.2° holds bone "hip" to 0.2°: both ankles and the head land with no pelvis= entry, and the report says why', () => {
    const c = tracked();
    const x = run(c, LEGS, 'legs');
    expect(x.ran.stderr).toBe('');
    expect(x.ran.status).toBe(0);
    for (const b of ['leg_r1:tip', 'leg_l1:tip', 'head']) {
      const l = x.rep!.landings.find((y) => y.bone === b)!;
      expect(l.worst).toBeLessThanOrEqual(l.tolerance);
    }
    expect(x.rep!.landings.find((y) => y.bone === 'hip' && y.kind === 'angle')!.tolerance).toBe(0.21);
    expect(linesOf(x.ran, 'REDUCE held')).toEqual([
      'REDUCE held: bone "hip" (chain "pelvis") reduced within 0.2°, not 3° — for chain "leg_r" (a planted ankle; L = 15 units to bone "leg_r0"), chain "leg_l" (a planted ankle; L = 15 units to bone "leg_l0") below it, reduced within 0.2°: a turn error θ on bone "hip" moves a chain below it by θ·L and turns it by θ, and the ankle allowance counts L at the leg\'s own degrees, so θ ≤ 0.2°',
    ]);
    expect(linesOf(x.ran, 'REDUCE bone "hip" rotate:')[0]).toEndWith('— held to 0.2° for chain "leg_r", chain "leg_l" below it');
    expect(x.rep!.reduce.held).toEqual([
      { bone: 'hip', chain: 'pelvis', from: 3, to: 0.2, for: [{ chain: 'leg_r', by: 'ankle', bone: 'leg_r0', lever: 15 }, { chain: 'leg_l', by: 'ankle', bone: 'leg_l0', lever: 15 }] },
    ]);
    // The hold is the hand entry it replaces, byte for byte.
    const hand = run(c, `${LEGS},pelvis=0.2`, 'hand');
    expect(hand.ran.status).toBe(0);
    expect(readFileSync(x.motion).equals(readFileSync(hand.motion))).toBe(true);
    expect(linesOf(hand.ran, 'REDUCE held')).toEqual([]);
    expect('held' in hand.rep!.reduce).toBe(false);
  }, SLOW);

  test('an aimed chain holds the bones above it; a plain --reduce, a bent chain\'s entry, and a chain at the run\'s own tolerance hold nothing', () => {
    const c = tracked();
    const head = run(c, `${LEGS},head=1`, 'head');
    expect(head.ran.status).toBe(0);
    expect(head.rep!.reduce.held).toEqual([
      { bone: 'chest', chain: 'trunk', from: 3, to: 1, for: [{ chain: 'head', by: 'aim', bone: 'head', lever: 105 }] },
      { bone: 'hip', chain: 'pelvis', from: 3, to: 0.2, for: [{ chain: 'leg_r', by: 'ankle', bone: 'leg_r0', lever: 15 }, { chain: 'leg_l', by: 'ankle', bone: 'leg_l0', lever: 15 }] },
    ]);
    expect(head.rep!.landings.find((y) => y.bone === 'chest' && y.kind === 'angle')!.tolerance).toBe(1.01);
    expect(linesOf(head.ran, 'REDUCE held: bone "chest"')[0]).toContain('an aimed chain refits against its parent\'s error within its own, so θ ≤ 1°');
    const plain = run(c, '3', 'plain');
    expect(plain.ran.status).toBe(0);
    for (const [reduce, name] of [['3,arm_r=0.5', 'arm'], ['3,leg_r=3,pelvis=3', 'same']] as const) {
      const y = run(c, reduce, name);
      expect(y.ran.status).toBe(0);
      expect(linesOf(y.ran, 'REDUCE held')).toEqual([]);
      expect('held' in y.rep!.reduce).toBe(false);
    }
    expect(linesOf(plain.ran, 'REDUCE held')).toEqual([]);
    expect('held' in plain.rep!.reduce).toBe(false);
    expect(readFileSync(join(c.dir, 'same.motion.json')).equals(readFileSync(plain.motion))).toBe(true);
  }, SLOW);

  // 0.40.0's behaviour: the hold computed and printed but not handed to the reduction — the hip reduced within 3° moves both ankles past their allowance.
  test('mutant: the hold not applied — POSE_LANDS names both planted ankles', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'run.ts');
      const before = readFileSync(path, 'utf8');
      const from = 'reduceOf = (bone) => held.find((h) => h.bone === bone)?.to ?? first(bone);';
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'reduceOf = first;'));
      const c = tracked();
      expect(run(c, LEGS, 'ours').ran.status).toBe(0);
      const m = run(c, LEGS, 'mutant', join(d, 'cli.ts'));
      expect(m.ran.status).toBe(1);
      const miss = m.ran.stderr.split('\n').filter((l) => /POSE_LANDS: bone "leg_[rl]1:tip" ankle/.test(l));
      expect(miss).toHaveLength(2);
      console.log(`  mutant "#320 hold not applied": ${miss[0]!.slice(0, 160)}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('the trunk smoothing (#116) is kept only within every bone\'s own tolerance; past it the fitted keys stand, named', () => {
    const times = Array.from({ length: 24 }, (_, i) => i / 24);
    // The control: a slow turn the fit holds within 1°, and its smoothing with it.
    const bone = (name: string, above: string | null, dense: number[]) => ({ bone: name, above, dense, keep: new Set<number>() });
    const slow = [bone('chest', null, times.map((t) => 20 * Math.sin(2 * Math.PI * t))), bone('head', 'chest', times.map((t) => 10 * Math.cos(2 * Math.PI * t)))];
    const kept = reduceKeys(times, slow, 1, null);
    smoothTrunk(times, slow, 1, kept, new Set(['chest', 'head']));
    expect(kept.unsmoothed).toBeUndefined();
    for (const e of kept.errors.values()) expect(Math.max(...e.map(Math.abs))).toBeLessThanOrEqual(1);
    // Planted: three keys handed in on a ±10° zigzag that no curve on them follows within 1°.
    const zig = times.map((_, i) => (i % 2 === 0 ? 10 : -10));
    const planted = [bone('chest', null, zig), bone('head', 'chest', zig.map((v) => -v))];
    const three = [{ t: times[0]!, v: [0] }, { t: times[12]!, v: [0] }, { t: times[23]!, v: [0] }];
    const out: Reduced = { rotate: new Map([['chest', three], ['head', three]]), hip: null, rows: [], errors: new Map([['chest', zig.map((v) => -v)], ['head', zig.map(() => 0)]]) };
    smoothTrunk(times, planted, 1, out, new Set(['chest', 'head']));
    expect(out.rotate.get('chest')).toBe(three);
    expect(out.rotate.get('head')).toBe(three);
    expect(out.unsmoothed).toHaveLength(1);
    const u = out.unsmoothed![0]!;
    expect(u.root).toBe('chest');
    expect(u.worst).toBeGreaterThan(u.tolerance);
    expect(unsmoothedLine({ root: 'chest', bone: 'head', worst: 3.1605, tolerance: 3 })).toBe('smoothing (rig-c/pose#116) from bone "chest" down not kept: it left bone "head" at 3.16°, past its 3°; the fitted keys stand, each within its tolerance');
  });
});

/**
 * rig-c/pose#318: the waistband is read at its top edge. Two variants of #293's dithered band: `dithered-fold`, a fold
 * of darker cloth below a line turned 15° from the band on every fourth frame, and `dithered-strip`, a thin two-line
 * strip at the band's top (a second ink line under the top edge across half the hips). The bars (the card): every frame
 * read is within 3° of the band's edge, or declined by name, and the retargeted swing is within 1.5× of the band's.
 * Two mutants: without the climb to the band's top the strip reads the stair between its lines; without the test for an
 * edge cutting across the band the fold frame it declines reads the fold.
 */
describe('the band\'s top edge (rig-c/pose#318)', () => {
  /** The waistband's reading of each frame of a variant against the band's edge: errors of the frames read, declines by kind. */
  function readAll(v: 'dithered-fold' | 'dithered-strip') {
    const cycle = variantCycle(v);
    const seq = readPoseSequence(readFileSync(writePelvisFixture(tempDir(), v).pose, 'utf8'), 'fixture');
    const errs: number[] = [];
    const declined: Array<[number, string]> = [];
    let raised = 0;
    cycle.forEach((f, i) => {
      const r = readPelvis(drawFrame(f, v), seq.frames[i]!.people[0]!.joints, 'waistband');
      if ('tilt' in r) {
        errs.push(Math.abs(r.tilt - bandTilt(f.phi)));
        if (r.raised !== undefined) raised++;
      } else declined.push([i, r.kind]);
    });
    return { errs, declined, raised };
  }

  test('the fold: every frame read within 3° of the band; the one whose edge cuts across the band is declined by name', () => {
    const { errs, declined } = readAll('dithered-fold');
    expect(errs).toHaveLength(23);
    expect(Math.max(...errs)).toBeLessThan(3);
    expect(declined).toEqual([[18, 'edge leaves the band']]);
  });

  test('the thin strip: every frame read within 3° of the band, read at the strip\'s top line; the rest declined by name', () => {
    const { errs, declined, raised } = readAll('dithered-strip');
    expect(errs.length).toBeGreaterThanOrEqual(12);
    expect(Math.max(...errs)).toBeLessThan(3);
    expect(raised).toBeGreaterThanOrEqual(10);
    for (const [, kind] of declined) expect(kind).toBe('waistband edge too short');
  });

  for (const v of ['dithered-fold', 'dithered-strip'] as const) {
    test(`${v}: the posed pelvis swings within 1.5× of the band's edge and correlates ≥ 0.7 with it; the PELVIS line names the band's top read above the colour's edge`, () => {
      const run = pipeline(v, 'waistband');
      expect(run.read!.stderr).toBe('');
      expect(run.read!.status).toBe(0);
      expect(linesOf(run.read!, 'PELVIS')[0]).toContain('with the band\'s top read above the colour\'s edge in some columns');
      expect(run.retarget.status).toBe(0);
      const b = bars(run.build, band());
      expect(b.ratio).toBeGreaterThanOrEqual(1 / 1.5);
      expect(b.ratio).toBeLessThanOrEqual(1.5);
      expect(b.r).toBeGreaterThanOrEqual(0.7);
    }, SLOW);
  }

  test('mutants: without the climb to the band\'s top the strip reads a frame > 3° off; without the across-the-band test the fold does', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm318-'));
    try {
      const cases = [
        { name: 'no-top', from: 'const raised = toBandTop(f, tops, g, top, colourAt);', to: 'const raised = 0;', variant: 'dithered-strip' as const },
        { name: 'no-across', from: 'const off = notTheBand(f, fit, tops, top, colourAt);', to: 'const off = null;', variant: 'dithered-fold' as const },
      ];
      for (const m of cases) {
        const src = readFileSync(join(ROOT, 'src', 'pelvis.ts'), 'utf8');
        expect(src.split(m.from)).toHaveLength(2);
        const dir = join(d, m.name);
        cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'pelvis.ts'), src.replace(m.from, m.to));
        cpSync(join(ROOT, 'cli.ts'), join(dir, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
        const out = tempDir();
        const fx = writePelvisFixture(join(out, 'fixture'), m.variant);
        const seq = join(out, 'pose.pelvis.json');
        const r = cli(['pelvis', '--pose', fx.pose, '--frames', fx.frames, '--mode', 'waistband', '--out', seq], join(dir, 'cli.ts'));
        expect(r.status).toBe(0);
        const tilt = (JSON.parse(readFileSync(seq, 'utf8')) as { frames: Array<{ pelvisTilt: number | null }> }).frames.map((f) => f.pelvisTilt);
        const errs = tilt.flatMap((t, i) => (t === null ? [] : [Math.abs(t - band()[i]!)]));
        expect(Math.max(...errs)).toBeGreaterThan(3);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

/**
 * rig-c/pose#342: a garment hanging over the waistband hides it. `sweater`: shorts turned with the drawn pelvis (−15·sin φ)
 * under a sweater whose hem hangs level over the shorts' top. The bars (the card): the below-cover reader recovers the drawn
 * tilt from the shorts' hem and where the legs leave them; the band-top reader does not (it reads the level cover or
 * declines). Where an uncovered band and the hem disagree beyond the stated spread (`covered`: the band turned, the hem
 * level), the frame is declined by name.
 */
describe('the pelvis below the cover (rig-c/pose#342)', () => {
  test('sweater: below-cover reads every frame within 1.5° of the drawn pelvis, from the hem and the thigh roots; the band-top reader recovers none of it', () => {
    const cycle = variantCycle('sweater');
    const seq = readPoseSequence(readFileSync(writePelvisFixture(tempDir(), 'sweater').pose, 'utf8'), 'fixture');
    const errs: number[] = [];
    const band: number[] = [];
    cycle.forEach((f, i) => {
      const plate = drawFrame(f, 'sweater');
      const j = seq.frames[i]!.people[0]!.joints;
      const r = readPelvis(plate, j, 'below-cover');
      if (!('tilt' in r)) throw new Error(`frame ${i} declined: ${r.why}`);
      expect(r.cues!.hem).not.toBeNull();
      expect(r.cues!.roots).not.toBeNull();
      expect(r.cues!.band === null || r.cues!.band === 'covered').toBe(true);
      errs.push(Math.abs(r.tilt - pelvisTilt(f.phi)));
      const w = readPelvis(plate, j, 'waistband');
      if ('tilt' in w) band.push(w.tilt);
    });
    expect(Math.max(...errs)).toBeLessThan(1.5);
    // The band-top reader reads the sweater's level hem where it reads at all: not the drawn ±15°.
    for (const t of band) expect(Math.abs(t)).toBeLessThan(1);
  });

  test('covered: an uncovered band is a cue; where it and the level hem differ by more than the spread the frame is declined by name', () => {
    const cycle = variantCycle('covered');
    const seq = readPoseSequence(readFileSync(writePelvisFixture(tempDir(), 'covered').pose, 'utf8'), 'fixture');
    const kinds = cycle.map((f, i) => {
      const r = readPelvis(drawFrame(f, 'covered'), seq.frames[i]!.people[0]!.joints, 'below-cover');
      if ('tilt' in r) {
        expect(typeof r.cues!.band).toBe('number');
        const fitted = [r.cues!.hem, r.cues!.band].filter((v): v is number => typeof v === 'number');
        expect(Math.max(...fitted) - Math.min(...fitted)).toBeLessThanOrEqual(CUE_SPREAD);
        return 'read';
      }
      return r.kind;
    });
    expect(kinds[0]).toBe('cues disagree');
    expect(kinds[12]).toBe('cues disagree');
    for (const k of kinds) expect(['read', 'cues disagree']).toContain(k);
  });

  test('sweater, below-cover → clean → retarget: the posed pelvis swings within 1.5× of the drawn one and correlates ≥ 0.7; a CUES line per frame', () => {
    const run = pipeline('sweater', 'below-cover');
    expect(run.read!.stderr).toBe('');
    expect(run.read!.status).toBe(0);
    expect(linesOf(run.read!, 'CUES')).toHaveLength(N);
    expect(linesOf(run.read!, 'CUES')[0]).toMatch(/^CUES frame 0: hem [+-]\d+\.\d\d°, roots [+-]\d+\.\d\d°, band (covered|not read), hips [+-]\d+\.\d\d° \(not fitted\) → [+-]\d+\.\d\d°; hips sign [+−0], fit sign [+−0]$/);
    expect(run.retarget.status).toBe(0);
    const b = bars(run.build, drawn());
    expect(b.ratio).toBeGreaterThanOrEqual(1 / 1.5);
    expect(b.ratio).toBeLessThanOrEqual(1.5);
    expect(b.r).toBeGreaterThanOrEqual(0.7);
  }, SLOW);
});
