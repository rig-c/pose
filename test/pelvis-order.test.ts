import { describe, expect, test } from 'bun:test';
import { groupLines, groupsReport, keyGroups, missingLayoutGroups, resolveGroups } from '../src/layout.ts';
import type { DrawOrderKey } from '../src/draworder.ts';
import { firstFrames } from './discrete.ts';
import { hipFixture, HIP_FRONT, HIP_ORDER } from './pelvis-fixture.ts';

const setup = HIP_ORDER.map((s) => s.name);
function orderOf(k?: DrawOrderKey): string[] {
  const out: Array<string | undefined> = Array(setup.length).fill(undefined);
  for (const o of k?.offsets ?? []) out[setup.indexOf(o.slot) + o.offset] = o.slot;
  const moved = new Set(k?.offsets?.map((o) => o.slot));
  const rest = setup.filter((s) => !moved.has(s));
  return out.map((s) => s ?? rest.shift()!);
}

describe('#431: explicitly bound forearms against a shared pelvis target', () => {
  test('red before: left hand over hip on frames 1,2; right on 3,4; other slots retain their relative order', () => {
    const f = hipFixture();
    const resolved = resolveGroups(f.layout, f.map.layout!, f.map, f.rest, HIP_ORDER, [[2, 5]]);
    expect(resolved.problems.list).toEqual([]);
    expect(resolved.groups.every((g) => g.group.keyed)).toBe(true);
    const legs = { pairs: [], spans: [], keys: [{ frame: 2, t: 1.5 / 24, offsets: [{ slot: 'c', offset: 2 }, { slot: 'd', offset: 2 }, { slot: 'e', offset: -2 }, { slot: 'f', offset: -2 }] }, { frame: 4, t: 3.5 / 24 }] };
    const { reading, groups } = keyGroups(legs, resolved.groups, f.track, f.depth, f.times, HIP_ORDER);
    const orders = f.times.map((_, i) => orderOf([...reading.keys].reverse().find((k) => k.frame <= i)));
    for (const [side, slot] of [['l', 'a'], ['r', 'g']] as const) {
      const front = orders.flatMap((o, i) => o.indexOf(slot) > o.indexOf('j') ? [i] : []);
      expect(front).toEqual(HIP_FRONT[side]);
      expect(groups.find((g) => g.depth === `${side}_forearm`)!.frames).toEqual({ front: 2, back: 4, unread: 0 });
      console.log(`#431 ${side}: front frames ${front.join(',')}; back ${f.times.length - front.length}`);
    }
    orders.forEach((o, i) => {
      const base = orderOf([...legs.keys].reverse().find((k) => k.frame <= i));
      expect(o.filter((s) => s !== 'a' && s !== 'g')).toEqual(base.filter((s) => s !== 'a' && s !== 'g'));
      expect(new Set(o).size).toBe(setup.length);
    });
    expect(firstFrames(reading.keys, f.times.length, 24)).toEqual(reading.keys.map((k) => k.frame));
    expect(JSON.stringify(keyGroups(legs, resolved.groups, f.track, f.depth, f.times, HIP_ORDER))).toBe(JSON.stringify({ reading, groups }));
  });

  test('controls: negative, tied and unread forearms retain setup and byte-identical leg keys', () => {
    const f = hipFixture();
    const resolved = resolveGroups(f.layout, f.map.layout!, f.map, f.rest, HIP_ORDER, [[2, 5]]);
    expect(resolved.problems.list).toEqual([]);
    const depth = f.depth.map(() => ({ r_forearm: { ratio: 1, source: 'derived' as const, sign: 0 as const }, l_forearm: { ratio: 0.6, source: 'derived' as const, sign: -1 as const } }));
    const legs = { pairs: [], spans: [], keys: [{ frame: 1, t: 0.5 / 24, offsets: [{ slot: 'c', offset: 2 }, { slot: 'd', offset: 2 }, { slot: 'e', offset: -2 }, { slot: 'f', offset: -2 }] }, { frame: 5, t: 4.5 / 24 }] };
    expect(JSON.stringify(keyGroups(legs, resolved.groups, f.track, depth, f.times, HIP_ORDER).reading)).toBe(JSON.stringify(legs));
    expect(JSON.stringify(keyGroups(legs, resolved.groups, f.track, f.times.map(() => undefined), f.times, HIP_ORDER).reading)).toBe(JSON.stringify(legs));
  });

  test('both front compose stably with unique in-range destinations; placement list order is immaterial', () => {
    const f = hipFixture();
    const depth = f.depth.map(() => ({ r_forearm: { ratio: 0.6, source: 'derived' as const, sign: 1 as const }, l_forearm: { ratio: 0.6, source: 'derived' as const, sign: 1 as const } }));
    const run = (reverse: boolean) => {
      const layout = { ...f.layout, placements: reverse ? [...f.layout.placements].reverse() : f.layout.placements };
      const r = resolveGroups(layout, f.map.layout!, f.map, f.rest, HIP_ORDER, []);
      expect(r.problems.list).toEqual([]);
      return keyGroups({ pairs: [], keys: [], spans: [] }, r.groups, f.track, depth, f.times, HIP_ORDER).reading.keys;
    };
    const keys = run(false);
    expect(run(true)).toEqual(keys);
    expect(orderOf(keys[0]).slice(-3)).toEqual(['a', 'g', 'k']);
    expect(orderOf(keys[0]).filter((s) => s !== 'a' && s !== 'g')).toEqual(setup.filter((s) => s !== 'a' && s !== 'g'));
    for (const key of keys) {
      const dest = (key.offsets ?? []).map((o) => setup.indexOf(o.slot) + o.offset);
      expect(new Set(dest).size).toBe(dest.length);
      expect(dest.every((d) => d >= 0 && d < setup.length)).toBe(true);
      expect(new Set(key.offsets?.map((o) => o.slot)).size).toBe((key.offsets ?? []).length);
    }
  });

  test('only explicit hip-line anatomy permits gaps and shared targets; chest and wrong segment bindings still refuse', () => {
    const f = hipFixture();
    const chest = { ...f.layout, placements: f.layout.placements.map((p) => ({ ...p, target_slots: ['k'] })) };
    expect(resolveGroups(chest, f.map.layout!, f.map, f.rest, HIP_ORDER, []).problems.list.map((p) => p.code)).toContain('LAYOUT_ADJACENCY');
    const noPelvis = { ...f.map, chains: f.map.chains.filter((c) => c.name !== 'axis') };
    expect(resolveGroups(f.layout, f.map.layout!, noPelvis, f.rest, HIP_ORDER, []).problems.list.map((p) => p.code)).toContain('LAYOUT_ADJACENCY');
    const wrong = f.map.layout!.map((b) => ({ ...b, depth: b.depth === 'r_forearm' ? 'l_forearm' as const : 'r_forearm' as const }));
    expect(resolveGroups(f.layout, wrong, f.map, f.rest, HIP_ORDER, []).problems.list.map((p) => p.code)).toContain('LAYOUT_BINDING_BONES');
    const missing = missingLayoutGroups(f.map, f.rest, HIP_ORDER, f.times.length);
    expect(missing.map((g) => g.depth)).toEqual(['r_forearm', 'l_forearm']);
    expect(missing.every((g) => !g.keyed && g.why?.includes('no limb layout') && g.why.includes('rig-parts rig writes layout.json'))).toBe(true);
    expect(missing.every((g) => g.target.length === 0)).toBe(true);
    const serialized = JSON.parse(JSON.stringify(groupsReport(null, missing))) as { layout?: unknown; groups: Array<{ setup: unknown; target: string[]; why: string }> };
    expect(serialized.layout).toBeUndefined();
    expect(serialized.groups.every((g) => g.setup === null && g.target.length === 0)).toBe(true);
    expect(groupLines(missing, [])).toEqual([
      'DRAWORDER arm_r / trunk by r_forearm not keyed: no limb layout; rig-parts rig writes layout.json beside rig.json from the config limb layout; bind its depth in the map layout',
      'DRAWORDER arm_l / trunk by l_forearm not keyed: no limb layout; rig-parts rig writes layout.json beside rig.json from the config limb layout; bind its depth in the map layout',
    ]);
  });
});
