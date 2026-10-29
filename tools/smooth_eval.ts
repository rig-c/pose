/**
 * The smoothing measurement for rig-c/pose#8 (round 1) and rig-c/pose#11
 * (round 2; re-run with the flip guard for #15): which filter, and at which
 * window, takes the jitter out of the rig without moving the motion in time or
 * clipping its peaks. Not shipped.
 *
 *   bun tools/smooth_eval.ts --rig <rig dir> --map <map.json> --pose <pose.json> --out <dir> \
 *     [--points "sleeve_r1:tip,sleeve_l1:tip,leg_r1:tip,leg_l1:tip,hip"] [--min-score 0.3] \
 *     [-- <extra retarget flags>]
 *   bun tools/smooth_eval.ts --self-check    (the band-power check alone; it also runs before every measurement)
 *
 * The criteria are the cards', written before each round ran (the
 * sub-commander's comments on #8 and #11), and are not tuned here:
 *
 * - Candidates: Savitzky–Golay (the package's `--smooth`) at 5, 7, 9 and 11
 *   frames; a centred moving average over 5 frames; a One Euro filter (causal;
 *   min cutoff 1.0 Hz, β 0.007, d-cutoff 1.0 Hz). The baseline is `--smooth 1`.
 *   The moving average and One Euro are applied here to the joint positions
 *   after the package's holds (score under --min-score, or missing, holds the
 *   last good value; before the first good one, that one), written as a
 *   pre-smoothed pose, and retargeted with `--smooth 1`. They are measured for
 *   the record only.
 * - Measured on the rig: each run's gated build (`--build`) is posed by rig-c's
 *   poser at every key frame; the points are --points (rig points, `name:tip`
 *   the end of a bone). Units: reference shoulder widths, rig units ÷ (scale ×
 *   the pose's median |r_shoulder − l_shoulder| px).
 * - 1. Jitter (round 2, #11, the criterion): per point and per axis, remove the
 *   mean and the linear trend (a least-squares line), apply a Hann window
 *   (symmetric, 0.5 − 0.5·cos(2πi/(N−1))), zero-pad to 512 and take the FFT at
 *   24 fps; sum |X(f)|² over 6 Hz ≤ f ≤ 12 Hz (bins 128…256). A point's jitter
 *   is x's sum plus y's; it must drop ≥ 2× against the baseline on every point.
 *   Round 1's jitter (#8), the median |second difference|, is kept beside it
 *   and is no longer a criterion: on the hip it is mostly real motion.
 *   2. Timing: the speed series' normalised cross-correlation against the
 *   baseline's, over lags −12…+12, peaks at 0 on every point. 3. Peaks: each
 *   point's 95th-percentile speed stays ≥ 0.85× the baseline's.
 * - The choice: the smallest Savitzky–Golay window that meets all three.
 *
 * Writes into --out: one directory per candidate (motion.json, report.json,
 * run.txt, build/, and pose.json for the pre-smoothed ones), smooth_eval.json
 * and smooth_eval.md (the band-power check, the table, the choice, every
 * rejection and its reason).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readModel } from '@rig-c/core/core';
import { BODY18, type Body18 } from '../src/joints.ts';
import { pointAt } from '../src/map.ts';
import { personTrack, POSE_SPEC, POSE_SPACE, readPoseSequence, writePoseSequence, type Joint, type PoseSequence } from '../src/pose.ts';
import { pointOn } from '../src/retarget.ts';
import { poseFrames } from '../src/verify.ts';

type Pt = [number, number];
const ROOT = resolve(import.meta.dir, '..');

// --- round 2's jitter: power from 6 Hz to Nyquist ---------------------------------

const FPS = 24;
const NFFT = 512;
const BAND_LO_HZ = 6;
const BAND_HI_HZ = 12;

/** |X(k)|², k = 0…nfft/2, of xs zero-padded to nfft (a power of two): an iterative radix-2 FFT. */
function powerSpectrum(xs: readonly number[], nfft: number): number[] {
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  xs.forEach((v, i) => (re[i] = v));
  for (let i = 1, j = 0; i < nfft; i++) {
    let bit = nfft >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= nfft; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < nfft; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + half;
        const vr = re[b]! * wr - im[b]! * wi;
        const vi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - vr;
        im[b] = im[a]! - vi;
        re[a] = re[a]! + vr;
        im[a] = im[a]! + vi;
      }
    }
  }
  return Array.from({ length: (nfft >> 1) + 1 }, (_, k) => re[k]! ** 2 + im[k]! ** 2);
}

/** The series less its mean and its least-squares linear trend, times a symmetric Hann window. */
function detrendedHann(xs: readonly number[]): number[] {
  const n = xs.length;
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  const tc = (n - 1) / 2;
  let sxy = 0;
  let sxx = 0;
  xs.forEach((v, i) => {
    sxy += (i - tc) * (v - mean);
    sxx += (i - tc) ** 2;
  });
  const slope = sxx > 0 ? sxy / sxx : 0;
  return xs.map((v, i) => (v - mean - slope * (i - tc)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
}

/** Σ|X(f)|² over lo ≤ f ≤ hi Hz, of the detrended, Hann-windowed series zero-padded to NFFT at FPS. */
function bandPower(xs: readonly number[], lo = BAND_LO_HZ, hi = BAND_HI_HZ): number {
  if (xs.length > NFFT) throw new Error(`smooth_eval.ts: ${xs.length} frames do not fit the ${NFFT}-point FFT the criterion fixes`);
  const p = powerSpectrum(detrendedHann(xs), NFFT);
  let s = 0;
  // f_k = k·FPS/NFFT; compared in integers so the 6 Hz edge (k = 128) is exact.
  p.forEach((v, k) => {
    if (k * FPS >= lo * NFFT && k * FPS <= hi * NFFT) s += v;
  });
  return s;
}

/**
 * The band power's correctness check, run before every measurement: the FFT
 * against a direct DFT; a pure 8 Hz sine's power in band, a 2 Hz sine's out of
 * it; a line has none (the trend is removed); white noise puts about half in
 * the band (6–12 Hz is half of 0–12 Hz). Each line is its figure and its bound.
 */
function selfCheck(n: number): { lines: string[]; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  const check = (what: string, value: number, pass: boolean, bound: string) => {
    lines.push(`${pass ? 'ok  ' : 'FAIL'} ${what}: ${value.toExponential(3)} (${bound})`);
    if (!pass) ok = false;
  };
  const sine = (hz: number) => Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / FPS + 0.3));
  const total = (xs: number[]) => powerSpectrum(detrendedHann(xs), NFFT).reduce((s, v) => s + v, 0);
  // The FFT against the DFT, on a signal with every kind of content.
  const probe = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + 0.01 * i);
  const fft = powerSpectrum(probe, NFFT);
  let worst = 0;
  for (let k = 0; k <= NFFT >> 1; k++) {
    let r = 0;
    let m = 0;
    probe.forEach((v, i) => {
      r += v * Math.cos((2 * Math.PI * k * i) / NFFT);
      m -= v * Math.sin((2 * Math.PI * k * i) / NFFT);
    });
    worst = Math.max(worst, Math.abs(fft[k]! - (r * r + m * m)) / Math.max(1, r * r + m * m));
  }
  check('FFT vs direct DFT, worst relative error over bins 0…256', worst, worst < 1e-9, '< 1e-9');
  const s8 = sine(8);
  check('8 Hz sine, share of its power in 6–12 Hz', bandPower(s8) / total(s8), bandPower(s8) / total(s8) > 0.999, '> 0.999');
  const s2 = sine(2);
  check('2 Hz sine, share of its power in 6–12 Hz', bandPower(s2) / total(s2), bandPower(s2) / total(s2) < 1e-6, '< 1e-6');
  const s5 = sine(5.5);
  check('5.5 Hz sine (just under the edge), share in 6–12 Hz', bandPower(s5) / total(s5), bandPower(s5) / total(s5) < 0.01, '< 0.01');
  const line = Array.from({ length: n }, (_, i) => 3 - 0.02 * i);
  check('a line (mean and trend only), band power', bandPower(line), bandPower(line) < 1e-20, '< 1e-20');
  let x = 11;
  const white = Array.from({ length: n }, () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return (x / 2 ** 32) * 2 - 1;
  });
  const share = bandPower(white) / total(white);
  check('uniform white noise, share of its power in 6–12 Hz', share, share > 0.4 && share < 0.6, 'in (0.4, 0.6)');
  return { lines, ok };
}

if (process.argv.includes('--self-check')) {
  const c = selfCheck(313);
  process.stdout.write(`${c.lines.join('\n')}\n`);
  process.exit(c.ok ? 0 : 1);
}

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const own = dash < 0 ? argv : argv.slice(0, dash);
const extra = dash < 0 ? [] : argv.slice(dash + 1);
function flag(name: string, dflt?: string): string {
  const i = own.indexOf(`--${name}`);
  const v = i >= 0 ? own[i + 1] : dflt;
  if (v === undefined) {
    process.stderr.write(`smooth_eval.ts: --${name} is required\n`);
    process.exit(2);
  }
  return v;
}
const rig = flag('rig');
const mapPath = flag('map');
const posePath = flag('pose');
const out = resolve(flag('out'));
const minScore = Number(flag('min-score', '0.3'));
const points = flag('points', 'sleeve_r1:tip,sleeve_l1:tip,leg_r1:tip,leg_l1:tip,hip').split(',');
const LAGS = 12;
const ANIM = 'dance';

const seq = readPoseSequence(readFileSync(posePath, 'utf8'), posePath);
const track = personTrack(seq, undefined, posePath);
const times = seq.frames.map((f) => f.t);
const n = times.length;
const check = selfCheck(n);
process.stdout.write(`band-power check (${n} frames):\n${check.lines.map((l) => `  ${l}`).join('\n')}\n`);
if (!check.ok) {
  process.stderr.write('smooth_eval.ts: the band-power check failed; nothing measured\n');
  process.exit(1);
}

// --- the filters this tool applies itself -------------------------------------

/** Each joint's positions with the package's holds; null for a joint good on no frame. */
function held(name: Body18): Pt[] | null {
  const raw = track.map((j) => pointOn(j, name, minScore));
  const first = raw.findIndex((v) => typeof v !== 'string');
  if (first < 0) return null;
  let last = raw[first] as Pt;
  return raw.map((v) => {
    if (typeof v !== 'string') last = v;
    return [last[0], last[1]];
  });
}

/** A centred moving average, the window clipped at the ends (the package's filter before #8). */
function movingAverage(xs: Pt[], window: number): Pt[] {
  const h = window >> 1;
  return xs.map((_, i) => {
    let sx = 0;
    let sy = 0;
    let k = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(xs.length - 1, i + h); j++) {
      sx += xs[j]![0];
      sy += xs[j]![1];
      k++;
    }
    return [sx / k, sy / k];
  });
}

/**
 * The One Euro filter (Casiez, Roussel, Vogel, CHI 2012), per coordinate, as
 * its authors' reference implementation runs it: the derivative is taken
 * against the last filtered value and low-passed at d-cutoff; the cutoff is
 * min cutoff + β·|that derivative|; α = 1 / (1 + τ/Tₑ), τ = 1 / (2π·cutoff),
 * Tₑ the frame's time step.
 */
function oneEuro(xs: Pt[], ts: number[], minCutoff: number, beta: number, dCutoff: number): Pt[] {
  const alpha = (cutoff: number, te: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / te);
  const one = (vs: number[]): number[] => {
    const outv: number[] = [];
    let x = vs[0]!;
    let dx = 0;
    outv.push(x);
    for (let i = 1; i < vs.length; i++) {
      const te = ts[i]! - ts[i - 1]!;
      const d = (vs[i]! - x) / te;
      const ad = alpha(dCutoff, te);
      dx = ad * d + (1 - ad) * dx;
      const a = alpha(minCutoff + beta * Math.abs(dx), te);
      x = a * vs[i]! + (1 - a) * x;
      outv.push(x);
    }
    return outv;
  };
  const fx = one(xs.map((p) => p[0]));
  const fy = one(xs.map((p) => p[1]));
  return fx.map((x, i) => [x, fy[i]!]);
}

/** The pose with every joint replaced by its held, filtered positions (score 1, so nothing holds again). */
function preSmoothed(filter: (xs: Pt[]) => Pt[], source: string): PoseSequence {
  const series = new Map<Body18, Pt[]>();
  for (const name of BODY18) {
    const h = held(name);
    if (h !== null) series.set(name, filter(h));
  }
  return {
    spec: POSE_SPEC,
    space: POSE_SPACE,
    width: seq.width,
    height: seq.height,
    source: `${seq.source}; ${source} (tools/smooth_eval.ts, after holds at min-score ${minScore})`,
    frames: seq.frames.map((f, i) => {
      const joints: Partial<Record<Body18, Joint>> = {};
      for (const name of BODY18) {
        const s = series.get(name);
        joints[name] = s === undefined ? { state: 'missing' } : { state: 'observed', at: s[i]!, score: 1 };
      }
      return { t: f.t, people: [{ id: 'a', joints }] };
    }),
  };
}

// --- the runs -------------------------------------------------------------------

interface Candidate {
  name: string;
  label: string;
  kind: 'baseline' | 'sg' | 'ma' | 'oneeuro';
  smooth: number;
  pose?: PoseSequence;
}
const candidates: Candidate[] = [
  { name: 'baseline', label: 'none (--smooth 1)', kind: 'baseline', smooth: 1 },
  { name: 'sg5', label: 'Savitzky–Golay 5', kind: 'sg', smooth: 5 },
  { name: 'sg7', label: 'Savitzky–Golay 7', kind: 'sg', smooth: 7 },
  { name: 'sg9', label: 'Savitzky–Golay 9', kind: 'sg', smooth: 9 },
  { name: 'sg11', label: 'Savitzky–Golay 11', kind: 'sg', smooth: 11 },
  { name: 'ma5', label: 'moving average 5', kind: 'ma', smooth: 1, pose: preSmoothed((xs) => movingAverage(xs, 5), 'centred moving average over 5 frames') },
  { name: 'oneeuro', label: 'One Euro (1.0 Hz, β 0.007, d 1.0 Hz)', kind: 'oneeuro', smooth: 1, pose: preSmoothed((xs) => oneEuro(xs, times, 1.0, 0.007, 1.0), 'One Euro, min cutoff 1.0 Hz, beta 0.007, d-cutoff 1.0 Hz') },
];

interface Report {
  scale: { factor: number };
  /** Absent before rig-c/pose#15. */
  options: { flip?: number | 'off' };
}

const series = new Map<string, Map<string, Pt[]>>();
let scaleFactor = 0;
/** The flip guard the runs had (#15): the baseline's, from its report; every run takes the same extra flags. */
let flip: number | 'off' | undefined;
mkdirSync(out, { recursive: true });
for (const c of candidates) {
  const dir = join(out, c.name);
  mkdirSync(dir, { recursive: true });
  let pose = posePath;
  if (c.pose !== undefined) {
    pose = join(dir, 'pose.json');
    writeFileSync(pose, writePoseSequence(c.pose));
  }
  const args = ['retarget', '--rig', rig, '--map', mapPath, '--pose', pose, '--out', join(dir, 'motion.json'), '--name', ANIM, '--build', join(dir, 'build'), '--report', join(dir, 'report.json'), '--smooth', String(c.smooth), ...extra];
  const r = spawnSync(process.execPath, [join(ROOT, 'cli.ts'), ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(join(dir, 'run.txt'), `${r.stdout}${r.stderr}`);
  if (r.status !== 0) {
    process.stderr.write(`smooth_eval.ts: ${c.name} exit ${r.status}; see ${join(dir, 'run.txt')}\n`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
  if (c.kind === 'baseline') {
    scaleFactor = report.scale.factor;
    flip = report.options.flip;
  }
  const path = join(dir, 'build', 'skeleton.model.json');
  const doc = readModel(readFileSync(path, 'utf8'), path);
  const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
  const keyTimes = times.map((t) => Math.round((t - times[0]!) * 1e6) / 1e6);
  const posed = poseFrames(doc, ANIM, keyTimes);
  const m = new Map<string, Pt[]>();
  for (const p of points) m.set(p, posed.map((b) => pointAt(b, lengths, p)!));
  series.set(c.name, m);
  process.stdout.write(`  ran ${c.name} (${c.label})\n`);
}

// --- the measures ---------------------------------------------------------------

const widths: number[] = [];
track.forEach((j) => {
  const r = pointOn(j, 'r_shoulder', minScore);
  const l = pointOn(j, 'l_shoulder', minScore);
  if (typeof r !== 'string' && typeof l !== 'string') widths.push(Math.hypot(l[0] - r[0], l[1] - r[1]));
});
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const percentile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * q;
  const lo = Math.floor(k);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (k - lo);
};
const swPx = median(widths);
const sw = scaleFactor * swPx;

/** Round 2's jitter (#11): x's band power plus y's, in sw². */
const hfPower = (xs: Pt[]): number => bandPower(xs.map((p) => p[0] / sw)) + bandPower(xs.map((p) => p[1] / sw));
/** Round 1's jitter (#8), kept for the record: the median |second difference|, in sw/frame². */
const jitter = (xs: Pt[]): number => median(xs.slice(1, -1).map((p, i) => Math.hypot(xs[i + 2]![0] - 2 * p[0] + xs[i]![0], xs[i + 2]![1] - 2 * p[1] + xs[i]![1]))) / sw;
const speed = (xs: Pt[]): number[] => xs.slice(1).map((p, i) => Math.hypot(p[0] - xs[i]![0], p[1] - xs[i]![1]) / sw);
/** The lag (frames) at which the normalised cross-correlation of b against a peaks: b[i + lag] ~ a[i]. */
function peakLag(a: number[], b: number[]): { lag: number; r: number } {
  let best = { lag: 0, r: -Infinity };
  for (let lag = -LAGS; lag <= LAGS; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      xs.push(a[i]!);
      ys.push(b[j]!);
    }
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i]! - mx) * (ys[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
      syy += (ys[i]! - my) ** 2;
    }
    const r = sxy / Math.sqrt(sxx * syy);
    if (r > best.r) best = { lag, r };
  }
  return best;
}

interface Row {
  point: string;
  hf: number;
  hfDrop: number;
  jitter: number;
  jitterDrop: number;
  lag: number;
  r: number;
  p95: number;
  p95Ratio: number;
}
const base = series.get('baseline')!;
const results = candidates.map((c) => {
  const s = series.get(c.name)!;
  const rows: Row[] = points.map((p) => {
    const b = base.get(p)!;
    const x = s.get(p)!;
    const hf = hfPower(x);
    const j = jitter(x);
    const lag = peakLag(speed(b), speed(x));
    const p95 = percentile(speed(x), 0.95);
    return { point: p, hf, hfDrop: hfPower(b) / hf, jitter: j, jitterDrop: jitter(b) / j, lag: lag.lag, r: lag.r, p95, p95Ratio: p95 / percentile(speed(b), 0.95) };
  });
  const failed: string[] = [];
  let round1: string | null = null;
  if (c.kind !== 'baseline') {
    const h = rows.filter((r) => !(r.hfDrop >= 2));
    if (h.length > 0) failed.push(`1 jitter: the power in 6–12 Hz drops under 2× on ${h.map((r) => `${r.point} (${r.hfDrop.toFixed(2)}×)`).join(', ')}`);
    const t = rows.filter((r) => r.lag !== 0);
    if (t.length > 0) failed.push(`2 timing: the speed cross-correlation peaks off 0 on ${t.map((r) => `${r.point} (${r.lag > 0 ? '+' : ''}${r.lag} frames)`).join(', ')}`);
    const q = rows.filter((r) => !(r.p95Ratio >= 0.85));
    if (q.length > 0) failed.push(`3 peaks: p95 speed under 0.85× on ${q.map((r) => `${r.point} (${r.p95Ratio.toFixed(3)}×)`).join(', ')}`);
    const j = rows.filter((r) => !(r.jitterDrop >= 2));
    round1 = j.length === 0 ? 'met' : `under 2× on ${j.map((r) => `${r.point} (${r.jitterDrop.toFixed(2)}×)`).join(', ')}`;
  }
  return { name: c.name, label: c.label, kind: c.kind, rows, failed, round1Jitter: round1 };
});

const chosen = results.find((r) => r.kind === 'sg' && r.failed.length === 0) ?? null;

const f = (x: number, d = 3) => x.toFixed(d);
const md: string[] = [];
md.push(`# Smoothing, measured on the rig (rig-c/pose#11, round 2; round 1 was #8)`, '');
md.push(`Pose: ${posePath} (${n} frames). Rig: ${rig}. Map: ${mapPath}. Extra flags: ${extra.join(' ') || '(none)'}. Flip guard (#15): ${flip === undefined ? 'none (before #15)' : flip === 'off' ? 'off' : `on, ${flip}°`}, the baseline included.`);
md.push(`Units: reference shoulder widths, 1 sw = scale ${f(scaleFactor, 5)} × median shoulder width ${f(swPx, 1)} px = ${f(sw, 2)} rig units.`, '');
md.push(`Band power: per axis, mean and least-squares trend removed, symmetric Hann window, ${NFFT}-point FFT at ${FPS} fps, Σ|X(f)|² over ${BAND_LO_HZ} Hz ≤ f ≤ ${BAND_HI_HZ} Hz; a point's figure is x's plus y's. Its check, run before this measurement:`, '');
for (const l of check.lines) md.push(`    ${l}`);
md.push('');
md.push('Criterion 1 is the band power (round 2). Round 1\'s median |second difference| is beside it for the record; it is not a criterion here.', '');
md.push('| candidate | point | power 6–12 Hz (sw²) | drop vs baseline | round 1: median \\|Δ²\\| (sw/frame²) | round 1 drop | xcorr peak lag (r) | p95 speed (sw/frame) | p95 vs baseline |');
md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  const b = r.kind === 'baseline';
  for (const row of r.rows) md.push(`| ${r.label} | ${row.point} | ${row.hf.toExponential(3)} | ${b ? '—' : `${f(row.hfDrop, 2)}×`} | ${f(row.jitter, 4)} | ${b ? '—' : `${f(row.jitterDrop, 2)}×`} | ${b ? '—' : `${row.lag} (${f(row.r, 3)})`} | ${f(row.p95, 4)} | ${b ? '—' : `${f(row.p95Ratio, 3)}×`} |`);
}
md.push('');
md.push(`**Chosen:** ${chosen === null ? 'none — no Savitzky–Golay window meets all three criteria' : `${chosen.label} (\`--smooth ${chosen.name.slice(2)}\`), the smallest window that meets all three`}.`, '');
for (const r of results) {
  if (r.kind === 'baseline') continue;
  const record = r.kind === 'sg' ? '' : ' (for the record only)';
  md.push(`- ${r.label}${record}: ${r.failed.length === 0 ? 'meets all three' : `fails ${r.failed.join('; ')}`}${r === chosen ? ' — chosen' : r.kind === 'sg' && r.failed.length === 0 ? ' — meets all three, but a smaller window does too' : ''}. Round 1's jitter criterion: ${r.round1Jitter}.`);
}
writeFileSync(join(out, 'smooth_eval.md'), `${md.join('\n')}\n`);
writeFileSync(join(out, 'smooth_eval.json'), `${JSON.stringify({ pose: posePath, rig, map: mapPath, extra, flip: flip ?? null, frames: n, scale: scaleFactor, shoulderWidthPx: swPx, swUnits: sw, band: { fps: FPS, nfft: NFFT, loHz: BAND_LO_HZ, hiHz: BAND_HI_HZ, window: 'hann-symmetric', detrend: 'mean+linear', check: check.lines }, points, results, chosen: chosen?.name ?? null }, null, 2)}\n`);
process.stdout.write(`${md.join('\n')}\n`);
