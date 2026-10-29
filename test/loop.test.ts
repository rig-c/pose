/** #275: loop timing, with the non-loop control recorded before the defect. */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTrack, type CompiledDocument } from '@rig-c/core/core';
import { clean } from '../src/clean.ts';
import { readMap } from '../src/map.ts';
import { personTrack, readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { closeAnimationLoop, retarget, type Animation, type MotionTrack } from '../src/retarget.ts';
import { readBuild, restOf } from '../src/rigc.ts';
import { runRetarget } from '../src/run.ts';
import { walkCycle, walkDoc } from '../examples/walk/make-walk.ts';

const FPS = 24;
const N = 24;
/** A synthetic one-bone rig; its rest transform is read through rig-c's poser. */
const DOC: CompiledDocument = {
  spec: 'rigc-compiled/1', skin: 'all', referenceScale: 1,
  bones: [{ name: 'arm', rotation: -100, length: 70 }],
  slots: [], skins: [], constraints: [], animations: [],
  spine: { sha256: '0'.repeat(64) }, pages: null, stated: null,
};
const MAP = readMap(JSON.stringify({
  spec: 'rig-pose-map/1',
  chains: [{ name: 'arm', bones: ['arm'], joints: ['r_shoulder', 'r_elbow'], bend: 'free' }],
}), 'fixture');

function cycle(loop: boolean, start = 0, fps = FPS) {
  const raw = walkDoc(walkCycle(), 'synthetic loop timing control');
  const seq = clean(readPoseSequence(JSON.stringify(raw), 'fixture'), { loop, legs: 1, rest: 1, hold: 'off' }, undefined, 'fixture').seq;
  const times = seq.frames.map((f) => (fps === FPS ? f.t : Math.round(f.t * FPS / fps * 1e6) / 1e6) + start);
  const result = retarget(restOf(DOC), MAP, personTrack(seq, undefined, 'fixture'), times, {
    minScore: 0.3, bends: 'refuse', bendTolerance: 0, flip: 'off', short: 'off',
    switchTolerance: 25, switchMin: 0.25, switchAt: 'first',
    loop: seq.cleaned!.params.loop,
  });
  return { seq, result };
}

describe('#275: cycle duration', () => {
  test('non-loop control: duration remains the last distinct frame time, with no closing key', () => {
    const { seq, result } = cycle(false);
    expect(seq.cleaned!.params.loop).toBe(false);
    expect(result.animation.duration).toBe(0.958333);
    expect(result.animation.duration).toBe(seq.frames[N - 1]!.t);
    expect(result.animation.tracks[0]!.keys).toHaveLength(N);
    expect(result.animation.tracks[0]!.keys.at(-1)!.t).toBe(result.animation.duration);
    console.log(`#275 non-loop: ${N} frames at ${FPS} fps, duration ${result.animation.duration}, ${result.animation.tracks[0]!.keys.length} keys`);
  });
  test('loop defect: N distinct cleaned frames need N frame intervals', () => {
    const { seq, result } = cycle(true);
    expect(seq.cleaned!.params.loop).toBe(true);
    expect(seq.frames).toHaveLength(N);
    expect(result.animation.duration).toBe(N / FPS);
  });
});

/** A numeric timeline read into the same rig-c runtime used by a built rig. No compiler or gate here. */
function runtime(animation: Animation) {
  const track = animation.tracks[0] as MotionTrack;
  const doc: CompiledDocument = { ...DOC, animations: [{
    name: 'cycle', slots: [], deforms: [],
    constraints: { ik: [], transform: [], path: [], physics: 0, slider: [] },
    timelines: {
      declared: animation.duration, duration: Math.fround(track.keys.at(-1)!.t),
      bones: [{ name: 'arm', timelines: [{ kind: 'rotate', keys: track.keys.map((k) => ({
        time: Math.fround(k.t), values: k.v.map(Math.fround), stated: { time: k.t, values: k.v }, curve: 'linear',
      })) }] }],
      slots: [], later: [], attachments: [], drawOrder: [], events: [],
    },
  }] };
  return openTrack(doc, 'cycle', { loop: true, reset: 'animation' });
}

const angleDelta = (a: number, b: number) => Math.abs(((a - b + 540) % 360 + 360) % 360 - 180);

describe('#275: closing interval in the runtime', () => {
  test('normal: the seam takes a frame interval and moves toward frame 0 before wrapping', () => {
    const { result } = cycle(true);
    const keys = result.animation.tracks[0]!.keys;
    const maxStep = Math.max(...keys.slice(1).map((k, i) => Math.abs((k.v as number[])[0]! - (keys[i]!.v as number[])[0]!)));
    const seam = Math.abs((keys.at(-1)!.v as number[])[0]! - (keys[0]!.v as number[])[0]!);
    expect(seam).toBeGreaterThan(0);
    expect(seam).toBeLessThanOrEqual(maxStep);
    closeAnimationLoop(result.animation, new Map());
    const player = runtime(result.animation);
    expect(player.duration).toBe(1);
    const first = player.first.bones[0]!.rotationX;
    const lastTime = result.times.at(-1)!;
    const last = player.step(lastTime).bones[0]!.rotationX;
    const mid = player.step((1 - lastTime) / 2).bones[0]!.rotationX;
    expect(angleDelta(mid, first)).toBeCloseTo(angleDelta(last, first) / 2, 4);
    const near = player.step((1 - lastTime) / 2 - 1e-5).bones[0]!.rotationX;
    expect(angleDelta(near, first)).toBeLessThan(0.002);
    const wrapped = player.step(2e-5).bones[0]!.rotationX;
    expect(angleDelta(wrapped, near)).toBeLessThanOrEqual(maxStep);
    console.log(`#275 loop: duration ${player.duration}, seam ${seam.toFixed(3)} degrees <= in-loop max ${maxStep.toFixed(3)}, near-end gap ${angleDelta(near, first).toFixed(6)}`);
  });

  test('defect control: duration alone leaves the runtime short and the last pose held', () => {
    const { result } = cycle(true);
    const player = runtime(result.animation);
    expect(player.duration).toBeCloseTo((N - 1) / FPS, 5);
    expect(player.duration).toBeLessThan(result.animation.duration);
    const near = player.step(player.duration - 1e-5).bones[0]!.rotationX;
    expect(angleDelta(near, player.first.bones[0]!.rotationX)).toBeGreaterThan(1);
  });

  test('edge: shifted timestamps and a different cadence retain one closing interval', () => {
    const { result } = cycle(true, 7, 25);
    expect(result.animation.duration).toBe(N / 25);
    expect(result.times[0]).toBe(0);
    closeAnimationLoop(result.animation, new Map());
    expect(result.animation.tracks[0]!.keys.at(-1)!.t).toBe(N / 25);
    expect(result.animation.tracks[0]!.keys.at(-1)!.v).toEqual(result.animation.tracks[0]!.keys[0]!.v);
  });

  test('edge: non-loop timestamps can start away from zero without adding a closing interval', () => {
    const { result } = cycle(false, 7);
    expect(result.animation.duration).toBe(0.958333);
    expect(result.times[0]).toBe(0);
    expect(result.animation.tracks[0]!.keys).toHaveLength(N);
  });

  test('edge: an unwrapped full turn closes by the short arc, while scale and translation close numerically', () => {
    const animation: Animation = { duration: 1, tracks: [
      { bone: 'arm', property: 'rotate', keys: [{ t: 0, v: [10] }, { t: 0.9, v: [350] }] },
      { bone: 'arm', property: 'scalex', keys: [{ t: 0, v: [1] }, { t: 0.9, v: [0.8] }] },
      { bone: 'arm', property: 'translate', keys: [{ t: 0, v: [1, 2] }, { t: 0.9, v: [3, 4] }] },
    ] };
    closeAnimationLoop(animation, new Map());
    expect(animation.tracks.map((t) => t.keys.at(-1)!.v)).toEqual([[370], [1], [1, 2]]);
  });

  test('edge: irregular timestamps are accepted; the closing interval is their mean, not a promised fps', () => {
    const { seq } = cycle(true);
    const times = seq.frames.map((_, i) => i * i / 100);
    const result = retarget(restOf(DOC), MAP, personTrack(seq, undefined, 'fixture'), times, {
      minScore: 0.3, bends: 'refuse', bendTolerance: 0, flip: 'off', short: 'off',
      switchTolerance: 25, switchMin: 0.25, switchAt: 'first', loop: true,
    });
    expect(result.animation.duration).toBe(5.52);
    expect(result.animation.duration - times.at(-1)!).toBeCloseTo((times.at(-1)! - times[0]!) / (N - 1), 6);
  });

  test('edge: clean refuses a singleton loop, and closing a singleton never duplicates t=0', () => {
    const raw = walkDoc(walkCycle().slice(0, 1), 'singleton control');
    expect(() => clean(readPoseSequence(JSON.stringify(raw), 'fixture'), { loop: true, legs: 1, rest: 1 }, undefined, 'fixture')).toThrow('CLEAN_LOOP');
    const animation: Animation = { duration: 0, tracks: [{ bone: 'arm', property: 'rotate', keys: [{ t: 0, v: [0] }] }] };
    closeAnimationLoop(animation, new Map());
    expect(animation.tracks[0]!.keys).toEqual([{ t: 0, v: [0] }]);
  });

  test('edge: an earlier stepped span does not turn a mixed track closing interval into a hold', () => {
    const animation: Animation = { duration: 1, tracks: [{
      bone: 'arm', property: 'translate', keys: [{ t: 0, v: [0, 0], ease: 'stepped' }, { t: 0.4, v: [1, 2] }, { t: 0.8, v: [2, 3] }],
    }] };
    closeAnimationLoop(animation, new Map());
    expect((animation.tracks[0] as MotionTrack).keys[2]!.ease).toBeUndefined();
    expect(animation.tracks[0]!.keys.at(-1)!.v).toEqual([0, 0]);
    closeAnimationLoop(animation, new Map());
    expect(animation.tracks[0]!.keys).toHaveLength(4);
  });

  test('edge: sparse attachments close to setup, and stepped offsets hold until the wrap', () => {
    const animation: Animation = { duration: 1, tracks: [
      { slot: 'hand', property: 'attachment', keys: [{ t: 0.5, v: 'alternate' }] },
      { slot: 'empty', property: 'attachment', keys: [{ t: 0, v: null }, { t: 0.5, v: 'alternate' }] },
      { bone: 'arm', property: 'translate', keys: [{ t: 0, v: [0, 0], ease: 'stepped' }, { t: 0.5, v: [2, 3] }] },
    ] };
    closeAnimationLoop(animation, new Map([['hand', { setup: 'setup', attachments: new Set(['setup', 'alternate']) }]]));
    expect(animation.tracks[0]!.keys).toEqual([{ t: 0, v: 'setup' }, { t: 0.5, v: 'alternate' }, { t: 1, v: 'setup' }]);
    expect(animation.tracks[1]!.keys.at(-1)!.v).toBeNull();
    expect((animation.tracks[2] as MotionTrack).keys[1]!.ease).toBe('stepped');
    expect((animation.tracks[2] as MotionTrack).keys.at(-1)!.ease).toBeUndefined();
  });
});

/** End-to-end controls, using only a generated public pose and the repository's stick rig. */
describe('#275: gated output', () => {
  for (const reduced of [false, true]) test(`loop ${reduced ? 'reduced' : 'dense'}: the built animation closes over one frame and LAND stays green`, () => {
    const root = join(import.meta.dir, '..');
    const scratch = join(root, 'scratchpad');
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(join(scratch, 'rig-pose-loop-'));
    try {
      const pose = join(dir, 'pose.json');
      writeFileSync(pose, writePoseSequence(cycle(true).seq));
      const lines: string[] = [];
      const out = join(dir, 'motion.json');
      const build = join(dir, 'build');
      const result = runRetarget({
        rig: join(root, 'examples', 'wave', 'rig'), map: join(root, 'examples', 'walk', 'map.json'),
        pose, out, build, name: 'cycle', coco: false, profile: 'spine',
        minScore: 0.3, bends: 'refuse', bendTolerance: 5, flip: 120, short: 0.35,
        switchTolerance: 25, switchMin: 0.25, switchAt: 'first',
        plantFeet: true, ...(reduced ? { reduce: 0.1, reduceHip: 0.01 } : {}),
      }, (line) => lines.push(line));
      expect(result.written).toBe(true);
      expect(lines.some((line) => line.trim().startsWith('GATE '))).toBe(true);
      expect(lines.some((line) => line.trim().startsWith('LAND '))).toBe(true);
      const motion = JSON.parse(readFileSync(out, 'utf8')) as { animations: Record<string, Animation> };
      const animation = motion.animations.cycle!;
      expect(animation.duration).toBe(N / FPS);
      for (const tr of animation.tracks) expect(tr.keys.at(-1)!.t).toBe(N / FPS);
      const doc = readBuild(build);
      const player = openTrack(doc, 'cycle', { loop: true, reset: 'animation' });
      expect(player.duration).toBe(N / FPS);
      const angle = (bones: typeof player.first.bones) => new Map(bones.map((b) => [b.name, b.rotationX]));
      const first = angle(player.first.bones);
      let previous = first;
      const maxima = new Map<string, number>();
      const times = cycle(true).seq.frames.map((f) => f.t);
      for (let i = 1; i < N; i++) {
        const next = angle(player.step(times[i]! - times[i - 1]!).bones);
        for (const [bone, a] of next) maxima.set(bone, Math.max(maxima.get(bone) ?? 0, angleDelta(a, previous.get(bone)!)));
        previous = next;
      }
      const closingInterval = N / FPS - times.at(-1)!;
      const mid = angle(player.step(closingInterval / 2).bones);
      const near = angle(player.step(closingInterval / 2 - 1e-5).bones);
      let ordinary = 0;
      let seam = 0;
      for (const [bone, initial] of first) {
        const max = maxima.get(bone) ?? 0;
        const step = angleDelta(previous.get(bone)!, initial);
        expect(angleDelta(mid.get(bone)!, initial)).toBeLessThanOrEqual(step + 0.002);
        expect(angleDelta(near.get(bone)!, initial)).toBeLessThan(0.002);
        ordinary = Math.max(ordinary, max);
        seam = Math.max(seam, step);
      }
      // The card compares the largest seam step with the maximum in-loop step over the rig.
      expect(seam).toBeLessThanOrEqual(ordinary);
      const wrapped = angle(player.step(2e-5).bones);
      for (const [bone, a] of wrapped) expect(angleDelta(a, near.get(bone)!)).toBeLessThanOrEqual(ordinary);
      console.log(`#275 gated ${reduced ? 'reduced' : 'dense'}: duration ${player.duration}, seam ${seam.toFixed(3)} degrees, in-loop max ${ordinary.toFixed(3)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
