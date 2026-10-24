/**
 * #404: an advisory reading of input picture scale, before clean moves joints.
 * Foreshortening also changes this span: this never estimates a camera.
 */
import type { Body18 } from './joints.ts';
import type { Joint } from './pose.ts';
import { isObject, Problems, refuseUnknownKeys, typeName } from './problems.ts';

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

export function measureFigureScale(track: Array<Partial<Record<Body18, Joint>>>): FigureScale {
  const spans = track.map((joints) => {
    const points: Array<[number, number]> = [];
    for (const name of ['r_hip', 'l_hip', 'r_shoulder', 'l_shoulder'] as const) {
      const j = joints[name];
      if (j === undefined || (j.state !== 'observed' && j.state !== 'inferred') || j.at === undefined || j.score === undefined || j.score < FIGURE_SCALE_SCORE) return null;
      points.push(j.at);
    }
    const [rh, lh, rs, ls] = points as [[number, number], [number, number], [number, number], [number, number]];
    const span = Math.hypot(rh[0] / 2 + lh[0] / 2 - rs[0] / 2 - ls[0] / 2, rh[1] / 2 + lh[1] / 2 - rs[1] / 2 - ls[1] / 2);
    return Number.isFinite(span) && span > 0 ? span : null;
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
  return { ...base, referencePx: max, scale: filtered.map((v) => v === null ? null : v / max), minFrame, maxFrame, variation: (max - min) / max };
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

/** Optional additive clean record; old records have no such field. */
export function readFigureScale(p: Problems, where: string, value: unknown, frames: number | null, note: string): FigureScale | undefined {
  const before = p.list.length;
  const bad = (text: string) => p.add('POSE_CLEANED', `${where} ${text}`);
  if (!isObject(value)) { bad(`is ${typeName(value)}; it must be a measured figure-scale record`); return undefined; }
  const keys = ['source', 'method', 'minScore', 'threshold', 'referencePx', 'scale', 'minFrame', 'maxFrame', 'variation'];
  refuseUnknownKeys(p, 'POSE_CLEANED', where, value, keys, note);
  for (const k of keys) if (!(k in value)) bad(`has no "${k}"; a measured figure-scale record carries ${keys.join(', ')}`);
  for (const [k, v] of [['source', 'measured'], ['method', FIGURE_SCALE_METHOD], ['minScore', FIGURE_SCALE_SCORE], ['threshold', FIGURE_SCALE_THRESHOLD]] as const) {
    if (value[k] !== v) bad(`"${k}" is ${typeName(value[k])}; it must be ${JSON.stringify(v)} for this measurement`);
  }
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const scale = value.scale;
  if (!Array.isArray(scale) || (frames !== null && scale.length !== frames)) bad(`"scale" is ${Array.isArray(scale) ? `${scale.length} entries` : typeName(scale)}; it must have one number or null per frame (${frames ?? 'the sequence frame count'})`);
  else {
    scale.forEach((v: unknown, i: number) => { if (!(v === null || (finite(v) && v >= 0 && v <= 1))) bad(`"scale"[${i}] is ${typeName(v)}; it must be null or a finite ratio in [0, 1]`); });
    if (value.referencePx === null) {
      if (scale.some((v: unknown) => v !== null) || value.minFrame !== null || value.maxFrame !== null || value.variation !== null) bad('has null "referencePx"; an unknown measurement has an all-null scale, minFrame, maxFrame and variation');
    } else {
      if (!(finite(value.referencePx) && value.referencePx > 0)) bad(`"referencePx" is ${typeName(value.referencePx)}; it must be null or a finite span > 0 px`);
      const measured = scale.filter((v: unknown): v is number => finite(v) && v >= 0 && v <= 1);
      if (measured.length < 2) bad(`has ${measured.length} measured frame(s); a known measurement needs at least 2`);
      if (measured.length >= 2) {
        let min = 1;
        for (const v of measured) min = Math.min(min, v);
        const minFrame = scale.indexOf(min), maxFrame = scale.indexOf(1);
        if (maxFrame < 0) bad('"scale" has no maximum 1; the track is normalised by referencePx');
        if (value.minFrame !== minFrame) bad(`"minFrame" is ${typeName(value.minFrame)}; it must be the first minimum frame ${minFrame}`);
        if (value.maxFrame !== maxFrame) bad(`"maxFrame" is ${typeName(value.maxFrame)}; it must be the first maximum frame ${maxFrame}`);
        if (!(finite(value.variation) && value.variation >= 0 && value.variation <= 1 && Math.abs(value.variation - (1 - min)) <= 1e-12)) bad(`"variation" is ${typeName(value.variation)}; it must be (max-min)/max, ${1 - min}`);
      }
    }
  }
  if (p.list.length !== before) return undefined;
  return copyFigureScale(value as unknown as FigureScale);
}

/** Fixed field order; retain measured precision, including at the warning bar. */
export function copyFigureScale(r: FigureScale): FigureScale {
  return { source: r.source, method: r.method, minScore: r.minScore, threshold: r.threshold, referencePx: r.referencePx, scale: [...r.scale], minFrame: r.minFrame, maxFrame: r.maxFrame, variation: r.variation };
}
