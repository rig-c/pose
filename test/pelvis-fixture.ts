/** Public synthetic hip/hand fixture for rig-c/pose#431; names carry no anatomy. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plate } from 'rig-c/plate';
import { readMap, type Rest } from '../src/map.ts';
import type { Layout } from '../src/layout.ts';
import type { FrameDepth, Joint } from '../src/pose.ts';

export const HIP_ORDER = [
  { name: 'a', bone: 'sleeve_l1' }, { name: 'b', bone: 'sleeve_l0' },
  { name: 'c', bone: 'leg_r0' }, { name: 'd', bone: 'leg_r1' },
  { name: 'e', bone: 'leg_l0' }, { name: 'f', bone: 'leg_l1' },
  { name: 'g', bone: 'sleeve_r1' }, { name: 'h', bone: 'sleeve_r0' },
  { name: 'i', bone: 'chest' }, { name: 'j', bone: 'hip' }, { name: 'k', bone: 'chest' },
];
export const HIP_FRONT = { r: [3, 4], l: [1, 2] };
export function hipFixture() {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, '../examples/walk/map.json'), 'utf8')) as { chains: unknown[] };
  raw.chains.push({ name: 'axis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] });
  const bindings = [
    { limb: 'arm_l', parts: ['panel-a'], depth: 'l_forearm', against: 'trunk' },
    { limb: 'arm_r', parts: ['panel-g'], depth: 'r_forearm', against: 'trunk' },
  ];
  const mapText = JSON.stringify({ ...raw, layout: bindings });
  const map = readMap(mapText, 'synthetic map');
  const rig = JSON.parse(readFileSync(join(import.meta.dir, '../examples/wave/rig/rig.json'), 'utf8')) as { bones: Array<{ name: string; parent?: string }> };
  const rest = new Map(rig.bones.map((b) => [b.name, { parent: b.parent ?? null }])) as unknown as Rest;
  const layout: Layout = { path: 'synthetic layout', sha256: '0'.repeat(64), setup: HIP_ORDER.map((s) => s.name), placements: [
    { limb: 'arm_l', parts: ['panel-a'], before: { limb: 'axis' }, slots: ['a'], target_slots: ['j'] },
    { limb: 'arm_r', parts: ['panel-g'], before: { limb: 'axis' }, slots: ['g'], target_slots: ['j'] },
  ] };
  const at = (x: number, y: number): Joint => ({ at: [x, y], score: 1, state: 'observed' });
  const track = Array.from({ length: 6 }, () => ({ r_elbow: at(170, 330), r_wrist: at(175, 390), l_elbow: at(230, 330), l_wrist: at(225, 390) }));
  const depth: FrameDepth[] = track.map((_, f) => ({ r_forearm: { ratio: 0.6, source: 'derived' as const, sign: HIP_FRONT.r.includes(f) ? 1 : -1 }, l_forearm: { ratio: 0.6, source: 'derived' as const, sign: HIP_FRONT.l.includes(f) ? 1 : -1 } }));
  const times = track.map((_, f) => f / 24);
  return { map, mapText, rest, layout, track, depth, times };
}

/** Same fixture as a rig-c input, for the before/after render receipt. */
export function writeHipRig(dir: string): void {
  mkdirSync(join(dir, 'images'), { recursive: true });
  const rig = JSON.parse(readFileSync(join(import.meta.dir, '../examples/wave/rig/rig.json'), 'utf8')) as Record<string, unknown>;
  const colors: Record<string, [number, number, number, number]> = { a: [210, 70, 230, 255], g: [245, 190, 40, 255], j: [45, 115, 180, 255] };
  const skins: Record<string, unknown> = {};
  for (const s of HIP_ORDER) {
    const width = s.name === 'j' ? 100 : s.name === 'a' || s.name === 'g' ? 22 : 8;
    const height = s.name === 'j' ? 75 : 60;
    const p = new Plate(width, height);
    p.rect(1, 1, width - 2, height - 2, colors[s.name] ?? [120, 130, 140, 255]);
    p.writePng(join(dir, 'images', `${s.name}.png`));
    skins[s.name] = { art: { image: `${s.name}.png`, ...(s.name === 'j' ? { x: 0, y: -10 } : { x: 30, y: 0, rotation: 90 }) } };
  }
  rig.images = 'images';
  rig.slots = HIP_ORDER.map((s) => ({ ...s, attachment: 'art' }));
  rig.skins = { default: skins };
  const bytes = JSON.stringify(rig, null, 2) + '\n';
  writeFileSync(join(dir, 'rig.json'), bytes);
  const f = hipFixture();
  writeFileSync(join(dir, 'layout.json'), JSON.stringify({ spec: 'rig-parts-layout/1', rig: { file: 'rig.json', sha256: createHash('sha256').update(bytes).digest('hex') }, setup_slots: f.layout.setup, placements: f.layout.placements }, null, 2) + '\n');
  writeFileSync(join(dir, 'map.json'), f.mapText);
}
