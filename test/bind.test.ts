/**
 * rig-c/pose#360: a set with `bind` shows on exactly its bound frames — no key distance, no art-turn gate, no minimum
 * span, no bridging, no hysteresis — and nowhere else. Held here on the pure pieces: the map reader's shape refusals,
 * the cycle form's expansion (against the explicit list), the sequence and overlap refusals, and the selection itself on
 * a synthetic group with the key deliberately far from the pose, beside a planted mutant (the bind read as a window the
 * angle rule picks inside) that must lose the far-key bind and the one-frame bind. The gated end-to-end bars are in
 * `retarget.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMap, type AlternateSet, type JointMap, type RigSlots } from '../src/map.ts';
import { Refusal } from '../src/problems.ts';
import { bindFrames, bindProblems, keyDrawnProblems, keyAtFrame, phaseGroupProblems, selectSwitches, switchBindLines, switchBinds, type SwitchOptions } from '../src/switch.ts';

const ROOT = join(import.meta.dir, '..');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');

/** The explicit list a cycle-relative bind must expand to, written out by hand. */
describe('bindFrames: the cycle form expands to exactly the explicit list', () => {
  test('a range inside the cycle repeats every cycle, the last repetition cut at the sequence end', () => {
    expect(bindFrames({ cycle: 8, at: [[2, 3]] }, 20)).toEqual([[2, 3], [10, 11], [18, 19]]);
    expect(bindFrames({ cycle: 8, at: [[6, 7]] }, 15)).toEqual([[6, 7], [14, 14]]);
    expect(bindFrames({ cycle: null, at: [[2, 3], [10, 11], [18, 19]] }, 20)).toEqual(bindFrames({ cycle: 8, at: [[2, 3]] }, 20));
  });
  test('a range past the cycle end runs into the next cycle, and its tail binds frame 0 on', () => {
    // [6, 9] of an 8-frame cycle: 6–9, 14–17, …, and the previous cycle's tail at 0–1.
    expect(bindFrames({ cycle: 8, at: [[6, 9]] }, 20)).toEqual([[0, 1], [6, 9], [14, 17]]);
  });
  test('ranges are merged where they overlap or touch, in order', () => {
    expect(bindFrames({ cycle: null, at: [[5, 6], [2, 3], [4, 4], [9, 9]] }, 12)).toEqual([[2, 6], [9, 9]]);
    expect(bindFrames({ cycle: 4, at: [[0, 0], [3, 3]] }, 10)).toEqual([[0, 0], [3, 4], [7, 8]]);
  });
  test('a one-frame bind is one frame', () => {
    expect(bindFrames({ cycle: null, at: [[7, 7]] }, 12)).toEqual([[7, 7]]);
  });
});

const BASE_MAP = {
  spec: 'rig-pose-map/1',
  chains: [{ name: 'arm_r', bones: ['arm_r0'], joints: ['r_shoulder', 'r_wrist'], bend: 'free' }],
};
const setOf = (o: Record<string, unknown>) => ({ name: 'fix', slots: { forearm_r: 'fix_r' }, chains: ['arm_r'], pose: { r_shoulder: [0, 0], r_wrist: [0, 100] }, ...o });
function mapProblems(...sets: Array<Record<string, unknown>>): string[] {
  try {
    readMap(JSON.stringify({ ...BASE_MAP, alternates: sets }), 'map.json');
    return [];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return e.problems.filter((p) => p.code === 'MAP_ALT_BIND').map((p) => p.text);
  }
}

describe('MAP_ALT_BIND: a malformed bind is refused by name', () => {
  test('control: both forms are read', () => {
    const m = readMap(JSON.stringify({ ...BASE_MAP, alternates: [setOf({ bind: [[3, 5]] }), setOf({ name: 'loop', slots: { forearm_l: 'x' }, bind: { cycle: 8, at: [[6, 9]] } })] }), 'map.json');
    expect(m.alternates.map((a) => a.bind)).toEqual([{ cycle: null, at: [[3, 5]] }, { cycle: 8, at: [[6, 9]] }]);
  });
  test('a set without bind carries no bind key', () => {
    const m = readMap(JSON.stringify({ ...BASE_MAP, alternates: [setOf({})] }), 'map.json');
    expect('bind' in m.alternates[0]!).toBe(false);
  });
  test('each malformed form, and bind beside frames or phase', () => {
    expect(mapProblems(setOf({ bind: [[5, 3]] }))).toEqual(['set "fix" "bind" is [[5,3]]; it is a non-empty list of inclusive pose-frame ranges [[first, last], …], or { "cycle": N, "at": [[first, last], …] } with the ranges counted from the start of each N-frame cycle; whole frame numbers ≥ 0 with first ≤ last']);
    expect(mapProblems(setOf({ bind: [] }))).toHaveLength(1);
    expect(mapProblems(setOf({ bind: [[1.5, 3]] }))).toHaveLength(1);
    expect(mapProblems(setOf({ bind: [[-1, 3]] }))).toHaveLength(1);
    expect(mapProblems(setOf({ bind: 'all' }))).toEqual(['set "fix" "bind" is the string "all"; it is a non-empty list of inclusive pose-frame ranges [[first, last], …], or { "cycle": N, "at": [[first, last], …] } with the ranges counted from the start of each N-frame cycle; whole frame numbers ≥ 0 with first ≤ last']);
    expect(mapProblems(setOf({ bind: { cycle: 0, at: [[0, 1]] } }))).toEqual(['set "fix" "bind" "cycle" is 0; it must be the cycle\'s length in frames, a whole number ≥ 1']);
    expect(mapProblems(setOf({ bind: { cycle: 8, at: [[8, 9]] } }))).toEqual(['set "fix" "bind" "at" range(s) [8,9] with "cycle" 8: a cycle-relative range starts inside the cycle (first ≤ 7) and spans at most one cycle (last − first + 1 ≤ 8); a last past 7 runs into the next cycle']);
    expect(mapProblems(setOf({ bind: { cycle: 8, at: [[0, 8]] } }))).toHaveLength(1);
    expect(mapProblems(setOf({ bind: { cycle: 8, at: [[0, 1]], every: 2 } }))).toEqual(['set "fix" "bind" names "every"; a cycle-relative bind is { "cycle": N, "at": [[first, last], …] }']);
    expect(mapProblems(setOf({ bind: [[0, 1]], frames: [[0, 1]] }))).toEqual(['set "fix" names both "bind" and "frames"; a bound set shows exactly on its bound frames and nowhere else, so a window would mean nothing — drop one']);
    expect(mapProblems(setOf({ bind: [[0, 1]], phase: 'left-step' }))).toEqual(['set "fix" names both "bind" and "phase"; a bound set shows on its bound frames and a phase set on its supporting foot\'s spans — drop one']);
  });
});

/**
 * A synthetic group on one arm, 24 frames at 24 fps (switchMin 0.25 s = 6 frames): `near`, an angle set whose key is
 * the pose on frames 4–19; `fix`, bound, its key 120° from the pose on every frame and its drawn angle 120° from its key
 * (an angle set so drawn is refused, SET_KEY_DRAWN), competing with `near` on slot forearm_r.
 */
const N = 24;
const times = Array.from({ length: N }, (_, i) => i / 24);
const SLOTS: RigSlots = new Map([
  ['forearm_r', { setup: 'forearm_r', attachments: new Set(['forearm_r', 'near_r', 'fix_r']), bone: 'arm_r0' }],
  ['cap_r', { setup: null, attachments: new Set(['fix_cap']), bone: 'arm_r0' }],
]);
const deg = (a: number): [number, number] => [100 * Math.cos((a * Math.PI) / 180), -100 * Math.sin((a * Math.PI) / 180)];
function group(fix: Partial<AlternateSet>): JointMap {
  const set = (o: Partial<AlternateSet> & { name: string }): AlternateSet => ({ slots: {}, hides: [], chains: ['arm_r'], pose: { r_shoulder: [0, 0], r_wrist: deg(-90) }, drawn: {}, offsets: {}, turn: {}, frames: null, place: null, ...o });
  return {
    translate: null,
    chains: [{ name: 'arm_r', bones: ['arm_r0'], joints: ['r_shoulder', 'r_wrist'], aim: ['x'], range: {}, bend: 'free', reach: false }],
    alternates: [
      set({ name: 'near', slots: { forearm_r: 'near_r' }, drawn: { arm_r0: -90 } }),
      set({ name: 'fix', slots: { forearm_r: 'fix_r', cap_r: 'fix_cap' }, pose: { r_shoulder: [0, 0], r_wrist: deg(150) }, drawn: { arm_r0: 30 }, ...fix }),
    ],
  };
}
const targets = new Map([['arm_r0', Array.from({ length: N }, (_, i) => (i >= 4 && i <= 19 ? -90 : 0))]]);
const OPTS: SwitchOptions = { switchTolerance: 25, switchMin: 0.25, switchAt: 'first' };
const showsOf = (sw: ReturnType<typeof selectSwitches>, set: string) => sw.switches.filter((s) => s.set === set).flatMap((s) => Array.from({ length: s.frames[1] - s.frames[0] + 1 }, (_, k) => s.frames[0] + k));
const BOUND = [[0, 0], [9, 11], [21, 21]] as Array<[number, number]>;
const boundList = BOUND.flatMap(([f, l]) => Array.from({ length: l - f + 1 }, (_, k) => f + k));

describe('selectSwitches: a bound set shows on exactly its bound frames, its key placed anywhere', () => {
  test('N/N bound frames, the far key and drawing refused for no set, one-frame binds kept, the rest of the group as without it', () => {
    const map = group({ bind: { cycle: null, at: BOUND } });
    // The key is at least 120° from the pose on every frame: far past the 25° tolerance.
    expect(Math.min(...targets.get('arm_r0')!.map((t) => Math.abs(((150 - t + 540) % 360) - 180)))).toBe(120);
    expect(keyDrawnProblems(map, 25)).toEqual([]);
    expect(keyDrawnProblems(group({}), 25)).toHaveLength(1);
    const sw = selectSwitches(map, targets, times, times[N - 1]!, SLOTS, OPTS);
    const shown = showsOf(sw, 'fix');
    console.log(`  #360: bound set shown on ${shown.filter((i) => boundList.includes(i)).length}/${boundList.length} bound frames, ${shown.filter((i) => !boundList.includes(i)).length} outside`);
    expect(shown).toEqual(boundList);
    expect(sw.switches.filter((s) => s.set === 'fix').every((s) => s.bound === true)).toBe(true);
    // `near` keeps 4–8 and 12–19 (its run cut by the bind; the cut runs are not re-tested against --switch-min).
    expect(showsOf(sw, 'near')).toEqual([4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(sw.switches.some((s) => s.set === 'near' && s.bound !== undefined)).toBe(false);
    // Keyed half a frame before each change, on and off, frame 0 at 0.
    expect(sw.slotTracks).toEqual([
      { slot: 'forearm_r', property: 'attachment', keys: [0, 1, 4, 9, 12, 20, 21, 22].map((i, k) => ({ t: keyAtFrame(times, i), v: ['fix_r', 'forearm_r', 'near_r', 'fix_r', 'near_r', 'forearm_r', 'fix_r', 'forearm_r'][k]! })) },
      { slot: 'cap_r', property: 'attachment', keys: [0, 1, 9, 12, 21, 22].map((i, k) => ({ t: keyAtFrame(times, i), v: k % 2 === 0 ? 'fix_cap' : null })) },
    ]);
    // A bound set has no switchRuns row; its row is switchBinds'.
    expect(sw.runs.map((r) => r.set)).toEqual(['near']);
    expect(switchBinds(map, N)).toEqual([{ set: 'fix', frames: BOUND }]);
    expect(switchBindLines(map, switchBinds(map, N), sw.switches)).toEqual(['set "fix": bound on 5 frame(s) in 3 run(s), 0, 9–11, 21 (from "bind" [[0,0],[9,11],[21,21]]); shown on 5/5 — no key distance, art-turn gate, --switch-min, bridging or hysteresis, and nowhere else']);
  });

  test('the cycle form gives byte-identical switches and tracks to the explicit list it expands to', () => {
    // 12-frame cycle, [9, 12]: the previous cycle's tail at 0, 9–12, and 21–24 cut at 23 — written out by hand.
    const hand: Array<[number, number]> = [[0, 0], [9, 12], [21, 23]];
    expect(bindFrames({ cycle: 12, at: [[9, 12]] }, N)).toEqual(hand);
    const cyc = selectSwitches(group({ bind: { cycle: 12, at: [[9, 12]] } }), targets, times, times[N - 1]!, SLOTS, OPTS);
    const exp = selectSwitches(group({ bind: { cycle: null, at: hand } }), targets, times, times[N - 1]!, SLOTS, OPTS);
    expect(showsOf(cyc, 'fix')).toEqual([0, 9, 10, 11, 12, 21, 22, 23]);
    expect(JSON.stringify({ s: cyc.switches, t: cyc.slotTracks, o: cyc.offsetTracks })).toBe(JSON.stringify({ s: exp.switches, t: exp.slotTracks, o: exp.offsetTracks }));
  });

  test('--switch-at peak and a large --switch-min move no bound boundary and drop no bound frame', () => {
    const map = group({ bind: { cycle: null, at: BOUND } });
    const sw = selectSwitches(map, targets, times, times[N - 1]!, SLOTS, { ...OPTS, switchAt: 'peak', switchMin: 0.5, switchHysteresis: 30 });
    expect(showsOf(sw, 'fix')).toEqual(boundList);
    for (const s of sw.switches.filter((x) => x.set === 'fix')) for (const m of [s.moved.on, s.moved.off]) if (m !== null) expect(m.frames).toBe(0);
  });

  test('a bound set takes its frames over a phase group too; the phase rule refuses no bound set', () => {
    const map = group({ bind: { cycle: null, at: [[5, 5]] } });
    map.alternates[0]!.phase = 'left-step';
    expect(phaseGroupProblems(map.alternates)).toEqual([]);
    const sw = selectSwitches(map, targets, times, times[N - 1]!, SLOTS, { ...OPTS, phaseSupports: [{ side: 'r', frames: [0, N - 1] }] });
    expect(showsOf(sw, 'fix')).toEqual([5]);
    expect(showsOf(sw, 'near')).toEqual([...Array.from({ length: 5 }, (_, i) => i), ...Array.from({ length: N - 6 }, (_, i) => i + 6)]);
  });

  test('mutant: the bind read as a window the angle rule picks inside loses the far-key bind and the one-frame bind', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'switch.ts');
      const src = readFileSync(path, 'utf8');
      const edits: Array<[string, string]> = [
        ['        if (a.bind !== undefined) continue;\n        if (a.frames', '        if (a.bind !== undefined && !bound.get(a.name)![i]) continue;\n        if (a.frames'],
        ['      for (let i = 0; i < n; i++) if (m[i]) pick[i] = a;\n', ''],
        ['  const groups = competing(map.alternates.filter((a) => a.bind === undefined));', '  const groups = competing(map.alternates);'],
        ["  for (const b of boundSets) spans(bound.get(b.name)!.map((v) => (v ? b : null)), { ...opts, switchAt: 'first' }, true);\n", ''],
        ['(a.bind !== undefined && !own)', 'own'],
        ['      if (a.bind !== undefined) continue;\n      nearestOn.set', '      nearestOn.set'],
        ['      if (a.bind !== undefined) continue;\n      const dropped = droppedOn', '      const dropped = droppedOn'],
      ];
      let out = src;
      for (const [from, to] of edits) {
        expect(out.split(from)).toHaveLength(2);
        out = out.replace(from, to);
      }
      writeFileSync(path, out);
      const m = (await import(path)) as { selectSwitches: typeof selectSwitches };
      // The far key: never within the tolerance, so never shown.
      const far = m.selectSwitches(group({ bind: { cycle: null, at: BOUND } }), targets, times, times[N - 1]!, SLOTS, OPTS);
      // The key on the pose, bound on one frame: a run of one frame, under --switch-min, dropped.
      const alone = (): JointMap => {
        const g = group({ bind: { cycle: null, at: [[6, 6]] }, pose: { r_shoulder: [0, 0], r_wrist: deg(-90) }, drawn: { arm_r0: -90 } });
        return { ...g, alternates: g.alternates.filter((a) => a.name === 'fix') };
      };
      const one = m.selectSwitches(alone(), targets, times, times[N - 1]!, SLOTS, OPTS);
      // Read as a window, the one frame is picked, then dropped by --switch-min.
      expect(one.runs.find((r) => r.set === 'fix')?.suppressed.map((r) => r.frames)).toEqual([[6, 6]]);
      console.log(`  #360 mutant: far-key bind shown on ${showsOf(far, 'fix').length}/${boundList.length}, one-frame bind on ${showsOf(one, 'fix').length}/1`);
      expect(showsOf(far, 'fix')).toEqual([]);
      expect(showsOf(one, 'fix')).toEqual([]);
      // The same two under the real rule.
      const oneReal = selectSwitches(alone(), targets, times, times[N - 1]!, SLOTS, OPTS);
      expect(showsOf(oneReal, 'fix')).toEqual([6]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('bindProblems: the sequence and overlap refusals', () => {
  test('SET_BIND_FRAMES: an explicit range past the last frame, a cycle bind that binds nothing; control: inside, and a cycle cut at the end', () => {
    const p = bindProblems(group({ bind: { cycle: null, at: [[20, 24]] } }), N);
    expect(p).toEqual({ frames: ['set "fix" "bind" range(s) [20,24] end(s) past the sequence\'s last frame 23 (24 frames); an explicit bound range lies inside the sequence — a cycle-relative bind { "cycle", "at" } is clipped at its end instead'], overlap: [] });
    expect(bindProblems(group({ bind: { cycle: 30, at: [[25, 26]] } }), N).frames).toEqual(['set "fix" "bind" { "cycle": 30, "at": [[25,26]] } binds no frame of the 24-frame sequence (its last frame is 23)']);
    expect(bindProblems(group({ bind: { cycle: null, at: [[20, 23]] } }), N)).toEqual({ frames: [], overlap: [] });
    expect(bindProblems(group({ bind: { cycle: 10, at: [[8, 9]] } }), N)).toEqual({ frames: [], overlap: [] });
  });
  test('SET_BIND_OVERLAP: two bound sets on a common frame and slot, bone, or group are refused naming both; control: disjoint frames', () => {
    const map = group({ bind: { cycle: null, at: [[2, 6]] } });
    map.alternates[0]!.bind = { cycle: 10, at: [[6, 7]] };
    expect(bindProblems(map, N).overlap).toEqual(['sets "near" and "fix" are both bound on 1 frame(s), 6, and both draw bone "arm_r0"; one drawing shows per bone and slot on a frame, and nothing decides between two bound sets — bind them on different frames']);
    map.alternates[0]!.bind = { cycle: null, at: [[7, 9]] };
    expect(bindProblems(map, N).overlap).toEqual([]);
  });
});

/** Two arms, each an independent single-arm set, beside a two-arm set; every arm on every key on every frame. */
function twoArms(withBound: boolean): JointMap {
  const key = { r_shoulder: [0, 0] as [number, number], r_wrist: deg(-90), l_shoulder: [0, 0] as [number, number], l_wrist: deg(-90) };
  const set = (o: Partial<AlternateSet> & { name: string }): AlternateSet => ({ slots: {}, hides: [], chains: [], pose: key, drawn: {}, offsets: {}, turn: {}, frames: null, place: null, ...o });
  return {
    translate: null,
    chains: [
      { name: 'arm_r', bones: ['arm_r0'], joints: ['r_shoulder', 'r_wrist'], aim: ['x'], range: {}, bend: 'free', reach: false },
      { name: 'arm_l', bones: ['arm_l0'], joints: ['l_shoulder', 'l_wrist'], aim: ['x'], range: {}, bend: 'free', reach: false },
    ],
    alternates: [
      set({ name: 'R', slots: { forearm_r: 'R_r' }, chains: ['arm_r'] }),
      set({ name: 'L', slots: { forearm_l: 'L_l' }, chains: ['arm_l'] }),
      ...(withBound ? [set({ name: 'both', slots: { forearm_r: 'both_r', forearm_l: 'both_l' }, chains: ['arm_r', 'arm_l'], bind: { cycle: null, at: [[5, 5]] } })] : []),
    ],
  };
}

describe('review of PR #362: a bind changes only its own frames', () => {
  test('a bound two-arm set joins no groups: two independent single-arm sets show on every unbound frame as without it', () => {
    const slots: RigSlots = new Map([
      ['forearm_r', { setup: 'forearm_r', attachments: new Set(['forearm_r', 'R_r', 'both_r']), bone: 'arm_r0' }],
      ['forearm_l', { setup: 'forearm_l', attachments: new Set(['forearm_l', 'L_l', 'both_l']), bone: 'arm_l0' }],
    ]);
    const tg = new Map([['arm_r0', Array.from({ length: N }, () => -90)], ['arm_l0', Array.from({ length: N }, () => -90)]]);
    const off = selectSwitches(twoArms(false), tg, times, times[N - 1]!, slots, OPTS);
    const on = selectSwitches(twoArms(true), tg, times, times[N - 1]!, slots, OPTS);
    expect(showsOf(off, 'R')).toHaveLength(N);
    expect(showsOf(off, 'L')).toHaveLength(N);
    const unbound = (sw: typeof on, s: string) => sw.shown.get(s)!.filter((_, i) => i !== 5);
    const diff = ['forearm_r', 'forearm_l'].map((s) => unbound(on, s).filter((v, k) => v !== unbound(off, s)[k]).length);
    console.log(`  #362 P2-1: unbound frames that differ with the bind, forearm_r ${diff[0]}, forearm_l ${diff[1]}`);
    expect(JSON.stringify(['forearm_r', 'forearm_l'].map((s) => unbound(on, s)))).toBe(JSON.stringify(['forearm_r', 'forearm_l'].map((s) => unbound(off, s))));
    expect(on.shown.get('forearm_r')![5]).toBe('both_r');
    expect(on.shown.get('forearm_l')![5]).toBe('both_l');
    expect(showsOf(on, 'R')).toEqual(Array.from({ length: N }, (_, i) => i).filter((i) => i !== 5));
    expect(showsOf(on, 'L')).toEqual(Array.from({ length: N }, (_, i) => i).filter((i) => i !== 5));
    expect(showsOf(on, 'both')).toEqual([5]);
  });

  test('no behind-the-torso bridge reaches a bound frame: only the bound drawing shows there', () => {
    // #136's layering: two back slots, the torso, the two front setup slots, and B's own slot. A draws both arms behind the
    // torso and hides the setup arms; B, bound to frame 5, hides the same setup arms and draws its own right arm.
    const n = 12;
    const t = Array.from({ length: n }, (_, i) => i / 24);
    const slots: RigSlots = new Map([
      ['back_r', { setup: null, attachments: new Set(['A_r']), bone: 'arm_r0' }],
      ['back_l', { setup: null, attachments: new Set(['A_l']), bone: 'arm_l0' }],
      ['topwear', { setup: 'topwear', attachments: new Set(['topwear', 'A_top']), bone: 'chest' }],
      ['forearm_r', { setup: 'forearm_r', attachments: new Set(['forearm_r']), bone: 'arm_r0' }],
      ['forearm_l', { setup: 'forearm_l', attachments: new Set(['forearm_l']), bone: 'arm_l0' }],
      ['b_r', { setup: null, attachments: new Set(['B_r']), bone: 'arm_r0' }],
    ]);
    const key = { r_shoulder: [0, 0] as [number, number], r_wrist: deg(-90), l_shoulder: [0, 0] as [number, number], l_wrist: deg(-90) };
    const set = (o: Partial<AlternateSet> & { name: string }): AlternateSet => ({ slots: {}, hides: [], chains: ['arm_r', 'arm_l'], pose: key, drawn: {}, offsets: {}, turn: {}, frames: null, place: null, ...o });
    const map: JointMap = {
      translate: null,
      chains: twoArms(false).chains,
      alternates: [
        set({ name: 'A', slots: { back_r: 'A_r', back_l: 'A_l', topwear: 'A_top' }, hides: ['forearm_r', 'forearm_l'], drawn: { arm_r0: -90, arm_l0: -90 } }),
        set({ name: 'B', slots: { b_r: 'B_r' }, hides: ['forearm_r', 'forearm_l'], chains: ['arm_r'], bind: { cycle: null, at: [[5, 5]] } }),
      ],
    };
    const tg = new Map([['arm_r0', Array.from({ length: n }, () => -90)], ['arm_l0', Array.from({ length: n }, () => -90)]]);
    const sw = selectSwitches(map, tg, t, t[n - 1]!, slots, OPTS);
    expect(sw.switches.map((s) => [s.set, s.frames])).toEqual([['A', [0, 4]], ['B', [5, 5]], ['A', [6, 11]]]);
    const at5 = Object.fromEntries([...slots.keys()].map((s) => [s, sw.shown.has(s) ? sw.shown.get(s)![5] : slots.get(s)!.setup]));
    console.log(`  #362 P2-2: frame 5 shows ${JSON.stringify(at5)}`);
    expect(at5).toEqual({ back_r: null, back_l: null, topwear: 'topwear', forearm_r: null, forearm_l: null, b_r: 'B_r' });
    // Either side of the bind, A's drawing as selected.
    for (const i of [4, 6]) expect([sw.shown.get('back_r')![i], sw.shown.get('back_l')![i], sw.shown.get('topwear')![i]]).toEqual(['A_r', 'A_l', 'A_top']);
    // No hold of A on the bound frame.
    expect((sw.chainHolds ?? []).filter((h) => h.frames[0] <= 5 && h.frames[1] >= 5)).toEqual([]);
  });
});
