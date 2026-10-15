/**
 * rig-c/pose#102: a change of support does not slide the planted foot through
 * the switch's confirmation and blend. Once the incoming foot has been lower by
 * PLANT_SWITCH for PLANT_SWITCH_SECONDS, it takes support from the landing
 * frame it crossed that margin on, and placeHip blends only y over PLANT_BLEND
 * frames while taking the new derivation's x immediately. Held by a synthetic
 * sequence with a known step gap and switch frame, and by planted mutants
 * (reading the switch late, or blending x) that must make the test red.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plantHip, supportsOf, type Feet, type Side } from '../src/legs.ts';
import type { JointMap, RigSlots } from '../src/map.ts';
import { selectSwitches, type SwitchOptions } from '../src/switch.ts';

const ROOT = join(import.meta.dir, '..');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
type Pt = [number, number];
const FPS = 30;
const N = 24;
const LEG = 100;
/** Known horizontal step gap between the outgoing and incoming feet at landing. */
const STEP_GAP = 40;
const LAND = 10;
const times = Array.from({ length: N }, (_, i) => i / FPS);
const secondsOf = (x: [number, number]) => (x[1] - x[0] + 1) / FPS;

/**
 * Picture px, y down. The body moves 2 px/frame to the right while the planted
 * foot stays on the ground: a grounded foot's offset from the hip slides back by
 * 2 px/frame. The right foot supports on frames 0–9 at x = 0, then lifts (1.5 px
 * on frame 9, 3 px from frame 10: 0.03 leg lengths >= PLANT_SWITCH, speed under
 * STEP_SPEED) and travels with the hip from frame 10. The left foot is at
 * x = STEP_GAP (held on the ground from frame 10, so its offset from the hip
 * changes by -2 px/frame while the lifted right foot's offset stays constant)
 * and is lower from frame 10 through 23 (confirmed at frame 12: frames 10–12 = 0.1 s).
 */
function stepSwitch(): { ankle: Record<Side, Pt[]>; hip: Record<Side, Pt[]>; offset: (i: number, s: Side) => Pt } {
  const ankle = { r: [] as Pt[], l: [] as Pt[] };
  const hip = { r: [] as Pt[], l: [] as Pt[] };
  for (let i = 0; i < N; i++) {
    const hx = 2 * i;
    hip.r.push([hx - 10, 0]);
    hip.l.push([hx + 10, 0]);
    // Right ankle stays planted at x = 0 on frames 0–9, then lifts and moves with the hip (2 px/frame < STEP_SPEED = 3 px/frame).
    const rx = i < LAND ? 0 : 2 * (i - LAND);
    const ry = i < LAND - 1 ? LEG : i === LAND - 1 ? LEG - 1.5 : LEG - 3;
    // Left ankle moves with the hip until landing at x = STEP_GAP on frame 10, then stays planted at x = STEP_GAP on the floor (y = LEG).
    const lx = i < LAND ? STEP_GAP - 2 * (LAND - i) : STEP_GAP;
    const ly = i < LAND - 1 ? LEG - 3 : i === LAND - 1 ? LEG - 1.5 : LEG;
    ankle.r.push([rx, ry]);
    ankle.l.push([lx, ly]);
  }
  const offset = (i: number, s: Side): Pt => {
    const hx = 2 * i;
    return [ankle[s][i]![0] - hx, -ankle[s][i]![1]];
  };
  return { ankle, hip, offset };
}

function worldAnkleX(hip: Pt[], offset: (i: number, s: Side) => Pt, i: number, s: Side): number {
  return hip[i]![0] + offset(i, s)[0];
}

describe('#102: a change of support holds the planted foot from landing through confirmation and blend', () => {
  test('synthetic step switch: the incoming foot takes support at landing (frame 10) and holds its horizontal anchor through confirmation (10–11) and blend (10–12) while y blends', () => {
    const s = stepSwitch();
    const feet = supportsOf(s.ankle, s.hip, times, secondsOf, false, true);
    // Confirmed at frame 12 (frames 10–12 = 0.1 s at 30 fps), support switches at landing frame 10.
    expect(feet.supports).toEqual([
      { side: 'r', frames: [0, LAND - 1] },
      { side: 'l', frames: [LAND, N - 1] },
    ]);
    expect(feet.changes).toEqual([
      { frame: 0, from: null, to: 'r' },
      { frame: LAND, from: 'r', to: 'l' },
    ]);
    const p = plantHip(feet, s.offset, (i) => [2 * i, 0], [0, 0]);
    // Right foot holds its horizontal anchor on frames 0–9.
    const rAnchor = worldAnkleX(p.hip, s.offset, 0, 'r');
    for (let i = 0; i < LAND; i++) expect(Math.abs(worldAnkleX(p.hip, s.offset, i, 'r') - rAnchor)).toBeLessThan(1e-9);
    // Left foot lands STEP_GAP (40 px) ahead of the right foot and holds its horizontal anchor from landing frame 10 through confirmation (10–11), blend (10–12), and the rest of the span (10–23).
    const lAnchor = worldAnkleX(p.hip, s.offset, LAND, 'l');
    expect(lAnchor - rAnchor).toBeCloseTo(STEP_GAP, 9);
    for (let i = LAND; i < N; i++) expect(Math.abs(worldAnkleX(p.hip, s.offset, i, 'l') - lAnchor)).toBeLessThan(1e-9);
    // Meanwhile hip.y blends with weights 1/4, 2/4, 3/4 across the 3 blend frames (10, 11, 12) between the outgoing and incoming y derivations (-4.5 to -1.5).
    expect(p.blends.map((b) => b.frame)).toEqual([LAND, LAND + 1, LAND + 2]);
    expect(p.hip[LAND]![1]).toBeCloseTo(-3.75, 9);
    expect(p.hip[LAND + 1]![1]).toBeCloseTo(-3.0, 9);
    expect(p.hip[LAND + 2]![1]).toBeCloseTo(-2.25, 9);
    expect(p.hip[LAND + 3]![1]).toBeCloseTo(-1.5, 9);
  });

  test('mutant: reading the switch late (at the end of the 0.1 s confirmation) slides the planted foot on the confirmation frames', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'for (let k = freeFrom; k < i; k++) support[k] = other;\n            changes.push({ frame: freeFrom, from: cur, to: other });';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'changes.push({ frame: i, from: cur, to: other });'));
      const m = (await import(path)) as { supportsOf: typeof supportsOf; plantHip: typeof plantHip };
      const s = stepSwitch();
      const feet = m.supportsOf(s.ankle, s.hip, times, secondsOf, false, true);
      const p = m.plantHip(feet, s.offset, (i) => [2 * i, 0], [0, 0]);
      // Switched late at frame 12 instead of 10: the left foot slides 4 px on frames 10–12 instead of holding from frame 10.
      expect(feet.changes[1]!.frame).toBe(LAND + 2);
      const slide = Math.abs(worldAnkleX(p.hip, s.offset, LAND + 2, 'l') - worldAnkleX(p.hip, s.offset, LAND, 'l'));
      console.log(`  mutant "late switch": change frame ${feet.changes[1]!.frame}, planted foot drift on frames 10–12 = ${slide.toFixed(2)} px`);
      expect(slide).toBeCloseTo(4, 9);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('mutant: blending hip.x across PLANT_BLEND slides the planted foot across the 3 blend frames', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'legs.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'hip.push([to[0], f[1] + (to[1] - f[1]) * w]);';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'hip.push([f[0] + (to[0] - f[0]) * w, f[1] + (to[1] - f[1]) * w]);'));
      const m = (await import(path)) as { supportsOf: typeof supportsOf; plantHip: typeof plantHip };
      const s = stepSwitch();
      const feet: Feet = m.supportsOf(s.ankle, s.hip, times, secondsOf, false, true);
      const p = m.plantHip(feet, s.offset, (i) => [2 * i, 0], [0, 0]);
      // Blending hip.x between the outgoing foot's derivation (which stays at hip x = 20) and the incoming foot's derivation (20, 22, 24) pulls the planted left foot off its anchor on the blend frames.
      const held = worldAnkleX(p.hip, s.offset, LAND + 3, 'l');
      const drift = Math.max(...[LAND, LAND + 1, LAND + 2].map((i) => Math.abs(worldAnkleX(p.hip, s.offset, i, 'l') - held)));
      console.log(`  mutant "blend x": planted foot drift across blend frames 10–12 = ${drift.toFixed(2)} px`);
      expect(drift).toBeCloseTo(1, 9);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * Synthetic rig and pose for #136:
 * - Draw order: 0 `forearm_r_back`, 1 `forearm_l_back`, 2 `topwear` (torso, never hidden),
 *   3 `forearm_r` (setup), 4 `forearm_l` (setup), 5 `forearm_r_front`, 6 `forearm_l_front`.
 * - `K_back` draws both arms behind `topwear` (slots 0, 1; hides 3, 4, 5, 6), key angle -90° on both arms.
 * - `K_front` draws both arms in front of `topwear` (slots 5, 6; hides 0, 1, 3, 4), key angle -80° on `arm_r`, -50° on `arm_l`.
 * - Over 28 frames at 24 fps (`switchMin = 0.25s` = 6 frames, `2 * switchMin = 0.50s` = 12 frames):
 *   - Frames 0–9 (10 frames): `arm_r = -90°`, `arm_l = -90°` (`K_back`, distance 0°).
 *   - Frames 10–17 (8 frames = 0.333s >= switchMin, < 2 * switchMin): `arm_r = -90°` (10° from `K_front`, 0° from `K_back`),
 *     `arm_l = -50°` (0° from `K_front`, 40° > 25° from `K_back`) -> `K_front` has distance 10° <= 25°, a short front window
 *     between two behind windows while `arm_r` stays behind at `K_back`.
 *   - Frames 18–27 (10 frames): `arm_r = -90°`, `arm_l = -90°` (`K_back`, distance 0°).
 */
function shortFrontBetweenBehind(): { map: JointMap; targets: Map<string, number[]>; times: number[]; duration: number; slots: RigSlots; opts: SwitchOptions } {
  const n = 28;
  const fps = 24;
  const t = Array.from({ length: n }, (_, i) => i / fps);
  const slots: RigSlots = new Map([
    ['forearm_r_back', { setup: null, attachments: new Set(['K_back_r']), bone: 'arm_r0' }],
    ['forearm_l_back', { setup: null, attachments: new Set(['K_back_l']), bone: 'arm_l0' }],
    ['topwear', { setup: 'topwear', attachments: new Set(['topwear', 'K_back_top', 'K_front_top']), bone: 'chest' }],
    ['forearm_r', { setup: 'forearm_r', attachments: new Set(['forearm_r']), bone: 'arm_r0' }],
    ['forearm_l', { setup: 'forearm_l', attachments: new Set(['forearm_l']), bone: 'arm_l0' }],
    ['forearm_r_front', { setup: null, attachments: new Set(['K_front_r']), bone: 'arm_r0' }],
    ['forearm_l_front', { setup: null, attachments: new Set(['K_front_l']), bone: 'arm_l0' }],
  ]);
  const map: JointMap = {
    translate: null,
    chains: [
      { name: 'arm_r', bones: ['arm_r0'], joints: ['r_shoulder', 'r_wrist'], aim: ['x'], range: {}, bend: 'free', reach: false },
      { name: 'arm_l', bones: ['arm_l0'], joints: ['l_shoulder', 'l_wrist'], aim: ['x'], range: {}, bend: 'free', reach: false },
    ],
    alternates: [
      {
        name: 'K_back',
        slots: { forearm_r_back: 'K_back_r', forearm_l_back: 'K_back_l', topwear: 'K_back_top' },
        hides: ['forearm_r', 'forearm_l', 'forearm_r_front', 'forearm_l_front'],
        offsets: {},
        chains: ['arm_r', 'arm_l'],
        pose: {
          r_shoulder: [0, 0],
          r_wrist: [0, 100], // pictureAngle = -90°
          l_shoulder: [0, 0],
          l_wrist: [0, 100], // pictureAngle = -90°
        },
        drawn: { arm_r0: -90, arm_l0: -90 },
        turn: { arm_r0: [-5, 5], arm_l0: [-5, 5] },
        frames: null,
        place: null,
      },
      {
        name: 'K_front',
        slots: { forearm_r_front: 'K_front_r', forearm_l_front: 'K_front_l', topwear: 'K_front_top' },
        hides: ['forearm_r_back', 'forearm_l_back', 'forearm_r', 'forearm_l'],
        offsets: {},
        chains: ['arm_r', 'arm_l'],
        pose: {
          r_shoulder: [0, 0],
          r_wrist: [100 * Math.cos((-80 * Math.PI) / 180), -100 * Math.sin((-80 * Math.PI) / 180)], // pictureAngle = -80°
          l_shoulder: [0, 0],
          l_wrist: [100 * Math.cos((-50 * Math.PI) / 180), -100 * Math.sin((-50 * Math.PI) / 180)], // pictureAngle = -50°
        },
        drawn: { arm_r0: -80, arm_l0: -50 },
        turn: { arm_r0: [-20, 20], arm_l0: [-20, 20] },
        frames: null,
        place: null,
      },
    ],
  };
  const armR = Array.from({ length: n }, () => -90);
  const armL = Array.from({ length: n }, (_, i) => (i >= 10 && i <= 17 ? -50 : -90));
  const targets = new Map<string, number[]>([
    ['arm_r0', armR],
    ['arm_l0', armL],
  ]);
  const opts: SwitchOptions = { switchTolerance: 25, switchMin: 0.25, switchAt: 'first' };
  return { map, targets, times: t, duration: t[n - 1]!, slots, opts };
}

describe('#136: a short front-set window between two behind-set windows is dropped, and the behind chain stays behind the torso', () => {
  test('synthetic: short front window (frames 10–17, 0.333s < 2 * switchMin) between two behind windows (0–9, 18–27) is dropped and arm_r stays behind topwear on all 28 frames', () => {
    const s = shortFrontBetweenBehind();
    const sw = selectSwitches(s.map, s.targets, s.times, s.duration, s.slots, s.opts);
    // K_front on 10–17 is dropped; only the two K_back windows remain.
    expect(sw.switches.map((x) => ({ set: x.set, frames: x.frames }))).toEqual([
      { set: 'K_back', frames: [0, 9] },
      { set: 'K_back', frames: [18, 27] },
    ]);
    // Over all 28 frames (0–27), arm_r stays behind topwear (forearm_r_back shown, front setup forearm_r hidden).
    for (let i = 0; i < 28; i++) {
      expect(sw.shown.get('forearm_r_back')![i]).toBe('K_back_r');
      expect(sw.shown.get('forearm_r')![i]).toBeNull();
      expect(sw.shown.get('forearm_r_front')![i]).toBeNull();
    }
    // arm_l is behind topwear on 0–9 and 18–27, and in front (setup forearm_l) only on 10–17.
    for (let i = 0; i < 28; i++) {
      const inExcursion = i >= 10 && i <= 17;
      expect(sw.shown.get('forearm_l_back')![i]).toBe(inExcursion ? null : 'K_back_l');
      expect(sw.shown.get('forearm_l')![i]).toBe(inExcursion ? 'forearm_l' : null);
      expect(sw.shown.get('forearm_l_front')![i]).toBeNull();
    }
  });

  test("mutant: under today's rule (without the #136 short-front-window drop), K_front shows on 10–17 and pulls both arms in front of topwear", async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'switch.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'if (layer.torsoRank !== null) {';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'if (false && layer.torsoRank !== null) {'));
      const m = (await import(path)) as { selectSwitches: typeof selectSwitches };
      const s = shortFrontBetweenBehind();
      const sw = m.selectSwitches(s.map, s.targets, s.times, s.duration, s.slots, s.opts);
      console.log(`  mutant "today's rule": switches = ${sw.switches.map((x) => `${x.set}[${x.frames[0]}–${x.frames[1]}]`).join(', ')}`);
      expect(sw.switches.map((x) => ({ set: x.set, frames: x.frames }))).toEqual([
        { set: 'K_back', frames: [0, 9] },
        { set: 'K_front', frames: [10, 17] },
        { set: 'K_back', frames: [18, 27] },
      ]);
      // Under the mutant, arm_r is pulled in front of topwear (forearm_r_front) on frames 10–17.
      expect(sw.shown.get('forearm_r_front')![10]).toBe('K_front_r');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

