/**
 * rig-c/pose#281: derived depth per limb segment — `clean --depth walk|run`
 * writes it, tools/skeleton.ts colours the segments by it, and `retarget
 * --report` orders the limbs front to back by it (`layers`).
 *
 * The fixtures are made in 3D from joint angles (examples/walk/make-depth.ts):
 * a frontal run in place (the swinging shin kicked back to 0.41 of its length),
 * a frontal walk (the lifted foot forward), and the run seen from the side. The
 * generator knows every joint's true depth, so it is the hand-read table the
 * derived depth is held to. The bars (the card): (1) on the run, every frame
 * whose shin reads ≤ 0.5 of its rest length carries sign − (kicked back) on
 * every stride, and the same drawing cleaned as a walk carries +; (2) on the
 * side view every ratio is within 0.95–1.05, sign 0, drawn neutral; (3) the
 * report's `layers` agrees with the generator's front/back on ≥ 90 % of frames,
 * the disagreeing frames listed; (4) without `--depth` nothing changes (the
 * sha256 table against main is the PR's evidence; here, the control's bytes).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { depthCycle, depthDoc, FIXTURES, LIMBS as TRUE_LIMBS, STRIDE, trueOrder, type DepthFrame, type Limb } from '../examples/walk/make-depth.ts';
import { clean } from '../src/clean.ts';
import { deriveDepth, FLAT_BAND, LIMB_NAMES } from '../src/depth.ts';
import { DEPTH_SEGMENTS, personTrack, readPoseSequence, writePoseSequence, type DepthSegment, type FrameDepth, type PoseSequence } from '../src/pose.ts';
import { AWAY, drawSkeleton, FLAT, legendBox, legendScale, TOWARD } from '../tools/skeleton.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const RIG = join(ROOT, 'examples', 'wave', 'rig');
const MAP = join(ROOT, 'examples', 'walk', 'map.json');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const SLOW = 120_000;
/** Bar (1)'s line: a shin at or under this share of its rest length is foreshortened past doubt. */
const SHORT = 0.5;
/** Bar (3)'s line. */
const LAYERS_BAR = 0.9;

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-depth-'));
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
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const linesOf = (r: Ran, tag: string): string[] => r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(tag));

/** A fixture through `rig-pose clean --loop --legs 1 --rest 1 --hold off [--depth gait]`: the run, the cleaned file's path and text. */
function cleaned(frames: DepthFrame[], gait: 'walk' | 'run' | null, dir = tempDir(), name = 'fixture'): { ran: Ran; path: string; text: string } {
  const raw = join(dir, `${name}.json`);
  writeFileSync(raw, JSON.stringify(depthDoc(frames, 'examples/walk/make-depth.ts (test/depth.test.ts)')));
  const path = join(dir, `${name}.clean.json`);
  const ran = cli(['clean', '--pose', raw, '--out', path, '--loop', '--legs', '1', '--rest', '1', '--hold', 'off', ...(gait === null ? [] : ['--depth', gait])]);
  return { ran, path, text: ran.status === 0 ? readFileSync(path, 'utf8') : '' };
}
const seqOf = (text: string): PoseSequence => readPoseSequence(text, 'fixture');

/** Frame runs as text: "3–5, 9". */
const runs = (fs: readonly number[]): string => {
  const out: Array<[number, number]> = [];
  for (const f of fs) {
    const last = out[out.length - 1];
    if (last !== undefined && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
};

/** The midpoint of a segment on the rendered plate, px. */
function midpoint(seq: PoseSequence, i: number, s: DepthSegment, height: number): [number, number] {
  const j = personTrack(seq, undefined, 'fixture')[i]!;
  const [a, b] = DEPTH_SEGMENTS[s];
  const k = height / seq.height;
  return [Math.round(((j[a]!.at![0] + j[b]!.at![0]) / 2) * k), Math.round(((j[a]!.at![1] + j[b]!.at![1]) / 2) * k)];
}
const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);

describe('bar (1): the run\'s kicked-back shin reads away (−) on every stride, and the same drawing as a walk reads toward (+)', () => {
  test('every frame whose shin is ≤ 0.5 of its rest length carries sign −1 under --depth run and +1 under --depth walk; the generator\'s table agrees with the run; drawn cool and warm', () => {
    const truth = FIXTURES.run();
    const run = cleaned(truth, 'run');
    expect(run.ran.stderr).toBe('');
    expect(run.ran.status).toBe(0);
    const walk = cleaned(truth, 'walk');
    expect(walk.ran.status).toBe(0);
    const sr = seqOf(run.text);
    const sw = seqOf(walk.text);
    expect(JSON.parse(run.text).spec).toBe('rig-pose-sequence/1.2');
    expect(sr.cleaned!.params.depth).toEqual({ gait: 'run' });
    const P = STRIDE.run;
    const table: string[] = ['| frame | stride | shin | ratio | --depth run | --depth walk | generator |', '| --- | --- | --- | --- | --- | --- | --- |'];
    const perStride = new Map<string, number>();
    let short = 0;
    for (const side of ['r', 'l'] as const) {
      const s = `${side}_shin` as DepthSegment;
      sr.frames.forEach((f, i) => {
        const d = f.depth![s]!;
        if (d.ratio > SHORT) return;
        short++;
        const stride = Math.floor(i / P);
        perStride.set(`${side} ${stride}`, (perStride.get(`${side} ${stride}`) ?? 0) + 1);
        table.push(`| ${i} | ${stride} | ${s} | ${d.ratio.toFixed(3)} | ${d.sign} | ${sw.frames[i]!.depth![s]!.sign} | ${truth[i]!.truth[s].sign} |`);
        expect(d.sign).toBe(-1);
        expect(sw.frames[i]!.depth![s]!.sign).toBe(1);
        expect(truth[i]!.truth[s].sign).toBe(-1);
        // Drawn: the run's shin cool, the walk's warm.
        const [x, y] = midpoint(sr, i, s, 480);
        expect(same(drawSkeleton(personTrack(sr, undefined, 'fixture')[i]!, sr, { height: 480, minScore: 0.3 }, f.depth).get(x, y), AWAY)).toBe(true);
        expect(same(drawSkeleton(personTrack(sw, undefined, 'fixture')[i]!, sw, { height: 480, minScore: 0.3 }, sw.frames[i]!.depth).get(x, y), TOWARD)).toBe(true);
      });
    }
    console.log(`  #281 bar 1 — the run's shins at ratio ≤ ${SHORT} (${short} shin-frames):\n${table.join('\n')}`);
    // Every stride of each leg has such frames, and the smallest ratio is the card's 0.41.
    for (const side of ['r', 'l']) for (let k = 0; k < 3; k++) expect(perStride.get(`${side} ${k}`) ?? 0).toBeGreaterThan(0);
    const least = Math.min(...sr.frames.flatMap((f) => [f.depth!.r_shin!.ratio, f.depth!.l_shin!.ratio]));
    expect(least).toBeGreaterThan(0.4);
    expect(least).toBeLessThan(0.42);
  });

  test('the walk: the lifted foot comes forward, and every shin the generator says is toward reads + (and none reads −)', () => {
    const truth = FIXTURES.walk();
    const w = cleaned(truth, 'walk');
    expect(w.ran.status).toBe(0);
    const seq = seqOf(w.text);
    const toward: number[] = [];
    for (const side of ['r', 'l'] as const) {
      const s = `${side}_shin` as DepthSegment;
      seq.frames.forEach((f, i) => {
        expect(f.depth![s]!.sign).not.toBe(-1);
        if (truth[i]!.truth[s].sign === 1) {
          toward.push(i);
          expect(f.depth![s]!.sign).toBe(1);
        }
      });
    }
    console.log(`  #281 walk: ${toward.length} shin-frames the generator draws toward the camera, every one read +`);
    expect(toward.length).toBeGreaterThan(0);
  });

  test('from behind the same run reads the other way: the trunk faces away, so the kicked-back shin comes toward the camera', () => {
    const truth = depthCycle('run', 'back', 1);
    const seq = seqOf(cleaned(truth, 'run').text);
    let n = 0;
    seq.frames.forEach((f, i) => {
      for (const s of ['r_shin', 'l_shin'] as const) {
        if (f.depth![s]!.ratio > SHORT) continue;
        n++;
        expect(f.depth![s]!.sign).toBe(1);
        expect(truth[i]!.truth[s].sign).toBe(1);
      }
    });
    expect(n).toBeGreaterThan(0);
  });
});

describe('bar (2): the side view is flat', () => {
  test('every ratio within 0.95–1.05, every sign 0, every depth segment drawn neutral (no warm or cool pixel on any frame)', () => {
    const truth = FIXTURES.side();
    const c = cleaned(truth, 'run');
    expect(c.ran.status).toBe(0);
    const seq = seqOf(c.text);
    const track = personTrack(seq, undefined, 'fixture');
    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    seq.frames.forEach((f, i) => {
      const plate = drawSkeleton(track[i]!, seq, { height: 480, minScore: 0.3 }, f.depth);
      for (const s of Object.keys(DEPTH_SEGMENTS) as DepthSegment[]) {
        const d = f.depth![s]!;
        n++;
        lo = Math.min(lo, d.ratio);
        hi = Math.max(hi, d.ratio);
        expect(d.sign).toBe(0);
      }
      // Drawn: no warm or cool pixel anywhere outside the legend, and the limbs neutral (a side view overlaps the two
      // sides, so a joint's disc may cover a segment's midpoint; the whole plate is read instead).
      const [lx, ly, lw, lh] = legendBox(legendScale(480), false);
      let flat = 0;
      let coloured = 0;
      for (let y = 0; y < plate.height; y++) for (let x = 0; x < plate.width; x++) {
        if (x >= lx && x < lx + lw && y >= ly && y < ly + lh) continue;
        const c = plate.get(x, y);
        if (same(c, TOWARD) || same(c, AWAY)) coloured++;
        else if (same(c, FLAT)) flat++;
      }
      expect(coloured).toBe(0);
      expect(flat).toBeGreaterThan(0);
    });
    console.log(`  #281 bar 2 — side view: ${n} segment-frames, ratio ${lo.toFixed(3)}–${hi.toFixed(3)}, every sign 0`);
    expect(lo).toBeGreaterThanOrEqual(FLAT_BAND[0]);
    expect(hi).toBeLessThanOrEqual(FLAT_BAND[1]);
  }, SLOW);
});

interface Layer {
  frame: number;
  t: number;
  order: Limb[][];
  depth: Partial<Record<Limb, number>>;
}
/** Bar (3)'s reading: the frames whose report order contradicts the generator's on some pair it orders. */
function disagreements(truth: DepthFrame[], layers: Layer[]): string[] {
  const out: string[] = [];
  layers.forEach((l, i) => {
    const pos = new Map<Limb, number>();
    l.order.forEach((g, k) => g.forEach((x) => pos.set(x, k)));
    const wrong: string[] = [];
    const names = Object.keys(TRUE_LIMBS) as Limb[];
    for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
      const [A, B] = [names[a]!, names[b]!];
      const t = trueOrder(truth[i]!, A, B);
      if (t === 0) continue;
      const d = Math.sign(pos.get(B)! - pos.get(A)!);
      if (d !== t) wrong.push(`${A}/${B}: generator ${t > 0 ? A : B} in front by ${Math.abs(truth[i]!.limb[A] - truth[i]!.limb[B]).toFixed(1)} px, derived ${d === 0 ? 'tied' : `${d > 0 ? A : B} in front`} (${l.depth[A]} vs ${l.depth[B]})`);
    }
    if (wrong.length > 0) out.push(`frame ${i}: ${wrong.join('; ')}`);
  });
  return out;
}

describe('bar (3): retarget --report orders the limbs front to back (layers), and the order agrees with the generator', () => {
  for (const name of ['run', 'walk'] as const) {
    test(`${name}: layers on every frame, ≥ 90 % agreeing with the generator, the rest listed; a DEPTH line`, () => {
      const dir = tempDir();
      const truth = FIXTURES[name]();
      const c = cleaned(truth, name, dir);
      expect(c.ran.status).toBe(0);
      const report = join(dir, 'report.json');
      const r = cli(['retarget', '--rig', RIG, '--map', MAP, '--sequence', c.path, '--out', join(dir, 'm.json'), '--name', name, '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const line = linesOf(r, 'DEPTH');
      expect(line).toHaveLength(1);
      expect(line[0]).toMatch(new RegExp(`^DEPTH  layers from the sequence's derived depth \\(clean --depth ${name}\\): the limbs ordered front to back on ${truth.length} of ${truth.length} frame\\(s\\); in front alone: r_arm \\d+, l_arm \\d+, r_leg \\d+, l_leg \\d+; tied in front on \\d+ \\(the report's layers\\)$`));
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { layers: Layer[]; frameTimes: number[] };
      expect(rep.layers).toHaveLength(truth.length);
      rep.layers.forEach((l, i) => {
        expect(l.frame).toBe(i);
        expect(l.t).toBe(rep.frameTimes[i]!);
        expect(l.order.flat().sort()).toEqual([...LIMB_NAMES].sort());
      });
      const bad = disagreements(truth, rep.layers);
      const share = 1 - bad.length / truth.length;
      console.log(`  #281 bar 3 — ${name}: layers agree with the generator on ${truth.length - bad.length} of ${truth.length} frames (${(100 * share).toFixed(1)} %)${bad.length > 0 ? `; disagreeing:\n    ${bad.join('\n    ')}` : ''}`);
      expect(share).toBeGreaterThanOrEqual(LAYERS_BAR);
    }, SLOW);
  }
});

describe('bar (4): without --depth nothing changes', () => {
  test('control: clean without --depth writes /1 with no depth (the same bytes as before the flag existed), and retarget prints no DEPTH and writes no layers', () => {
    const dir = tempDir();
    const truth = FIXTURES.run();
    const plain = cleaned(truth, null, dir, 'plain');
    expect(plain.ran.status).toBe(0);
    expect(linesOf(plain.ran, 'DEPTH')).toEqual([]);
    const doc = JSON.parse(plain.text) as { spec: string; frames: Array<Record<string, unknown>>; cleaned: { params: Record<string, unknown> } };
    expect(doc.spec).toBe('rig-pose-sequence/1');
    expect(doc.frames.some((f) => 'depth' in f)).toBe(false);
    expect('depth' in doc.cleaned.params).toBe(false);
    // The in-process clean without the field writes the same bytes.
    const seq = readPoseSequence(JSON.stringify(depthDoc(truth, 'examples/walk/make-depth.ts (test/depth.test.ts)')), 'fixture');
    expect(writePoseSequence(clean(seq, { loop: true, legs: 1, rest: 1, hold: 'off' }, undefined, 'fixture').seq)).toBe(plain.text);
    const report = join(dir, 'report.json');
    const r = cli(['retarget', '--rig', RIG, '--map', MAP, '--sequence', plain.path, '--out', join(dir, 'm.json'), '--name', 'run', '--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'DEPTH')).toEqual([]);
    expect('layers' in (JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>)).toBe(false);
    // The motion is the same with and without depth: depth orders layers, it keys nothing.
    const deep = cleaned(truth, 'run', dir, 'deep');
    const r2 = cli(['retarget', '--rig', RIG, '--map', MAP, '--sequence', deep.path, '--out', join(dir, 'm2.json'), '--name', 'run']);
    expect(r2.status).toBe(0);
    expect(readFileSync(join(dir, 'm2.json'), 'utf8')).toBe(readFileSync(join(dir, 'm.json'), 'utf8'));
  }, SLOW);
});

describe('the format: rig-pose-sequence/1.2', () => {
  const base = (): PoseSequence => seqOf(cleaned(depthCycle('run', 'front', 1), null).text);
  const refusal = (doc: unknown): string[] => {
    try {
      readPoseSequence(JSON.stringify(doc), 'p.json');
      return [];
    } catch (e) {
      return (e as Error).message.split('\n');
    }
  };
  const measured = (seq: PoseSequence): PoseSequence => ({ ...seq, frames: seq.frames.map((f) => ({ ...f, depth: { r_shin: { ratio: 0.5, sign: 1, source: 'measured' } } as FrameDepth })) });

  test('written /1.2 exactly when the frames carry depth — with the pelvis track too — and read back to the same bytes', () => {
    const seq = base();
    expect(JSON.parse(writePoseSequence(seq)).spec).toBe('rig-pose-sequence/1');
    const deep = measured(seq);
    const text = writePoseSequence(deep);
    expect(JSON.parse(text).spec).toBe('rig-pose-sequence/1.2');
    expect(writePoseSequence(readPoseSequence(text, 'p.json'))).toBe(text);
    // 1.2 includes 1.1's keys: a sequence with both is /1.2; the track alone stays /1.1.
    const both = { ...deep, pelvisSource: 'keys' as const, cleaned: { ...deep.cleaned!, params: { ...deep.cleaned!.params, pelvis: { window: 1 } } }, frames: deep.frames.map((f) => ({ ...f, pelvisTilt: 0 })) };
    const bothText = writePoseSequence(both);
    expect(JSON.parse(bothText).spec).toBe('rig-pose-sequence/1.2');
    expect(writePoseSequence(readPoseSequence(bothText, 'p.json'))).toBe(bothText);
    const track = { ...both, frames: both.frames.map(({ depth: _d, ...f }) => f) };
    expect(JSON.parse(writePoseSequence(track)).spec).toBe('rig-pose-sequence/1.1');
  });

  test('planted: depth in a /1 or /1.1 file is refused naming 1.2; a partial, malformed or mixed depth is refused by name; derived depth with no record of clean deriving it is refused', () => {
    const doc = JSON.parse(writePoseSequence(measured(base()))) as { spec: string; frames: Array<Record<string, unknown>>; cleaned: { params: Record<string, unknown> } };
    for (const spec of ['rig-pose-sequence/1', 'rig-pose-sequence/1.1']) {
      expect(refusal({ ...doc, spec })).toEqual([`POSE_SPEC: p.json ${doc.frames.length} frames (0–${doc.frames.length - 1}) carries "depth", a key of "rig-pose-sequence/1.2", and the file says "${spec}"; a sequence carrying depth is written as "rig-pose-sequence/1.2" (rig-pose clean --depth)`]);
    }
    expect(refusal(doc)).toEqual([]);
    const bad = structuredClone(doc);
    delete bad.frames[3]!.depth;
    bad.frames[4]!.depth = { r_shin: { ratio: -1, sign: 2, source: 'guessed' }, r_toe: {} };
    expect(refusal(bad)).toEqual([
      'POSE_DEPTH: p.json frames[4] "depth" "r_shin" "ratio" is number -1; it must be a finite number ≥ 0 (the segment\'s drawn length ÷ its rest length)',
      'POSE_DEPTH: p.json frames[4] "depth" "r_shin" "sign" is number 2; it must be 1 (the distal joint nearer the camera), -1 (farther) or 0 (flat, or not decided)',
      'POSE_DEPTH: p.json frames[4] "depth" "r_shin" "source" is the string "guessed"; it must be "derived" (clean --depth, from the picture\'s lengths) or "measured" (a 3D detector)',
      'POSE_DEPTH: p.json frames[4] "depth" names "r_toe"; the segments are r_upper_arm, r_forearm, r_thigh, r_shin, l_upper_arm, l_forearm, l_thigh, l_shin',
      `POSE_DEPTH: p.json has "depth" on ${doc.frames.length - 1} frame(s) and none on frame(s) 3; a sequence with depth carries it on every frame (an empty object where no segment is placed)`,
    ]);
    const mixed = structuredClone(doc);
    (mixed.frames[2]!.depth as Record<string, { source: string }>).r_shin!.source = 'derived';
    expect(refusal(mixed)).toEqual(['POSE_DEPTH: p.json carries "derived" and "measured" depth together; a sequence\'s depth comes from one source — clean --depth derives it, a 3D detector measures it']);
    const derived = structuredClone(doc);
    for (const f of derived.frames) (f.depth as Record<string, { source: string }>).r_shin!.source = 'derived';
    expect(refusal(derived)).toEqual(['POSE_DEPTH: p.json carries "derived" depth and its "cleaned" record has no "params" "depth"; derived depth is written by rig-pose clean --depth walk|run, which records the gait it was read for']);
  });

  test('measured depth (a 3D detector\'s) is read, carried through a clean without --depth, and refused with it; derived depth is read again only with --depth', () => {
    const dir = tempDir();
    const m = join(dir, 'm.json');
    writeFileSync(m, writePoseSequence(measured(base())));
    const carried = cli(['clean', '--pose', m, '--out', join(dir, 'c.json'), '--legs', '1', '--rest', '1', '--hold', 'off']);
    expect(carried.status).toBe(0);
    expect(linesOf(carried, 'DEPTH')).toEqual(['DEPTH  measured depth (a 3D detector\'s) carried through as read']);
    expect(seqOf(readFileSync(join(dir, 'c.json'), 'utf8')).frames.every((f) => f.depth!.r_shin!.source === 'measured')).toBe(true);
    const refused = cli(['clean', '--pose', m, '--out', join(dir, 'd.json'), '--depth', 'run']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`CLEAN_DEPTH: ${m} carries measured depth (a 3D detector's) and --depth run asks to derive it; a derived reading would replace a measurement — clean without --depth, which carries the measured depth through`);
    const deep = cleaned(depthCycle('run', 'front', 1), 'run', dir, 'deep');
    const again = cli(['clean', '--pose', deep.path, '--out', join(dir, 'e.json'), '--legs', '1', '--rest', '1', '--hold', 'off']);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(`CLEAN_DEPTH: ${deep.path} carries derived depth (clean --depth), read off positions this clean moves; give --depth walk|run to read it again on the cleaned positions`);
    expect(cli(['clean', '--pose', deep.path, '--out', join(dir, 'f.json'), '--legs', '1', '--rest', '1', '--hold', 'off', '--depth', 'run']).status).toBe(0);
  });

  test('--depth takes walk or run; anything else is a usage error (exit 2)', () => {
    const dir = tempDir();
    const raw = join(dir, 'raw.json');
    writeFileSync(raw, JSON.stringify(depthDoc(depthCycle('run', 'front', 1), 'test')));
    const r = cli(['clean', '--pose', raw, '--out', join(dir, 'o.json'), '--depth', 'jog']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--depth is "jog"; it must be walk or run');
  });
});

describe('mutants: the sign rule and the layers\' depth, each making its bar red', () => {
  const MUTS = [
    { name: 'the shin\'s gait sign ignored (always forward)', from: "if (kind === 'shin') sense = gait === 'walk' ? 1 : -1;", to: "if (kind === 'shin') sense = 1;", bar: 1 },
    { name: 'the facing ignored (forward always toward the camera)', from: "const sign = (r < FLAT_BAND[0] ? face * sense : 0) as -1 | 0 | 1;", to: "const sign = (r < FLAT_BAND[0] ? sense : 0) as -1 | 0 | 1;", bar: 1 },
    { name: 'the upper arm forward always (no opposition)', from: "sense = own === null || opp === null || Math.min(own, opp) >= FLAT_BAND[0] || own === opp ? 1 : opp < own ? 1 : -1;", to: 'sense = 1;', bar: 3 },
  ];
  for (const mu of MUTS) {
    test(`mutant: ${mu.name}`, async () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm281-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        const path = join(d, 'src', 'depth.ts');
        const src = readFileSync(path, 'utf8');
        expect(src.split(mu.from)).toHaveLength(2);
        writeFileSync(path, src.replace(mu.from, mu.to));
        const m = (await import(path)) as { deriveDepth: typeof deriveDepth; layersOf: (j: unknown, d: FrameDepth) => { order: Limb[][]; depth: Partial<Record<Limb, number>> } };
        if (mu.bar === 1) {
          // Bar (1) on the run (or, for the facing, from behind): some shin at ≤ 0.5 reads against the generator.
          const truth = mu.name.includes('facing') ? depthCycle('run', 'back', 1) : FIXTURES.run();
          const seq = seqOf(cleaned(truth, null).text);
          const track = personTrack(seq, undefined, 'fixture');
          const dd = m.deriveDepth(track, 'run');
          const wrong = dd.frames.flatMap((f, i) => (['r_shin', 'l_shin'] as const).filter((s) => f[s]!.ratio <= SHORT && f[s]!.sign !== truth[i]!.truth[s].sign).map((s) => `${i} ${s}`));
          console.log(`  #281 mutant "${mu.name}": ${wrong.length} shin-frames at ratio ≤ ${SHORT} read against the generator (frames ${runs([...new Set(wrong.map((w) => Number(w.split(' ')[0])))])})`);
          expect(wrong.length).toBeGreaterThan(0);
        } else {
          const truth = FIXTURES.run();
          const seq = seqOf(cleaned(truth, null).text);
          const track = personTrack(seq, undefined, 'fixture');
          const dd = m.deriveDepth(track, 'run');
          const layers = track.map((j, i) => ({ frame: i, t: 0, ...m.layersOf(j, dd.frames[i]!) }));
          const bad = disagreements(truth, layers);
          console.log(`  #281 mutant "${mu.name}": layers agree on ${truth.length - bad.length} of ${truth.length} frames`);
          expect(1 - bad.length / truth.length).toBeLessThan(LAYERS_BAR);
        }
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }
});
