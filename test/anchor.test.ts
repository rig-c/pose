/**
 * rig-c/pose#344: in an in-place walk the upper body is the anchor and the pelvis sways under it. The pelvis bone
 * carries the trunk (its child), so the pelvis track's turn swung the chest around it; retarget now keys the first
 * spine bone with the pelvis's counter, and carries the top of the trunk on the drawn neck's own sideways path.
 *
 * The fixture is the walk (examples/walk/make-walk.ts) with its pelvis drawn turned 30° peak to peak, its hips moved
 * `SWAY`·sin φ px sideways and its neck (with the head and arms) on a known small path, `NECK`·sin φ px about the
 * figure's centre line, cleaned with `--depth walk` and keyed onto the wave's rig with a pelvis chain from hand pelvis
 * keys (±15°). The bar (rewritten on rig-c/pose#344 after measuring): over the cycle, posed by rig-c's poser, the
 * rig's neck ÷ pelvis-bone sideways peak-to-peak is within ±0.1 of the drawing's neck ÷ mid_hip, and the torso's world
 * angle (first spine bone → neck) follows the drawing's trunk angle (mid_hip → neck) within 0.1° on every frame;
 * the pelvis's own keys are the ones written without the anchor. The control — the same sequence cleaned without a
 * gait — lets the pelvis swing the torso, far past the drawing. Two rigs: the wave's, whose trunk bone is the
 * pelvis's child, and the same with a spine bone between them, which takes the counter-rotation too. A run
 * (`--depth run`) is not anchored.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poseRawAnimation, readModel, type RawBone } from '@rig-c/core/core';
import { tiltedCycle } from '../examples/walk/make-pelvis.ts';
import { walkDoc } from '../examples/walk/make-walk.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const WAVE = join(ROOT, 'examples', 'wave', 'rig');
const DEG = 180 / Math.PI;
const SLOW = 120_000;
const N = 24;
const DT = 1 / 24;
/** The hips' sideways sway, px peak (the picture's pelvis sway). */
const SWAY = 2.5;
/** The neck's own sideways path about the figure's centre line, px peak: a small sway, with the head and arms on it. */
const NECK = 1;
const UPPER = ['neck', 'nose', 'r_eye', 'l_eye', 'r_ear', 'l_ear', 'r_shoulder', 'l_shoulder', 'r_elbow', 'l_elbow', 'r_wrist', 'l_wrist'];

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-anchor-'));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The wave's rig, or the same with bone "spine" between "hip" and "chest" (the chest's setup unchanged). */
function rigOf(dir: string, spine: boolean): string {
  if (!spine) return WAVE;
  const out = join(dir, 'rig-spine');
  cpSync(WAVE, out, { recursive: true });
  const rig = JSON.parse(readFileSync(join(out, 'rig.json'), 'utf8')) as { bones: Array<Record<string, unknown>> };
  const at = rig.bones.findIndex((b) => b.name === 'chest');
  const chest = rig.bones[at]!;
  rig.bones.splice(at, 0, { name: 'spine', parent: 'hip', x: chest.x, y: chest.y });
  rig.bones[at + 1] = { ...chest, parent: 'spine', x: 0, y: 0 };
  writeFileSync(join(out, 'rig.json'), JSON.stringify(rig, null, 2));
  return out;
}

/** The walk with the drawn pelvis, its hips moved `SWAY`·sin φ sideways and its neck put at x 200 + `NECK`·sin φ (the head and arms moved with it). */
function swayingWalk(dir: string): string {
  const doc = walkDoc(tiltedCycle()) as { frames: Array<{ people: Array<{ joints: Record<string, { at: [number, number] }> }> }> };
  doc.frames.forEach((f, i) => {
    const phi = (2 * Math.PI * i) / N;
    const js = f.people[0]!.joints;
    for (const j of ['r_hip', 'l_hip']) js[j]!.at[0] += SWAY * Math.sin(phi);
    const d = 200 + NECK * Math.sin(phi) - js.neck!.at[0];
    for (const j of UPPER) if (js[j] !== undefined) js[j]!.at[0] += d;
  });
  const path = join(dir, 'pose.json');
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

interface Walked {
  status: number;
  stdout: string;
  stderr: string;
  motion: Array<{ bone?: string; property?: string; keys: Array<{ v: number[] }> }>;
  posed: Array<Map<string, RawBone>>;
  /** The cleaned sequence's mid_hip and neck, picture px, per frame. */
  drawn: Array<{ mid: [number, number]; neck: [number, number] }>;
}
/** Pelvis keys ±15°, clean as the walk is (loop, hold off) with `gait` as --depth, retarget with a pelvis chain. */
function walk(dir: string, rig: string, gait: 'walk' | 'run' | null, trunkAim = 'neck'): Walked {
  const keys = join(dir, 'keys.json');
  writeFileSync(keys, JSON.stringify({ spec: 'rig-pose-pelvis-keys/1', keys: [{ frame: 0, deg: 0 }, { frame: 6, deg: 15 }, { frame: 18, deg: -15 }, { frame: 23, deg: -3.75 }] }));
  const seq = join(dir, 'pose.pelvis.json');
  expect(cli(['pelvis', '--pose', swayingWalk(dir), '--pelvis-keys', keys, '--out', seq]).status).toBe(0);
  const cleaned = join(dir, 'pose.clean.json');
  const c = cli(['clean', '--pose', seq, '--out', cleaned, '--loop', '--hold', 'off', ...(gait === null ? [] : ['--depth', gait])]);
  expect(c.stderr).toBe('');
  const map = JSON.parse(readFileSync(join(ROOT, 'examples', 'walk', 'map.json'), 'utf8')) as { chains: Array<{ name: string; aim?: string[]; [k: string]: unknown }> };
  map.chains.find((c) => c.name === 'trunk')!.aim = [trunkAim];
  map.chains.unshift({ name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] });
  const mapPath = join(dir, 'map.json');
  writeFileSync(mapPath, JSON.stringify(map));
  const motion = join(dir, 'motion.json');
  const build = join(dir, 'build');
  const r = cli(['retarget', '--rig', rig, '--map', mapPath, '--sequence', cleaned, '--out', motion, '--name', 'walk', '--build', build]);
  const cs = JSON.parse(readFileSync(cleaned, 'utf8')) as { frames: Array<{ people: Array<{ joints: Record<string, { at: [number, number] }> }> }> };
  const drawn = cs.frames.map((f) => {
    const j = f.people[0]!.joints;
    return { mid: [(j.r_hip!.at[0] + j.l_hip!.at[0]) / 2, (j.r_hip!.at[1] + j.l_hip!.at[1]) / 2] as [number, number], neck: j.neck!.at };
  });
  if (r.status !== 0) return { ...r, motion: [], posed: [], drawn };
  const model = join(build, 'skeleton.model.json');
  const doc = readModel(readFileSync(model, 'utf8'), model);
  const posed = poseRawAnimation(doc, 'walk', Array.from({ length: N - 1 }, () => DT)).map((p) => new Map(p.bones.map((b) => [b.name, b])));
  const m = JSON.parse(readFileSync(motion, 'utf8')) as { animations: { walk: { tracks: Walked['motion'] } } };
  return { ...r, motion: m.animations.walk.tracks, posed, drawn };
}

const pp = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
/**
 * The bar's figures: the rig's neck ÷ pelvis-bone sideways peak-to-peak against the drawing's neck ÷ mid_hip, and the
 * largest gap between the torso's world angle (first spine bone → neck) and the drawing's trunk angle (mid_hip → neck,
 * y down), degrees.
 */
function bar(w: Walked, spine: string): { ratio: number; drawnRatio: number; hipX: number; torsoGap: number; swing: number } {
  const hipX = w.posed.map((p) => p.get('hip')!.worldX);
  const neckX = w.posed.map((p) => p.get('neck')!.worldX);
  const torso = w.posed.map((p) => {
    const s = p.get(spine)!;
    const n = p.get('neck')!;
    return Math.atan2(n.worldX - s.worldX, n.worldY - s.worldY) * DEG;
  });
  const trunk = w.drawn.map((d) => Math.atan2(d.neck[0] - d.mid[0], d.mid[1] - d.neck[1]) * DEG);
  const hipAngle = w.posed.map((p) => Math.atan2(p.get('hip')!.c, p.get('hip')!.a) * DEG);
  return {
    ratio: pp(neckX) / pp(hipX),
    drawnRatio: pp(w.drawn.map((d) => d.neck[0])) / pp(w.drawn.map((d) => d.mid[0])),
    hipX: pp(hipX),
    torsoGap: Math.max(...torso.map((t, i) => Math.abs(t - trunk[i]!))),
    swing: pp(hipAngle),
  };
}
const track = (w: Walked, bone: string, property: string) => w.motion.find((t) => t.bone === bone && t.property === property);

describe('rig-c/pose#344: the pelvis sways under a steady upper body in an in-place walk', () => {
  for (const spine of [false, true]) {
    const first = spine ? 'spine' : 'chest';
    test(`${spine ? 'a spine bone between the pelvis and the trunk' : "the wave's rig (the trunk bone is the pelvis's child)"}: the neck sways against the pelvis as the drawing's does (±0.1), the torso on the drawn trunk angle (0.1°), the pelvis's keys as without the anchor`, () => {
      const rig = rigOf(tempDir(), spine);
      const on = walk(tempDir(), rig, 'walk');
      const off = walk(tempDir(), rig, null);
      expect(on.stderr).toBe('');
      expect(off.stderr).toBe('');
      const a = bar(on, first);
      const b = bar(off, first);
      // The pelvis sways sideways and turns ~30° (clean smooths the track), with and without the anchor alike.
      expect(a.hipX).toBeGreaterThan(SWAY);
      expect(a.swing).toBeGreaterThan(25);
      // The fixture's neck sways, small against the pelvis: its ratio is known, not zero.
      expect(a.drawnRatio).toBeGreaterThan(0.2);
      expect(a.drawnRatio).toBeLessThan(0.6);
      expect(Math.abs(a.ratio - a.drawnRatio)).toBeLessThanOrEqual(0.1);
      expect(a.torsoGap).toBeLessThanOrEqual(0.1);
      // The control: without the gait the pelvis carries the torso — the neck moves several times the pelvis.
      expect(b.ratio).toBeGreaterThan(5);
      // Bar 2: the pelvis's own keys are the ones written without the anchor.
      for (const p of ['rotate', 'translate']) expect(track(on, 'hip', p)).toEqual(track(off, 'hip', p));
      expect(track(off, first, 'translate')).toBeUndefined();
      expect(track(on, first, 'translate')).toBeDefined();
      // A spine bone that is not in a chain takes the counter-rotation: minus the pelvis's turn on every key.
      if (spine) {
        const hip = track(on, 'hip', 'rotate')!.keys;
        track(on, 'spine', 'rotate')!.keys.forEach((k, i) => expect(Math.abs(k.v[0]! + hip[i]!.v[0]!)).toBeLessThan(1e-6));
      }
      const line = on.stdout.split('\n').find((l) => l.includes('PELVIS:'))!;
      expect(line).toContain(`torso anchored (in-place walk): bone "${first}" keyed with the pelvis's counter, "neck" carried on the drawn neck's sideways path about x`);
      expect(off.stdout).not.toContain('torso anchored');
    }, SLOW);
  }

  test('a composite trunk aim (chest>neck) anchors the same point as the plain one (neck): the same neck path, the same keys', () => {
    const plain = walk(tempDir(), WAVE, 'walk');
    const composite = walk(tempDir(), WAVE, 'walk', 'chest>neck');
    expect(composite.stderr).toBe('');
    const neck = (w: Walked) => w.posed.map((p) => p.get('neck')!.worldX);
    neck(composite).forEach((x, i) => expect(Math.abs(x - neck(plain)[i]!)).toBeLessThan(1e-6));
    expect(composite.motion).toEqual(plain.motion);
    const line = composite.stdout.split('\n').find((l) => l.includes('PELVIS:'))!;
    expect(line).toContain('"neck" carried on the drawn neck\'s sideways path');
    expect(Math.abs(bar(composite, 'chest').ratio - bar(composite, 'chest').drawnRatio)).toBeLessThanOrEqual(0.1);
  }, SLOW);

  test('a run (--depth run) is not anchored: its motion is the one cleaned without a gait', () => {
    const run = walk(tempDir(), WAVE, 'run');
    const none = walk(tempDir(), WAVE, null);
    expect(run.status).toBe(0);
    expect(run.motion).toEqual(none.motion);
    expect(run.stdout).not.toContain('torso anchored');
  }, SLOW);
});
