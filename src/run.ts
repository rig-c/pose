/**
 * `rig-pose retarget`, end to end: read, gate the rig as it is, retarget (the
 * switches and the range clamp included), gate it with the animation in,
 * measure where the rig landed, read the folds (and which no switch covers),
 * and write — only when every check passed.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { knownSetsOf, readMap, resolveMap, type JointMap, type Rest } from './map.ts';
import { cleanLine, cleanSummaryLine, inferredSource } from './clean.ts';
import { depthLine, depthRecleanText, forwardShinFrames, layersOf, type FrameLayers } from './depth.ts';
import { drawGapLines, drawOrderFromDepth, drawOrderKeys, drawOrderLines, type DrawOrderReading } from './draworder.ts';
import { bindingProblems, groupLines, groupsReport, keyGroups, readLayout, resolveGroups, type GroupOrder } from './layout.ts';
import { convertCoco17, personTrack, readPoseSequence, TRAVEL_IN_PLACE, type CameraFrame } from './pose.ts';
import { isObject, lineOf, parseJson, Problems, Refusal, type Problem } from './problems.ts';
import { boneIdentity, droppedLine, keptOutLine, mergeProblems, readFragment, readIdle, targetOf, trackLabel, type IdleReading, type RigcTrack, type Target } from './idle.ts';
import { bendGroupLine, bendGroups, bendLine, endOnLine, flipLine, holdLine, nodLine, pelvisLine, rangeLine, reachCostLine, reachOriginLine, reachOriginWarn, retarget, shortLine, turnLine, type MotionTrack, type RetargetOptions, type ScaleBand, type ScaleFit } from './retarget.ts';
import { attachmentBones, baseMotionOf, buildInto, rigcVersion, folds, gate, readBuild, resolveRig, restOf, seamRender, slotsOf } from './rigc.ts';
import { partsPath, projectSeams, readSeamDoc, readSeamPairs, seamLines, type SeamPair } from './seams.ts';
import { artRangeLine, chainsMoving, phaseLines, raisedLine, RAISED_WITHIN, reachLine, switchBindLines, switchLine, switchMinLines, switchTurnLines, uncoveredFolds } from './switch.ts';
import { jitterLine, landed, type FeetReading, type JitterRow, type Landing, measureFeet, measureJitter, measureLanding, measurePosture, measureShear, poseFrames, postureLines } from './verify.ts';
import { FRONTAL_DISAGREE, legsOf, PLANT_SWITCH, STANCE_BOUNDS, STILL_SPEED } from './legs.ts';
import { M2_IDENTITY, mulM2, reduceKeys, reduceScale, reduceUnderScale, SCALE_REDUCE, setupLocal, smoothTrunk, type M2, type ReduceBone, type Reduced, type ReduceRow, type UnderBone } from './reduce.ts';
import type { BlendHold, Closure, Feet, Floor, FreeAnkleShift, LegScale, LegSegmentRatio, Lowered, Side, Stance, SupportScaleRun, SupportSignal } from './legs.ts';
import { reportRenderDomain, writeReport, type ReportInput } from './report.ts';
import { PROVENANCE_FILE, provenanceText } from './provenance.ts';
import { madeLine, planOutDirs } from './outdir.ts';
import { bodyLine, faceLine } from './face.ts';
import { contactKeysLines, readContactKeys } from './contacts.ts';

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
  /**
   * With `build`: echoed verbatim into the build's record (`retarget.json`, #270) as `reference`;
   * never read, never checked to exist. Absent, the record has no `reference` key.
   */
  reference?: string;
  /** Keep rigc's render of the animation (frames, contact sheet, folds.json) here. */
  render?: string;
  /** @rig-c/parts' `parts.json` (or the directory holding it): the neighbour pairs the seam reading reads (#216). */
  parts?: string;
  /** Write the run's measurements as JSON here. */
  report?: string;
  /** Write the sequence's per-frame relative figure scale and pan as a sidecar JSON here (#161). */
  camera?: string;
  /** The rig's animation read as its idle (default: idle); naming one the motion spec lacks is refused. */
  idle?: string;
  /** Loop the idle's dropped tracks into the new animation (#43 item 2). */
  carryIdle?: boolean;
  /** A rig-pose-tracks/1 fragment merged into the new animation. */
  merge?: string;
  /** Thin the mapped bones' rotate keys within this many degrees (#32). */
  reduce?: number;
  /** With reduce: a map chain's own tolerance in degrees, by chain name, in place of `reduce` on its bones (#283). */
  reduceChains?: Record<string, number>;
  /** With reduce: thin the hip's translate keys within this many rig units. */
  reduceHip?: number;
  /** With reduce and plantFeet: keep each support span's frames on the supporting leg at its dense keys (#251). */
  reduceKeepPlanted?: boolean;
  /**
   * What stdout carries (rig-c/pose#238). `default`: the CLEAN line's hold record
   * as a count and each hinge's wrong-way frames as one line; `verbose`: every
   * line in full, as before #238; `summary`: the run line, one line per measure
   * (GATE, FEET, LIFT, JITTER, LAND) and the `wrote` lines. Refusals are the
   * same in all three and the gate is the same gate.
   */
  output?: 'default' | 'verbose' | 'summary';
  /** `--draw-order depth` (rig-c/pose#304): key the animation's draw order from the sequence's depth. Absent: no draw-order key, the output as before. */
  drawOrder?: 'depth';
  /** `--contact-keys` (rig-c/pose#303): the hand contact keys' file, `rig-pose-contact-keys/1`. Absent: the support as read, the output as before. */
  contactKeysFile?: string;
}

export interface RunResult {
  lines: string[];
  written: boolean;
}

export function runRetarget(a: RetargetArgs, log: (line: string) => void): RunResult {
  const lines: string[] = [];
  const output = a.output ?? 'default';
  /** A line every mode prints: the run line, the summary lines, the `wrote` lines. */
  const tell = (l: string) => {
    lines.push(l);
    log(l);
  };
  /** A line of the full output: default and --verbose print it; --summary does not. */
  const say = (l: string) => {
    if (output !== 'summary') tell(l);
  };
  const refuse = (problems: readonly Problem[]): never => {
    throw new Refusal(problems);
  };
  const args = new Problems();
  for (const [flag, path] of [['--map', a.map], ['--pose', a.pose], ['--merge', a.merge], ['--contact-keys', a.contactKeysFile]] as const) {
    if (path !== undefined && !existsSync(path)) args.add('ARG_PATH', `${flag} ${path} does not exist`);
  }
  // rig-c/pose#239: the report is written unless asked elsewhere — beside the motion, as <out>.report.json.
  const report = a.report ?? defaultReportPath(a.out);
  // A file this run writes goes into a directory the user named: one that is not there yet is made
  // after the run is green (one line says so), as --build and --render make theirs; a file in the way is refused.
  const makeDirs = planOutDirs([['--out', a.out], ['--report', report], ['--camera', a.camera]], args);
  // #284: --build and --render make their own directories (rigc, the copy); a file in the way is refused here, up front.
  planOutDirs([['--build', a.build], ['--render', a.render]], args);
  if (a.reference !== undefined && a.build === undefined) args.add('ARG_REFERENCE', `--reference ${a.reference} needs --build: the record it goes in is written beside the build (${PROVENANCE_FILE})`);
  args.throwIfAny();
  const input = resolveRig(a.rig, a.baseMotion);
  const rigSnapshot = readReportInput(input.rig);
  const base = baseMotionOf(input);
  const animations = base.animations as Record<string, unknown>;
  if (a.name in animations) refuse([{ code: 'MOTION_NAME_FREE', text: `the rig's motion spec already has an animation "${a.name}" (it has ${Object.keys(animations).join(', ')}); name this one with --name` }]);
  const idleName = a.idle ?? 'idle';
  if (!(idleName in animations) && (a.idle !== undefined || a.carryIdle === true)) {
    refuse([{ code: 'IDLE_NAME', text: `${a.idle !== undefined ? `--idle "${idleName}"` : '--carry-idle reads the animation "idle", and'} the rig's motion spec ${input.motion === null ? '— there is none, so it has no animations' : `${input.motion} has no animation "${idleName}" (it has ${Object.keys(animations).join(', ') || 'none'})`}; name the rig's idle with --idle` }]);
  }
  // #216: the neighbour pairs, read before any work so a bad --parts is refused first.
  const seamDecl = a.parts === undefined ? null : (() => {
    const path = partsPath(a.parts);
    return { path, pairs: readSeamPairs(readFileSync(path, 'utf8'), path) };
  })();
  const fragment = a.merge === undefined ? [] : readFragment(parseJson(readFileSync(a.merge, 'utf8'), a.merge, 'MERGE_JSON'), a.merge);
  const mapSnapshot = readReportInput(a.map), poseSnapshot = readReportInput(a.pose);
  const map = readMap(mapSnapshot.bytes.toString('utf8'), a.map);
  // #283: each chain --reduce names must be the map's; a bone takes its chain's tolerance (the tighter, if two chains name it).
  let reduceOf = a.reduce === undefined ? null : reduceTolerances(map, a.reduce, a.reduceChains, a.map);
  const poseText = poseSnapshot.bytes.toString('utf8');
  const seq = a.coco ? convertCoco17(poseText, a.pose) : readPoseSequence(poseText, a.pose);
  if (seq.cleaned === undefined) refuse([{ code: 'POSE_NOT_CLEANED', text: notCleaned(a.pose, a.coco) }]);
  // #304: the draw order is read off the sequence's depth; asked for on a sequence without it, refused by name.
  if (a.drawOrder === 'depth' && !seq.frames.some((x) => x.depth !== undefined)) refuse([{ code: 'DRAWORDER_NO_DEPTH', text: `--draw-order depth keys the draw order from the sequence's depth, and ${a.pose} carries none (rig-pose-sequence/${seq.cleaned!.params.depth === undefined ? '1 or 1.1, no "depth" on any frame' : '1.2 with no frame naming a segment'}); clean it with --depth walk|run, or retarget without --draw-order` }]);
  const frames = personTrack(seq, a.person, a.pose);
  // #336: a derived depth whose shins lean the way the trunk faces was cleaned with the table before #336 (a walk's lifted
  // foot forward); the draw order now reads a walk at the ankle, and would draw that foot in front. Refused by name.
  if (a.drawOrder === 'depth') {
    const old = forwardShinFrames(frames, seq.frames);
    if (old.length > 0) refuse([{ code: 'DEPTH_RECLEAN', text: depthRecleanText(a.pose, seq.cleaned!.params.depth?.gait ?? null, old) }]);
  }
  // rig-c/pose#346: the limb layout beside the rig, read and bound only with --draw-order depth (without it, nothing is read).
  const layout = a.drawOrder === 'depth' ? readLayout(input.rig) : null;
  if (a.drawOrder === 'depth') bindingProblems(layout, map.layout, input.rig, a.map).throwIfAny();
  // rig-c/pose#303: the contact keys, read against the sequence's frames before any gate runs.
  const contactKeysSnapshot = a.contactKeysFile === undefined ? null : readFileSync(a.contactKeysFile);
  const contactKeys = contactKeysSnapshot === null ? null : readContactKeys(contactKeysSnapshot.toString('utf8'), a.contactKeysFile!, seq.frames.length);
  const times = seq.frames.map((f) => f.t);

  const scratch = mkdtempSync(join(tmpdir(), 'rig-pose-'));
  try {
    // The rig as it stands, through the gate, so the rest pose is rig-c's reading of a green build.
    const g0 = gate(input.rig, base, join(scratch, 'base'), a.profile, a.images);
    if (!g0.green) {
      refuse([{ code: 'RIG_GATE_BASE', text: `${input.rig} with ${input.motion ?? 'no motion spec'} is red under rigc build --profile ${a.profile} before any animation is added (exit ${g0.run.status})${unreadMotionHint(a.rig, input.motion)}` }, ...g0.fails.map((f) => ({ code: 'RIGC', text: f }))]);
    }
    const doc0 = readBuild(g0.build);
    const rigc = rigcVersion();
    const rest = restOf(doc0);
    const slots = slotsOf(doc0);
    resolveMap(map, rest, a.map, slots, input.sets);

    const r = retarget(rest, map, frames, times, { ...a, ...(seq.travel !== undefined ? { travel: seq.travel } : {}), ...(seq.cleaned!.params.loop ? { loop: true } : {}), ...(seq.pelvisSource !== undefined ? { pelvis: { source: seq.pelvisSource, tilt: seq.frames.map((f) => f.pelvisTilt ?? null) } } : {}), ...(contactKeys !== null ? { contactKeys } : {}), ...(seq.cleaned!.params.depth !== undefined ? { gait: seq.cleaned!.params.depth.gait } : {}) }, slots, input.sets);
    if (fragment.length > 0 && ((r.face?.sets?.length ?? 0) > 0 || (r.body?.sets?.length ?? 0) > 0)) {
      const known = knownSetsOf(map, input.sets);
      for (const s of [...(r.face?.sets ?? []), ...(r.body?.sets ?? [])]) {
        const def = known.get(s.set);
        if (def === undefined) continue;
        for (const h of def.hides) {
          for (const tr of fragment) {
            const tgt = targetOf(tr);
            if (tgt?.kind === 'slot' && tgt.name === h) {
              const by = `slot "${h}" ${tr.property} (--merge ${a.merge})`;
              if (!s.hidesKeyed.some((x) => x.slot === h && x.by === by)) s.hidesKeyed.push({ slot: h, by });
            }
          }
        }
      }
    }
    tell(`rig-pose retarget: ${seq.frames.length} frame(s), ${r.animation.duration.toFixed(3)}s, onto "${input.name}" as "${a.name}" — ${r.animation.tracks.length} track(s); min-score ${a.minScore}, flip ${a.flip === 'off' ? 'off' : `${a.flip}°`}, short ${a.short}, bends ${a.bends} (tolerance ${a.bendTolerance}°)${a.legScale !== undefined && a.legScale !== 'off' ? `, leg-scale ${a.legScale[0]}–${a.legScale[1]}` : ''}${a.plantFeet === true ? ', plant-feet' : ''}${a.stance !== undefined && a.stance !== 'off' ? `, stance ${a.stance}` : ''}${a.raisedByHead === true ? ', raised-by-head' : ''}${a.carryIdle === true ? ', carry-idle' : ''}${a.merge !== undefined ? `, merge ${a.merge}` : ''}${a.reduce !== undefined ? `, reduce ${a.reduce}°${chainsText(a.reduceChains)}${a.reduceHip !== undefined ? ` (hip ${a.reduceHip} units)` : ''}${a.reduceKeepPlanted === true ? ', planted legs kept dense' : ''}` : ''}`);
    say(`  RIGC   rig-c ${rigc.version} (${rigc.entry}) gates and poses this run`);
    // #250: the gate was green without it, so nothing else would say the rig's own animations are not in --out.
    const unread = unreadMotionLine(a.rig, input.motion);
    if (unread !== null) tell(`  MOTION ${unread}`);
    say(`  CLEAN  ${output === 'verbose' ? cleanLine(seq.cleaned!) : cleanSummaryLine(seq.cleaned!)}`);
    if (a.smoothAlias !== undefined) say(`  SMOOTH --smooth is carried by clean; ignored (given ${a.smoothAlias}; this sequence was cleaned with legs ${seq.cleaned!.params.legs}, rest ${seq.cleaned!.params.rest})`);
    if (seq.camera !== undefined) say(`  CAMERA ${cameraLine(seq.camera, times, seq.cameraSource)}`);
    else if (a.plantFeet === true) say('  CAMERA none in the sequence: --plant-feet reads the picture as a fixed camera, so a zoom or a pan in the video moves the floor with it and the floor may step with the picture (tools/scan.py reads the camera, rig-c/pose#63)');
    if (r.scale !== null) {
      const fit = r.scaleFit === null ? [] : scaleFitLines(r.scale.factor, r.scaleFit);
      say(`  SCALE  ${r.scale.factor.toFixed(5)} rig units per picture px (rig ${r.scale.rig.toFixed(2)} / pose median ${r.scale.pose.toFixed(2)})${r.scaleFit === null ? '' : `; ${segmentClause(r.scaleFit)}`}`);
      for (const l of fit) say(`  SCALE  ${l}`);
    }
    for (const h of r.holds) say(`  HOLD   ${holdLine(h, r.times)}`);
    for (const s of r.short) say(`  ${s.across === true ? 'HOLD  ' : 'SHORT '} ${shortLine(s, r.times, a.short)}`);
    if (a.short !== 'off') {
      for (const e of r.endOn) say(`  END-ON ${endOnLine(e, r.times, a.short)}`);
    }
    if (a.flip !== 'off') for (const fl of r.flips) say(`  FLIP   ${flipLine(fl, r.times, a.flip)}`);
    if (output === 'verbose') for (const e of r.bends) say(`  BEND   ${bendLine(e)} — clamped straight`);
    else for (const g of bendGroups(r.bends)) say(`  BEND   ${bendGroupLine(g, 'clamp')}`);
    for (const e of r.turns) say(`  TURN   ${turnLine(e, r.times)}`);
    for (const u of r.turnsUnread) say(`  TURN   line "${u.line}" (${u.joints[0]} → ${u.joints[1]}) not measured: ${u.why}`);
    if (map.alternates.length > 0) {
      if (r.switches.length === 0) say(`  SWITCH none — no set within ${a.switchTolerance}° of the pose for ${a.switchMin}s`);
      for (const s of r.switches) say(`  SWITCH ${switchLine(s, r.times)}`);
      // #279: only for a set the minimum span held back, so a run where nothing was suppressed prints what it always has.
      for (const l of switchMinLines(r.switchRuns, a.switchMin)) say(`  SWITCH-MIN ${l}`);
      // #355: only for a set whose art turn kept it off some frames.
      for (const l of switchTurnLines(r.switchRuns, a.switchTolerance)) say(`  SWITCH-TURN ${l}`);
      // #360: only for a set with a `bind`.
      for (const l of switchBindLines(map, r.switchBinds, r.switches)) say(`  SWITCH-BIND ${l}`);
      for (const l of windowLines(map, r.switches, r.distances, r.times, a.switchTolerance)) say(`  FRAMES ${l}`);
      for (const l of phaseLines(map, r.switches)) say(`  PHASE  ${l}`);
    }
    for (const e of r.range) say(`  RANGE  ${rangeLine(e, r.times)}`);
    if (a.raisedByHead === true && r.raised.length === 0) say(`  RAISED none — no set drawing an arm within ${RAISED_WITHIN}° of straight up showed; no key moved`);
    for (const e of r.raised) say(`  RAISED ${raisedLine(e, r.times)}`);
    for (const e of r.raised) if (e.short.length > 0) say(`  REACH  ${reachLine(e, r.times)}`);
    if (map.alternates.some((x) => x.place !== undefined && x.place !== null) && r.byHip.length === 0) say(`  BY-HIP none — no set with "place": "by-hip" showed; no key moved`);
    for (const e of r.byHip) say(`  BY-HIP ${raisedLine(e, r.times)}`);
    for (const e of r.byHip) if (e.short.length > 0) say(`  REACH  ${reachLine(e, r.times)}`);
    for (const e of r.reach) say(`  REACH  ${reachCostLine(e, r.times)}`);
    // rig-c/pose#282: each reach chain's origin against its source joint; a map without one prints none.
    for (const e of r.reachOrigin) {
      say(`  REACH-ORIGIN ${reachOriginLine(e, r.times)}`);
      if (e.warn) say(`  WARN   ${reachOriginWarn(e)}`);
    }
    for (const e of r.artRange) say(`  ART-RANGE ${artRangeLine(e, r.times)}`);
    // #287: a range that clamps no frame says so once, on the last segment's line (the line count stays one per segment).
    const noClamp = legScaleNoClamp(r.legScale);
    r.legScale.forEach((l, k) => say(`  LEG-SCALE ${legScaleLine(l, r.times, r.feet?.legLength ?? null, r.rigLeg)}${k === r.legScale.length - 1 && noClamp !== null ? `; ${noClamp}` : ''}`));
    for (const l of r.legScale) for (const s of l.support ?? []) say(`  LEG-SCALE ${supportScaleLine(l, s, r.times)}`);
    if (r.pelvis !== null) say(`  ${pelvisLine(r.pelvis, seq.frames.length)}`);
    // rig-c/pose#281: the limbs' front-to-back order from the sequence's depth, only when it carries depth.
    const layers: FrameLayers[] | null = seq.frames.some((x) => x.depth !== undefined) ? frames.map((j, i) => layersOf(j, seq.frames[i]!.depth ?? {})) : null;
    if (layers !== null) say(`  ${depthLine(layers, seq.frames, seq.cleaned!.params.depth?.gait ?? null)}`);
    // rig-c/pose#304: with --draw-order depth, the legs' draw order keyed from the depth (#336: at the joint the recorded gait names).
    const legOrder: DrawOrderReading | null = a.drawOrder === 'depth' && layers !== null ? drawOrderFromDepth(layers, frames, seq.frames.map((x) => x.depth), r.times, map, rest, doc0.slots, input.sets, seq.cleaned!.params.loop, seq.cleaned!.params.depth?.gait ?? null) : null;
    // rig-c/pose#346: each bound layout group (a forearm) against its target, merged into the legs' timeline.
    let drawOrder = legOrder;
    let layoutGroups: GroupOrder[] | null = null;
    if (legOrder !== null && layout !== null) {
      const names = doc0.slots.map((x) => x.name);
      const legRuns = legOrder.pairs.filter((x) => x.keyed).map((x): [number, number] => {
        const ix = [...x.slots.a, ...x.slots.b].map((n) => names.indexOf(n));
        return [Math.min(...ix), Math.max(...ix)];
      });
      const resolved = resolveGroups(layout, map.layout ?? [], map, rest, doc0.slots, legRuns);
      resolved.problems.throwIfAny();
      const keyed = keyGroups(legOrder, resolved.groups, frames, seq.frames.map((x) => x.depth), r.times, doc0.slots);
      drawOrder = keyed.reading;
      layoutGroups = keyed.groups;
    }
    if (legOrder !== null) for (const l of [...drawOrderLines(legOrder), ...drawGapLines(legOrder)]) say(`  ${l}`);
    if (layoutGroups !== null && drawOrder !== null) for (const l of groupLines(layoutGroups, drawOrder.keys)) say(`  ${l}`);
    if (r.pivot !== null) say(`  PIVOT  bone "${r.pivot.bone}"'s origin is ${r.pivot.distance.toFixed(2)} units (${r.pivot.hipWidths.toFixed(3)} hip widths) from its thigh roots' midpoint (${r.pivot.roots.join(' + ')}): dx ${r.pivot.offset[0].toFixed(2)}, dy ${r.pivot.offset[1].toFixed(2)}, at setup — the pivot every hip turn swings the legs about`);
    if (r.feet !== null) {
      const f = r.feet;
      const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
      say(`  FEET   ${r.planted ? 'planted' : 'read, not planted (no --plant-feet)'}: leg length (median hip → ankle) r ${f.legLength.r.toFixed(1)}px, l ${f.legLength.l.toFixed(1)}px; ${f.supports.length} support span(s), ${f.changes.filter((c) => c.from !== null).length} change(s) of support, ${f.jumps.length} jump(s), ${f.steps.length} step(s)`);
      for (const sg of r.segments) say(`  FEET   ${segmentLine(sg)}`);
      say(`  FEET   supports: ${f.supports.map((x) => `${x.side} ${span(x.frames)}`).join(', ') || 'none'}`);
      // rig-c/pose#303: with contact keys, their stride lines stand in for #280's (the keys decide the frames they cover).
      const signal = f.signal === undefined ? [] : signalLines(f.signal, f.supports);
      for (const l of f.contactKeys === undefined ? signal : [...signal.filter((x) => !x.startsWith('stride ')), ...contactKeysLines(f)]) say(`  FEET   ${l}`);
      say(`  FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): ${f.jumps.map(span).join(', ') || 'none'}`);
      if (f.lowered !== undefined) say(`  FEET   ${loweredLine(f.lowered)}`);
      if (f.tracked !== undefined) say(`  FEET   tracked (the lower foot supports on the floor, following its scaled ankle track until still, rig-c/pose#119): ${f.tracked.map((x) => `${x.side} ${span(x.frames)}`).join(', ')}`);
      if (r.closure !== null) say(`  FEET   ${travelLine(r.closure)}`);
      else say(`  FEET   steps (the supporting ankle > 0.03 leg lengths a frame; re-planted after 2 frames < 0.01): ${f.steps.map((x) => `${x.side} ${span(x.frames)} → ${x.to === null ? 'the pose\'s travel' : `${x.to} supports`}, ${x.replant === null ? 'never re-planted' : `re-planted at ${x.replant}`}`).join('; ') || 'none'}`);
      if (r.floor !== null) {
        const legBones = legBonesOf(map);
        if (legBones !== null) say(`  FEET   ${floorLine(r.floor, setupLegs(rest, legBones))}`);
      }
      if (r.blendHold !== null) for (const l of blendLines(r.blendHold, r.times)) say(`  FEET   ${l}`);
    }
    if (seq.travel === TRAVEL_IN_PLACE && !r.planted) say(`  TRAVEL ${openTravelLine(r.openDrift)}`);
    if (r.stance !== null) for (const l of stanceLines(r.stance, r.times, r.feet === null || r.legStraight === null ? undefined : { legLength: r.feet.legLength, straight: r.legStraight, rigLeg: r.rigLeg })) say(`  STANCE ${l}`);
    const nod = nodLine(r.headNod, r.nodSkipped, map.face?.pitch !== undefined);
    if (nod !== null) say(`  NOD    ${nod}`);
    if (r.face !== null) say(`  FACE   ${faceLine(r.face)}`);
    if (r.body !== null) say(`  BODY   ${bodyLine(r.body)}`);

    // #320: a mapped bone above a planted or aimed chain --reduce names is held to that chain's tolerance when its own is looser.
    const held = reduceOf === null || a.reduceChains === undefined ? [] : holdParents(map, rest, new Set(r.targets.keys()), a.reduceChains, reduceOf, r.ankles === null ? [] : [r.ankles.bones.r, r.ankles.bones.l]);
    if (held.length > 0) {
      const first = reduceOf!;
      reduceOf = (bone) => held.find((h) => h.bone === bone)?.to ?? first(bone);
      for (const h of held) say(`  REDUCE ${heldLine(h)}`);
    }
    // --reduce (#32): the dense keys thinned top-down, before anything reads the tracks.
    const reduced = a.reduce === undefined ? null : a.reduceChains === undefined ? reduceTracks(r, map, rest, a.reduce, a.reduceHip, a.reduceKeepPlanted === true) : reduceTracks(r, map, rest, a.reduce, a.reduceHip, a.reduceKeepPlanted === true, reduceOf!);
    if (reduced !== null) {
      for (const row of reduced.rows) {
        const [who, track, what, unit] = row.kind === 'angle' ? ['bone', 'rotate', 'aim', '°'] : row.kind === 'origin' ? ['hip', 'translate', 'origin', ' units'] : ['bone', 'scalex', 'scale', ' of its setup length'];
        const hold = held.find((h) => h.bone === row.bone && row.kind === 'angle');
        const own = row.kind === 'angle' && reduceOf!(row.bone) !== a.reduce ? (hold === undefined ? ` — within its chain's ${reduceOf!(row.bone)}°` : ` — held to ${hold.to}° for ${hold.for.map((c) => `chain "${c.chain}"`).join(', ')} below it`) : '';
        say(`  REDUCE ${who} "${row.bone}" ${track}: ${row.before} → ${row.after} key(s); worst ${what} error ${row.worst.toPrecision(3)}${unit} at frame ${row.frame} (t=${r.times[row.frame]!.toFixed(3)}s)${own}`);
      }
      for (const u of reduced.unsmoothed ?? []) say(`  REDUCE ${unsmoothedLine(u)}`);
      const sum = (kind: ReduceRow['kind'], k: 'before' | 'after') => reduced.rows.filter((x) => x.kind === kind).reduce((t, x) => t + x[k], 0);
      const scales = reduced.rows.some((x) => x.kind === 'scale') ? `; scalex keys ${sum('scale', 'before')} → ${sum('scale', 'after')} within ${SCALE_REDUCE} of the setup length` : '';
      say(`  REDUCE rotate keys ${sum('angle', 'before')} → ${sum('angle', 'after')} (${(sum('angle', 'before') / sum('angle', 'after')).toFixed(2)}×) within ${a.reduce}°${chainsText(a.reduceChains)}${scales}${a.reduceHip === undefined ? '; the hip stays dense (no --reduce-hip)' : ''}`);
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
      const mapped = [
        ...map.chains.flatMap((c) => c.bones),
        ...(map.translate === null ? [] : [map.translate.bone]),
        ...(map.face?.yaw === undefined ? [] : [map.face.yaw.bone]),
        ...(map.face?.pitch === undefined ? [] : [map.face.pitch.bone]),
        ...(map.body?.yaw === undefined ? [] : [map.body.yaw.bone]),
      ];
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
    const tracked = added.length === 0 ? r.animation : { ...r.animation, tracks: [...own, ...added] };
    // #304: rig-c's one draw-order timeline sits on the animation beside its tracks; written only when keyed.
    const animation = drawOrder === null || drawOrder.keys.length === 0 ? tracked : { ...tracked, drawOrder: drawOrderKeys(drawOrder) };
    const motion = { ...base, animations: { ...animations, [a.name]: animation } };
    const g1 = gate(input.rig, motion, join(scratch, 'with'), a.profile, a.images);
    if (!g1.green) {
      refuse([{ code: 'RIG_GATE', text: `rigc build --profile ${a.profile} is red with "${a.name}" in (exit ${g1.run.status}); nothing written` }, ...g1.fails.map((f) => ({ code: 'RIGC', text: f }))]);
    }
    const gateText = gateLine(a.profile, g1.summary);
    say(`  GATE   ${gateText}`);

    const doc = readBuild(g1.build);
    const posed = poseFrames(doc, a.name, r.times);
    // A reduced track is held to the dense target plus its tolerance (#32); an ankle, to what the
    // reduced bones above it may move it by (#94, `footReduce`). A scale keeps its own: it is reduced within half of it.
    // #240: each ankle's allowance is computed once, here, and both the LAND tolerance and the drift line read it.
    const drift: AnkleDrift[] = [];
    // #251: with --reduce-keep-planted, each ankle is held apart on its support frames, which were kept dense.
    const support = a.reduce !== undefined && a.reduceKeepPlanted === true && r.feet !== null ? supportFrames(r.feet.supports) : undefined;
    const landings = measureLanding(doc, a.name, map, r, posed, support).map((l) => {
      if (a.reduce === undefined) return l;
      // #283: a chain's own tolerance is added as the run's is; the sum is rounded only under a per-chain --reduce.
      if (l.kind === 'angle') return { ...l, tolerance: a.reduceChains === undefined ? l.tolerance + a.reduce : Number((l.tolerance + reduceOf!(l.bone)).toPrecision(12)) };
      if (l.kind === 'origin' && a.reduceHip !== undefined) return { ...l, tolerance: l.tolerance + a.reduceHip };
      if (l.kind !== 'foot') return l;
      const ankle = l.bone.replace(/:tip$/, '');
      const by = footReduce(rest, r, ankle, a.reduce, a.reduceHip, a.reduceChains === undefined ? undefined : reduceOf!);
      // #251: on its support frames every mapped bone from the hip down was kept at its target, so only the hip's tolerance moves it.
      const hip = a.reduceHip ?? 0;
      if (!drift.some((d) => d.bone === l.bone)) {
        const lb = legBonesOf(map);
        const side = lb?.r.ankle === ankle ? 'r' : lb?.l.ankle === ankle ? 'l' : null;
        const legs = (u: number) => (side === null || r.rigLeg === null ? null : u / r.rigLeg[side]);
        const held = support === undefined ? {} : { support: side === null || support[side].size === 0 ? null : { reduce: hip, units: l.tolerance + hip, legLengths: legs(l.tolerance + hip) } };
        // #283: under a per-chain --reduce, the tolerance its leg was reduced within.
        const leg = a.reduceChains === undefined ? {} : { legTolerance: legTolerance(rest, r, ankle, reduceOf!) };
        drift.push({ bone: l.bone, side, plant: l.tolerance, reduce: by, units: l.tolerance + by, legLengths: legs(l.tolerance + by), ...held, ...leg });
      }
      return { ...l, tolerance: l.tolerance + (l.on === 'support' ? hip : by) };
    });
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
      const what = l.kind === 'angle' ? 'aim' : l.kind === 'scale' ? 'scale' : l.kind === 'foot' ? (l.on === 'support' ? 'ankle on its support frames (kept dense)' : l.on === 'off-support' ? 'ankle off its support frames' : 'ankle') : 'origin';
      const tol = l.kind === 'foot' ? Number(l.tolerance.toPrecision(3)) : l.tolerance;
      const line = `bone "${l.bone}" ${what} — worst |reached − asked| ${l.worst.toPrecision(3)}${unit} at frame ${l.frame} (t=${r.times[l.frame]!.toFixed(3)}s); the tolerance is ${tol}${unit}`;
      if (landed(l)) say(`  LAND   ${line}`);
      else if (l.on === 'support') p.add('POSE_LANDS', `${line} — --reduce-keep-planted holds every mapped bone from the hip down at its dense key on its side's support frames, so only the hip's --reduce-hip may move it; a frame missed here was not kept${carriedAbove(l.bone)}`);
      else p.add('POSE_LANDS', `${line} — the rig does not turn the way the key formula assumes (a constraint, a scaled or sheared parent, a non-normal inherit mode)${carriedAbove(l.bone)}`);
    }
    p.throwIfAny();
    // #236: each keyed bone's jitter as posed, against its map pair's — names the bone that moved a group's ratio.
    const jitter = measureJitter(posed, map, r, frames, a.minScore);
    for (const j of jitter) say(`  JITTER ${jitterLine(j)}`);

    const lengths = new Map(doc.bones.map((b) => [b.name, b.length ?? 0]));
    const hips = seq.cleaned?.params.hipsInferred;
    const posture = measurePosture(posed, lengths, map, r, frames, a.minScore, inferredSource(seq.cleaned), hips?.by === 'measured' ? hips : null, seq.pelvisSource !== undefined ? { source: seq.pelvisSource, tilt: seq.frames.map((f) => f.pelvisTilt ?? null) } : null);
    if (posture !== null) for (const l of postureLines(posture)) say(`  POSTURE ${l}`);
    const legBones = legBonesOf(map);
    const feetReading = legBones === null ? null : measureFeet(posed, lengths, r, legBones);
    if (feetReading !== null) {
      for (const l of posedFeetLines(feetReading)) say(`  FEET   ${l}`);
    }
    const shear = r.scales.size === 0 ? [] : measureShear(doc, posed, r.scales.keys());
    for (const x of shear) say(`  SHEAR  bone "${x.bone}": art sheared up to ${x.shear.toFixed(2)}° (frame ${x.frame}); world x axis ${x.x[0].toFixed(3)} … ${x.x[1].toFixed(3)}, y axis ${x.y[0].toFixed(3)} … ${x.y[1].toFixed(3)} of setup — a scaled bone, or one under it; a reading${shearRemedy(x, rest, shear)}`);

    const dts = r.times.slice(1).map((t, i) => t - r.times[i]!).sort((x, y) => x - y);
    const fps = dts.length === 0 ? 12 : Math.max(1, Math.min(60, Math.round(1 / dts[dts.length >> 1]!)));
    // A rig that draws nothing (bones only) has nothing to fold, and rigc's render refuses it.
    const f = doc.slots.length === 0 ? { run: { args: [], status: 0, out: '' }, meshes: [], frames: '' } : folds(g1.build, a.name, join(scratch, 'folds'), fps);
    if (doc.slots.length === 0) say('  FOLD   the rig has no slots, so it draws nothing to fold; not measured');
    else if (f.meshes === null) say(`  FOLD   rigc render --folds did not read (exit ${f.run.status}); folds not measured`);
    else if (f.meshes.length === 0) say(`  FOLD   rigc render --folds at ${fps} fps: no mesh folds`);
    else for (const m of f.meshes) say(`  FOLD   mesh "${m.attachment}" (slot "${m.slot}") folds on ${m.times.length} frame(s) at ${fps} fps: t=${spans(m.times, 1 / fps)}`);
    const uncovered = f.meshes === null ? null : uncoveredFolds(f.meshes, r.shown, r.times, slots, (slot, att) => chainsMoving(attachmentBones(doc, slot, att), rest, map));
    if (uncovered !== null && (map.alternates.length > 0 || (r.face?.sets?.length ?? 0) > 0 || (r.body?.sets?.length ?? 0) > 0)) {
      for (const u of uncovered) say(`  UNCOVERED mesh "${u.attachment}" (slot "${u.slot}"; chains ${u.chains.length === 0 ? 'none' : u.chains.join(', ')}) folds with no switch covering it on ${u.times.length} frame(s): t=${spans(u.times, 1 / fps)}`);
    }

    // #216: the seam reading over the declared neighbour pairs — a reading, never a gate.
    const seamRead = readSeams(seamDecl, input.rig, doc.slots.map((s) => s.name), g1.build, a.name, join(scratch, 'seams'), fps);
    for (const l of seamRead.lines) say(`  SEAM   ${l}`);

    // #240: what --reduce allowed each ankle, at the end of the run, from the same figure the LAND check applied.
    for (const d of drift) say(`  REDUCE ${ankleDriftLine(d)}`);

    assertReportInputs([rigSnapshot,mapSnapshot,poseSnapshot]);
    // Every retarget option as resolved: the report's `options`, and with the name the build record's `flags` (#270).
    const options = { minScore: a.minScore, flip: a.flip, short: a.short, bends: a.bends, bendTolerance: a.bendTolerance, switchTolerance: a.switchTolerance, switchMin: a.switchMin, switchAt: a.switchAt, profile: a.profile, legScale: a.legScale ?? 'off', plantFeet: a.plantFeet === true, stance: a.stance ?? 'off', floor: a.floor ?? null, raisedByHead: a.raisedByHead === true, idle: idleName, carryIdle: a.carryIdle === true, merge: a.merge ?? null, reduce: a.reduce ?? 'off', ...(a.reduceChains === undefined ? {} : { reduceChains: a.reduceChains }), reduceHip: a.reduceHip ?? 'off', ...(a.reduceKeepPlanted === true ? { reduceKeepPlanted: true } : {}), ...(a.drawOrder !== undefined ? { drawOrder: a.drawOrder } : {}), ...(a.contactKeysFile !== undefined ? { contactKeys: a.contactKeysFile } : {}) };
    const reportText = writeReport({
        spec: 'rig-pose-report/1',
        rigc,
        rig: input.name,
        animation: a.name,
        frames: seq.frames.length,
        duration: r.animation.duration,
        cleaned: seq.cleaned,
        options,
        scale: r.scale,
        scaleFit: r.scaleFit,
        holds: r.holds,
        short: r.short,
        endOn: r.endOn,
        bends: r.bends,
        flips: r.flips,
        gate: g1.summary,
        landings,
        jitter,
        posture,
        folds: f.meshes,
        seams: seamRead.seams,
        seamPairs: seamRead.seamPairs,
        switches: r.switches,
        switchRuns: r.switchRuns,
        // Only when the map binds a set (#360): a map without one writes the report it always has.
        ...(r.switchBinds.length > 0 ? { switchBinds: r.switchBinds } : {}),
        uncovered,
        turns: r.turns,
        reach: r.reach,
        // Only when the map has a reach chain (#282): a map without one writes the report it always has.
        ...(r.reachOrigin.length > 0 ? { reachOrigin: r.reachOrigin } : {}),
        range: r.range,
        artRange: r.artRange,
        raised: r.raised,
        // Only when a set declares `place` (#93): a map without one writes the report it always has.
        ...(map.alternates.some((x) => x.place !== undefined && x.place !== null) ? { byHip: r.byHip } : {}),
        ...(r.face === null
          ? {}
          : {
              face: {
                ears: r.face.ears,
                read: { yaw: r.face.read.yaw, pitch: r.face.read.pitch },
                ...(r.face.yaw === undefined ? {} : { yaw: { bone: r.face.yaw.bone, limits: r.face.yaw.limits, knee: r.face.yaw.knee, read: r.face.yaw.read, mapped: r.face.yaw.mapped, scale: r.face.yaw.scale, corr: r.face.yaw.corr } }),
                ...(r.face.pitch === undefined ? {} : { pitch: { bone: r.face.pitch.bone, limits: r.face.pitch.limits, knee: r.face.pitch.knee, read: r.face.pitch.read, mapped: r.face.pitch.mapped, scale: r.face.pitch.scale, corr: r.face.pitch.corr } }),
                ...(r.face.sets === undefined ? {} : { sets: r.face.sets }),
              },
            }),
        body: r.body === null
          ? null
          : {
              standing: r.body.standing,
              read: { yaw: r.body.read.yaw, opening: r.body.read.opening },
              over45: r.body.over45,
              framesOver45: r.body.framesOver45,
              ...(r.body.yaw === undefined ? {} : { yaw: { bone: r.body.yaw.bone, limits: r.body.yaw.limits, knee: r.body.yaw.knee, read: r.body.yaw.read, mapped: r.body.yaw.mapped, scale: r.body.yaw.scale, corr: r.body.yaw.corr } }),
              ...(r.body.sets === undefined ? {} : { sets: r.body.sets }),
            },
        legScale: r.legScale.map(({ scale: _scale, asked: _asked, picture: _picture, ...rest }) => rest),
        pivot: r.pivot,
        pelvis: r.pelvis,
        // Only when the sequence carries depth (#281): a sequence without it writes the report it always has.
        ...(layers !== null ? { layers: layers.map((l, frame) => ({ frame, order: l.order, depth: l.depth })) } : {}),
        // Only with --draw-order depth (#304). A key's `t` here is its frame's time, the report's clock (#214); the
        // motion's key is written half a frame before it (#325).
        ...(drawOrder !== null ? { drawOrder: { source: 'depth', pairs: drawOrder.pairs, keys: drawOrder.keys.map((k) => ({ ...k, t: r.times[k.frame]! })), spans: drawOrder.spans, gaps: drawOrder.gaps ?? [], ...(layoutGroups !== null && layout !== null ? groupsReport(layout, layoutGroups) : {}) } } : {}),
        // Only with --contact-keys (#303).
        ...(r.feet?.contactKeys !== undefined && contactKeysSnapshot !== null ? { contactKeys: { path: a.contactKeysFile, sha256: createHash('sha256').update(contactKeysSnapshot).digest('hex'), keys: r.feet.contactKeys.keys.length, from: r.feet.contactKeys.from, changed: r.feet.contactKeys.changed, kept: r.feet.contactKeys.kept, unreached: r.feet.contactKeys.unreached } } : {}),
        stance: r.stance === null ? null : { tolerance: r.stance.tolerance, release: r.stance.release, minSeconds: r.stance.minSeconds, bounds: r.stance.bounds, ...(r.stance.range === undefined ? {} : { range: r.stance.range }), runs: r.stance.runs, over: r.stance.over },
        feet: r.feet === null ? null : { planted: r.planted, legLength: r.feet.legLength, straight: r.legStraight, rigLeg: r.rigLeg, segments: r.segments, supports: r.feet.supports, jumps: r.feet.jumps, steps: r.feet.steps, changes: r.feet.changes, ...(r.feet.lowered === undefined ? {} : { lowered: r.feet.lowered }), ...(r.feet.tracked === undefined ? {} : { tracked: r.feet.tracked }), floor: r.floor?.y ?? null, shifts: r.floor?.shifts ?? [], blend: r.blendHold === null ? null : { bounds: r.blendHold.bounds, ...(r.blendHold.range === undefined ? {} : { range: r.blendHold.range }), runs: r.blendHold.runs, over: r.blendHold.over }, reading: feetReading, closure: r.closure },
        shear,
        idleDropped: idle === null ? null : idle.dropped,
        idleKeptOut: idle === null ? null : idle.keptOut,
        merged: fragment.map((tr) => ({ track: trackLabel(tr, groups), keys: tr.keys.length })),
        reduce: reduced === null ? null : { tolerance: a.reduce, ...(a.reduceChains === undefined ? {} : { chains: a.reduceChains }), ...(held.length === 0 ? {} : { held }), ...(reduced.unsmoothed === undefined ? {} : { unsmoothed: reduced.unsmoothed }), hipTolerance: a.reduceHip ?? null, rows: reduced.rows, ankleDrift: drift },
      }, map, { frameTimes: r.times }, f.meshes !== null && doc.slots.length > 0 ? reportRenderDomain(JSON.parse(readFileSync(join(f.frames, '..', 'frames.json'), 'utf8')), a.name) : seamRead.frames === null ? null : reportRenderDomain(seamRead.frames, a.name), {rig:rigSnapshot.identity,map:mapSnapshot.identity,pose:poseSnapshot.identity});
    if (a.build !== undefined) {
      // Built again where it will live, not copied: rigc's page paths are relative to the build (#18).
      rmSync(a.build, { recursive: true, force: true });
      const kept = buildInto(input.rig, join(scratch, 'with', 'motion.json'), resolve(a.build), a.profile, undefined, a.images);
      if (!kept.green) refuse([{ code: 'RIG_GATE', text: `rigc build into --build ${a.build} is red where the same build was green in scratch (exit ${kept.run.status}); nothing written` }, ...kept.fails.map((x) => ({ code: 'RIGC', text: x }))]);
    }
    // The kept build reads the rig again; its bytes must still match the report.
    assertReportInputs([rigSnapshot,mapSnapshot,poseSnapshot]);
    if (a.build !== undefined) {
      // #270: what made the build, beside it — the inputs as given with the bytes' hashes (the ones just
      // re-checked), the versions, the options; `reference` only when the author gave one.
      writeFileSync(join(a.build, PROVENANCE_FILE), provenanceText({
        rigc: rigc.version,
        rig: { path: a.rig, sha256: rigSnapshot.identity.sha256 },
        map: { path: a.map, sha256: mapSnapshot.identity.sha256 },
        sequence: { path: a.pose, sha256: poseSnapshot.identity.sha256, source: seq.source },
        name: a.name,
        options,
        ...(a.reference === undefined ? {} : { reference: a.reference }),
      }));
      say(`  RECORD ${PROVENANCE_FILE} written beside the build (reference: ${a.reference ?? 'none given'})`);
    }
    for (const [dir, flags] of makeDirs) {
      mkdirSync(dir, { recursive: true });
      tell(madeLine(dir, flags));
    }
    writeFileSync(a.out, `${JSON.stringify(motion, null, 2)}\n`);
    if (a.camera !== undefined) {
      const ss = r.figureScale.frames.map((x) => x.s);
      const minS = ss.length === 0 ? 1 : Math.min(...ss);
      const maxS = ss.length === 0 ? 1 : Math.max(...ss);
      writeFileSync(a.camera, `${JSON.stringify({
        spec: 'rig-pose-camera/1',
        rig: input.name,
        animation: a.name,
        frames: r.figureScale.frames.map((f, i) => {
          const cam = seq.camera?.[i];
          const camS = cam?.s ?? 1;
          return {
            frame: f.frame,
            t: f.t,
            s: f.s,
            rawS: f.rawS,
            tx: cam?.tx ?? 0,
            ty: cam?.ty ?? 0,
            videoS: Number((f.s * camS).toFixed(6)),
          };
        }),
        summary: {
          minS,
          maxS,
          maxStep: r.figureScale.maxStep,
          endOverStart: r.figureScale.endOverStart,
        },
      }, null, 2)}\n`);
    }
    if (a.render !== undefined && f.meshes !== null && f.frames !== '') {
      rmSync(a.render, { recursive: true, force: true });
      cpSync(f.frames, a.render, { recursive: true });
    }
    const previous = existsSync(report) ? statSync(report).mtime : null;
    writeFileSync(report, reportText);

    if (output === 'summary') for (const l of summaryLines({ gate: gateText, feet: feetReading, stance: r.stance, jitter, landings, times: r.times })) tell(`  ${l}`);
    if (a.camera !== undefined) tell(`  wrote ${a.camera} — camera track (${r.figureScale.frames.length} frames)`);
    tell(reportLine(report, a.report === undefined, previous));
    tell(`  wrote ${a.out} — animations: ${Object.keys(motion.animations).join(', ')}`);
    return { lines, written: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The GATE line's text: the profile and rig-c's own summary of the green build. */
export function gateLine(profile: string, summary: string | null): string {
  return `rigc build --profile ${profile}: green${summary === null ? '' : ` — ${summary}`}`;
}

/** The FEET lines of the posed build: the lowest ankle's range, and the supporting ankle's worst over the support spans. */
export function posedFeetLines(f: FeetReading): string[] {
  const out = [`the posed build, outside jumps: the lowest ankle's vertical range ${lowestText(f)} (rig leg r ${f.legLength.r.toFixed(1)}, l ${f.legLength.l.toFixed(1)} units) over ${f.lowest.frames} frames`];
  const plant = plantText(f);
  if (plant !== null) out.push(`the supporting ankle over each support span: ${plant}`);
  return out;
}

const lowestText = (f: FeetReading): string => `${f.lowest.range.toFixed(2)} units = ${f.lowest.legs.toFixed(4)} leg lengths`;

function plantText(f: FeetReading): string | null {
  const worst = (k: 'verticalLegs' | 'horizontalLegs') => f.plants.reduce<(typeof f.plants)[number] | null>((m, x) => (m === null || x[k] > m[k] ? x : m), null);
  const wv = worst('verticalLegs');
  const wh = worst('horizontalLegs');
  if (wv === null || wh === null) return null;
  return `worst vertical range ${wv.vertical.toFixed(2)} units = ${wv.verticalLegs.toFixed(4)} leg lengths (${wv.side} ${wv.frames[0]}–${wv.frames[1]}), worst horizontal drift ${wh.horizontal.toFixed(2)} units = ${wh.horizontalLegs.toFixed(4)} leg lengths (${wh.side} ${wh.frames[0]}–${wh.frames[1]})`;
}

/** What `--summary` reads (rig-c/pose#238): the same records the full lines print. */
export interface SummaryInput {
  gate: string;
  feet: FeetReading | null;
  stance: Stance | null;
  jitter: readonly JitterRow[];
  landings: readonly Landing[];
  times: readonly number[];
}

/**
 * `--summary`'s lines (rig-c/pose#238), one per measure, in the order a second
 * run is compared on: GATE (the GATE line), FEET (the posed build's two FEET
 * lines, joined), LIFT (the STANCE runs counted), JITTER (the JITTER rows' worst
 * ratio) and LAND (each landing kind's worst against its tolerance). Each figure
 * is formatted as the full line formats it, from the same record.
 */
export function summaryLines(x: SummaryInput): string[] {
  const out = [`GATE   ${x.gate}`];
  if (x.feet === null) out.push('FEET   not measured: the map maps no legs');
  else {
    const plant = plantText(x.feet);
    out.push(`FEET   lowest ankle's vertical range ${lowestText(x.feet)} over ${x.feet.lowest.frames} frames; supporting ankle ${plant ?? 'over no support span'}`);
  }
  if (x.stance === null) out.push('LIFT   not read (no --stance)');
  else {
    const own = x.stance.runs.filter((r) => r.absorbed !== true);
    const count = (state: Stance['runs'][number]['state']) => {
      const rs = own.filter((r) => r.state === state);
      return { runs: rs.length, frames: rs.reduce((t, r) => t + r.frames[1] - r.frames[0] + 1, 0), rs };
    };
    const lifted = count('lifted'), both = count('both'), below = count('below');
    const top = lifted.rs.reduce<Stance['runs'][number] | null>((m, r) => (m === null || r.maxHeight > m.maxHeight ? r : m), null);
    out.push(`LIFT   lifted ${lifted.runs} run(s), ${lifted.frames} frame(s)${top === null ? '' : `, highest ${top.maxHeight.toFixed(4)} leg lengths (${top.side} ${spanText(top.frames)})`}; planted both ${both.runs} run(s), ${both.frames} frame(s); below ${below.runs} run(s), ${below.frames} frame(s); ${x.stance.over.length} past the bounds`);
  }
  const read = x.jitter.filter((j) => j.ratio !== null);
  const worst = read.reduce<JitterRow | null>((m, j) => (m === null || j.ratio! > m.ratio! ? j : m), null);
  const still = x.jitter.filter((j) => j.triples > 0 && j.ratio === null).length;
  const unread = x.jitter.filter((j) => j.triples === 0).length;
  out.push(`JITTER ${x.jitter.length} bone(s): ${worst === null ? 'no ratio read' : `worst ${worst.ratio!.toFixed(2)}× on bone "${worst.bone}" (${worst.rig!.toFixed(4)}°/f² against its pair's ${worst.pair!.toFixed(4)}°/f²)`}; ${still} still pair(s), ${unread} not measured`);
  const kinds: Array<[Landing['kind'], string, string]> = [['angle', 'aim', '°'], ['origin', 'origin', ' units'], ['scale', 'scale', ' of its setup length'], ['foot', 'ankle', ' units']];
  const parts = kinds.flatMap(([kind, what, unit]) => {
    const ls = x.landings.filter((l) => l.kind === kind);
    if (ls.length === 0) return [];
    const w = ls.reduce((m, l) => (l.worst > m.worst ? l : m));
    const tol = kind === 'foot' ? Number(w.tolerance.toPrecision(3)) : w.tolerance;
    return [`${what} ${ls.length}, worst ${w.worst.toPrecision(3)}${unit} on bone "${w.bone}" at frame ${w.frame} (t=${x.times[w.frame]!.toFixed(3)}s), tolerance ${tol}${unit}`];
  });
  out.push(`LAND   ${x.landings.length} landed: ${parts.join('; ') || 'none'}`);
  return out;
}

const spanText = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);

/**
 * The retarget's rotate tracks (and with a hip tolerance, its translate) thinned
 * in place (#32), on the final keys: the plant, the one floor, the stretches and
 * the in-place closure all live inside `retarget`, so they are done (#94). Kept
 * regardless, per bone: the frames either side of each switch boundary on the
 * chains it changes, and the edges of every FLIP spread, SHORT span and RANGE
 * run on it (the first and last frame the reducer keeps).
 *
 * With `keepPlanted` (#251): every frame of each support span, on every mapped
 * bone from the hip down to that side's ankle — kept frames are keyed at their
 * target, so the planted ankle lands as dense there, but for the hip's own
 * tolerance.
 *
 * With scaled bones (`--leg-scale`, the stretches; #94): a scaled bone's
 * `scalex` is thinned within `SCALE_REDUCE`, and a mapped bone under a scaled
 * bone — keyed through its parent's posed matrix (legs.ts) — is re-solved
 * through its parent as reduced and thinned with its error read as the world
 * aim and length it lands on (`reduceUnderScale`). With none, this is #32's
 * reduction, unchanged.
 */
function reduceTracks(r: ReturnType<typeof retarget>, map: JointMap, rest: Rest, tolerance: number, hipTolerance: number | undefined, keepPlanted: boolean, tolOf: (bone: string) => number = () => tolerance): Reduced {
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
  if (keepPlanted && r.feet !== null && r.ankles !== null) {
    for (const s of r.feet.supports) {
      const frames = Array.from({ length: s.frames[1] - s.frames[0] + 1 }, (_, k) => s.frames[0] + k);
      for (let b: string | null = r.ankles.bones[s.side]; b !== null; b = rest.get(b)!.parent) {
        if (mapped.has(b)) add(b, ...frames);
        if (b === r.origin?.bone) break;
      }
    }
  }
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
  // #283: a bone whose chain --reduce names carries its own tolerance; every other takes the run's.
  const own = (b: string): { tolerance?: number } => (tolOf(b) === tolerance ? {} : { tolerance: tolOf(b) });
  const bones: ReduceBone[] = [...rotate.values()].filter((tr) => !under(tr.bone)).map((tr) => ({ bone: tr.bone, above: above(tr.bone), dense: dense.get(tr.bone)!, keep: keep.get(tr.bone) ?? new Set<number>(), ...own(tr.bone) }));
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

  // #116: smooth the trunk-and-head chain within the stated tolerance while keeping limb landings and jitter within 0.04.
  const trunkBones = new Set(
    map.chains
      .filter((c) => c.bones.length === 1 && !(c.joints.includes('r_hip') && c.joints.includes('l_hip')))
      .map((c) => c.bones[0]!),
  );
  smoothTrunk(r.times, bones, tolerance, out, trunkBones);
  for (const [bone, keys] of out.rotate) rotate.get(bone)!.keys = keys;

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
  const noScaleOf = (b: string): 'noScale' | 'noScaleOrReflection' | undefined => {
    const inh = rest.get(b)!.inherit;
    return inh === 'noScale' || inh === 'noScaleOrReflection' ? inh : undefined;
  };
  const given: UnderBone[] = underBones.map((b) => {
    if (!scalex.has(b)) throw new Refusal([{ code: 'POSE_REDUCE', text: `bone "${b}" hangs under a scaled bone and has no scalex track, so it was not keyed through its parent's posed matrix; --reduce re-solves only a bone the legs keyed that way` }]);
    // Up through the unmapped bones between (their setup locals, or their noScale unit frames, #153), to a bone given before it or one the key formula holds for.
    let via: M2 = M2_IDENTITY;
    const steps: Array<{ wp0: M2; w0: M2; inherit?: 'noScale' | 'noScaleOrReflection' }> = [];
    let p = rest.get(b)!.parent!;
    while (under(p) && !mapped.has(p)) {
      const wp0 = world0(rest.get(p)!.parent!);
      const w0 = world0(p);
      via = mulM2(setupLocal(wp0, w0), via);
      const inherit = noScaleOf(p);
      steps.unshift({ wp0, w0, ...(inherit !== undefined ? { inherit } : {}) });
      p = rest.get(p)!.parent!;
    }
    const viaSteps = steps.some((st) => st.inherit !== undefined) ? { steps } : {};
    const parent: UnderBone['parent'] = under(p) ? { under: p, via, ...viaSteps } : { rigid: { turn: turnOf(p), world0: world0(p), scale: scaleAt.get(p) ?? new Array<number>(n).fill(1) }, via, ...viaSteps };
    const wp0 = world0(rest.get(b)!.parent!);
    const w0 = world0(b);
    const inherit = noScaleOf(b);
    return {
      bone: b,
      parent,
      local: setupLocal(wp0, w0),
      ...(inherit !== undefined ? { wp0, w0, inherit } : {}),
      len0: Math.hypot(w0[0], w0[2]),
      target: r.targets.get(b)!,
      asked: r.scales.get(b) ?? new Array<number>(n).fill(1),
      dense: dense.get(b)!,
      keep: keepOf(b),
      ...own(b),
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
export function footReduce(rest: Rest, r: ReturnType<typeof retarget>, ankle: string, tolerance: number, hipTolerance: number | undefined, tolOf?: (bone: string) => number): number {
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
  const deg = tolOf === undefined ? tolerance : legTolerance(rest, r, ankle, tolOf);
  return (hipTolerance ?? 0) + lever * sMax * ((deg * Math.PI) / 180 + SCALE_REDUCE);
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
  higher: 'the only foot free to take support was the higher one',
};
function loweredLine(lowered: readonly Lowered[]): string {
  const side = (s: Side | null) => s ?? 'none';
  const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
  const head = `support read from the lower ankle (a foot ≥ ${PLANT_SWITCH} leg lengths higher than the other does not take support, rig-c/pose#113)`;
  if (lowered.length === 0) return `${head}: no frame reads differently from before`;
  const frames = lowered.reduce((k, x) => k + x.frames[1] - x.frames[0] + 1, 0);
  return `${head}: ${frames} frame(s) read differently from before — ${lowered.map((x) => `frames ${span(x.frames)} ${side(x.was)} → ${side(x.now)}${x.cause === undefined ? '' : ` (${CAUSE[x.cause]})`}`).join(', ')}`;
}

/**
 * The support-signal lines (rig-c/pose#280). On a clip read as frontal: two
 * lines — how often the ankle's vertical speed contradicts ankle height against
 * `FRONTAL_DISAGREE`, and where the stride shows (in depth) — then one line per
 * support span (a stride) naming the signal that decided its frames and what
 * ankle height alone would have read. On any other clip ankle height decided as
 * before and nothing is printed: the output of a clip the second signal does not
 * decide stays as it was, in every mode (`Feet.signal` still carries the figures).
 */
export function signalLines(sig: SupportSignal, supports: Feet['supports']): string[] {
  const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
  const n = Math.round(FRONTAL_DISAGREE * 100);
  const pct = sig.read === 0 ? 0 : (100 * sig.contradict.length) / sig.read;
  const ranges = `x · y against the hips: r ${sig.range.r.x.toFixed(1)} · ${sig.range.r.y.toFixed(1)} px, l ${sig.range.l.x.toFixed(1)} · ${sig.range.l.y.toFixed(1)} px`;
  const contra = `${sig.contradict.length} of ${sig.read} frame(s) (${pct.toFixed(1)} %`;
  if (!sig.frontal) {
    // rig-c/pose#379: the one case named — the clip contradicts past the share and strides in depth, but its ground does not move enough for the speed to tell a still ankle from it.
    const inDepth = (['r', 'l'] as const).every((s) => sig.range[s].y > sig.range[s].x);
    if (sig.groundResolved || !inDepth || sig.read === 0 || !(sig.contradict.length > FRONTAL_DISAGREE * sig.read)) return [];
    const ground = `feet ${sig.ground.r.toFixed(2)} · ${sig.ground.l.toFixed(2)} px, hips ${sig.hipStep.toFixed(2)}`;
    return [`support: ankle height — vertical speed contradicts it on ${contra}, past ${n} %) but the ground moves under ${STILL_SPEED} leg lengths a frame (${ground}): a still ankle reads as ground, so it cannot decide (rig-c/pose#379)`];
  }
  const out = [
    `support: ankle vertical speed (rig-c/pose#280) — it contradicts ankle height on ${contra}, past ${n} %): the lower ankle moving while the higher moves with the ground`,
    `support: read as a frontal view — ankles move more in y than x (${ranges}); ankle height only where neither foot moves with the ground`,
  ];
  for (const sp of supports) {
    let speed = 0;
    let height = 0;
    let both = 0;
    let differ = 0;
    const was = new Set<string>();
    for (let i = sp.frames[0]; i <= sp.frames[1]; i++) {
      if (sig.by[i] === 'speed') speed++;
      else if (sig.by[i] === 'height') height++;
      if (sig.contact[i] === 'both') both++;
      if (sig.height[i] !== sp.side) {
        differ++;
        was.add(sig.height[i] ?? 'none');
      }
    }
    const by = speed > 0 ? `ankle vertical speed on ${speed} frame(s)${height > 0 ? `, ankle height on ${height} (neither foot moved with the ground)` : ''}` : `ankle height on ${height} frame(s) (neither foot moved with the ground)`;
    const alone = differ === 0 ? 'ankle height alone reads the same' : `ankle height alone would read ${[...was].join(' or ')} on ${differ} of them`;
    out.push(`stride ${sp.side} ${span(sp.frames)}: ${by} (both feet down on ${both}); ${alone}`);
  }
  return out;
}

/**
 * The in-place line without --plant-feet (rig-c/pose#242): what the declaration still changes, and the one thing it
 * cannot without planted feet — the loop closure, which spreads back the planted hip's drift. `drift` is the
 * translated bone's x on the last frame less the first (null: the map translates no bone).
 */
export function openTravelLine(drift: number | null): string {
  const hip = drift === null ? 'and the map translates no bone' : `so the hip follows the pose's own travel: x ${drift >= 0 ? '+' : ''}${drift.toFixed(2)} units from the first frame to the last, not closed`;
  return `sequence declares travel: ${TRAVEL_IN_PLACE} but --plant-feet is off — its supports and the head nod are read in place as with it; the loop closure is --plant-feet's (it closes the planted hip), ${hip}`;
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
 * The STANCE lines (#60): one per run of planted-both, lifted or (#114) below
 * frames, with the tolerance and the stretch keyed; one per run a stretch was
 * capped.
 */
export function stanceLines(st: Stance, times: readonly number[], unit?: StanceUnit): string[] {
  const span = (x: [number, number]) => (x[0] === x[1] ? `frame ${x[0]} (t=${times[x[0]]!.toFixed(3)}s)` : `frames ${x[0]}–${x[1]} (t=${times[x[0]]!.toFixed(3)}–${times[x[1]]!.toFixed(3)}s)`);
  const tol = unit === undefined ? `the tolerance ${st.tolerance} leg lengths` : `the tolerance ${st.tolerance} leg lengths (${pxPair(st.tolerance, unit.legLength)})`;
  // #237: what the tolerance is in px and in LEG-SCALE's straight length, and that "kept" is true only where no clamp moved the ankle.
  const kept = (r: Stance['runs'][number]): string => {
    if (r.moved === undefined) return "the pose's height kept";
    const all = r.frames[1] - r.frames[0] + 1;
    const head = r.moved.count === all ? `the pose's height not kept on any of its ${all} frame(s)` : `the pose's height kept on ${all - r.moved.count} of its ${all} frame(s)`;
    return `${head}; on ${r.moved.count} (frames ${r.moved.frames.map(spanOf).join(', ')}) --leg-scale's clamps moved the free ankle off it, ${shiftText(r.moved, unit, "the pose's")}`;
  };
  const release = `planted again under ${st.release} of it, ${(st.release * st.tolerance).toFixed(4)}`;
  const NAME: Record<Stance['runs'][number]['state'], string> = { both: 'planted-both', lifted: 'lifted', below: 'below' };
  // An absorbed run lies inside a run of the state it took; the line names that state.
  const around = (r: Stance['runs'][number]) => st.runs.find((x) => x.absorbed !== true && x.side === r.side && x.frames[0] <= r.frames[0] && r.frames[1] <= x.frames[1]);
  const other = (r: Stance['runs'][number]) => NAME[around(r)?.state ?? (r.state === 'both' ? 'lifted' : 'both')];
  const where = (r: Stance['runs'][number]) => (r.state === 'below' ? `its ankle up to ${r.maxDepth!.toFixed(4)} leg lengths below the supporting one in the picture` : `its ankle up to ${r.maxHeight.toFixed(4)} leg lengths above the supporting one in the picture`);
  const out = st.runs.map((r) => (r.absorbed === true
    ? `absorbed: free foot ${r.side} ${span(r.frames)} — read ${r.state === 'both' ? 'planted both' : r.state === 'below' ? 'past the tolerance below' : 'lifted'} (${where(r)}; ${tol}, ${release}) for ${r.frames[1] - r.frames[0] + 1} frame(s), under ${st.minSeconds} s between two ${other(r)} runs; it takes their state`
    : r.state === 'both'
    ? `planted both: free foot ${r.side} ${span(r.frames)} — its ankle up to ${r.maxHeight.toFixed(4)} leg lengths above the supporting one in the picture, within ${tol}; its leg stretched by k ${r.k!.min === r.k!.max ? r.k!.max.toFixed(4) : `${r.k!.min.toFixed(4)} … ${r.k!.max.toFixed(4)}`} (largest ${r.k!.max.toFixed(4)})`
    : r.state === 'below'
    ? `past the tolerance below: free foot ${r.side} ${span(r.frames)} — ${where(r)}, past ${tol} (${release}); a free foot that far below the supporting one is a support error, not a stance: never planted both, ${kept(r)}`
    : `lifted: free foot ${r.side} ${span(r.frames)} — ${where(r)}, over ${tol} (${release}); ${kept(r)}`));
  if (unit !== undefined) out.unshift(stanceUnitLine(st.tolerance, unit));
  if (st.range !== undefined) out.push(legRangeLine('free', st.range, st.bounds));
  for (const o of st.over) out.push(`past the bounds: free foot ${o.side} ${span(o.frames)} — ${o.needed === null ? 'its ankle is not below its leg\'s root, so no stretch reaches the floor' : `the floor needed k ${o.needed.toFixed(4)}, past ${boundText(o.bound ?? st.bounds)}; held at the bound`}, the foot left up to ${o.left.toFixed(2)} units from the floor`);
  return out;
}

/** The units the STANCE lines print against (rig-c/pose#237): FEET's leg length, the straight leg, and the rig's leg at setup. */
export interface StanceUnit {
  /** FEET's: each side's median picture length hip → ankle, px. */
  legLength: Record<Side, number>;
  /** Each side's 95th-percentile picture length hip → ankle, px. */
  straight: Record<Side, number>;
  /** Each side's rig leg at setup, thigh origin → ankle, world units. */
  rigLeg: Record<Side, number> | null;
}

const spanOf = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);

/** `v` leg lengths in each side's px: `r 10.5 / l 10.6 px`. */
function pxPair(v: number, legLength: Record<Side, number>): string {
  return `r ${(v * legLength.r).toFixed(1)} / l ${(v * legLength.l).toFixed(1)} px`;
}

/** The STANCE unit line (rig-c/pose#237): --stance in FEET's leg length, in px and as a share of the straight leg LEG-SCALE's percentile reads. */
export function stanceUnitLine(tolerance: number, u: StanceUnit): string {
  const share = (s: Side) => (tolerance * u.legLength[s]) / u.straight[s];
  return `unit: --stance ${tolerance} is in FEET's leg length (each side's median picture length hip → ankle, r ${u.legLength.r.toFixed(1)} / l ${u.legLength.l.toFixed(1)} px), not a straight length (a 95th percentile, as LEG-SCALE reads a segment's: the straight leg hip → ankle r ${u.straight.r.toFixed(1)} / l ${u.straight.l.toFixed(1)} px): ${tolerance} leg lengths = ${pxPair(tolerance, u.legLength)} = r ${share('r').toFixed(4)} / l ${share('l').toFixed(4)} of the straight leg`;
}

/** A free ankle's shift by the clamps, in its rig leg and in FEET's px: `up to 0.1500 leg lengths (22.6 px) above, up to … below`. */
function shiftText(m: FreeAnkleShift, unit: { legLength: Record<Side, number> | null; rigLeg: Record<Side, number> | null } | undefined, against: string): string {
  const one = (x: { legLengths: number }, way: string) => `up to ${x.legLengths.toFixed(4)} leg lengths${unit?.legLength == null ? '' : ` (${(x.legLengths * unit.legLength[m.side]).toFixed(1)} px of FEET's)`} ${way}`;
  const parts = [...(m.above === null ? [] : [one(m.above, `above ${against}`)]), ...(m.below === null ? [] : [one(m.below, `below ${against}`)])];
  const leg = unit?.rigLeg == null ? '' : ` (leg lengths: the rig's ${m.side} leg at setup, thigh origin → ankle, ${unit.rigLeg[m.side].toFixed(1)} units)`;
  return `${parts.length === 0 ? `by 0 leg lengths, at ${against}` : parts.join(' and ')}${leg}`;
}

/** The FEET segment line (rig-c/pose#237): a mapped leg segment's picture length ÷ straight, read with or without --leg-scale. */
export function segmentLine(sg: LegSegmentRatio): string {
  const head = `segment chain "${sg.chain}" bone "${sg.bone}" (${sg.joints[0]} → ${sg.joints[1]})`;
  if (sg.straight === null || sg.ratio === null) return `${head}: picture length ÷ straight not measured — ${sg.why ?? 'no straight length'}`;
  return `${head}: picture length ÷ straight length (${sg.straight.toFixed(1)}px, the one --leg-scale scales against) min ${sg.ratio.min.toFixed(4)} · median ${sg.ratio.median.toFixed(4)} · max ${sg.ratio.max.toFixed(4)} — the scale --leg-scale asks before its clamp, read with or without it`;
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

/** A LEG-SCALE line: the segment, its straight length, its ratio's spread, and the frames clamped (with the asked value, #225). */
export function legScaleLine(l: LegScale, times: readonly number[], legLength: Record<Side, number> | null = null, rigLeg: Record<Side, number> | null = null): string {
  const span = (x: [number, number]) => (x[0] === x[1] ? `${x[0]}` : `${x[0]}–${x[1]}`);
  const count = (rs: Array<[number, number]>) => rs.reduce((k, x) => k + x[1] - x[0] + 1, 0);
  const val = (r: { min: number; max: number }) => (r.min.toFixed(3) === r.max.toFixed(3) ? r.min.toFixed(3) : `${r.min.toFixed(3)}–${r.max.toFixed(3)}`);
  const askedOf = (x: [number, number], kind: 'low' | 'high'): string => {
    const c = l.clamped?.find((r) => r.limit === kind && r.frames[0] === x[0] && r.frames[1] === x[1]);
    if (c !== undefined) return `asked ${val(c.asked)}`;
    const sub = l.asked.slice(x[0], x[1] + 1);
    return sub.length === 0 ? '' : `asked ${val({ min: Math.min(...sub), max: Math.max(...sub) })}`;
  };
  const clamp = (rs: Array<[number, number]>, at: number, how: string, kind: 'low' | 'high') => {
    if (rs.length === 0) return `none ${how} ${at}`;
    const detail = rs.length === 1 ? ` (${askedOf(rs[0]!, kind)})` : ` (${rs.map((x) => `${span(x)}: ${askedOf(x, kind)}`).join(', ')})`;
    return `${count(rs)} frame(s) ${how} ${at}, clamped (frames ${rs.map(span).join(', ')})${detail}`;
  };
  // #237: the straight length against FEET's leg length, the limits in px, and what the clamps did to a free ankle.
  const side: Side = l.joints[0].startsWith('r_') ? 'r' : 'l';
  const share = legLength === null ? '' : ` = ${(l.straight / legLength[side]).toFixed(3)} of FEET's leg length (median hip → ankle, ${side} ${legLength[side].toFixed(1)}px)`;
  const limitsPx = `${(l.limits[0] * l.straight).toFixed(1)}–${(l.limits[1] * l.straight).toFixed(1)}px`;
  const clampedFrames = count(l.low) + count(l.high);
  const free = l.free !== undefined
    ? `; its leg free (the other foot supporting) on ${l.free.count} of its ${clampedFrames} clamped frame(s) (frames ${l.free.frames.map(span).join(', ')}): the clamps on that leg left the free ankle ${shiftText(l.free, { legLength, rigLeg }, "the picture's (the leg at picture length ÷ straight)")}`
    : clampedFrames > 0 && legLength !== null ? `; its leg free on none of its ${clampedFrames} clamped frame(s)` : '';
  return `chain "${l.chain}" bone "${l.bone}" (${l.joints[0]} → ${l.joints[1]}): straight length ${l.straight.toFixed(1)}px (larger 95th percentile of ${times.length} frames, both legs)${share}; picture length ÷ straight ${l.ratio.min.toFixed(3)} … ${l.ratio.max.toFixed(3)} (median ${l.ratio.median.toFixed(3)}); scalex keyed in [${l.limits[0]}, ${l.limits[1]}] of the straight length (${limitsPx}): ${clamp(l.low, l.limits[0], 'under', 'low')}; ${clamp(l.high, l.limits[1], 'over', 'high')}${free}`;
}

/**
 * rig-c/pose#287: when `--leg-scale`'s range clamps no frame on any leg segment
 * (no run under the floor, none over the ceiling, no supporting frame scaled past
 * the floor), the clause naming the range and the picture's own spread across
 * every segment, so a reader learns the range never bound and what floor would.
 * Null when any frame was clamped, or with no segment scaled.
 */
export function legScaleNoClamp(ls: readonly LegScale[]): string | null {
  if (ls.length === 0 || ls.some((l) => l.low.length > 0 || l.high.length > 0 || (l.support ?? []).length > 0)) return null;
  const [floor, ceiling] = ls[0]!.limits;
  const min = Math.min(...ls.map((l) => l.ratio.min));
  const max = Math.max(...ls.map((l) => l.ratio.max));
  return `no frame clamped on any leg segment: the range [${floor}, ${ceiling}] holds the picture's whole spread, picture length ÷ straight ${min.toFixed(3)} … ${max.toFixed(3)} over the ${ls.length} segment(s), so each segment is scaled to the picture on every frame; a floor above ${min.toFixed(3)} would clamp`;
}

/** A LEG-SCALE past the floor (support) line (rig-c/pose#133): the supporting leg segment scaled below `--leg-scale`'s floor down to #95's bound. */
export function supportScaleLine(l: LegScale, s: SupportScaleRun, times: readonly number[]): string {
  const span = (x: [number, number]) => (x[0] === x[1] ? `frame ${x[0]} (t=${times[x[0]]!.toFixed(3)}s)` : `frames ${x[0]}–${x[1]} (t=${times[x[0]]!.toFixed(3)}–${times[x[1]]!.toFixed(3)}s)`);
  const val = (r: { min: number; max: number }) => (r.min === r.max ? r.min.toFixed(4) : `${r.min.toFixed(4)}–${r.max.toFixed(4)}`);
  if (s.clamped !== undefined) {
    return `past the floor (support): chain "${l.chain}" bone "${l.bone}" (supporting foot ${s.side}) ${span(s.frames)} — asked ${val(s.asked)} under ${l.limits[0]}, clamped at the leg's own range ${s.clamped.bound.toFixed(4)} (#95), used ${val(s.used)}; hip rose by up to +${s.clamped.hipRise.toFixed(2)} units (never sinks)`;
  }
  return `past the floor (support): chain "${l.chain}" bone "${l.bone}" (supporting foot ${s.side}) ${span(s.frames)} — asked ${val(s.asked)} under ${l.limits[0]}, used ${val(s.used)} (within the leg's own range, #95; ankle stays on the floor)`;
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

/** File-bound identities are assembled only in this existing IO boundary. */
export interface ReportInputSnapshot {file:string;bytes:Buffer;identity:ReportInput;size:number;mtimeMs:number}
export function readReportInput(file:string):ReportInputSnapshot {
  const path=realpathSync(resolve(file)),before=statSync(path),bytes=readFileSync(path),after=statSync(path);
  if(!before.isFile()||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Refusal([{code:'REPORT_INPUTS',text:`${file}: input changed while reading; expected one stable regular file`}]);
  return {file:resolve(file),bytes,identity:{path:relative(process.cwd(),path).split('\\').join('/'),sha256:createHash('sha256').update(bytes).digest('hex')},size:after.size,mtimeMs:after.mtimeMs};
}
export function assertReportInputs(inputs:readonly ReportInputSnapshot[]):void {
  for(const expected of inputs){const current=readReportInput(expected.file);if(current.identity.path!==expected.identity.path||current.identity.sha256!==expected.identity.sha256)throw new Refusal([{code:'REPORT_INPUTS_CHANGED',text:`${expected.identity.path}: consumed input changed before output writes; expected SHA-256 ${expected.identity.sha256}, found ${current.identity.sha256}`}]);}
}

/**
 * #216: the seam reading end to end — the declared pairs, each pair whose part
 * has no slot of its name left unread (rigc would refuse the whole render for
 * it), one `rigc render --seam` over the rest, and its projection. Whatever it
 * finds, or fails to read, it says so and refuses nothing.
 */
function readSeams(decl: { path: string; pairs: SeamPair[] } | null, rig: string, slotNames: string[], build: string, animation: string, dir: string, fps: number): ReturnType<typeof projectSeams> & { lines: string[]; frames: unknown } {
  if (decl === null || decl.pairs.length === 0) {
    let why: string;
    if (decl !== null) why = `${decl.path} holds no limb segment below another (a part's "limb" record), so it declares no pair`;
    else {
      // @rig-c/parts writes rig/ and parts.json side by side under its --out; a rig spec itself carries no pair.
      const home = dirname(dirname(rig));
      why = `a rig spec carries none and no --parts was named${existsSync(join(home, 'parts.json')) ? ` (${home} holds parts.json: --parts ${home} reads its limbs)` : ''}`;
    }
    return { seams: [], seamPairs: [], frames: null, lines: [`no neighbour pair declared — ${why}; seams: []`] };
  }
  const have = new Set(slotNames);
  const unread = new Map<string, string>();
  for (const p of decl.pairs) {
    const missing = [p.a, p.b].filter((n) => !have.has(n));
    if (missing.length > 0) unread.set(p.pair, `${missing.map((n) => `part "${n}"`).join(' and ')} has no slot of its name in the rig (a part is drawn by the slot of its name)`);
  }
  const toRead = decl.pairs.filter((p) => !unread.has(p.pair));
  let rows: ReturnType<typeof readSeamDoc> = [];
  let frames: unknown = null;
  if (toRead.length > 0) {
    const s = seamRender(build, animation, dir, fps, toRead.map((p) => [p.a, p.b] as const));
    let why: string | null = null;
    if (s.seam === null) {
      const said = s.run.out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('rigc: ') && !l.startsWith('rigc: wrote'));
      why = `rigc render --seam did not read (exit ${s.run.status})${said === undefined ? '' : `: ${said}`}`;
    } else {
      try {
        rows = readSeamDoc(s.seam.text, s.seam.path);
        frames = s.frames;
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        why = e.message;
      }
    }
    if (why !== null) for (const p of toRead) unread.set(p.pair, why);
  }
  const projected = projectSeams(decl.pairs, rows, unread);
  return { ...projected, frames, lines: seamLines(projected, fps) };
}

/** rig-c/pose#239: the report's path when --report is not given — `<out>.report.json`, beside the motion (a trailing `.json` of --out is replaced). */
export function defaultReportPath(out: string): string {
  return `${out.endsWith('.json') ? out.slice(0, -'.json'.length) : out}.report.json`;
}

/** rig-c/pose#239: the report's `wrote` line — whether it was the default, and the mtime of the report it replaced. */
export function reportLine(report: string, byDefault: boolean, previous: Date | null): string {
  return `  wrote ${report} — the run's report (rig-pose-report/1)${byDefault ? ', beside --out by default; name another path with --report' : ''}${previous === null ? '' : `; it replaced the report there last written ${previous.toISOString()}`}`;
}

/**
 * rig-c/pose#239: `--rig` naming a rig.json reads no motion spec, even with one beside it. When the base
 * gate is red that way, the refusal says the motion beside it was not read and names the two forms that read it.
 */
export function unreadMotionHint(rigArg: string, motion: string | null): string {
  if (motion !== null) return '';
  const beside = join(dirname(rigArg), 'motion.json');
  if (!existsSync(beside) || statSync(rigArg).isDirectory()) return '';
  return `; ${beside} is beside it and was not read — --rig naming the rig.json reads no motion spec: pass --rig ${dirname(rigArg)} (the directory, which reads the motion.json beside its rig.json) or --base-motion ${beside}`;
}

/**
 * rig-c/pose#250: the same reading when the base gate is green — the run goes on, and --out would carry
 * none of the rig's own animations without a word. One line, whatever the gate said; null when nothing was left unread.
 */
export function unreadMotionLine(rigArg: string, motion: string | null): string | null {
  if (motion !== null) return null;
  const beside = join(dirname(rigArg), 'motion.json');
  if (!existsSync(beside) || statSync(rigArg).isDirectory()) return null;
  return `${beside} is beside ${rigArg} and was not read — --rig naming the rig.json reads no motion spec, so --out carries none of the rig's own animations: pass --rig ${dirname(rigArg)} (the directory, which reads the motion.json beside its rig.json) or --base-motion ${beside}`;
}

/** The SCALE line's own clause (rig-c/pose#240): the median it divides by, against the segment at its longest. */
export function segmentClause(f: ScaleFit): string {
  const sg = f.segment;
  return `the median is ${sg.ratio.toFixed(3)} of its 95th percentile ${sg.straight.toFixed(2)} — under 1, the median frame foreshortens ${sg.joints[0]} → ${sg.joints[1]} and the factor is ${(1 / sg.ratio).toFixed(3)}× the one at its longest`;
}

/**
 * The SCALE reading's remedy lines (rig-c/pose#240): the scale segment's median
 * against its 95th percentile, the legs' and hips' bands beside the factor (and
 * the line naming a factor outside both), and the hip's travel, pose beside rig.
 */
export function scaleFitLines(factor: number, f: ScaleFit): string[] {
  const out: string[] = [];
  const sg = f.segment;
  const band = (b: ScaleBand) => `${b.lo.toFixed(5)}–${b.hi.toFixed(5)}`;
  const within = (w: boolean) => (w ? 'within' : 'outside');
  const leg = f.leg === null ? 'leg not read (needs both legs)' : `leg ${band(f.leg.band)} (${within(f.leg.within)})`;
  const hip = f.hip === null ? 'hip not read (needs both legs and both hips)' : `hip ${band(f.hip.band)} (${within(f.hip.within)})`;
  out.push(`bands, rig ÷ picture at its 95th percentile – median: ${leg}, ${hip}; scale.factor ${factor.toFixed(5)} (within: rig ÷ factor inside the picture's lengths ± 1 px)`);
  if (f.outside === true) {
    out.push(`outside both bands: scale.factor ${factor.toFixed(5)} sizes the figure as neither its legs nor its hips do — "translate" "scale" ${sg.joints[0]} → ${sg.joints[1]} is proportioned unlike the rig; a pair on the legs or hips reads inside a band`);
  }
  const t = f.travel;
  const per = (v: { legs: [number, number] | null; hips: [number, number] | null }, k: 0 | 1) => `${v.legs === null ? '' : ` = ${v.legs[k].toFixed(3)} legs`}${v.hips === null ? '' : ` = ${v.hips[k].toFixed(3)} hips`}`;
  out.push(`hip travel (${t.joint} → bone "${t.bone}"), range: pose x ${t.pose.x.toFixed(2)}px${per(t.pose, 0)}, y ${t.pose.y.toFixed(2)}px${per(t.pose, 1)}; rig x ${t.rig.x.toFixed(2)}${per(t.rig, 0)}, y ${t.rig.y.toFixed(2)}${per(t.rig, 1)}`);
  return out;
}

/**
 * The SHEAR line's remedy clause (rig-c/pose#240): where the shear comes from
 * and the rig spec's `inherit` setting that removes it. Nothing on a shear that
 * prints as 0.00°, the line's own precision.
 */
export function shearRemedy(x: { bone: string; shear: number }, rest: Rest, measured: ReadonlyArray<{ bone: string }>): string {
  if (x.shear.toFixed(2) === '0.00') return '';
  const b = rest.get(x.bone);
  if (b === undefined) return '';
  const inherit = b.inherit ?? 'normal';
  const parent = b.parent;
  const carried = parent !== null && measured.some((m) => m.bone === parent);
  if (inherit === 'normal' && carried) {
    return `; it inherits "normal" from scaled "${parent}" — "inherit": "noScale" on bone "${x.bone}" in the rig spec unshears its art and still turns it with "${parent}" ("onlyTranslation" also stops the turn)`;
  }
  if (inherit !== 'normal') return `; bone "${x.bone}" inherits "${inherit}", so the shear is not carried from "${parent ?? 'its parent'}"`;
  return `; its parent ${parent === null ? 'is none' : `"${parent}" is not scaled`}, so the shear is not carried from above`;
}

/** rig-c/pose#240: how far --reduce may leave one ankle off the dense run's, as the landing check applies it. */
export interface AnkleDrift {
  /** The ankle point, as its LAND line names it (`<bone>:tip`). */
  bone: string;
  side: 'r' | 'l' | null;
  /** The plant's own tolerance (without --reduce). */
  plant: number;
  /** `footReduce`: the most the reduced bones above it may move it. */
  reduce: number;
  /** plant + reduce, world units — the LAND line's tolerance. */
  units: number;
  /** `units` in that side's rig leg at setup (thigh origin → ankle); null without both legs. */
  legLengths: number | null;
  /**
   * With --reduce-keep-planted (#251): the allowance on the frames its side supports, kept dense —
   * the plant's plus the hip's --reduce-hip (`reduce`, 0 without it); null when its side never supports.
   * Absent without the flag.
   */
  support?: { reduce: number; units: number; legLengths: number | null } | null;
  /** rig-c/pose#283: under a per-chain --reduce, the largest tolerance a bone from the hip down to it was reduced within (degrees). */
  legTolerance?: number;
}

/** #251: each side's support frames, from the spans --plant-feet read. */
function supportFrames(supports: ReadonlyArray<{ side: 'r' | 'l'; frames: [number, number] }>): Record<'r' | 'l', Set<number>> {
  const out = { r: new Set<number>(), l: new Set<number>() };
  for (const s of supports) for (let i = s.frames[0]; i <= s.frames[1]; i++) out[s.side].add(i);
  return out;
}

/** The drift line: the allowance on one frame, and what it lets a planted ankle slide between two. */
export function ankleDriftLine(d: AnkleDrift): string {
  const chainDeg = d.legTolerance;
  const legs = (v: number) => (d.legLengths === null ? '' : ` = ${(d.legLengths * v / d.units).toPrecision(3)} leg lengths`);
  const line = `ankle drift allowed: bone "${d.bone}" ${d.units.toPrecision(3)} units${legs(d.units)} on any one frame (plant ${d.plant.toPrecision(3)} + reduce ${d.reduce.toPrecision(3)}); between two frames up to ${(2 * d.units).toPrecision(3)} units${legs(2 * d.units)}`;
  if (d.support === undefined) return `${line} — ${chainDeg === undefined ? 'a tighter slide bar needs a smaller --reduce' : `its leg reduced within ${chainDeg}° (--reduce <deg>,<chain>=<deg>); a tighter slide bar needs a smaller one on its chain`}`;
  if (d.support === null) return `${line}; its side never supports, so --reduce-keep-planted keeps no frame of it`;
  const s = d.support;
  const sLegs = (v: number) => (s.legLengths === null ? '' : ` = ${(s.legLengths * v / s.units).toPrecision(3)} leg lengths`);
  return `${line} off its support frames; on them, kept dense (--reduce-keep-planted), ${s.units.toPrecision(3)} units${sLegs(s.units)} (plant ${d.plant.toPrecision(3)} + hip ${s.reduce.toPrecision(3)}), between two frames of a support span up to ${(2 * s.units).toPrecision(3)} units${sLegs(2 * s.units)}`;
}

/** rig-c/pose#283: the largest tolerance any bone from `ankle` up to the legs' top was reduced within. */
export function legTolerance(rest: Rest, r: ReturnType<typeof retarget>, ankle: string, tolOf: (bone: string) => number): number {
  const top = r.origin?.bone ?? null;
  let deg = tolOf(ankle);
  for (let b: string | null = rest.get(ankle)!.parent; b !== null && b !== top; b = rest.get(b)!.parent) deg = Math.max(deg, tolOf(b));
  return deg;
}

/**
 * rig-c/pose#283: the reduction's tolerance per bone. Every bone takes `tolerance`
 * but a bone of a chain `chains` names, which takes that chain's (the smallest,
 * when two named chains list it). A name the map has no chain for is refused by
 * name, beside the chains it has.
 */
export function reduceTolerances(map: JointMap, tolerance: number, chains: Record<string, number> | undefined, mapPath: string): (bone: string) => number {
  if (chains === undefined) return () => tolerance;
  const names = map.chains.map((c) => c.name);
  const missing = Object.keys(chains).filter((c) => !names.includes(c));
  if (missing.length > 0) throw new Refusal(missing.map((c) => ({ code: 'POSE_REDUCE', text: `--reduce names chain "${c}", which ${mapPath} does not have; its chains are ${names.map((x) => `"${x}"`).join(', ')}` })));
  const by = new Map<string, number>();
  for (const c of map.chains) {
    const t = Object.hasOwn(chains, c.name) ? chains[c.name] : undefined;
    if (t === undefined) continue;
    for (const b of c.bones) by.set(b, Math.min(by.get(b) ?? t, t));
  }
  return (bone) => by.get(bone) ?? tolerance;
}

/** rig-c/pose#320: a mapped bone held to the tolerance of a planted or aimed chain below it. */
export interface ReduceHeld {
  /** The held bone, and the map chain it is a bone of (null for a mapped bone no chain lists). */
  bone: string;
  chain: string | null;
  /** Its tolerance as --reduce gave it (the run's, or its own chain's), degrees. */
  from: number;
  /** The tolerance it is held to: the tightest planted or aimed chain --reduce names below it, degrees. */
  to: number;
  /**
   * Each such chain below it reduced within `to`, in the map's order: its name, what holds it (`ankle`: it carries
   * a planted ankle's landing; `aim`: the map aims it), its first bone, and the lever — that bone's origin's setup
   * distance from the held bone's origin, rig units.
   */
  for: Array<{ chain: string; by: 'ankle' | 'aim'; bone: string; lever: number }>;
}

/**
 * rig-c/pose#320: every mapped bone above a planted or aimed chain `chains`
 * names, whose own tolerance (`tolOf`) is looser than that chain's, held to it
 * — to the tightest such chain when several hang below it. A chain is planted
 * when it carries an ankle the landing check holds (`ankles`), aimed when the
 * map gives it an `aim` other than "x".
 *
 * The lever. A turn error θ on a bone turns everything under it rigidly: a
 * chain below has its first bone moved by θ·L (L = `lever`) and its aim turned
 * by θ. The reduction refits the chain against the turn (`target = dense −
 * e_above`), so the aim is the chain's own error, but not the move: the ankle
 * allowance (`footReduce`) sums every segment from the legs' top down — the
 * held bone's lever among them — times the leg's own degrees. θ·L ≤ θ_leg·L is
 * θ ≤ θ_leg whatever L is. An aimed chain is refitted, and on the trunk
 * smoothed (#116), against its parent's error as it stands: held to the
 * chain's degrees, that error never asks the chain to absorb more than its own
 * tolerance. A bent chain (an arm, a leg with no ankle check) has only its aim
 * checked, which the refit holds, so it holds nothing above it. Only a
 * per-chain entry can be tighter than a bone above it: with none, nothing is held.
 */
export function holdParents(map: JointMap, rest: Rest, mapped: ReadonlySet<string>, chains: Record<string, number>, tolOf: (bone: string) => number, ankles: readonly string[]): ReduceHeld[] {
  const held: ReduceHeld[] = [];
  for (const c of map.chains) {
    const t = Object.hasOwn(chains, c.name) ? chains[c.name] : undefined;
    const top = c.bones[0];
    const by = c.bones.some((b) => ankles.includes(b)) ? ('ankle' as const) : c.aim.some((x) => x !== 'x') ? ('aim' as const) : null;
    if (t === undefined || top === undefined || by === null || !rest.has(top)) continue;
    const at = rest.get(top)!;
    for (let p = at.parent; p !== null; p = rest.get(p)?.parent ?? null) {
      if (!mapped.has(p) || c.bones.includes(p) || !(tolOf(p) > t)) continue;
      const was = held.findIndex((h) => h.bone === p);
      if (was >= 0 && held[was]!.to < t) continue;
      const x = rest.get(p)!;
      const child = { chain: c.name, by, bone: top, lever: Number(Math.hypot(at.worldX - x.worldX, at.worldY - x.worldY).toPrecision(6)) };
      if (was >= 0 && held[was]!.to === t) held[was]!.for.push(child);
      else if (was >= 0) held[was] = { ...held[was]!, to: t, for: [child] };
      else held.push({ bone: p, chain: map.chains.find((m) => m.bones.includes(p))?.name ?? null, from: tolOf(p), to: t, for: [child] });
    }
  }
  return held;
}

/** rig-c/pose#320: the REDUCE line naming a held bone, the chains it was held for, and why. */
export function heldLine(h: ReduceHeld): string {
  const below = h.for.map((c) => `chain "${c.chain}" (${c.by === 'ankle' ? 'a planted ankle' : 'aimed'}; L = ${c.lever} units to bone "${c.bone}")`).join(', ');
  const why = [
    ...(h.for.some((c) => c.by === 'ankle') ? ['the ankle allowance counts L at the leg\'s own degrees'] : []),
    ...(h.for.some((c) => c.by === 'aim') ? ['an aimed chain refits against its parent\'s error within its own'] : []),
  ].join(' and ');
  return `held: bone "${h.bone}"${h.chain === null ? '' : ` (chain "${h.chain}")`} reduced within ${h.to}°, not ${h.from}° — for ${below} below it, reduced within ${h.to}°: a turn error θ on bone "${h.bone}" moves a chain below it by θ·L and turns it by θ, and ${why}, so θ ≤ ${h.to}°`;
}

/** rig-c/pose#320: the REDUCE line for a trunk smoothing (#116) not kept. */
export function unsmoothedLine(u: { root: string; bone: string; worst: number; tolerance: number }): string {
  return `smoothing (rig-c/pose#116) from bone "${u.root}" down not kept: it left bone "${u.bone}" at ${u.worst.toPrecision(3)}°, past its ${u.tolerance}°; the fitted keys stand, each within its tolerance`;
}

/** rig-c/pose#283: the per-chain tolerances as the run and REDUCE lines print them; empty without. */
export function chainsText(chains: Record<string, number> | undefined): string {
  if (chains === undefined) return '';
  return ` (${Object.entries(chains).map(([c, t]) => `chain "${c}" ${t}°`).join(', ')})`;
}
