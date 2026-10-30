/** Disk boundary for compiled-only landmark extraction. */
import { readModel, underNoSkin } from '@rig-c/core/core';
import corePackage from '@rig-c/core/package.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { resolve, join } from 'node:path';
import { extractSequence, readExtractMap } from './extract.ts';
import { makeOutDirs, planOutDirs } from './outdir.ts';
import { writePoseSequence } from './pose.ts';
import { isObject, parseJson, Problems, Refusal } from './problems.ts';

export interface ExtractArgs { model: string; map: string; animation: string; fps: number; loop: boolean; out: string }
const digest = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const remedy = 'Convert raw Spine 4.3 with `rigc ingest source.json --out specs --art none`, then `rigc build --rig specs/rig.json --motion specs/motion.json --atlas-in source.atlas --out build --profile spine`. Keep the authentic atlas and its page PNGs together; build validates their image streams. Pass build/skeleton.model.json here.';

export function runExtract(args: ExtractArgs, say: (line: string) => void): void {
  const read = (path: string): Buffer => {
    try { return readFileSync(path); }
    catch (e) { throw new Refusal([{ code: 'EXTRACT_INPUT', text: `${path} cannot be read: ${(e as Error).message}; required a readable file` }]); }
  };
  const sourceBytes = read(args.model), mapBytes = read(args.map);
  const sourceText = sourceBytes.toString('utf8'), mapText = mapBytes.toString('utf8');
  const raw = parseJson(sourceText, args.model, 'EXTRACT_MODEL');
  if (!isObject(raw) || typeof raw.spec !== 'string' || !/^rigc-compiled\/[123]$/.test(raw.spec)) throw new Refusal([{ code: 'EXTRACT_MODEL', text: `${args.model} spec is ${JSON.stringify(isObject(raw) ? raw.spec : null)}; required a compiled skeleton.model.json. ${remedy}` }]);
  let doc;
  try { doc = underNoSkin(readModel(sourceText, args.model)); }
  catch (e) { throw new Refusal([{ code: 'EXTRACT_MODEL', text: `${args.model}: ${(e as Error).message}. ${remedy}` }]); }
  const map = readExtractMap(mapText, args.map);
  const names = args.animation === 'all' ? doc.animations.map(a => a.name) : [args.animation];
  if (names.length === 0) throw new Refusal([{ code: 'EXTRACT_ANIMATION', text: `${args.model} has no animations; required at least one named animation` }]);
  const outputs = names.map((name, i) => {
    // Indices keep arbitrary source names out of filesystem paths and prevent collisions.
    const path = args.animation === 'all' ? join(args.out, `${String(i).padStart(4, '0')}.pose.json`) : args.out;
    return { name, path, record: `${path}.extract.json` };
  });
  const p = new Problems();
  const dirs = planOutDirs(outputs.flatMap(o => [['--out', o.path], ['extraction record', o.record]] as Array<[string, string]>), p);
  const inputPaths = [args.model, args.map];
  const inputs = new Set(inputPaths.map(path => resolve(path)));
  const inputFiles = inputPaths.map(path => ({ real: realpathSync(path), stat: statSync(path) }));
  const existingOutputs: Array<{ path: string; real: string; stat: Stats }> = [];
  for (const o of outputs) for (const path of [o.path, o.record]) {
    if (inputs.has(resolve(path))) p.add('ARG_PATH', `${path} is an input file; output must have a distinct path`);
    if (existsSync(path)) {
      try {
        const stat = statSync(path), real = realpathSync(path);
        if (inputFiles.some(input => input.real === real || (input.stat.dev === stat.dev && input.stat.ino === stat.ino))) p.add('ARG_PATH', `${path} aliases an input file through its real path or device/inode; output must be a distinct file`);
        if (existingOutputs.some(output => output.real === real || (output.stat.dev === stat.dev && output.stat.ino === stat.ino))) p.add('ARG_PATH', `${path} aliases another output; every output must be a distinct file`);
        existingOutputs.push({ path, real, stat });
        if (!stat.isFile()) p.add('ARG_PATH', `${path} is not a regular output file`); else accessSync(path, constants.W_OK);
      }
      catch (e) { p.add('ARG_PATH', `${path} is not writable: ${(e as Error).message}`); }
    }
  }
  p.throwIfAny();
  // All animations pose before any output is written; a later refusal cannot leave partial results.
  const results = outputs.map(o => ({ ...o, value: extractSequence(doc, map, { animation: o.name, fps: args.fps, loop: args.loop }, args.model) }));
  const written = results.map(o => {
    const sequence = writePoseSequence(o.value.sequence);
    const record = `${JSON.stringify({ spec: 'rig-pose-extract/1', sourceSHA256: digest(sourceBytes), modelSpec: doc.spec, spineSHA256: doc.spine.sha256, coreVersion: corePackage.version, animation: o.name, mapSHA256: digest(mapBytes), map, ...o.value.sampling, envelope: o.value.envelope, boundary: o.value.boundary, depth: o.value.depth, sequenceSHA256: digest(sequence) }, null, 2)}\n`;
    return { ...o, sequence, recordText: record };
  });
  makeOutDirs(dirs, say);
  for (const o of written) {
    writeFileSync(o.path, o.sequence); writeFileSync(o.record, o.recordText);
    say(`rig-pose extract: animation ${JSON.stringify(o.name)}, ${o.value.sequence.frames.length} frames at ${args.fps} fps; wrote ${o.path} and ${o.record}`);
  }
}
