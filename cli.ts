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
                        switches, uncovered, turns, range, artRange) as JSON

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

function retargetArgs(argv: string[]): RetargetArgs {
  const f = parseFlags(argv, ['rig', 'map', 'pose', 'out', 'name', 'person', 'base-motion', 'min-score', 'smooth', 'flip', 'short', 'bends', 'bend-tolerance', 'switch-tolerance', 'switch-min', 'switch-at', 'profile', 'build', 'render', 'report'], ['coco']);
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
    minScore: num(f, 'min-score', 0.3, (n) => n >= 0, 'a number ≥ 0'),
    smooth: smoothOf(f),
    flip: flipOf(f),
    short: shortOf(f),
    bends,
    bendTolerance: num(f, 'bend-tolerance', 0, (n) => n >= 0 && n < 180, 'degrees in [0, 180)'),
    switchTolerance: num(f, 'switch-tolerance', 25, (n) => n >= 0 && n < 180, 'degrees in [0, 180)'),
    switchMin: num(f, 'switch-min', 0.25, (n) => n >= 0, 'seconds ≥ 0'),
    switchAt,
    profile,
    build: f.get('build'),
    render: f.get('render'),
    report: f.get('report'),
  };
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
