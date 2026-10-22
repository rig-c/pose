/** Shared generated input for #369 and the #375 PR regression row. No exam input. */
import { clean } from '../src/clean.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { depthCycle, depthDoc, STRIDE, type DepthFrame } from '../examples/walk/make-depth.ts';

export const FPS = 24;
export const STRIDES = 10;
export const CYCLE = STRIDE.run;
type Pt = [number, number];

export const run = (): DepthFrame[] => depthCycle('run', 'front', STRIDES, true);
export const series = (c: DepthFrame[], j: string): Pt[] => c.map((f) => f.joints[j]!);

/** The fixture as a cleaned, in-place sequence, the form retarget reads. */
export function sequence(): string {
  const doc = { ...depthDoc(run(), 'test/flight.test.ts: the frontal run of make-depth.ts carried on a floor, no picture'), travel: 'in-place' };
  const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
  return writePoseSequence(clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture').seq);
}

