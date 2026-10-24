/** #404: deterministic external measurement; never part of the pose schema. */
import { FIGURE_SCALE_METHOD, FIGURE_SCALE_SCORE, FIGURE_SCALE_THRESHOLD, type FigureScale } from './figurescale.ts';
import { isObject, parseJson, Problems, refuseUnknownKeys, typeName } from './problems.ts';

export const FIGURE_SCALE_SPEC = 'rig-pose-figure-scale/1';
export const figureScalePath = (out: string): string => `${out}.figure-scale.json`;

export interface FigureScaleRecord {
  spec: typeof FIGURE_SCALE_SPEC;
  inputSHA256: string;
  sequenceSHA256: string;
  person: string;
  cameraDeclared: boolean;
  figureScale: FigureScale;
}

/** Fixed key order, full measurement precision, no paths, clocks or host state. */
export function writeFigureScaleRecord(r: FigureScaleRecord): string {
  return `${JSON.stringify({ spec: r.spec, inputSHA256: r.inputSHA256, sequenceSHA256: r.sequenceSHA256, person: r.person, cameraDeclared: r.cameraDeclared, figureScale: copyFigureScale(r.figureScale) }, null, 2)}\n`;
}

export function readFigureScaleRecord(text: string, where: string, frames: number | null = null): FigureScaleRecord {
  const p = new Problems();
  const doc = parseJson(text, where, 'FIGURE_SCALE_RECORD');
  if (!isObject(doc)) { p.add('FIGURE_SCALE_RECORD', `${where} is ${typeName(doc)}; it must be a ${FIGURE_SCALE_SPEC} record`); p.throwIfAny(); }
  const d = doc as Record<string, unknown>;
  const keys = ['spec', 'inputSHA256', 'sequenceSHA256', 'person', 'cameraDeclared', 'figureScale'];
  refuseUnknownKeys(p, 'FIGURE_SCALE_RECORD', where, d, keys);
  for (const key of keys) if (!(key in d)) p.add('FIGURE_SCALE_RECORD', `${where} has no "${key}"; the record carries ${keys.join(', ')}`);
  if (d.spec !== FIGURE_SCALE_SPEC) p.add('FIGURE_SCALE_RECORD', `${where} "spec" is ${typeName(d.spec)}; it must be "${FIGURE_SCALE_SPEC}"`);
  for (const key of ['inputSHA256', 'sequenceSHA256']) if (typeof d[key] !== 'string' || !/^[0-9a-f]{64}$/.test(d[key] as string)) p.add('FIGURE_SCALE_RECORD', `${where} "${key}" is ${typeName(d[key])}; it must be a lowercase SHA-256 hex digest`);
  if (typeof d.person !== 'string' || d.person.length === 0) p.add('FIGURE_SCALE_RECORD', `${where} "person" is ${typeName(d.person)}; it must be a non-empty person ID`);
  if (typeof d.cameraDeclared !== 'boolean') p.add('FIGURE_SCALE_RECORD', `${where} "cameraDeclared" is ${typeName(d.cameraDeclared)}; it must be boolean`);
  const figureScale = readFigureScale(p, `${where} figureScale`, d.figureScale, frames, '');
  p.throwIfAny();
  return { spec: FIGURE_SCALE_SPEC, inputSHA256: d.inputSHA256 as string, sequenceSHA256: d.sequenceSHA256 as string, person: d.person as string, cameraDeclared: d.cameraDeclared as boolean, figureScale: figureScale! };
}

/** Validate the sidecar measurement without changing any pose input reader. */
function readFigureScale(p: Problems, where: string, value: unknown, frames: number | null, note: string): FigureScale | undefined {
  const before = p.list.length;
  const bad = (text: string) => p.add('FIGURE_SCALE_RECORD', `${where} ${text}`);
  if (!isObject(value)) { bad(`is ${typeName(value)}; it must be a measured figure-scale record`); return undefined; }
  const keys = ['source', 'method', 'minScore', 'threshold', 'referencePx', 'scale', 'minFrame', 'maxFrame', 'variation'];
  refuseUnknownKeys(p, 'FIGURE_SCALE_RECORD', where, value, keys, note);
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
