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
import { clean, cleanLine, inferredSource, jitterOf, LEGS, savitzkyGolay, type Series } from '../src/clean.ts';
import { measuredFrames, readPoseSequence, writePoseSequence, type PoseSequence } from '../src/pose.ts';

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
    expect(doc.cleaned.params).toEqual({ loop: false, legs: 1, rest: 1, hold: { speed: 0.015, reach: 0.03, minSeconds: 0.5, blend: 6 } });
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

describe('--hips-inferred (#63): the hips marked inferred, the record says who declared it', () => {
  test('both hips are inferred on every frame they have a position; positions, scores and every other joint are as without the flag', () => {
    const doc = seqDoc(12, SMOOTH, (i, j) => {
      if (i === 3) j.l_hip = { state: 'missing' };
      if (i === 6) j.r_hip = { state: 'occluded', at: [j.r_hip!.at![0] + 4, j.r_hip!.at![1]], score: 0.4 };
    });
    const plain = clean(seqOf(doc), { loop: false, legs: 5, rest: 7 }, undefined, 'mem');
    const flagged = clean(seqOf(doc), { loop: false, legs: 5, rest: 7, hipsInferred: true }, undefined, 'mem');
    expect(plain.record.params).toEqual({ loop: false, legs: 5, rest: 7 });
    expect(plain.inferred).toBeNull();
    expect(flagged.record.params).toEqual({ loop: false, legs: 5, rest: 7, hipsInferred: { by: 'declared' } });
    expect(flagged.inferred).toEqual({ r_hip: 12, l_hip: 11 });
    const jointsOf = (c: typeof plain, i: number) => c.seq.frames[i]!.people[0]!.joints as Record<string, JointDoc>;
    for (let i = 0; i < 12; i++) {
      for (const name of BODY18) {
        const a = jointsOf(plain, i)[name]!;
        const b = jointsOf(flagged, i)[name]!;
        if ((name === 'r_hip' || name === 'l_hip') && a.state !== 'missing') expect(b).toEqual({ ...a, state: 'inferred' });
        else expect(b).toEqual(a);
      }
    }
    // A hip with no position is not given a state it cannot carry.
    expect(jointsOf(flagged, 3).l_hip).toEqual({ state: 'missing' });
    expect(jointsOf(flagged, 6).r_hip!.score).toBe(0.4);
    // Every other figure is the same run's.
    expect({ ...flagged.record, params: plain.record.params }).toEqual(plain.record);
    // The record and the states round-trip through the file.
    const written = writePoseSequence(flagged.seq);
    const back = readPoseSequence(written, 'mem');
    expect(back.cleaned!.params.hipsInferred).toEqual({ by: 'declared' });
    expect(writePoseSequence(back)).toBe(written);
    expect(cleanLine(flagged.record)).toBe(`${cleanLine(plain.record)}; hips inferred (declared at clean)`);
  });

  test('the CLI: --hips-inferred prints INFERRED and the CLEAN line names it; control: without it, neither, and the file carries no hipsInferred', () => {
    const dir = tempDir();
    const input = join(dir, 'pose.json');
    writeFileSync(input, JSON.stringify(seqDoc(12)));
    const out = join(dir, 'flag.json');
    const r = cli(['clean', '--pose', input, '--out', out, '--hips-inferred']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'INFERRED')).toEqual(['INFERRED r_hip on 12 frame(s), l_hip on 12 frame(s) of 12 marked "inferred" (every frame where it has a position): declared at clean (--hips-inferred); positions and scores unchanged']);
    expect(linesOf(r, 'CLEAN')[0]).toEndWith('; hips inferred (declared at clean)');
    const flagged = JSON.parse(readFileSync(out, 'utf8')) as { cleaned: { params: Record<string, unknown> } };
    expect(flagged.cleaned.params).toEqual({ loop: false, legs: 5, rest: 7, hipsInferred: { by: 'declared' }, hold: { speed: 0.015, reach: 0.03, minSeconds: 0.5, blend: 6 } });
    const out0 = join(dir, 'plain.json');
    const r0 = cli(['clean', '--pose', input, '--out', out0]);
    expect(r0.status).toBe(0);
    expect(linesOf(r0, 'INFERRED')).toEqual([]);
    expect(linesOf(r0, 'CLEAN')[0]).not.toContain('inferred');
    const plain = readFileSync(out0, 'utf8');
    expect(plain).not.toContain('inferred');
    expect(plain).not.toContain('hipsInferred');
    // The two files differ in the hips' state and the record only.
    expect(readFileSync(out, 'utf8').replaceAll('"state": "inferred"', '"state": "observed"').replace(',\n      "hipsInferred": {\n        "by": "declared"\n      }', '')).toBe(plain);
  });

  test('a cleaned file cleaned again moves its inferred hips as observed ones (the occlusion step reads them alike)', () => {
    const once = clean(seqOf(seqDoc(12, SMOOTH, plant)), { loop: false, legs: 1, rest: 1, hipsInferred: true }, undefined, 'mem');
    const twice = clean(readPoseSequence(writePoseSequence(once.seq), 'mem'), { loop: false, legs: 1, rest: 1 }, undefined, 'mem');
    expect(twice.occluded).toEqual([]);
  });
});

describe('the inferred state (#63) is read by name', () => {
  test('an inferred joint with no position is refused by name; control: with one, it is read', () => {
    const bad = seqDoc(6, SMOOTH, (i, j) => {
      if (i === 2) j.r_hip = { state: 'inferred', score: 0.5 };
    });
    let err = '';
    try {
      readPoseSequence(JSON.stringify(bad), 'p.json');
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toBe('POSE_JOINT_AT: p.json frames[2] people[0] joint "r_hip" is "inferred" and has no "at"; an inferred joint is a position the detector supplied but did not see, so it has one');
    const good = seqDoc(6, SMOOTH, (i, j) => {
      if (i === 2) j.r_hip = { state: 'inferred', at: [485, 600] };
    });
    expect((readPoseSequence(JSON.stringify(good), 'p.json').frames[2]!.people[0]!.joints.r_hip)).toEqual({ state: 'inferred', at: [485, 600] });
  });

  test('a "hipsInferred" record by neither "declared" nor "measured" is refused by name', () => {
    const good = clean(seqOf(seqDoc(12)), { loop: false, legs: 5, rest: 7, hipsInferred: true }, undefined, 'mem').seq;
    const doc = JSON.parse(writePoseSequence(good)) as { cleaned: { params: Record<string, unknown> } };
    doc.cleaned.params.hipsInferred = { by: 'guessed', how: 1 };
    let err = '';
    try {
      readPoseSequence(JSON.stringify(doc), 'p.json');
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err.split('\n')).toEqual([
      'POSE_CLEANED: p.json "cleaned" "params" "hipsInferred" has a key this reader does not know: "how"; the keys it reads are by',
      'POSE_CLEANED: p.json "cleaned" "params" "hipsInferred" "by" is the string "guessed"; this reader reads "declared" (the person running rig-pose clean --hips-inferred said so) or "measured" (a tool read the pelvis line off the picture, tools/pelvis.py)',
    ]);
  });
});

describe('a measured "hipsInferred" record (#86) is read, written and refused by name', () => {
  const MEASURED = {
    by: 'measured',
    method: 'a test reading',
    read: [[0, 3], [7, 9]],
    interpolated: [[4, 5]],
    held: [[6, 6], [10, 11]],
    declined: [{ frames: [4, 5], why: 'covered' }, { frames: [6, 6], why: 'edge confidence' }, { frames: [10, 11], why: 'covered' }],
  };
  const docWith = (h: unknown) => {
    const good = clean(seqOf(seqDoc(12)), { loop: false, legs: 5, rest: 7, hipsInferred: true }, undefined, 'mem').seq;
    const doc = JSON.parse(writePoseSequence(good)) as { cleaned: { params: Record<string, unknown> } };
    doc.cleaned.params.hipsInferred = h;
    return JSON.stringify(doc);
  };
  const refusal = (h: unknown): string[] => {
    try {
      readPoseSequence(docWith(h), 'p.json');
    } catch (e) {
      return (e as Error).message.split('\n');
    }
    return [];
  };
  const W = 'POSE_CLEANED: p.json "cleaned" "params" "hipsInferred"';

  test('the control: a well-formed record with each class is read, round-trips byte for byte, and names its source', () => {
    const back = readPoseSequence(docWith(MEASURED), 'p.json');
    expect(back.cleaned!.params.hipsInferred).toEqual(MEASURED as never);
    expect(writePoseSequence(readPoseSequence(writePoseSequence(back), 'p.json'))).toBe(writePoseSequence(back));
    expect(measuredFrames(back.cleaned!.params.hipsInferred)).toEqual(new Set(Array.from({ length: 12 }, (_, i) => i)));
    expect(measuredFrames({ by: 'declared' })).toBeNull();
    expect(inferredSource(back.cleaned)).toBe('measured by a test reading');
    expect(cleanLine(back.cleaned!)).toEndWith('; hips inferred (measured by a test reading)');
  });

  test('planted: each malformed field is refused naming the field, the value and what it must be', () => {
    expect(refusal({ by: 'measured', read: [], interpolated: [], held: [], declined: [] })).toEqual([
      `${W} has no "method"; a measured record is { by: "measured", method, read, interpolated, held: [[first, last]], declined: [{ frames: [first, last], why }] }`,
    ]);
    expect(refusal({ ...MEASURED, held: undefined })).toEqual([
      `${W} has no "held"; a measured record is { by: "measured", method, read, interpolated, held: [[first, last]], declined: [{ frames: [first, last], why }] }`,
    ]);
    expect(refusal({ ...MEASURED, method: '' })).toEqual([`${W} "method" is the string ""; it must be a non-empty string naming the reading`]);
    expect(refusal({ ...MEASURED, extra: 1 })).toEqual([`${W} has a key this reader does not know: "extra"; the keys it reads are by, method, read, interpolated, held, declined`]);
    expect(refusal({ ...MEASURED, read: [[0, 3.5], [7, 12]] })).toEqual([
      `${W} read[0][1] is number 3.5; it must be a frame index in [0, 11]`,
      `${W} read[1][1] is number 12; it must be a frame index in [0, 11]`,
    ]);
    expect(refusal({ ...MEASURED, read: [[3, 0], [7, 9]] })).toEqual([`${W} read[0] is [3, 0]; a run's first frame must not come after its last`]);
    expect(refusal({ ...MEASURED, held: [[10, 11], [6, 6]] })).toEqual([
      `${W} held[1] [6, 6] starts at or before the end of p.json "cleaned" "params" "hipsInferred" held[0] [10, 11]; held runs must increase and not overlap`,
    ]);
    expect(refusal({ ...MEASURED, declined: [{ frames: [4, 5] }, { frames: [6], why: 'x' }] })).toEqual([
      `${W} declined[0] has no "why"; a declined run says why, a non-empty string`,
      `${W} declined[1] "frames" is an array; a run is [first, last], two frame indices`,
    ]);
  });

  test('planted: the classes must be disjoint, cover every frame, and be exactly what was declined', () => {
    // A frame in two classes.
    expect(refusal({ ...MEASURED, interpolated: [[3, 5]] })).toEqual([
      `${W} read[0] [0, 3] and p.json "cleaned" "params" "hipsInferred" interpolated[0] [3, 5] share frame(s) 3–3; a frame is one of read, interpolated and held`,
    ]);
    // A frame in none.
    expect(refusal({ ...MEASURED, held: [[6, 6], [10, 10]], declined: [MEASURED.declined[0], MEASURED.declined[1], { frames: [10, 10], why: 'covered' }] })).toEqual([
      `${W}: frame(s) 11 are in none of read, interpolated and held; every frame of the sequence is one of them`,
    ]);
    // Read and declined.
    expect(refusal({ ...MEASURED, declined: [{ frames: [3, 5], why: 'covered' }, MEASURED.declined[1], MEASURED.declined[2]] })).toEqual([
      `${W}: frame(s) 3 are both read and declined; a frame is read or declined, not both`,
    ]);
    // Filled but not declined.
    expect(refusal({ ...MEASURED, declined: [MEASURED.declined[0], MEASURED.declined[1]] })).toEqual([
      `${W}: frame(s) 10–11 are interpolated or held but not declined; only a frame the reading declined is filled, and "declined" says why`,
    ]);
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
      'POSE_CLEANED: p.json "cleaned" "params" has a key this reader does not know: "extra"; the keys it reads are loop, legs, rest, hipsInferred, hold',
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
    expect(seq.cleaned!.params).toEqual({ loop: false, legs: 5, rest: 7, hold: { speed: 0.015, reach: 0.03, minSeconds: 0.5, blend: 6 } });
    expect(seq.source).toStartWith('converted from COCO-17');
  });
});

// ===========================================================================

/**
 * The stillness hold (#91), per joint. A figure whose mid-hip travels
 * `path(i)` px in x, every joint carrying its own small deterministic
 * "detector noise" (under 0.4 px a coordinate, so a still joint's 5-frame
 * median speed stays under the 1.5 px/frame that 0.015 trunk lengths is at a
 * 100 px trunk). 30 frames a second.
 */
const noise = (k: number, i: number): Pt => [0.4 * Math.sin(k * 7.13 + i * 3.71), 0.4 * Math.cos(k * 5.27 + i * 2.93)];
const travel = (path: (i: number) => number, own?: (k: number, i: number) => number): Wave => (k, i) => {
  const e = noise(k, i);
  return [path(i) + (own?.(k, i) ?? 0) + e[0], e[1]];
};
const HOLD = { speed: 0.015, reach: 0.03 };
const runClean = (doc: Record<string, unknown>, hold?: { speed: number; reach: number } | 'off') => clean(seqOf(doc), { loop: false, legs: 1, rest: 1, ...(hold !== undefined ? { hold } : {}) }, undefined, 'mem');
const R_WRIST = BODY18.indexOf('r_wrist');

/** Moves 3 px a frame (0.03 trunk) for 20 frames, then stands still to the end. */
const STOPS = travel((i) => 3 * Math.min(i, 20));
/** As STOPS, but the right wrist keeps drifting 0.7 px a frame (0.007 trunk, under the speed limit) after the stop. */
const WRIST_DRIFTS = travel((i) => 3 * Math.min(i, 20), (k, i) => (k === R_WRIST ? 0.7 * Math.max(0, i - 20) : 0));
/** Moves 3 px a frame to frame 20, stands still to frame 44, moves again from 45. */
const STOPS_AND_GOES = travel((i) => 3 * (i <= 20 ? i : i <= 44 ? 20 : i - 24));
/** Moves 3 px a frame to frame 20, then drifts 0.3 px a frame: still by speed, and a 3 px reach chops it into holds back to back. */
const CHOPPED = travel((i) => (i <= 20 ? 3 * i : 60 + 0.3 * (i - 20)));
/** Per seam, the largest frame-to-frame movement of its joint over the frames of its two holds, px, beside the step between their medians, px. */
const seamSteps = (seq: PoseSequence, holds: ReadonlyArray<{ joint: string; frames: readonly [number, number] }>, seams: ReadonlyArray<{ joint: string; frame: number; gap: number }>): Array<{ moved: number; step: number; gap: number }> => seams.map((s) => {
  const one = holds.find((h) => h.joint === s.joint && h.frames[1] === s.frame - s.gap - 1)!;
  const two = holds.find((h) => h.joint === s.joint && h.frames[0] === s.frame)!;
  const m1 = atOf(seq, one.frames[0], s.joint)!;
  const m2 = atOf(seq, two.frames[1], s.joint)!;
  let moved = 0;
  for (let i = one.frames[0] + 1; i <= two.frames[1]; i++) {
    const p = atOf(seq, i - 1, s.joint)!;
    const q = atOf(seq, i, s.joint)!;
    moved = Math.max(moved, Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  return { moved, step: Math.hypot(m2[0] - m1[0], m2[1] - m1[1]), gap: s.gap };
});
/** As `travel`, with a quieter noise (under 0.25 px a coordinate), so a 2.5 px step stays over the 1.5 px speed limit on every joint. */
const quiet = (path: (i: number) => number): Wave => (k, i) => {
  const e = noise(k, i);
  return [path(i) + 0.625 * e[0], 0.625 * e[1]];
};
/** Still, then three 2.5 px steps (frames 28, 30, 32: over the speed limit) with stops between, then still: only frame 30's 5-frame median speed fails — a 1-frame gap between two holds. */
const GAP1 = quiet((i) => 2.5 * (i < 28 ? 0 : i < 30 ? 1 : i < 32 ? 2 : 3));
/** Still, then three 2.5 px steps on frames 29, 30, 31, then still: frames 29–31 fail the speed — a 3-frame gap. */
const GAP3 = quiet((i) => 2.5 * (i < 29 ? 0 : i < 32 ? i - 28 : 3));
/** Drifts 1 px a frame (0.01 trunk, under the speed limit) for the whole clip: a 0.5 s span spans 14 px. */
const DRIFT = travel((i) => 1 * i);
/** Moves 3 px a frame, stopping on one frame (30 repeats 29). */
const ONE_FRAME_PAUSE = travel((i) => 3 * (i < 30 ? i : i - 1));
/** Moves 3 px a frame, stopping for 0.2 s (frames 30–35 repeat 29): a pause, under the 0.5 s minimum. */
const SHORT_PAUSE = travel((i) => 3 * (i < 30 ? i : i <= 35 ? 29 : i - 6));

const spansOf = (c: ReturnType<typeof runClean>): Record<string, Array<[number, number]>> => {
  const out: Record<string, Array<[number, number]>> = {};
  for (const h of c.holds) (out[h.joint] ??= []).push(h.frames);
  return out;
};

describe('the stillness hold (#91): a joint that has stopped is written at one position', () => {
  test('a still figure with planted detector noise: every joint is held, its jitter goes to 0, the frames before the blend are bit-identical, the blend in is linear', () => {
    const off = runClean(seqDoc(60, STOPS), 'off');
    const on = runClean(seqDoc(60, STOPS), HOLD);
    // Frame 20 is the first still position, but its speed window (18–22) still reads three moving frames.
    expect(spansOf(on)).toEqual(Object.fromEntries(BODY18.map((name) => [name, [[21, 59]]])));
    expect(on.unheld).toEqual([]);
    expect(on.record.unheld).toEqual([]);
    for (const h of on.holds) {
      expect(h.jitter.after).toBe(0);
      expect(h.jitter.before!).toBeGreaterThan(0);
      expect(h.blendIn).toEqual([16, 20]);
      expect(h.blendOut).toBeNull();
    }
    for (const name of BODY18) {
      const held = atOf(on.seq, 21, name)!;
      for (let i = 21; i < 60; i++) expect(atOf(on.seq, i, name)).toEqual(held);
      for (let i = 0; i <= 15; i++) expect(atOf(on.seq, i, name)).toEqual(atOf(off.seq, i, name)!);
      for (let k = 1; k <= 5; k++) {
        const was = atOf(off.seq, 21 - k, name)!;
        const now = atOf(on.seq, 21 - k, name)!;
        const w = (6 - k) / 6;
        expect(now[0]).toBeCloseTo(was[0] + w * (held[0] - was[0]), 9);
        expect(now[1]).toBeCloseTo(was[1] + w * (held[1] - was[1]), 9);
      }
    }
    // The held position is the joint's per-coordinate median of its cleaned positions over the span.
    const xs = Array.from({ length: 39 }, (_, u) => atOf(off.seq, 21 + u, 'r_wrist')![0]).sort((a, b) => a - b);
    expect(atOf(on.seq, 30, 'r_wrist')![0]).toBe(xs[19]!);
  });

  test('one joint drifting while the rest are still: the rest are held, the drifting one keeps its track and is named with its reach', () => {
    const off = runClean(seqDoc(60, WRIST_DRIFTS), 'off');
    const on = runClean(seqDoc(60, WRIST_DRIFTS), HOLD);
    const spans = spansOf(on);
    expect(spans.r_wrist).toBeUndefined();
    expect(Object.keys(spans).sort()).toEqual(BODY18.filter((n) => n !== 'r_wrist').sort());
    for (const name of BODY18) if (name !== 'r_wrist') expect(spans[name]).toEqual([[21, 59]]);
    for (let i = 0; i < 60; i++) expect(atOf(on.seq, i, 'r_wrist')).toEqual(atOf(off.seq, i, 'r_wrist')!);
    expect(on.unheld).toHaveLength(1);
    expect(on.unheld[0]!.joint).toBe('r_wrist');
    expect(on.unheld[0]!.frames).toEqual([21, 59]);
    expect(on.unheld[0]!.test).toBe('reach');
    expect(on.unheld[0]!.value!).toBeGreaterThan(0.1);
    const line = cleanLine(on.record);
    expect(line).toContain('; HOLD frames 21–59: held nose, neck, r_shoulder, r_elbow, l_shoulder,');
    expect(line).toMatch(/; not held: r_wrist 21–59 \(reach 0\.\d{4} > 0\.03\)/);
  });

  test('the blend out: a hold that ends before the clip does blends out over the 6 frames after it, mirroring the blend in', () => {
    const off = runClean(seqDoc(70, STOPS_AND_GOES), 'off');
    const on = runClean(seqDoc(70, STOPS_AND_GOES), HOLD);
    expect(on.unheld).toEqual([]);
    for (const name of BODY18) {
      const h = on.holds.filter((x) => x.joint === name);
      expect(h).toHaveLength(1);
      const [a, b] = h[0]!.frames;
      expect(a).toBe(21);
      expect(b).toBe(44);
      expect(h[0]!.blendOut).toEqual([45, 49]);
      const held = atOf(on.seq, a, name)!;
      for (let k = 1; k <= 5; k++) {
        const was = atOf(off.seq, b + k, name)!;
        const now = atOf(on.seq, b + k, name)!;
        const w = (6 - k) / 6;
        expect(now[0]).toBeCloseTo(was[0] + w * (held[0] - was[0]), 9);
        expect(now[1]).toBeCloseTo(was[1] + w * (held[1] - was[1]), 9);
      }
      for (let i = b + 6; i < 70; i++) expect(atOf(on.seq, i, name)).toEqual(atOf(off.seq, i, name)!);
    }
  });

  test('a slow drift chopped into back-to-back holds: each seam is recorded and cross-faded, and no frame inside the holds moves more than a sixth of a step', () => {
    const r = runClean(seqDoc(60, CHOPPED), HOLD);
    expect(r.seams.length).toBeGreaterThan(0);
    expect(r.record.seams).toEqual(r.seams);
    const worst = seamSteps(r.seq, r.holds, r.seams);
    for (const w of worst) expect(w.moved).toBeLessThanOrEqual(w.step / 6 + 1e-9);
    // The cross-fade's frames: the 6 centred on the seam take 1/12, 3/12, … 11/12 of the way.
    const s0 = r.seams[0]!;
    const one = r.holds.find((h) => h.joint === s0.joint && h.frames[1] === s0.frame - 1)!;
    const two = r.holds.find((h) => h.joint === s0.joint && h.frames[0] === s0.frame)!;
    const m1 = atOf(r.seq, one.frames[0], s0.joint)!;
    const m2 = atOf(r.seq, two.frames[1], s0.joint)!;
    for (let j = 0; j < 6; j++) {
      const now = atOf(r.seq, s0.frame - 3 + j, s0.joint)!;
      const w = (2 * j + 1) / 12;
      expect(now[0]).toBeCloseTo(m1[0] + w * (m2[0] - m1[0]), 9);
    }
    expect(cleanLine(r.record)).toContain(`seams cross-faded: ${r.seams[0]!.joint} ${r.seams[0]!.frame} (step `);
  });

  test('a 1-frame and a 3-frame gap between two holds are two holds meeting: each is a seam with its gap, cross-faded over 6 + gap frames, no frame moving more than 1/(6 + gap) of the step', () => {
    for (const [doc, gap] of [[GAP1, 1], [GAP3, 3]] as const) {
      const r = runClean(seqDoc(60, doc), HOLD);
      expect(r.seams.length).toBe(18);
      for (const s of r.seams) expect(s.gap).toBe(gap);
      for (const s of r.seams) expect(s.frame).toBe(gap === 1 ? 31 : 32);
      for (const w of seamSteps(r.seq, r.holds, r.seams)) expect(w.moved).toBeLessThanOrEqual(w.step / (6 + gap) + 1e-9);
      // The cross-fade's frames: 6 + gap, symmetric about the gap's centre, (2j + 1)/(2(6 + gap)) of the way.
      const s0 = r.seams[0]!;
      const one = r.holds.find((h) => h.joint === s0.joint && h.frames[1] === s0.frame - gap - 1)!;
      const two = r.holds.find((h) => h.joint === s0.joint && h.frames[0] === s0.frame)!;
      const m1 = atOf(r.seq, one.frames[0], s0.joint)!;
      const m2 = atOf(r.seq, two.frames[1], s0.joint)!;
      for (let j = 0; j < 6 + gap; j++) {
        const now = atOf(r.seq, one.frames[1] - 2 + j, s0.joint)!;
        const w = (2 * j + 1) / (2 * (6 + gap));
        expect(now[0]).toBeCloseTo(m1[0] + w * (m2[0] - m1[0]), 9);
        expect(now[1]).toBeCloseTo(m1[1] + w * (m2[1] - m1[1]), 9);
      }
      expect(cleanLine(r.record)).toContain(`(step ${s0.step.toFixed(4)}, gap ${gap})`);
      expect(cleanLine(r.record)).toMatch(/; jitter after [^;]* px\/f² \(ramp\)/);
    }
  });

  test('mutant: without the gap rule a 1-frame and a 3-frame gap step, and the gap test is red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'clean.ts');
      const from = 'if (gap < 0 || gap >= HOLD_BLEND) continue;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'if (gap !== 0) continue;'));
      const dir = tempDir();
      const input = join(dir, 'pose.json');
      const out = join(dir, 'out.json');
      // The largest frame-to-frame movement of any joint from its first hold's start to its second hold's end, as a share of the step between their medians.
      const worstShare = (cliPath: string, doc: Wave): number => {
        writeFileSync(input, JSON.stringify(seqDoc(60, doc)));
        const ran = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1'], cliPath);
        expect(ran.status).toBe(0);
        const seq = readPoseSequence(readFileSync(out, 'utf8'), out);
        let worst = 0;
        for (const name of BODY18) {
          const hs = seq.cleaned!.holds!.filter((h) => h.joint === name);
          if (hs.length < 2) continue;
          const m1 = atOf(seq, hs[0]!.frames[0], name)!;
          const m2 = atOf(seq, hs[1]!.frames[1], name)!;
          const step = Math.hypot(m2[0] - m1[0], m2[1] - m1[1]);
          for (let i = hs[0]!.frames[0] + 1; i <= hs[1]!.frames[1]; i++) {
            const p = atOf(seq, i - 1, name)!;
            const q = atOf(seq, i, name)!;
            worst = Math.max(worst, Math.hypot(q[0] - p[0], q[1] - p[1]) / step);
          }
        }
        return worst;
      };
      const mutant = [worstShare(join(d, 'cli.ts'), GAP1), worstShare(join(d, 'cli.ts'), GAP3)];
      console.log(`  mutant "no gap rule": the largest frame-to-frame move is ${mutant.map((x) => x.toFixed(3)).join(' (1-frame gap) and ')} (3-frame gap) of the step`);
      if (!(mutant[0]! > 1 / 6 + 0.01 && mutant[1]! > 1 / 6 + 0.01)) throw new Error('mutant "no gap rule" survived: the gaps did not step');
      expect(mutant[0]!).toBeGreaterThan(1 / 6 + 0.01);
      expect(mutant[1]!).toBeGreaterThan(1 / 6 + 0.01);
      // Control: the real source; the writer's 0.01 px rounding is the slack.
      expect(worstShare(CLI, GAP1)).toBeLessThan(1 / 7 + 0.01);
      expect(worstShare(CLI, GAP3)).toBeLessThan(1 / 9 + 0.01);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  test('mutant: without the cross-fade a seam steps in one frame, and the seam test is red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'clean.ts');
      const from = 'out[i] = [one.at[0] + w * (two.at[0] - one.at[0]), one.at[1] + w * (two.at[1] - one.at[1])];';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'void w;'));
      const dir = tempDir();
      const input = join(dir, 'pose.json');
      const out = join(dir, 'out.json');
      const stepsOf = (cliPath: string) => {
        writeFileSync(input, JSON.stringify(seqDoc(60, CHOPPED)));
        const ran = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1'], cliPath);
        expect(ran.status).toBe(0);
        const seq = readPoseSequence(readFileSync(out, 'utf8'), out);
        const holds = seq.cleaned!.holds!;
        return seamSteps(seq, holds, seq.cleaned!.seams!);
      };
      // The writer rounds to 0.01 px, so the bar here carries 0.02 px of slack.
      const over = (ws: Array<{ moved: number; step: number }>) => ws.filter((w) => w.moved > w.step / 6 + 0.02);
      const mutant = stepsOf(join(d, 'cli.ts'));
      console.log(`  mutant "no cross-fade": ${over(mutant).length} of ${mutant.length} seam(s) step by more than a sixth, the largest ${Math.max(...mutant.map((w) => w.moved / w.step)).toFixed(3)} of the step in one frame`);
      if (over(mutant).length === 0) throw new Error('mutant "no cross-fade" survived: no seam stepped');
      expect(over(mutant).length).toBeGreaterThan(0);
      // Control: the real source.
      expect(over(stepsOf(CLI))).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  test('a slow drift of the whole figure under the speed limit is NOT held: it leaves its median by more than the reach; control: with a reach of 1 trunk it is', () => {
    const drift = runClean(seqDoc(60, DRIFT), HOLD);
    expect(drift.holds).toEqual([]);
    expect(drift.record.holds).toEqual([]);
    const wide = runClean(seqDoc(60, DRIFT), { speed: 0.015, reach: 1 });
    // Each joint is held over most of the clip (the noise puts a few edge frames' speed over the limit).
    expect(new Set(wide.holds.map((h) => h.joint)).size).toBe(18);
    for (const h of wide.holds) expect(h.seconds).toBeGreaterThan(1);
    // Control on the speed: moving 3 px a frame is never still, whatever the reach.
    expect(runClean(seqDoc(60, travel((i) => 3 * i)), { speed: 0.015, reach: 1 }).holds).toEqual([]);
  });

  test('a one-frame pause is not held, nor a 0.2 s one (under the 0.5 s minimum)', () => {
    // A one-frame stop never passes a 5-frame median speed: the median reads the motion either side.
    expect(runClean(seqDoc(60, ONE_FRAME_PAUSE), HOLD).holds).toEqual([]);
    // The 0.2 s pause (frames 30–35) does pass the speed test on a few frames, and the 0.5 s minimum refuses it.
    expect(runClean(seqDoc(60, SHORT_PAUSE), HOLD).holds).toEqual([]);
  });

  test('mutant: without the 0.5 s minimum the 0.2 s pause is held, and the pause test is red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'clean.ts');
      const from = 'export const HOLD_MIN_SECONDS = 0.5;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const HOLD_MIN_SECONDS = 0;'));
      const dir = tempDir();
      const input = join(dir, 'pose.json');
      const out = join(dir, 'out.json');
      const holdsOf = (cliPath: string): Array<{ joint: string; frames: [number, number] }> => {
        writeFileSync(input, JSON.stringify(seqDoc(60, SHORT_PAUSE)));
        const r = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1'], cliPath);
        expect(r.status).toBe(0);
        return (JSON.parse(readFileSync(out, 'utf8')) as { cleaned: { holds: Array<{ joint: string; frames: [number, number] }> } }).cleaned.holds;
      };
      const mutant = holdsOf(join(d, 'cli.ts'));
      console.log(`  mutant "no 0.5 s minimum": ${mutant.length} joint hold(s) on the 0.2 s pause, e.g. ${mutant.slice(0, 3).map((h) => `${h.joint} ${h.frames.join('–')}`).join(', ') || 'none'}`);
      if (mutant.length === 0) throw new Error('mutant "no 0.5 s minimum" survived: the pause was not held');
      expect(mutant.length).toBeGreaterThan(0);
      // Control: the same input through the real source holds nothing.
      expect(holdsOf(CLI)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  test('the CLI: a HOLD line per joint and span, UNHELD names the joints not held, the CLEAN line and the record carry both', () => {
    const dir = tempDir();
    const input = join(dir, 'pose.json');
    const out = join(dir, 'out.json');
    writeFileSync(input, JSON.stringify(seqDoc(60, WRIST_DRIFTS)));
    const r = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const hold = linesOf(r, 'HOLD');
    expect(hold).toHaveLength(17);
    expect(hold[0]).toStartWith('HOLD   joint "nose" frames 21–59 (t=0.700s–t=1.967s, 1.300 s): 5-frame median speed under 0.015 trunk/frame (largest ');
    expect(hold[0]).toContain('written as that median, blended in over before frames 16–20, out over nothing after it; jitter inside ');
    expect(hold[0]).toEndWith('→ 0.000 px/f²');
    expect(linesOf(r, 'UNHELD')).toHaveLength(1);
    expect(linesOf(r, 'UNHELD')[0]).toMatch(/^UNHELD frames 21–59, where other joints are held: r_wrist 21–59 \(reach 0\.\d{4} > 0\.03\)$/);
    expect(linesOf(r, 'HOLDS')).toEqual(['HOLDS  17 found over 17 joint(s) (per joint: a span ≥ 0.5 s still by speed < 0.015 trunk/frame and reach ≤ 0.03 trunk; 6-frame blend in and out)']);
    expect(linesOf(r, 'CLEAN')[0]).toContain('; not held: r_wrist 21–59 (reach ');
    const doc = JSON.parse(readFileSync(out, 'utf8')) as { cleaned: { params: Record<string, unknown>; holds: Array<{ joint: string; frames: number[] }>; unheld: Array<Record<string, unknown>> } };
    expect(doc.cleaned.params.hold).toEqual({ speed: 0.015, reach: 0.03, minSeconds: 0.5, blend: 6 });
    expect(doc.cleaned.holds.map((h) => h.joint)).toEqual(BODY18.filter((n) => n !== 'r_wrist'));
    expect(doc.cleaned.unheld.map((u) => [u.joint, u.frames, u.test])).toEqual([['r_wrist', [21, 59], 'reach']]);
    // No hold found is said so; the thresholds are recorded as given.
    writeFileSync(input, JSON.stringify(seqDoc(60, DRIFT)));
    const none = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1']);
    expect(linesOf(none, 'HOLDS')[0]).toStartWith('HOLDS  0 found');
    expect(linesOf(none, 'CLEAN')[0]).toEndWith('; no HOLD (speed < 0.015 trunk/frame, within 0.03 trunk, ≥ 0.5 s)');
    const wide = cli(['clean', '--pose', input, '--out', out, '--legs', '1', '--rest', '1', '--hold-reach', '1', '--hold-speed', '0.02']);
    expect(wide.status).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { cleaned: { params: Record<string, unknown> } }).cleaned.params.hold).toEqual({ speed: 0.02, reach: 1, minSeconds: 0.5, blend: 6 });
  });

  test('--hold off writes the positions of a clean without the step, byte for byte; the record differs by "hold": "off" alone', () => {
    const dir = tempDir();
    const input = join(dir, 'pose.json');
    const out = join(dir, 'out.json');
    const doc = seqDoc(60, STOPS);
    writeFileSync(input, JSON.stringify(doc));
    const r = cli(['clean', '--pose', input, '--out', out, '--hold', 'off']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'HOLD')).toEqual(['HOLD   off (--hold off): no stillness hold']);
    expect(linesOf(r, 'CLEAN')[0]).toEndWith('; hold off');
    const written = readFileSync(out, 'utf8');
    const without = writePoseSequence(clean(seqOf(doc), { loop: false, legs: 5, rest: 7 }, undefined, 'mem').seq);
    expect(written).not.toBe(without);
    expect(written.split(',\n      "hold": "off"')).toHaveLength(2);
    expect(written.replace(',\n      "hold": "off"', '')).toBe(without);
    const rec = (JSON.parse(written) as { cleaned: Record<string, unknown> }).cleaned;
    expect(rec.holds).toBeUndefined();
    expect(rec.unheld).toBeUndefined();
  });

  test('refusals: --hold takes "off" only; a threshold with --hold off; a threshold ≤ 0 — each beside its control', () => {
    const dir = tempDir();
    const input = join(dir, 'pose.json');
    const out = join(dir, 'out.json');
    writeFileSync(input, JSON.stringify(seqDoc(12)));
    const on = cli(['clean', '--pose', input, '--out', out, '--hold', 'on']);
    expect(on.status).toBe(2);
    expect(on.stderr).toContain('--hold is "on"; the hold runs by default, and the only value is "off"');
    const both = cli(['clean', '--pose', input, '--out', out, '--hold', 'off', '--hold-speed', '0.02']);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain('--hold-speed with --hold off: the hold does not run, so it changes nothing');
    const zero = cli(['clean', '--pose', input, '--out', out, '--hold-reach', '0']);
    expect(zero.status).toBe(2);
    expect(zero.stderr).toContain('--hold-reach is "0"; it must be a number > 0 (trunk lengths)');
    expect(cli(['clean', '--pose', input, '--out', out, '--hold', 'off']).status).toBe(0);
    expect(cli(['clean', '--pose', input, '--out', out, '--hold-reach', '0.05']).status).toBe(0);
  });

  test('the record: "hold", "holds" and "unheld" are read by name, each malformed one refused; a valid one round-trips', () => {
    const good = runClean(seqDoc(60, WRIST_DRIFTS), HOLD).seq;
    const written = writePoseSequence(good);
    const back = readPoseSequence(written, 'mem');
    expect(back.cleaned!.holds!).toHaveLength(17);
    expect(back.cleaned!.unheld!.map((u) => u.joint)).toEqual(['r_wrist']);
    expect(writePoseSequence(back)).toBe(written);
    const refuse = (edit: (c: Record<string, unknown>) => void): string[] => {
      const doc = JSON.parse(written) as { cleaned: Record<string, unknown> };
      edit(doc.cleaned);
      try {
        readPoseSequence(JSON.stringify(doc), 'p.json');
      } catch (e) {
        return (e as Error).message.split('\n');
      }
      return [];
    };
    expect(refuse(() => {})).toEqual([]);
    expect(refuse((c) => delete c.holds)).toEqual(['POSE_CLEANED: p.json "cleaned" has "params" "hold" and no "holds"; a record whose hold ran lists its holds, the joints it did not hold and its seams (an empty array when none)']);
    expect(refuse((c) => { (c.params as Record<string, unknown>).hold = 'off'; })).toEqual(['holds', 'unheld', 'seams'].map((k) => `POSE_CLEANED: p.json "cleaned" has "${k}" with "params" "hold" "off"; a record lists holds only when the hold ran`));
    expect(refuse((c) => delete (c.params as Record<string, unknown>).hold)).toEqual(['holds', 'unheld', 'seams'].map((k) => `POSE_CLEANED: p.json "cleaned" has "${k}" and no "params" "hold"; the holds' figures are recorded in "params" "hold"`));
    expect(refuse((c) => { c.seams = [{ joint: 'neck', frame: 60, step: -1, gap: 1.5 }]; })).toEqual([
      'POSE_CLEANED: p.json "cleaned" seams[0] "gap" is number 1.5; it must be a whole number of frames ≥ 0',
      'POSE_CLEANED: p.json "cleaned" seams[0] "frame" is number 60; it must be a frame index in [0, 59]',
      'POSE_CLEANED: p.json "cleaned" seams[0] "step" is number -1; it must be trunk lengths ≥ 0',
    ]);
    expect(refuse((c) => {
      (c.params as Record<string, unknown>).hold = { speed: 0, reach: 0.03, minSeconds: 0.5, blend: 1.5 };
      c.holds = [{ joint: 'r_toe', frames: [59, 21], jitter: { before: 1, after: -1 } }];
      c.unheld = [{ joint: 'r_wrist', frames: [21, 59], test: 'drift', value: null }];
    })).toEqual([
      'POSE_CLEANED: p.json "cleaned" "params" "hold" "speed" is number 0; it must be a number > 0 (trunk lengths per frame)',
      'POSE_CLEANED: p.json "cleaned" "params" "hold" "blend" is number 1.5; it must be a whole number of frames ≥ 0',
      'POSE_CLEANED: p.json "cleaned" holds[0] "joint" is the string "r_toe"; it must be a body-18 joint: nose, neck, r_shoulder, r_elbow, r_wrist, l_shoulder, l_elbow, l_wrist, r_hip, r_knee, r_ankle, l_hip, l_knee, l_ankle, r_eye, l_eye, r_ear, l_ear',
      'POSE_CLEANED: p.json "cleaned" holds[0] "frames" is an array; it must be [first, last], frame indices in [0, 59], first ≤ last',
      'POSE_CLEANED: p.json "cleaned" holds[0] "jitter" "after" is number -1; it must be px/f² ≥ 0, or null (not measured)',
      'POSE_CLEANED: p.json "cleaned" unheld[0] "test" is the string "drift"; it must be "speed", "reach", "short" or "span"',
      'POSE_CLEANED: p.json "cleaned" unheld[0] "value" is null; it must be a figure ≥ 0 (trunk lengths, or seconds for "short"), or null for a speed not known',
    ]);
  });
});
