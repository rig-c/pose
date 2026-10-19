/**
 * rig-c/pose#238: retarget's output a person can read. The CLEAN line counts
 * the stillness hold instead of inlining it; a hinge's wrong-way frames are one
 * line (count, frame range, worst angle, the remedy); `--summary` prints one
 * line per measure; `--verbose` prints what the run printed before #238.
 *
 * The inputs are public: the wave example as it is, and the same pose put
 * through `rig-pose clean` at today's defaults, whose stillness hold writes the
 * per-joint record a long CLEAN line came from.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanLine, cleanSummaryLine } from '../src/clean.ts';
import { readPoseSequence } from '../src/pose.ts';
import { bendGroupLine, bendGroups, bendLine, type BendEvent } from '../src/retarget.ts';
import { stanceLines, summaryLines } from '../src/run.ts';
import type { Stance } from '../src/legs.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const SLOW = 120_000;
const RIG = 'examples/wave/rig';
const MAP = 'examples/wave/map.json';
const POSE = 'examples/wave/pose.json';

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}
function cli(args: string[], cliPath = CLI): Ran {
  const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'rig-pose-238-'));
const linesOf = (text: string): string[] => text.split('\n').filter((l) => l !== '');
const tagged = (r: Ran, tag: string): string[] => linesOf(r.stdout).map((l) => l.trim()).filter((l) => l.startsWith(`${tag} `));
const fails = (r: Ran): string[] => linesOf(r.stderr).filter((l) => l.startsWith('FAIL  '));
const longest = (text: string): number => Math.max(...linesOf(text).map((l) => l.length));

/** The wave re-cleaned at today's defaults (the hold on), into a temp dir. */
function heldPose(dir: string): string {
  const out = join(dir, 'wave.held.json');
  const r = cli(['clean', '--pose', POSE, '--out', out]);
  expect(r.status).toBe(0);
  return out;
}
/** The wave's map with the legs' "bend": "free" dropped: the knees read their side off the rest (±3°) and bend the other way on every frame. */
function legsOnRest(dir: string): string {
  const map = JSON.parse(readFileSync(join(ROOT, MAP), 'utf8')) as { chains: Array<Record<string, unknown>> };
  for (const c of map.chains) if (String(c.name).startsWith('leg_')) delete c.bend;
  const out = join(dir, 'map.legs-on-rest.json');
  writeFileSync(out, JSON.stringify(map));
  return out;
}
/** The wave's rig with leg_r's knee straight at rest, so a map that does not state its side is refused (MAP_BEND_SIDE). */
function straightKnee(dir: string): string {
  const rig = JSON.parse(readFileSync(join(ROOT, RIG, 'rig.json'), 'utf8')) as { bones: Array<Record<string, unknown>> };
  for (const b of rig.bones) if (b.name === 'leg_r1') b.rotation = 0;
  const d = join(dir, 'straight-rig');
  mkdirSync(d);
  writeFileSync(join(d, 'rig.json'), JSON.stringify(rig));
  return d;
}
const run = (dir: string, o: { rig?: string; map?: string; pose?: string; extra?: string[] } = {}, cliPath = CLI): Ran =>
  cli(['retarget', '--rig', o.rig ?? RIG, '--map', o.map ?? MAP, '--pose', o.pose ?? POSE, '--out', join(dir, 'out.motion.json'), ...(o.extra ?? [])], cliPath);

/** What a bend refusal must name (#238): the README's remedy for front-facing material, on the chain refused. */
const namesFree = (line: string, chain: string): boolean => line.includes(`state "bend": "free" on chain "${chain}"`) && line.includes('seen from the front');

describe('the default output on the public example (#238)', () => {
  // Measured on this commit's parent: the wave printed 41 lines, the longest 260 characters (a LAND/JITTER line);
  // re-cleaned with the hold on, 41 lines and a CLEAN line of 3021 characters. After: 41 and 260; 41 and 366.
  test('the wave as shipped: at most 41 lines, none longer than 260 characters', () => {
    const d = tempDir();
    try {
      const r = run(d);
      expect(r.status).toBe(0);
      expect(linesOf(r.stdout).length).toBeLessThanOrEqual(41);
      expect(longest(r.stdout)).toBeLessThanOrEqual(260);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('the wave re-cleaned with the hold on: at most 41 lines, the CLEAN line counts the holds and is at most 366 characters', () => {
    const d = tempDir();
    try {
      const pose = heldPose(d);
      const r = run(d, { pose });
      expect(r.status).toBe(0);
      expect(linesOf(r.stdout).length).toBeLessThanOrEqual(41);
      expect(longest(r.stdout)).toBeLessThanOrEqual(366);
      const record = readPoseSequence(readFileSync(pose, 'utf8'), pose).cleaned!;
      expect(record.holds!.length).toBeGreaterThan(0);
      expect(tagged(r, 'CLEAN')).toEqual([`CLEAN  ${cleanSummaryLine(record)}`]);
      expect(tagged(r, 'CLEAN')[0]).toContain(`${record.holds!.length} HOLD(s) over ${new Set(record.holds!.map((h) => h.joint)).size} joint(s)`);
      // Control: the full line is the long one, and the summary is not it.
      expect(cleanLine(record).length).toBeGreaterThan(2000);
      expect(cleanSummaryLine(record)).not.toBe(cleanLine(record));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('--verbose prints what the run printed before #238', () => {
  test('the wave as shipped: --verbose and the default are the same bytes (nothing on it collapses)', () => {
    const d = tempDir();
    try {
      const a = run(d), b = run(d, { extra: ['--verbose'] });
      expect(a.status).toBe(0);
      expect(b.stdout).toBe(a.stdout);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('re-cleaned, knees clamped: --verbose is the default with the full CLEAN line and one BEND line per frame, and --report keeps every record that left stdout', () => {
    const d = tempDir();
    try {
      const pose = heldPose(d), map = legsOnRest(d);
      const report = join(d, 'report.json');
      const def = run(d, { pose, map, extra: ['--bends', 'clamp', '--report', report] });
      const verbose = run(d, { pose, map, extra: ['--bends', 'clamp', '--verbose'] });
      expect(def.status).toBe(0);
      expect(verbose.status).toBe(0);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { bends: BendEvent[]; cleaned: { holds: unknown[]; unheld: unknown[]; seams: unknown[] } };
      const record = readPoseSequence(readFileSync(pose, 'utf8'), pose).cleaned!;
      // The report's cleaned record is the sequence's, whole: the holds, the joints not held and the seams the CLEAN line now counts.
      // (The report adds each record's times and bones beside it; every field of the record is there.)
      expect(rep.cleaned.holds).toMatchObject(record.holds!);
      expect(rep.cleaned.unheld).toMatchObject(record.unheld!);
      expect(rep.cleaned.seams).toMatchObject(record.seams!);
      // The report's bends are every frame; the verbose BEND lines are those frames as bendLine says them.
      expect(rep.bends.length).toBe(146);
      expect(tagged(verbose, 'BEND')).toEqual(rep.bends.map((e) => `BEND   ${bendLine(e)} — clamped straight`));
      expect(tagged(verbose, 'CLEAN')).toEqual([`CLEAN  ${cleanLine(record)}`]);
      // Substitute exactly those lines in the verbose output and the default comes out, byte for byte.
      const groups = bendGroups(rep.bends);
      const derived: string[] = [];
      let bendsDone = false;
      for (const l of linesOf(verbose.stdout)) {
        if (l.startsWith('  CLEAN  ')) derived.push(`  CLEAN  ${cleanSummaryLine(record)}`);
        else if (l.startsWith('  BEND   ')) {
          if (!bendsDone) for (const g of groups) derived.push(`  BEND   ${bendGroupLine(g, 'clamp')}`);
          bendsDone = true;
        } else derived.push(l);
      }
      expect(derived).toEqual(linesOf(def.stdout));
      // The collapsed lines count what they stand for.
      const counts = tagged(def, 'BEND').map((l) => Number(/, (\d+) frame\(s\) in /.exec(l)![1]));
      expect(counts.reduce((t, n) => t + n, 0)).toBe(rep.bends.length);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('--verbose with --summary is a usage error', () => {
    const d = tempDir();
    try {
      const r = run(d, { extra: ['--verbose', '--summary'] });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--verbose and --summary are both given');
      expect(existsSync(join(d, 'out.motion.json'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('a refusal on every frame collapses to one line per hinge, and still refuses (#238)', () => {
  test('POSE_BEND_ONE_WAY: each line\'s count is the number of per-frame refusals --verbose prints for that hinge; exit 1, nothing written', () => {
    const d = tempDir();
    try {
      const pose = heldPose(d), map = legsOnRest(d);
      const def = run(d, { pose, map });
      expect(def.status).toBe(1);
      expect(existsSync(join(d, 'out.motion.json'))).toBe(false);
      const verbose = run(d, { pose, map, extra: ['--verbose'] });
      expect(verbose.status).toBe(1);
      expect(existsSync(join(d, 'out.motion.json'))).toBe(false);
      const collapsed = fails(def);
      expect(collapsed).toHaveLength(2);
      expect(def.stderr).toContain('rig-pose retarget: 2 problem(s) — nothing written');
      const perFrame = fails(verbose).filter((l) => / hinge \w+, frame \d+ \(/.test(l));
      expect(perFrame).toHaveLength(146);
      for (const line of collapsed) {
        const [, chain, joint, n] = /chain "(\w+)" hinge (\w+), (\d+) frame\(s\) in /.exec(line)!;
        expect(Number(n)).toBe(perFrame.filter((l) => l.includes(`chain "${chain}" hinge ${joint}, frame `)).length);
        // The collapsed line is in the verbose output too, after its frames.
        expect(fails(verbose)).toContain(line);
        expect(namesFree(line, chain!)).toBe(true);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('bendGroups: the worst is the frame furthest on the wrong side, the runs count the gaps', () => {
    const e = (frame: number, angle: number): BendEvent => ({ chain: 'arm_r', joint: 'r_elbow', frame, t: frame / 24, angle, side: 1, rest: 20 });
    const [g, ...rest] = bendGroups([e(3, -2), e(4, -9), e(5, -1), e(9, -4)]);
    expect(rest).toEqual([]);
    expect(g!.events).toHaveLength(4);
    expect(g!.worst.frame).toBe(4);
    expect(g!.runs).toBe(2);
    expect(bendGroupLine(g!, 'refuse')).toContain('4 frame(s) in 2 run(s), frames 3–9 (t=0.125–0.375s) — worst inner angle -9.0° at frame 4');
  });
});

describe('both bend refusals name "bend": "free" and when it is right (#238)', () => {
  test('POSE_BEND_ONE_WAY and MAP_BEND_SIDE each name the remedy on their chain', () => {
    const d = tempDir();
    try {
      const one = run(d, { map: legsOnRest(d) });
      expect(one.status).toBe(1);
      expect(fails(one).filter((l) => l.includes('POSE_BEND_ONE_WAY')).every((l) => namesFree(l, /chain "(\w+)"/.exec(l)![1]!))).toBe(true);
      const side = run(d, { rig: straightKnee(d), map: legsOnRest(d) });
      expect(side.status).toBe(1);
      const sideLines = fails(side).filter((l) => l.includes('MAP_BEND_SIDE'));
      expect(sideLines).toHaveLength(1);
      expect(namesFree(sideLines[0]!, 'leg_r')).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('mutant: the remedy removed from the source, both checks go red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const m = mkdtempSync(join(MUTANTS, 'm238-'));
    const d = tempDir();
    try {
      cpSync(join(ROOT, 'src'), join(m, 'src'), { recursive: true });
      cpSync(CLI, join(m, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(m, 'package.json'));
      const path = join(m, 'src', 'retarget.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'state "bend": "free" on chain "${chain}"; ';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, ''));
      const one = run(d, { map: legsOnRest(d) }, join(m, 'cli.ts'));
      const side = run(d, { rig: straightKnee(d), map: legsOnRest(d) }, join(m, 'cli.ts'));
      expect(one.status).toBe(1);
      expect(side.status).toBe(1);
      const lines = [...fails(one), ...fails(side)].filter((l) => /POSE_BEND_ONE_WAY|MAP_BEND_SIDE/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((l) => namesFree(l, /chain "(\w+)"/.exec(l)![1]!))).toBe(false);
      console.log(`  mutant "no bend remedy": ${lines.length} bend refusal(s), none naming "bend": "free"`);
    } finally {
      rmSync(m, { recursive: true, force: true });
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('--summary: one line per measure, from the records the full lines print (#238)', () => {
  const num = (re: RegExp, s: string): number => Number(re.exec(s)![1]);

  test('the wave, feet planted with a stance: GATE, FEET, LIFT, JITTER and LAND agree with the full lines', () => {
    const d = tempDir();
    try {
      const extra = ['--plant-feet', '--stance', '0.07'];
      const full = run(d, { extra });
      const sum = run(d, { extra: [...extra, '--summary'] });
      expect(full.status).toBe(0);
      expect(sum.status).toBe(0);
      const out = linesOf(sum.stdout);
      // The run line, the five measures, the wrote line.
      expect(out).toHaveLength(7);
      expect(out[0]).toBe(linesOf(full.stdout)[0]);
      expect(out.slice(1, 6).map((l) => l.trim().split(/\s+/)[0])).toEqual(['GATE', 'FEET', 'LIFT', 'JITTER', 'LAND']);
      expect(out[6]).toBe(linesOf(full.stdout).at(-1)!);
      expect(tagged(sum, 'GATE')).toEqual(tagged(full, 'GATE'));
      // FEET: the posed build's two lines' figures.
      const posed = tagged(full, 'FEET').filter((l) => l.includes('the posed build') || l.includes('the supporting ankle over each support span'));
      expect(posed).toHaveLength(2);
      const feet = tagged(sum, 'FEET')[0]!;
      expect(feet).toContain(/lowest ankle's vertical range ([^(]+) \(/.exec(posed[0]!)![1]!.trim());
      expect(feet).toContain(posed[1]!.replace(/^FEET {3}the supporting ankle over each support span: /, ''));
      // LIFT: the STANCE runs, counted.
      const stance = tagged(full, 'STANCE');
      expect(num(/planted both (\d+) run/, tagged(sum, 'LIFT')[0]!)).toBe(stance.filter((l) => l.startsWith('STANCE planted both:')).length);
      expect(num(/lifted (\d+) run/, tagged(sum, 'LIFT')[0]!)).toBe(stance.filter((l) => l.startsWith('STANCE lifted:')).length);
      // JITTER: the worst ratio over the JITTER lines.
      const ratios = tagged(full, 'JITTER').map((l) => /\(([\d.]+)×\)/.exec(l)).filter((x) => x !== null).map((x) => Number(x[1]));
      expect(num(/worst ([\d.]+)×/, tagged(sum, 'JITTER')[0]!)).toBe(Math.max(...ratios));
      expect(num(/^JITTER (\d+) bone/, tagged(sum, 'JITTER')[0]!)).toBe(tagged(full, 'JITTER').length);
      // LAND: the count, and each kind's worst over the LAND lines.
      const land = tagged(full, 'LAND');
      const s = tagged(sum, 'LAND')[0]!;
      expect(num(/^LAND {3}(\d+) landed/, s)).toBe(land.length);
      const worstOf = (what: string) => Math.max(...land.filter((l) => l.includes(`" ${what} — `)).map((l) => num(/worst \|reached − asked\| ([\d.e+-]+)/, l)));
      expect(num(/aim \d+, worst ([\d.e+-]+)°/, s)).toBe(worstOf('aim'));
      expect(num(/origin \d+, worst ([\d.e+-]+) units/, s)).toBe(worstOf('origin'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('LIFT counts the same runs the STANCE lines print, lifted ones included', () => {
    const run0 = (state: 'both' | 'lifted' | 'below', frames: [number, number], maxHeight: number, absorbed = false) => ({ state, side: 'l' as const, frames, maxHeight, k: state === 'both' ? { min: 1, max: 1.01 } : null, ...(state === 'below' ? { maxDepth: 0.2 } : {}), ...(absorbed ? { absorbed: true as const } : {}) });
    const st: Stance = { tolerance: 0.07, release: 0.5, minSeconds: 0.1, bounds: [0.92, 1.08], runs: [run0('both', [0, 9], 0.01), run0('lifted', [10, 19], 0.31), run0('lifted', [12, 13], 0.02, true), run0('both', [20, 29], 0.02), run0('lifted', [30, 34], 0.12)], over: [], stretch: [] };
    const times = Array.from({ length: 35 }, (_, i) => i / 24);
    const lines = stanceLines(st, times);
    const lift = summaryLines({ gate: 'g', feet: null, stance: st, jitter: [], landings: [], times }).find((l) => l.startsWith('LIFT'))!;
    expect(num(/lifted (\d+) run/, lift)).toBe(lines.filter((l) => l.startsWith('lifted:')).length);
    expect(num(/planted both (\d+) run/, lift)).toBe(lines.filter((l) => l.startsWith('planted both:')).length);
    expect(num(/lifted \d+ run\(s\), (\d+) frame/, lift)).toBe(15);
    expect(lift).toContain('highest 0.3100 leg lengths (l 10–19)');
  });
});
