/** Authored swing follows final selected art, never a guessed phase/depth (#444). */
import { describe, expect, test } from 'bun:test';
import { readMap, resolveMap, type AlternateSet, type RigSlots } from '../src/map.ts';
import { orderFromSwing } from '../src/swing.ts';
import { selectSwitches, type SwitchOptions } from '../src/switch.ts';
import type { DrawOrderReading } from '../src/draworder.ts';
import type { CompiledDocument } from 'rig-c/core';
import { restOf } from '../src/rigc.ts';
import { retarget } from '../src/retarget.ts';
import type { Joint } from '../src/pose.ts';
import { hipFixture, HIP_ORDER } from './pelvis-fixture.ts';

const options: SwitchOptions = { switchTolerance: 25, switchMin: 0, switchAt: 'first' };
function set(name: string, swing?: 'forward' | 'back', extra: Record<string, unknown> = {}) {
  return { name, slots: { g: name }, chains: ['arm_r'], pose: { r_shoulder: [0, 0], r_elbow: [50, 0], r_wrist: [100, 0] }, ...(swing === undefined ? {} : { swing }), ...extra };
}
function fixture(sets: ReturnType<typeof set>[], n = 8) {
  const f = hipFixture(), raw = JSON.parse(f.mapText) as Record<string, unknown>;
  delete raw.layout;
  const map = readMap(JSON.stringify({ ...raw, alternates: sets }), 'synthetic map');
  const slots: RigSlots = new Map(HIP_ORDER.map(s => [s.name, { bone: s.bone, setup: 'base', attachments: new Set(['base', 'shared', ...sets.flatMap(a => Object.values(a.slots))]) }]));
  const times = Array.from({ length: n }, (_, i) => i / 24);
  const targets = new Map(map.chains.flatMap(c => c.bones.map(b => [b, Array<number>(n).fill(0)] as const)));
  return { ...f, map, slots, times, targets };
}
const empty: DrawOrderReading = { pairs: [], keys: [], spans: [] };
function decode(reading: DrawOrderReading | null, order = HIP_ORDER, n = 8) {
  const names = order.map(s => s.name);
  return Array.from({ length: n }, (_, f) => {
    const offsets = [...(reading?.keys ?? [])].reverse().find(k => k.frame <= f)?.offsets ?? [];
    const placed: Array<string | undefined> = Array(names.length).fill(undefined);
    for (const o of offsets) placed[names.indexOf(o.slot) + o.offset] = o.slot;
    const moved = new Set(offsets.map(o => o.slot)), rest = names.filter(n => !moved.has(n));
    return placed.map(n => n ?? rest.shift()!);
  });
}
function selected(f: ReturnType<typeof fixture>, opts: Partial<SwitchOptions> = {}) {
  return selectSwitches(f.map, f.targets, f.times, f.times.length / 24, f.slots, { ...options, ...opts });
}
function keyed(f: ReturnType<typeof fixture>, sw: ReturnType<typeof selected>, base: DrawOrderReading | null = null) {
  return orderFromSwing(base, f.map, f.rest, HIP_ORDER, f.slots, sw.shown, sw.slotSets, f.times);
}

describe('#444 authored map declarations', () => {
  test('normal forward/back are read; absence is absent; invalid value and non-arm name the set and chain', () => {
    expect(fixture([set('art', 'back')]).map.alternates[0]!.swing).toBe('back');
    expect(fixture([set('art')]).map.alternates[0]!.swing).toBeUndefined();
    expect(() => fixture([set('bad', 'back', { swing: 'in' })])).toThrow('MAP_ALT_SWING');
    expect(() => fixture([set('leg-art', 'back', { chains: ['leg_r'], pose: { r_hip: [0, 0], r_knee: [50, 0], r_ankle: [100, 0] } })])).toThrow('non-arm chain "leg_r"');
    expect(() => fixture([set('bad', 'back', { swing: 'in' })])).toThrow('set "bad"');
  });

  test('same-chain same-phase duplicates refuse in both directions; independent opposite arms remain valid', () => {
    for (const swing of ['forward', 'back'] as const) {
      expect(() => fixture([set('one', swing, { phase: 'right-step' }), set('two', swing, { phase: 'right-step' })])).toThrow('MAP_SWING_OVERLAP');
      expect(() => fixture([set('one', swing, { phase: 'right-step' }), set('two', swing, { phase: 'right-step' })])).toThrow('chain "arm_r"');
    }
    const left = set('left', 'forward', { slots: { a: 'left' }, chains: ['arm_l'], pose: { l_shoulder: [0, 0], l_elbow: [50, 0], l_wrist: [100, 0] }, phase: 'right-step' });
    expect(fixture([set('right', 'forward', { phase: 'right-step' }), left]).map.alternates).toHaveLength(2);
  });
});

describe('#444 selected art and total slot order', () => {
  test('phase selection ignores min/peak; hands cross their own thigh while all other slot pairs preserve leg order', () => {
    const f = fixture([set('back', 'back', { phase: 'right-step' }), set('front', 'forward', { phase: 'left-step' })]);
    const sw = selected(f, { switchMin: 999, switchAt: 'peak', phaseSupports: [{ side: 'l', frames: [0, 3] }, { side: 'r', frames: [4, 7] }] });
    const legs: DrawOrderReading = { ...empty, keys: [{ frame: 2, t: 1.5 / 24, offsets: [{ slot: 'c', offset: 2 }, { slot: 'd', offset: 2 }, { slot: 'e', offset: -2 }, { slot: 'f', offset: -2 }] }, { frame: 6, t: 5.5 / 24 }] };
    const k = keyed(f, sw, legs), orders = decode(k.reading), before = decode(legs);
    expect(k.swings.map(s => [s.set, s.frames])).toEqual([['back', [[0, 3]]], ['front', [[4, 7]]]]);
    orders.forEach((o, i) => {
      expect(o.indexOf('g') < o.indexOf('c')).toBe(i < 4);
      expect(o.filter(n => n !== 'g')).toEqual(before[i]!.filter(n => n !== 'g'));
      expect(new Set(o).size).toBe(HIP_ORDER.length);
    });
    // Planted declaration-direction defect must reverse the actual relation, not change a depth sign.
    const mutant = { ...f.map, alternates: f.map.alternates.map(a => ({ ...a, swing: a.swing === 'back' ? 'forward' as const : 'back' as const })) };
    const wrong = orderFromSwing(legs, mutant, f.rest, HIP_ORDER, f.slots, sw.shown, sw.slotSets, f.times);
    expect(decode(wrong.reading)[0]!.indexOf('g')).toBeGreaterThan(decode(wrong.reading)[0]!.indexOf('c'));
  });

  test('an already-correct declaration does not move art across an unrelated pelvis or change the base timeline', () => {
    const f = fixture([set('front', 'forward', { phase: 'left-step' })]);
    const sw = selected(f, { phaseSupports: [{ side: 'r', frames: [0, 7] }] });
    const base: DrawOrderReading = { ...empty, keys: [{ frame: 0, t: 0, offsets: [{ slot: 'g', offset: 4 }, { slot: 'h', offset: -1 }, { slot: 'i', offset: -1 }, { slot: 'j', offset: -1 }, { slot: 'k', offset: -1 }] }] };
    const k = keyed(f, sw, base);
    expect(k.reading).toEqual(base);
    expect(k.swings[0]!.frames).toEqual([[0, 7]]);
  });

  test('same attachment name is not ownership; a selected set without swing restores base immediately', () => {
    const f = fixture([set('declared', 'back', { slots: { g: 'shared' }, phase: 'right-step' }), set('plain', undefined, { slots: { g: 'shared' }, phase: 'left-step' })]);
    const sw = selected(f, { phaseSupports: [{ side: 'l', frames: [0, 3] }, { side: 'r', frames: [4, 7] }] });
    expect(sw.shown.get('g')).toEqual(Array(8).fill('shared'));
    expect(sw.slotSets!.get('g')).toEqual(['declared', 'declared', 'declared', 'declared', 'plain', 'plain', 'plain', 'plain']);
    const k = keyed(f, sw);
    expect(k.swings[0]!.frames).toEqual([[0, 3]]);
    expect(decode(k.reading)[4]).toEqual(HIP_ORDER.map(s => s.name));
  });

  test('bound plain art overrides a phase declaration; exact one-frame swing bind ignores distance and minimum', () => {
    const f = fixture([set('phase', 'back', { slots: { g: 'shared' }, phase: 'right-step' }), set('bound', undefined, { slots: { g: 'shared' }, bind: [[2, 3]] })]);
    const k = keyed(f, selected(f, { switchMin: 999, phaseSupports: [{ side: 'l', frames: [0, 7] }] }));
    expect(k.swings[0]!.frames).toEqual([[0, 1], [4, 7]]);
    expect(decode(k.reading)[2]).toEqual(HIP_ORDER.map(s => s.name));
    const one = fixture([set('exact', 'back', { bind: [[3, 3]] })]);
    for (const t of one.targets.values()) t.fill(150);
    const exact = keyed(one, selected(one, { switchMin: 999 }));
    expect(exact.swings[0]!.frames).toEqual([[3, 3]]);
    expect(decode(exact.reading)[4]).toEqual(HIP_ORDER.map(s => s.name));
  });

  test('a minimum-suppressed or never-selected declaration makes no order; no swing is strict identity', () => {
    const f = fixture([set('short', 'back', { frames: [[2, 2]] })]);
    const k = keyed(f, selected(f, { switchMin: 0.25 }));
    expect(k.swings[0]!.frames).toEqual([]);
    expect(k.reading!.keys).toEqual([]);
    const none = fixture([set('plain')]);
    const sw = selected(none);
    expect(sw.slotSets).toBeUndefined();
    expect(keyed(none, sw, empty).reading).toBe(empty);
    expect(keyed(none, sw).reading).toBeNull();
  });

  test('missing art/thigh joints refuse by object name; unknown owner and hidden art never invent a declaration', () => {
    const f = fixture([set('named', 'back')]), sw = selected(f);
    const noThigh = { ...f.map, chains: f.map.chains.filter(c => !c.joints.includes('r_knee')) };
    expect(() => orderFromSwing(null, noThigh, f.rest, HIP_ORDER, f.slots, sw.shown, sw.slotSets, f.times)).toThrow('SWING_THIGH');
    const noArt = new Map(f.slots); noArt.set('g', { ...noArt.get('g')!, attachments: new Set() });
    expect(() => orderFromSwing(null, f.map, f.rest, HIP_ORDER, noArt, sw.shown, sw.slotSets, f.times)).toThrow('SWING_ART');
    expect(orderFromSwing(null, f.map, f.rest, HIP_ORDER, f.slots, sw.shown, undefined, f.times).swings[0]!.frames).toEqual([]);
    const hidden = new Map(sw.shown);hidden.set('g', Array(8).fill(null));
    expect(orderFromSwing(null, f.map, f.rest, HIP_ORDER, f.slots, hidden, sw.slotSets, f.times).swings[0]!.frames).toEqual([]);
  });

  test('actual same-chain simultaneous source ownership refuses duplicates and opposite directions with exact frames', () => {
    const f = fixture([set('one', 'back'), set('two', 'forward', { slots: { h2: 'two' } })]);
    const order = [...HIP_ORDER, { name: 'h2', bone: 'sleeve_r1' }];
    const slots = new Map(f.slots); slots.set('h2', { bone: 'sleeve_r1', setup: 'base', attachments: new Set(['base', 'two']) });
    const shown = new Map([['g', ['one', 'base']], ['h2', ['two', 'base']]]);
    const owners = new Map([['g', ['one', null]], ['h2', ['two', null]]]);
    expect(() => orderFromSwing(null, f.map, f.rest, order, slots, shown, owners, [0, 1 / 24])).toThrow('SWING_CONFLICT');
    expect(() => orderFromSwing(null, f.map, f.rest, order, slots, shown, owners, [0, 1 / 24])).toThrow('frames 0');
    const same = { ...f.map, alternates: f.map.alternates.map(a => ({ ...a, swing: 'back' as const })) };
    expect(() => orderFromSwing(null, same, f.rest, order, slots, shown, owners, [0, 1 / 24])).toThrow('SWING_OVERLAP');
  });
});


describe('#444 final ownership overrides', () => {
  test('real face and body yaw plain sets clear a bound swing owner even when the attachment is identical', () => {
    const doc: CompiledDocument = {
      spec: 'rigc-compiled/1', skin: 'all', referenceScale: 1,
      bones: [{ name: 'upper', length: 50 }, { name: 'lower', parent: 'upper', x: 50, length: 50 },
        { name: 'thigh', length: 50 }, { name: 'shin', parent: 'thigh', x: 50, length: 50 }, { name: 'yaw' }],
      slots: [], skins: [], constraints: [], animations: [], spine: { sha256: '0'.repeat(64) }, pages: null, stated: null,
    };
    const rest = restOf(doc), times = Array.from({ length: 24 }, (_, i) => i / 24);
    const slots: RigSlots = new Map([
      ['hand', { bone: 'lower', setup: 'base', attachments: new Set(['base', 'shared']) }],
      ['leg', { bone: 'thigh', setup: 'base', attachments: new Set(['base']) }],
    ]);
    const order = [...slots].map(([name, s]) => ({ name, bone: s.bone! }));
    const point = (x: number, y: number): Joint => ({ state: 'observed', at: [x, y], score: 1 });
    const frames = times.map((_, i) => {
      const width = i < 12 ? 100 : 100 * Math.cos(75 * Math.PI / 180);
      return { r_shoulder: point(0, 0), r_elbow: point(50, 0), r_wrist: point(100, 0),
        l_shoulder: point(width, 0), r_hip: point(0, 100), l_hip: point(width, 100),
        r_knee: point(50, 100), r_ankle: point(100, 100), neck: point(width / 2 - (i < 12 ? 0 : 4), -20),
        r_eye: point(-6, -40), l_eye: point(6, -40),
        nose: point(i < 12 ? 0 : -Math.tan(50 * Math.PI / 180) * 12 / 1.25, -35) };
    });
    const rigSets = new Map([['plain-yaw', { slots: { hand: 'shared' }, hides: [] }]]);
    for (const selector of ['face', 'body'] as const) {
      const map = readMap(JSON.stringify({ spec: 'rig-pose-map/1', chains: [
        { name: 'arm', bones: ['upper', 'lower'], joints: ['r_shoulder', 'r_elbow', 'r_wrist'], bend: 'free' },
        { name: 'leg', bones: ['thigh', 'shin'], joints: ['r_hip', 'r_knee', 'r_ankle'], bend: 'free' },
      ], alternates: [{ name: 'declared', slots: { hand: 'shared' }, chains: ['arm'], swing: 'back', bind: [[0, 23]],
        pose: { r_shoulder: [0, 0], r_elbow: [50, 0], r_wrist: [100, 0] } }],
      ...(selector === 'face' ? { face: { yaw: { bone: 'yaw', range: [-15, 15], sets: [{ set: 'plain-yaw', above: 45 }] } } }
        : { body: { sets: [{ set: 'plain-yaw', above: 45 }] } }),
      }), 'yaw ownership control');
      resolveMap(map, rest, 'yaw ownership control', slots, rigSets);
      const result = retarget(rest, map, frames, times, { ...options, minScore: 0.3, bends: 'refuse', bendTolerance: 0, flip: 'off', short: 'off' }, slots, rigSets);
      const spans = result[selector]!.sets![0]!.spans;
      expect(spans).toEqual([[12, 23]]);
      expect(result.shown.get('hand')).toEqual(Array(24).fill('shared'));
      expect(result.slotSets!.get('hand')).toEqual([...Array(12).fill('declared'), ...Array(12).fill('plain-yaw')]);
      const authored = orderFromSwing(null, map, rest, order, slots, result.shown, result.slotSets, times);
      expect(authored.swings[0]!.frames).toEqual([[0, 11]]);
      expect(decode(authored.reading, order, 24)[12]).toEqual(['hand', 'leg']);
      // A stale declaration owner is the defect: identical visible art would incorrectly keep the order.
      const stale = new Map(result.slotSets); stale.set('hand', Array(24).fill('declared'));
      expect(orderFromSwing(null, map, rest, order, slots, result.shown, stale, times).swings[0]!.frames).toEqual([[0, 23]]);
    }
  });

  test('gesture smoothing keeps the previous behind-chain source on the dropped short front excursion', () => {
    const n = 28, polar = (a: number, length: number): [number, number] => [length * Math.cos(a * Math.PI / 180), -length * Math.sin(a * Math.PI / 180)];
    const pose = (r: number, l: number) => ({ r_shoulder: [0, 0], r_elbow: polar(r, 50), r_wrist: polar(r, 100), l_shoulder: [0, 0], l_elbow: polar(l, 50), l_wrist: polar(l, 100) });
    const f = fixture([
      set('back', 'back', { slots: { back_r: 'back_r', back_l: 'back_l', torso: 'back_top' }, hides: ['front_r', 'front_l', 'extra_r', 'extra_l'], chains: ['arm_r', 'arm_l'], pose: pose(-90, -90), drawn: { sleeve_r0: -90, sleeve_r1: -90, sleeve_l0: -90, sleeve_l1: -90 }, turn: { sleeve_r0: [-5, 5], sleeve_r1: [-5, 5], sleeve_l0: [-5, 5], sleeve_l1: [-5, 5] } }),
      set('front', undefined, { slots: { extra_r: 'extra_r', extra_l: 'extra_l', torso: 'front_top' }, hides: ['back_r', 'back_l', 'front_r', 'front_l'], chains: ['arm_r', 'arm_l'], pose: pose(-80, -50), drawn: { sleeve_r0: -80, sleeve_r1: -80, sleeve_l0: -50, sleeve_l1: -50 }, turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] } }),
    ], n);
    const slot = (bone: string, setup: string | null, names: string[]) => ({ bone, setup, attachments: new Set(names) });
    f.slots = new Map([
      ['back_r', slot('sleeve_r1', null, ['back_r'])], ['back_l', slot('sleeve_l1', null, ['back_l'])],
      ['torso', slot('chest', 'torso', ['torso', 'back_top', 'front_top'])],
      ['leg_r', slot('leg_r0', 'leg_r', ['leg_r'])], ['leg_l', slot('leg_l0', 'leg_l', ['leg_l'])],
      ['front_r', slot('sleeve_r1', 'front_r', ['front_r'])], ['front_l', slot('sleeve_l1', 'front_l', ['front_l'])],
      ['extra_r', slot('sleeve_r1', null, ['extra_r'])], ['extra_l', slot('sleeve_l1', null, ['extra_l'])],
    ]);
    for (const b of ['sleeve_r0', 'sleeve_r1']) f.targets.set(b, Array(n).fill(-90));
    for (const b of ['sleeve_l0', 'sleeve_l1']) f.targets.set(b, Array.from({ length: n }, (_, i) => i >= 10 && i <= 17 ? -50 : -90));
    const sw = selected(f, { switchMin: 0.25 });
    expect(sw.switches.map(s => [s.set, s.frames])).toEqual([['back', [0, 9]], ['back', [18, 27]]]);
    expect(sw.shown.get('back_r')).toEqual(Array(n).fill('back_r'));
    expect(sw.slotSets!.get('back_r')).toEqual(Array(n).fill('back'));
    expect(sw.shown.get('back_l')!.slice(10, 18)).toEqual(Array(8).fill(null));
    const order = [...f.slots].map(([name, s]) => ({ name, bone: s.bone! }));
    const authored = orderFromSwing(null, f.map, f.rest, order, f.slots, sw.shown, sw.slotSets, f.times);
    expect(authored.swings.find(s => s.chain === 'arm_r')!.frames).toEqual([[0, 27]]);
    expect(authored.swings.find(s => s.chain === 'arm_l')!.frames).toEqual([[0, 9], [18, 27]]);
    // Merely assigning the whole-group windows would lose the independently held right arm in the gap.
    const stale = new Map(sw.slotSets); stale.set('back_r', Array.from({ length: n }, (_, i) => i >= 10 && i <= 17 ? null : 'back'));
    expect(orderFromSwing(null, f.map, f.rest, order, f.slots, sw.shown, stale, f.times).swings.find(s => s.chain === 'arm_r')!.frames).toEqual([[0, 9], [18, 27]]);
  });
});
