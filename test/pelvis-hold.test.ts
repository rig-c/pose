import { describe, expect, test } from 'bun:test';
import { keyGroups, resolveGroups } from '../src/layout.ts';
import type { DrawOrderReading } from '../src/draworder.ts';
import type { FrameDepth, Joint } from '../src/pose.ts';
import { hipFixture, HIP_ORDER } from './pelvis-fixture.ts';

const empty: DrawOrderReading = { pairs: [], spans: [], keys: [] };
type Sample = number | null;
/** Constant rest length, with a signed foreshortening reading; null is genuinely unread. */
function run(samples: Sample[], loop = false, after = false, chest = false, legs = empty) {
  const f = hipFixture();
  const order = chest ? [...HIP_ORDER.filter((s) => s.name !== 'g' && s.name !== 'k'), HIP_ORDER.find((s) => s.name === 'g')!, HIP_ORDER.find((s) => s.name === 'k')!] : after ? [...HIP_ORDER.filter((s) => s.name !== 'g'), HIP_ORDER.find((s) => s.name === 'g')!] : HIP_ORDER;
  const pl = f.layout.placements.find((p) => p.limb === 'arm_r')!;
  const target = chest ? ['k'] : pl.target_slots;
  const layout = { ...f.layout, setup: order.map((s) => s.name), placements: [{ ...pl, before: after ? undefined : pl.before, ...(after ? { after: pl.before } : {}), target_slots: target }] };
  const resolved = resolveGroups(layout, f.map.layout!.filter((b) => b.limb === 'arm_r'), f.map, f.rest, order, []);
  expect(resolved.problems.list).toEqual([]);
  const at = (x: number): Joint => ({ at: [x, 0], score: 1, state: 'observed' });
  const track = samples.map((s) => ({ r_elbow: at(0), r_wrist: at(100 * (s === null ? 1 : Math.abs(s))) }));
  const depth: Array<FrameDepth | undefined> = samples.map((s) => s === null ? undefined : { r_forearm: { ratio: Math.abs(s), sign: s === 1 ? 0 : s > 0 ? 1 : -1, source: 'derived' } });
  const result = keyGroups(legs, resolved.groups, track, depth, samples.map((_, i) => i / 24), order, loop);
  const names = order.map((s) => s.name);
  const orders = samples.map((_, f) => {
    const offsets = [...result.reading.keys].reverse().find((k) => k.frame <= f)?.offsets ?? [];
    const placed: Array<string | undefined> = Array(names.length).fill(undefined);
    for (const o of offsets) placed[names.indexOf(o.slot) + o.offset] = o.slot;
    const moved = new Set(offsets.map((o) => o.slot));
    const remaining = names.filter((s) => !moved.has(s));
    return placed.map((s) => s ?? remaining.shift()!);
  });
  return { ...result, orders, front: orders.map((o) => o.indexOf('g') > o.indexOf(target[0]!)) };
}

describe('#434: only pelvis orders hold through undecided forearm depth', () => {
  test('front-flat-several-front emits one key and no flipped frames', () => {
    const r = run([0.6, 1, 1, 1, 1, 0.6]);
    const flipped = r.front.flatMap((v, f) => v ? [] : [f]);
    if (flipped.length) throw new Error(`#434 flipped frames ${flipped.join(',')}; front-flat-several-front must hold front`);
    expect(r.reading.keys.map((k) => k.frame)).toEqual([0]);
    expect(r.groups[0]!.frames).toEqual({ front: 6, back: 0, unread: 0 });
    expect(r.groups[0]!.depthPx).toEqual([80, 0, 0, 0, 0, 80]);
  });

  test('decided back crosses once and holds through flat and small signed depths', () => {
    const r = run([0.6, -0.6, 1, 0.99, -0.99, -0.6]);
    expect(r.front).toEqual([true, false, false, false, false, false]);
    expect(r.reading.keys.map((k) => k.frame)).toEqual([0, 1]);
    expect(r.groups[0]!.frames).toEqual({ front: 1, back: 5, unread: 0 });
  });

  test('signed equality at the rounded tie is decisive; signed inside tie holds', () => {
    const r = run([0.6, -0.95001, -0.95, 0.95001, 0.95]);
    expect(r.groups[0]!.tie).toBe(31.22);
    expect(r.groups[0]!.depthPx).toEqual([80, -31.22, -31.22, 31.22, 31.22]);
    expect(r.front).toEqual([true, false, false, true, true]);
    expect(run([0.6, -0.951, 0.951]).front).toEqual([true, true, true]);
  });

  test('missing depth holds the chosen order but remains unread in counts and runs', () => {
    const r = run([0.6, null, 1, null, -0.6, null]);
    expect(r.front).toEqual([true, true, true, true, false, false]);
    expect(r.groups[0]!.frames).toEqual({ front: 2, back: 1, unread: 3 });
    expect(r.groups[0]!.front).toEqual([[0, 0], [2, 2]]);
    expect(r.groups[0]!.back).toEqual([[4, 4]]);
    expect(r.groups[0]!.depthPx).toEqual([80, null, 0, null, -80, null]);
  });

  test('leading undecided nonloop uses setup on both setup sides', () => {
    expect(run([1, null, 0.6]).front).toEqual([false, false, true]);
    expect(run([1, null, -0.6], false, true).front).toEqual([true, true, false]);
  });

  test('leading undecided loop holds the final decided order across trailing unread frames', () => {
    expect(run([1, null, -0.6, 0.6, null], true).front).toEqual([true, true, false, true, true]);
    expect(run([1, null, 0.6, -0.6, null], true, true).front).toEqual([false, false, true, false, false]);
  });

  test('all undecided uses setup, even on a loop; all unread never invents a depth', () => {
    for (const loop of [false, true]) for (const after of [false, true]) {
      const r = run([1, null, 0.99, -0.99], loop, after);
      expect(r.front).toEqual([after, after, after, after]);
      expect(r.reading.keys).toEqual([]);
      expect(r.groups[0]!.frames).toEqual({ front: after ? 3 : 0, back: after ? 0 : 3, unread: 1 });
      const unread = run([null, null], loop, after);
      expect(unread.front).toEqual([after, after]);
      expect(unread.groups[0]!.tie).toBeNull();
      expect(unread.groups[0]!.frames).toEqual({ front: 0, back: 0, unread: 2 });
    }
    // A zero-length segment also gives tie 0: equal depths still cannot decide.
    expect(run([0, 0], true, true).front).toEqual([true, true]);
  });

  test('adjacent chest retains non-front-as-back and unread-as-setup semantics, with either loop value', () => {
    for (const loop of [false, true]) {
      const r = run([0.6, 1, null, 0.6, 0.99, -0.6], loop, false, true);
      expect(r.front).toEqual([true, false, false, true, false, false]);
      expect(r.groups[0]!.frames).toEqual({ front: 2, back: 3, unread: 1 });
    }
  });

  test('undecided controls preserve leg key bytes; crossing forearms preserve every other relative order', () => {
    const legs: DrawOrderReading = { pairs: [], spans: [], keys: [{ frame: 1, t: 0.5 / 24, offsets: [{ slot: 'c', offset: 2 }, { slot: 'd', offset: 2 }, { slot: 'e', offset: -2 }, { slot: 'f', offset: -2 }] }, { frame: 4, t: 3.5 / 24 }] };
    const control = run([1, 1, 1, 1, 1, 1], false, false, false, legs);
    expect(JSON.stringify(control.reading)).toBe(JSON.stringify(legs));
    const changed = run([0.6, 1, null, -0.6, 1, 0.6], false, false, false, legs);
    changed.orders.forEach((o, f) => expect(o.filter((s) => s !== 'g')).toEqual(control.orders[f]!.filter((s) => s !== 'g')));
  });
});
