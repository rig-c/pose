/** Perspective from existing derived depth (#437); no depth is inferred here. */
import type { CompiledDocument } from 'rig-c/core';
import { ORIGIN_TOLERANCE } from './verify.ts';
import type { Body18 } from './joints.ts';
import type { Joint, FrameDepth, DepthGait } from './pose.ts';
import type { JointMap, Rest } from './map.ts';
import { limbJointDepths } from './depth.ts';
import { walkAnkleDepth } from './draworder.ts';
import { legsOf, percentile, SIDES, type Side } from './legs.ts';
import { Refusal } from './problems.ts';

export interface DepthFoot { bone: string; parent: string; slots: string[] }
export interface DepthScaleSide {
  side: Side;
  joint: 'knee' | 'ankle';
  depth: { min: number | null; max: number | null };
  scale: { min: number; median: number; max: number };
  limits: [number, number];
  status: 'scaled' | 'zero-span' | 'unread';
  /** Individual zero-based frames, not inclusive pairs. */
  clampedFrames: number[];
  unreadFrames: number[];
  values: number[];
}
export function depthScaleRefusal(code: string, text: string): never { throw new Refusal([{ code, text: `--depth-scale: ${text}` }]); }
export function depthScaleLimits(limits: readonly number[]): void {
  if (limits.length !== 2 || !limits.every(Number.isFinite) || !(limits[0]! > 0 && limits[0]! <= 1 && limits[1]! >= 1)) depthScaleRefusal('DEPTH_SCALE_RANGE', `range ${JSON.stringify(limits)} must satisfy 0 < min <= 1 <= max`);
}
/** Affine clip extrema (#437 HQ amendment); zero span is explicitly neutral. */
export function scaleDepth(z: number, extreme: { min: number; max: number }, limits: readonly [number, number]): { value: number; clamped: boolean } {
  if (extreme.max === extreme.min) return { value: 1, clamped: false };
  const raw = limits[0] + (limits[1] - limits[0]) * (z - extreme.min) / (extreme.max - extreme.min);
  const value = Math.min(limits[1], Math.max(limits[0], raw));
  return { value, clamped: value !== raw };
}
export function readDepthScale(track: ReadonlyArray<Partial<Record<Body18, Joint>>>, frames: ReadonlyArray<FrameDepth | undefined> | undefined, gait: DepthGait | undefined, limits: [number, number]): DepthScaleSide[] {
  depthScaleLimits(limits);
  if (gait === undefined || frames === undefined || frames.length !== track.length) depthScaleRefusal('DEPTH_SCALE_SOURCE', 'requires the derived-depth provenance and gait written by clean --depth walk|run');
  const selected = gait === 'walk' ? 'ankle' : 'knee';
  return SIDES.map(side => {
    const zs = track.map((joints, frame): number | null => {
      const depth = frames[frame];
      for (const name of [`${side}_thigh`, `${side}_shin`] as const) {
        const d = depth?.[name];
        if (d !== undefined && (d.source !== 'derived' || !Number.isFinite(d.ratio) || !(d.ratio > 0) || ![-1, 0, 1].includes(d.sign))) depthScaleRefusal('DEPTH_SCALE_SOURCE', `frame ${frame} segment "${name}" must carry valid derived depth; found ${JSON.stringify(d)}`);
      }
      const value = depth === undefined ? null : selected === 'ankle' ? walkAnkleDepth(joints, depth, `${side}_leg`) : limbJointDepths(joints, depth, `${side}_leg`)?.mid;
      return value === null || value === undefined || !Number.isFinite(value) ? null : value;
    });
    const finite = zs.filter((z): z is number => z !== null);
    const depth = { min: finite.length === 0 ? null : Math.min(...finite), max: finite.length === 0 ? null : Math.max(...finite) };
    const status = finite.length === 0 ? 'unread' : depth.min === depth.max ? 'zero-span' : 'scaled';
    const mapped = zs.map(z => z === null || depth.min === null || depth.max === null ? { value: 1, clamped: false } : scaleDepth(z, { min: depth.min, max: depth.max }, limits));
    const values = mapped.map(x => x.value);
    return { side, joint: selected, depth, limits, status, scale: { min: Math.min(...values), median: percentile(values, 0.5), max: Math.max(...values) }, unreadFrames: zs.flatMap((z,i) => z === null ? [i] : []), clampedFrames: mapped.flatMap((x, i) => x.clamped ? [i] : []), values };
  });
}
/** Locate the shoe by anatomical attachment, never a bone-name substring. */
export function depthFeetOf(doc: CompiledDocument, rest: Rest, map: JointMap): Record<Side, DepthFoot> {
  const legs = legsOf(map, '--depth-scale');
  if ('problems' in legs) depthScaleRefusal('DEPTH_SCALE_GEOMETRY', legs.problems.join('; '));
  const result = {} as Record<Side, DepthFoot>;
  for (const side of SIDES) {
    const shin = rest.get(legs.legs[side].ankleBone)!;
    const ankle: [number, number] = [shin.worldX + shin.a * shin.length, shin.worldY + shin.c * shin.length];
    const children = [...rest.values()].filter(b => b.parent === shin.name && Math.hypot(b.worldX - ankle[0], b.worldY - ankle[1]) <= ORIGIN_TOLERANCE);
    if (children.length !== 1) depthScaleRefusal('DEPTH_SCALE_GEOMETRY', `${side} ankle "${shin.name}:tip" needs exactly one foot child at its setup position; found ${children.length}`);
    const foot = children[0]!;
    if ([...rest.values()].some(b => b.parent === foot.name) || map.chains.some(c => c.bones.includes(foot.name))) depthScaleRefusal('DEPTH_SCALE_GEOMETRY', `foot "${foot.name}" must be an unmapped leaf; body-18 has no toe to aim its descendants`);
    // The positive local scalar is uniform under every inheritance mode. The
    // independent poser holds the resulting world axes and ankle to account.
    const slots = doc.slots.filter(slot => slot.bone === foot.name).map(slot => slot.name);
    let count = 0;
    for (const skin of doc.skins) for (const slot of slots) for (const [name, attachment] of Object.entries(skin.attachments[slot] ?? {})) {
      count++;
      const geometry = attachment.geometry;
      const rigid = geometry?.kind === 'region' || (geometry?.kind === 'mesh' && (!geometry.vertices.weighted || geometry.vertices.bindings.every(vertex => vertex.length === 1 && vertex[0]!.bone === foot.name && vertex[0]!.weight === 1)));
      if (!rigid) depthScaleRefusal('DEPTH_SCALE_GEOMETRY', `foot "${foot.name}" slot "${slot}" attachment "${name}" is ${attachment.kind}; require region or mesh rigidly bound to that foot alone (single unit-weight influence per vertex), not multi-bone geometry`);
    }
    if (count === 0) depthScaleRefusal('DEPTH_SCALE_GEOMETRY', `foot "${foot.name}" has no source attachment geometry`);
    result[side] = { bone: foot.name, parent: shin.name, slots };
  }
  return result;
}
export function depthScaleLine(row: DepthScaleSide): string {
  const note = row.status === 'unread' ? 'DEPTH_SCALE_UNREAD: no readable depth; scale 1 on every frame' : row.status === 'zero-span' ? 'DEPTH_SCALE_ZERO_SPAN: depth span is zero; scale 1 on every frame' : row.unreadFrames.length > 0 ? `DEPTH_SCALE_UNREAD: scale 1 on unread frames ${row.unreadFrames.join(',')}` : 'affine clip extrema';
  return `${row.side} ${row.joint} depth ${row.depth.min ?? 'unread'}..${row.depth.max ?? 'unread'} px (+ toward camera), foot perspective min ${row.scale.min.toFixed(6)} median ${row.scale.median.toFixed(6)} max ${row.scale.max.toFixed(6)}; range ${row.limits.join(',')}; clamped frames ${row.clampedFrames.length === 0 ? 'none' : row.clampedFrames.join(',')}; ${note}; grows from ankle, sole follows`;
}

/** Foot-only dense keys, independent of the existing leg solve and reducer. */
export function footScaleTracks(rows: readonly DepthScaleSide[], feet: Record<Side, DepthFoot>, times: readonly number[]): import('./retarget.ts').MotionTrack[] {
  return rows.flatMap(row => (['scalex', 'scaley'] as const).map(property => ({ bone: feet[row.side].bone, property, keys: times.map((t,i) => ({ t, v: [Math.round(row.values[i]! * 1e6) / 1e6] })) })));
}
