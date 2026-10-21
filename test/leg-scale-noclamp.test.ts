/**
 * rig-c/pose#287: when `--leg-scale`'s range clamps no frame on any leg
 * segment, the last LEG-SCALE line says so once, naming the range and the
 * picture's own spread (its minimum is the floor that would clamp). A range
 * that clamps prints no such clause, and a run without `--leg-scale` prints
 * no LEG-SCALE line at all.
 *
 * The input is public: the walk example (`examples/walk`) on the wave's rig,
 * run as its README runs it.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LegScale } from '../src/legs.ts';
import { legScaleNoClamp } from '../src/run.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const SLOW = 120_000;
const README = 'examples/walk/README.md';
const NO_CLAMP = 'no frame clamped on any leg segment';

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}
/** The walk, as its README runs it, with `--leg-scale` given (or left out with null). */
function walk(legScale: string | null): Ran {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-287-'));
  try {
    const args = ['retarget', '--rig', 'examples/wave/rig', '--map', 'examples/walk/map.json', '--sequence', 'examples/walk/pose.json', '--out', join(d, 'walk.motion.json'), '--name', 'walk', '--plant-feet', ...(legScale === null ? [] : ['--leg-scale', legScale])];
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const legLines = (r: Ran): string[] => r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('LEG-SCALE '));

describe('#287: a --leg-scale range that clamps no frame says so', () => {
  test('the walk at 0.8,1.05: four LEG-SCALE lines, none clamped, and the last names the range and the minimum 0.850', () => {
    const r = walk('0.8,1.05');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const ls = legLines(r);
    expect(ls).toHaveLength(4);
    for (const l of ls) expect(l).toContain('none under 0.8; none over 1.05');
    // Once, on the last line; the minimum is the thigh's and the maximum the larger of all four segments'.
    expect(ls.filter((l) => l.includes(NO_CLAMP))).toHaveLength(1);
    expect(ls[3]).toContain('bone "leg_l1"');
    expect(ls[3]).toEndWith("; no frame clamped on any leg segment: the range [0.8, 1.05] holds the picture's whole spread, picture length ÷ straight 0.850 … 1.000 over the 4 segment(s), so each segment is scaled to the picture on every frame; a floor above 0.850 would clamp");
    expect(ls[0]).toContain('picture length ÷ straight 0.850 … 1.000');
  }, SLOW);

  test('control: the walk at 0.9,1.05 clamps the thighs, and no line says the range clamped nothing', () => {
    const r = walk('0.9,1.05');
    expect(r.status).toBe(0);
    const ls = legLines(r);
    expect(ls.some((l) => l.includes(NO_CLAMP))).toBe(false);
    expect(ls.find((l) => l.includes('bone "leg_r0"'))).toContain('5 frame(s) under 0.9, clamped (frames 16–20)');
    expect(ls.find((l) => l.includes('bone "leg_l0"'))).toContain('5 frame(s) under 0.9, clamped (frames 4–8)');
  }, SLOW);

  test('without --leg-scale there is no LEG-SCALE line and no clause', () => {
    const r = walk(null);
    expect(r.status).toBe(0);
    expect(legLines(r)).toEqual([]);
    expect(r.stdout).not.toContain(NO_CLAMP);
  }, SLOW);

  test("the walk README's sentence is what the command prints on its own example", () => {
    const readme = readFileSync(join(ROOT, README), 'utf8');
    expect(readme).toContain('--sequence examples/walk/pose.json --out walk.motion.json --name walk --plant-feet --leg-scale 0.8,1.05');
    const quoted = /the last LEG-SCALE line adds `([^`]+)`/.exec(readme)![1]!;
    expect(legLines(walk('0.8,1.05'))[3]).toContain(`; ${quoted}`);
    expect(readme).toContain('`--leg-scale 0.9,1.05` clamps 5 frames on each (frames 16–20 right, 4–8 left)');
  }, SLOW);
});

describe('#287: legScaleNoClamp', () => {
  const seg = (o: Partial<LegScale> = {}): LegScale => ({ chain: 'leg_r', bone: 'leg_r0', joints: ['r_hip', 'r_knee'], straight: 80, ratio: { min: 0.9, median: 0.95, max: 1 }, limits: [0.8, 1.05], low: [], high: [], scale: [], asked: [], picture: [], ...o });

  test('no run anywhere: the clause, with the lowest minimum and highest maximum over the segments', () => {
    expect(legScaleNoClamp([seg(), seg({ bone: 'leg_r1', ratio: { min: 0.85, median: 0.9, max: 1.02 } })])).toBe("no frame clamped on any leg segment: the range [0.8, 1.05] holds the picture's whole spread, picture length ÷ straight 0.850 … 1.020 over the 2 segment(s), so each segment is scaled to the picture on every frame; a floor above 0.850 would clamp");
  });

  test('a run under the floor, over the ceiling, or a supporting frame past the floor: null; and null with no segment', () => {
    expect(legScaleNoClamp([seg(), seg({ low: [[3, 4]] })])).toBeNull();
    expect(legScaleNoClamp([seg({ high: [[0, 0]] }), seg()])).toBeNull();
    expect(legScaleNoClamp([seg({ support: [{} as NonNullable<LegScale['support']>[number]] })])).toBeNull();
    expect(legScaleNoClamp([])).toBeNull();
  });
});
