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
import type { Rest, RestBone } from './map.ts';
import { isObject, parseJson, Problems, Refusal, typeName } from './problems.ts';

export interface RigInput {
  /** The rig spec (`rigc-rig/1`). */
  rig: string;
  /** Its name, which a motion spec's `archetype` must equal. */
  name: string;
  /** The motion spec the rig is built with, or null when it has none. */
  motion: string | null;
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
  return { rig, name: doc.name, motion };
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
export function gate(rig: string, motion: Record<string, unknown>, dir: string, profile: string): Gate {
  mkdirSync(dir, { recursive: true });
  const motionPath = join(dir, 'motion.json');
  writeFileSync(motionPath, `${JSON.stringify(motion, null, 2)}\n`);
  const build = join(dir, 'build');
  const run = runRigc(['build', '--rig', rig, '--motion', motionPath, '--out', build, '--profile', profile, '--report', join(dir, 'build-report.json')]);
  const lines = run.out.split('\n');
  return {
    run,
    green: run.status === 0,
    summary: lines.find((l) => /assertions: \d+ measured/.test(l))?.replace(/^[\s.]+/, '') ?? null,
    fails: lines.filter((l) => /^\s*FAIL\s/.test(l) || l.startsWith('rigc compile error')).map((l) => l.trim()),
    build,
  };
}

export function readBuild(build: string): CompiledDocument {
  const path = join(build, 'skeleton.model.json');
  return readModel(readFileSync(path, 'utf8'), path);
}

/** Every bone's setup pose, by rig-c's poser, with its model `length`. */
export function restOf(doc: CompiledDocument): Rest {
  const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
  const out = new Map<string, RestBone>();
  for (const b of poseRawSetup(doc).bones) out.set(b.name, { ...b, length: lengths.get(b.name) ?? 0 });
  return out;
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
