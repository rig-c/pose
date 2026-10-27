/** Authored arm-set hand order (#444), composed after all existing selectors. */
import { armSide, type JointMap, type Rest, type RigSlots, type Swing } from './map.ts';
import type { DrawOrderOffset, DrawOrderReading } from './draworder.ts';
import { Problems } from './problems.ts';
import { keyAtFrame, runsOf } from './switch.ts';

export interface SwingReading {
  set: string;
  chain: string;
  side: 'r' | 'l';
  swing: Swing;
  slots: string[];
  thigh: string[];
  /** Actual final source-owned art spans, inclusive; never raw phase spans. */
  frames: Array<[number, number]>;
}

/** No declarations is an identity, including the null/no-depth case. */
export function orderFromSwing(base: DrawOrderReading | null, map: JointMap, rest: Rest, order: ReadonlyArray<{ name: string; bone: string }>, slots: RigSlots, shown: ReadonlyMap<string, readonly (string | null)[]>, slotSets: ReadonlyMap<string, readonly (string | null)[]> | undefined, times: readonly number[]): { reading: DrawOrderReading | null; swings: SwingReading[] } {
  const authored = map.alternates.filter(a => a.swing !== undefined);
  if (authored.length === 0) return { reading: base, swings: [] };
  const p = new Problems();
  const names = order.map(s => s.name);
  const mapped = new Set(map.chains.flatMap(c => c.bones));
  const owner = (bone: string): string | null => {
    for (let b: string | null = bone; b !== null; b = rest.get(b)?.parent ?? null) if (mapped.has(b)) return b;
    return null;
  };
  const resolved: Array<{ row: SwingReading; active: boolean[] }> = [];
  for (const set of authored) for (const cn of set.chains) {
    const chain = map.chains.find(c => c.name === cn);
    const side = chain === undefined ? null : armSide(chain);
    const where = `set "${set.name}" swing "${set.swing}" chain "${cn}"`;
    if (chain === undefined || side === null) { p.add('SWING_ANATOMY', `${where}: expected mapped shoulder -> elbow -> wrist on one side; found ${chain?.joints.join(' -> ') ?? 'no chain'}`); continue; }
    const forearm = chain.bones[1]!;
    const thighBones = new Set(map.chains.flatMap(c => c.bones.filter((_, i) => c.joints[i] === `${side}_hip` && c.joints[i + 1] === `${side}_knee`)));
    const hand = order.filter(s => owner(s.bone) === forearm && (slots.get(s.name)?.attachments.size ?? 0) > 0).map(s => s.name);
    const thigh = order.filter(s => thighBones.has(owner(s.bone) ?? '') && (slots.get(s.name)?.attachments.size ?? 0) > 0).map(s => s.name);
    const declared = Object.keys(set.slots).filter(s => hand.includes(s));
    if (hand.length === 0 || declared.length === 0) { p.add('SWING_ART', `${where}: no declared hand/forearm art on mapped bone "${forearm}"; hand slots ${JSON.stringify(hand)}, set slots ${JSON.stringify(Object.keys(set.slots))}`); continue; }
    if (thigh.length === 0) { p.add('SWING_THIGH', `${where}: no art on a mapped ${side}_hip -> ${side}_knee thigh; mapped bones ${JSON.stringify([...thighBones])}`); continue; }
    const active = times.map((_, f) => declared.some(s => slotSets?.get(s)?.[f] === set.name && shown.get(s)?.[f] === set.slots[s]));
    resolved.push({ row: { set: set.name, chain: cn, side, swing: set.swing!, slots: hand, thigh, frames: runsOf(active, 0) }, active });
  }
  p.throwIfAny();
  for (let a = 0; a < resolved.length; a++) for (let b = a + 1; b < resolved.length; b++) {
    const A = resolved[a]!, B = resolved[b]!;
    if (A.row.chain !== B.row.chain) continue;
    const overlap = runsOf(times.map((_, f) => A.active[f]! && B.active[f]!), 0);
    if (overlap.length > 0) p.add(A.row.swing === B.row.swing ? 'SWING_OVERLAP' : 'SWING_CONFLICT', `sets "${A.row.set}" (${A.row.swing}) and "${B.row.set}" (${B.row.swing}) on chain "${A.row.chain}" both show hand art on frames ${overlap.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(', ')}; one authored hand order is required on each frame`);
  }
  p.throwIfAny();
  const original = base ?? { pairs: [], keys: [], spans: [] };
  const sorted = [...original.keys].sort((a, b) => a.frame - b.frame);
  const keys: DrawOrderReading['keys'] = [];
  let last = '[]';
  for (let f = 0; f < times.length; f++) {
    const offsets = [...sorted].reverse().find(k => k.frame <= f)?.offsets ?? [];
    const placed: Array<string | undefined> = Array(names.length).fill(undefined);
    for (const o of offsets) placed[names.indexOf(o.slot) + o.offset] = o.slot;
    const moved = new Set(offsets.map(o => o.slot)), remaining = names.filter(n => !moved.has(n));
    let total = placed.map(n => n ?? remaining.shift()!);
    const active = resolved.filter(r => r.active[f]).sort((a, b) => names.indexOf(a.row.slots[0]!) - names.indexOf(b.row.slots[0]!));
    for (const { row } of active) {
      const handAt = row.slots.map(n => total.indexOf(n)), thighAt = row.thigh.map(n => total.indexOf(n));
      if (row.swing === 'back' ? Math.max(...handAt) < Math.min(...thighAt) : Math.min(...handAt) > Math.max(...thighAt)) continue;
      const own = new Set(row.slots);
      total = total.filter(n => !own.has(n));
      const target = row.thigh.map(n => total.indexOf(n));
      const at = row.swing === 'back' ? Math.min(...target) : Math.max(...target) + 1;
      total.splice(at, 0, ...row.slots);
    }
    const offs: DrawOrderOffset[] = names.flatMap((slot, i) => total.indexOf(slot) === i ? [] : [{ slot, offset: total.indexOf(slot) - i }]);
    const text = JSON.stringify(offs);
    if (text === last) continue;
    last = text;
    keys.push(offs.length === 0 ? { frame: f, t: keyAtFrame(times, f) } : { frame: f, t: keyAtFrame(times, f), offsets: offs });
  }
  return { reading: { ...original, keys }, swings: resolved.map(r => r.row) };
}

export function swingLines(rows: readonly SwingReading[]): string[] {
  return rows.map(r => `set "${r.set}" chain "${r.chain}" swing "${r.swing}": hand slots ${r.slots.join(', ')} ${r.swing === 'back' ? 'behind' : 'in front of'} same-side thigh ${r.thigh.join(', ')} on selected frames ${r.frames.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(', ') || 'none'}`);
}
