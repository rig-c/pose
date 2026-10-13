#!/usr/bin/env bun
/**
 * rig-pose — puts motion from a body-18 pose sequence onto a rig rig-c built.
 *
 * The command line is the interface for an agent that cannot see the rig: every
 * refusal names the rule, the object, the value found and the value required,
 * and the exit code says which kind of outcome it was.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import pkg from './package.json' with { type: 'json' };
import { convertCoco17, writePoseSequence } from './src/pose.ts';
import { parseWindows } from './src/compare.ts';
import { lineOf, Refusal } from './src/problems.ts';
import { runCompare, type CompareArgs } from './src/runcompare.ts';
import { runRetarget, type RetargetArgs } from './src/run.ts';

const HELP = `rig-pose ${pkg.version} — motion from a pose sequence onto a rig-c rig

Usage:
  rig-pose retarget --rig <rig> --map <map.json> --pose <pose.json> --out <motion.json> [--name dance] [flags]
  rig-pose convert --coco <coco17.json> --out <pose.json>
  rig-pose compare --reference <pose.json> --render <pose.json> --map <map.json> [flags]
  rig-pose --version | --help

retarget
  --rig <path>          the rig spec rigc builds from: a rig.json, or a directory holding one
                        (with its motion.json beside it — @rig-c/parts writes the pair to <out>/rig/)
  --map <map.json>      rig-pose-map/1: which bones carry which joints
  --pose <pose.json>    rig-pose-sequence/1 (body-18 per frame), or COCO-17 with --coco
  --out <motion.json>   where the motion spec goes: the rig's own animations plus the new one,
                        ready for \`rigc build --rig <rig> --motion <motion.json>\`
  --name <name>         the new animation's name (default: dance); refused if the rig has one by that name
  --coco                read --pose as coco17-sequence/1 and convert it first
  --person <id>         the person to follow when the sequence holds more than one
  --base-motion <path>  the rig's motion spec, when it is not motion.json beside rig.json
  --images <dir>        passed to rigc build: where the rig spec's images are, when its own "images" path
                        does not reach them (a rig.json copied away from its images)
  --min-score <s>       a joint scored below s is not good on that frame and holds its last good
                        value (default: 0.3); a joint with no score is good
  --smooth <n>          Savitzky–Golay over n frames of joint positions: a centred least-squares cubic,
                        read at each frame (default: 1, none); n is odd and ≥ 5 — a cubic through 3
                        points passes through all three, so 3 would change nothing
  --flip <deg>|off      a segment that turns more than <deg> degrees in one frame of the pose is
                        spread over the frames around the jump, centred on it, and listed as FLIP
                        (default: off, every turn kept as the pose gives it; 90 is the measured setting)
  --short <f>|off       a segment whose picture length on a frame is under <f> of its median length
                        (seen end-on, or collapsed by blur) has its angle there interpolated from the
                        frames either side, before the flip guard, and listed as SHORT; a run under <f>
                        lasting ≥ 0.15 s is also listed as END-ON (default: off; 0.35 is the measured
                        setting, f in (0, 1))
  --bends refuse|clamp  a hinge (elbow, knee: any joint inside a chain) bent the wrong way refuses
                        the run (default), or is straightened on that frame and listed
  --bend-tolerance <d>  degrees past straight a hinge may bend the wrong way before it counts (default: 0)
  --leg-scale <min,max>|off
                        each leg segment (two of one side's hip, knee, ankle) is scaled along its own x axis
                        (a scalex key) by its picture length over its straight length — the 95th percentile of
                        its picture length — clamped to [min, max], listed as LEG-SCALE with the frames clamped;
                        a bone under a scaled one is keyed through its parent's scale (default: off; 0.8,1.05
                        is the card's range, rig-c/pose#47)
  --plant-feet          the hip is placed so the supporting foot stays where it took support: the lower ankle
                        in the picture, changing after the other has been 0.02 leg lengths lower for 0.1 s,
                        blended over 3 frames; a jump (both ankles and mid_hip 0.05 leg lengths above their
                        rolling floor — the 95th-percentile y over ±1 s — for ≥ 2 frames) follows the pose's
                        travel and re-plants on landing; a supporting ankle moving > 0.03 leg lengths a frame
                        releases its plant to the other foot, or to the pose's travel, until it is still
                        (< 0.01 for 2 frames) (FEET lines)
  --stance <leg lengths> with --plant-feet: on a frame outside the jumps, a free ankle within this many
                        leg lengths (FEET's) of the supporting one in the picture is planted too — its leg's
                        scalex keys stretched by k = (root y − floor y) / (root y − ankle y) until the foot
                        reaches the floor, raised or lowered, k within [0.92, 1.08] (past it, reported, not forced); above
                        it the foot is lifted and keeps the pose's height (STANCE lines; default: off; 0.07 is
                        the card's, rig-c/pose#60)
  --idle <name>         the rig's animation read as its idle (default: idle). Every idle track the new
                        animation does not key, on any channel, is listed as IDLE-DROPPED (a blink, a
                        breath); one it keys is IDLE-KEPT-OUT, naming the track that keys it, and so is a
                        rotate, scale or shear of a bone above a mapped bone (a translate of one is carried)
  --carry-idle          loop the IDLE-DROPPED tracks into the new animation: the idle's keys repeated
                        every idle duration and cut at the new animation's end, with the value
                        interpolated there (default: off — a blink keyed over a set's art is the author's call)
  --merge <file>        merge rig-pose-tracks/1 into the new animation: { "spec": "rig-pose-tracks/1",
                        "tracks": [ <rigc-motion track> … ] } at absolute times from its start (blinks read
                        off the video); a track on a target and property it already keys is refused
                        (MERGE_CONFLICT), and so is a key past its duration (MERGE_TIME)
  --reduce <deg>        thin each mapped bone's rotate keys to few keys with curves (linear, or one raw
                        Bezier per span with handles at its thirds), on the pose's own frame times, so every
                        bone's world aim stays within deg of the dense keys on every frame; fitted top-down,
                        each bone against its parent's reduced error, so errors do not pile up down a chain.
                        Kept regardless: the first and last frame, the frames either side of a switch boundary
                        on the chains it changes, and the edges of every FLIP spread, SHORT span and RANGE run
                        (REDUCE lines; default: off). Not with --leg-scale or --plant-feet (rig-c/pose#32)
  --reduce-hip <units>  with --reduce, thin the hip's translate keys too, its world origin within units
                        of the dense keys (default: the hip stays dense)
  --switch-tolerance <d>  a set of alternate drawings (the map's "alternates") may show on a frame where
                        every segment of its chains is within d degrees of its key skeleton (default: 25)
  --switch-min <s>      a run of one set shorter than s seconds is dropped (default: 0.25)
  --switch-at first|peak  where a switch is keyed: first (default) keeps the frame the selection gave it;
                        peak moves each boundary to the frame within ±switch-min/2 where the chains it
                        changes turn fastest, among those that newly show a set only on frames within
                        2 × the switch tolerance of its key skeleton (it stays when none qualifies)
  --profile spine|spine-html  rigc's gate profile (default: spine, rigc's own default)
  --build <dir>         keep the gated build (skeleton.json, .atlas, .model.json) here
  --render <dir>        keep rigc's render of the animation (frames, contact.png, folds.json) here
  --report <file>       write the run's measurements (holds, short, endOn, flips, bends, landings, folds,
                        switches, uncovered, turns, range, artRange,
                        idleDropped, idleKeptOut, merged, reduce) as JSON

  It writes nothing until rigc's gate is green with the animation in, every mapped bone lands on
  the angle the pose asks for (posed by rig-c's own poser), and no hinge bends the wrong way.
  \`rigc render --folds\` is a reading: the run lists every mesh that folds, and still writes.
  With "alternates" in the map, it keys attachment switches beside the bone keys (SWITCH lines)
  and lists every fold no switch covers (UNCOVERED lines). A chain's "range" clamps a rotate key
  outside the spans of a set depicting it (RANGE lines); inside one, a bone with a "drawn" angle
  turned past its range is listed (ART-RANGE). A line across the body (hips, shoulders, eyes)
  under 0.5 of its median picture length, or reversed, for ≥ 0.15 s is listed (TURN).

convert
  --coco <file>         coco17-sequence/1: { format, width, height, source, frames: [{ t, keypoints }] },
                        keypoints in COCO's order as 17 [x, y, score] or 51 numbers, or null
  --out <file>          the rig-pose-sequence/1 it becomes; neck = the shoulders' midpoint

compare
  --reference <file>    rig-pose-sequence/1: the source video's keypoints
  --render <file>       rig-pose-sequence/1: the same detector on rigc's render of the retargeted motion,
                        rendered at the reference's rate — same frame count, times within 1 ms
  --map <map.json>      rig-pose-map/1: its arm and leg segments are compared
  --retarget-report <f> the retarget's --report: a limb finding inside a set's span suggests paint, outside rig
  --reference-hands <f> --render-hands <f>
                        COCO-WholeBody keypoints ({ frames: [{ t, points: [[x, y, score] x 133] }] }) for
                        hand visibility from the 21 hand points; without them, from the wrist scores
  --cloth-reference <f> --cloth-render <f> --cloth-windows <t0-t1,...>
                        cloth tracks (rig-c-cloth-track/0: hip_x and hem_mid per frame, in hip widths) and
                        the windows, in seconds, #34's lag, swing ratio and overshoot are read over; a render
                        track in rig world units needs --retarget-report (its scale); without the tracks,
                        cloth reads "not measured"
  --report <file>       write the comparison as JSON (rig-pose-compare/1)
  --sheet <png>         draw the reference and render skeletons side by side at each finding's worst frame

  A finding is a run of frames over a bar lasting >= 0.15 s (gaps of one frame merged), worst first.
  The bars (README, "Compare"): arm and leg segment direction > 20 deg; hand visibility reference >= 0.6
  while render < 0.4; foot plant render > 0.05 while reference < 0.02 hip widths/frame; eye-line tilt
  > 15 deg; torso length and hip height range under 0.5 x the reference's; cloth outside #34's bands.
  Exit 0 whenever it compared, findings or not.

Exit codes: 0 written (compare: compared), 1 refused (every reason printed), 2 bad invocation.
`;

class Usage extends Error {}

function parseFlags(argv: string[], flags: readonly string[], switches: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Usage(`unexpected argument "${a}"`);
    const name = a.slice(2);
    if (switches.includes(name)) {
      out.set(name, 'true');
      continue;
    }
    if (!flags.includes(name)) throw new Usage(`unknown flag ${a}; the flags are ${[...flags, ...switches].map((f) => `--${f}`).join(', ')}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Usage(`${a} needs a value`);
    if (out.has(name)) throw new Usage(`${a} is given twice`);
    out.set(name, v);
  }
  return out;
}

function need(f: Map<string, string>, name: string): string {
  const v = f.get(name);
  if (v === undefined) throw new Usage(`--${name} is required`);
  return v;
}

function num(f: Map<string, string>, name: string, dflt: number, ok: (n: number) => boolean, what: string): number {
  const v = f.get(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || !ok(n)) throw new Usage(`--${name} is "${v}"; it must be ${what}`);
  return n;
}

function smoothOf(f: Map<string, string>): number {
  const n = num(f, 'smooth', 1, (v) => Number.isInteger(v) && v >= 1 && v % 2 === 1, '1 (none) or an odd whole number ≥ 5');
  if (n === 3) throw new Usage('--smooth is "3"; a cubic fitted through 3 points passes through all three, so a window of 3 changes nothing — it must be 1 (none) or an odd whole number ≥ 5');
  return n;
}

function flipOf(f: Map<string, string>): number | 'off' {
  if (!f.has('flip') || f.get('flip') === 'off') return 'off';
  return num(f, 'flip', 90, (v) => v > 0 && v < 180, 'off, or degrees in (0, 180) — a one-frame turn is never more than 180°');
}

function shortOf(f: Map<string, string>): number | 'off' {
  if (!f.has('short') || f.get('short') === 'off') return 'off';
  return num(f, 'short', 0.35, (v) => v > 0 && v < 1, 'off, or a fraction in (0, 1) of the segment\'s median picture length');
}

function legScaleOf(f: Map<string, string>): [number, number] | 'off' {
  const v = f.get('leg-scale');
  if (v === undefined || v === 'off') return 'off';
  const parts = v.split(',').map((x) => (x.trim() === '' ? NaN : Number(x)));
  if (parts.length !== 2 || !parts.every((x) => Number.isFinite(x)) || !(parts[0]! > 0) || parts[0]! > 1 || parts[1]! < 1) {
    throw new Usage(`--leg-scale is "${v}"; it must be off, or min,max with 0 < min ≤ 1 ≤ max (the scale of a leg segment against its straight length, e.g. 0.8,1.05)`);
  }
  return [parts[0]!, parts[1]!];
}

function retargetArgs(argv: string[]): RetargetArgs {
  const f = parseFlags(argv, ['rig', 'map', 'pose', 'out', 'name', 'person', 'base-motion', 'images', 'min-score', 'smooth', 'flip', 'short', 'bends', 'bend-tolerance', 'switch-tolerance', 'switch-min', 'switch-at', 'profile', 'build', 'render', 'report', 'leg-scale', 'idle', 'merge', 'reduce', 'reduce-hip', 'stance'], ['coco', 'plant-feet', 'carry-idle']);
  const bends = f.get('bends') ?? 'refuse';
  if (bends !== 'refuse' && bends !== 'clamp') throw new Usage(`--bends is "${bends}"; it must be refuse or clamp`);
  const switchAt = f.get('switch-at') ?? 'first';
  if (switchAt !== 'peak' && switchAt !== 'first') throw new Usage(`--switch-at is "${switchAt}"; it must be peak or first`);
  const profile = f.get('profile') ?? 'spine';
  if (profile !== 'spine' && profile !== 'spine-html') throw new Usage(`--profile is "${profile}"; it must be spine or spine-html`);
  const name = f.get('name') ?? 'dance';
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Usage(`--name is "${name}"; an animation name here is letters, digits, _ . -`);
  return {
    rig: need(f, 'rig'),
    map: need(f, 'map'),
    pose: need(f, 'pose'),
    out: need(f, 'out'),
    name,
    coco: f.has('coco'),
    person: f.get('person'),
    baseMotion: f.get('base-motion'),
    images: f.get('images'),
    minScore: num(f, 'min-score', 0.3, (n) => n >= 0, 'a number ≥ 0'),
    smooth: smoothOf(f),
    flip: flipOf(f),
    short: shortOf(f),
    legScale: legScaleOf(f),
    plantFeet: f.has('plant-feet'),
    stance: stanceOf(f),
    bends,
    bendTolerance: num(f, 'bend-tolerance', 0, (n) => n >= 0 && n < 180, 'degrees in [0, 180)'),
    switchTolerance: num(f, 'switch-tolerance', 25, (n) => n >= 0 && n < 180, 'degrees in [0, 180)'),
    switchMin: num(f, 'switch-min', 0.25, (n) => n >= 0, 'seconds ≥ 0'),
    switchAt,
    profile,
    build: f.get('build'),
    render: f.get('render'),
    report: f.get('report'),
    idle: f.get('idle'),
    carryIdle: f.has('carry-idle'),
    merge: f.get('merge'),
    ...reduceOf(f),
  };
}

/** --stance (rig-c/pose#60): off unless given, and only with --plant-feet. */
function stanceOf(f: Map<string, string>): number | 'off' {
  if (!f.has('stance') || f.get('stance') === 'off') return 'off';
  const v = num(f, 'stance', 0, (n) => n > 0 && n < 1, 'off, or leg lengths in (0, 1)');
  if (!f.has('plant-feet')) throw new Usage(`--stance is "${f.get('stance')}" without --plant-feet; it plants the free foot beside the supporting one that --plant-feet holds`);
  return v;
}

/** --reduce and --reduce-hip (rig-c/pose#32): off unless given; the hip only with the bones. */
function reduceOf(f: Map<string, string>): { reduce?: number; reduceHip?: number } {
  if (!f.has('reduce')) {
    if (f.has('reduce-hip')) throw new Usage('--reduce-hip is given without --reduce; the hip is thinned with the bones, not alone');
    return {};
  }
  const reduce = num(f, 'reduce', 0, (n) => n > 0 && n < 180, 'degrees in (0, 180)');
  for (const other of ['leg-scale', 'plant-feet'] as const) {
    if (f.has(other) && f.get(other) !== 'off') throw new Usage(`--reduce is given with --${other}; their keys land a bone through a scaled parent or an ankle's lever, which the reduction's tolerance does not bound (rig-c/pose#32 round 1)`);
  }
  return f.has('reduce-hip') ? { reduce, reduceHip: num(f, 'reduce-hip', 0, (n) => n > 0, 'rig units > 0') } : { reduce };
}

function compareArgs(argv: string[]): CompareArgs {
  const f = parseFlags(argv, ['reference', 'render', 'map', 'retarget-report', 'reference-hands', 'render-hands', 'cloth-reference', 'cloth-render', 'cloth-windows', 'report', 'sheet'], []);
  const pair = (x: string, y: string) => {
    if (f.has(x) !== f.has(y)) throw new Usage(`--${f.has(x) ? x : y} is given without --${f.has(x) ? y : x}; the two are read together, so both sides are measured the same way`);
  };
  pair('reference-hands', 'render-hands');
  pair('cloth-reference', 'cloth-render');
  let clothWindows: CompareArgs['clothWindows'];
  if (f.has('cloth-reference') && !f.has('cloth-windows')) throw new Usage('--cloth-reference and --cloth-render need --cloth-windows <t0-t1,...>: the figures are read per window');
  if (f.has('cloth-windows')) {
    if (!f.has('cloth-reference')) throw new Usage('--cloth-windows is given without --cloth-reference and --cloth-render');
    const w = parseWindows(f.get('cloth-windows')!);
    if (typeof w === 'string') throw new Usage(`--cloth-windows is "${f.get('cloth-windows')}": ${w}; it must be t0-t1[,t0-t1...] in seconds`);
    clothWindows = w;
  }
  return {
    reference: need(f, 'reference'),
    render: need(f, 'render'),
    map: need(f, 'map'),
    retargetReport: f.get('retarget-report'),
    referenceHands: f.get('reference-hands'),
    renderHands: f.get('render-hands'),
    clothReference: f.get('cloth-reference'),
    clothRender: f.get('cloth-render'),
    clothWindows,
    report: f.get('report'),
    sheet: f.get('sheet'),
  };
}

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  try {
    if (rest.includes('--help')) {
      process.stdout.write(HELP);
      return 0;
    }
    if (cmd === 'retarget') {
      runRetarget(retargetArgs(rest), (l) => process.stdout.write(`${l}\n`));
      return 0;
    }
    if (cmd === 'compare') {
      runCompare(compareArgs(rest), (l) => process.stdout.write(`${l}\n`));
      return 0;
    }
    if (cmd === 'convert') {
      const f = parseFlags(rest, ['coco', 'out'], []);
      const input = need(f, 'coco');
      const out = need(f, 'out');
      const seq = convertCoco17(readFileSync(input, 'utf8'), input);
      writeFileSync(out, writePoseSequence(seq));
      process.stdout.write(`rig-pose convert: ${seq.frames.length} frame(s) of COCO-17 → body-18; wrote ${out}\n`);
      return 0;
    }
    process.stderr.write(`rig-pose: unknown command "${cmd}" — the commands are: retarget, convert, compare\n`);
    return 2;
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`rig-pose ${cmd}: ${e.message} (rig-pose --help)\n`);
      return 2;
    }
    if (e instanceof Refusal) {
      for (const p of e.problems) process.stderr.write(`FAIL  ${lineOf(p)}\n`);
      process.stderr.write(`rig-pose ${cmd}: ${e.problems.length} problem(s) — ${cmd === 'compare' ? 'not compared' : 'nothing written'}\n`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
