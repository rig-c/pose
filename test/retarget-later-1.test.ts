import {
  afterEach,
  describe,
  expect,
  test,
  spawnSync,
  createHash,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  join,
  poseRawAnimation,
  type RawBone,
  Plate,
  capShortSteps,
  holdAcross,
  holdShort,
  shortLine,
  clampArt,
  clean,
  readPoseSequence,
  writePoseSequence,
  scaleSupport,
  type Feet,
  type LegScale,
  readMap,
  type Chain,
  overFloor,
  projectSeams,
  readSeamPairs,
  writeReport,
  type RenderDomain,
  type ReportInputs,
  walkCycle,
  walkDoc,
  firstFrames,
  keysOnFrameTimes,
  type MotionDoc,
  ROOT,
  CLI,
  MUTANTS,
  DEG,
  RAD,
  ANGLE_TOL,
  ORIGIN_TOL,
  SLOW,
  type Pt,
  wrap,
  made,
  tempDir,
  type BoneSpec,
  type RigOpts,
  type ChainSpec,
  baseChains,
  baseMap,
  type Motion,
  BASE,
  SCALE,
  dir,
  add,
  positions,
  type JointsDoc,
  poseDoc,
  cleanedDoc,
  type Ran,
  cli,
  type Case,
  setup,
  retarget,
  fails,
  linesOf,
  documentedReport,
  loadBuild,
  byName,
  worldAngle,
  motionOf,
} from './retarget-fixture.ts';

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('--raised-by-head (#62): a raised arm\'s wrist placed against the head, in eye distances', () => {
  /** The stick rig with a head and two eye points 12 units apart, 30 above the neck; its right shoulder 10 below the neck and 30 out; the arm 70 + 60. */
  const headBones = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const RIG: RigOpts = { bones: headBones, extra: { sleeve_r0: { seg_up: { image: 'seg.png', x: 30, y: 0, rotation: -90 } } } };
  /** The rig's head centre and right shoulder at setup (the trunk and the head stand still in every pose below). */
  const RIG_CENTRE: Pt = [0, 480];
  const RIG_SHOULDER: Pt = [-30, 440];
  /**
   * The pose's proportions are not the rig's: its eyes are 12 px apart 35 px above the neck and its shoulder 20 px out
   * level with it (1.67, 2.92 eye distances from the shoulder to the head centre), where the rig's is (2.5, 3.33).
   * The right arm is raised on frames 4–11 (the set's key skeleton) and low elsewhere; the trunk stands still.
   */
  const ON = (i: number) => i >= 4 && i <= 11;
  const raisedMotion = (ru: (i: number) => number, rf: (i: number) => number): Motion => ({ ...BASE, trunk: () => 90, hip: () => [0, 0], ru: (i) => (ON(i) ? ru(i) : 30), rf: (i) => (ON(i) ? rf(i) : 50) });
  const RAISED = raisedMotion((i) => 110 + i, (i) => 70 - i);
  /** The eyes `half(i)` px either side of their midpoint (6 is the pose as positions() writes it). */
  const eyesApart = (half: (i: number) => number) => (i: number, j: JointsDoc): void => {
    const r = j.r_eye!.at as Pt;
    const l = j.l_eye!.at as Pt;
    const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
    j.r_eye = { state: 'observed', at: [mid[0] - half(i), mid[1]], score: 0.9 };
    j.l_eye = { state: 'observed', at: [mid[0] + half(i), mid[1]], score: 0.9 };
  };
  /** The key skeleton: the arm at the given angles, at another scale and place than the pose's. */
  const keySkeleton = (ru: number, rf: number): Record<string, Pt> => {
    const sh: Pt = [1000, 1000];
    const el = add(sh, dir(ru, 300));
    return { r_shoulder: sh, r_elbow: el, r_wrist: add(el, dir(rf, 250)) };
  };
  const set = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'up', slots: { sleeve_r0: 'seg_up' }, chains: ['arm_r'], pose: keySkeleton(117.5, 62.5), drawn: { sleeve_r0: 100, sleeve_r1: 60 }, turn: { sleeve_r0: [-90, 90], sleeve_r1: [-90, 90] }, ...o });
  const headChain = (aim = 'eye_r>eye_l'): ChainSpec => ({ name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: [aim] });
  const mapOf = (o: { sets?: Array<Record<string, unknown>>; head?: ChainSpec | null } = {}): Record<string, unknown> => ({
    ...baseMap(),
    // The right elbow bends the other way from the stick rig's rest, as a V sign does: "free", as HQ's map states it.
    chains: [...baseChains().map((c) => (c.name === 'arm_r' ? { ...c, bend: 'free' } : c)), ...(o.head === null ? [] : [o.head ?? headChain()])],
    alternates: o.sets ?? [set()],
  });
  /** The reference's wrist − head centre on frame i, in `eye` px (picture y turned up). */
  const refOffset = (m: Motion, i: number, eye = 12): Pt => {
    const p = positions(m, i);
    return [(p.r_wrist![0] - (p.r_eye![0] + p.l_eye![0]) / 2) / eye, -(p.r_wrist![1] - (p.r_eye![1] + p.l_eye![1]) / 2) / eye];
  };
  const posedBones = (build: string, m: Motion) => poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: m.n - 1 }, () => m.dt)).map((p) => byName(p.bones));
  const tipOf = (b: Map<string, RawBone>): Pt => {
    const f = b.get('sleeve_r1')!;
    return [f.worldX + f.a * 60, f.worldY + f.c * 60];
  };
  /** The rig's wrist − head centre in its eye distances (12 units), posed by rig-c from the gated build. */
  const rigOffsets = (build: string, m: Motion): Pt[] =>
    posedBones(build, m).map((b) => {
      const er = b.get('eye_r')!;
      const el = b.get('eye_l')!;
      const w = tipOf(b);
      return [(w[0] - (er.worldX + el.worldX) / 2) / 12, (w[1] - (er.worldY + el.worldY) / 2) / 12];
    });
  /** Every frame of the span where the rig's wrist is more than `tol` eye distances off `want(i)`, in x or y. */
  const offBy = (build: string, m: Motion, tol: number, want: (i: number) => Pt = (i) => refOffset(m, i)): string[] => {
    const rig = rigOffsets(build, m);
    const out: string[] = [];
    for (let i = 0; i < m.n; i++) {
      if (!ON(i)) continue;
      const r = want(i);
      if (!(Math.abs(rig[i]![0] - r[0]) <= tol && Math.abs(rig[i]![1] - r[1]) <= tol)) out.push(`frame ${i}: rig (${rig[i]![0].toFixed(3)}, ${rig[i]![1].toFixed(3)}) want (${r[0].toFixed(3)}, ${r[1].toFixed(3)})`);
    }
    return out;
  };
  /** The pose's right arm angles that put its wrist at `w` (picture px from the neck), the elbow bent clockwise. */
  const armTo = (w: Pt): { ru: number; rf: number } => {
    const v: Pt = [w[0] + 20, -w[1]];
    const d = Math.hypot(v[0], v[1]);
    const th = Math.atan2(v[1], v[0]) * DEG;
    const al = Math.acos((60 * 60 + d * d - 50 * 50) / (2 * 60 * d)) * DEG;
    const ru = th + al;
    const e: Pt = [60 * Math.cos(ru * RAD), 60 * Math.sin(ru * RAD)];
    return { ru, rf: Math.atan2(v[1] - e[1], v[0] - e[0]) * DEG };
  };
  type ReportOut = { options: Record<string, unknown>; raised: Array<{ eyes: { rig: number; reference: number }; placed: Pt[]; worst: { before: Pt; after: Pt; placed: number }; short: Array<{ frames: [number, number]; how: string; shortfall: { max: number } }>; upperHeld: number[]; reach: { min: number; max: number; farthest: number } }> };
  const reportOf = (path: string): ReportOut => JSON.parse(readFileSync(path, 'utf8')) as ReportOut;
  const rotateKeys = (path: string): Map<string, string[]> => new Map(motionOf(path).animations.dance!.tracks.map((t) => [`${t.bone}.${t.property}`, t.keys.map((k) => JSON.stringify(k))]));
  const angleBetween = (a: Pt, b: Pt): number => Math.abs(wrap((Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) * DEG));

  /** The card's test for #62, against a given CLI: written, and the wrist within 0.05 eye distances of the reference's on every frame of the span. */
  function raisedTest(cliPath = CLI): { ran: Ran; off: string[]; c: Case } {
    const c = setup({ rig: RIG, map: mapOf(), pose: poseDoc(RAISED) });
    const ran = retarget(c, ['--raised-by-head', '--report', join(c.dir, 'report.json')], cliPath);
    return { ran, off: ran.status === 0 ? offBy(c.build, RAISED, 0.05) : [], c };
  }

  test('the wrist lands on the reference\'s offset from the head within 0.05 eye distances; every other key is the run without the flag\'s', () => {
    const { ran, off, c } = raisedTest();
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(off).toEqual([]);
    expect(linesOf(ran, 'SWITCH')[0]).toContain('frames 4–11');
    const line = linesOf(ran, 'RAISED');
    expect(line).toHaveLength(1);
    expect(line[0]).toStartWith('RAISED set "up" chain "arm_r" frames 4–11 (t=0.500–1.375s): the wrist placed against the head; eye distance (median) rig 12.00 units, reference 12.00 px;');
    expect(line[0]).toEndWith('the upper arm within its turn on every frame; every target in reach');
    expect(linesOf(ran, 'REACH')).toEqual([]);
    expect(linesOf(ran, 'ART-RANGE')).toEqual([]);
    const rep = reportOf(join(c.dir, 'report.json'));
    expect(rep.options.raisedByHead).toBe(true);
    expect(rep.raised).toHaveLength(1);
    expect(rep.raised[0]!.eyes).toEqual({ rig: 12, reference: 12 });
    expect(Math.max(...rep.raised[0]!.worst.after)).toBeLessThanOrEqual(0.05);
    expect(rep.raised[0]!.short).toEqual([]);
    // Control: the pose's own angles, on these proportions, miss by more than the bar (what the flag is for).
    const plain = setup({ rig: RIG, map: mapOf(), pose: poseDoc(RAISED) });
    expect(retarget(plain).status).toBe(0);
    expect(Math.max(...rep.raised[0]!.worst.before)).toBeGreaterThan(0.5);
    expect(offBy(plain.build, RAISED, 0.05).length).toBe(8);
    // Outside the span, and on every other bone, the keys are the run without the flag's, byte for byte.
    const a = rotateKeys(plain.out);
    const b = rotateKeys(c.out);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [track, keys] of a) {
      keys.forEach((k, i) => {
        const moved = (track === 'sleeve_r0.rotate' || track === 'sleeve_r1.rotate') && ON(i);
        if (!moved) expect(`${track} ${i} ${b.get(track)![i]}`).toBe(`${track} ${i} ${k}`);
      });
    }
  }, SLOW);

  test('mutant: a solve that keeps the pose\'s angles fails the 0.05 bar', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = '          t0[i] = a0;\n          t1[i] = a1;\n';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));
      const { ran, off } = raisedTest(join(d, 'cli.ts'));
      expect(ran.status).toBe(0);
      expect(off.length).toBe(8);
      console.log(`  mutant "the solve keeps the pose's angles": exit ${ran.status}, ${off.length} frame(s) off, first: ${off[0]}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('the eye distance is each side\'s median over the span: two frames with the eyes half as far apart move nothing', () => {
    // Frames 5 and 6 read the eyes 6 px apart; read per frame, the wrist there would be twice as many eye distances out (past the arm).
    const narrow = (i: number) => (i === 5 || i === 6 ? 3 : 6);
    const c = setup({ rig: RIG, map: mapOf(), pose: poseDoc(RAISED, eyesApart(narrow)) });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'RAISED')[0]).toContain('eye distance (median) rig 12.00 units, reference 12.00 px;');
    expect(linesOf(r, 'REACH')).toEqual([]);
    expect(offBy(c.build, RAISED, 0.05)).toEqual([]);
  }, SLOW);

  test('too far: the wrist at the reach limit on the ray from the head centre toward the target; REACH, not ART-RANGE', () => {
    // Eyes 6 px apart in the pose: the same wrist is twice as many eye distances from the head, past the rig's 130 units of arm.
    const c = setup({ rig: RIG, map: mapOf(), pose: poseDoc(RAISED, eyesApart(() => 3)) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--raised-by-head', '--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'RAISED')[0]).toContain('reference 6.00 px');
    expect(linesOf(r, 'RAISED')[0]).toEndWith('out of reach on 8 frame(s) (REACH)');
    const reach = linesOf(r, 'REACH');
    expect(reach).toHaveLength(1);
    expect(reach[0]).toMatch(/^REACH {2}set "up" chain "arm_r": the target out of the arm's reach from the shoulder — frames 4–11 \(t=0\.500–1\.375s\) farther than l0 \+ l1 = 130\.0: up to [0-9.]+ eye distances short \(median [0-9.]+\); the wrist placed at the reach limit along the head-relative direction/);
    expect(reach[0]).toEndWith('Not ART-RANGE: the rig\'s proportions, not the art\'s range, were the limit');
    expect(linesOf(r, 'ART-RANGE')).toEqual([]);
    const rep = reportOf(report);
    expect(rep.raised[0]!.short).toHaveLength(1);
    expect(rep.raised[0]!.short[0]!.how).toBe('far');
    expect(rep.raised[0]!.short[0]!.shortfall.max).toBeGreaterThan(0);
    const rig = rigOffsets(c.build, RAISED);
    const bones = posedBones(c.build, RAISED);
    for (let i = 4; i <= 11; i++) {
      const ref = refOffset(RAISED, i, 6);
      // On the ray: the reference's direction from the head centre; at the limit: the arm straight, its tip l0 + l1 from the shoulder.
      expect(angleBetween(rig[i]!, ref)).toBeLessThanOrEqual(0.01);
      expect(Math.hypot(rig[i]![0], rig[i]![1])).toBeLessThan(Math.hypot(ref[0], ref[1]));
      const w = tipOf(bones[i]!);
      expect(Math.abs(Math.hypot(w[0] - RIG_SHOULDER[0], w[1] - RIG_SHOULDER[1]) - 130)).toBeLessThanOrEqual(ORIGIN_TOL);
    }
  }, SLOW);

  test('too near: the wrist at the inner limit |l0 − l1| on the ray from the head centre; REACH says so', () => {
    // The reference's wrist sits where, on the rig, it is 6 units above the shoulder: inside the 10 units a 70 + 60 arm cannot fold to.
    const want: Pt = [RIG_SHOULDER[0] - RIG_CENTRE[0], RIG_SHOULDER[1] + 6 - RIG_CENTRE[1]];
    // In the pose (eyes 12 px, centre 35 px above the neck), that offset is this wrist, from the neck, picture y down.
    // The set has no turn: a fully folded forearm is far from any drawn angle, and this test is about the reach.
    const a = armTo([want[0], -35 - want[1]]);
    const m = raisedMotion(() => a.ru, () => a.rf);
    const c = setup({ rig: RIG, map: mapOf({ sets: [set({ pose: keySkeleton(a.ru, a.rf), turn: {} })] }), pose: poseDoc(m) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--raised-by-head', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')[0]).toContain('frames 4–11');
    expect(linesOf(r, 'REACH')[0]).toContain('frames 4–11 (t=0.500–1.375s) nearer than |l0 − l1| = 10.0: up to');
    expect(linesOf(r, 'ART-RANGE')).toEqual([]);
    expect(reportOf(report).raised[0]!.short.map((x) => x.how)).toEqual(['near']);
    const rig = rigOffsets(c.build, m);
    const bones = posedBones(c.build, m);
    for (let i = 4; i <= 11; i++) {
      expect(angleBetween(rig[i]!, [want[0] / 12, want[1] / 12])).toBeLessThanOrEqual(0.01);
      const w = tipOf(bones[i]!);
      expect(Math.abs(Math.hypot(w[0] - RIG_SHOULDER[0], w[1] - RIG_SHOULDER[1]) - 10)).toBeLessThanOrEqual(ORIGIN_TOL);
    }
  }, SLOW);

  test('turn holds the upper arm and the re-aimed forearm leaves the wrist short: ART-RANGE on the upper arm with the shortfall in eye distances', () => {
    const c = setup({ rig: RIG, map: mapOf({ sets: [set({ drawn: { sleeve_r0: 70, sleeve_r1: 30 }, turn: { sleeve_r0: [-5, 5], sleeve_r1: [-90, 90] } })] }), pose: poseDoc(RAISED) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--raised-by-head', '--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'RAISED')[0]).toContain('the upper arm held by the set\'s turn on 8 frame(s) (4–11), the forearm re-aimed');
    expect(reportOf(report).raised[0]!.upperHeld).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    const art = linesOf(r, 'ART-RANGE');
    expect(art).toHaveLength(1);
    expect(art[0]).toMatch(/^ART-RANGE set "up" chain "arm_r" bone "sleeve_r0" held at its turn \(range \[-5, 5\]\) frames 4–11 \(t=0\.500–1\.375s\): 1\.000s the re-aimed forearm leaves the wrist up to [0-9.]+ eye distances short of its placed point \(the upper arm asked \+[0-9.]+° from drawn, [0-9.]+° past\) — demand for another drawing of the set$/);
    const entry = (JSON.parse(readFileSync(report, 'utf8')) as { artRange: Array<{ bone: string; shortfall?: number; clamped: boolean }> }).artRange;
    expect(entry).toHaveLength(1);
    expect(entry[0]!.bone).toBe('sleeve_r0');
    expect(entry[0]!.clamped).toBe(true);
    const bones = posedBones(c.build, RAISED);
    let worst = 0;
    for (let i = 4; i <= 11; i++) {
      const b = bones[i]!;
      // The upper arm at its limit.
      expect(Math.abs(Math.abs(wrap(worldAngle(b, 'sleeve_r0') - 70)) - 5)).toBeLessThanOrEqual(ANGLE_TOL);
      // The forearm pointing from the elbow at the target (in reach here: head centre + the reference's offset × 12).
      const ref = refOffset(RAISED, i);
      const target: Pt = [RIG_CENTRE[0] + ref[0] * 12, RIG_CENTRE[1] + ref[1] * 12];
      const e = b.get('sleeve_r1')!;
      const toTarget = Math.atan2(target[1] - e.worldY, target[0] - e.worldX) * DEG;
      expect(Math.abs(wrap(worldAngle(b, 'sleeve_r1') - toTarget))).toBeLessThanOrEqual(ANGLE_TOL);
      // ... and still short of it: the shortfall, read on rig-c's poser.
      const w = tipOf(b);
      worst = Math.max(worst, Math.hypot(w[0] - target[0], w[1] - target[1]) / 12);
    }
    expect(worst).toBeGreaterThan(0.01);
    expect(Math.abs(entry[0]!.shortfall! - worst)).toBeLessThanOrEqual(0.001);
  }, SLOW);

  test('control: turn holds the upper arm where the re-aimed forearm still reaches (the other elbow of the two-bone solve) — no ART-RANGE', () => {
    // A still arm, so the target is one point; the turn admits exactly the mirror elbow, which reaches it too.
    const m = raisedMotion(() => 115, () => 65);
    const ref = refOffset(m, 4);
    const target: Pt = [RIG_CENTRE[0] + ref[0] * 12, RIG_CENTRE[1] + ref[1] * 12];
    const d = Math.hypot(target[0] - RIG_SHOULDER[0], target[1] - RIG_SHOULDER[1]);
    const theta = Math.atan2(target[1] - RIG_SHOULDER[1], target[0] - RIG_SHOULDER[0]) * DEG;
    const alpha = Math.acos((70 * 70 + d * d - 60 * 60) / (2 * 70 * d)) * DEG;
    // The pose bends clockwise, so the solve's own elbow is at θ + α; the mirror at θ − α.
    const mirror = wrap(theta - alpha - 100);
    const c = setup({ rig: RIG, map: mapOf({ sets: [set({ pose: keySkeleton(115, 65), drawn: { sleeve_r0: 100, sleeve_r1: 60 }, turn: { sleeve_r0: [mirror, mirror], sleeve_r1: [-180, 180] } })] }), pose: poseDoc(m) });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'RAISED')[0]).toContain('the upper arm held by the set\'s turn on 8 frame(s) (4–11), the forearm re-aimed');
    expect(linesOf(r, 'ART-RANGE')).toEqual([]);
    expect(offBy(c.build, m, 0.01)).toEqual([]);
  }, SLOW);

  test('a forearm past its own turn after the re-aim: ART-RANGE on the forearm, held there; the upper arm only as a held arm leaving the wrist short', () => {
    const c = setup({ rig: RIG, map: mapOf({ sets: [set({ drawn: { sleeve_r0: 70, sleeve_r1: 30 }, turn: { sleeve_r0: [-5, 5], sleeve_r1: [-5, 5] } })] }), pose: poseDoc(RAISED) });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.status).toBe(0);
    const art = linesOf(r, 'ART-RANGE');
    // The forearm past its own turn, held there; the upper arm appears only as a held arm leaving the wrist short.
    expect(art.some((l) => l.startsWith('ART-RANGE set "up" chain "arm_r" bone "sleeve_r1" turned') && l.includes('held at the limit'))).toBe(true);
    expect(art.every((l) => l.startsWith('ART-RANGE set "up" chain "arm_r" bone "sleeve_r1" turned') || (l.startsWith('ART-RANGE set "up" chain "arm_r" bone "sleeve_r0" held at its turn') && l.includes('eye distances short of its placed point')))).toBe(true);
    const bones = posedBones(c.build, RAISED);
    const out: string[] = [];
    for (let i = 4; i <= 11; i++) {
      for (const [bone, drawn] of [['sleeve_r0', 70], ['sleeve_r1', 30]] as const) {
        const turn = wrap(worldAngle(bones[i]!, bone) - drawn);
        if (Math.abs(turn) > 5 + ANGLE_TOL) out.push(`${bone} frame ${i}: ${turn.toFixed(3)}° from drawn`);
      }
    }
    expect(out).toEqual([]);
  }, SLOW);

  test('RAISED_HEAD: the flag is refused without a head chain, and with one not aimed "a>b"; nothing written', () => {
    for (const [head, says] of [[null, 'no chain of the map carries the eye line'], [headChain('x'), 'chain "head" carries r_eye → l_eye on bone "head", and aims it "x"']] as const) {
      const c = setup({ rig: RIG, map: mapOf({ head }), pose: poseDoc(RAISED) });
      const r = retarget(c, ['--raised-by-head']);
      expect(r.status).toBe(1);
      expect(fails(r)).toHaveLength(1);
      expect(fails(r)[0]).toStartWith('FAIL  RAISED_HEAD: --raised-by-head places a raised arm\'s wrist against the head in eye distances');
      expect(fails(r)[0]).toContain(says);
      expect(existsSync(c.out)).toBe(false);
      // Control: the same map without the flag runs.
      expect(retarget(c).status).toBe(0);
    }
  }, SLOW);

  test('a map whose sets draw no arm raised: the flag writes the same bytes as without it', () => {
    const low = set({ drawn: { sleeve_r0: 30, sleeve_r1: 60 } });
    const a = setup({ rig: RIG, map: mapOf({ sets: [low] }), pose: poseDoc(RAISED) });
    expect(retarget(a).status).toBe(0);
    const first = readFileSync(a.out);
    rmSync(a.out);
    const r = retarget(a, ['--raised-by-head']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')[0]).toContain('frames 4–11');
    expect(linesOf(r, 'RAISED')).toEqual(['RAISED none — no set drawing an arm within 30° of straight up showed; no key moved']);
    expect(readFileSync(a.out).equals(first)).toBe(true);
  }, SLOW);
});

describe('"place": "by-hip" (#93): a hand that meets the body placed by its offset from the hip, in hip widths', () => {
  /**
   * The stick rig's hips are its legs' roots, 30 units apart at (∓15, 300): the mid-hip (0, 300), its right
   * shoulder at (−30, 440), the arm 70 + 60. The pose's hips are 30 px apart too, but its trunk is 100 px against
   * the rig's 150 and its arm 60 + 50: the pose's angles put the rig's hand far from where the reference's is
   * against the hip. The right wrist meets the body on frames 4–11 (the set's key skeleton) and is up elsewhere.
   */
  const RIG: RigOpts = { extra: { sleeve_r0: { seg_low: { image: 'seg.png', x: 30, y: 0, rotation: -90 } } } };
  const ON = (i: number) => i >= 4 && i <= 11;
  const RIG_SHOULDER: Pt = [-30, 440];
  /** The pose's right shoulder, and its mid-hip, picture px (the trunk stands still at 90°, the hip does not travel). */
  const SHOULDER: Pt = [180, 300];
  const MID: Pt = [200, 400];
  /** The pose's right arm angles that put its wrist at mid-hip + w (px, y up), the elbow out to the side. */
  const armTo = (w: Pt): { ru: number; rf: number } => {
    const v: Pt = [MID[0] + w[0] - SHOULDER[0], SHOULDER[1] - (MID[1] - w[1])];
    const d = Math.hypot(v[0], v[1]);
    const th = Math.atan2(v[1], v[0]) * DEG;
    const al = Math.acos((60 * 60 + d * d - 50 * 50) / (2 * 60 * d)) * DEG;
    const ru = th - al;
    const e: Pt = [60 * Math.cos(ru * RAD), 60 * Math.sin(ru * RAD)];
    return { ru, rf: Math.atan2(v[1] - e[1], v[0] - e[0]) * DEG };
  };
  /** The wrist at mid-hip + w(i) on the span, raised (30°, 50°) elsewhere. */
  const handMotion = (w: (i: number) => Pt): Motion => ({ ...BASE, trunk: () => 90, hip: () => [0, 0], ru: (i) => (ON(i) ? armTo(w(i)).ru : 30), rf: (i) => (ON(i) ? armTo(w(i)).rf : 50) });
  /** In front of the hips: (−0.6, 0.6) hip widths on frame 8, drifting. */
  const CLASP = handMotion((i) => [-18 + (i - 8) * 0.8, 18 - (i - 8) * 0.4]);
  /** The set's key skeleton: frame 8 of the motion at twice the scale, elsewhere; the hips are in it. */
  const keySkeleton = (m: Motion): Record<string, Pt> => {
    const p = positions(m, 8);
    const at = (q: Pt): Pt => [1000 + 2 * (q[0] - 200), 1000 + 2 * (q[1] - 400)];
    return Object.fromEntries(['r_shoulder', 'r_elbow', 'r_wrist', 'r_hip', 'l_hip'].map((j) => [j, at(p[j]!)]));
  };
  const set = (m: Motion, o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'clasp', slots: { sleeve_r0: 'seg_low' }, chains: ['arm_r'], pose: keySkeleton(m), place: 'by-hip', ...o });
  const mapOf = (sets: Array<Record<string, unknown>>, chains: ChainSpec[] = baseChains()): Record<string, unknown> => ({ ...baseMap(), chains, alternates: sets });
  /** The reference's wrist − mid-hip on frame i, in `width` px (picture y turned up). */
  const refOffset = (m: Motion, i: number, width = 30): Pt => {
    const p = positions(m, i);
    return [(p.r_wrist![0] - (p.r_hip![0] + p.l_hip![0]) / 2) / width, -(p.r_wrist![1] - (p.r_hip![1] + p.l_hip![1]) / 2) / width];
  };
  const posedBones = (build: string, m: Motion) => poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: m.n - 1 }, () => m.dt)).map((p) => byName(p.bones));
  const tipOf = (b: Map<string, RawBone>): Pt => {
    const f = b.get('sleeve_r1')!;
    return [f.worldX + f.a * 60, f.worldY + f.c * 60];
  };
  /** The rig's wrist − mid-hip (the legs' roots) in its hip widths (30 units), posed by rig-c from the gated build. */
  const rigOffsets = (build: string, m: Motion): Pt[] =>
    posedBones(build, m).map((b) => {
      const r = b.get('leg_r0')!;
      const l = b.get('leg_l0')!;
      const w = tipOf(b);
      return [(w[0] - (r.worldX + l.worldX) / 2) / 30, (w[1] - (r.worldY + l.worldY) / 2) / 30];
    });
  /** Every frame of the span where the rig's wrist is more than `tol` hip widths from the reference's offset, or on the other side of the mid-hip. */
  const offBy = (build: string, m: Motion, tol: number): string[] => {
    const rig = rigOffsets(build, m);
    const out: string[] = [];
    for (let i = 0; i < m.n; i++) {
      if (!ON(i)) continue;
      const r = refOffset(m, i);
      const g = rig[i]!;
      if (!(Math.hypot(g[0] - r[0], g[1] - r[1]) <= tol) || Math.sign(g[0]) !== Math.sign(r[0])) out.push(`frame ${i}: rig (${g[0].toFixed(3)}, ${g[1].toFixed(3)}) want (${r[0].toFixed(3)}, ${r[1].toFixed(3)})`);
    }
    return out;
  };
  type ReportOut = { raised: unknown[]; byHip: Array<{ set: string; chain: string; hips: { rig: number; reference: number }; worst: { before: Pt; after: Pt; placed: number }; short: Array<{ frames: [number, number]; how: string; shortfall: { max: number } }>; upperHeld: number[] }>; artRange: Array<{ bone: string; shortfall?: number; anchor?: string }> };
  const reportOf = (path: string): ReportOut => JSON.parse(readFileSync(path, 'utf8')) as ReportOut;
  const tracksOf = (path: string): Map<string, string[]> => new Map(motionOf(path).animations.dance!.tracks.map((t) => [`${t.bone}.${t.property}`, t.keys.map((k) => JSON.stringify(k))]));

  /** The card's synthetic bar, against a given CLI: written, and the wrist within 0.05 hip widths of the reference's offset on every frame of the span. */
  function byHipTest(cliPath = CLI): { ran: Ran; off: string[]; c: Case } {
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)]), pose: poseDoc(CLASP) });
    const ran = retarget(c, ['--report', join(c.dir, 'report.json')], cliPath);
    return { ran, off: ran.status === 0 ? offBy(c.build, CLASP, 0.05) : [], c };
  }

  test('the wrist lands on the reference\'s offset from the mid-hip within 0.05 hip widths; every key outside the span is the run without "place"\'s', () => {
    const { ran, off, c } = byHipTest();
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(off).toEqual([]);
    expect(linesOf(ran, 'SWITCH')[0]).toContain('frames 4–11');
    const line = linesOf(ran, 'BY-HIP');
    expect(line).toHaveLength(1);
    expect(line[0]).toStartWith('BY-HIP set "clasp" chain "arm_r" frames 4–11 (t=0.500–1.375s): the wrist placed against the hip; hip width (median) rig 30.00 units, reference 30.00 px; wrist − mid-hip in hip widths (x right, y up),');
    expect(line[0]).toEndWith('the upper arm within its turn on every frame; every target in reach');
    expect(linesOf(ran, 'RAISED')).toEqual([]);
    expect(linesOf(ran, 'REACH')).toEqual([]);
    expect(linesOf(ran, 'ART-RANGE')).toEqual([]);
    const rep = reportOf(join(c.dir, 'report.json'));
    expect(rep.raised).toEqual([]);
    expect(rep.byHip).toHaveLength(1);
    // The other direction of #84's control: with `place` declared, the report carries every documented key, `byHip` included.
    const doc = documentedReport();
    expect(doc.conditional).toEqual(['byHip']);
    expect(Object.keys(rep).sort()).toEqual(doc.all);
    expect(rep.byHip[0]!.hips).toEqual({ rig: 30, reference: 30 });
    expect(Math.max(...rep.byHip[0]!.worst.after)).toBeLessThanOrEqual(0.05);
    // Control: the same set without "place" — the pose's angles, on these proportions, miss by more than the bar on every frame.
    const plain = setup({ rig: RIG, map: mapOf([set(CLASP, { place: undefined })]), pose: poseDoc(CLASP) });
    const pr = retarget(plain, ['--report', join(plain.dir, 'report.json')]);
    expect(pr.status).toBe(0);
    // ... and its report has no `byHip` key, and is otherwise the documented set.
    const plainRep = JSON.parse(readFileSync(join(plain.dir, 'report.json'), 'utf8')) as Record<string, unknown>;
    expect('byHip' in plainRep).toBe(false);
    expect(Object.keys(plainRep).sort()).toEqual(doc.all.filter((k) => k !== 'byHip'));
    expect(linesOf(pr, 'BY-HIP')).toEqual([]);
    expect(Math.max(...rep.byHip[0]!.worst.before)).toBeGreaterThan(0.5);
    expect(offBy(plain.build, CLASP, 0.05).length).toBe(8);
    // Outside the span, and on every other track, the keys are the run without "place"'s, byte for byte.
    const a = tracksOf(plain.out);
    const b = tracksOf(c.out);
    expect([...b.keys()]).toEqual([...a.keys()]);
    let moved = 0;
    for (const [track, keys] of a) {
      keys.forEach((k, i) => {
        if ((track === 'sleeve_r0.rotate' || track === 'sleeve_r1.rotate') && ON(i)) moved += b.get(track)![i] === k ? 0 : 1;
        else expect(`${track} ${i} ${b.get(track)![i]}`).toBe(`${track} ${i} ${k}`);
      });
    }
    expect(moved).toBe(16);
  }, SLOW);

  test('mutant: a solve that keeps the pose\'s angles fails the 0.05 bar', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = '          t0[i] = a0;\n          t1[i] = a1;\n';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));
      const { ran, off } = byHipTest(join(d, 'cli.ts'));
      expect(ran.status).toBe(0);
      expect(off.length).toBe(8);
      console.log(`  mutant "the by-hip solve keeps the pose's angles": exit ${ran.status}, ${off.length} frame(s) off, first: ${off[0]}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('mutant: the offset measured in the reference\'s px scaled by the figure, not in hip widths, fails the 0.05 bar', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      // The target off the mid-hip by the reference's px times the figure scale (the trunk's, 1.5), as the pose's angles would put it.
      const from = 'const target: Pt = [h.centre[0] + ref[0] * rigEye, h.centre[1] + ref[1] * rigEye];';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const target: Pt = [h.centre[0] + ref[0] * refEye * (scale?.factor ?? 1), h.centre[1] + ref[1] * refEye * (scale?.factor ?? 1)];'));
      const { ran, off } = byHipTest(join(d, 'cli.ts'));
      expect(ran.status).toBe(0);
      expect(off.length).toBe(8);
      console.log(`  mutant "the offset in figure-scaled px, not hip widths": exit ${ran.status}, ${off.length} frame(s) off, first: ${off[0]}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('the hips may be a pelvis chain\'s "a>b" points: the same placement', () => {
    const pelvis: ChainSpec = { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] };
    const a = setup({ rig: RIG, map: mapOf([set(CLASP)]), pose: poseDoc(CLASP) });
    const b = setup({ rig: RIG, map: mapOf([set(CLASP)], [...baseChains(), pelvis]), pose: poseDoc(CLASP) });
    const ra = retarget(a);
    const rb = retarget(b);
    expect(rb.stderr).toBe('');
    expect(rb.status).toBe(0);
    expect(linesOf(rb, 'BY-HIP')).toEqual(linesOf(ra, 'BY-HIP'));
    expect(offBy(b.build, CLASP, 0.05)).toEqual([]);
  }, SLOW);

  test('out of reach below the shoulder: the ray from the mid-hip points away from the arm, so the wrist goes to the reach\'s point nearest the target; REACH in hip widths, not ART-RANGE', () => {
    // Just above the hips' line: on the rig, about 146 units from the shoulder, past its 130 units of arm. The ray
    // from the mid-hip through that target runs down and away from the shoulder and never enters the reach
    // ("missed"), the case #62's head-relative rule keeps for last; here it is the usual one.
    const m = handMotion((i) => [-10 + (i - 8) * 0.5, -5]);
    const c = setup({ rig: RIG, map: mapOf([set(m)]), pose: poseDoc(m) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'BY-HIP')[0]).toEndWith('out of reach on 8 frame(s) (REACH)');
    const reach = linesOf(r, 'REACH');
    expect(reach).toHaveLength(1);
    expect(reach[0]).toMatch(/^REACH {2}set "clasp" chain "arm_r": the target out of the arm's reach from the shoulder — frames 4–11 \(t=0\.500–1\.375s\) out of reach, and the ray from the mid-hip never enters the reach; placed at the reach's point nearest it: up to [0-9.]+ hip widths short \(median [0-9.]+\); the wrist placed at the reach limit along the hip-relative direction/);
    expect(linesOf(r, 'ART-RANGE')).toEqual([]);
    const rep = reportOf(report);
    expect(rep.byHip[0]!.short.map((s) => s.how)).toEqual(['missed']);
    const bones = posedBones(c.build, m);
    for (let i = 4; i <= 11; i++) {
      const ref = refOffset(m, i);
      // The target: the rig's mid-hip (0, 300) + the reference's offset × 30. The wrist on the line from the shoulder to it, the arm straight.
      const target: Pt = [ref[0] * 30, 300 + ref[1] * 30];
      const w = tipOf(bones[i]!);
      const toTarget = Math.atan2(target[1] - RIG_SHOULDER[1], target[0] - RIG_SHOULDER[0]);
      expect(Math.abs(wrap((Math.atan2(w[1] - RIG_SHOULDER[1], w[0] - RIG_SHOULDER[0]) - toTarget) * DEG))).toBeLessThanOrEqual(0.01);
      expect(Math.abs(Math.hypot(w[0] - RIG_SHOULDER[0], w[1] - RIG_SHOULDER[1]) - 130)).toBeLessThanOrEqual(ORIGIN_TOL);
    }
    // Control: the in-reach clasp prints no REACH (the first test).
  }, SLOW);

  test('turn holds the upper arm and the re-aimed forearm leaves the wrist short: ART-RANGE on the upper arm, in hip widths', () => {
    const c = setup({ rig: RIG, map: mapOf([set(CLASP, { drawn: { sleeve_r0: -160, sleeve_r1: -40 }, turn: { sleeve_r0: [-5, 5], sleeve_r1: [-90, 90] } })]), pose: poseDoc(CLASP) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'BY-HIP')[0]).toContain('the upper arm held by the set\'s turn on 8 frame(s) (4–11), the forearm re-aimed');
    const art = linesOf(r, 'ART-RANGE');
    expect(art).toHaveLength(1);
    expect(art[0]).toMatch(/^ART-RANGE set "clasp" chain "arm_r" bone "sleeve_r0" held at its turn \(range \[-5, 5\]\) frames 4–11 \(t=0\.500–1\.375s\): 1\.000s the re-aimed forearm leaves the wrist up to [0-9.]+ hip widths short of its placed point/);
    const entry = reportOf(report).artRange;
    expect(entry).toHaveLength(1);
    expect(entry[0]!.anchor).toBe('hip');
    // Control: a turn wide enough holds nothing, and no ART-RANGE.
    const wide = setup({ rig: RIG, map: mapOf([set(CLASP, { drawn: { sleeve_r0: -160, sleeve_r1: -40 }, turn: { sleeve_r0: [-90, 90], sleeve_r1: [-90, 90] } })]), pose: poseDoc(CLASP) });
    const rw = retarget(wide);
    expect(rw.status).toBe(0);
    expect(linesOf(rw, 'ART-RANGE')).toEqual([]);
    expect(offBy(wide.build, CLASP, 0.05)).toEqual([]);
  }, SLOW);

  test('a "by-hip" set that never shows: BY-HIP none, and the same bytes as without "place"', () => {
    // Its key skeleton is the clasp's, but the arm never leaves the raised pose.
    const still: Motion = { ...BASE, trunk: () => 90, hip: () => [0, 0], ru: () => 30, rf: () => 50 };
    const a = setup({ rig: RIG, map: mapOf([set(CLASP, { place: undefined })]), pose: poseDoc(still) });
    expect(retarget(a).status).toBe(0);
    const first = readFileSync(a.out);
    rmSync(a.out);
    writeFileSync(a.map, JSON.stringify(mapOf([set(CLASP)]), null, 2));
    const r = retarget(a);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'BY-HIP')).toEqual(['BY-HIP none — no set with "place": "by-hip" showed; no key moved']);
    expect(readFileSync(a.out).equals(first)).toBe(true);
  }, SLOW);

  test('MAP_ALT_PLACE: a placement other than "by-hip", a key skeleton without a hip or the wrist, hips that meet, or no wrist within one hip width — refused by name', () => {
    const without = (...js: string[]): Record<string, Pt> => {
      const k = keySkeleton(CLASP);
      for (const j of js) delete k[j];
      return k;
    };
    const far = keySkeleton(CLASP);
    far.r_wrist = [far.r_hip![0] - 80, far.r_hip![1]];
    const met = keySkeleton(CLASP);
    met.l_hip = [met.r_hip![0], met.r_hip![1]];
    for (const [o, says] of [
      [{ place: 'by-head' }, '"place" is "by-head"; the one placement a set may ask for is "by-hip"'],
      [{ pose: without('l_hip') }, 'its "pose" has no "l_hip"'],
      [{ pose: without('r_hip') }, 'its "pose" has no "r_hip"'],
      [{ pose: without('r_hip', 'l_hip') }, 'its "pose" has no "r_hip" or "l_hip"'],
      [{ pose: without('r_wrist') }, 'its "pose" has no "r_wrist", the wrist of chain "arm_r"'],
      [{ pose: met }, 'its "pose" puts r_hip and l_hip at the same point'],
      [{ pose: far }, 'its "pose" puts no wrist within one hip width of the mid-hip (chain "arm_r" r_wrist '],
    ] as const) {
      const c = setup({ rig: RIG, map: mapOf([set(CLASP, o)]), pose: poseDoc(CLASP) });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r).some((l) => l.includes('MAP_ALT_PLACE') && l.includes('set "clasp"') && l.includes(says))).toBe(true);
      expect(existsSync(c.out)).toBe(false);
      // Control: the same key skeleton without "place" — a hip missing is no refusal there (the chains do not use it).
      if ('pose' in o && !says.includes('r_wrist')) {
        writeFileSync(c.map, JSON.stringify(mapOf([set(CLASP, { ...o, place: undefined })]), null, 2));
        expect(retarget(c).status).toBe(0);
      }
    }
    // Control: the clasp's own key skeleton is read.
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)]), pose: poseDoc(CLASP) });
    expect(retarget(c).status).toBe(0);
  }, SLOW);

  test('PLACE_HIP: a map with neither a hip line aimed "a>b" nor two chains from the hips is refused; nothing written', () => {
    const noLegs = baseChains().filter((c) => !c.name.startsWith('leg'));
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)], noLegs), pose: poseDoc(CLASP) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toHaveLength(1);
    expect(fails(r)[0]).toStartWith('FAIL  PLACE_HIP: "place": "by-hip" places a wrist against the hip in hip widths');
    expect(fails(r)[0]).toEndWith('the map has neither (no chain starts at r_hip or l_hip)');
    expect(existsSync(c.out)).toBe(false);
    // Control: the same map without "place" runs.
    writeFileSync(c.map, JSON.stringify(mapOf([set(CLASP, { place: undefined })], noLegs), null, 2));
    expect(retarget(c).status).toBe(0);
  }, SLOW);

  test('PLACE_HIPS: a reference whose hips meet over the span (no unit) is refused', () => {
    const together = (i: number, j: JointsDoc): void => {
      if (!ON(i)) return;
      const r = j.r_hip!.at as Pt;
      const l = j.l_hip!.at as Pt;
      const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
      j.r_hip = { state: 'observed', at: mid, score: 0.9 };
      j.l_hip = { state: 'observed', at: [mid[0], mid[1]], score: 0.9 };
    };
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)], baseChains().map((x) => (x.name.startsWith('leg') ? { ...x, bend: 'free' } : x))), pose: poseDoc(CLASP, together) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.startsWith('FAIL  PLACE_HIPS: "place": "by-hip": set "clasp" places chain "arm_r"\'s wrist against the hip: over frames 4–11 the median hip width is 0px in the reference (r_hip, l_hip)'))).toBe(true);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('PLACE_CHAIN: a placed chain the two-bone solve cannot turn is refused', () => {
    const chains = baseChains().map((x) => (x.name === 'arm_r' ? { ...x, aim: ['x', 'sleeve_r1>sleeve_r1:tip'] } : x));
    const c = setup({ rig: RIG, map: mapOf([set(CLASP)], chains), pose: poseDoc(CLASP) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.startsWith('FAIL  PLACE_CHAIN: "place": "by-hip": set "clasp" places chain "arm_r"\'s wrist against the hip, and it aims ["x","sleeve_r1>sleeve_r1:tip"]'))).toBe(true);
    // Control: without "place" the same aims run.
    writeFileSync(c.map, JSON.stringify(mapOf([set(CLASP, { place: undefined })], chains), null, 2));
    expect(retarget(c).status).toBe(0);
  }, SLOW);

  test('PLACE_BOTH: with --raised-by-head, a chain drawn raised that "by-hip" also places is refused', () => {
    const head = (b: BoneSpec[]): BoneSpec[] => [...b, { name: 'head', parent: 'neck', x: 0, y: 20 }, { name: 'eye_r', parent: 'head', x: -6, y: 10 }, { name: 'eye_l', parent: 'head', x: 6, y: 10 }];
    const rig: RigOpts = { ...RIG, bones: head };
    const chains = [...baseChains(), { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] }];
    const c = setup({ rig, map: mapOf([set(CLASP, { drawn: { sleeve_r0: 100 } })], chains), pose: poseDoc(CLASP) });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.startsWith('FAIL  PLACE_BOTH: set "clasp" chain "arm_r": --raised-by-head places its wrist against the head'))).toBe(true);
    expect(existsSync(c.out)).toBe(false);
    // Control: without the flag, "by-hip" alone places it.
    const ok = retarget(c);
    expect(ok.status).toBe(0);
    expect(linesOf(ok, 'BY-HIP')).toHaveLength(1);
  }, SLOW);
});

describe('#110: clampArt eases at set edges, and capShortSteps caps foreshortened steps', () => {
  test('clampArt eases in and out at set edges so the boundary step stays within 3° of the picture step, while interior and outside frames are unchanged', () => {
    const n = 28;
    // Reference sits at -55 outside [4, 23] and -50 inside [4, 23] (+5° picture step in, -5° picture step out).
    // Set "lift" has drawn -80 and turn [-10, 10], so the clamped angle inside is -70 (20° off the reference, eased over 6 frames).
    const asked = Array.from({ length: n }, (_, i) => (i >= 4 && i <= 23 ? -50 : -55));
    const targets = new Map<string, number[]>([['sleeve_r0', [...asked]]]);
    const sw = [{ set: 'lift', slots: { sleeve_r0: 'seg_up' }, hides: [], chains: ['arm_r'], frames: [4, 23] as [number, number], from: 0.5, to: 3, seconds: 2.5, distance: { max: 0, median: 0 }, artTurn: {}, offsets: {}, place: null, moved: { on: null, off: null } }];
    const map = { translate: null, chains: [], alternates: [{ name: 'lift', slots: { sleeve_r0: 'seg_up' }, hides: [], chains: ['arm_r'], pose: {}, drawn: { sleeve_r0: -80 }, turn: { sleeve_r0: [-10, 10] as [number, number] }, offsets: {}, place: null, frames: null }] };
    clampArt(sw, map, targets);
    const got = targets.get('sleeve_r0')!;
    // Outside [4, 23] and interior [10, 17] are unchanged from unclamped / fully clamped.
    for (let i = 0; i <= 3; i++) expect(got[i]).toBe(-55);
    for (let i = 10; i <= 17; i++) expect(got[i]).toBe(-70);
    for (let i = 24; i < n; i++) expect(got[i]).toBe(-55);
    // Entry step (3 -> 4) and exit step (23 -> 24): rig step minus picture step <= 3°.
    const inDiff = wrap(got[4]! - got[3]!) - wrap(asked[4]! - asked[3]!);
    const outDiff = wrap(got[24]! - got[23]!) - wrap(asked[24]! - asked[23]!);
    expect(Math.abs(inDiff)).toBeLessThanOrEqual(3);
    expect(Math.abs(outDiff)).toBeLessThanOrEqual(3);
  });

  test('mutant (#110): without edge easing in clampArt, the boundary step jumps by the full clamp offset and the <= 3° check is red', async () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm110-art-'));
    try {
      const src = readFileSync(join(ROOT, 'src', 'switch.ts'), 'utf8');
      const from = 'const easeIn = a > 0 && da !== 0 && Math.sign(delta(a - 1)) === Math.sign(da)';
      expect(src.split(from)).toHaveLength(2);
      const mutated = src
        .replace(from, 'const easeIn = false && a > 0 && da !== 0 && Math.sign(delta(a - 1)) === Math.sign(da)')
        .replace('const easeOut = b + 1 < n && db !== 0 && Math.sign(delta(b + 1)) === Math.sign(db)', 'const easeOut = false && b + 1 < n');
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      writeFileSync(join(d, 'src', 'switch.ts'), mutated);
      const mod = await import(join(d, 'src', 'switch.ts')) as typeof import('../src/switch.ts');
      const asked = Array.from({ length: 28 }, (_, i) => (i >= 4 && i <= 23 ? -50 : -55));
      const targets = new Map<string, number[]>([['sleeve_r0', [...asked]]]);
      const sw = [{ set: 'lift', slots: { sleeve_r0: 'seg_up' }, hides: [], chains: ['arm_r'], frames: [4, 23] as [number, number], from: 0.5, to: 3, seconds: 2.5, distance: { max: 0, median: 0 }, artTurn: {}, offsets: {}, place: null, moved: { on: null, off: null } }];
      const map = { translate: null, chains: [], alternates: [{ name: 'lift', slots: { sleeve_r0: 'seg_up' }, hides: [], chains: ['arm_r'], pose: {}, drawn: { sleeve_r0: -80 }, turn: { sleeve_r0: [-10, 10] as [number, number] }, offsets: {}, place: null, frames: null }] };
      mod.clampArt(sw, map, targets);
      const got = targets.get('sleeve_r0')!;
      const inDiff = wrap(got[4]! - got[3]!) - wrap(asked[4]! - asked[3]!);
      console.log(`  mutant "no clampArt edge easing": boundary step diff is ${inDiff.toFixed(2)}°`);
      expect(Math.abs(inDiff)).toBeGreaterThan(3);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('capShortSteps spreads a > 30° step when fraction < 0.60 to <= 30°/frame, stays inside uncovered spans, and leaves keys away from the step unchanged', () => {
    // 12 frames: angle steps from 0° to 54° between frame 4 and frame 5 while fraction dips to 0.50 (above 0.35, below 0.60).
    const angles = [0, 0, 0, 0, 0, 54, 54, 54, 54, 54, 54, 54];
    const fraction = [1, 1, 1, 1, 0.50, 0.55, 1, 1, 1, 1, 1, 1];
    expect(holdShort(angles, fraction, 0.35)).toEqual([]);
    const capped = capShortSteps(angles, fraction);
    expect(capped).toEqual([{ frames: [4, 5], minFraction: 0.5, step: 18, asked: 54 }]);
    for (let i = 1; i < angles.length; i++) {
      expect(Math.abs(wrap(angles[i]! - angles[i - 1]!))).toBeLessThanOrEqual(30);
    }
    // Frames outside [4, 5] are untouched.
    expect(angles.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(angles.slice(6)).toEqual([54, 54, 54, 54, 54, 54]);
    const times = angles.map((_, i) => i * 0.125);
    expect(shortLine({ chain: 'arm_l', bone: 'sleeve_l1', joints: ['l_elbow', 'l_wrist'], ...capped[0]! }, times, 0.35)).toBe(
      'chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) frames 4–5 (t=0.500–0.625s): picture length down to 0.50 of its median, under 0.60, turned +54.0° in one frame (over 30°); spread to +18.0° per frame',
    );
  });

  test('mutant (#110): without capShortSteps a foreshortened segment at 0.50 of median jumps > 30° in one frame', () => {
    const angles = [0, 0, 0, 0, 0, 54, 54, 54, 54, 54, 54, 54];
    const fraction = [1, 1, 1, 1, 0.50, 0.55, 1, 1, 1, 1, 1, 1];
    holdShort(angles, fraction, 0.35);
    let maxStep = 0;
    for (let i = 1; i < angles.length; i++) maxStep = Math.max(maxStep, Math.abs(wrap(angles[i]! - angles[i - 1]!)));
    console.log(`  mutant "no capShortSteps": max step is ${maxStep.toFixed(1)}°`);
    expect(maxStep).toBeGreaterThan(30);
  });
});

describe('#107: --leg-scale clamp floor does not lift the hip, and POSTURE reads the bounce per support span', () => {
  const THIGH = -95;
  const SHIN = -97;
  const N = 24;
  const DT = 1 / 24;
  /** Knee bend asks down to 0.70 on frame 12, below the 0.85 clamp floor. */
  const askF = (i: number): number => (i < 6 || i > 18 ? 1 : 1 - 0.30 * Math.sin(((i - 6) / 12) * Math.PI));
  const STILL: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };
  const V = add(dir(THIGH, 80), dir(SHIN, 70));
  const W: Pt = [80 * Math.cos(THIGH * RAD) + 70 * Math.cos(SHIN * RAD), 80 * Math.sin(THIGH * RAD) + 70 * Math.sin(SHIN * RAD)];

  function bendPose(): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const drop: Pt = [(1 - askF(i)) * V[0], (1 - askF(i)) * V[1]];
      for (const [name, at] of Object.entries(j)) {
        const a = at.at as Pt;
        if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
        j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
      }
      for (const s of ['r', 'l'] as const) {
        const hip = j[`${s}_hip`]!.at as Pt;
        const knee = add(hip, dir(THIGH, 80 * askF(i)));
        const ankle = add(knee, dir(SHIN, 70 * askF(i)));
        j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
        j[`${s}_ankle`] = { state: 'observed', at: ankle, score: 0.9 };
      }
    });
  }

  function mapWithPelvis(): Record<string, unknown> {
    return {
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
      ],
    };
  }

  test('a leg asking below the clamp floor holds the bone at the floor without lifting the hip, every scale lands, and POSTURE prints the bounce per support span', () => {
    const c = setup({ map: mapWithPelvis(), pose: bendPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.85,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // Landing holds every scale.
    const lands = linesOf(r, 'LAND');
    expect(lands.filter((l) => l.includes(' scale — '))).toHaveLength(4);
    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const hip0 = byName(poses[0]!.bones).get('hip')!;
    for (let i = 0; i < N; i++) {
      const b = byName(poses[i]!.bones);
      // The supporting leg (r) scales to askF(i) so its ankle stays on #85's floor (#133); the free leg (l) is held at the 0.85 clamp floor.
      const wantSupport = askF(i);
      const wantFree = Math.max(0.85, askF(i));
      for (const seg of ['leg_r0', 'leg_r1']) {
        expect(Math.abs(Math.hypot(b.get(seg)!.a, b.get(seg)!.c) - wantSupport)).toBeLessThan(1e-4);
      }
      for (const seg of ['leg_l0', 'leg_l1']) {
        expect(Math.abs(Math.hypot(b.get(seg)!.a, b.get(seg)!.c) - wantFree)).toBeLessThan(1e-4);
      }
      // The hip is placed from the asked scale askF(i), not lifted by the 0.85 clamp floor.
      const wantHip: Pt = [hip0.worldX + (1 - askF(i)) * W[0], hip0.worldY + (1 - askF(i)) * W[1]];
      const h = b.get('hip')!;
      expect(Math.hypot(h.worldX - wantHip[0], h.worldY - wantHip[1])).toBeLessThan(0.05);
    }
    const posture = linesOf(r, 'POSTURE');
    const bounceLine = posture.find((l) => l.startsWith('POSTURE bounce r 0–23'));
    expect(bounceLine).toBeDefined();
    expect(bounceLine).toContain('r=1.000');
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { posture: { bounce: Array<{ side: string; frames: [number, number]; hip: { ratio: number; corr: number }; neck: { ratio: number; corr: number }; eyesNeck: { ratio: number; corr: number | null } }> } };
    expect(rep.posture.bounce).toHaveLength(1);
    expect(rep.posture.bounce[0]!.side).toBe('r');
    expect(rep.posture.bounce[0]!.frames).toEqual([0, 23]);
    expect(rep.posture.bounce[0]!.hip.corr).toBeCloseTo(1, 5);
    expect(rep.posture.bounce[0]!.neck.corr).toBeCloseTo(1, 5);
    expect(rep.posture.bounce[0]!.eyesNeck.ratio).toBeNull();
  }, SLOW);

  test('mutant (#107): placing the hip from the clamped scale lifts the hip when the leg asks below the floor', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm107-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const lp = poseLegsWith(i, askedScales);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const lp = poseLegs(i);'));
      const c = setup({ map: mapWithPelvis(), pose: bendPose() });
      const r = retarget(c, ['--leg-scale', '0.85,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const hip0 = byName(poses[0]!.bones).get('hip')!;
      const hip12 = byName(poses[12]!.bones).get('hip')!;
      const wantY = hip0.worldY + (1 - askF(12)) * W[1];
      const lift = hip12.worldY - wantY;
      console.log(`  mutant "plantHip from clamped scale": frame 12 hip lifted by +${lift.toFixed(2)} units`);
      expect(lift).toBeGreaterThan(20);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#111: the head chain nods from the eyes\' vertical travel against the neck', () => {
  const N = 24;
  const DT = 1 / 24;
  const headRig = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });
  const rollDeg = (i: number): number => 12 * Math.sin((i / N) * 2 * Math.PI);
  /** World vertical nod in rig units: 0 on frames [0, 2] and [21, 23] (<0.5s so clean's stillness hold does not blend), and a known -0.4 dip inside. */
  const nodY = (i: number): number => (i >= 2 && i <= 21 ? -0.4 * Math.sin(((i - 2) / 19) * Math.PI) : 0);

  function nodPose(withNod: boolean, withRoll = false): Record<string, unknown> {
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90 };
    return poseDoc(m, (i, j) => {
      // Keep right foot planted as support so --plant-feet emits POSTURE bounce r 0–23.
      j.r_ankle = { state: 'observed', at: [-20, 350], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [20, 320], score: 0.9 };
      const r = j.r_eye!.at as Pt;
      const l = j.l_eye!.at as Pt;
      const dyPic = withNod ? -nodY(i) / SCALE : 0;
      const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2 + dyPic];
      const d = dir(withRoll ? rollDeg(i) : 0, 6);
      j.r_eye = { state: 'observed', at: [mid[0] - d[0], mid[1] - d[1]], score: 0.9 };
      j.l_eye = { state: 'observed', at: [mid[0] + d[0], mid[1] + d[1]], score: 0.9 };
    });
  }

  test('a known nod is keyed on head.translate, POSTURE eyes − neck ratio is >= 0.5, and roll is unchanged where the reference does not nod', () => {
    const cNod = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: nodPose(true, false) });
    const report = join(cNod.dir, 'report.json');
    const rNod = retarget(cNod, ['--plant-feet', '--report', report]);
    expect(rNod.stderr).toBe('');
    expect(rNod.status).toBe(0);

    // Bar 2: roll is unchanged where the reference does not nod (and on every frame when roll is present).
    const cRollNod = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: nodPose(true, true) });
    const cRollFlat = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: nodPose(false, true) });
    expect(retarget(cRollNod, ['--plant-feet']).status).toBe(0);
    expect(retarget(cRollFlat, ['--plant-feet']).status).toBe(0);
    const tracksRollNod = motionOf(cRollNod.out).animations.dance!.tracks;
    const tracksRollFlat = motionOf(cRollFlat.out).animations.dance!.tracks;
    const headRotNod = tracksRollNod.find((t) => t.bone === 'head' && t.property === 'rotate')!;
    const headRotFlat = tracksRollFlat.find((t) => t.bone === 'head' && t.property === 'rotate')!;
    expect(headRotNod.keys).toEqual(headRotFlat.keys);
    expect(tracksRollFlat.find((t) => t.bone === 'head' && t.property === 'translate')).toBeUndefined();

    // Bar 3: a known nod is keyed on head.translate, and the posed eyes − neck vertical travel matches nodY(i).
    const tracksNod = motionOf(cNod.out).animations.dance!.tracks;
    const headTrans = tracksNod.find((t) => t.bone === 'head' && t.property === 'translate');
    expect(headTrans).toBeDefined();
    for (const i of [0, 1, 2, 21, 22, 23]) {
      expect(headTrans!.keys[i]!.v).toEqual([0, 0]);
    }
    const poses = poseRawAnimation(loadBuild(cNod.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const b0 = byName(poses[0]!.bones);
    const baseEN = (b0.get('eye_r')!.worldY + b0.get('eye_l')!.worldY) / 2 - b0.get('neck')!.worldY;
    poses.forEach((p, i) => {
      const b = byName(p.bones);
      const en = (b.get('eye_r')!.worldY + b.get('eye_l')!.worldY) / 2 - b.get('neck')!.worldY;
      expect(Math.abs(en - (baseEN + nodY(i)))).toBeLessThan(0.01);
    });

    // Bar 1: POSTURE bounce row reads eyes − neck ratio >= 0.5.
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { posture: { bounce: Array<{ eyesNeck: { rig: number; reference: number; ratio: number; corr: number } }> } };
    expect(rep.posture.bounce).toHaveLength(1);
    expect(rep.posture.bounce[0]!.eyesNeck.ratio).toBeGreaterThanOrEqual(0.5);
    expect(rep.posture.bounce[0]!.eyesNeck.ratio).toBeCloseTo(1, 3);
    expect(rep.posture.bounce[0]!.eyesNeck.corr).toBeCloseTo(1, 5);
  }, SLOW);

  test('mutant (#111): without the head nod channel, the posed head reads 0 vertical travel against the neck', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm111-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'if (headNodTrack !== null) tracks.push(headNodTrack);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));
      const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: nodPose(true, false) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { posture: { bounce: Array<{ eyesNeck: { rig: number; reference: number; ratio: number } }> } };
      console.log(`  mutant "without headNodTrack": eyesNeck rig sd ${rep.posture.bounce[0]!.eyesNeck.rig.toFixed(4)}u, ratio ${rep.posture.bounce[0]!.eyesNeck.ratio.toFixed(4)}`);
      expect(rep.posture.bounce[0]!.eyesNeck.rig).toBeCloseTo(0, 6);
      expect(rep.posture.bounce[0]!.eyesNeck.ratio).toBeCloseTo(0, 6);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#133: a supporting leg that asks under --leg-scale\'s floor is scaled to its own range so its ankle stays on #85\'s floor', () => {
  const THIGH = -90;
  const SHIN = -90;
  const N = 24;
  const DT = 1 / 24;
  /** Knee bend asks down to 0.60 on frame 12, below the 0.80 clamp floor. */
  const askF = (i: number): number => (i < 6 || i > 18 ? 1 : 1 - 0.40 * Math.sin(((i - 6) / 12) * Math.PI));
  const STILL: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };
  const V = add(dir(THIGH, 80), dir(SHIN, 70));
  const BONE_LEN = 80 + 70;

  /** Right foot is planted as the supporting leg on the floor; left foot is lifted in the air as the free leg; both legs ask askF(i) down to 0.60. */
  function supportAndFreeBendPose(): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const drop: Pt = [(1 - askF(i)) * V[0], (1 - askF(i)) * V[1]];
      for (const [name, at] of Object.entries(j)) {
        const a = at.at as Pt;
        if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
        j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
      }
      for (const s of ['r', 'l'] as const) {
        const hip = j[`${s}_hip`]!.at as Pt;
        const knee = add(hip, dir(THIGH, 80 * askF(i)));
        const ankle = add(knee, dir(SHIN, 70 * askF(i)));
        j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
        j[`${s}_ankle`] = { state: 'observed', at: ankle, score: 0.9 };
      }
    });
  }

  function mapWithPelvis(): Record<string, unknown> {
    return {
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
      ],
    };
  }

  test('supporting leg asking 0.6 with floor 0.8 scales to 0.6 and plants on #85\'s floor, while free leg asking 0.6 stays clamped at 0.8', () => {
    const c = setup({ map: mapWithPelvis(), pose: supportAndFreeBendPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    // Summary lines print LEG-SCALE past the floor (support) for leg_r0 and leg_r1, and not for free leg_l0/leg_l1.
    const supportLines = r.stdout.split('\n').filter((l) => l.includes('LEG-SCALE past the floor (support):'));
    expect(supportLines).toHaveLength(2);
    expect(supportLines[0]).toContain('chain "leg_r" bone "leg_r0" (supporting foot r) frames 9–15');
    expect(supportLines[0]).toContain('asked 0.6000–0.7172 under 0.8, used 0.6000–0.7172');
    expect(supportLines[1]).toContain('chain "leg_r" bone "leg_r1" (supporting foot r) frames 9–15');
    expect(supportLines.some((l) => l.includes('leg_l0') || l.includes('leg_l1'))).toBe(false);

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const b0 = byName(poses[0]!.bones);
    const ankleY = (b: Map<string, RawBone>): number => {
      const s1 = b.get('leg_r1')!;
      return s1.worldY + s1.c * 70;
    };
    const floorAnkleY = ankleY(b0);

    for (let i = 0; i < N; i++) {
      const b = byName(poses[i]!.bones);
      const wantSupport = askF(i);
      const wantFree = Math.max(0.8, askF(i));
      // Supporting right leg scales down to 0.60 (its own range) and its ankle stays on #85's floor.
      for (const seg of ['leg_r0', 'leg_r1']) {
        expect(Math.abs(Math.hypot(b.get(seg)!.a, b.get(seg)!.c) - wantSupport)).toBeLessThan(1e-4);
      }
      expect(Math.abs(ankleY(b) - floorAnkleY)).toBeLessThan(0.05);
      // Free left leg asking 0.60 stays clamped at 0.80.
      for (const seg of ['leg_l0', 'leg_l1']) {
        expect(Math.abs(Math.hypot(b.get(seg)!.a, b.get(seg)!.c) - wantFree)).toBeLessThan(1e-4);
      }
    }

    // Report JSON records support runs on leg_r0 and leg_r1, and not on leg_l0 or leg_l1.
    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      legScale: Array<{ chain: string; bone: string; support?: Array<{ side: string; frames: [number, number]; asked: { min: number; max: number }; used: { min: number; max: number } }> }>;
    };
    const r0 = rep.legScale.find((ls) => ls.bone === 'leg_r0')!;
    const r1 = rep.legScale.find((ls) => ls.bone === 'leg_r1')!;
    const l0 = rep.legScale.find((ls) => ls.bone === 'leg_l0')!;
    const l1 = rep.legScale.find((ls) => ls.bone === 'leg_l1')!;
    expect(r0.support).toBeDefined();
    expect(r0.support).toHaveLength(1);
    expect(r0.support![0]!.side).toBe('r');
    expect(r0.support![0]!.frames).toEqual([9, 15]);
    expect(r0.support![0]!.asked.min).toBeCloseTo(0.6, 3);
    expect(r0.support![0]!.used.min).toBeCloseTo(0.6, 3);
    expect(r1.support).toBeDefined();
    expect(l0.support).toBeUndefined();
    expect(l1.support).toBeUndefined();
  }, SLOW);

  test('when the lower bound is above asked on a supporting frame, scaleSupport clamps at the bound and lifts the hip by the remainder', () => {
    const legScale: LegScale[] = [
      {
        chain: 'leg_r',
        bone: 'leg_r0',
        joints: ['r_hip', 'r_knee'],
        straight: 80,
        ratio: { min: 0.6, median: 0.6, max: 0.6 },
        limits: [0.8, 1.05],
        low: [[0, 0]],
        high: [],
        scale: [0.8],
        asked: [0.6],
        picture: [0.6],
      },
      {
        chain: 'leg_r',
        bone: 'leg_r1',
        joints: ['r_knee', 'r_ankle'],
        straight: 70,
        ratio: { min: 0.6, median: 0.6, max: 0.6 },
        limits: [0.8, 1.05],
        low: [[0, 0]],
        high: [],
        scale: [0.8],
        asked: [0.6],
        picture: [0.6],
      },
    ];
    const scales = new Map<string, number[]>([
      ['leg_r0', [0.8]],
      ['leg_r1', [0.8]],
    ]);
    const feet: Feet = {
      legLength: { r: 150, l: 150 },
      support: ['r'],
      supports: [{ side: 'r', frames: [0, 0] }],
      jumps: [],
      steps: [],
      changes: [],
    };
    const rChain: Chain = { name: 'leg_r', bones: ['leg_r0', 'leg_r1'], joints: ['r_hip', 'r_knee', 'r_ankle'], aim: ['x', 'x'], reach: false, bend: 'free', range: {} };
    const lChain: Chain = { name: 'leg_l', bones: ['leg_l0', 'leg_l1'], joints: ['l_hip', 'l_knee', 'l_ankle'], aim: ['x', 'x'], reach: false, bend: 'free', range: {} };
    const hip: Pt[] = [[0, 100]];
    // Supporting leg asks 0.60, floor is 0.80, and an explicit lower bound of 0.70 clamps at max(0.60, min(0.80, 0.70)) = 0.70.
    // The remaining (0.70 - 0.60) = 0.10 of downward leg vector (0, -150) lifts the hip by +15u so the ankle still meets the floor.
    scaleSupport(
      legScale,
      scales,
      feet,
      { r: { chain: rChain, ankleBone: 'leg_r1' }, l: { chain: lChain, ankleBone: 'leg_l1' } },
      hip,
      () => [0, -0.6 * BONE_LEN],
      () => [0, -(scales.get('leg_r0')![0]! * 80 + scales.get('leg_r1')![0]! * 70)],
      { r: [0.7], l: [1.0] },
    );
    expect(scales.get('leg_r0')![0]).toBeCloseTo(0.7, 6);
    expect(scales.get('leg_r1')![0]).toBeCloseTo(0.7, 6);
    expect(hip[0]![1]).toBeCloseTo(115, 6);
    expect(legScale[0]!.support).toEqual([
      { side: 'r', frames: [0, 0], asked: { min: 0.6, max: 0.6 }, used: { min: 0.7, max: 0.7 }, clamped: { bound: 0.7, hipRise: 15 } },
    ]);
  });

  test('mutant (#133): clamping the supporting leg at 0.8 puts the ankle 0.2 * bone below #85\'s floor', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm133-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'scaleSupport(legScale, scales, feet, L, hip, (i, s) => offsets[i]![s], (i, s) => tipOf(rest, poseLegs(i), L[s].ankleBone));';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));
      const c = setup({ map: mapWithPelvis(), pose: supportAndFreeBendPose() });
      const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const ankleY = (b: Map<string, RawBone>): number => {
        const s1 = b.get('leg_r1')!;
        return s1.worldY + s1.c * 70;
      };
      const floorAnkleY = ankleY(byName(poses[0]!.bones));
      const ankle12Y = ankleY(byName(poses[12]!.bones));
      const dropBelowFloor = floorAnkleY - ankle12Y;
      console.log(`  mutant "supporting leg clamped at 0.8": frame 12 ankle is ${dropBelowFloor.toFixed(2)}u below floor (0.2 * ${BONE_LEN} = ${(0.2 * BONE_LEN).toFixed(2)}u)`);
      expect(Math.abs(dropBelowFloor - 0.2 * BONE_LEN)).toBeLessThan(0.05);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#137: under --stance and --leg-scale, a straight stance leg whose shin was shortened below STANCE_BOUNDS[0] restores its shin before stretching to the floor', () => {
  const THIGH = -90;
  const SHIN = -90;
  const N = 24;
  const DT = 1 / 24;
  const BONE_LEN = 80 + 70;
  const STILL: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };

  /**
   * Right foot (`r`) supports on every frame at full length (90 + 60 = 150 px).
   * Left foot (`l`, free) stands beside it in a `state = 'both'` stance:
   * - frames 0–11: thigh 90 px, shin 60 px, total 150 px (both sides share straight thigh 90 px, shin 60 px);
   * - frames 12–23 (held ending span): l_ankle is 10 px (0.0667 leg lengths, within `--stance 0.07`) above r_ankle while l_knee stays at 90 px below l_hip, so the whole leg is 140 / 150 = 0.9333 >= 0.92 (not folded), the thigh is 90 / 90 = 1.00 >= 0.92, and the shin is 50 / 60 = 0.8333 < 0.92.
   */
  function endingShortShinPose(): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const rHip = j.r_hip!.at as Pt;
      j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 90], score: 0.9 };
      j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150], score: 0.9 };
      const lHip = j.l_hip!.at as Pt;
      const ankleLen = i < 12 ? 150 : 140;
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 90], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + ankleLen], score: 0.9 };
    });
  }

  function mapWithPelvis(): Record<string, unknown> {
    return {
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
      ],
    };
  }

  test('restores the shortened shin on the ending span so both ankles land on #85\'s floor with no stance.over, while leaving earlier frames and the supporting leg unchanged', () => {
    const c = setup({ map: mapWithPelvis(), pose: endingShortShinPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      feet: { floor: number };
      stance: { over: unknown[]; runs: Array<{ state: string; side: string; frames: [number, number] }> };
    };
    expect(rep.stance.runs.map((x) => [x.state, x.side, x.frames])).toEqual([['both', 'l', [0, 23]]]);
    expect(rep.stance.over).toEqual([]);

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const ankleOf = (b: Map<string, RawBone>, side: 'r' | 'l'): Pt => {
      const s1 = b.get(`leg_${side}1`)!;
      return [s1.worldX + s1.a * 70, s1.worldY + s1.c * 70];
    };
    const floorY = rep.feet.floor;

    for (let i = 0; i < N; i++) {
      const b = byName(poses[i]!.bones);
      const ar = ankleOf(b, 'r');
      const al = ankleOf(b, 'l');
      // Both the supporting right ankle and the stance left ankle sit on #85's floor on every frame.
      expect(Math.abs(ar[1] - floorY)).toBeLessThan(0.05);
      expect(Math.abs(al[1] - floorY)).toBeLessThan(0.05);
      if (i >= 12) {
        // On the ending span (12–23), both thigh and shin of the stance leg are un-squashed (~1.00) and knees are level.
        expect(Math.hypot(b.get('leg_l0')!.a, b.get('leg_l0')!.c)).toBeCloseTo(1, 3);
        expect(Math.hypot(b.get('leg_l1')!.a, b.get('leg_l1')!.c)).toBeCloseTo(1, 3);
        expect(Math.abs(b.get('leg_l1')!.worldY - b.get('leg_r1')!.worldY)).toBeLessThan(0.05);
      }
    }
  }, SLOW);

  test('mutant (#137): without unshortenStanceShin the ending span exceeds STANCE_BOUNDS[1], floats off #85\'s floor, and leaves frames 0–11 and leg_r byte-identical', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm137-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'legScaleOn ? unshortenStanceShin(scales, L, posedFeet, lower) : posedFeet';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'posedFeet'));

      const cPkg = setup({ map: mapWithPelvis(), pose: endingShortShinPose() });
      const rPkg = retarget(cPkg, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07']);
      expect(rPkg.status).toBe(0);
      const pkgMotion = motionOf(cPkg.out);

      const cMut = setup({ map: mapWithPelvis(), pose: endingShortShinPose() });
      const mReport = join(cMut.dir, 'report.json');
      const rMut = retarget(cMut, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07', '--report', mReport], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutMotion = motionOf(cMut.out);

      // Bar 2: outside the ending span (frames 0–11), and on the supporting right leg across all frames, keys are byte-identical.
      for (let t = 0; t < pkgMotion.animations.dance!.tracks.length; t++) {
        const pt = pkgMotion.animations.dance!.tracks[t]!;
        const mt = mutMotion.animations.dance!.tracks[t]!;
        for (let i = 0; i < 12; i++) {
          expect(pt.keys[i]).toEqual(mt.keys[i]);
        }
        if ('bone' in pt && (pt.bone === 'leg_r0' || pt.bone === 'leg_r1' || pt.bone === 'hip')) {
          expect(pt.keys).toEqual(mt.keys);
        }
      }

      // Bar 3: on the mutant, frames 12–23 exceed 1.08 (stance.over non-empty) and the left ankle floats off #85's floor.
      const rep = JSON.parse(readFileSync(mReport, 'utf8')) as {
        feet: { floor: number };
        stance: { over: Array<{ side: string; frames: [number, number]; needed: number; left: number }> };
      };
      expect(rep.stance.over).toHaveLength(1);
      expect(rep.stance.over[0]!.side).toBe('l');
      expect(rep.stance.over[0]!.frames).toEqual([12, 23]);
      expect(rep.stance.over[0]!.needed).toBeGreaterThan(1.08);

      const poses = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const b15 = byName(poses[15]!.bones);
      const s1 = b15.get('leg_l1')!;
      const ankle15Y = s1.worldY + s1.c * 70;
      const gap = ankle15Y - rep.feet.floor;
      console.log(`  mutant "without unshortenStanceShin": frame 15 needed k ${rep.stance.over[0]!.needed.toFixed(4)} > 1.08, left ankle ${gap.toFixed(2)}u (${(gap / BONE_LEN).toFixed(4)} leg lengths) above floor`);
      expect(gap).toBeGreaterThan(0.3);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('leg-scale (#148): one straight length per segment for both legs, so consecutive landings on opposite feet place the hip at the same height', () => {
  const N = 24;
  const DT = 1 / 24;
  const THIGH = 90;
  const SHIN = 90;
  const BONE_LEN = 150;

  /**
   * Two consecutive landings on opposite feet (`r` on frames 0–3, flight on 4–9, `l` on frames 10–13, flight on 14–19, `r` on 20–23):
   * - On right-support frames (`0–3, 20–23`), `r_ankle` is at identical detector pixel distance (`141 px` below `r_hip`: thigh `76 px`, shin `65 px`), while on flight frames (`4–9, 14–19`) the right leg kicks out to `80 + 70 = 150 px`, giving right thigh/shin a 95th-percentile straight length of `80 px` / `70 px`.
   * - The left leg (`l`) reaches only `76 + 65 = 141 px` at its peak and lands at the exact same `141 px` pixel distance on `10–13` (`76 px` thigh, `65 px` shin).
   * With shared straight length (#148), both legs divide by `80 px` (thigh) and `70 px` (shin), so both landings place the hip at the exact same height (`141.00 u` above the floor). With per-side denominators, `l` gets `scale = 1.0` (`150.00 u`) while `r` gets `scale = 141 / 150 = 0.94` (`141.00 u`), creating a `9.00 u` (`6.0%`) alternating landing height step.
   */
  function asymmetricPeakSymmetricLandingPose(): Record<string, unknown> {
    const motion: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: () => 90,
      rt: () => THIGH,
      rs: () => SHIN,
      lt: () => THIGH,
      ls: () => SHIN,
      hip: (i) => {
        const flight = (i >= 4 && i <= 9) || (i >= 14 && i <= 19);
        return [0, flight ? -30 : 0];
      },
    };
    return poseDoc(motion, (i, j) => {
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      const rSupport = i <= 3 || i >= 20;
      const lSupport = i >= 10 && i <= 13;
      const flight = !rSupport && !lSupport;
      // Right leg: 76 + 65 = 141 px on support (0..3, 20..23) and during left support (lifted to 110 px); 80 + 70 = 150 px in flight (8 frames = 33% of 24 -> 95th percentile is 80 / 70).
      if (rSupport) {
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 76], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 141], score: 0.9 };
      } else if (flight) {
        j.r_knee = { state: 'observed', at: [rHip[0] + 64, rHip[1] + 48], score: 0.9 }; // hypot(64, 48) = 80
        j.r_ankle = { state: 'observed', at: [rHip[0] + 64 + 56, rHip[1] + 48 + 42], score: 0.9 }; // hypot(56, 42) = 70
      } else {
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 55], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 110], score: 0.9 };
      }

      // Left leg: never exceeds 76 + 65 = 141 px; on left support (10..13), identical vertical 76 + 65 = 141 px as right support!
      if (lSupport) {
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 76], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 141], score: 0.9 };
      } else if (flight) {
        j.l_knee = { state: 'observed', at: [lHip[0] + 60.8, lHip[1] + 45.6], score: 0.9 }; // hypot = 76
        j.l_ankle = { state: 'observed', at: [lHip[0] + 60.8 + 52, lHip[1] + 45.6 + 39], score: 0.9 }; // hypot = 65
      } else {
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 55], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 110], score: 0.9 };
      }
    });
  }

  test('shares the larger 95th-percentile straight length across both legs so consecutive landings on opposite feet place the hip at the same height', () => {
    const c = setup({ pose: asymmetricPeakSymmetricLandingPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.5,1.5', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('larger 95th percentile of 24 frames, both legs');

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      legScale: Array<{ bone: string; straight: number }>;
    };
    const byBone = new Map(rep.legScale.map((s) => [s.bone, s.straight]));
    expect(byBone.get('leg_r0')).toBeCloseTo(80, 3);
    expect(byBone.get('leg_l0')).toBeCloseTo(80, 3);
    expect(byBone.get('leg_r1')).toBeCloseTo(70, 3);
    expect(byBone.get('leg_l1')).toBeCloseTo(70, 3);

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const hipY0 = byName(poses[0]!.bones).get('hip')!.worldY;
    const hipY10 = byName(poses[10]!.bones).get('hip')!.worldY;
    expect(Math.abs(hipY0 - hipY10) / BONE_LEN).toBeLessThan(0.01);
  }, SLOW);

  test('mutant (per-side): taking each leg\'s 95th percentile separately gives opposite landings different hip heights', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm148-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const ls = legScaleOf(seg.lengths, limits, straightByKind.get(seg.kind)! * rigShareOf(seg));';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const ls = legScaleOf(seg.lengths, limits, seg.ownStraight);'));

      const cMut = setup({ pose: asymmetricPeakSymmetricLandingPose() });
      const rMut = retarget(cMut, ['--leg-scale', '0.5,1.5', '--plant-feet'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);

      const poses = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const hipY0 = byName(poses[0]!.bones).get('hip')!.worldY;
      const hipY10 = byName(poses[10]!.bones).get('hip')!.worldY;
      const diff = Math.abs(hipY10 - hipY0);
      console.log(`  mutant "per-side": landing hipY0=${hipY0.toFixed(2)}u vs hipY10=${hipY10.toFixed(2)}u, diff=${diff.toFixed(2)}u (${((diff / BONE_LEN) * 100).toFixed(2)}% > 1%)`);
      expect(diff / BONE_LEN).toBeGreaterThan(0.05);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('leg-scale (#153): respect noScale and noScaleOrReflection inheritance when solving a leg segment under a scaled parent', () => {
  /** A 16-frame pose where the right thigh shortens to ~0.75 of straight on frame 15 while the right shin turns 45° across it. */
  function foreshortenedPose(): Record<string, unknown> {
    return poseDoc(BASE, (i, j) => {
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150], score: 0.9 };
      if (i < 15) {
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150], score: 0.9 };
      } else {
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 60], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0] - 45, rHip[1] + 105], score: 0.9 };
      }
    });
  }

  test('lands scale, angle and ankle under direct noScale / noScaleOrReflection and under an unmapped noScale control bone (dense and --reduce)', () => {
    for (const mode of ['noScale', 'noScaleOrReflection', 'ctl-noScale'] as const) {
      const c = setup({
        pose: foreshortenedPose(),
        rig: {
          bones: (bs) => {
            if (mode !== 'ctl-noScale') {
              return bs.map((b) => (b.name === 'leg_r1' || b.name === 'leg_l1' ? { ...b, inherit: mode } : b));
            }
            const out: BoneSpec[] = [];
            for (const b of bs) {
              if (b.name === 'leg_r1' || b.name === 'leg_l1') {
                const ctl = `${b.name}_ctl`;
                out.push({ name: ctl, parent: b.parent, x: b.x, y: b.y, rotation: b.rotation, length: 0, inherit: 'noScale' });
                out.push({ ...b, parent: ctl, x: 0, y: 0, rotation: 0, inherit: 'normal' });
              } else {
                out.push(b);
              }
            }
            return out;
          },
        },
      });
      for (const extra of [[], ['--reduce', '0.5']]) {
        const report = join(c.dir, `report_${mode}_${extra.length}.json`);
        const r = retarget(c, ['--leg-scale', '0.55,1.05', '--plant-feet', '--report', report, ...extra]);
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
        const rep = JSON.parse(readFileSync(report, 'utf8')) as {
          landings: Array<{ bone: string; kind: string; worst: number; tolerance: number }>;
          shear: Array<{ bone: string; shear: number }>;
        };
        for (const l of rep.landings) expect(l.worst).toBeLessThanOrEqual(l.tolerance);
        const shinShear = rep.shear.find((s) => s.bone === 'leg_r1')!;
        expect(shinShear.shear).toBeLessThan(1e-3);
      }
    }
  }, SLOW);

  test('mutant (ignore-noscale): treating a noScale shin as normal divides by the stripped parent scale and fails POSE_LANDS', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm153-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = "const noScale = rb.inherit === 'noScale' || rb.inherit === 'noScaleOrReflection' ? rb.inherit : null;";
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const noScale = null;'));

      const cMut = setup({
        pose: foreshortenedPose(),
        rig: {
          bones: (bs) => bs.map((b) => (b.name === 'leg_r1' || b.name === 'leg_l1' ? { ...b, inherit: 'noScale' } : b)),
        },
      });
      const rMut = retarget(cMut, ['--leg-scale', '0.55,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(1);
      expect(rMut.stderr).toContain('POSE_LANDS: bone "leg_r1" scale');
      expect(rMut.stderr).toContain('POSE_LANDS: bone "leg_r1:tip" ankle');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('face direction (rig-c/pose#138)', () => {
  function facePose(rawYawDeg: (i: number) => number, rawPitchDeg: (i: number) => number = () => 0): Record<string, unknown> {
    return poseDoc(BASE, (i, joints) => {
      const neck = (joints.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      const dEye = 12;
      const dEar = 24;
      joints.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      joints.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      joints.r_ear = { state: 'observed', at: [midEye[0] - dEar / 2, midEye[1] + 5], score: 0.95 };
      joints.l_ear = { state: 'observed', at: [midEye[0] + dEar / 2, midEye[1] + 5], score: 0.95 };
      // For horizontal eyes (de = 12, da = 24), xne = (midEye.x - Nx) / 12 and xna = (midEye.x - Nx) / 24 = xne / 2,
      // so (2*xne + xna)/2 = 1.25 * (midEye.x - Nx) / 12 = tan(yaw).
      const ty = Math.tan(rawYawDeg(i) * RAD);
      const tp = Math.tan(rawPitchDeg(i) * RAD);
      const nx = midEye[0] - (ty * dEye) / 1.25;
      const ny = midEye[1] + 5 + tp * dEye;
      joints.nose = { state: 'observed', at: [nx, ny], score: 0.95 };
    });
  }

  test('refuses malformed face map entries and duplicate or missing face bones by name', () => {
    const badMaps: Array<{ face: unknown; code: string }> = [
      { face: 'yaw', code: 'MAP_FACE_SHAPE' },
      { face: {}, code: 'MAP_FACE_SHAPE' },
      { face: { yaw: 12 }, code: 'MAP_FACE_SHAPE' },
      { face: { yaw: { bone: '', range: [-15, 15] } }, code: 'MAP_FACE_BONE' },
      { face: { yaw: { bone: 'yaw', range: [5, 15] } }, code: 'MAP_FACE_RANGE' },
      { face: { yaw: { bone: 'yaw', range: [-15, -5] } }, code: 'MAP_FACE_RANGE' },
      { face: { yaw: { bone: 'yaw', range: [15, -15] } }, code: 'MAP_FACE_RANGE' },
      { face: { yaw: { bone: 'no_such_bone', range: [-15, 15] } }, code: 'MAP_BONE_EXISTS' },
      { face: { yaw: { bone: 'chest', range: [-15, 15] } }, code: 'MAP_BONE_ONCE' },
      { face: { yaw: { bone: 'yaw', range: [-15, 15] }, pitch: { bone: 'yaw', range: [-10, 15] } }, code: 'MAP_BONE_ONCE' },
    ];
    for (const { face, code } of badMaps) {
      const c = setup({
        rig: { bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }, { name: 'pitch', parent: 'root' }] },
        map: { ...baseMap(), face },
      });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(code);
    }
  }, SLOW);

  test('monotonic nose turn 0 → max yaw drives the yaw axis monotonically within range (r >= 0.9), and leaves every non-face track byte-identical', () => {
    // Raw yaw sweeps strictly monotonically from 0° to +30° across the 16 frames (compressed into [-15, 15] -> 0° to +15°),
    // and pitch sweeps from -15° to +15° (compressed into [-10, 15] -> -10° to +15°).
    const pose = facePose(
      (i) => (30 * i) / (BASE.n - 1),
      (i) => -15 + (30 * i) / (BASE.n - 1),
    );
    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }, { name: 'pitch', parent: 'root' }],
    };
    const withoutFace = setup({ rig: rigOpts, map: baseMap(), pose });
    const withFace = setup({
      rig: rigOpts,
      map: {
        ...baseMap(),
        face: {
          yaw: { bone: 'yaw', range: [-15, 15] },
          pitch: { bone: 'pitch', range: [-10, 15] },
        },
      },
      pose,
    });

    const r0 = retarget(withoutFace, ['--bends', 'clamp']);
    expect(r0.status).toBe(0);
    expect(linesOf(r0, 'FACE')).toEqual([]);

    const report = join(withFace.dir, 'report.json');
    const r1 = retarget(withFace, ['--bends', 'clamp', '--report', report]);
    expect(r1.stderr).toBe('');
    expect(r1.status).toBe(0);

    const faceLines = linesOf(r1, 'FACE');
    expect(faceLines).toHaveLength(1);
    expect(faceLines[0]).toContain('mapped yaw → bone "yaw" [-15, 15]°');
    expect(faceLines[0]).toContain('pitch → bone "pitch" [-10, 15]°');

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      face: {
        ears: boolean;
        yaw: { bone: string; limits: [number, number]; mapped: { min: number; max: number }; corr: number };
        pitch: { bone: string; limits: [number, number]; mapped: { min: number; max: number }; corr: number };
      };
    };
    expect(rep.face.ears).toBe(true);
    expect(rep.face.yaw.corr).toBeGreaterThanOrEqual(0.9);
    expect(rep.face.pitch.corr).toBeGreaterThanOrEqual(0.9);
    expect(rep.face.yaw.mapped.min).toBeGreaterThanOrEqual(-15);
    expect(rep.face.yaw.mapped.max).toBeLessThanOrEqual(15);
    expect(rep.face.pitch.mapped.min).toBeGreaterThanOrEqual(-10);
    expect(rep.face.pitch.mapped.max).toBeLessThanOrEqual(15);

    // Every non-face track is 100% byte-identical to the run without "face".
    const m0 = JSON.parse(readFileSync(withoutFace.out, 'utf8')) as { animations: { dance: { tracks: Array<{ bone?: string; slot?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } } };
    const m1 = JSON.parse(readFileSync(withFace.out, 'utf8')) as { animations: { dance: { tracks: Array<{ bone?: string; slot?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } } };
    const nonFace1 = m1.animations.dance.tracks.filter((tr) => tr.bone !== 'yaw' && tr.bone !== 'pitch');
    expect(JSON.stringify(nonFace1)).toBe(JSON.stringify(m0.animations.dance.tracks));

    // Yaw track keys increase strictly monotonically from 0° to +15°, and posed build matches.
    const yawTrack = m1.animations.dance.tracks.find((tr) => tr.bone === 'yaw' && tr.property === 'rotate')!;
    expect(yawTrack).toBeDefined();
    const yawKeys = yawTrack.keys.map((k) => k.v[0]!);
    expect(yawKeys[0]).toBeCloseTo(0, 2);
    expect(yawKeys[yawKeys.length - 1]).toBeCloseTo(15, 2);
    for (let i = 1; i < yawKeys.length; i++) {
      expect(yawKeys[i]!).toBeGreaterThan(yawKeys[i - 1]!);
    }
    const doc = loadBuild(withFace.build);
    const steps = Array.from({ length: BASE.n - 1 }, () => BASE.dt);
    const posed = poseRawAnimation(doc, 'dance', steps, {}, 'animation').map((p) => byName(p.bones));
    const posedYaw = posed.map((b) => worldAngle(b, 'yaw'));
    for (let i = 1; i < posedYaw.length; i++) {
      expect(posedYaw[i]!).toBeGreaterThan(posedYaw[i - 1]!);
    }
  }, SLOW);

  test('mutant (face-axis-unkeyed): leaving the face axis unkeyed fails POSE_LANDS and fails monotonic posed yaw', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm138-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = "tracks.push({ bone: ax.bone, property: 'rotate', keys: ax.keys.map((v, i) => ({ t: keyTimes[i]!, v: [v] })) });";
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, '// mutant: face axis unkeyed'));

      const pose = facePose((i) => (15 * i) / (BASE.n - 1));
      const cMut = setup({
        rig: { bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }] },
        map: { ...baseMap(), face: { yaw: { bone: 'yaw', range: [-15, 15] } } },
        pose,
      });
      const rMut = retarget(cMut, ['--bends', 'clamp'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(1);
      expect(rMut.stderr).toContain('POSE_LANDS: bone "yaw" aim');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('figure growth over the dance (#159): rolling leg-scale straight length and bounded head-nod translate keep neck and legs within ±3% across camera zoom drift', () => {
  const N = 60;
  const DT = 1 / 24;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function zoomDriftPose(): Record<string, unknown> {
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    return poseDoc(m, (i, j) => {
      // Camera zoom normalisation inflates the figure from 1.00x on frames 0..24 to 1.35x on frames 35..59,
      // while the shoulders drop relative to the eyes on the ending phrase.
      const z = i < 25 ? 1 : i < 35 ? 1 + (0.35 * (i - 25)) / 10 : 1.35;
      const cx = 100;
      const cy = 200;
      for (const k of Object.keys(j)) {
        const pt = j[k]!.at as Pt;
        j[k] = { ...j[k]!, at: [cx + (pt[0] - cx) * z, cy + (pt[1] - cy) * z] };
      }
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80 * z], score: 0.9 };
      j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150 * z], score: 0.9 };
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80 * z], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150 * z], score: 0.9 };
      if (i >= 40) {
        j.r_eye = { state: 'observed', at: [(j.r_eye!.at as Pt)[0], (j.r_eye!.at as Pt)[1] - 6], score: 0.9 };
        j.l_eye = { state: 'observed', at: [(j.l_eye!.at as Pt)[0], (j.l_eye!.at as Pt)[1] - 6], score: 0.9 };
      }
    });
  }

  test('keeps posed neck, thigh, shin, and whole-leg lengths at the ending within ±3% of frame 0 (and neck within ±2% on every frame)', () => {
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: zoomDriftPose() });
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const measureFrame = (idx: number) => {
      const b = byName(poses[idx]!.bones);
      const neck = Math.hypot(b.get('head')!.worldX - b.get('neck')!.worldX, b.get('head')!.worldY - b.get('neck')!.worldY);
      const rThigh = Math.hypot(b.get('leg_r1')!.worldX - b.get('leg_r0')!.worldX, b.get('leg_r1')!.worldY - b.get('leg_r0')!.worldY);
      const lThigh = Math.hypot(b.get('leg_l1')!.worldX - b.get('leg_l0')!.worldX, b.get('leg_l1')!.worldY - b.get('leg_l0')!.worldY);
      const r1 = b.get('leg_r1')!;
      const l1 = b.get('leg_l1')!;
      const rShin = Math.hypot(r1.a * 70, r1.c * 70);
      const lShin = Math.hypot(l1.a * 70, l1.c * 70);
      return { neck, rThigh, rShin, lThigh, lShin, rLeg: rThigh + rShin, lLeg: lThigh + lShin };
    };
    const f0 = measureFrame(0);
    const fEnd = measureFrame(55);
    for (const k of ['neck', 'rThigh', 'rShin', 'lThigh', 'lShin', 'rLeg', 'lLeg'] as const) {
      const ratio = fEnd[k] / f0[k];
      expect(ratio).toBeGreaterThanOrEqual(0.97);
      expect(ratio).toBeLessThanOrEqual(1.03);
    }
    for (let i = 0; i < N; i++) {
      const ratio = measureFrame(i).neck / f0.neck;
      expect(ratio).toBeGreaterThanOrEqual(0.98 - 1e-4);
      expect(ratio).toBeLessThanOrEqual(1.02 + 1e-4);
    }
  }, SLOW);

  test('mutant (#159): without rolling leg-scale normalisation and head-nod stretch bound, neck and legs grow > 20% at the ending', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm159-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const before = readFileSync(path, 'utf8');
      const fromLeg = 'if (!inPlace && n > 25) {';
      const fromNod = 'const maxNod = !inPlace && neckRestLen > 1e-6 ? 0.02 * neckRestLen : Infinity;';
      expect(before.split(fromLeg)).toHaveLength(2);
      expect(before.split(fromNod)).toHaveLength(2);
      writeFileSync(
        path,
        before
          .replace(fromLeg, 'if (false) {')
          .replace(fromNod, 'const maxNod = Infinity;'),
      );

      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: zoomDriftPose() });
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const poses = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const b0 = byName(poses[0]!.bones);
      const b55 = byName(poses[55]!.bones);
      const neck0 = Math.hypot(b0.get('head')!.worldX - b0.get('neck')!.worldX, b0.get('head')!.worldY - b0.get('neck')!.worldY);
      const neck55 = Math.hypot(b55.get('head')!.worldX - b55.get('neck')!.worldX, b55.get('head')!.worldY - b55.get('neck')!.worldY);
      const lThigh0 = Math.hypot(b0.get('leg_l1')!.worldX - b0.get('leg_l0')!.worldX, b0.get('leg_l1')!.worldY - b0.get('leg_l0')!.worldY);
      const lThigh55 = Math.hypot(b55.get('leg_l1')!.worldX - b55.get('leg_l0')!.worldX, b55.get('leg_l1')!.worldY - b55.get('leg_l0')!.worldY);
      expect(neck55 / neck0).toBeGreaterThan(1.2);
      expect(lThigh55 / lThigh0).toBeGreaterThan(1.2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('face knee (#164): 1:1 mapping inside FACE_KNEE * limit so a single outlier does not crush the rest of the clip', () => {
  function facePose(rawYawDeg: (i: number) => number, rawPitchDeg: (i: number) => number = () => 0): Record<string, unknown> {
    return poseDoc(BASE, (i, joints) => {
      const neck = (joints.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      const dEye = 12;
      const dEar = 24;
      joints.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      joints.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      joints.r_ear = { state: 'observed', at: [midEye[0] - dEar / 2, midEye[1] + 5], score: 0.95 };
      joints.l_ear = { state: 'observed', at: [midEye[0] + dEar / 2, midEye[1] + 5], score: 0.95 };
      const ty = Math.tan(rawYawDeg(i) * RAD);
      const tp = Math.tan(rawPitchDeg(i) * RAD);
      const nx = midEye[0] - (ty * dEye) / 1.25;
      const ny = midEye[1] + 5 + tp * dEye;
      joints.nose = { state: 'observed', at: [nx, ny], score: 0.95 };
    });
  }

  test('a 12° opening yaw with a single 43° outlier maps 1:1 at f0 (within 0.5° of raw), hits 15° at the peak, and stays monotone', () => {
    // Raw yaw is 12° at f0, rises through 12°..15°, spikes to 43° at frame 8, and settles back inside 12°.
    const rawTargets = [12, 11, 10, 9, 11, 13, 18, 28, 43, 25, 14, 12, 10, 8, 6, 4];
    const pose = facePose((i: number) => rawTargets[i]!);
    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }],
    };
    const c = setup({
      rig: rigOpts,
      map: { ...baseMap(), face: { yaw: { bone: 'yaw', range: [-15, 15] } } },
      pose,
    });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FACE')[0]).toContain('(knee [-12, 12]°)');

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      face: {
        read: { yaw: { min: number; max: number } };
        yaw: { knee: [number, number]; mapped: { min: number; max: number }; corr: number };
      };
    };
    expect(rep.face.yaw.knee).toEqual([-12, 12]);
    expect(rep.face.yaw.mapped.max).toBeCloseTo(15, 2);
    expect(rep.face.yaw.corr).toBeGreaterThanOrEqual(0.99);

    const m = JSON.parse(readFileSync(c.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
    };
    const yawKeys = m.animations.dance.tracks.find((tr) => tr.bone === 'yaw' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
    // f0 raw yaw is ~12°, so mapped f0 yaw must stay within 0.5° of raw (1:1 inside the 12° knee).
    expect( yawKeys[0]! ).toBeGreaterThan(11.5);
    expect( Math.abs(yawKeys[0]! - 12) ).toBeLessThanOrEqual(0.5);
    expect( yawKeys[8]! ).toBeCloseTo(15, 2);
  }, SLOW);

  test('mutant (#164): whole-sequence peak compression (FACE_KNEE = 0) crushes the 12° opening yaw down to ~4°', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm164-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'face.ts');
      const from = 'export const FACE_KNEE = 0.8;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const FACE_KNEE = 0;'));

      const rawTargets = [12, 11, 10, 9, 11, 13, 18, 28, 43, 25, 14, 12, 10, 8, 6, 4];
      const pose = facePose((i: number) => rawTargets[i]!);
      const cMut = setup({
        rig: { bones: (bs) => [...bs, { name: 'yaw', parent: 'root' }] },
        map: { ...baseMap(), face: { yaw: { bone: 'yaw', range: [-15, 15] } } },
        pose,
      });
      const rMut = retarget(cMut, ['--bends', 'clamp'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const m = JSON.parse(readFileSync(cMut.out, 'utf8')) as {
        animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
      };
      const yaw0 = m.animations.dance.tracks.find((tr) => tr.bone === 'yaw' && tr.property === 'rotate')!.keys[0]!.v[0]!;
      expect(Math.abs(yaw0 - 12)).toBeGreaterThan(7);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('continuous figure scale (#163) and --camera sidecar track (#161)', () => {
  const N = 80;
  const DT = 1 / 24;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function cameraEventPose(): Record<string, unknown> {
    // Slow rise 0..20 (1.00 -> 1.18), fast drop 20..35 (1.18 -> 1.03), slow rise 35..60 (1.03 -> 1.28), frozen hold 60..79 (1.28).
    const scaleAt = (i: number): number => {
      if (i <= 20) return 1 + (0.18 * i) / 20;
      if (i <= 35) return 1.18 - (0.15 * (i - 20)) / 15;
      if (i <= 60) return 1.03 + (0.25 * (i - 35)) / 25;
      return 1.28;
    };
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    const doc = poseDoc(m, (i, j) => {
      const z = scaleAt(i);
      const cx = 100;
      const cy = 200;
      for (const k of Object.keys(j)) {
        const pt = j[k]!.at as Pt;
        j[k] = { ...j[k]!, at: [cx + (pt[0] - cx) * z, cy + (pt[1] - cy) * z] };
      }
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80 * z], score: 0.9 };
      j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150 * z], score: 0.9 };
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80 * z], score: 0.9 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150 * z], score: 0.9 };
    });
    return {
      ...doc,
      cameraSource: 'hand',
      camera: Array.from({ length: N }, (_, i) => ({
        s: i < 20 ? 1 : i < 35 ? 0.92 : 0.78,
        tx: i * 0.5,
        ty: -i * 0.25,
        inliers: 100,
      })),
    };
  }

  test('continuous figure scale holds frozen spans within <= 0.5%, caps frame-to-frame steps at <= 1%, and --camera writes rig-pose-camera/1 while leaving motion.json 100% byte-identical', () => {
    const pose = cameraEventPose();
    const withoutCam = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const withCam = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const camFile = join(withCam.dir, 'camera.json');

    const flags = ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'];
    const r0 = retarget(withoutCam, flags);
    const r1 = retarget(withCam, [...flags, '--camera', camFile]);
    expect(r0.status).toBe(0);
    expect(r1.status).toBe(0);

    // #161 Bar 1: motion.json is 100% byte-identical with and without --camera.
    const bytes0 = readFileSync(withoutCam.out, 'utf8');
    const bytes1 = readFileSync(withCam.out, 'utf8');
    expect(bytes1).toBe(bytes0);

    // #161 Bar 2 & #163 Bars 1-3: inspect camera.json and posed standing height.
    const cam = JSON.parse(readFileSync(camFile, 'utf8')) as {
      spec: string;
      frames: Array<{ frame: number; t: number; s: number; rawS: number; tx: number; ty: number; videoS: number }>;
      summary: { minS: number; maxS: number; maxStep: { step: number; frame: number; t: number }; endOverStart: number };
    };
    expect(cam.spec).toBe('rig-pose-camera/1');
    expect(cam.frames).toHaveLength(N);
    expect(cam.summary.maxStep.step).toBeLessThanOrEqual(0.01 + 1e-6);
    expect(cam.summary.endOverStart).toBeCloseTo(1.28, 2);

    // On the frozen ending span 60..79, figure scale s is held constant (variation <= 0.5%) and posed standing height varies <= 0.5%.
    const frozenS = cam.frames.slice(60, 80).map((f) => f.s);
    expect((Math.max(...frozenS) - Math.min(...frozenS)) / frozenS[0]!).toBeLessThanOrEqual(0.005);

    const poses = poseRawAnimation(loadBuild(withCam.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const standingHeight = (idx: number): number => {
      const b = byName(poses[idx]!.bones);
      const headY = b.get('head')!.worldY;
      const r1 = b.get('leg_r1')!;
      const l1 = b.get('leg_l1')!;
      const rAnkY = r1.worldY + r1.c * 70;
      const lAnkY = l1.worldY + l1.c * 70;
      return headY - Math.min(rAnkY, lAnkY);
    };
    const frozenH = Array.from({ length: 20 }, (_, k) => standingHeight(60 + k));
    expect((Math.max(...frozenH) - Math.min(...frozenH)) / frozenH[0]!).toBeLessThanOrEqual(0.005);
    expect(Math.abs(standingHeight(N - 1) / standingHeight(0) - 1)).toBeLessThanOrEqual(0.02);

    // ARG_PATH refusal when --camera points under a file (a missing directory is made since #239).
    writeFileSync(join(withCam.dir, 'not-a-dir'), '');
    const bad = retarget(withCam, [...flags, '--camera', join(withCam.dir, 'not-a-dir', 'camera.json')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('ARG_PATH: --camera');
  }, SLOW);

  test('mutant (#163): without rate-limited projection (unsmoothed raw scale), a 15% single-frame spike violates the <= 1%/frame step bound', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm163-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'export const FIGURE_SCALE_STEP = 0.01;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const FIGURE_SCALE_STEP = 0.5;'));

      // Pose with a sharp 8% step between frames 20 and 21.
      const m: Motion = { ...BASE, n: 40, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
      const pose = poseDoc(m, (i, j) => {
        const z = i < 20 ? 1 : 1.08 + 0.004 * (i - 20);
        const cx = 100;
        const cy = 200;
        for (const k of Object.keys(j)) {
          const pt = j[k]!.at as Pt;
          j[k] = { ...j[k]!, at: [cx + (pt[0] - cx) * z, cy + (pt[1] - cy) * z] };
        }
      });
      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      const camFile = join(cMut.dir, 'camera.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--camera', camFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const cam = JSON.parse(readFileSync(camFile, 'utf8')) as { summary: { maxStep: { step: number } } };
      expect(cam.summary.maxStep.step).toBeGreaterThan(0.05);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('trunk smoothing under --reduce (#116): knot and handle smoothing keeps trunk local jitter <= 1.0 deg/f^2 under --leg-scale while leaving limbs within 0.05 and non-leg-scale runs byte-identical', () => {
  const N = 30;
  const DT = 1 / 30;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function noisyTrunkPose(): Record<string, unknown> {
    // Trunk and head carry high-frequency +/-0.75 deg jitter on top of a slow 2.5 deg sway.
    const trunkJitter = (i: number): number => 90 + 2.5 * Math.sin((2 * Math.PI * i) / 15) + (i % 2 === 0 ? 0.75 : -0.75);
    const headWave = (i: number): number => 2.5 * Math.sin((2 * Math.PI * i) / 15) + (i % 3 === 0 ? 0.75 : i % 3 === 1 ? -0.75 : 0.25);
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: trunkJitter };
    return poseDoc(m, (i, j) => {
      const neck = j.neck!.at as Pt;
      const hw = headWave(i) * RAD;
      const cx = neck[0];
      const cy = neck[1] - 20;
      const dx = 6 * Math.cos(hw);
      const dy = -6 * Math.sin(hw);
      j.r_eye = { state: 'observed', at: [cx - dx, cy - dy], score: 0.95 };
      j.l_eye = { state: 'observed', at: [cx + dx, cy + dy], score: 0.95 };
    });
  }

  function localRotateJitter(buildDir: string, boneName: string): number {
    const doc = loadBuild(buildDir);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation').map((p) => byName(p.bones));
    const setupParent = new Map<string, string | null>();
    for (const b of doc.bones) setupParent.set(b.name, b.parent ?? null);
    const parent = setupParent.get(boneName) ?? null;
    const angles = poses.map((b) => {
      const w = worldAngle(b, boneName);
      if (!parent) return w;
      let d = w - worldAngle(b, parent);
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    });
    let sum = 0;
    for (let i = 1; i < angles.length - 1; i++) {
      sum += Math.abs(angles[i + 1]! - 2 * angles[i]! + angles[i - 1]!);
    }
    return sum / (angles.length - 2);
  }

  test('smooths chest and head local jitter to <= 1.0 deg/f^2 under --leg-scale, holds limbs within 0.05, and leaves runs without --leg-scale byte-identical to mutant', () => {
    const pose = noisyTrunkPose();
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const repFile = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--reduce', '1', '--reduce-hip', '1', '--report', repFile]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const chestJit = localRotateJitter(c.build, 'chest');
    const headJit = localRotateJitter(c.build, 'head');
    const trunkMean = (chestJit + headJit) / 2;
    expect(trunkMean).toBeLessThanOrEqual(1.0);

    // Mutant without smoothTrunk leaves trunk mean jitter > 1.2 deg/f^2, while limbs stay within 0.05 and non-leg-scale runs are byte-identical.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm116-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'run.ts');
      const from = 'smoothTrunk(r.times, bones, tolerance, out, trunkBones);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, '// mutant: no smoothTrunk'));

      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      const mRepFile = join(cMut.dir, 'report.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--reduce', '1', '--reduce-hip', '1', '--report', mRepFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutChestJit = localRotateJitter(cMut.build, 'chest');
      const mutHeadJit = localRotateJitter(cMut.build, 'head');
      const mutTrunkMean = (mutChestJit + mutHeadJit) / 2;
      expect(mutTrunkMean).toBeGreaterThan(1.2);
      expect(trunkMean).toBeLessThan(mutTrunkMean - 0.3);

      // Every limb bone's jitter and landing are unchanged within 0.05.
      const repOurs = JSON.parse(readFileSync(repFile, 'utf8')) as { landings: Array<{ bone: string; kind: string; worst: number }> };
      const repMut = JSON.parse(readFileSync(mRepFile, 'utf8')) as { landings: Array<{ bone: string; kind: string; worst: number }> };
      for (const limb of ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
        expect(Math.abs(localRotateJitter(c.build, limb) - localRotateJitter(cMut.build, limb))).toBeLessThanOrEqual(0.05);
        const lOurs = repOurs.landings.find((b) => b.bone === limb && b.kind === 'angle')!.worst;
        const lMut = repMut.landings.find((b) => b.bone === limb && b.kind === 'angle')!.worst;
        expect(Math.abs(lOurs - lMut)).toBeLessThanOrEqual(0.05);
      }

      // Without --leg-scale (as on the dance under --reduce 1 alone), output is 100% byte-identical.
      const cNoLeg = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      const cNoLegMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      expect(retarget(cNoLeg, ['--bends', 'clamp', '--reduce', '1']).status).toBe(0);
      expect(retarget(cNoLegMut, ['--bends', 'clamp', '--reduce', '1'], join(d, 'cli.ts')).status).toBe(0);
      expect(readFileSync(cNoLeg.out, 'utf8')).toBe(readFileSync(cNoLegMut.out, 'utf8'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('tools/pelvis.ts: --camera sidecar and residual zoom warning (#170)', () => {
  const N = 36;
  const DT = 1 / 24;
  const PELVIS_TOOL = join(ROOT, 'tools', 'pelvis.ts');
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function runPelvis(args: string[]): { status: number; stdout: string; stderr: string } {
    const p = spawnSync(process.execPath, [PELVIS_TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { status: p.status ?? 1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
  }

  function zoomedPelvisPose(inPlace = false): Record<string, unknown> {
    // Window 0..17 has 16% camera zoom (1.00 -> 1.16); window 18..35 holds steady zoom (1.16 -> 1.18).
    // In both windows the dancer performs the same periodic crouch + lateral sway over a planted right foot.
    const zoomAt = (i: number): number => (i < 18 ? 1 + (0.16 * i) / 18 : 1.16 + (0.02 * (i - 18)) / 17);
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90 };
    const doc = poseDoc(m, (i, j) => {
      const z = inPlace ? 1 : zoomAt(i);
      const crouch = 1 - 0.08 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i % 9)) / 9));
      const swayDeg = 6 * Math.sin((2 * Math.PI * (i % 18)) / 18);
      const swayRad = swayDeg * RAD;
      // Right ankle planted at (200, 500) in canonical space; camera zooms around top-left (0, 0).
      const rAnk: Pt = [200, 500];
      const legLen = 150 * crouch;
      const dx = -legLen * Math.sin(swayRad);
      const dy = -legLen * Math.cos(swayRad);
      const rHip: Pt = [rAnk[0] + dx, rAnk[1] + dy];
      const rKnee: Pt = [rAnk[0] + dx * (70 / 150), rAnk[1] + dy * (70 / 150)];
      const lHip: Pt = [rHip[0] + 30, rHip[1]];
      const lKnee: Pt = [rKnee[0] + 30, rKnee[1]];
      const lAnk: Pt = [rAnk[0] + 30, rAnk[1]];
      const mh: Pt = [(rHip[0] + lHip[0]) / 2, (rHip[1] + lHip[1]) / 2];
      const origR = j.r_hip!.at as Pt;
      const origL = j.l_hip!.at as Pt;
      const origMh: Pt = [(origR[0] + origL[0]) / 2, (origR[1] + origL[1]) / 2];
      const shiftX = mh[0] - origMh[0];
      const shiftY = mh[1] - origMh[1];
      for (const k of Object.keys(j)) {
        const pt = j[k]!.at as Pt;
        j[k] = { ...j[k]!, at: [(pt[0] + shiftX) * z, (pt[1] + shiftY) * z] };
      }
      j.r_hip = { state: 'observed', at: [rHip[0] * z, rHip[1] * z], score: 0.95 };
      j.l_hip = { state: 'observed', at: [lHip[0] * z, lHip[1] * z], score: 0.95 };
      j.r_knee = { state: 'observed', at: [rKnee[0] * z, rKnee[1] * z], score: 0.95 };
      j.l_knee = { state: 'observed', at: [lKnee[0] * z, lKnee[1] * z], score: 0.95 };
      j.r_ankle = { state: 'observed', at: [rAnk[0] * z, rAnk[1] * z], score: 0.95 };
      j.l_ankle = { state: 'observed', at: [lAnk[0] * z, lAnk[1] * z], score: 0.95 };
    });
    return inPlace ? { ...doc, travel: 'in-place' } : doc;
  }

  test('with --camera, zoomed windows pass and agree within 0.01; without --camera, warns and keeps raw ratios; refuses malformed camera and fails on mutant camera', () => {
    const pose = zoomedPelvisPose(false);
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const repFile = join(c.dir, 'report.json');
    const camFile = join(c.dir, 'camera.json');
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--report', repFile, '--camera', camFile]);
    expect(r.status).toBe(0);

    const outCam = join(c.dir, 'bands_cam.json');
    const pCam = runPelvis(['--build', c.build, '--pose', c.pose, '--map', c.map, '--report', repFile, '--camera', camFile, '--windows', '0-17,18-35', '--out', outCam]);
    expect(pCam.status).toBe(0);
    expect(pCam.stdout).not.toContain('warning:');
    expect(pCam.stdout).not.toContain('FAIL');

    const bandsCam = JSON.parse(readFileSync(outCam, 'utf8')) as {
      bands: Array<{
        window: [number, number];
        vertical: { ratio: number };
        lateral: { ratio: number };
        rebound: { median: number };
      }>;
    };
    const [b0, b1] = bandsCam.bands as [typeof bandsCam.bands[0], typeof bandsCam.bands[0]];
    expect(b0.vertical.ratio).toBeGreaterThanOrEqual(0.85);
    expect(b0.vertical.ratio).toBeLessThanOrEqual(1.15);
    expect(b0.lateral.ratio).toBeGreaterThanOrEqual(0.85);
    expect(b0.lateral.ratio).toBeLessThanOrEqual(1.15);
    expect(Math.abs(b0.vertical.ratio - b1.vertical.ratio)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b0.lateral.ratio - b1.lateral.ratio)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b0.rebound.median - b1.rebound.median)).toBeLessThanOrEqual(0.01);

    // Without --camera on the zoomed sequence: warning line appears, raw ratios still print.
    const outRaw = join(c.dir, 'bands_raw.json');
    const pRaw = runPelvis(['--build', c.build, '--pose', c.pose, '--map', c.map, '--report', repFile, '--windows', '0-17,18-35', '--out', outRaw]);
    expect(pRaw.status).toBe(0);
    const rawLines = pRaw.stdout.trim().split('\n');
    expect(rawLines[0]).toMatch(/^warning: sequence has residual camera zoom s /);
    expect(rawLines.slice(1).join('\n')).toContain('window 0–17:');
    expect(pRaw.stdout).toContain('FAIL');
    const bandsRaw = JSON.parse(readFileSync(outRaw, 'utf8')) as typeof bandsCam;
    expect(bandsRaw.bands[0]!.vertical.ratio).toBeGreaterThan(1.15);

    // Negative control 1: mutant camera with flat s=1 fails the vertical band on 0-17.
    const mutCamFile = join(c.dir, 'camera_mut.json');
    const camObj = JSON.parse(readFileSync(camFile, 'utf8')) as { spec: string; frames: Array<{ frame: number; t: number; s: number }> };
    writeFileSync(mutCamFile, JSON.stringify({ ...camObj, frames: camObj.frames.map((f) => ({ ...f, s: 1 })) }));
    const pMut = runPelvis(['--build', c.build, '--pose', c.pose, '--map', c.map, '--report', repFile, '--camera', mutCamFile, '--windows', '0-17,18-35']);
    expect(pMut.status).toBe(0);
    expect(pMut.stdout).toContain('FAIL');

    // Negative control 2: invalid --camera spec is refused with exit 2.
    const badCamFile = join(c.dir, 'camera_bad.json');
    writeFileSync(badCamFile, JSON.stringify({ spec: 'wrong/1', frames: [] }));
    const pBad = runPelvis(['--build', c.build, '--pose', c.pose, '--map', c.map, '--report', repFile, '--camera', badCamFile, '--windows', '0-17']);
    expect(pBad.status).toBe(2);
    expect(pBad.stderr).toContain('expected "rig-pose-camera/1"');

    // In-place sequence without --camera: no warning line printed.
    const inPlaceFile = join(c.dir, 'pose_inplace.json');
    writeFileSync(inPlaceFile, JSON.stringify({ ...JSON.parse(readFileSync(c.pose, 'utf8')), travel: 'in-place' }));
    const pInPlace = runPelvis(['--build', c.build, '--pose', inPlaceFile, '--map', c.map, '--report', repFile, '--windows', '0-17']);
    expect(pInPlace.status).toBe(0);
    expect(pInPlace.stdout).not.toContain('warning:');
  }, SLOW);
});

describe('posture-invariant figure scale and trunk scaley foreshortening (#172)', () => {
  const N = 45;
  const DT = 1 / 24;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      ...baseChains(),
      { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
    ],
  });

  function trunkBendPose(): Record<string, unknown> {
    // Fixed camera (true s = 1.0):
    // - frames 0..14: upright standing (trunkLen = 100)
    // - frames 15..29: head thrown back (trunkLen = 106.5, +6.5%)
    // - frames 30..44: forward bend toward camera (trunkLen = 82, -18%)
    const trunkRatioAt = (i: number): number => {
      if (i < 15) return 1.0;
      if (i < 30) return 1.065;
      return 0.82;
    };
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    return poseDoc(m, (i, j) => {
      const ratio = trunkRatioAt(i);
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      const mh: Pt = [(rHip[0] + lHip[0]) / 2, (rHip[1] + lHip[1]) / 2];
      const origNeck = j.neck!.at as Pt;
      const trunkLen0 = mh[1] - origNeck[1];
      const newNeckY = mh[1] - trunkLen0 * ratio;
      const dy = newNeckY - origNeck[1];
      for (const k of ['neck', 'r_shoulder', 'l_shoulder', 'r_elbow', 'l_elbow', 'r_wrist', 'l_wrist', 'nose', 'r_eye', 'l_eye', 'r_ear', 'l_ear']) {
        if (j[k]) {
          const pt = j[k]!.at as Pt;
          j[k] = { ...j[k]!, at: [pt[0], pt[1] + dy] };
        }
      }
      j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80], score: 0.95 };
      j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150], score: 0.95 };
      j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80], score: 0.95 };
      j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150], score: 0.95 };
    });
  }

  test('holds s(t) within [0.98, 1.02] on a fixed-camera trunk bend and carries trunk foreshortening/extension on chest:scaley within 3%', () => {
    const pose = trunkBendPose();
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
    const camFile = join(c.dir, 'camera.json');
    const repFile = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--camera', camFile, '--report', repFile]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const cam = JSON.parse(readFileSync(camFile, 'utf8')) as {
      summary: { minS: number; maxS: number };
      frames: Array<{ frame: number; s: number }>;
    };
    expect(cam.summary.minS).toBeGreaterThanOrEqual(0.98);
    expect(cam.summary.maxS).toBeLessThanOrEqual(1.02);

    const motion = JSON.parse(readFileSync(c.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
    };
    const chestScaleY = motion.animations.dance.tracks.find((tr) => tr.bone === 'chest' && tr.property === 'scaley');
    expect(chestScaleY).toBeDefined();

    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const rigTrunkLen = (idx: number): number => {
      const b = byName(poses[idx]!.bones);
      const ch = b.get('chest')!;
      const nk = b.get('neck')!;
      return Math.hypot(nk.worldX - ch.worldX, nk.worldY - ch.worldY);
    };
    const standLen = rigTrunkLen(0);
    // Frame 22 (head back, sequence ratio 1.065, clamped at 1.05): within 3% of 1.065.
    expect(Math.abs(rigTrunkLen(22) / standLen - 1.065) / 1.065).toBeLessThanOrEqual(0.03);
    // Frame 37 (forward bend, sequence ratio 0.82): within 3% of 0.82.
    expect(Math.abs(rigTrunkLen(37) / standLen - 0.82) / 0.82).toBeLessThanOrEqual(0.03);

    // Mutant: if rawFigureHeight reads nose-to-ankle instead of posture-invariant measures, forward bend drops s(t) below 0.95.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm172-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'if (ar !== null && al !== null && hr !== null && hl !== null) {';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(
        path,
        before.replace(
          from,
          "if (ar !== null && al !== null) { const ns = heldPt('nose')!; return ar.map((r, i) => Math.max(r[1], al[i]![1]) - ns[i]![1]); } if (false) {",
        ),
      );
      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose });
      const mutCamFile = join(cMut.dir, 'camera_mut.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--camera', mutCamFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutCam = JSON.parse(readFileSync(mutCamFile, 'utf8')) as { summary: { minS: number } };
      expect(mutCam.summary.minS).toBeLessThan(0.95);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#173: body yaw reading from camera-normalised shoulder and hip width', () => {
  const N = 60;
  const DT = 1 / 30;

  function bodyTurnPose(): Record<string, unknown> {
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    return poseDoc(m, (i, j) => {
      // Frames 0..47: frontal standing (cos(yaw) = 1.0 -> yaw = 0°)
      // Frames 48..59: 75° turn to subject's right (cos(75°) ≈ 0.2588 -> yaw ≈ +75°)
      const deg = i < 48 ? 0 : 75;
      const c = Math.cos((deg * Math.PI) / 180);
      const rSh = j.r_shoulder!.at as Pt;
      const lSh = j.l_shoulder!.at as Pt;
      const mShX = (rSh[0] + lSh[0]) / 2;
      const halfSh = ((lSh[0] - rSh[0]) / 2) * c;
      j.r_shoulder = { ...j.r_shoulder!, at: [mShX - halfSh, rSh[1]] };
      j.l_shoulder = { ...j.l_shoulder!, at: [mShX + halfSh, lSh[1]] };

      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      const mHipX = (rHip[0] + lHip[0]) / 2;
      const halfHip = ((lHip[0] - rHip[0]) / 2) * c;
      j.r_hip = { ...j.r_hip!, at: [mHipX - halfHip, rHip[1]] };
      j.l_hip = { ...j.l_hip!, at: [mHipX + halfHip, lHip[1]] };

      if (deg > 0) {
        const nose = j.nose!.at as Pt;
        j.nose = { ...j.nose!, at: [nose[0] - 4, nose[1]] };
      }
    });
  }

  test('reports BODY yaw (<= 15° on opening, >= 60° on ending turn, frames >= 45° listed) without changing tracks when body is undeclared, and drives body.yaw when declared', () => {
    const pose = bodyTurnPose();
    const c = setup({ pose });
    const repFile = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--report', repFile]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const bodyLines = linesOf(r, 'BODY');
    expect(bodyLines).toHaveLength(1);
    expect(bodyLines[0]).toContain('opening (frames 0–47)');
    expect(bodyLines[0]).toContain('≥ 45° on 12 frame(s): frames 48–59');

    const rep = JSON.parse(readFileSync(repFile, 'utf8')) as {
      body: {
        standing: { shoulder: number; hip: number };
        read: { yaw: { min: number; max: number; range: number }; opening: { min: number; max: number } };
        over45: Array<[number, number]>;
        framesOver45: number[];
        yaw?: unknown;
      };
    };
    expect(Math.max(Math.abs(rep.body.read.opening.min), Math.abs(rep.body.read.opening.max))).toBeLessThanOrEqual(15);
    expect(rep.body.read.yaw.max).toBeGreaterThanOrEqual(60);
    expect(rep.body.over45).toEqual([[48, 59]]);
    expect(rep.body.framesOver45).toHaveLength(12);
    expect(rep.body.yaw).toBeUndefined();

    // With body.yaw declared in map.json, the dial bone is keyed with knee compression and reported.
    const dialMap = { ...baseMap(), body: { yaw: { bone: 'body_yaw', range: [-30, 30] } } };
    const cDial = setup({
      rig: { bones: (b) => [...b, { name: 'body_yaw', parent: 'chest', x: 0, y: 50, rotation: 0, length: 10 }] },
      map: dialMap,
      pose,
    });
    const repDialFile = join(cDial.dir, 'report_dial.json');
    const rDial = retarget(cDial, ['--bends', 'clamp', '--report', repDialFile]);
    expect(rDial.stderr).toBe('');
    expect(rDial.status).toBe(0);
    expect(linesOf(rDial, 'BODY')[0]).toContain('mapped yaw → bone "body_yaw" [-30, 30]°');

    const motionUndeclared = JSON.parse(readFileSync(c.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; slot?: string; property: string; keys: unknown[] }> } };
    };
    const motionDial = JSON.parse(readFileSync(cDial.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; slot?: string; property: string; keys: unknown[] }> } };
    };
    expect(motionDial.animations.dance.tracks.filter((tr) => tr.bone !== 'body_yaw')).toEqual(motionUndeclared.animations.dance.tracks);

    // Mutant: if readBodyYaw ignores width narrowing and returns 0, over45 is empty.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm173-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'face.ts');
      const from = 'const mag = Math.acos(w) * DEG;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const mag = 0;'));
      const cMut = setup({ pose });
      const mutRepFile = join(cMut.dir, 'report_mut.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--report', mutRepFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutRep = JSON.parse(readFileSync(mutRepFile, 'utf8')) as { body: { over45: unknown[] } };
      expect(mutRep.body.over45).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#173 Part 2: switches sets on face and body yaw with hysteresis and --switch-min, refuses unknown sets by name, and reports hides keyed by another track', () => {
    // 60 frames at 30 fps (dt = 1/30, switchMin = 0.25s = 8 frames):
    // - Face yaw:
    //   - frames 1..4 (4 frames < 8): 50° spike -> NOT entered
    //   - frames 5..14 (10 frames >= 8): 0°
    //   - frames 15..22 (8 frames >= 8): 50° -> ENTERED at f15
    //   - frame 23: 40° (>= 35° leave threshold) -> stays in T1!
    //   - frames 24..59: 0° (< 35° for >= 8 frames) -> LEAVES at f24 (active span 15..23, 2 swaps)
    // - Body yaw:
    //   - frames 0..47: 0°
    //   - frames 48..59 (12 frames >= 8): 75° -> ENTERED at f48, never leaves before end (active span 48..59, 1 swap)
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    const pose = poseDoc(m, (i, j) => {
      const neck = (j.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      const dEye = 12;
      const dEar = 24;
      j.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      j.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      j.r_ear = { state: 'observed', at: [midEye[0] - dEar / 2, midEye[1] + 5], score: 0.95 };
      j.l_ear = { state: 'observed', at: [midEye[0] + dEar / 2, midEye[1] + 5], score: 0.95 };

      const fYaw = (i >= 1 && i <= 4) || (i >= 15 && i <= 22) ? 50 : i === 23 ? 40 : 0;
      const ty = Math.tan(fYaw * RAD);
      j.nose = { state: 'observed', at: [midEye[0] - (ty * dEye) / 1.25, midEye[1] + 5], score: 0.95 };

      const bDeg = i >= 48 ? 75 : 0;
      const c = Math.cos((bDeg * Math.PI) / 180);
      const rSh = j.r_shoulder!.at as Pt;
      const lSh = j.l_shoulder!.at as Pt;
      const mShX = (rSh[0] + lSh[0]) / 2;
      const halfSh = ((lSh[0] - rSh[0]) / 2) * c;
      j.r_shoulder = { ...j.r_shoulder!, at: [mShX - halfSh, rSh[1]] };
      j.l_shoulder = { ...j.l_shoulder!, at: [mShX + halfSh, lSh[1]] };

      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      const mHipX = (rHip[0] + lHip[0]) / 2;
      const halfHip = ((lHip[0] - rHip[0]) / 2) * c;
      j.r_hip = { ...j.r_hip!, at: [mHipX - halfHip, rHip[1]] };
      j.l_hip = { ...j.l_hip!, at: [mHipX + halfHip, lHip[1]] };
      if (bDeg > 0) {
        j.neck = { ...j.neck!, at: [neck[0] - 4, neck[1]] };
      }
    });

    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw_dial', parent: 'root' }],
      extraSlots: [
        { name: 'head_slot', bone: 'neck', attachment: 'head_base' },
        { name: 'ear_l', bone: 'neck', attachment: 'ear_base' },
      ],
      extra: {
        head_slot: {
          head_base: { image: 'seg.png', x: 0, y: 0 },
          T1_head: { image: 'seg.png', x: 0, y: 0 },
          T8_head: { image: 'seg.png', x: 0, y: 0 },
        },
        ear_l: {
          ear_base: { image: 'seg.png', x: 0, y: 0 },
          T8_ear: { image: 'seg.png', x: 0, y: 0 },
        },
        sleeve_r0: {
          T8_sleeve_r0: { image: 'seg.png', x: 30, y: 0, rotation: 90 },
        },
      },
      sets: {
        spec: 'rig-parts-sets/1',
        sets: {
          T1: { slots: { head_slot: 'T1_head' }, hides: ['ear_l'] },
          T8: { slots: { head_slot: 'T8_head', ear_l: 'T8_ear', sleeve_r0: 'T8_sleeve_r0' }, hides: ['sleeve_l0'] },
        },
      },
    };

    // Unknown set in map.json is refused by name under MAP_SET_EXISTS.
    const cBad = setup({
      rig: rigOpts,
      map: {
        ...baseMap(),
        body: { sets: [{ set: 'NO_SUCH_SET', above: 45 }] },
      },
      pose,
    });
    const rBad = retarget(cBad, ['--bends', 'clamp']);
    expect(rBad.status).toBe(1);
    expect(rBad.stderr).toContain('MAP_SET_EXISTS: "body.sets" — set "NO_SUCH_SET" is not in the rig; its sets are T1, T8');

    // Valid map with T1 on face.yaw.sets and T8 on body.sets.
    const c = setup({
      rig: rigOpts,
      map: {
        ...baseMap(),
        face: {
          yaw: {
            bone: 'yaw_dial',
            range: [-15, 15],
            sets: [{ set: 'T1', above: 45 }],
          },
        },
        body: {
          sets: [{ set: 'T8', above: 45 }],
        },
      },
      pose,
    });
    const repFile = join(c.dir, 'report_sets.json');
    const r = retarget(c, ['--bends', 'clamp', '--switch-min', '0.25', '--report', repFile]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const faceLines = linesOf(r, 'FACE');
    const bodyLines = linesOf(r, 'BODY');
    expect(faceLines[0]).toContain('sets set "T1" (≥ 45°, leave < 35°): frames 15–23 (+40.0° … +50.0°) (2 swaps); hides keyed by another track: slot "ear_l" (slot "ear_l" attachment (set "T8"))');
    expect(bodyLines[0]).toContain('sets set "T8" (≥ 45°, leave < 35°): frames 48–59 (+75.1° … +75.1°) (1 swap)');

    // Check attachment keys on head_slot, ear_l, sleeve_r0, sleeve_l0.
    const motion = JSON.parse(readFileSync(c.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ slot?: string; property: string; keys: Array<{ t: number; v: string | null }> }> } };
    };
    const slotTrack = (s: string) => motion.animations.dance.tracks.find((tr) => tr.slot === s && tr.property === 'attachment');
    // head_slot enters T1 at f15, leaves T1 back to head_base at f24, and enters T8 at f48. Each key sits half a frame
    // before its frame (#334): f15's is r6((0.466667 + 0.5) / 2) = 0.483334, f24's 0.783334, f48's 1.583334.
    expect(slotTrack('head_slot')?.keys).toEqual([
      { t: 0.483334, v: 'T1_head' },
      { t: 0.783334, v: 'head_base' },
      { t: 1.583334, v: 'T8_head' },
    ]);
    // ear_l is hidden by T1 on 15..23, restored to ear_base at f24, and switched to T8_ear by T8 at f48.
    expect(slotTrack('ear_l')?.keys).toEqual([
      { t: 0.483334, v: null },
      { t: 0.783334, v: 'ear_base' },
      { t: 1.583334, v: 'T8_ear' },
    ]);
    // sleeve_l0 is hidden by T8 at f48 and never left before the end (1 key).
    expect(slotTrack('sleeve_l0')?.keys).toEqual([
      { t: 1.583334, v: null },
    ]);

    // Mutant: if selectYawSets ignores --switch-min and enters on any single frame >= above, the 4-frame spike 1..4 flips T1 (4 swaps > 2).
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm173p2-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'face.ts');
      const from = 'if (spanSec(i, j) >= switchMin - 1e-9) {';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from).length).toBeGreaterThanOrEqual(2);
      writeFileSync(path, before.replaceAll(from, 'if (true) {'));
      const cMut = setup({
        rig: rigOpts,
        map: {
          ...baseMap(),
          face: { yaw: { bone: 'yaw_dial', range: [-15, 15], sets: [{ set: 'T1', above: 45 }] } },
          body: { sets: [{ set: 'T8', above: 45 }] },
        },
        pose,
      });
      const mutRepFile = join(cMut.dir, 'report_mut.json');
      const rMut = retarget(cMut, ['--bends', 'clamp', '--switch-min', '0.25', '--report', mutRepFile], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutRep = JSON.parse(readFileSync(mutRepFile, 'utf8')) as { face: { sets: Array<{ swaps: number }> } };
      expect(mutRep.face.sets[0]!.swaps).toBeGreaterThan(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#334: the face and body yaw sets\' attachment keys sit half a frame before the frame they show on', () => {
  // A head turn at 24 fps: the face yaw at 50° (T1 enters at ≥ 45°) on frames 13–21, 26–47, 55–59 and 70–78, 0° elsewhere;
  // the body turned 75° (T8) on frames 31–41. --switch-min 0.1 s (3 frames) keeps every span and gap.
  const N = 96;
  const FPS = 24;
  const FACE: Array<[number, number]> = [[13, 21], [26, 47], [55, 59], [70, 78]];
  const BODY: Array<[number, number]> = [[31, 41]];
  const inAny = (spans: Array<[number, number]>, i: number) => spans.some(([a, b]) => i >= a && i <= b);
  const m: Motion = { ...BASE, n: N, dt: 1 / FPS, hip: () => [0, 0], trunk: () => 90, ru: () => 120, rf: () => 128, lu: () => 60, lf: () => 50, rt: () => -90, rs: () => -95, lt: () => -90, ls: () => -90 };
  const pose = poseDoc(m, (i, j) => {
    const neck = (j.neck as { at: Pt }).at;
    const midEye: Pt = [neck[0], neck[1] - 35];
    j.r_eye = { state: 'observed', at: [midEye[0] - 6, midEye[1]], score: 0.95 };
    j.l_eye = { state: 'observed', at: [midEye[0] + 6, midEye[1]], score: 0.95 };
    j.r_ear = { state: 'observed', at: [midEye[0] - 12, midEye[1] + 5], score: 0.95 };
    j.l_ear = { state: 'observed', at: [midEye[0] + 12, midEye[1] + 5], score: 0.95 };
    const ty = Math.tan((inAny(FACE, i) ? 50 : 0) * RAD);
    j.nose = { state: 'observed', at: [midEye[0] - (ty * 12) / 1.25, midEye[1] + 5], score: 0.95 };
    const c = Math.cos((inAny(BODY, i) ? 75 : 0) * RAD);
    for (const [r, l] of [['r_shoulder', 'l_shoulder'], ['r_hip', 'l_hip']] as const) {
      const a = j[r]!.at as Pt;
      const b = j[l]!.at as Pt;
      const mx = (a[0] + b[0]) / 2;
      const half = ((b[0] - a[0]) / 2) * c;
      j[r] = { ...j[r]!, at: [mx - half, a[1]] };
      j[l] = { ...j[l]!, at: [mx + half, b[1]] };
    }
  });
  const rigOpts: RigOpts = {
    bones: (bs) => [...bs, { name: 'yaw_dial', parent: 'root' }],
    extraSlots: [
      { name: 'head_slot', bone: 'neck', attachment: 'head_base' },
      { name: 'body_slot', bone: 'chest', attachment: 'body_base' },
    ],
    extra: {
      head_slot: { head_base: { image: 'seg.png', x: 0, y: 0 }, T1_head: { image: 'seg.png', x: 0, y: 0 } },
      body_slot: { body_base: { image: 'seg.png', x: 0, y: 0 }, T8_body: { image: 'seg.png', x: 0, y: 0 } },
    },
    sets: { spec: 'rig-parts-sets/1', sets: { T1: { slots: { head_slot: 'T1_head' }, hides: [] }, T8: { slots: { body_slot: 'T8_body' }, hides: [] } } },
  };
  const map = { ...baseMap(), face: { yaw: { bone: 'yaw_dial', range: [-15, 15], sets: [{ set: 'T1', above: 45 }] } }, body: { sets: [{ set: 'T8', above: 45 }] } };
  type Out = { motion: MotionDoc & { animations: { dance: { tracks: Array<{ slot?: string; property: string; keys: Array<{ t: number; v: string | null }> }> } } }; frameTimes: number[]; face: Array<[number, number]>; body: Array<[number, number]> };
  const run = (cliPath = CLI): Out => {
    const c = setup({ rig: rigOpts, map, pose });
    const rep = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--switch-min', '0.1', '--report', rep], cliPath);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(rep, 'utf8')) as { frameTimes: number[]; face: { sets: Array<{ spans: Array<[number, number]> }> }; body: { sets: Array<{ spans: Array<[number, number]> }> } };
    return { motion: JSON.parse(readFileSync(c.out, 'utf8')) as Out['motion'], frameTimes: report.frameTimes, face: report.face.sets[0]!.spans, body: report.body.sets[0]!.spans };
  };
  /** Per swap, `slot frame f: shows on g` where the render's reading shows the key on another frame than its span says. */
  const late = (o: Out): string[] => {
    const rows: string[] = [];
    for (const [slot, spans] of [['head_slot', o.face], ['body_slot', o.body]] as const) {
      const want = spans.flatMap(([lo, hi]) => (hi + 1 < N ? [lo, hi + 1] : [lo]));
      const keys = o.motion.animations.dance.tracks.find((tr) => tr.slot === slot && tr.property === 'attachment')!.keys;
      expect(keys).toHaveLength(want.length);
      firstFrames(keys, N, FPS).forEach((g, k) => {
        if (g !== want[k]) rows.push(`${slot} frame ${want[k]} (t=${keys[k]!.t}): shows on ${g}`);
      });
    }
    return rows;
  };

  test('every yaw swap first shows on the frame its span starts or ends on, read as the render reads it; no discrete key is on a frame time', () => {
    const o = run();
    expect(o.face).toEqual(FACE);
    expect(o.body).toEqual(BODY);
    expect(keysOnFrameTimes(o.motion, o.frameTimes)).toEqual([]);
    expect(late(o)).toEqual([]);
  }, SLOW);

  test('mutant: the yaw keys written on their frames\' exact times sit on frame times, and 7 of the 10 swaps show a frame late', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm334-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'keys.push({ t: keyAtFrame(keyTimes, i), v });';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'keys.push({ t: keyTimes[i]!, v });'));
      const o = run(join(d, 'cli.ts'));
      expect(keysOnFrameTimes(o.motion, o.frameTimes)).toHaveLength(10);
      expect(late(o)).toEqual([
        'head_slot frame 13 (t=0.541667): shows on 14',
        'head_slot frame 22 (t=0.916667): shows on 23',
        'head_slot frame 55 (t=2.291667): shows on 56',
        'head_slot frame 60 (t=2.5): shows on 61',
        'head_slot frame 70 (t=2.916667): shows on 71',
        'head_slot frame 79 (t=3.291667): shows on 80',
        'body_slot frame 31 (t=1.291667): shows on 32',
      ]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#179 and #181: wrist-to-head distance gate for --raised-by-head and detrended running median baseline for head nod', () => {
  test('#179: --raised-by-head places a set whose key wrist lies within 2 eye distances of the head even when upper arm drawn is outside 60°..120°, and does not head-place a set whose wrist is farther; mutant re-enabling upper-arm gate fails', () => {
    const N = 16;
    const DT = 1 / 24;
    const headBones = (b: BoneSpec[]): BoneSpec[] => [
      ...b,
      { name: 'head', parent: 'neck', x: 0, y: 20 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    ];
    const rigOpts: RigOpts = {
      bones: headBones,
      extra: {
        sleeve_r0: { seg_up: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
        sleeve_l0: { seg_far: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
      },
    };
    // Right arm: drawn sleeve_r0 = 40° (outside 60°..120°!), key wrist at (-5, 65) within 1.5 eye_dist (18px) of head centre (0, 65).
    // Left arm: drawn sleeve_l0 = 80° (inside 60°..120°!), key wrist at (80, 65), 6.7 eye_dist (> 2) from head centre (0, 65).
    const m: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: () => 90,
      hip: () => [0, 0],
      ru: () => 115,
      rf: () => 65,
      lu: () => 80,
      lf: () => 0,
    };
    const keyPos = positions(m, 0);
    const mapSpec: Record<string, unknown> = {
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K_both',
          slots: { sleeve_r0: 'seg_up', sleeve_l0: 'seg_far' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_eye: keyPos.r_eye!,
            l_eye: keyPos.l_eye!,
            r_shoulder: keyPos.r_shoulder!,
            r_elbow: keyPos.r_elbow!,
            r_wrist: [keyPos.r_eye![0] + 2, keyPos.r_eye![1]],
            l_shoulder: keyPos.l_shoulder!,
            l_elbow: keyPos.l_elbow!,
            l_wrist: [keyPos.l_eye![0] + 60, keyPos.l_eye![1]],
          },
          drawn: { sleeve_r0: 40, sleeve_r1: 65, sleeve_l0: 80, sleeve_l1: 0 },
          turn: { sleeve_r0: [-90, 90], sleeve_r1: [-90, 90], sleeve_l0: [-90, 90], sleeve_l1: [-90, 90] },
        },
      ],
    };
    const pose = poseDoc(m, (_i, j) => {
      j.r_wrist = { state: 'observed', at: [keyPos.r_eye![0] + 2, keyPos.r_eye![1]], score: 0.9 };
      j.l_wrist = { state: 'observed', at: [keyPos.l_eye![0] + 60, keyPos.l_eye![1]], score: 0.9 };
    });
    const c = setup({ rig: rigOpts, map: mapSpec, pose });
    const r = retarget(c, ['--raised-by-head']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const raised = linesOf(r, 'RAISED');
    expect(raised.some((l) => l.includes('chain "arm_r"'))).toBe(true);
    expect(raised.some((l) => l.includes('chain "arm_l"'))).toBe(false);

    // Mutant: re-enabling the upper-arm angle gate (isRaised(drawn) only) drops arm_r (drawn 40°) and head-places arm_l (drawn 80°).
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm179-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const up = isChainHeadPlaced(set, c, drawn);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const up = headOk !== null && drawn !== undefined && isRaised(drawn);'));
      const cMut = setup({ rig: rigOpts, map: mapSpec, pose });
      const rMut = retarget(cMut, ['--raised-by-head'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutRaised = linesOf(rMut, 'RAISED');
      expect(mutRaised.some((l) => l.includes('chain "arm_r"'))).toBe(false);
      expect(mutRaised.some((l) => l.includes('chain "arm_l"'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#181: detrended running median nod baseline preserves beat-to-beat oscillation across slow baseline drift with <= 10% frames at the ±2% clamp; mutant using frame 0 baseline pins >= 70% of frames at the clamp', () => {
    const N = 60;
    const DT = 1 / 24;
    const headRig: NonNullable<RigOpts['bones']> = (b) => [
      ...b,
      { name: 'head', parent: 'neck', x: 0, y: 50 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    ];
    const mapWithHead = (): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
    });
    // Slow baseline drift of -4 rig units after frame 10 + beat oscillation of ±0.7 rig units (within maxNod = 1.0u).
    const driftNodPose = () => {
      const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
      return poseDoc(m, (i, j) => {
        j.r_ankle = { state: 'observed', at: [-20, 350], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [20, 320], score: 0.9 };
        const drift = i < 10 ? (-4 * i) / 10 : -4;
        const beat = 0.7 * Math.sin((i / 6) * 2 * Math.PI);
        const dyPic = -(drift + beat) / SCALE;
        const r = j.r_eye!.at as Pt;
        const l = j.l_eye!.at as Pt;
        j.r_eye = { state: 'observed', at: [r[0], r[1] + dyPic], score: 0.9 };
        j.l_eye = { state: 'observed', at: [l[0], l[1] + dyPic], score: 0.9 };
      });
    };
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: driftNodPose() });
    const r = retarget(c, ['--bends', 'clamp', '--plant-feet']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const headTrans = motionOf(c.out).animations.dance!.tracks.find((t) => t.bone === 'head' && t.property === 'translate')!;
    const maxNod = 0.02 * 50; // 1.0u
    const clampedCount = headTrans.keys.filter((k) => Math.abs((k.v as number[])[1]!) >= maxNod - 1e-3).length;
    expect(clampedCount / N).toBeLessThanOrEqual(0.1);

    // Mutant: reverting nodBase to frame 0 pins >= 70% of frames at -maxNod.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm181-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const rawNod = refEN.map((v, i) => (v - nodBase[i]!) * nodScale!);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const rawNod = refEN.map((v) => (v - refEN[0]!) * nodScale!);\n        const p90Nod0 = 0;').replace('if (p90Nod > maxNod', 'if (p90Nod0 > maxNod'));
      const cMut = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: driftNodPose() });
      const rMut = retarget(cMut, ['--bends', 'clamp', '--plant-feet'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutTrans = motionOf(cMut.out).animations.dance!.tracks.find((t) => t.bone === 'head' && t.property === 'translate')!;
      const mutClamped = mutTrans.keys.filter((k) => Math.abs((k.v as number[])[1]!) >= maxNod - 1e-3).length;
      expect(mutClamped / N).toBeGreaterThanOrEqual(0.7);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#184: a horizontal chain (pelvis) shorter than --short or reversed within a frame holds its last confident angle and interpolates; mutant disabling holdAcross flips hip.rotate past 100° and mirrors leg origins', () => {
    // Unit check: holdAcross holds frames below cutoff or reversed past threshold and interpolates the short way round.
    const u = [-5, -5.6, -5.6, 171.8, 174.6, 174.4, -5.0, -2.2, -2.0];
    const frac = [1, 1, 0.25, 0.17, 0.17, 0.18, 0.28, 1, 1];
    const spans = holdAcross(u, frac, 0.35, 90, 0);
    expect(spans).toEqual([
      {
        frames: [2, 6],
        minFraction: 0.17,
        across: true,
        reversed: expect.closeTo(-179.4, 5),
      },
    ]);
    for (const a of u) expect(Math.abs(a)).toBeLessThanOrEqual(6);

    // End-to-end check with mutant: pelvis foreshortens to 0.17 of median on frames 8–12 and crosses r_hip.x > l_hip.x on frames 9–11.
    const N = 20;
    const DT = 1 / 30;
    const pelvisMap = (): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
      ],
    });
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0] };
    const sideTurnPose = poseDoc(m, (i, j) => {
      // Base hip line is r_hip (-15, 300) → l_hip (+15, 300), length 30 px, slight tilt -5.6° before turn and -2.2° after.
      const tiltDeg = i <= 7 ? -5.6 : i >= 13 ? -2.2 : -4.0;
      const rad = -tiltDeg * RAD; // picture y-down
      if (i >= 8 && i <= 12) {
        // Collapses to 0.17 * 30 = 5.1 px, and on frames 9–11 crosses so r_hip.x > l_hip.x (reversed ~178°).
        const crossed = i >= 9 && i <= 11;
        const half = 2.55;
        const dx = crossed ? -half : half;
        const dy = Math.sin(rad) * half;
        j.r_hip = { state: 'observed', at: [-dx, 300 - dy], score: 0.9 };
        j.l_hip = { state: 'observed', at: [dx, 300 + dy], score: 0.9 };
      } else {
        const half = 15;
        const dx = Math.cos(rad) * half;
        const dy = Math.sin(rad) * half;
        j.r_hip = { state: 'observed', at: [-dx, 300 - dy], score: 0.9 };
        j.l_hip = { state: 'observed', at: [dx, 300 + dy], score: 0.9 };
      }
    });
    const c = setup({ map: pelvisMap(), pose: sideTurnPose });
    const r = retarget(c, ['--short', '0.35', '--flip', '90', '--bends', 'clamp']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FLIP')).toEqual([]);
    expect(linesOf(r, 'END-ON')).toEqual([]);
    const holds = linesOf(r, 'HOLD');
    expect(holds.some((l) => l.includes('chain "pelvis" bone "hip" (r_hip → l_hip) frames 8–12'))).toBe(true);
    const hipRot = motionOf(c.out).animations.dance!.tracks.find((t) => t.bone === 'hip' && t.property === 'rotate')!;
    for (const k of hipRot.keys) {
      const deg = (k.v as number[])[0]!;
      expect(deg).toBeGreaterThanOrEqual(-10);
      expect(deg).toBeLessThanOrEqual(10);
    }
    const doc = loadBuild(c.build);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    for (const p of poses) {
      const b = byName(p.bones);
      expect(b.get('leg_r0')!.worldX).toBeLessThan(b.get('leg_l0')!.worldX);
    }

    // Mutant: skipping across-body chains in the short/reverse hold lets the crossed 2D hip line flip hip.rotate > 100° and mirror leg_r0/leg_l0.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm184-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const spans = holdAcross(targets.get(b)!, fraction, opts.short, opts.flip, restDir);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const spans: ShortSpan[] = [];'));
      const cMut = setup({ map: pelvisMap(), pose: sideTurnPose });
      const rMut = retarget(cMut, ['--short', '0.35', '--flip', '90', '--bends', 'clamp'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      expect(linesOf(rMut, 'FLIP').length).toBeGreaterThan(0);
      const mutRot = motionOf(cMut.out).animations.dance!.tracks.find((t) => t.bone === 'hip' && t.property === 'rotate')!;
      const maxMutDeg = Math.max(...mutRot.keys.map((k) => Math.abs((k.v as number[])[0]!)));
      expect(maxMutDeg).toBeGreaterThan(100);
      const mutDoc = loadBuild(cMut.build);
      const mutPoses = poseRawAnimation(mutDoc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const anyMirrored = mutPoses.some((p) => {
        const b = byName(p.bones);
        return b.get('leg_r0')!.worldX >= b.get('leg_l0')!.worldX;
      });
      expect(anyMirrored).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#188: symmetric gesture set normalisation and declared support-arm anchoring', () => {
  const N = 16;
  const DT = 1 / 24;
  const headBones = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -15, y: 10 },
    { name: 'eye_l', parent: 'head', x: 15, y: 10 },
  ];
  const rigOpts: RigOpts = {
    bones: headBones,
    extra: {
      sleeve_r0: { k1_r: { image: 'seg.png', x: 30, y: 0, rotation: -90 }, k3_r: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
      sleeve_l0: { k1_l: { image: 'seg.png', x: 30, y: 0, rotation: -90 }, k3_l: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
    },
  };

  test('MAP_ALT_SYMMETRIC and MAP_ALT_SUPPORT refuse malformed declarations by name', () => {
    const m: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0] };
    const kp = positions(m, 0);
    const makeMap = (altPatch: Record<string, unknown>): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K_test',
          slots: { sleeve_r0: 'k1_r', sleeve_l0: 'k1_l' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp.r_shoulder!,
            r_elbow: kp.r_elbow!,
            r_wrist: kp.r_wrist!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_r0: 120, sleeve_r1: 30, sleeve_l0: 60, sleeve_l1: 150 },
          ...altPatch,
        },
      ],
    });
    const pose = poseDoc(m);

    const rSymFalse = retarget(setup({ rig: rigOpts, map: makeMap({ symmetric: false }), pose }));
    expect(rSymFalse.status).toBe(1);
    expect(rSymFalse.stderr).toContain('MAP_ALT_SYMMETRIC');

    const rSymMissingDrawn = retarget(
      setup({
        rig: rigOpts,
        map: makeMap({ symmetric: true, drawn: { sleeve_r0: 120, sleeve_r1: 30, sleeve_l0: 60 } }),
        pose,
      }),
    );
    expect(rSymMissingDrawn.status).toBe(1);
    expect(rSymMissingDrawn.stderr).toContain('MAP_ALT_SYMMETRIC');

    const rSupUnknown = retarget(setup({ rig: rigOpts, map: makeMap({ support: 'leg_r' }), pose }));
    expect(rSupUnknown.status).toBe(1);
    expect(rSupUnknown.stderr).toContain('MAP_ALT_SUPPORT');

    const rSupMissingDrawn = retarget(
      setup({
        rig: rigOpts,
        map: makeMap({ support: 'arm_l', drawn: { sleeve_r0: 120, sleeve_r1: 30, sleeve_l0: 60 } }),
        pose,
      }),
    );
    expect(rSupMissingDrawn.status).toBe(1);
    expect(rSupMissingDrawn.stderr).toContain('MAP_ALT_SUPPORT');
  });

  test('#188 symmetric rule + mutant: a "symmetric": true set normalises elbow heights (|elbow_l.y - elbow_r.y| <= 0.01u) and clamps wrists inside the head box while keeping lower-body tracks byte-identical', () => {
    // Symmetric key pose: ru=120°, rf=30°, lu=60°, lf=150°; sequence has asymmetric upper arms (ru=135°, lu=75°: sin(135°)=0.707 vs sin(75°)=0.966 -> 18u height diff) and wide forearms (rf=15°, lf=165°).
    const mKey: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 120, rf: () => 30, lu: () => 60, lf: () => 150 };
    const kp = positions(mKey, 0);
    const mSeq: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 135, rf: () => 15, lu: () => 75, lf: () => 165 };
    const pose = poseDoc(mSeq);
    const makeMap = (symmetric: boolean): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K1_sym',
          slots: { sleeve_r0: 'k1_r', sleeve_l0: 'k1_l' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp.r_shoulder!,
            r_elbow: kp.r_elbow!,
            r_wrist: kp.r_wrist!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_r0: 120, sleeve_r1: 30, sleeve_l0: 60, sleeve_l1: 150 },
          turn: { sleeve_r0: [-35, 35], sleeve_r1: [-35, 35], sleeve_l0: [-35, 35], sleeve_l1: [-35, 35] },
          ...(symmetric ? { symmetric: true } : {}),
        },
      ],
    });

    const cSym = setup({ rig: rigOpts, map: makeMap(true), pose });
    const rSym = retarget(cSym, ['--raised-by-head']);
    expect(rSym.stderr).toBe('');
    expect(rSym.status).toBe(0);

    const cBase = setup({ rig: rigOpts, map: makeMap(false), pose });
    const rBase = retarget(cBase, ['--raised-by-head']);
    expect(rBase.status).toBe(0);

    // Lower-body tracks are byte-identical.
    const motSym = motionOf(cSym.out).animations.dance!.tracks;
    const motBase = motionOf(cBase.out).animations.dance!.tracks;
    for (const lb of ['hip', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
      expect(motSym.filter((t) => 'bone' in t && t.bone === lb)).toEqual(motBase.filter((t) => 'bone' in t && t.bone === lb));
    }

    const posesSym = poseRawAnimation(loadBuild(cSym.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    let maxElbowDiffSym = 0;
    for (const p of posesSym) {
      const b = byName(p.bones);
      const er = b.get('sleeve_r1')!;
      const el = b.get('sleeve_l1')!;
      maxElbowDiffSym = Math.max(maxElbowDiffSym, Math.abs(el.worldY - er.worldY));
      const eyeR = b.get('eye_r')!;
      const eyeL = b.get('eye_l')!;
      const hcx = 0.5 * (eyeR.worldX + eyeL.worldX);
      const ed = Math.hypot(eyeL.worldX - eyeR.worldX, eyeL.worldY - eyeR.worldY);
      const wxR = er.worldX + er.a * 60;
      const wxL = el.worldX + el.a * 60;
      expect(Math.abs(wxR - hcx)).toBeLessThanOrEqual(0.35 * ed + 1e-3);
      expect(Math.abs(wxL - hcx)).toBeLessThanOrEqual(0.35 * ed + 1e-3);
    }
    expect(maxElbowDiffSym).toBeLessThanOrEqual(0.05);

    // Mutant: disabling solveSymmetricFrame leaves the elbows > 15u apart in height.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm188-sym-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'if (set.chains.length !== 2) return null;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'if (true) return null;'));
      const cMut = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rMut = retarget(cMut, ['--raised-by-head'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const posesMut = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      let maxElbowDiffMut = 0;
      for (const p of posesMut) {
        const b = byName(p.bones);
        maxElbowDiffMut = Math.max(maxElbowDiffMut, Math.abs(b.get('sleeve_l1')!.worldY - b.get('sleeve_r1')!.worldY));
      }
      expect(maxElbowDiffMut).toBeGreaterThan(15);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#188 support-arm rule + mutant: a declared "support" chain stays within ±3° of drawn and the active raised arm clears the head outward while keeping lower-body tracks byte-identical', () => {
    // K3_v_sign style: right arm raised (drawn 102°, 77°, wrist > 2 eye_dist from head), left arm on waist (drawn -50°, -125°).
    // On the sequence, left arm has noisy foreshortened swing (-30°, -107°, 20° off drawn).
    const mKey: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 102, rf: () => 77, lu: () => -50, lf: () => -125 };
    const kp = positions(mKey, 0);
    const mSeq: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 102, rf: () => 77, lu: () => -30, lf: () => -107 };
    const pose = poseDoc(mSeq);
    const makeMap = (withSupport: boolean): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K3_sup',
          slots: { sleeve_r0: 'k3_r', sleeve_l0: 'k3_l' },
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_eye: kp.r_eye!,
            l_eye: kp.l_eye!,
            r_shoulder: kp.r_shoulder!,
            r_elbow: kp.r_elbow!,
            r_wrist: kp.r_wrist!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_r0: 102, sleeve_r1: 77, sleeve_l0: -50, sleeve_l1: -125 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          ...(withSupport ? { support: 'arm_l' } : {}),
        },
      ],
    });

    const cSup = setup({ rig: rigOpts, map: makeMap(true), pose });
    const rSup = retarget(cSup, ['--raised-by-head']);
    expect(rSup.stderr).toBe('');
    expect(rSup.status).toBe(0);

    const posesSup = poseRawAnimation(loadBuild(cSup.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    for (const p of posesSup) {
      const b = byName(p.bones);
      const l0 = Math.atan2(b.get('sleeve_l0')!.c, b.get('sleeve_l0')!.a) * DEG;
      const l1 = Math.atan2(b.get('sleeve_l1')!.c, b.get('sleeve_l1')!.a) * DEG;
      const r0 = Math.atan2(b.get('sleeve_r0')!.c, b.get('sleeve_r0')!.a) * DEG;
      const r1 = Math.atan2(b.get('sleeve_r1')!.c, b.get('sleeve_r1')!.a) * DEG;
      expect(Math.abs(wrap(l0 - -50))).toBeLessThanOrEqual(3);
      expect(Math.abs(wrap(l1 - -125))).toBeLessThanOrEqual(3);
      expect(r0).toBeGreaterThanOrEqual(102 + 8);
      expect(r1).toBeGreaterThanOrEqual(77 + 12);
    }

    // Mutant: disabling solveSupportChainFrame and solveSupportActiveFrame lets arm_l swing > 15° from drawn and leaves arm_r at <= 105°.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm188-sup-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from1 = 'const solveSupportChainFrame = (set: (typeof map.alternates)[number], c: Chain, i: number): void => {';
      const from2 = 'if (c.bones.length < 2 || c.joints.length < 3) return null;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from1)).toHaveLength(2);
      expect(before.split(from2)).toHaveLength(2);
      writeFileSync(
        path,
        before
          .replace(from1, `${from1} if (true) return;`)
          .replace(from2, 'if (true) return null;'),
      );
      const cMut = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rMut = retarget(cMut, ['--raised-by-head'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const posesMut = poseRawAnimation(loadBuild(cMut.build), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const b0 = byName(posesMut[0]!.bones);
      const l0Mut = Math.atan2(b0.get('sleeve_l0')!.c, b0.get('sleeve_l0')!.a) * DEG;
      const r0Mut = Math.atan2(b0.get('sleeve_r0')!.c, b0.get('sleeve_r0')!.a) * DEG;
      expect(Math.abs(wrap(l0Mut - -50))).toBeGreaterThan(15);
      expect(r0Mut).toBeLessThanOrEqual(105);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#189: read yaw from the ear chord when the eye span is foreshortened and the ear chord disagrees with the nose', () => {
  function sideGazeAndTurnPose(): Record<string, unknown> {
    return poseDoc({ ...BASE, n: 20 }, (i, joints) => {
      const neck = (joints.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      // 12 of 20 frames (f6..17) have dEye = de0 = 56.18 -> median(de) = 56.18.
      // - f0..1: held side gaze (de = 0.7972 * de0, xne = 0.0975, xea = 0.2016; w = 1.0)
      // - f2..4: exit ramp (de/de0 = 0.8014, 0.8145, 0.8352; w = 0.972, 0.711, 0.296)
      // - f5..7: post-exit smooth frames (de/de0 = 0.8508, 1.0, 1.0; w = 0)
      // - f18..19: foreshortened normal turn where nose and ear agree (de = 0.7921 * de0, xne = 0.16, xea = 0.20; |xea|/|xne| = 1.25 <= 1.8 -> w = 0)
      const de0 = 56.18;
      const dEar = 123.38;
      let dEye = de0;
      let xne = (i - 12) * 0.08;
      let xea = (i - 12) * 0.08;
      if (i <= 1) {
        dEye = 0.7972 * de0;
        xne = 0.0975;
        xea = 0.2016;
      } else if (i === 2) {
        dEye = 0.8014 * de0;
        xne = 0.1001;
        xea = 0.1953;
      } else if (i === 3) {
        dEye = 0.8145 * de0;
        xne = 0.0927;
        xea = 0.1852;
      } else if (i === 4) {
        dEye = 0.8352 * de0;
        xne = 0.0906;
        xea = 0.1707;
      } else if (i === 5) {
        dEye = 0.8508 * de0;
        xne = 0.0891;
        xea = 0.1471;
      } else if (i === 6) {
        dEye = de0;
        xne = 0.0915;
        xea = 0.1267;
      } else if (i === 7) {
        dEye = de0;
        xne = 0.08;
        xea = 0.08;
      } else if (i >= 18) {
        dEye = 0.7921 * de0;
        xne = 0.16;
        xea = 0.2;
      }
      joints.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      joints.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      const midEarX = midEye[0] + xea * dEar;
      joints.r_ear = { state: 'observed', at: [midEarX - dEar / 2, midEye[1] + 5], score: 0.95 };
      joints.l_ear = { state: 'observed', at: [midEarX + dEar / 2, midEye[1] + 5], score: 0.95 };
      const nx = midEye[0] - xne * dEye;
      joints.nose = { state: 'observed', at: [nx, midEye[1] + 5], score: 0.95 };
    });
  }

  test('reads yaw from the ear chord (+21.964°) on the foreshortened side-gaze opening with 0.000°/f jitter, ramps out smoothly across [0.80, 0.85]*median(de), and keeps outside frames byte-identical to the regime-off mutant', () => {
    const pose = sideGazeAndTurnPose();
    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw_dial', parent: 'root' }],
    };
    const map = { ...baseMap(), face: { yaw: { bone: 'yaw_dial', range: [-30, 30] } } };
    const c = setup({ rig: rigOpts, map, pose });
    const r = retarget(c, ['--bends', 'clamp']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const mot = motionOf(c.out).animations.dance!.tracks;
    const yawKeys = mot.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
    // On f0..1 (w = 1.0), yaw_dial reaches atan(2 * 0.2016) * DEG = 21.964° with 0.000°/f jitter.
    expect(yawKeys[0]!).toBeCloseTo(21.964, 2);
    expect(yawKeys[1]!).toBeCloseTo(21.964, 2);
    expect(Math.abs(yawKeys[1]! - yawKeys[0]!)).toBe(0);

    // Bar 2 boundary smoothness: across the regime exit (f4 -> f5), max |Δyaw| on boundary ±3 frames (f2..7) <= 5°/f (absolute ceiling) and <= max |Δyaw| inside regime (f0..4) + 2°.
    let maxInRegime = 0;
    for (let i = 1; i <= 4; i++) maxInRegime = Math.max(maxInRegime, Math.abs(yawKeys[i]! - yawKeys[i - 1]!));
    let maxBoundary = 0;
    for (let i = 2; i <= 7; i++) maxBoundary = Math.max(maxBoundary, Math.abs(yawKeys[i]! - yawKeys[i - 1]!));
    const exitStep = Math.abs(yawKeys[5]! - yawKeys[4]!);
    expect(exitStep).toBeLessThan(3.5);
    expect(maxBoundary).toBeLessThanOrEqual(5);
    expect(maxBoundary).toBeLessThanOrEqual(maxInRegime + 2);

    // Mutant 1: disabling the earChord regime drops f0..1 back down to ~12.2° while f5..19 are 100% byte-identical.
    mkdirSync(MUTANTS, { recursive: true });
    const d1 = mkdtempSync(join(MUTANTS, 'm189-off-'));
    try {
      cpSync(join(ROOT, 'src'), join(d1, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d1, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d1, 'package.json'));
      const path = join(d1, 'src', 'face.ts');
      const from = 'Math.abs(xea[i]!) > EAR_CHORD_K_MIN;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'false;'));

      const cOff = setup({ rig: rigOpts, map, pose });
      const rOff = retarget(cOff, ['--bends', 'clamp'], join(d1, 'cli.ts'));
      expect(rOff.status).toBe(0);
      const motOff = motionOf(cOff.out).animations.dance!.tracks;
      const yawOff = motOff.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
      for (let i = 0; i < 2; i++) {
        expect(yawOff[i]!).toBeLessThan(12.5);
      }
      // Every frame with w = 0 (frames 5..19) is byte-identical, and all non-yaw_dial tracks are byte-identical.
      expect(yawKeys.slice(5)).toEqual(yawOff.slice(5));
      expect(mot.filter((tr) => !('bone' in tr && tr.bone === 'yaw_dial'))).toEqual(
        motOff.filter((tr) => !('bone' in tr && tr.bone === 'yaw_dial')),
      );
    } finally {
      rmSync(d1, { recursive: true, force: true });
    }
  }, SLOW);

  test('mutant (#189): lowering EAR_CHORD_K_RATIO to 1.0 leaks onto normal foreshortened turns, and a step exit (EAR_CHORD_K_LO = 0.85) snaps by > 8° across the boundary', () => {
    const pose = sideGazeAndTurnPose();
    const rigOpts: RigOpts = {
      bones: (bs) => [...bs, { name: 'yaw_dial', parent: 'root' }],
    };
    const map = { ...baseMap(), face: { yaw: { bone: 'yaw_dial', range: [-30, 30] } } };
    const c = setup({ rig: rigOpts, map, pose });
    const r = retarget(c, ['--bends', 'clamp']);
    expect(r.status).toBe(0);
    const yawKeys = motionOf(c.out).animations.dance!.tracks.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);

    mkdirSync(MUTANTS, { recursive: true });
    const d2 = mkdtempSync(join(MUTANTS, 'm189-kratio-'));
    try {
      cpSync(join(ROOT, 'src'), join(d2, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d2, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d2, 'package.json'));
      const path = join(d2, 'src', 'face.ts');
      const from = 'export const EAR_CHORD_K_RATIO = 1.8;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const EAR_CHORD_K_RATIO = 1.0;'));

      const cK1 = setup({ rig: rigOpts, map, pose });
      const rK1 = retarget(cK1, ['--bends', 'clamp'], join(d2, 'cli.ts'));
      expect(rK1.status).toBe(0);
      const motK1 = motionOf(cK1.out).animations.dance!.tracks;
      const yawK1 = motK1.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
      expect(yawK1.slice(5)).not.toEqual(yawKeys.slice(5));
      expect(Math.abs(yawK1[19]! - yawKeys[19]!)).toBeGreaterThan(4);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }

    const d3 = mkdtempSync(join(MUTANTS, 'm189-step-'));
    try {
      cpSync(join(ROOT, 'src'), join(d3, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d3, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d3, 'package.json'));
      const path = join(d3, 'src', 'face.ts');
      const from = 'export const EAR_CHORD_K_LO = 0.8;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'export const EAR_CHORD_K_LO = 0.85;'));

      const cStep = setup({ rig: rigOpts, map, pose });
      const rStep = retarget(cStep, ['--bends', 'clamp'], join(d3, 'cli.ts'));
      expect(rStep.status).toBe(0);
      const motStep = motionOf(cStep.out).animations.dance!.tracks;
      const yawStep = motStep.find((tr) => 'bone' in tr && tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
      let maxInStep = 0;
      for (let i = 1; i <= 4; i++) maxInStep = Math.max(maxInStep, Math.abs(yawStep[i]! - yawStep[i - 1]!));
      const snapStep = Math.abs(yawStep[5]! - yawStep[4]!);
      expect(snapStep).toBeGreaterThan(8);
      expect(snapStep).toBeGreaterThan(maxInStep + 2);
    } finally {
      rmSync(d3, { recursive: true, force: true });
    }
  }, SLOW);
});
