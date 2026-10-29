/**
 * The signature moments of a retargeted dance: the time ranges where a flat
 * painting rigged with bones cannot express what the dancer does, so a later
 * version can swap in separately painted parts there. A demo tool, not shipped.
 *
 *   bun tools/moments.ts --pose pose.json --map map.json --build <gated build> \
 *     --animation dance --report report.json [--wholebody raw_wholebody.json] \
 *     --out-md moments.md --out-json moments.json
 *
 * The criteria (v2) are fixed here, before the run that reads them; they are
 * not tuned to a dance. v1 measured the rig against the dancer and the face
 * unit per frame; v2 measures the dancer against herself. Per frame:
 *
 * - TURN — the body turns, and 2D bones cannot. Shoulder-width ratio =
 *   |r_shoulder − l_shoulder| in the pose × scale.factor ÷ the distance between
 *   the setup origins of the first bones of chains arm_r and arm_l. Flagged
 *   under 0.75, or when the left/right order in x is the reverse of the rig's
 *   rest. The same for the hips (leg_r, leg_l).
 * - DEPTH — a limb points toward or away from the camera (foreshortening).
 *   Per mapped segment: its length on frame t ÷ its length on the dancer's
 *   reference frame, the frame of median length over the whole dance. Flagged
 *   under 0.70. The rig-vs-dancer ratio (reference length × scale.factor ÷ rig
 *   length) is reported beside it as the proportions, not as a criterion.
 * - ORDER — draw order the rig cannot change. Face: a wrist within 1.0 unit of
 *   the nose, the unit the dancer's median |nose − neck| over the dance. Cross:
 *   a wrist past mid_shoulder's x toward the other side by more than 0.25 × the
 *   median shoulder width, or the two wrists closer than 0.5 × the median
 *   shoulder width while both are below both shoulders (hands meet in front).
 * - HAND (a candidate, not a detection) — with --wholebody: the wrist is above
 *   its shoulder and the hand's mean point score is ≥ 0.5. It marks where a hand
 *   shape would be seen, not which shape.
 * - FOLD — the meshes the retarget report's `folds` lists, at their times.
 *
 * And the retarget's error at each limb end (wrist, ankle): the posed rig's
 * limb tip vs the pose's joint mapped into the rig's world, ÷ the rig limb
 * length; and that error less the same joint's error on the most rest-like
 * frame (the frame whose largest |limb segment DEPTH ratio − 1| is smallest).
 *
 * Flagged frames merge per (reason, part) across gaps of ≤ 2 frames; moments
 * spanning under 3 frames are dropped and counted. Moments then merge into the
 * combined list when they overlap in time AND share a body part (left arm,
 * right arm, left leg, right leg, torso/head).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { poseRawAnimation, type CompiledDocument, type RawBone } from '@rig-c/core/core';
import { isBody18, VIRTUAL } from '../src/joints.ts';
import type { Body18 } from '../src/joints.ts';
import { readMap, type Chain, type JointMap, type Rest } from '../src/map.ts';
import { personTrack, readPoseSequence, type Joint } from '../src/pose.ts';
import { isObject, parseJson, Problems, Refusal, typeName } from '../src/problems.ts';
import { readBuild, restOf } from '../src/rigc.ts';

// --- the fixed criteria (v2) ---------------------------------------------

const TURN_RATIO = 0.75;
const DEPTH_RATIO = 0.7;
const FACE_UNITS = 1.0;
const CROSS_PAST = 0.25;
const MEET_GAP = 0.5;
const HAND_SCORE = 0.5;
const GAP = 2;
const MIN_FRAMES = 3;

type Pt = [number, number];
type Reason = 'turn' | 'depth' | 'order' | 'hand' | 'fold';
const REASONS: readonly Reason[] = ['turn', 'depth', 'order', 'hand', 'fold'];
const GROUPS = ['torso/head', 'right arm', 'left arm', 'right leg', 'left leg'] as const;
type Group = (typeof GROUPS)[number];
const WHY: Record<Reason, string> = {
  turn: 'body rotation — the painting is one view of the body; a turned torso or pelvis needs another view, and bones only turn in the picture plane',
  depth: 'foreshortening — a bone keeps its length; a limb pointing toward or away from the camera is shorter in the picture, and the rig cannot shorten it',
  order: 'draw order — a limb in front of or behind the face, or across the torso, changes which part covers which; the rig draws in one fixed order',
  hand: 'hand shape — the rig has no finger bones; the painted hand keeps its painted shape (a candidate: the hand is raised and seen, its shape is not read)',
  fold: 'the rig itself folds — a mesh turns inside out under these keys (rig-side evidence, from rigc render --folds)',
};
const HAND_BASE = { r_hand: 112, l_hand: 91 } as const;

// --- reading ---------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    pose: { type: 'string' },
    map: { type: 'string' },
    build: { type: 'string' },
    animation: { type: 'string' },
    report: { type: 'string' },
    wholebody: { type: 'string' },
    person: { type: 'string' },
    'out-md': { type: 'string' },
    'out-json': { type: 'string' },
  },
  strict: true,
});

function need(name: 'pose' | 'map' | 'build' | 'animation' | 'report' | 'out-md' | 'out-json'): string {
  const v = args[name];
  if (v === undefined) {
    console.error(`moments: --${name} is required (--pose --map --build --animation --report --out-md --out-json, [--wholebody] [--person])`);
    process.exit(2);
  }
  return v;
}

interface ReportIn {
  minScore: number;
  scale: { factor: number; pose: number; rig: number };
  folds: Array<{ slot: string; attachment: string; times: number[] }>;
}

function readReport(path: string): ReportIn {
  const doc = parseJson(readFileSync(path, 'utf8'), path, 'REPORT_JSON');
  const p = new Problems();
  if (!isObject(doc) || doc.spec !== 'rig-pose-report/1') {
    p.add('REPORT_SPEC', `${path} "spec" is ${isObject(doc) ? typeName(doc.spec) : typeName(doc)}; it must be "rig-pose-report/1" (rig-pose retarget --report)`);
    p.throwIfAny();
    throw new Error('unreachable');
  }
  const s = doc.scale;
  if (!isObject(s) || typeof s.factor !== 'number' || typeof s.pose !== 'number' || typeof s.rig !== 'number') {
    p.add('REPORT_SCALE', `${path} "scale" is ${typeName(s)}; it must be { factor, pose, rig } (the map must translate a bone)`);
  }
  const o = doc.options;
  if (!isObject(o) || typeof o.minScore !== 'number') p.add('REPORT_OPTIONS', `${path} "options.minScore" is ${isObject(o) ? typeName(o.minScore) : '-'}; it must be a number`);
  const folds: ReportIn['folds'] = [];
  if (doc.folds !== null) {
    if (!Array.isArray(doc.folds)) p.add('REPORT_FOLDS', `${path} "folds" is ${typeName(doc.folds)}; it must be an array or null`);
    else {
      doc.folds.forEach((m: unknown, i: number) => {
        if (!isObject(m) || typeof m.slot !== 'string' || typeof m.attachment !== 'string' || !Array.isArray(m.times) || !m.times.every((t) => typeof t === 'number')) {
          p.add('REPORT_FOLDS', `${path} folds[${i}] is ${typeName(m)}; it must be { slot, attachment, times: number[] }`);
        } else folds.push({ slot: m.slot, attachment: m.attachment, times: m.times as number[] });
      });
    }
  }
  p.throwIfAny();
  const sc = s as { factor: number; pose: number; rig: number };
  return { minScore: (o as { minScore: number }).minScore, scale: { factor: sc.factor, pose: sc.pose, rig: sc.rig }, folds };
}

interface WholeBody {
  frames: Array<Array<[number, number, number]>>;
  note: string;
}

/** `coco-wholebody-133`: { spec, fps, width, height, frames: [{ t, points: 133 × [x, y, score] }] }, checked against the pose's times. */
function readWholeBody(path: string, times: readonly number[]): WholeBody {
  const doc = parseJson(readFileSync(path, 'utf8'), path, 'WHOLEBODY_JSON');
  const p = new Problems();
  if (!isObject(doc) || doc.spec !== 'coco-wholebody-133' || !Array.isArray(doc.frames)) {
    p.add('WHOLEBODY_SHAPE', `${path} is not { spec: "coco-wholebody-133", frames: [...] }; its spec is ${isObject(doc) ? typeName(doc.spec) : typeName(doc)}`);
    p.throwIfAny();
    throw new Error('unreachable');
  }
  const raw = doc.frames as unknown[];
  if (raw.length !== times.length) p.add('WHOLEBODY_FRAMES', `${path} has ${raw.length} frames; the pose has ${times.length}`);
  const frames: WholeBody['frames'] = [];
  raw.forEach((f, i) => {
    const pts = isObject(f) ? f.points : undefined;
    const t = isObject(f) ? f.t : undefined;
    if (typeof t !== 'number' || (times[i] !== undefined && Math.abs(t - times[i]!) > 1e-3)) p.add('WHOLEBODY_TIME', `${path} frames[${i}] "t" is ${typeName(t)}; the pose's frame ${i} is at ${times[i]}s`);
    if (!Array.isArray(pts) || pts.length !== 133 || !pts.every((q) => Array.isArray(q) && q.length === 3 && q.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
      p.add('WHOLEBODY_POINTS', `${path} frames[${i}] "points" is ${typeName(pts)}; it must be 133 [x, y, score] triples`);
      return;
    }
    frames.push(pts as Array<[number, number, number]>);
  });
  p.throwIfAny();
  return { frames, note: `${frames.length} frames × 133 [x, y, score] (picture px, y down); points 91–111 sit on body point 9 (left_wrist), 112–132 on point 10 (right_wrist) — COCO-WholeBody order, the subject's sides` };
}

// --- geometry --------------------------------------------------------------

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function pointOn(joints: Partial<Record<Body18, Joint>>, name: string, minScore: number): Pt | null {
  if (isBody18(name)) {
    const j = joints[name];
    if (j === undefined || j.state === 'missing' || j.at === undefined) return null;
    if (j.score !== undefined && j.score < minScore) return null;
    return j.at;
  }
  const pair = VIRTUAL[name];
  if (pair === undefined) return null;
  const a = pointOn(joints, pair[0], minScore);
  const b = pointOn(joints, pair[1], minScore);
  return a === null || b === null ? null : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** A mapped bone's segment on the rig: its `length` (aim "x") or origin → aim distance. */
function rigSegment(rest: Rest, bone: string, aim: string): number {
  const b = rest.get(bone)!;
  if (aim === 'x') return b.length;
  const a = rest.get(aim)!;
  return Math.hypot(a.worldX - b.worldX, a.worldY - b.worldY);
}

function tipOf(bones: Map<string, RawBone>, rest: Rest, c: Chain): Pt {
  const k = c.bones.length - 1;
  const b = bones.get(c.bones[k]!)!;
  const aim = c.aim[k]!;
  if (aim !== 'x') {
    const a = bones.get(aim)!;
    return [a.worldX, a.worldY];
  }
  const len = rest.get(c.bones[k]!)!.length;
  return [b.worldX + b.a * len, b.worldY + b.c * len];
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A chain's body part, by the joint it ends in. */
function groupOfChain(c: Chain): Group {
  const end = c.joints[c.joints.length - 1]!;
  if (end === 'r_wrist') return 'right arm';
  if (end === 'l_wrist') return 'left arm';
  if (end === 'r_ankle') return 'right leg';
  if (end === 'l_ankle') return 'left leg';
  return 'torso/head';
}

/**
 * A mesh's body parts: the limb chains whose bones (or bones below them) weight
 * its vertices; torso/head only when no limb chain does — the trunk anchors
 * every limb mesh at its root, so its weight there does not name a part.
 */
function groupsOfMesh(doc: CompiledDocument, map: JointMap, rest: Rest, slot: string, attachment: string): Group[] {
  const owner = new Map<string, Group>();
  for (const c of map.chains) for (const b of c.bones) owner.set(b, groupOfChain(c));
  const groupOfBone = (bone: string): Group | null => {
    for (let b: string | null = bone; b !== null; b = rest.get(b)?.parent ?? null) {
      const g = owner.get(b);
      if (g !== undefined) return g;
    }
    return null;
  };
  const bones = new Set<string>();
  for (const skin of doc.skins) {
    const geo = skin.attachments[slot]?.[attachment]?.geometry;
    if (geo !== undefined && 'vertices' in geo && isObject(geo.vertices) && geo.vertices.weighted === true && Array.isArray(geo.vertices.bindings)) {
      for (const v of geo.vertices.bindings as unknown[]) if (Array.isArray(v)) for (const x of v) if (isObject(x) && typeof x.bone === 'string') bones.add(x.bone);
    }
  }
  if (bones.size === 0) {
    const s = doc.slots.find((q) => q.name === slot);
    if (s !== undefined) bones.add(s.bone);
  }
  const gs = new Set<Group>();
  for (const b of bones) {
    const g = groupOfBone(b);
    if (g !== null && g !== 'torso/head') gs.add(g);
  }
  if (gs.size === 0) gs.add('torso/head');
  return GROUPS.filter((g) => gs.has(g));
}

// --- the run ---------------------------------------------------------------

interface FrameMark {
  value: number;
}

interface Moment {
  reason: Reason;
  part: string;
  groups: Group[];
  from: number;
  to: number;
  flagged: number;
  measured: Record<string, number | string>;
}

interface ErrStat {
  joint: string;
  max: number;
  max_frame: number;
  median: number;
  above_rest_max: number;
  above_rest_median: number;
}

const r4 = (v: number) => {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
};

function main(): void {
  const posePath = need('pose');
  const mapPath = need('map');
  const build = need('build');
  const animation = need('animation');
  const reportPath = need('report');
  const outMd = need('out-md');
  const outJson = need('out-json');

  const seq = readPoseSequence(readFileSync(posePath, 'utf8'), posePath);
  const frames = personTrack(seq, args.person, posePath);
  const n = frames.length;
  const t0 = seq.frames[0]!.t;
  const times = seq.frames.map((f) => Math.round((f.t - t0) * 1e6) / 1e6);
  const map = readMap(readFileSync(mapPath, 'utf8'), mapPath);
  const report = readReport(reportPath);
  const doc = readBuild(build);
  const rest = restOf(doc);
  const S = report.scale.factor;
  const minScore = report.minScore;
  const wb = args.wholebody === undefined ? null : readWholeBody(args.wholebody, seq.frames.map((f) => f.t));

  const p = new Problems();
  const chain = (name: string) => map.chains.find((c) => c.name === name);
  for (const name of ['arm_r', 'arm_l', 'leg_r', 'leg_l']) if (chain(name) === undefined) p.add('MOMENTS_CHAIN', `${mapPath} has no chain "${name}"; TURN reads the first bones of arm_r, arm_l, leg_r, leg_l`);
  if (map.translate === null) p.add('MOMENTS_TRANSLATE', `${mapPath} translates no bone; ERROR maps the pose into the rig's world through the translated bone's rest origin`);
  if (!doc.animations.some((a) => a.name === animation)) p.add('MOMENTS_ANIMATION', `${build} has no animation "${animation}"; it has ${doc.animations.map((a) => a.name).join(', ') || '(none)'}`);
  p.throwIfAny();

  const marks = new Map<string, Map<number, FrameMark>>();
  const groupsOf = new Map<string, Group[]>();
  const keyOf = (r: Reason, part: string) => `${r}\u0000${part}`;
  const mark = (r: Reason, part: string, groups: Group[], i: number, value: number) => {
    const k = keyOf(r, part);
    if (!marks.has(k)) {
      marks.set(k, new Map());
      groupsOf.set(k, groups);
    }
    marks.get(k)!.set(i, { value });
  };
  const unmeasured = new Map<string, number>();
  const miss = (what: string) => unmeasured.set(what, (unmeasured.get(what) ?? 0) + 1);
  const at = (i: number, name: string) => pointOn(frames[i]!, name, minScore);
  const medianOver = (f: (i: number) => number | null) => {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = f(i);
      if (v !== null) xs.push(v);
    }
    return median(xs);
  };

  // The dancer's own units, over the whole dance.
  const faceUnit = medianOver((i) => {
    const a = at(i, 'nose');
    const b = at(i, 'neck');
    return a === null || b === null ? null : dist(a, b);
  });
  const shoulderW = medianOver((i) => {
    const a = at(i, 'r_shoulder');
    const b = at(i, 'l_shoulder');
    return a === null || b === null ? null : dist(a, b);
  });

  // TURN (unchanged from v1)
  const turnFrame0: Record<string, number> = {};
  const pairs = [
    { part: 'shoulders', a: chain('arm_r')!, b: chain('arm_l')! },
    { part: 'hips', a: chain('leg_r')!, b: chain('leg_l')! },
  ];
  for (const { part, a, b } of pairs) {
    const ra = rest.get(a.bones[0]!)!;
    const rb = rest.get(b.bones[0]!)!;
    const rigW = Math.hypot(rb.worldX - ra.worldX, rb.worldY - ra.worldY);
    const restSide = Math.sign(rb.worldX - ra.worldX);
    for (let i = 0; i < n; i++) {
      const pa = at(i, a.joints[0]!);
      const pb = at(i, b.joints[0]!);
      if (pa === null || pb === null) {
        miss(`turn ${part}`);
        continue;
      }
      const ratio = (dist(pa, pb) * S) / rigW;
      const reversed = Math.sign(pb[0] - pa[0]) === -restSide;
      if (i === 0) turnFrame0[part] = r4(ratio);
      // A reversed frame carries its ratio negated, so the moment can count them.
      if (ratio < TURN_RATIO || reversed) mark('turn', part, ['torso/head'], i, reversed ? -ratio : ratio);
    }
  }

  // DEPTH: each segment against its own median-length frame.
  interface Segment {
    chain: Chain;
    bone: string;
    part: string;
    group: Group;
    limb: boolean;
    rigLen: number;
    lens: number[];
    refFrame: number;
    refLen: number;
    ratio: number[];
  }
  const segments: Segment[] = [];
  for (const c of map.chains) {
    c.bones.forEach((bone, k) => {
      const lens: number[] = [];
      for (let i = 0; i < n; i++) {
        const pa = at(i, c.joints[k]!);
        const pb = at(i, c.joints[k + 1]!);
        lens.push(pa === null || pb === null ? NaN : dist(pa, pb));
      }
      const ok = lens.map((l, i) => [l, i] as const).filter(([l]) => !Number.isNaN(l)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      const ref = ok[(ok.length - 1) >> 1]!;
      const group = groupOfChain(c);
      segments.push({
        chain: c,
        bone,
        part: `${bone} (${c.joints[k]} → ${c.joints[k + 1]})`,
        group,
        limb: group !== 'torso/head',
        rigLen: rigSegment(rest, bone, c.aim[k]!),
        lens,
        refFrame: ref[1],
        refLen: ref[0],
        ratio: lens.map((l) => l / ref[0]),
      });
    });
  }
  for (const s of segments) {
    s.ratio.forEach((r, i) => {
      if (Number.isNaN(r)) miss(`depth ${s.bone}`);
      else if (r < DEPTH_RATIO) mark('depth', s.part, [s.group], i, r);
    });
  }

  // ORDER
  const sideSign = Math.sign(rest.get(chain('arm_l')!.bones[0]!)!.worldX - rest.get(chain('arm_r')!.bones[0]!)!.worldX);
  for (let i = 0; i < n; i++) {
    const nose = at(i, 'nose');
    const mid = at(i, 'mid_shoulder');
    const rs = at(i, 'r_shoulder');
    const ls = at(i, 'l_shoulder');
    const wr = at(i, 'r_wrist');
    const wl = at(i, 'l_wrist');
    for (const side of ['r', 'l'] as const) {
      const w = side === 'r' ? wr : wl;
      const arm: Group = side === 'r' ? 'right arm' : 'left arm';
      if (w === null || nose === null) miss(`order ${side}_wrist face`);
      else {
        const d = dist(w, nose) / faceUnit;
        if (d <= FACE_UNITS) mark('order', `${side}_wrist over the face`, [arm, 'torso/head'], i, d);
      }
      if (w === null || mid === null) miss(`order ${side}_wrist across`);
      else {
        // Toward the other side: the subject's left for the right wrist, and the mirror.
        const past = ((side === 'r' ? 1 : -1) * sideSign * (w[0] - mid[0])) / shoulderW;
        if (past > CROSS_PAST) mark('order', `${side}_wrist across the torso`, [arm, 'torso/head'], i, past);
      }
    }
    if (wr === null || wl === null || rs === null || ls === null) miss('order hands meet');
    else {
      const low = Math.max(rs[1], ls[1]);
      const gap = dist(wr, wl) / shoulderW;
      if (wr[1] > low && wl[1] > low && gap < MEET_GAP) mark('order', 'hands meeting in front of the body', ['right arm', 'left arm'], i, gap);
    }
  }

  // HAND (candidate)
  if (wb !== null) {
    for (const [hand, base] of Object.entries(HAND_BASE)) {
      const side = hand[0]!;
      for (let i = 0; i < n; i++) {
        const w = at(i, `${side}_wrist`);
        const s = at(i, `${side}_shoulder`);
        let score = 0;
        for (let k = 0; k < 21; k++) score += wb.frames[i]![base + k]![2];
        score /= 21;
        if (w === null || s === null) {
          miss(`hand ${hand}`);
          continue;
        }
        if (w[1] < s[1] && score >= HAND_SCORE) mark('hand', `${hand} shape visible (candidate)`, [side === 'r' ? 'right arm' : 'left arm'], i, score);
      }
    }
  }

  // FOLD
  const step = median(times.slice(1).map((t, i) => t - times[i]!));
  let foldOff = 0;
  for (const m of report.folds) {
    const groups = groupsOfMesh(doc, map, rest, m.slot, m.attachment);
    for (const t of m.times) {
      let best = 0;
      for (let i = 1; i < n; i++) if (Math.abs(times[i]! - t) < Math.abs(times[best]! - t)) best = i;
      if (Math.abs(times[best]! - t) > step / 2) foldOff++;
      else mark('fold', `mesh ${m.attachment} (slot ${m.slot})`, groups, best, 1);
    }
  }

  // ERROR, and the most rest-like frame.
  const limbSegs = segments.filter((s) => s.limb);
  let restFrame = -1;
  let restDev = Infinity;
  for (let i = 0; i < n; i++) {
    const devs = limbSegs.map((s) => Math.abs(s.ratio[i]! - 1));
    if (devs.some((d) => Number.isNaN(d))) continue;
    const dev = Math.max(...devs);
    if (dev < restDev) {
      restDev = dev;
      restFrame = i;
    }
  }
  if (restFrame < 0) throw new Refusal([{ code: 'MOMENTS_REST', text: 'no frame has every limb segment measured; the most rest-like frame cannot be chosen' }]);
  const steps = times.slice(1).map((t, i) => t - times[i]!);
  const poses = poseRawAnimation(doc, animation, steps, {}, 'animation');
  if (poses.length !== n) throw new Refusal([{ code: 'MOMENTS_POSES', text: `rig-c posed ${poses.length} frames of "${animation}"; the pose has ${n}` }]);
  const tr = map.translate!;
  const hipRest = rest.get(tr.bone)!;
  const anchor = at(0, tr.joint);
  if (anchor === null) throw new Refusal([{ code: 'MOMENTS_ANCHOR', text: `"${tr.joint}" is not good on frame 0; ERROR maps the pose into the rig's world from it` }]);
  const limbChains = map.chains.filter((c) => groupOfChain(c) !== 'torso/head');
  const errs = new Map<string, number[]>();
  for (const c of limbChains) {
    const end = c.joints[c.joints.length - 1]!;
    const limbLen = c.bones.reduce((s, b, k) => s + rigSegment(rest, b, c.aim[k]!), 0);
    const series: number[] = [];
    poses.forEach((pose, i) => {
      const P = at(i, end);
      if (P === null) {
        series.push(NaN);
        miss(`error ${end}`);
        return;
      }
      const want: Pt = [hipRest.worldX + S * (P[0] - anchor[0]), hipRest.worldY - S * (P[1] - anchor[1])];
      const got = tipOf(new Map(pose.bones.map((b) => [b.name, b])), rest, c);
      series.push(dist(got, want) / limbLen);
    });
    errs.set(end, series);
  }
  const errRest = new Map([...errs.entries()].map(([j, s]) => [j, s[restFrame]!]));
  const errStats = (from: number, to: number): ErrStat[] =>
    [...errs.entries()].map(([joint, s]) => {
      let max = -Infinity;
      let maxFrame = from;
      const xs: number[] = [];
      for (let i = from; i <= to; i++) {
        const v = s[i]!;
        if (Number.isNaN(v)) continue;
        xs.push(v);
        if (v > max) {
          max = v;
          maxFrame = i;
        }
      }
      const base = errRest.get(joint)!;
      return { joint, max: r4(max), max_frame: maxFrame, median: r4(median(xs)), above_rest_max: r4(max - base), above_rest_median: r4(median(xs) - base) };
    });

  // Moments per (reason, part)
  const moments: Moment[] = [];
  let dropped = 0;
  const droppedBy: Record<string, number> = {};
  const split = (k: string) => k.split('\u0000') as [Reason, string];
  const keys = [...marks.keys()].sort((x, y) => {
    const [rx, px] = split(x);
    const [ry, py] = split(y);
    return REASONS.indexOf(rx) - REASONS.indexOf(ry) || (px < py ? -1 : px > py ? 1 : 0);
  });
  const segOf = new Map(segments.map((s) => [s.part, s]));
  const measure = (reason: Reason, part: string, xs: ReadonlyArray<readonly [number, number]>): Record<string, number | string> => {
    const argmin = () => xs.reduce((m, x) => (x[1] < m[1] ? x : m));
    const argmax = () => xs.reduce((m, x) => (x[1] > m[1] ? x : m));
    if (reason === 'turn') {
      const m = xs.reduce((a, x) => (Math.abs(x[1]) < Math.abs(a[1]) ? x : a));
      return { min_ratio: r4(Math.abs(m[1])), at_frame: m[0], threshold: TURN_RATIO, reversed_frames: xs.filter((x) => x[1] < 0).length, frame0_ratio: turnFrame0[part] ?? '-' };
    }
    if (reason === 'depth') {
      const m = argmin();
      const s = segOf.get(part)!;
      return { min_ratio: r4(m[1]), at_frame: m[0], threshold: DEPTH_RATIO, ref_frame: s.refFrame, ref_length_px: r4(s.refLen), proportion_rig_vs_dancer: r4((s.refLen * S) / s.rigLen) };
    }
    if (reason === 'order') {
      if (part.endsWith('over the face')) {
        const m = argmin();
        return { min_distance_in_face_units: r4(m[1]), at_frame: m[0], threshold: FACE_UNITS, face_unit_px: r4(faceUnit) };
      }
      if (part.endsWith('across the torso')) {
        const m = argmax();
        return { max_past_mid_shoulder_in_shoulder_widths: r4(m[1]), at_frame: m[0], threshold: CROSS_PAST, shoulder_width_px: r4(shoulderW) };
      }
      const m = argmin();
      return { min_wrist_gap_in_shoulder_widths: r4(m[1]), at_frame: m[0], threshold: MEET_GAP, shoulder_width_px: r4(shoulderW) };
    }
    if (reason === 'hand') {
      return { candidate: 'a hand shape would be seen here; which shape is not read', min_hand_score: r4(Math.min(...xs.map((x) => x[1]))), score_threshold: HAND_SCORE };
    }
    return { fold_frames: xs.length };
  };
  for (const k of keys) {
    const [reason, part] = split(k);
    const fm = marks.get(k)!;
    const idx = [...fm.keys()].sort((a, b) => a - b);
    const runs: number[][] = [];
    for (const i of idx) {
      const last = runs[runs.length - 1];
      if (last !== undefined && i - last[last.length - 1]! - 1 <= GAP) last.push(i);
      else runs.push([i]);
    }
    for (const run of runs) {
      const from = run[0]!;
      const to = run[run.length - 1]!;
      if (to - from + 1 < MIN_FRAMES) {
        dropped++;
        droppedBy[reason] = (droppedBy[reason] ?? 0) + 1;
        continue;
      }
      moments.push({ reason, part, groups: groupsOf.get(k)!, from, to, flagged: run.length, measured: measure(reason, part, run.map((i) => [i, fm.get(i)!.value] as const)) });
    }
  }

  // Combined: overlapping in time AND sharing a body part, transitively.
  const parent = moments.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let a = 0; a < moments.length; a++) {
    for (let b = a + 1; b < moments.length; b++) {
      const A = moments[a]!;
      const B = moments[b]!;
      if (A.from <= B.to && B.from <= A.to && A.groups.some((g) => B.groups.includes(g))) parent[find(b)] = find(a);
    }
  }
  const comps = new Map<number, Moment[]>();
  moments.forEach((m, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(m);
  });
  const combined = [...comps.values()]
    .map((members) => {
      const ms = [...members].sort((a, b) => a.from - b.from || a.to - b.to || REASONS.indexOf(a.reason) - REASONS.indexOf(b.reason) || (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
      return { from: Math.min(...ms.map((m) => m.from)), to: Math.max(...ms.map((m) => m.to)), members: ms };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const groupsIn = (ms: Moment[]) => GROUPS.filter((g) => ms.some((m) => m.groups.includes(g)));

  const whole = errStats(0, n - 1);
  const tf = (i: number) => times[i]!.toFixed(3);
  const range = (a: number, b: number) => `t ${tf(a)}–${tf(b)} s, frames ${a}–${b}`;
  const measuredText = (m: Record<string, number | string>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ');
  const errText = (es: ErrStat[]) => es.map((e) => `${e.joint} ${e.max.toFixed(3)} / ${e.median.toFixed(3)} (above rest ${e.above_rest_max.toFixed(3)} / ${e.above_rest_median.toFixed(3)})`).join('; ');
  const unmeasuredList = [...unmeasured.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const segmentInfo = segments.map((s) => ({ part: s.part, body_part: s.group, ref_frame: s.refFrame, ref_length_px: r4(s.refLen), rig_length: r4(s.rigLen), proportion_rig_vs_dancer: r4((s.refLen * S) / s.rigLen), frame0_ratio: Number.isNaN(s.ratio[0]!) ? null : r4(s.ratio[0]!) }));

  // --- JSON ---------------------------------------------------------------
  const json = {
    spec: 'rig-pose-moments/0',
    criteria_version: 2,
    inputs: { pose: posePath, map: mapPath, build, animation, report: reportPath, wholebody: args.wholebody ?? null },
    frames: n,
    duration: times[n - 1]!,
    scale_factor: r4(S),
    min_score: minScore,
    criteria: {
      turn_ratio_below: TURN_RATIO,
      turn_reversed: 'left/right order in x reversed relative to the rig rest',
      depth_ratio_below: DEPTH_RATIO,
      depth_reference: 'per segment, its frame of median length over the dance',
      order_face_within_units: FACE_UNITS,
      order_cross_past_mid_shoulder: CROSS_PAST,
      order_hands_meet_below: MEET_GAP,
      hand: 'candidate: wrist above its shoulder and mean hand-point score >= 0.5; marks where a hand shape would be seen, not which shape',
      hand_score_at_least: HAND_SCORE,
      merge_gap_frames: GAP,
      min_span_frames: MIN_FRAMES,
      combine: 'overlap in time and share a body part (torso/head, right arm, left arm, right leg, left leg), transitively',
    },
    units: { face_unit_px: r4(faceUnit), shoulder_width_px: r4(shoulderW) },
    segments: segmentInfo,
    rest_frame: { frame: restFrame, t: times[restFrame]!, max_limb_ratio_deviation: r4(restDev) },
    wholebody: wb === null ? null : wb.note,
    unmeasured: Object.fromEntries(unmeasuredList),
    fold_times_off_grid: foldOff,
    dropped: { total: dropped, by_reason: Object.fromEntries(REASONS.filter((r) => droppedBy[r] !== undefined).map((r) => [r, droppedBy[r]!])) },
    error_whole_dance: whole,
    error_rest_frame: [...errRest.entries()].map(([joint, v]) => ({ joint, value: r4(v) })),
    combined: combined.map((c, k) => ({
      id: `M${k + 1}`,
      from_frame: c.from,
      to_frame: c.to,
      from_t: times[c.from]!,
      to_t: times[c.to]!,
      body_parts: groupsIn(c.members),
      reasons: REASONS.filter((r) => c.members.some((m) => m.reason === r)),
      parts: [...new Set(c.members.map((m) => m.part))],
      members: c.members.map((m) => ({ reason: m.reason, part: m.part, body_parts: m.groups, from_frame: m.from, to_frame: m.to, flagged_frames: m.flagged, measured: m.measured, why: WHY[m.reason] })),
      error: errStats(c.from, c.to),
    })),
    moments: moments.map((m) => ({ reason: m.reason, part: m.part, body_parts: m.groups, from_frame: m.from, to_frame: m.to, from_t: times[m.from]!, to_t: times[m.to]!, flagged_frames: m.flagged, measured: m.measured, error: errStats(m.from, m.to) })),
  };
  writeFileSync(outJson, `${JSON.stringify(json, null, 2)}\n`);

  // --- Markdown -----------------------------------------------------------
  const md: string[] = [];
  md.push(`# Signature moments — "${animation}" (criteria v2)`, '');
  md.push(`${n} frames, ${times[n - 1]!.toFixed(3)} s; scale ${S.toFixed(5)} rig units per picture px; min score ${minScore} (from the report).`, '');
  md.push('Criteria (fixed before the run):', '');
  md.push(`- TURN: shoulder or hip width × scale ÷ the rig's < ${TURN_RATIO}, or left/right reversed against the rig rest.`);
  md.push(`- DEPTH: segment length ÷ the same segment's length on its own median-length frame < ${DEPTH_RATIO}. The rig-vs-dancer proportion is informational.`);
  md.push(`- ORDER: a wrist within ${FACE_UNITS} × the median |nose − neck| (${faceUnit.toFixed(1)} px) of the nose; a wrist past mid_shoulder toward the other side by > ${CROSS_PAST} × the median shoulder width (${shoulderW.toFixed(1)} px); or both wrists below both shoulders and < ${MEET_GAP} shoulder widths apart.`);
  md.push(`- HAND (candidate): the wrist above its shoulder and mean hand-point score ≥ ${HAND_SCORE}. **This marks where a hand shape would be seen, not which shape.**`);
  md.push('- FOLD: the report\'s folds; a mesh\'s body parts are the limb chains weighting it (torso/head when none does).');
  md.push(`- Merged across gaps ≤ ${GAP} frames; moments spanning under ${MIN_FRAMES} frames dropped. Combined: overlapping in time and sharing a body part.`, '');
  md.push(`Dropped (span under ${MIN_FRAMES} frames): ${dropped}${dropped > 0 ? ` (${Object.entries(droppedBy).map(([r, c]) => `${r} ${c}`).join(', ')})` : ''}. Unmeasured frames: ${unmeasuredList.length === 0 ? 'none' : unmeasuredList.map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  if (wb !== null) md.push(`Whole-body input: ${wb.note}.`, '');
  md.push('## Segments', '', '| segment | body part | reference frame | reference length (px) | rig length | proportion rig ÷ dancer (info) | frame 0 ratio |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of segmentInfo) md.push(`| ${s.part} | ${s.body_part} | ${s.ref_frame} | ${s.ref_length_px.toFixed(1)} | ${s.rig_length.toFixed(1)} | ${s.proportion_rig_vs_dancer.toFixed(3)} | ${s.frame0_ratio === null ? '-' : s.frame0_ratio.toFixed(3)} |`);
  md.push('', '## Retarget error over the whole dance', '');
  md.push(`Limb end: the posed rig's tip vs the pose's joint in the rig's world, ÷ the rig limb length. "Above rest" subtracts the joint's error on the most rest-like frame, frame ${restFrame} (t ${tf(restFrame)} s; every limb segment within ${(restDev * 100).toFixed(1)}% of its reference length).`, '');
  md.push('| joint | max | at frame | median | on the rest frame | above rest: max / median |', '| --- | --- | --- | --- | --- | --- |');
  for (const e of whole) md.push(`| ${e.joint} | ${e.max.toFixed(3)} | ${e.max_frame} (t ${tf(e.max_frame)} s) | ${e.median.toFixed(3)} | ${errRest.get(e.joint)!.toFixed(3)} | ${e.above_rest_max.toFixed(3)} / ${e.above_rest_median.toFixed(3)} |`);
  md.push('', `## Combined moments (${combined.length})`, '');
  combined.forEach((c, k) => {
    md.push(`### M${k + 1} — ${range(c.from, c.to)}`, '');
    md.push(`Body parts: ${groupsIn(c.members).join(', ')}. Reasons: ${REASONS.filter((r) => c.members.some((m) => m.reason === r)).join(', ')}.`, '');
    md.push('| reason | part | range | measured | why the retarget cannot express it |', '| --- | --- | --- | --- | --- |');
    for (const m of c.members) md.push(`| ${m.reason} | ${m.part} | ${range(m.from, m.to)} (${m.flagged} flagged) | ${measuredText(m.measured)} | ${WHY[m.reason]} |`);
    md.push('', '| joint | error max | at frame | median | above rest: max / median |', '| --- | --- | --- | --- | --- |');
    for (const e of errStats(c.from, c.to)) md.push(`| ${e.joint} | ${e.max.toFixed(3)} | ${e.max_frame} | ${e.median.toFixed(3)} | ${e.above_rest_max.toFixed(3)} / ${e.above_rest_median.toFixed(3)} |`);
    md.push('');
  });
  md.push(`## Moments per reason and part (${moments.length})`, '');
  md.push('| reason | part | body parts | range | measured | error max / median (above rest) |', '| --- | --- | --- | --- | --- | --- |');
  for (const m of moments) md.push(`| ${m.reason} | ${m.part} | ${m.groups.join(', ')} | ${range(m.from, m.to)} (${m.flagged} flagged) | ${measuredText(m.measured)} | ${errText(errStats(m.from, m.to))} |`);
  md.push('');
  writeFileSync(outMd, md.join('\n'));

  // --- console --------------------------------------------------------------
  console.log(`moments (v2): ${n} frames, ${moments.length} moment(s) per reason/part (${dropped} dropped, span under ${MIN_FRAMES} frames), ${combined.length} combined; rest frame ${restFrame}`);
  combined.forEach((c, k) => console.log(`  M${k + 1}  ${range(c.from, c.to)} [${groupsIn(c.members).join(', ')}] — ${c.members.map((m) => `${m.reason}:${m.part}`).join(' | ')}`));
  console.log(`  ERROR whole dance (max / median, above rest): ${errText(whole)}`);
  console.log(`  wrote ${outMd}, ${outJson}`);
}

try {
  main();
} catch (e) {
  if (e instanceof Refusal) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
