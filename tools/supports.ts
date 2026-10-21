/**
 * The supporting foot of every frame, read as the retarget reads it
 * (rig-c/pose#82). Not shipped; `tools/scan.py --camera-windows` calls it.
 *
 *   bun tools/supports.ts --pose <pose.json> [--person <id>] [--min-score 0.3]
 *
 * Reads a `rig-pose-sequence/1` (cleaned or not; a scan reads it before
 * `clean`), builds the right and left hip and ankle series in picture px with
 * the retarget's hold rule — a point that is missing or scored under
 * `--min-score` on a frame holds its last good value, and before its first good
 * frame that first good value — and calls `supportsOf` from `src/legs.ts` on
 * them, with the key times and `secondsOf` the retarget uses. Prints JSON:
 *
 *   { "legLength": { "r", "l" }, "leg": number, "support": ("r" | "l" | null)[],
 *     "contact": ("r" | "l" | "both" | null)[], "frontal": boolean,
 *     "jumps": [[a, b], …], "jump": boolean[], "stillSpeed": number,
 *     "speed": { "r": number[], "l": number[] },
 *     "planted": { "r": boolean[], "l": boolean[] },
 *     "ankle": { "r": [[x, y], …], "l": [[x, y], …] } }
 *
 * `support[i]` is null on jump frames and on a step with no other foot planted
 * (`supportsOf`'s own reading). `contact[i]` is the feet the ankle's vertical
 * speed reads down (rig-c/pose#280, `speedSignalOf`), and `frontal` whether
 * that reading decided `support` (a frontal view). `leg` is one picture leg length, the clip
 * median of hip → ankle over both sides (#82's ruling). `speed` is each ankle's
 * movement from the frame before in `leg` (0 on the first frame); `planted` is
 * still both ways — the speed from the previous frame and to the next each
 * under `STILL_SPEED` (src/legs.ts); jump frames are not excluded, and `jumps`
 * is reported beside it (the first and last frames, missing a neighbour, are
 * not planted). A hip or ankle good on no
 * frame is refused by name on stderr, exit 1.
 *
 * Two pieces are minimal equivalents of code src/ does not export: `held` is the
 * retarget's `heldOf` (src/retarget.ts) over `pointOn`, without the HOLD records
 * the retarget prints; the speed is the formula inside `supportsOf` (src/legs.ts), over `leg`.
 */
import { readFileSync } from 'node:fs';
import type { Body18 } from '../src/joints.ts';
import { percentile, SIDES, STILL_SPEED, supportsOf, type Side } from '../src/legs.ts';
import { personTrack, readPoseSequence, type Joint } from '../src/pose.ts';
import { Problems, Refusal } from '../src/problems.ts';
import { pointOn } from '../src/retarget.ts';

type Pt = [number, number];

const args = process.argv.slice(2);
const usage = 'usage: bun tools/supports.ts --pose <pose.json> [--person <id>] [--min-score 0.3]';
const known = ['--pose', '--person', '--min-score'];

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

function fail(lines: readonly string[], code: number): never {
  for (const l of lines) process.stderr.write(`FAIL  ${l}\n`);
  process.exit(code);
}

/** The retarget's hold (`heldOf` in src/retarget.ts): the series, or why the point is good on no frame. */
function held(frames: ReadonlyArray<Partial<Record<Body18, Joint>>>, name: string, minScore: number): Pt[] | string {
  const raw = frames.map((f) => pointOn(f, name, minScore));
  const firstGood = raw.findIndex((v) => typeof v !== 'string');
  if (firstGood < 0) return [...new Set(raw as string[])].slice(0, 3).join('; ');
  const out: Pt[] = [];
  let last = firstGood;
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== 'string') last = i;
    out.push(raw[last] as Pt);
  }
  return out;
}

function main(): void {
  const bad: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    if (!known.includes(args[i]!)) bad.push(`SUPPORTS_ARGS: ${JSON.stringify(args[i])} is not a flag this tool reads; ${usage}`);
    else if (args[i + 1] === undefined) bad.push(`SUPPORTS_ARGS: ${args[i]} has no value; ${usage}`);
  }
  const posePath = flag('--pose');
  if (posePath === undefined) bad.push(`SUPPORTS_ARGS: --pose is required; ${usage}`);
  const ms = flag('--min-score') ?? '0.3';
  const minScore = Number(ms);
  if (!(ms.trim() !== '' && Number.isFinite(minScore) && minScore >= 0)) bad.push(`SUPPORTS_ARGS: --min-score is ${JSON.stringify(ms)}; it must be a number ≥ 0`);
  if (bad.length > 0 || posePath === undefined) fail(bad, 2);
  let text: string;
  try {
    text = readFileSync(posePath, 'utf8');
  } catch (e) {
    fail([`SUPPORTS_ARGS: --pose ${posePath} does not read: ${(e as Error).message}`], 1);
  }
  const seq = readPoseSequence(text, posePath);
  const frames = personTrack(seq, flag('--person'), posePath);
  const n = frames.length;
  // The retarget's key times and run length (src/retarget.ts, `retarget`).
  const t0 = seq.frames[0]!.t;
  const keyTimes = seq.frames.map((f) => Math.round((f.t - t0) * 1e6) / 1e6);
  const endOf = (i: number): number => (i + 1 < n ? keyTimes[i + 1]! : n > 1 ? 2 * keyTimes[i]! - keyTimes[i - 1]! : keyTimes[i]!);
  const secondsOf = (run: [number, number]): number => Math.round((endOf(run[1]) - keyTimes[run[0]]!) * 1e6) / 1e6;
  const p = new Problems();
  const ankle = {} as Record<Side, Pt[]>;
  const hip = {} as Record<Side, Pt[]>;
  for (const s of SIDES) {
    for (const [what, into] of [['hip', hip], ['ankle', ankle]] as const) {
      const name = `${s}_${what}`;
      const h = held(frames, name, minScore);
      if (typeof h === 'string') p.add('SUPPORTS_POINT_NEVER_GOOD', `${posePath}: point "${name}" is good on none of the ${n} frames (${h}); the supports read both hips and both ankles, and there is no value to hold`);
      else into[s] = h;
    }
  }
  p.throwIfAny();
  const feet = supportsOf(ankle, hip, keyTimes, secondsOf);
  const jump = new Array<boolean>(n).fill(false);
  for (const [a, b] of feet.jumps) for (let i = a; i <= b; i++) jump[i] = true;
  // The snap's leg (#82, HQ's ruling): one picture leg length, the clip median of hip → ankle over both
  // sides. An ankle's speed is its movement from the previous frame in that leg (0 on the first frame).
  const leg = percentile(SIDES.flatMap((s) => ankle[s].map((a, i) => Math.hypot(a[0] - hip[s][i]![0], a[1] - hip[s][i]![1]))), 0.5);
  const speed = {} as Record<Side, number[]>;
  const planted = {} as Record<Side, boolean[]>;
  for (const s of SIDES) {
    speed[s] = ankle[s].map((a, i) => (i === 0 ? 0 : Math.hypot(a[0] - ankle[s][i - 1]![0], a[1] - ankle[s][i - 1]![1]) / leg));
    // Planted: still both ways (from the previous frame and to the next, each under STILL_SPEED); the first
    // and last frames, missing a neighbour, are not. Jump frames are not excluded (#82's ruling): the jumps are
    // read on the uncorrected picture, so they carry the very camera steps the windows remove, and an airborne
    // ankle cannot hold still over three frames. scan.py names a frame that falls inside one.
    planted[s] = speed[s].map((v, i) => i > 0 && i + 1 < n && v < STILL_SPEED && speed[s][i + 1]! < STILL_SPEED);
  }
  const out = { legLength: feet.legLength, leg, support: feet.support, contact: feet.signal!.contact, frontal: feet.signal!.frontal, jumps: feet.jumps, jump, stillSpeed: STILL_SPEED, speed, planted, ankle: { r: ankle.r, l: ankle.l } };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

try {
  main();
} catch (e) {
  if (e instanceof Refusal) fail(e.message.split('\n'), 1);
  throw e;
}
