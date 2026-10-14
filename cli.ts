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
import { clean, cleanLine, holdRegions, unheldText, untestedText, HOLD_BLEND, HOLD_MIN_SECONDS, HOLD_REACH, HOLD_SPEED, HOLD_SPEED_WINDOW, LEGS, OCCLUSION_SCORE, OCCLUSION_WINDOW, SPIKE_TRUNKS, SPIKE_WINDOW, windowProblem } from './src/clean.ts';
import { convertCoco17, readPoseSequence, writePoseSequence } from './src/pose.ts';
import { parseWindows } from './src/compare.ts';
import { lineOf, Refusal } from './src/problems.ts';
import { runCompare, type CompareArgs } from './src/runcompare.ts';
import { runRetarget, type RetargetArgs } from './src/run.ts';

const HELP = `rig-pose ${pkg.version} — motion from a pose sequence onto a rig-c rig

Usage:
  rig-pose clean --pose <pose.json> --out <pose.clean.json> [--loop] [--legs 5] [--rest 7] [--hold off] [--coco] [--person <id>]
  rig-pose retarget --rig <rig> --map <map.json> --pose <pose.json> --out <motion.json> [--name dance] [flags]
  rig-pose convert --coco <coco17.json> --out <pose.json>
  rig-pose compare --reference <pose.json> --render <pose.json> --map <map.json> [flags]
  rig-pose --version | --help

clean (required before retarget; rig-c/pose#67)
  --pose <file>         rig-pose-sequence/1 as a scan wrote it, or COCO-17 with --coco
  --out <file>          the cleaned rig-pose-sequence/1, carrying the record of what was done ("cleaned")
  --coco                read --pose as coco17-sequence/1 and convert it first (neck = the shoulders' midpoint)
  --person <id>         the person to clean when the sequence holds more than one; only that person is written
  --loop                the sequence is one cycle (a gait's strike to strike): every window wraps, last frame
                        to first, and the floor is re-pinned; the sequence is written with "travel": "in-place"
                        (rig-c/pose#92)
  --legs <n>            Savitzky–Golay window over the legs — both hips, knees and ankles (default: 5)
  --rest <n>            Savitzky–Golay window over every other joint (default: 7)
                        n is 1 (none), or odd and ≥ 5: a quadratic through 3 points passes through all three
  --hips-inferred       declare the hips inferred (rig-c/pose#63): r_hip and l_hip are marked "inferred" — a
                        position the detector supplied but did not see — on every frame where they have one, and
                        the record says so (hipsInferred: { by: "declared" }). Positions are unchanged, so retarget's
                        keys are too; its POSTURE line does not read the hip tilt ("hip tilt not read: hips inferred")
  --hold off            turn the stillness hold off (rig-c/pose#91); recorded as hold: "off"
  --hold-speed <n>      the hold's speed limit, trunk lengths per frame (default: 0.015)
  --hold-reach <n>      how far a held joint may lie from its span median, trunk lengths (default: 0.03)

  In order, each step printed with its figures: (1) spikes — a joint more than 0.2 trunk lengths
  (neck → mid_hip, the median over the clip) from its 5-frame median takes the median, each listed by
  frame and joint; without --loop the first and last two frames, whose window a clip end cuts, are not
  tested and are listed as untested; (2) occlusion — a joint not "observed", or scored under 0.3, takes its 3-frame median;
  (3) a quadratic Savitzky–Golay per joint, the window cut at the ends (wrapped with --loop); (4) with
  --loop, the figure moved in y so the lowest ankle over the cycle is where it was before smoothing.
  A median is per coordinate over the window's frames where the joint has a position. A joint with no
  position on a frame is left without one (retarget holds it). States and scores are written as read.
  Jitter: the mean |second difference| of y over every joint, px/f², before and after.
  (5) the stillness hold (rig-c/pose#91), per joint, on the cleaned positions: a span of ≥ 0.5 s where the
  joint's 5-frame median speed (its movement from the frame before, in trunk lengths) is under --hold-speed and
  it stays within --hold-reach of its own span median is written as that median, blended in linearly over the
  6 frames before and out over the 6 after (two holds of a joint back to back, or under 6 frames apart, cross-fade
  over the 6 frames plus the gap, centred on it, SEAM); each hold is printed (HOLD) and recorded with its jitter before and
  after, and the joints not held where others are are named with the test each fails (UNHELD).

retarget
  --rig <path>          the rig spec rigc builds from: a rig.json, or a directory holding one
                        (with its motion.json beside it — @rig-c/parts writes the pair to <out>/rig/)
  --map <map.json>      rig-pose-map/1: which bones carry which joints
  --pose <pose.json>    rig-pose-sequence/1 (body-18 per frame) that rig-pose clean wrote; a sequence without
                        its "cleaned" record is refused (POSE_NOT_CLEANED), naming the clean command to run
  --out <motion.json>   where the motion spec goes: the rig's own animations plus the new one,
                        ready for \`rigc build --rig <rig> --motion <motion.json>\`
  --name <name>         the new animation's name (default: dance); refused if the rig has one by that name
  --coco                read --pose as coco17-sequence/1: refused (POSE_NOT_CLEANED) — clean it with
                        rig-pose clean --coco, then retarget the cleaned file
  --person <id>         the person to follow when the sequence holds more than one
  --base-motion <path>  the rig's motion spec, when it is not motion.json beside rig.json
  --images <dir>        passed to rigc build: where the rig spec's images are, when its own "images" path
                        does not reach them (a rig.json copied away from its images)
  --min-score <s>       a joint scored below s is not good on that frame and holds its last good
                        value (default: 0.3); a joint with no score is good
  --smooth <n>          an alias kept since rig-c/pose#67: the smoothing is clean's (--legs, --rest); retarget
                        prints "--smooth is carried by clean; ignored" and smooths nothing
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
                        (< 0.01 for 2 frames) (FEET lines). Every support span is planted on one floor: its
                        supporting ankle moved in y onto the median of the spans' planted heights (world y on
                        the rig, posed by rig-c), the hip and everything above with it; FEET lists each span's
                        shift. On the 3 blend frames the supporting leg's scalex is stretched (k within
                        [0.92, 1.08], past it listed) so its ankle stays on the floor (rig-c/pose#85).
                        On a sequence with "travel": "in-place" (rig-c/pose#92) each supporting foot follows its
                        own ankle's picture x, scaled, instead of being held, no step releases it, and the hip's x
                        drift from the first frame to the last is spread back over the frames, closing the loop
  --floor <y>           with --plant-feet: the floor's world y (rig units, y up) instead of the median
  --stance <leg lengths> with --plant-feet: on a frame outside the jumps, a free ankle within this many
                        leg lengths (FEET's) of the supporting one in the picture, above or below, is planted
                        too — its leg's scalex keys stretched by k = (root y − floor y) / (root y − ankle y) until
                        the foot reaches the floor, raised or lowered, k within [min(0.92, the leg's own fold on
                        the frame), 1.08] (#95; past it, reported, not forced); above the tolerance the foot is
                        lifted and keeps the pose's height; below it, it is reported (past the tolerance below,
                        #114) and not planted (STANCE lines; default: off; 0.07 is the card's, rig-c/pose#60)
  --raised-by-head      while a set whose arm is drawn raised shows (its "drawn" upper arm within 30° of straight
                        up), that arm's wrist goes where the reference's is against the head, in eye distances:
                        rig head centre + (reference wrist − reference head centre) × rig eye distance ÷ the
                        reference's, per frame; each eye distance is its median over the span. The head centre is
                        the eyes' midpoint; the rig's eyes are the two points the head chain's "a>b" aim names
                        (refused without one, RAISED_HEAD), posed from the targets of the bones above. A target out
                        of the arm's reach, too far or too near, goes to the reach limit on the ray from the head
                        centre toward it and is graded at that placed distance (REACH lines, in eye distances). A
                        two-bone solve on the rig's own lengths keeps the pose's elbow side; when the set's "turn"
                        holds the upper arm the forearm is re-aimed at the wrist. ART-RANGE: a forearm still past
                        its turn, or a held arm leaving the wrist > 0.01 eye distances short of its placed point
                        (the shortfall listed). RAISED lines (default: off; rig-c/pose#62)
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
                        (REDUCE lines; default: off). It runs last, on the final keys: with --leg-scale,
                        --plant-feet and --stance, a scaled bone's scalex is thinned within 5e-5 of its setup
                        length, a bone under one is re-solved through its parent as reduced, and each ankle
                        is held to what the reduced bones above it may move it by (rig-c/pose#94)
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
                        switches, uncovered, turns, range, artRange, raised, byHip,
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
  const f = parseFlags(argv, ['rig', 'map', 'pose', 'out', 'name', 'person', 'base-motion', 'images', 'min-score', 'smooth', 'flip', 'short', 'bends', 'bend-tolerance', 'switch-tolerance', 'switch-min', 'switch-at', 'profile', 'build', 'render', 'report', 'leg-scale', 'idle', 'merge', 'reduce', 'reduce-hip', 'stance', 'floor'], ['coco', 'plant-feet', 'carry-idle', 'raised-by-head']);
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
    smoothAlias: f.get('smooth'),
    flip: flipOf(f),
    short: shortOf(f),
    legScale: legScaleOf(f),
    plantFeet: f.has('plant-feet'),
    stance: stanceOf(f),
    ...floorOf(f),
    raisedByHead: f.has('raised-by-head'),
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

/** --floor (rig-c/pose#85): the floor's world y, only with --plant-feet; absent, the median of the spans' planted heights. */
function floorOf(f: Map<string, string>): { floor?: number } {
  if (!f.has('floor')) return {};
  const v = num(f, 'floor', 0, () => true, 'a world y in rig units (a finite number)');
  if (!f.has('plant-feet')) throw new Usage(`--floor is "${f.get('floor')}" without --plant-feet; it is the floor --plant-feet plants every support span on`);
  return { floor: v };
}

/** --reduce and --reduce-hip (rig-c/pose#32): off unless given; the hip only with the bones. */
function reduceOf(f: Map<string, string>): { reduce?: number; reduceHip?: number } {
  if (!f.has('reduce')) {
    if (f.has('reduce-hip')) throw new Usage('--reduce-hip is given without --reduce; the hip is thinned with the bones, not alone');
    return {};
  }
  const reduce = num(f, 'reduce', 0, (n) => n > 0 && n < 180, 'degrees in (0, 180)');
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

/** The stillness hold's flags (#91): `--hold off`, or the thresholds (defaults 0.015 and 0.03). */
function holdOf(f: Map<string, string>): { speed: number; reach: number } | 'off' {
  const v = f.get('hold');
  if (v !== undefined && v !== 'off') throw new Usage(`--hold is "${v}"; the hold runs by default, and the only value is "off"`);
  if (v === 'off') {
    const given = ['hold-speed', 'hold-reach'].filter((k) => f.has(k));
    if (given.length > 0) throw new Usage(`${given.map((k) => `--${k}`).join(' and ')} with --hold off: the hold does not run, so ${given.length === 1 ? 'it changes' : 'they change'} nothing — drop ${given.length === 1 ? 'it' : 'them'} or the --hold off`);
    return 'off';
  }
  return {
    speed: num(f, 'hold-speed', HOLD_SPEED, (n) => n > 0, 'a number > 0 (trunk lengths per frame)'),
    reach: num(f, 'hold-reach', HOLD_REACH, (n) => n > 0, 'a number > 0 (trunk lengths)'),
  };
}

/** A window flag of clean: 1, or odd and ≥ 5 (`windowProblem`). */
function windowOf(f: Map<string, string>, name: string, dflt: number): number {
  const v = f.get(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  const why = windowProblem(`--${name}`, Number.isFinite(n) ? n : NaN);
  if (!Number.isFinite(n) || why !== null) throw new Usage(why ?? `--${name} is "${v}"; it must be 1 (none) or an odd whole number ≥ 5`);
  return n;
}

const fmt = (v: number, d = 2) => v.toFixed(d);
function runsOf(frames: number[]): string {
  const out: string[] = [];
  let a = -1;
  let b = -1;
  for (const f of frames) {
    if (f === b + 1) b = f;
    else {
      if (a >= 0) out.push(a === b ? `${a}` : `${a}–${b}`);
      a = f;
      b = f;
    }
  }
  if (a >= 0) out.push(a === b ? `${a}` : `${a}–${b}`);
  return out.join(', ');
}

/** `rig-pose clean` (#67): read, clean, print each step's figures, write. */
function runClean(argv: string[], say: (l: string) => void): void {
  const f = parseFlags(argv, ['pose', 'out', 'legs', 'rest', 'person', 'hold', 'hold-speed', 'hold-reach'], ['loop', 'coco', 'hips-inferred']);
  const input = need(f, 'pose');
  const out = need(f, 'out');
  const params = { loop: f.has('loop'), legs: windowOf(f, 'legs', 5), rest: windowOf(f, 'rest', 7), hipsInferred: f.has('hips-inferred'), hold: holdOf(f) };
  const text = readFileSync(input, 'utf8');
  const seq = f.has('coco') ? convertCoco17(text, input) : readPoseSequence(text, input);
  const c = clean(seq, params, f.get('person'), input);
  const n = seq.frames.length;
  const tOf = (i: number) => `t=${seq.frames[i]!.t.toFixed(3)}s`;
  say(`rig-pose clean: ${n} frame(s) of person "${c.person}" from ${input}${f.has('coco') ? ' (COCO-17)' : ''}; legs ${params.legs}, rest ${params.rest}, ${params.loop ? 'loop (every window wraps)' : 'no loop (windows cut at the ends)'}`);
  say(`  TRUNK  neck → mid_hip: median ${fmt(c.trunk.length)} px over ${c.trunk.frames} frame(s); a spike is > ${fmt(SPIKE_TRUNKS * c.trunk.length)} px (${SPIKE_TRUNKS} trunk) from its ${SPIKE_WINDOW}-frame median`);
  for (const s of c.spikes) say(`  SPIKE  joint "${s.joint}" frame ${s.frame} (${tOf(s.frame)}): ${fmt(s.off)} px from its ${SPIKE_WINDOW}-frame median, over ${fmt(SPIKE_TRUNKS * c.trunk.length)} — took the median`);
  say(`  SPIKES ${c.spikes.length} replaced; ${untestedText(c.untested)}`);
  const byJoint = new Map<string, typeof c.occluded>();
  for (const o of c.occluded) byJoint.set(o.joint, [...(byJoint.get(o.joint) ?? []), o]);
  for (const [joint, os] of byJoint) say(`  OCCLUDED joint "${joint}" on ${os.length} frame(s) (${runsOf(os.map((o) => o.frame))}): not observed or scored under ${OCCLUSION_SCORE}; took its ${OCCLUSION_WINDOW}-frame median, moved up to ${fmt(Math.max(...os.map((o) => o.moved)))} px`);
  say(`  OCCLUSION ${c.occluded.length} joint-frame(s) took the median`);
  for (const m of c.missing) say(`  MISSING joint "${m.joint}" frame${m.from === m.to ? ` ${m.from}` : `s ${m.from}–${m.to}`}: no position; left without one (retarget holds it)`);
  const sg = (w: number) => (w === 1 ? '1 frame (none)' : `${w} frames`);
  say(`  SMOOTH quadratic Savitzky–Golay per joint: legs (${LEGS.join(', ')}) over ${sg(params.legs)}, the rest over ${sg(params.rest)}; ${params.loop ? 'circular' : 'the window cut at the ends'}`);
  if (params.loop) {
    if (c.floor === null) say('  FLOOR  no ankle has a position on any frame; not re-pinned');
    else say(`  FLOOR  the lowest ankle over the cycle: y ${fmt(c.floor.before)} before smoothing, ${fmt(c.floor.after)} after; every joint moved ${c.floor.shift >= 0 ? '+' : ''}${fmt(c.floor.shift, 3)} px in y`);
    say('  TRAVEL "in-place" written (rig-c/pose#92): a loop is one cycle repeated, so the figure does not travel; retarget --plant-feet holds the hip\'s x over the loop and lets the supporting foot follow its own track');
  }
  const jit = (v: number | null) => (v === null ? 'not measured' : `${fmt(v, 3)}`);
  say(`  JITTER mean |second difference| of y over ${c.triples} joint-frame triple(s): ${jit(c.record.jitter.before)} → ${jit(c.record.jitter.after)} px/f²${c.record.jitter.before !== null && c.record.jitter.after !== null && c.record.jitter.before > 0 ? ` (${fmt(100 * (1 - c.record.jitter.after / c.record.jitter.before), 1)}% lower)` : ''}`);
  if (params.hold === 'off') say('  HOLD   off (--hold off): no stillness hold');
  else {
    const h = params.hold;
    const span = (r: [number, number] | null, what: string) => (r === null ? `nothing ${what}` : `${what} ${r[0] === r[1] ? `frame ${r[0]}` : `frames ${r[0]}–${r[1]}`}`);
    for (const x of c.holds) say(`  HOLD   joint "${x.joint}" frames ${x.frames[0]}–${x.frames[1]} (${tOf(x.frames[0])}–${tOf(x.frames[1])}, ${fmt(x.seconds, 3)} s): ${HOLD_SPEED_WINDOW}-frame median speed under ${h.speed} trunk/frame (largest ${fmt(x.speed, 4)}), ${x.excursion === null ? `within ${h.reach} trunk of its span median (largest ${fmt(x.reach, 4)}); written as that median` : `within ${h.reach} trunk of its span median outside excursion ${x.excursion[0] === x.excursion[1] ? `frame ${x.excursion[0]}` : `frames ${x.excursion[0]}–${x.excursion[1]}`} (reach ${fmt(x.reach, 4)} with excursion); held around the excursion, which is blended in and out`}, blended in over ${span(x.blendIn, 'before').replace('nothing before', 'nothing before it')}, out over ${span(x.blendOut, 'after').replace('nothing after', 'nothing after it')}; jitter inside ${jit(x.jitter.before)} → ${jit(x.jitter.after)} px/f²${x.jitter.after !== null && x.jitter.after > 0 ? ` (${x.excursion !== null ? 'excursion' : 'ramp'})` : ''}`);
    for (const x of c.seams) say(`  SEAM   joint "${x.joint}" frame ${x.frame} (${tOf(x.frame)}): two holds ${x.gap === 0 ? 'back to back' : `${x.gap} frame(s) apart`}, their medians ${fmt(x.step, 4)} trunk (${fmt(x.step * c.trunk.length)} px) apart; cross-faded over frames ${x.frame - x.gap - HOLD_BLEND / 2}–${x.frame + HOLD_BLEND / 2 - 1}, no frame moving more than 1/${HOLD_BLEND + x.gap} of it`);
    for (const [a, b] of holdRegions(c.holds)) {
      const not = c.unheld.filter((u) => u.frames[0] >= a && u.frames[1] <= b);
      if (not.length > 0) say(`  UNHELD frames ${a}–${b}, where other joints are held: ${not.map(unheldText({ ...h, minSeconds: HOLD_MIN_SECONDS })).join(', ')}`);
    }
    say(`  HOLDS  ${c.holds.length} found over ${new Set(c.holds.map((x) => x.joint)).size} joint(s) (per joint: a span ≥ ${HOLD_MIN_SECONDS} s still by speed < ${h.speed} trunk/frame and reach ≤ ${h.reach} trunk; ${HOLD_BLEND}-frame blend in and out)`);
  }
  if (c.inferred !== null) say(`  INFERRED r_hip on ${c.inferred.r_hip} frame(s), l_hip on ${c.inferred.l_hip} frame(s) of ${n} marked "inferred" (every frame where it has a position): declared at clean (--hips-inferred); positions and scores unchanged`);
  writeFileSync(out, writePoseSequence(c.seq));
  say(`  CLEAN  ${cleanLine(c.record)}`);
  say(`  wrote ${out}`);
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
    if (cmd === 'clean') {
      runClean(rest, (l) => process.stdout.write(`${l}\n`));
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
    process.stderr.write(`rig-pose: unknown command "${cmd}" — the commands are: clean, retarget, convert, compare\n`);
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
