/** Synthetic source-only fixture for #437; no reference art. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Plate } from '@rig-c/core/plate';
import { depthCycle, depthDoc } from '../examples/walk/make-depth.ts';
import { readPoseSequence, personTrack, type FrameDepth, type Joint } from '../src/pose.ts';
import type { Body18 } from '../src/joints.ts';
import { deriveDepth } from '../src/depth.ts';
import type { RetargetOptions } from '../src/retarget.ts';
export const DEPTH_OPTIONS: RetargetOptions = { minScore: 0.3, short: 'off', flip: 'off', bends: 'refuse', bendTolerance: 5, switchTolerance: 30, switchMin: 0, switchAt: 'first' };
/** A rigid shoe at each anatomical ankle, with an explicit sole in its art. */
export function writeDepthRig(dir: string): void {
  const rig = JSON.parse(readFileSync(join(import.meta.dir, '../examples/wave/rig/rig.json'), 'utf8')) as { bones: Array<Record<string, unknown>>; slots: unknown[]; skins: Record<string, unknown>; images?: string };
  mkdirSync(join(dir, 'images'), { recursive: true });
  const skins: Record<string, unknown> = {};
  for (const side of ['r', 'l']) {
    const bone = `shoe_${side}`;
    rig.bones.push({ name: bone, parent: `leg_${side}1`, x: 70, y: 0, rotation: 98, length: 20 });
    rig.slots.push({ name: bone, bone, attachment: 'art' });
    skins[bone] = { art: { image: `${bone}.png`, x: 5, y: -5 } };
    const plate = new Plate(30, 12); plate.rect(0, 0, 30, 12, side === 'r' ? [220, 70, 60, 255] : [40, 110, 220, 255]); plate.writePng(join(dir, 'images', `${bone}.png`));
  }
  rig.skins = { default: skins }; rig.images = 'images';
  writeFileSync(join(dir, 'rig.json'), JSON.stringify(rig));
}
export function depthInput(gait: 'walk' | 'run' = 'walk') {
  const cycle = depthCycle(gait, 'front', 2);
  const sequence = readPoseSequence(JSON.stringify(depthDoc(cycle, 'Synthetic 3D gait; orthographic projection')), 'synthetic');
  const track = personTrack(sequence, 'a', 'synthetic');
  const depths = deriveDepth(track).frames;
  return { cycle, sequence, track, depths, times: sequence.frames.map(f => f.t) };
}

/** Analytical reader control, not a replacement for the 3D generator or consumer. */
export function leadInput() {
  const deltas = [8, 6, 0, -8, -6, 0, 8, -8];
  const leads = [1, 1, 1, -1, -1, -1, 1, -1];
  const point = (x: number, y: number): Joint => ({ state: 'observed', at: [x, y], score: 1 });
  const track = deltas.map((delta): Partial<Record<Body18, Joint>> => ({
    r_hip: point(0, 0), r_knee: point(0, 50), r_ankle: point(0, 100 + delta / 2),
    l_hip: point(20, 0), l_knee: point(20, 50), l_ankle: point(20, 100 - delta / 2),
  }));
  const depths: FrameDepth[] = deltas.map((_, i) => ({
    r_thigh: { ratio: 0.9, sign: 1, source: 'derived' }, r_shin: { ratio: 0.7 + i * 0.01, sign: -1, source: 'derived' },
    l_thigh: { ratio: 0.9, sign: 1, source: 'derived' }, l_shin: { ratio: 0.8 - i * 0.01, sign: -1, source: 'derived' },
  }));
  return { track, depths, leads };
}

