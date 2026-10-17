/**
 * Face direction (`rig-c/pose#138`): read yaw and pitch per frame from the five
 * body-18 face points (`nose` against the eye midpoint `r_eye + l_eye` and,
 * when present, the ear midpoint `r_ear + l_ear`, de-rolled by the eye line),
 * and map each configured axis into its declared range by compression (never
 * clipping, so motion changes at the extremes survive).
 */
import type { BodyMap, FaceAxis, FaceMap, YawSet } from './map.ts';

type Pt = [number, number];

const DEG = 180 / Math.PI;

/**
 * Fraction of each side's limit below which `mapFaceAxis` is 1:1 identity
 * (`rig-c/pose#164`); above `FACE_KNEE * limit` (`12°` for `15°`, `8°` for `10°`),
 * a piecewise-linear knee compresses only the overshoot `[k, peak]` into `[k, limit]`.
 */
export const FACE_KNEE = 0.8;

/** Hysteresis in degrees for leaving a yaw-selected set (`leave = above - 10°`, `rig-c/pose#173`). */
export const SET_HYSTERESIS_DEG = 10;

export interface YawSetSwitch {
  set: string;
  above: number;
  leave: number;
  /** Inclusive `[first, last]` frame spans where the set is shown. */
  spans: Array<[number, number]>;
  /** Total number of attachment transitions (enter + leave boundaries inside the clip). */
  swaps: number;
  /** Any `hides` slot of this set that is also keyed by another track, with the track that keys it. */
  hidesKeyed: Array<{ slot: string; by: string }>;
}

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
  sets?: YawSetSwitch[];
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

function formatYawSets(sets: readonly YawSetSwitch[] | undefined, raw: readonly number[]): string {
  if (sets === undefined || sets.length === 0) return '';
  const parts = sets.map((s) => {
    const spanStr = s.spans.length === 0
      ? 'none (0 swaps)'
      : `${s.spans.map(([lo, hi]) => {
          const slice = raw.slice(lo, hi + 1);
          const sMin = Math.min(...slice);
          const sMax = Math.max(...slice);
          const where = lo === hi ? `frame ${lo}` : `frames ${lo}–${hi}`;
          return `${where} (${lo === hi ? `${sg(sMax)}°` : `${sg(sMin)}° … ${sg(sMax)}°`})`;
        }).join(', ')} (${s.swaps} swap${s.swaps === 1 ? '' : 's'})`;
    const hidesStr = s.hidesKeyed.length === 0
      ? ''
      : `; hides keyed by another track: ${s.hidesKeyed.map((h) => `slot "${h.slot}" (${h.by})`).join(', ')}`;
    return `set "${s.set}" (≥ ${s.above}°, leave < ${s.leave}°): ${spanStr}${hidesStr}`;
  });
  return `; sets ${parts.join('; ')}`;
}

export function faceLine(f: FaceReading): string {
  const joints = f.ears ? 'nose against r_eye + l_eye, r_ear + l_ear' : 'nose against r_eye + l_eye (ears absent)';
  const readPart = `read yaw ${sg(f.read.yaw.min)}° … ${sg(f.read.yaw.max)}° (${f1(f.read.yaw.range)}°), pitch ${sg(f.read.pitch.min)}° … ${sg(f.read.pitch.max)}° (${f1(f.read.pitch.range)}°)`;
  const axes: string[] = [];
  for (const name of ['yaw', 'pitch'] as const) {
    const ax = f[name];
    if (ax === undefined) continue;
    axes.push(`${name} → bone "${ax.bone}" [${ax.limits[0]}, ${ax.limits[1]}]° (knee [${ax.knee[0]}, ${ax.knee[1]}]°): ${sg(ax.mapped.min)}° … ${sg(ax.mapped.max)}° (scale ${ax.scale[0].toFixed(3)}/${ax.scale[1].toFixed(3)}, r=${ax.corr.toFixed(3)})`);
  }
  const mappedPart = axes.length === 0 ? '' : `; mapped ${axes.join(', ')}`;
  return `${joints}: ${readPart}${mappedPart}${formatYawSets(f.sets, f.read.rawYaw)}`;
}

/**
 * Select yaw-switched sets (`rig-c/pose#173` Part 2):
 * - A set is entered when `raw[i] >= above` for at least `switchMin` seconds,
 *   and left when `raw[i] < above - SET_HYSTERESIS_DEG` (`above - 10°`) for at
 *   least `switchMin` seconds.
 * - Between two frames of the same set separated by `< switchMin`, nothing flips (`#162`).
 */
export function selectYawSets(
  raw: readonly number[],
  declared: readonly YawSet[] | undefined,
  times: readonly number[],
  switchMin: number,
): YawSetSwitch[] {
  if (declared === undefined || declared.length === 0 || raw.length === 0) return [];
  const n = raw.length;
  const endOf = (i: number): number => (i + 1 < n ? times[i + 1]! : n > 1 ? 2 * times[i]! - times[i - 1]! : times[i]!);
  const spanSec = (lo: number, hi: number): number => endOf(hi) - times[lo]!;

  return declared.map((decl) => {
    const above = decl.above;
    const leave = r3(above - SET_HYSTERESIS_DEG);
    const active = new Array<boolean>(n).fill(false);
    let inSet = false;
    let i = 0;
    while (i < n) {
      if (!inSet) {
        if (raw[i]! >= above) {
          let j = i;
          while (j + 1 < n && raw[j + 1]! >= above) j++;
          if (spanSec(i, j) >= switchMin - 1e-9) {
            inSet = true;
            for (let k = i; k <= j; k++) active[k] = true;
          }
          i = j + 1;
        } else {
          i++;
        }
      } else {
        if (raw[i]! < leave) {
          let j = i;
          while (j + 1 < n && raw[j + 1]! < leave) j++;
          if (spanSec(i, j) >= switchMin - 1e-9) {
            inSet = false;
          } else {
            for (let k = i; k <= j; k++) active[k] = true;
          }
          i = j + 1;
        } else {
          active[i] = true;
          i++;
        }
      }
    }
    // #162: bridge any remaining gap between two spans of the same set shorter than switchMin.
    for (let k = 0; k < n;) {
      if (active[k]) {
        k++;
        continue;
      }
      let j = k;
      while (j + 1 < n && !active[j + 1]) j++;
      if (k > 0 && j + 1 < n && active[k - 1] && active[j + 1] && spanSec(k, j) < switchMin - 1e-9) {
        for (let m = k; m <= j; m++) active[m] = true;
      }
      k = j + 1;
    }
    const spans: Array<[number, number]> = [];
    for (let k = 0; k < n; k++) {
      if (!active[k]) continue;
      const last = spans[spans.length - 1];
      if (last !== undefined && last[1] === k - 1) last[1] = k;
      else spans.push([k, k]);
    }
    let swaps = 0;
    for (const [lo, hi] of spans) {
      swaps++;
      if (hi < n - 1) swaps++;
    }
    return { set: decl.set, above, leave, spans, swaps, hidesKeyed: [] };
  });
}

/** Threshold in degrees at or above which a frame is listed on `BODY` as needing a turned-body drawing (`rig-c/pose#173`). */
export const BODY_TURN_DEG = 45;

export interface BodyReading {
  /** Camera-normalised standing widths in picture pixels (at frame 0's scale). */
  standing: {
    shoulder: number;
    hip: number;
  };
  read: {
    yaw: FaceSpan;
    opening: FaceSpan;
    rawYaw: number[];
  };
  /** Inclusive `[first, last]` frame spans where `|yaw| >= BODY_TURN_DEG` (`45°`). */
  over45: Array<[number, number]>;
  /** Frame indices where `|yaw| >= BODY_TURN_DEG` (`45°`). */
  framesOver45: number[];
  /** Present when the map declares `body.yaw`. */
  yaw?: FaceAxisReading;
  /** Present when the map declares `body.sets` or `body.yaw.sets`. */
  sets?: YawSetSwitch[];
}

/**
 * Read per-frame body yaw (degrees) from camera-normalised shoulder width
 * (`r_shoulder`, `l_shoulder`) and hip width (`r_hip`, `l_hip`), projected
 * perpendicular to the trunk (`mid_hip → neck`) so raising one shoulder or
 * tilting the torso in 2D roll does not distort the horizontal torso width,
 * against the sequence's standing width (`yaw ≈ acos(w / w_standing)`,
 * `rig-c/pose#173`).
 *
 * Sign convention (matching `readFaceAngles`):
 * - `yaw > 0`: torso turned toward the subject's right (viewer-left, left shoulder nearer).
 * - `yaw < 0`: torso turned toward the subject's left (viewer-right, right shoulder nearer).
 */
export function readBodyYaw(
  rShoulder: readonly Pt[],
  lShoulder: readonly Pt[],
  rHip: readonly Pt[] | null,
  lHip: readonly Pt[] | null,
  neck: readonly Pt[] | null,
  scale: readonly number[] | null,
  faceYaw: readonly number[] | null,
): { standing: { shoulder: number; hip: number }; yaw: number[] } {
  const n = rShoulder.length;
  const hasHips = rHip !== null && lHip !== null && rHip.length === n && lHip.length === n;
  const wSh: number[] = [];
  const wHip: number[] = [];
  const signs: number[] = [];
  const revSh: boolean[] = [];

  for (let i = 0; i < n; i++) {
    const rS = rShoulder[i]!;
    const lS = lShoulder[i]!;
    const s = scale !== null && scale[i] !== undefined && scale[i]! > 1e-6 ? scale[i]! : 1;
    const mS: Pt = [0.5 * (rS[0] + lS[0]), 0.5 * (rS[1] + lS[1])];
    const mH: Pt = hasHips ? [0.5 * (rHip[i]![0] + lHip[i]![0]), 0.5 * (rHip[i]![1] + lHip[i]![1])] : [mS[0], mS[1] + 100];
    const top: Pt = neck !== null && neck[i] !== undefined ? neck[i]! : mS;
    const tx = top[0] - mH[0];
    const ty = top[1] - mH[1];
    const tl = Math.hypot(tx, ty);
    const nx = tl > 1e-6 ? -ty / tl : 1;
    const ny = tl > 1e-6 ? tx / tl : 0;

    const projSh = ((lS[0] - rS[0]) * nx + (lS[1] - rS[1]) * ny) / s;
    const absSh = Math.abs(projSh);
    wSh.push(absSh);
    revSh.push(projSh < -1e-6);

    if (hasHips) {
      const rH = rHip[i]!;
      const lH = lHip[i]!;
      const projHip = ((lH[0] - rH[0]) * nx + (lH[1] - rH[1]) * ny) / s;
      wHip.push(Math.abs(projHip));
    } else {
      wHip.push(absSh);
    }

    const neckOff = neck !== null && neck[i] !== undefined ? ((mS[0] - neck[i]![0]) * nx + (mS[1] - neck[i]![1]) * ny) / s : 0;
    const fy = faceYaw !== null && faceYaw[i] !== undefined ? faceYaw[i]! : 0;
    let sign = 1;
    if (Math.abs(neckOff) > 0.05 * Math.max(1, absSh)) sign = neckOff >= 0 ? 1 : -1;
    else if (Math.abs(fy) > 0.5) sign = fy >= 0 ? 1 : -1;
    else {
      const shear = (mS[0] - mH[0]) * nx + (mS[1] - mH[1]) * ny;
      if (Math.abs(shear) > 1e-6) sign = shear >= 0 ? 1 : -1;
      else if (i > 0) sign = signs[i - 1]!;
    }
    signs.push(sign);
  }

  const openN = Math.min(n, 48);
  const sh0 = Math.max(1e-6, Math.min(median(wSh.slice(0, openN)), median(wSh)));
  const hip0 = Math.max(1e-6, Math.min(median(wHip.slice(0, openN)), median(wHip)));

  const yaw: number[] = [];
  for (let i = 0; i < n; i++) {
    if (revSh[i]) {
      yaw.push(signs[i]! * 90);
      continue;
    }
    const rS = Math.min(1, wSh[i]! / sh0);
    const rH = hasHips ? Math.min(1, wHip[i]! / hip0) : rS;
    const mx = Math.min(Math.max(rS, rH), rS / 0.65);
    const mn = Math.min(rS, rH);
    const alpha = Math.max(0, Math.min(1, (mx - 0.85) / 0.1));
    const w = Math.max(0, Math.min(1, alpha * Math.max(rS, rH) + (1 - alpha) * mn));
    const mag = Math.acos(w) * DEG;
    yaw.push(mag < 1e-6 ? 0 : signs[i]! * mag);
  }

  return {
    standing: { shoulder: r3(sh0), hip: r3(hasHips ? hip0 : 0) },
    yaw,
  };
}

export function readBody(
  body: BodyMap | undefined,
  rShoulder: readonly Pt[],
  lShoulder: readonly Pt[],
  rHip: readonly Pt[] | null,
  lHip: readonly Pt[] | null,
  neck: readonly Pt[] | null,
  scale: readonly number[] | null,
  faceYaw: readonly number[] | null,
): BodyReading {
  const { standing, yaw } = readBodyYaw(rShoulder, lShoulder, rHip, lHip, neck, scale, faceYaw);
  const openN = Math.min(yaw.length, 48);
  const framesOver45: number[] = [];
  const over45: Array<[number, number]> = [];
  for (let i = 0; i < yaw.length; i++) {
    if (Math.abs(yaw[i]!) >= BODY_TURN_DEG) {
      framesOver45.push(i);
      const last = over45[over45.length - 1];
      if (last !== undefined && last[1] === i - 1) last[1] = i;
      else over45.push([i, i]);
    }
  }
  return {
    standing,
    read: {
      yaw: spanOf(yaw),
      opening: spanOf(yaw.slice(0, openN)),
      rawYaw: yaw.map(r3),
    },
    over45,
    framesOver45,
    ...(body?.yaw === undefined ? {} : { yaw: mapFaceAxis(yaw, body.yaw) }),
  };
}

export function bodyLine(b: BodyReading): string {
  const openEnd = Math.min(b.read.rawYaw.length, 48) - 1;
  const openAbs = Math.max(Math.abs(b.read.opening.min), Math.abs(b.read.opening.max));
  const spans = b.over45.map(([lo, hi]) => {
    const slice = b.read.rawYaw.slice(lo, hi + 1);
    const sMin = Math.min(...slice);
    const sMax = Math.max(...slice);
    const where = lo === hi ? `frame ${lo}` : `frames ${lo}–${hi}`;
    return `${where} (${lo === hi ? `${sg(sMax)}°` : `${sg(sMin)}° … ${sg(sMax)}°`})`;
  });
  const overPart = b.framesOver45.length === 0
    ? `≥ ${BODY_TURN_DEG}°: none`
    : `≥ ${BODY_TURN_DEG}° on ${b.framesOver45.length} frame(s): ${spans.join(', ')}`;
  const head = `r_shoulder + l_shoulder, r_hip + l_hip (standing shoulder ${b.standing.shoulder.toFixed(1)}px, hip ${b.standing.hip.toFixed(1)}px): read yaw ${sg(b.read.yaw.min)}° … ${sg(b.read.yaw.max)}° (${f1(b.read.yaw.range)}°), opening (frames 0–${openEnd}) ${sg(b.read.opening.min)}° … ${sg(b.read.opening.max)}° (max |yaw| ${f1(openAbs)}°); ${overPart}`;
  const mappedPart = b.yaw === undefined
    ? ''
    : `; mapped yaw → bone "${b.yaw.bone}" [${b.yaw.limits[0]}, ${b.yaw.limits[1]}]° (knee [${b.yaw.knee[0]}, ${b.yaw.knee[1]}]°): ${sg(b.yaw.mapped.min)}° … ${sg(b.yaw.mapped.max)}° (scale ${b.yaw.scale[0].toFixed(3)}/${b.yaw.scale[1].toFixed(3)}, r=${b.yaw.corr.toFixed(3)})`;
  return `${head}${mappedPart}${formatYawSets(b.sets, b.read.rawYaw)}`;
}

