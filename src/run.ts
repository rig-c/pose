/**
 * `rig-pose retarget`, end to end: read, gate the rig as it is, retarget (the
 * switches and the range clamp included), gate it with the animation in,
 * measure where the rig landed, read the folds (and which no switch covers),
 * and write — only when every check passed.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readMap, resolveMap, type JointMap, type Rest } from './map.ts';
import { cleanLine, inferredSource } from './clean.ts';
import { convertCoco17, personTrack, readPoseSequence, TRAVEL_IN_PLACE, type CameraFrame } from './pose.ts';
import { isObject, lineOf, parseJson, Problems, Refusal, type Problem } from './problems.ts';
import { boneIdentity, droppedLine, keptOutLine, mergeProblems, readFragment, readIdle, targetOf, trackLabel, type IdleReading, type RigcTrack, type Target } from './idle.ts';
import { bendLine, endOnLine, flipLine, holdLine, rangeLine, retarget, shortLine, turnLine, type MotionTrack, type RetargetOptions } from './retarget.ts';
import { attachmentBones, baseMotionOf, buildInto, rigcVersion, folds, gate, readBuild, resolveRig, restOf, slotsOf } from './rigc.ts';
import { artRangeLine, chainsMoving, raisedLine, RAISED_WITHIN, reachLine, switchLine, uncoveredFolds } from './switch.ts';
import { landed, measureFeet, measureLanding, measurePosture, measureShear, poseFrames, postureLines } from './verify.ts';
import { legsOf, PLANT_SWITCH, STANCE_BOUNDS } from './legs.ts';
import { M2_IDENTITY, mulM2, reduceKeys, reduceScale, reduceUnderScale, SCALE_REDUCE, setupLocal, type M2, type ReduceBone, type Reduced, type ReduceRow, type UnderBone } from './reduce.ts';
import type { BlendHold, Closure, Floor, LegScale, Lowered, Side, Stance } from './legs.ts';

export interface RetargetArgs extends RetargetOptions {
  rig: string;
  map: string;
  pose: string;
  out: string;
  name: string;
  coco: boolean;
  /** `--smooth`'s value when given: an alias since #67 — the cleaning carries the smoothing; it prints so and changes nothing. */
  smoothAlias?: string;
  person?: string;
  baseMotion?: string;
  /** Passed to rigc build as --images: the directory the rig spec's images resolve in, when rig.json's own `images` does not point there (a copied rig). */
  images?: string;
  profile: 'spine' | 'spine-html';
  /** Keep the gated build here. */
  build?: string;
  /** Keep rigc's render of the animation (frames, contact sheet, folds.json) here. */
  render?: string;
  /** Write the run's measurements as JSON here. */
  report?: string;
  /** The rig's animation read as its idle (default: idle); naming one the motion spec lacks is refused. */
  idle?: string;
  /** Loop the idle's dropped tracks into the new animation (#43 item 2). */
  carryIdle?: boolean;
  /** A rig-pose-tracks/1 fragment merged into the new animation. */
  merge?: string;
  /** Thin the mapped bones' rotate keys within this many degrees (#32). */
  reduce?: number;
  /** With reduce: thin the hip's translate keys within this many rig units. */
  reduceHip?: number;
}

export interface RunResult {
  lines: string[];
  written: boolean;
}

export function runRetarget(a: RetargetArgs, log: (line: string) => void): RunResult {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    log(l);
  };
  const refuse = (problems: readonly Problem[]): never => {
    throw new Refusal(problems);
  };
  const args = new Problems();
  for (const [flag, path] of [['--map', a.map], ['--pose', a.pose], ['--merge', a.merge]] as const) {
    if (path !== undefined && !existsSync(path)) args.add('ARG_PATH', `${flag} ${path} does not exist`);
  }
  // A file this run writes goes into a directory that is there already; --build and --render make theirs.
  for (const [flag, path] of [['--out', a.out], ['--report', a.report]] as const) {
    if (path === undefined) continue;
    const dir = dirname(path);
    if (!existsSync(dir)) args.add('ARG_PATH', `${flag} ${path} — directory ${dir} does not exist`);
    else if (!statSync(dir).isDirectory()) args.add('ARG_PATH', `${flag} ${path} — ${dir} is not a directory`);
  }
  args.throwIfAny();
  const input = resolveRig(a.rig, a.baseMotion);
  const base = baseMotionOf(input);
  const animations = base.animations as Record<string, unknown>;
  if (a.name in animations) refuse([{ code: 'MOTION_NAME_FREE', text: `the rig's motion spec already has an animation "${a.name}" (it has ${Object.keys(animations).join(', ')}); name this one with --name` }]);
  const idleName = a.idle ?? 'idle';
  if (!(idleName in animations) && (a.idle !== undefined || a.carryIdle === true)) {
    refuse([{ code: 'IDLE_NAME', text: `${a.idle !== undefined ? `--idle "${idleName}"` : '--carry-idle reads the animation "idle", and'} the rig's motion spec ${input.motion === null ? '— there is none, so it has no animations' : `${input.motion} has no animation "${idleName}" (it has ${Object.keys(animations).join(', ') || 'none'})`}; name the rig's idle with --idle` }]);
  }
  const fragment = a.merge === undefined ? [] : readFragment(parseJson(readFileSync(a.merge, 'utf8'), a.merge, 'MERGE_JSON'), a.merge);
  const map = readMap(readFileSync(a.map, 'utf8'), a.map);
  const poseText = readFileSync(a.pose, 'utf8');
  const seq = a.coco ? convertCoco17(poseText, a.pose) : readPoseSequence(poseText, a.pose);
  if (seq.cleaned === undefined) refuse([{ code: 'POSE_NOT_CLEANED', text: notCleaned(a.pose, a.coco) }]);
  const frames = personTrack(seq, a.person, a.pose);
  const times = seq.frames.map((f) => f.t);

  const scratch = mkdtempSync(join(tmpdir(), 'rig-pose-'));
  try {
    // The rig as it stands, through the gate, so the rest pose is rig-c's reading of a green build.
    const g0 = gate(input.rig, base, join(scratch, 'base'), a.profile, a.images);
    if (!g0.green) {
      refuse([{ code: 'RIG_GATE_BASE', text: `${input.rig} with ${input.motion ?? 'no motion spec'} is red under rigc build --profile ${a.profile} before any animation is added (exit ${g0.run.status})` }, ...g0.fails.map((f) => ({ code: 'RIGC', text: f }))]);
    }
    const doc0 = readBuild(g0.build);
    const rigc = rigcVersion();
    const rest = restOf(doc0);
    const slots = slotsOf(doc0);
    resolveMap(map, rest, a.map, slots);

    const r = retarget(rest, map, frames, times, { ...a, ...(seq.travel !== undefined ? { travel: seq.travel } : {}) }, slots);
    say(`rig-pose retarget: ${seq.frames.length} frame(s), ${r.animation.duration.toFixed(3)}s, onto "${input.name}" as "${a.name}" — ${r.animation.tracks.length} track(s); min-score ${a.minScore}, flip ${a.flip === 'off' ? 'off' : `${a.flip}°`}, short ${a.short}, bends ${a.bends} (tolerance ${a.bendTolerance}°)${a.legScale !== undefined && a.legScale !== 'off' ? `, leg-scale ${a.legScale[0]}–${a.legScale[1]}` : ''}${a.plantFeet === true ? ', plant-feet' : ''}${a.stance !== undefined && a.stance !== 'off' ? `, stance ${a.stance}` : ''}${a.raisedByHead === true ? ', raised-by-head' : ''}${a.carryIdle === true ? ', carry-idle' : ''}${a.merge !== undefined ? `, merge ${a.merge}` : ''}${a.reduce !== undefined ? `, reduce ${a.reduce}°${a.reduceHip !== undefined ? ` (hip ${a.reduceHip} units)` : ''}` : ''}`);
    say(`  RIGC   rig-c ${rigc.version} (${rigc.entry}) gates and poses this run`);
    say(`  CLEAN  ${cleanLine(seq.cleaned!)}`);
    if (a.smoothAlias !== undefined) say(`  SMOOTH --smooth is carried by clean; ignored (given ${a.smoothAlias}; this sequence was cleaned with legs ${seq.cleaned!.params.legs}, rest ${seq.cleaned!.params.rest})`);
    if (seq.camera !== undefined) say(`  CAMERA ${cameraLine(seq.camera, times, seq.cameraSource)}`);
    else if (a.plantFeet === true) say('  CAMERA none in the sequence: --plant-feet reads the picture as a fixed camera, so a zoom or a pan in the video moves the floor with it and the floor may step with the picture (tools/scan.py reads the camera, rig-c/pose#63)');
    if (r.scale !== null) say(`  SCALE  ${r.scale.factor.toFixed(5)} rig units per picture px (rig ${r.scale.rig.toFixed(2)} / pose median ${r.scale.pose.toFixed(2)})`);
    for (const h of r.holds) say(`  HOLD   ${holdLine(h, r.times)}`);
    if (a.short !== 'off') {
      for (const s of r.short) say(`  SHORT  ${shortLine(s, r.times, a.short)}`);
      for (const e of r.endOn) say(`  END-ON ${endOnLine(e, r.times, a.short)}`);
    }
    if (a.flip !== 'off') for (const fl of r.flips) say(`  FLIP   ${flipLine(fl, r.times, a.flip)}`);
    for (const e of r.bends) say(`  BEND   ${bendLine(e)} — clamped straight`);
    for (const e of r.turns) say(`  TURN   ${turnLine(e, r.times)}`);
    for (const u of r.turnsUnread) say(`  TURN   line "${u.line}" (${u.joints[0]} → ${u.joints[1]}) not measured: ${u.why}`);
    if (map.alternates.length > 0) {
      if (r.switches.length === 0) say(`  SWITCH none — no set within ${a.switchTolerance}° of the pose for ${a.switchMin}s`);
      for (const s of r.switches) say(`  SWITCH ${switchLine(s, r.times)}`);
      for (const l of windowLines(map, r.switches, r.distances, r.times, a.switchTolerance)) say(`  FRAMES ${l}`);
    }
    for (const e of r.range) say(`  RANGE  ${rangeLine(e, r.times)}`);
    if (a.raisedByHead === true && r.raised.length === 0) say(`  RAISED none — no set drawing an arm within ${RAISED_WITHIN}° of straight up showed; no key moved`);
    for (const e of r.raised) say(`  RAISED ${raisedLine(e, r.times)}`);
    for (const e of r.raised) if (e.short.length > 0) say(`  REACH  ${reachLine(e, r.times)}`);
    if (map.alternates.some((x) => x.place !== undefined && x.place !== null) && r.byHip.length === 0) say(`  BY-HIP none — no set with "place": "by-hip" showed; no key moved`);
    for (const e of r.byHip) say(`  BY-HIP ${raisedLine(e, r.times)}`);
    for (const e of r.byHip) if (e.short.length > 0) say(`  REACH  ${reachLine(e, r.times)}`);
    for (const e of r.artRange) say(`  ART-RANGE ${artRangeLine(e, r.times)}`);
    for (const l of r.legScale) say(`  LEG-SCALE ${legScaleLine(l, r.times)}`);
    if (r.pivot !== null) say(`  PIVOT  bone "${r.pivot.bone}"'s origin is ${r.pivot.distance.toFixed(2)} units (${r.pivot.hipWidths.toFixed(3)} hip widths) from its thigh roots' midpoint (${r.pivot.roots.join(' + ')}): dx ${r.pivot.offset[0].toFixed(2)}, dy ${r.pivot.offset[1].toFixed(2)}, at setup — the pivot every hip turn swings the legs about`);
    if (r.feet !== null) {
      const f = r.feet;
      const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
      say(`  FEET   ${r.planted ? 'planted' : 'read, not planted (no --plant-feet)'}: leg length (median hip → ankle) r ${f.legLength.r.toFixed(1)}px, l ${f.legLength.l.toFixed(1)}px; ${f.supports.length} support span(s), ${f.changes.filter((c) => c.from !== null).length} change(s) of support, ${f.jumps.length} jump(s), ${f.steps.length} step(s)`);
      say(`  FEET   supports: ${f.supports.map((x) => `${x.side} ${span(x.frames)}`).join(', ') || 'none'}`);
      say(`  FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): ${f.jumps.map(span).join(', ') || 'none'}`);
      if (f.lowered !== undefined) say(`  FEET   ${loweredLine(f.lowered)}`);
      if (r.closure !== null) say(`  FEET   ${travelLine(r.closure)}`);
      else say(`  FEET   steps (the supporting ankle > 0.03 leg lengths a frame; re-planted after 2 frames < 0.01): ${f.steps.map((x) => `${x.side} ${span(x.frames)} → ${x.to !== null ? `${x.to} supports` : f.held?.includes(x.frames[0]) === true ? 'no foot (the other is higher, rig-c/pose#113): the hip keeps this plant' : 'the pose\'s travel'}, ${x.replant === null ? 'never re-planted' : `re-planted at ${x.replant}`}`).join('; ') || 'none'}`);
      if (r.floor !== null) {
        const legBones = legBonesOf(map);
        if (legBones !== null) say(`  FEET   ${floorLine(r.floor, setupLegs(rest, legBones))}`);
      }
      if (r.blendHold !== null) for (const l of blendLines(r.blendHold, r.times)) say(`  FEET   ${l}`);
    }
    if (r.stance !== null) for (const l of stanceLines(r.stance, r.times)) say(`  STANCE ${l}`);

    // --reduce (#32): the dense keys thinned top-down, before anything reads the tracks.
    const reduced = a.reduce === undefined ? null : reduceTracks(r, map, rest, a.reduce, a.reduceHip);
    if (reduced !== null) {
      for (const row of reduced.rows) {
        const [who, track, what, unit] = row.kind === 'angle' ? ['bone', 'rotate', 'aim', '°'] : row.kind === 'origin' ? ['hip', 'translate', 'origin', ' units'] : ['bone', 'scalex', 'scale', ' of its setup length'];
        say(`  REDUCE ${who} "${row.bone}" ${track}: ${row.before} → ${row.after} key(s); worst ${what} error ${row.worst.toPrecision(3)}${unit} at frame ${row.frame} (t=${r.times[row.frame]!.toFixed(3)}s)`);
      }
      const sum = (kind: ReduceRow['kind'], k: 'before' | 'after') => reduced.rows.filter((x) => x.kind === kind).reduce((t, x) => t + x[k], 0);
      const scales = reduced.rows.some((x) => x.kind === 'scale') ? `; scalex keys ${sum('scale', 'before')} → ${sum('scale', 'after')} within ${SCALE_REDUCE} of the setup length` : '';
      say(`  REDUCE rotate keys ${sum('angle', 'before')} → ${sum('angle', 'after')} (${(sum('angle', 'before') / sum('angle', 'after')).toFixed(2)}×) within ${a.reduce}°${scales}${a.reduceHip === undefined ? '; the hip stays dense (no --reduce-hip)' : ''}`);
    }

    // The idle against the new animation (#43 item 2): what it drops, and with --carry-idle, looped back in.
    const groups = (isObject(base.groups) ? base.groups : {}) as Record<string, string[]>;
    const easings = (isObject(base.easings) ? base.easings : {}) as Record<string, number[]>;
    const own = r.animation.tracks as unknown as RigcTrack[];
    const T = r.animation.duration;
    let idle: IdleReading | null = null;
    if (!(idleName in animations)) say(`  IDLE   ${input.motion === null ? 'the rig has no motion spec' : `the rig's motion spec has no animation "idle" (it has ${Object.keys(animations).join(', ') || 'none'})`}; no idle read (--idle names another)`);
    else {
      const setupOf = (t: Target, property: string, sample: unknown): unknown => {
        if (t.kind === 'slot' && property === 'attachment') return slots.get(t.name)?.setup;
        if ((t.kind === 'bone' || t.kind === 'group') && Array.isArray(sample)) return boneIdentity(property, sample.length);
        return undefined;
      };
      const mapped = [...map.chains.flatMap((c) => c.bones), ...(map.translate === null ? [] : [map.translate.bone])];
      const below = new Map<string, string[]>();
      for (const m of new Set(mapped)) {
        for (let b = rest.get(m)?.parent ?? null; b !== null; b = rest.get(b)?.parent ?? null) {
          const list = below.get(b) ?? [];
          if (!list.includes(m)) list.push(m);
          below.set(b, list);
        }
      }
      idle = readIdle(idleName, a.name, animations[idleName] as Record<string, unknown>, own, T, { groups, easings }, setupOf, a.carryIdle === true, (bone) => below.get(bone) ?? [], (bone) => {
        const hip = map.translate?.bone;
        if (hip === undefined) return null;
        for (let b = rest.get(hip)?.parent ?? null; b !== null; b = rest.get(b)?.parent ?? null) if (b === bone) return hip;
        return null;
      });
      say(`  IDLE   animation "${idleName}" (${idle.duration.toFixed(3)}s, ${idle.tracks} track(s)) against "${a.name}": ${idle.dropped.length} dropped (${a.carryIdle === true ? `${idle.carriedTracks.length} carried, looped to ${T.toFixed(3)}s` : 'not carried; --carry-idle loops them in'}), ${idle.keptOut.length} kept out`);
      for (const d of idle.dropped) say(`  IDLE-DROPPED ${droppedLine(d, a.name, a.carryIdle === true, T)}`);
      for (const k of idle.keptOut) say(`  IDLE-KEPT-OUT ${keptOutLine(k)}`);
      for (const n of idle.notTracks) say(`  IDLE-KEPT-OUT "${idleName}"'s ${n} timeline(s): not a track; neither compared nor carried`);
    }
    const carried = idle?.carriedTracks ?? [];
    if (fragment.length > 0) {
      const problems = mergeProblems(fragment, a.merge!, a.name, [...own, ...carried], T, groups);
      if (problems.length > 0) refuse(problems);
      for (const tr of fragment) say(`  MERGE  ${a.merge}: ${trackLabel(tr, groups)}, ${tr.keys.length} key(s) at t=${tr.keys[0]!.t}${tr.keys.length > 1 ? `–${tr.keys[tr.keys.length - 1]!.t}` : ''}s`);
    }
    const added = [...carried, ...fragment];
    const animation = added.length === 0 ? r.animation : { ...r.animation, tracks: [...own, ...added] };
    const motion = { ...base, animations: { ...animations, [a.name]: animation } };
    const g1 = gate(input.rig, motion, join(scratch, 'with'), a.profile, a.images);
    if (!g1.green) {
      refuse([{ code: 'RIG_GATE', text: `rigc build --profile ${a.profile} is red with "${a.name}" in (exit ${g1.run.status}); nothing written` }, ...g1.fails.map((f) => ({ code: 'RIGC', text: f }))]);
    }
    say(`  GATE   rigc build --profile ${a.profile}: green${g1.summary === null ? '' : ` — ${g1.summary}`}`);

    const doc = readBuild(g1.build);
    const posed = poseFrames(doc, a.name, r.times);
    // A reduced track is held to the dense target plus its tolerance (#32); an ankle, to what the
    // reduced bones above it may move it by (#94, `footReduce`). A scale keeps its own: it is reduced within half of it.
    const landings = measureLanding(doc, a.name, map, r, posed).map((l) => (a.reduce === undefined ? l
      : l.kind === 'angle' ? { ...l, tolerance: l.tolerance + a.reduce }
      : l.kind === 'origin' && a.reduceHip !== undefined ? { ...l, tolerance: l.tolerance + a.reduceHip }
      : l.kind === 'foot' ? { ...l, tolerance: l.tolerance + footReduce(rest, r, l.bone.replace(/:tip$/, ''), a.reduce, a.reduceHip) }
      : l));
    const p = new Problems();
    // A carried idle track on a bone above a mapped one moves it where the keys did not ask (the key formula holds unmapped bones at setup).
    const carriedAbove = (bone: string): string => {
      const above = new Set<string>();
      for (let b = rest.get(bone)?.parent ?? null; b !== null; b = rest.get(b)?.parent ?? null) above.add(b);
      const hits = carried.filter((tr) => {
        const t = targetOf(tr);
        return t !== null && (t.kind === 'bone' ? above.has(t.name) : t.kind === 'group' && (groups[t.name] ?? []).some((m) => above.has(m)));
      });
      return hits.length === 0 ? '' : `; --carry-idle carried ${hits.map((tr) => trackLabel(tr, groups)).join(', ')} onto bones above it`;
    };
    for (const l of landings) {
      const unit = l.kind === 'angle' ? '°' : l.kind === 'scale' ? ' of its setup length' : ' units';
      const what = l.kind === 'angle' ? 'aim' : l.kind === 'scale' ? 'scale' : l.kind === 'foot' ? 'ankle' : 'origin';
      const tol = l.kind === 'foot' ? Number(l.tolerance.toPrecision(3)) : l.tolerance;
      const line = `bone "${l.bone}" ${what} — worst |reached − asked| ${l.worst.toPrecision(3)}${unit} at frame ${l.frame} (t=${r.times[l.frame]!.toFixed(3)}s); the tolerance is ${tol}${unit}`;
      if (landed(l)) say(`  LAND   ${line}`);
      else p.add('POSE_LANDS', `${line} — the rig does not turn the way the key formula assumes (a constraint, a scaled or sheared parent, a non-normal inherit mode)${carriedAbove(l.bone)}`);
    }
    p.throwIfAny();

    const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
    const hips = seq.cleaned?.params.hipsInferred;
    const posture = measurePosture(posed, lengths, map, r, frames, a.minScore, inferredSource(seq.cleaned), hips?.by === 'measured' ? hips : null);
    if (posture !== null) for (const l of postureLines(posture)) say(`  POSTURE ${l}`);
    const legBones = legBonesOf(map);
    const feetReading = legBones === null ? null : measureFeet(posed, lengths, r, legBones);
    if (feetReading !== null) {
      const f = feetReading;
      say(`  FEET   the posed build, outside jumps: the lowest ankle's vertical range ${f.lowest.range.toFixed(2)} units = ${f.lowest.legs.toFixed(4)} leg lengths (rig leg r ${f.legLength.r.toFixed(1)}, l ${f.legLength.l.toFixed(1)} units) over ${f.lowest.frames} frames`);
      const worst = (k: 'verticalLegs' | 'horizontalLegs') => f.plants.reduce<(typeof f.plants)[number] | null>((m, x) => (m === null || x[k] > m[k] ? x : m), null);
      const wv = worst('verticalLegs');
      const wh = worst('horizontalLegs');
      if (wv !== null && wh !== null) say(`  FEET   the supporting ankle over each support span: worst vertical range ${wv.vertical.toFixed(2)} units = ${wv.verticalLegs.toFixed(4)} leg lengths (${wv.side} ${wv.frames[0]}–${wv.frames[1]}), worst horizontal drift ${wh.horizontal.toFixed(2)} units = ${wh.horizontalLegs.toFixed(4)} leg lengths (${wh.side} ${wh.frames[0]}–${wh.frames[1]})`);
    }
    const shear = r.scales.size === 0 ? [] : measureShear(doc, posed, r.scales.keys());
    for (const x of shear) say(`  SHEAR  bone "${x.bone}": art sheared up to ${x.shear.toFixed(2)}° (frame ${x.frame}); world x axis ${x.x[0].toFixed(3)} … ${x.x[1].toFixed(3)}, y axis ${x.y[0].toFixed(3)} … ${x.y[1].toFixed(3)} of setup — a scaled bone, or one under it; a reading`);

    const dts = r.times.slice(1).map((t, i) => t - r.times[i]!).sort((x, y) => x - y);
    const fps = dts.length === 0 ? 12 : Math.max(1, Math.min(60, Math.round(1 / dts[dts.length >> 1]!)));
    // A rig that draws nothing (bones only) has nothing to fold, and rigc's render refuses it.
    const f = doc.slots.length === 0 ? { run: { args: [], status: 0, out: '' }, meshes: [], frames: '' } : folds(g1.build, a.name, join(scratch, 'folds'), fps);
    if (doc.slots.length === 0) say('  FOLD   the rig has no slots, so it draws nothing to fold; not measured');
    else if (f.meshes === null) say(`  FOLD   rigc render --folds did not read (exit ${f.run.status}); folds not measured`);
    else if (f.meshes.length === 0) say(`  FOLD   rigc render --folds at ${fps} fps: no mesh folds`);
    else for (const m of f.meshes) say(`  FOLD   mesh "${m.attachment}" (slot "${m.slot}") folds on ${m.times.length} frame(s) at ${fps} fps: t=${spans(m.times, 1 / fps)}`);
    const uncovered = f.meshes === null ? null : uncoveredFolds(f.meshes, r.shown, r.times, slots, (slot, att) => chainsMoving(attachmentBones(doc, slot, att), rest, map));
    if (uncovered !== null && map.alternates.length > 0) {
      for (const u of uncovered) say(`  UNCOVERED mesh "${u.attachment}" (slot "${u.slot}"; chains ${u.chains.length === 0 ? 'none' : u.chains.join(', ')}) folds with no switch covering it on ${u.times.length} frame(s): t=${spans(u.times, 1 / fps)}`);
    }

    if (a.build !== undefined) {
      // Built again where it will live, not copied: rigc's page paths are relative to the build (#18).
      rmSync(a.build, { recursive: true, force: true });
      const kept = buildInto(input.rig, join(scratch, 'with', 'motion.json'), resolve(a.build), a.profile, undefined, a.images);
      if (!kept.green) refuse([{ code: 'RIG_GATE', text: `rigc build into --build ${a.build} is red where the same build was green in scratch (exit ${kept.run.status}); nothing written` }, ...kept.fails.map((x) => ({ code: 'RIGC', text: x }))]);
    }
    writeFileSync(a.out, `${JSON.stringify(motion, null, 2)}\n`);
    if (a.render !== undefined && f.meshes !== null && f.frames !== '') {
      rmSync(a.render, { recursive: true, force: true });
      cpSync(f.frames, a.render, { recursive: true });
    }
    if (a.report !== undefined) {
      writeFileSync(a.report, `${JSON.stringify({
        spec: 'rig-pose-report/1',
        rigc,
        rig: input.name,
        animation: a.name,
        frames: seq.frames.length,
        duration: r.animation.duration,
        cleaned: seq.cleaned,
        options: { minScore: a.minScore, flip: a.flip, short: a.short, bends: a.bends, bendTolerance: a.bendTolerance, switchTolerance: a.switchTolerance, switchMin: a.switchMin, switchAt: a.switchAt, profile: a.profile, legScale: a.legScale ?? 'off', plantFeet: a.plantFeet === true, stance: a.stance ?? 'off', floor: a.floor ?? null, raisedByHead: a.raisedByHead === true, idle: idleName, carryIdle: a.carryIdle === true, merge: a.merge ?? null, reduce: a.reduce ?? 'off', reduceHip: a.reduceHip ?? 'off' },
        scale: r.scale,
        holds: r.holds,
        short: r.short,
        endOn: r.endOn,
        bends: r.bends,
        flips: r.flips,
        gate: g1.summary,
        landings,
        posture,
        folds: f.meshes,
        switches: r.switches,
        uncovered,
        turns: r.turns,
        range: r.range,
        artRange: r.artRange,
        raised: r.raised,
        // Only when a set declares `place` (#93): a map without one writes the report it always has.
        ...(map.alternates.some((x) => x.place !== undefined && x.place !== null) ? { byHip: r.byHip } : {}),
        legScale: r.legScale.map(({ scale: _scale, ...rest }) => rest),
        pivot: r.pivot,
        stance: r.stance === null ? null : { tolerance: r.stance.tolerance, release: r.stance.release, minSeconds: r.stance.minSeconds, bounds: r.stance.bounds, ...(r.stance.range === undefined ? {} : { range: r.stance.range }), runs: r.stance.runs, over: r.stance.over },
        feet: r.feet === null ? null : { planted: r.planted, legLength: r.feet.legLength, supports: r.feet.supports, jumps: r.feet.jumps, steps: r.feet.steps, changes: r.feet.changes, ...(r.feet.lowered === undefined ? {} : { lowered: r.feet.lowered }), floor: r.floor?.y ?? null, shifts: r.floor?.shifts ?? [], blend: r.blendHold === null ? null : { bounds: r.blendHold.bounds, ...(r.blendHold.range === undefined ? {} : { range: r.blendHold.range }), runs: r.blendHold.runs, over: r.blendHold.over }, reading: feetReading, closure: r.closure },
        shear,
        idleDropped: idle === null ? null : idle.dropped,
        idleKeptOut: idle === null ? null : idle.keptOut,
        merged: fragment.map((tr) => ({ track: trackLabel(tr, groups), keys: tr.keys.length })),
        reduce: reduced === null ? null : { tolerance: a.reduce, hipTolerance: a.reduceHip ?? null, rows: reduced.rows },
      }, null, 2)}\n`);
    }
    say(`  wrote ${a.out} — animations: ${Object.keys(motion.animations).join(', ')}`);
    return { lines, written: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The retarget's rotate tracks (and with a hip tolerance, its translate) thinned
 * in place (#32), on the final keys: the plant, the one floor, the stretches and
 * the in-place closure all live inside `retarget`, so they are done (#94). Kept
 * regardless, per bone: the frames either side of each switch boundary on the
 * chains it changes, and the edges of every FLIP spread, SHORT span and RANGE
 * run on it (the first and last frame the reducer keeps).
 *
 * With scaled bones (`--leg-scale`, the stretches; #94): a scaled bone's
 * `scalex` is thinned within `SCALE_REDUCE`, and a mapped bone under a scaled
 * bone — keyed through its parent's posed matrix (legs.ts) — is re-solved
 * through its parent as reduced and thinned with its error read as the world
 * aim and length it lands on (`reduceUnderScale`). With none, this is #32's
 * reduction, unchanged.
 */
function reduceTracks(r: ReturnType<typeof retarget>, map: JointMap, rest: Rest, tolerance: number, hipTolerance: number | undefined): Reduced {
  const n = r.times.length;
  const keep = new Map<string, Set<number>>();
  const add = (bone: string, ...frames: number[]) => {
    const s = keep.get(bone) ?? new Set<number>();
    for (const f of frames) if (f >= 0 && f < n) s.add(f);
    keep.set(bone, s);
  };
  for (const sw of r.switches) {
    for (const c of map.chains.filter((x) => sw.chains.includes(x.name))) for (const b of c.bones) add(b, sw.frames[0] - 1, sw.frames[0], sw.frames[1], sw.frames[1] + 1);
  }
  for (const x of [...r.flips, ...r.short, ...r.range]) add(x.bone, x.frames[0], x.frames[1]);
  const mapped = new Set(r.targets.keys());
  const above = (b: string): string | null => {
    for (let p = rest.get(b)!.parent; p !== null; p = rest.get(p)!.parent) if (mapped.has(p)) return p;
    return null;
  };
  const rotate = new Map<string, MotionTrack>();
  const scalex = new Map<string, MotionTrack>();
  for (const tr of r.animation.tracks) {
    if (!('bone' in tr)) continue;
    if (tr.property === 'rotate') rotate.set(tr.bone, tr);
    else if (tr.property === 'scalex') scalex.set(tr.bone, tr);
  }
  /** A bone with a scaled bone above it: keyed through its parent's posed matrix (legs.ts), not by the key formula. */
  const under = (b: string): boolean => {
    for (let p = rest.get(b)!.parent; p !== null; p = rest.get(p)!.parent) if (scalex.has(p)) return true;
    return false;
  };
  const dense = new Map([...rotate].map(([b, tr]) => [b, tr.keys.map((k) => k.v[0]!)]));
  const bones: ReduceBone[] = [...rotate.values()].filter((tr) => !under(tr.bone)).map((tr) => ({ bone: tr.bone, above: above(tr.bone), dense: dense.get(tr.bone)!, keep: keep.get(tr.bone) ?? new Set<number>() }));
  const hipTrack = r.origin === null || hipTolerance === undefined ? undefined : r.animation.tracks.find((tr): tr is MotionTrack => 'bone' in tr && tr.property === 'translate' && tr.bone === r.origin!.bone && tr.keys.every((k) => k.ease === undefined));
  const parent = hipTrack === undefined ? null : rest.get(hipTrack.bone)!.parent;
  const pm = parent === null ? null : rest.get(parent)!;
  const out = reduceKeys(r.times, bones, tolerance, hipTrack === undefined ? null : {
    bone: hipTrack.bone,
    dense: hipTrack.keys.map((k) => [k.v[0]!, k.v[1]!]),
    keep: new Set<number>(),
    parent: pm === null ? null : [pm.a, pm.b, pm.c, pm.d],
    tolerance: hipTolerance!,
  });
  for (const [bone, keys] of out.rotate) rotate.get(bone)!.keys = keys;
  if (hipTrack !== undefined && out.hip !== null) hipTrack.keys = out.hip;
  if (scalex.size === 0) return out;

  // #94: the scales of the bones the key formula holds for, then the bones under a scaled bone, parents first.
  const rows = new Map<string, ReduceRow>();
  for (const row of out.rows) if (row.kind === 'angle') rows.set(`rotate ${row.bone}`, row);
  const scaleAt = new Map<string, number[]>();
  const keepOf = (b: string) => keep.get(b) ?? new Set<number>();
  for (const [bone, tr] of scalex) {
    if (under(bone)) continue;
    const red = reduceScale(r.times, bone, r.scales.get(bone) ?? tr.keys.map((k) => k.v[0]!), keepOf(bone), SCALE_REDUCE);
    tr.keys = red.keys;
    scaleAt.set(bone, red.at);
    rows.set(`scalex ${bone}`, red.row);
  }
  /** A bone the key formula holds for: its world turn from setup on every frame as reduced — its dense turn (the keys summed down the mapped chain) plus its world error; an unmapped bone turns with the nearest mapped bone above it. */
  const turnOf = (b: string): number[] => {
    const m = mapped.has(b) ? b : above(b);
    if (m === null) return new Array<number>(n).fill(0);
    const denseTurn = (x: string): number[] => {
      const up = above(x);
      const own = dense.get(x)!;
      if (up === null) return [...own];
      const t = denseTurn(up);
      return own.map((v, i) => v + t[i]!);
    };
    const e = out.errors.get(m)!;
    return denseTurn(m).map((v, i) => v + e[i]!);
  };
  const world0 = (b: string): M2 => {
    const x = rest.get(b)!;
    return [x.a, x.b, x.c, x.d];
  };
  const depth = (b: string): number => {
    let d = 0;
    for (let p = rest.get(b)!.parent; p !== null; p = rest.get(p)!.parent) d++;
    return d;
  };
  const underBones = [...rotate.keys()].filter(under).sort((x, y) => depth(x) - depth(y));
  const given: UnderBone[] = underBones.map((b) => {
    if (!scalex.has(b)) throw new Refusal([{ code: 'POSE_REDUCE', text: `bone "${b}" hangs under a scaled bone and has no scalex track, so it was not keyed through its parent's posed matrix; --reduce re-solves only a bone the legs keyed that way` }]);
    // Up through the unmapped bones between (their setup locals), to a bone given before it or one the key formula holds for.
    let via: M2 = M2_IDENTITY;
    let p = rest.get(b)!.parent!;
    while (under(p) && !mapped.has(p)) {
      via = mulM2(setupLocal(world0(rest.get(p)!.parent!), world0(p)), via);
      p = rest.get(p)!.parent!;
    }
    const parent: UnderBone['parent'] = under(p) ? { under: p, via } : { rigid: { turn: turnOf(p), world0: world0(p), scale: scaleAt.get(p) ?? new Array<number>(n).fill(1) }, via };
    const w0 = world0(b);
    return {
      bone: b,
      parent,
      local: setupLocal(world0(rest.get(b)!.parent!), w0),
      len0: Math.hypot(w0[0], w0[2]),
      target: r.targets.get(b)!,
      asked: r.scales.get(b) ?? new Array<number>(n).fill(1),
      dense: dense.get(b)!,
      keep: keepOf(b),
    };
  });
  const red = reduceUnderScale(r.times, given, tolerance, SCALE_REDUCE);
  for (const [bone, keys] of red.rotate) rotate.get(bone)!.keys = keys;
  for (const [bone, keys] of red.scale) scalex.get(bone)!.keys = keys;
  for (const row of red.rows) rows.set(`${row.kind === 'angle' ? 'rotate' : 'scalex'} ${row.bone}`, row);
  // The rows: every rotate track in the animation's order, the hip, then every scalex track.
  const hipRow = out.rows.filter((x) => x.kind === 'origin');
  return {
    ...out,
    rows: [...[...rotate.keys()].map((b) => rows.get(`rotate ${b}`)!), ...hipRow, ...[...scalex.keys()].map((b) => rows.get(`scalex ${b}`)!)],
  };
}

/**
 * How far `--reduce` may move an ankle (the tip of `ankle`), world units (#94):
 * the hip's tolerance when its translate is reduced, plus every segment from
 * the legs' top down to the ankle — each bone's setup offset from its parent,
 * and the ankle bone's length — times the largest scale asked of any bone, each
 * turned by at most the angle tolerance (a vector of length ℓ turned by θ moves
 * its end ≤ ℓ·θ) and lengthened by at most `SCALE_REDUCE`. Every reduced bone's
 * world aim is within the angle tolerance of its dense one, top-down, so the
 * segments' errors are each bounded and the sum bounds the ankle's.
 */
export function footReduce(rest: Rest, r: ReturnType<typeof retarget>, ankle: string, tolerance: number, hipTolerance: number | undefined): number {
  const top = r.origin?.bone ?? null;
  let sMax = 1;
  for (const s of r.scales.values()) for (const v of s) sMax = Math.max(sMax, v);
  const a = rest.get(ankle)!;
  let lever = a.length * Math.hypot(a.a, a.c);
  for (let b: string | null = ankle; b !== null && b !== top; b = rest.get(b)!.parent) {
    const x = rest.get(b)!;
    const p = x.parent === null ? null : rest.get(x.parent)!;
    if (p === null) break;
    lever += Math.hypot(x.worldX - p.worldX, x.worldY - p.worldY);
  }
  return (hipTolerance ?? 0) + lever * sMax * ((tolerance * Math.PI) / 180 + SCALE_REDUCE);
}

function spans(ts: number[], step: number): string {
  const out: string[] = [];
  let s = ts[0]!;
  let e = s;
  for (const t of ts.slice(1)) {
    if (t - e <= step * 1.5) e = t;
    else {
      out.push(s === e ? s.toFixed(3) : `${s.toFixed(3)}–${e.toFixed(3)}`);
      s = e = t;
    }
  }
  out.push(s === e ? s.toFixed(3) : `${s.toFixed(3)}–${e.toFixed(3)}`);
  return out.join(', ');
}

export { lineOf };

/**
 * For each set with `frames` windows: every stretch of a window the set did not
 * show on, and why — the pose there was past the tolerance (with the largest
 * distance), or within it but the run was dropped (shorter than --switch-min, or
 * taken by another set's span). A window never forces a set; this says so.
 */
function windowLines(map: JointMap, switches: ReadonlyArray<{ set: string; frames: [number, number] }>, distances: ReadonlyMap<string, readonly number[]>, times: readonly number[], tolerance: number): string[] {
  const out: string[] = [];
  for (const set of map.alternates) {
    if (set.frames === null) continue;
    const shown = new Set<number>();
    for (const sw of switches) if (sw.set === set.name) for (let i = sw.frames[0]; i <= sw.frames[1]; i++) shown.add(i);
    const d = distances.get(set.name)!;
    for (const [first, last] of set.frames) {
      const lastIn = Math.min(last, times.length - 1);
      const parts: string[] = [];
      for (let i = first; i <= lastIn;) {
        if (shown.has(i)) { i++; continue; }
        let j = i;
        while (j + 1 <= lastIn && !shown.has(j + 1)) j++;
        const ds = d.slice(i, j + 1);
        const worst = Math.max(...ds);
        const over = ds.filter((x) => x > tolerance).length;
        const span = i === j ? `frame ${i}` : `frames ${i}–${j}`;
        parts.push(over === ds.length ? `${span} outside the tolerance (up to ${worst.toFixed(1)}° > ${tolerance}°)` : over === 0 ? `${span} within the tolerance but not shown (a run shorter than --switch-min, or another set's span)` : `${span} partly outside the tolerance (up to ${worst.toFixed(1)}°)`);
        i = j + 1;
      }
      const head = `set "${set.name}" window ${first}–${last}`;
      out.push(parts.length === 0 ? `${head}: shown on every frame` : `${head}: ${parts.join('; ')} — a window restricts a set, it never forces one`);
    }
  }
  return out;
}

/**
 * The CAMERA line (#63): where the camera came from (the sequence's
 * `cameraSource`, or "(source not stated)"), the scale's range over the sequence, and the three
 * frame-to-frame changes of s largest in size (ties to the earlier frame).
 */
export function cameraLine(camera: readonly CameraFrame[], times: readonly number[], source: string | undefined): string {
  const ss = camera.map((c) => c.s);
  const lo = ss.reduce((m, x, i) => (x < ss[m]! ? i : m), 0);
  const hi = ss.reduce((m, x, i) => (x > ss[m]! ? i : m), 0);
  const steps = ss.slice(1).map((x, k) => ({ to: k + 1, d: x - ss[k]! }));
  const fastest = [...steps].sort((x, y) => Math.abs(y.d) - Math.abs(x.d) || x.to - y.to).slice(0, 3);
  const sign = (d: number) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(4)}`;
  const inl = camera.reduce((m, c) => Math.min(m, c.inliers), Infinity);
  return `${source ?? '(source not stated)'}: the sequence carries the picture's camera against frame 0's; its joints are normalised by it (p′ = (p − t) / s): s ${ss[lo]!.toFixed(4)} (frame ${lo}) … ${ss[hi]!.toFixed(4)} (frame ${hi}) over ${camera.length} frames; s changes fastest at ${fastest.map((x) => `frame ${x.to - 1}→${x.to} (t=${times[x.to]!.toFixed(3)}s) ${sign(x.d)}`).join(', ') || 'no frame (one frame only)'}${source?.startsWith('hand') === true ? '' : `; fewest background inliers ${inl}`}`;
}

/** Each leg's first bone (its root, the thigh) and last bone (whose tip is the ankle), when the map has both. */
function legBonesOf(map: JointMap): { r: { root: string; ankle: string }; l: { root: string; ankle: string } } | null {
  const l = legsOf(map, 'reading the feet');
  if ('problems' in l) return null;
  return { r: { root: l.legs.r.chain.bones[0]!, ankle: l.legs.r.ankleBone }, l: { root: l.legs.l.chain.bones[0]!, ankle: l.legs.l.ankleBone } };
}

/** Each side's rig leg at setup, world units: its thigh's origin to its ankle (the leg's last bone's tip), by rig-c's setup pose. */
export function setupLegs(rest: Rest, legs: { r: { root: string; ankle: string }; l: { root: string; ankle: string } }): { r: number; l: number } {
  const of = (s: 'r' | 'l') => {
    const o = rest.get(legs[s].root)!;
    const b = rest.get(legs[s].ankle)!;
    return Math.hypot(b.worldX + b.a * b.length - o.worldX, b.worldY + b.c * b.length - o.worldY);
  };
  return { r: of('r'), l: of('l') };
}

/**
 * The FEET floor line (#85): the floor's world y and where it came from, each
 * support span's shift onto it in world units and in that side's rig leg at
 * setup, and the shifts' range in the two legs' mean.
 */
export function floorLine(floor: Floor, leg: { r: number; l: number }): string {
  const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
  const sign = (v: number, d: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}`;
  const ss = floor.shifts.map((x) => x.shift);
  const lo = Math.min(...ss);
  const hi = Math.max(...ss);
  const mean = (leg.r + leg.l) / 2;
  return `floor: world y ${floor.y.toFixed(2)} (${floor.given ? 'given by --floor' : `the median of the ${floor.shifts.length} support span(s)' planted heights`}); each span's supporting ankle moved onto it, the hip and everything above with it — shift per span in units (leg lengths: the rig's at setup, thigh origin → ankle, r ${leg.r.toFixed(1)}, l ${leg.l.toFixed(1)} units): ${floor.shifts.map((x) => `${x.side} ${span(x.frames)} ${sign(x.shift, 2)} (${sign(x.shift / leg[x.side], 4)})`).join(', ')}; range ${sign(lo, 2)} … ${sign(hi, 2)} units = ${((hi - lo) / mean).toFixed(4)} leg lengths`;
}

/**
 * The FEET blend lines (#85): one per run of blend frames whose supporting leg
 * was stretched to keep its ankle on the floor, with the stretch keyed; one per
 * run whose stretch fell past its bounds (`past the bounds`, as STANCE says it).
 */
/**
 * The lower-ankle line (rig-c/pose#113): under --plant-feet on a sequence not
 * declared in place, the frames whose supporting foot differs from the reading
 * before #113 — today's side, then the side read from the lower ankle ("none":
 * no foot supports, the hip follows the pose).
 */
const CAUSE: Record<NonNullable<Lowered['cause']>, string> = {
  released: 'released: the lower ankle could not take support, released by a step or moving',
  higher: 'the only foot free to take support was the higher one; the hip keeps the plant it held, if any',
};
function loweredLine(lowered: readonly Lowered[]): string {
  const side = (s: Side | null) => s ?? 'none';
  const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
  const head = `support read from the lower ankle (a foot ≥ ${PLANT_SWITCH} leg lengths higher than the other does not take support, rig-c/pose#113)`;
  if (lowered.length === 0) return `${head}: no frame reads differently from before`;
  const frames = lowered.reduce((k, x) => k + x.frames[1] - x.frames[0] + 1, 0);
  return `${head}: ${frames} frame(s) read differently from before — ${lowered.map((x) => `frames ${span(x.frames)} ${side(x.was)} → ${side(x.now)}${x.cause === undefined ? '' : ` (${CAUSE[x.cause]})`}`).join(', ')}`;
}

/** The in-place line (rig-c/pose#92): what --plant-feet did instead of holding the foot, and the loop's closure. */
export function travelLine(c: Closure): string {
  const per = c.frames > 1 ? Math.abs(c.drift) / (c.frames - 1) : 0;
  return `in place (the sequence's travel "${TRAVEL_IN_PLACE}"): each supporting foot follows its own ankle's picture x, scaled, instead of being held where it planted, and no step releases it; the hip's x travelled ${c.drift >= 0 ? '+' : ''}${c.drift.toFixed(2)} units from the first frame to the last, closed — spread back over the ${c.frames} frames (${per.toFixed(3)} units a frame), so the last frame's hip x is the first's`;
}

export function blendLines(h: BlendHold, times: readonly number[]): string[] {
  const span = (x: [number, number]) => (x[0] === x[1] ? `frame ${x[0]} (t=${times[x[0]]!.toFixed(3)}s)` : `frames ${x[0]}–${x[1]} (t=${times[x[0]]!.toFixed(3)}–${times[x[1]]!.toFixed(3)}s)`);
  const out: string[] = [];
  for (const r of h.runs) out.push(`blend held on the floor: supporting foot ${r.side} ${span(r.frames)} — the hip blends between two derivations there, so its leg is stretched by k ${r.k.min.toFixed(4)}–${r.k.max.toFixed(4)} within ${boundText([r.lower ?? h.bounds[0], h.bounds[1]])} to keep the ankle on the floor`);
  if (h.runs.length === 0) out.push('blend held on the floor: no blend frame left a supporting ankle off the floor');
  if (h.range !== undefined) out.push(legRangeLine('supporting', h.range, h.bounds));
  for (const o of h.over) out.push(`past the bounds: supporting foot ${o.side} ${span(o.frames)} — ${o.needed === null ? 'its ankle is not below its leg\'s root, so no stretch reaches the floor' : `the floor needed k ${o.needed.toFixed(4)}, past ${boundText(o.bound ?? h.bounds)}; held at the bound`}, the foot left up to ${o.left.toFixed(2)} units from the floor`);
  return out;
}

/**
 * The STANCE lines (#60): one per run of planted-both or lifted frames, with
 * the tolerance and the stretch keyed; one per run a stretch was capped.
 */
export function stanceLines(st: Stance, times: readonly number[]): string[] {
  const span = (x: [number, number]) => (x[0] === x[1] ? `frame ${x[0]} (t=${times[x[0]]!.toFixed(3)}s)` : `frames ${x[0]}–${x[1]} (t=${times[x[0]]!.toFixed(3)}–${times[x[1]]!.toFixed(3)}s)`);
  const tol = `the tolerance ${st.tolerance} leg lengths`;
  const release = `planted again under ${st.release} of it, ${(st.release * st.tolerance).toFixed(4)}`;
  const other = (r: Stance['runs'][number]) => (r.state === 'both' ? 'lifted' : 'planted-both');
  const out = st.runs.map((r) => (r.absorbed === true
    ? `absorbed: free foot ${r.side} ${span(r.frames)} — read ${r.state === 'both' ? 'planted both' : 'lifted'} (its ankle up to ${r.maxHeight.toFixed(4)} leg lengths above the supporting one in the picture; ${tol}, ${release}) for ${r.frames[1] - r.frames[0] + 1} frame(s), under ${st.minSeconds} s between two ${other(r)} runs; it takes their state`
    : r.state === 'both'
    ? `planted both: free foot ${r.side} ${span(r.frames)} — its ankle up to ${r.maxHeight.toFixed(4)} leg lengths above the supporting one in the picture, within ${tol}; its leg stretched by k ${r.k!.min === r.k!.max ? r.k!.max.toFixed(4) : `${r.k!.min.toFixed(4)} … ${r.k!.max.toFixed(4)}`} (largest ${r.k!.max.toFixed(4)})`
    : `lifted: free foot ${r.side} ${span(r.frames)} — its ankle up to ${r.maxHeight.toFixed(4)} leg lengths above the supporting one in the picture, over ${tol} (${release}); the pose's height kept`));
  if (st.range !== undefined) out.push(legRangeLine('free', st.range, st.bounds));
  for (const o of st.over) out.push(`past the bounds: free foot ${o.side} ${span(o.frames)} — ${o.needed === null ? 'its ankle is not below its leg\'s root, so no stretch reaches the floor' : `the floor needed k ${o.needed.toFixed(4)}, past ${boundText(o.bound ?? st.bounds)}; held at the bound`}, the foot left up to ${o.left.toFixed(2)} units from the floor`);
  return out;
}

/** A bound as the lines print it: the default's figures as written, a derived lower bound to 4 places (#95). */
function boundText(b: readonly [number, number]): string {
  return `[${b[0] === STANCE_BOUNDS[0] ? `${b[0]}` : b[0].toFixed(4)}, ${b[1]}]`;
}

/** The #95 line: where the picture folds a leg below the default lower bound, that fold is the frame's lower bound. */
function legRangeLine(which: 'free' | 'supporting', range: Partial<Record<'r' | 'l', number>>, bounds: readonly [number, number]): string {
  const sides = (['r', 'l'] as const).filter((s) => range[s] !== undefined).map((s) => `${s} ${range[s]!.toFixed(4)}`);
  return `bound from the leg's own range: on a frame where the picture folds the ${which} leg below ${bounds[0]} of its straight length (hip → ankle, its 95th percentile), the lower bound is that fold — lowest ${sides.join(', ')}; the upper stays ${bounds[1]}`;
}

/** A LEG-SCALE line: the segment, its straight length, its ratio's spread, and the frames clamped. */
function legScaleLine(l: LegScale, times: readonly number[]): string {
  const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
  const count = (rs: Array<[number, number]>) => rs.reduce((k, x) => k + x[1] - x[0] + 1, 0);
  const clamp = (rs: Array<[number, number]>, at: number, how: string) => (rs.length === 0 ? `none ${how} ${at}` : `${count(rs)} frame(s) ${how} ${at}, clamped (frames ${rs.map(span).join(', ')})`);
  return `chain "${l.chain}" bone "${l.bone}" (${l.joints[0]} → ${l.joints[1]}): straight length ${l.straight.toFixed(1)}px (95th percentile of ${times.length} frames); picture length ÷ straight ${l.ratio.min.toFixed(3)} … ${l.ratio.max.toFixed(3)} (median ${l.ratio.median.toFixed(3)}); scalex keyed in [${l.limits[0]}, ${l.limits[1]}]: ${clamp(l.low, l.limits[0], 'under')}; ${clamp(l.high, l.limits[1], 'over')}`;
}

/**
 * POSE_NOT_CLEANED (#67): retarget reads only a sequence `rig-pose clean` wrote.
 * The message is the command to run on this file; the output name is a
 * suggestion beside it (`<name>.clean.json`).
 */
export function notCleaned(pose: string, coco: boolean): string {
  const out = pose.endsWith('.json') ? `${pose.slice(0, -'.json'.length)}.clean.json` : `${pose}.clean.json`;
  const what = coco ? `${pose} is COCO-17 (--coco), which carries no "cleaned" record` : `${pose} has no "cleaned" record`;
  return `${what}; retarget reads a sequence rig-pose clean wrote (spikes, occlusion, smoothing; there is no flag to skip it). Run \`rig-pose clean ${coco ? '--coco ' : ''}--pose ${pose} --out ${out}\` (add --loop for one cycle of a gait) and retarget --pose ${out}`;
}
