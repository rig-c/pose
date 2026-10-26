/** Synthetic source-only fixture for #437; no reference art. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Plate } from 'rig-c/plate';
import { depthCycle, depthDoc } from '../examples/walk/make-depth.ts';
import { readPoseSequence, personTrack } from '../src/pose.ts';
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

