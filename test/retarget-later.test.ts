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


// ===========================================================================

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

// --- #110: art-range edge easing and foreshortened step cap ----------------------

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

// --- #107: --leg-scale clamp floor does not lift the hip, and POSTURE bounce -----

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

describe('#190 / #205: beat nod: clamped head.translate.y drives pitch_dial and head.rotate in phase when the neck-length clamp acts', () => {
  test('couples clamped head.translate.y into pitch_dial.rotate (2.8 °/u) and head.rotate (1.6 °/u) within ≤ 0.5° in phase at the beat frequency, adds 0 on un-nodded frames, flattens when disabled, and fails Bar 1 when residual is put back in', () => {
    const N = 63;
    const DT = 1 / 24;
    const headRig: NonNullable<RigOpts['bones']> = (b) => [
      ...b,
      { name: 'head', parent: 'neck', x: 0, y: 50 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
      { name: 'pitch_dial', parent: 'head', x: 0, y: 0 },
    ];
    const mapSpec: Record<string, unknown> = {
      ...baseMap(),
      chains: [
        { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
        ...baseChains(),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      face: {
        pitch: { bone: 'pitch_dial', range: [-25, 25] },
      },
    };
    // Frames 0..11: 0u vertical nod -> clampedY === 0 -> pitch_dial === 0° and head.rotate === 0°.
    // Frames 12..62: 2-cycle beat nod (bin 2 over 63 frames, 0.7619 Hz) with 12.0u amplitude on maxNod = 1.0u
    // (clampedY within ±1.0u, unbounded residual up to ±11.0u).
    // Nose moves vertically with the eyes so raw 2D face pitch (nose vs eyes/ears) is 0° on every frame.
    const beatNodSignal = (i: number): number => {
      if (i < 12) return 0;
      return 12.0 * Math.sin(((2 * i) / N) * 2 * Math.PI);
    };
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    const pose = poseDoc(m, (i, j) => {
      j.r_ankle = { state: 'observed', at: [-20, 350], score: 0.95 };
      j.l_ankle = { state: 'observed', at: [20, 320], score: 0.95 };
      const dyPic = -beatNodSignal(i) / SCALE;
      const rEye = j.r_eye!.at as Pt;
      const lEye = j.l_eye!.at as Pt;
      const midEyeY = (rEye[1] + lEye[1]) / 2 + dyPic;
      const midEyeX = (rEye[0] + lEye[0]) / 2;
      j.r_eye = { state: 'observed', at: [rEye[0], rEye[1] + dyPic], score: 0.95 };
      j.l_eye = { state: 'observed', at: [lEye[0], lEye[1] + dyPic], score: 0.95 };
      j.r_ear = { state: 'observed', at: [midEyeX - 18, midEyeY], score: 0.95 };
      j.l_ear = { state: 'observed', at: [midEyeX + 18, midEyeY], score: 0.95 };
      j.nose = { state: 'observed', at: [midEyeX, midEyeY], score: 0.95 };
    });

    const c = setup({ rig: { bones: headRig }, map: mapSpec, pose });
    const r = retarget(c, ['--bends', 'clamp']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const mot = motionOf(c.out).animations.dance!.tracks;
    const headTrans = mot.find((t) => 'bone' in t && t.bone === 'head' && t.property === 'translate')!.keys.map((k) => (k.v as number[])[1]!);
    const headRot = mot.find((t) => 'bone' in t && t.bone === 'head' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
    const pitchRot = mot.find((t) => 'bone' in t && t.bone === 'pitch_dial' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);

    // Bar 1 (#205): pitch_dial.rotate and head.rotate match 2.8 * clampedY and 1.6 * clampedY within ≤ 0.5° on every frame, and are 0 wherever clampedY is 0.
    expect(headTrans[0]).toBe(0);
    for (let i = 0; i < N; i++) {
      if (headTrans[i] === 0) {
        expect(pitchRot[i]).toBe(0);
        expect(headRot[i]).toBe(0);
      }
    }
    let maxErrPitch = 0;
    let maxErrHead = 0;
    for (let i = 0; i < N; i++) {
      maxErrPitch = Math.max(maxErrPitch, Math.abs(pitchRot[i]! - 2.8 * headTrans[i]!));
      maxErrHead = Math.max(maxErrHead, Math.abs(headRot[i]! - 1.6 * headTrans[i]!));
    }
    expect(maxErrPitch).toBeLessThanOrEqual(0.5);
    expect(maxErrHead).toBeLessThanOrEqual(0.5);
    const maxPitch = Math.max(...pitchRot.slice(12).map((v) => Math.abs(v)));
    const maxHeadRot = Math.max(...headRot.slice(12).map((v) => Math.abs(v)));
    expect(maxPitch).toBeGreaterThan(2.5);
    expect(maxPitch).toBeLessThanOrEqual(3.0);
    expect(maxHeadRot).toBeGreaterThan(1.4);
    expect(maxHeadRot).toBeLessThanOrEqual(1.8);
    for (let i = 12; i < N; i++) {
      if (Math.abs(pitchRot[i]!) > 0.5) {
        expect(Math.sign(pitchRot[i]!)).toBe(Math.sign(headRot[i]!));
        expect(Math.sign(pitchRot[i]!)).toBe(Math.sign(headTrans[i]!));
      }
    }

    // Bar 3 (#190 / #205): DFT peak frequency of pitch_dial matches the reference vertical head travel within 1 bin and in phase.
    const dftPeak = (sig: readonly number[]) => {
      const m0 = sig.reduce((a, b) => a + b, 0) / sig.length;
      const x = sig.map((v) => v - m0);
      let bestBin = 1;
      let bestMag = -1;
      let bestPhase = 0;
      for (let k = 1; k <= Math.floor(sig.length / 2); k++) {
        let re = 0;
        let im = 0;
        for (let n = 0; n < sig.length; n++) {
          const ang = (-2 * Math.PI * k * n) / sig.length;
          re += x[n]! * Math.cos(ang);
          im += x[n]! * Math.sin(ang);
        }
        const mag = (2 * Math.hypot(re, im)) / sig.length;
        if (mag > bestMag) {
          bestMag = mag;
          bestBin = k;
          bestPhase = Math.atan2(im, re) * DEG;
        }
      }
      return { bin: bestBin, mag: bestMag, phase: bestPhase };
    };
    const refPeak = dftPeak(Array.from({ length: N }, (_, i) => beatNodSignal(i)));
    const pitchPeak = dftPeak(pitchRot);
    expect(Math.abs(pitchPeak.bin - refPeak.bin)).toBeLessThanOrEqual(1);
    expect(pitchPeak.bin).toBe(2);
    expect(Math.abs(wrap(pitchPeak.phase - refPeak.phase))).toBeLessThan(15);

    // Mutant A: lower-body tracks are byte-identical, and disabling the coupling flattens pitch_dial and head.rotate to 0°.
    // Mutant B (#205 Bar 4): putting `headNodReading.residual` back in instead of `headNodReading.clampedY` fails Bar 1 (max |Δ| > 15° > 0.5°).
    mkdirSync(MUTANTS, { recursive: true });
    const dZero = mkdtempSync(join(MUTANTS, 'm190-zero-'));
    const dRes = mkdtempSync(join(MUTANTS, 'm205-res-'));
    try {
      cpSync(join(ROOT, 'src'), join(dZero, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(dZero, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(dZero, 'package.json'));
      const pathZero = join(dZero, 'src', 'retarget.ts');
      const fromPitch = 'export const NOD_RESIDUAL_PITCH_GAIN = 2.8;';
      const fromHead = 'export const NOD_RESIDUAL_HEAD_GAIN = 1.6;';
      const before = readFileSync(pathZero, 'utf8');
      expect(before.split(fromPitch)).toHaveLength(2);
      expect(before.split(fromHead)).toHaveLength(2);
      writeFileSync(
        pathZero,
        before
          .replace(fromPitch, 'export const NOD_RESIDUAL_PITCH_GAIN = 0;')
          .replace(fromHead, 'export const NOD_RESIDUAL_HEAD_GAIN = 0;'),
      );

      const cMut = setup({ rig: { bones: headRig }, map: mapSpec, pose });
      const rMut = retarget(cMut, ['--bends', 'clamp'], join(dZero, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const motMut = motionOf(cMut.out).animations.dance!.tracks;
      for (const lb of ['hip', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
        expect(mot.filter((t) => 'bone' in t && t.bone === lb)).toEqual(motMut.filter((t) => 'bone' in t && t.bone === lb));
      }
      const mutPitch = motMut.find((t) => 'bone' in t && t.bone === 'pitch_dial' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
      const mutHeadRot = motMut.find((t) => 'bone' in t && t.bone === 'head' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
      expect(Math.max(...mutPitch.map((v) => Math.abs(v)))).toBe(0);
      expect(Math.max(...mutHeadRot.map((v) => Math.abs(v)))).toBe(0);

      cpSync(join(ROOT, 'src'), join(dRes, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(dRes, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(dRes, 'package.json'));
      const pathRes = join(dRes, 'src', 'retarget.ts');
      const fromClamped = 'const nodCoupled = headNodReading !== null && headNodReading.residual.some((r) => r !== 0) ? headNodReading.clampedY : null;';
      expect(before.split(fromClamped)).toHaveLength(2);
      writeFileSync(
        pathRes,
        before.replace(
          fromClamped,
          'const nodCoupled = headNodReading !== null && headNodReading.residual.some((r) => r !== 0) ? headNodReading.residual : null;',
        ),
      );
      const cRes = setup({ rig: { bones: headRig }, map: mapSpec, pose });
      const rRes = retarget(cRes, ['--bends', 'clamp'], join(dRes, 'cli.ts'));
      expect(rRes.status).toBe(0);
      const motRes = motionOf(cRes.out).animations.dance!.tracks;
      const resPitch = motRes.find((t) => 'bone' in t && t.bone === 'pitch_dial' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
      const resHead = motRes.find((t) => 'bone' in t && t.bone === 'head' && t.property === 'rotate')!.keys.map((k) => (k.v as number[])[0]!);
      const resErrPitch = Math.max(...resPitch.map((v, i) => Math.abs(v - 2.8 * headTrans[i]!)));
      const resErrHead = Math.max(...resHead.map((v, i) => Math.abs(v - 1.6 * headTrans[i]!)));
      expect(resErrPitch).toBeGreaterThan(15);
      expect(resErrHead).toBeGreaterThan(10);
    } finally {
      rmSync(dZero, { recursive: true, force: true });
      rmSync(dRes, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#191: head-anchored end-effector two-link IK inside art turn range', () => {
  const N = 16;
  const DT = 1 / 24;
  const rigOpts: RigOpts = {
    bones: (b) => [
      ...b,
      { name: 'head', parent: 'neck', x: 0, y: 20 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    ],
    extra: {
      sleeve_l0: { k4_l0: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
      sleeve_l1: { k4_l1: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
    },
  };

  test('MAP_ALT_ANCHOR and ANCHOR_HEAD refuse malformed declarations by name', () => {
    const m: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], lu: () => -35, lf: () => 90 };
    const kp = positions(m, 0);
    const makeMap = (altPatch: Record<string, unknown>, includeHeadChain = true): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        ...(includeHeadChain ? [{ name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] }] : []),
      ],
      alternates: [
        {
          name: 'K4_hand_up',
          slots: { sleeve_l0: 'k4_l0', sleeve_l1: 'k4_l1' },
          chains: ['arm_l'],
          pose: {
            r_eye: kp.r_eye!,
            l_eye: kp.l_eye!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_l0: -35, sleeve_l1: 90 },
          turn: { sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          ...altPatch,
        },
      ],
    });
    const pose = poseDoc(m);

    const rBadChain = retarget(setup({ rig: rigOpts, map: makeMap({ anchor: 'leg_l' }), pose }));
    expect(rBadChain.status).toBe(1);
    expect(rBadChain.stderr).toContain('MAP_ALT_ANCHOR');

    const rMissingDrawn = retarget(
      setup({
        rig: rigOpts,
        map: makeMap({ anchor: 'arm_l', drawn: { sleeve_l0: -35 } }),
        pose,
      }),
    );
    expect(rMissingDrawn.status).toBe(1);
    expect(rMissingDrawn.stderr).toContain('MAP_ALT_ANCHOR');

    const rConflictSup = retarget(
      setup({
        rig: rigOpts,
        map: makeMap({ anchor: 'arm_l', support: 'arm_l' }),
        pose,
      }),
    );
    expect(rConflictSup.status).toBe(1);
    expect(rConflictSup.stderr).toContain('MAP_ALT_ANCHOR');

    const rNoHead = retarget(setup({ rig: rigOpts, map: makeMap({ anchor: 'arm_l' }, false), pose }));
    expect(rNoHead.status).toBe(1);
    expect(rNoHead.stderr).toContain('ANCHOR_HEAD');
  });

  test('#191 head-local IK + mutants: holds hand-tip-to-head local offset at 0.00u on unclamped frames, reports saturated frames with residual, keeps all non-anchored tracks byte-identical, and distinguishes head-local from world-fixed and off', () => {
    // Drawn pose: trunk=90°, head=0°, lu=-35°, lf=90°.
    // Sequence:
    // - frames 0..11: trunk leans up to +6° and head rolls +10° while 2D wrist drifts away by +15° on lu/lf (reachable within ±20° turn -> 0.00u head-local residual).
    // - frames 12..15: trunk leans -18° and head rolls -22°, forcing sleeve_l0/l1 against the ±20° turn clamp -> reported in `saturated`.
    const mKey: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], lu: () => -35, lf: () => 90 };
    const kp = positions(mKey, 0);
    const mSeq: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      hip: () => [0, 0],
      trunk: (i) => (i < 12 ? 90 + 6 * Math.sin((i / 11) * Math.PI) : 72),
      lu: () => -22,
      lf: () => 104,
    };
    const pose = poseDoc(mSeq, (i, j) => {
      const headDeg = i < 12 ? 10 * Math.sin((i / 11) * Math.PI) : -22;
      const rad = (headDeg * Math.PI) / 180;
      const rE = j.r_eye!.at as Pt;
      const lE = j.l_eye!.at as Pt;
      const cx = 0.5 * (rE[0] + lE[0]);
      const cy = 0.5 * (rE[1] + lE[1]);
      const half = 0.5 * Math.hypot(lE[0] - rE[0], lE[1] - rE[1]);
      j.r_eye = { state: 'observed', at: [cx - half * Math.cos(rad), cy + half * Math.sin(rad)], score: 0.95 };
      j.l_eye = { state: 'observed', at: [cx + half * Math.cos(rad), cy - half * Math.sin(rad)], score: 0.95 };
    });
    const makeMap = (withAnchor: boolean): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K4_hand_up',
          slots: { sleeve_l0: 'k4_l0', sleeve_l1: 'k4_l1' },
          chains: ['arm_l'],
          pose: {
            r_eye: kp.r_eye!,
            l_eye: kp.l_eye!,
            l_shoulder: kp.l_shoulder!,
            l_elbow: kp.l_elbow!,
            l_wrist: kp.l_wrist!,
          },
          drawn: { sleeve_l0: -35, sleeve_l1: 90 },
          turn: { sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          ...(withAnchor ? { anchor: 'arm_l' } : {}),
        },
      ],
    });

    const cAnc = setup({ rig: rigOpts, map: makeMap(true), pose });
    const repFile = join(cAnc.dir, 'report.json');
    const rAnc = retarget(cAnc, ['--raised-by-head', '--report', repFile]);
    expect(rAnc.stderr).toBe('');
    expect(rAnc.status).toBe(0);
    expect(rAnc.stdout).toContain('residual f12');

    const rep = JSON.parse(readFileSync(repFile, 'utf8')) as {
      raised: Array<{ saturated?: Array<{ frame: number; residual: number }> }>;
    };
    const satFrames = new Set((rep.raised[0]?.saturated ?? []).map((s) => s.frame));
    expect(satFrames.has(12)).toBe(true);
    for (let i = 0; i < 12; i++) expect(satFrames.has(i)).toBe(false);

    // Measure posed hand-tip-to-head offset in head-local and world frames.
    const buildAnc = loadBuild(cAnc.build);
    const setupPose = byName(poseRawAnimation(buildAnc, 'dance', [0], {}, 'setup')[0]!.bones);
    const s0 = setupPose.get('sleeve_l0')!;
    const h0 = setupPose.get('head')!;
    const l0 = 70;
    const l1 = 60;
    const wDrawn: Pt = [
      s0.worldX + l0 * Math.cos((-35 * Math.PI) / 180) + l1 * Math.cos((90 * Math.PI) / 180),
      s0.worldY + l0 * Math.sin((-35 * Math.PI) / 180) + l1 * Math.sin((90 * Math.PI) / 180),
    ];
    const dDrawnWorld: Pt = [wDrawn[0] - h0.worldX, wDrawn[1] - h0.worldY];

    const measureOffsets = (buildDir: string) => {
      const poses = poseRawAnimation(loadBuild(buildDir), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      const localErrs: number[] = [];
      const worldErrs: number[] = [];
      for (let i = 0; i < N; i++) {
        const b = byName(poses[i]!.bones);
        const sl0 = b.get('sleeve_l0')!;
        const sl1 = b.get('sleeve_l1')!;
        const hd = b.get('head')!;
        const a0 = Math.atan2(sl0.c, sl0.a) * DEG;
        const a1 = Math.atan2(sl1.c, sl1.a) * DEG;
        expect(Math.abs(wrap(a0 - -35))).toBeLessThanOrEqual(20.005);
        expect(Math.abs(wrap(a1 - 90))).toBeLessThanOrEqual(20.005);
        const w: Pt = [sl1.worldX + sl1.a * l1, sl1.worldY + sl1.c * l1];
        const dw: Pt = [w[0] - hd.worldX, w[1] - hd.worldY];
        worldErrs.push(Math.hypot(dw[0] - dDrawnWorld[0], dw[1] - dDrawnWorld[1]));
        const hRot = Math.atan2(hd.c, hd.a) - Math.atan2(h0.c, h0.a);
        const c = Math.cos(-hRot);
        const s = Math.sin(-hRot);
        const dLocal: Pt = [dw[0] * c - dw[1] * s, dw[0] * s + dw[1] * c];
        localErrs.push(Math.hypot(dLocal[0] - dDrawnWorld[0], dLocal[1] - dDrawnWorld[1]));
      }
      return { localErrs, worldErrs };
    };

    const mAnc = measureOffsets(cAnc.build);
    for (let i = 0; i < 12; i++) {
      expect(mAnc.localErrs[i]!).toBeLessThanOrEqual(0.05);
    }

    // Mutants: HEAD_ANCHOR_FRAME = 'off' and 'world-fixed'.
    mkdirSync(MUTANTS, { recursive: true });
    const dOff = mkdtempSync(join(MUTANTS, 'm191-off-'));
    const dWorld = mkdtempSync(join(MUTANTS, 'm191-world-'));
    try {
      for (const [d, mode] of [
        [dOff, 'off'],
        [dWorld, 'world-fixed'],
      ] as const) {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'retarget.ts');
        const from = "export const HEAD_ANCHOR_FRAME: 'head-local' | 'world-fixed' | 'off' = 'head-local';";
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, `export const HEAD_ANCHOR_FRAME: 'head-local' | 'world-fixed' | 'off' = '${mode}';`));
      }

      const cOff = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rOff = retarget(cOff, ['--raised-by-head'], join(dOff, 'cli.ts'));
      expect(rOff.status).toBe(0);
      const mOff = measureOffsets(cOff.build);
      expect(Math.max(...mOff.localErrs.slice(0, 12))).toBeGreaterThan(12);

      // Bar 3: every track other than sleeve_l0.rotate and sleeve_l1.rotate is byte-identical.
      const motAnc = motionOf(cAnc.out).animations.dance!.tracks;
      const motOff = motionOf(cOff.out).animations.dance!.tracks;
      const nonArm = (ts: typeof motAnc) =>
        ts.filter((t) => !('bone' in t && (t.bone === 'sleeve_l0' || t.bone === 'sleeve_l1') && t.property === 'rotate'));
      expect(nonArm(motAnc)).toEqual(nonArm(motOff));

      const cWorld = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rWorld = retarget(cWorld, ['--raised-by-head'], join(dWorld, 'cli.ts'));
      expect(rWorld.status).toBe(0);
      const mWorld = measureOffsets(cWorld.build);
      // On frame 5 (head rolled +10°), world-fixed holds worldErr ~ 0 while head-local drift exceeds 5u.
      expect(mWorld.worldErrs[5]!).toBeLessThanOrEqual(0.05);
      expect(mWorld.localErrs[5]!).toBeGreaterThan(5);
    } finally {
      rmSync(dOff, { recursive: true, force: true });
      rmSync(dWorld, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#206: gesture-set bridges interpolate in joint space, apply set.support only from loShow, and include extended holds in covered', () => {
  test('joint-space bridge, loShow support start, and extended hold coverage + 3 mutants', () => {
    const N = 36;
    const DT = 1 / 24;
    const att = { image: 'seg.png', x: 30, y: 0, rotation: -90 };
    const rigOpts: RigOpts = {
      bones: (b) => [
        ...b.map((x) => (x.name === 'sleeve_r1' || x.name === 'sleeve_l1' ? { ...x, rotation: 0 } : x)),
        { name: 'head', parent: 'neck', x: 0, y: 20 },
        { name: 'eye_r', parent: 'head', x: -6, y: 10 },
        { name: 'eye_l', parent: 'head', x: 6, y: 10 },
      ],
      extra: {
        sleeve_r0: { k1_r0: att, k2_r0: att, k3_r0: att },
        sleeve_r1: { k1_r1: att, k2_r1: att, k3_r1: att },
        sleeve_l0: { k1_l0: att, k2_l0: att, k3_l0: att },
        sleeve_l1: { k1_l1: att, k2_l1: att, k3_l1: att },
      },
    };
    // Key poses:
    // K1_sym (symmetric raised, frames 0..7): ru=120, rf=25 (local -95), lu=60, lf=155 (local +95)
    // K2_hips (hands on hips, frames 12..18, 32..35): ru=-70, rf=-30 (local +40), lu=-110, lf=-150 (local -40)
    // K3_sup (raised right + support left, frames 22..28): ru=95, rf=85 (local -10), lu=-85, lf=-165 (local -80)
    const kp1 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 120, rf: () => 25, lu: () => 60, lf: () => 155 }, 0);
    const kp2 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => -70, rf: () => -30, lu: () => -110, lf: () => -150 }, 0);
    const kp3 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 95, rf: () => 85, lu: () => -85, lf: () => -165 }, 0);

    const mSeq: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      hip: () => [0, 0],
      trunk: () => 90,
      ru: (i) => {
        if (i <= 7) return 120;
        if (i === 8) return 90;
        if (i === 9) return 80;
        if (i === 10) return 50;
        if (i === 11) return -55;
        if (i <= 18) return -70;
        if (i === 19) return -40;
        if (i === 20) return -25;
        if (i === 21) return 45;
        if (i <= 28) return 95;
        if (i === 29) return -20;
        if (i === 30) return -35;
        if (i === 31) return -50;
        return -70;
      },
      rf: (i) => {
        if (i <= 7) return 25;
        if (i === 8) return 35;
        if (i === 9) return 35;
        if (i === 10) return 35;
        if (i === 11) return -20;
        if (i <= 18) return -30;
        if (i === 19) return -20;
        if (i === 20) return 0;
        if (i === 21) return 45;
        if (i <= 28) return 85;
        if (i === 29) return -5;
        if (i === 30) return -10;
        if (i === 31) return -20;
        return -30;
      },
      lu: (i) => {
        if (i <= 7) return 60;
        if (i === 8) return 45;
        if (i === 9) return 40;
        if (i === 10) return 10;
        if (i === 11) return -85;
        if (i <= 18) return -110;
        if (i === 19) return -106;
        if (i === 20) return -102;
        if (i === 21) return -92;
        if (i <= 28) return -85;
        if (i === 29) return -105;
        if (i === 30) return -108;
        return -110;
      },
      lf: (i) => {
        if (i <= 7) return 155;
        if (i === 8) return 145;
        if (i === 9) return 145;
        if (i === 10) return 145;
        if (i === 11) return -135;
        if (i <= 18) return -150;
        if (i === 19) return -152;
        if (i === 20) return -155;
        if (i === 21) return -160;
        if (i <= 28) return -165;
        if (i <= 31) return -110; // 40° from K2_hips.drawn (-150°), so only syncBridgeClamp puts extended hold 29..31 into cClamp/covered
        return -150;
      },
    };
    const pose = poseDoc(mSeq);
    const mapDoc: Record<string, unknown> = {
      ...baseMap(),
      chains: [
        ...baseChains().map((c) =>
          c.name === 'arm_r'
            ? { ...c, bend: 'free', range: { sleeve_r0: [-130, 50], sleeve_r1: [-175, 50] } }
            : c.name === 'arm_l'
              ? { ...c, bend: 'free', range: { sleeve_l0: [-50, 130], sleeve_l1: [-50, 175] } }
              : c,
        ),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K1_sym',
          slots: { back_r0: 'k1_r0', back_r1: 'k1_r1', back_l0: 'k1_l0', back_l1: 'k1_l1', topwear: 'top_k1' },
          hides: ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp1.r_shoulder!,
            r_elbow: kp1.r_elbow!,
            r_wrist: kp1.r_wrist!,
            l_shoulder: kp1.l_shoulder!,
            l_elbow: kp1.l_elbow!,
            l_wrist: kp1.l_wrist!,
          },
          drawn: { sleeve_r0: 120, sleeve_r1: 25, sleeve_l0: 60, sleeve_l1: 155 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          symmetric: true,
        },
        {
          name: 'K2_hips',
          slots: { sleeve_r0: 'k2_r0', sleeve_r1: 'k2_r1', sleeve_l0: 'k2_l0', sleeve_l1: 'k2_l1', topwear: 'top_k2' },
          hides: ['back_r0', 'back_r1', 'back_l0', 'back_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp2.r_shoulder!,
            r_elbow: kp2.r_elbow!,
            r_wrist: kp2.r_wrist!,
            l_shoulder: kp2.l_shoulder!,
            l_elbow: kp2.l_elbow!,
            l_wrist: kp2.l_wrist!,
          },
          drawn: { sleeve_r0: -70, sleeve_r1: -30, sleeve_l0: -110, sleeve_l1: -150 },
          turn: { sleeve_r0: [-5, 5], sleeve_r1: [-5, 5], sleeve_l0: [-5, 5], sleeve_l1: [-5, 5] },
        },
        {
          name: 'K3_sup',
          slots: { back_r0: 'k3_r0', back_r1: 'k3_r1', back_l0: 'k3_l0', back_l1: 'k3_l1', topwear: 'top_k3' },
          hides: ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp3.r_shoulder!,
            r_elbow: kp3.r_elbow!,
            r_wrist: kp3.r_wrist!,
            l_shoulder: kp3.l_shoulder!,
            l_elbow: kp3.l_elbow!,
            l_wrist: kp3.l_wrist!,
          },
          drawn: { sleeve_r0: 95, sleeve_r1: 85, sleeve_l0: -85, sleeve_l1: -165 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-15, 15], sleeve_l1: [-15, 15] },
          support: 'arm_l',
        },
      ],
    };

    const makeCase = () => {
      const cs = setup({ rig: rigOpts, map: mapDoc, pose });
      const rigJsonPath = join(cs.rig, 'rig.json');
      const rigSpec = JSON.parse(readFileSync(rigJsonPath, 'utf8')) as {
        slots: Array<Record<string, unknown>>;
        skins: { default: Record<string, Record<string, unknown>> };
      };
      rigSpec.slots = [
        { name: 'back_r0', bone: 'sleeve_r0', attachment: null },
        { name: 'back_r1', bone: 'sleeve_r1', attachment: null },
        { name: 'back_l0', bone: 'sleeve_l0', attachment: null },
        { name: 'back_l1', bone: 'sleeve_l1', attachment: null },
        { name: 'topwear', bone: 'chest', attachment: 'seg' },
        ...rigSpec.slots,
      ];
      rigSpec.skins.default.back_r0 = { k1_r0: att, k3_r0: att };
      rigSpec.skins.default.back_r1 = { k1_r1: att, k3_r1: att };
      rigSpec.skins.default.back_l0 = { k1_l0: att, k3_l0: att };
      rigSpec.skins.default.back_l1 = { k1_l1: att, k3_l1: att };
      rigSpec.skins.default.topwear = { seg: att, top_k1: att, top_k2: att, top_k3: att };
      writeFileSync(rigJsonPath, JSON.stringify(rigSpec, null, 2));
      return cs;
    };

    const c = makeCase();
    const r = retarget(c, ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const tracks = motionOf(c.out).animations.dance!.tracks;
    const rotOf = (bone: string, f: number): number =>
      wrap((tracks.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);

    // 1. Across K1 -> K2 bridge (frames 8..11), forearms never invert through ±180° (|rot| stays <= 146°).
    for (let f = 8; f <= 11; f++) {
      expect(Math.abs(rotOf('sleeve_r1', f))).toBeLessThanOrEqual(146);
      expect(Math.abs(rotOf('sleeve_l1', f))).toBeLessThanOrEqual(146);
    }

    // 2. On frame 19 (first gap frame after K2 [12..18], while K2 is still shown before K3 switches at 21),
    //    support arm sleeve_l1 bridges smoothly instead of snapping early to K3's -80° support pose.
    expect(Math.abs(wrap(rotOf('sleeve_l1', 19) - rotOf('sleeve_l1', 18)))).toBeLessThanOrEqual(20);

    // 3. On frame 29..31 (gap between K3 [22..28] and K2 [32..35]), extended hold covers the tight K2_hips frames.
    expect(Math.abs(wrap(rotOf('sleeve_l1', 30) - rotOf('sleeve_l1', 32)))).toBeLessThanOrEqual(20);

    // Mutants 1, 2, 3:
    mkdirSync(MUTANTS, { recursive: true });
    const dM1 = mkdtempSync(join(MUTANTS, 'm206-1-'));
    const dM2 = mkdtempSync(join(MUTANTS, 'm206-2-'));
    const dM3 = mkdtempSync(join(MUTANTS, 'm206-3-'));
    try {
      for (const d of [dM1, dM2, dM3]) {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      }

      // Mutant 1: world-angle bridge interpolation in switch.ts / retarget.ts flips forearm past 160° on frames 8..11.
      {
        const pSw = join(dM1, 'src', 'switch.ts');
        const swSrc = readFileSync(pSw, 'utf8');
        const swFrom = 'const parentTg = parentBone !== undefined ? targets.get(parentBone) : undefined;';
        expect(swSrc.split(swFrom)).toHaveLength(2);
        writeFileSync(pSw, swSrc.replace(swFrom, 'const parentTg = undefined;'));
        const pRet = join(dM1, 'src', 'retarget.ts');
        const src = readFileSync(pRet, 'utf8');
        const from1 = 'const parentTg = bIdx > 0 ? targets.get(ch.bones[bIdx - 1]!) : undefined;';
        const from2 = 'targets.get(bR1)![i] = wrap(inR1 + 0.45 * wrap(aR0 - drawnR0));\n            targets.get(bL1)![i] = wrap(inL1 + 0.45 * wrap(aL0 - drawnL0));';
        const from3 = 'if (set.anchor === undefined && set.symmetric !== true && set.support === undefined && loShow < s.frames[0]) {';
        expect(src.split(from1)).toHaveLength(2);
        expect(src.split(from2)).toHaveLength(2);
        expect(src.split(from3)).toHaveLength(2);
        writeFileSync(pRet, src.replace(from1, 'const parentTg = undefined;').replace(from2, '').replace(from3, 'if (false) {'));
        const cM1 = makeCase();
        const rM1 = retarget(cM1, ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1'], join(dM1, 'cli.ts'));
        expect(rM1.status).toBe(0);
        const trM1 = motionOf(cM1.out).animations.dance!.tracks;
        const rotM1 = (bone: string, f: number): number =>
          wrap((trM1.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);
        const maxElbowM1 = Math.max(...[8, 9, 10, 11].flatMap((f) => [Math.abs(rotM1('sleeve_r1', f)), Math.abs(rotM1('sleeve_l1', f))]));
        expect(maxElbowM1).toBeGreaterThan(155);
      }

      // Mutant 2: set.support applied from Math.min(loGap, loShow) without bridging loGap..loShow-1, snapping frame 19 to K3's -80° support pose while K2 is still shown.
      {
        const pRet = join(dM2, 'src', 'retarget.ts');
        const src = readFileSync(pRet, 'utf8');
        const from = 'for (let i = loShow; i <= hiShow; i++) solveSupportChainFrame(set, c, i);\n          if (loGap < loShow && loGap >= 1) {';
        expect(src.split(from)).toHaveLength(2);
        writeFileSync(
          pRet,
          src.replace(
            from,
            'for (let i = Math.min(loGap, loShow); i <= hiShow; i++) solveSupportChainFrame(set, c, i);\n          if (false && loGap < loShow && loGap >= 1) {',
          ),
        );
        const cM2 = makeCase();
        const rM2 = retarget(cM2, ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1'], join(dM2, 'cli.ts'));
        expect(rM2.status).toBe(0);
        const trM2 = motionOf(cM2.out).animations.dance!.tracks;
        const rotM2 = (bone: string, f: number): number =>
          wrap((trM2.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);
        expect(Math.abs(wrap(rotM2('sleeve_l1', 19) - rotOf('sleeve_l1', 18)))).toBeGreaterThan(30);
      }

      // Mutant 3: syncBridgeClamp omitted in switch.ts and extended-hold forearm alignment omitted in retarget.ts so extended hold on frame 29..31 is not in cClamp/covered.
      {
        const pSw = join(dM3, 'src', 'switch.ts');
        const src = readFileSync(pSw, 'utf8');
        const from = 'if (isTightSet(picked, cn)) cClamp.get(cn)![i] = picked;';
        expect(src.split(from)).toHaveLength(2);
        writeFileSync(pSw, src.replace(from, ''));
        const pRet = join(dM3, 'src', 'retarget.ts');
        const retSrc = readFileSync(pRet, 'utf8');
        const retFrom = 'if (set.anchor === undefined && set.symmetric !== true && set.support === undefined && loShow < s.frames[0]) {';
        expect(retSrc.split(retFrom)).toHaveLength(2);
        writeFileSync(pRet, retSrc.replace(retFrom, 'if (false) {'));
        const cM3 = makeCase();
        const rM3 = retarget(cM3, ['--bends', 'clamp', '--short', '0.35', '--raised-by-head', '--switch-min', '0.1'], join(dM3, 'cli.ts'));
        expect(rM3.status).toBe(0);
        const trM3 = motionOf(cM3.out).animations.dance!.tracks;
        const rotM3 = (bone: string, f: number): number =>
          wrap((trM3.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);
        const maxJumpM3 = Math.max(
          Math.abs(wrap(rotM3('sleeve_l1', 29) - rotOf('sleeve_l1', 29))),
          Math.abs(wrap(rotM3('sleeve_l1', 30) - rotOf('sleeve_l1', 30))),
        );
        expect(maxJumpM3).toBeGreaterThan(30);
      }
    } finally {
      rmSync(dM1, { recursive: true, force: true });
      rmSync(dM2, { recursive: true, force: true });
      rmSync(dM3, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#207: symmetric gesture set solves the diamond in the chest-local frame so torso lean never collapses an arm into the ±20° clamp', () => {
  const N = 24;
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
      sleeve_r0: { k1_r: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
      sleeve_l0: { k1_l: { image: 'seg.png', x: 30, y: 0, rotation: -90 } },
    },
  };

  test('#207 chest-local diamond + mutant: under a 12° torso lean, a "symmetric": true set has 0 clamp saturations at ±20° and keeps non-arm tracks byte-identical, while the world-Y mutant saturates the clamp', () => {
    const mKey: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 145, rf: () => 45, lu: () => 41, lf: () => 135 };
    const kp = positions(mKey, 0);
    // Torso leans up to 12° away from 90° while arms stay raised behind the head.
    const mSeq: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: (i) => 90 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
      hip: () => [0, 0],
      ru: (i) => 145 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
      rf: (i) => 45 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
      lu: (i) => 41 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
      lf: (i) => 135 + 12 * Math.sin((2 * Math.PI * i) / (N - 1)),
    };
    const pose = poseDoc(mSeq);
    const drawn = { sleeve_r0: 145, sleeve_r1: 45, sleeve_l0: 41, sleeve_l1: 135 };
    const makeMap = (symmetric: boolean): Record<string, unknown> => ({
      ...baseMap(),
      chains: [
        ...baseChains().map((c) => (c.name === 'arm_r' || c.name === 'arm_l' ? { ...c, bend: 'free' } : c)),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K1_lean',
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
          drawn,
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          ...(symmetric ? { symmetric: true } : {}),
        },
      ],
    });

    const c = setup({ rig: rigOpts, map: makeMap(true), pose });
    const r = retarget(c, ['--raised-by-head', '--bends', 'clamp']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const cBase = setup({ rig: rigOpts, map: makeMap(false), pose });
    const rBase = retarget(cBase, ['--raised-by-head', '--bends', 'clamp']);
    expect(rBase.status).toBe(0);

    // Non-arm tracks are byte-identical.
    const motSym = motionOf(c.out).animations.dance!.tracks;
    const motBase = motionOf(cBase.out).animations.dance!.tracks;
    for (const lb of ['hip', 'chest', 'head', 'leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
      expect(motSym.filter((t) => 'bone' in t && t.bone === lb)).toEqual(motBase.filter((t) => 'bone' in t && t.bone === lb));
    }

    const countSaturations = (buildDir: string): number => {
      const poses = poseRawAnimation(loadBuild(buildDir), 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
      let sat = 0;
      for (const p of poses) {
        const b = byName(p.bones);
        for (const bone of ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'] as const) {
          const bn = b.get(bone)!;
          // Bone world rotation + aim offset (0° in stickBones since each arm bone points along +x of its own frame).
          const wRot = Math.atan2(bn.c, bn.a) * DEG;
          const turn = Math.abs(wrap(wRot - drawn[bone]));
          if (turn >= 20 - 1e-3) sat++;
        }
      }
      return sat;
    };
    expect(countSaturations(c.build)).toBe(0);

    // Mutant: solving on world shoulder Y (sr[1], sl[1]) without chest-local diamond alignment saturates the ±20° clamp under torso lean.
    mkdirSync(MUTANTS, { recursive: true });
    const dM = mkdtempSync(join(MUTANTS, 'm207-lean-'));
    try {
      cpSync(join(ROOT, 'src'), join(dM, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(dM, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(dM, 'package.json'));
      const pRet = join(dM, 'src', 'retarget.ts');
      const src = readFileSync(pRet, 'utf8');
      const from1 = 'if (Math.abs(wrap(drawnR0 + drawnL0 - 180)) > 1 && (hc0[0] - erDrawnX > lR1 || elDrawnX - hc0[0] > lL1)) {';
      const from2 = 'const eyr = SR0[1] + lR0 * Math.sin((ar + dR0) / DEG);\n        const eyl = SL0[1] + lL0 * Math.sin((al + dL0) / DEG);';
      const from3 = 'const carry = 0.35 * chestTurn;';
      expect(src.split(from1)).toHaveLength(2);
      expect(src.split(from2)).toHaveLength(2);
      expect(src.split(from3)).toHaveLength(2);
      writeFileSync(
        pRet,
        src
          .replace(from1, 'if (false) {')
          .replace(from2, 'const eyr = sr[1] + lR0 * Math.sin((ar + dR0) / DEG);\n        const eyl = sl[1] + lL0 * Math.sin((al + dL0) / DEG);')
          .replace(from3, 'const carry = 0;'),
      );
      const cM = setup({ rig: rigOpts, map: makeMap(true), pose });
      const rM = retarget(cM, ['--raised-by-head', '--bends', 'clamp'], join(dM, 'cli.ts'));
      expect(rM.status).toBe(0);
      expect(countSaturations(cM.build)).toBeGreaterThan(0);
    } finally {
      rmSync(dM, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#218: adjacent gesture-set bridges interpolate across the full gap in joint space, inner-reach wrist steps preserve upper-arm clamp sign, and short stance spans before flight arch-blend hip y', () => {
  const N = 36;
  const DT = 1 / 24;
  const att = { image: 'seg.png', x: 30, y: 0, rotation: -90 };
  const rigOpts: RigOpts = {
    bones: (b) => [
      ...b.map((x) => (x.name === 'sleeve_r1' || x.name === 'sleeve_l1' ? { ...x, rotation: 0 } : x)),
      { name: 'head', parent: 'neck', x: 0, y: 20 },
      { name: 'eye_r', parent: 'head', x: -6, y: 10 },
      { name: 'eye_l', parent: 'head', x: 6, y: 10 },
    ],
    extra: {
      sleeve_r0: { k1_r0: att, k2_r0: att, k3_r0: att },
      sleeve_r1: { k1_r1: att, k2_r1: att, k3_r1: att },
      sleeve_l0: { k1_l0: att, k2_l0: att, k3_l0: att },
      sleeve_l1: { k1_l1: att, k2_l1: att, k3_l1: att },
    },
  };

  test('#218 full-gap joint-space bridge + short-stance arch blend + mutants', () => {
    const kp1 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 120, rf: () => 25, lu: () => 60, lf: () => 155 }, 0);
    const kp2 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => -70, rf: () => -30, lu: () => -110, lf: () => -150 }, 0);
    const kp3 = positions({ ...BASE, n: 1, dt: DT, trunk: () => 90, hip: () => [0, 0], ru: () => 95, rf: () => 85, lu: () => -85, lf: () => -165 }, 0);

    const mSeq: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      hip: () => [0, 0],
      trunk: () => 90,
      ru: (i) => {
        if (i <= 7) return 120;
        if (i === 8) return 90;
        if (i === 9) return 80;
        if (i === 10) return 50;
        if (i === 11) return -55;
        if (i <= 18) return -70;
        if (i === 19) return -40;
        if (i === 20) return -25;
        if (i === 21) return 45;
        if (i <= 28) return 95;
        if (i === 29) return -20;
        if (i === 30) return -35;
        if (i === 31) return -50;
        return -70;
      },
      rf: (i) => {
        if (i <= 7) return 25;
        if (i === 8) return 35;
        if (i === 9) return 35;
        if (i === 10) return 35;
        if (i === 11) return -20;
        if (i <= 18) return -30;
        if (i === 19) return -20;
        if (i === 20) return 0;
        if (i === 21) return 45;
        if (i <= 28) return 85;
        if (i === 29) return -5;
        if (i === 30) return -10;
        if (i === 31) return -20;
        return -30;
      },
      lu: (i) => {
        if (i <= 7) return 60;
        if (i === 8) return 45;
        if (i === 9) return 40;
        if (i === 10) return 10;
        if (i === 11) return -85;
        if (i <= 18) return -110;
        if (i === 19) return -106;
        if (i === 20) return -102;
        if (i === 21) return -92;
        if (i <= 28) return -85;
        if (i === 29) return -105;
        if (i === 30) return -108;
        return -110;
      },
      lf: (i) => {
        if (i <= 7) return 155;
        if (i === 8) return 145;
        if (i === 9) return 145;
        if (i === 10) return 145;
        if (i === 11) return -135;
        if (i <= 18) return -150;
        if (i === 19) return -152;
        if (i === 20) return -155;
        if (i === 21) return -160;
        if (i <= 28) return -165;
        if (i <= 31) return -110;
        return -150;
      },
    };
    const pose = poseDoc(mSeq);
    const mapDoc: Record<string, unknown> = {
      ...baseMap(),
      chains: [
        ...baseChains().map((c) =>
          c.name === 'arm_r'
            ? { ...c, bend: 'free', range: { sleeve_r0: [-130, 50], sleeve_r1: [-175, 50] } }
            : c.name === 'arm_l'
              ? { ...c, bend: 'free', range: { sleeve_l0: [-50, 130], sleeve_l1: [-50, 175] } }
              : c,
        ),
        { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] },
      ],
      alternates: [
        {
          name: 'K1_sym',
          slots: { back_r0: 'k1_r0', back_r1: 'k1_r1', back_l0: 'k1_l0', back_l1: 'k1_l1', topwear: 'top_k1' },
          hides: ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp1.r_shoulder!,
            r_elbow: kp1.r_elbow!,
            r_wrist: kp1.r_wrist!,
            l_shoulder: kp1.l_shoulder!,
            l_elbow: kp1.l_elbow!,
            l_wrist: kp1.l_wrist!,
          },
          drawn: { sleeve_r0: 120, sleeve_r1: 25, sleeve_l0: 60, sleeve_l1: 155 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-20, 20], sleeve_l1: [-20, 20] },
          symmetric: true,
        },
        {
          name: 'K2_hips',
          slots: { sleeve_r0: 'k2_r0', sleeve_r1: 'k2_r1', sleeve_l0: 'k2_l0', sleeve_l1: 'k2_l1', topwear: 'top_k2' },
          hides: ['back_r0', 'back_r1', 'back_l0', 'back_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp2.r_shoulder!,
            r_elbow: kp2.r_elbow!,
            r_wrist: kp2.r_wrist!,
            l_shoulder: kp2.l_shoulder!,
            l_elbow: kp2.l_elbow!,
            l_wrist: kp2.l_wrist!,
          },
          drawn: { sleeve_r0: -70, sleeve_r1: -30, sleeve_l0: -110, sleeve_l1: -150 },
          turn: { sleeve_r0: [-5, 5], sleeve_r1: [-5, 5], sleeve_l0: [-5, 5], sleeve_l1: [-5, 5] },
        },
        {
          name: 'K3_sup',
          slots: { back_r0: 'k3_r0', back_r1: 'k3_r1', back_l0: 'k3_l0', back_l1: 'k3_l1', topwear: 'top_k3' },
          hides: ['sleeve_r0', 'sleeve_r1', 'sleeve_l0', 'sleeve_l1'],
          chains: ['arm_r', 'arm_l'],
          pose: {
            r_shoulder: kp3.r_shoulder!,
            r_elbow: kp3.r_elbow!,
            r_wrist: kp3.r_wrist!,
            l_shoulder: kp3.l_shoulder!,
            l_elbow: kp3.l_elbow!,
            l_wrist: kp3.l_wrist!,
          },
          drawn: { sleeve_r0: 95, sleeve_r1: 85, sleeve_l0: -85, sleeve_l1: -165 },
          turn: { sleeve_r0: [-20, 20], sleeve_r1: [-20, 20], sleeve_l0: [-15, 15], sleeve_l1: [-15, 15] },
          support: 'arm_l',
        },
      ],
    };

    const makeCase = () => {
      const cs = setup({ rig: rigOpts, map: mapDoc, pose });
      const rigJsonPath = join(cs.rig, 'rig.json');
      const rigSpec = JSON.parse(readFileSync(rigJsonPath, 'utf8')) as {
        slots: Array<Record<string, unknown>>;
        skins: { default: Record<string, Record<string, unknown>> };
      };
      rigSpec.slots = [
        { name: 'back_r0', bone: 'sleeve_r0', attachment: null },
        { name: 'back_r1', bone: 'sleeve_r1', attachment: null },
        { name: 'back_l0', bone: 'sleeve_l0', attachment: null },
        { name: 'back_l1', bone: 'sleeve_l1', attachment: null },
        { name: 'topwear', bone: 'chest', attachment: 'seg' },
        ...rigSpec.slots,
      ];
      rigSpec.skins.default.back_r0 = { k1_r0: att, k3_r0: att };
      rigSpec.skins.default.back_r1 = { k1_r1: att, k3_r1: att };
      rigSpec.skins.default.back_l0 = { k1_l0: att, k3_l0: att };
      rigSpec.skins.default.back_l1 = { k1_l1: att, k3_l1: att };
      rigSpec.skins.default.topwear = { seg: att, top_k1: att, top_k2: att, top_k3: att };
      writeFileSync(rigJsonPath, JSON.stringify(rigSpec, null, 2));
      return cs;
    };

    const c = makeCase();
    const r = retarget(c, ['--raised-by-head', '--bends', 'clamp', '--short', '0.35', '--switch-min', '0.1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const tr = motionOf(c.out).animations.dance!.tracks;
    const rotOf = (bone: string, f: number): number =>
      wrap((tr.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);

    // Across the K3 [22..28] -> K2 [32..35] bridge (frames 28..32), sleeve_l1 interpolates linearly in joint space (interior |Δ²| ≈ 0 on 29..31, max step <= 9°).
    const maxBridgeD2 = (fn: (b: string, f: number) => number): number => {
      let mx = 0;
      for (let i = 29; i <= 31; i++) {
        const dPrev = wrap(fn('sleeve_l1', i) - fn('sleeve_l1', i - 1));
        const dNext = wrap(fn('sleeve_l1', i + 1) - fn('sleeve_l1', i));
        mx = Math.max(mx, Math.abs(dNext - dPrev));
      }
      return mx;
    };
    expect(maxBridgeD2(rotOf)).toBeLessThan(1e-2);
    expect(Math.abs(wrap(rotOf('sleeve_l1', 29) - rotOf('sleeve_l1', 28)))).toBeLessThanOrEqual(10);

    // Part 2: short stance span (frames 10..12) between two flights (4..9 and 13..18) arch-blends hip y so peak stance upward acceleration is lower than linear stepIn/(PLANT_BLEND+1).
    const THIGH_RUN = -95;
    const SHIN_RUN = -97;
    const STILL_RUN: Motion = { ...BASE, n: 24, dt: 1 / 24, rt: () => THIGH_RUN, rs: () => SHIN_RUN, lt: () => THIGH_RUN, ls: () => SHIN_RUN, hip: () => [0, 0] };
    const V_RUN = add(dir(THIGH_RUN, 80), dir(SHIN_RUN, 70));
    const fRun = (i: number): number => {
      if (i === 2 || i === 12 || i === 22) return 0.92;
      if (i === 3 || i === 13) return 0.84;
      return 1;
    };
    const riseRun = (i: number): number => {
      if (i === 2 || i === 12 || i === 22) return 0.08 * V_RUN[1] - 5;
      if (i === 3 || i === 13) return 0.16 * V_RUN[1] - 2;
      if ((i >= 4 && i <= 9) || (i >= 14 && i <= 19)) return 25;
      return 0;
    };
    const liftRun = (i: number): number => (i === 2 || i === 12 || i === 22 ? -(0.08 * V_RUN[1] - 5) : 0);
    const docRun = {
      ...poseDoc(STILL_RUN, (i, j) => {
        const drop: Pt = [(1 - fRun(i)) * V_RUN[0], (1 - fRun(i)) * V_RUN[1] - riseRun(i)];
        for (const [name, at] of Object.entries(j)) {
          const a = at.at as Pt;
          if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
          j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
        }
        for (const s of ['r', 'l'] as const) {
          const hip = j[`${s}_hip`]!.at as Pt;
          const knee = add(hip, dir(THIGH_RUN, 80 * fRun(i)));
          const ankle = add(knee, dir(SHIN_RUN, 70 * fRun(i)));
          j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
          j[`${s}_ankle`] = { state: 'observed', at: [ankle[0], ankle[1] - liftRun(i)], score: 0.9 };
        }
      }),
      travel: 'in-place',
    };
    const cRun = setup({ pose: docRun });
    const rRun = retarget(cRun, ['--leg-scale', '0.8,1.05', '--plant-feet']);
    expect(rRun.status).toBe(0);
    const hipYOf = (outPath: string): number[] =>
      (motionOf(outPath).animations.dance!.tracks.find((t) => 'bone' in t && t.bone === 'hip' && t.property === 'translate')!.keys as Array<{ v: number[] }>).map(
        (k) => k.v[1]!,
      );
    const hyOurs = hipYOf(cRun.out);
    const accOurs = hyOurs[10]! - 2 * hyOurs[11]! + hyOurs[12]!;

    mkdirSync(MUTANTS, { recursive: true });
    const dM1 = mkdtempSync(join(MUTANTS, 'm218-bridge-'));
    const dM2 = mkdtempSync(join(MUTANTS, 'm218-stance-'));
    try {
      for (const d of [dM1, dM2]) {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      }
      // Mutant 1: disabling full-gap joint-space bridge interpolation produces a > 10° |Δ²| kink on frames 29..31 and raises frame 29's step past 13.5°.
      const pRet = join(dM1, 'src', 'retarget.ts');
      const srcRet = readFileSync(pRet, 'utf8');
      const fromRet = 'if (i0 >= 0 && prevSw!.chains.includes(cn) && s.frames[0] - i0 >= 2 && chainShownInBridge) {';
      expect(srcRet.split(fromRet)).toHaveLength(2);
      writeFileSync(pRet, srcRet.replace(fromRet, 'if (false) {'));
      const cM1 = makeCase();
      const rM1 = retarget(cM1, ['--raised-by-head', '--bends', 'clamp', '--short', '0.35', '--switch-min', '0.1'], join(dM1, 'cli.ts'));
      expect(rM1.status).toBe(0);
      const trM1 = motionOf(cM1.out).animations.dance!.tracks;
      const rotM1 = (bone: string, f: number): number =>
        wrap((trM1.find((t) => 'bone' in t && t.bone === bone && t.property === 'rotate')!.keys[f] as { v: number[] }).v[0]!);
      expect(maxBridgeD2(rotM1)).toBeGreaterThan(10);
      expect(Math.abs(wrap(rotM1('sleeve_l1', 29) - rotM1('sleeve_l1', 28)))).toBeGreaterThan(13.5);

      // Mutant 2: disabling short-stance arch blend raises stance upward hip acceleration on 10..12 by 0.5 * (planted - travel) = 1.24u.
      const pLegs = join(dM2, 'src', 'legs.ts');
      const srcLegs = readFileSync(pLegs, 'utf8');
      const fromLegs = 'const w = (blendToFlight && blendEnd - blendAt < PLANT_BLEND ? Math.min(stepIn, blendEnd - i + 1) : stepIn) / (PLANT_BLEND + 1);';
      expect(srcLegs.split(fromLegs)).toHaveLength(2);
      writeFileSync(pLegs, srcLegs.replace(fromLegs, 'const w = stepIn / (PLANT_BLEND + 1);'));
      const cM2 = setup({ pose: docRun });
      const rM2 = retarget(cM2, ['--leg-scale', '0.8,1.05', '--plant-feet'], join(dM2, 'cli.ts'));
      expect(rM2.status).toBe(0);
      const hyM2 = hipYOf(cM2.out);
      const accM2 = hyM2[10]! - 2 * hyM2[11]! + hyM2[12]!;
      expect(accM2 - accOurs).toBeCloseTo(1.24, 1);
    } finally {
      rmSync(dM1, { recursive: true, force: true });
      rmSync(dM2, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#225: per-leg setup-weighted straight length and clamped asked values in report', () => {
  const N = 24;
  const DT = 1 / 24;

  function makeAsymmetricLegCase() {
    const motion: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: () => 90,
      rt: () => -90,
      rs: () => -90,
      lt: () => -90,
      ls: () => -90,
      hip: () => [0, 0],
    };
    const pose = poseDoc(motion, (i, j) => {
      const rHip = j.r_hip!.at as Pt;
      const lHip = j.l_hip!.at as Pt;
      if (i < 6) {
        // Left leg starts lower (150 px vs right 146 px) so left leg supports continuously from frame 0.
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150], score: 0.9 };
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 78], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 146], score: 0.9 };
      } else if (i < 18) {
        // Both legs straight at 80 + 70 = 150 px for 12/24 frames -> P95 straight is 80 / 70 px on both sides.
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 80], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 150], score: 0.9 };
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 80], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 150], score: 0.9 };
      } else {
        // On frames 18..23, left leg supports at 76.0 + 67.2 = 143.2 px while right leg lifts by 9.4 px (133.8 px: thigh 78.8 px, shin 55.0 px).
        j.l_knee = { state: 'observed', at: [lHip[0], lHip[1] + 76.0], score: 0.9 };
        j.l_ankle = { state: 'observed', at: [lHip[0], lHip[1] + 143.2], score: 0.9 };
        j.r_knee = { state: 'observed', at: [rHip[0], rHip[1] + 78.8], score: 0.9 };
        j.r_ankle = { state: 'observed', at: [rHip[0], rHip[1] + 133.8], score: 0.9 };
      }
    });
    // Setup rig has asymmetric legs: left leg 81.2 + 70.5 = 151.7 u (+2.29% longer than right leg 78.8 + 69.5 = 148.3 u).
    return setup({
      rig: {
        bones: (bs) =>
          bs.map((b) => {
            if (b.name === 'leg_r0') return { ...b, rotation: -90, length: 78.8 };
            if (b.name === 'leg_r1') return { ...b, x: 78.8, rotation: 0, length: 69.5 };
            if (b.name === 'leg_l0') return { ...b, rotation: -90, length: 81.2 };
            if (b.name === 'leg_l1') return { ...b, x: 81.2, rotation: 0, length: 70.5 };
            return b;
          }),
      },
      map: {
        ...baseMap(),
        chains: baseChains().map((ch) => (ch.name === 'leg_r' ? { ...ch, bend: 'free' } : ch)),
      },
      pose,
    });
  }

  function liftRatioOnSpan(buildDir: string): number {
    const doc = loadBuild(buildDir);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const ratios: number[] = [];
    const seqLift = 9.4; // 143.2 - 133.8 px (rig mean leg 150u / sequence straight leg 150px = 1.0 u/px)
    for (let i = 18; i < N; i++) {
      const b = byName(poses[i]!.bones);
      const rShin = b.get('leg_r1')!;
      const lShin = b.get('leg_l1')!;
      const rAnkleY = rShin.worldY + rShin.c * 69.5;
      const lAnkleY = lShin.worldY + lShin.c * 70.5;
      ratios.push((rAnkleY - lAnkleY) / seqLift);
    }
    ratios.sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length / 2)]!;
  }

  test('weights reference straight length by each leg segment\'s setup bone share and records clamped asked values in LEG-SCALE and report.json', () => {
    const c = makeAsymmetricLegCase();
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.04', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const legLines = linesOf(r, 'LEG-SCALE');
    expect(legLines[0]).toContain('chain "leg_r" bone "leg_r0" (r_hip → r_knee): straight length 78.8px');
    expect(legLines[1]).toContain('chain "leg_r" bone "leg_r1" (r_knee → r_ankle): straight length 69.5px');
    expect(legLines[1]).toContain('6 frame(s) under 0.8, clamped (frames 18–23) (asked 0.791)');
    expect(legLines[2]).toContain('chain "leg_l" bone "leg_l0" (l_hip → l_knee): straight length 81.2px');
    expect(legLines[3]).toContain('chain "leg_l" bone "leg_l1" (l_knee → l_ankle): straight length 70.5px');

    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      legScale: Array<{
        bone: string;
        straight: number;
        clamped: Array<{ frames: [number, number]; times: [number, number]; limit: 'low' | 'high'; asked: { min: number; max: number } }>;
      }>;
    };
    const r0 = rep.legScale.find((s) => s.bone === 'leg_r0')!;
    const r1 = rep.legScale.find((s) => s.bone === 'leg_r1')!;
    const l0 = rep.legScale.find((s) => s.bone === 'leg_l0')!;
    const l1 = rep.legScale.find((s) => s.bone === 'leg_l1')!;
    expect(r0.straight).toBeCloseTo(78.8, 3);
    expect(r1.straight).toBeCloseTo(69.5, 3);
    expect(l0.straight).toBeCloseTo(81.2, 3);
    expect(l1.straight).toBeCloseTo(70.5, 3);
    expect(r1.clamped).toHaveLength(1);
    expect(r1.clamped[0]!.frames).toEqual([18, 23]);
    expect(r1.clamped[0]!.limit).toBe('low');
    expect(r1.clamped[0]!.times[0]).toBeCloseTo(18 * DT, 5);
    expect(r1.clamped[0]!.times[1]).toBeCloseTo(23 * DT, 5);
    expect(r1.clamped[0]!.asked.min).toBeCloseTo(55.0 / 69.5, 6);
    expect(r1.clamped[0]!.asked.max).toBeCloseTo(55.0 / 69.5, 6);

    const ratio = liftRatioOnSpan(c.build);
    expect(ratio).toBeCloseTo(8.8 / 9.4, 3);
    expect(ratio).toBeGreaterThanOrEqual(0.85);
    expect(ratio).toBeLessThanOrEqual(1.15);

    // Mutant (Bar 3): pooling the straight reference length across both legs without setup-bone weighting pushes the lifted foot ratio past 1.15.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm225-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const pRet = join(d, 'src', 'retarget.ts');
      const srcRet = readFileSync(pRet, 'utf8');
      const fromRet = 'const ls = legScaleOf(seg.lengths, limits, straightByKind.get(seg.kind)! * rigShareOf(seg));';
      expect(srcRet.split(fromRet)).toHaveLength(2);
      writeFileSync(pRet, srcRet.replace(fromRet, 'const ls = legScaleOf(seg.lengths, limits, straightByKind.get(seg.kind)!);'));

      const cMut = makeAsymmetricLegCase();
      const rMut = retarget(cMut, ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.04'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const ratioMut = liftRatioOnSpan(cMut.build);
      expect(ratioMut).toBeGreaterThan(1.15);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('crouch-invariant per-frame figure scale across support spans (#226)', () => {
  const N = 180;
  const DT = 1 / 24;
  const spans = [
    { idx: 1, side: 'l' as const, a: 0, b: 35 },
    { idx: 2, side: 'r' as const, a: 36, b: 59 },
    { idx: 3, side: 'l' as const, a: 60, b: 109 },
    { idx: 4, side: 'r' as const, a: 110, b: 149 },
    { idx: 5, side: 'l' as const, a: 150, b: 179 },
  ];

  function crouchDancePose(): Record<string, unknown> {
    const m: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: () => 90,
      rt: () => -90,
      rs: () => -90,
      lt: () => -90,
      ls: () => -90,
      hip: () => [0, 0],
    };
    return poseDoc(m, (i, j) => {
      // Clip-wide camera scale grows +25% across the sequence so 5-series consensus exceeds ±2%.
      const camZ = 1.0 + (0.25 * i) / (N - 1);
      const sp = spans.find((s) => i >= s.a && i <= s.b)!;
      const u = (i - sp.a) / Math.max(1, sp.b - sp.a);
      // Support leg foreshortens in the interior of spans 2-5 (after the 3-frame plant blend) and stands straight at the span edges.
      let legFrac = 1.0;
      let headDrop = 0;
      if (sp.idx === 2) {
        legFrac = u >= 0.25 && u <= 0.65 ? 0.9 : 1.0;
        headDrop = u >= 0.25 && u <= 0.65 ? 10 : 0;
      } else if (sp.idx === 3) {
        // Span 3 has a deep crouch followed by pre-jump extension where nose rises while straight segment length stays constant.
        legFrac = u >= 0.2 && u <= 0.55 ? 0.84 : 1.0;
        headDrop = u >= 0.2 && u <= 0.55 ? 32 : u >= 0.75 ? -22 : 0;
      } else if (sp.idx === 4) {
        legFrac = u >= 0.25 && u <= 0.65 ? 0.86 : 1.0;
        headDrop = u >= 0.25 && u <= 0.65 ? 14 : 0;
      } else if (sp.idx === 5) {
        legFrac = u >= 0.25 && u <= 0.65 ? 0.92 : 1.0;
        headDrop = u >= 0.25 && u <= 0.65 ? 8 : 0;
      }
      const floorY = 350 * camZ;
      const supLen = 150 * camZ * legFrac;
      const freeLift = 12 * camZ;
      const mhY = floorY - supLen;
      const rHipX = -15 * camZ;
      const lHipX = 15 * camZ;
      j.r_hip = { state: 'observed', at: [rHipX, mhY], score: 0.95 };
      j.l_hip = { state: 'observed', at: [lHipX, mhY], score: 0.95 };
      const setLeg = (side: 'r' | 'l', x: number, ankleY: number) => {
        const thigh = (80 / 150) * (ankleY - mhY);
        j[`${side}_knee`] = { state: 'observed', at: [x, mhY + thigh], score: 0.95 };
        j[`${side}_ankle`] = { state: 'observed', at: [x, ankleY], score: 0.95 };
      };
      if (sp.side === 'l') {
        setLeg('l', lHipX, floorY);
        setLeg('r', rHipX, floorY - freeLift);
      } else {
        setLeg('r', rHipX, floorY);
        setLeg('l', lHipX, floorY - freeLift);
      }
      const trunkLen = 100 * camZ;
      const shY = mhY - trunkLen;
      j.neck = { state: 'observed', at: [0, shY], score: 0.95 };
      j.r_shoulder = { state: 'observed', at: [-25 * camZ, shY], score: 0.95 };
      j.l_shoulder = { state: 'observed', at: [25 * camZ, shY], score: 0.95 };
      j.r_elbow = { state: 'observed', at: [-25 * camZ, shY + 45 * camZ], score: 0.95 };
      j.l_elbow = { state: 'observed', at: [25 * camZ, shY + 45 * camZ], score: 0.95 };
      j.r_wrist = { state: 'observed', at: [-25 * camZ, shY + 85 * camZ], score: 0.95 };
      j.l_wrist = { state: 'observed', at: [25 * camZ, shY + 85 * camZ], score: 0.95 };
      const noseY = shY - 30 * camZ + headDrop * camZ;
      j.nose = { state: 'observed', at: [0, noseY], score: 0.95 };
      j.r_eye = { state: 'observed', at: [-6 * camZ, noseY - 5 * camZ], score: 0.95 };
      j.l_eye = { state: 'observed', at: [6 * camZ, noseY - 5 * camZ], score: 0.95 };
      j.r_ear = { state: 'observed', at: [-12 * camZ, noseY - 5 * camZ], score: 0.95 };
      j.l_ear = { state: 'observed', at: [12 * camZ, noseY - 5 * camZ], score: 0.95 };
    });
  }

  function spanHipVerticalRatios(buildDir: string, pose: Record<string, unknown>): Map<string, number> {
    const doc = loadBuild(buildDir);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const frames = (pose.frames as Array<{ people: Array<{ joints: Record<string, { at: Pt }> }> }>).map((f) => f.people[0]!.joints);
    const rigL = 150;
    const seqL = 150 * 1.07;
    const out = new Map<string, number>();
    for (const sp of spans.slice(1)) {
      const ankJ = `${sp.side}_ankle`;
      const shinB = sp.side === 'l' ? 'leg_l1' : 'leg_r1';
      const rv: number[] = [];
      const sv: number[] = [];
      for (let i = sp.a; i <= sp.b; i++) {
        const b = byName(poses[i]!.bones);
        const r0 = b.get('leg_r0')!;
        const l0 = b.get('leg_l0')!;
        const shin = b.get(shinB)!;
        const footY = shin.worldY + shin.c * 70;
        const midHipY = (r0.worldY + l0.worldY) / 2;
        rv.push((midHipY - footY) / rigL);
        const j = frames[i]!;
        const seqMidHipY = (j.r_hip!.at[1] + j.l_hip!.at[1]) / 2;
        sv.push((j[ankJ]!.at[1] - seqMidHipY) / seqL);
      }
      const wr = Math.max(...rv) - Math.min(...rv);
      const ws = Math.max(...sv) - Math.min(...sv);
      out.set(`span ${sp.idx}`, wr / ws);
    }
    return out;
  }

  test('keeps hip-vertical amplitude ratio within 0.85..1.15 on spans 2..5; mutant restoring vertical ankle-nose height fails on span 3 by name', () => {
    const pose = crouchDancePose();
    const c = setup({ pose });
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const ratios = spanHipVerticalRatios(c.build, pose);
    for (const name of ['span 2', 'span 3', 'span 4', 'span 5']) {
      const v = ratios.get(name)!;
      expect(v, `${name} hip-vertical ratio ${v.toFixed(3)} must be in 0.85..1.15`).toBeGreaterThanOrEqual(0.85);
      expect(v, `${name} hip-vertical ratio ${v.toFixed(3)} must be in 0.85..1.15`).toBeLessThanOrEqual(1.15);
    }

    // Mutant (Bar 3): restoring vertical ankle-to-nose height shrinks continuousScale in the crouch and stretches it before takeoff, dropping span 3 below 0.85.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm226-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const pRet = join(d, 'src', 'retarget.ts');
      const srcRet = readFileSync(pRet, 'utf8');
      const fromRet = 'const segH =';
      expect(srcRet.split(fromRet)).toHaveLength(2);
      writeFileSync(
        pRet,
        srcRet.replace(
          fromRet,
          "const top = heldPt('nose') ?? heldPt('neck'); if (top !== null) { const h = ar.map((r, i) => Math.max(r[1], al[i]![1]) - top[i]![1]); if (h.every((v) => v > 1e-6)) return h; }\n          const segH =",
        ),
      );

      const cMut = setup({ pose });
      const rMut = retarget(cMut, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mutRatios = spanHipVerticalRatios(cMut.build, pose);
      const span3Mut = mutRatios.get('span 3')!;
      expect(span3Mut, `mutant span 3 hip-vertical ratio ${span3Mut.toFixed(3)} must fail (< 0.85)`).toBeLessThan(0.85);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('continuous figure scale across inter-span airborne gaps (#231)', () => {
  const N = 240;
  const DT = 1 / 24;

  function jumpLandingPose(): Record<string, unknown> {
    const m: Motion = {
      ...BASE,
      n: N,
      dt: DT,
      trunk: () => 90,
      rt: () => -90,
      rs: () => -90,
      lt: () => -90,
      ls: () => -90,
      hip: () => [0, 0],
    };
    const doc = poseDoc(m, (i, j) => {
      // Span 1 [0..70] at camZ = 1.000; Span 2 [71..145] at camZ = 1.145;
      // airborne jump [146..150] at camZ = 1.197; Span 3 [151..239] at camZ = 1.258
      // with an 18-frame landing crouch (legFrac = 0.85) before standing upright on 169..239.
      const camZ = i <= 70 ? 1.0 : i <= 145 ? 1.145 : i <= 150 ? 1.197 : 1.258;
      let legFrac = 1.0;
      let jumpLift = 0;
      if (i >= 146 && i <= 150) {
        jumpLift = 35 * camZ;
        legFrac = 1.0;
      } else if (i >= 151 && i <= 168) {
        legFrac = 0.85;
      }
      const floorY = 380;
      const ankY = floorY - jumpLift;
      const supLen = 150 * camZ * legFrac;
      const mhY = ankY - supLen;
      const rHipX = -15 * camZ;
      const lHipX = 15 * camZ;
      j.r_hip = { state: 'observed', at: [rHipX, mhY], score: 0.95 };
      j.l_hip = { state: 'observed', at: [lHipX, mhY], score: 0.95 };
      const setLeg = (side: 'r' | 'l', x: number, ay: number) => {
        const thigh = (80 / 150) * (ay - mhY);
        j[`${side}_knee`] = { state: 'observed', at: [x, mhY + thigh], score: 0.95 };
        j[`${side}_ankle`] = { state: 'observed', at: [x, ay], score: 0.95 };
      };
      if (i <= 70) {
        setLeg('l', lHipX, ankY);
        setLeg('r', rHipX, ankY - 5 * camZ);
      } else if (i <= 145) {
        setLeg('r', rHipX, ankY);
        setLeg('l', lHipX, ankY - 5 * camZ);
      } else if (i <= 150) {
        setLeg('l', lHipX, ankY);
        setLeg('r', rHipX, ankY);
      } else {
        setLeg('l', lHipX, ankY);
        setLeg('r', rHipX, ankY - 5 * camZ);
      }
      const shY = mhY - 100 * camZ;
      j.neck = { state: 'observed', at: [0, shY], score: 0.95 };
      j.r_shoulder = { state: 'observed', at: [-25 * camZ, shY], score: 0.95 };
      j.l_shoulder = { state: 'observed', at: [25 * camZ, shY], score: 0.95 };
      j.r_elbow = { state: 'observed', at: [-25 * camZ, shY + 45 * camZ], score: 0.95 };
      j.l_elbow = { state: 'observed', at: [25 * camZ, shY + 45 * camZ], score: 0.95 };
      j.r_wrist = { state: 'observed', at: [-25 * camZ, shY + 85 * camZ], score: 0.95 };
      j.l_wrist = { state: 'observed', at: [25 * camZ, shY + 85 * camZ], score: 0.95 };
      const noseY = shY - 30 * camZ;
      j.nose = { state: 'observed', at: [0, noseY], score: 0.95 };
      j.r_eye = { state: 'observed', at: [-6 * camZ, noseY - 5 * camZ], score: 0.95 };
      j.l_eye = { state: 'observed', at: [6 * camZ, noseY - 5 * camZ], score: 0.95 };
      j.r_ear = { state: 'observed', at: [-12 * camZ, noseY - 5 * camZ], score: 0.95 };
      j.l_ear = { state: 'observed', at: [12 * camZ, noseY - 5 * camZ], score: 0.95 };
    });
    return cleanedDoc(doc);
  }

  test('ramps figure scale across an airborne gap into the landing support span with 0% landing-frame scale step; mutant without gap ramp steps > 4% at landing', () => {
    const pose = jumpLandingPose();
    const c = setup({ pose });
    const camPath = join(c.dir, 'camera.json');
    const repPath = join(c.dir, 'report.json');
    const r = retarget(c, ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--camera', camPath, '--report', repPath]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);

    const rep = JSON.parse(readFileSync(repPath, 'utf8')) as { feet: { supports: Array<{ frames: [number, number] }> } };
    const landSpan = rep.feet.supports.find((sp) => sp.frames[0] >= 151)!;
    const land = landSpan.frames[0];
    const cam = JSON.parse(readFileSync(camPath, 'utf8')) as { frames: Array<{ s: number }> };
    const landingStep = Math.abs(cam.frames[land]!.s - cam.frames[land - 1]!.s) / cam.frames[land - 1]!.s;
    expect(landingStep).toBeLessThan(0.001);

    // Mutant: removing the inter-span gap ramp leaves the airborne gap as a flat plateau that locks as a false frozen span and steps > 4% on landing.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm231-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const pRet = join(d, 'src', 'retarget.ts');
      const srcRet = readFileSync(pRet, 'utf8');
      const fromRet = 'if (a <= b && ms[k + 1]! > ms[k]!) {';
      expect(srcRet.split(fromRet)).toHaveLength(2);
      writeFileSync(pRet, srcRet.replace(fromRet, 'if (false) {'));

      const cMut = setup({ pose });
      const camMutPath = join(cMut.dir, 'camera.json');
      const rMut = retarget(
        cMut,
        ['--bends', 'clamp', '--leg-scale', '0.8,1.05', '--plant-feet', '--camera', camMutPath],
        join(d, 'cli.ts'),
      );
      expect(rMut.status).toBe(0);
      const camMut = JSON.parse(readFileSync(camMutPath, 'utf8')) as { frames: Array<{ s: number }> };
      const mutLandingStep = Math.abs(camMut.frames[land]!.s - camMut.frames[land - 1]!.s) / camMut.frames[land - 1]!.s;
      expect(mutLandingStep).toBeGreaterThan(0.04);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

// --- #237: --stance and --leg-scale name their unit; a clamp's effect on a free ankle is printed ---

describe('#237: --stance and --leg-scale name their unit, and LEG-SCALE and STANCE say what the clamp did to the free ankle', () => {
  const THIGH = -95;
  const SHIN = -97;
  const N = 24;
  const DT = 1 / 24;
  /** The left leg's picture length, of straight: 1, folding to 0.69 on frame 12 (collinear), so its ankle rises 0.31 of the leg; no frame sits on the 0.85 floor (frame 8: 0.845). */
  const fL = (i: number): number => (i < 6 || i > 18 ? 1 : 1 - 0.31 * Math.sin(((i - 6) / 12) * Math.PI));
  const STILL: Motion = { ...BASE, n: N, dt: DT, trunk: () => 90, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };
  /** The rig leg's vertical extent along the pose's angles, units (80 and 70 at −95° and −97°); the left rig leg at setup is straight, 150 units. */
  const WY = Math.abs(80 * Math.sin(THIGH * RAD) + 70 * Math.sin(SHIN * RAD));
  const RIG_LEG = 150;
  function liftPose(): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const hip = j.l_hip!.at as Pt;
      const knee = add(hip, dir(THIGH, 80 * fL(i)));
      j.l_knee = { state: 'observed', at: knee, score: 0.9 };
      j.l_ankle = { state: 'observed', at: add(knee, dir(SHIN, 70 * fL(i))), score: 0.9 };
    });
  }
  type Shift = { units: number; legLengths: number } | null;
  type Free = { side: string; frames: Array<[number, number]>; count: number; above: Shift; below: Shift };
  type Rep = {
    legScale: Array<{ bone: string; straight: number; limits: [number, number]; ratio: { min: number; median: number; max: number }; free?: Free }>;
    feet: { legLength: { r: number; l: number }; straight: { r: number; l: number }; rigLeg: { r: number; l: number }; segments: Array<{ bone: string; straight: number; ratio: { min: number; median: number; max: number } }> };
    stance: { tolerance: number; runs: Array<{ state: string; side: string; frames: [number, number]; absorbed?: true; moved?: Free }> };
  };
  const run = (extra: string[], cliPath = CLI) => {
    const c = setup({ pose: liftPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, [...extra, '--report', report], cliPath);
    return { c, r, rep: r.status === 0 ? (JSON.parse(readFileSync(report, 'utf8')) as Rep) : null };
  };
  const FLAGS = ['--leg-scale', '0.85,1.05', '--plant-feet', '--stance', '0.07'];
  /** numpy's linear percentile, independent of src/. */
  const pct = (xs: number[], q: number): number => {
    const s = [...xs].sort((a, b) => a - b);
    const pos = q * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(s.length - 1, lo + 1);
    return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  };

  test('LEG-SCALE names its unit in px and in FEET\'s leg length, and prints what the clamps did to the free ankle, derived from the report\'s own fields', () => {
    const { r, rep } = run(FLAGS);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const ls = linesOf(r, 'LEG-SCALE');
    const l0 = rep!.legScale.find((x) => x.bone === 'leg_l0')!;
    const line = ls.find((x) => x.includes('bone "leg_l0"'))!;
    // The straight length against FEET's leg length, and the limits in px — each from the report's fields.
    expect(line).toContain(`straight length ${l0.straight.toFixed(1)}px (larger 95th percentile of ${N} frames, both legs) = ${(l0.straight / rep!.feet.legLength.l).toFixed(3)} of FEET's leg length (median hip → ankle, l ${rep!.feet.legLength.l.toFixed(1)}px)`);
    expect(line).toContain(`scalex keyed in [0.85, 1.05] of the straight length (${(0.85 * l0.straight).toFixed(1)}–${(1.05 * l0.straight).toFixed(1)}px): `);
    // The free ankle: clamped at 0.85 where the picture folds it to fL < 0.85 (frames 8–16), it hangs (0.85 − fL) of the
    // rig leg's vertical extent below the picture's. Recomputed here from the fixture, not from src/.
    const free = l0.free!;
    expect(free.side).toBe('l');
    expect(free.frames).toEqual([[8, 16]]);
    expect(free.count).toBe(9);
    expect(free.above).toBeNull();
    const want = ((0.85 - fL(12)) * WY) / RIG_LEG;
    expect(Math.abs(free.below!.legLengths - want)).toBeLessThan(1e-4);
    expect(rep!.feet.rigLeg.l).toBeCloseTo(RIG_LEG, 3);
    expect(free.below!.legLengths).toBeCloseTo(free.below!.units / rep!.feet.rigLeg.l, 12);
    expect(line).toContain(`; its leg free (the other foot supporting) on 9 of its 9 clamped frame(s) (frames 8–16): the clamps on that leg left the free ankle up to ${free.below!.legLengths.toFixed(4)} leg lengths (${(free.below!.legLengths * rep!.feet.legLength.l).toFixed(1)} px of FEET's) below the picture's (the leg at picture length ÷ straight) (leg lengths: the rig's l leg at setup, thigh origin → ankle, ${rep!.feet.rigLeg.l.toFixed(1)} units)`);
    // The supporting leg is never clamped here: no free clause.
    expect(ls.find((x) => x.includes('bone "leg_r0"'))).not.toContain('free');
  }, SLOW);

  test('STANCE prints its unit in px and as a share of the straight leg, from the report\'s fields; "height kept" is absent on the frames the clamp moved', () => {
    const { r, rep } = run(FLAGS);
    expect(r.status).toBe(0);
    const st = linesOf(r, 'STANCE');
    const { legLength, straight } = rep!.feet;
    const tol = rep!.stance.tolerance;
    expect(st[0]).toBe(`STANCE unit: --stance ${tol} is in FEET's leg length (each side's median picture length hip → ankle, r ${legLength.r.toFixed(1)} / l ${legLength.l.toFixed(1)} px), not a straight length (a 95th percentile, as LEG-SCALE reads a segment's: the straight leg hip → ankle r ${straight.r.toFixed(1)} / l ${straight.l.toFixed(1)} px): ${tol} leg lengths = r ${(tol * legLength.r).toFixed(1)} / l ${(tol * legLength.l).toFixed(1)} px = r ${((tol * legLength.r) / straight.r).toFixed(4)} / l ${((tol * legLength.l) / straight.l).toFixed(4)} of the straight leg`);
    const lifted = rep!.stance.runs.find((x) => x.state === 'lifted' && x.absorbed !== true)!;
    expect(lifted.frames).toEqual([7, 17]);
    expect(lifted.moved!.frames).toEqual([[8, 16]]);
    expect(lifted.moved!.count).toBe(9);
    const line = st.find((x) => x.startsWith('STANCE lifted:'))!;
    expect(line).toContain(`the tolerance ${tol} leg lengths (r ${(tol * legLength.r).toFixed(1)} / l ${(tol * legLength.l).toFixed(1)} px)`);
    expect(line).not.toMatch(/; the pose's height kept$/);
    expect(line).toContain(`the pose's height kept on 2 of its 11 frame(s); on 9 (frames 8–16) --leg-scale's clamps moved the free ankle off it, up to ${lifted.moved!.below!.legLengths.toFixed(4)} leg lengths`);
  }, SLOW);

  test('control: with the floor under the fold (0.5) nothing is clamped, so the lifted run keeps the pose\'s height and says so', () => {
    const { r, rep } = run(['--leg-scale', '0.5,1.05', '--plant-feet', '--stance', '0.07']);
    expect(r.status).toBe(0);
    const lifted = rep!.stance.runs.find((x) => x.state === 'lifted' && x.absorbed !== true)!;
    expect(lifted.moved).toBeUndefined();
    expect(linesOf(r, 'STANCE').find((x) => x.startsWith('STANCE lifted:'))).toMatch(/; the pose's height kept$/);
    for (const l of rep!.legScale) expect(l.free).toBeUndefined();
  }, SLOW);

  test('the FEET segment lines print without --leg-scale, and their min · median · max are recomputed from the sequence; with --leg-scale they are LEG-SCALE\'s', () => {
    const { c, r, rep } = run([]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LEG-SCALE')).toEqual([]);
    const doc = JSON.parse(readFileSync(c.pose, 'utf8')) as { frames: Array<{ people: Array<{ joints: Record<string, { at: Pt }> }> }> };
    const at = (i: number, j: string) => doc.frames[i]!.people[0]!.joints[j]!.at;
    const len = (s: 'r' | 'l', a: string, b: string) => doc.frames.map((_, i) => Math.hypot(at(i, `${s}_${b}`)[0] - at(i, `${s}_${a}`)[0], at(i, `${s}_${b}`)[1] - at(i, `${s}_${a}`)[1]));
    const feet = linesOf(r, 'FEET');
    for (const [bone, a, b] of [['leg_r0', 'hip', 'knee'], ['leg_r1', 'knee', 'ankle'], ['leg_l0', 'hip', 'knee'], ['leg_l1', 'knee', 'ankle']] as const) {
      const side = bone.includes('_r') ? 'r' : 'l';
      const straight = Math.max(pct(len('r', a, b), 0.95), pct(len('l', a, b), 0.95));
      const ratio = len(side, a, b).map((x) => x / straight).sort((p, q) => p - q);
      const want = { min: ratio[0]!, median: (ratio[N / 2 - 1]! + ratio[N / 2]!) / 2, max: ratio[N - 1]! };
      const seg = rep!.feet.segments.find((x) => x.bone === bone)!;
      expect(Math.abs(seg.straight - straight)).toBeLessThan(1e-9);
      for (const k of ['min', 'median', 'max'] as const) expect(Math.abs(seg.ratio[k] - want[k])).toBeLessThan(1e-9);
      const line = feet.find((x) => x.includes(`bone "${bone}"`))!;
      expect(line).toContain(`min ${want.min.toFixed(4)} · median ${want.median.toFixed(4)} · max ${want.max.toFixed(4)}`);
    }
    expect(rep!.feet.segments.find((x) => x.bone === 'leg_l0')!.ratio.min).toBeCloseTo(fL(12), 6);
    // With --leg-scale the same reading is LEG-SCALE's straight and ratio.
    const withFlag = run(FLAGS).rep!;
    for (const l of withFlag.legScale) {
      const seg = withFlag.feet.segments.find((x) => x.bone === l.bone)!;
      expect(seg.straight).toBe(l.straight);
      expect(seg.ratio).toEqual(l.ratio);
    }
  }, SLOW);

  test('the readings move no key: motion.json is byte-identical with the reading removed (mutant), and on the public example to its bytes before #237', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm237-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'if (legScaleOn && feet !== null && legPath !== null && rigLeg !== null';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'if (false && legScaleOn && feet !== null && legPath !== null && rigLeg !== null'));
      const a = run(FLAGS);
      const b = run(FLAGS, join(d, 'cli.ts'));
      expect(b.r.status).toBe(0);
      expect(b.rep!.legScale.some((l) => l.free !== undefined)).toBe(false);
      expect(a.rep!.legScale.some((l) => l.free !== undefined)).toBe(true);
      expect(readFileSync(b.c.out)).toEqual(readFileSync(a.c.out));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
    // The public example, measured at v0.31.1 (47d0575) before #237 with the same flags.
    const BEFORE: Array<[string[], string]> = [
      [[], 'bd1ca2506217c21769169b884a306ad2defabaadecb93abd0572969291aa2e59'],
      [['--leg-scale', '0.8,1.05'], '8c265adfa4afc2608d4cc5c9da85ac2ddc4c3624775e931cb95d69dc693460df'],
      [['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'], '2f39a35e90cb2e543125a8f2db349bb79babec8d322c3e3fd49417191457dabd'],
    ];
    const ex = join(ROOT, 'examples', 'wave');
    for (const [flags, sha] of BEFORE) {
      const out = join(tempDir(), 'wave.motion.json');
      const r = cli(['retarget', '--rig', join(ex, 'rig'), '--map', join(ex, 'map.json'), '--pose', join(ex, 'pose.json'), '--out', out, ...flags]);
      expect(r.status).toBe(0);
      expect(createHash('sha256').update(readFileSync(out)).digest('hex')).toBe(sha);
    }
  }, SLOW);

  test('mutant: a clamp floor moved by +0.05 moves the printed shortfall by 0.05 of the rig leg\'s vertical extent', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm237f-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'const scale = ratio.map((r) => Math.min(Math.max(r, limits[0]), limits[1]));';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const scale = ratio.map((r) => Math.min(Math.max(r, limits[0] + 0.05), limits[1]));'));
      const ok = run(FLAGS).rep!.legScale.find((x) => x.bone === 'leg_l0')!.free!.below!.legLengths;
      const m = run(FLAGS, join(d, 'cli.ts'));
      expect(m.r.status).toBe(0);
      const moved = m.rep!.legScale.find((x) => x.bone === 'leg_l0')!.free!.below!.legLengths;
      console.log(`  mutant "clamp floor +0.05": free ankle shortfall ${ok.toFixed(4)} → ${moved.toFixed(4)} leg lengths`);
      expect(Math.abs(moved - ok - (0.05 * WY) / RIG_LEG)).toBeLessThan(1e-4);
      expect(linesOf(m.r, 'LEG-SCALE').find((x) => x.includes('bone "leg_l0"'))).toContain(`up to ${moved.toFixed(4)} leg lengths`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('mutant: printing "height kept" without reading the clamp says it on the lifted run the clamp moved, and the STANCE test is red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm237k-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'run.ts');
      const from = `if (r.moved === undefined) return "the pose's height kept";`;
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, `return "the pose's height kept";`));
      const m = run(FLAGS, join(d, 'cli.ts'));
      expect(m.r.status).toBe(0);
      expect(m.rep!.stance.runs.find((x) => x.state === 'lifted' && x.absorbed !== true)!.moved!.count).toBe(9);
      expect(linesOf(m.r, 'STANCE').find((x) => x.startsWith('STANCE lifted:'))).toMatch(/; the pose's height kept$/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#242: "in-place" is the sequence\'s property — its supports and its nod are read in place with or without --plant-feet', () => {
  /** One gait cycle, frames; the sequence repeats it CYCLES times, at 24 fps. */
  const C = 24;
  const CYCLES = 7;
  const NN = C * CYCLES;
  /** The loop bar the cycle-1 against cycle-N comparison is held to, degrees on the head's rotate key and world units on its nod. */
  const LOOP_DEG = 0.05;
  const LOOP_UNITS = 0.05;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const mapWithHead = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: [...baseChains(), { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'] }],
  });
  const phase = (i: number): number => (2 * Math.PI * (i % C)) / C;
  /**
   * A walk in place, `clean --loop`ed (which writes `"travel": "in-place"`): the hips still, the thighs swinging ±20°
   * a cycle in opposition, so a supporting ankle slides back up to 0.09 leg lengths a frame (past a step's 0.03); the
   * swinging foot lifted up to 10 px; the eyes bobbing 3 px twice a cycle against a still neck (the nod), level.
   */
  function walkInPlace(): Record<string, unknown> {
    const m: Motion = {
      ...BASE,
      n: NN,
      dt: 1 / 24,
      trunk: () => 90,
      ru: () => -100,
      rf: () => -95,
      lu: () => -80,
      lf: () => -85,
      rt: (i) => -90 + 20 * Math.sin(phase(i)),
      rs: (i) => -95 + 20 * Math.sin(phase(i)),
      lt: (i) => -90 - 20 * Math.sin(phase(i)),
      ls: (i) => -90 - 20 * Math.sin(phase(i)),
      hip: () => [0, 0],
    };
    const doc = poseDoc(m, (i, j) => {
      const lift = { r: 10 * Math.max(0, Math.cos(phase(i))), l: 10 * Math.max(0, -Math.cos(phase(i))) };
      for (const s of ['r', 'l'] as const) {
        const a = j[`${s}_ankle`]!.at as Pt;
        j[`${s}_ankle`] = { ...j[`${s}_ankle`], at: [a[0], a[1] - lift[s]] };
      }
      const bob = 3 * Math.sin(2 * phase(i));
      for (const e of ['r_eye', 'l_eye']) {
        const a = j[e]!.at as Pt;
        j[e] = { ...j[e], at: [a[0], a[1] + bob] };
      }
    });
    const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
    const c = clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture');
    expect(c.seq.travel).toBe('in-place');
    return JSON.parse(writePoseSequence(c.seq)) as Record<string, unknown>;
  }
  interface Read {
    ran: Ran;
    supports: Array<{ side: string; frames: [number, number] }>;
    steps: unknown[];
    /** The largest |cycle 1 − cycle N| over a cycle's frames: the head's rotate key (degrees) and its nod translate (units). */
    loop: { rotate: number; nod: number };
  }
  function read(c: Case, extra: string[], cliPath = CLI): Read {
    const report = join(c.dir, `report${extra.length}.json`);
    const ran = retarget(c, ['--report', report, ...extra], cliPath);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { supports: Read['supports']; steps: unknown[] } };
    const tracks = motionOf(c.out).animations.dance!.tracks;
    const keysOf = (property: string, k: number) => {
      const keys = tracks.find((t) => t.bone === 'head' && t.property === property)!.keys;
      // #275 adds the closing endpoint; the nod still reports NN distinct pose frames.
      expect(keys).toHaveLength(NN + 1);
      expect(keys.at(-1)!.v).toEqual(keys[0]!.v);
      return keys.slice(0, NN).map((x) => x.v[k]!);
    };
    const rot = keysOf('rotate', 0);
    const nodX = keysOf('translate', 0);
    const nodY = keysOf('translate', 1);
    expect(rot).toHaveLength(NN);
    let rotate = 0;
    let nod = 0;
    for (let k = 0; k < C; k++) {
      const last = (CYCLES - 1) * C + k;
      rotate = Math.max(rotate, Math.abs(wrap(rot[last]! - rot[k]!)));
      nod = Math.max(nod, Math.hypot(nodX[last]! - nodX[k]!, nodY[last]! - nodY[k]!));
    }
    return { ran, supports: rep.feet.supports, steps: rep.feet.steps, loop: { rotate, nod } };
  }
  const covered = (s: Read['supports']): number => s.reduce((t, x) => t + x.frames[1] - x.frames[0] + 1, 0);
  const show = (r: Read): string => `${r.supports.length} support span(s) covering ${covered(r.supports)} of ${NN} frames, ${r.steps.length} step(s); head cycle 1 vs ${CYCLES}: rotate ${r.loop.rotate.toFixed(3)}°, nod ${r.loop.nod.toFixed(3)} units`;

  test('without --plant-feet: one support span per foot per cycle, every frame supported, no step; the head\'s cycle 1 is its cycle N; the line names what stays --plant-feet\'s; control: --plant-feet reads the same supports', () => {
    const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: walkInPlace() });
    const free = read(c, []);
    console.log(`  #242 in place, not planted: ${show(free)}`);
    expect(free.steps).toEqual([]);
    // Two spans a cycle, alternating, half a cycle each; frame 0 is mid-way through a support, so the seam splits that one
    // span in two (the first and the last, half a cycle between them): 2 × CYCLES + 1 spans, every frame supported.
    expect(free.supports).toHaveLength(2 * CYCLES + 1);
    expect(covered(free.supports)).toBe(NN);
    expect(free.supports.map((s) => s.side)).toEqual(Array.from({ length: 2 * CYCLES + 1 }, (_, k) => (k % 2 === 0 ? free.supports[0]!.side : free.supports[1]!.side)));
    expect(free.supports.slice(1, -1).map((s) => s.frames[1] - s.frames[0] + 1)).toEqual(new Array<number>(2 * CYCLES - 1).fill(C / 2));
    const [first, last] = [free.supports[0]!, free.supports[2 * CYCLES]!];
    expect(first.frames[1] - first.frames[0] + 1 + (last.frames[1] - last.frames[0] + 1)).toBe(C / 2);
    expect(free.loop.rotate).toBeLessThan(LOOP_DEG);
    expect(free.loop.nod).toBeLessThan(LOOP_UNITS);
    const travel = linesOf(free.ran, 'TRAVEL');
    expect(travel).toHaveLength(1);
    expect(travel[0]).toMatch(/^TRAVEL sequence declares travel: in-place but --plant-feet is off — its supports and the head nod are read in place as with it; the loop closure is --plant-feet's \(it closes the planted hip\), so the hip follows the pose's own travel: x [+-]\d+\.\d{2} units from the first frame to the last, not closed$/);
    // Control: planted, the supports are the same reading (the closure prints in place of TRAVEL).
    const planted = read(c, ['--plant-feet']);
    expect(planted.supports).toEqual(free.supports);
    expect(linesOf(planted.ran, 'TRAVEL')).toEqual([]);
    // Control: a sequence without the declaration prints no TRAVEL line.
    const open = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: (({ travel: _t, ...rest }) => rest)(walkInPlace()) });
    expect(linesOf(read(open, []).ran, 'TRAVEL')).toEqual([]);
  }, SLOW);

  test('mutant: the coupling restored (`plantOn &&`) fragments the supports, and the test above is red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm242-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const src = readFileSync(path, 'utf8');
      const from = 'const inPlace = opts.travel === TRAVEL_IN_PLACE;';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, 'const inPlace = plantOn && opts.travel === TRAVEL_IN_PLACE;'));
      const c = setup({ rig: { bones: headRig }, map: mapWithHead(), pose: walkInPlace() });
      const m = read(c, [], join(d, 'cli.ts'));
      console.log(`  #242 mutant "plantOn &&": ${show(m)}`);
      const red = m.supports.length !== 2 * CYCLES + 1 || covered(m.supports) !== NN || m.loop.rotate >= LOOP_DEG || m.loop.nod >= LOOP_UNITS;
      if (!red) throw new Error('mutant "plantOn &&" survived: the supports and the head loop read as in place');
      expect(covered(m.supports)).toBeLessThan(NN);
      // #241: this mutant reads the walk as a travelling clip, and the head's loop it used to open (1.057°, 0.661 units)
      // came from the nod's detrend window cut at the clip's ends. That window now wraps on a `clean --loop` sequence, so
      // the head stays closed under this mutant too; #241's own mutant (the window cut again) is the one that opens it.
      expect(m.loop.rotate).toBeLessThan(LOOP_DEG);
      expect(m.loop.nod).toBeLessThan(LOOP_UNITS);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#286: a set with a "phase" switches on the support hand-over — exactly the frames of its side\'s support spans', () => {
  /** #242's gait cycle: frames a cycle, cycles, 24 fps. */
  const C = 24;
  const CYCLES = 7;
  const NN = C * CYCLES;
  const DT = 1 / 24;
  const phase = (i: number): number => (2 * Math.PI * (i % C)) / C;
  /** #242's walk in place (the thighs swinging ±20° in opposition, the swinging foot lifted up to 10 px), `clean --loop`ed. */
  const motion: Motion = {
    ...BASE,
    n: NN,
    dt: DT,
    trunk: () => 90,
    ru: () => -100,
    rf: () => -95,
    lu: () => -80,
    lf: () => -85,
    rt: (i) => -90 + 20 * Math.sin(phase(i)),
    rs: (i) => -95 + 20 * Math.sin(phase(i)),
    lt: (i) => -90 - 20 * Math.sin(phase(i)),
    ls: (i) => -90 - 20 * Math.sin(phase(i)),
    hip: () => [0, 0],
  };
  function walk(): Record<string, unknown> {
    const doc = poseDoc(motion, (i, j) => {
      const lift = { r: 10 * Math.max(0, Math.cos(phase(i))), l: 10 * Math.max(0, -Math.cos(phase(i))) };
      for (const s of ['r', 'l'] as const) {
        const a = j[`${s}_ankle`]!.at as Pt;
        j[`${s}_ankle`] = { ...j[`${s}_ankle`], at: [a[0], a[1] - lift[s]] };
      }
    });
    const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
    const c = clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture');
    expect(c.seq.travel).toBe('in-place');
    return JSON.parse(writePoseSequence(c.seq)) as Record<string, unknown>;
  }
  const LEG_SLOTS = ['leg_r0', 'leg_r1', 'leg_l0', 'leg_l1'];
  const att = { image: 'seg.png', x: 30, y: 0, rotation: 90 };
  /** Each leg slot carries a left-step and a right-step drawing beside its setup one. */
  const RIG: RigOpts = { extra: Object.fromEntries(LEG_SLOTS.map((s) => [s, { step_l: att, step_r: att }])) };
  const legJoints = ['r_hip', 'r_knee', 'r_ankle', 'l_hip', 'l_knee', 'l_ankle'];
  /** A gait set drawing both legs: its key skeleton is the walk's own legs on frame `at`. */
  const stepSet = (name: string, at: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    slots: Object.fromEntries(LEG_SLOTS.map((s) => [s, name])),
    chains: ['leg_r', 'leg_l'],
    pose: Object.fromEntries(Object.entries(positions(motion, at)).filter(([j]) => legJoints.includes(j))),
    ...extra,
  });
  const mapOf = (...sets: Array<Record<string, unknown>>): Record<string, unknown> => ({ ...baseMap(), alternates: sets });
  interface Rep {
    feet: { supports: Array<{ side: 'r' | 'l'; frames: [number, number] }> };
    switches: Array<{ set: string; frames: [number, number]; phase?: Record<string, unknown> }>;
  }
  /** What rig-c's own poser shows in a slot on every frame of the gated build. */
  const shows = (build: string, slot: string): Array<string | null> =>
    poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: NN - 1 }, () => DT)).map((p) => p.slots.find((row) => row[0] === slot)![1]);
  /**
   * The bar, read off the gated build: per frame, the drawing the leg slots show (all four must agree) against the side
   * the report's `feet.supports` names. `wrong`: a frame showing a step drawing other than its support side's (or one
   * where no foot supports, or none where one does); `flicker`: a frame whose drawing differs from the frame before
   * while the support side does not.
   */
  function bar(c: Case, rep: Rep, sideOf: Record<string, 'r' | 'l'>): { wrong: number; flicker: number; shown: Record<string, number> } {
    const rows = LEG_SLOTS.map((s) => shows(c.build, s));
    const support: Array<'r' | 'l' | null> = Array.from({ length: NN }, () => null);
    for (const sp of rep.feet.supports) for (let i = sp.frames[0]; i <= sp.frames[1]; i++) support[i] = sp.side;
    let wrong = 0;
    let flicker = 0;
    const shown: Record<string, number> = {};
    for (let i = 0; i < NN; i++) {
      const v = rows[0]![i]!;
      for (const r of rows) expect(r[i]).toBe(v);
      const want = support[i] === null ? 'seg' : (Object.keys(sideOf).find((k) => sideOf[k] === support[i]) ?? 'seg');
      if (v !== want) wrong++;
      if (i > 0 && v !== rows[0]![i - 1] && support[i] === support[i - 1]) flicker++;
      shown[v] = (shown[v] ?? 0) + 1;
    }
    return { wrong, flicker, shown };
  }
  function run(c: Case, extra: string[]): { ran: Ran; rep: Rep } {
    const report = join(c.dir, `report${extra.length}.json`);
    const ran = retarget(c, ['--report', report, ...extra]);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    return { ran, rep: JSON.parse(readFileSync(report, 'utf8')) as Rep };
  }
  /** The supporting foot each set shows on: left-step — the left foot is stepping — while the right foot supports. */
  const SIDES_OF = { step_l: 'r', step_r: 'l' } as const;

  test('two phase sets show exactly on their side\'s support spans (0 wrong-side frames, 0 flicker), with and without --plant-feet; PHASE names every span and its hand-overs; control: the same sets without "phase" go by angle', () => {
    // The key skeletons are deliberately off-phase (a quarter cycle from either support's middle): a phase set does not read them.
    const phased = mapOf(stepSet('step_l', 0, { phase: 'left-step' }), stepSet('step_r', 12, { phase: 'right-step' }));
    const c = setup({ rig: RIG, map: phased, pose: walk() });
    for (const extra of [[], ['--plant-feet']]) {
      const { ran, rep } = run(c, extra);
      const b = bar(c, rep, SIDES_OF);
      const lines = linesOf(ran, 'PHASE');
      console.log(`  #286 phase sets${extra.length > 0 ? ' --plant-feet' : ''}: ${rep.feet.supports.length} support span(s); wrong-side ${b.wrong}, flicker ${b.flicker}; shown ${JSON.stringify(b.shown)}`);
      for (const l of lines) console.log(`    ${l}`);
      expect(rep.feet.supports.length).toBe(2 * CYCLES + 1);
      expect(b.wrong).toBe(0);
      expect(b.flicker).toBe(0);
      // Every support span is one switch of its side's set, frame for frame, and the report carries the hand-overs.
      expect(rep.switches.map((s) => [s.set, s.frames])).toEqual(rep.feet.supports.map((sp) => [sp.side === 'r' ? 'step_l' : 'step_r', sp.frames]));
      rep.switches.forEach((s, k) => {
        const prev = rep.feet.supports[k - 1];
        const next = rep.feet.supports[k + 1];
        expect(s.phase).toMatchObject({
          step: s.set === 'step_l' ? 'left-step' : 'right-step',
          side: SIDES_OF[s.set as keyof typeof SIDES_OF],
          on: s.frames[0] === 0 ? null : { frame: s.frames[0], from: prev!.side },
          off: s.frames[1] === NN - 1 ? null : { frame: s.frames[1] + 1, to: next!.side },
        });
      });
      // One PHASE line per set: its spans, each with the hand-over it was switched on and off at.
      expect(lines).toHaveLength(2);
      for (const [name, step, side] of [['step_l', 'left-step', 'r'], ['step_r', 'right-step', 'l']] as const) {
        const own = rep.feet.supports.filter((sp) => sp.side === side);
        const other = side === 'l' ? 'r' : 'l';
        const text = own.map((sp) => `${sp.frames[0]}–${sp.frames[1]} (${sp.frames[0] === 0 ? 'on the first frame' : `on frame ${sp.frames[0]} ${other} → ${side}`}, ${sp.frames[1] === NN - 1 ? 'off at the end' : `off frame ${sp.frames[1] + 1} ${side} → ${other}`})`);
        const count = own.reduce((t, sp) => t + sp.frames[1] - sp.frames[0] + 1, 0);
        const word = (x: 'r' | 'l') => (x === 'l' ? 'left' : 'right');
        expect(lines).toContain(`PHASE  set "${name}" "${step}" — the ${word(other)} foot is stepping; shown while the ${word(side)} foot supports (feet.supports): ${own.length} span(s), ${count} frame(s): ${text.join(', ')}`);
      }
    }
    // Control: the same two sets without "phase", their key skeletons on the middle of each side's support, go by the
    // angle rule (#279, #180) — measured and printed, not held to the bar.
    const { rep: first } = run(c, []);
    const mid = (side: 'r' | 'l') => {
      const sp = first.feet.supports.slice(1, -1).find((x) => x.side === side)!;
      return (sp.frames[0] + sp.frames[1]) >> 1;
    };
    const angle = setup({ rig: RIG, map: mapOf(stepSet('step_l', mid('r')), stepSet('step_r', mid('l'))), pose: walk() });
    const a = run(angle, []);
    const ab = bar(angle, a.rep, SIDES_OF);
    console.log(`  #286 control, the same sets by angle (keys on frames ${mid('r')} and ${mid('l')}): wrong-side ${ab.wrong}, flicker ${ab.flicker}; shown ${JSON.stringify(ab.shown)}`);
    expect(linesOf(a.ran, 'PHASE')).toEqual([]);
  }, SLOW);

  test('refusals by name: a phase that is not a step side, "phase" with "frames", a phase set competing with an angle set or with another of its side, and a run that reads no feet; controls run', () => {
    const pose = walk();
    const refused = (map: Record<string, unknown>, extra: string[] = []): string[] => {
      const c = setup({ rig: RIG, map, pose });
      const r = retarget(c, extra);
      expect(r.status).not.toBe(0);
      return fails(r);
    };
    expect(refused(mapOf(stepSet('step_l', 0, { phase: 'left' })))).toEqual(['FAIL  MAP_ALT_PHASE: set "step_l" "phase" is "left"; it is the stepping foot the set is drawn for, one of "left-step", "right-step" (left-step: the left foot is stepping; shown while the right foot supports)']);
    expect(refused(mapOf(stepSet('step_l', 0, { phase: 'left-step', frames: [[0, 10]] })))).toEqual(['FAIL  MAP_ALT_PHASE: set "step_l" names both "phase" and "frames"; a phase set shows on its supporting foot\'s spans, and a window would cut them — drop one']);
    expect(refused(mapOf(stepSet('step_l', 0, { phase: 'left-step' }), stepSet('step_r', 12)))).toEqual(['FAIL  PHASE_GROUP: set(s) "step_l" declare "phase" and compete with set(s) "step_r", which declare none (they switch a common slot or offset bone); a phase set shows on its supporting foot\'s spans and an angle set on its distance, and nothing decides between them — give every set of the group a "phase", or none']);
    expect(refused(mapOf(stepSet('step_l', 0, { phase: 'left-step' }), stepSet('step_r', 12, { phase: 'left-step' })))).toEqual(['FAIL  PHASE_GROUP: set(s) "step_l", "step_r" all declare "phase": "left-step" and compete (they switch a common slot or offset bone); one drawing shows per support span — keep one "left-step" set per group']);
    // No feet: a map whose chains end at no ankle reads no supports. The set draws an arm here (a leg chain would read the feet).
    const armSet = { name: 'arms', slots: { sleeve_r0: 'seg' }, chains: ['arm_r'], pose: { r_shoulder: [0, 0], r_elbow: [0, 10], r_wrist: [0, 20] }, phase: 'right-step' };
    const noLegs = { ...baseMap(), chains: baseChains().filter((x) => !x.name.startsWith('leg_')), alternates: [armSet] };
    const f = refused(noLegs);
    expect(f).toHaveLength(1);
    expect(f[0]).toStartWith('FAIL  PHASE_FEET: set(s) "arms" ("phase": "right-step") show by the supporting foot (left-step while the right foot supports), and this run reads no supports: reading the feet needs one chain ending at "r_ankle"');
    // Control: a phase pair beside an angle set that shares nothing with it runs.
    const c = setup({ rig: { ...RIG, extra: { ...RIG.extra, sleeve_r0: { up: att } } }, map: mapOf(stepSet('step_l', 0, { phase: 'left-step' }), stepSet('step_r', 12, { phase: 'right-step' }), { name: 'up', slots: { sleeve_r0: 'up' }, chains: ['arm_r'], pose: { r_shoulder: [0, 0], r_elbow: [0, -10], r_wrist: [0, -20] } }), pose });
    const ok = retarget(c);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
  }, SLOW);

  test('mutant: phase sets sent through the angle rule (the phase group\'s branch cut) miss the bar, and the first test is red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm286-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'switch.ts');
      const src = readFileSync(path, 'utf8');
      const from = '    if (group.some((a) => a.phase !== undefined)) {\n      const pick =';
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, '    if (group.length < 0) {\n      const pick ='));
      const c = setup({ rig: RIG, map: mapOf(stepSet('step_l', 0, { phase: 'left-step' }), stepSet('step_r', 12, { phase: 'right-step' })), pose: walk() });
      const report = join(c.dir, 'report.json');
      const ran = retarget(c, ['--report', report], join(d, 'cli.ts'));
      expect(ran.status).toBe(0);
      const b = bar(c, JSON.parse(readFileSync(report, 'utf8')) as Rep, SIDES_OF);
      console.log(`  #286 mutant "no phase branch": wrong-side ${b.wrong}, flicker ${b.flicker}; shown ${JSON.stringify(b.shown)}`);
      if (b.wrong === 0 && b.flicker === 0) throw new Error('mutant "no phase branch" survived: the angle rule met the phase bar');
      expect(b.wrong + b.flicker).toBeGreaterThan(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('#241: the head nod — a NOD line, a map switch, and a loop\'s nod read wrapped', () => {
  /** One gait cycle, frames; the sequence repeats it CYCLES times, at 24 fps (#242's walk in place). */
  const C = 24;
  const CYCLES = 7;
  const NN = C * CYCLES;
  /** #242's loop bars: cycle 1 against cycle N, degrees on the head's rotate key and world units on its nod. */
  const LOOP_DEG = 0.05;
  const LOOP_UNITS = 0.05;
  const headRig: NonNullable<RigOpts['bones']> = (b) => [
    ...b,
    { name: 'head_ctl', parent: 'neck', x: 0, y: 20 },
    { name: 'head', parent: 'head_ctl', x: 0, y: 0 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const headChain = (extra: Record<string, unknown> = {}) => ({ name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: ['eye_r>eye_l'], ...extra });
  const mapWith = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...baseMap(), chains: [...baseChains(), headChain(extra)] });
  const phase = (i: number): number => (2 * Math.PI * (i % C)) / C;
  /**
   * #242's walk in place, `clean --loop`ed: the hips still, the thighs swinging in opposition, the eyes bobbing 3 px
   * twice a cycle against a still neck (past the ±2% neck clamp once scaled, so the clamp acts and couples).
   * `inPlace: false` deletes the `travel` the loop wrote: a loop that is not declared in place — the one sequence that
   * reads the nod through its detrend window and the neck clamp while being a loop.
   */
  function walk(inPlace: boolean): Record<string, unknown> {
    const m: Motion = {
      ...BASE,
      n: NN,
      dt: 1 / 24,
      trunk: () => 90,
      ru: () => -100,
      rf: () => -95,
      lu: () => -80,
      lf: () => -85,
      rt: (i) => -90 + 20 * Math.sin(phase(i)),
      rs: (i) => -95 + 20 * Math.sin(phase(i)),
      lt: (i) => -90 - 20 * Math.sin(phase(i)),
      ls: (i) => -90 - 20 * Math.sin(phase(i)),
      hip: () => [0, 0],
    };
    const doc = poseDoc(m, (i, j) => {
      const bob = 3 * Math.sin(2 * phase(i));
      for (const e of ['r_eye', 'l_eye']) {
        const a = j[e]!.at as Pt;
        j[e] = { ...j[e], at: [a[0], a[1] + bob] };
      }
    });
    const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
    const c = clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture');
    expect(c.seq.travel).toBe('in-place');
    const out = JSON.parse(writePoseSequence(c.seq)) as Record<string, unknown>;
    if (!inPlace) delete out.travel;
    return out;
  }
  interface Read {
    ran: Ran;
    nod: string[];
    rot: number[];
    /** The head's translate keys, y (empty: no translate track). */
    ty: number[];
    /** The largest |cycle 1 − cycle N| over a cycle's frames: rotate (degrees) and nod (units). */
    loop: { rotate: number; nod: number };
  }
  function read(c: Case, cliPath = CLI): Read {
    const ran = retarget(c, [], cliPath);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    const tracks = motionOf(c.out).animations.dance!.tracks;
    // #275's closing key is checked separately from the NN frames the NOD line counts.
    const frameValues = (keys: Array<{ t: number; v: number[] }>, k: number): number[] => {
      expect(keys).toHaveLength(NN + 1);
      expect(keys.at(-1)!.v).toEqual(keys[0]!.v);
      return keys.slice(0, NN).map((x) => x.v[k]!);
    };
    const rot = frameValues(tracks.find((t) => t.bone === 'head' && t.property === 'rotate')!.keys, 0);
    const tr = tracks.find((t) => t.bone === 'head' && t.property === 'translate');
    const ty = tr === undefined ? [] : frameValues(tr.keys, 1);
    if (tr !== undefined) expect(tr.keys.every((x) => x.v[0] === 0)).toBe(true);
    let rotate = 0;
    let nod = 0;
    for (let k = 0; k < C; k++) {
      const last = (CYCLES - 1) * C + k;
      rotate = Math.max(rotate, Math.abs(wrap(rot[last]! - rot[k]!)));
      if (ty.length > 0) nod = Math.max(nod, Math.abs(ty[last]! - ty[k]!));
    }
    return { ran, nod: linesOf(ran, 'NOD'), rot, ty, loop: { rotate, nod } };
  }
  /** The figures a NOD line prints, read back out of it. */
  function figures(line: string): { lo: number; hi: number; frames: number; clamp: number | null; acted: number | null } {
    const num = (re: RegExp): number | null => {
      const m = re.exec(line);
      return m === null ? null : Number(m[1]);
    };
    const range = /translate y ([+-]\d+\.\d{3}) … ([+-]\d+\.\d{3}) units over (\d+) frame\(s\)/.exec(line);
    if (range === null) throw new Error(`NOD line has no range: ${line}`);
    return { lo: Number(range[1]), hi: Number(range[2]), frames: Number(range[3]), clamp: num(/clamp ±(\d+\.\d{3}) units/), acted: num(/acted on (\d+) frame\(s\)/) };
  }
  const show = (r: Read): string => `cycle 1 vs ${CYCLES}: rotate ${r.loop.rotate.toFixed(3)}°, nod ${r.loop.nod.toFixed(3)} units; ${r.nod[0]}`;

  test('a loop not declared in place: the window wraps, the clamp acts and couples, and cycle 1 is cycle N; the NOD line\'s figures are the written keys\'', () => {
    const c = setup({ rig: { bones: headRig }, map: mapWith(), pose: walk(false) });
    const r = read(c);
    console.log(`  #241 loop, not in place: ${show(r)}`);
    expect(r.nod).toHaveLength(1);
    expect(r.nod[0]).toContain('window ±12 frame(s) (0.5 s) running median, detrended, wrapped on the loop');
    expect(r.nod[0]).toContain('so the clamped nod is coupled in phase into bone "head"\'s rotate (+1.6°/unit) on every frame');
    const f = figures(r.nod[0]!);
    // The written keys say the same as the line: the range, the frame count, the clamp (the keys reach it).
    expect(r.ty).toHaveLength(NN);
    expect(f.frames).toBe(NN);
    expect(f.lo).toBeCloseTo(Math.min(...r.ty), 3);
    expect(f.hi).toBeCloseTo(Math.max(...r.ty), 3);
    expect(f.clamp).toBeCloseTo(0.02 * 20, 3);
    expect(Math.max(...r.ty.map(Math.abs))).toBeCloseTo(f.clamp!, 3);
    expect(f.acted!).toBeGreaterThan(0);
    // The bar: cycle 1 is cycle N, on the nod and on the rotate it is coupled into.
    expect(r.loop.rotate).toBeLessThan(LOOP_DEG);
    expect(r.loop.nod).toBeLessThan(LOOP_UNITS);
  }, SLOW);

  test('mutant: the window read cut at the ends on the loop (as before #241) opens the loop, and the test above is red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm241-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const src = readFileSync(path, 'utf8');
      const from = "opts.loop === true ? 'wrapped' : 'cut'";
      expect(src.split(from)).toHaveLength(2);
      writeFileSync(path, src.replace(from, "'cut'"));
      const c = setup({ rig: { bones: headRig }, map: mapWith(), pose: walk(false) });
      const m = read(c, join(d, 'cli.ts'));
      console.log(`  #241 mutant "cut": ${show(m)}`);
      expect(m.nod[0]).toContain('cut at the clip\'s ends');
      const red = m.loop.rotate >= LOOP_DEG || m.loop.nod >= LOOP_UNITS;
      if (!red) throw new Error('mutant "cut" survived: cycle 1 and cycle N agree with the window cut at the ends');
      expect(m.loop.nod).toBeGreaterThan(LOOP_UNITS);
      expect(m.loop.rotate).toBeGreaterThan(LOOP_DEG);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('"nod": false keys no translate and takes the coupling out of the head\'s rotate; the NOD line says so', () => {
    const on = read(setup({ rig: { bones: headRig }, map: mapWith(), pose: walk(false) }));
    const off = read(setup({ rig: { bones: headRig }, map: mapWith({ nod: false }), pose: walk(false) }));
    expect(off.ty).toEqual([]);
    expect(off.nod).toEqual(['NOD    none on bone "head" (chain "head", r_eye → l_eye): the chain declares "nod": false — no translate keyed, nothing coupled into its rotate']);
    // The coupling is exactly what was removed: on every frame, rotate(on) − rotate(off) = +1.6°/unit × the keyed nod.
    let worst = 0;
    for (let i = 0; i < NN; i++) worst = Math.max(worst, Math.abs(wrap(on.rot[i]! - off.rot[i]!) - 1.6 * on.ty[i]!));
    console.log(`  #241 switch: |rotate(on) − rotate(off) − 1.6 × nod| ≤ ${worst.toFixed(4)}°, coupling up to ${Math.max(...on.ty.map((y) => Math.abs(1.6 * y))).toFixed(3)}°`);
    expect(worst).toBeLessThan(0.003);
    expect(Math.max(...on.ty.map((y) => Math.abs(1.6 * y)))).toBeGreaterThan(0.5);
    // Control: "nod": true is the default.
    const yes = read(setup({ rig: { bones: headRig }, map: mapWith({ nod: true }), pose: walk(false) }));
    expect(yes.ty).toEqual(on.ty);
    expect(yes.rot).toEqual(on.rot);
  }, SLOW);

  test('in place: the NOD line names no window and no clamp, and cycle 1 is cycle N (#242 already reads it as a loop)', () => {
    const r = read(setup({ rig: { bones: headRig }, map: mapWith(), pose: walk(true) }));
    console.log(`  #241 in place: ${show(r)}`);
    expect(r.nod).toHaveLength(1);
    expect(r.nod[0]).toContain('window none (in-place): the baseline is frame 0, no clamp, nothing coupled');
    expect(r.nod[0]).not.toContain('clamp ±');
    const f = figures(r.nod[0]!);
    expect(f.lo).toBeCloseTo(Math.min(...r.ty), 3);
    expect(f.hi).toBeCloseTo(Math.max(...r.ty), 3);
    expect(r.loop.nod).toBeLessThan(LOOP_UNITS);
    expect(r.loop.rotate).toBeLessThan(LOOP_DEG);
  }, SLOW);

  const nodCases: Array<{ map: () => Record<string, unknown>; want: string }> = [
    { map: () => mapWith({ nod: 'off' }), want: 'MAP_NOD: chain "head" "nod" is the string \"off\"; it must be true or false (false keys no head nod and couples none into the head\'s rotate or the face pitch)' },
    { map: () => ({ ...baseMap(), chains: [...baseChains().map((ch) => (ch.name === 'arm_r' ? { ...ch, nod: false } : ch)), headChain()] }), want: 'MAP_NOD: chain "arm_r" has "nod" but its joints (r_shoulder → r_elbow → r_wrist) carry no eye line; the nod is read on the chain whose joints run r_eye → l_eye (or l_eye → r_eye), so "nod" belongs there or nowhere' },
  ];
  nodCases.forEach((nc, k) => {
    test(`map: MAP_NOD (${k + 1} of ${nodCases.length})`, () => {
      const c = setup({ rig: { bones: headRig }, map: nc.map(), pose: walk(false) });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toEqual([`FAIL  ${nc.want}`]);
      expect(existsSync(c.out)).toBe(false);
    }, SLOW);
  });
});

// --- the seam reading (#216) ----------------------------------------------------

describe('#216: the seam reading over the declared neighbour pairs, a reading and never a gate', () => {
  /**
   * A cut arm: `upperarm_r` on the upper arm drawn 90 units long so it runs
   * 20 units past the elbow over `forearm_r` — the overlap @rig-c/parts paints
   * at a cut joint — and `parts.json` beside `rig/`, as @rig-c/parts writes it,
   * declaring the two as one limb's consecutive segments. BASE bends the right
   * elbow from 5° to 50°, so the overlap swings clear of its partner.
   */
  const CUT: RigOpts = {
    extraSlots: [
      { name: 'upperarm_r', bone: 'sleeve_r0', attachment: 'long' },
      { name: 'forearm_r', bone: 'sleeve_r1', attachment: 'seg' },
    ],
    extra: { upperarm_r: { long: { image: 'long.png', x: 45, y: 0, rotation: 90 } }, forearm_r: { seg: { image: 'seg.png', x: 30, y: 0, rotation: 90 } } },
  };
  const limbParts = (parts: Array<Record<string, unknown>>) => ({ rig_size: [400, 600], parts });
  const ARM = [
    { name: 'upperarm_r', limb: { name: 'arm_r', segment: 0, of: 'handwear_r', bone: 'sleeve_r0' } },
    { name: 'forearm_r', limb: { name: 'arm_r', segment: 1, of: 'handwear_r', bone: 'sleeve_r1', joint: 'elbow' } },
    { name: 'torso' },
  ];
  const cutCase = (parts: unknown = limbParts(ARM)): Case => {
    const c = setup({ rig: CUT });
    const long = new Plate(20, 90);
    long.rect(0, 0, 20, 90, [80, 80, 200, 255]);
    long.writePng(join(c.rig, 'images', 'long.png'));
    if (parts !== null) writeFileSync(join(c.dir, 'parts.json'), JSON.stringify(parts, null, 2));
    return c;
  };
  type SeamRow = { pair: string; kind: string; frames: [number, number]; times: [number, number]; maxPx: number; domain: string };
  type PairRow = { pair: string; declared: string[]; status: string; opens: number[]; maxPx: number; underFloor: number[]; reason?: string };
  const reportOf = (c: Case): Record<string, unknown> => JSON.parse(readFileSync(c.out.replace(/\.json$/, '.report.json'), 'utf8')) as Record<string, unknown>;

  test('bar 1: --parts on a cut rig — seams present, every entry a span with frames and times, counted; held to rigc\'s own seam.json by the floor written again here', () => {
    const c = cutCase();
    const r = retarget(c, ['--parts', c.dir]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rep = reportOf(c);
    const seams = rep.seams as SeamRow[];
    const pairs = rep.seamPairs as PairRow[];
    expect(pairs.map((p) => [p.pair, p.status, p.declared])).toEqual([['upperarm_r|forearm_r', 'read', ['config.limbs.arm_r segment 1, joint "elbow"']]]);
    expect(seams.length).toBeGreaterThan(0);
    for (const s of seams) {
      expect(Object.keys(s).sort()).toEqual(['domain', 'frames', 'kind', 'maxPx', 'pair', 'times']);
      expect(s.domain).toBe('render');
      expect(['gap', 'ghost']).toContain(s.kind);
      expect(s.frames[1]).toBeGreaterThanOrEqual(s.frames[0]);
      expect(s.times[1]).toBeGreaterThanOrEqual(s.times[0]);
    }
    // The independent reading: rigc's own render --seam over the kept build, at the run's rate, with the
    // floor written out a second time here (more cells than the box's long side, in cells) and the spans
    // grouped by hand — not the code under test.
    const fps = (rep.render as { fps: number }).fps;
    const out = join(c.dir, 'seam-check');
    const g = spawnSync(process.execPath, [join(ROOT, 'node_modules', '@rig-c', 'core', 'bin', 'rigc'), 'render', '--candidate', c.build, '--animation', 'dance', '--seam', 'upperarm_r:forearm_r', '--fps', String(fps), '--out', out], { encoding: 'utf8' });
    expect(g.status).toBe(0);
    type Hit = { index: number; time: number; px: number; cell: number; box: number[] };
    const setDir = (JSON.parse(readFileSync(join(out, 'frames.json'), 'utf8')) as { sets: Array<{ dir: string; animation: string }> }).sets.find((x) => x.animation === 'dance')!.dir;
    const doc = JSON.parse(readFileSync(join(out, setDir, 'seam.json'), 'utf8')) as { pairs: Array<Record<'gap' | 'ghost', { frames: Hit[] }> & { opens: number[] }> };
    const want: Array<Omit<SeamRow, 'domain'>> = [];
    for (const kind of ['gap', 'ghost'] as const) {
      const over = doc.pairs[0]![kind].frames.filter((h) => h.px > Math.round(Math.max(h.box[2]! - h.box[0]!, h.box[3]! - h.box[1]!) / h.cell));
      for (const h of over) {
        const last = want[want.length - 1];
        if (last !== undefined && last.kind === kind && last.frames[1] === h.index - 1) {
          last.frames[1] = h.index;
          last.times[1] = h.time;
          last.maxPx = Math.max(last.maxPx, h.px);
        } else want.push({ pair: 'upperarm_r|forearm_r', kind, frames: [h.index, h.index], times: [h.time, h.time], maxPx: h.px });
      }
    }
    expect(seams.map(({ domain: _d, ...s }) => s)).toEqual(want);
    // The printed lines: one per span, then the count.
    const lines = linesOf(r, 'SEAM');
    expect(lines.filter((l) => l.startsWith('SEAM   pair "upperarm_r|forearm_r" ') && l.includes('over the one-cell floor'))).toHaveLength(seams.length);
    expect(lines[lines.length - 1]).toBe(`SEAM   ${seams.length} span(s) over 1 pair(s) at ${fps} fps — 1 of 1 declared pair(s) read; a reading, not a gate`);
    // Under the floor: the frames rigc names that no span reports, on the pair's row and its line.
    const named = doc.pairs[0]!.opens;
    expect(pairs[0]!.underFloor).toEqual(named.filter((f) => !pairs[0]!.opens.includes(f)));
    expect([...pairs[0]!.opens, ...pairs[0]!.underFloor].sort((x, y) => x - y)).toEqual(named);
  }, SLOW);

  test('the reading moves no byte: the motion and the build are the same with --parts as without, and only the report\'s seam rows differ', () => {
    const a = cutCase();
    const b = cutCase();
    expect(retarget(a, ['--parts', a.dir]).status).toBe(0);
    const rb = retarget(b);
    expect(rb.status).toBe(0);
    expect(readFileSync(a.out).equals(readFileSync(b.out))).toBe(true);
    expect(readFileSync(join(a.build, 'skeleton.json')).equals(readFileSync(join(b.build, 'skeleton.json')))).toBe(true);
    // Without --parts, no pair is declared, and the line says where the pairs are.
    expect(linesOf(rb, 'SEAM')).toEqual([`SEAM   no neighbour pair declared — a rig spec carries none and no --parts was named (${b.dir} holds parts.json: --parts ${b.dir} reads its limbs); seams: []`]);
    const [ra, rbRep] = [reportOf(a), reportOf(b)];
    expect(rbRep.seams).toEqual([]);
    expect(rbRep.seamPairs).toEqual([]);
    const strip = (x: Record<string, unknown>) => {
      const { seams: _s, seamPairs: _p, inputs: _i, ...rest } = x;
      return rest;
    };
    expect(strip(ra)).toEqual(strip(rbRep));
  }, SLOW);

  test('a pair whose part has no slot is not read and says so; parts.json without limbs declares none; neither changes the exit', () => {
    const c = cutCase(limbParts([ARM[0]!, { name: 'cuff_r', limb: { name: 'arm_r', segment: 1, joint: 'elbow' } }]));
    const r = retarget(c, ['--parts', join(c.dir, 'parts.json')]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SEAM')).toEqual([
      'SEAM   pair "upperarm_r|cuff_r": not read — part "cuff_r" has no slot of its name in the rig (a part is drawn by the slot of its name)',
      'SEAM   0 span(s) over 0 pair(s) at 8 fps — 0 of 1 declared pair(s) read; a reading, not a gate',
    ]);
    expect((reportOf(c).seamPairs as PairRow[])[0]).toMatchObject({ pair: 'upperarm_r|cuff_r', status: 'unread' });
    const none = cutCase(limbParts([{ name: 'torso' }]));
    const rn = retarget(none, ['--parts', none.dir]);
    expect(rn.status).toBe(0);
    expect(linesOf(rn, 'SEAM')).toEqual([`SEAM   no neighbour pair declared — ${join(none.dir, 'parts.json')} holds no limb segment below another (a part's "limb" record), so it declares no pair; seams: []`]);
  }, SLOW);

  test('--parts is an input: a missing path or a record that is not a limb is refused by name before any work', () => {
    const c = cutCase(limbParts([{ name: 'upperarm_r', limb: { name: 'arm_r', segment: -1 } }]));
    const r = retarget(c, ['--parts', c.dir]);
    expect(r.status).not.toBe(0);
    expect(fails(r)).toEqual([`FAIL  PARTS_JSON: ${join(c.dir, 'parts.json')} parts[0] ("upperarm_r") limb: expected { name: string, segment: integer ≥ 0, joint?: string }, found {"name":"arm_r","segment":-1}`]);
    const m = retarget(c, ['--parts', join(c.dir, 'nope')]);
    expect(fails(m)).toEqual([`FAIL  ARG_PATH: --parts ${join(c.dir, 'nope')} does not exist`]);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('bar 3, the mutant: the reading disabled — a report with no seams, or no seamPairs — is refused by the writer by name', () => {
    const c = cutCase();
    expect(retarget(c, ['--parts', c.dir]).status).toBe(0);
    const rep = reportOf(c);
    const map = readMap(readFileSync(c.map, 'utf8'), c.map);
    const clock = { frameTimes: rep.frameTimes as number[] };
    const inputs = rep.inputs as ReportInputs;
    const { seams: _s, ...noSeams } = rep;
    expect(() => writeReport(noSeams, map, clock, rep.render as RenderDomain, inputs)).toThrow('REPORT_SEAMS: seams: found no field');
    const { seamPairs: _p, ...noPairs } = rep;
    expect(() => writeReport(noPairs, map, clock, rep.render as RenderDomain, inputs)).toThrow('REPORT_SEAMS: seamPairs: found no field');
    // A row without its times is refused too: every entry carries frame and t.
    const rows = rep.seams as SeamRow[];
    const { times: _t, ...noTimes } = rows[0]!;
    expect(() => writeReport({ ...rep, seams: [noTimes] }, map, clock, rep.render as RenderDomain, inputs)).toThrow('REPORT_SEAMS: seams[0]');
    // The control: the run's own report, written again, passes the same writer.
    expect(() => writeReport(rep, map, clock, rep.render as RenderDomain, inputs)).not.toThrow();
  }, SLOW);
});

describe('#216: the one-cell floor, @rig-c/parts\' rule (rig-c/parts#503), by hand', () => {
  const hit = (px: number, w: number, h: number, cell = 1) => ({ px, cell, box: [0, 0, w * cell, h * cell] });
  test('a cell, a line and a scattered line are under it; a block and a thick cluster are over it', () => {
    expect(overFloor(hit(1, 1, 1))).toBe(false);
    expect(overFloor(hit(5, 5, 1))).toBe(false);
    expect(overFloor(hit(5, 15, 15))).toBe(false);
    expect(overFloor(hit(4, 2, 2))).toBe(true);
    expect(overFloor(hit(3, 2, 2, 0.5))).toBe(true);
  });
  test('the mutant: the floor removed reports every frame rigc names, so a one-cell crack becomes a span', () => {
    const doc = [{ a: 'x', b: 'y', status: 'read' as const, opens: [0, 1], gap: { frames: [{ index: 0, time: 0, ...hit(1, 1, 1) }, { index: 1, time: 0.1, ...hit(4, 2, 2) }] }, ghost: { frames: [] } }];
    const pairs = [{ pair: 'x|y', a: 'x', b: 'y', declared: ['d'] }];
    const floored = projectSeams(pairs, doc, new Map());
    expect(floored.seams).toEqual([{ pair: 'x|y', kind: 'gap', frames: [1, 1], times: [0.1, 0.1], maxPx: 4 }]);
    expect(floored.seamPairs[0]).toMatchObject({ opens: [1], underFloor: [0] });
    const floorless = projectSeams(pairs, doc.map((d) => ({ ...d, gap: { frames: d.gap.frames.map((h) => ({ ...h, px: 99 })) } })), new Map());
    expect(floorless.seams).toEqual([{ pair: 'x|y', kind: 'gap', frames: [0, 1], times: [0, 0.1], maxPx: 99 }]);
  });
  test('pairs: each limb\'s consecutive segments by segment, in either order once, a part with no limb declaring none', () => {
    const text = JSON.stringify({ parts: [
      { name: 'shin', limb: { name: 'leg', segment: 1, joint: 'knee' } },
      { name: 'foot', limb: { name: 'leg', segment: 2, joint: 'ankle' } },
      { name: 'thigh', limb: { name: 'leg', segment: 0 } },
      { name: 'hat' },
    ] });
    expect(readSeamPairs(text, 'p.json')).toEqual([
      { pair: 'thigh|shin', a: 'thigh', b: 'shin', declared: ['config.limbs.leg segment 1, joint "knee"'] },
      { pair: 'shin|foot', a: 'shin', b: 'foot', declared: ['config.limbs.leg segment 2, joint "ankle"'] },
    ]);
    expect(() => readSeamPairs(JSON.stringify({ parts: [{ name: 'a', limb: { name: 'l', segment: 0 } }, { name: 'b', limb: { name: 'l', segment: 0 } }] }), 'p.json')).toThrow('PARTS_JSON: p.json parts[1] ("b"): limb "l" segment 0 is already part "a"');
    expect(() => readSeamPairs('{}', 'p.json')).toThrow('PARTS_JSON');
  });
});

// --- #251: --reduce-keep-planted ---------------------------------------------

describe('#251: --reduce-keep-planted keeps the supporting leg chain dense on its support frames', () => {
  /** One gait cycle, frames; the walk repeats it CYCLES times, at 24 fps. */
  const C = 24;
  const CYCLES = 3;
  const NN = C * CYCLES;
  const phase = (i: number): number => (2 * Math.PI * (i % C)) / C;
  /**
   * A walk that travels: the thighs swinging ±20° a cycle in opposition, the swinging foot lifted up to 10 px, and the
   * hips carried forward in the picture by exactly what keeps the supporting ankle's x still (the lower foot supports;
   * a change of support takes the new one's x). Under --plant-feet each supporting ankle is held where it planted: one
   * support span per foot per half cycle, the body travelling over it.
   */
  function walk(): Record<string, unknown> {
    const m: Motion = {
      ...BASE,
      n: NN,
      dt: 1 / 24,
      trunk: (i) => 90 + 4 * Math.sin(2 * phase(i)),
      ru: (i) => -100 - 15 * Math.sin(phase(i)),
      rf: (i) => -80 - 15 * Math.sin(phase(i)) + 5 * Math.sin(2 * phase(i)),
      lu: (i) => -80 + 15 * Math.sin(phase(i)),
      lf: (i) => -100 + 15 * Math.sin(phase(i)) - 5 * Math.sin(2 * phase(i)),
      rt: (i) => -90 + 20 * Math.sin(phase(i)),
      rs: (i) => -95 + 20 * Math.sin(phase(i)),
      lt: (i) => -90 - 20 * Math.sin(phase(i)),
      ls: (i) => -90 - 20 * Math.sin(phase(i)),
      hip: () => [0, 0],
    };
    const lift = (i: number) => ({ r: 10 * Math.max(0, Math.cos(phase(i))), l: 10 * Math.max(0, -Math.cos(phase(i))) });
    const support = (i: number): 'r' | 'l' => (lift(i).r <= lift(i).l ? 'r' : 'l');
    const ankleX = (i: number, s: 'r' | 'l') => positions(m, i)[`${s}_ankle`]![0];
    const dx: number[] = [0];
    for (let i = 1; i < NN; i++) dx.push(dx[i - 1]! + ankleX(i - 1, support(i)) - ankleX(i, support(i)));
    return poseDoc(m, (i, j) => {
      for (const [name, at] of Object.entries(j)) {
        const a = at.at as Pt;
        j[name] = { ...at, at: [a[0] + dx[i]!, a[1] - (name === 'r_ankle' ? lift(i).r : name === 'l_ankle' ? lift(i).l : 0)] };
      }
    });
  }
  const WALK_FLAGS = ['--plant-feet'];

  /** #94's gait (the #47 fixture): knees bending toward the camera, scaled legs, the hip planted over them, the free left ankle 0.03 leg lengths up on frames 8–15 and planted by --stance. */
  const THIGH = -95;
  const SHIN = -97;
  const GN = 24;
  const bendF = (i: number): number => (i < 6 || i > 18 ? 1 : 1 - 0.15 * Math.sin(((i - 6) / 12) * Math.PI));
  const V = add(dir(THIGH, 80), dir(SHIN, 70));
  function gait(): Record<string, unknown> {
    const still: Motion = { ...BASE, n: GN, dt: 1 / 24, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };
    const pic = Math.hypot(V[0], V[1]);
    return poseDoc(still, (i, j) => {
      const f = bendF(i);
      const drop: Pt = [(1 - f) * V[0], (1 - f) * V[1]];
      for (const [name, at] of Object.entries(j)) {
        const a = at.at as Pt;
        if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
        j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
      }
      for (const s of ['r', 'l'] as const) {
        const hip = j[`${s}_hip`]!.at as Pt;
        const knee = add(hip, dir(THIGH, 80 * f));
        const ankle = add(knee, dir(SHIN, 70 * f));
        const lift = s === 'l' && i >= 8 && i <= 15 ? 0.03 * pic : 0;
        j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
        j[`${s}_ankle`] = { state: 'observed', at: [ankle[0], ankle[1] - lift], score: 0.9 };
      }
    });
  }
  const GAIT_FLAGS = ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'];

  interface Rep {
    frameTimes: number[];
    landings: Array<{ bone: string; kind: string; worst: number; frame: number; tolerance: number; on?: 'support' | 'off-support' }>;
    feet: { rigLeg: { r: number; l: number }; supports: Array<{ side: 'r' | 'l'; frames: [number, number] }>; reading: { plants: Array<{ horizontalLegs: number; verticalLegs: number }> } };
    reduce: null | { ankleDrift: Array<{ bone: string; side: 'r' | 'l'; plant: number; reduce: number; units: number; legLengths: number; support?: { reduce: number; units: number; legLengths: number } | null }> };
  }
  interface Read {
    ran: Ran;
    rep: Rep;
    ankle: { r: Pt[]; l: Pt[] };
    /** Rotate (and scalex) key times on each leg bone, by frame index. */
    keyed: Map<string, Set<number>>;
  }
  /** One run: its report, and its gated build posed by rig-c, read independently — each shin's tip on every frame. */
  function run(c: Case, extra: string[], cliPath = CLI): Read {
    const report = join(c.dir, 'report.json');
    const ran = retarget(c, [...extra, '--report', report], cliPath);
    if (ran.status !== 0) return { ran, rep: null as unknown as Rep, ankle: { r: [], l: [] }, keyed: new Map() };
    const rep = JSON.parse(readFileSync(report, 'utf8')) as Rep;
    const doc = loadBuild(c.build);
    const steps = rep.frameTimes.slice(1).map((t, i) => t - rep.frameTimes[i]!);
    const ankle: Read['ankle'] = { r: [], l: [] };
    for (const p of poseRawAnimation(doc, 'dance', steps, {}, 'animation')) {
      const b = byName(p.bones);
      for (const s of ['r', 'l'] as const) {
        const shin = b.get(`leg_${s}1`)!;
        ankle[s].push([shin.worldX + shin.a * 70, shin.worldY + shin.c * 70]);
      }
    }
    const keyed = new Map<string, Set<number>>();
    const frameOf = new Map(rep.frameTimes.map((t, i) => [Number(t.toFixed(6)), i]));
    for (const tr of motionOf(c.out).animations.dance!.tracks) {
      if (!['leg_r0', 'leg_r1', 'leg_l0', 'leg_l1'].includes(tr.bone) || (tr.property !== 'rotate' && tr.property !== 'scalex')) continue;
      keyed.set(`${tr.bone} ${tr.property}`, new Set(tr.keys.map((k) => frameOf.get(Number(k.t.toFixed(6))) ?? -1)));
    }
    return { ran, rep, ankle, keyed };
  }
  interface Figures {
    /** The supporting ankle against the dense run's, over every support frame: units. */
    max: number;
    p95: number;
    /** The same, in that side's rig leg at setup. */
    maxLegs: number;
    /** The posed build's own slide figure: the worst horizontal drift of a supporting ankle over a support span (the FEET line), leg lengths. */
    slide: number;
    /** The supporting ankle's largest move between two consecutive frames of one support span, leg lengths. */
    step: number;
  }
  function figures(dense: Read, x: Read): Figures {
    const errs: number[] = [];
    let maxLegs = 0;
    let step = 0;
    for (const s of dense.rep.feet.supports) {
      const leg = dense.rep.feet.rigLeg[s.side];
      for (let i = s.frames[0]; i <= s.frames[1]; i++) {
        const a = x.ankle[s.side][i]!;
        const d = dense.ankle[s.side][i]!;
        const e = Math.hypot(a[0] - d[0], a[1] - d[1]);
        errs.push(e);
        maxLegs = Math.max(maxLegs, e / leg);
        if (i > s.frames[0]) {
          const p = x.ankle[s.side][i - 1]!;
          step = Math.max(step, Math.hypot(a[0] - p[0], a[1] - p[1]) / leg);
        }
      }
    }
    errs.sort((p, q) => p - q);
    return { max: errs.at(-1)!, p95: errs[Math.min(errs.length - 1, Math.ceil(0.95 * errs.length) - 1)]!, maxLegs, slide: Math.max(...x.rep.feet.reading.plants.map((p) => p.horizontalLegs)), step };
  }
  const row = (name: string, f: Figures) => `  #251 ${name}: support-frame ankle vs dense max ${f.max.toExponential(3)} units (${f.maxLegs.toExponential(3)} leg lengths), p95 ${f.p95.toExponential(3)}; slide (FEET worst horizontal drift) ${f.slide.toFixed(5)} leg lengths; largest one-frame step ${f.step.toFixed(5)} leg lengths`;

  /** The public example, as the README's #240 figure runs it. */
  const WAVE_FLAGS = ['--leg-scale', '0.8,1.05', '--plant-feet'];
  function wave(): Case {
    const ex = join(ROOT, 'examples', 'wave');
    const dir = tempDir();
    return { dir, rig: join(ex, 'rig'), map: join(ex, 'map.json'), pose: join(ex, 'pose.json'), out: join(dir, 'motion.out.json'), build: join(dir, 'build') };
  }

  test('measured: the supporting ankle against the dense run on support frames, with and without --reduce', () => {
    for (const [name, mk, flags] of [['wave', wave, WAVE_FLAGS], ['walk', () => setup({ pose: walk() }), WALK_FLAGS], ['#94 gait', () => setup({ pose: gait() }), GAIT_FLAGS]] as const) {
      const c = mk();
      const dense = run(c, [...flags]);
      if (dense.ran.status !== 0) console.log(dense.ran.stderr.slice(0, 2000));
      expect(dense.ran.status).toBe(0);
      console.log(linesOf(dense.ran, "FEET").join("\n"));
      console.log(`  #251 ${name}: supports ${dense.rep.feet.supports.map((s) => `${s.side} ${s.frames[0]}–${s.frames[1]}`).join(', ')}; rig leg r ${dense.rep.feet.rigLeg.r.toFixed(2)}`);
      console.log(row(`${name} dense`, figures(dense, dense)));
      for (const extra of [['--reduce', '1'], ['--reduce', '1', '--reduce-hip', '0.5'], ['--reduce', '1', '--reduce-keep-planted'], ['--reduce', '1', '--reduce-hip', '0.5', '--reduce-keep-planted']]) {
        const red = run(c, [...flags, ...extra]);
        expect(red.ran.status).toBe(0);
        const keys = [...red.keyed].map(([k, v]) => `${k} ${v.size}`).join(', ');
        console.log(row(`${name} ${extra.join(' ')}`, figures(dense, red)) + `; leg keys ${keys}`);
        for (const l of linesOf(red.ran, 'REDUCE').filter((x) => x.includes('ankle drift'))) console.log(`    ${l}`);
      }
    }
  }, SLOW);

  const KEEP = ['--reduce', '1', '--reduce-keep-planted'];
  /** The supporting side's ankle on its support frames: the report's support row, and the independent worst against the dense run. */
  function held(dense: Read, x: Read): { rows: Rep['landings']; worst: number } {
    const rows = x.rep.landings.filter((l) => l.kind === 'foot' && l.on === 'support');
    return { rows, worst: figures(dense, x).max };
  }

  test('control: every support-span frame is keyed on each supporting leg bone, and the planted ankle lands as dense within the support tolerance', () => {
    for (const [name, pose, flags] of [['walk', walk(), WALK_FLAGS], ['#94 gait', gait(), GAIT_FLAGS]] as const) {
      const c = setup({ pose });
      const dense = run(c, [...flags]);
      expect(dense.ran.status).toBe(0);
      const x = run(c, [...flags, ...KEEP]);
      expect(x.ran.status).toBe(0);
      for (const s of x.rep.feet.supports) {
        for (const bone of [`leg_${s.side}0`, `leg_${s.side}1`]) {
          for (const prop of ['rotate', 'scalex']) {
            const keyed = x.keyed.get(`${bone} ${prop}`)!;
            for (let i = s.frames[0]; i <= s.frames[1]; i++) expect(keyed.has(i)).toBe(true);
          }
        }
      }
      const { rows, worst } = held(dense, x);
      // One support row per side that supports, held to the plant's own tolerance (no --reduce-hip).
      expect(new Set(rows.map((l) => l.bone))).toEqual(new Set(x.rep.feet.supports.map((s) => `leg_${s.side}1:tip`)));
      for (const l of rows) {
        expect(l.tolerance).toBeLessThan(0.03);
        expect(l.worst).toBeLessThanOrEqual(l.tolerance);
      }
      expect(worst).toBeLessThanOrEqual(Math.min(...rows.map((l) => l.tolerance)));
      // The drift line prints both figures, and the report carries the support one.
      expect(linesOf(x.ran, 'REDUCE').filter((l) => l.includes('on them, kept dense (--reduce-keep-planted)')).length).toBeGreaterThan(0);
      for (const d of x.rep.reduce!.ankleDrift) {
        if (d.support === undefined) throw new Error(`${name}: ${d.bone} has no support figure`);
        if (d.support !== null) expect(d.support.units).toBeLessThan(d.units);
      }
    }
  }, SLOW);

  test('without the flag the reduced bytes are origin/main\'s (the wave, pinned at 6ddcdb8), and the report has no support rows', () => {
    const PINNED: Array<[string[], string]> = [
      [['--leg-scale', '0.8,1.05', '--plant-feet', '--reduce', '0.5', '--reduce-hip', '0.5'], 'aafb26e64fb0ae4b4035a9e0eab880e3428bd58e7415f5c8dae9d53db35cd674'],
      [['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07', '--reduce', '1'], 'dd0d48176b0d2d81d07162fe24ed903be64cc2212a541722be5bd3133d2ddbe8'],
    ];
    for (const [flags, sha] of PINNED) {
      const c = wave();
      const report = join(c.dir, 'report.json');
      const ran = retarget(c, [...flags, '--report', report]);
      expect(ran.status).toBe(0);
      expect(createHash('sha256').update(readFileSync(c.out)).digest('hex')).toBe(sha);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Rep & { options: Record<string, unknown> };
      expect(rep.landings.some((l) => 'on' in l)).toBe(false);
      expect(rep.reduce!.ankleDrift.some((d) => 'support' in d)).toBe(false);
      expect('reduceKeepPlanted' in rep.options).toBe(false);
    }
  }, SLOW);

  test('refused by name without --reduce or without --plant-feet', () => {
    const c = setup({ pose: gait() });
    for (const [flags, missing] of [[['--plant-feet', '--reduce-keep-planted'], '--reduce;'], [['--reduce', '1', '--reduce-keep-planted'], '--plant-feet;'], [['--reduce-keep-planted'], '--reduce and --plant-feet;']] as const) {
      const r = retarget(c, [...flags]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--reduce-keep-planted is given without ${missing}`);
      expect(existsSync(c.out)).toBe(false);
    }
  });

  // The option dropped silently — parsed, but no frame kept — must make the support landing red, by name.
  const DROPS: Array<{ name: string; from: string; to: string }> = [
    { name: 'the support frames not added to keep', from: 'if (mapped.has(b)) add(b, ...frames);', to: 'if (mapped.has(b)) add(b);' },
    { name: 'the flag not passed to the reduction', from: 'reduceTracks(r, map, rest, a.reduce, a.reduceHip, a.reduceKeepPlanted === true)', to: 'reduceTracks(r, map, rest, a.reduce, a.reduceHip, false)' },
  ];
  for (const mu of DROPS) {
    test(`mutant: ${mu.name} — POSE_LANDS names the supporting ankle on its support frames`, () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'run.ts');
        const before = readFileSync(path, 'utf8');
        expect(before.split(mu.from)).toHaveLength(2);
        writeFileSync(path, before.replace(mu.from, mu.to));
        const c = setup({ pose: walk() });
        const ctl = run(c, [...WALK_FLAGS, ...KEEP]);
        expect(ctl.ran.status).toBe(0);
        const m = run(c, [...WALK_FLAGS, ...KEEP], join(d, 'cli.ts'));
        expect(m.ran.status).toBe(1);
        const miss = fails(m.ran).filter((l) => l.includes('POSE_LANDS') && /bone "leg_[rl]1:tip" ankle on its support frames \(kept dense\)/.test(l));
        expect(miss.length).toBeGreaterThan(0);
        console.log(`  mutant "${mu.name}": ${miss[0]!.slice(0, 220)}`);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }
});

describe('#285: an in-place run under --plant-feet --leg-scale — the planted heights repeat with the cycle, and a hand-over stays within the blend', () => {
  /** One stride, frames, at 24 fps; the sequence repeats it CYCLES times. Odd, so the two halves differ by a frame. */
  const C = 19;
  const CYCLES = 10;
  const NN = C * CYCLES;
  const DT = 1 / 24;
  /** The issue's bars: cycle 1 against cycle CYCLES within the landing check's origin tolerance; every printed shift under 0.05 leg lengths. */
  const LOOP_UNITS = ORIGIN_TOL;
  const SHIFT_LEGS = 0.05;
  /** The blend's bounds (`STANCE_BOUNDS`): a shift between neighbouring spans the incoming leg can take as a stretch of at most 0.08. */
  const BOUNDS: [number, number] = [0.92, 1.08];
  const phase = (i: number): number => (2 * Math.PI * (i % C)) / C;
  /** A side's swing weight on frame i: 0 on its supporting half, rising at once off the floor (√sin) on its swinging half. */
  const swing = (i: number, s: 'r' | 'l'): number => {
    const u = ((i % C) / C + (s === 'l' ? 0.5 : 0)) % 1;
    return u < 0.5 ? 0 : Math.sqrt(Math.sin((Math.PI * (u - 0.5)) / 0.5));
  };
  /**
   * A run in place, `clean --loop`ed: the thighs swinging ±20° a stride in opposition, the pelvis bobbing 2 px twice a
   * stride, and the swinging thigh drawn foreshortened to 1 − 0.45·w of its length (w = `swing`, the shin carried with
   * the knee), so the foot leaving the floor rises 0.08–0.12 leg lengths in the picture on its first frame off it — the
   * frame the other foot first reads 0.02 leg lengths lower, so support passes on it. No flight.
   */
  function runInPlace(): Record<string, unknown> {
    const m: Motion = {
      ...BASE,
      n: NN,
      dt: DT,
      trunk: () => 90,
      ru: () => -100,
      rf: () => -95,
      lu: () => -80,
      lf: () => -85,
      rt: (i) => -90 + 20 * Math.sin(phase(i)),
      rs: (i) => -95 + 20 * Math.sin(phase(i)),
      lt: (i) => -90 - 20 * Math.sin(phase(i)),
      ls: (i) => -90 - 20 * Math.sin(phase(i)),
      hip: (i) => [0, 2 * Math.cos(2 * phase(i))],
    };
    const doc = poseDoc(m, (i, j) => {
      for (const s of ['r', 'l'] as const) {
        const h = j[`${s}_hip`]!.at as Pt;
        const k = j[`${s}_knee`]!.at as Pt;
        const a = j[`${s}_ankle`]!.at as Pt;
        const f = 1 - 0.45 * swing(i, s);
        const k2: Pt = [h[0] + (k[0] - h[0]) * f, h[1] + (k[1] - h[1]) * f];
        j[`${s}_knee`] = { ...j[`${s}_knee`], at: k2 };
        j[`${s}_ankle`] = { ...j[`${s}_ankle`], at: [a[0] + k2[0] - k[0], a[1] + k2[1] - k[1]] };
      }
    });
    const seq = readPoseSequence(JSON.stringify(doc), 'fixture');
    const c = clean(seq, { loop: true, legs: 1, rest: 1 }, undefined, 'fixture');
    expect(c.seq.travel).toBe('in-place');
    return JSON.parse(writePoseSequence(c.seq)) as Record<string, unknown>;
  }
  interface Span {
    side: 'r' | 'l';
    frames: [number, number];
  }
  interface Rep {
    feet: {
      supports: Span[];
      jumps: unknown[];
      floor: number;
      shifts: Array<Span & { shift: number }>;
      blend: { runs: Array<Span & { k: { min: number; max: number } }>; over: unknown[] };
    };
  }
  interface Figures {
    /** The largest |planted height, cycle 1 − cycle CYCLES| over the spans starting on frames 1…C, and how many were matched. */
    loop: number;
    pairs: number;
    /** The largest |shift| between neighbouring spans, in the mean rig leg at setup. */
    step: number;
    /** Every printed per-span shift and the printed range, in leg lengths, as the FEET floor line says them. */
    printed: number[];
    range: number;
    /** The blend's stretch over every run, and the runs past its bounds. */
    k: { min: number; max: number };
    over: number;
    /** The hip's world y range, as rig-c poses the build. */
    hip: number;
  }
  function read(c: Case, extra: string[], cliPath = CLI): { ran: Ran; rep: Rep; floor: string; f: Figures } {
    const report = join(c.dir, `report${extra.join('')}.json`);
    const ran = retarget(c, ['--plant-feet', '--report', report, ...extra], cliPath);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as Rep;
    const floor = linesOf(ran, 'FEET').find((l) => l.startsWith('FEET   floor: '))!;
    const legs = /thigh origin → ankle, r (\d+\.\d), l (\d+\.\d) units/.exec(floor)!;
    const leg = (Number(legs[1]) + Number(legs[2])) / 2;
    const hs = rep.feet.shifts.map((s) => ({ ...s, h: rep.feet.floor - s.shift }));
    let loop = 0;
    let pairs = 0;
    for (const a of hs) {
      if (a.frames[0] < 1 || a.frames[0] > C) continue;
      const b = hs.find((x) => x.side === a.side && x.frames[0] === a.frames[0] + (CYCLES - 1) * C);
      if (b === undefined) continue;
      pairs++;
      loop = Math.max(loop, Math.abs(b.h - a.h));
    }
    let step = 0;
    for (let k = 0; k + 1 < hs.length; k++) step = Math.max(step, Math.abs(hs[k + 1]!.shift - hs[k]!.shift) / leg);
    const printed = [...floor.matchAll(/ \(([−+]\d+\.\d{4})\)/g)].map((m) => Math.abs(Number(m[1]!.replace('−', '-'))));
    const range = Number(/ = (\d+\.\d{4}) leg lengths$/.exec(floor)![1]);
    const ks = rep.feet.blend.runs.flatMap((x) => [x.k.min, x.k.max]);
    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: NN - 1 }, () => DT), {}, 'animation');
    const hip = poses.map((p) => byName(p.bones).get('hip')!.worldY);
    return {
      ran,
      rep,
      floor,
      f: { loop, pairs, step, printed, range, k: { min: Math.min(...ks), max: Math.max(...ks) }, over: rep.feet.blend.over.length, hip: Math.max(...hip) - Math.min(...hip) },
    };
  }
  const show = (f: Figures): string =>
    `cycle 1 vs ${CYCLES} planted heights |Δ| ≤ ${f.loop.toFixed(4)} units (${f.pairs} spans); neighbouring shifts differ ≤ ${f.step.toFixed(4)} L; printed shifts ≤ ${Math.max(...f.printed).toFixed(4)} L, range ${f.range.toFixed(4)} L; blend k ${f.k.min.toFixed(4)}–${f.k.max.toFixed(4)}, ${f.over} past the bounds; hip y range ${f.hip.toFixed(2)} units`;
  /** Bars (1) and (2), against one run's figures. */
  function holds(f: Figures): boolean {
    return f.pairs === 2 && f.loop < LOOP_UNITS && f.step < BOUNDS[1] - 1 && f.over === 0 && f.k.min >= BOUNDS[0] && f.k.max <= BOUNDS[1] && f.printed.every((x) => x < SHIFT_LEGS) && f.range < SHIFT_LEGS;
  }

  test('the planted heights of cycle 1 are cycle 10\'s, every hand-over within the blend, every printed shift under 0.05 leg lengths — at the clamp 0.4 and 0.8 alike; control: without --leg-scale the same, and the hip\'s range is the control\'s', () => {
    const c = setup({ pose: runInPlace() });
    const plain = read(c, []);
    console.log(`  #285 run in place, no --leg-scale: ${show(plain.f)}`);
    expect(plain.rep.feet.jumps).toEqual([]);
    // One support span per foot per stride, alternating, plus the seam's: 2 × CYCLES + 1.
    expect(plain.rep.feet.supports).toHaveLength(2 * CYCLES + 1);
    expect(holds(plain.f)).toBe(true);
    for (const clamp of ['0.4,1.05', '0.8,1.05']) {
      const r = read(c, ['--leg-scale', clamp]);
      console.log(`  #285 run in place, --leg-scale ${clamp}: ${show(r.f)}`);
      expect(r.rep.feet.supports).toEqual(plain.rep.feet.supports);
      // Bar (1): periodic, and each hand-over's one-floor shift a stretch the blend can take.
      expect(r.f.pairs).toBe(2);
      expect(r.f.loop).toBeLessThan(LOOP_UNITS);
      expect(r.f.step).toBeLessThan(BOUNDS[1] - 1);
      expect(r.rep.feet.blend.over).toEqual([]);
      expect(r.f.k.min).toBeGreaterThanOrEqual(BOUNDS[0]);
      expect(r.f.k.max).toBeLessThanOrEqual(BOUNDS[1]);
      expect(linesOf(r.ran, 'FEET').filter((l) => l.startsWith('FEET   past the bounds'))).toEqual([]);
      // Bar (2): the FEET floor line prints every span's shift, and their range, under 0.05 leg lengths.
      expect(r.f.printed).toHaveLength(2 * CYCLES + 1);
      expect(Math.max(...r.f.printed)).toBeLessThan(SHIFT_LEGS);
      expect(r.f.range).toBeLessThan(SHIFT_LEGS);
      // The hip moves as the control's: the hand-over no longer bounces it.
      expect(Math.abs(r.f.hip - plain.f.hip)).toBeLessThan(0.01 * plain.f.hip);
    }
  }, SLOW);

  test('mutants: the outgoing plant posed at its hand-over frame\'s scale steps the floor every hand-over past the blend; the heights left unclosed drift by the cycle; each makes the test above red', () => {
    const muts: Array<{ name: string; file: string; from: string; to: string; extra: string[] }> = [
      {
        name: 'the outgoing leg at the hand-over frame\'s scale',
        file: 'retarget.ts',
        from: 'const held = legScaleOn ? (i: number, s: Side, at: number) => tipOf(rest, poseLegsWith(i, askedScales, at), ankleBone(s)) : undefined;',
        to: 'const held = legScaleOn ? (i: number, s: Side) => tipOf(rest, poseLegsWith(i, askedScales), ankleBone(s)) : undefined;',
        extra: ['--leg-scale', '0.4,1.05'],
      },
      {
        name: 'the heights not closed',
        file: 'legs.ts',
        from: 'const heights = follow === undefined ? (read as number[]) : closeHeights(read as number[], feet.supports);',
        to: 'const heights = read as number[];',
        extra: [],
      },
    ];
    mkdirSync(MUTANTS, { recursive: true });
    for (const mu of muts) {
      const d = mkdtempSync(join(MUTANTS, 'm285-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', mu.file);
        const src = readFileSync(path, 'utf8');
        expect(src.split(mu.from)).toHaveLength(2);
        writeFileSync(path, src.replace(mu.from, mu.to));
        const c = setup({ pose: runInPlace() });
        const m = read(c, mu.extra, join(d, 'cli.ts'));
        console.log(`  #285 mutant "${mu.name}": ${show(m.f)}`);
        if (holds(m.f)) throw new Error(`mutant "${mu.name}" survived: ${show(m.f)}`);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  }, SLOW);
});

describe('#279: the runs --switch-min suppressed are reported, per set, with their frames and lengths', () => {
  /** 30 fps: two sets whose key skeletons the right arm meets for 4 frames each (0.133 s), under the default 0.25 s. */
  const FPS30 = 30;
  const KEY_UP: [number, number] = [150, 170];
  const KEY_OUT: [number, number] = [60, 80];
  const UP_ON: [number, number] = [8, 11];
  const OUT_ON: [number, number] = [24, 27];
  const inRun = (i: number, r: [number, number]) => i >= r[0] && i <= r[1];
  const motion: Motion = {
    ...BASE,
    n: 40,
    dt: 1 / FPS30,
    trunk: () => 90,
    hip: () => [0, 0],
    ru: (i) => (inRun(i, UP_ON) ? KEY_UP[0] : inRun(i, OUT_ON) ? KEY_OUT[0] : 30),
    rf: (i) => (inRun(i, UP_ON) ? KEY_UP[1] : inRun(i, OUT_ON) ? KEY_OUT[1] : 50),
  };
  const keySkeleton = ([ru, rf]: [number, number]): Record<string, Pt> => {
    const sh: Pt = [1000, 1000];
    const el = add(sh, dir(ru, 300));
    return { r_shoulder: sh, r_elbow: el, r_wrist: add(el, dir(rf, 250)) };
  };
  const RIG: RigOpts = { extra: { sleeve_r0: { seg_up: { image: 'seg.png', x: 30, y: 0, rotation: -90 }, seg_out: { image: 'seg.png', x: 30, y: 0, rotation: 0 } } } };
  const map = (): Record<string, unknown> => ({
    ...baseMap(),
    alternates: [
      { name: 'up', slots: { sleeve_r0: 'seg_up' }, chains: ['arm_r'], pose: keySkeleton(KEY_UP) },
      { name: 'out', slots: { sleeve_r0: 'seg_out' }, chains: ['arm_r'], pose: keySkeleton(KEY_OUT) },
    ],
  });
  interface RunsRow { set: string; nearest: Array<Record<string, unknown>>; suppressed: Array<Record<string, unknown>> }
  const reportOf = (path: string): { options: { switchMin: number }; switches: Array<{ set: string; frames: number[] }>; switchRuns: RunsRow[] } => JSON.parse(readFileSync(path, 'utf8'));
  // The report's times are the motion's key times (rounded to 1e-6 s at the writer).
  const run4 = (r: [number, number]) => ({ frames: r, count: 4, seconds: 0.133 });

  test('at the default 0.25 s: neither set shows, and SWITCH-MIN and switchRuns name both sets\' 4-frame runs (0.133 s)', () => {
    const c = setup({ rig: RIG, map: map(), pose: poseDoc(motion) });
    try {
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'SWITCH')).toEqual(['SWITCH none — no set within 25° of the pose for 0.25s']);
      expect(linesOf(r, 'SWITCH-MIN')).toEqual([
        'SWITCH-MIN set "up": 1 run(s) shorter than --switch-min 0.25s not shown: frames 8–11 (4 frames, 0.133s); nearest on 1 run(s), the longest frames 8–11 (4 frames, 0.133s)',
        'SWITCH-MIN set "out": 1 run(s) shorter than --switch-min 0.25s not shown: frames 24–27 (4 frames, 0.133s); nearest on 1 run(s), the longest frames 24–27 (4 frames, 0.133s)',
      ]);
      const rep = reportOf(report);
      expect(rep.options.switchMin).toBe(0.25);
      expect(rep.switches).toEqual([]);
      expect(rep.switchRuns.map((s) => s.set)).toEqual(['up', 'out']);
      expect(rep.switchRuns[0]!.nearest).toEqual([{ ...run4(UP_ON), times: [0.266667, 0.366667], spanSeconds: 0.133 }]);
      expect(rep.switchRuns[0]!.suppressed).toEqual([{ ...run4(UP_ON), times: [0.266667, 0.366667], spanSeconds: 0.133 }]);
      expect(rep.switchRuns[1]!.nearest).toEqual([{ ...run4(OUT_ON), times: [0.8, 0.9], spanSeconds: 0.133 }]);
      expect(rep.switchRuns[1]!.suppressed).toEqual([{ ...run4(OUT_ON), times: [0.8, 0.9], spanSeconds: 0.133 }]);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  }, SLOW);

  test('control: at --switch-min 0.1 both sets show on those frames, nothing is suppressed and no SWITCH-MIN line prints', () => {
    const c = setup({ rig: RIG, map: map(), pose: poseDoc(motion) });
    try {
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report, '--switch-min', '0.1']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'SWITCH').map((l) => l.split(';').slice(0, 3).join(';'))).toEqual([
        'SWITCH set "up" — shows "sleeve_r0" = "seg_up"; chains arm_r; frames 8–11 (t=0.267s until 0.400s) — distance max 0.0°, median 0.0°',
        'SWITCH set "out" — shows "sleeve_r0" = "seg_out"; chains arm_r; frames 24–27 (t=0.800s until 0.933s) — distance max 0.0°, median 0.0°',
      ]);
      expect(linesOf(r, 'SWITCH-MIN')).toEqual([]);
      const rep = reportOf(report);
      expect(rep.options.switchMin).toBe(0.1);
      expect(rep.switches.map((s) => [s.set, s.frames])).toEqual([['up', UP_ON], ['out', OUT_ON]]);
      expect(rep.switchRuns.map((s) => [s.set, s.nearest.map((x) => x.frames), s.suppressed])).toEqual([['up', [UP_ON], []], ['out', [OUT_ON], []]]);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  }, SLOW);
});

// --- #283: --reduce <deg>,<chain>=<deg> ---------------------------------------

describe('#283: a per-chain --reduce holds the legs against slide while the trunk is smoothed', () => {
  /**
   * The public walk (examples/walk) made to travel: its cycle three times (72 frames at 24 fps), each swinging ankle
   * 12 px fore and aft (its knee half that), and every joint carried by what keeps the lower ankle's x still. Cleaned
   * with legs 5, rest 7, the hold off, no loop. On the wave's rig with the walk's map, its trunk given `reach` — which
   * carries 2.00× the pair's jitter (#236) — one global tolerance cannot pass slide ≤ 0.005 and jitter ≤ 1.1 together.
   */
  function travellingWalk(): Record<string, unknown> {
    const base = walkCycle();
    const P = base.length;
    const frames = Array.from({ length: 3 * P }, (_, i) => {
      const j = { ...base[i % P]!.joints };
      const fwd = 12 * Math.cos((2 * Math.PI * (i % P)) / P);
      j.r_ankle = [j.r_ankle![0] + fwd, j.r_ankle![1]];
      j.l_ankle = [j.l_ankle![0] - fwd, j.l_ankle![1]];
      j.r_knee = [j.r_knee![0] + fwd / 2, j.r_knee![1]];
      j.l_knee = [j.l_knee![0] - fwd / 2, j.l_knee![1]];
      return { ...base[i % P]!, joints: j };
    });
    const lower = (i: number): 'r' | 'l' => (frames[i]!.joints.r_ankle![1] >= frames[i]!.joints.l_ankle![1] ? 'r' : 'l');
    const dx: number[] = [0];
    for (let i = 1; i < frames.length; i++) dx.push(dx[i - 1]! + frames[i - 1]!.joints[`${lower(i)}_ankle`]![0] - frames[i]!.joints[`${lower(i)}_ankle`]![0]);
    for (let i = 0; i < frames.length; i++) {
      const j = frames[i]!.joints;
      for (const n of Object.keys(j)) j[n] = [j[n]![0] + dx[i]!, j[n]![1]];
    }
    const doc = walkDoc(frames, 'synthetic: examples/walk travelling, test/retarget.test.ts #283');
    const c = clean(readPoseSequence(JSON.stringify(doc), 'fixture'), { loop: false, legs: 5, rest: 7, hold: 'off' }, undefined, 'fixture');
    return JSON.parse(writePoseSequence(c.seq)) as Record<string, unknown>;
  }
  function walkCase(): Case {
    const dir = tempDir();
    const map = JSON.parse(readFileSync(join(ROOT, 'examples', 'walk', 'map.json'), 'utf8')) as { chains: Array<Record<string, unknown>> };
    map.chains.find((c) => c.name === 'trunk')!.reach = true;
    writeFileSync(join(dir, 'map.json'), JSON.stringify(map, null, 2));
    writeFileSync(join(dir, 'pose.json'), JSON.stringify(travellingWalk()));
    return { dir, rig: join(ROOT, 'examples', 'wave', 'rig'), map: join(dir, 'map.json'), pose: join(dir, 'pose.json'), out: join(dir, 'motion.out.json'), build: join(dir, 'build') };
  }
  const FLAGS = ['--plant-feet', '--leg-scale', '0.8,1.05'];
  const PER_CHAIN = ['--reduce', '3,leg_r=0.2,leg_l=0.2'];
  interface Rep {
    options: Record<string, unknown>;
    landings: Array<{ bone: string; kind: string; worst: number; tolerance: number }>;
    jitter: Array<{ bone: string; ratio: number | null }>;
    feet: { reading: { plants: Array<{ horizontalLegs: number }> } };
    reduce: null | { tolerance: number; chains?: Record<string, number>; ankleDrift: Array<{ bone: string; legTolerance?: number }> };
  }
  function run(c: Case, extra: string[], cliPath = CLI): { ran: Ran; rep: Rep; slide: number; jitter: number } {
    const report = join(c.dir, 'report.json');
    const ran = retarget(c, [...FLAGS, ...extra, '--report', report], cliPath);
    if (ran.status !== 0) return { ran, rep: null as unknown as Rep, slide: NaN, jitter: NaN };
    const rep = JSON.parse(readFileSync(report, 'utf8')) as Rep;
    return { ran, rep, slide: Math.max(...rep.feet.reading.plants.map((p) => p.horizontalLegs)), jitter: Math.max(...rep.jitter.map((j) => j.ratio ?? 0)) };
  }
  const passes = (x: { slide: number; jitter: number }) => x.slide <= 0.005 && x.jitter <= 1.1;

  test('the trade: no global tolerance passes both bars, with or without --reduce-keep-planted; the per-chain one does', () => {
    const c = walkCase();
    const rows: Array<[string, string[]]> = [
      ['global 0.2', ['--reduce', '0.2']],
      ['global 3', ['--reduce', '3']],
      ['keep-planted 0.2', ['--reduce', '0.2', '--reduce-keep-planted']],
      ['keep-planted 3', ['--reduce', '3', '--reduce-keep-planted']],
      ['per-chain 3,leg_r=0.2,leg_l=0.2', PER_CHAIN],
    ];
    const got = new Map<string, { slide: number; jitter: number }>();
    for (const [name, extra] of rows) {
      const x = run(c, extra);
      expect(x.ran.status).toBe(0);
      got.set(name, x);
      console.log(`  #283 ${name}: slide (FEET worst horizontal drift) ${x.slide.toFixed(4)} leg lengths, jitter (worst JITTER ratio) ${x.jitter.toFixed(2)}`);
    }
    // Global: the tight tolerance holds the ankle but leaves the reach trunk's jitter; the loose one smooths it and slides.
    expect(got.get('global 0.2')!.slide).toBeLessThanOrEqual(0.005);
    expect(got.get('global 0.2')!.jitter).toBeGreaterThan(1.1);
    expect(got.get('global 3')!.jitter).toBeLessThanOrEqual(1.1);
    expect(got.get('global 3')!.slide).toBeGreaterThan(0.005);
    // #251 holds the ankle at every tolerance but cannot smooth the trunk without seaming the supporting leg.
    expect(got.get('keep-planted 0.2')!.jitter).toBeGreaterThan(1.1);
    expect(got.get('keep-planted 3')!.jitter).toBeGreaterThan(1.1);
    for (const name of ['global 0.2', 'global 3', 'keep-planted 0.2', 'keep-planted 3']) expect(passes(got.get(name)!)).toBe(false);
    expect(passes(got.get('per-chain 3,leg_r=0.2,leg_l=0.2')!)).toBe(true);
  }, SLOW);

  test('the run names each chain held tighter, and its LAND lines and ankle allowance follow that chain', () => {
    const c = walkCase();
    const x = run(c, PER_CHAIN);
    expect(x.ran.status).toBe(0);
    expect(x.ran.stdout).toContain('reduce 3° (chain "leg_r" 0.2°, chain "leg_l" 0.2°)');
    expect(linesOf(x.ran, 'REDUCE').filter((l) => l.startsWith('REDUCE rotate keys'))[0]).toContain('within 3° (chain "leg_r" 0.2°, chain "leg_l" 0.2°)');
    for (const b of ['leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
      expect(linesOf(x.ran, 'REDUCE').some((l) => l.startsWith(`REDUCE bone "${b}" rotate:`) && l.endsWith(`— within its chain's 0.2°`))).toBe(true);
      const land = x.rep.landings.find((l) => l.bone === b && l.kind === 'angle')!;
      expect(land.tolerance).toBe(0.21);
      expect(land.worst).toBeLessThanOrEqual(0.21);
    }
    for (const b of ['chest', 'head', 'sleeve_r0']) expect(x.rep.landings.find((l) => l.bone === b && l.kind === 'angle')!.tolerance).toBe(3.01);
    expect(linesOf(x.ran, 'REDUCE').filter((l) => l.includes('its leg reduced within 0.2°'))).toHaveLength(2);
    expect(x.rep.reduce!.ankleDrift.map((d) => d.legTolerance)).toEqual([0.2, 0.2]);
    expect(x.rep.reduce!.chains).toEqual({ leg_r: 0.2, leg_l: 0.2 });
    expect(x.rep.options.reduceChains).toEqual({ leg_r: 0.2, leg_l: 0.2 });
    // Without it, neither key is written, and a chain at the run's own tolerance writes the run's keys.
    const g = run(c, ['--reduce', '3']);
    expect(g.ran.status).toBe(0);
    expect('chains' in g.rep.reduce!).toBe(false);
    expect('reduceChains' in g.rep.options).toBe(false);
    expect(g.rep.reduce!.ankleDrift.some((d) => 'legTolerance' in d)).toBe(false);
    const motion = readFileSync(c.out);
    const same = run(c, ['--reduce', '3,leg_r=3']);
    expect(same.ran.status).toBe(0);
    expect(readFileSync(c.out).equals(motion)).toBe(true);
  }, SLOW);

  test('refused by name: a chain the map lacks, a malformed item, a tolerance out of range, a chain twice', () => {
    const c = walkCase();
    const r = retarget(c, [...FLAGS, '--reduce', '3,legs=0.2']);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.includes('POSE_REDUCE: --reduce names chain "legs"') && l.includes('its chains are "trunk", "head", "arm_r", "arm_l", "leg_r", "leg_l"'))).toBe(true);
    for (const [v, text] of [
      ['3,leg_r', '"leg_r" is not <chain>=<deg>'],
      ['3,leg_r=0', 'chain "leg_r" is "0", and it must be degrees in (0, 180)'],
      ['3,leg_r=180', 'chain "leg_r" is "180"'],
      ['x,leg_r=1', 'its first item "x" must be degrees in (0, 180)'],
      ['3,leg_r=1,leg_r=2', 'chain "leg_r" is given twice'],
    ] as const) {
      const u = retarget(c, [...FLAGS, '--reduce', v]);
      expect(u.status).toBe(2);
      expect(u.stderr).toContain(text);
    }
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  // The chains' tolerances parsed and printed but not handed to the reduction: the legs thinned within 3° must miss their 0.21° LAND, by name.
  test('mutant: the chain tolerance not passed to the reduction — POSE_LANDS names a leg bone against its chain\'s tolerance', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'run.ts');
      const from = 'const own = (b: string): { tolerance?: number } => (tolOf(b) === tolerance ? {} : { tolerance: tolOf(b) });';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const own = (_b: string): { tolerance?: number } => ({});'));
      const c = walkCase();
      expect(run(c, PER_CHAIN).ran.status).toBe(0);
      const m = run(c, PER_CHAIN, join(d, 'cli.ts'));
      expect(m.ran.status).toBe(1);
      const miss = fails(m.ran).filter((l) => l.includes('POSE_LANDS') && /bone "leg_[rl][01]" aim .* the tolerance is 0\.21°/.test(l));
      expect(miss.length).toBeGreaterThan(0);
      console.log(`  mutant "#283 chain tolerance dropped": ${miss[0]!.slice(0, 200)}`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

describe('face and body dial sliders (rig-c/pose#454)', () => {
  function dialRigOpts(): RigOpts {
    return {
      bones: (bs) => [
        ...bs,
        { name: 'head', parent: 'neck', x: 0, y: 20 },
        { name: 'yaw_dial', parent: 'root', x: 0, y: 0 },
        { name: 'pitch_dial', parent: 'root', x: 0, y: 0 },
        { name: 'body_yaw_dial', parent: 'root', x: 0, y: 0 },
      ],
      constraints: [
        {
          name: 'yaw',
          type: 'slider',
          animation: 'turn',
          bone: 'yaw_dial',
          property: 'rotate',
          from: -15,
          to: 0,
          scale: 0.0625,
          local: true,
          additive: true,
          mix: 1,
        },
        {
          name: 'pitch',
          type: 'slider',
          animation: 'tilt',
          bone: 'pitch_dial',
          property: 'rotate',
          from: -12,
          to: 0,
          scale: 0.0625,
          local: true,
          additive: true,
          mix: 1,
        },
        {
          name: 'body_yaw',
          type: 'slider',
          animation: 'body_turn',
          bone: 'body_yaw_dial',
          property: 'rotate',
          from: -20,
          to: 0,
          scale: 0.0625,
          local: true,
          additive: true,
          mix: 1,
        },
      ],
      motion: {
        spec: 'rigc-motion/1',
        archetype: 'stick',
        cut: 'stick',
        easings: {},
        animations: {
          turn: {
            duration: 1.875,
            loop: false,
            tracks: [
              {
                bone: 'head',
                property: 'translate',
                keys: [
                  { t: 0, v: [-6, 0] },
                  { t: 0.9375, v: [0, 0] },
                  { t: 1.875, v: [6, 0] },
                ],
              },
            ],
          },
          tilt: {
            duration: 1.5,
            loop: false,
            tracks: [
              {
                bone: 'head',
                property: 'translate',
                keys: [
                  { t: 0, v: [0, 5] },
                  { t: 0.75, v: [0, 0] },
                  { t: 1.5, v: [0, -5] },
                ],
              },
            ],
          },
          body_turn: {
            duration: 2.5,
            loop: false,
            tracks: [
              {
                bone: 'chest',
                property: 'translate',
                keys: [
                  { t: 0, v: [-4, 0] },
                  { t: 1.25, v: [0, 0] },
                  { t: 2.5, v: [4, 0] },
                ],
              },
            ],
          },
        },
      },
    };
  }

  function fourWayTurnPose(scale = 1): Record<string, unknown> {
    const N = 25;
    const DT = 1 / 24;
    const m: Motion = { ...BASE, n: N, dt: DT, hip: () => [0, 0], trunk: () => 90, rt: () => -90, rs: () => -90, lt: () => -90, ls: () => -90 };
    return poseDoc(m, (i, j) => {
      const neck = (j.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      const dEye = 12;
      const dEar = 24;
      j.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      j.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      j.r_ear = { state: 'observed', at: [midEye[0] - dEar / 2, midEye[1] + 5], score: 0.95 };
      j.l_ear = { state: 'observed', at: [midEye[0] + dEar / 2, midEye[1] + 5], score: 0.95 };

      // Segments of 5 frames:
      // 0..4: neutral (yaw 0°, pitch 0°, body 0°)
      // 5..9: turn left (yaw -12° * scale, body -45°)
      // 10..14: turn right (yaw +12° * scale, body +45°)
      // 15..19: pitch up (pitch -9° * scale)
      // 20..24: pitch down (pitch +9° * scale)
      const rawYaw = i >= 5 && i <= 9 ? -12 * scale : i >= 10 && i <= 14 ? 12 * scale : 0;
      const rawPitch = i >= 15 && i <= 19 ? -9 * scale : i >= 20 && i <= 24 ? 9 * scale : 0;
      const ty = Math.tan(rawYaw * RAD);
      const tp = Math.tan(rawPitch * RAD);
      j.nose = { state: 'observed', at: [midEye[0] - (ty * dEye) / 1.25, midEye[1] + 5 + tp * dEye], score: 0.95 };

      const bDeg = i >= 5 && i <= 9 ? -45 * scale : i >= 10 && i <= 14 ? 45 * scale : 0;
      const c = Math.cos(Math.min(80, Math.abs(bDeg)) * RAD);
      for (const [r, l] of [['r_shoulder', 'l_shoulder'], ['r_hip', 'l_hip']] as const) {
        const a = j[r]!.at as Pt;
        const b = j[l]!.at as Pt;
        const mx = (a[0] + b[0]) / 2;
        const half = ((b[0] - a[0]) / 2) * c;
        j[r] = { ...j[r]!, at: [mx - half, a[1]] };
        j[l] = { ...j[l]!, at: [mx + half, b[1]] };
      }
      if (bDeg !== 0) {
        const sign = bDeg > 0 ? 1 : -1;
        j.neck = { ...j.neck!, at: [neck[0] - 4 * sign, neck[1]] };
      }
    });
  }

  test('refuses by name when a map names both bone and slider, a malformed slider, a slider the rig lacks, or a duplicate slider', () => {
    const badMaps: Array<{ map: Record<string, unknown>; code: string; text: string }> = [
      {
        map: { ...baseMap(), face: { yaw: { bone: 'yaw_dial', slider: 'yaw', range: [-15, 15] } } },
        code: 'MAP_FACE_BONE',
        text: '"face.yaw"',
      },
      {
        map: { ...baseMap(), face: { pitch: { bone: 'pitch_dial', slider: 'pitch', range: [-12, 12] } } },
        code: 'MAP_FACE_BONE',
        text: '"face.pitch"',
      },
      {
        map: { ...baseMap(), body: { yaw: { bone: 'body_yaw_dial', slider: 'body_yaw', range: [-20, 20] } } },
        code: 'MAP_BODY_BONE',
        text: '"body.yaw"',
      },
      {
        map: { ...baseMap(), face: { yaw: { slider: '' } } },
        code: 'MAP_FACE_BONE',
        text: '"face.yaw"',
      },
      {
        map: { ...baseMap(), body: { yaw: { slider: '' } } },
        code: 'MAP_BODY_BONE',
        text: '"body.yaw"',
      },
      {
        map: { ...baseMap(), face: { yaw: { slider: 'no_such_slider' } } },
        code: 'MAP_SLIDER_EXISTS',
        text: 'slider "no_such_slider" is not in the rig',
      },
      {
        map: { ...baseMap(), body: { yaw: { slider: 'missing_body_slider' } } },
        code: 'MAP_SLIDER_EXISTS',
        text: 'slider "missing_body_slider" is not in the rig',
      },
      {
        map: { ...baseMap(), face: { yaw: { slider: 'yaw' }, pitch: { slider: 'yaw' } } },
        code: 'MAP_BONE_ONCE',
        text: 'yaw_dial',
      },
      {
        map: { ...baseMap(), face: { yaw: { slider: 'yaw' } }, body: { yaw: { bone: 'yaw_dial', range: [-15, 15] } } },
        code: 'MAP_BONE_ONCE',
        text: 'yaw_dial',
      },
    ];
    for (const { map, code, text } of badMaps) {
      const c = setup({ rig: dialRigOpts(), map });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(code);
      expect(r.stderr).toContain(text);
    }
  }, SLOW);

  test('synthetic 4-way turn (left, right, up, down) keys face.yaw, face.pitch, and body.yaw sliders in their own ranges with the right sign and order, matching dial-bone keys', () => {
    const pose = fourWayTurnPose(1);
    const rig = dialRigOpts();

    const cSlider = setup({
      rig,
      map: {
        ...baseMap(),
        face: { yaw: { slider: 'yaw' }, pitch: { slider: 'pitch' } },
        body: { yaw: { slider: 'body_yaw' } },
      },
      pose,
    });
    const cDialName = setup({
      rig,
      map: {
        ...baseMap(),
        face: { yaw: { slider: 'yaw_dial' }, pitch: { slider: 'pitch_dial' } },
        body: { yaw: { slider: 'body_yaw_dial' } },
      },
      pose,
    });
    const cBone = setup({
      rig,
      map: {
        ...baseMap(),
        face: {
          yaw: { bone: 'yaw_dial', range: [-15, 15] },
          pitch: { bone: 'pitch_dial', range: [-12, 12] },
        },
        body: {
          yaw: { bone: 'body_yaw_dial', range: [-20, 20] },
        },
      },
      pose,
    });

    const rSlider = retarget(cSlider, ['--bends', 'clamp']);
    expect(rSlider.stderr).toBe('');
    expect(rSlider.status).toBe(0);
    expect(linesOf(rSlider, 'FACE')[0]).toContain('mapped yaw → slider "yaw" [-15, 15]°');
    expect(linesOf(rSlider, 'FACE')[0]).toContain('pitch → slider "pitch" [-12, 12]°');
    expect(linesOf(rSlider, 'BODY')[0]).toContain('mapped yaw → slider "body_yaw" [-20, 20]°');

    const rDialName = retarget(cDialName, ['--bends', 'clamp']);
    expect(rDialName.stderr).toBe('');
    expect(rDialName.status).toBe(0);

    const rBone = retarget(cBone, ['--bends', 'clamp']);
    expect(rBone.stderr).toBe('');
    expect(rBone.status).toBe(0);

    // Identical motion output between slider and bone with matching range.
    const mSlider = readFileSync(cSlider.out, 'utf8');
    const mDialName = readFileSync(cDialName.out, 'utf8');
    const mBone = readFileSync(cBone.out, 'utf8');
    expect(mSlider).toBe(mBone);
    expect(mDialName).toBe(mBone);

    const parsed = JSON.parse(mSlider) as {
      animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
    };
    const trackVals = (bone: string) =>
      parsed.animations.dance.tracks.find((tr) => tr.bone === bone && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
    const yawKeys = trackVals('yaw_dial');
    const pitchKeys = trackVals('pitch_dial');
    const bodyKeys = trackVals('body_yaw_dial');

    // Right sign and order across neutral (f2), left (f7), right (f12), up (f17), down (f22):
    expect(Math.abs(yawKeys[2]!)).toBeLessThan(1);
    expect(yawKeys[7]!).toBeLessThan(-8);
    expect(yawKeys[12]!).toBeGreaterThan(8);
    expect(yawKeys[7]!).toBeLessThan(yawKeys[2]!);
    expect(yawKeys[2]!).toBeLessThan(yawKeys[12]!);

    expect(Math.abs(pitchKeys[2]!)).toBeLessThan(1);
    expect(pitchKeys[17]!).toBeLessThan(-6);
    expect(pitchKeys[22]!).toBeGreaterThan(6);
    expect(pitchKeys[17]!).toBeLessThan(pitchKeys[2]!);
    expect(pitchKeys[2]!).toBeLessThan(pitchKeys[22]!);

    expect(Math.abs(bodyKeys[2]!)).toBeLessThan(2);
    expect(bodyKeys[7]!).toBeLessThan(-8);
    expect(bodyKeys[12]!).toBeGreaterThan(8);
    expect(bodyKeys[7]!).toBeLessThan(bodyKeys[2]!);
    expect(bodyKeys[2]!).toBeLessThan(bodyKeys[12]!);

    // Posed build moves the head bone through the turn/tilt sliders in the right order:
    const doc = loadBuild(cSlider.build);
    const posed = poseRawAnimation(doc, 'dance', Array.from({ length: 24 }, () => 1 / 24), {}, 'animation').map((p) => byName(p.bones));
    const headX = (f: number) => posed[f]!.get('head')!.worldX - posed[f]!.get('neck')!.worldX;
    const headY = (f: number) => posed[f]!.get('head')!.worldY - posed[f]!.get('neck')!.worldY;
    expect(headX(7)).toBeLessThan(headX(2) - 2);
    expect(headX(12)).toBeGreaterThan(headX(2) + 2);
    expect(headY(17)).toBeGreaterThan(headY(2) + 2);
    expect(headY(22)).toBeLessThan(headY(2) - 2);
  }, SLOW);

  test('stays within slider ranges on extreme turns and public head-turn fixtures (#138, #334), and keeps fixtures without slider byte-identical', () => {
    const rig = dialRigOpts();
    // 1. Extreme 3x synthetic turns stay strictly within [-15, 15], [-12, 12], [-20, 20].
    const cExtreme = setup({
      rig,
      map: {
        ...baseMap(),
        face: { yaw: { slider: 'yaw' }, pitch: { slider: 'pitch' } },
        body: { yaw: { slider: 'body_yaw' } },
      },
      pose: fourWayTurnPose(3.5),
    });
    const rExtreme = retarget(cExtreme, ['--bends', 'clamp']);
    expect(rExtreme.stderr).toBe('');
    expect(rExtreme.status).toBe(0);
    const mExtreme = JSON.parse(readFileSync(cExtreme.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
    };
    const valsOf = (m: typeof mExtreme, bone: string) =>
      m.animations.dance.tracks.find((tr) => tr.bone === bone && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
    for (const v of valsOf(mExtreme, 'yaw_dial')) {
      expect(v).toBeGreaterThanOrEqual(-15);
      expect(v).toBeLessThanOrEqual(15);
    }
    for (const v of valsOf(mExtreme, 'pitch_dial')) {
      expect(v).toBeGreaterThanOrEqual(-12);
      expect(v).toBeLessThanOrEqual(12);
    }
    for (const v of valsOf(mExtreme, 'body_yaw_dial')) {
      expect(v).toBeGreaterThanOrEqual(-20);
      expect(v).toBeLessThanOrEqual(20);
    }

    // 2. Public monotone head-turn fixture (#138): yaw sweeps -30° → +30°, pitch sweeps -15° → +15°.
    const publicSweep = poseDoc(BASE, (i, joints) => {
      const neck = (joints.neck as { at: Pt }).at;
      const midEye: Pt = [neck[0], neck[1] - 35];
      const dEye = 12;
      const dEar = 24;
      joints.r_eye = { state: 'observed', at: [midEye[0] - dEye / 2, midEye[1]], score: 0.95 };
      joints.l_eye = { state: 'observed', at: [midEye[0] + dEye / 2, midEye[1]], score: 0.95 };
      joints.r_ear = { state: 'observed', at: [midEye[0] - dEar / 2, midEye[1] + 5], score: 0.95 };
      joints.l_ear = { state: 'observed', at: [midEye[0] + dEar / 2, midEye[1] + 5], score: 0.95 };
      const yawDeg = -30 + (60 * i) / (BASE.n - 1);
      const pitchDeg = -15 + (30 * i) / (BASE.n - 1);
      const ty = Math.tan(yawDeg * RAD);
      const tp = Math.tan(pitchDeg * RAD);
      joints.nose = { state: 'observed', at: [midEye[0] - (ty * dEye) / 1.25, midEye[1] + 5 + tp * dEye], score: 0.95 };
    });
    const cSweep = setup({
      rig,
      map: { ...baseMap(), face: { yaw: { slider: 'yaw' }, pitch: { slider: 'pitch' } } },
      pose: publicSweep,
    });
    const rSweep = retarget(cSweep, ['--bends', 'clamp']);
    expect(rSweep.stderr).toBe('');
    expect(rSweep.status).toBe(0);
    const mSweep = JSON.parse(readFileSync(cSweep.out, 'utf8')) as typeof mExtreme;
    const sweepYaw = valsOf(mSweep, 'yaw_dial');
    const sweepPitch = valsOf(mSweep, 'pitch_dial');
    expect(sweepYaw[0]).toBeCloseTo(-15, 2);
    expect(sweepYaw[sweepYaw.length - 1]).toBeCloseTo(15, 2);
    expect(sweepPitch[0]).toBeCloseTo(-12, 2);
    expect(sweepPitch[sweepPitch.length - 1]).toBeCloseTo(12, 2);
    for (let i = 1; i < sweepYaw.length; i++) {
      expect(sweepYaw[i]!).toBeGreaterThan(sweepYaw[i - 1]!);
      expect(sweepPitch[i]!).toBeGreaterThan(sweepPitch[i - 1]!);
    }

    // 3. Existing public fixtures without slider (examples/wave and examples/walk) remain byte-identical.
    for (const ex of ['wave', 'walk'] as const) {
      const d1 = tempDir();
      const d2 = tempDir();
      const out1 = join(d1, 'motion.json');
      const out2 = join(d2, 'motion.json');
      const rigPath = join(ROOT, 'examples', 'wave', 'rig');
      const mapPath = join(ROOT, 'examples', ex, 'map.json');
      const posePath = join(ROOT, 'examples', ex, 'pose.json');
      const run1 = cli(['retarget', '--rig', rigPath, '--map', mapPath, '--pose', posePath, '--out', out1]);
      const run2 = cli(['retarget', '--rig', rigPath, '--map', mapPath, '--pose', posePath, '--out', out2]);
      expect(run1.status).toBe(0);
      expect(run2.status).toBe(0);
      expect(readFileSync(out1).equals(readFileSync(out2))).toBe(true);
    }
  }, SLOW);

  test('time-driven slider (bone: null) keys { slider, property: "time" } in [0, duration] with the right sign and order, and mutant flipping slider range fails sign/order', () => {
    const pose = fourWayTurnPose(1);
    const baseRig = dialRigOpts();
    const timeRig: RigOpts = {
      ...baseRig,
      constraints: [
        { name: 'yaw_time', type: 'slider', animation: 'turn', additive: true, mix: 1 },
        { name: 'pitch_time', type: 'slider', animation: 'tilt', additive: true, mix: 1 },
      ],
    };
    const cTime = setup({
      rig: timeRig,
      map: {
        ...baseMap(),
        face: { yaw: { slider: 'yaw_time' }, pitch: { slider: 'pitch_time' } },
      },
      pose,
    });
    const rTime = retarget(cTime, ['--bends', 'clamp']);
    expect(rTime.stderr).toBe('');
    expect(rTime.status).toBe(0);
    const mTime = JSON.parse(readFileSync(cTime.out, 'utf8')) as {
      animations: { dance: { tracks: Array<{ slider?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
    };
    const yawTime = mTime.animations.dance.tracks.find((tr) => tr.slider === 'yaw_time' && tr.property === 'time')!.keys.map((k) => k.v[0]!);
    const pitchTime = mTime.animations.dance.tracks.find((tr) => tr.slider === 'pitch_time' && tr.property === 'time')!.keys.map((k) => k.v[0]!);
    for (const v of yawTime) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.875);
    }
    for (const v of pitchTime) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.5);
    }
    // Neutral at midpoint (0.9375s / 0.75s), left < neutral < right, up < neutral < down:
    expect(yawTime[7]!).toBeLessThan(0.9375 - 0.3);
    expect(Math.abs(yawTime[2]! - 0.9375)).toBeLessThan(0.1);
    expect(yawTime[12]!).toBeGreaterThan(0.9375 + 0.3);
    expect(pitchTime[17]!).toBeLessThan(0.75 - 0.25);
    expect(Math.abs(pitchTime[2]! - 0.75)).toBeLessThan(0.1);
    expect(pitchTime[22]!).toBeGreaterThan(0.75 + 0.25);

    // Mutant: flipping the mapped dial sign in face.ts reverses left/right and up/down order.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm454-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'face.ts');
      const from = 'const degs = raw.map((x) => (x < 0 ? -mapKneeSide(-x, limNeg, peakNeg) : mapKneeSide(x, limPos, peakPos)));';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const degs = raw.map((x) => -(x < 0 ? -mapKneeSide(-x, limNeg, peakNeg) : mapKneeSide(x, limPos, peakPos)));'));

      const cMut = setup({
        rig: dialRigOpts(),
        map: {
          ...baseMap(),
          face: { yaw: { slider: 'yaw' }, pitch: { slider: 'pitch' } },
        },
        pose,
      });
      const rMut = retarget(cMut, ['--bends', 'clamp'], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const mMut = JSON.parse(readFileSync(cMut.out, 'utf8')) as {
        animations: { dance: { tracks: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[] }> }> } };
      };
      const mutYaw = mMut.animations.dance.tracks.find((tr) => tr.bone === 'yaw_dial' && tr.property === 'rotate')!.keys.map((k) => k.v[0]!);
      expect(mutYaw[7]!).toBeGreaterThan(0);
      expect(mutYaw[12]!).toBeLessThan(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});
