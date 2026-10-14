/**
 * `rig-pose clean` (rig-c/pose#67): the sequence-cleaning step every sequence
 * passes through before `retarget`. A pose model reads each frame alone, so a
 * hanging wrist moves ±20 px a frame and a cloak-hidden leg jumps 100+ px; this
 * removes that once, at the sequence, where others can inspect the result.
 *
 * Four steps, in this order, each on one person's joints:
 *
 * 1. **Spikes.** A joint more than `SPIKE_TRUNKS` (0.2) trunk lengths from its
 *    `SPIKE_WINDOW`-frame (5) median takes the median. The trunk is neck →
 *    mid_hip (the hips' midpoint), the median of its picture length over the
 *    frames where all three have a position. Every replacement is listed by
 *    frame and joint. Without `loop`, a frame whose window a clip end cuts
 *    (the first and last two) is not tested, and is listed as untested: on a
 *    cut window the median is a neighbour's value, so a joint moving steadily
 *    would read as a spike there. Reflecting the window at the end does not
 *    help — the median of [x2, x1, x0, x1, x2] is still x1.
 * 2. **Occlusion.** A joint whose state is not `observed`, or whose score is
 *    under `OCCLUSION_SCORE` (0.3), takes its `OCCLUSION_WINDOW`-frame (3)
 *    median.
 * 3. **Smoothing.** A quadratic Savitzky–Golay per joint: the legs (`LEGS`:
 *    both hips, knees and ankles) over `legs` frames, every other joint over
 *    `rest`. A window of 1 is none.
 * 4. **Floor.** With `loop` only: the whole figure is moved in y by one
 *    constant, so the lowest ankle over the cycle (the largest y of either
 *    ankle on any frame) is at its height before smoothing.
 *
 * What a median is here: per coordinate (x and y apart), over the frames of the
 * window on which the joint has a position — its own frame included, any state.
 * An even count takes the mean of the middle two. The windows are centred; with
 * `loop` they wrap (the sequence is one cycle, its last frame followed by its
 * first), without it they are cut at the ends. The medians read the step's
 * input, never a value the same step already replaced.
 *
 * What is never invented: a joint with no position on a frame (`missing`, or a
 * frame the person is absent from) gets none here. It has nothing to take a
 * median of on its own frame, and a value made from its neighbours would be a
 * guess; `retarget` holds it, and says so with a HOLD line. A joint's state and
 * score are the detector's and are written as they were read: this step moves
 * positions only — with one stated exception, `hipsInferred` below.
 *
 * `hipsInferred` (rig-c/pose#63, `--hips-inferred`): after the four steps, r_hip
 * and l_hip are marked `inferred` on every frame where they have a position,
 * and the record says who said so (`{ by: 'declared' }`, the person running
 * clean). Positions and scores are not touched by it, so retarget's keys are
 * the same with and without it; what changes is POSTURE, which does not read a
 * hip tilt off inferred hips. The occlusion step reads `inferred` as it reads
 * `observed`: a cleaned file cleaned again moves its hips the same way.
 *
 * The smoothing fits the frames of the window where the joint has a position;
 * where fewer than three are there, the polynomial's degree drops to fit the
 * ones that are (two give a line, one returns the frame's own value).
 *
 * Jitter, the step's figure, is the mean |second difference| of y, in px/f²,
 * over every joint and every three consecutive frames on which it has a
 * position (wrapping with `loop`), before (the sequence as read) and after
 * (the cleaned positions, before the writer rounds them to 0.01 px).
 *
 * Pure: no clock, no randomness, no disk.
 */
import { BODY18, type Body18 } from './joints.ts';
import type { CleanRecord, CleanSpike, Joint, PoseSequence } from './pose.ts';
import { CLEAN_SPEC, personTrack, sortedJoints } from './pose.ts';
import { Problems } from './problems.ts';

/** A spike is a joint this many trunk lengths or more from its median. */
export const SPIKE_TRUNKS = 0.2;
/** The spike median's window, in frames. */
export const SPIKE_WINDOW = 5;
/** The occlusion median's window, in frames. */
export const OCCLUSION_WINDOW = 3;
/** A joint scored under this is treated as occluded. */
export const OCCLUSION_SCORE = 0.3;
/** The joints smoothed over `legs`; every other joint is smoothed over `rest`. */
export const LEGS: readonly Body18[] = ['r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle'];
/** The polynomial's degree. */
const ORDER = 2;

export interface CleanParams {
  /** The sequence is one cycle: every window wraps, and the floor is re-pinned. */
  loop: boolean;
  /** Savitzky–Golay window over the legs, frames: 1 (none), or odd and ≥ 5. */
  legs: number;
  /** Savitzky–Golay window over every other joint, frames: 1 (none), or odd and ≥ 5. */
  rest: number;
  /** Mark r_hip and l_hip `inferred` wherever they have a position (#63): the person running clean declares it. */
  hipsInferred?: boolean;
}

/** The joints `--hips-inferred` marks. */
export const HIPS: readonly Body18[] = ['r_hip', 'l_hip'];

export type Pt = [number, number];
/** One joint's positions over the frames; null where it has none. */
export type Series = Array<Pt | null>;

export interface SpikeFound extends CleanSpike {
  /** Its distance from the median, px. */
  off: number;
}
export interface Occluded {
  joint: Body18;
  frame: number;
  /** How far the median moved it, px. */
  moved: number;
  why: string;
}
export interface Floor {
  /** The lowest ankle's y before smoothing, and after, px. */
  before: number;
  after: number;
  /** The y every joint was moved by, px. */
  shift: number;
}

export interface Cleaned {
  seq: PoseSequence;
  record: CleanRecord;
  person: string;
  /** Neck → mid_hip, the median picture length, px, and over how many frames. */
  trunk: { length: number; frames: number };
  spikes: SpikeFound[];
  occluded: Occluded[];
  /** Joints without a position on some frames, as runs: left without one. */
  missing: Array<{ joint: Body18; from: number; to: number }>;
  /** The frames the spike step did not test (a clip end cuts their window). */
  untested: number[];
  /** With loop, where an ankle exists; else null. */
  floor: Floor | null;
  /** How many (joint, three-frame) runs the jitter was read over: before, after. */
  triples: number;
  /** With `hipsInferred`: how many joint-frames were marked `inferred`, per hip. */
  inferred: { r_hip: number; l_hip: number } | null;
}

/**
 * The windows `clean` accepts: 1, or odd and ≥ 5. A window of 3 is refused:
 * a quadratic fitted through 3 points passes through all three, so it would
 * change nothing (and at the ends the window cut to 2 frames is a line through
 * both). An even window has no centre frame.
 */
export function windowProblem(flag: string, n: number): string | null {
  if (!Number.isInteger(n) || n < 1) return `${flag} is "${n}"; it must be 1 (none) or an odd whole number ≥ 5`;
  if (n === 3) return `${flag} is "3"; a quadratic fitted through 3 points passes through all three, so a window of 3 changes nothing — it must be 1 (none) or an odd whole number ≥ 5`;
  if (n % 2 === 0) return `${flag} is "${n}"; an even window has no centre frame — it must be 1 (none) or an odd whole number ≥ 5`;
  return null;
}

/** The frame offsets of a centred window at frame i over n frames: wrapped with loop, cut at the ends without. */
function windowAt(i: number, n: number, size: number, loop: boolean): number[] {
  const h = size >> 1;
  const out: number[] = [];
  for (let u = -h; u <= h; u++) {
    const j = i + u;
    if (loop) out.push(((j % n) + n) % n);
    else if (j >= 0 && j < n) out.push(j);
  }
  return out;
}

function median1(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The per-coordinate median of a joint's positions over the window around i; null when it has none there. */
export function medianAt(xs: Series, i: number, size: number, loop: boolean): Pt | null {
  const pts = windowAt(i, xs.length, size, loop).map((j) => xs[j]).filter((p): p is Pt => p !== null && p !== undefined);
  if (pts.length === 0) return null;
  return [median1(pts.map((p) => p[0])), median1(pts.map((p) => p[1]))];
}

/** Whether the spike step tests frame i: under loop always; without it, only where no clip end cuts the window. */
export function testedAt(i: number, n: number, loop: boolean, size = SPIKE_WINDOW): boolean {
  const h = size >> 1;
  return loop ? n >= size : i - h >= 0 && i + h < n;
}

/**
 * Spikes on one joint: every frame where it lies more than `limit` px from its
 * `size`-frame median (read from `xs`, not from a replaced value). Returns the
 * frames, each with its median and distance; `xs` is not changed.
 */
export function spikesOf(xs: Series, limit: number, loop: boolean, size = SPIKE_WINDOW): Array<{ frame: number; at: Pt; off: number }> {
  const out: Array<{ frame: number; at: Pt; off: number }> = [];
  xs.forEach((p, i) => {
    if (p === null || !testedAt(i, xs.length, loop, size)) return;
    const m = medianAt(xs, i, size, loop)!;
    const off = Math.hypot(p[0] - m[0], p[1] - m[1]);
    if (off > limit) out.push({ frame: i, at: m, off });
  });
  return out;
}

/**
 * Savitzky–Golay, centred: at each frame with a position, the least-squares
 * polynomial of degree `ORDER` (2) through the window's frames that have one,
 * read at that frame. With `loop` the window wraps; without it, it is cut at
 * the ends. Fewer than three points drop the degree to fit them exactly. A
 * polynomial of degree ≤ 2 passes through unchanged; a window of 1 is the input.
 */
export function savitzkyGolay(xs: Series, window: number, loop: boolean): Series {
  if (window <= 1) return xs.map((p) => (p === null ? null : [p[0], p[1]]));
  const n = xs.length;
  const h = window >> 1;
  const cache = new Map<string, number[]>();
  return xs.map((p, i) => {
    if (p === null) return null;
    const us: number[] = [];
    const at: Pt[] = [];
    for (let u = -h; u <= h; u++) {
      let j = i + u;
      if (loop) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      const q = xs[j];
      if (q === null || q === undefined) continue;
      us.push(u);
      at.push(q);
    }
    const key = us.join(',');
    let w = cache.get(key);
    if (w === undefined) {
      w = sgWeights(us, Math.min(ORDER, us.length - 1));
      cache.set(key, w);
    }
    let x = 0;
    let y = 0;
    w.forEach((c, k) => {
      x += c * at[k]![0];
      y += c * at[k]![1];
    });
    return [x, y];
  });
}

/** The weights that read a least-squares polynomial of degree q over the offsets `us` at offset 0. */
function sgWeights(us: readonly number[], q: number): number[] {
  const m = q + 1;
  // Normal equations: A[j][l] = Σ u^(j+l); solve A z = e0, then w(u) = Σ z_j u^j.
  const A = Array.from({ length: m }, (_, j) => Array.from({ length: m + 1 }, (_, l) => {
    if (l === m) return j === 0 ? 1 : 0;
    let s = 0;
    for (const u of us) s += u ** (j + l);
    return s;
  }));
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let l = c; l <= m; l++) A[r]![l]! -= f * A[c]![l]!;
    }
  }
  const z = A.map((row, j) => row[m]! / row[j]!);
  return us.map((u) => z.reduce((s, zj, j) => s + zj * u ** j, 0));
}

/** Mean |second difference| of y, px/f², over every series and every three consecutive frames with a position (wrapping with loop). */
export function jitterOf(all: readonly Series[], loop: boolean): { value: number | null; triples: number } {
  let sum = 0;
  let count = 0;
  for (const xs of all) {
    const n = xs.length;
    for (let i = 0; i < n; i++) {
      if (!loop && (i === 0 || i === n - 1)) continue;
      if (loop && n < 3) continue;
      const a = xs[(i - 1 + n) % n];
      const b = xs[i];
      const c = xs[(i + 1) % n];
      if (a === null || b === null || c === null || a === undefined || b === undefined || c === undefined) continue;
      sum += Math.abs(c[1] - 2 * b[1] + a[1]);
      count++;
    }
  }
  return { value: count === 0 ? null : sum / count, triples: count };
}

/**
 * Clean one person's track. Refuses (every reason at once) a window that is
 * not 1 or odd ≥ 5, a loop shorter than the widest window it reads, and a
 * sequence whose trunk is measured on no frame.
 */
export function clean(seq: PoseSequence, params: CleanParams, wanted: string | undefined, where: string): Cleaned {
  const p = new Problems();
  for (const [flag, v] of [['--legs', params.legs], ['--rest', params.rest]] as const) {
    const why = windowProblem(flag, v);
    if (why !== null) p.add('CLEAN_WINDOW', why);
  }
  const track = personTrack(seq, wanted, where);
  const n = track.length;
  const person = wanted ?? [...new Set(seq.frames.flatMap((f) => f.people.map((q) => q.id)))].sort()[0]!;
  if (params.loop) {
    const widest = Math.max(SPIKE_WINDOW, params.legs, params.rest);
    if (n < widest) p.add('CLEAN_LOOP', `--loop over ${n} frame(s) of ${where}: a circular window of ${widest} frames would read a frame twice; a cycle needs ≥ ${widest} frames (the spike median reads ${SPIKE_WINDOW}, --legs ${params.legs}, --rest ${params.rest})`);
  }
  const at = (j: Joint | undefined): Pt | null => (j === undefined || j.state === 'missing' || j.at === undefined ? null : [j.at[0], j.at[1]]);
  const names = BODY18.filter((name) => track.some((f) => f[name] !== undefined));
  const raw = new Map<Body18, Series>(names.map((name) => [name, track.map((f) => at(f[name]))]));

  // The trunk: neck → mid_hip, its median picture length.
  const lengths: number[] = [];
  for (let i = 0; i < n; i++) {
    const neck = raw.get('neck')?.[i] ?? null;
    const r = raw.get('r_hip')?.[i] ?? null;
    const l = raw.get('l_hip')?.[i] ?? null;
    if (neck === null || r === null || l === null) continue;
    lengths.push(Math.hypot(neck[0] - (r[0] + l[0]) / 2, neck[1] - (r[1] + l[1]) / 2));
  }
  if (lengths.length === 0) p.add('CLEAN_TRUNK', `${where} person "${person}": neck, r_hip and l_hip have a position together on none of its ${n} frame(s); the spike limit is ${SPIKE_TRUNKS} trunk lengths (neck → mid_hip), so there is no limit to read`);
  p.throwIfAny();
  const trunk = median1(lengths);
  const limit = SPIKE_TRUNKS * trunk;

  // 1. Spikes.
  const spikes: SpikeFound[] = [];
  const despiked = new Map<Body18, Series>();
  for (const name of names) {
    const xs = raw.get(name)!;
    const out = [...xs];
    for (const s of spikesOf(xs, limit, params.loop)) {
      out[s.frame] = s.at;
      spikes.push({ frame: s.frame, joint: name, off: s.off });
    }
    despiked.set(name, out);
  }
  spikes.sort((a, b) => a.frame - b.frame || BODY18.indexOf(a.joint) - BODY18.indexOf(b.joint));

  // 2. Occlusion.
  const occluded: Occluded[] = [];
  const unhidden = new Map<Body18, Series>();
  for (const name of names) {
    const xs = despiked.get(name)!;
    const out = [...xs];
    xs.forEach((q, i) => {
      if (q === null) return;
      const j = track[i]![name]!;
      const low = j.score !== undefined && j.score < OCCLUSION_SCORE;
      if ((j.state === 'observed' || j.state === 'inferred') && !low) return;
      const m = medianAt(xs, i, OCCLUSION_WINDOW, params.loop)!;
      out[i] = m;
      occluded.push({ joint: name, frame: i, moved: Math.hypot(m[0] - q[0], m[1] - q[1]), why: j.state !== 'observed' && j.state !== 'inferred' ? j.state : `score ${j.score!.toFixed(3)} < ${OCCLUSION_SCORE}` });
    });
    unhidden.set(name, out);
  }

  // 3. Smoothing.
  const smoothed = new Map<Body18, Series>();
  for (const name of names) smoothed.set(name, savitzkyGolay(unhidden.get(name)!, LEGS.includes(name) ? params.legs : params.rest, params.loop));

  // 4. Floor (loop only).
  let floor: Floor | null = null;
  if (params.loop) {
    const lowest = (m: Map<Body18, Series>): number | null => {
      const ys = (['r_ankle', 'l_ankle'] as const).flatMap((a) => (m.get(a) ?? []).filter((q): q is Pt => q !== null).map((q) => q[1]));
      return ys.length === 0 ? null : Math.max(...ys);
    };
    const before = lowest(unhidden);
    const after = lowest(smoothed);
    if (before !== null && after !== null) {
      const shift = before - after;
      floor = { before, after, shift };
      for (const name of names) smoothed.set(name, smoothed.get(name)!.map((q) => (q === null ? null : [q[0], q[1] + shift])));
    }
  }

  const missing: Cleaned['missing'] = [];
  for (const name of names) {
    raw.get(name)!.forEach((q, i) => {
      if (q !== null) return;
      const last = missing[missing.length - 1];
      if (last !== undefined && last.joint === name && last.to === i - 1) last.to = i;
      else missing.push({ joint: name, from: i, to: i });
    });
  }

  const untested = Array.from({ length: n }, (_, i) => i).filter((i) => !testedAt(i, n, params.loop));
  const before = jitterOf([...raw.values()], params.loop);
  const after = jitterOf([...smoothed.values()], params.loop);
  const record: CleanRecord = {
    spec: CLEAN_SPEC,
    params: { loop: params.loop, legs: params.legs, rest: params.rest, ...(params.hipsInferred === true ? { hipsInferred: { by: 'declared' as const } } : {}) },
    spikes: { found: spikes.map((s) => ({ frame: s.frame, joint: s.joint })), untested },
    jitter: { before: before.value, after: after.value },
  };
  const inferred = params.hipsInferred === true ? { r_hip: 0, l_hip: 0 } : null;
  const frames = seq.frames.map((f, i) => {
    const q = f.people.find((x) => x.id === person);
    if (q === undefined) return { t: f.t, people: [] };
    const joints: Partial<Record<Body18, Joint>> = {};
    for (const [name, j] of Object.entries(q.joints) as Array<[Body18, Joint]>) {
      const moved = smoothed.get(name)?.[i] ?? null;
      const out: Joint = moved === null ? { ...j } : { ...j, at: [moved[0], moved[1]] };
      if (inferred !== null && (name === 'r_hip' || name === 'l_hip') && out.state !== 'missing' && out.at !== undefined) {
        out.state = 'inferred';
        inferred[name]++;
      }
      joints[name] = out;
    }
    return { t: f.t, people: [{ id: person, joints: sortedJoints(joints) }] };
  });
  const { cleaned: _was, ...rest } = seq;
  return {
    seq: { ...rest, cleaned: record, frames },
    record,
    person,
    trunk: { length: trunk, frames: lengths.length },
    spikes,
    occluded,
    missing,
    untested,
    floor,
    triples: before.triples,
    inferred,
  };
}

/** The untested frames as text: "frames 0, 1, 30, 31 untested (a clip end cuts their window)", or "every frame tested". */
export function untestedText(frames: readonly number[]): string {
  if (frames.length === 0) return 'every frame tested';
  return `frame${frames.length === 1 ? '' : 's'} ${frames.join(', ')} untested (a clip end cuts the ${SPIKE_WINDOW}-frame window)`;
}

/** The record as one line: retarget's CLEAN line, and clean's own summary. */
export function cleanLine(r: CleanRecord): string {
  const { loop, legs, rest } = r.params;
  const windows = legs === 1 && rest === 1 ? 'legs 1, rest 1 — no smoothing' : `legs ${legs}, rest ${rest}`;
  const found = r.spikes.found;
  const shown = found.slice(0, 8).map((s) => `frame ${s.frame} ${s.joint}`).join(', ');
  const spikes = `${found.length === 0 ? 'no spike' : `${found.length} spike(s) replaced (${shown}${found.length > 8 ? `, … ${found.length - 8} more` : ''})`}, ${untestedText(r.spikes.untested)}`;
  const jit = (v: number | null) => (v === null ? 'not measured' : v.toFixed(2));
  const hips = r.params.hipsInferred === undefined ? '' : `; hips inferred (${inferredSource(r)})`;
  return `${r.spec}: ${windows}, ${loop ? 'loop' : 'no loop'}; ${spikes}; jitter (mean |second difference| of y) ${jit(r.jitter.before)} → ${jit(r.jitter.after)} px/f²${hips}`;
}

/**
 * Where a sequence's `inferred` hips come from, as the lines say it: "declared
 * at clean" when the record says `--hips-inferred` marked them; "source not
 * stated" when the joints carry the state and the record does not say why
 * (a file whose states were written by hand or by another tool).
 */
export function inferredSource(r: CleanRecord | undefined): string {
  const h = r?.params.hipsInferred;
  if (h === undefined) return 'source not stated';
  return h.by === 'declared' ? 'declared at clean' : h.by;
}
