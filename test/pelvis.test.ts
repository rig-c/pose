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
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poseRawAnimation, readModel, type RawBone } from 'rig-c/core';
import { bandTilt, drawFrame, pelvisTilt, tiltedCycle, writePelvisFixture, type Variant } from '../examples/walk/make-pelvis.ts';
import { clean } from '../src/clean.ts';
import { readPelvis, readPelvisKeys } from '../src/pelvis.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';

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
function pipeline(variant: Variant, mode: 'silhouette' | 'waistband' | null, dir = tempDir(), cliPath = CLI, extra: string[] = []): Pipeline {
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
      'POSE_PELVIS: p.json "pelvisSource" is the string "eyeballed"; it must be one of "silhouette", "waistband", "keys" (where every frame\'s "pelvisTilt" came from)',
      'POSE_PELVIS: p.json has "pelvisSource" and frame(s) 5 carry no "pelvisTilt"; with a pelvis track every frame carries one (null where the reading declined it)',
    ]);
    delete doc.pelvisSource;
    doc.frames[6]!.pelvisTilt = 0;
    expect(refusal(doc)).toEqual(['POSE_PELVIS: p.json has "pelvisTilt" on 23 frame(s) and no "pelvisSource"; a pelvis track says where it came from (silhouette, waistband, keys)']);
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

  test('covered, read by the waistband: the posed pelvis correlates ≥ 0.7 with the band\'s edge', () => {
    const run = pipeline('covered', 'waistband');
    expect(run.read!.status).toBe(0);
    expect(run.retarget.status).toBe(0);
    expect(linesOf(run.retarget, 'PELVIS:')[0]).toStartWith('PELVIS: from waistband, swing ');
    const b = bars(run.build, band());
    expect(b.r).toBeGreaterThanOrEqual(0.7);
    expect(b.ratio).toBeGreaterThanOrEqual(0.5);
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
    expect(cli(['pelvis', '--pose', fx.pose, '--out', join(dir, 'z.json'), '--frames', fx.frames, '--mode', 'hem']).stderr).toContain('--mode is "hem"; it must be silhouette or waistband');
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
