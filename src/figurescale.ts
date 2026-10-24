/**
 * #404: an advisory reading of input picture scale, before clean moves joints.
 * Foreshortening also changes this span: this never estimates a camera.
 */
import type { Body18 } from './joints.ts';
import type { Joint } from './pose.ts';

export const FIGURE_SCALE_METHOD = 'trunk-median-5';
export const FIGURE_SCALE_SCORE = 0.3;
export const FIGURE_SCALE_THRESHOLD = 0.1;
const WINDOW = 5;

export interface FigureScale {
  source: 'measured';
  method: typeof FIGURE_SCALE_METHOD;
  minScore: number;
  threshold: number;
  referencePx: number | null;
  /** One filtered input span / referencePx per frame; null means unmeasurable. */
  scale: Array<number | null>;
  minFrame: number | null;
  maxFrame: number | null;
  variation: number | null;
}

/** Fixed IEEE operation order avoids platform libm hypot rounding differences. */
function euclideanSpan(dx: number, dy: number): number | null {
  const maxAbs = Math.max(Math.abs(dx), Math.abs(dy));
  if (!Number.isFinite(maxAbs) || maxAbs === 0) return null;
  const x = dx / maxAbs;
  const y = dy / maxAbs;
  const span = maxAbs * Math.sqrt(x * x + y * y);
  return Number.isFinite(span) && span > 0 ? span : null;
}

export function measureFigureScale(track: Array<Partial<Record<Body18, Joint>>>): FigureScale {
  const spans = track.map((joints) => {
    const points: Array<[number, number]> = [];
    for (const name of ['r_hip', 'l_hip', 'r_shoulder', 'l_shoulder'] as const) {
      const j = joints[name];
      if (j === undefined || (j.state !== 'observed' && j.state !== 'inferred') || j.at === undefined || j.score === undefined || j.score < FIGURE_SCALE_SCORE) return null;
      points.push(j.at);
    }
    const [rh, lh, rs, ls] = points as [[number, number], [number, number], [number, number], [number, number]];
    return euclideanSpan(rh[0] / 2 + lh[0] / 2 - rs[0] / 2 - ls[0] / 2, rh[1] / 2 + lh[1] / 2 - rs[1] / 2 - ls[1] / 2);
  });
  const filtered = spans.map((_, i) => {
    if (i < 2 || i >= spans.length - 2) return null;
    const window = spans.slice(i - 2, i + 3);
    if (window.some((v) => v === null)) return null;
    return window.filter((v): v is number => v !== null).sort((a, b) => a - b)[Math.floor(WINDOW / 2)]!;
  });
  let minFrame: number | null = null;
  let maxFrame: number | null = null;
  let count = 0;
  filtered.forEach((v, i) => {
    if (v === null) return;
    count++;
    if (minFrame === null || v < filtered[minFrame]!) minFrame = i;
    if (maxFrame === null || v > filtered[maxFrame]!) maxFrame = i;
  });
  const base = { source: 'measured', method: FIGURE_SCALE_METHOD, minScore: FIGURE_SCALE_SCORE, threshold: FIGURE_SCALE_THRESHOLD } as const;
  if (count < 2 || minFrame === null || maxFrame === null) return { ...base, referencePx: null, scale: track.map(() => null), minFrame: null, maxFrame: null, variation: null };
  const max = filtered[maxFrame]!;
  const min = filtered[minFrame]!;
  const scale = filtered.map((v) => v === null ? null : v / max);
  // Distinct raw doubles can divide to the same ratio. Match the reader's first
  // extrema on the actual serialized track, without changing the raw metric.
  return { ...base, referencePx: max, scale, minFrame: scale.indexOf(min / max), maxFrame: scale.indexOf(1), variation: (max - min) / max };
}

/** Output lines only: no warning becomes a refusal or changes a position. */
export function figureScaleLines(r: FigureScale, cameraDeclared: boolean): string[] {
  if (r.referencePx === null || r.minFrame === null || r.maxFrame === null || r.variation === null) return ['FIGURE-SCALE unavailable: fewer than 2 complete five-frame trunk medians (mid_hip → mid_shoulder, four observed/inferred joints with scores ≥ 0.3); null track, no camera reading'];
  const measured = r.scale.filter((v) => v !== null).length;
  const range = `scale ${r.scale[r.minFrame]!.toFixed(6)} at frame ${r.minFrame} (min) to ${r.scale[r.maxFrame]!.toFixed(6)} at frame ${r.maxFrame} (max)`;
  const reading = `variation ${(100 * r.variation).toFixed(4)}% (max-min)/max; ${range}`;
  const lines = [`FIGURE-SCALE measured input trunk-median-5: ${reading}; reference ${r.referencePx.toFixed(4)} px, ${measured}/${r.scale.length} frames; camera ${cameraDeclared ? 'declared' : 'undeclared'}; picture span, not a camera estimate`];
  if (!cameraDeclared && r.variation > r.threshold) lines.push(`CAMERA_UNDECLARED WARN: ${reading}, over ${(100 * r.threshold).toFixed(1)}%; declare camera before clean (acquisition → camera declaration → clean): zoom can read as motion; pose foreshortening can also change figure scale; no camera guessed or corrected`);
  return lines;
}

