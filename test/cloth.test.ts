/**
 * `rig-pose cloth` (rig-c/pose#34):
 * - Control A: a synthetic swaying rig (`examples/wave` extended with a `skirt` bone and slot)
 *   keyed along a known analytical hem curve; expected `lag`, `swingRatio`, and `overshoot`
 *   are derived in the test directly from the keyed curve (never written as literals).
 *   Mode 1 (`--rig`) and Mode 2 (`--frames` rendered from the same build) agree and pass
 *   `rig-pose compare` with 0 findings.
 * - Control B: a live `rigc` `physics` constraint on `skirt` under hip sway produces positive
 *   lag, amplified swing ratio (`> 1`), and non-zero overshoot; Mode 1 and Mode 2 agree.
 * - Public stand-in reference: a multi-cycle swaying figure with a filled skirt polygon drawn
 *   on `Plate` (`400×600`, `24 fps`) alongside its `rig-pose-sequence/1`, measured through
 *   `rig-pose cloth --frames ... --pose ...`, with its error stated against the analytical curve.
 * - Planted failures (mutants) beside the controls:
 *   1. Rigid skirt (physics constraint omitted; rig-c's `A23_PHYSICS_CONSTRAINT_EFFECTIVE` refuses a resting `mix: 0`) flagged by `rig-pose compare` as a `cloth` `swingRatio` finding (`fix: rig`).
 *   2. Sign-flipped cross-correlation (`xcorrLag` with `sign = -1`: `Y[i - L]`) flipping `+lag` to `-lag` and failing Control A.
 *   3. Upper-half skirt band (`measureSkirtTriangles`, `measureSkirtPlate`, `measureRigCloth`, `measureFramesCloth` with `half = 'upper'`: `y <= y_mid`) instead of lower-half (`y >= y_mid`), collapsing `swingRatio` on Control A in both Mode 1 and Mode 2.
 *   4. Input and CLI refusals (`CLOTH_SLOT`, `CLOTH_ANIMATION`, `CLOTH_FRAMES`, `CLOTH_EMPTY_FRAME` on both transparent and opaque-background plates within `< --alpha-min` of background, `CLOTH_WINDOW`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Plate, readPlate, type RGBA } from 'rig-c/plate';
import { clean } from '../src/clean.ts';
import {
  buildClothTrack,
  measureFramesCloth,
  measureRigCloth,
  measureSkirtPlate,
  measureSkirtTriangles,
  runCloth,
  type ClothTrackDocument,
} from '../src/cloth.ts';
import { CLOTH, clothFigures, gaussSmooth, gradient, median, parseWindows, readCloth, xcorrLag } from '../src/compare.ts';
import { readMap } from '../src/map.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { Problems } from '../src/problems.ts';
import { gate, readBuild, runRigc } from '../src/rigc.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const FPS = 24;
const N = 120; // 5.0 s at 24 fps -> 121 frames (i = 0..120)
const FRAMES_COUNT = N + 1;
const HIP_W_RIG = 30; // leg_r0 (-15, 0) to leg_l0 (+15, 0) on wave rig
const SKIRT_LEN = 60; // skirt bone length down from hip

type Pt = [number, number];

const made: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-cloth-test-'));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Fill a convex or simple polygon on `plate` using even-odd scanlines. */
function fillPolygon(plate: Plate, pts: readonly Pt[], colour: RGBA): void {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(plate.height - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[(k + 1) % pts.length]!;
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xStart = Math.max(0, Math.round(xs[k]!));
      const xEnd = Math.min(plate.width - 1, Math.round(xs[k + 1]!));
      for (let x = xStart; x <= xEnd; x++) plate.set(x, y, colour);
    }
  }
}

/**
 * Analytical curve for Control A and the public stand-in reference:
 * - Hip sways sinusoidally in hip widths: `hipNorm(i) = A_hip * sin(omega * i)`
 * - Period is 32 frames (`0.75 Hz` at `24 fps`) so turnaround peaks land on exact integer frames (`8, 24, 40, 56, 72, 88, 104`).
 * - Hem follows `lagFrames` later with gain `gain` plus a quadrature carry after each stroke turn:
 *   `hemNorm(i) = gain * A_hip * sin(omega * (i - lagFrames)) - carryAmp * cos(omega * (i - lagFrames))`
 * Everything is evaluated from this function so tests derive expected figures from it directly.
 */
const OMEGA = (2 * Math.PI) / 32; // period = 32 frames (0.75 Hz at 24 fps)
const AMP_HIP = 0.5; // 0.5 hip widths (peak-to-peak 1.0 hip width > 0.2 stroke threshold)
const LAG_FRAMES = 3;
const GAIN = 2.0;
const CARRY_AMP = 0.22;

function analyticalHipNorm(i: number): number {
  return AMP_HIP * Math.sin(OMEGA * i);
}

function analyticalHemNorm(i: number): number {
  // Primary delayed swing + quadrature carry that continues after hip turnaround
  return GAIN * AMP_HIP * Math.sin(OMEGA * (i - LAG_FRAMES)) - CARRY_AMP * Math.cos(OMEGA * (i - LAG_FRAMES));
}

/** Build a rig spec extending `examples/wave/rig/rig.json` with a `skirt` bone, `skirt` mesh slot, and optional physics constraint. */
function makeSkirtRig(
  dir: string,
  physics?: { inertia: number; strength: number; damping: number; mix: number },
): { rigPath: string; mapPath: string } {
  const rigDir = join(dir, 'rig');
  mkdirSync(join(rigDir, 'images'), { recursive: true });
  const img = new Plate(80, 80);
  img.rect(0, 0, 80, 80, [220, 70, 90, 255]);
  img.writePng(join(rigDir, 'images', 'skirt.png'));

  const waveRig = JSON.parse(readFileSync(join(ROOT, 'examples', 'wave', 'rig', 'rig.json'), 'utf8')) as {
    bones: Array<Record<string, unknown>>;
  };
  const bones = [
    ...waveRig.bones,
    { name: 'skirt', parent: 'hip', x: 0, y: 0, rotation: -90, length: SKIRT_LEN },
  ];
  const slots = [{ name: 'skirt', bone: 'skirt', attachment: 'skirt' }];
  // Flared A-line skirt mesh: top edge (vertices 0, 3) weighted to `hip` at y=0, x=±10; bottom hem (vertices 1, 2) weighted to `skirt` tip at x=SKIRT_LEN, y=±35.
  // In `skirt` bone local space (rotation -90°, so +x points straight down and +y points right in Spine world):
  const skins = {
    default: {
      skirt: {
        skirt: {
          type: 'mesh',
          image: 'skirt.png',
          uvs: [0, 0, 0, 1, 1, 1, 1, 0],
          triangles: [0, 1, 2, 0, 2, 3],
          hull: 4,
          weights: [
            [{ bone: 'hip', x: -10, y: 0, weight: 1 }],
            [{ bone: 'skirt', x: SKIRT_LEN, y: -35, weight: 1 }],
            [{ bone: 'skirt', x: SKIRT_LEN, y: 35, weight: 1 }],
            [{ bone: 'hip', x: 10, y: 0, weight: 1 }],
          ],
        },
      },
    },
  };
  const constraints = physics === undefined
    ? []
    : [
        {
          type: 'physics',
          name: 'skirt_phys',
          bone: 'skirt',
          rotate: 1,
          inertia: physics.inertia,
          strength: physics.strength,
          damping: physics.damping,
          mass: 1,
          mix: physics.mix,
        },
      ];
  const rigPath = join(rigDir, 'rig.json');
  writeFileSync(
    rigPath,
    JSON.stringify(
      {
        spec: 'rigc-rig/1',
        name: 'wave',
        images: 'images',
        skeleton: { width: 400, height: 600 },
        bones,
        slots,
        skins,
        ...(constraints.length > 0 ? { constraints } : {}),
      },
      null,
      2,
    ),
  );
  const mapPath = join(dir, 'map.json');
  writeFileSync(mapPath, readFileSync(join(ROOT, 'examples', 'wave', 'map.json'), 'utf8'));
  return { rigPath, mapPath };
}

/**
 * Create a clean `rig-pose-sequence/1` matching a given per-frame `hipX(i)` (in picture px, relative to x=200)
 * with hip width `30 px` (`r_hip` at `hipX - 15`, `l_hip` at `hipX + 15`) and trunk length `75 px`.
 */
function makePoseForHip(hipWorldX: (i: number) => number, frameCount = FRAMES_COUNT, width = 400, height = 600, hipHalf = 15): string {
  const frames = Array.from({ length: frameCount }, (_, i) => {
    const cx = width / 2 + hipWorldX(i);
    const cy = height - 200;
    const joints: Record<string, { state: 'observed'; at: Pt; score: number }> = {
      nose: { state: 'observed', at: [cx, cy - 180], score: 0.99 },
      neck: { state: 'observed', at: [cx, cy - 150], score: 0.99 },
      r_eye: { state: 'observed', at: [cx - 6, cy - 185], score: 0.99 },
      l_eye: { state: 'observed', at: [cx + 6, cy - 185], score: 0.99 },
      r_ear: { state: 'observed', at: [cx - 12, cy - 180], score: 0.99 },
      l_ear: { state: 'observed', at: [cx + 12, cy - 180], score: 0.99 },
      r_shoulder: { state: 'observed', at: [cx - 30, cy - 140], score: 0.99 },
      r_elbow: { state: 'observed', at: [cx - 40, cy - 70], score: 0.99 },
      r_wrist: { state: 'observed', at: [cx - 45, cy - 10], score: 0.99 },
      l_shoulder: { state: 'observed', at: [cx + 30, cy - 140], score: 0.99 },
      l_elbow: { state: 'observed', at: [cx + 40, cy - 70], score: 0.99 },
      l_wrist: { state: 'observed', at: [cx + 45, cy - 10], score: 0.99 },
      r_hip: { state: 'observed', at: [cx - hipHalf, cy], score: 0.99 },
      r_knee: { state: 'observed', at: [cx - hipHalf, cy + 80], score: 0.99 },
      r_ankle: { state: 'observed', at: [cx - hipHalf, cy + 150], score: 0.99 },
      l_hip: { state: 'observed', at: [cx + hipHalf, cy], score: 0.99 },
      l_knee: { state: 'observed', at: [cx + hipHalf, cy + 80], score: 0.99 },
      l_ankle: { state: 'observed', at: [cx + hipHalf, cy + 150], score: 0.99 },
    };
    return { t: Number((i / FPS).toFixed(5)), people: [{ id: 'a', joints }] };
  });
  const raw = readPoseSequence(
    JSON.stringify({
      spec: 'rig-pose-sequence/1',
      space: { units: 'picture-px', origin: 'top-left', y: 'down' },
      width,
      height,
      source: 'synthetic-cloth-control',
      frames,
    }),
    'synthetic.json',
  );
  // Window 1 (no smoothing) with --hold off preserves exact analytical positions while adding `cleaned`.
  return writePoseSequence(clean(raw, { loop: false, legs: 1, rest: 1, hipsInferred: false, hold: 'off' }, undefined, 'synthetic.json').seq);
}

describe('rig-pose cloth (#34): Controls A & B, public stand-in reference, and planted mutants', () => {
  test('Control A (analytical keyed skirt): figures match values derived from the keyed curve without calling the production reader, Mode 1 & Mode 2 agree, and compare reports 0 findings', () => {
    const dir = tempDir();
    const { rigPath, mapPath } = makeSkirtRig(dir);

    // Key `hip` translate in world x by `analyticalHipNorm(i) * HIP_W_RIG` and `skirt` translate in `hip`'s
    // horizontal frame by `dx(i) = (analyticalHemNorm(i) - analyticalHipNorm(i)) * HIP_W_RIG`.
    // Top waist vertices (0, 3) are bound to `hip` at `x = ±10, y_down = 0`, while bottom hem vertices (1, 2)
    // are bound to `skirt` at `x = ±35, y_down = SKIRT_LEN = 60`, so in the lower half `y_down in [30, 60]`
    // the flare (`35 - 22.5 = 12.5 > 0.5 * max|dx| ≈ 9.2`) guarantees that the leftmost and rightmost points
    // of the lower half are the bottom hem corners `hemX ± 35` at `y_down = 60`, whose midpoint is identically
    // `analyticalHemNorm(i)` — evaluated directly from the analytical curve without calling `measureSkirtTriangles`.
    const hipSeriesWanted = Array.from({ length: FRAMES_COUNT }, (_, i) => analyticalHipNorm(i));
    const hemSeriesWanted = Array.from({ length: FRAMES_COUNT }, (_, i) => analyticalHemNorm(i));
    const dxOf = (i: number): number => (hemSeriesWanted[i]! - hipSeriesWanted[i]!) * HIP_W_RIG;

    // Derive Control A's expected window figures directly from the analytical curves (never from `measureSkirtTriangles`):
    const win = (parseWindows('0.5-4.5') as Array<{ name: string; from: number; to: number }>)[0]!;
    const f0 = Math.round(win.from * FPS);
    const f1 = Math.round(win.to * FPS);
    const expectedFromCurve = clothFigures(hipSeriesWanted, hemSeriesWanted, f0, f1, CLOTH.stroke);
    expect(expectedFromCurve.strokes).toBeGreaterThanOrEqual(4);
    expect(expectedFromCurve.lag).toBeGreaterThan(1.5);
    expect(expectedFromCurve.swingRatio!).toBeGreaterThan(1.5);
    expect(expectedFromCurve.overshoot!).toBeGreaterThan(0.15);

    const motion = {
      spec: 'rigc-motion/1',
      archetype: 'wave',
      cut: 'wave',
      easings: {},
      animations: {
        dance: {
          duration: Number((N / FPS).toFixed(5)),
          tracks: [
            {
              bone: 'hip',
              property: 'translate',
              keys: Array.from({ length: FRAMES_COUNT }, (_, i) => ({
                t: Number((i / FPS).toFixed(5)),
                v: [Number((hipSeriesWanted[i]! * HIP_W_RIG).toFixed(5)), 0],
              })),
            },
            {
              bone: 'skirt',
              property: 'translate',
              keys: Array.from({ length: FRAMES_COUNT }, (_, i) => ({
                t: Number((i / FPS).toFixed(5)),
                v: [Number(dxOf(i).toFixed(5)), 0],
              })),
            },
          ],
        },
      },
    };
    const buildDir = join(dir, 'build-a');
    const g = gate(rigPath, motion, buildDir, 'spine');
    expect(g.green, g.fails.join('\n')).toBe(true);

    // Run Mode 1 (--rig) via CLI:
    const outRigCloth = join(dir, 'control-a.rig.cloth.json');
    const r1 = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--rig', g.build, '--map', mapPath, '--skirt-slots', 'skirt', '--animation', 'dance', '--fps', String(FPS), '--windows', '0.5-4.5', '--out', outRigCloth],
      { encoding: 'utf8' },
    );
    expect(r1.status, r1.stderr).toBe(0);
    expect(r1.stdout).toContain('CLOTH  window A 0.5–4.5s');

    const parsedRigTrack = readCloth(readFileSync(outRigCloth, 'utf8'), outRigCloth);
    expect(parsedRigTrack.unit).toBe('rig world units');
    expect(parsedRigTrack.hipWidth).toBeCloseTo(HIP_W_RIG, 4);
    expect(parsedRigTrack.times.length).toBe(FRAMES_COUNT);

    const rawRigJson = JSON.parse(readFileSync(outRigCloth, 'utf8')) as ClothTrackDocument;
    const winARig = rawRigJson.skirtSwing!.A!;
    const maxRigHemErr = Math.max(...rawRigJson.frames.map((f, i) => Math.abs(f.hem_mid - hemSeriesWanted[i]!)));
    expect(maxRigHemErr).toBeLessThan(1e-4);
    // Compare Mode 1 figures against `expectedFromCurve` derived directly from `analyticalHipNorm` and `analyticalHemNorm`:
    expect(Math.abs(winARig.lag - expectedFromCurve.lag)).toBeLessThan(0.01);
    expect(Math.abs(winARig.swingRatio! - expectedFromCurve.swingRatio!)).toBeLessThan(0.01);
    expect(Math.abs(winARig.overshoot! - expectedFromCurve.overshoot!)).toBeLessThan(0.01);

    // Render isolated skirt PNGs via `rigc render --slot skirt` and measure Mode 2 (--frames + --pose):
    const renderOut = join(dir, 'render-a');
    const ren = runRigc(['render', '--candidate', g.build, '--animation', 'dance', '--slot', 'skirt', '--fps', String(FPS), '--out', renderOut]);
    expect(ren.status, ren.out).toBe(0);
    const framesSidecar = JSON.parse(readFileSync(join(renderOut, 'frames.json'), 'utf8')) as {
      viewport: { x: number; y: number; width: number; height: number; scale: number; pixelWidth: number; pixelHeight: number };
      sets: Array<{ animation: string; dir: string }>;
    };
    const setDir = resolve(dirname(join(renderOut, 'frames.json')), framesSidecar.sets.find((s) => s.animation === 'dance')!.dir);
    const vp = framesSidecar.viewport;

    // Build the matching pose.json in the render viewport's pixel space (`vp.pixelWidth x vp.pixelHeight`):
    // In `rigc render`'s projector, world `(wx, wy)` maps to pixel `px = (wx - vp.x) * vp.scale`, `py = (vp.y + vp.height - wy) * vp.scale`.
    const posePath = join(dir, 'pose-a.json');
    const hipHalfPx = 15 * vp.scale;
    const framesPose = Array.from({ length: FRAMES_COUNT }, (_, i) => {
      const wx = hipSeriesWanted[i]! * HIP_W_RIG;
      const cx = (wx - vp.x) * vp.scale;
      const cy = (vp.y + vp.height - 200) * vp.scale;
      const joints: Record<string, { state: 'observed'; at: Pt; score: number }> = {
        nose: { state: 'observed', at: [cx, cy - 180 * vp.scale], score: 0.99 },
        neck: { state: 'observed', at: [cx, cy - 150 * vp.scale], score: 0.99 },
        r_eye: { state: 'observed', at: [cx - 6 * vp.scale, cy - 185 * vp.scale], score: 0.99 },
        l_eye: { state: 'observed', at: [cx + 6 * vp.scale, cy - 185 * vp.scale], score: 0.99 },
        r_ear: { state: 'observed', at: [cx - 12 * vp.scale, cy - 180 * vp.scale], score: 0.99 },
        l_ear: { state: 'observed', at: [cx + 12 * vp.scale, cy - 180 * vp.scale], score: 0.99 },
        r_shoulder: { state: 'observed', at: [cx - 30 * vp.scale, cy - 140 * vp.scale], score: 0.99 },
        r_elbow: { state: 'observed', at: [cx - 40 * vp.scale, cy - 70 * vp.scale], score: 0.99 },
        r_wrist: { state: 'observed', at: [cx - 45 * vp.scale, cy - 10 * vp.scale], score: 0.99 },
        l_shoulder: { state: 'observed', at: [cx + 30 * vp.scale, cy - 140 * vp.scale], score: 0.99 },
        l_elbow: { state: 'observed', at: [cx + 40 * vp.scale, cy - 70 * vp.scale], score: 0.99 },
        l_wrist: { state: 'observed', at: [cx + 45 * vp.scale, cy - 10 * vp.scale], score: 0.99 },
        r_hip: { state: 'observed', at: [cx - hipHalfPx, cy], score: 0.99 },
        r_knee: { state: 'observed', at: [cx - hipHalfPx, cy + 80 * vp.scale], score: 0.99 },
        r_ankle: { state: 'observed', at: [cx - hipHalfPx, cy + 150 * vp.scale], score: 0.99 },
        l_hip: { state: 'observed', at: [cx + hipHalfPx, cy], score: 0.99 },
        l_knee: { state: 'observed', at: [cx + hipHalfPx, cy + 80 * vp.scale], score: 0.99 },
        l_ankle: { state: 'observed', at: [cx + hipHalfPx, cy + 150 * vp.scale], score: 0.99 },
      };
      return { t: Number((i / FPS).toFixed(5)), people: [{ id: 'a', joints }] };
    });
    writeFileSync(
      posePath,
      JSON.stringify({
        spec: 'rig-pose-sequence/1',
        space: { units: 'picture-px', origin: 'top-left', y: 'down' },
        width: vp.pixelWidth,
        height: vp.pixelHeight,
        source: 'render-a',
        frames: framesPose,
      }),
    );

    const outFramesCloth = join(dir, 'control-a.frames.cloth.json');
    const r2 = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--frames', setDir, '--pose', posePath, '--windows', '0.5-4.5', '--out', outFramesCloth],
      { encoding: 'utf8' },
    );
    expect(r2.status, r2.stderr).toBe(0);
    const rawFramesJson = JSON.parse(readFileSync(outFramesCloth, 'utf8')) as ClothTrackDocument;
    const winAFrames = rawFramesJson.skirtSwing!.A!;
    const maxFramesHemErr = Math.max(...rawFramesJson.frames.map((f, i) => Math.abs(f.hem_mid - hemSeriesWanted[i]!)));
    expect(maxFramesHemErr).toBeLessThan(0.025);
    console.log(
      `CONTROL_A window A (0.5-4.5s): curve lag=${expectedFromCurve.lag.toFixed(4)}f swing=${expectedFromCurve.swingRatio!.toFixed(4)} overshoot=${expectedFromCurve.overshoot!.toFixed(4)} | ` +
        `Mode 1 (--rig) lag=${winARig.lag.toFixed(4)}f swing=${winARig.swingRatio!.toFixed(4)} overshoot=${winARig.overshoot!.toFixed(4)} (max|Δhem_mid|=${maxRigHemErr.toFixed(5)}hw) | ` +
        `Mode 2 (--frames) lag=${winAFrames.lag.toFixed(4)}f swing=${winAFrames.swingRatio!.toFixed(4)} overshoot=${winAFrames.overshoot!.toFixed(4)} (max|Δhem_mid|=${maxFramesHemErr.toFixed(5)}hw)`,
    );
    // Mode 1 (geometry) and Mode 2 (raster PNGs) agree well within pixel quantisation:
    expect(Math.abs(winAFrames.lag - expectedFromCurve.lag)).toBeLessThan(0.15);
    expect(Math.abs(winAFrames.swingRatio! - expectedFromCurve.swingRatio!)).toBeLessThan(0.1);
    expect(Math.abs(winAFrames.overshoot! - expectedFromCurve.overshoot!)).toBeLessThan(0.05);
    expect(Math.abs(winAFrames.lag - winARig.lag)).toBeLessThan(0.15);
    expect(Math.abs(winAFrames.swingRatio! - winARig.swingRatio!)).toBeLessThan(0.1);
    expect(Math.abs(winAFrames.overshoot! - winARig.overshoot!)).toBeLessThan(0.05);

    // Run `rig-pose compare` with Mode 2 (`picture px`) as reference and Mode 1 (`rig world units`) as render:
    const repPath = join(dir, 'retarget-report.json');
    writeFileSync(
      repPath,
      JSON.stringify({
        spec: 'rig-pose-report/1',
        frames: FRAMES_COUNT,
        scale: { factor: 1 / vp.scale },
        switches: [],
      }),
    );
    const cmp = spawnSync(
      process.execPath,
      [
        CLI,
        'compare',
        '--reference',
        posePath,
        '--render',
        posePath,
        '--map',
        mapPath,
        '--retarget-report',
        repPath,
        '--cloth-reference',
        outFramesCloth,
        '--cloth-render',
        outRigCloth,
        '--cloth-windows',
        '0.5-4.5',
      ],
      { encoding: 'utf8' },
    );
    expect(cmp.status, cmp.stderr).toBe(0);
    expect(cmp.stdout).toContain('  CLOTH  0 findings');
    expect(cmp.stdout).toContain('  0 finding(s)');
  }, 60_000);

  test('Control B (live rigc physics constraint on skirt: Mode 1 and Mode 2 agree under physicsClockStep, while plain clock fails) and Planted Mutant 1 (rigid skirt refused by compare)', () => {
    const dir = tempDir();
    // Control B: live physics constraint driven solely by hip translate keys
    const { rigPath: physRigPath, mapPath } = makeSkirtRig(dir, {
      inertia: 1.8,
      strength: 22,
      damping: 0.92,
      mix: 1.0,
    });
    const hipKeys = Array.from({ length: FRAMES_COUNT }, (_, i) => ({
      t: Number((i / FPS).toFixed(5)),
      v: [Number((analyticalHipNorm(i) * HIP_W_RIG).toFixed(5)), 0],
    }));
    const motion = {
      spec: 'rigc-motion/1',
      archetype: 'wave',
      cut: 'wave',
      easings: {},
      animations: {
        dance: {
          duration: Number((N / FPS).toFixed(5)),
          tracks: [{ bone: 'hip', property: 'translate', keys: hipKeys }],
        },
      },
    };
    const gPhys = gate(physRigPath, motion, join(dir, 'build-phys'), 'spine');
    expect(gPhys.green, gPhys.fails.join('\n')).toBe(true);

    const physDoc = readBuild(gPhys.build);
    const map = readMap(readFileSync(mapPath, 'utf8'), mapPath);
    const windows = parseWindows('0.5-4.5') as Array<{ name: string; from: number; to: number }>;
    const physRes = measureRigCloth(physDoc, map, mapPath, {
      rigWhere: gPhys.build,
      animation: 'dance',
      skirtSlots: ['skirt'],
      fps: FPS,
      windows,
    });
    const winPhys = physRes.windows[0]!;
    expect(winPhys.lag).toBeGreaterThan(0.5);
    expect(winPhys.swingRatio!).toBeGreaterThan(1.15);
    expect(winPhys.overshoot!).toBeGreaterThan(0.02);

    // Render Control B's physics skirt with `rigc render --slot skirt` and measure it with Mode 2 (--frames + --pose):
    const renderPhysOut = join(dir, 'render-phys');
    const renPhys = runRigc(['render', '--candidate', gPhys.build, '--animation', 'dance', '--slot', 'skirt', '--fps', String(FPS), '--out', renderPhysOut]);
    expect(renPhys.status, renPhys.out).toBe(0);
    const framesSidecarB = JSON.parse(readFileSync(join(renderPhysOut, 'frames.json'), 'utf8')) as {
      viewport: { x: number; y: number; width: number; height: number; scale: number; pixelWidth: number; pixelHeight: number };
      sets: Array<{ animation: string; dir: string }>;
    };
    const setDirB = resolve(dirname(join(renderPhysOut, 'frames.json')), framesSidecarB.sets.find((s) => s.animation === 'dance')!.dir);
    const vpB = framesSidecarB.viewport;

    const poseBPath = join(dir, 'pose-b.json');
    const hipHalfPxB = 15 * vpB.scale;
    const framesPoseB = physRes.doc.frames.map((f, i) => {
      const wx = f.hip_x * physRes.doc.hipWidth.median + physRes.doc.origin[0];
      const cx = (wx - vpB.x) * vpB.scale;
      const cy = (vpB.y + vpB.height - 200) * vpB.scale;
      const joints: Record<string, { state: 'observed'; at: Pt; score: number }> = {
        nose: { state: 'observed', at: [cx, cy - 180 * vpB.scale], score: 0.99 },
        neck: { state: 'observed', at: [cx, cy - 150 * vpB.scale], score: 0.99 },
        r_eye: { state: 'observed', at: [cx - 6 * vpB.scale, cy - 185 * vpB.scale], score: 0.99 },
        l_eye: { state: 'observed', at: [cx + 6 * vpB.scale, cy - 185 * vpB.scale], score: 0.99 },
        r_ear: { state: 'observed', at: [cx - 12 * vpB.scale, cy - 180 * vpB.scale], score: 0.99 },
        l_ear: { state: 'observed', at: [cx + 12 * vpB.scale, cy - 180 * vpB.scale], score: 0.99 },
        r_shoulder: { state: 'observed', at: [cx - 30 * vpB.scale, cy - 140 * vpB.scale], score: 0.99 },
        r_elbow: { state: 'observed', at: [cx - 40 * vpB.scale, cy - 70 * vpB.scale], score: 0.99 },
        r_wrist: { state: 'observed', at: [cx - 45 * vpB.scale, cy - 10 * vpB.scale], score: 0.99 },
        l_shoulder: { state: 'observed', at: [cx + 30 * vpB.scale, cy - 140 * vpB.scale], score: 0.99 },
        l_elbow: { state: 'observed', at: [cx + 40 * vpB.scale, cy - 70 * vpB.scale], score: 0.99 },
        l_wrist: { state: 'observed', at: [cx + 45 * vpB.scale, cy - 10 * vpB.scale], score: 0.99 },
        r_hip: { state: 'observed', at: [cx - hipHalfPxB, cy], score: 0.99 },
        r_knee: { state: 'observed', at: [cx - hipHalfPxB, cy + 80 * vpB.scale], score: 0.99 },
        r_ankle: { state: 'observed', at: [cx - hipHalfPxB, cy + 150 * vpB.scale], score: 0.99 },
        l_hip: { state: 'observed', at: [cx + hipHalfPxB, cy], score: 0.99 },
        l_knee: { state: 'observed', at: [cx + hipHalfPxB, cy + 80 * vpB.scale], score: 0.99 },
        l_ankle: { state: 'observed', at: [cx + hipHalfPxB, cy + 150 * vpB.scale], score: 0.99 },
      };
      return { t: Number((i / FPS).toFixed(5)), people: [{ id: 'a', joints }] };
    });
    writeFileSync(
      poseBPath,
      JSON.stringify({
        spec: 'rig-pose-sequence/1',
        space: { units: 'picture-px', origin: 'top-left', y: 'down' },
        width: vpB.pixelWidth,
        height: vpB.pixelHeight,
        source: 'render-b',
        frames: framesPoseB,
      }),
    );

    const outFramesB = join(dir, 'control-b.frames.cloth.json');
    const r2B = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--frames', setDirB, '--pose', poseBPath, '--windows', '0.5-4.5', '--out', outFramesB],
      { encoding: 'utf8' },
    );
    expect(r2B.status, r2B.stderr).toBe(0);
    const rawFramesB = JSON.parse(readFileSync(outFramesB, 'utf8')) as ClothTrackDocument;
    const winFramesB = rawFramesB.skirtSwing!.A!;
    const maxHemDiffB = Math.max(...physRes.doc.frames.map((f, i) => Math.abs(f.hem_mid - rawFramesB.frames[i]!.hem_mid)));
    console.log(
      `CONTROL_B (physics skirt, inertia=1.8, strength=22, damping=0.92, mix=1): ` +
        `Mode 1 (--rig) lag=${winPhys.lag.toFixed(4)}f swingRatio=${winPhys.swingRatio!.toFixed(4)} overshoot=${winPhys.overshoot!.toFixed(4)} strokes=${winPhys.strokes} | ` +
        `Mode 2 (--frames) lag=${winFramesB.lag.toFixed(4)}f swingRatio=${winFramesB.swingRatio!.toFixed(4)} overshoot=${winFramesB.overshoot!.toFixed(4)} strokes=${winFramesB.strokes} | ` +
        `max|Δhem_mid|=${maxHemDiffB.toFixed(5)}hw (${(maxHemDiffB * HIP_W_RIG * vpB.scale).toFixed(2)}px)`,
    );
    // Frame-level and window-level agreement between Mode 1 (`physicsClockStep`) and Mode 2 (`rigc render --slot skirt`):
    expect(maxHemDiffB).toBeLessThan(0.025);
    expect(Math.abs(winFramesB.lag - winPhys.lag)).toBeLessThan(0.15);
    expect(Math.abs(winFramesB.swingRatio! - winPhys.swingRatio!)).toBeLessThan(0.1);
    expect(Math.abs(winFramesB.overshoot! - winPhys.overshoot!)).toBeLessThan(0.05);

    // Planted plain clock (`(dt) => dt`, without `physicsClockStep`'s `1 + 2^-30` nudge) drifts off `rigc render`'s 60 Hz physics clock by > 0.12 hip widths:
    const plainClockRes = measureRigCloth(physDoc, map, mapPath, {
      rigWhere: gPhys.build,
      animation: 'dance',
      skirtSlots: ['skirt'],
      fps: FPS,
      windows,
      plant: { clock: (dt) => dt },
    });
    const maxPlainHemDiffB = Math.max(...plainClockRes.doc.frames.map((f, i) => Math.abs(f.hem_mid - rawFramesB.frames[i]!.hem_mid)));
    expect(maxPlainHemDiffB).toBeGreaterThan(0.12);

    // Planted Mutant 1: rigid skirt (physics constraint omitted; rig-c's A23_PHYSICS_CONSTRAINT_EFFECTIVE refuses a resting mix: 0)
    // -> hem moves 1:1 with hip (`swingRatio = 1, lag = 0, overshoot = 0`).
    // When compared against a swaying reference track, `rig-pose compare` must flag `cloth` `swingRatio` with `fix: rig`.
    const dirRigid = join(dir, 'rigid');
    mkdirSync(dirRigid, { recursive: true });
    const { rigPath: rigidRigPath } = makeSkirtRig(dirRigid);
    const gRigid = gate(rigidRigPath, motion, join(dir, 'build-rigid'), 'spine');
    expect(gRigid.green, gRigid.fails.join('\n')).toBe(true);
    const rigidOut = join(dir, 'rigid.cloth.json');
    runCloth({ kind: 'rig', rig: gRigid.build, map: mapPath, skirtSlots: ['skirt'], animation: 'dance', fps: FPS, windows, out: rigidOut }, () => {});
    const rigidTrack = JSON.parse(readFileSync(rigidOut, 'utf8')) as ClothTrackDocument;
    expect(rigidTrack.skirtSwing!.A!.lag).toBeCloseTo(0, 4);
    expect(rigidTrack.skirtSwing!.A!.swingRatio!).toBeCloseTo(1, 4);
    expect(rigidTrack.skirtSwing!.A!.overshoot!).toBeCloseTo(0, 4);

    // Compare Rigid Render against Physics Reference (written in picture px for reference):
    const refOut = join(dir, 'ref-phys.cloth.json');
    writeFileSync(
      refOut,
      JSON.stringify({
        ...physRes.doc,
        hipWidth: { median: 30, unit: 'picture px' },
      }),
    );
    const poseFile = join(dir, 'pose.json');
    writeFileSync(poseFile, makePoseForHip((i) => analyticalHipNorm(i) * HIP_W_RIG));
    const repFile = join(dir, 'rep.json');
    writeFileSync(repFile, JSON.stringify({ spec: 'rig-pose-report/1', frames: FRAMES_COUNT, scale: { factor: 1 }, switches: [] }));
    const cmpRigid = spawnSync(
      process.execPath,
      [CLI, 'compare', '--reference', poseFile, '--render', poseFile, '--map', mapPath, '--retarget-report', repFile, '--cloth-reference', refOut, '--cloth-render', rigidOut, '--cloth-windows', '0.5-4.5'],
      { encoding: 'utf8' },
    );
    expect(cmpRigid.status).toBe(0);
    expect(cmpRigid.stdout).toContain('FIND   cloth swingRatio window A');
    expect(cmpRigid.stdout).toContain("fix: rig (the cloth is the rig's physics)");
  }, 60_000);

  test('Public stand-in reference (HQ Note 3): Plate-drawn swaying skirt frames + pose.json measured against its analytical curve', () => {
    const dir = tempDir();
    const framesDir = join(dir, 'frames');
    mkdirSync(framesDir, { recursive: true });
    const W = 400;
    const H = 600;
    const HIP_W_PX = 60; // r_hip at cx - 30, l_hip at cx + 30
    const SKIRT_H = 80;
    const SKIRT_COLOUR: RGBA = [70, 110, 190, 255];

    // Draw each frame's flared A-line skirt polygon on a 400x600 Plate:
    // Top waist spans [hipX - 15, hipX + 15] at y = 300.
    // Bottom hem spans [hemX - 60, hemX + 60] at y = 380.
    // Because the flare (60 - 15 = 45 px) exceeds max |hemX - hipX| (<= 38 px), in the lower half y in [340, 380]
    // both the left and right edges reach their extreme x at the bottom hem y=380 (`hemX - 60` and `hemX + 60`),
    // so the continuous midpoint of `[hem_l, hem_r]` is identically `hemX`!
    const plates: Array<{ name: string; plate: Plate }> = [];
    for (let i = 0; i < FRAMES_COUNT; i++) {
      const plate = new Plate(W, H);
      const hipX = W / 2 + analyticalHipNorm(i) * HIP_W_PX;
      const hemX = W / 2 + analyticalHemNorm(i) * HIP_W_PX;
      const poly: Pt[] = [
        [hipX - 15, 300],
        [hipX + 15, 300],
        [hemX + 60, 300 + SKIRT_H],
        [hemX + 60, 300 + SKIRT_H + 1],
        [hemX - 60, 300 + SKIRT_H + 1],
        [hemX - 60, 300 + SKIRT_H],
      ];
      fillPolygon(plate, poly, SKIRT_COLOUR);
      const name = `f${String(i).padStart(4, '0')}.png`;
      const path = join(framesDir, name);
      plate.writePng(path);
      plates.push({ name: path, plate });
    }

    const posePath = join(dir, 'standin.pose.json');
    const poseText = makePoseForHip((i) => analyticalHipNorm(i) * HIP_W_PX, FRAMES_COUNT, W, H, HIP_W_PX / 2);
    writeFileSync(posePath, poseText);
    const seq = readPoseSequence(poseText, posePath);
    const windows = parseWindows('0.5-4.5') as Array<{ name: string; from: number; to: number }>;

    // Analytical reference figures computed directly from `analyticalHipNorm` and `analyticalHemNorm`:
    const f0 = Math.round(0.5 * FPS);
    const f1 = Math.round(4.5 * FPS);
    const hipTrue = Array.from({ length: FRAMES_COUNT }, (_, i) => analyticalHipNorm(i));
    const hemTrue = Array.from({ length: FRAMES_COUNT }, (_, i) => analyticalHemNorm(i));
    const figTrue = clothFigures(hipTrue, hemTrue, f0, f1, CLOTH.stroke);

    // Measure the drawn public stand-in via `measureFramesCloth`:
    const measured = measureFramesCloth(plates, seq, posePath, framesDir, { alphaMin: 16, windows });
    const winMeas = measured.windows[0]!;

    // Per-frame error between rasterised pixels (`1 / 60 px` = `0.0167` hip widths per pixel) and continuous curve:
    const maxHipErr = Math.max(...measured.doc.frames.map((f, i) => Math.abs(f.hip_x - hipTrue[i]!)));
    const maxHemErr = Math.max(...measured.doc.frames.map((f, i) => Math.abs(f.hem_mid - hemTrue[i]!)));
    const lagErr = Math.abs(winMeas.lag - figTrue.lag);
    const swingErr = Math.abs(winMeas.swingRatio! - figTrue.swingRatio!);
    const overshootErr = Math.abs(winMeas.overshoot! - figTrue.overshoot!);

    console.log(
      `STANDIN_REFERENCE window A (0.5-4.5s, frames ${f0}-${f1 - 1}): ` +
        `analytical lag=${figTrue.lag.toFixed(4)} swing=${figTrue.swingRatio!.toFixed(4)} overshoot=${figTrue.overshoot!.toFixed(4)} | ` +
        `measured lag=${winMeas.lag.toFixed(4)} swing=${winMeas.swingRatio!.toFixed(4)} overshoot=${winMeas.overshoot!.toFixed(4)} | ` +
        `errors: |Δlag|=${lagErr.toFixed(4)}f, |Δswing|=${swingErr.toFixed(4)}, |Δovershoot|=${overshootErr.toFixed(4)}, max|Δhip_x|=${maxHipErr.toFixed(5)}hw, max|Δhem_mid|=${maxHemErr.toFixed(5)}hw`,
    );

    // `writePoseSequence` rounds joint coordinates to 2 decimal places (`0.005 px / 60 px = 8.3e-5 hw`):
    expect(maxHipErr).toBeLessThan(1e-4);
    // 1 px quantisation at 60 px hip width is <= 1/60 = 0.0167 hip widths:
    expect(maxHemErr).toBeLessThan(1 / HIP_W_PX + 1e-4);
    expect(lagErr).toBeLessThan(0.05);
    expect(swingErr).toBeLessThan(0.05);
    expect(overshootErr).toBeLessThan(0.02);
  });

  test('Planted Mutant 2 (sign-flipped xcorrLag) and Planted Mutant 3 (upper-half skirt band in measureRigCloth and measureFramesCloth) go red against Control A', () => {
    const dir = tempDir();
    const { rigPath, mapPath } = makeSkirtRig(dir);
    const f0 = Math.round(0.5 * FPS);
    const f1 = Math.round(4.5 * FPS);
    const hip = Array.from({ length: FRAMES_COUNT }, (_, i) => analyticalHipNorm(i));
    const hem = Array.from({ length: FRAMES_COUNT }, (_, i) => analyticalHemNorm(i));
    const control = clothFigures(hip, hem, f0, f1, CLOTH.stroke);
    expect(control.lag).toBeGreaterThan(1.5);

    // Build Control A's rig and rendered frames so Mutant 2 and Mutant 3 exercise the production readers directly:
    const motion = {
      spec: 'rigc-motion/1',
      archetype: 'wave',
      cut: 'wave',
      easings: {},
      animations: {
        dance: {
          duration: Number((N / FPS).toFixed(5)),
          tracks: [
            {
              bone: 'hip',
              property: 'translate',
              keys: Array.from({ length: FRAMES_COUNT }, (_, i) => ({
                t: Number((i / FPS).toFixed(5)),
                v: [Number((hip[i]! * HIP_W_RIG).toFixed(5)), 0],
              })),
            },
            {
              bone: 'skirt',
              property: 'translate',
              keys: Array.from({ length: FRAMES_COUNT }, (_, i) => ({
                t: Number((i / FPS).toFixed(5)),
                v: [Number(((hem[i]! - hip[i]!) * HIP_W_RIG).toFixed(5)), 0],
              })),
            },
          ],
        },
      },
    };
    const g = gate(rigPath, motion, join(dir, 'build-mut'), 'spine');
    expect(g.green, g.fails.join('\n')).toBe(true);
    const doc = readBuild(g.build);
    const map = readMap(readFileSync(mapPath, 'utf8'), mapPath);
    const windows = parseWindows('0.5-4.5') as Array<{ name: string; from: number; to: number }>;

    // Mutant 2: plant `xcorrLag` (`sign = -1`) and `measureRigCloth` (`plant: { lagSign: -1 }`) so Control A goes red:
    const dh = gradient(gaussSmooth(hip)).slice(f0, f1);
    const de = gradient(gaussSmooth(hem)).slice(f0, f1);
    expect(xcorrLag(dh, de, CLOTH.lagFrom, CLOTH.lagTo, 1).lag).toBeCloseTo(control.lag, 6);
    const flippedLag = xcorrLag(dh, de, CLOTH.lagFrom, CLOTH.lagTo, -1);
    expect(flippedLag.lag).toBeLessThan(0);
    expect(Math.abs(flippedLag.lag - control.lag)).toBeGreaterThan(3);
    const rigMut2 = measureRigCloth(doc, map, mapPath, {
      rigWhere: g.build,
      animation: 'dance',
      skirtSlots: ['skirt'],
      fps: FPS,
      windows,
      plant: { lagSign: -1 },
    });
    expect(rigMut2.windows[0]!.lag).toBeLessThan(0);
    expect(Math.abs(rigMut2.windows[0]!.lag - control.lag)).toBeGreaterThan(3);

    // Mutant 3: plant `half = 'upper'` in `measureSkirtTriangles`, `measureSkirtPlate`, `measureRigCloth` (Mode 1),
    // and `measureFramesCloth` (Mode 2) on Control A so both Mode 1 and Mode 2 go red against `control.swingRatio`:
    const rigUpper = measureRigCloth(doc, map, mapPath, {
      rigWhere: g.build,
      animation: 'dance',
      skirtSlots: ['skirt'],
      fps: FPS,
      windows,
      plant: { half: 'upper' },
    });
    expect(Math.abs(rigUpper.windows[0]!.swingRatio! - control.swingRatio!)).toBeGreaterThan(0.4);

    // Also render Control A's isolated skirt frames and run Mode 2 (`measureFramesCloth`) with `plant: { half: 'upper' }`:
    const renderOut = join(dir, 'render-mut');
    const ren = runRigc(['render', '--candidate', g.build, '--animation', 'dance', '--slot', 'skirt', '--fps', String(FPS), '--out', renderOut]);
    expect(ren.status, ren.out).toBe(0);
    const framesSidecar = JSON.parse(readFileSync(join(renderOut, 'frames.json'), 'utf8')) as {
      viewport: { x: number; y: number; width: number; height: number; scale: number; pixelWidth: number; pixelHeight: number };
      sets: Array<{ animation: string; dir: string }>;
    };
    const setDir = resolve(dirname(join(renderOut, 'frames.json')), framesSidecar.sets.find((s) => s.animation === 'dance')!.dir);
    const vp = framesSidecar.viewport;
    const pngs = readdirSync(setDir).filter((f) => f.toLowerCase().endsWith('.png') && !/contact|sheet/i.test(f)).sort();
    const plates = pngs.map((f) => {
      const p = join(setDir, f);
      return { name: p, plate: readPlate(p) };
    });
    const posePath = join(dir, 'pose-mut.json');
    const hipHalfPx = 15 * vp.scale;
    const framesPose = Array.from({ length: FRAMES_COUNT }, (_, i) => {
      const wx = hip[i]! * HIP_W_RIG;
      const cx = (wx - vp.x) * vp.scale;
      const cy = (vp.y + vp.height - 200) * vp.scale;
      const joints: Record<string, { state: 'observed'; at: Pt; score: number }> = {
        nose: { state: 'observed', at: [cx, cy - 180 * vp.scale], score: 0.99 },
        neck: { state: 'observed', at: [cx, cy - 150 * vp.scale], score: 0.99 },
        r_eye: { state: 'observed', at: [cx - 6 * vp.scale, cy - 185 * vp.scale], score: 0.99 },
        l_eye: { state: 'observed', at: [cx + 6 * vp.scale, cy - 185 * vp.scale], score: 0.99 },
        r_ear: { state: 'observed', at: [cx - 12 * vp.scale, cy - 180 * vp.scale], score: 0.99 },
        l_ear: { state: 'observed', at: [cx + 12 * vp.scale, cy - 180 * vp.scale], score: 0.99 },
        r_shoulder: { state: 'observed', at: [cx - 30 * vp.scale, cy - 140 * vp.scale], score: 0.99 },
        r_elbow: { state: 'observed', at: [cx - 40 * vp.scale, cy - 70 * vp.scale], score: 0.99 },
        r_wrist: { state: 'observed', at: [cx - 45 * vp.scale, cy - 10 * vp.scale], score: 0.99 },
        l_shoulder: { state: 'observed', at: [cx + 30 * vp.scale, cy - 140 * vp.scale], score: 0.99 },
        l_elbow: { state: 'observed', at: [cx + 40 * vp.scale, cy - 70 * vp.scale], score: 0.99 },
        l_wrist: { state: 'observed', at: [cx + 45 * vp.scale, cy - 10 * vp.scale], score: 0.99 },
        r_hip: { state: 'observed', at: [cx - hipHalfPx, cy], score: 0.99 },
        r_knee: { state: 'observed', at: [cx - hipHalfPx, cy + 80 * vp.scale], score: 0.99 },
        r_ankle: { state: 'observed', at: [cx - hipHalfPx, cy + 150 * vp.scale], score: 0.99 },
        l_hip: { state: 'observed', at: [cx + hipHalfPx, cy], score: 0.99 },
        l_knee: { state: 'observed', at: [cx + hipHalfPx, cy + 80 * vp.scale], score: 0.99 },
        l_ankle: { state: 'observed', at: [cx + hipHalfPx, cy + 150 * vp.scale], score: 0.99 },
      };
      return { t: Number((i / FPS).toFixed(5)), people: [{ id: 'a', joints }] };
    });
    const seq = readPoseSequence(
      JSON.stringify({
        spec: 'rig-pose-sequence/1',
        space: { units: 'picture-px', origin: 'top-left', y: 'down' },
        width: vp.pixelWidth,
        height: vp.pixelHeight,
        source: 'render-mut',
        frames: framesPose,
      }),
      posePath,
    );
    const framesLower = measureFramesCloth(plates, seq, posePath, setDir, { alphaMin: 16, windows });
    const framesUpper = measureFramesCloth(plates, seq, posePath, setDir, { alphaMin: 16, windows, plant: { half: 'upper' } });
    expect(Math.abs(framesLower.windows[0]!.swingRatio! - control.swingRatio!)).toBeLessThan(0.1);
    expect(Math.abs(framesUpper.windows[0]!.swingRatio! - control.swingRatio!)).toBeGreaterThan(0.4);
  }, 60_000);

  test('Planted Mutant 4: CLI and reader refusals by name (CLOTH_SLOT, CLOTH_ANIMATION, CLOTH_FRAMES, CLOTH_EMPTY_FRAME on transparent and opaque backgrounds, CLOTH_WINDOW, Usage)', () => {
    const dir = tempDir();
    const { rigPath, mapPath } = makeSkirtRig(dir);
    const out = join(dir, 'out.cloth.json');

    // Unknown slot -> CLOTH_SLOT
    const badSlot = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--rig', rigPath, '--map', mapPath, '--skirt-slots', 'no_such_slot', '--out', out],
      { encoding: 'utf8' },
    );
    expect(badSlot.status).toBe(1);
    expect(badSlot.stderr).toContain('FAIL  CLOTH_SLOT:');
    expect(badSlot.stderr).toContain('"no_such_slot"');

    // Unknown animation -> CLOTH_ANIMATION
    const badAnim = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--rig', rigPath, '--map', mapPath, '--skirt-slots', 'skirt', '--animation', 'no_such_anim', '--out', out],
      { encoding: 'utf8' },
    );
    expect(badAnim.status).toBe(1);
    expect(badAnim.stderr).toContain('FAIL  CLOTH_ANIMATION:');

    // Frame count mismatch -> CLOTH_FRAMES
    const framesDir = join(dir, 'empty-frames');
    mkdirSync(framesDir, { recursive: true });
    const poseFile = join(dir, 'pose.json');
    writeFileSync(poseFile, makePoseForHip(() => 0, 20));
    const badFrames = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--frames', framesDir, '--pose', poseFile, '--out', out],
      { encoding: 'utf8' },
    );
    expect(badFrames.status).toBe(1);
    expect(badFrames.stderr).toContain('FAIL  CLOTH_FRAMES:');

    // Blank PNG frame (all alpha 0) -> CLOTH_EMPTY_FRAME
    const blankPlate = new Plate(400, 600);
    for (let i = 0; i < 20; i++) blankPlate.writePng(join(framesDir, `f${String(i).padStart(2, '0')}.png`));
    expect(measureSkirtPlate(blankPlate, 16)).toBeNull();
    const emptyFrame = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--frames', framesDir, '--pose', poseFile, '--out', out],
      { encoding: 'utf8' },
    );
    expect(emptyFrame.status).toBe(1);
    expect(emptyFrame.stderr).toContain('FAIL  CLOTH_EMPTY_FRAME:');

    // Opaque-background PNG (`[232, 232, 232, 255]`, as in `rigc render --slot`) whose skirt (`[225, 225, 225, 255]`, RGB distance 7 < 16) is within `--alpha-min` of the border background -> CLOTH_EMPTY_FRAME
    const lowContrastPlate = new Plate(400, 600);
    lowContrastPlate.rect(0, 0, 400, 600, [232, 232, 232, 255]);
    lowContrastPlate.rect(180, 300, 40, 80, [225, 225, 225, 255]);
    expect(measureSkirtPlate(lowContrastPlate, 16)).toBeNull();
    for (let i = 0; i < 20; i++) lowContrastPlate.writePng(join(framesDir, `f${String(i).padStart(2, '0')}.png`));
    const opaqueEmpty = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--frames', framesDir, '--pose', poseFile, '--alpha-min', '16', '--out', out],
      { encoding: 'utf8' },
    );
    expect(opaqueEmpty.status).toBe(1);
    expect(opaqueEmpty.stderr).toContain('FAIL  CLOTH_EMPTY_FRAME:');
    expect(opaqueEmpty.stderr).toContain('colour distance ≥ 16 from an opaque border background');

    // Window <= 12 frames -> CLOTH_WINDOW
    const filledPlate = new Plate(400, 600);
    filledPlate.rect(180, 300, 40, 80, [100, 120, 200, 255]);
    for (let i = 0; i < 20; i++) filledPlate.writePng(join(framesDir, `f${String(i).padStart(2, '0')}.png`));
    const shortWin = spawnSync(
      process.execPath,
      [CLI, 'cloth', '--frames', framesDir, '--pose', poseFile, '--windows', '0.0-0.3', '--out', out],
      { encoding: 'utf8' },
    );
    expect(shortWin.status).toBe(1);
    expect(shortWin.stderr).toContain('FAIL  CLOTH_WINDOW:');

    // Usage refusals (exit 2): both --rig and --frames, or neither
    expect(spawnSync(process.execPath, [CLI, 'cloth', '--out', out], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(process.execPath, [CLI, 'cloth', '--rig', rigPath, '--frames', framesDir, '--out', out], { encoding: 'utf8' }).status).toBe(2);

    // Zero hip width refusal -> CLOTH_HIP
    const p = new Problems();
    expect(() =>
      buildClothTrack(
        [{ i: 0, t: 0, hipX: 0, hipY: 0, hipW: 0, tiltDeg: 0, hemL: -10, hemR: 10, hemLY: 20, hemRY: 20, hemBandCx: 0, skirtCx: 0, skirtTop: 0, skirtBottom: 20 }],
        { subject: 's', method: 'm', source: 'src', fps: 24, unit: 'picture px' },
        undefined,
        p,
      ),
    ).toThrow('CLOTH_HIP');
    expect(median([1, 2, 3])).toBe(2);
  }, 60_000);

  test('Mode 2 hip holds: prints HOLD lines per held span joint by joint (P1) and holds in camera-normalised space before applying each frame camera (P2)', () => {
    const dir = tempDir();
    const framesDir = join(dir, 'frames-cam');
    mkdirSync(framesDir, { recursive: true });
    const plate = new Plate(400, 600);
    plate.rect(180, 300, 40, 80, [70, 110, 190, 255]);
    const plates3: Array<{ name: string; plate: Plate }> = [];
    for (let i = 0; i < 3; i++) {
      const p = join(framesDir, `f${String(i).padStart(2, '0')}.png`);
      plate.writePng(p);
      plates3.push({ name: p, plate });
    }

    // P2 exact control: stationary normalised hip midpoint at x = 10 (`r_hip` at x = 0, `l_hip` at x = 20, hipW = 20),
    // camera translations tx = 0, 100, 200 on frames 0, 1, 2, with the middle sample (frame 1) missing.
    // Holding in camera-normalised space and then applying each frame's camera must yield picture hip_x = 10, 110, 210 (not 10, 10, 210).
    const camPosePath = join(dir, 'cam-hold.pose.json');
    const makeFrameJoints = (rAt: Pt | null, lAt: Pt | null) => ({
      nose: { state: 'observed' as const, at: [10, 120] as Pt, score: 0.99 },
      neck: { state: 'observed' as const, at: [10, 150] as Pt, score: 0.99 },
      r_hip: rAt === null ? { state: 'missing' as const } : { state: 'observed' as const, at: rAt, score: 0.99 },
      l_hip: lAt === null ? { state: 'missing' as const } : { state: 'observed' as const, at: lAt, score: 0.99 },
    });
    const camSeqText = JSON.stringify({
      spec: 'rig-pose-sequence/1',
      space: { units: 'picture-px', origin: 'top-left', y: 'down' },
      width: 400,
      height: 600,
      source: 'cam-hold-control',
      cameraSource: 'hand',
      camera: [
        { s: 1, tx: 0, ty: 0, inliers: 50 },
        { s: 1, tx: 100, ty: 0, inliers: 50 },
        { s: 1, tx: 200, ty: 0, inliers: 50 },
      ],
      frames: [
        { t: 0, people: [{ id: 'a', joints: makeFrameJoints([0, 300], [20, 300]) }] },
        { t: Number((1 / FPS).toFixed(5)), people: [{ id: 'a', joints: makeFrameJoints(null, null) }] },
        { t: Number((2 / FPS).toFixed(5)), people: [{ id: 'a', joints: makeFrameJoints([0, 300], [20, 300]) }] },
      ],
    });
    writeFileSync(camPosePath, camSeqText);
    const camSeq = readPoseSequence(camSeqText, camPosePath);
    const camRes = measureFramesCloth(plates3, camSeq, camPosePath, framesDir, { alphaMin: 16 });
    const picHipXs = camRes.doc.frames.map((f) => f.hip_x * camRes.doc.hipWidth.median + camRes.doc.origin[0]);
    expect(picHipXs[0]).toBeCloseTo(10, 5);
    expect(picHipXs[1]).toBeCloseTo(110, 5);
    expect(picHipXs[2]).toBeCloseTo(210, 5);
    expect(camRes.holds).toEqual([
      { point: 'r_hip', from: 1, to: 1, source: 0, why: 'missing' },
      { point: 'l_hip', from: 1, to: 1, source: 0, why: 'missing' },
    ]);

    // P1 control: missing hip spans print exact HOLD lines, joint by joint, before the track is written.
    const frames6Dir = join(dir, 'frames-6');
    mkdirSync(frames6Dir, { recursive: true });
    for (let i = 0; i < 6; i++) plate.writePng(join(frames6Dir, `f${String(i).padStart(2, '0')}.png`));
    const spanPosePath = join(dir, 'span-hold.pose.json');
    writeFileSync(
      spanPosePath,
      JSON.stringify({
        spec: 'rig-pose-sequence/1',
        space: { units: 'picture-px', origin: 'top-left', y: 'down' },
        width: 400,
        height: 600,
        source: 'span-hold-control',
        frames: [
          // frame 0: l_hip missing (held from first good frame 1)
          { t: 0, people: [{ id: 'a', joints: makeFrameJoints([185, 300], null) }] },
          // frame 1: r_hip missing (held from frame 0), l_hip good
          { t: Number((1 / FPS).toFixed(5)), people: [{ id: 'a', joints: makeFrameJoints(null, [215, 300]) }] },
          // frame 2: both good
          { t: Number((2 / FPS).toFixed(5)), people: [{ id: 'a', joints: makeFrameJoints([185, 300], [215, 300]) }] },
          // frames 3–4: r_hip missing for a 2-frame span (held from frame 2)
          { t: Number((3 / FPS).toFixed(5)), people: [{ id: 'a', joints: makeFrameJoints(null, [215, 300]) }] },
          { t: Number((4 / FPS).toFixed(5)), people: [{ id: 'a', joints: makeFrameJoints(null, [215, 300]) }] },
          // frame 5: both good
          { t: Number((5 / FPS).toFixed(5)), people: [{ id: 'a', joints: makeFrameJoints([185, 300], [215, 300]) }] },
        ],
      }),
    );
    const outSpan = join(dir, 'span.cloth.json');
    const lines: string[] = [];
    runCloth({ kind: 'frames', frames: frames6Dir, pose: spanPosePath, alphaMin: 16, out: outSpan }, (l) => lines.push(l));
    const holdLines = lines.filter((l) => l.startsWith('  HOLD   '));
    expect(holdLines).toEqual([
      '  HOLD   point "r_hip" frame 1 (t=0.042s): missing; held frame 0\'s value',
      '  HOLD   point "r_hip" frames 3–4 (t=0.125–0.167s): missing; held frame 2\'s value',
      '  HOLD   point "l_hip" frame 0 (t=0.000s): missing; held frame 1\'s value',
    ]);
    const lastHoldIdx = lines.findLastIndex((l) => l.startsWith('  HOLD   '));
    const wroteIdx = lines.findIndex((l) => l.startsWith('  wrote '));
    expect(lastHoldIdx).toBeGreaterThan(0);
    expect(wroteIdx).toBeGreaterThan(lastHoldIdx);
  });
});
