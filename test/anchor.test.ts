/**
 * rig-c/pose#344: in an in-place walk the upper body is the anchor and the pelvis sways under it. The pelvis bone
 * carries the trunk (its child), so the pelvis track's turn swung the chest around it; retarget now keys the first
 * spine bone with the pelvis's counter.
 *
 * The fixture is the walk (examples/walk/make-walk.ts) with its pelvis drawn turned 30° peak to peak and its hips
 * moved sideways under a still neck (`SWAY` px), cleaned with `--depth walk` and keyed onto the wave's rig with a
 * pelvis chain from hand pelvis keys (±15°). The bar (the card): over the cycle, posed by rig-c's poser, the neck's
 * world x moves ≤ 25 % of the pelvis bone's, and the torso's world angle (first spine bone → neck) stays within ±3°;
 * the pelvis's own keys are the ones written without the anchor. The control — the same sequence cleaned without a
 * gait — fails the first bar, so the anchor is what holds the torso. Two rigs: the wave's, whose trunk bone is the
 * pelvis's child, and the same with a spine bone between them, which takes the counter-rotation too. A run
 * (`--depth run`) is not anchored.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poseRawAnimation, readModel, type RawBone } from 'rig-c/core';
import { tiltedCycle } from '../examples/walk/make-pelvis.ts';
import { walkDoc } from '../examples/walk/make-walk.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const WAVE = join(ROOT, 'examples', 'wave', 'rig');
const DEG = 180 / Math.PI;
const SLOW = 120_000;
const N = 24;
const DT = 1 / 24;
/** The hips' sideways sway drawn under the still neck, px peak (the picture's pelvis sway). */
const SWAY = 2;

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

/** The walk with the drawn pelvis, its hips moved `SWAY`·sin φ sideways (the neck and everything above where drawn). */
function swayingWalk(dir: string): string {
  const doc = walkDoc(tiltedCycle()) as { frames: Array<{ people: Array<{ joints: Record<string, { at: [number, number] }> }> }> };
  doc.frames.forEach((f, i) => {
    const d = SWAY * Math.sin((2 * Math.PI * i) / N);
    for (const j of ['r_hip', 'l_hip']) f.people[0]!.joints[j]!.at[0] += d;
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
}
/** Pelvis keys ±15°, clean as the walk is (loop, hold off) with `gait` as --depth, retarget with a pelvis chain. */
function walk(dir: string, rig: string, gait: 'walk' | 'run' | null): Walked {
  const keys = join(dir, 'keys.json');
  writeFileSync(keys, JSON.stringify({ spec: 'rig-pose-pelvis-keys/1', keys: [{ frame: 0, deg: 0 }, { frame: 6, deg: 15 }, { frame: 18, deg: -15 }, { frame: 23, deg: -3.75 }] }));
  const seq = join(dir, 'pose.pelvis.json');
  expect(cli(['pelvis', '--pose', swayingWalk(dir), '--pelvis-keys', keys, '--out', seq]).status).toBe(0);
  const cleaned = join(dir, 'pose.clean.json');
  const c = cli(['clean', '--pose', seq, '--out', cleaned, '--loop', '--hold', 'off', ...(gait === null ? [] : ['--depth', gait])]);
  expect(c.stderr).toBe('');
  const map = JSON.parse(readFileSync(join(ROOT, 'examples', 'walk', 'map.json'), 'utf8')) as { chains: unknown[] };
  map.chains.unshift({ name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] });
  const mapPath = join(dir, 'map.json');
  writeFileSync(mapPath, JSON.stringify(map));
  const motion = join(dir, 'motion.json');
  const build = join(dir, 'build');
  const r = cli(['retarget', '--rig', rig, '--map', mapPath, '--sequence', cleaned, '--out', motion, '--name', 'walk', '--build', build]);
  if (r.status !== 0) return { ...r, motion: [], posed: [] };
  const model = join(build, 'skeleton.model.json');
  const doc = readModel(readFileSync(model, 'utf8'), model);
  const posed = poseRawAnimation(doc, 'walk', Array.from({ length: N - 1 }, () => DT)).map((p) => new Map(p.bones.map((b) => [b.name, b])));
  const m = JSON.parse(readFileSync(motion, 'utf8')) as { animations: { walk: { tracks: Walked['motion'] } } };
  return { ...r, motion: m.animations.walk.tracks, posed };
}

const pp = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
/** The card's bar 1 figures: the neck's world x over the pelvis bone's, and the torso's largest |world angle| from upright. */
function bar(w: Walked, spine: string): { ratio: number; hipX: number; torso: number; swing: number } {
  const hipX = w.posed.map((p) => p.get('hip')!.worldX);
  const neckX = w.posed.map((p) => p.get('neck')!.worldX);
  const torso = w.posed.map((p) => {
    const s = p.get(spine)!;
    const n = p.get('neck')!;
    return Math.atan2(n.worldX - s.worldX, n.worldY - s.worldY) * DEG;
  });
  const hipAngle = w.posed.map((p) => Math.atan2(p.get('hip')!.c, p.get('hip')!.a) * DEG);
  return { ratio: pp(neckX) / pp(hipX), hipX: pp(hipX), torso: Math.max(...torso.map(Math.abs)), swing: pp(hipAngle) };
}
const track = (w: Walked, bone: string, property: string) => w.motion.find((t) => t.bone === bone && t.property === property);

describe('rig-c/pose#344: the pelvis sways under a steady upper body in an in-place walk', () => {
  for (const spine of [false, true]) {
    const first = spine ? 'spine' : 'chest';
    test(`${spine ? 'a spine bone between the pelvis and the trunk' : "the wave's rig (the trunk bone is the pelvis's child)"}: the neck moves ≤ 25 % of the pelvis, the torso within ±3°, the pelvis's keys as without the anchor`, () => {
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
      expect(a.ratio).toBeLessThanOrEqual(0.25);
      expect(a.torso).toBeLessThanOrEqual(3);
      // The control: without the gait the pelvis carries the torso — the neck moves more than the pelvis does.
      expect(b.ratio).toBeGreaterThan(1);
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
      expect(line).toContain(`torso anchored (in-place walk): bone "${first}" keyed with the pelvis's counter, "neck" held at x`);
      expect(off.stdout).not.toContain('torso anchored');
    }, SLOW);
  }

  test('a run (--depth run) is not anchored: its motion is the one cleaned without a gait', () => {
    const run = walk(tempDir(), WAVE, 'run');
    const none = walk(tempDir(), WAVE, null);
    expect(run.status).toBe(0);
    expect(run.motion).toEqual(none.motion);
    expect(run.stdout).not.toContain('torso anchored');
  }, SLOW);
});
