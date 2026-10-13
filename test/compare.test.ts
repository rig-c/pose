/**
 * `rig-pose compare` (rig-c/pose#38): the control (a sequence against itself
 * finds nothing in any unit) beside a planted difference per unit and measure
 * that must be found — and one under each bar that must not — the finding rule's
 * 0.15 s edge, the fix classes, the refusals by name, and the sheet.
 *
 * The sequences are synthetic: a front-facing figure at 24 fps whose hips and
 * shoulders bob (so the body unit has a bounce to lose), with each difference
 * planted on the render side only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BARS, clothFigures, compare, gradient, reversals, summaryLine, UNITS, xcorrLag, type ClothTrack, type CompareInput, type Comparison, type HandScores, type Side, type Span } from '../src/compare.ts';
import { readMap } from '../src/map.ts';
import { personTrack, readPoseSequence } from '../src/pose.ts';

const CLI = join(import.meta.dir, '..', 'cli.ts');
const FPS = 24;
type Pt = [number, number];

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-compare-'));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

// --- the synthetic figure ----------------------------------------------------

/** Hip width 80 px; the hips bob ±10 px and the shoulders ±6 px at 1.5 Hz (the torso's length changes by 4 px). */
function figure(i: number, bounce: boolean): Record<string, Pt> {
  const t = i / FPS;
  const hip = bounce ? 10 * Math.sin(2 * Math.PI * 1.5 * t) : 0;
  const sh = bounce ? 6 * Math.sin(2 * Math.PI * 1.5 * t) : 0;
  return {
    nose: [540, 355 + sh], neck: [540, 420 + sh],
    r_eye: [525, 340 + sh], l_eye: [555, 340 + sh], r_ear: [510, 345 + sh], l_ear: [570, 345 + sh],
    r_shoulder: [480, 420 + sh], r_elbow: [460, 520 + sh], r_wrist: [450, 620 + sh],
    l_shoulder: [600, 420 + sh], l_elbow: [620, 520 + sh], l_wrist: [630, 620 + sh],
    r_hip: [500, 700 + hip], r_knee: [500, 850], r_ankle: [500, 1000],
    l_hip: [580, 700 + hip], l_knee: [580, 850], l_ankle: [580, 1000],
  };
}

type Edit = (i: number, p: Record<string, Pt>, score: Record<string, number>) => void;

interface SeqDoc {
  spec: string;
  space: unknown;
  width: number;
  height: number;
  source: string;
  frames: Array<{ t: number; people: Array<{ id: string; joints: Record<string, { state: string; at?: Pt; score?: number }> }> }>;
}

function makeSeq(n: number, edit?: Edit, bounce = true, dt = 0): SeqDoc {
  const frames = Array.from({ length: n }, (_, i) => {
    const p = figure(i, bounce);
    const score: Record<string, number> = Object.fromEntries(Object.keys(p).map((k) => [k, 0.9]));
    edit?.(i, p, score);
    const joints = Object.fromEntries(Object.entries(p).map(([k, at]) => [k, { state: 'observed', at, score: score[k]! }]));
    return { t: Math.round((i / FPS) * 1e5) / 1e5 + (i === n - 1 ? dt : 0), people: [{ id: 'a', joints }] };
  });
  return { spec: 'rig-pose-sequence/1', space: { units: 'picture-px', origin: 'top-left', y: 'down' }, width: 1080, height: 1920, source: 'synthetic', frames };
}

function sideOf(doc: SeqDoc, where: string): Side {
  const s = readPoseSequence(JSON.stringify(doc), where);
  return { where, times: s.frames.map((f) => f.t), frames: personTrack(s, undefined, where) };
}

const MAP = {
  spec: 'rig-pose-map/1',
  chains: [
    { name: 'trunk', bones: ['chest'], joints: ['mid_hip', 'mid_shoulder'], aim: ['neck'] },
    { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    { name: 'arm_r', bones: ['sleeve_r0', 'sleeve_r1'], joints: ['r_shoulder', 'r_elbow', 'r_wrist'], bend: 'free' },
    { name: 'arm_l', bones: ['sleeve_l0', 'sleeve_l1'], joints: ['l_shoulder', 'l_elbow', 'l_wrist'], bend: 'free' },
    { name: 'leg_r', bones: ['leg_r0', 'leg_r1'], joints: ['r_hip', 'r_knee', 'r_ankle'] },
    { name: 'leg_l', bones: ['leg_l0', 'leg_l1'], joints: ['l_hip', 'l_knee', 'l_ankle'] },
  ],
};
const map = () => readMap(JSON.stringify(MAP), 'map.json');

function run(render: SeqDoc, opts: Partial<Omit<CompareInput, 'reference' | 'render' | 'map'>> = {}, reference: SeqDoc = makeSeq(48)): Comparison {
  return compare({
    reference: sideOf(reference, 'ref.json'),
    render: sideOf(render, 'ren.json'),
    map: map(),
    spans: opts.spans ?? null,
    retargetScale: opts.retargetScale ?? null,
    hands: opts.hands ?? null,
    cloth: opts.cloth ?? null,
  });
}

/** Turn point `p` about `c` by `deg` degrees in the picture. */
function turn(p: Pt, c: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * Math.cos(r) - dy * Math.sin(r), c[1] + dx * Math.sin(r) + dy * Math.cos(r)];
}

/** The right forearm turned `deg` about the elbow on frames [from, from + count). */
const forearm = (deg: number, from: number, count: number): Edit => (i, p) => {
  if (i >= from && i < from + count) p.r_wrist = turn(p.r_wrist!, p.r_elbow!, deg);
};

// --- the control -------------------------------------------------------------

describe('the control: a sequence compared with itself', () => {
  test('finds nothing in any unit, and every summary line says 0', () => {
    const seq = makeSeq(48);
    const c = run(seq, {}, seq);
    expect(c.findings).toEqual([]);
    expect(c.units.map((u) => u.unit)).toEqual([...UNITS]);
    for (const u of c.units) {
      expect(summaryLine(u, c.times)).toStartWith('0 findings');
      for (const m of u.measures) expect(m.overBar).toBe(0);
    }
    expect(summaryLine(c.units.find((u) => u.unit === 'cloth')!, c.times)).toContain('not measured: no cloth tracks');
  });
});

// --- arms ----------------------------------------------------------------------

describe('arms: a mapped segment\'s direction (bar > 20°)', () => {
  test('a forearm turned 30° for 6 frames is one finding, on its frames, fix class rig (no set depicts the chain)', () => {
    const c = run(makeSeq(48, forearm(30, 20, 6)));
    expect(c.findings.length).toBe(1);
    const f = c.findings[0]!;
    expect([f.unit, f.measure, f.subject, f.chain]).toEqual(['arms', 'direction', 'arm_r/sleeve_r1', 'arm_r']);
    expect(f.frames).toEqual([20, 25]);
    expect(f.over).toBe(6);
    expect(f.worst.figure).toBeCloseTo(30, 6);
    expect(f.fix).toBe('rig');
    expect(f.seconds).toBeCloseTo(0.25, 4);
  });

  test('inside a set\'s span from the retarget report it is paint; outside every span, rig', () => {
    const inside: Span[] = [{ set: 'K1', chains: ['arm_r', 'arm_l'], frames: [15, 30] }];
    const a = run(makeSeq(48, forearm(30, 20, 6)), { spans: inside });
    expect(a.findings[0]!.fix).toBe('paint');
    expect(a.findings[0]!.fixWhy).toContain('"K1"');
    const elsewhere: Span[] = [{ set: 'K1', chains: ['arm_r'], frames: [30, 40] }, { set: 'K9', chains: ['arm_l'], frames: [15, 30] }];
    const b = run(makeSeq(48, forearm(30, 20, 6)), { spans: elsewhere });
    expect(b.findings[0]!.fix).toBe('rig');
  });

  test('10° is under the bar: no finding, no frame over it', () => {
    const c = run(makeSeq(48, forearm(10, 20, 6)));
    expect(c.findings).toEqual([]);
    expect(c.units.find((u) => u.unit === 'arms')!.measures[0]!.overBar).toBe(0);
  });

  test('the 0.15 s edge at 24 fps: 4 frames (0.167 s) are a finding, 3 frames (0.125 s) are not', () => {
    const four = run(makeSeq(48, forearm(30, 20, 4)));
    expect(four.findings.length).toBe(1);
    expect(four.findings[0]!.seconds).toBeCloseTo(4 / 24, 4);
    const three = run(makeSeq(48, forearm(30, 20, 3)));
    expect(three.findings).toEqual([]);
    expect(three.units.find((u) => u.unit === 'arms')!.measures[0]!.overBar).toBe(3);
  });

  test('two runs a frame apart merge into one; two frames apart they do not', () => {
    const gap1 = (i: number, p: Record<string, Pt>) => {
      if ((i >= 10 && i < 12) || (i >= 13 && i < 15)) p.r_wrist = turn(p.r_wrist!, p.r_elbow!, 30);
    };
    const c = run(makeSeq(48, gap1));
    expect(c.findings.map((f) => f.frames)).toEqual([[10, 14]]);
    expect(c.findings[0]!.over).toBe(4);
    const gap2 = (i: number, p: Record<string, Pt>) => {
      if ((i >= 10 && i < 12) || (i >= 14 && i < 16)) p.r_wrist = turn(p.r_wrist!, p.r_elbow!, 30);
    };
    expect(run(makeSeq(48, gap2)).findings).toEqual([]);
  });

  test('findings are listed worst first', () => {
    const two = (i: number, p: Record<string, Pt>) => {
      if (i >= 5 && i < 11) p.r_wrist = turn(p.r_wrist!, p.r_elbow!, 25);
      if (i >= 30 && i < 36) p.l_wrist = turn(p.l_wrist!, p.l_elbow!, -60);
    };
    const c = run(makeSeq(48, two));
    expect(c.findings.map((f) => f.subject)).toEqual(['arm_l/sleeve_l1', 'arm_r/sleeve_r1']);
  });
});

describe('arms: hand visibility (reference ≥ 0.6 while render < 0.4)', () => {
  const hands = (where: string, r: (i: number) => number): HandScores => ({
    where, times: makeSeq(48).frames.map((f) => f.t), r: Array.from({ length: 48 }, (_, i) => r(i)), l: Array.from({ length: 48 }, () => 0.8),
  });
  test('from the hand points: a hand seen in the video and hidden in the render for 10 frames is a finding, fix class depth', () => {
    const c = run(makeSeq(48), { hands: { reference: hands('rh', () => 0.8), render: hands('nh', (i) => (i >= 10 && i < 20 ? 0.2 : 0.8)) } });
    expect(c.findings.length).toBe(1);
    const f = c.findings[0]!;
    expect([f.measure, f.subject, f.fix]).toEqual(['visibility', 'hand_r', 'depth']);
    expect(f.frames).toEqual([10, 19]);
    expect(f.worst.reference).toBeCloseTo(0.8, 6);
    expect(f.worst.render).toBeCloseTo(0.2, 6);
    expect(summaryLine(c.units.find((u) => u.unit === 'arms')!, c.times)).toContain('from hand points');
  });
  test('the bars: render at 0.4 or reference at 0.59 is not a finding', () => {
    expect(run(makeSeq(48), { hands: { reference: hands('rh', () => 0.8), render: hands('nh', (i) => (i >= 10 && i < 20 ? 0.4 : 0.8)) } }).findings).toEqual([]);
    expect(run(makeSeq(48), { hands: { reference: hands('rh', () => 0.59), render: hands('nh', (i) => (i >= 10 && i < 20 ? 0.1 : 0.8)) } }).findings).toEqual([]);
  });
  test('without hands files it reads the wrist scores, and the summary line says so', () => {
    const c = run(makeSeq(48, (i, _p, s) => {
      if (i >= 10 && i < 20) s.l_wrist = 0.3;
    }));
    expect(c.findings.map((f) => [f.subject, f.points[0]])).toEqual([['hand_l', 'l_wrist']]);
    expect(summaryLine(c.units.find((u) => u.unit === 'arms')!, c.times)).toContain('from wrist scores (no --reference-hands/--render-hands');
  });
});

// --- head, body, legs -----------------------------------------------------------

describe('head: eye-line tilt (bar > 15°)', () => {
  const tilt = (deg: number): Edit => (i, p) => {
    if (i >= 12 && i < 20) {
      const c: Pt = [(p.r_eye![0] + p.l_eye![0]) / 2, p.r_eye![1]];
      p.r_eye = turn(p.r_eye!, c, deg);
      p.l_eye = turn(p.l_eye!, c, deg);
    }
  };
  test('20° for 8 frames is a finding; 10° is not', () => {
    const c = run(makeSeq(48, tilt(20)));
    expect(c.findings.map((f) => [f.unit, f.measure, f.frames])).toEqual([['head', 'tilt', [12, 19]]]);
    expect(c.findings[0]!.worst.figure).toBeCloseTo(20, 6);
    expect(c.findings[0]!.fix).toBeNull();
    expect(run(makeSeq(48, tilt(10))).findings).toEqual([]);
  });
});

describe('body: torso length and hip travel (the render\'s range under 0.5 × the reference\'s)', () => {
  test('a render with no bounce is one summary finding per measure, over the whole run, fix class motion', () => {
    const c = run(makeSeq(48, undefined, false));
    const body = c.findings.filter((f) => f.unit === 'body');
    expect(body.map((f) => [f.measure, f.frames])).toEqual([['torsoLength', [0, 47]], ['hipTravel', [0, 47]]]);
    expect(body.every((f) => f.fix === 'motion' && f.worst.render === 0)).toBe(true);
    // Nothing else moved enough to cross a bar.
    expect(c.findings.length).toBe(2);
  });
  test('a render with 60% of the bounce is not', () => {
    const ref = makeSeq(48);
    const ren = makeSeq(48, (i, p) => {
      const r = figure(i, true);
      const f0 = figure(i, false);
      for (const k of Object.keys(p)) p[k] = [f0[k]![0], f0[k]![1] + 0.6 * (r[k]![1] - f0[k]![1])];
    }, false);
    const c = run(ren, {}, ref);
    expect(c.findings).toEqual([]);
    const t = c.units.find((u) => u.unit === 'body')!.measures[0]!.ranges!.torso!;
    expect(t.render / t.reference).toBeCloseTo(0.6, 1);
  });
});

describe('legs: foot plant (render > 0.05 while reference < 0.02 hip widths per frame)', () => {
  test('an ankle sliding ±5 px (0.125 hip widths per frame) where the reference stands still is a finding, fix class motion', () => {
    const c = run(makeSeq(48, (i, p) => {
      if (i >= 30 && i < 38) p.r_ankle = [p.r_ankle![0] + (i % 2 === 0 ? 5 : -5), p.r_ankle![1]];
    }));
    expect(c.findings.map((f) => [f.unit, f.measure, f.subject, f.frames, f.fix])).toEqual([['legs', 'footPlant', 'foot_r', [30, 38], 'motion']]);
    expect(c.findings[0]!.worst.figure).toBeCloseTo(10 / 80, 6);
  });
  test('the same slide where the reference moves too is not', () => {
    const slide: Edit = (i, p) => {
      if (i >= 30 && i < 38) p.r_ankle = [p.r_ankle![0] + (i % 2 === 0 ? 5 : -5), p.r_ankle![1]];
    };
    expect(run(makeSeq(48, slide), {}, makeSeq(48, slide)).findings).toEqual([]);
  });
  test('a shin turned 30° for 6 frames is a legs direction finding', () => {
    const c = run(makeSeq(48, (i, p) => {
      if (i >= 5 && i < 11) p.l_ankle = turn(p.l_ankle!, p.l_knee!, 30);
    }));
    expect(c.findings.filter((f) => f.measure === 'direction').map((f) => [f.unit, f.subject, f.frames])).toEqual([['legs', 'leg_l/leg_l1', [5, 10]]]);
  });
});

// --- cloth -----------------------------------------------------------------------

describe('cloth: #34\'s figures against the reference\'s bands', () => {
  const N = 240;
  /** Hips swaying ±0.5 hip widths at 0.8 Hz; the hem follows `lag` frames later at `gain` times the hip's travel. */
  const x = (k: number) => 0.5 * Math.sin(2 * Math.PI * 0.8 * (k / FPS));
  const track = (where: string, gain: number, lag: number, unit: ClothTrack['unit'] = 'picture px', hipWidth = 80): ClothTrack => ({
    where, unit, hipWidth,
    times: Array.from({ length: N }, (_, i) => Math.round((i / FPS) * 1e5) / 1e5),
    hip: Array.from({ length: N }, (_, i) => x(i)),
    hem: Array.from({ length: N }, (_, i) => gain * x(i - lag)),
  });
  const windows = [{ name: 'A', from: 1, to: 9 }];
  test('the reference against itself is in every band; a hem that only follows the hips (ratio 1, not 2) is a swing-ratio finding, fix class rig', () => {
    const seq = makeSeq(N);
    const same = run(seq, { cloth: { reference: track('cr', 2, 1), render: track('cr', 2, 1), windows } }, seq);
    expect(same.findings).toEqual([]);
    expect(same.cloth!.windows[0]!.reference.swingRatio).toBeCloseTo(2, 1);
    const c = run(seq, { cloth: { reference: track('cr', 2, 1), render: track('cn', 1, 1), windows } }, seq);
    const swing = c.findings.filter((f) => f.measure === 'swingRatio');
    expect(swing.map((f) => [f.unit, f.subject, f.fix])).toEqual([['cloth', 'window A', 'rig']]);
    expect(swing[0]!.worst.render).toBeCloseTo(1, 1);
    expect(c.findings.some((f) => f.measure === 'lag')).toBe(false);
  });
  test('a hem 4 frames late is a lag finding', () => {
    const seq = makeSeq(N);
    const c = run(seq, { cloth: { reference: track('cr', 2, 1), render: track('cn', 2, 4), windows } }, seq);
    expect(c.findings.filter((f) => f.measure === 'lag').map((f) => f.subject)).toEqual(['window A']);
  });
  test('a render track in rig world units is carried by the retarget\'s scale, and refused without it', () => {
    const seq = makeSeq(N);
    const cloth = { reference: track('cr', 2, 1, 'picture px', 128.1), render: track('cn', 2, 1, 'rig world units', 92.202), windows };
    expect(() => run(seq, { cloth }, seq)).toThrow('COMPARE_CLOTH_SCALE');
    const c = run(seq, { cloth, retargetScale: 0.5415153605535532 }, seq);
    // HQ's skirt criteria, Revision 1: 0.2 reference hip widths is 0.1505 of the rig's.
    expect(c.cloth!.stroke.render).toBeCloseTo(0.2 * 128.1 * 0.5415153605535532 / 92.202, 9);
    expect(c.cloth!.stroke.render).toBeCloseTo(0.1505, 4);
  });
  test('the pieces match numpy: gradient, the parabola-refined lag, the wiggle dropped as a pair', () => {
    expect(gradient([0, 1, 4, 9])).toEqual([1, 2, 4, 5]);
    const x = Array.from({ length: 80 }, (_, i) => Math.sin(i / 4));
    const y = Array.from({ length: 80 }, (_, i) => Math.sin((i - 2) / 4));
    // HQ's metrics.py (numpy) on the same input: (2.148801697553295, 1.0089193091278477); the parabola is a sub-frame estimate, not exact.
    expect(xcorrLag(x, y).lag).toBeCloseTo(2.148801697553295, 9);
    expect(xcorrLag(x, y).peak).toBeCloseTo(1.0089193091278477, 9);
    // A wiggle between the turns at 3 and 10 (under 0.2) is dropped as a pair; metrics.py gives [3, 10] too.
    const hip = [0, 0.5, 0.9, 1, 0.9, 0.85, 0.88, 0.9, 0.5, 0.2, 0, 0.3, 0.6];
    expect(reversals(hip, 0, hip.length, 0.2)).toEqual([3, 10]);
    const f = clothFigures(Array.from({ length: 100 }, (_, i) => Math.sin(i / 5)), Array.from({ length: 100 }, (_, i) => 2 * Math.sin(i / 5)), 10, 90, 0.2);
    expect(f.swingRatio).toBeCloseTo(2, 2);
    expect(f.lag).toBeCloseTo(0, 6);
  });
});

// --- the command ------------------------------------------------------------------

describe('rig-pose compare on the command line', () => {
  const cli = (...args: string[]) => spawnSync('bun', [CLI, 'compare', ...args], { encoding: 'utf8' });
  function files(render: SeqDoc, reference: SeqDoc = makeSeq(48)) {
    const d = tempDir();
    const ref = join(d, 'ref.json');
    const ren = join(d, 'ren.json');
    const mp = join(d, 'map.json');
    writeFileSync(ref, JSON.stringify(reference));
    writeFileSync(ren, JSON.stringify(render));
    writeFileSync(mp, JSON.stringify(MAP));
    return { d, args: ['--reference', ref, '--render', ren, '--map', mp] };
  }

  test('a finding exits 0, prints a summary line per unit and the finding, and writes the report and the sheet', () => {
    const { d, args } = files(makeSeq(48, forearm(30, 20, 6)));
    const r = cli(...args, '--report', join(d, 'c.json'), '--sheet', join(d, 's.png'));
    expect(r.status).toBe(0);
    for (const u of ['HEAD', 'ARMS', 'BODY', 'LEGS', 'CLOTH']) expect(r.stdout).toContain(`  ${u.padEnd(6)} `);
    expect(r.stdout).toContain('  ARMS   1 finding — direction (4 segments): 1 finding, worst 30.0°');
    expect(r.stdout).toMatch(/FIND {3}arms direction arm_r\/sleeve_r1 \(r_elbow → r_wrist\) — worst 30\.0°.*frames 20–25.*fix: rig/);
    const rep = JSON.parse(readFileSync(join(d, 'c.json'), 'utf8')) as { spec: string; findings: Array<{ subject: string; frames: number[] }>; bars: typeof BARS };
    expect(rep.spec).toBe('rig-pose-compare/1');
    expect(rep.findings.map((f) => [f.subject, f.frames])).toEqual([['arm_r/sleeve_r1', [20, 25]]]);
    expect(rep.bars.armDirection).toBe(20);
    const png = readFileSync(join(d, 's.png'));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }, 30_000);

  test('the control exits 0 with 0 findings and writes no sheet', () => {
    const seq = makeSeq(48);
    const { d, args } = files(seq, seq);
    const r = cli(...args, '--sheet', join(d, 's.png'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('  0 finding(s)');
    expect(existsSync(join(d, 's.png'))).toBe(false);
  }, 30_000);

  test('refused by name: frame counts differ', () => {
    const { args } = files(makeSeq(47));
    const r = cli(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('COMPARE_FRAMES: the reference');
    expect(r.stderr).toContain('has 48 frame(s) and the render');
  }, 30_000);

  test('refused by name: times more than 1 ms apart (and 0.5 ms is one time base)', () => {
    const late = files(makeSeq(48, undefined, true, 0.002));
    const r = cli(...late.args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('COMPARE_TIMES');
    expect(r.stderr).toContain('frame 47');
    expect(cli(...files(makeSeq(48, undefined, true, 0.0005)).args).status).toBe(0);
  }, 30_000);

  test('refused by name: a map segment\'s joint on no frame of one side', () => {
    const noWrist = makeSeq(48);
    for (const f of noWrist.frames) f.people[0]!.joints.r_wrist = { state: 'missing' };
    const r = cli(...files(noWrist).args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('COMPARE_JOINT_MISSING: chain "arm_r" bone "sleeve_r1" (r_elbow → r_wrist): "r_wrist" has a position on no frame of the render');
  }, 30_000);

  test('refused by name: an unreadable retarget report, hands file and cloth track — all in one run', () => {
    const { d, args } = files(makeSeq(48));
    writeFileSync(join(d, 'rep.json'), '{ not json');
    writeFileSync(join(d, 'h.json'), JSON.stringify({ frames: [{ t: 0, points: [[1, 2, 3]] }] }));
    writeFileSync(join(d, 'c.json'), JSON.stringify({ frames: [{ t: 0, hem: [1, 2] }] }));
    const r = cli(...args, '--retarget-report', join(d, 'rep.json'), '--reference-hands', join(d, 'h.json'), '--render-hands', join(d, 'h.json'),
      '--cloth-reference', join(d, 'c.json'), '--cloth-render', join(d, 'c.json'), '--cloth-windows', '0.1-1.5');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('COMPARE_REPORT_JSON');
    expect(r.stderr).toContain('COMPARE_HANDS');
    expect(r.stderr).toContain('COMPARE_CLOTH');
  }, 30_000);

  test('cloth tracks in HQ\'s rig-c-cloth-track/0 are read; the control finds nothing in the cloth unit either', () => {
    const seq = makeSeq(48);
    const { d, args } = files(seq, seq);
    const frames = seq.frames.map((f, i) => ({ i, t: f.t, hip_x: 0.5 * Math.sin(i / 3), hip_y: 0, hip_w: 1, tilt_deg: 0, hem_mid: Math.sin((i - 1) / 3), hem_l: -1, hem_r: 1 }));
    writeFileSync(join(d, 'c.json'), JSON.stringify({ spec: 'rig-c-cloth-track/0', fps: 24, frames_count: 48, hipWidth: { median: 80, unit: 'picture px' }, frames }));
    const r = cli(...args, '--cloth-reference', join(d, 'c.json'), '--cloth-render', join(d, 'c.json'), '--cloth-windows', '0.1-1.9');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('  CLOTH  0 findings — lag: 0 findings');
    expect(r.stdout).toContain('  CLOTH  window A 0.1–1.9s (frames 2–45)');
  }, 30_000);

  test('a retarget report of another run is refused', () => {
    const { d, args } = files(makeSeq(48));
    writeFileSync(join(d, 'rep.json'), JSON.stringify({ spec: 'rig-pose-report/1', frames: 313, switches: [] }));
    const r = cli(...args, '--retarget-report', join(d, 'rep.json'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('it is the report of another run');
  }, 30_000);

  test('usage (exit 2): one side\'s hands without the other\'s, cloth without windows, a bad window', () => {
    const { d, args } = files(makeSeq(48));
    writeFileSync(join(d, 'x.json'), '{}');
    const one = cli(...args, '--reference-hands', join(d, 'x.json'));
    expect(one.status).toBe(2);
    expect(one.stderr).toContain('--reference-hands is given without --render-hands');
    expect(cli(...args, '--cloth-reference', join(d, 'x.json'), '--cloth-render', join(d, 'x.json')).status).toBe(2);
    const bad = cli(...args, '--cloth-reference', join(d, 'x.json'), '--cloth-render', join(d, 'x.json'), '--cloth-windows', '5-2');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('does not end after it starts');
  }, 30_000);
});
