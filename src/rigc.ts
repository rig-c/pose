/**
 * Everything this package asks of rig-c that is not pure: its gate (`rigc build`),
 * its fold reading (`rigc render --folds`), and the files they write. This is
 * the one module in `src/` that touches the disk or starts a process.
 *
 * rig-c has no programmatic gate and no way to append an animation to a build
 * (its `docs/INGEST.md`: "There is no append — build re-emits the whole
 * skeleton"), so a retarget merges its animation into the rig's motion spec and
 * builds the rig again, exactly as @rig-c/parts does with `animations_from`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poseRawSetup, readModel, type CompiledDocument } from 'rig-c/core';
import type { InheritMode, Rest, RestBone, RigSet, RigSets, RigSlot, RigSlots } from './map.ts';
import { isObject, parseJson, Problems, Refusal, typeName } from './problems.ts';

export interface RigInput {
  /** The rig spec (`rigc-rig/1`). */
  rig: string;
  /** Its name, which a motion spec's `archetype` must equal. */
  name: string;
  /** The motion spec the rig is built with, or null when it has none. */
  motion: string | null;
  /** Any alternate sets declared in `sets.json` (`rig-parts-sets/1`) beside `rig.json`. */
  sets: RigSets;
}

function readRigSets(path: string): RigSets {
  const out = new Map<string, RigSet>();
  if (!existsSync(path)) return out;
  const doc = parseJson(readFileSync(path, 'utf8'), path, 'SETS_JSON');
  if (!isObject(doc) || (doc.spec !== 'rig-parts-sets/1' && doc.spec !== 'spine-parts-sets/1') || (!isObject(doc.sets) && !Array.isArray(doc.sets))) {
    throw new Refusal([{ code: 'SETS_SPEC', text: `${path} is not a rig-parts-sets/1 spec with a "sets" object` }]);
  }
  const addSet = (name: string, s: unknown) => {
    if (!isObject(s) || !isObject(s.slots)) return;
    const slots: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.slots)) if (typeof v === 'string') slots[k] = v;
    const hides = Array.isArray(s.hides) ? s.hides.filter((h): h is string => typeof h === 'string') : [];
    out.set(name, { slots, hides });
  };
  if (Array.isArray(doc.sets)) {
    for (const s of doc.sets) {
      if (isObject(s) && typeof s.name === 'string') addSet(s.name, s);
    }
  } else {
    for (const [name, s] of Object.entries(doc.sets)) addSet(name, s);
  }
  return out;
}

/**
 * `--rig` is the rig spec rigc builds from: a `rig.json`, or a directory holding
 * one (with its `motion.json` beside it, when it has one — @rig-c/parts writes
 * the pair to `<out>/rig/`). `--base-motion` names the motion spec explicitly.
 */
export function resolveRig(path: string, baseMotion: string | undefined): RigInput {
  const p = new Problems();
  let rig = resolve(path);
  let motion: string | null = baseMotion === undefined ? null : resolve(baseMotion);
  if (!existsSync(rig)) p.add('RIG_PATH', `--rig ${path} does not exist`);
  else if (statSync(rig).isDirectory()) {
    const dir = rig;
    rig = join(dir, 'rig.json');
    if (!existsSync(rig)) {
      const built = existsSync(join(dir, 'skeleton.model.json'));
      p.add('RIG_PATH', `--rig ${path} is a directory with no rig.json${built ? ' (it holds skeleton.model.json, a build: the gate rebuilds the rig with the animation in, so it needs the spec the build came from — for @rig-c/parts, <out>/rig/)' : ''}`);
    } else if (motion === null && existsSync(join(dir, 'motion.json'))) motion = join(dir, 'motion.json');
  }
  if (motion !== null && !existsSync(motion)) p.add('RIG_PATH', `--base-motion ${baseMotion} does not exist`);
  p.throwIfAny();
  const doc = parseJson(readFileSync(rig, 'utf8'), rig, 'RIG_JSON');
  if (!isObject(doc) || doc.spec !== 'rigc-rig/1' || typeof doc.name !== 'string') {
    throw new Refusal([{ code: 'RIG_SPEC', text: `${rig} is not a rig spec: "spec" is ${isObject(doc) ? typeName(doc.spec) : typeName(doc)} and "name" ${isObject(doc) ? typeName(doc.name) : '-'}; it must be "rigc-rig/1" with a name` }]);
  }
  const sets = readRigSets(join(dirname(rig), 'sets.json'));
  return { rig, name: doc.name, motion, sets };
}

/** The motion spec the rig is built with, or an empty one under its name. */
export function baseMotionOf(input: RigInput): Record<string, unknown> {
  if (input.motion === null) return { spec: 'rigc-motion/1', archetype: input.name, cut: input.name, easings: {}, animations: {} };
  const doc = parseJson(readFileSync(input.motion, 'utf8'), input.motion, 'MOTION_JSON');
  if (!isObject(doc) || doc.spec !== 'rigc-motion/1' || !isObject(doc.animations)) {
    throw new Refusal([{ code: 'MOTION_SPEC', text: `${input.motion} is not a rigc-motion/1 spec with an "animations" object` }]);
  }
  if (doc.archetype !== input.name) throw new Refusal([{ code: 'MOTION_SPEC', text: `${input.motion} "archetype" is ${typeName(doc.archetype)}; the rig ${input.rig} is named "${input.name}", and rigc builds only a pair that agree` }]);
  return doc;
}

/**
 * rig-c's own launcher, run under the Bun running this one. It picks rigc's
 * entry the way an install of rig-c does: the spine-core round trip where
 * `@esotericsoftware/spine-core` resolves beside rig-c (this repository's
 * development dependency), rigc's own gate over the model document where it
 * does not (an install of this package), and the gate's report says which ran.
 */
export function rigcCli(): string {
  return fileURLToPath(import.meta.resolve('rig-c/bin/rigc'));
}

export interface RigcRun {
  args: string[];
  status: number;
  out: string;
}

export function runRigc(args: string[]): RigcRun {
  const r = spawnSync(process.execPath, [rigcCli(), ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { args, status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export interface Gate {
  run: RigcRun;
  green: boolean;
  /** The `..  N assertions: …` summary line rigc prints, when it printed one. */
  summary: string | null;
  /** Every `FAIL` line, verbatim. */
  fails: string[];
  build: string;
}

/** Build `rig` with `motion` under rigc's gate into `dir/build`; nothing is read from a red build. */
export function gate(rig: string, motion: Record<string, unknown>, dir: string, profile: string, images?: string): Gate {
  mkdirSync(dir, { recursive: true });
  const motionPath = join(dir, 'motion.json');
  writeFileSync(motionPath, `${JSON.stringify(motion, null, 2)}\n`);
  return buildInto(rig, motionPath, join(dir, 'build'), profile, join(dir, 'build-report.json'), images);
}

/**
 * `rigc build` of `rig` with the motion spec at `motionPath` into `out`, under
 * rigc's gate (it writes nothing when red). rigc records each source image's
 * path relative to `out` (`images[].page` in the model document), so a build is
 * only right where it was built: the run gates in a scratch directory, and the
 * build `--build` keeps is built again, by rigc, where it will live (#18) —
 * never copied out, which would carry a path climbing from the scratch
 * directory to the filesystem root. --copy-images puts the pages beside it.
 */
export function buildInto(rig: string, motionPath: string, out: string, profile: string, report?: string, images?: string): Gate {
  const run = runRigc(['build', '--rig', rig, '--motion', motionPath, '--out', out, '--profile', profile, '--copy-images', ...(images === undefined ? [] : ['--images', images]), ...(report === undefined ? [] : ['--report', report])]);
  const lines = run.out.split('\n');
  return {
    run,
    green: run.status === 0,
    summary: lines.find((l) => /assertions: \d+ measured/.test(l))?.replace(/^[\s.]+/, '') ?? null,
    fails: lines.filter((l) => /^\s*FAIL\s/.test(l) || l.startsWith('rigc compile error')).map((l) => l.trim()),
    build: out,
  };
}

export function readBuild(build: string): CompiledDocument {
  const path = join(build, 'skeleton.model.json');
  return readModel(readFileSync(path, 'utf8'), path);
}

/** Every bone's setup pose, by rig-c's poser, with its model `length` and `inheritMode`. */
export function restOf(doc: CompiledDocument): Rest {
  const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
  const inherits = new Map<string, InheritMode>(
    doc.bones.map((b) => {
      const s = b.inheritMode;
      const folded = s === undefined || s.length === 0 ? 'normal' : `${s[0]!.toLowerCase()}${s.slice(1)}`;
      return [b.name, folded === 'onlyTranslation' || folded === 'noRotationOrReflection' || folded === 'noScale' || folded === 'noScaleOrReflection' ? folded : 'normal'];
    }),
  );
  const out = new Map<string, RestBone>();
  for (const b of poseRawSetup(doc).bones) out.set(b.name, { ...b, length: lengths.get(b.name) ?? 0, inherit: inherits.get(b.name) ?? 'normal' });
  return out;
}

/** Every slot of the build: what it shows at setup, as the compiled model states it, and every attachment any skin gives it. */
export function slotsOf(doc: CompiledDocument): RigSlots {
  const out = new Map<string, RigSlot>();
  for (const s of doc.slots) {
    const attachments = new Set<string>();
    for (const k of doc.skins) for (const name of Object.keys(k.attachments[s.name] ?? {})) attachments.add(name);
    out.set(s.name, { setup: s.setup, attachments, bone: s.bone });
  }
  return out;
}

/**
 * The bones that move an attachment: a weighted mesh's bindings (a linked mesh
 * its source's), or the slot's bone for anything else — what an uncovered fold
 * names its chains by.
 */
export function attachmentBones(doc: CompiledDocument, slot: string, attachment: string): string[] {
  const slotBone = doc.slots.find((s) => s.name === slot)?.bone;
  const find = (sl: string, name: string) => {
    for (const k of doc.skins) {
      const g = k.attachments[sl]?.[name]?.geometry;
      if (g !== undefined) return g;
    }
    return undefined;
  };
  let g = find(slot, attachment);
  if (g?.kind === 'linkedmesh') g = find(g.slot, g.source);
  if (g !== undefined && 'vertices' in g && g.vertices.weighted) {
    const bones = new Set<string>();
    for (const v of g.vertices.bindings) for (const b of v) bones.add(b.bone);
    return [...bones];
  }
  return slotBone === undefined ? [] : [slotBone];
}

export interface MeshFolds {
  slot: string;
  attachment: string;
  /** Times (seconds) of the sampled frames on which the mesh folds. */
  times: number[];
}

/** `rigc render --folds` over one animation: which meshes fold, and when. */
export function folds(build: string, animation: string, dir: string, fps: number): { run: RigcRun; meshes: MeshFolds[] | null; frames: string } {
  const out = join(dir, 'render');
  const run = runRigc(['render', '--candidate', build, '--animation', animation, '--folds', '--fps', String(fps), '--out', out]);
  if (run.status !== 0) return { run, meshes: null, frames: out };
  const framesDoc = JSON.parse(readFileSync(join(out, 'frames.json'), 'utf8')) as { sets: Array<{ dir: string; animation: string }> };
  const set = framesDoc.sets.find((s) => s.animation === animation);
  if (set === undefined) return { run, meshes: null, frames: out };
  const setDir = resolve(dirname(join(out, 'frames.json')), set.dir);
  const foldsPath = existsSync(join(setDir, 'folds.json')) ? join(setDir, 'folds.json') : join(out, set.dir, 'folds.json');
  const doc = JSON.parse(readFileSync(foldsPath, 'utf8')) as { meshes: Array<{ slot: string; attachment: string; frames: Array<{ time: number }> }> };
  return {
    run,
    meshes: doc.meshes.filter((m) => m.frames.length > 0).map((m) => ({ slot: m.slot, attachment: m.attachment, times: m.frames.map((f) => f.time) })),
    frames: setDir,
  };
}

/** rig-c's version and the entry its launcher picked (`rigc --version`), so a run names the compiler that gated it. */
export function rigcVersion(): { version: string; entry: string } {
  const r = runRigc(['--version']);
  const lines = r.out.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const version = lines.find((l) => /^\d+\.\d+\.\d+/.test(l)) ?? lines[0] ?? 'unknown';
  const entry = lines.find((l) => l.startsWith('entry:'))?.slice('entry:'.length).trim() ?? 'not stated';
  return { version, entry };
}
