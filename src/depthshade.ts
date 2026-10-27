/** Slot light RGB from signed gait depth (#446); pure and opt-in. */
import { FLAT_BAND, LIMBS, limbJointDepths, type Limb } from './depth.ts';
import { walkAnkleDepth } from './draworder.ts';
import { LEGS, savitzkyGolay, windowProblem } from './clean.ts';
import type { Body18 } from './joints.ts';
import type { Chain, JointMap } from './map.ts';
import { DEPTH_SEGMENTS, type CleanRecord, type DepthGait, type DepthSegment, type FrameDepth, type Joint } from './pose.ts';
import { Refusal } from './problems.ts';

type Joints = Partial<Record<Body18, Joint>>;
export interface ShadeTrack { slot: string; property: 'rgb'; keys: Array<{ t: number; v: number[] }> }
export interface ShadeSelection { mode: 'default-legs' | 'explicit'; requested: string[] | null; chains: string[] }
export type ShadeCleanParams = Pick<CleanRecord['params'], 'loop' | 'legs' | 'rest' | 'depth'>;
type Sign = -1 | 1;
export interface ShadeHeldSpan { frames: [number, number]; sign: Sign; seedFrame: number; reason: 'flat-band' | 'above-band' | 'side-on-or-unread' }
export interface ShadeUnreadSpan { frames: [number, number]; reason: 'leading-undecided' | 'all-undecided'; sourceReason: ShadeHeldSpan['reason'] }
export interface ShadeSegmentReading { segment: DepthSegment; sourceSigns: Array<-1 | 0 | 1>; signs: Array<Sign | null>; held: ShadeHeldSpan[]; unreadFrames: number[]; unreadSpans: ShadeUnreadSpan[] }
export interface ShadeLimb {
  limb: Limb;
  slots: string[];
  joints: Body18[];
  window: number;
  segments: ShadeSegmentReading[];
  depth: Array<number | null>;
  smoothedDepth: Array<number | null>;
  farthest: number;
  farness: Array<number | null>;
  unreadFrames: number[];
  unreadSpans: Array<{ frames: [number, number]; reason: 'sign-unread' | 'geometry-unread'; objects: string[] }>;
  status: 'read' | 'partly-unread' | 'unread' | 'no-far';
}
export interface ShadeReconstruction {
  selection?: ShadeSelection;
  method: 'held-segment-depth-sg/1';
  stage: 'retarget-on-cleaned-joints';
  source: { kind: 'derived'; gait: DepthGait; cleaned: { loop: boolean; legs: number; rest: number }; rest: 'drawn/recorded-ratio' };
  tie: { flatBand: [number, number]; policy: 'last-decided-through-every-recorded-zero'; initial: 'loop-last-decision/nonloop-unread'; unreadMultiplier: 1 };
  limbs: Array<Pick<ShadeLimb, 'limb' | 'joints' | 'window' | 'segments' | 'unreadFrames' | 'unreadSpans' | 'status'>>;
}
const refuse = (code: string, text: string): never => { throw new Refusal([{ code, text: `--depth-shade: ${text}` }]); };
export function shadeLimit(k: number): void {
  if (!Number.isFinite(k) || k < 0 || k > 1) refuse('DEPTH_SHADE_RANGE', `k ${k} must be a finite RGB multiplier in [0, 1]`);
}
/** A same-side limb segment, identified only by its anatomical joints. */
function shadeLimb(chain: Chain): Limb | undefined {
  return (Object.keys(LIMBS) as Limb[]).find(limb => {
    const side = limb.slice(0, 1);
    const allowed = limb.endsWith('arm') ? [`${side}_shoulder`, `${side}_elbow`, `${side}_wrist`] : [`${side}_hip`, `${side}_knee`, `${side}_ankle`];
    return new Set(chain.joints).size >= 2 && chain.joints.every(joint => allowed.includes(joint));
  });
}
/** Default legs follow map order; an explicit list keeps its first occurrence order. */
export function selectShadeChains(map: JointMap, requested?: readonly string[]): ShadeSelection {
  if (requested === undefined) return { mode: 'default-legs', requested: null, chains: map.chains.filter(chain => shadeLimb(chain)?.endsWith('leg')).map(chain => chain.name) };
  if (requested.length === 0 || requested.some(name => name.trim() === '')) refuse('DEPTH_SHADE_CHAINS', '--depth-shade-chains needs one or more nonempty comma-separated map chain names');
  const names = [...new Set(requested)];
  for (const name of names) {
    const chain = map.chains.find(chain => chain.name === name);
    if (chain === undefined) return refuse('DEPTH_SHADE_CHAINS', `--depth-shade-chains names unknown chain "${name}"; map chains: ${map.chains.map(chain => chain.name).join(', ') || 'none'}`);
    if (shadeLimb(chain) === undefined) refuse('DEPTH_SHADE_CHAINS', `--depth-shade-chains chain "${name}" has joints ${chain.joints.join(' -> ')}; expected at least two distinct joints of one same-side hip/knee/ankle or shoulder/elbow/wrist limb`);
  }
  return { mode: 'explicit', requested: [...names], chains: names };
}
/** Only selected direct mapped bones own RGB; other chains are not inspected. */
export function shadeSlots(map: JointMap, slots: ReadonlyArray<{ name: string; bone: string }>, selection: ShadeSelection = selectShadeChains(map)): Map<Limb, string[]> {
  const owners = new Map<string, Limb>();
  for (const name of selection.chains) {
    const chain = map.chains.find(chain => chain.name === name)!;
    const limb = shadeLimb(chain)!;
    for (const slot of slots.filter(s => chain.bones.includes(s.bone))) {
      const previous = owners.get(slot.name);
      if (previous !== undefined && previous !== limb) refuse('DEPTH_SHADE_MAP', `slot "${slot.name}" belongs to both ${previous} and ${limb}`);
      owners.set(slot.name, limb);
    }
  }
  const out = new Map<Limb, string[]>();
  for (const slot of slots) {
    const limb = owners.get(slot.name);
    if (limb !== undefined) out.set(limb, [...(out.get(limb) ?? []), slot.name]);
  }
  return out;
}
/** Mirror depth-scale's last-decision policy, including unread leading/all-tie
 * observations. Reasons describe recorded ratio/sign only, never inferred facing. */
export function heldShadeSigns(segment: DepthSegment, values: ReadonlyArray<{ ratio: number; sign: -1 | 0 | 1 }>, loop: boolean): ShadeSegmentReading {
  let prior: Sign | null = null;
  let seed = -1;
  if (loop) values.forEach((v, i) => { if (v.sign !== 0) { prior = v.sign; seed = i; } });
  const held: ShadeHeldSpan[] = [];
  const unreadFrames: number[] = [];
  const unreadSpans: ShadeUnreadSpan[] = [];
  const unreadReason = values.some(v => v.sign !== 0) ? 'leading-undecided' : 'all-undecided';
  const signs = values.map((v, i) => {
    if (v.sign !== 0) { prior = v.sign; seed = i; return prior; }
    const reason: ShadeHeldSpan['reason'] = v.ratio > FLAT_BAND[1] ? 'above-band' : v.ratio >= FLAT_BAND[0] ? 'flat-band' : 'side-on-or-unread';
    if (prior === null) {
      unreadFrames.push(i);
      const last = unreadSpans.at(-1);
      if (last !== undefined && last.frames[1] === i - 1 && last.sourceReason === reason) last.frames[1] = i;
      else unreadSpans.push({ frames: [i, i], reason: unreadReason, sourceReason: reason });
      return null;
    }
    const last = held.at(-1);
    if (last !== undefined && last.frames[1] === i - 1 && last.sign === prior && last.seedFrame === seed && last.reason === reason) last.frames[1] = i;
    else held.push({ frames: [i, i], sign: prior, seedFrame: seed, reason });
    return prior;
  });
  return { segment, sourceSigns: values.map(v => v.sign), signs, held, unreadFrames, unreadSpans };
}
export function readDepthShade(track: readonly Joints[], depths: ReadonlyArray<FrameDepth | undefined>, params: ShadeCleanParams | undefined, k: number, slots: ReadonlyMap<Limb, readonly string[]>): ShadeLimb[] {
  shadeLimit(k);
  const gait = params?.depth?.gait;
  if (params === undefined || gait === undefined || depths.length !== track.length || track.length === 0) return refuse('DEPTH_SHADE_SOURCE', 'requires the derived-depth provenance, gait and actual windows written by clean --depth walk|run');
  for (const name of ['legs', 'rest'] as const) {
    const why = windowProblem(`cleaned.params.${name}`, params[name]);
    if (why !== null || (params.loop && track.length < params[name])) refuse('DEPTH_SHADE_WINDOW', why ?? `cleaned.params.${name} window ${params[name]} exceeds loop length ${track.length}; a circular window must not read a sample twice`);
  }
  return [...slots].map(([limb, names]) => {
    const required = gait === 'run' && limb.endsWith('leg') ? [LIMBS[limb][0]] : [...LIMBS[limb]];
    const joints = [...new Set(required.flatMap(s => DEPTH_SEGMENTS[s]))];
    const window = joints.every(j => LEGS.includes(j)) ? params.legs : params.rest;
    const segments = required.map(segment => {
      const values = depths.map((d, frame) => {
        const v = d?.[segment];
        if (v === undefined || v.source !== 'derived' || !Number.isFinite(v.ratio) || v.ratio < 0 || ![-1, 0, 1].includes(v.sign)) return refuse('DEPTH_SHADE_SOURCE', `limb "${limb}" frame ${frame} segment "${segment}" needs valid derived ratio/sign; found ${JSON.stringify(v)}`);
        if (v.ratio === 0) return refuse('DEPTH_SHADE_GEOMETRY', `limb "${limb}" frame ${frame} segment "${segment}": legal ratio 0 leaves drawn/ratio rest length unread; no magnitude is inferred`);
        return v;
      });
      return heldShadeSigns(segment, values, params.loop);
    });
    const unreadSpans: ShadeLimb['unreadSpans'] = [];
    const markUnread = (frame: number, reason: 'sign-unread' | 'geometry-unread', objects: string[]): null => {
      const last = unreadSpans.at(-1);
      if (last !== undefined && last.frames[1] === frame - 1 && last.reason === reason && last.objects.join(',') === objects.join(',')) last.frames[1] = frame;
      else unreadSpans.push({ frames: [frame, frame], reason, objects });
      return null;
    };
    const depth = track.map((points, frame): number | null => {
      // Missing geometry and undecided sign are separate unread observations.
      // Neither one is fabricated, and a null centre stays null through SG.
      const missing = joints.filter(j => points[j]?.at === undefined || points[j]?.state === 'missing' || !points[j]!.at!.every(Number.isFinite));
      if (missing.length > 0) return markUnread(frame, 'geometry-unread', missing);
      const undecided = segments.filter(s => s.signs[frame] === null).map(s => s.segment);
      if (undecided.length > 0) return markUnread(frame, 'sign-unread', undecided);
      const copy: FrameDepth = { ...depths[frame] };
      for (const s of segments) copy[s.segment] = { ...depths[frame]![s.segment]!, sign: s.signs[frame]! };
      const joint = limbJointDepths(points, copy, limb);
      const z = limb.endsWith('leg') ? gait === 'walk' ? walkAnkleDepth(points, copy, limb) : joint?.mid : joint?.end === null || joint?.end === undefined ? null : (joint.mid + joint.end) / 2;
      return z === null || z === undefined || !Number.isFinite(z) ? markUnread(frame, 'geometry-unread', joints) : z;
    });
    const smoothedDepth = savitzkyGolay(depth.map(z => z === null ? null : [z, 0]), window, params.loop).map(p => p === null ? null : p[0]);
    const farthest = Math.max(0, ...smoothedDepth.flatMap(z => z === null ? [] : [-z]));
    const farness = smoothedDepth.map(z => z === null ? null : farthest === 0 ? 0 : Math.max(0, -z) / farthest);
    const unreadFrames = smoothedDepth.flatMap((z, i) => z === null ? [i] : []);
    const status = unreadFrames.length === track.length ? 'unread' : unreadFrames.length > 0 ? 'partly-unread' : farthest === 0 ? 'no-far' : 'read';
    return { limb, slots: [...names], joints, window, segments, depth, smoothedDepth, farthest, farness, unreadFrames, unreadSpans, status };
  });
}
export function shadeReconstruction(rows: readonly ShadeLimb[], params: ShadeCleanParams, selection?: ShadeSelection): ShadeReconstruction {
  return { ...(selection === undefined ? {} : { selection }), method: 'held-segment-depth-sg/1', stage: 'retarget-on-cleaned-joints', source: { kind: 'derived', gait: params.depth!.gait, cleaned: { loop: params.loop, legs: params.legs, rest: params.rest }, rest: 'drawn/recorded-ratio' }, tie: { flatBand: [FLAT_BAND[0], FLAT_BAND[1]], policy: 'last-decided-through-every-recorded-zero', initial: 'loop-last-decision/nonloop-unread', unreadMultiplier: 1 }, limbs: rows.map(({ limb, joints, window, segments, unreadFrames, unreadSpans, status }) => ({ limb, joints, window, segments, unreadFrames, unreadSpans, status })) };
}
/** The shade key writer rounds RGB once to 1e-6, like the other dense key writers.
 * The motion JSON serializer does not round again; rig-c owns its later hex encoding.
 * RGB multiplies setup RGB and leaves alpha to setup/alpha tracks. k=1 or known no-far
 * depth writes no colour track, preserving idle colour ownership as an identity. */
export function depthShadeTracks(rows: readonly ShadeLimb[], k: number, times: readonly number[], duration: number, loop: boolean, setupColours: ReadonlyMap<string, string | undefined> = new Map()): ShadeTrack[] {
  shadeLimit(k);
  if (k === 1) return [];
  return rows.filter(row => row.farthest > 0 || row.unreadFrames.length > 0).flatMap(row => row.slots.map(slot => {
    const colour = setupColours.get(slot) ?? 'ffffffff';
    const rgb = [0, 2, 4].map(i => parseInt(colour.slice(i, i + 2), 16) / 255);
    const keys = times.map((t, i) => {
      const f = row.farness[i];
      const factor = f === null || f === undefined ? 1 : 1 + (k - 1) * f;
      return { t, v: rgb.map(value => Math.round(value * factor * 1e6) / 1e6) };
    });
    if (loop && keys.length > 0 && keys.at(-1)!.t < duration) keys.push({ t: duration, v: [...keys[0]!.v] });
    return { slot, property: 'rgb' as const, keys };
  }));
}
