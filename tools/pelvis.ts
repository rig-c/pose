/**
 * The pelvis path against the reference (rig-c/pose#47), per window: the pass
 * bands the card fixed before the run, read on the gated build posed by rig-c.
 * Not shipped.
 *
 *   bun tools/pelvis.ts --build <dir> --pose <reference.pose.json> --map <map.json> \
 *     --report <retarget report.json> --windows 88-181,183-261 [--name dance] [--min-score 0.3] \
 *     [--out <bands.json>] [--plot <paths.png>]
 *
 * - Reference: mid_hip as read (no hold, no smoothing; a frame counts where both
 *   hips are good), picture px, y down. Rig: the translated bone's world origin.
 * - Vertical: the hip's height range over the window, in that side's median leg
 *   length (hip → ankle: the reference's mean of both sides' |hip → ankle| per
 *   frame, the rig's mean of both thighs' origin → ankle tip; medians over all
 *   frames). Lateral: the x range in that side's median hip width (reference
 *   |r_hip − l_hip|, rig the two thigh roots apart).
 * - Rebound: at every local minimum of the reference's height (the lowest of
 *   the 5 frames centred on it, inside the window), the peak upward
 *   acceleration within ±2 frames — the second difference of height, per leg
 *   length per frame² — on each side, rig ÷ reference; the median over the
 *   window's minima.
 * - Feet: per support span the retarget's report lists (the reference's
 *   supports, jumps excepted), the supporting ankle's vertical range and
 *   horizontal drift on the rig over the span's frames inside the window, in
 *   the rig's leg length of that side; and the lowest ankle's vertical range
 *   over the window's frames outside jumps.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readModel } from 'rig-c/core';
import { Plate, type RGBA } from 'rig-c/plate';
import type { Body18 } from '../src/joints.ts';
import { readMap, pointAt } from '../src/map.ts';
import { personTrack, readPoseSequence } from '../src/pose.ts';
import { pointOn } from '../src/retarget.ts';
import { poseFrames } from '../src/verify.ts';

type Pt = [number, number];
const args = process.argv.slice(2);
const flag = (name: string, dflt?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : dflt;
  if (v === undefined) {
    process.stderr.write(`pelvis.ts: --${name} is required\n`);
    process.exit(2);
  }
  return v;
};
const build = flag('build');
const posePath = flag('pose');
const map = readMap(readFileSync(flag('map'), 'utf8'), flag('map'));
const report = JSON.parse(readFileSync(flag('report'), 'utf8')) as {
  options: Record<string, unknown>;
  feet: { supports: Array<{ side: 'r' | 'l'; frames: [number, number] }>; jumps: Array<[number, number]> } | null;
};
const windows = flag('windows').split(',').map((w) => w.split('-').map(Number) as [number, number]);
const name = flag('name', 'dance');
const minScore = Number(flag('min-score', '0.3'));
const out = args.includes('--out') ? flag('out') : null;
const plot = args.includes('--plot') ? flag('plot') : null;

const seq = readPoseSequence(readFileSync(posePath, 'utf8'), posePath);
const frames = personTrack(seq, undefined, posePath);
const t0 = seq.frames[0]!.t;
const times = seq.frames.map((f) => Math.round((f.t - t0) * 1e6) / 1e6);
const n = frames.length;
const doc = readModel(readFileSync(join(build, 'skeleton.model.json'), 'utf8'), join(build, 'skeleton.model.json'));
const posed = poseFrames(doc, name, times);
const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));

const median = (xs: number[]): number => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const at = (i: number, j: string): Pt | null => {
  const v = pointOn(frames[i]!, j as Body18, minScore);
  return typeof v === 'string' ? null : v;
};
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The reference.
const refHip: Array<Pt | null> = Array.from({ length: n }, (_, i) => at(i, 'mid_hip'));
const refWidth = median(Array.from({ length: n }, (_, i) => {
  const r = at(i, 'r_hip');
  const l = at(i, 'l_hip');
  return r && l ? dist(r, l) : NaN;
}));
const refLeg = median(Array.from({ length: n }, (_, i) => {
  const ls = (['r', 'l'] as const).map((s) => {
    const h = at(i, `${s}_hip`);
    const a = at(i, `${s}_ankle`);
    return h && a ? dist(h, a) : NaN;
  });
  return (ls[0]! + ls[1]!) / 2;
}));

// The rig.
const legChain = (s: 'r' | 'l') => map.chains.find((c) => !c.reach && c.joints[c.joints.length - 1] === `${s}_ankle`)!;
const roots = { r: legChain('r').bones[0]!, l: legChain('l').bones[0]! };
const ankles = { r: legChain('r').bones.at(-1)!, l: legChain('l').bones.at(-1)! };
const hipBone = map.translate!.bone;
const rigHip: Pt[] = posed.map((b) => [b.get(hipBone)!.worldX, b.get(hipBone)!.worldY]);
const tip = (i: number, s: 'r' | 'l'): Pt => pointAt(posed[i]!, lengths, `${ankles[s]}:tip`)!;
const rootAt = (i: number, s: 'r' | 'l'): Pt => [posed[i]!.get(roots[s])!.worldX, posed[i]!.get(roots[s])!.worldY];
const rigWidth = median(posed.map((_, i) => dist(rootAt(i, 'r'), rootAt(i, 'l'))));
const rigLegSide = { r: median(posed.map((_, i) => dist(rootAt(i, 'r'), tip(i, 'r')))), l: median(posed.map((_, i) => dist(rootAt(i, 'l'), tip(i, 'l')))) };
const rigLeg = median(posed.map((_, i) => (dist(rootAt(i, 'r'), tip(i, 'r')) + dist(rootAt(i, 'l'), tip(i, 'l'))) / 2));

const range = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
const jump = new Set<number>();
for (const [a, b] of report.feet?.jumps ?? []) for (let i = a; i <= b; i++) jump.add(i);

interface Band {
  window: [number, number];
  vertical: { reference: number; rig: number; ratio: number; referenceHipWidths: number; rigHipWidths: number };
  lateral: { reference: number; rig: number; ratio: number };
  rebound: { minima: Array<{ frame: number; reference: number; rig: number; ratio: number }>; median: number | null };
  feet: { plants: Array<{ side: string; frames: [number, number]; vertical: number; horizontal: number }>; worstVertical: number; worstHorizontal: number; lowest: number; lowestFrames: number };
}
const bands: Band[] = windows.map(([a, b]) => {
  const idx = Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const ry = idx.flatMap((i) => (refHip[i] ? [refHip[i]![1]] : []));
  const rx = idx.flatMap((i) => (refHip[i] ? [refHip[i]![0]] : []));
  const gy = idx.map((i) => rigHip[i]![1]);
  const gx = idx.map((i) => rigHip[i]![0]);
  const vertical = { reference: range(ry) / refLeg, rig: range(gy) / rigLeg, ratio: 0, referenceHipWidths: range(ry) / refWidth, rigHipWidths: range(gy) / rigWidth };
  vertical.ratio = vertical.rig / vertical.reference;
  const lateral = { reference: range(rx) / refWidth, rig: range(gx) / rigWidth, ratio: 0 };
  lateral.ratio = lateral.rig / lateral.reference;
  // Heights: the reference's −y (picture y down), the rig's y (world y up), each in its own leg lengths.
  const hRef = (i: number) => (refHip[i] ? -refHip[i]![1] / refLeg : NaN);
  const hRig = (i: number) => rigHip[i]![1] / rigLeg;
  const acc = (h: (i: number) => number, k: number) => (k - 1 >= 0 && k + 1 < n ? h(k + 1) - 2 * h(k) + h(k - 1) : NaN);
  const minima: Band['rebound']['minima'] = [];
  for (let i = a + 2; i <= b - 2; i++) {
    const v = hRef(i);
    if (!Number.isFinite(v)) continue;
    let lowest = true;
    for (let j = i - 2; j <= i + 2; j++) if (j !== i && (hRef(j) < v || (hRef(j) === v && j < i))) lowest = false;
    if (!lowest) continue;
    const peak = (h: (i: number) => number) => Math.max(...[-2, -1, 0, 1, 2].map((d) => acc(h, i + d)).filter(Number.isFinite));
    const pr = peak(hRef);
    const pg = peak(hRig);
    minima.push({ frame: i, reference: pr, rig: pg, ratio: pg / pr });
  }
  const rebound = { minima, median: minima.length === 0 ? null : median(minima.map((m) => m.ratio)) };
  const plants: Band['feet']['plants'] = [];
  for (const s of report.feet?.supports ?? []) {
    const lo = Math.max(a, s.frames[0]);
    const hi = Math.min(b, s.frames[1]);
    if (lo > hi) continue;
    const pts = Array.from({ length: hi - lo + 1 }, (_, k) => tip(lo + k, s.side));
    plants.push({ side: s.side, frames: [lo, hi], vertical: range(pts.map((p) => p[1])) / rigLegSide[s.side], horizontal: range(pts.map((p) => p[0])) / rigLegSide[s.side] });
  }
  const low = idx.filter((i) => !jump.has(i)).map((i) => Math.min(tip(i, 'r')[1], tip(i, 'l')[1]));
  return {
    window: [a, b],
    vertical,
    lateral,
    rebound,
    feet: {
      plants,
      worstVertical: Math.max(0, ...plants.map((p) => p.vertical)),
      worstHorizontal: Math.max(0, ...plants.map((p) => p.horizontal)),
      lowest: low.length === 0 ? NaN : range(low) / rigLeg,
      lowestFrames: low.length,
    },
  };
});

const result = { build, options: report.options, reference: { hipWidth: refWidth, legLength: refLeg }, rig: { hipWidth: rigWidth, legLength: rigLeg, legLengthSide: rigLegSide }, bands };
const f3 = (x: number | null) => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(3));
const f4 = (x: number) => x.toFixed(4);
for (const bd of bands) {
  const pass = (x: number | null, lo: number, hi: number) => (x !== null && x >= lo && x <= hi ? 'pass' : 'FAIL');
  console.log(`window ${bd.window[0]}–${bd.window[1]}:`);
  console.log(`  1 vertical  reference ${f3(bd.vertical.reference)} rig ${f3(bd.vertical.rig)} leg lengths (${f3(bd.vertical.referenceHipWidths)} / ${f3(bd.vertical.rigHipWidths)} hip widths) — ratio ${f3(bd.vertical.ratio)} [0.85, 1.15] ${pass(bd.vertical.ratio, 0.85, 1.15)}`);
  console.log(`  2 lateral   reference ${f3(bd.lateral.reference)} rig ${f3(bd.lateral.rig)} hip widths — ratio ${f3(bd.lateral.ratio)} [0.85, 1.15] ${pass(bd.lateral.ratio, 0.85, 1.15)}`);
  console.log(`  3 rebound   ${bd.rebound.minima.length} minima (${bd.rebound.minima.map((m) => `${m.frame}: ${f3(m.ratio)}`).join(', ')}) — median ratio ${f3(bd.rebound.median)} [0.7, 1.3] ${pass(bd.rebound.median, 0.7, 1.3)}`);
  console.log(`  4 feet      worst plant vertical ${f4(bd.feet.worstVertical)} horizontal ${f4(bd.feet.worstHorizontal)} leg lengths [≤ 0.02] ${bd.feet.plants.length === 0 ? 'no plant' : bd.feet.worstVertical <= 0.02 && bd.feet.worstHorizontal <= 0.02 ? 'pass' : 'FAIL'}; lowest ankle vertical range ${f4(bd.feet.lowest)} leg lengths over ${bd.feet.lowestFrames} frames outside jumps`);
}
if (out !== null) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);

// The plot: per window, the height over time and the path, reference red, rig blue.
if (plot !== null) {
  const RED: RGBA = [214, 69, 65, 255];
  const BLUE: RGBA = [52, 120, 214, 255];
  const INK: RGBA = [30, 30, 30, 255];
  const GRID: RGBA = [210, 210, 210, 255];
  const W = 520;
  const H = 300;
  const G = 24;
  const plate = new Plate(G + 2 * (W + G), G + windows.length * (H + 3 * G));
  plate.rect(0, 0, plate.width, plate.height, [255, 255, 255, 255]);
  windows.forEach(([a, b], row) => {
    const y0 = G + row * (H + 3 * G) + 2 * G;
    const idx = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    const centre = (xs: number[]) => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      return xs.map((x) => x - m);
    };
    // Heights in leg lengths, each centred on its window mean.
    const hr = centre(idx.map((i) => (refHip[i] ? -refHip[i]![1] / refLeg : NaN)));
    const hg = centre(idx.map((i) => rigHip[i]![1] / rigLeg));
    const xr = centre(idx.map((i) => (refHip[i] ? refHip[i]![0] / refWidth : NaN)));
    const xg = centre(idx.map((i) => rigHip[i]![0] / rigWidth));
    const hMax = Math.max(...hr.map(Math.abs), ...hg.map(Math.abs)) * 1.1;
    const xMax = Math.max(...xr.map(Math.abs), ...xg.map(Math.abs)) * 1.1;
    plate.text(`frames ${a}-${b}: hip height (leg lengths) over time`, G, y0 - 2 * G + 4, 1, INK);
    plate.text('path: x (hip widths) vs height (leg lengths)', 2 * G + W, y0 - 2 * G + 4, 1, INK);
    plate.text('red reference, blue rig', G, y0 - G + 4, 1, INK);
    plate.frame(G, y0, W, H, 1, GRID);
    plate.frame(2 * G + W, y0, W, H, 1, GRID);
    plate.line(G, y0 + H / 2, G + W, y0 + H / 2, 1, GRID);
    const tx = (k: number) => G + (k / (idx.length - 1)) * W;
    const ty = (h: number) => y0 + H / 2 - (h / hMax) * (H / 2);
    const px = (x: number) => 2 * G + W + W / 2 + (x / xMax) * (W / 2);
    for (const [hs, xs, c] of [[hr, xr, RED], [hg, xg, BLUE]] as Array<[number[], number[], RGBA]>) {
      for (let k = 1; k < idx.length; k++) {
        if (!Number.isFinite(hs[k - 1]!) || !Number.isFinite(hs[k]!)) continue;
        plate.line(tx(k - 1), ty(hs[k - 1]!), tx(k), ty(hs[k]!), 2, c);
        plate.line(px(xs[k - 1]!), ty(hs[k - 1]!), px(xs[k]!), ty(hs[k]!), 2, c);
      }
    }
    for (const m of bands[row]!.rebound.minima) plate.ring(tx(m.frame - a), ty(hr[m.frame - a]!), 4, 1, INK);
  });
  plate.writePng(plot);
}
