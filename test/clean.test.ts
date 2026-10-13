/**
 * `rig-pose clean` (rig-c/pose#67), held by synthetic sequences with known
 * answers: planted spikes that must all be found while every clean joint stays
 * bit-identical, a sequence with none that reports 0, a periodic signal whose
 * amplitude --loop keeps beside the control without it, and mutants without
 * the 5-frame median that must make the spike test red. Each refusal has its
 * planted input beside a control.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BODY18 } from '../src/joints.ts';
import { clean, cleanLine, jitterOf, LEGS, savitzkyGolay, type Series } from '../src/clean.ts';
import { readPoseSequence, writePoseSequence, type PoseSequence } from '../src/pose.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
type Pt = [number, number];

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-clean-'));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}
function cli(args: string[], cliPath = CLI): Ran {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: ROOT });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const linesOf = (r: Ran, tag: string): string[] => r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${tag} `));
const fails = (r: Ran): string[] => r.stderr.split('\n').filter((l) => l.startsWith('FAIL  '));

// --- the synthetic figure ----------------------------------------------------------

/**
 * A standing figure that moves smoothly: every joint at a fixed offset from the
 * mid-hip plus its own slow sinusoid (a few px a frame at most), the neck 100 px
 * above the mid-hip, so the spike limit is 20 px. Nothing in it is a spike.
 */
const OFFSET: Record<string, Pt> = {
  nose: [0, -130], neck: [0, -100], r_shoulder: [-25, -100], r_elbow: [-35, -60], r_wrist: [-40, -20],
  l_shoulder: [25, -100], l_elbow: [35, -60], l_wrist: [40, -20], r_hip: [-15, 0], r_knee: [-18, 70],
  r_ankle: [-20, 140], l_hip: [15, 0], l_knee: [18, 70], l_ankle: [20, 140], r_eye: [-6, -135],
  l_eye: [6, -135], r_ear: [-12, -130], l_ear: [12, -130],
};
type Wave = (k: number, i: number) => Pt;
const SMOOTH: Wave = (k, i) => [6 * Math.sin(0.2 * i + k), 4 * Math.cos(0.15 * i + 0.5 * k)];

interface JointDoc {
  state: string;
  at?: Pt;
  score?: number;
}
function seqDoc(n: number, wave: Wave = SMOOTH, edit?: (i: number, j: Record<string, JointDoc>) => void): Record<string, unknown> {
  const frames = Array.from({ length: n }, (_, i) => {
    const joints: Record<string, JointDoc> = {};
    BODY18.forEach((name, k) => {
      const w = wave(k, i);
      joints[name] = { state: 'observed', at: [500 + OFFSET[name]![0] + w[0], 600 + OFFSET[name]![1] + w[1]], score: 0.9 };
    });
    // The trunk stays 100 px: the neck rides on the hips' midpoint.
    const r = joints.r_hip!.at!;
    const l = joints.l_hip!.at!;
    joints.neck!.at = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2 - 100];
    edit?.(i, joints);
    return { t: i / 30, people: [{ id: 'a', joints }] };
  });
  return { spec: 'rig-pose-sequence/1', space: { units: 'picture-px', origin: 'top-left', y: 'down' }, width: 1000, height: 1000, source: 'synthetic, test/clean.test.ts', frames };
}
const seqOf = (doc: Record<string, unknown>): PoseSequence => readPoseSequence(JSON.stringify(doc), 'mem');
const atOf = (s: PoseSequence, i: number, name: string): Pt | undefined => (s.frames[i]!.people[0]!.joints as Record<string, JointDoc>)[name]?.at;

/** The planted spikes: (frame, joint, push) — one a two-frame spike, which a 3-frame median cannot see. */
const PLANTED: Array<[number, string, Pt]> = [
  [4, 'r_wrist', [60, -10]],
  [11, 'l_ankle', [0, 45]],
  [12, 'l_ankle', [0, 45]],
  [20, 'nose', [-30, 25]],
  [27, 'r_knee', [25, 0]],
];
const plant = (i: number, j: Record<string, JointDoc>): void => {
  for (const [f, name, d] of PLANTED) if (f === i) j[name]!.at = [j[name]!.at![0] + d[0], j[name]!.at![1] + d[1]];
};

// ===========================================================================

describe('spikes: a joint more than 0.2 trunk lengths from its 5-frame median takes the median', () => {
  test('every planted spike is found and named; every other joint is bit-identical (pure)', () => {
    const doc = seqDoc(32, SMOOTH, plant);
    const input = seqOf(doc);
    const c = clean(input, { loop: false, legs: 1, rest: 1 }, undefined, 'mem');
    expect(c.trunk.length).toBeCloseTo(100, 9);
    expect(c.record.spikes.found as Array<{ frame: number; joint: string }>).toEqual(PLANTED.map(([frame, joint]) => ({ frame, joint })).sort((a, b) => a.frame - b.frame));
    const planted = new Set(PLANTED.map(([f, n]) => `${f}:${n}`));
    let same = 0;
    for (let i = 0; i < 32; i++) {
      for (const name of BODY18) {
        const was = atOf(input, i, name)!;
        const now = atOf(c.seq, i, name)!;
        if (planted.has(`${i}:${name}`)) {
          // The median of the clean neighbours: back within a few px of the smooth path.
          const smooth = (seqDoc(32).frames as Array<{ people: Array<{ joints: Record<string, JointDoc> }> }>)[i]!.people[0]!.joints[name]!.at!;
          expect(Math.hypot(now[0] - smooth[0], now[1] - smooth[1])).toBeLessThan(5);
        } else {
          expect(now[0]).toBe(was[0]);
          expect(now[1]).toBe(was[1]);
          same++;
        }
      }
    }
    expect(same).toBe(32 * 18 - PLANTED.length);
  });

  test('a sequence with no spike reports 0, and windows of 1 return it bit-identical', () => {
    const input = seqOf(seqDoc(32));
    const c = clean(input, { loop: false, legs: 1, rest: 1 }, undefined, 'mem');
    expect(c.record.spikes).toEqual({ found: [], untested: [0, 1, 30, 31] });
    expect(c.occluded).toEqual([]);
    for (let i = 0; i < 32; i++) for (const name of BODY18) expect(atOf(c.seq, i, name)).toEqual(atOf(input, i, name)!);
    expect(c.record.jitter.after).toBe(c.record.jitter.before);
  });

  test('the command line names each spike by frame and joint, and records them in "cleaned"', () => {
    const dir = tempDir();
    const input = join(dir, 'pose.json');
    const out = join(dir, 'pose.clean.json');
    writeFileSync(input, JSON.stringify(seqDoc(32, SMOOTH, plant)));
    const r = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'TRUNK')).toEqual(['TRUNK  neck → mid_hip: median 100.00 px over 32 frame(s); a spike is > 20.00 px (0.2 trunk) from its 5-frame median']);
    const spikes = linesOf(r, 'SPIKE');
    expect(spikes).toHaveLength(PLANTED.length);
    expect(spikes[1]).toStartWith('SPIKE  joint "l_ankle" frame 11 (t=0.367s): ');
    expect(spikes[1]).toEndWith('px from its 5-frame median, over 20.00 — took the median');
    expect(linesOf(r, 'SPIKES')).toEqual([`SPIKES ${PLANTED.length} replaced; frames 0, 1, 30, 31 untested (a clip end cuts the 5-frame window)`]);
    expect(linesOf(r, 'SMOOTH')).toEqual(['SMOOTH quadratic Savitzky–Golay per joint: legs (r_hip, r_knee, r_ankle, l_hip, l_knee, l_ankle) over 1 frame (none), the rest over 1 frame (none); the window cut at the ends']);
    expect(linesOf(r, 'CLEAN')[0]).toStartWith('CLEAN  rig-pose-clean/1: legs 1, rest 1 — no smoothing, no loop; 5 spike(s) replaced (frame 4 r_wrist, frame 11 l_ankle, frame 12 l_ankle, frame 20 nose, frame 27 r_knee), frames 0, 1, 30, 31 untested (a clip end cuts the 5-frame window); jitter');
    const doc = JSON.parse(readFileSync(out, 'utf8')) as { cleaned: { spec: string; params: unknown; spikes: unknown } };
    expect(doc.cleaned.spec).toBe('rig-pose-clean/1');
    expect(doc.cleaned.params).toEqual({ loop: false, legs: 1, rest: 1 });
    expect(doc.cleaned.spikes).toEqual({
      found: [{ frame: 4, joint: 'r_wrist' }, { frame: 11, joint: 'l_ankle' }, { frame: 12, joint: 'l_ankle' }, { frame: 20, joint: 'nose' }, { frame: 27, joint: 'r_knee' }],
      untested: [0, 1, 30, 31],
    });
    // Determinism: the same input writes the same bytes.
    const first = readFileSync(out);
    rmSync(out);
    expect(cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1']).status).toBe(0);
    expect(readFileSync(out).equals(first)).toBe(true);
  });
});

describe('the edge: a frame whose 5-frame window a clip end cuts is not tested, and is named', () => {
  /** A wrist sweeping 25 px a frame — over the 20 px limit from a neighbour's value, never a spike. */
  const FAST: Wave = (k, i) => (k === 4 ? [25 * i, 0] : SMOOTH(k, i));

  test('a joint moving steadily through the first and last frames is not a spike; the four edge frames are recorded untested', () => {
    const c = clean(seqOf(seqDoc(16, FAST)), { loop: false, legs: 1, rest: 1 }, undefined, 'mem');
    expect(c.record.spikes).toEqual({ found: [], untested: [0, 1, 14, 15] });
  });

  test('control: the same sweep with the edge guard removed (a mutant) is flagged at both ends — the flaw the guard is for', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'clean.ts');
      const from = 'return loop ? n >= size : i - h >= 0 && i + h < n;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'return loop ? n >= size : n >= 0 && h >= 0;'));
      const dir = tempDir();
      const input = join(dir, 'pose.json');
      const out = join(dir, 'out.json');
      writeFileSync(input, JSON.stringify(seqDoc(16, FAST)));
      const r = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1'], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      const found = (JSON.parse(readFileSync(out, 'utf8')) as { cleaned: { spikes: { found: Array<{ frame: number; joint: string }> } } }).cleaned.spikes.found;
      expect(found).toEqual([{ frame: 0, joint: 'r_wrist' }, { frame: 15, joint: 'r_wrist' }]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  test('a spike planted on an untested frame stays, named as untested on the SPIKES line; one frame in is found', () => {
    const dir = tempDir();
    const input = join(dir, 'pose.json');
    const out = join(dir, 'out.json');
    writeFileSync(input, JSON.stringify(seqDoc(16, SMOOTH, (i, j) => {
      if (i === 1 || i === 2) j.nose!.at = [j.nose!.at![0] + 50, j.nose!.at![1]];
    })));
    const r = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SPIKES')).toEqual(['SPIKES 1 replaced; frames 0, 1, 14, 15 untested (a clip end cuts the 5-frame window)']);
    expect(linesOf(r, 'SPIKE')[0]).toStartWith('SPIKE  joint "nose" frame 2 ');
  });

  test('under --loop there is no edge: every frame is tested', () => {
    const c = clean(seqOf(seqDoc(16)), { loop: true, legs: 1, rest: 1 }, undefined, 'mem');
    expect(c.record.spikes.untested).toEqual([]);
    expect(linesOfClean(c.record)).toContain('every frame tested');
  });
});
const linesOfClean = (r: Parameters<typeof cleanLine>[0]): string => cleanLine(r);

/** Mutants of the spike median: each must make the planted-spike test red. */
const SPIKE_MUTANTS: Array<{ name: string; from: string; to: string }> = [
  { name: 'a 3-frame median instead of 5', from: 'export const SPIKE_WINDOW = 5;', to: 'export const SPIKE_WINDOW = 3;' },
  { name: 'no median: each joint against itself', from: 'export const SPIKE_WINDOW = 5;', to: 'export const SPIKE_WINDOW = 1;' },
];

describe('mutants without the 5-frame median make the spike test red', () => {
  for (const mu of SPIKE_MUTANTS) {
    test(mu.name, () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'clean.ts');
        const before = readFileSync(path, 'utf8');
        expect(before.split(mu.from)).toHaveLength(2);
        writeFileSync(path, before.replace(mu.from, mu.to));
        const dir = tempDir();
        const input = join(dir, 'pose.json');
        const out = join(dir, 'out.json');
        writeFileSync(input, JSON.stringify(seqDoc(32, SMOOTH, plant)));
        const r = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1'], join(d, 'cli.ts'));
        expect(r.status).toBe(0);
        const found = (JSON.parse(readFileSync(out, 'utf8')) as { cleaned: { spikes: { found: Array<{ frame: number; joint: string }> } } }).cleaned.spikes.found;
        const want = PLANTED.map(([frame, joint]) => ({ frame, joint })).sort((a, b) => a.frame - b.frame);
        const red = JSON.stringify(found) !== JSON.stringify(want);
        console.log(`  mutant "${mu.name}": found ${found.length} of ${want.length} planted spikes: ${found.map((s) => `${s.frame} ${s.joint}`).join(', ') || 'none'}`);
        if (!red) throw new Error(`mutant "${mu.name}" survived: every planted spike found`);
        expect(red).toBe(true);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

// ===========================================================================

describe('occlusion: a joint not observed, or scored under 0.3, takes its 3-frame median', () => {
  test('an occluded joint and a low-score one move to the median; a missing one stays missing; states and scores are kept', () => {
    const doc = seqDoc(12, SMOOTH, (i, j) => {
      if (i === 5) j.r_elbow = { state: 'occluded', at: [j.r_elbow!.at![0] + 12, j.r_elbow!.at![1] + 12], score: 0.5 };
      if (i === 7) j.l_knee = { state: 'observed', at: [j.l_knee!.at![0] - 10, j.l_knee!.at![1]], score: 0.2 };
      if (i === 8) j.l_wrist = { state: 'missing' };
      if (i === 9) j.l_wrist = { state: 'missing' };
    });
    const input = seqOf(doc);
    const c = clean(input, { loop: false, legs: 1, rest: 1 }, undefined, 'mem');
    expect(c.record.spikes.found).toEqual([]);
    expect(c.occluded.map((o) => `${o.frame} ${o.joint} ${o.why}`)).toEqual(['5 r_elbow occluded', '7 l_knee score 0.200 < 0.3']);
    const med = (a: number, b: number, x: number) => [a, b, x].sort((p, q) => p - q)[1]!;
    for (const [i, name] of [[5, 'r_elbow'], [7, 'l_knee']] as const) {
      const xs = [i - 1, i, i + 1].map((f) => atOf(input, f, name)!);
      expect(atOf(c.seq, i, name)).toEqual([med(xs[0]![0], xs[1]![0], xs[2]![0]), med(xs[0]![1], xs[1]![1], xs[2]![1])]);
    }
    const j5 = (c.seq.frames[5]!.people[0]!.joints as Record<string, JointDoc>).r_elbow!;
    expect([j5.state, j5.score]).toEqual(['occluded', 0.5]);
    const j7 = (c.seq.frames[7]!.people[0]!.joints as Record<string, JointDoc>).l_knee!;
    expect([j7.state, j7.score]).toEqual(['observed', 0.2]);
    expect((c.seq.frames[8]!.people[0]!.joints as Record<string, JointDoc>).l_wrist).toEqual({ state: 'missing' });
    expect(c.missing).toEqual([{ joint: 'l_wrist', from: 8, to: 9 }]);
    // Control: the observed neighbours are untouched.
    expect(atOf(c.seq, 4, 'r_elbow')).toEqual(atOf(input, 4, 'r_elbow')!);
    expect(atOf(c.seq, 6, 'r_elbow')).toEqual(atOf(input, 6, 'r_elbow')!);
  });
});

// ===========================================================================

describe('smoothing: a quadratic Savitzky–Golay per joint (moved here from retarget, #67)', () => {
  /** A deterministic uniform noise in [−1, 1] (a linear congruential generator). */
  const noise = (seed: number) => {
    let x = seed >>> 0;
    return (): number => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return (x / 2 ** 32) * 2 - 1;
    };
  };
  const quadratic = (u: number): Pt => [-0.3 * u ** 2 + 2 * u + 5, 0.02 * u ** 2 + u];

  // Moved from retarget.test.ts's "a cubic passes through unchanged": the filter is a quadratic now (the card).
  test('a quadratic passes through unchanged, ends included, at every window, and across a gap', () => {
    const xs: Series = Array.from({ length: 40 }, (_, u) => quadratic(u));
    for (const w of [1, 5, 7, 9, 11]) {
      const out = savitzkyGolay(xs, w, false);
      const worst = Math.max(...out.map((p, i) => Math.hypot(p![0] - xs[i]![0], p![1] - xs[i]![1])));
      expect(worst).toBeLessThan(1e-6);
    }
    const gappy: Series = xs.map((p, i) => (i === 10 || i === 11 || i === 30 ? null : p));
    const out = savitzkyGolay(gappy, 7, false);
    expect(out[10]).toBeNull();
    expect(Math.max(...out.map((p, i) => (p === null ? 0 : Math.hypot(p[0] - xs[i]![0], p[1] - xs[i]![1]))))).toBeLessThan(1e-6);
  });

  // Moved from retarget.test.ts: a centred quadratic has the centred cubic's weights, so the same gains hold.
  test('noise around a quadratic: its variance drops to about the filter\'s gain (0.486 at 5, 0.255 at 9)', () => {
    const rnd = noise(8);
    const n = 400;
    const base = Array.from({ length: n }, (_, u) => quadratic(u / 10));
    const e: Pt[] = base.map(() => [rnd(), rnd()]);
    const noisy: Series = base.map((p, i): Pt => [p[0] + e[i]![0], p[1] + e[i]![1]]);
    const variance = (pts: Pt[]) => pts.reduce((s, p) => s + p[0] ** 2 + p[1] ** 2, 0) / pts.length;
    const before = variance(e);
    const ratio = (w: number) => variance(savitzkyGolay(noisy, w, false).map((p, i): Pt => [p![0] - base[i]![0], p![1] - base[i]![1]])) / before;
    expect(ratio(5)).toBeLessThan(0.6);
    expect(ratio(9)).toBeLessThan(0.35);
    expect(ratio(9)).toBeLessThan(ratio(5));
    expect(ratio(1)).toBeCloseTo(1, 12);
  });

  // Moved from retarget.test.ts unchanged in meaning.
  test('a centred filter keeps a peak in time: a symmetric bump\'s top stays on its frame', () => {
    const xs: Series = Array.from({ length: 41 }, (_, i): Pt => [Math.exp(-(((i - 20) / 3) ** 2)), 0]);
    const out = savitzkyGolay(xs, 7, false);
    const top = out.reduce((b, p, i) => (p![0] > out[b]![0] ? i : b), 0);
    expect(top).toBe(20);
  });

  test('the legs (hips, knees, ankles) take --legs, every other joint --rest', () => {
    expect(LEGS).toEqual(['r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle']);
    const rnd = noise(3);
    const input = seqOf(seqDoc(40, (k, i) => [SMOOTH(k, i)[0] + 3 * rnd(), SMOOTH(k, i)[1] + 3 * rnd()]));
    const c = clean(input, { loop: false, legs: 1, rest: 7 }, undefined, 'mem');
    for (const name of BODY18) {
      const changed = Array.from({ length: 40 }, (_, i) => atOf(c.seq, i, name)![1] !== atOf(input, i, name)![1]).some(Boolean);
      expect([name, changed]).toEqual([name, !LEGS.includes(name)]);
    }
  });
});

describe('--loop: the windows wrap, and the floor is re-pinned', () => {
  const N = 32;
  /** One gait-like cycle: every joint swings on a whole period, the ankles 30 px up and down. */
  const CYCLE: Wave = (k, i) => [10 * Math.sin((2 * Math.PI * i) / N + k), (k === 10 || k === 13 ? 30 : 8) * Math.sin((2 * Math.PI * i) / N + 0.3 * k)];
  const amplitude = (s: PoseSequence, name: string, from = 0, to = N - 1): number => {
    const ys = Array.from({ length: to - from + 1 }, (_, u) => atOf(s, from + u, name)![1]);
    return Math.max(...ys) - Math.min(...ys);
  };

  test('a periodic signal keeps its amplitude within 2% under --loop; the control without it is cut at the ends', () => {
    const input = seqOf(seqDoc(N, CYCLE));
    const looped = clean(input, { loop: true, legs: 5, rest: 7 }, undefined, 'mem');
    const open = clean(input, { loop: false, legs: 5, rest: 7 }, undefined, 'mem');
    for (const name of ['r_wrist', 'r_ankle', 'nose'] as const) {
      const a0 = amplitude(input, name);
      const a1 = amplitude(looped.seq, name);
      expect(Math.abs(a1 / a0 - 1)).toBeLessThan(0.02);
    }
    // The control: the same interior, different ends. Frames ≥ 3 from either end see a whole window in both runs
    // (the looped run's floor shift, one constant in y, taken out).
    const shift = looped.floor!.shift;
    for (let i = 0; i < N; i++) {
      const p = atOf(looped.seq, i, 'r_wrist')!;
      const a: Pt = [p[0], p[1] - shift];
      const b = atOf(open.seq, i, 'r_wrist')!;
      if (i >= 3 && i <= N - 4) expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-9);
    }
    // At the ends the cut window fits fewer frames: the first and last frames are not the circular result.
    for (const i of [0, N - 1]) {
      const p = atOf(looped.seq, i, 'r_wrist')!;
      const a: Pt = [p[0], p[1] - shift];
      const b = atOf(open.seq, i, 'r_wrist')!;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(1e-3);
    }
    // And the end of the open run is closer to the input than the circular run is (a shrunk window smooths less).
    const rnd = noise(5);
    const noisy = seqOf(seqDoc(N, (k, i) => [CYCLE(k, i)[0] + 4 * rnd(), CYCLE(k, i)[1] + 4 * rnd()]));
    const lj = clean(noisy, { loop: true, legs: 5, rest: 7 }, undefined, 'mem').record.jitter;
    const oj = clean(noisy, { loop: false, legs: 5, rest: 7 }, undefined, 'mem').record.jitter;
    expect(lj.after!).toBeLessThan(lj.before!);
    expect(oj.after!).toBeLessThan(oj.before!);
  });

  test('the floor: the lowest ankle over the cycle is at its height before smoothing; the figure moves by one constant', () => {
    const rnd = noise(11);
    const input = seqOf(seqDoc(N, (k, i) => [CYCLE(k, i)[0] + 3 * rnd(), CYCLE(k, i)[1] + 3 * rnd()]));
    const c = clean(input, { loop: true, legs: 5, rest: 7 }, undefined, 'mem');
    const lowest = (s: PoseSequence) => Math.max(...Array.from({ length: N }, (_, i) => Math.max(atOf(s, i, 'r_ankle')![1], atOf(s, i, 'l_ankle')![1])));
    expect(c.floor).not.toBeNull();
    expect(Math.abs(lowest(c.seq) - lowest(input))).toBeLessThan(1e-9);
    expect(Math.abs(c.floor!.shift)).toBeGreaterThan(1e-3);
    // Control: without --loop nothing is re-pinned.
    expect(clean(input, { loop: false, legs: 5, rest: 7 }, undefined, 'mem').floor).toBeNull();
  });

  function noise(seed: number) {
    let x = seed >>> 0;
    return (): number => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return (x / 2 ** 32) * 2 - 1;
    };
  }
});

describe('jitter: the mean |second difference| of y, px/f²', () => {
  test('a known figure: y = i² has second difference 2 everywhere; a still joint 0; wrapping only with loop', () => {
    const square: Series = Array.from({ length: 10 }, (_, i): Pt => [0, i * i]);
    const still: Series = Array.from({ length: 10 }, (): Pt => [0, 7]);
    expect(jitterOf([square], false)).toEqual({ value: 2, triples: 8 });
    expect(jitterOf([square, still], false)).toEqual({ value: 1, triples: 16 });
    // A gap removes the three triples that need it.
    expect(jitterOf([square.map((p, i) => (i === 5 ? null : p))], false)).toEqual({ value: 2, triples: 5 });
    // With loop the two wrapping triples count: |81 - 0 - 0 ...| at the seam.
    expect(jitterOf([square], true).triples).toBe(10);
    expect(jitterOf([[[0, 1], [0, 2]]], false)).toEqual({ value: null, triples: 0 });
  });
});

// ===========================================================================

describe('refusals, each beside its control', () => {
  const write = (doc: Record<string, unknown>): { input: string; out: string } => {
    const dir = tempDir();
    const input = join(dir, 'pose.json');
    writeFileSync(input, JSON.stringify(doc));
    return { input, out: join(dir, 'out.json') };
  };

  test('--legs and --rest: 1 or odd ≥ 5; 3 is an identity, an even window has no centre', () => {
    const { input, out } = write(seqDoc(12));
    const three = cli(['clean', '--pose', input, '--out', out, '--legs', '3']);
    expect(three.status).toBe(2);
    expect(three.stderr).toContain('--legs is "3"; a quadratic fitted through 3 points passes through all three, so a window of 3 changes nothing — it must be 1 (none) or an odd whole number ≥ 5');
    const even = cli(['clean', '--pose', input, '--out', out, '--rest', '6']);
    expect(even.status).toBe(2);
    expect(even.stderr).toContain('--rest is "6"; an even window has no centre frame — it must be 1 (none) or an odd whole number ≥ 5');
    const zero = cli(['clean', '--pose', input, '--out', out, '--rest', '0']);
    expect(zero.status).toBe(2);
    expect(zero.stderr).toContain('--rest is "0"; it must be 1 (none) or an odd whole number ≥ 5');
    expect(existsSync(out)).toBe(false);
    // A window of 3 really is the identity: the quadratic through 3 points.
    const xs: Series = Array.from({ length: 12 }, (_, i): Pt => [Math.sin(i), Math.cos(3 * i)]);
    const out3 = savitzkyGolay(xs, 3, false);
    expect(Math.max(...out3.map((p, i) => Math.hypot(p![0] - xs[i]![0], p![1] - xs[i]![1])))).toBeLessThan(1e-12);
    // Control: the defaults (5, 7) and 1 are accepted.
    expect(cli(['clean', '--pose', input, '--out', out]).status).toBe(0);
    expect(cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '9']).status).toBe(0);
  });

  test('CLEAN_LOOP: a cycle shorter than its widest window; CLEAN_TRUNK: no frame with neck and both hips', () => {
    const short = write(seqDoc(6));
    const r = cli(['clean', '--pose', short.input, '--out', short.out, '--loop']);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  CLEAN_LOOP: --loop over 6 frame(s) of ${short.input}: a circular window of 7 frames would read a frame twice; a cycle needs ≥ 7 frames (the spike median reads 5, --legs 5, --rest 7)`]);
    expect(existsSync(short.out)).toBe(false);
    expect(cli(['clean', '--pose', short.input, '--out', short.out, '--loop', '--rest', '5']).status).toBe(0);
    const noHips = write(seqDoc(8, SMOOTH, (_i, j) => (j.r_hip = { state: 'missing' })));
    const t = cli(['clean', '--pose', noHips.input, '--out', noHips.out]);
    expect(t.status).toBe(1);
    expect(fails(t)).toEqual([`FAIL  CLEAN_TRUNK: ${noHips.input} person "a": neck, r_hip and l_hip have a position together on none of its 8 frame(s); the spike limit is 0.2 trunk lengths (neck → mid_hip), so there is no limit to read`]);
  });

  test('a malformed "cleaned" record is refused by name, every problem in one run; a valid one round-trips', () => {
    const good = clean(seqOf(seqDoc(12, SMOOTH, plant)), { loop: false, legs: 5, rest: 7 }, undefined, 'mem').seq;
    const written = writePoseSequence(good);
    expect(Object.keys(JSON.parse(written) as object)).toEqual(['spec', 'space', 'width', 'height', 'source', 'cleaned', 'frames']);
    const back = readPoseSequence(written, 'mem');
    expect(back.cleaned).toEqual({ ...good.cleaned!, jitter: { before: Number(good.cleaned!.jitter.before!.toFixed(4)), after: Number(good.cleaned!.jitter.after!.toFixed(4)) } });
    expect(writePoseSequence(back)).toBe(written);
    const bad = { ...seqDoc(12), cleaned: { spec: 'rig-pose-clean/0', params: { loop: 'yes', legs: 3, rest: 7, extra: 1 }, spikes: { found: [{ frame: 12, joint: 'r_toe' }, 4], untested: [0, -1] }, jitter: { before: -1 } } };
    let err = '';
    try {
      readPoseSequence(JSON.stringify(bad), 'p.json');
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err.split('\n')).toEqual([
      'POSE_CLEANED: p.json "cleaned" "spec" is the string "rig-pose-clean/0"; this reader reads "rig-pose-clean/1"',
      'POSE_CLEANED: p.json "cleaned" "params" has a key this reader does not know: "extra"; the keys it reads are loop, legs, rest',
      'POSE_CLEANED: p.json "cleaned" "params" "loop" is the string "yes"; it must be true or false',
      'POSE_CLEANED: p.json "cleaned" "params" "legs" is number 3; it must be 1 (none) or an odd whole number ≥ 5',
      'POSE_CLEANED: p.json "cleaned" spikes.found[0] "frame" is number 12; it must be a frame index in [0, 11]',
      'POSE_CLEANED: p.json "cleaned" spikes.found[0] "joint" is the string "r_toe"; it must be a body-18 joint: nose, neck, r_shoulder, r_elbow, r_wrist, l_shoulder, l_elbow, l_wrist, r_hip, r_knee, r_ankle, l_hip, l_knee, l_ankle, r_eye, l_eye, r_ear, l_ear',
      'POSE_CLEANED: p.json "cleaned" spikes.found[1] is number 4; a spike is { frame, joint }',
      'POSE_CLEANED: p.json "cleaned" spikes.untested[1] is number -1; it must be a frame index in [0, 11]',
      'POSE_CLEANED: p.json "cleaned" "jitter" "before" is number -1; it must be px/f² ≥ 0, or null (not measured)',
      'POSE_CLEANED: p.json "cleaned" "jitter" "after" is undefined undefined; it must be px/f² ≥ 0, or null (not measured)',
    ]);
  });

  test('clean --coco reads COCO-17 and writes a cleaned rig-pose-sequence/1', () => {
    const order = ['nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear', 'l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist', 'l_hip', 'r_hip', 'l_knee', 'r_knee', 'l_ankle', 'r_ankle'];
    const src = seqDoc(10) as { frames: Array<{ t: number; people: Array<{ joints: Record<string, JointDoc> }> }> };
    const coco = { format: 'coco17-sequence/1', width: 1000, height: 1000, source: 'synthetic', frames: src.frames.map((f) => ({ t: f.t, keypoints: order.map((n) => [...f.people[0]!.joints[n]!.at!, 0.9]) })) };
    const { input, out } = write(coco);
    const r = cli(['clean', '--coco', '--pose', input, '--out', out]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('(COCO-17)');
    const seq = readPoseSequence(readFileSync(out, 'utf8'), out);
    expect(seq.cleaned!.params).toEqual({ loop: false, legs: 5, rest: 7 });
    expect(seq.source).toStartWith('converted from COCO-17');
  });
});
