/**
 * The map's `layout` bindings (rig-c/pose#346; `src/layout.ts` says what they bind): each
 * `rig-parts-layout/1` group's depth source, named explicitly. Kept apart from `layout.ts`
 * so the map reader imports nothing but the problems.
 */
import type { DepthSegment } from './pose.ts';
import { isObject, type Problems, refuseUnknownKeys, typeName } from './problems.ts';

/** The depth sources a group can be bound to (rig-c/pose#346): a forearm, against the trunk. */
export const LAYOUT_DEPTHS = ['r_forearm', 'l_forearm'] as const satisfies readonly DepthSegment[];
export type LayoutDepth = (typeof LAYOUT_DEPTHS)[number];
export const LAYOUT_AGAINST = ['trunk'] as const;
export type LayoutAgainst = (typeof LAYOUT_AGAINST)[number];
/** One of the map's `layout` bindings. */
export interface LayoutBinding {
  limb: string;
  parts: string[];
  depth: LayoutDepth;
  against: LayoutAgainst;
}

export const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
/** A group as text: `arm_r [forearm_r]`. */
export const groupName = (g: { limb: string; parts: readonly string[] }): string => `${g.limb} [${g.parts.join(', ')}]`;
export const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '');

/** The map's `layout` (rig-c/pose#346): its bindings, or problems by name. */
export function readLayoutBindings(p: Problems, where: string, raw: unknown): LayoutBinding[] | undefined {
  const w = `${where} "layout"`;
  const shape = '[{ "limb", "parts": [...], "depth": "r_forearm" | "l_forearm", "against": "trunk" }]';
  if (!Array.isArray(raw) || raw.length === 0) {
    p.add('MAP_LAYOUT', `${w} is ${typeName(raw)}; it is a non-empty array of bindings, ${shape}`);
    return undefined;
  }
  const out: LayoutBinding[] = [];
  raw.forEach((b: unknown, i: number) => {
    const bw = `${w}[${i}]`;
    if (!isObject(b)) {
      p.add('MAP_LAYOUT', `${bw} is ${typeName(b)}; a binding is ${shape.slice(1, -1)}`);
      return;
    }
    refuseUnknownKeys(p, 'MAP_KEYS', bw, b, ['limb', 'parts', 'depth', 'against']);
    let ok = true;
    if (typeof b.limb !== 'string' || b.limb === '') (ok = false), p.add('MAP_LAYOUT', `${bw} "limb" is ${typeName(b.limb)}; it names the layout placement's limb`);
    if (!stringList(b.parts) || new Set(b.parts).size !== b.parts.length) (ok = false), p.add('MAP_LAYOUT', `${bw} "parts" is ${JSON.stringify(b.parts) ?? typeName(b.parts)}; it is the placement's parts, a non-empty list of distinct names`);
    if (!(LAYOUT_DEPTHS as readonly unknown[]).includes(b.depth)) {
      ok = false;
      p.add('MAP_LAYOUT', `${bw} "depth" is ${typeName(b.depth)}; the depth sources --draw-order depth keys a group by are ${LAYOUT_DEPTHS.join(', ')} (a forearm against the trunk, rig-c/pose#346): a group with no supported source is not keyed by a guess`);
    }
    if (!(LAYOUT_AGAINST as readonly unknown[]).includes(b.against)) (ok = false), p.add('MAP_LAYOUT', `${bw} "against" is ${typeName(b.against)}; it must be "trunk" (the shoulders' and hips' plane, depth 0), what a forearm is ordered against`);
    if (!ok) return;
    const binding = { limb: b.limb as string, parts: [...(b.parts as string[])], depth: b.depth as LayoutDepth, against: b.against as LayoutAgainst };
    const same = out.find((o) => (o.limb === binding.limb && sameList(o.parts, binding.parts)) || o.depth === binding.depth);
    if (same !== undefined) p.add('MAP_LAYOUT', `${bw} binds ${groupName(binding)} to ${binding.depth}, and an earlier binding already binds ${groupName(same)} to ${same.depth}; each group and each depth source is bound once`);
    else out.push(binding);
  });
  return out;
}

