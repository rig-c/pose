/**
 * rig-c/pose#303: `--contact-keys`, the support declared by hand. Held by a
 * public synthetic slow frontal walk — 8 drawings a stride, each held 4.75
 * frames at 24 fps (a key sheet timed off the frame grid), the nearer foot drawn
 * lower — whose contact table is its keys: on every covered frame the support
 * is the keys' (the key holds until the next one), before the first key it is
 * the reading without keys, the report names the keys per span, a run without
 * the flag prints and writes none of it, and a bad file is refused by name.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from '../src/clean.ts';
import { CONTACT_KEYS_SPEC, contactKeysOf, readContactKeys, type ContactSide } from '../src/contacts.ts';
import { supportsOf, type Side } from '../src/legs.ts';
import { readPoseSequence, writePoseSequence } from '../src/pose.ts';
import { Refusal } from '../src/problems.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const SLOW = 60_000;
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
type Pt = [number, number];

// --- the fixture: a slow drawn frontal walk -------------------------------------

const FPS = 24;
const DRAWINGS = 8;
/** Each drawing is held this many frames: 8 drawings a stride over 38 frames, 1.58 s. */
const HOLD = 4.75;
const CYCLES = 4;
const N = Math.round(DRAWINGS * HOLD * CYCLES);
const FLOOR_Y = 553;
const HIP_Y = 403;
const X: Record<Side, number> = { r: 185, l: 215 };
/** Each foot's depth from front to back as the picture draws it, px. */
const DEPTH: Record<Side, number> = { r: 17, l: 23 };
const LANDS: Record<Side, number> = { r: 0, l: 4 };
const LIFT = [3, 2];
/** The first drawing the key sheet keys: frames before it are outside the keys. */
const FIRST_KEYED = 2;

const phaseOf = (s: Side, k: number): number => (((k - LANDS[s]) % DRAWINGS) + DRAWINGS) % DRAWINGS;
const downOn = (s: Side, k: number): boolean => phaseOf(s, k) <= 5;
/** One drawing's ankle: down 6 drawings sliding back, 2 in the air swinging forward, lifted; the nearer foot lower. */
function drawn(s: Side, k: number): Pt {
  const j = phaseOf(s, k);
  const z = j <= 5 ? j / 5 : (DRAWINGS - j) / 3;
  const lift = j === 6 ? LIFT[0]! : j === 7 ? LIFT[1]! : 0;
  return [X[s], FLOOR_Y - DEPTH[s] * z - lift];
}
const drawingOf = (i: number): number => Math.floor(i / HOLD + 1e-9);
/** A drawing's contact: the foot down, or both. */
const contactOf = (d: number): ContactSide => (downOn('r', d) && downOn('l', d) ? 'both' : downOn('r', d) ? 'r' : 'l');

function slowWalk(): { ankle: Record<Side, Pt[]>; hip: Record<Side, Pt[]> } {
  const ankle = { r: [] as Pt[], l: [] as Pt[] };
  const hip = { r: [] as Pt[], l: [] as Pt[] };
  for (let i = 0; i < N; i++) {
    for (const s of ['r', 'l'] as const) {
      ankle[s].push(drawn(s, drawingOf(i)));
      hip[s].push([X[s], HIP_Y]);
    }
  }
  return { ankle, hip };
}

/** The key sheet: one key where the contact changes, on the drawing's own (fractional) frame, from drawing FIRST_KEYED on. */
function keySheet(): Array<{ frame: number; side: ContactSide }> {
  const keys: Array<{ frame: number; side: ContactSide }> = [];
  for (let d = FIRST_KEYED; d * HOLD <= N - 1; d++) {
    const side = contactOf(d);
    if (keys[keys.length - 1]?.side !== side) keys.push({ frame: Math.round(d * HOLD * 100) / 100, side });
  }
  return keys;
}
const keysText = (keys: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ spec: CONTACT_KEYS_SPEC, keys, ...extra });

const times = Array.from({ length: N }, (_, i) => i / FPS);
const secondsOf = (x: [number, number]) => (x[1] - x[0] + 1) / FPS;

/** What the keys require on a covered frame: the side keyed; on `both`, the foot that landed (the next single-foot key's side, on a walk); null on `none`. */
function required(key: ReadonlyArray<ContactSide | null>, i: number): Side | null {
  const k = key[i]!;
  if (k === 'none') return null;
  if (k !== 'both') return k;
  let j = i;
  while (key[j] === 'both') j++;
  return key[j] as Side;
}

describe('#303: a slow drawn frontal walk — the support follows the contact keys', () => {
  test('bar 1: on every covered frame the support is the keys\' (both → the foot that landed); bar 2: before the first key it is the reading without keys, frame for frame', () => {
    const { ankle, hip } = slowWalk();
    const plain = supportsOf(ankle, hip, times, secondsOf, true, true);
    const keys = readContactKeys(keysText(keySheet()), 'keys.json', N);
    const feet = contactKeysOf(plain, keys);
    const c = feet.contactKeys!;
    const covered = keys.key.map((k, i) => (k === null ? -1 : i)).filter((i) => i >= 0);
    const wrongPlain = covered.filter((i) => (plain.support[i] ?? null) !== required(keys.key, i));
    const wrongKeyed = covered.filter((i) => (feet.support[i] ?? null) !== required(keys.key, i));
    console.log(`  #303 slow walk: ${N} frames, ${keys.keys.length} keys (first at ${keys.keys[0]!.frame}), cover ${covered.length}; the reading without keys (frontal ${plain.signal!.frontal}) misses the keys on ${wrongPlain.length}, with keys ${wrongKeyed.length}; changed runs ${c.changed.length}`);
    expect(keys.keys.some((k) => !Number.isInteger(k.frame))).toBe(true);
    expect(c.from).toBe(Math.ceil(FIRST_KEYED * HOLD));
    expect(covered).toHaveLength(N - c.from);
    expect(wrongPlain.length).toBeGreaterThan(0);
    expect(wrongKeyed).toEqual([]);
    for (const i of covered) expect(c.keyed[i]).toBe(true);
    // The key holds until the next one: frames between two keys carry the earlier key.
    for (let k = 0; k + 1 < keys.keys.length; k++) for (let i = Math.ceil(keys.keys[k]!.frame); i < keys.keys[k + 1]!.frame; i++) expect(keys.key[i]).toBe(keys.keys[k]!.side);
    // Bar 2: outside the keys (frames before the first), the reading without them.
    for (let i = 0; i < c.from; i++) {
      expect(feet.support[i] ?? null).toBe(plain.support[i] ?? null);
      expect(c.keyed[i]).toBe(false);
    }
    expect(c.before).toEqual(plain.support.map((s) => s ?? null));
    // Rebuilt as #280's: spans and changes are the per-frame support's.
    for (const sp of feet.supports) for (let i = sp.frames[0]; i <= sp.frames[1]; i++) expect(feet.support[i]).toBe(sp.side);
    for (const ch of feet.changes) expect(feet.support[ch.frame]).toBe(ch.to);
  });

  test('mutant: both keeping the foot that was supporting (no hand-over on landing) misses the keys on the both-down frames, and bar 1 is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm303-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      const path = join(d, 'src', 'contacts.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'keyed[i - 1] && prev !== null ? other(prev) :';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'keyed[i - 1] && prev !== null ? prev :'));
      const m = (await import(path)) as { contactKeysOf: typeof contactKeysOf; readContactKeys: typeof readContactKeys };
      const { ankle, hip } = slowWalk();
      const keys = m.readContactKeys(keysText(keySheet()), 'keys.json', N);
      const feet = m.contactKeysOf(supportsOf(ankle, hip, times, secondsOf, true, true), keys);
      const wrong = keys.key.map((k, i) => (k !== null && (feet.support[i] ?? null) !== required(keys.key, i) ? i : -1)).filter((i) => i >= 0);
      console.log(`  #303 mutant "both keeps the supporting foot": ${wrong.length} covered frame(s) miss the keys, every one keyed both: ${wrong.every((i) => keys.key[i] === 'both')}`);
      expect(wrong.length).toBeGreaterThan(0);
      for (const i of wrong) expect(keys.key[i]).toBe('both');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('none is flight: no foot supports; both after flight takes the next single-foot key\'s side; a key at a fractional frame starts on the next whole frame', () => {
    const { ankle, hip } = slowWalk();
    const plain = supportsOf(ankle, hip, times, secondsOf, true, true);
    const keys = readContactKeys(keysText([{ frame: 10.25, side: 'r' }, { frame: 20.5, side: 'none' }, { frame: 24, side: 'both' }, { frame: 27, side: 'l' }, { frame: 40, side: 'both' }]), 'keys.json', N);
    expect(keys.key[10]).toBeNull();
    expect(keys.key[11]).toBe('r');
    expect(keys.key[20]).toBe('r');
    expect(keys.key[21]).toBe('none');
    const feet = contactKeysOf(plain, keys);
    for (let i = 21; i <= 23; i++) expect(feet.support[i]).toBeNull();
    for (let i = 24; i <= 39; i++) expect(feet.support[i]).toBe('l');
    // The last key holds to the clip's end: both after l, the foot that landed is r.
    for (let i = 40; i < N; i++) expect(feet.support[i]).toBe('r');
    // Rebuilt from the per-frame support: the r span ends at 20, the flight has none, l runs 24–39, r from 40 to the end.
    expect(feet.supports.filter((s) => s.frames[1] >= 11).map((s) => [s.side, s.frames[1]])).toEqual([['r', 20], ['l', 39], ['r', N - 1]]);
    expect(feet.supports.filter((s) => s.frames[1] >= 11).slice(1).map((s) => s.frames[0])).toEqual([24, 40]);
  });

  test('bar 5: a bad file is refused by name — not JSON, the shape, a side outside the four, a frame out of span, frames not increasing — every problem in one refusal', () => {
    const refusal = (text: string): string[] => {
      try {
        readContactKeys(text, 'keys.json', N);
      } catch (e) {
        if (e instanceof Refusal) return e.problems.map((p) => `${p.code}: ${p.text}`);
        throw e;
      }
      return [];
    };
    expect(refusal('{ not json')[0]).toStartWith('CONTACT_KEYS: keys.json is not JSON: ');
    expect(refusal('[]')).toEqual([`CONTACT_KEYS: keys.json is an array; it must be { "spec": "${CONTACT_KEYS_SPEC}", "keys": [{ "frame", "side" }], "note"? }`]);
    expect(refusal(JSON.stringify({ spec: 'rig-pose-pelvis-keys/1', keys: [] }))).toEqual([
      `CONTACT_KEYS: keys.json "spec" is the string "rig-pose-pelvis-keys/1"; it must be "${CONTACT_KEYS_SPEC}"`,
      'CONTACT_KEYS: keys.json "keys" is an array; it must be a non-empty array of { frame, side }',
    ]);
    const lines = refusal(keysText([{ frame: 0, side: 'left' }, { frame: 4, side: 'r' }, { frame: 4, side: 'l' }, { frame: N, side: 'both' }, { frame: 9, side: 'l', at: 1 }]));
    console.log(`  #303 refusals:\n    ${lines.join('\n    ')}`);
    expect(lines).toEqual([
      'CONTACT_KEYS: keys.json keys[0] "side" is the string "left"; it must be one of l, r, both, none (the foot down, both feet, or flight)',
      'CONTACT_KEYS: keys.json keys[2] "frame" is 4, not after the key before it (4); frames strictly increase',
      `CONTACT_KEYS: keys.json keys[3] "frame" is number ${N}; it must be a frame of the sequence in [0, ${N - 1}] (fractional allowed)`,
      'CONTACT_KEYS: keys.json keys[4] has a key this reader does not know: "at"; the keys it reads are frame, side',
    ]);
  });
});

// --- the run -------------------------------------------------------------------

/** The slow walk's legs on the README walk's still upper body, knees on the hip → ankle line, `clean --loop --legs 1 --rest 1`ed. */
function slowPose(): string {
  const walk = JSON.parse(readFileSync(join(ROOT, 'examples', 'walk', 'pose.json'), 'utf8')) as { width: number; height: number; frames: Array<{ people: Array<{ joints: Record<string, unknown> }> }> };
  const body = walk.frames[0]!.people[0]!.joints;
  const { ankle, hip } = slowWalk();
  const frames = Array.from({ length: N }, (_, i) => {
    const joints: Record<string, unknown> = { ...body };
    for (const s of ['r', 'l'] as const) {
      const h = hip[s][i]!;
      const a = ankle[s][i]!;
      const u = 80 / 150;
      joints[`${s}_hip`] = { state: 'observed', at: h, score: 1 };
      joints[`${s}_knee`] = { state: 'observed', at: [h[0] + (a[0] - h[0]) * u, h[1] + (a[1] - h[1]) * u], score: 1 };
      joints[`${s}_ankle`] = { state: 'observed', at: a, score: 1 };
    }
    return { t: Math.round((i / FPS) * 1e6) / 1e6, people: [{ id: 'a', joints }] };
  });
  const doc = { spec: 'rig-pose-sequence/1', space: { units: 'picture-px', origin: 'top-left', y: 'down' }, width: walk.width, height: walk.height, source: 'test/contactkeys.test.ts: a synthetic slow drawn frontal walk, no picture', frames };
  const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
  return writePoseSequence(clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture').seq);
}

describe('#303: the run — the report names the contact keys per span; without the flag nothing changes; refusals by name', () => {
  test('bar 3: one contact-keys support line and a stride line per span naming contact keys, none over 260 characters, and the report key; bar 4 control: the same run without the flag prints neither and writes no contactKeys key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-pose-test-'));
    try {
      const pose = join(dir, 'pose.json');
      writeFileSync(pose, slowPose());
      const keys = join(dir, 'keys.json');
      writeFileSync(keys, keysText(keySheet(), { note: 'the slow walk\'s key sheet' }));
      const run = (out: string, extra: string[] = []) => spawnSync(process.execPath, [CLI, 'retarget', '--rig', join(ROOT, 'examples', 'wave', 'rig'), '--map', join(ROOT, 'examples', 'walk', 'map.json'), '--pose', pose, '--out', join(dir, `${out}.motion.json`), '--name', 'walk', '--plant-feet', ...extra], { encoding: 'utf8', cwd: ROOT });
      const feetOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('FEET '));
      const r = run('keyed', ['--contact-keys', keys]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const feet = feetOf(r.stdout);
      const support = feet.filter((l) => l.startsWith('FEET   support: contact keys'));
      const strides = feet.filter((l) => l.startsWith('FEET   stride '));
      console.log(`  #303 run:\n    ${[...feet.filter((l) => l.startsWith('FEET   supports:')), ...support, ...strides.slice(0, 3)].join('\n    ')}`);
      expect(support).toHaveLength(1);
      expect(support[0]).toContain(`cover frames ${Math.ceil(FIRST_KEYED * HOLD)}–${N - 1} of ${N}, each holding until the next one`);
      expect(support[0]).toContain(`frames 0–${Math.ceil(FIRST_KEYED * HOLD) - 1}, before the first key, keep it`);
      expect(strides.length).toBeGreaterThan(2);
      // Every span after the first key's frame is decided by the keys alone.
      for (const l of strides) {
        const from = Number(/^FEET {3}stride [rl] (\d+)/.exec(l)![1]);
        if (from >= Math.ceil(FIRST_KEYED * HOLD)) expect(l).toMatch(/: of \d+ frame\(s\), decided by contact keys \d+; /);
      }
      expect(Math.max(...[...support, ...strides].map((l) => `  ${l}`.length))).toBeLessThanOrEqual(260);
      const report = JSON.parse(readFileSync(join(dir, 'keyed.motion.report.json'), 'utf8')) as Record<string, unknown> & { contactKeys: { path: string; keys: number; from: number }; options: Record<string, unknown> };
      expect(report.contactKeys.path).toBe(keys);
      expect(report.contactKeys.keys).toBe(keySheet().length);
      expect(report.contactKeys.from).toBe(Math.ceil(FIRST_KEYED * HOLD));
      expect(report.options.contactKeys).toBe(keys);
      // Control: no flag — no contact-keys line, no contactKeys key, no option.
      const p = run('plain');
      expect(p.status).toBe(0);
      expect(feetOf(p.stdout).filter((l) => l.includes('contact keys'))).toEqual([]);
      const plain = JSON.parse(readFileSync(join(dir, 'plain.motion.report.json'), 'utf8')) as Record<string, unknown> & { options: Record<string, unknown> };
      expect('contactKeys' in plain).toBe(false);
      expect('contactKeys' in plain.options).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);

  test('bar 5 through the command: a bad keys file is refused by name with exit 1 and nothing written; a map whose legs are not read refuses the keys by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-pose-test-'));
    try {
      const pose = join(dir, 'pose.json');
      writeFileSync(pose, slowPose());
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, keysText([{ frame: 2.5, side: 'both' }, { frame: 1, side: 'l' }, { frame: N + 0.5, side: 'none' }, { frame: 200.5, side: 'down' }]));
      const out = join(dir, 'bad.motion.json');
      const r = spawnSync(process.execPath, [CLI, 'retarget', '--rig', join(ROOT, 'examples', 'wave', 'rig'), '--map', join(ROOT, 'examples', 'walk', 'map.json'), '--pose', pose, '--out', out, '--name', 'walk', '--contact-keys', bad], { encoding: 'utf8', cwd: ROOT });
      const fails = r.stderr.split('\n').filter((l) => l.startsWith('FAIL'));
      console.log(`  #303 refused (exit ${r.status}):\n    ${fails.join('\n    ')}`);
      expect(r.status).toBe(1);
      expect(fails).toEqual([
        `FAIL  CONTACT_KEYS: ${bad} keys[1] "frame" is 1, not after the key before it (2.5); frames strictly increase`,
        `FAIL  CONTACT_KEYS: ${bad} keys[2] "frame" is number ${N + 0.5}; it must be a frame of the sequence in [0, ${N - 1}] (fractional allowed)`,
        `FAIL  CONTACT_KEYS: ${bad} keys[3] "frame" is number 200.5; it must be a frame of the sequence in [0, ${N - 1}] (fractional allowed)`,
        `FAIL  CONTACT_KEYS: ${bad} keys[3] "side" is the string "down"; it must be one of l, r, both, none (the foot down, both feet, or flight)`,
      ]);
      expect(existsSync(out)).toBe(false);
      const missing = spawnSync(process.execPath, [CLI, 'retarget', '--rig', join(ROOT, 'examples', 'wave', 'rig'), '--map', join(ROOT, 'examples', 'walk', 'map.json'), '--pose', pose, '--out', out, '--name', 'walk', '--contact-keys', join(dir, 'none.json')], { encoding: 'utf8', cwd: ROOT });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(`ARG_PATH: --contact-keys ${join(dir, 'none.json')} does not exist`);
      // A map with no leg chains (the wave map, its legs taken out): no support is read, so keys for it are refused rather than ignored.
      const waveMap = JSON.parse(readFileSync(join(ROOT, 'examples', 'wave', 'map.json'), 'utf8')) as { chains: Array<{ joints: string[] }> };
      waveMap.chains = waveMap.chains.filter((c) => !c.joints.includes('r_hip') && !c.joints.includes('l_hip'));
      const armsMap = join(dir, 'arms.map.json');
      writeFileSync(armsMap, JSON.stringify(waveMap));
      const good = join(dir, 'good.json');
      writeFileSync(good, keysText([{ frame: 0, side: 'both' }]));
      const wavePose = join(ROOT, 'examples', 'wave', 'pose.json');
      const frames = (JSON.parse(readFileSync(wavePose, 'utf8')) as { frames: unknown[] }).frames.length;
      expect(frames).toBeGreaterThan(0);
      const noLegs = spawnSync(process.execPath, [CLI, 'retarget', '--rig', join(ROOT, 'examples', 'wave', 'rig'), '--map', armsMap, '--pose', wavePose, '--out', join(dir, 'wave.motion.json'), '--name', 'wavekeys', '--contact-keys', good], { encoding: 'utf8', cwd: ROOT });
      const noLegsFails = noLegs.stderr.split('\n').filter((l) => l.startsWith('FAIL'));
      console.log(`  #303 no legs (exit ${noLegs.status}):\n    ${noLegsFails.join('\n    ')}`);
      expect(noLegs.status).toBe(1);
      expect(noLegsFails.some((l) => l.startsWith('FAIL  CONTACT_KEYS: --contact-keys '))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);
});
