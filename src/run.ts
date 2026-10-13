/**
 * `rig-pose retarget`, end to end: read, gate the rig as it is, retarget (the
 * switches and the range clamp included), gate it with the animation in,
 * measure where the rig landed, read the folds (and which no switch covers),
 * and write — only when every check passed.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readMap, resolveMap } from './map.ts';
import { convertCoco17, personTrack, readPoseSequence } from './pose.ts';
import { lineOf, Problems, Refusal, type Problem } from './problems.ts';
import { bendLine, endOnLine, flipLine, holdLine, rangeLine, retarget, shortLine, turnLine, type RetargetOptions } from './retarget.ts';
import { attachmentBones, baseMotionOf, buildInto, folds, gate, readBuild, resolveRig, restOf, slotsOf } from './rigc.ts';
import { artRangeLine, chainsMoving, switchLine, uncoveredFolds } from './switch.ts';
import { landed, measureLanding, measurePosture, poseFrames, postureLines, ANGLE_TOLERANCE, ORIGIN_TOLERANCE } from './verify.ts';

export interface RetargetArgs extends RetargetOptions {
  rig: string;
  map: string;
  pose: string;
  out: string;
  name: string;
  coco: boolean;
  person?: string;
  baseMotion?: string;
  profile: 'spine' | 'spine-html';
  /** Keep the gated build here. */
  build?: string;
  /** Keep rigc's render of the animation (frames, contact sheet, folds.json) here. */
  render?: string;
  /** Write the run's measurements as JSON here. */
  report?: string;
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
  for (const [flag, path] of [['--map', a.map], ['--pose', a.pose]] as const) {
    if (!existsSync(path)) args.add('ARG_PATH', `${flag} ${path} does not exist`);
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
  const map = readMap(readFileSync(a.map, 'utf8'), a.map);
  const poseText = readFileSync(a.pose, 'utf8');
  const seq = a.coco ? convertCoco17(poseText, a.pose) : readPoseSequence(poseText, a.pose);
  const frames = personTrack(seq, a.person, a.pose);
  const times = seq.frames.map((f) => f.t);

  const scratch = mkdtempSync(join(tmpdir(), 'rig-pose-'));
  try {
    // The rig as it stands, through the gate, so the rest pose is rig-c's reading of a green build.
    const g0 = gate(input.rig, base, join(scratch, 'base'), a.profile);
    if (!g0.green) {
      refuse([{ code: 'RIG_GATE_BASE', text: `${input.rig} with ${input.motion ?? 'no motion spec'} is red under rigc build --profile ${a.profile} before any animation is added (exit ${g0.run.status})` }, ...g0.fails.map((f) => ({ code: 'RIGC', text: f }))]);
    }
    const doc0 = readBuild(g0.build);
    const rest = restOf(doc0);
    const slots = slotsOf(doc0);
    resolveMap(map, rest, a.map, slots);

    const r = retarget(rest, map, frames, times, a, slots);
    say(`rig-pose retarget: ${seq.frames.length} frame(s), ${r.animation.duration.toFixed(3)}s, onto "${input.name}" as "${a.name}" — ${r.animation.tracks.length} track(s); min-score ${a.minScore}, smooth ${a.smooth}, flip ${a.flip === 'off' ? 'off' : `${a.flip}°`}, short ${a.short}, bends ${a.bends} (tolerance ${a.bendTolerance}°)`);
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
    }
    for (const e of r.range) say(`  RANGE  ${rangeLine(e, r.times)}`);
    for (const e of r.artRange) say(`  ART-RANGE ${artRangeLine(e, r.times)}`);

    const motion = { ...base, animations: { ...animations, [a.name]: r.animation } };
    const g1 = gate(input.rig, motion, join(scratch, 'with'), a.profile);
    if (!g1.green) {
      refuse([{ code: 'RIG_GATE', text: `rigc build --profile ${a.profile} is red with "${a.name}" in (exit ${g1.run.status}); nothing written` }, ...g1.fails.map((f) => ({ code: 'RIGC', text: f }))]);
    }
    say(`  GATE   rigc build --profile ${a.profile}: green${g1.summary === null ? '' : ` — ${g1.summary}`}`);

    const doc = readBuild(g1.build);
    const posed = poseFrames(doc, a.name, r.times);
    const landings = measureLanding(doc, a.name, map, r, posed);
    const p = new Problems();
    for (const l of landings) {
      const unit = l.kind === 'angle' ? '°' : ' units';
      const tol = l.kind === 'angle' ? ANGLE_TOLERANCE : ORIGIN_TOLERANCE;
      const line = `bone "${l.bone}" ${l.kind === 'angle' ? 'aim' : 'origin'} — worst |reached − asked| ${l.worst.toPrecision(3)}${unit} at frame ${l.frame} (t=${r.times[l.frame]!.toFixed(3)}s); the tolerance is ${tol}${unit}`;
      if (landed(l)) say(`  LAND   ${line}`);
      else p.add('POSE_LANDS', `${line} — the rig does not turn the way the key formula assumes (a constraint, a scaled or sheared parent, a non-normal inherit mode)`);
    }
    p.throwIfAny();

    const posture = measurePosture(posed, new Map(doc.bones.map((b) => [b.name, b.length ?? 0])), map, r, frames, a.minScore);
    if (posture !== null) for (const l of postureLines(posture)) say(`  POSTURE ${l}`);

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
      const kept = buildInto(input.rig, join(scratch, 'with', 'motion.json'), resolve(a.build), a.profile);
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
        rig: input.name,
        animation: a.name,
        frames: seq.frames.length,
        duration: r.animation.duration,
        options: { minScore: a.minScore, smooth: a.smooth, flip: a.flip, short: a.short, bends: a.bends, bendTolerance: a.bendTolerance, switchTolerance: a.switchTolerance, switchMin: a.switchMin, switchAt: a.switchAt, profile: a.profile },
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
