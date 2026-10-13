/**
 * `rig-pose retarget`, end to end: read, gate the rig as it is, retarget (the
 * switches and the range clamp included), gate it with the animation in,
 * measure where the rig landed, read the folds (and which no switch covers),
 * and write — only when every check passed.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readMap, resolveMap, type JointMap } from './map.ts';
import { convertCoco17, personTrack, readPoseSequence } from './pose.ts';
import { isObject, lineOf, parseJson, Problems, Refusal, type Problem } from './problems.ts';
import { boneIdentity, droppedLine, keptOutLine, mergeProblems, readFragment, readIdle, targetOf, trackLabel, type IdleReading, type RigcTrack, type Target } from './idle.ts';
import { bendLine, endOnLine, flipLine, holdLine, rangeLine, retarget, shortLine, turnLine, type RetargetOptions } from './retarget.ts';
import { attachmentBones, baseMotionOf, buildInto, rigcVersion, folds, gate, readBuild, resolveRig, restOf, slotsOf } from './rigc.ts';
import { artRangeLine, chainsMoving, switchLine, uncoveredFolds } from './switch.ts';
import { landed, measureFeet, measureLanding, measurePosture, measureShear, poseFrames, postureLines } from './verify.ts';
import { legsOf } from './legs.ts';
import type { LegScale } from './legs.ts';

export interface RetargetArgs extends RetargetOptions {
  rig: string;
  map: string;
  pose: string;
  out: string;
  name: string;
  coco: boolean;
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

    const r = retarget(rest, map, frames, times, a, slots);
    say(`rig-pose retarget: ${seq.frames.length} frame(s), ${r.animation.duration.toFixed(3)}s, onto "${input.name}" as "${a.name}" — ${r.animation.tracks.length} track(s); min-score ${a.minScore}, smooth ${a.smooth}, flip ${a.flip === 'off' ? 'off' : `${a.flip}°`}, short ${a.short}, bends ${a.bends} (tolerance ${a.bendTolerance}°)${a.legScale !== undefined && a.legScale !== 'off' ? `, leg-scale ${a.legScale[0]}–${a.legScale[1]}` : ''}${a.plantFeet === true ? ', plant-feet' : ''}${a.carryIdle === true ? ', carry-idle' : ''}${a.merge !== undefined ? `, merge ${a.merge}` : ''}`);
    say(`  RIGC   rig-c ${rigc.version} (${rigc.entry}) gates and poses this run`);
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
    for (const e of r.artRange) say(`  ART-RANGE ${artRangeLine(e, r.times)}`);
    for (const l of r.legScale) say(`  LEG-SCALE ${legScaleLine(l, r.times)}`);
    if (r.pivot !== null) say(`  PIVOT  bone "${r.pivot.bone}"'s origin is ${r.pivot.distance.toFixed(2)} units (${r.pivot.hipWidths.toFixed(3)} hip widths) from its thigh roots' midpoint (${r.pivot.roots.join(' + ')}): dx ${r.pivot.offset[0].toFixed(2)}, dy ${r.pivot.offset[1].toFixed(2)}, at setup — the pivot every hip turn swings the legs about`);
    if (r.feet !== null) {
      const f = r.feet;
      const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
      say(`  FEET   ${r.planted ? 'planted' : 'read, not planted (no --plant-feet)'}: leg length (median hip → ankle) r ${f.legLength.r.toFixed(1)}px, l ${f.legLength.l.toFixed(1)}px; ${f.supports.length} support span(s), ${f.changes.filter((c) => c.from !== null).length} change(s) of support, ${f.jumps.length} jump(s), ${f.steps.length} step(s)`);
      say(`  FEET   supports: ${f.supports.map((x) => `${x.side} ${span(x.frames)}`).join(', ') || 'none'}`);
      say(`  FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): ${f.jumps.map(span).join(', ') || 'none'}`);
      say(`  FEET   steps (the supporting ankle > 0.03 leg lengths a frame; re-planted after 2 frames < 0.01): ${f.steps.map((x) => `${x.side} ${span(x.frames)} → ${x.to === null ? 'the pose\'s travel' : `${x.to} supports`}, ${x.replant === null ? 'never re-planted' : `re-planted at ${x.replant}`}`).join('; ') || 'none'}`);
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
    const landings = measureLanding(doc, a.name, map, r, posed);
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
    const posture = measurePosture(posed, lengths, map, r, frames, a.minScore);
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
        options: { minScore: a.minScore, smooth: a.smooth, flip: a.flip, short: a.short, bends: a.bends, bendTolerance: a.bendTolerance, switchTolerance: a.switchTolerance, switchMin: a.switchMin, switchAt: a.switchAt, profile: a.profile, legScale: a.legScale ?? 'off', plantFeet: a.plantFeet === true, idle: idleName, carryIdle: a.carryIdle === true, merge: a.merge ?? null },
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
        legScale: r.legScale.map(({ scale: _scale, ...rest }) => rest),
        pivot: r.pivot,
        feet: r.feet === null ? null : { planted: r.planted, legLength: r.feet.legLength, supports: r.feet.supports, jumps: r.feet.jumps, steps: r.feet.steps, changes: r.feet.changes, reading: feetReading },
        shear,
        idleDropped: idle === null ? null : idle.dropped,
        idleKeptOut: idle === null ? null : idle.keptOut,
        merged: fragment.map((tr) => ({ track: trackLabel(tr, groups), keys: tr.keys.length })),
      }, null, 2)}\n`);
    }
    say(`  wrote ${a.out} — animations: ${Object.keys(motion.animations).join(', ')}`);
    return { lines, written: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

/** Each leg's first bone (its root, the thigh) and last bone (whose tip is the ankle), when the map has both. */
function legBonesOf(map: JointMap): { r: { root: string; ankle: string }; l: { root: string; ankle: string } } | null {
  const l = legsOf(map, 'reading the feet');
  if ('problems' in l) return null;
  return { r: { root: l.legs.r.chain.bones[0]!, ankle: l.legs.r.ankleBone }, l: { root: l.legs.l.chain.bones[0]!, ankle: l.legs.l.ankleBone } };
}

/** A LEG-SCALE line: the segment, its straight length, its ratio's spread, and the frames clamped. */
function legScaleLine(l: LegScale, times: readonly number[]): string {
  const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
  const count = (rs: Array<[number, number]>) => rs.reduce((k, x) => k + x[1] - x[0] + 1, 0);
  const clamp = (rs: Array<[number, number]>, at: number, how: string) => (rs.length === 0 ? `none ${how} ${at}` : `${count(rs)} frame(s) ${how} ${at}, clamped (frames ${rs.map(span).join(', ')})`);
  return `chain "${l.chain}" bone "${l.bone}" (${l.joints[0]} → ${l.joints[1]}): straight length ${l.straight.toFixed(1)}px (95th percentile of ${times.length} frames); picture length ÷ straight ${l.ratio.min.toFixed(3)} … ${l.ratio.max.toFixed(3)} (median ${l.ratio.median.toFixed(3)}); scalex keyed in [${l.limits[0]}, ${l.limits[1]}]: ${clamp(l.low, l.limits[0], 'under')}; ${clamp(l.high, l.limits[1], 'over')}`;
}
