/**
 * #425: absolute hip height and height above the supporting ankle are different
 * signals. The public walk has a known bob while its feet move relative to the
 * hips. Preserve that source signal and hold the support on the same floor.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileModel } from '@rig-c/core/compile';
import { readModel, type CompiledDocument } from '@rig-c/core/core';
import { modelDocument } from '@rig-c/core/src/model.ts';
import { walkCycle, walkDoc } from '../examples/walk/make-walk.ts';
import { clean } from '../src/clean.ts';
import { readMap } from '../src/map.ts';
import { personTrack, readPoseSequence } from '../src/pose.ts';
import { closeAnimationLoop, retarget, type Retarget, type RetargetOptions } from '../src/retarget.ts';
import { restOf, slotsOf } from '../src/rigc.ts';
import { FOOT_TOLERANCE_PER_UNIT, landed, measureLanding, ORIGIN_TOLERANCE, poseFrames } from '../src/verify.ts';

const ROOT = join(import.meta.dir, '..');
const DIR = mkdtempSync(join(tmpdir(), 'rig-pose-walk-height-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
const RIG = join(ROOT, 'examples/wave/rig/rig.json');
const MOTION = join(DIR, 'motion.json');

function compile(animation?: Retarget['animation']): CompiledDocument {
  const closed = animation === undefined ? undefined : structuredClone(animation);
  if (closed !== undefined) closeAnimationLoop(closed, new Map());
  writeFileSync(MOTION, JSON.stringify({ spec: 'rigc-motion/1', archetype: 'wave', cut: 'wave', easings: {}, animations: closed === undefined ? {} : { walk: closed } }));
  const c = compileModel({ rigPath: RIG, motionPath: MOTION, outDir: DIR });
  return readModel(modelDocument(c.model, '', c.atlasText), 'walk-height fixture');
}
const setup = compile();
const rest = restOf(setup);
const slots = slotsOf(setup);
const map = readMap(readFileSync(join(ROOT, 'examples/walk/map.json'), 'utf8'), 'public walk map');
const seq = clean(readPoseSequence(JSON.stringify(walkDoc(walkCycle())), 'public walk'), { loop: true, legs: 5, rest: 7, hold: 'off', depth: 'walk' }, undefined, 'public walk').seq;
const frames = personTrack(seq, undefined, 'public walk');
const times = seq.frames.map((f) => f.t);
const options: RetargetOptions = { minScore: 0.3, flip: 'off', short: 'off', bends: 'refuse', bendTolerance: 0, switchTolerance: 25, switchMin: 0.25, switchAt: 'first', plantFeet: true, legScale: [0.8, 1.05], stance: 0.03, travel: 'in-place', loop: true, gait: 'walk' };
const run = (extra: Partial<RetargetOptions> = {}) => retarget(rest, map, frames, times, { ...options, ...extra }, slots);
const sourceY = frames.map((f) => -(f.r_hip!.at![1] + f.l_hip!.at![1]) / 2);
const pp = (xs: readonly number[]) => Math.max(...xs) - Math.min(...xs);
const d2 = (xs: readonly number[], i: number) => xs[(i + 1) % xs.length]! - 2 * xs[i]! + xs[(i + xs.length - 1) % xs.length]!;
const extrema = (xs: readonly number[], kind: 'min' | 'max') => xs.flatMap((x, i) => {
  const before = xs[(i + xs.length - 1) % xs.length]!, after = xs[(i + 1) % xs.length]!;
  return (kind === 'min' ? x < before && x < after : x > before && x > after) ? [i] : [];
});

describe('#425: source walk height with a planted support', () => {
  test('keeps source amplitude, extrema and second differences rather than the support-relative bob', () => {
    const r = run();
    const legacy = run({ gait: undefined });
    const y = r.origin!.at.map((p) => p[1]);
    const old = legacy.origin!.at.map((p) => p[1]);
    const factor = r.scale!.factor;
    // The old floor solve erases most of this fixture's bob: a useful red control.
    expect(Math.abs(pp(old) / (pp(sourceY) * factor) - 1)).toBeGreaterThan(0.1);
    expect(y[0]).toBe(old[0]);
    expect(pp(y) / (pp(sourceY) * factor)).toBeCloseTo(1, 10);
    for (let i = 0; i < y.length; i++) {
      expect(y[i]! - y[0]!).toBeCloseTo((sourceY[i]! - sourceY[0]!) * factor, 10);
      expect(d2(y, i)).toBeCloseTo(d2(sourceY, i) * factor, 10);
    }
    for (const kind of ['min', 'max'] as const) expect(extrema(y, kind)).toEqual(extrema(sourceY, kind));
  });

  test('the official poser keeps support height and lateral plant, with the existing landing tolerances', () => {
    const r = run();
    const legacy = run({ gait: undefined });
    const doc = compile(r.animation);
    const posed = poseFrames(doc, 'walk', r.times);
    const oldDoc = compile(legacy.animation);
    const oldPosed = poseFrames(oldDoc, 'walk', legacy.times);
    expect(measureLanding(doc, 'walk', map, r, posed).every(landed)).toBe(true);
    r.feet!.support.forEach((side, i) => {
      expect(side).not.toBeNull();
      const bone = r.ankles!.bones[side!];
      const b = posed[i]!.get(bone)!;
      const before = oldPosed[i]!.get(bone)!;
      const length = doc.bones.find((x) => x.name === bone)!.length!;
      const ankle = [b.worldX + b.a * length, b.worldY + b.c * length];
      const oldX = before.worldX + before.a * length;
      const tolerance = ORIGIN_TOLERANCE + FOOT_TOLERANCE_PER_UNIT * 150;
      expect(Math.abs(ankle[1]! - r.floor!.y)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(ankle[0]! - oldX)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs((posed[i]!.get('hip')!.worldY - posed[0]!.get('hip')!.worldY) - (sourceY[i]! - sourceY[0]!) * r.scale!.factor)).toBeLessThanOrEqual(ORIGIN_TOLERANCE);
    });
  });

  test('support holding does not turn ordinary support frames into reported blend frames', () => {
    const r = run();
    const changes = r.feet!.changes.filter((c) => c.frame > 0).map((c) => c.frame);
    const blendFrames = new Set(changes.flatMap((i) => [i, i + 1, i + 2]));
    expect(r.blendHold!.over).toEqual([]);
    for (const span of r.blendHold!.runs) for (let i = span.frames[0]; i <= span.frames[1]; i++) expect(blendFrames.has(i)).toBe(true);
    expect(r.blendHold!.stretch.filter((x) => x !== null).length).toBeLessThan(r.times.length);
  });

  test('run, travelling, unscaled and already-clamped walks keep their old paths', () => {
    expect(run({ gait: 'run' }).animation).toEqual(run({ gait: undefined }).animation);
    for (const extra of [{ travel: undefined }, { legScale: 'off' }, { legScale: [0.95, 1.05] }] satisfies Array<Partial<RetargetOptions>>) {
      expect(run(extra).animation).toEqual(run({ ...extra, gait: undefined }).animation);
    }
  });
});
