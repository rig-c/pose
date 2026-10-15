/**
 * Face direction (`rig-c/pose#138`): read yaw and pitch per frame from the five
 * body-18 face points (`nose` against the eye midpoint `r_eye + l_eye` and,
 * when present, the ear midpoint `r_ear + l_ear`, de-rolled by the eye line),
 * and map each configured axis into its declared range by compression (never
 * clipping, so motion changes at the extremes survive).
 */
import type { FaceAxis, FaceMap } from './map.ts';

type Pt = [number, number];

const DEG = 180 / Math.PI;

/**
 * Fraction of each side's limit below which `mapFaceAxis` is 1:1 identity
 * (`rig-c/pose#164`); above `FACE_KNEE * limit` (`12°` for `15°`, `8°` for `10°`),
 * a piecewise-linear knee compresses only the overshoot `[k, peak]` into `[k, limit]`.
 */
export const FACE_KNEE = 0.8;

export interface FaceSpan {
  min: number;
  max: number;
  range: number;
}

export interface FaceAxisReading {
  bone: string;
  limits: [number, number];
  /** Knee thresholds `[kneeNeg, kneePos]` in degrees (`FACE_KNEE * limits`), inside which mapping is 1:1. */
  knee: [number, number];
  read: FaceSpan;
  mapped: FaceSpan;
  /** Peak-to-limit ratios `[kNeg, kPos]` in (0, 1] for negative and positive sides. */
  scale: [number, number];
  /** Spearman rank (monotone) correlation between the read angle and the mapped keys over the clip. */
  corr: number;
  /** Per-frame read angle in degrees, before range compression. */
  raw: number[];
  /** Per-frame mapped rotate key in degrees, rounded to 0.001°. */
  keys: number[];
}

export interface FaceReading {
  ears: boolean;
  read: {
    yaw: FaceSpan;
    pitch: FaceSpan;
    rawYaw: number[];
    rawPitch: number[];
  };
  yaw?: FaceAxisReading;
  pitch?: FaceAxisReading;
}

const r3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function spanOf(xs: readonly number[]): FaceSpan {
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { min: r3(min), max: r3(max), range: r3(max - min) };
}

function ranksOf(xs: readonly number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const out = new Array<number>(xs.length).fill(0);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]!]! === xs[idx[i]!]!) j++;
    const rank = 0.5 * (i + j);
    for (let k = i; k <= j; k++) out[idx[k]!] = rank;
    i = j + 1;
  }
  return out;
}

function corrOf(a: readonly number[], b: readonly number[]): number {
  if (a.length < 2 || a.length !== b.length) return 1;
  const ra = ranksOf(a);
  const rb = ranksOf(b);
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    const xa = ra[i]! - ma;
    const xb = rb[i]! - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-9 ? r3(num / den) : 1;
}

/**
 * Read per-frame yaw and pitch (degrees) from `nose`, `r_eye`, `l_eye`, and
 * (when both are present) `r_ear` and `l_ear`.
 *
 * Sign convention (matching `rig-c` gallery `look` and the Part 1 range sweep):
 * - `yaw > 0`: nose turned toward the subject's right (`r_eye`, viewer-left).
 * - `pitch > 0`: nose tilted down (chin down / nod down).
 */
export function readFaceAngles(
  nose: readonly Pt[],
  rEye: readonly Pt[],
  lEye: readonly Pt[],
  rEar: readonly Pt[] | null,
  lEar: readonly Pt[] | null,
): { ears: boolean; yaw: number[]; pitch: number[] } {
  const n = nose.length;
  const ears = rEar !== null && lEar !== null && rEar.length === n && lEar.length === n;
  const xne: number[] = [];
  const xna: number[] = [];
  const yne: number[] = [];
  const yna: number[] = [];

  for (let i = 0; i < n; i++) {
    const N = nose[i]!;
    const Er = rEye[i]!;
    const El = lEye[i]!;
    const ex = El[0] - Er[0];
    const ey = El[1] - Er[1];
    const de = Math.hypot(ex, ey);
    if (!(de > 1e-9)) {
      xne.push(xne[i - 1] ?? 0);
      yne.push(yne[i - 1] ?? 0);
      if (ears) {
        xna.push(xna[i - 1] ?? 0);
        yna.push(yna[i - 1] ?? 0);
      }
      continue;
    }
    const ux = ex / de;
    const uy = ey / de;
    const vx = -uy;
    const vy = ux;
    const mex = 0.5 * (Er[0] + El[0]);
    const mey = 0.5 * (Er[1] + El[1]);
    xne.push(((mex - N[0]) * ux + (mey - N[1]) * uy) / de);
    yne.push(((N[0] - mex) * vx + (N[1] - mey) * vy) / de);
    if (ears) {
      const Ar = rEar[i]!;
      const Al = lEar[i]!;
      const max = 0.5 * (Ar[0] + Al[0]);
      const may = 0.5 * (Ar[1] + Al[1]);
      const da = Math.max(de, (Al[0] - Ar[0]) * ux + (Al[1] - Ar[1]) * uy);
      xna.push(((max - N[0]) * ux + (may - N[1]) * uy) / da);
      yna.push(((N[0] - max) * vx + (N[1] - may) * vy) / de);
    }
  }

  const yne0 = median(yne);
  const yna0 = ears ? median(yna) : 0;
  const yaw: number[] = [];
  const pitch: number[] = [];
  for (let i = 0; i < n; i++) {
    const ty = ears ? (2 * xne[i]! + xna[i]!) / 2 : 2 * xne[i]!;
    const tp = ears ? (yne[i]! - yne0 + (yna[i]! - yna0)) / 2 : yne[i]! - yne0;
    yaw.push(Math.atan(ty) * DEG);
    pitch.push(Math.atan(tp) * DEG);
  }
  return { ears, yaw, pitch };
}

function mapKneeSide(u: number, limit: number, peak: number): number {
  if (!(limit > 1e-9)) return 0;
  if (!(peak > limit)) return u;
  const k = FACE_KNEE * limit;
  if (u <= k) return u;
  if (u >= peak) return limit;
  return k + ((limit - k) * (u - k)) / (peak - k);
}

/**
 * Compress a read angle series into `axis.range` (`[min, max]` with `min <= 0 <= max`):
 * readings on a side whose peak stays inside the limit map 1:1 (`f(x) = x`); when a
 * side's peak exceeds its limit `L`, readings up to the knee `k = FACE_KNEE * L`
 * (`0.8 * L`, `rig-c/pose#164`) still map 1:1 and only the overshoot `[k, peak]` is
 * compressed linearly into `[k, L]`.
 */
export function mapFaceAxis(raw: readonly number[], axis: FaceAxis): FaceAxisReading {
  const limits = axis.range;
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (const x of raw) {
    if (x < rawMin) rawMin = x;
    if (x > rawMax) rawMax = x;
  }
  const limNeg = -limits[0];
  const limPos = limits[1];
  const peakNeg = -rawMin;
  const peakPos = rawMax;
  const kNeg = rawMin < limits[0] && rawMin < -1e-9 ? limits[0] / rawMin : 1;
  const kPos = rawMax > limits[1] && rawMax > 1e-9 ? limits[1] / rawMax : 1;
  const keys = raw.map((x) => r3(x < 0 ? -mapKneeSide(-x, limNeg, peakNeg) : mapKneeSide(x, limPos, peakPos)));
  return {
    bone: axis.bone,
    limits: [limits[0], limits[1]],
    knee: [r3(FACE_KNEE * limits[0]), r3(FACE_KNEE * limits[1])],
    read: spanOf(raw),
    mapped: spanOf(keys),
    scale: [r3(kNeg), r3(kPos)],
    corr: corrOf(raw, keys),
    raw: [...raw],
    keys,
  };
}

export function readFace(
  face: FaceMap,
  nose: readonly Pt[],
  rEye: readonly Pt[],
  lEye: readonly Pt[],
  rEar: readonly Pt[] | null,
  lEar: readonly Pt[] | null,
): FaceReading {
  const { ears, yaw, pitch } = readFaceAngles(nose, rEye, lEye, rEar, lEar);
  return {
    ears,
    read: {
      yaw: spanOf(yaw),
      pitch: spanOf(pitch),
      rawYaw: yaw,
      rawPitch: pitch,
    },
    ...(face.yaw === undefined ? {} : { yaw: mapFaceAxis(yaw, face.yaw) }),
    ...(face.pitch === undefined ? {} : { pitch: mapFaceAxis(pitch, face.pitch) }),
  };
}

const f1 = (x: number): string => x.toFixed(1);
const sg = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;

export function faceLine(f: FaceReading): string {
  const joints = f.ears ? 'nose against r_eye + l_eye, r_ear + l_ear' : 'nose against r_eye + l_eye (ears absent)';
  const readPart = `read yaw ${sg(f.read.yaw.min)}° … ${sg(f.read.yaw.max)}° (${f1(f.read.yaw.range)}°), pitch ${sg(f.read.pitch.min)}° … ${sg(f.read.pitch.max)}° (${f1(f.read.pitch.range)}°)`;
  const axes: string[] = [];
  for (const name of ['yaw', 'pitch'] as const) {
    const ax = f[name];
    if (ax === undefined) continue;
    axes.push(`${name} → bone "${ax.bone}" [${ax.limits[0]}, ${ax.limits[1]}]° (knee [${ax.knee[0]}, ${ax.knee[1]}]°): ${sg(ax.mapped.min)}° … ${sg(ax.mapped.max)}° (scale ${ax.scale[0].toFixed(3)}/${ax.scale[1].toFixed(3)}, r=${ax.corr.toFixed(3)})`);
  }
  return `${joints}: ${readPart}; mapped ${axes.join(', ')}`;
}
