/**
 * rig-c/pose#280: on a frontal walk the lower ankle is the nearer foot, not the
 * planted one, so support needs a second signal beside ankle height — the
 * ankle's vertical speed against the ground's. Held by a synthetic frontal walk
 * with a known contact table (both feet down on 4 of its 8 drawn frames, the
 * nearer foot drawn lower), read frame by frame against it; by side views the
 * second signal must leave alone; and by a planted mutant (the frontal reading
 * never taking over) that must make the first test red.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from '../src/clean.ts';
import { FRONTAL_DISAGREE, supportsOf, type Contact, type Side } from '../src/legs.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const SLOW = 60_000;
type Pt = [number, number];

// --- the fixture -------------------------------------------------------------

/** Drawn at 12 fps (on twos) and interpolated to 24 fps: each drawing is followed by one in-between, its neighbours' midpoint. */
const FPS = 24;
const DRAWINGS = 8;
const CYCLE = 2 * DRAWINGS;
const CYCLES = 6;
const N = CYCLE * CYCLES;
/** The ankle on the floor at the front (nearest the camera, lowest in the picture), px, y down; the hips above at HIP_Y. */
const FLOOR_Y = 553;
const HIP_Y = 403;
const X: Record<Side, number> = { r: 185, l: 215 };
/** Each foot's depth from front to back as the picture draws it, px: 17 for the right, 23 for the left. */
const DEPTH: Record<Side, number> = { r: 17, l: 23 };
/** The drawing each foot lands on, at the front. */
const LANDS: Record<Side, number> = { r: 0, l: 4 };
/** The swinging foot's lift on its two swing drawings, px. */
const LIFT = [3, 2];

/** Drawings since this foot landed: 0–5 down (sliding back), 6–7 in the air (swinging forward). */
const phaseOf = (s: Side, k: number): number => (((k - LANDS[s]) % DRAWINGS) + DRAWINGS) % DRAWINGS;
const downOn = (s: Side, k: number): boolean => phaseOf(s, k) <= 5;

/**
 * One drawing's ankle, picture px. A walk in place seen from the front: a foot
 * lands at the front and slides back while it is down (5 drawings, its depth in
 * fifths), then swings forward to land again (3 drawings, its depth in thirds),
 * lifted on the two drawings in the air. Depth reads as height in the picture,
 * so the nearer foot is drawn lower.
 */
function drawn(s: Side, k: number): Pt {
  const j = phaseOf(s, k);
  const z = j <= 5 ? j / 5 : (DRAWINGS - j) / 3;
  const lift = j === 6 ? LIFT[0]! : j === 7 ? LIFT[1]! : 0;
  return [X[s], FLOOR_Y - DEPTH[s] * z - lift];
}

/** The ankles and hips on every 24 fps frame, and the contact table: a foot is down on a drawing as drawn, and on an in-between when it is down on both drawings either side. */
function frontalWalk(): { ankle: Record<Side, Pt[]>; hip: Record<Side, Pt[]>; table: Contact[] } {
  const ankle = { r: [] as Pt[], l: [] as Pt[] };
  const hip = { r: [] as Pt[], l: [] as Pt[] };
  const table: Contact[] = [];
  for (let i = 0; i < N; i++) {
    const k = Math.floor((i % CYCLE) / 2);
    const between = i % 2 === 1;
    const down = {} as Record<Side, boolean>;
    for (const s of ['r', 'l'] as const) {
      const a = drawn(s, k);
      const b = drawn(s, k + 1);
      ankle[s].push(between ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a);
      hip[s].push([X[s], HIP_Y]);
      down[s] = between ? downOn(s, k) && downOn(s, k + 1) : downOn(s, k);
    }
    table.push(down.r && down.l ? 'both' : down.r ? 'r' : down.l ? 'l' : null);
  }
  return { ankle, hip, table };
}

const times = Array.from({ length: N }, (_, i) => i / FPS);
const secondsOf = (x: [number, number]) => (x[1] - x[0] + 1) / FPS;
const code = (c: Contact): string => (c === 'both' ? 'B' : c ?? '-');
/** A frame's support agrees with the table when the side read is down on it. */
const agrees = (support: Side | null, table: Contact): boolean => support !== null && (table === support || table === 'both');

describe('#280: a frontal walk — support from the ankle\'s vertical speed', () => {
  test('the fixture is the card\'s: 8 drawings, both feet down on 4, the nearer foot lower, ankles moving 17–23 px in y', () => {
    const { ankle, table } = frontalWalk();
    const drawings = Array.from({ length: DRAWINGS }, (_, k) => table[2 * k]);
    expect(drawings.filter((c) => c === 'both')).toHaveLength(4);
    expect(drawings.map(code).join('')).toBe('BBrrBBll');
    const range = (s: Side) => Math.max(...ankle[s].map((a) => a[1])) - Math.min(...ankle[s].map((a) => a[1]));
    expect(range('r')).toBeCloseTo(17, 9);
    expect(range('l')).toBeCloseTo(23, 9);
    // On every both-down drawing the foot that landed last (the nearer) is the lower.
    for (const k of [0, 1]) expect(drawn('r', k)[1]).toBeGreaterThan(drawn('l', k)[1]);
    for (const k of [4, 5]) expect(drawn('l', k)[1]).toBeGreaterThan(drawn('r', k)[1]);
  });

  for (const inPlace of [true, false]) {
    test(`${inPlace ? 'declared in place' : 'not declared'}: the contact read is the table on every frame (0 mismatches), the clip is named frontal, and every support is a foot that is down`, () => {
      const { ankle, hip, table } = frontalWalk();
      const feet = supportsOf(ankle, hip, times, secondsOf, inPlace, !inPlace);
      const sig = feet.signal!;
      const rows = table.map((t, i) => `${String(i).padStart(3)} ${code(t).padEnd(5)}${code(sig.contact[i]!).padEnd(8)}${code(feet.support[i]!).padEnd(8)}${code(sig.height[i]!).padEnd(7)}${ankle.r[i]![1].toFixed(2)} ${ankle.l[i]![1].toFixed(2)}`);
      if (inPlace) console.log(`  #280 frame table contact support height yR yL (first cycle)\n${rows.slice(0, CYCLE + 1).join('\n')}`);
      const mismatches = table.filter((t, i) => sig.contact[i] !== t).length;
      const heightWrong = table.filter((t, i) => !agrees(sig.height[i] ?? null, t)).length;
      console.log(`  #280 ${inPlace ? 'in place' : 'travelling'}: contact mismatches ${mismatches} of ${N}; contradict ${sig.contradict.length} of ${sig.read} (${((100 * sig.contradict.length) / sig.read).toFixed(1)} %); ankle height alone supports a foot in the air on ${heightWrong} frame(s)`);
      expect(mismatches).toBe(0);
      expect(sig.frontal).toBe(true);
      expect(sig.contradict.length).toBeGreaterThan(FRONTAL_DISAGREE * sig.read);
      for (let i = 0; i < N; i++) expect(agrees(feet.support[i] ?? null, table[i]!)).toBe(true);
      expect(sig.by.every((b) => b === 'speed')).toBe(true);
      // Support passes to the incoming foot on the frame it lands: each span starts on a both-down frame whose single-foot neighbour before is the other side.
      expect(feet.supports.slice(0, 4)).toEqual([
        { side: 'r', frames: [0, 7] },
        { side: 'l', frames: [8, 15] },
        { side: 'r', frames: [16, 23] },
        { side: 'l', frames: [24, 31] },
      ]);
      expect(feet.supports).toHaveLength(2 * CYCLES);
      expect(feet.steps).toEqual([]);
      expect(feet.changes.filter((c) => c.from !== null).map((c) => c.frame)).toEqual(Array.from({ length: 2 * CYCLES - 1 }, (_, k) => 8 * (k + 1)));
      // Ankle height alone picks the nearer foot while it is still in the air.
      expect(heightWrong).toBeGreaterThan(0);
    });
  }

  test('mutant: the frontal reading never taking over leaves ankle height\'s support — a foot in the air on every hand-over — and the test above is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm280-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'const frontal = strideInDepth && sig.read > 0 && sig.contradict.length > FRONTAL_DISAGREE * sig.read;';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'const frontal = false;'));
      const m = (await import(path)) as { supportsOf: typeof supportsOf };
      const { ankle, hip, table } = frontalWalk();
      const feet = m.supportsOf(ankle, hip, times, secondsOf, true);
      const wrong = table.map((t, i) => (agrees(feet.support[i] ?? null, t) ? -1 : i)).filter((i) => i >= 0);
      console.log(`  #280 mutant "never frontal": a foot in the air read as support on ${wrong.length} frame(s): ${wrong.slice(0, 8).join(', ')}, …`);
      expect(wrong.length).toBeGreaterThan(0);
      // Two frames before each landing after the first: the nearer foot passes below the planted one in the air.
      expect(wrong.slice(0, 2)).toEqual([7, 14]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('#280: side views and a frontal walk on one floor are left to ankle height', () => {
  /** The README's walk (examples/walk): facing the camera with no depth, the swinging ankle lifted above the supporting one. */
  test('examples/walk: no contradiction, not frontal, every support decided by ankle height', () => {
    const doc = JSON.parse(readFileSync(join(ROOT, 'examples', 'walk', 'pose.json'), 'utf8')) as { frames: Array<{ t: number; people: Array<{ joints: Record<string, { at: Pt }> }> }> };
    const series = (j: string) => doc.frames.map((f) => f.people[0]!.joints[j]!.at);
    const ankle = { r: series('r_ankle'), l: series('l_ankle') };
    const hip = { r: series('r_hip'), l: series('l_hip') };
    const t = doc.frames.map((f) => f.t);
    const feet = supportsOf(ankle, hip, t, secondsOf, true, false);
    expect(feet.signal!.contradict).toEqual([]);
    expect(feet.signal!.frontal).toBe(false);
    expect(feet.signal!.by.every((b) => b === 'height')).toBe(true);
  });

  /** A side view: the supporting ankle slides back level while the other swings forward lifted (inplace.test.ts's gait). */
  test('a side-view gait in place: no contradiction, not frontal', () => {
    const n = 40;
    const half = n / 2;
    const foot = (k: number): Pt => (k < half ? [19 - 2 * k, 100] : [-19 + 2 * (k - half), 100 - Math.min(10, 2 * (k - half), 2 * (n - 1 - k))]);
    const ankle = { r: [] as Pt[], l: [] as Pt[] };
    const hip = { r: [] as Pt[], l: [] as Pt[] };
    for (let i = 0; i < n; i++) {
      const r = foot(i);
      const l = foot((i + half) % n);
      ankle.r.push([-10 + r[0], r[1]]);
      ankle.l.push([10 + l[0], l[1]]);
      hip.r.push([-10, 0]);
      hip.l.push([10, 0]);
    }
    const t = Array.from({ length: n }, (_, i) => i / FPS);
    for (const inPlace of [true, false]) {
      const feet = supportsOf(ankle, hip, t, secondsOf, inPlace, !inPlace);
      expect(feet.signal!.contradict).toEqual([]);
      expect(feet.signal!.frontal).toBe(false);
    }
  });
});

// --- the run -------------------------------------------------------------------

describe('#280: the report names the signal per stride, and the disagreement', () => {
  /** The fixture's legs on the README walk's still upper body (examples/walk, frame 0), knees on the hip → ankle line, `clean --loop`ed. */
  function frontalPose(): string {
    const walk = JSON.parse(readFileSync(join(ROOT, 'examples', 'walk', 'pose.json'), 'utf8')) as { width: number; height: number; frames: Array<{ people: Array<{ joints: Record<string, unknown> }> }> };
    const body = walk.frames[0]!.people[0]!.joints;
    const { ankle, hip } = frontalWalk();
    const frames = Array.from({ length: N }, (_, i) => {
      const joints: Record<string, unknown> = { ...body };
      for (const s of ['r', 'l'] as const) {
        const h = hip[s][i]!;
        const a = ankle[s][i]!;
        const u = 80 / 150;
        joints[`${s}_hip`] = { state: 'observed', at: h, score: 1 };
        joints[`${s}_knee`] = { state: 'observed', at: [h[0] + (a[0] - h[0]) * u, h[1] + (a[1] - h[1]) * u], score: 1 };
        joints[`${s}_ankle`] = { state: 'observed', at: a, score: 1 };
      }
      return { t: i / FPS, people: [{ id: 'a', joints }] };
    });
    const doc = { spec: 'rig-pose-sequence/1', space: { units: 'picture-px', origin: 'top-left', y: 'down' }, width: walk.width, height: walk.height, source: 'test/frontal.test.ts: a synthetic frontal walk, no picture', frames };
    const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
    const c = clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture');
    return writePoseSequence(c.seq);
  }

  test('two support lines name the vertical speed and the disagreement with N stated, a FEET line per stride names its signal, none over 260 characters; control: examples/walk prints none, by default or under --verbose', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-pose-test-'));
    try {
      const pose = join(dir, 'pose.json');
      writeFileSync(pose, frontalPose());
      const run = (seq: string, out: string, extra: string[] = []) => spawnSync(process.execPath, [CLI, 'retarget', '--rig', join(ROOT, 'examples', 'wave', 'rig'), '--map', join(ROOT, 'examples', 'walk', 'map.json'), '--pose', seq, '--out', join(dir, out), '--name', 'walk', '--plant-feet', ...extra], { encoding: 'utf8', cwd: ROOT });
      const feetOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('FEET '));
      const r = run(pose, 'frontal.motion.json');
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const feet = feetOf(r.stdout);
      const signal = feet.filter((l) => l.startsWith('FEET   support:'));
      const strides = feet.filter((l) => l.startsWith('FEET   stride '));
      console.log(`  #280 run:\n    ${[...signal, ...strides.slice(0, 3)].join('\n    ')}`);
      expect(signal).toEqual([
        'FEET   support: ankle vertical speed (rig-c/pose#280) — it contradicts ankle height on 18 of 96 frame(s) (18.8 %, past 5 %): the lower ankle moving while the higher moves with the ground',
        'FEET   support: read as a frontal view — ankles move more in y than x (x · y against the hips: r 0.0 · 17.0 px, l 0.0 · 23.0 px); ankle height only where neither foot moves with the ground',
      ]);
      expect(strides).toHaveLength(2 * CYCLES);
      expect(strides.slice(0, 2)).toEqual([
        'FEET   stride r 0–7: ankle vertical speed on 8 frame(s) (both feet down on 3); ankle height alone would read l on 1 of them',
        'FEET   stride l 8–15: ankle vertical speed on 8 frame(s) (both feet down on 3); ankle height alone would read r on 2 of them',
      ]);
      expect(strides.every((l) => l.includes(': ankle vertical speed on '))).toBe(true);
      expect(Math.max(...[...signal, ...strides].map((l) => `  ${l}`.length))).toBeLessThanOrEqual(260);
      // Control: the README's walk — not frontal; by default no support line and no stride line, so the default output keeps its length.
      const w = run(join(ROOT, 'examples', 'walk', 'pose.json'), 'walk.motion.json');
      expect(w.status).toBe(0);
      const wfeet = feetOf(w.stdout);
      expect(wfeet.filter((l) => l.startsWith('FEET   stride ') || l.startsWith('FEET   support:'))).toEqual([]);
      // Nor under --verbose: a clip the second signal does not decide prints as before in every mode.
      const v = run(join(ROOT, 'examples', 'walk', 'pose.json'), 'walk.verbose.motion.json', ['--verbose']);
      expect(v.status).toBe(0);
      expect(feetOf(v.stdout).filter((l) => l.startsWith('FEET   support:'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);
});
