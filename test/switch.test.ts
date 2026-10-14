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
