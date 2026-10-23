/** #384: an advisory reading only; never selects a scale or changes a key. */
import type { Body18 } from './joints.ts';
import type { JointMap, Rest } from './map.ts';
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

/**
 * Observed samples only, exactly as translate.scale's median: both points
 * good on that frame. Missing/low-score points are not held into the measured spread.
 */
export function scalePairWarning(_rest: Rest, map: JointMap, frames: ReadonlyArray<Partial<Record<Body18, Joint>>>, minScore: number): string | null {
  const t = map.translate;
  if (t === null) return null;
  let min = Infinity, max = 0, good = 0;
  for (const frame of frames) {
    const a = pointOn(frame, t.scale.pose[0], minScore);
    const b = pointOn(frame, t.scale.pose[1], minScore);
    if (typeof a === 'string' || typeof b === 'string') continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!Number.isFinite(length)) return null;
    good++;
    min = Math.min(min, length);
    max = Math.max(max, length);
  }
  if (good < 2 || max <= 1e-6) return null;
  // Compare the inverse directly: an exact 1.15 gain is inside the bound.
  if (max / min <= SCALE_PAIR_GAIN) return null;
  const variation = (max - min) / max;
  // Keep adjacent-to-bound measurements distinguishable in the printed inequality.
  const nearBound = (100 * variation).toFixed(6) === (100 * SCALE_PAIR_VARIATION).toFixed(6);
  const percent = (v: number) => nearBound ? (100 * v).toPrecision(17) : (100 * v).toFixed(6);
  // #387 option (b): observed steadiness cannot validate pose-to-rig proportions.
  return `SCALE-PAIR WARN ${t.scale.pose.join(' → ')} (rig ${t.scale.rig.join(' → ')}): picture length ${min.toFixed(2)}–${max.toFixed(2)}px on ${good}/${frames.length} good frames; variation (max-min)/max ${percent(variation)}% > ${percent(SCALE_PAIR_VARIATION)}% (inverse-length gain > ${SCALE_PAIR_GAIN}); see docs/REFERENCE.md "The map: rig-pose-map/1", translate.scale rule for choosing corresponding points; advisory only, scale unchanged`;
}
