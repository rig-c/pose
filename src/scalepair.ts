/** #384: an advisory reading only; never selects a scale or changes a key. */
import type { Body18 } from './joints.ts';
import { aimEnds, rigPoint, type JointMap, type Rest } from './map.ts';
import type { Joint } from './pose.ts';
import { pointOn } from './retarget.ts';

/**
 * test/flight.test.ts's existing hip-vertical upper gain is 1.15. Inverse-length
 * scaling gives max/min = 1/(1-v), v = (max-min)/max. Thus v > 1-1/1.15
 * (3/23, about 13.043478%) can inflate travel beyond that gain. A clip's spread
 * is a reason to inspect the pair, not a measurement of its median's bias.
 */
export const SCALE_PAIR_GAIN = 1.15;
export const SCALE_PAIR_VARIATION = 1 - 1 / SCALE_PAIR_GAIN;

interface Pair {
  pose: [string, string];
  rig: [string, string];
}
interface Reading {
  min: number;
  max: number;
  median: number;
  variation: number;
  frames: Set<number>;
}

/** Explicit correspondences, not a bone-name convention or a nearest-point fit. */
function mappedPairs(map: JointMap): Pair[] {
  const points = new Map<string, Set<string>>();
  const pairs: Pair[] = [];
  const add = (joint: string, point: string) => {
    const known = points.get(joint) ?? new Set<string>();
    known.add(point);
    points.set(joint, known);
  };
  const pair = (pose: Pair['pose'], rig: Pair['rig']) => {
    pairs.push({ pose, rig });
    add(pose[0], rig[0]);
    add(pose[1], rig[1]);
  };
  const t = map.translate;
  if (t !== null) {
    add(t.joint, t.bone);
    pair(t.scale.pose, t.scale.rig);
  }
  for (const c of map.chains) {
    for (let k = 0; k < c.bones.length; k++) {
      const bone = c.bones[k]!;
      const rig: Pair['rig'] = c.aim[k] === 'x' ? [bone, `${bone}:tip`] : aimEnds(bone, c.aim[k]!);
      pair([c.joints[k]!, c.joints[k + 1]!], rig);
    }
  }
  for (const part of ['shoulder', 'hip', 'eye']) {
    const pose: Pair['pose'] = [`r_${part}`, `l_${part}`];
    const a = points.get(pose[0]), b = points.get(pose[1]);
    // Conflicting declarations do not establish a usable correspondence.
    if (a?.size === 1 && b?.size === 1) pairs.push({ pose, rig: [[...a][0]!, [...b][0]!] });
  }
  return pairs;
}

/**
 * Observed samples only, exactly as translate.scale's median: both points
 * good on that frame. Missing/low-score points cannot make a candidate steady.
 */
export function scalePairWarning(rest: Rest, map: JointMap, frames: ReadonlyArray<Partial<Record<Body18, Joint>>>, minScore: number): string | null {
  const t = map.translate;
  if (t === null) return null;
  const cache = new Map<string, Array<ReturnType<typeof pointOn>>>();
  const at = (joint: string) => {
    let values = cache.get(joint);
    if (values === undefined) {
      values = frames.map((f) => pointOn(f, joint, minScore));
      cache.set(joint, values);
    }
    return values;
  };
  const read = (pose: Pair['pose']): Reading | null => {
    const a = at(pose[0]), b = at(pose[1]);
    const lengths: number[] = [];
    const observed = new Set<number>();
    let min = Infinity, max = 0;
    for (let i = 0; i < frames.length; i++) {
      const A = a[i]!, B = b[i]!;
      if (typeof A === 'string' || typeof B === 'string') continue;
      const length = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (!Number.isFinite(length)) return null;
      lengths.push(length);
      observed.add(i);
      min = Math.min(min, length);
      max = Math.max(max, length);
    }
    if (lengths.length < 2 || max <= 1e-6) return null;
    lengths.sort((a, b) => a - b);
    const k = Math.floor(lengths.length / 2);
    const median = lengths.length % 2 ? lengths[k]! : (lengths[k - 1]! + lengths[k]!) / 2;
    return { min, max, median, variation: (max - min) / max, frames: observed };
  };
  const chosen = read(t.scale.pose);
  // Compare the inverse directly: an exact 1.15 gain is inside the bound.
  if (chosen === null || chosen.max / chosen.min <= SCALE_PAIR_GAIN) return null;
  const candidates: Array<{ pair: Pair; reading: Reading }> = [];
  for (const pair of mappedPairs(map)) {
    const A = rigPoint(rest, pair.rig[0]), B = rigPoint(rest, pair.rig[1]);
    if (A === null || B === null) continue;
    const rigLength = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (!Number.isFinite(rigLength) || rigLength <= 1e-6) continue;
    const reading = read(pair.pose);
    if (reading === null || reading.min <= 1e-6 || reading.max / reading.min > SCALE_PAIR_GAIN || reading.variation >= chosen.variation) continue;
    if (reading.frames.size < chosen.frames.size || [...chosen.frames].some((i) => !reading.frames.has(i))) continue;
    candidates.push({ pair, reading });
  }
  const label = (pair: Pair) => `${pair.pose.join(' → ')} (rig ${pair.rig.join(' → ')})`;
  const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  candidates.sort((a, b) => a.reading.variation - b.reading.variation || b.reading.median - a.reading.median || lexical(label(a.pair), label(b.pair)));
  const best = candidates[0];
  // Keep adjacent-to-bound measurements distinguishable in the printed inequality.
  const nearBound = (100 * chosen.variation).toFixed(6) === (100 * SCALE_PAIR_VARIATION).toFixed(6);
  const percent = (v: number) => nearBound ? (100 * v).toPrecision(17) : (100 * v).toFixed(6);
  const alternative = best === undefined
    ? 'no steadier viable pair from the map on these observed frames'
    : `steadier mapped pair: ${label(best.pair)}, variation ${percent(best.reading.variation)}% (${best.reading.min.toFixed(2)}–${best.reading.max.toFixed(2)}px, ${best.reading.frames.size}/${frames.length} good frames including all ${chosen.frames.size} chosen-pair observations); inspect its proportions before choosing it`;
  return `SCALE-PAIR WARN ${label(t.scale)}: picture length ${chosen.min.toFixed(2)}–${chosen.max.toFixed(2)}px on ${chosen.frames.size}/${frames.length} good frames; variation (max-min)/max ${percent(chosen.variation)}% > ${percent(SCALE_PAIR_VARIATION)}% (inverse-length gain > ${SCALE_PAIR_GAIN}); ${alternative}; advisory only, scale unchanged`;
}
