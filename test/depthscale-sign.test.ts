import { describe, expect, test } from 'bun:test';
import { ankleLeadSigns, footLeadTie, readDepthScale, scaleDepth, depthScaleLine } from '../src/depthscale.ts';
import { walkAnkleDepth } from '../src/draworder.ts';
import { limbJointDepths } from '../src/depth.ts';
import { leadInput, depthInput } from './depthscale-fixture.ts';
import type { Joint } from '../src/pose.ts';

const ankle = (y: number): Joint => ({ state: 'observed', at: [0, y], score: 1 });
const frame = (delta: number) => ({ r_ankle: ankle(100 + delta), l_ankle: ankle(100) });

describe('#440 explicit picture-y lead', () => {
  test('lower ankle leads; explicit tie holds the previous decision, including its boundary', () => {
    expect(ankleLeadSigns([frame(3), frame(1), frame(0), frame(-1), frame(-3), frame(0)], 1, false)).toEqual([1, 1, 1, 1, -1, -1]);
    expect(ankleLeadSigns([frame(0.01), frame(-0.01)], 0, false)).toEqual([1, -1]);
  });
  test('leading ties unread without a predecessor; loop inherits its last decision', () => {
    const track = [frame(0), frame(0), frame(3), frame(0), frame(-3), frame(0)];
    expect(ankleLeadSigns(track, 0, false)).toEqual([null, null, 1, 1, -1, -1]);
    expect(ankleLeadSigns(track, 0, true)).toEqual([-1, -1, 1, 1, -1, -1]);
    for (const loop of [false, true]) {
      expect(ankleLeadSigns([frame(0), frame(0)], 0, loop)).toEqual([null, null]);
      expect(ankleLeadSigns([], 0, loop)).toEqual([]);
    }
  });
  test('absent, missing, unplaced and nonfinite ankles hold only a real prior decision', () => {
    const bad = [{}, { r_ankle: { state: 'missing' as const, at: [0, 99] as [number, number] }, l_ankle: ankle(100) }, { r_ankle: { state: 'occluded' as const }, l_ankle: ankle(100) }, frame(NaN)];
    expect(ankleLeadSigns(bad, 0, true)).toEqual([null, null, null, null]);
    expect(ankleLeadSigns([frame(2), ...bad, frame(-2)], 0, false)).toEqual([1, 1, 1, 1, 1, -1]);
    expect(ankleLeadSigns([...bad, frame(-2)], 0, true)).toEqual([-1, -1, -1, -1, -1]);
    expect(ankleLeadSigns([{ r_ankle: { ...ankle(102), state: 'inferred' }, l_ankle: ankle(100) }], 0, false)).toEqual([1]);
    for (const tie of [-1, NaN, Infinity]) expect(() => ankleLeadSigns([frame(2)], tie, false)).toThrow('DEPTH_SCALE_SOURCE');
  });
  test('FEET unit is mean of the two side medians; sign changes preserve every magnitude and source', () => {
    const f = leadInput(), before = JSON.stringify(f);
    expect(footLeadTie(f.track)).toBe(1);
    const rows = readDepthScale(f.track, f.depths, 'walk', [1, 1.48]);
    rows.forEach((row, k) => {
      const signed = f.track.map((j, i) => Math.abs(walkAnkleDepth(j, f.depths[i]!, `${row.side}_leg`)!) * f.leads[i]! * (k === 0 ? 1 : -1));
      const extreme = { min: Math.min(...signed), max: Math.max(...signed) };
      expect(row.depth).toEqual(extreme);
      signed.forEach((z, i) => expect(row.values[i]).toBe(scaleDepth(z, extreme, [1, 1.48]).value));
      expect(row.signSource).toBe('ankle-picture-y');
      expect(row.tie).toBe(1);
      expect(row.tiedFrames).toEqual([2, 5]);
      expect(depthScaleLine(row)).toContain('2 frames inside band');
    });
    expect(JSON.stringify(f)).toBe(before);
    const unequal = f.track.map(j => ({ ...j, l_hip: ankle(-100) }));
    // Right median = 100; left median includes the independently placed hip.
    const left = unequal.map(j => Math.hypot(j.l_hip.at![0] - j.l_ankle!.at![0], j.l_hip.at![1] - j.l_ankle!.at![1])).sort((a, b) => a - b);
    expect(footLeadTie(unequal)).toBeCloseTo(0.01 * (100 + (left[3]! + left[4]!) / 2) / 2, 12);
  });
  test('readable magnitude but unknown lead is named neutral; loop wraps the final decision', () => {
    const f = leadInput();
    const track = f.track.map((j, i) => i < 2 ? { ...j, r_ankle: { ...j.r_ankle!, at: [...j.l_ankle!.at!] as [number, number] } } : j);
    const linear = readDepthScale(track, f.depths, 'walk', [1, 1.48]);
    for (const row of linear) {
      expect(row.unreadFrames).toEqual([0, 1, 2]);
      expect(row.values.slice(0, 3)).toEqual([1, 1, 1]);
      expect(depthScaleLine(row)).toContain('DEPTH_SCALE_UNREAD');
    }
    expect(readDepthScale(track, f.depths, 'walk', [1, 1.48], true).every(row => row.unreadFrames.length === 0)).toBe(true);
    const tied = f.track.map(j => ({ ...j, r_ankle: { ...j.r_ankle!, at: [...j.l_ankle!.at!] as [number, number] } }));
    for (const loop of [false, true]) for (const row of readDepthScale(tied, f.depths, 'walk', [1, 1.48], loop)) {
      expect(row.status).toBe('unread');
      expect(row.unreadFrames).toHaveLength(tied.length);
      expect(row.tiedFrames).toHaveLength(tied.length);
      expect(row.values.every(v => v === 1)).toBe(true);
      expect(depthScaleLine(row)).toContain('DEPTH_SCALE_UNREAD');
    }
    const noUnit = f.track.map(({ r_hip: _hip, ...j }) => j);
    expect(footLeadTie(noUnit)).toBeNull();
    expect(readDepthScale(noUnit, f.depths, 'walk', [1, 1.48]).every(row => row.status === 'unread')).toBe(true);
  });
  test('RUN keeps its existing derived knee depth, sign, affine factors and no ankle dependency', () => {
    const f = depthInput('run');
    const rows = readDepthScale(f.track, f.depths, 'run', [1, 1.48], true);
    rows.forEach(row => {
      const zs = f.track.map((j, i) => limbJointDepths(j, f.depths[i]!, `${row.side}_leg`)!.mid);
      const extreme = { min: Math.min(...zs), max: Math.max(...zs) };
      expect(row.depth).toEqual(extreme);
      expect(row.values).toEqual(zs.map(z => scaleDepth(z, extreme, [1, 1.48]).value));
      expect(row.joint).toBe('knee');
      expect(row.signSource).toBe('derived');
      expect(row.tie).toBeNull();
      expect(row.tiedFrames).toEqual([]);
    });
    const noAnkles = f.track.map(({ r_ankle: _r, l_ankle: _l, ...j }) => j);
    expect(readDepthScale(noAnkles, f.depths, 'run', [1, 1.48]).map(row => row.values)).toEqual(rows.map(row => row.values));
  });
});
