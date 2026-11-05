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
  tmpdir,
  join,
  poseRawAnimation,
  poseRawSetup,
  holdShort,
  isAcross,
  mergeRuns,
  spreadFlips,
  clean,
  loopTrack,
  type RigcTrack,
  readPoseSequence,
  writePoseSequence,
  keysOnFrameTimes,
  type MotionDoc,
  ROOT,
  CLI,
  RIGC,
  MUTANTS,
  DEG,
  RAD,
  ANGLE_TOL,
  ORIGIN_TOL,
  SLOW,
  type Pt,
  wrap,
  legacyReportRows,
  made,
  tempDir,
  type BoneSpec,
  type RigOpts,
  writeRig,
  type ChainSpec,
  baseChains,
  baseMap,
  type Motion,
  BASE,
  POSE_TRUNK,
  SCALE,
  BONE_ANGLE,
  angleOf,
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
  stanceRuns,
  documentedReport,
  loadBuild,
  byName,
  worldAngle,
  misses,
  motionOf,
  cardTest,
  MUTATIONS,
  cocoDoc,
  type ReadSeq,
  SMOOTH,
  REDUCE_MUTANT,
  worstErrors,
  keysOf,
} from './retarget-fixture.ts';

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});


test('legacy report projection retains wrong old values and nested signed diagnostics', () => {
  const rows = [{ frames: [1, 2], seconds: 0.25, times: [0.1, 0.2], moved: { on: { frames: -1, seconds: -0.1, t: 99 } } }];
  const projected = legacyReportRows(rows, ['times']);
  expect(projected).toEqual([{ frames: [1, 2], seconds: 0.25, moved: { on: { frames: -1, seconds: -0.1, t: 99 } } }]);
  expect(projected).not.toEqual([{ frames: [1, 2], seconds: 0.5, moved: rows[0]!.moved }]);
  expect(projected).not.toEqual([{ frames: [1, 2], seconds: 0.25, moved: { on: { frames: 1, seconds: -0.1, t: 99 } } }]);
  expect(rows[0]!.times).toEqual([0.1, 0.2]);
  expect(legacyReportRows([{ turns: [{ frame: 2, jump: 150, t: 0.2 }], times: [0.1, 0.2] }], ['times'], true)).toEqual([{ turns: [{ frame: 2, jump: 150 }] }]);
});

// ===========================================================================

describe('the synthetic pose with known angles (the card\'s test)', () => {
  test('the rig lands on every known angle and the hip travels the known distance', () => {
    const { ran, misses: m, c } = cardTest();
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(m).toEqual([]);
    expect(existsSync(c.out)).toBe(true);
    expect(linesOf(ran, 'SCALE')[0]).toContain('1.50000 rig units per picture px (rig 150.00 / pose median 100.00)');
    expect(linesOf(ran, 'HOLD')).toEqual([]);
    expect(linesOf(ran, 'BEND')).toEqual([]);
    expect(linesOf(ran, 'LAND')).toHaveLength(10);
    // The pose starts away from rest: frame 0 is not the setup pose.
    expect(Math.abs(wrap(BASE.ru(0) - -100))).toBeGreaterThan(90);
    // ±180° is crossed between two frames: a world angle, and a key.
    expect(BASE.ru(7)).toBeLessThan(180);
    expect(BASE.ru(8)).toBeGreaterThan(180);
    const keys = (motionOf(c.out).animations.dance!.tracks.find((t) => t.bone === 'sleeve_l0')!.keys).map((k) => k.v[0]!);
    expect(Math.min(...keys)).toBeLessThan(180);
    expect(Math.max(...keys)).toBeGreaterThan(180);
    const motion = motionOf(c.out);
    expect(Object.keys(motion.animations)).toEqual(['dance']);
    expect(motion.animations.dance!.tracks.map((t) => `${t.bone}.${t.property}`)).toEqual([
      'chest.rotate', 'sleeve_r0.rotate', 'sleeve_r1.rotate', 'sleeve_l0.rotate', 'sleeve_l1.rotate',
      'leg_r0.rotate', 'leg_r1.rotate', 'leg_l0.rotate', 'leg_l1.rotate', 'hip.translate',
    ]);
  }, SLOW);

  test('control for the checker: a build posed against the wrong known angles is caught', () => {
    const c = setup();
    expect(retarget(c).status).toBe(0);
    const off = misses(c.build, BASE, (b, i) => angleOf(BASE, b, i) + (b === 'sleeve_l1' && i === 4 ? 0.05 : 0));
    expect(off).toEqual([expect.stringContaining('sleeve_l1 between frames 3 and 4'), expect.stringContaining('sleeve_l1 frame 4: world'), expect.stringContaining('sleeve_l1 between frames 4 and 5')]);
  }, SLOW);

  test('determinism: the same inputs write the same bytes', () => {
    const c = setup();
    expect(retarget(c).status).toBe(0);
    const first = readFileSync(c.out);
    rmSync(c.out);
    expect(retarget(c).status).toBe(0);
    expect(readFileSync(c.out).equals(first)).toBe(true);
  }, SLOW);
});

describe('mutants make the card\'s test red', () => {
  for (const mu of MUTATIONS) {
    test(mu.name, () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, mu.file);
        const before = readFileSync(path, 'utf8');
        expect(before.split(mu.from)).toHaveLength(2);
        const after = before.replace(mu.from, mu.to);
        expect(after).not.toBe(before);
        writeFileSync(path, after);
        expect(readFileSync(path, 'utf8')).not.toBe(readFileSync(join(ROOT, mu.file), 'utf8'));
        const { ran, misses: m } = cardTest(join(d, 'cli.ts'), mu.args);
        const red = ran.status !== 0 || m.length > 0;
        if (!red) throw new Error(`mutant "${mu.name}" survived: exit ${ran.status}, no miss`);
        expect(red).toBe(true);
        if (mu.onlyIndependent === true) {
          expect(ran.status).toBe(0);
          expect(m.length).toBeGreaterThan(0);
        }
        // Say which way it went red, for the record.
        console.log(`  mutant "${mu.name}": exit ${ran.status}${ran.status !== 0 ? `, ${fails(ran)[0] ?? ran.stderr.split('\n')[0]}` : `, ${m.length} miss(es), first: ${m[0]}`}`);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }
});

// ===========================================================================

describe('a hinge bent the wrong way', () => {
  const BENT: Motion = { ...BASE, rf: (i) => (i === 7 ? BASE.ru(7) - 15 : BASE.rf(i)) };

  test('refused naming the chain, the joint, the frame and the angle; nothing written', () => {
    const c = setup({ pose: poseDoc(BENT) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    // #238: one line per hinge — count, frame range, worst, and the remedy; --verbose puts the per-frame line before it.
    const collapsed = 'FAIL  POSE_BEND_ONE_WAY: chain "arm_r" hinge r_elbow, 1 frame(s) in 1 run(s), frame 7 (t=0.875s) — worst inner angle -15.0° at frame 7 (t=0.875s); it bends counter-clockwise (+) at rest (20.0°), so the angle must stay ≥ 0; seen from the front, the side a hinge\'s picture falls on is not its limit, so for front-facing material state "bend": "free" on chain "arm_r"; keep a side ("rest", "ccw", "cw") only for a side view, where the picture\'s side is the joint\'s own; a near-straight knee\'s noise takes --bends clamp or --bend-tolerance <deg> (each frame: --verbose)';
    expect(fails(r)).toEqual([collapsed]);
    expect(existsSync(c.out)).toBe(false);
    expect(existsSync(c.build)).toBe(false);
    const v = retarget(c, ['--verbose']);
    expect(v.status).toBe(1);
    expect(fails(v)).toEqual([
      'FAIL  POSE_BEND_ONE_WAY: chain "arm_r" hinge r_elbow, frame 7 (t=0.875s) — inner angle -15.0°; it bends counter-clockwise (+) at rest (20.0°), so the angle must stay ≥ 0',
      collapsed,
    ]);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('control: --bends clamp writes, lists the frame and lays the forearm along the upper arm', () => {
    const c = setup({ pose: poseDoc(BENT) });
    const r = retarget(c, ['--bends', 'clamp']);
    expect(r.status).toBe(0);
    const bends = linesOf(r, 'BEND');
    expect(bends).toHaveLength(1);
    expect(bends[0]).toContain('chain "arm_r" hinge r_elbow, 1 frame(s) in 1 run(s), frame 7 (t=0.875s) — worst inner angle -15.0° at frame 7 (t=0.875s)');
    expect(bends[0]).toContain('clamped straight');
    const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: BENT.n - 1 }, () => BENT.dt));
    const f7 = byName(poses[7]!.bones);
    expect(Math.abs(wrap(worldAngle(f7, 'sleeve_r1') - worldAngle(f7, 'sleeve_r0')))).toBeLessThan(ANGLE_TOL);
    // Every other frame is the pose's.
    expect(misses(c.build, BENT, (b, i) => (b === 'sleeve_r1' && i === 7 ? BENT.ru(7) : angleOf(BENT, b, i))).filter((s) => !s.includes('between frames'))).toEqual([]);
  }, SLOW);

  test('control: --bend-tolerance above the bend lets it through unlisted', () => {
    const c = setup({ pose: poseDoc(BENT) });
    const r = retarget(c, ['--bend-tolerance', '20']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'BEND')).toEqual([]);
  }, SLOW);

  test('MAP_BEND_SIDE: a chain straight at rest with no "bend" stated', () => {
    const map = baseMap();
    map.chains = baseChains().map((c) => (c.name === 'leg_l' ? { name: c.name, bones: c.bones, joints: c.joints } : c));
    const c = setup({ map });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([
      'FAIL  MAP_BEND_SIDE: chain "leg_l" — the hinge at l_knee is straight at rest (inner angle 0.000°), so the rest pose does not say which way it bends; state "bend": "ccw", "cw" or "free" — seen from the front, the side a hinge\'s picture falls on is not its limit, so for front-facing material state "bend": "free" on chain "leg_l"; keep a side ("rest", "ccw", "cw") only for a side view, where the picture\'s side is the joint\'s own',
    ]);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('control: "bend": "free" on that chain is accepted (the card\'s map states it)', () => {
    expect(baseChains().find((c) => c.name === 'leg_l')!.bend).toBe('free');
    const c = setup();
    expect(retarget(c).status).toBe(0);
  }, SLOW);
});

// ===========================================================================

describe('holds', () => {
  /** Still everywhere but the left leg, so a held value is the true value. */
  const STILL: Motion = {
    ...BASE,
    trunk: () => 95,
    ru: () => 150,
    rf: () => 170,
    lu: () => -60,
    lf: () => -75,
    rt: () => -95,
    rs: () => -110,
    hip: () => [0, 0],
  };

  test('a missing and a low-score joint, and a leading gap, hold a good value and are listed', () => {
    const pose = poseDoc(STILL, (i, j) => {
      if (i >= 3 && i <= 5) {
        j.r_wrist = { state: 'missing' };
        j.l_wrist = { state: 'observed', at: [0, 0], score: 0.1 };
      }
      if (i <= 1) j.r_ankle = { state: 'occluded', at: [399, 0], score: 0.05 };
    });
    const c = setup({ pose });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'HOLD')).toEqual([
      'HOLD   point "l_wrist" frames 3–5 (t=0.375–0.625s): score 0.100 < 0.3; held frame 2\'s value',
      'HOLD   point "r_ankle" frames 0–1 (t=0.000–0.125s): score 0.050 < 0.3; held frame 2\'s value',
      'HOLD   point "r_wrist" frames 3–5 (t=0.375–0.625s): missing; held frame 2\'s value',
    ]);
    // The garbage positions were not used: the rig still lands on the known pose.
    expect(misses(c.build, STILL)).toEqual([]);
  }, SLOW);

  test('control: --min-score below the low score uses the positions it was given', () => {
    const pose = poseDoc(STILL, (i, j) => {
      if (i >= 3 && i <= 5) j.l_wrist = { state: 'observed', at: [0, 0], score: 0.1 };
    });
    const c = setup({ pose });
    const r = retarget(c, ['--min-score', '0.05', '--bends', 'clamp']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'HOLD')).toEqual([]);
    expect(misses(c.build, STILL).some((s) => s.startsWith('sleeve_l1 frame 3'))).toBe(true);
  }, SLOW);

  test('POSE_POINT_NEVER_GOOD: a joint the map needs is good on no frame', () => {
    const c = setup({ pose: poseDoc(BASE, (_i, j) => (j.r_wrist = { state: 'missing' })) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([
      'FAIL  POSE_POINT_NEVER_GOOD: point "r_wrist" is good on none of the 16 frames (missing); the map needs it, and there is no value to hold',
    ]);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);
});

// ===========================================================================

describe('the flip guard (#15): a segment that turns more than --flip degrees in one frame is spread', () => {
  /**
   * The left arm still (upper arm at −60°) and its forearm stepping 150°
   * counter-clockwise in one frame, from 140° to −70° (= 290°), at frame `at`.
   * The elbow's inner angle goes −160° → −10° on its rest side (clockwise)
   * the whole way, so the hinge check stays out of it.
   */
  const stepped = (at: number, to = -70): Motion => ({ ...BASE, lu: () => -60, lf: (i) => (i < at ? 140 : to) });
  /** The forearm's world angle on each frame of the gated build, by rig-c's poser. */
  const forearm = (build: string, m: Motion): number[] =>
    poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: m.n - 1 }, () => m.dt)).map((p) => worldAngle(byName(p.bones), 'sleeve_l1'));
  const turns = (xs: number[]): number[] => xs.slice(1).map((x, i) => wrap(x - xs[i]!));

  test('a 150° step: one FLIP line, and the rig turns at most 90° a frame, landing on the spread', () => {
    const m = stepped(8);
    const c = setup({ pose: poseDoc(m) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--flip', '90', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('flip 90°');
    expect(linesOf(r, 'FLIP')).toEqual([
      'FLIP   chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) turned +150.0° from frame 7 to 8 (t=0.875–1.000s), over 90° in one frame; spread over frames 7–8 (h=1), +50.0° per frame',
    ]);
    // The landing check (against the spread targets) is green for every bone.
    expect(linesOf(r, 'LAND')).toHaveLength(10);
    // Read back by rig-c: the spread is 140° → 190° → 240° → 290°, the frames either side are the input's.
    const spread = (b: string, i: number) => (b === 'sleeve_l1' && (i === 7 || i === 8) ? 140 + 50 * (i - 6) : angleOf(m, b, i));
    expect(misses(c.build, m, spread)).toEqual([]);
    const f = forearm(c.build, m);
    expect(Math.max(...turns(f).map(Math.abs))).toBeLessThanOrEqual(90 + ANGLE_TOL);
    expect(Math.abs(wrap(f[6]! - 140))).toBeLessThan(ANGLE_TOL);
    expect(Math.abs(wrap(f[9]! - -70))).toBeLessThan(ANGLE_TOL);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { options: { flip: unknown }; flips: unknown[] };
    expect(rep.options.flip).toBe(90);
    expect(legacyReportRows(rep.flips, ['times'], true)).toEqual([{ chain: 'arm_l', bone: 'sleeve_l1', joints: ['l_elbow', 'l_wrist'], jump: expect.closeTo(150, 6), turns: [{ frame: 8, jump: expect.closeTo(150, 6) }], frames: [7, 8], h: 1, step: expect.closeTo(50, 6), clipped: null }]);
  }, SLOW);

  test('control: without the guard the same build turns 150° in one frame (what the guard is for)', () => {
    const m = stepped(8);
    const c = setup({ pose: poseDoc(m) });
    const r = retarget(c, ['--flip', 'off']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('flip off');
    expect(linesOf(r, 'FLIP')).toEqual([]);
    expect(misses(c.build, m)).toEqual([]);
    expect(Math.abs(turns(forearm(c.build, m))[7]!)).toBeCloseTo(150, 2);
  }, SLOW);

  test('control: a 60° step is under the threshold, untouched and unlisted', () => {
    const m = stepped(8, -160);
    const c = setup({ pose: poseDoc(m) });
    const r = retarget(c, ['--flip', '90']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FLIP')).toEqual([]);
    expect(misses(c.build, m)).toEqual([]);
  }, SLOW);

  test('a step at frame 1: the window stops at the first frame, which keeps the input\'s angle', () => {
    const m = stepped(1);
    const c = setup({ pose: poseDoc(m) });
    const r = retarget(c, ['--flip', '90']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FLIP')).toEqual([
      'FLIP   chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) turned +150.0° from frame 0 to 1 (t=0.000–0.125s), over 90° in one frame; spread over frame 1 (h=1), +75.0° per frame; the window was cut short at the first frame of the pose',
    ]);
    expect(misses(c.build, m, (b, i) => (b === 'sleeve_l1' && i === 1 ? 215 : angleOf(m, b, i)))).toEqual([]);
  }, SLOW);

  test('--flip takes off or degrees in (0, 180); anything else is exit 2', () => {
    const c = setup();
    for (const v of ['0', '180', 'none', '-5']) {
      const r = retarget(c, ['--flip', v]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--flip is "${v}"; it must be off, or degrees in (0, 180)`);
    }
    expect(existsSync(c.out)).toBe(false);
  });

  test('spreadFlips: the smallest h, centred; ends kept; a series under the threshold untouched', () => {
    const a = [0, 0, 0, 0, 0, 170, 170, 170, 170, 170];
    expect(spreadFlips(a, 90)).toEqual([{ jump: 170, turns: [{ frame: 5, jump: 170 }], frames: [4, 5], h: 1, step: expect.closeTo(170 / 3, 9), clipped: null }]);
    expect(a.map((x) => Math.round(x * 1000) / 1000)).toEqual([0, 0, 0, 0, 56.667, 113.333, 170, 170, 170, 170]);
    // A step too big for h = 1 at a tighter threshold widens to h = 2 (5 turns of 34°).
    const b = [0, 0, 0, 0, 0, 170, 170, 170, 170, 170];
    expect(spreadFlips(b, 50)[0]).toMatchObject({ frames: [3, 6], h: 2 });
    expect(Math.max(...turns(b).map(Math.abs))).toBeLessThanOrEqual(50);
    const still = [10, 40, 70, 100, 130];
    expect(spreadFlips(still, 90)).toEqual([]);
    expect(still).toEqual([10, 40, 70, 100, 130]);
  });

  test('spreadFlips: neighbouring windows merge into one; a window at the last frame says so', () => {
    // Out by +150° at frame 4 and back by −150° at frame 5: the two windows overlap and become one line.
    const a = [0, 0, 0, 0, 150, 0, 0, 0];
    const s = spreadFlips(a, 90);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ turns: [{ frame: 4 }, { frame: 5 }], frames: [3, 5], h: 1, clipped: null });
    expect(a.every((x) => Math.abs(x) < 1e-9)).toBe(true);
    const e = [0, 0, 0, 0, 0, 150];
    expect(spreadFlips(e, 90)).toEqual([{ jump: 150, turns: [{ frame: 5, jump: 150 }], frames: [4, 4], h: 1, step: 75, clipped: 'end' }]);
    // A turn the short way round: 170° → −170° is +20°, not a flip.
    expect(spreadFlips([170, -170, -150], 90)).toEqual([]);
  });

  test('the guard is off unless --flip is given: a 150° step is keyed as the pose gives it', () => {
    const m = stepped(8);
    const c = setup({ pose: poseDoc(m) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FLIP')).toEqual([]);
    expect(Math.max(...turns(forearm(c.build, m)).map(Math.abs))).toBeGreaterThan(149);
  }, SLOW);
});

// ===========================================================================

describe('the short hold (#22): a segment under --short of its median picture length has its angle interpolated', () => {
  /** 30 fps; the left upper arm still at −60°, its forearm turning steadily 130° → 175°, on the elbow's rest side throughout. */
  const STEADY: Motion = { ...BASE, dt: 1 / 30, lu: () => -60, lf: (i) => 130 + 3 * i };
  /** Where the shrunken forearm points in the picture: noise, every value on the elbow's rest side (inner angle in (−180°, 0°)). */
  const NOISE = [200, 290, 130, 250, 170, 280];
  /** The forearm shrunk to 5 px of its 50 (0.1) on `len` frames from `from`, pointing NOISE's way. */
  const shrunk = (from: number, len: number): Record<string, unknown> => poseDoc(STEADY, (i, j) => {
    if (i < from || i >= from + len) return;
    j.l_wrist = { state: 'observed', at: add(j.l_elbow!.at as Pt, dir(NOISE[i - from]!, 5)), score: 0.9 };
  });
  /** The angles the pose gives: NOISE on the shrunken frames. */
  const asGiven = (from: number, len: number) => (b: string, i: number): number => (b === 'sleeve_l1' && i >= from && i < from + len ? NOISE[i - from]! : angleOf(STEADY, b, i));
  interface Report { options: { short: unknown }; short: unknown[]; endOn: unknown[] }

  test('a forearm at 0.1 of its length for 6 frames (0.2 s): SHORT and END-ON, and the rig follows the interpolated angle', () => {
    const c = setup({ pose: shrunk(5, 6) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--short', '0.35', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('short 0.35');
    expect(linesOf(r, 'SHORT')).toEqual([
      'SHORT  chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) frames 5–10 (t=0.167–0.333s): picture length down to 0.10 of its median, under 0.35; its direction is not read — interpolated from frame 4\'s angle to frame 11\'s, the short way round',
    ]);
    expect(linesOf(r, 'END-ON')).toEqual([
      'END-ON chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) frames 5–10 (t=0.167–0.333s): 0.200s under 0.35 of its median picture length (down to 0.10), ≥ 0.15s — seen end-on, a pose the rig cannot draw',
    ]);
    expect(linesOf(r, 'LAND')).toHaveLength(10);
    // Read back by rig-c: the forearm is linear in the pose, so the line from frame 4 to 11 is its true angle.
    expect(misses(c.build, STEADY)).toEqual([]);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as Report;
    expect(rep.options.short).toBe(0.35);
    expect(legacyReportRows(rep.short, ['times'])).toEqual([{ chain: 'arm_l', bone: 'sleeve_l1', joints: ['l_elbow', 'l_wrist'], frames: [5, 10], minFraction: expect.closeTo(0.1, 9) }]);
    expect(legacyReportRows(rep.endOn, ['times', 'spanSeconds'])).toEqual([{ chain: 'arm_l', bone: 'sleeve_l1', joints: ['l_elbow', 'l_wrist'], frames: [5, 10], seconds: 0.2, minFraction: expect.closeTo(0.1, 9) }]);
  }, SLOW);

  // Since #67 a 4-frame shrink, still under END-ON's 0.15 s: clean's 5-frame median takes a 2-frame collapse out as a
  // spike, and on this fixture (the arm moving ~12 px a frame) the last frame of a 3-frame run as well.
  test('a 4-frame shrink (0.133 s, a blur): SHORT, but not END-ON', () => {
    const c = setup({ pose: shrunk(7, 4) });
    const r = retarget(c, ['--short', '0.35']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SHORT')).toEqual([
      'SHORT  chain "arm_l" bone "sleeve_l1" (l_elbow → l_wrist) frames 7–10 (t=0.233–0.333s): picture length down to 0.10 of its median, under 0.35; its direction is not read — interpolated from frame 6\'s angle to frame 11\'s, the short way round',
    ]);
    expect(linesOf(r, 'END-ON')).toEqual([]);
    expect(misses(c.build, STEADY)).toEqual([]);
  }, SLOW);

  test('control: without --short the same pose is keyed as given, and nothing is listed', () => {
    const c = setup({ pose: shrunk(5, 6) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('short off');
    expect(linesOf(r, 'SHORT')).toEqual([]);
    expect(linesOf(r, 'END-ON')).toEqual([]);
    expect(misses(c.build, STEADY, asGiven(5, 6))).toEqual([]);
    expect(misses(c.build, STEADY).some((m) => m.startsWith('sleeve_l1 frame 5'))).toBe(true);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as Report;
    expect(rep.options.short).toBe('off');
    expect(rep.short).toEqual([]);
    expect(rep.endOn).toEqual([]);
  }, SLOW);

  test('with --flip 90 as well, the held span is not also a FLIP; control: --flip 90 alone spreads its jumps', () => {
    const c = setup({ pose: shrunk(5, 6) });
    const both = retarget(c, ['--short', '0.35', '--flip', '90']);
    expect(both.status).toBe(0);
    expect(linesOf(both, 'SHORT')).toHaveLength(1);
    expect(linesOf(both, 'FLIP')).toEqual([]);
    expect(misses(c.build, STEADY)).toEqual([]);
    const flipOnly = retarget(c, ['--flip', '90', '--bends', 'clamp']);
    expect(flipOnly.status).toBe(0);
    expect(linesOf(flipOnly, 'SHORT')).toEqual([]);
    expect(linesOf(flipOnly, 'FLIP').length).toBeGreaterThan(0);
    expect(linesOf(flipOnly, 'FLIP').every((l) => l.includes('bone "sleeve_l1"'))).toBe(true);
  }, SLOW);

  test('--short takes off or a fraction in (0, 1); anything else is exit 2', () => {
    const c = setup();
    for (const v of ['0', '1', '1.5', '-0.2', 'none']) {
      const r = retarget(c, ['--short', v]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--short is "${v}"; it must be off, or a fraction in (0, 1)`);
    }
    expect(existsSync(c.out)).toBe(false);
  });

  test('POSE_SHORT_MEDIAN: a segment of zero length on most frames has no median to measure against', () => {
    // Since #67 frames 0–9: the collapsed wrist rides the elbow 12 px a frame, so on the run's last frame the
    // per-coordinate 5-frame median mixes in the far side of the step and clean takes it as a spike; 9 of 16 stay zero.
    const pose = poseDoc(STEADY, (i, j) => {
      if (i <= 9) j.l_wrist = { ...j.l_elbow! };
    });
    const c = setup({ pose });
    const r = retarget(c, ['--short', '0.35']);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([
      'FAIL  POSE_SHORT_MEDIAN: chain "arm_l" — bone "sleeve_l1"\'s segment l_elbow → l_wrist has median picture length 0px over the 16 frames; --short measures a frame\'s length against that median, and there is none to measure against',
    ]);
    expect(existsSync(c.out)).toBe(false);
    // Control: without --short the same pose writes.
    expect(retarget(c, ['--bends', 'clamp']).status).toBe(0);
  }, SLOW);

  test('holdShort: the short way round between the reliable ends; flat at either end; a series above the cutoff untouched', () => {
    const a = [170, 175, 0, 90, -175, -170];
    expect(holdShort(a, [1, 1, 0.1, 0.2, 1, 1], 0.35)).toEqual([{ frames: [2, 3], minFraction: 0.1 }]);
    // 175° → −175° is +10° the short way, over three steps.
    expect(a.map((x) => Math.round(x * 1000) / 1000)).toEqual([170, 175, 178.333, -178.333, -175, -170]);
    const start = [5, 99, 30, 40];
    expect(holdShort(start, [0.1, 0.3, 1, 1], 0.35)).toEqual([{ frames: [0, 1], minFraction: 0.1 }]);
    expect(start).toEqual([30, 30, 30, 40]);
    const end = [10, 20, 99, 5];
    expect(holdShort(end, [1, 1, 0.2, 0.3], 0.35)).toEqual([{ frames: [2, 3], minFraction: 0.2 }]);
    expect(end).toEqual([10, 20, 20, 20]);
    const fine = [1, 2, 3];
    expect(holdShort(fine, [0.35, 1, 0.9], 0.35)).toEqual([]);
    expect(fine).toEqual([1, 2, 3]);
  });

  test('mergeRuns: spans one frame apart merge, two apart do not', () => {
    expect(mergeRuns([{ frames: [2, 3], minFraction: 0.3 }, { frames: [5, 5], minFraction: 0.1 }, { frames: [8, 8], minFraction: 0.2 }], 1)).toEqual([
      { frames: [2, 5], minFraction: 0.1 },
      { frames: [8, 8], minFraction: 0.2 },
    ]);
  });
});

// ===========================================================================

describe('readers', () => {
  test('pose: every problem named in one run', () => {
    const pose = poseDoc(BASE, (i, j) => {
      if (i === 2) j.r_toe = { state: 'observed', at: [1, 1] };
      if (i === 3) j.nose = { state: 'observed', score: 0.9 };
    });
    pose.lens = 'front';
    pose.space = { units: 'picture-px', origin: 'top-left', y: 'up' };
    (pose.frames as Array<{ t: number }>)[5]!.t = (pose.frames as Array<{ t: number }>)[4]!.t;
    const c = setup({ pose });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const f = fails(r);
    const p = c.pose;
    expect(f).toContain(`FAIL  POSE_KEYS: ${p} has a key this reader does not know: "lens"; the keys it reads are spec, space, width, height, source, frames, cameraSource, camera, cleaned, travel`);
    expect(f).toContain(`FAIL  POSE_SPACE: ${p} "space" is {"units":"picture-px","origin":"top-left","y":"up"}; for "rig-pose-sequence/1" it must be exactly {"units":"picture-px","origin":"top-left","y":"down"}`);
    expect(f).toContain(`FAIL  POSE_TIME: ${p} frames[5] "t" is 0.5s, not after frame 4's 0.5s; times must strictly increase`);
    expect(f.some((l) => l.startsWith(`FAIL  POSE_JOINT_NAME: ${p} frames[2] people[0] names joint "r_toe", which body-18 does not have; the joints are nose, neck,`))).toBe(true);
    expect(f).toContain(`FAIL  POSE_JOINT_AT: ${p} frames[3] people[0] joint "nose" is "observed" and has no "at"; an observed joint has a position`);
    expect(f).toHaveLength(5);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  /** One map planted per case; the control is the card's map, green above. */
  const mapCases: Array<{ code: string; chains?: (c: ChainSpec[]) => ChainSpec[]; translate?: Record<string, unknown>; want: (map: string) => string }> = [
    {
      code: 'MAP_BONE_EXISTS',
      chains: (cs) => cs.map((c) => (c.name === 'arm_r' ? { ...c, bones: ['sleeve_r0', 'sleeve_r9'] } : c)),
      want: () => 'FAIL  MAP_BONE_EXISTS: chain "arm_r" — bone "sleeve_r9" is not in the rig; its bones are root, hip, chest, neck, sleeve_r0, sleeve_r1, sleeve_l0, sleeve_l1, leg_r0, leg_r1, leg_l0, leg_l1',
    },
    {
      code: 'MAP_CHAIN_ORDER',
      chains: (cs) => cs.map((c) => (c.name === 'arm_r' ? { ...c, bones: ['sleeve_r0', 'sleeve_l1'] } : c.name === 'arm_l' ? { ...c, bones: ['sleeve_l0', 'sleeve_r1'] } : c)),
      want: () => 'FAIL  MAP_CHAIN_ORDER: chain "arm_r" — bone "sleeve_l1" does not descend from "sleeve_r0"; its parent is "sleeve_l0"',
    },
    {
      code: 'MAP_AIM_DESCENDS',
      chains: (cs) => cs.map((c) => (c.name === 'arm_r' ? { ...c, aim: ['x', 'sleeve_r0'] } : c)),
      want: () => 'FAIL  MAP_AIM_DESCENDS: chain "arm_r" — bone "sleeve_r1" aims at "sleeve_r0", which does not descend from it; turning "sleeve_r1" would not turn that direction',
    },
    {
      code: 'MAP_TRANSLATE_PARENT',
      translate: { bone: 'neck', joint: 'neck', scale: { pose: ['mid_hip', 'neck'], rig: ['hip', 'neck'] } },
      want: () => 'FAIL  MAP_TRANSLATE_PARENT: "translate" — bone "neck" descends from "chest", which chain "trunk" turns; a translated bone\'s parent frame must not move',
    },
    {
      code: 'MAP_CHAIN_JOINTS',
      chains: (cs) => cs.map((c) => (c.name === 'arm_r' ? { ...c, joints: ['r_shoulder', 'r_elbow'] } : c)),
      want: (map) => `FAIL  MAP_CHAIN_JOINTS: chain "arm_r" has 2 bone(s) and 2 joint(s); bone k carries the segment from joint k to joint k+1, so it needs 3`,
    },
  ];
  for (const mc of mapCases) {
    test(`map: ${mc.code}`, () => {
      const map = baseMap();
      if (mc.chains) map.chains = mc.chains(baseChains());
      if (mc.translate) map.translate = mc.translate;
      const c = setup({ map });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toContain(mc.want(c.map));
      expect(fails(r).every((l) => l.startsWith(`FAIL  ${mc.code}:`) || l.startsWith('FAIL  MAP_RESOLVES:'))).toBe(true);
      if (mc.code !== 'MAP_CHAIN_JOINTS') expect(fails(r)[0]).toBe(`FAIL  MAP_RESOLVES: ${c.map} does not resolve against the rig`);
      expect(existsSync(c.out)).toBe(false);
    }, SLOW);
  }
});

// ===========================================================================

describe('the gate', () => {
  test('RIG_GATE_BASE: a rig red before any animation, with rigc\'s own lines', () => {
    const c = setup({ rig: { missingImage: true } });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const f = fails(r);
    expect(f[0]).toStartWith(`FAIL  RIG_GATE_BASE: ${join(c.rig, 'rig.json')} with no motion spec is red under rigc build --profile spine before any animation is added (exit `);
    expect(f.length).toBeGreaterThan(1);
    expect(f.slice(1).every((l) => l.startsWith('FAIL  RIGC: '))).toBe(true);
    expect(f.slice(1).join('\n')).toContain('ghost');
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  const idle = { duration: 1, tracks: [{ bone: 'chest', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 1, v: [5] }] }] };
  const motion = (animations: Record<string, unknown>) => ({ spec: 'rigc-motion/1', archetype: 'stick', cut: 'stick', easings: {}, animations });

  test('MOTION_NAME_FREE: the rig\'s motion spec already has the name', () => {
    const c = setup({ rig: { motion: motion({ dance: idle }) } });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual(['FAIL  MOTION_NAME_FREE: the rig\'s motion spec already has an animation "dance" (it has dance); name this one with --name']);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('control: the rig\'s own animation is kept beside the new one, and the pair builds green', () => {
    const c = setup({ rig: { motion: motion({ idle }) } });
    const r = retarget(c);
    expect(r.status).toBe(0);
    const out = JSON.parse(readFileSync(c.out, 'utf8')) as { animations: Record<string, unknown> };
    expect(Object.keys(out.animations)).toEqual(['idle', 'dance']);
    expect(out.animations.idle).toEqual(idle);
    const b = spawnSync(process.execPath, [RIGC, 'build', '--rig', join(c.rig, 'rig.json'), '--motion', c.out, '--out', join(c.dir, 'rebuild')], { encoding: 'utf8' });
    expect(b.status).toBe(0);
    expect(misses(join(c.dir, 'rebuild'), BASE)).toEqual([]);
  }, SLOW);
});

// ===========================================================================

describe('the landing check', () => {
  test('POSE_LANDS: a parent scaled non-uniformly breaks the key formula and is refused by bone and degrees', () => {
    const c = setup({ rig: { bones: (bs) => bs.map((b) => (b.name === 'chest' ? { ...b, scaleX: 2 } : b)) } });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const f = fails(r);
    expect(f.length).toBeGreaterThan(0);
    for (const l of f) expect(l).toMatch(/^FAIL {2}POSE_LANDS: bone "sleeve_[rl][01]" aim — worst \|reached − asked\| [\d.]+° at frame \d+ \(t=[\d.]+s\); the tolerance is 0\.01° — the rig does not turn the way the key formula assumes/);
    expect(f.some((l) => l.includes('bone "sleeve_r0"'))).toBe(true);
    const worst = Math.max(...f.map((l) => Number(/\| ([\d.]+)°/.exec(l)![1])));
    expect(worst).toBeGreaterThan(1);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);
});

// ===========================================================================

describe('folds', () => {
  test('a weighted mesh across the elbow bent hard folds, and the run lists it and still writes', () => {
    const hard = new Set([6, 7, 8, 9]);
    const HARD: Motion = { ...BASE, rf: (i) => (hard.has(i) ? BASE.ru(i) + 170 : BASE.rf(i)) };
    const c = setup({ rig: { mesh: true }, pose: poseDoc(HARD) });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const f = linesOf(r, 'FOLD');
    expect(f).toHaveLength(1);
    expect(f[0]).toStartWith('FOLD   mesh "arm_mesh" (slot "arm_mesh") folds on ');
    expect(f[0]).toContain('at 8 fps: t=');
    // The folded frames are among the hard ones.
    const ts = f[0]!.split('t=')[1]!.split(/,\s*|–/).map(Number);
    for (const t of ts) expect(t).toBeGreaterThanOrEqual(0.75 - 1e-9);
    for (const t of ts) expect(t).toBeLessThanOrEqual(1.125 + 1e-9);
    expect(existsSync(c.out)).toBe(true);
  }, SLOW);

  test('control: the same mesh under the card\'s gentle bends does not fold', () => {
    const c = setup({ rig: { mesh: true } });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FOLD')).toEqual(['FOLD   rigc render --folds at 8 fps: no mesh folds']);
  }, SLOW);
});

describe('COCO-17', () => {
  test('convert: sides, neck, score 0, null frames, flat and triple forms', () => {
    const dir = tempDir();
    const coco = cocoDoc({ ...BASE, n: 3 }, (i, t) => {
      if (i === 0) {
        t[5] = [10, 20, 0.8]; // left_shoulder
        t[6] = [30, 40, 0.6]; // right_shoulder
        t[9] = [1, 2, 0]; // left_wrist, score 0
        return t;
      }
      if (i === 1) return t.flat();
      return null;
    });
    const input = join(dir, 'coco.json');
    const out = join(dir, 'pose.json');
    writeFileSync(input, JSON.stringify(coco));
    const r = cli(['convert', '--coco', input, '--out', out]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('3 frame(s) of COCO-17 → body-18');
    const seq = JSON.parse(readFileSync(out, 'utf8')) as ReadSeq;
    expect(seq.spec).toBe('rig-pose-sequence/1');
    const f0 = seq.frames[0]!.people[0]!.joints;
    expect(f0.l_shoulder).toEqual({ state: 'observed', at: [10, 20], score: 0.8 });
    expect(f0.r_shoulder).toEqual({ state: 'observed', at: [30, 40], score: 0.6 });
    expect(f0.neck).toEqual({ state: 'observed', at: [20, 30], score: 0.6 });
    expect(f0.l_wrist).toEqual({ state: 'missing' });
    const want = positions(BASE, 0);
    expect(f0.r_elbow!.at![0]).toBeCloseTo(want.r_elbow![0], 2);
    expect(f0.l_knee!.at![1]).toBeCloseTo(want.l_knee![1], 2);
    expect(Object.keys(f0)).toHaveLength(18);
    // The flat 51-number form reads as the triples do.
    const f1 = seq.frames[1]!.people[0]!.joints;
    const want1 = positions(BASE, 1);
    for (const n of ['r_wrist', 'l_ankle', 'nose', 'l_eye', 'r_ear']) {
      expect(f1[n]!.at![0]).toBeCloseTo(want1[n]![0], 2);
      expect(f1[n]!.at![1]).toBeCloseTo(want1[n]![1], 2);
    }
    expect(seq.frames[2]).toEqual({ t: 0.25, people: [] });
  }, SLOW);

  test('convert: a frame that is neither form is refused by name', () => {
    const dir = tempDir();
    const input = join(dir, 'coco.json');
    writeFileSync(input, JSON.stringify(cocoDoc({ ...BASE, n: 2 }, (i, t) => (i === 1 ? t.slice(0, 16) : t))));
    const r = cli(['convert', '--coco', input, '--out', join(dir, 'pose.json')]);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  COCO_KEYPOINTS: ${input} frames[1] "keypoints" is an array; it must be 17 [x, y, score] triples, 51 numbers, or null`]);
    expect(existsSync(join(dir, 'pose.json'))).toBe(false);
  }, SLOW);

  test('retarget --coco is refused, naming clean --coco; clean --coco then retarget lands the known pose, a null frame holding every point', () => {
    const c = setup();
    const coco = join(c.dir, 'coco.json');
    writeFileSync(coco, JSON.stringify(cocoDoc(BASE, (i, t) => (i === 9 ? null : t))));
    const refused = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', coco, '--out', c.out, '--coco']);
    expect(refused.status).toBe(1);
    expect(fails(refused)).toEqual([`FAIL  POSE_NOT_CLEANED: ${coco} is COCO-17 (--coco), which carries no "cleaned" record; retarget reads a sequence rig-pose clean wrote (spikes, occlusion, smoothing; there is no flag to skip it). Run \`rig-pose clean --coco --pose ${coco} --out ${join(c.dir, 'coco.clean.json')}\` (add --loop for one cycle of a gait) and retarget --pose ${join(c.dir, 'coco.clean.json')}`]);
    expect(existsSync(c.out)).toBe(false);
    const cl = cli(['clean', '--coco', '--pose', coco, '--out', c.pose, '--legs', '1', '--rest', '1']);
    expect(cl.stderr).toBe('');
    expect(cl.status).toBe(0);
    expect(linesOf(cl, 'SPIKES')).toEqual(['SPIKES 0 replaced; frames 0, 1, 14, 15 untested (a clip end cuts the 5-frame window)']);
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const holds = linesOf(r, 'HOLD');
    expect(holds).toContain('HOLD   point "r_wrist" frame 9 (t=1.125s): missing; held frame 8\'s value');
    expect(holds).toContain('HOLD   point "neck" frame 9 (t=1.125s): missing; held frame 8\'s value');
    // Every frame but the held one is the known pose (the writer's 0.01 px rounding is inside the tolerance).
    const m = misses(c.build, BASE).filter((s) => !/frame 9\b|frames (8 and 9|9 and 10)/.test(s));
    expect(m).toEqual([]);
  }, SLOW);
});

// ===========================================================================

describe('the command line', () => {
  test('an unknown flag is exit 2, naming it', () => {
    const c = setup();
    const r = retarget(c, ['--wobble', '1']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown flag --wobble');
  });
  test('a missing --rig is exit 2', () => {
    const r = cli(['retarget', '--map', 'm.json', '--pose', 'p.json', '--out', 'o.json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--rig is required');
  });
  test('POSE_NOT_CLEANED (#67): a sequence clean did not write is refused by name, with the command to run; control: the cleaned one runs and prints CLEAN', () => {
    const c = setup();
    const raw = join(c.dir, 'scan.json');
    writeFileSync(raw, JSON.stringify(poseDoc(BASE), null, 2));
    const r = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', raw, '--out', c.out, '--build', c.build]);
    expect(r.status).toBe(1);
    const cleanOut = join(c.dir, 'scan.clean.json');
    expect(fails(r)).toEqual([`FAIL  POSE_NOT_CLEANED: ${raw} has no "cleaned" record; retarget reads a sequence rig-pose clean wrote (spikes, occlusion, smoothing; there is no flag to skip it). Run \`rig-pose clean --pose ${raw} --out ${cleanOut}\` (add --loop for one cycle of a gait) and retarget --pose ${cleanOut}`]);
    expect(existsSync(c.out)).toBe(false);
    // Running the named command makes the same file pass.
    expect(cli(['clean', '--pose', raw, '--out', cleanOut]).status).toBe(0);
    const ran = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', cleanOut, '--out', c.out, '--build', c.build]);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(linesOf(ran, 'CLEAN')).toHaveLength(1);
    expect(linesOf(ran, 'CLEAN')[0]).toStartWith('CLEAN  rig-pose-clean/1: legs 5, rest 7, no loop; no spike, frames 0, 1, 14, 15 untested (a clip end cuts the 5-frame window); jitter (mean |second difference| of y) ');
    // The fixture's own record (windows of 1) says so on the line.
    const r1 = retarget(c);
    expect(r1.status).toBe(0);
    expect(linesOf(r1, 'CLEAN')).toEqual([expect.stringContaining('CLEAN  rig-pose-clean/1: legs 1, rest 1 — no smoothing, no loop; no spike')]);
  }, SLOW);

  test('--smooth is an alias (#67): it prints so, and --smooth 7 lands byte-identical to --smooth 1', () => {
    const c = setup();
    const r7 = retarget(c, ['--smooth', '7', '--report', join(c.dir, 'r7.json')]);
    expect(r7.stderr).toBe('');
    expect(r7.status).toBe(0);
    const out7 = readFileSync(c.out);
    const build7 = readFileSync(join(c.build, 'skeleton.model.json'));
    expect(linesOf(r7, 'SMOOTH')).toEqual(['SMOOTH --smooth is carried by clean; ignored (given 7; this sequence was cleaned with legs 1, rest 1)']);
    rmSync(c.out);
    const r1 = retarget(c, ['--smooth', '1', '--report', join(c.dir, 'r1.json')]);
    expect(r1.status).toBe(0);
    expect(linesOf(r1, 'SMOOTH')).toEqual(['SMOOTH --smooth is carried by clean; ignored (given 1; this sequence was cleaned with legs 1, rest 1)']);
    expect(readFileSync(c.out).equals(out7)).toBe(true);
    expect(readFileSync(join(c.build, 'skeleton.model.json')).equals(build7)).toBe(true);
    expect(readFileSync(join(c.dir, 'r1.json')).equals(readFileSync(join(c.dir, 'r7.json')))).toBe(true);
    // Control: without --smooth, no alias line, and the same bytes again.
    rmSync(c.out);
    const r0 = retarget(c);
    expect(r0.status).toBe(0);
    expect(linesOf(r0, 'SMOOTH')).toEqual([]);
    expect(readFileSync(c.out).equals(out7)).toBe(true);
    // The known angles still land under the alias.
    expect(misses(c.build, BASE)).toEqual([]);
  }, SLOW);

  test('--out into a directory that does not exist (#239): made once the run is green, and a line says so', () => {
    const c = setup();
    const out = join(c.dir, 'no', 'such', 'motion.json');
    const r = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', c.pose, '--out', out, '--build', c.build]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.split('\n')).toContain(`  made directory ${join(c.dir, 'no', 'such')} — it did not exist; --out ${out} and --report ${join(c.dir, 'no', 'such', 'motion.report.json')} are written into it`);
    expect(existsSync(out)).toBe(true);
  });
  test('ARG_PATH: --out under a file is refused up front; nothing written', () => {
    const c = setup();
    writeFileSync(join(c.dir, 'no'), '');
    const out = join(c.dir, 'no', 'such', 'motion.json');
    const r = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', c.pose, '--out', out, '--build', c.build, '--report', join(c.dir, 'report.json')]);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  ARG_PATH: --out ${out} — ${join(c.dir, 'no')} is a file, so directory ${join(c.dir, 'no', 'such')} cannot be made under it`]);
    expect(r.stdout).toBe('');
    expect(existsSync(c.build)).toBe(false);
  });
  test('ARG_PATH: --report under a file, the same', () => {
    const c = setup();
    writeFileSync(join(c.dir, 'gone'), '');
    const report = join(c.dir, 'gone', 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  ARG_PATH: --report ${report} — ${join(c.dir, 'gone')} is not a directory`]);
    expect(existsSync(c.out)).toBe(false);
    expect(existsSync(c.build)).toBe(false);
  });
  test('control: --build and --render into directories not there yet are made', () => {
    const c = setup();
    const build = join(c.dir, 'deep', 'er', 'build');
    const render = join(c.dir, 'deep', 'est', 'render');
    const r = cli(['retarget', '--rig', c.rig, '--map', c.map, '--pose', c.pose, '--out', c.out, '--build', build, '--render', render]);
    expect(r.status).toBe(0);
    expect(existsSync(join(build, 'skeleton.model.json'))).toBe(true);
    expect(existsSync(render)).toBe(true);
  }, SLOW);
});

// --- a two-point aim: the head by its eye line -------------------------------

describe('an aim between two points ("eye_r>eye_l") turns the head by its eye line', () => {
  const headBones = (b: BoneSpec[]): BoneSpec[] => [
    ...b,
    { name: 'head', parent: 'neck', x: 0, y: 20 },
    { name: 'eye_r', parent: 'head', x: -6, y: 10 },
    { name: 'eye_l', parent: 'head', x: 6, y: 10 },
  ];
  const tilt = (i: number): number => 25 * Math.sin(i * 0.6) + (i === 0 ? 30 : 0);
  /** The eyes tilted by tilt(i), Spine degrees, about their midpoint. */
  const eyes = (i: number, j: JointsDoc): void => {
    const r = j.r_eye!.at as Pt;
    const l = j.l_eye!.at as Pt;
    const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
    const d = dir(tilt(i), 6);
    j.r_eye = { state: 'observed', at: [mid[0] - d[0], mid[1] - d[1]], score: 0.9 };
    j.l_eye = { state: 'observed', at: [mid[0] + d[0], mid[1] + d[1]], score: 0.9 };
  };
  const mapWith = (aim: string): Record<string, unknown> => ({
    ...baseMap(),
    chains: [...baseChains(), { name: 'head', bones: ['head'], joints: ['r_eye', 'l_eye'], aim: [aim] }],
  });

  test('the eye line lands on the pose\'s, read back by rig-c\'s poser', () => {
    const c = setup({ rig: { bones: headBones }, map: mapWith('eye_r>eye_l'), pose: poseDoc(BASE, eyes) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LAND').some((l) => l.startsWith('LAND   bone "head" aim'))).toBe(true);
    const doc = loadBuild(c.build);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: BASE.n - 1 }, () => BASE.dt));
    const off: string[] = [];
    poses.forEach((p, i) => {
      const b = byName(p.bones);
      const er = b.get('eye_r')!;
      const el = b.get('eye_l')!;
      const got = Math.atan2(el.worldY - er.worldY, el.worldX - er.worldX) * DEG;
      if (Math.abs(wrap(got - tilt(i))) > ANGLE_TOL) off.push(`frame ${i}: eye line ${got.toFixed(4)}° want ${tilt(i).toFixed(4)}°`);
    });
    expect(off).toEqual([]);
  }, SLOW);

  test('an end that does not turn with the bone is refused by name', () => {
    const c = setup({ rig: { bones: headBones }, map: mapWith('eye_r>neck'), pose: poseDoc(BASE, eyes) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.includes('MAP_AIM_DESCENDS') && l.includes('"neck"') && l.includes('bone "head"'))).toBe(true);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('two ends at one point are refused: the direction is undefined', () => {
    const c = setup({ rig: { bones: headBones }, map: mapWith('eye_r>eye_r'), pose: poseDoc(BASE, eyes) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r).some((l) => l.includes('MAP_AIM_LENGTH') && l.includes('"eye_r"'))).toBe(true);
  }, SLOW);
});

// --- the kept build stands on its own ----------------------------------------

describe('--build keeps a build rigc can draw where it was copied', () => {
  test('rigc render reads the kept build (its pages travel with it)', () => {
    const c = setup();
    const r = retarget(c);
    expect(r.status).toBe(0);
    const out = join(c.dir, 'render');
    const rr = spawnSync(process.execPath, [RIGC, 'render', '--candidate', c.build, '--animation', 'dance', '--out', out], { encoding: 'utf8' });
    expect(`${rr.stdout}${rr.stderr}`).not.toContain('nothing at');
    expect(rr.status).toBe(0);
    expect(existsSync(join(out, 'dance', 'contact.png'))).toBe(true);
  }, SLOW);
});

// --- smoothing: moved to clean (#67) ---------------------------------------------
// Retarget smooths nothing since #67; the Savitzky–Golay and its tests are in
// src/clean.ts and test/clean.test.ts.

// --- midpoints: "a+b" -----------------------------------------------------------

describe('a rig point may be the midpoint of two ("a+b")', () => {
  const midMap = (): Record<string, unknown> => ({
    ...baseMap(),
    chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, aim: ['sleeve_r0+sleeve_l0'] } : c)),
    translate: { bone: 'hip', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['leg_r0+leg_l0', 'neck'] } },
  });

  test('the trunk aimed at the shoulders\' midpoint, and the scale from the legs\' midpoint: the card\'s pose lands', () => {
    // The stick rig's shoulders' midpoint is on the chest's y axis, as its neck is, and the legs' midpoint is the hip.
    const c = setup({ map: midMap() });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SCALE')[0]).toContain('1.50000 rig units per picture px (rig 150.00 / pose median 100.00)');
    expect(misses(c.build, BASE)).toEqual([]);
  }, SLOW);

  test('each half of a midpoint aim must turn with the bone', () => {
    const map = midMap();
    map.chains = baseChains().map((ch) => (ch.name === 'trunk' ? { ...ch, aim: ['sleeve_r0+hip'] } : ch));
    const c = setup({ map });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toContain('FAIL  MAP_AIM_DESCENDS: chain "trunk" — bone "chest" aims at "hip", which does not descend from it; turning "chest" would not turn that direction');
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('a missing half is named, in an aim and in the scale; three halves are not a point', () => {
    const map = midMap();
    map.chains = baseChains().map((ch) => (ch.name === 'trunk' ? { ...ch, aim: ['sleeve_r0+sleeve_x9'] } : ch));
    map.translate = { bone: 'hip', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['leg_r0+leg_x9', 'neck'] } };
    const c = setup({ map });
    const r = retarget(c);
    expect(r.status).toBe(1);
    expect(fails(r)).toContain('FAIL  MAP_AIM_EXISTS: chain "trunk" — bone "chest" aims at "sleeve_x9" (of "sleeve_r0+sleeve_x9"), which is not in the rig');
    expect(fails(r)).toContain('FAIL  MAP_BONE_EXISTS: "translate" "scale.rig" — "leg_r0+leg_x9" reads "leg_x9", which is not a bone in the rig (a point is a bone name, name:tip, or a+b)');
    const map3 = midMap();
    map3.chains = baseChains().map((ch) => (ch.name === 'trunk' ? { ...ch, aim: ['sleeve_r0+sleeve_l0+neck'] } : ch));
    const c3 = setup({ map: map3 });
    const r3 = retarget(c3);
    expect(r3.status).toBe(1);
    expect(fails(r3)).toEqual([`FAIL  MAP_POINT: chain "trunk" names the point "sleeve_r0+sleeve_l0+neck"; a point is a bone name, name:tip (the end of its x axis), or a+b (the midpoint of two of those)`]);
  }, SLOW);
});

// --- the pelvis: hip tilt, and a trunk that reaches ---------------------------------

describe('the pelvis tilts and the trunk reaches from the posed hip for the shoulders', () => {
  /** Hip-line tilt, Spine degrees; frame 0 is off level. */
  const tilt = (i: number): number => 12 * Math.sin(i * 0.5) + (i === 0 ? 5 : 0);
  /** The chest's world angle on the rig, Spine degrees, which the pose's mid-shoulder is built from. */
  const chestAngle = (i: number): number => 90 + 15 * Math.sin(i * 0.4 + 1);
  /**
   * The stick rig with a control bone between hip and chest, as @rig-c/parts
   * builds one (chest_ctl 40 above the hip, the chest 35 above that): the
   * chest's posed origin is reached through an unmapped bone. The shoulders'
   * midpoint is 65 above the chest.
   */
  const ctlBones = (bs: BoneSpec[]): BoneSpec[] => bs.flatMap((b) => (b.name === 'chest' ? [{ name: 'chest_ctl', parent: 'hip', x: 0, y: 40 }, { ...b, parent: 'chest_ctl', y: 35 }] : [b]));
  const CHEST: Pt = [0, 75];
  const SHOULDERS = 65;
  const rot = (deg: number, v: Pt): Pt => [Math.cos(deg * RAD) * v[0] - Math.sin(deg * RAD) * v[1], Math.sin(deg * RAD) * v[0] + Math.cos(deg * RAD) * v[1]];
  /** The rig's mid-shoulder relative to its hip, world (y up), on frame i — what the pose is drawn from. */
  const shoulderOffset = (i: number): Pt => add(rot(tilt(i), CHEST), [SHOULDERS * Math.cos(chestAngle(i) * RAD), SHOULDERS * Math.sin(chestAngle(i) * RAD)]);

  const pelvisPose = (): Record<string, unknown> =>
    poseDoc(BASE, (i, j) => {
      const h = BASE.hip(i);
      const mid: Pt = [200 + h[0], 400 + h[1]];
      const d = dir(tilt(i), 15);
      const o = shoulderOffset(i);
      const msh: Pt = [mid[0] + o[0] / SCALE, mid[1] - o[1] / SCALE];
      const set = (name: string, at: Pt) => (j[name] = { state: 'observed', at, score: 0.9 });
      const shift = (names: string[], from: Pt, to: Pt) => {
        for (const n of names) {
          const a = j[n]!.at as Pt;
          set(n, [a[0] + to[0] - from[0], a[1] + to[1] - from[1]]);
        }
      };
      // Each limb moves with its root, so every segment keeps the card's angle.
      shift(['r_knee', 'r_ankle'], j.r_hip!.at as Pt, add(mid, [-d[0], -d[1]]));
      shift(['l_knee', 'l_ankle'], j.l_hip!.at as Pt, add(mid, d));
      shift(['r_elbow', 'r_wrist'], j.r_shoulder!.at as Pt, add(msh, [-20, 0]));
      shift(['l_elbow', 'l_wrist'], j.l_shoulder!.at as Pt, add(msh, [20, 0]));
      set('r_hip', add(mid, [-d[0], -d[1]]));
      set('l_hip', add(mid, d));
      set('r_shoulder', add(msh, [-20, 0]));
      set('l_shoulder', add(msh, [20, 0]));
      // The scale's pose length stays 100 px, so the figure scale is exactly 1.5.
      set('neck', add(mid, [0, -POSE_TRUNK]));
    });
  const pelvisMap = (reach: boolean): Record<string, unknown> => ({
    ...baseMap(),
    chains: [
      { name: 'pelvis', bones: ['hip'], joints: ['r_hip', 'l_hip'], aim: ['leg_r0>leg_l0'] },
      { name: 'trunk', bones: ['chest'], joints: ['mid_hip', 'mid_shoulder'], aim: ['sleeve_r0+sleeve_l0'], ...(reach ? { reach: true } : {}) },
      ...baseChains().filter((c) => c.name !== 'trunk'),
    ],
  });

  /**
   * Read back by rig-c's poser, independently: the hip line's angle against
   * tilt(i), and the rig's mid-shoulder against where the pose puts it — the
   * hip's setup origin, plus its scaled travel, plus the pose's mid_hip →
   * mid_shoulder scaled. Tolerances: 0.01° and 0.01 units. A rotate key is
   * rounded to 0.001° (≤ 0.0005° each on the hip and the chest; levers of 140
   * and 65 units: ≤ 0.0018 units), a translate key to 0.001 (≤ 0.0007 units),
   * and rig-c stores float32 (≈ 3e-5 at 400 units): 0.01 is above three times
   * their sum.
   */
  function pelvisMisses(build: string): string[] {
    const doc = loadBuild(build);
    const setupHip = byName(poseRawSetup(doc).bones).get('hip')!;
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: BASE.n - 1 }, () => BASE.dt));
    const out: string[] = [];
    poses.forEach((p, i) => {
      const b = byName(p.bones);
      const lr = b.get('leg_r0')!;
      const ll = b.get('leg_l0')!;
      const line = Math.atan2(ll.worldY - lr.worldY, ll.worldX - lr.worldX) * DEG;
      if (Math.abs(wrap(line - tilt(i))) > ANGLE_TOL) out.push(`frame ${i}: hip line ${line.toFixed(4)}° want ${tilt(i).toFixed(4)}°`);
      const sr = b.get('sleeve_r0')!;
      const sl = b.get('sleeve_l0')!;
      const got: Pt = [(sr.worldX + sl.worldX) / 2, (sr.worldY + sl.worldY) / 2];
      const h = BASE.hip(i);
      const o = shoulderOffset(i);
      const want: Pt = [setupHip.worldX + h[0] * SCALE + o[0], setupHip.worldY - h[1] * SCALE + o[1]];
      const e = Math.hypot(got[0] - want[0], got[1] - want[1]);
      if (!(e <= ORIGIN_TOL)) out.push(`frame ${i}: mid-shoulder (${got[0].toFixed(3)}, ${got[1].toFixed(3)}) want (${want[0].toFixed(3)}, ${want[1].toFixed(3)}) (|e| ${e.toFixed(4)})`);
    });
    return out;
  }

  test('the hip line tilts with the pose and the rig\'s mid-shoulder lands on the pose\'s', () => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LAND').some((l) => l.startsWith('LAND   bone "chest" aim'))).toBe(true);
    expect(pelvisMisses(c.build)).toEqual([]);
  }, SLOW);

  test('control: the same trunk without "reach" points along the pose\'s segment, and its shoulders miss', () => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(false), pose: pelvisPose() });
    const r = retarget(c);
    expect(r.status).toBe(0);
    const m = pelvisMisses(c.build);
    expect(m.some((l) => l.includes('hip line'))).toBe(false);
    const worst = Math.max(...m.map((l) => Number(/\|e\| ([\d.]+)/.exec(l)?.[1] ?? 0)));
    expect(worst).toBeGreaterThan(1);
  }, SLOW);

  test('mutant: the reach\'s posed origin ignores the hip\'s turn, and the shoulders miss', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const r = turnAbove(parent, i) / DEG;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const r = 0;'));
      const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
      const r = retarget(c, [], join(d, 'cli.ts'));
      expect(r.status).toBe(0);
      expect(pelvisMisses(c.build).some((l) => l.includes('mid-shoulder'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('POSTURE lines and the report\'s posture: the rig\'s tilt and sway beside the reference\'s', () => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    const lines = linesOf(r, 'POSTURE');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('POSTURE hip tilt range (chain "pelvis", r_hip → l_hip, Spine degrees): reference ');
    expect(lines[1]).toContain('mid_hip = "hip", mid_shoulder = "sleeve_r0+sleeve_l0"');
    const q = (JSON.parse(readFileSync(report, 'utf8')) as { posture: { tilt: { reference: { range: number }; ratio: number }; sway: { ratio: number } } }).posture;
    const tilts = Array.from({ length: BASE.n }, (_, i) => tilt(i));
    expect(q.tilt!.reference.range).toBeCloseTo(Math.max(...tilts) - Math.min(...tilts), 6);
    expect(q.tilt!.ratio).toBeCloseTo(1, 3);
    // The rig's shoulders land on the pose's (above), so its sway is the reference's.
    expect(q.sway.ratio).toBeCloseTo(1, 3);
  }, SLOW);

  /**
   * #63: the same pelvis pose, cleaned by clean() with and without
   * `hipsInferred` (windows of 1, as the fixture's), written by the writer,
   * retargeted in the same directory so every path in the output is the same.
   */
  const inferredRuns = (edit?: (doc: Record<string, unknown>) => void) => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    const doc = pelvisPose();
    edit?.(doc);
    const run = (hipsInferred: boolean) => {
      const seq = clean(readPoseSequence(JSON.stringify(doc), 'fixture'), { loop: false, legs: 1, rest: 1, hipsInferred }, undefined, 'fixture').seq;
      const poseBytes = writePoseSequence(seq);
      writeFileSync(c.pose, poseBytes);
      const report = join(c.dir, 'report.json');
      // Removed first, so the second run's wrote line names no replaced report (#239) and every other line compares.
      rmSync(report, { force: true });
      const r = retarget(c, ['--report', report]);
      return { r, motion: readFileSync(c.out, 'utf8'), report: JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>, poseSHA: createHash('sha256').update(poseBytes).digest('hex') };
    };
    return { plain: run(false), flagged: run(true) };
  };

  test('#63 bar: with clean --hips-inferred, POSTURE reads no tilt and names why; the keys and every other line are the same as without it', () => {
    const { plain, flagged } = inferredRuns();
    expect(flagged.r.stderr).toBe('');
    expect(flagged.r.status).toBe(0);
    const lp = linesOf(plain.r, 'POSTURE');
    const lf = linesOf(flagged.r, 'POSTURE');
    expect(lp[0]).toStartWith('POSTURE hip tilt range (chain "pelvis", r_hip → l_hip, Spine degrees): reference ');
    expect(lf).toEqual(['POSTURE hip tilt not read: hips inferred (declared at clean)', lp[1]!]);
    expect(linesOf(flagged.r, 'CLEAN')).toEqual([`${linesOf(plain.r, 'CLEAN')[0]!}; hips inferred (declared at clean)`]);
    // Every other stdout line is the same, and the motion is byte-identical.
    const others = (r: Ran) => r.stdout.split('\n').filter((l) => !/^\s*(POSTURE hip tilt|CLEAN )/.test(l));
    expect(others(flagged.r)).toEqual(others(plain.r));
    expect(flagged.motion).toBe(plain.motion);
    // The report: the posture says tilt null and why; the clean record says who declared it; nothing else moves.
    const qp = plain.report.posture as Record<string, unknown>;
    const qf = flagged.report.posture as Record<string, unknown>;
    expect(Object.keys(qp)).toEqual(['pelvis', 'rigHip', 'rigShoulder', 'frames', 'tilt', 'sway']);
    expect(qf.tilt).toBeNull();
    expect(qf.tiltWhy).toBe('hips inferred (declared at clean)');
    expect(qf.hipsInferred).toEqual({ frames: BASE.n, source: 'declared at clean' });
    expect(qf.frames).toEqual({ ...(qp.frames as object), tilt: 0 });
    expect(qf.sway).toEqual(qp.sway);
    expect((flagged.report.cleaned as { params: unknown }).params).toEqual({ loop: false, legs: 1, rest: 1, hipsInferred: { by: 'declared' } });
    // Different cleaned input bytes must have different provenance, even when motion agrees.
    for (const run of [plain, flagged]) {
      const inputs = run.report.inputs as { pose: { sha256: string } };
      expect(inputs.pose.sha256).toBe(run.poseSHA);
    }
    const rest = (rep: Record<string, unknown>) => {
      const inputs = rep.inputs as { pose: Record<string, unknown> };
      return { ...rep, posture: null, cleaned: null, inputs: { ...inputs, pose: { ...inputs.pose, sha256: null } } };
    };
    expect(rest(flagged.report)).toEqual(rest(plain.report));
  }, SLOW);

  test('#63: hips inferred on some frames only — the tilt is read over the others and the line counts those left out', () => {
    const k = 5;
    const { plain } = inferredRuns((doc) => {
      (doc.frames as Array<{ people: Array<{ joints: Record<string, { state: string }> }> }>).forEach((f, i) => {
        if (i < k) f.people[0]!.joints.r_hip!.state = 'inferred';
      });
    });
    expect(plain.r.status).toBe(0);
    const l = linesOf(plain.r, 'POSTURE')[0]!;
    expect(l).toStartWith('POSTURE hip tilt range (chain "pelvis", r_hip → l_hip, Spine degrees): reference ');
    expect(l).toContain(` over ${BASE.n - k} of ${BASE.n} frames)`);
    expect(l).toEndWith(`; ${k} frame(s) with an inferred hip not read (source not stated)`);
    const q = plain.report.posture as { tilt: { reference: { range: number } }; hipsInferred: unknown; frames: { tilt: number } };
    const tilts = Array.from({ length: BASE.n - k }, (_, i) => tilt(i + k));
    // The writer rounds each hip to 0.01 px on a 30 px hip line: ≤ 0.027° an angle, ≤ 0.054° a range.
    expect(Math.abs(q.tilt.reference.range - (Math.max(...tilts) - Math.min(...tilts)))).toBeLessThan(0.054);
    expect(q.hipsInferred).toEqual({ frames: k, source: 'source not stated' });
    expect(q.frames.tilt).toBe(BASE.n - k);
  }, SLOW);

  /**
   * #86: the pelvis pose cleaned with `hipsInferred` (every hip inferred), its
   * record replaced by a `measured` one with the given classes. The positions
   * are the plain run's, so the keys are too; only the reading changes.
   */
  type Runs = Array<[number, number]>;
  const measuredRun = (classes: { read: Runs; interpolated: Runs; held: Runs; scaled?: Runs; unmeasured?: Runs; fit?: { frames: number; gain: number | null; corr: number | null } }) => {
    const c = setup({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    const seq = clean(readPoseSequence(JSON.stringify(pelvisPose()), 'fixture'), { loop: false, legs: 1, rest: 1, hipsInferred: true }, undefined, 'fixture').seq;
    const doc = JSON.parse(writePoseSequence(seq)) as { cleaned: { params: Record<string, unknown> } };
    const declined = [...classes.interpolated, ...(classes.scaled ?? []), ...classes.held, ...(classes.unmeasured ?? [])].sort((x, y) => x[0] - y[0]).map((frames) => ({ frames, why: 'covered' }));
    doc.cleaned.params.hipsInferred = { by: 'measured', method: 'test method', ...classes, declined };
    writeFileSync(c.pose, JSON.stringify(doc));
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    return { r, motion: readFileSync(c.out, 'utf8'), report: JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown> };
  };
  type Measured = { tilt: { reference: { range: number } }; hipsInferred?: unknown; tiltMeasured: unknown; frames: { tilt: number } };
  const N = BASE.n;
  const allTilts = () => Array.from({ length: N }, (_, i) => tilt(i));
  const rangeOf = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

  test('#86 read: every frame read — the tilt is the plain run\'s, the line says so, and the keys are the same', () => {
    const { plain } = inferredRuns();
    const m = measuredRun({ read: [[0, N - 1]], interpolated: [], held: [] });
    expect(m.r.stderr).toBe('');
    expect(m.r.status).toBe(0);
    const l = linesOf(m.r, 'POSTURE')[0]!;
    expect(l).toStartWith('POSTURE hip tilt range (chain "pelvis", r_hip → l_hip, Spine degrees): reference ');
    expect(l).toEndWith(`; tilt measured (test method) on ${N} frame(s): ${N} read, 0 interpolated, 0 held (held: none)`);
    expect(linesOf(m.r, 'CLEAN')[0]).toEndWith('; hips inferred (measured by test method)');
    const q = m.report.posture as Measured;
    expect(q.tilt).toEqual((plain.report.posture as { tilt: unknown }).tilt as never);
    expect(q.hipsInferred).toBeUndefined();
    expect(q.tiltMeasured).toEqual({ method: 'test method', frames: N, read: N, interpolated: 0, held: 0, heldSpans: [] });
    expect(m.motion).toBe(plain.motion);
  }, SLOW);

  test('#86 interpolated: the interpolated frames are read into the tilt and counted', () => {
    const m = measuredRun({ read: [[0, 1], [5, N - 1]], interpolated: [[2, 4]], held: [] });
    expect(m.r.status).toBe(0);
    expect(linesOf(m.r, 'POSTURE')[0]).toEndWith(`; tilt measured (test method) on ${N} frame(s): ${N - 3} read, 3 interpolated, 0 held (held: none)`);
    const q = m.report.posture as Measured;
    expect(Math.abs(q.tilt.reference.range - rangeOf(allTilts()))).toBeLessThan(0.054);
    expect(q.frames.tilt).toBe(N);
  }, SLOW);

  test('#86 held: the held frames are read into the tilt, counted, and their spans printed; a reading that left them out would differ', () => {
    const k = 5;
    const m = measuredRun({ read: [[k, N - 2]], interpolated: [], held: [[0, k - 1], [N - 1, N - 1]] });
    expect(m.r.status).toBe(0);
    expect(linesOf(m.r, 'POSTURE')[0]).toEndWith(`; tilt measured (test method) on ${N} frame(s): ${N - k - 1} read, 0 interpolated, ${k + 1} held (held: 0–${k - 1}, ${N - 1})`);
    const q = m.report.posture as Measured;
    expect(q.tiltMeasured).toEqual({ method: 'test method', frames: N, read: N - k - 1, interpolated: 0, held: k + 1, heldSpans: [[0, k - 1], [N - 1, N - 1]] });
    // Over every frame, as read; the read frames alone give another range, so the held ones are in it.
    expect(Math.abs(q.tilt.reference.range - rangeOf(allTilts()))).toBeLessThan(0.054);
    expect(Math.abs(rangeOf(allTilts().slice(k, N - 1)) - rangeOf(allTilts()))).toBeGreaterThan(0.2);
  }, SLOW);

  test('#106 scaled and unmeasured: scaled frames are read into the tilt and named; unmeasured frames are left out, refused nowhere, and named on the line', () => {
    const k = 5;
    const sc = measuredRun({
      read: [[k, N - 2]],
      interpolated: [],
      scaled: [[0, k - 1], [N - 1, N - 1]],
      held: [],
      unmeasured: [],
      fit: { frames: N - k - 1, gain: 2.73, corr: 0.938 },
    });
    expect(sc.r.status).toBe(0);
    expect(linesOf(sc.r, 'POSTURE')[0]).toEndWith(`; tilt measured (test method) on ${N} frame(s): ${N - k - 1} read, 0 interpolated, ${k + 1} scaled (scaled: 0–${k - 1}, ${N - 1}, gain 2.73×, r=0.938), 0 held (held: none)`);
    expect(linesOf(sc.r, 'CLEAN')[0]).toEndWith(`; hips inferred (measured by test method, scaled 0–${k - 1}, ${N - 1} (gain 2.73×, r=0.938))`);
    const qSc = sc.report.posture as Measured;
    expect(qSc.frames.tilt).toBe(N);
    expect(Math.abs(qSc.tilt.reference.range - rangeOf(allTilts()))).toBeLessThan(0.054);

    const unm = measuredRun({
      read: [[k, N - 2]],
      interpolated: [],
      scaled: [],
      held: [],
      unmeasured: [[0, k - 1], [N - 1, N - 1]],
      fit: { frames: N - k - 1, gain: 0.04, corr: 0.078 },
    });
    expect(unm.r.status).toBe(0);
    expect(linesOf(unm.r, 'POSTURE')[0]).toEndWith(`; tilt measured (test method) on ${N - k - 1} frame(s): ${N - k - 1} read, 0 interpolated, 0 held (held: none); ${k + 1} unmeasured (0–${k - 1}, ${N - 1}, r=0.078 < 0.9)`);
    expect(linesOf(unm.r, 'CLEAN')[0]).toEndWith(`; hips inferred (measured by test method, unmeasured 0–${k - 1}, ${N - 1} (r=0.078 < 0.9))`);
    const qUnm = unm.report.posture as Measured;
    expect(qUnm.frames.tilt).toBe(N - k - 1);
    expect(Math.abs(qUnm.tilt.reference.range - rangeOf(allTilts().slice(k, N - 1)))).toBeLessThan(0.054);
  }, SLOW);

  test('control: a map without a pelvis chain prints no POSTURE line', () => {
    const c = setup();
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'POSTURE')).toEqual([]);
  }, SLOW);

  const reachCases: Array<{ what: string; map: () => Record<string, unknown>; want: string }> = [
    {
      what: 'on a chain of two bones',
      map: () => ({ ...pelvisMap(false), chains: [...baseChains().filter((c) => c.name !== 'arm_r'), { name: 'arm_r', bones: ['sleeve_r0', 'sleeve_r1'], joints: ['r_shoulder', 'r_elbow', 'r_wrist'], reach: true }] }),
      want: 'FAIL  MAP_REACH: chain "arm_r" has "reach" and 2 bones; a reach turns one bone from its posed origin, so the chain must have exactly one',
    },
    {
      what: 'from a joint other than the translated one',
      map: () => ({ ...baseMap(), chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, joints: ['neck', 'nose'], aim: ['neck'], reach: true } : c)) }),
      want: 'FAIL  MAP_REACH: chain "trunk" has "reach" and starts at joint "neck"; the reach is measured from the translated joint, so its first joint must be "mid_hip"',
    },
    {
      what: 'with no translate',
      map: () => ({ spec: 'rig-pose-map/1', chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, reach: true } : c)) }),
      want: 'FAIL  MAP_REACH: chain "trunk" has "reach" and the map has no "translate"; a reach is anchored at the translated bone\'s posed origin',
    },
    {
      what: 'with an aim that is not one point',
      map: () => ({ ...baseMap(), chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, aim: ['x'], reach: true } : c)) }),
      want: 'FAIL  MAP_REACH: chain "trunk" has "reach" and aims "x"; a reach aims from the bone\'s own origin at one point, so "aim" must name it (a bone, name:tip or a+b)',
    },
    {
      what: 'on a bone that does not ride the translated bone',
      map: () => ({ ...baseMap(), translate: { bone: 'leg_r0', joint: 'mid_hip', scale: { pose: ['mid_hip', 'neck'], rig: ['hip', 'neck'] } }, chains: baseChains().filter((c) => c.name !== 'leg_r').map((c) => (c.name === 'trunk' ? { ...c, reach: true } : c)) }),
      want: 'FAIL  MAP_REACH: chain "trunk" — bone "chest" reaches from its posed origin, but it does not descend from the translated bone "leg_r0"; its origin would not travel with the anchor',
    },
  ];
  for (const rc of reachCases) {
    test(`MAP_REACH: refused ${rc.what}`, () => {
      const c = setup({ map: rc.map() });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toContain(rc.want);
      expect(existsSync(c.out)).toBe(false);
    }, SLOW);
  }

  // --- #236: what "reach" costs, named ---------------------------------------------

  type ReachRow = { chain: string; bone: string; anchor: string; offset: { units: number; ofLength: number }; above: Array<{ bone: string; property: string; chain: string | null }>; departure: { max: number; frame: number; meanD2: number | null }; aimD2: number | null; pairD2: number | null; ratio: number | null };
  type JitterRow = { bone: string; chain: string; against: string | null; rig: number | null; pair: number | null; ratio: number | null; triples: number; reach: boolean };
  const costRun = (o: { rig?: RigOpts; map: Record<string, unknown>; pose?: Record<string, unknown> }) => {
    const c = setup(o);
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(report, 'utf8')) as { reach: ReachRow[]; jitter: JitterRow[] };
    return { r, reach: doc.reach, jitter: doc.jitter, costLines: linesOf(r, 'REACH').filter((l) => l.startsWith('REACH  chain ')) };
  };
  /** The trunk on the hip's origin: the stick rig with the chest (and what hangs from it) moved down onto the hip. */
  const onHip = (bs: BoneSpec[]): BoneSpec[] => bs.map((b) => (b.name === 'chest' ? { ...b, y: 0 } : b));
  const reachTrunk = (): Record<string, unknown> => ({ ...baseMap(), chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, reach: true } : c)) });

  test('REACH: a reach below a turning pelvis prints its departure from the pair, naming the pelvis and the lever', () => {
    const { reach, costLines, jitter } = costRun({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    expect(costLines).toHaveLength(1);
    expect(costLines[0]).toStartWith('REACH  chain "trunk" bone "chest" (mid_hip → mid_shoulder) is aimed from its posed origin at the pair\'s end — its origin sits 75.00 units from the anchor "hip"\'s at setup');
    expect(costLines[0]).toContain('it hangs below "hip" (turned by chain "pelvis")');
    expect(reach).toHaveLength(1);
    const row = reach[0]!;
    expect(row.above).toEqual([{ bone: 'hip', property: 'rotate', chain: 'pelvis' }]);
    expect(row.offset.units).toBe(75);
    // The pelvis tilts ±12° and the chest's origin sits 75 units up it: the aim is not the pair's angle.
    expect(row.departure.max).toBeGreaterThan(1);
    expect(row.departure.meanD2).toBeGreaterThan(0);
    // The JITTER line names the same bone as a reach.
    expect(jitter.find((j) => j.bone === 'chest')?.reach).toBe(true);
  }, SLOW);

  test('REACH control: the same trunk without "reach" prints none, and the report\'s reach is empty', () => {
    const { reach, costLines } = costRun({ rig: { bones: ctlBones }, map: pelvisMap(false), pose: pelvisPose() });
    expect(costLines).toEqual([]);
    expect(reach).toEqual([]);
  }, SLOW);

  test('REACH control: a reach with no pelvis chain, its bone on the anchor\'s origin, is aimed along the pair and prints none', () => {
    const { reach, costLines, jitter } = costRun({ rig: { bones: onHip }, map: reachTrunk() });
    expect(costLines).toEqual([]);
    expect(reach).toEqual([]);
    const chest = jitter.find((j) => j.bone === 'chest')!;
    expect(chest.reach).toBe(true);
    expect(chest.ratio).toBeCloseTo(1, 2);
  }, SLOW);

  test('REACH: with no pelvis chain, a bone whose origin sits up the pair still departs from it (the lever), and says so without a turned bone', () => {
    const { reach, costLines, jitter } = costRun({ map: reachTrunk() });
    expect(costLines).toHaveLength(1);
    expect(costLines[0]).toContain('its origin sits 75.00 units from the anchor "hip"\'s at setup');
    expect(costLines[0]).not.toContain('hangs below');
    expect(reach[0]!.above).toEqual([]);
    // The aim from 75 units up a 150-unit reach turns by about twice the pair's turn.
    expect(reach[0]!.ratio!).toBeGreaterThan(1.5);
    expect(jitter.find((j) => j.bone === 'chest')!.ratio!).toBeGreaterThan(1.5);
  }, SLOW);

  // --- #282: where a reach starts, against the source joint it re-aims from ------------

  type OriginRow = { chain: string; bone: string; joints: [string, string]; anchor: string; setup: number; posed: { max: number; frame: number; t: number }; segment: number; ofSegment: number; warn: boolean; threshold: number };
  const originRun = (o: { rig?: RigOpts; map: Record<string, unknown>; pose?: Record<string, unknown> }) => {
    const c = setup(o);
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(report, 'utf8')) as { reachOrigin?: OriginRow[]; jitter: JitterRow[] };
    return { r, doc, origin: linesOf(r, 'REACH-ORIGIN'), warn: linesOf(r, 'WARN'), chest: doc.jitter.find((j) => j.bone === 'chest')! };
  };
  /** The chest's origin k units above the hip's, the neck kept 150 above it: the segment stays 150 units. */
  const chestAt = (k: number) => (bs: BoneSpec[]): BoneSpec[] => bs.map((b) => (b.name === 'chest' ? { ...b, y: k } : b.name === 'neck' ? { ...b, y: 150 - k } : b));

  test('REACH-ORIGIN: a trunk whose origin sits far above the translated hip, with "reach": true, prints the distance and a WARN, and its JITTER shows the cost', () => {
    const on = originRun({ map: reachTrunk() });
    expect(on.origin).toEqual(['REACH-ORIGIN chain "trunk" bone "chest" (mid_hip → neck): its origin 75.00 units from the source joint mid_hip (bone "hip"\'s origin) at setup, up to 75.00 on the frames (frame 0, t=0.000s): 0.500 of the 150.00-unit segment']);
    expect(on.warn).toEqual(['WARN   REACH_ORIGIN: chain "trunk" bone "chest" starts 0.500 of the segment from mid_hip, past 0.20: re-aimed from there, it turns more than the pair (JITTER bone "chest"); "reach": false follows the measured angle']);
    expect(on.doc.reachOrigin).toEqual([{ chain: 'trunk', bone: 'chest', joints: ['mid_hip', 'neck'], anchor: 'hip', setup: 75, posed: { max: 75, frame: 0, t: 0 }, segment: 150, ofSegment: 0.5, warn: true, threshold: 0.2 }]);
    // The symptom: the chest's jitter, about 1 ÷ (1 − 0.5) = 2× its pair's with "reach", the pair's own without.
    expect(on.chest.ratio!).toBeGreaterThan(1.9);
    const off = originRun({ map: baseMap() });
    expect(off.chest.ratio!).toBeCloseTo(1, 2);
    expect(on.chest.pair).toBe(off.chest.pair!);
  }, SLOW);

  test('REACH-ORIGIN control: the same trunk with "reach": false prints no line and no WARN, and the report has no reachOrigin', () => {
    const off = originRun({ map: { ...baseMap(), chains: baseChains().map((c) => (c.name === 'trunk' ? { ...c, reach: false } : c)) } });
    expect(off.origin).toEqual([]);
    expect(off.warn).toEqual([]);
    expect('reachOrigin' in off.doc).toBe(false);
  }, SLOW);

  test('REACH-ORIGIN: below a turning pelvis the origin keeps its distance on the frames, and the WARN reads the same', () => {
    const run = originRun({ rig: { bones: ctlBones }, map: pelvisMap(true), pose: pelvisPose() });
    expect(run.origin).toHaveLength(1);
    expect(run.origin[0]).toStartWith('REACH-ORIGIN chain "trunk" bone "chest" (mid_hip → mid_shoulder): its origin 75.00 units from the source joint mid_hip (bone "hip"\'s origin) at setup, up to 75.00 on the frames');
    expect(run.warn).toHaveLength(1);
    expect(run.doc.reachOrigin![0]!.posed.max).toBe(75);
  }, SLOW);

  // The threshold (0.2 of the segment, fixed before the case above was measured) against origins along the trunk:
  // the WARN fires strictly past it, and the jitter follows the lever 1 ÷ (1 − f).
  const sweep: Array<{ k: number; f: string; warn: boolean }> = [
    { k: 0, f: '0.000', warn: false },
    { k: 15, f: '0.100', warn: false },
    { k: 30, f: '0.200', warn: false },
    { k: 45, f: '0.300', warn: true },
  ];
  for (const sw of sweep) {
    test(`REACH-ORIGIN: an origin ${sw.k} units up a 150-unit trunk reads ${sw.f} of the segment, ${sw.warn ? 'past 0.20: WARN' : 'not past 0.20: no WARN'}`, () => {
      const run = originRun({ rig: { bones: chestAt(sw.k) }, map: reachTrunk() });
      expect(run.origin).toHaveLength(1);
      expect(run.origin[0]).toEndWith(`: ${sw.f} of the 150.00-unit segment`);
      expect(run.warn).toHaveLength(sw.warn ? 1 : 0);
      expect(run.doc.reachOrigin![0]!.warn).toBe(sw.warn);
      expect(Math.abs(run.chest.ratio! - 1 / (1 - Number(sw.f)))).toBeLessThan(0.05);
    }, SLOW);
  }
});

describe('JITTER: each keyed bone against its map pair (#236)', () => {
  type JitterRow = { bone: string; chain: string; against: string | null; rig: number | null; pair: number | null; ratio: number | null; triples: number; reach: boolean };
  const run = (cliPath = CLI) => {
    const c = setup();
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report], cliPath);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    return { lines: linesOf(r, 'JITTER'), jitter: (JSON.parse(readFileSync(report, 'utf8')) as { jitter: JitterRow[] }).jitter };
  };
  const worst = (rows: JitterRow[]) => rows.reduce((m, x) => ((x.ratio ?? 0) > (m.ratio ?? 0) ? x : m));

  test('a line for every bone a chain keys, in map order; on the synthetic pose each is its pair\'s (1.00×)', () => {
    const { lines, jitter } = run();
    const keyed = baseChains().flatMap((c) => c.bones);
    expect(jitter.map((j) => j.bone)).toEqual(keyed);
    expect(lines).toHaveLength(keyed.length);
    expect(lines[0]).toStartWith('JITTER bone "chest" (chain "trunk", mid_hip → neck): mean |Δ²| of the keyed local rotation as posed ');
    expect(jitter.find((j) => j.bone === 'sleeve_r1')!.against).toBe('sleeve_r0');
    expect(jitter.find((j) => j.bone === 'sleeve_r0')!.against).toBe('chest');
    for (const j of jitter) {
      expect(j.triples).toBe(BASE.n - 2);
      if (j.ratio !== null) expect(Math.abs(j.ratio - 1)).toBeLessThan(0.02);
    }
  }, SLOW);

  test('mutant: one bone\'s aim made noisy (±2° on alternate frames) — its JITTER names it, the worst ratio of the run', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = '  // Keys: the bone\'s turn less the turn of the nearest mapped bone above it.\n';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, `${from}  { const noisy = targets.get('leg_l1')!; for (let i = 0; i < n; i++) noisy[i] = noisy[i]! + (i % 2 === 0 ? 2 : -2); }\n`));
      const { lines, jitter } = run(join(d, 'cli.ts'));
      const w = worst(jitter);
      expect(w.bone).toBe('leg_l1');
      expect(w.ratio!).toBeGreaterThan(3);
      expect(lines.find((l) => l.startsWith('JITTER bone "leg_l1"'))).toMatch(/\(\d+\.\d\d×\)/);
      // Its neighbours keep their pair's figure: the noise is named on the one bone that carries it.
      for (const j of jitter) if (j.bone !== 'leg_l1' && j.ratio !== null) expect(Math.abs(j.ratio - 1)).toBeLessThan(0.02);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

// --- the kept build is the same bytes wherever it is made (#18) ---------------

describe('--build writes the same bytes in any folder, and no path out of it', () => {
  test('two identical runs in two folders at different depths: byte-identical build, motion and report', () => {
    const root = tempDir();
    const runIn = (dir: string): string => {
      mkdirSync(dir, { recursive: true });
      writeRig(dir);
      writeFileSync(join(dir, 'map.json'), JSON.stringify(baseMap(), null, 2));
      writeFileSync(join(dir, 'pose.json'), JSON.stringify(cleanedDoc(poseDoc(BASE)), null, 2));
      const r = spawnSync(process.execPath, [CLI, 'retarget', '--rig', 'rig', '--map', 'map.json', '--pose', 'pose.json', '--out', 'motion.json', '--build', 'build', '--report', 'report.json'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      return dir;
    };
    const a = runIn(join(root, 'a'));
    const b = runIn(join(root, 'deep', 'er', 'b'));
    for (const f of ['build/skeleton.model.json', 'build/skeleton.json', 'build/skeleton.atlas', 'motion.json', 'report.json']) {
      expect(readFileSync(join(b, f)).equals(readFileSync(join(a, f)))).toBe(true);
    }
    const model = readFileSync(join(a, 'build', 'skeleton.model.json'), 'utf8');
    expect(model).not.toContain(root);
    expect(model).not.toContain(tmpdir());
    const pages = (JSON.parse(model) as { images: Array<{ page: string }> }).images.map((i) => i.page);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p.startsWith('../rig/images/')).toBe(true);
  }, SLOW);
});

// --- the example runs ------------------------------------------------------------

describe('examples/wave runs as the README says', () => {
  test('a bones-only rig, a 3 s wave and its map: green, every bone lands, written', () => {
    const out = join(tempDir(), 'wave.motion.json');
    const r = cli(['retarget', '--rig', 'examples/wave/rig', '--map', 'examples/wave/map.json', '--pose', 'examples/wave/pose.json', '--out', out]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LAND')).toHaveLength(11);
    expect(linesOf(r, 'FOLD')).toEqual(['FOLD   the rig has no slots, so it draws nothing to fold; not measured']);
    expect(existsSync(out)).toBe(true);
    // #216 bar 1 on the public example: no pair declared, said, and the report's seams present and empty.
    expect(linesOf(r, 'SEAM')).toEqual(['SEAM   no neighbour pair declared — a rig spec carries none and no --parts was named; seams: []']);
    const waveReport = JSON.parse(readFileSync(out.replace(/\.json$/, '.report.json'), 'utf8')) as Record<string, unknown>;
    expect(waveReport.seams).toEqual([]);
    expect(waveReport.seamPairs).toEqual([]);
    // #236's readings: a JITTER line per keyed bone; the wave's trunk does not reach, so no REACH line.
    expect(linesOf(r, 'JITTER')).toHaveLength(10);
    expect(linesOf(r, 'REACH')).toEqual([]);
    // #242: the wave declares no travel, so the in-place readings it decoupled from --plant-feet do not apply — no TRAVEL line, and the hash below holds.
    expect(linesOf(r, 'TRAVEL')).toEqual([]);
    // #241: the wave's head chain carries the eye line, but its eyes do not move against the neck, so it keys no nod.
    expect(linesOf(r, 'NOD')).toEqual(['NOD    bone "head" (chain "head", r_eye → l_eye): the eyes do not move against the neck past the writer\'s 0.001 units — no translate keyed, nothing coupled']);
    // #240: the SCALE reading, and its factor (1.00000) inside the hip band, so no `outside both bands` line on the public example.
    expect(linesOf(r, 'SCALE').map((l) => l.slice(0, 28))).toEqual(['SCALE  1.00000 rig units per', 'SCALE  bands, rig ÷ picture ', 'SCALE  hip travel (mid_hip →']);
    expect(linesOf(r, 'SCALE')[1]).toContain('hip 1.00000–1.00000 (within)');
    // The readings moved no byte: the motion the wave wrote before #236 (v0.31.1), byte for byte.
    // A change that moves the wave's motion on purpose updates this hash in the same PR, and says why.
    expect(createHash('sha256').update(readFileSync(out)).digest('hex')).toBe('bd1ca2506217c21769169b884a306ad2defabaadecb93abd0572969291aa2e59');
  }, SLOW);
});

describe('--short leaves a line across the body alone (the hip line, the eye line)', () => {
  test('isAcross: a left joint and its right twin, either way round, and nothing else', () => {
    expect(isAcross('r_hip', 'l_hip')).toBe(true);
    expect(isAcross('l_eye', 'r_eye')).toBe(true);
    expect(isAcross('r_hip', 'r_knee')).toBe(false);
    expect(isAcross('mid_hip', 'neck')).toBe(false);
  });
});

// --- skeleton.json's `images` resolves to the parts (#25) ---------------------------

describe('the kept skeleton.json names an images directory that holds the parts', () => {
  const imagesOf = (build: string): string => {
    const doc = JSON.parse(readFileSync(join(build, 'skeleton.json'), 'utf8')) as { skeleton: { images?: string } };
    expect(typeof doc.skeleton.images).toBe('string');
    return join(build, doc.skeleton.images!);
  };
  for (const name of ['build', 'wave-build', 'out/nested/wave', 'trailing/']) {
    test(`--build ${name}: skeleton.images, read from skeleton.json's own folder, is a folder holding every part image`, () => {
      const dir = tempDir();
      writeRig(dir);
      writeFileSync(join(dir, 'map.json'), JSON.stringify(baseMap(), null, 2));
      writeFileSync(join(dir, 'pose.json'), JSON.stringify(cleanedDoc(poseDoc(BASE)), null, 2));
      const r = spawnSync(process.execPath, [CLI, 'retarget', '--rig', 'rig', '--map', 'map.json', '--pose', 'pose.json', '--out', 'motion.json', '--build', name], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      const images = imagesOf(join(dir, name));
      expect(existsSync(images)).toBe(true);
      expect(existsSync(join(images, 'seg.png'))).toBe(true);
    }, SLOW);
  }
});

// --- alternate sets, ranges and turns (#6) ------------------------------------------

describe('alternates (#6): sets of attachments switched beside the bone keys', () => {
  /** The right arm away from its key skeleton except on frames `on`, where it is exactly it. */
  const KEY_RU = 150;
  const KEY_RF = 170;
  /**
   * Since #67 the trunk stands still here (the hip in place, the chest upright): with BASE's travel the
   * shoulder moves up to 9 px a frame, and on the first frame of a held pose the per-coordinate 5-frame
   * median mixes two frames' coordinates far enough (> 0.2 trunk) for clean to take it as a spike.
   */
  const armed = (on: (i: number) => boolean): Motion => ({ ...BASE, trunk: () => 90, hip: () => [0, 0], ru: (i) => (on(i) ? KEY_RU : 30), rf: (i) => (on(i) ? KEY_RF : 50) });
  /** A key skeleton of the right arm at another scale and place than the pose's. */
  const keySkeleton = (ru = KEY_RU, rf = KEY_RF): Record<string, Pt> => {
    const sh: Pt = [1000, 1000];
    const el = add(sh, dir(ru, 300));
    return { r_shoulder: sh, r_elbow: el, r_wrist: add(el, dir(rf, 250)) };
  };
  /** The rig's alternates: the upper arm drawn raised and drawn out, and a shoulder cap only the raised set shows (an extra slot, empty at setup). */
  const ALT_RIG: RigOpts = {
    extra: {
      sleeve_r0: { seg_up: { image: 'seg.png', x: 30, y: 0, rotation: -90 }, seg_out: { image: 'seg.png', x: 30, y: 0, rotation: 0 } },
      cap_r: { cap_up: { image: 'seg.png', x: 0, y: 0, rotation: 0 } },
    },
    extraSlots: [{ name: 'cap_r', bone: 'sleeve_r0', attachment: null }],
  };
  const up = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'up', slots: { sleeve_r0: 'seg_up', cap_r: 'cap_up' }, hides: ['sleeve_r1'], chains: ['arm_r'], pose: keySkeleton(), ...o });
  const out = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'out', slots: { sleeve_r0: 'seg_out' }, chains: ['arm_r'], pose: keySkeleton(60, 80), ...o });
  const altMap = (...sets: Array<Record<string, unknown>>): Record<string, unknown> => ({ ...baseMap(), alternates: sets });
  type SlotTrackOut = { slot: string; property: string; keys: Array<{ t: number; v: string | null }> };
  const slotTracks = (path: string): SlotTrackOut[] => (motionOf(path).animations.dance!.tracks as unknown as SlotTrackOut[]).filter((t) => 'slot' in t);
  /** What rig-c's own poser shows in a slot on every frame of the gated build. */
  const shows = (build: string, slot: string, n = BASE.n, dt = BASE.dt): Array<string | null> =>
    poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: n - 1 }, () => dt)).map((p) => p.slots.find((row) => row[0] === slot)![1]);
  const each = <T>(f: (i: number) => T, n = BASE.n): T[] => Array.from({ length: n }, (_, i) => f(i));
  interface ReportOut {
    options: Record<string, unknown>;
    switches: Array<Record<string, unknown>>;
    uncovered: Array<{ slot: string; attachment: string; chains: string[]; times: number[] }> | null;
    turns: Array<Record<string, unknown>>;
    range: Array<Record<string, unknown>>;
    artRange: Array<Record<string, unknown>>;
    endOn: unknown[];
  }
  const reportOf = (path: string): ReportOut => JSON.parse(readFileSync(path, 'utf8')) as ReportOut;

  test('a set shows on the span where the pose is its key skeleton: every slot of it, keyed, gated and read back by rig-c\'s poser', () => {
    const on = (i: number) => i >= 5 && i <= 10;
    const c = setup({ rig: ALT_RIG, map: altMap(up(), out()), pose: poseDoc(armed(on)) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')).toEqual([
      'SWITCH set "up" — shows "sleeve_r0" = "seg_up", "cap_r" = "cap_up", hides "sleeve_r1"; chains arm_r; frames 5–10 (t=0.625s until 1.375s) — distance max 0.0°, median 0.0°; moved on frame 5 stays (60.0°/frame; window frames 4–6), off frame 11 stays (60.0°/frame; window frames 10–12)',
    ]);
    // Keyed half a frame before the frame each change shows on; back to the setup attachment the model states (nothing, for the cap).
    expect(slotTracks(c.out)).toEqual([
      { slot: 'sleeve_r0', property: 'attachment', keys: [{ t: 0.5625, v: 'seg_up' }, { t: 1.3125, v: 'seg' }] },
      { slot: 'cap_r', property: 'attachment', keys: [{ t: 0.5625, v: 'cap_up' }, { t: 1.3125, v: null }] },
      { slot: 'sleeve_r1', property: 'attachment', keys: [{ t: 0.5625, v: null }, { t: 1.3125, v: 'seg' }] },
    ]);
    const rep = reportOf(report);
    expect(rep.options.switchTolerance).toBe(25);
    expect(rep.options.switchMin).toBe(0.25);
    expect(rep.options.switchAt).toBe('first');
    // `first` is the default (#31 round 2): each boundary is reported where the selection put it, with its window and its speed.
    const stay = (f: number) => ({ frame: [f, f], frames: 0, seconds: 0, window: [f - 1, f + 1], speed: { old: 60, new: 60 } });
    expect(legacyReportRows(rep.switches, ['times'])).toEqual([{ set: 'up', chains: ['arm_r'], slots: { sleeve_r0: 'seg_up', cap_r: 'cap_up' }, hides: ['sleeve_r1'], offsets: {}, from: 0.625, to: 1.375, frames: [5, 10], distance: { max: 0, median: 0 }, artTurn: {}, moved: { on: stay(5), off: stay(11) } }]);
    // The bones still land: a switch adds tracks, it moves no key.
    expect(misses(c.build, armed(on))).toEqual([]);
    expect(shows(c.build, 'sleeve_r0')).toEqual(each((i) => (on(i) ? 'seg_up' : 'seg')));
    expect(shows(c.build, 'cap_r')).toEqual(each((i) => (on(i) ? 'cap_up' : null)));
    expect(shows(c.build, 'sleeve_r1')).toEqual(each((i) => (on(i) ? null : 'seg')));
    // The written motion builds green on its own.
    const b = spawnSync(process.execPath, [RIGC, 'build', '--rig', join(c.rig, 'rig.json'), '--motion', c.out, '--out', join(c.dir, 'rebuild')], { encoding: 'utf8' });
    expect(b.status).toBe(0);
  }, SLOW);

  test('control: a pose never within the tolerance switches nothing and adds no track', () => {
    const c = setup({ rig: ALT_RIG, map: altMap(up(), out()), pose: poseDoc(armed(() => false)) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')).toEqual(['SWITCH none — no set within 25° of the pose for 0.25s']);
    expect(slotTracks(c.out)).toEqual([]);
  }, SLOW);

  describe('#355: a set is shown only where its drawing is within the tolerance of the pose', () => {
    /** A copy of the package with the #355 rules taken out (today's rule): no key/drawn refusal, every art turn shows, no end-on hold. */
    function before355(): { cli: string; done: () => void } {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const edit = (file: string, from: string, to: string) => {
        const path = join(d, 'src', file);
        const src = readFileSync(path, 'utf8');
        expect(src.split(from)).toHaveLength(2);
        writeFileSync(path, src.replace(from, to));
      };
      edit('switch.ts', 'export function artShows(a: AlternateSet, targets: ReadonlyMap<string, readonly number[]>, i: number, tolerance: number, shortInfo?: ShortSwitchInfo, map?: JointMap, raisedByHead = false): boolean {', 'export function artShows(a: AlternateSet, targets: ReadonlyMap<string, readonly number[]>, i: number, tolerance: number, shortInfo?: ShortSwitchInfo, map?: JointMap, raisedByHead = false): boolean {\n  if (a !== null) return true;');
      edit('retarget.ts', "for (const x of keyDrawnProblems(map, opts.switchTolerance, opts.raisedByHead === true)) p.add('SET_KEY_DRAWN', x);", '');
      edit('retarget.ts', '  if (shortInfo !== undefined) {\n    for (const s of sw.switches) {', '  if (shortInfo !== undefined && shortInfo === null) {\n    for (const s of sw.switches) {');
      return { cli: join(d, 'cli.ts'), done: () => rmSync(d, { recursive: true, force: true }) };
    }
    const TOL = 25;
    /** The right arm on its key skeleton on frames 2–13 (the upper arm `du` off it on frames 8–13), away from it elsewhere. */
    const onKey = (du = 0): Motion => ({ ...BASE, trunk: () => 90, hip: () => [0, 0], ru: (i) => (i >= 2 && i <= 13 ? KEY_RU + (i >= 8 ? du : 0) : 30), rf: (i) => (i >= 2 && i <= 13 ? KEY_RF : 50) });

    test('a key that disagrees with its drawn angle by more than --switch-tolerance is refused by name; control: a wider tolerance takes it', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(up({ drawn: { sleeve_r0: KEY_RU + 40, sleeve_r1: KEY_RF } })), pose: poseDoc(onKey()) });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toEqual([
        'FAIL  SET_KEY_DRAWN: set "up" bone "sleeve_r0": its key skeleton r_shoulder → r_elbow points at +150.00° and its "drawn" angle is +190.00°, 40.00° apart, more than --switch-tolerance 25°; the set is chosen by its key and shown at its drawn angle, so it would show this drawing turned that far from its pose — make the key skeleton the drawing\'s, or correct "drawn"',
      ]);
      expect(existsSync(c.out)).toBe(false);
      const wide = retarget(c, ['--switch-tolerance', '45']);
      expect(wide.stderr).toBe('');
      expect(wide.status).toBe(0);
    }, SLOW);

    test('no frame shows a drawing turned past the tolerance (N/N); today\'s rule showed six at 35°, and SWITCH-TURN and switchRuns name them', () => {
      // Drawn 20° from its key (within the tolerance, so taken), the pose on the key on 2–7 (art turn 20°) and 15° off it
      // the other way on 8–13: the key's distance 15° chooses the set, and its art would turn 35°.
      const drawnU = KEY_RU + 20;
      const m = onKey(-15);
      const c = setup({ rig: ALT_RIG, map: altMap(up({ drawn: { sleeve_r0: drawnU, sleeve_r1: KEY_RF } })), pose: poseDoc(m) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const turnOf = (i: number) => Math.abs(wrap(m.ru(i) - drawnU));
      const shown = shows(c.build, 'sleeve_r0').flatMap((v, i) => (v === 'seg_up' ? [i] : []));
      const within = shown.filter((i) => turnOf(i) <= TOL);
      console.log(`  #355: ${within.length}/${shown.length} frame(s) shown within ${TOL}° of the drawing`);
      expect(shown).toEqual([2, 3, 4, 5, 6, 7]);
      expect(within).toEqual(shown);
      expect(linesOf(r, 'SWITCH-TURN')).toEqual([
        'SWITCH-TURN set "up": not shown on 6 frame(s) in 1 run(s) where a bone it draws turned more than --switch-tolerance 25° from its drawn angle (end-on segments held at it): frames 8–13 (6 frames, 0.750s); the nearest other set within the tolerance, or the base art, shows there',
      ]);
      const runs = (JSON.parse(readFileSync(report, 'utf8')) as { switchRuns: Array<{ set: string; turned: Array<{ frames: number[] }> }> }).switchRuns;
      expect(runs.map((x) => [x.set, x.turned.map((t) => t.frames)])).toEqual([['up', [[8, 13]]]]);
      expect(misses(c.build, m)).toEqual([]);
      // Today's rule: the key's distance alone shows it on 2–13, six frames with the drawing 35° from the pose.
      const old = before355();
      try {
        const o = setup({ rig: ALT_RIG, map: altMap(up({ drawn: { sleeve_r0: drawnU, sleeve_r1: KEY_RF } })), pose: poseDoc(m) });
        expect(retarget(o, [], old.cli).status).toBe(0);
        const oldShown = shows(o.build, 'sleeve_r0').flatMap((v, i) => (v === 'seg_up' ? [i] : []));
        console.log(`  #355 today's rule: ${oldShown.filter((i) => turnOf(i) <= TOL).length}/${oldShown.length} frame(s) within ${TOL}°, up to ${Math.max(...oldShown.map(turnOf)).toFixed(1)}°`);
        expect(oldShown).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      } finally {
        old.done();
      }
    }, SLOW);

    test('control: where no drawing turns past the tolerance, the motion is the bytes today\'s rule writes', () => {
      const old = before355();
      try {
        for (const [name, m, drawn, extra] of [
          ['on its key', onKey(), { sleeve_r0: KEY_RU, sleeve_r1: KEY_RF }, []],
          ['10° off its key, drawn 10° the other way', onKey(-10), { sleeve_r0: KEY_RU + 10, sleeve_r1: KEY_RF }, []],
          ['no drawn angle', onKey(-20), {}, []],
          ['--short on, nothing end-on', onKey(), { sleeve_r0: KEY_RU, sleeve_r1: KEY_RF }, ['--short', '0.35']],
        ] as Array<[string, Motion, Record<string, number>, string[]]>) {
          const a = setup({ rig: ALT_RIG, map: altMap(up({ drawn })), pose: poseDoc(m) });
          const b = setup({ rig: ALT_RIG, map: altMap(up({ drawn })), pose: poseDoc(m) });
          expect(retarget(a, extra).status).toBe(0);
          expect(retarget(b, extra, old.cli).status).toBe(0);
          const ha = createHash('sha256').update(readFileSync(a.out)).digest('hex');
          const hb = createHash('sha256').update(readFileSync(b.out)).digest('hex');
          console.log(`  #355 ${name}: ${ha.slice(0, 12)} / today's ${hb.slice(0, 12)}`);
          expect(ha).toBe(hb);
        }
      } finally {
        old.done();
      }
    }, SLOW);

    test('an end-on segment (under --short) is held at the drawn angle while the set shows; today\'s rule followed the short hold', () => {
      // The forearm drawn 20° from its key; on frames 6–8 the wrist sits 5 px from the elbow, 90° off: a tenth of its median length.
      const drawnF = KEY_RF + 20;
      const m = onKey();
      const endOn = (i: number) => i >= 6 && i <= 8;
      const doc = poseDoc(m, (i, j) => {
        if (!endOn(i)) return;
        const el = j.r_elbow!.at as Pt;
        j.r_wrist = { state: 'observed', at: add(el, dir(KEY_RF + 90, 5)), score: 0.9 };
      });
      const map = altMap(up({ drawn: { sleeve_r0: KEY_RU, sleeve_r1: drawnF } }));
      const c = setup({ rig: ALT_RIG, map, pose: doc });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--short', '0.35', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const sw = (JSON.parse(readFileSync(report, 'utf8')) as { switches: Array<{ set: string; frames: number[]; endOnHeld?: Record<string, number[][]> }> }).switches;
      expect(sw.map((x) => [x.set, x.frames, x.endOnHeld])).toEqual([['up', [2, 13], { sleeve_r1: [[6, 8]] }]]);
      expect(linesOf(r, 'SWITCH')[0]).toContain('end-on, held at drawn: "sleeve_r1" frames 6–8');
      // The forearm lands on its drawn angle on the end-on frames, on the pose everywhere else.
      expect(misses(c.build, m, (b, i) => (b === 'sleeve_r1' && endOn(i) ? drawnF : angleOf(m, b, i)))).toEqual([]);
      const old = before355();
      try {
        const o = setup({ rig: ALT_RIG, map, pose: doc });
        expect(retarget(o, ['--short', '0.35'], old.cli).status).toBe(0);
        // Today: the short hold's interpolation, the key's angle (20° from the drawing).
        expect(misses(o.build, m)).toEqual([]);
      } finally {
        old.done();
      }
    }, SLOW);
  });

  describe('#360: a set bound to frames shows on exactly them — no key, no tolerance, no switch-min', () => {
    /** A copy of the package without the bind path: the bind read as a window the angle rule picks inside, and nothing overlaid. */
    function withoutBind(): { cli: string; done: () => void } {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'switch.ts');
      let src = readFileSync(path, 'utf8');
      for (const [from, to] of [
        ['        if (a.bind !== undefined) continue;\n        if (a.frames', '        if (a.bind !== undefined && !bound.get(a.name)![i]) continue;\n        if (a.frames'],
        ['      for (let i = 0; i < n; i++) if (m[i]) pick[i] = a;\n', ''],
        ['  const groups = competing(map.alternates.filter((a) => a.bind === undefined));', '  const groups = competing(map.alternates);'],
        ["  for (const b of boundSets) spans(bound.get(b.name)!.map((v) => (v ? b : null)), { ...opts, switchAt: 'first' }, true);\n", ''],
        ['(a.bind !== undefined && !own)', 'own'],
        ['      if (a.bind !== undefined) continue;\n      nearestOn.set', '      nearestOn.set'],
        ['      if (a.bind !== undefined) continue;\n      const dropped = droppedOn', '      const dropped = droppedOn'],
      ] as Array<[string, string]>) {
        expect(src.split(from)).toHaveLength(2);
        src = src.replace(from, to);
      }
      writeFileSync(path, src);
      return { cli: join(d, 'cli.ts'), done: () => rmSync(d, { recursive: true, force: true }) };
    }
    /** The pose never near the key skeleton (the right arm at 30°/50°, the key at 150°/170°: 120° apart, past the 25° tolerance), and the drawing 120° from its key. */
    const FAR = armed(() => false);
    const farSet = (bind: unknown) => up({ bind, drawn: { sleeve_r0: KEY_RU - 120, sleeve_r1: KEY_RF - 120 } });
    // One one-frame bind (frame 3, 0.125 s, under the 0.25 s --switch-min) and one run (7–10).
    const BOUND = [3, 7, 8, 9, 10];
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

    test('N/N bound frames with the key 120° off, a one-frame bind kept, keyed half a frame before each change, read back by rig-c\'s poser', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(farSet([[3, 3], [7, 10]])), pose: poseDoc(FAR) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const shown = shows(c.build, 'sleeve_r0').flatMap((v, i) => (v === 'seg_up' ? [i] : []));
      console.log(`  #360: bound set shown on ${shown.filter((i) => BOUND.includes(i)).length}/${BOUND.length} bound frames by rig-c's poser, ${shown.filter((i) => !BOUND.includes(i)).length} outside`);
      expect(shown).toEqual(BOUND);
      expect(shows(c.build, 'cap_r')).toEqual(each((i) => (BOUND.includes(i) ? 'cap_up' : null)));
      expect(shows(c.build, 'sleeve_r1')).toEqual(each((i) => (BOUND.includes(i) ? null : 'seg')));
      // Each change keyed at the midpoint of the frame before and the frame it shows on (0.125 s frames).
      expect(slotTracks(c.out)[0]).toEqual({ slot: 'sleeve_r0', property: 'attachment', keys: [{ t: 0.3125, v: 'seg_up' }, { t: 0.4375, v: 'seg' }, { t: 0.8125, v: 'seg_up' }, { t: 1.3125, v: 'seg' }] });
      expect(linesOf(r, 'SWITCH-BIND')).toEqual(['SWITCH-BIND set "up": bound on 5 frame(s) in 2 run(s), 3, 7–10 (from "bind" [[3,3],[7,10]]); shown on 5/5 — no key distance, art-turn gate, --switch-min, bridging or hysteresis, and nowhere else']);
      expect(linesOf(r, 'SWITCH').map((l) => l.split('; moved')[0])).toEqual([
        'SWITCH set "up" — shows "sleeve_r0" = "seg_up", "cap_r" = "cap_up", hides "sleeve_r1"; chains arm_r; frame 3 (t=0.375s until 0.500s) — bound (its key not used); art turn "sleeve_r0" max 0.0°, median 0.0°; "sleeve_r1" max 0.0°, median 0.0°',
        'SWITCH set "up" — shows "sleeve_r0" = "seg_up", "cap_r" = "cap_up", hides "sleeve_r1"; chains arm_r; frames 7–10 (t=0.875s until 1.375s) — bound (its key not used); art turn "sleeve_r0" max 0.0°, median 0.0°; "sleeve_r1" max 0.0°, median 0.0°',
      ]);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { switchBinds: unknown; switchRuns: unknown[]; switches: Array<{ bound?: boolean; frames: number[] }> };
      expect(rep.switchBinds).toEqual([{ set: 'up', frames: [[3, 3], [7, 10]] }]);
      expect(rep.switchRuns).toEqual([]);
      expect(rep.switches.map((x) => [x.frames, x.bound])).toEqual([[[3, 3], true], [[7, 10], true]]);
      // A switch adds tracks; it moves no key.
      expect(misses(c.build, FAR)).toEqual([]);
    }, SLOW);

    test('the cycle form writes the bytes of the explicit list it expands to', () => {
      // A 6-frame cycle, [3, 4] over 16 frames: 3–4, 9–10, 15 (cut at the end).
      const a = setup({ rig: ALT_RIG, map: altMap(farSet({ cycle: 6, at: [[3, 4]] })), pose: poseDoc(FAR) });
      const b = setup({ rig: ALT_RIG, map: altMap(farSet([[3, 4], [9, 10], [15, 15]])), pose: poseDoc(FAR) });
      const ra = retarget(a, ['--report', join(a.dir, 'report.json')]);
      const rb = retarget(b, ['--report', join(b.dir, 'report.json')]);
      expect(ra.status).toBe(0);
      expect(rb.status).toBe(0);
      const ha = hash(a.out);
      const hb = hash(b.out);
      console.log(`  #360 cycle ${ha.slice(0, 12)} / explicit ${hb.slice(0, 12)}`);
      expect(ha).toBe(hb);
      const binds = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { switchBinds: unknown }).switchBinds;
      expect(binds(join(a.dir, 'report.json'))).toEqual(binds(join(b.dir, 'report.json')));
      expect(shows(a.build, 'sleeve_r0').flatMap((v, i) => (v === 'seg_up' ? [i] : []))).toEqual([3, 4, 9, 10, 15]);
    }, SLOW);

    test('refused by name: overlapping binds, a range past the end, a malformed bind; nothing written', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(farSet([[2, 5]]), out({ bind: { cycle: 8, at: [[5, 6]] } })), pose: poseDoc(FAR) });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toEqual(['FAIL  SET_BIND_OVERLAP: sets "up" and "out" are both bound on 1 frame(s), 5, and both draw bone "sleeve_r0"; one drawing shows per bone and slot on a frame, and nothing decides between two bound sets — bind them on different frames']);
      expect(existsSync(c.out)).toBe(false);
      const end = setup({ rig: ALT_RIG, map: altMap(farSet([[14, 16]])), pose: poseDoc(FAR) });
      const re = retarget(end);
      expect(re.status).toBe(1);
      expect(fails(re)).toEqual(['FAIL  SET_BIND_FRAMES: set "up" "bind" range(s) [14,16] end(s) past the sequence\'s last frame 15 (16 frames); an explicit bound range lies inside the sequence — a cycle-relative bind { "cycle", "at" } is clipped at its end instead']);
      const bad = setup({ rig: ALT_RIG, map: altMap(farSet([[5, 3]])), pose: poseDoc(FAR) });
      const rbad = retarget(bad);
      expect(rbad.status).toBe(1);
      expect(fails(rbad).some((l) => l.startsWith('FAIL  MAP_ALT_BIND: set "up" "bind" is [[5,3]]'))).toBe(true);
      // Control: the same two sets on disjoint frames.
      const ok = setup({ rig: ALT_RIG, map: altMap(farSet([[2, 4]]), out({ bind: { cycle: 8, at: [[5, 6]] } })), pose: poseDoc(FAR) });
      expect(retarget(ok).status).toBe(0);
      expect(shows(ok.build, 'sleeve_r0')).toEqual(each((i) => ([2, 3, 4].includes(i) ? 'seg_up' : [5, 6, 13, 14].includes(i) ? 'seg_out' : 'seg')));
    }, SLOW);

    test('mutant: without the bind path, the far-key bind and the one-frame bind do not show', () => {
      const old = withoutBind();
      try {
        const far = setup({ rig: ALT_RIG, map: altMap(farSet([[3, 3], [7, 10]])), pose: poseDoc(FAR) });
        expect(retarget(far, [], old.cli).status).toBe(0);
        const farShown = shows(far.build, 'sleeve_r0').filter((v) => v === 'seg_up').length;
        // The key on the pose (frames 2–4, three frames so clean keeps them), bound on frame 3 alone: one frame, under --switch-min.
        const near = armed((i) => i >= 2 && i <= 4);
        const one = setup({ rig: ALT_RIG, map: altMap(up({ bind: [[3, 3]] })), pose: poseDoc(near) });
        const ro = retarget(one, [], old.cli);
        expect(ro.stderr).toBe('');
        expect(ro.status).toBe(0);
        // Read as a window, frame 3 is picked and then dropped by the minimum span.
        expect(linesOf(ro, 'SWITCH-MIN')).toEqual(['SWITCH-MIN set "up": 1 run(s) shorter than --switch-min 0.25s not shown: frame 3 (1 frame, 0.125s); nearest on 1 run(s), the longest frame 3 (1 frame, 0.125s)']);
        const oneShown = shows(one.build, 'sleeve_r0').filter((v) => v === 'seg_up').length;
        console.log(`  #360 mutant: far-key bind shown on ${farShown}/${BOUND.length}, one-frame bind on ${oneShown}/1`);
        expect(farShown).toBe(0);
        expect(oneShown).toBe(0);
        // The same under the bind path.
        const real = setup({ rig: ALT_RIG, map: altMap(up({ bind: [[3, 3]] })), pose: poseDoc(near) });
        expect(retarget(real).status).toBe(0);
        expect(shows(real.build, 'sleeve_r0').flatMap((v, i) => (v === 'seg_up' ? [i] : []))).toEqual([3]);
      } finally {
        old.done();
      }
    }, SLOW);
  });

  test('set → set directly: the second set\'s frame puts the first set\'s slots back to setup (its extra slot empty)', () => {
    const pose = poseDoc({ ...BASE, ru: (i) => (i <= 7 ? KEY_RU : 60), rf: (i) => (i <= 7 ? KEY_RF : 80) });
    const c = setup({ rig: ALT_RIG, map: altMap(up(), out()), pose });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH').map((l) => l.split(' — ')[0])).toEqual(['SWITCH set "up"', 'SWITCH set "out"']);
    expect(slotTracks(c.out)).toEqual([
      { slot: 'sleeve_r0', property: 'attachment', keys: [{ t: 0, v: 'seg_up' }, { t: 0.9375, v: 'seg_out' }] },
      { slot: 'cap_r', property: 'attachment', keys: [{ t: 0, v: 'cap_up' }, { t: 0.9375, v: null }] },
      { slot: 'sleeve_r1', property: 'attachment', keys: [{ t: 0, v: null }, { t: 0.9375, v: 'seg' }] },
    ]);
    expect(shows(c.build, 'sleeve_r0')).toEqual(each((i) => (i <= 7 ? 'seg_up' : 'seg_out')));
    expect(shows(c.build, 'cap_r')).toEqual(each((i) => (i <= 7 ? 'cap_up' : null)));
    expect(shows(c.build, 'sleeve_r1')).toEqual(each((i) => (i <= 7 ? null : 'seg')));
  }, SLOW);

  // Since #67 every run and gap here is ≥ 3 frames: clean's 5-frame median takes a 1- or 2-frame pose out as a spike,
  // so the minimum is raised to 0.5 s (4 frames) to keep a run, and a gap, shorter than it.
  test('a run shorter than --switch-min is dropped (the base art shows there); control: under a smaller one it stays', () => {
    const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(armed((i) => (i >= 2 && i <= 4) || (i >= 9 && i <= 12))) });
    const r = retarget(c, ['--switch-min', '0.5']);
    expect(r.status).toBe(0);
    // Frames 2–4 are 0.375 s; frames 9–12 are 0.5 s, which is the minimum and stays (the gap, 0.5 s, is not bridged).
    expect(linesOf(r, 'SWITCH').map((l) => /frames? [\d–]+/.exec(l)![0])).toEqual(['frames 9–12']);
    expect(slotTracks(c.out)[0]!.keys).toEqual([{ t: 1.0625, v: 'seg_up' }, { t: 1.5625, v: 'seg' }]);
    const r2 = retarget(c, ['--switch-min', '0.25']);
    expect(r2.status).toBe(0);
    expect(linesOf(r2, 'SWITCH').map((l) => /frames? [\d–]+/.exec(l)![0])).toEqual(['frames 2–4', 'frames 9–12']);
  }, SLOW);

  test('a gap shorter than --switch-min between two runs of one set is bridged (no flash of the base art); control: a gap as long as it is not', () => {
    const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(armed((i) => (i >= 2 && i <= 5) || (i >= 9 && i <= 12))) });
    const r = retarget(c, ['--switch-min', '0.5']);
    expect(r.status).toBe(0);
    // Frames 6–8 are 0.375 s off the key skeleton: bridged, one span 2–12.
    expect(linesOf(r, 'SWITCH').map((l) => /frames? [\d–]+/.exec(l)![0])).toEqual(['frames 2–12']);
    expect(shows(c.build, 'sleeve_r0')).toEqual(each((i) => (i >= 2 && i <= 12 ? 'seg_up' : 'seg')));
    const c2 = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(armed((i) => (i >= 2 && i <= 5) || (i >= 10 && i <= 13))) });
    const r2 = retarget(c2, ['--switch-min', '0.5']);
    expect(r2.status).toBe(0);
    // Frames 6–9 are 0.5 s, the minimum itself: two spans.
    expect(linesOf(r2, 'SWITCH').map((l) => /frames? [\d–]+/.exec(l)![0])).toEqual(['frames 2–5', 'frames 10–13']);
  }, SLOW);

  test('frames (a stopgap): a set shows only inside its window, and there it is chosen over an equal set without one', () => {
    const on = (i: number) => i >= 2 && i <= 12;
    const twin = (o: Record<string, unknown> = {}) => ({ ...up(), name: 'twin', slots: { sleeve_r0: 'seg_out' }, ...o });
    const c = setup({ rig: ALT_RIG, map: altMap(up(), twin({ frames: [[4, 5], [6, 7]] })), pose: poseDoc(armed(on)) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    // Both sets match frames 2–12 exactly: "twin" takes its window 4–7, "up" the rest.
    expect(linesOf(r, 'SWITCH').map((l) => /set "(\w+)".*?frames? ([\d–]+)/.exec(l)!.slice(1).join(' '))).toEqual(['up 2–3', 'twin 4–7', 'up 8–12']);
    expect(shows(c.build, 'sleeve_r0')).toEqual(each((i) => (i >= 4 && i <= 7 ? 'seg_out' : on(i) ? 'seg_up' : 'seg')));
    const bad = setup({ rig: ALT_RIG, map: altMap(up(), twin({ frames: [[7, 4]] })), pose: poseDoc(armed(on)) });
    const rb = retarget(bad);
    expect(rb.status).toBe(1);
    expect(fails(rb).some((l) => l.includes('MAP_ALT_FRAMES'))).toBe(true);
  }, SLOW);

  test('FRAMES: a window that does not switch says why, frame by frame (#43)', () => {
    const on = (i: number) => i >= 6 && i <= 9;
    const c = setup({ rig: ALT_RIG, map: altMap(up({ frames: [[3, 12]] })), pose: poseDoc(armed(on)) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    const l = linesOf(r, 'FRAMES');
    expect(l).toHaveLength(1);
    expect(l[0]).toContain('set "up" window 3–12: frames 3–5 outside the tolerance');
    expect(l[0]).toContain('frames 10–12 outside the tolerance');
    expect(l[0]).toContain('a window restricts a set, it never forces one');
  }, SLOW);

  test('offsets: a stepped translate on the bone, the offset over the span and 0 outside, read back by rig-c\'s poser', () => {
    const on = (i: number) => i >= 5 && i <= 10;
    const c = setup({ rig: ALT_RIG, map: altMap(up({ offsets: { sleeve_r1: [3, -2] } })), pose: poseDoc(armed(on)) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'SWITCH')[0]).toContain('; offsets "sleeve_r1" (3, -2); moved on ');
    const tracks = motionOf(c.out).animations.dance!.tracks as unknown as Array<{ bone?: string; slot?: string; property: string; keys: unknown[] }>;
    expect(tracks.map((t) => `${t.bone ?? t.slot}.${t.property}`).slice(-5)).toEqual(['hip.translate', 'sleeve_r1.translate', 'sleeve_r0.attachment', 'cap_r.attachment', 'sleeve_r1.attachment']);
    expect(tracks.find((t) => t.bone === 'sleeve_r1' && t.property === 'translate')!.keys).toEqual([
      { t: 0, v: [0, 0], ease: 'stepped' },
      { t: 0.5625, v: [3, -2], ease: 'stepped' },
      { t: 1.3125, v: [0, 0] },
    ]);
    // #334: no attachment or stepped key sits on a frame time.
    const frameTimes = (JSON.parse(readFileSync(report, 'utf8')) as { frameTimes: number[] }).frameTimes;
    expect(keysOnFrameTimes(motionOf(c.out) as unknown as MotionDoc, frameTimes)).toEqual([]);
    // The forearm's origin in its parent's axes: setup (70, 0), plus the offset over the span — on every frame and halfway between.
    const doc = loadBuild(c.build);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: 2 * (BASE.n - 1) }, () => BASE.dt / 2));
    const local = poses.map((p) => {
      const b = byName(p.bones);
      const pa = b.get('sleeve_r0')!;
      const ch = b.get('sleeve_r1')!;
      const dx = ch.worldX - pa.worldX;
      const dy = ch.worldY - pa.worldY;
      const det = pa.a * pa.d - pa.b * pa.c;
      return [Math.round(((pa.d * dx - pa.b * dy) / det) * 1000) / 1000 + 0, Math.round(((-pa.c * dx + pa.a * dy) / det) * 1000) / 1000 + 0];
    });
    expect(local).toEqual(Array.from({ length: 2 * BASE.n - 1 }, (_, k) => (k >= 9 && k <= 20 ? [73, -2] : [70, 0])));
    // An origin moved under an x aim turns nothing: every bone lands.
    expect(misses(c.build, armed(on))).toEqual([]);
    expect(reportOf(report).switches[0]!.offsets).toEqual({ sleeve_r1: [3, -2] });
  }, SLOW);

  describe('where a switch is keyed (#31): with --switch-at peak, each boundary at the fastest qualifying frame within ±switch-min/2', () => {
    /** 24 fps, 2 s: the right arm by its upper arm's world angle per frame, the forearm 20° past it (the key skeleton's elbow). */
    const N = 48;
    const DT = 1 / 24;
    const at24 = (ru: (i: number) => number): Motion => ({ ...BASE, n: N, dt: DT, ru, rf: (i) => ru(i) + 20 });
    interface MoveOut { frame: [number, number]; frames: number; seconds: number; window: [number, number]; speed: { old: number; new: number } }
    const movesOf = (path: string) => reportOf(path).switches.map((s) => ({ set: s.set as string, frames: s.frames as [number, number], moved: s.moved as { on: MoveOut | null; off: MoveOut | null } }));
    /** The run's times, rounded to the microsecond as the retarget reads them; a key half a frame before frame i; the seconds from frame a to b. */
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    const tOf = (i: number) => r6(i * DT);
    const keyAt = (i: number) => r6((tOf(i - 1) + tOf(i)) / 2);
    const secs = (a: number, b: number) => r6(tOf(b) - tOf(a));

    /**
     * The arm drifts onto the key skeleton at 1°/frame — within 25° from frame 12
     * (24.5° off), still slow there — then swings the last 23° in: the central
     * difference is 4.75°/frame on 13, 11.75 on 14, 7.5 on 15. It holds the key
     * pose to frame 30 and steps off to 100° on 31 (25°/frame on 30 and 31).
     */
    const DRIFT = at24((i) => (i <= 13 ? 113.5 + i : i === 14 ? 135 : i <= 30 ? 150 : 100));

    test('the pose reaches the key skeleton on a slow frame: the on-key moves to the speed peak 2 frames later, read back by rig-c\'s poser; the default (first) keeps it', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(DRIFT) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report, '--switch-at', 'peak']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(movesOf(report)).toEqual([{
        set: 'up',
        frames: [14, 30],
        moved: {
          on: { frame: [12, 14], frames: 2, seconds: secs(12, 14), window: [9, 15], speed: { old: 1, new: 11.75 } },
          // A tie on 30 and 31 (the step): the nearest, where it was.
          off: { frame: [31, 31], frames: 0, seconds: 0, window: [28, 34], speed: { old: 25, new: 25 } },
        },
      }]);
      expect(linesOf(r, 'SWITCH')[0]).toEndWith('; moved on frame 12 → 14 (+2 frames, +0.083s; 1.0°/frame → 11.8°/frame; window frames 9–15), off frame 31 stays (25.0°/frame; window frames 28–34)');
      // Keyed half a frame before the frame it now shows on.
      expect(slotTracks(c.out)[0]).toEqual({ slot: 'sleeve_r0', property: 'attachment', keys: [{ t: keyAt(14), v: 'seg_up' }, { t: keyAt(31), v: 'seg' }] });
      expect(shows(c.build, 'sleeve_r0', N, DT)).toEqual(each((i) => (i >= 14 && i <= 30 ? 'seg_up' : 'seg'), N));
      expect(misses(c.build, DRIFT)).toEqual([]);

      const first = join(c.dir, 'first.json');
      // The default keeps it.
      const f = retarget(c, ['--report', first]);
      expect(f.status).toBe(0);
      expect(reportOf(first).options.switchAt).toBe('first');
      expect(movesOf(first)).toEqual([{
        set: 'up',
        frames: [12, 30],
        moved: {
          on: { frame: [12, 12], frames: 0, seconds: 0, window: [9, 15], speed: { old: 1, new: 1 } },
          off: { frame: [31, 31], frames: 0, seconds: 0, window: [28, 34], speed: { old: 25, new: 25 } },
        },
      }]);
      expect(shows(c.build, 'sleeve_r0', N, DT)).toEqual(each((i) => (i >= 12 && i <= 30 ? 'seg_up' : 'seg'), N));
    }, SLOW);

    test('a window clipped by the minimum span: a span of exactly --switch-min cannot shrink to reach its peak; control: the same approach in a longer span moves', () => {
      // Within 25° from frame 10 at 1°/frame; the swing in peaks on 12 (11.75°/frame); the span ends where the arm steps off.
      const approach = (leave: number) => at24((i) => (i <= 11 ? 115.5 + i : i === 12 ? 140 : i < leave ? 150 : 100));
      const short = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(approach(16)) });
      const report = join(short.dir, 'report.json');
      expect(retarget(short, ['--report', report, '--switch-at', 'peak']).status).toBe(0);
      // Frames 10–15 are 0.25 s: the on-key may only move earlier (frames 7–10, all 1°/frame), the off-key only later.
      expect(movesOf(report)).toEqual([{
        set: 'up',
        frames: [10, 15],
        moved: {
          on: { frame: [10, 10], frames: 0, seconds: 0, window: [7, 10], speed: { old: 1, new: 1 } },
          off: { frame: [16, 16], frames: 0, seconds: 0, window: [16, 19], speed: { old: 25, new: 25 } },
        },
      }]);
      const long = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(approach(20)) });
      const report2 = join(long.dir, 'report.json');
      expect(retarget(long, ['--report', report2, '--switch-at', 'peak']).status).toBe(0);
      expect(movesOf(report2)[0]!.frames).toEqual([12, 19]);
      expect(movesOf(report2)[0]!.moved.on).toEqual({ frame: [10, 12], frames: 2, seconds: secs(10, 12), window: [7, 13], speed: { old: 1, new: 11.75 } });
    }, SLOW);

    test('set → set: the boundary between two sets moves once, one key per slot, no frame of base art between them', () => {
      // "up" (150°) eases toward "near" (110°): nearer "near" from frame 20 (129.5°), then the last 18° fast — 8°/frame on 22.
      const near = (o: Record<string, unknown> = {}) => out({ name: 'near', pose: keySkeleton(110, 130), ...o });
      const RU: Record<number, number> = { 16: 145, 17: 140, 18: 135, 19: 131, 20: 129.5, 21: 128, 22: 120, 23: 112 };
      const m = at24((i) => (i <= 15 ? 150 : RU[i] ?? 110));
      const c = setup({ rig: ALT_RIG, map: altMap(up(), near()), pose: poseDoc(m) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report, '--switch-at', 'peak']);
      expect(r.status).toBe(0);
      const mv = movesOf(report);
      expect(mv.map((s) => `${s.set} ${s.frames.join('–')}`)).toEqual(['up 0–21', 'near 22–47']);
      const boundary: MoveOut = { frame: [20, 22], frames: 2, seconds: secs(20, 22), window: [17, 23], speed: { old: 1.5, new: 8 } };
      expect(mv[0]!.moved).toEqual({ on: null, off: boundary });
      expect(mv[1]!.moved).toEqual({ on: boundary, off: null });
      expect(slotTracks(c.out)[0]).toEqual({ slot: 'sleeve_r0', property: 'attachment', keys: [{ t: 0, v: 'seg_up' }, { t: keyAt(22), v: 'seg_out' }] });
      expect(shows(c.build, 'sleeve_r0', N, DT)).toEqual(each((i) => (i <= 21 ? 'seg_up' : 'seg_out'), N));
    }, SLOW);

    test('a tie goes to the frame nearest the original', () => {
      // Within 25° from frame 12 (125.5°); 6°/frame on 10 and on 13 both, the window's fastest: 13 is one frame away, 10 two.
      const RU: Record<number, number> = { 10: 118, 11: 124, 12: 125.5, 13: 126, 14: 137.5, 15: 136 };
      const m = at24((i) => (i <= 9 ? 112 : i <= 15 ? RU[i]! : i <= 30 ? 137.5 : 100));
      const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(m) });
      const report = join(c.dir, 'report.json');
      expect(retarget(c, ['--report', report, '--switch-at', 'peak']).status).toBe(0);
      expect(movesOf(report)[0]!.moved.on).toEqual({ frame: [12, 13], frames: 1, seconds: secs(12, 13), window: [9, 15], speed: { old: 1, new: 6 } });
    }, SLOW);

    test('the bound: the window\'s peak would newly show the set 55° from its key skeleton (over 2 × 25°), so it is passed over for a slower frame that is within it', () => {
      // Within 25° from frame 12 (125.5°). Frame 10 is the window's fastest (25°/frame) but 55° off; frame 11 (40° off) is 15.25°/frame.
      const RU: Record<number, number> = { 10: 95, 11: 110, 12: 125.5, 13: 126.5, 14: 127.5, 15: 128.5 };
      const m = at24((i) => (i <= 9 ? 60 : i <= 15 ? RU[i]! : i <= 30 ? 150 : 60));
      const c = setup({ rig: ALT_RIG, map: altMap(up()), pose: poseDoc(m) });
      const report = join(c.dir, 'report.json');
      expect(retarget(c, ['--report', report, '--switch-at', 'peak']).status).toBe(0);
      const mv = movesOf(report)[0]!;
      expect(mv.frames).toEqual([11, 30]);
      expect(mv.moved.on).toEqual({ frame: [12, 11], frames: -1, seconds: secs(12, 11), window: [9, 15], speed: { old: 8.25, new: 15.25 } });
      expect(reportOf(report).switches[0]!.distance).toEqual({ max: 40, median: expect.any(Number) });
      // Control: under a tolerance of 30° (bound 60°) frame 10 qualifies and the boundary goes to the peak.
      const r2 = join(c.dir, 'report2.json');
      expect(retarget(c, ['--report', r2, '--switch-at', 'peak', '--switch-tolerance', '30']).status).toBe(0);
      expect(movesOf(r2)[0]!.moved.on!.frame).toEqual([12, 10]);
    }, SLOW);

    test('--switch-at takes peak or first, nothing else', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(up()) });
      const r = retarget(c, ['--switch-at', 'last']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--switch-at is "last"; it must be peak or first');
    });
  });

  /** One planted map per case; the control is the first test above. */
  const withChain = (name: string, extra: Record<string, unknown>) => ({ ...altMap(up()), chains: baseChains().map((ch) => (ch.name === name ? { ...ch, ...extra } : ch)) });
  const altCases: Array<{ code: string; map: () => Record<string, unknown>; resolves: boolean; want: string }> = [
    { code: 'MAP_ALT_SLOT', map: () => altMap(up({ slots: { sleeve_r9: 'seg_up' } })), resolves: true, want: 'MAP_ALT_SLOT: set "up" — slot "sleeve_r9" is not in the rig; its slots are sleeve_r0, sleeve_r1, sleeve_l0, sleeve_l1, leg_r0, leg_r1, leg_l0, leg_l1, cap_r' },
    { code: 'MAP_ALT_ATTACHMENT', map: () => altMap(up({ slots: { sleeve_r0: 'seg_down', cap_r: 'cap_up' } })), resolves: true, want: 'MAP_ALT_ATTACHMENT: set "up" — slot "sleeve_r0" has no attachment "seg_down" under any skin; it has seg, seg_up, seg_out' },
    { code: 'MAP_ALT_HIDES', map: () => altMap(up({ hides: ['sleeve_r1', 'cuff_r'] })), resolves: true, want: 'MAP_ALT_HIDES: set "up" hides slot "cuff_r", which is not in the rig; its slots are sleeve_r0, sleeve_r1, sleeve_l0, sleeve_l1, leg_r0, leg_r1, leg_l0, leg_l1, cap_r' },
    { code: 'MAP_ALT_HIDES', map: () => altMap(up({ hides: ['sleeve_r0'] })), resolves: false, want: 'MAP_ALT_HIDES: set "up" hides slot "sleeve_r0", which "slots" shows "seg_up" in; a slot of a set either shows or hides' },
    { code: 'MAP_ALT_CHAIN', map: () => altMap(up({ chains: ['arm_x'] })), resolves: false, want: 'MAP_ALT_CHAIN: set "up" names chain "arm_x", which the map does not have; its chains are trunk, arm_r, arm_l, leg_r, leg_l' },
    { code: 'MAP_ALT_JOINT', map: () => altMap(up({ pose: { r_shoulder: [0, 0], r_elbow: [10, 0] } })), resolves: false, want: 'MAP_ALT_JOINT: set "up" "pose" has no "r_wrist"; chain "arm_r" uses r_shoulder, r_elbow, r_wrist, and every one of them must be in the key skeleton' },
    { code: 'MAP_ALT_DRAWN', map: () => altMap(up({ drawn: { sleeve_l0: 10 } })), resolves: false, want: 'MAP_ALT_DRAWN: set "up" "drawn" names bone "sleeve_l0", which is not a bone of its chains (arm_r: sleeve_r0, sleeve_r1)' },
    { code: 'MAP_ALT_OFFSET', map: () => altMap(up({ offsets: { leg_r0: [1, 1] } })), resolves: false, want: 'MAP_ALT_OFFSET: set "up" "offsets" names bone "leg_r0", which is not a bone of its chains (arm_r: sleeve_r0, sleeve_r1)' },
    { code: 'MAP_ALT_OFFSET', map: () => altMap(up({ offsets: { hip: [1, 1] } })), resolves: false, want: 'MAP_ALT_OFFSET: set "up" "offsets" names bone "hip", which "translate" already keys; a bone carries one translate track' },
    { code: 'MAP_RANGE', map: () => withChain('arm_r', { range: { sleeve_l0: [-10, 10] } }), resolves: false, want: 'MAP_RANGE: chain "arm_r" "range" names bone "sleeve_l0", which is not a bone of the chain; its bones are sleeve_r0, sleeve_r1' },
    { code: 'MAP_RANGE', map: () => withChain('arm_r', { range: { sleeve_r0: [10, -10] } }), resolves: false, want: 'MAP_RANGE: chain "arm_r" "range" bone "sleeve_r0" is [10,-10]; it must be [min, max], two finite numbers of degrees with min ≤ max' },
  ];
  altCases.forEach((ac, k) => {
    test(`map: ${ac.code} (${k + 1} of ${altCases.length}) — ${ac.resolves ? 'against the built rig' : 'as read'}`, () => {
      const c = setup({ rig: ALT_RIG, map: ac.map() });
      const r = retarget(c);
      expect(r.status).toBe(1);
      const f = fails(r);
      if (ac.resolves) expect(f).toEqual([`FAIL  MAP_RESOLVES: ${c.map} does not resolve against the rig`, `FAIL  ${ac.want}`]);
      else expect(f).toEqual([`FAIL  ${ac.want}`]);
      expect(existsSync(c.out)).toBe(false);
    }, SLOW);
  });

  describe('range: a rotate key past its range is clamped outside a set\'s span, and listed', () => {
    /** The chest still at 90°, so the right upper arm's key is its turn from rest (−100°): 10° everywhere, 50° on frames 4–7. */
    const lifted = (i: number) => i >= 4 && i <= 7;
    const RANGED: Motion = { ...BASE, trunk: () => 90, ru: (i) => -100 + (lifted(i) ? 50 : 10), rf: (i) => -100 + (lifted(i) ? 50 : 10) + 25 };
    const rangedMap = (limits: [number, number], ...sets: Array<Record<string, unknown>>) => ({ ...altMap(...sets), chains: baseChains().map((ch) => (ch.name === 'arm_r' ? { ...ch, range: { sleeve_r0: limits } } : ch)) });
    /** A set painted at the lifted arm (its key skeleton is frames 4–7's pose). */
    const lift = (o: Record<string, unknown> = {}) => ({ name: 'lift', slots: { sleeve_r0: 'seg_up' }, chains: ['arm_r'], pose: keySkeleton(-50, -25), ...o });

    test('frames 4–7 clamped at +30: the upper arm stops there, the forearm still lands on its pose angle, RANGE listed', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-30, 30]), pose: poseDoc(RANGED) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'RANGE')).toEqual([
        'RANGE  chain "arm_r" bone "sleeve_r0" frames 4–7 (t=0.500–0.875s): 0.500s the pose asks its rotate key past its range [-30, 30] (+50.0°, up to 20.0° past); clamped at the limit — demand for an alternate',
      ]);
      // Landing is measured against the clamped targets, and holds.
      expect(linesOf(r, 'LAND')).toHaveLength(10);
      // Read back by rig-c: the upper arm at −100 + 30 on the clamped frames, every other bone (the forearm below it too) on the pose.
      expect(misses(c.build, RANGED, (b, i) => (b === 'sleeve_r0' && lifted(i) ? -70 : angleOf(RANGED, b, i)))).toEqual([]);
      expect(misses(c.build, RANGED).every((m) => m.startsWith('sleeve_r0 '))).toBe(true);
      expect(legacyReportRows(reportOf(report).range, ['times', 'spanSeconds'])).toEqual([{ chain: 'arm_r', bone: 'sleeve_r0', frames: [4, 7], seconds: 0.5, maxOverflow: 20, key: 50, limits: [-30, 30] }]);
    }, SLOW);

    test('control: without a range the same pose is keyed as given, and nothing is listed', () => {
      const c = setup({ rig: ALT_RIG, map: altMap(), pose: poseDoc(RANGED) });
      const r = retarget(c);
      expect(r.status).toBe(0);
      expect(linesOf(r, 'RANGE')).toEqual([]);
      expect(misses(c.build, RANGED)).toEqual([]);
    }, SLOW);

    test('inside a span of a set depicting the chain nothing is clamped; at the drawn angle the bone is posed exactly there (criterion 3)', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-30, 30], lift({ drawn: { sleeve_r0: -50, sleeve_r1: -25 } })), pose: poseDoc(RANGED) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'SWITCH')).toEqual([
        'SWITCH set "lift" — shows "sleeve_r0" = "seg_up"; chains arm_r; frames 4–7 (t=0.500s until 1.000s) — distance max 0.0°, median 0.0°; art turn "sleeve_r0" max 0.0°, median 0.0°; "sleeve_r1" max 0.0°, median 0.0°; moved on frame 4 stays (20.0°/frame; window frames 3–5), off frame 8 stays (20.0°/frame; window frames 7–9)',
      ]);
      expect(linesOf(r, 'RANGE')).toEqual([]);
      expect(linesOf(r, 'ART-RANGE')).toEqual([]);
      expect(misses(c.build, RANGED)).toEqual([]);
      // The reference equals `drawn` on the switched frames: rig-c's poser puts each bone at its drawn world angle.
      const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: BASE.n - 1 }, () => BASE.dt));
      for (let i = 4; i <= 7; i++) {
        const b = byName(poses[i]!.bones);
        expect(Math.abs(wrap(worldAngle(b, 'sleeve_r0') - -50))).toBeLessThanOrEqual(ANGLE_TOL);
        expect(Math.abs(wrap(worldAngle(b, 'sleeve_r1') - -25))).toBeLessThanOrEqual(ANGLE_TOL);
      }
      const rep = reportOf(report);
      expect(rep.switches[0]!.artTurn).toEqual({ sleeve_r0: { max: 0, median: 0 }, sleeve_r1: { max: 0, median: 0 } });
      expect(rep.range).toEqual([]);
    }, SLOW);

    // Changed by #355: a key 30° from its drawing (past --switch-tolerance) chose a drawing for a pose it is not of, so it is
    // now refused; the ART-RANGE reading is held on a drawing 20° from its key, within the tolerance.
    test('ART-RANGE: inside the span the reference sits 20° off drawn, range ±10 — 10° past it, listed, and the bone not clamped; a drawing 30° off is refused (#355)', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-10, 10], lift({ drawn: { sleeve_r0: -70 } })), pose: poseDoc(RANGED) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'ART-RANGE')).toEqual([
        'ART-RANGE set "lift" chain "arm_r" bone "sleeve_r0" turned +20.0° from drawn (range [-10, 10]) frames 4–7 (t=0.500–0.875s): 0.500s, up to 10.0° past it; the bone follows the pose — demand for another drawing of the set',
      ]);
      // Outside the span the key is 10°, at the limit: nothing clamped there either.
      expect(linesOf(r, 'RANGE')).toEqual([]);
      expect(misses(c.build, RANGED)).toEqual([]);
      const rep = reportOf(report);
      expect(legacyReportRows(rep.artRange, ['times', 'spanSeconds'])).toEqual([{ set: 'lift', chain: 'arm_r', bone: 'sleeve_r0', frames: [4, 7], seconds: 0.5, maxOverflow: 10, turn: 20, limits: [-10, 10], clamped: false }]);
      expect(rep.switches[0]!.artTurn).toEqual({ sleeve_r0: { max: 20, median: 20 } });
      // The old fixture: drawn −80°, its key −50°, 30° apart — refused by name, nothing written.
      const off = setup({ rig: ALT_RIG, map: rangedMap([-10, 10], lift({ drawn: { sleeve_r0: -80 } })), pose: poseDoc(RANGED) });
      const refused = retarget(off);
      expect(refused.status).toBe(1);
      expect(fails(refused)).toEqual([
        'FAIL  SET_KEY_DRAWN: set "lift" bone "sleeve_r0": its key skeleton r_shoulder → r_elbow points at −50.00° and its "drawn" angle is −80.00°, 30.00° apart, more than --switch-tolerance 25°; the set is chosen by its key and shown at its drawn angle, so it would show this drawing turned that far from its pose — make the key skeleton the drawing\'s, or correct "drawn"',
      ]);
      expect(existsSync(off.out)).toBe(false);
    }, SLOW);

    test('the set\'s turn holds the art: drawn −80°, turn ±10, reference 30° past drawn — clamped at drawn +10°, listed, and the forearm keeps its own angle', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-10, 10], lift({ drawn: { sleeve_r0: -80 }, turn: { sleeve_r0: [-10, 10] } })), pose: poseDoc(RANGED) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'ART-RANGE')).toEqual([
        'ART-RANGE set "lift" chain "arm_r" bone "sleeve_r0" turned +30.0° from drawn (range [-10, 10]) frames 4–7 (t=0.500–0.875s): 0.500s, up to 20.0° past it; held at the limit — demand for another drawing of the set',
      ]);
      expect(reportOf(report).artRange[0]!.clamped).toBe(true);
      const poses = poseRawAnimation(loadBuild(c.build), 'dance', Array.from({ length: BASE.n - 1 }, () => BASE.dt));
      for (let i = 4; i <= 7; i++) {
        const b = byName(poses[i]!.bones);
        expect(Math.abs(wrap(worldAngle(b, 'sleeve_r0') - -70))).toBeLessThanOrEqual(ANGLE_TOL);
        expect(Math.abs(wrap(worldAngle(b, 'sleeve_r1') - angleOf(RANGED, 'sleeve_r1', i)))).toBeLessThanOrEqual(ANGLE_TOL);
      }
      // Every frame and half-frame: the pose's own angles, the upper arm held at drawn +10° on the span.
      expect(misses(c.build, RANGED, (b, i) => (b === 'sleeve_r0' && i >= 4 && i <= 7 ? -70 : angleOf(RANGED, b, i)))).toEqual([]);
    }, SLOW);

    test('MAP_ALT_TURN: a turn on a bone the set has no drawn angle for is refused by name', () => {
      const c = setup({ rig: ALT_RIG, map: rangedMap([-10, 10], lift({ drawn: { sleeve_r0: -80 }, turn: { sleeve_r1: [-10, 10] } })), pose: poseDoc(RANGED) });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r).some((l) => l.includes('MAP_ALT_TURN') && l.includes('"sleeve_r1"'))).toBe(true);
    }, SLOW);
  });

  describe('TURN: a line across the body short or reversed for ≥ 0.15 s', () => {
    /** 30 fps, so 6 frames are 0.2 s and 2 are 0.067 s. */
    const T: Motion = { ...BASE, dt: 1 / 30 };
    /** The hips moved to `r` and `l` about their midpoint on `len` frames from `from`, each leg moved with its hip (every segment the map aims keeps its angle). */
    const hips = (from: number, len: number, r: Pt, l: Pt): Record<string, unknown> => poseDoc(T, (i, j) => {
      if (i < from || i >= from + len) return;
      const rh = j.r_hip!.at as Pt;
      const lh = j.l_hip!.at as Pt;
      const mid: Pt = [(rh[0] + lh[0]) / 2, (rh[1] + lh[1]) / 2];
      const move = (names: string[], from: Pt, to: Pt) => {
        for (const nm of names) {
          const a = j[nm]!.at as Pt;
          j[nm] = { state: 'observed', at: [a[0] + to[0] - from[0], a[1] + to[1] - from[1]], score: 0.9 };
        }
      };
      move(['r_knee', 'r_ankle', 'r_hip'], rh, add(mid, r));
      move(['l_knee', 'l_ankle', 'l_hip'], lh, add(mid, l));
    });

    test('the hip line at 0.3 of its length for 6 frames: TURN, and no key moves', () => {
      const c = setup({ pose: hips(5, 6, [-4.5, 0], [4.5, 0]) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'TURN')).toEqual([
        'TURN   line "hip" (r_hip → l_hip) frames 5–10 (t=0.167–0.333s): 0.200s picture length down to 0.30 of its median, under 0.5, ≥ 0.15s — the body or head turned, a pose the rig cannot draw',
      ]);
      expect(legacyReportRows(reportOf(report).turns, ['times', 'spanSeconds', 'bones'])).toEqual([{ line: 'hip', joints: ['r_hip', 'l_hip'], frames: [5, 10], seconds: 0.2, minFraction: expect.closeTo(0.3, 9), reversed: false }]);
      expect(misses(c.build, T)).toEqual([]);
    }, SLOW);

    test('control: 2 frames (0.067 s) is no TURN', () => {
      const c = setup({ pose: hips(7, 2, [-4.5, 0], [4.5, 0]) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.status).toBe(0);
      expect(linesOf(r, 'TURN')).toEqual([]);
      expect(reportOf(report).turns).toEqual([]);
    }, SLOW);

    test('the hips swapped for 6 frames (full length, pointing the other way): TURN, reversed', () => {
      const c = setup({ pose: hips(5, 6, [15, 0], [-15, 0]) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'TURN')).toEqual([
        'TURN   line "hip" (r_hip → l_hip) frames 5–10 (t=0.167–0.333s): 0.200s reversed (pointing more than 90° from r_hip → l_hip\'s own way), picture length down to 1.00 of its median, ≥ 0.15s — the body or head turned, a pose the rig cannot draw',
      ]);
      expect(legacyReportRows(reportOf(report).turns, ['times', 'spanSeconds', 'bones'])).toEqual([{ line: 'hip', joints: ['r_hip', 'l_hip'], frames: [5, 10], seconds: 0.2, minFraction: expect.closeTo(1, 9), reversed: true }]);
    }, SLOW);

    test('a line the map does not use is read too: the eye line at 0.3 for 6 frames', () => {
      const pose = poseDoc(T, (i, j) => {
        if (i < 5 || i > 10) return;
        const nose = j.nose!.at as Pt;
        j.r_eye = { state: 'observed', at: add(nose, [-1.8, -5]), score: 0.9 };
        j.l_eye = { state: 'observed', at: add(nose, [1.8, -5]), score: 0.9 };
      });
      const c = setup({ pose });
      const r = retarget(c);
      expect(r.status).toBe(0);
      expect(linesOf(r, 'TURN')).toEqual([
        'TURN   line "eye" (r_eye → l_eye) frames 5–10 (t=0.167–0.333s): 0.200s picture length down to 0.30 of its median, under 0.5, ≥ 0.15s — the body or head turned, a pose the rig cannot draw',
      ]);
    }, SLOW);
  });

  describe('uncovered folds', () => {
    /** The right forearm folded back on frames 6–9, as in the fold test above. */
    const HARD: Motion = { ...BASE, rf: (i) => (i >= 6 && i <= 9 ? BASE.ru(i) + 170 : BASE.rf(i)) };
    /** A key skeleton within 10° of frames 6 and 7 only (frame 8 is 12° off, 9 is 20°). */
    const folded = keySkeleton(172, 342);
    const MESH_RIG: RigOpts = { mesh: true, extra: { ...ALT_RIG.extra, arm_mesh: { arm_mesh_up: { image: 'seg.png', x: 30, y: 0, rotation: 90 } } }, extraSlots: ALT_RIG.extraSlots };
    const foldTimes = (r: Ran): number[] => {
      const l = linesOf(r, 'FOLD').find((x) => x.includes('"arm_mesh"'));
      return l === undefined ? [] : l.split('t=')[1]!.split(', ').flatMap((s) => {
        const [a, b] = s.split('–').map(Number);
        const ts: number[] = [];
        for (let t = a!; t <= (b ?? a!) + 1e-9; t += 0.125) ts.push(Math.round(t * 1000) / 1000);
        return ts;
      });
    };

    test('control: with no switch the mesh folds on frames 6–9, and every fold is uncovered', () => {
      const c = setup({ rig: MESH_RIG, pose: poseDoc(HARD) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report]);
      expect(r.status).toBe(0);
      expect(foldTimes(r)).toEqual([0.75, 0.875, 1, 1.125]);
      expect(legacyReportRows(reportOf(report).uncovered, ['domain'])).toEqual([{ slot: 'arm_mesh', attachment: 'arm_mesh', chains: ['arm_r'], times: [0.75, 0.875, 1, 1.125] }]);
      // No map alternates, no UNCOVERED lines.
      expect(linesOf(r, 'UNCOVERED')).toEqual([]);
    }, SLOW);

    test('the folding mesh replaced on frames 6–7: rigc reads no fold there, and the folds on 8–9 are uncovered', () => {
      const set = { name: 'folded', slots: { arm_mesh: 'arm_mesh_up' }, chains: ['arm_r'], pose: folded };
      const c = setup({ rig: MESH_RIG, map: altMap(set), pose: poseDoc(HARD) });
      const report = join(c.dir, 'report.json');
      // Kept where the selection puts it (--switch-at first): what is read here is the coverage, not the timing.
      const r = retarget(c, ['--report', report, '--switch-tolerance', '10', '--switch-at', 'first']);
      expect(r.status).toBe(0);
      expect(linesOf(r, 'SWITCH')[0]).toContain('frames 6–7');
      expect(foldTimes(r)).toEqual([1, 1.125]);
      expect(legacyReportRows(reportOf(report).uncovered, ['domain'])).toEqual([{ slot: 'arm_mesh', attachment: 'arm_mesh', chains: ['arm_r'], times: [1, 1.125] }]);
      expect(linesOf(r, 'UNCOVERED')).toEqual(['UNCOVERED mesh "arm_mesh" (slot "arm_mesh"; chains arm_r) folds with no switch covering it on 2 frame(s): t=1.000–1.125']);
    }, SLOW);

    test('the folding mesh hidden by a set that shows another slot: no fold read on its span either', () => {
      const c = setup({ rig: MESH_RIG, map: altMap(up({ hides: ['arm_mesh'], pose: folded })), pose: poseDoc(HARD) });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--report', report, '--switch-tolerance', '10', '--switch-at', 'first']);
      expect(r.status).toBe(0);
      expect(slotTracks(c.out).map((t) => t.slot)).toEqual(['sleeve_r0', 'cap_r', 'arm_mesh']);
      expect(foldTimes(r)).toEqual([1, 1.125]);
      expect(legacyReportRows(reportOf(report).uncovered, ['domain'])).toEqual([{ slot: 'arm_mesh', attachment: 'arm_mesh', chains: ['arm_r'], times: [1, 1.125] }]);
    }, SLOW);
  });
});

// --- #43: what two independent solvers ran into ------------------------------------

describe('#43: the older pose name, --images, the rigc version, and why a window did not switch', () => {
  test('a rig-c-pose-frames/0 file (painting-px, an fps key) is read as it is; a wrong space for it is refused by name', () => {
    const doc = poseDoc(BASE) as Record<string, unknown>;
    const older = { ...doc, spec: 'rig-c-pose-frames/0', space: { units: 'painting-px', origin: 'top-left', y: 'down' }, fps: 8 };
    const c = setup({ pose: older });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(misses(c.build, BASE)).toEqual([]);
    const bad = setup({ pose: { ...older, space: doc.space } });
    const rb = retarget(bad);
    expect(rb.status).toBe(1);
    expect(fails(rb).some((l) => l.includes('POSE_SPACE') && l.includes('rig-c-pose-frames/0'))).toBe(true);
  }, SLOW);

  test('--images reaches a rig.json copied away from its images; without it the gate is red by name', () => {
    const c = setup();
    const copy = join(c.dir, 'copied');
    mkdirSync(copy, { recursive: true });
    cpSync(join(c.rig, 'rig.json'), join(copy, 'rig.json'));
    const without = cli(['retarget', '--rig', copy, '--map', c.map, '--pose', c.pose, '--out', c.out]);
    expect(without.status).toBe(1);
    expect(fails(without).some((l) => l.includes('RIG_GATE_BASE'))).toBe(true);
    const withImages = cli(['retarget', '--rig', copy, '--images', join(c.rig, 'images'), '--map', c.map, '--pose', c.pose, '--out', c.out]);
    expect(withImages.stderr).toBe('');
    expect(withImages.status).toBe(0);
  }, SLOW);

  test('the run and the report name the rigc that gated it', () => {
    const c = setup();
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    const v = (JSON.parse(readFileSync(join(ROOT, 'node_modules', '@rig-c', 'core', 'package.json'), 'utf8')) as { version: string }).version;
    expect(linesOf(r, 'RIGC')[0]).toContain(`rig-c ${v}`);
    expect((JSON.parse(readFileSync(report, 'utf8')) as { rigc: { version: string } }).rigc.version).toBe(v);
  }, SLOW);
});

// --- #47: the legs foreshorten, and the hip comes from the supporting foot ---------

describe('#47: --leg-scale and --plant-feet', () => {
  /** Both legs parallel, thigh at −95° and shin at −97° (Spine degrees), 80 and 70 px straight. */
  const THIGH = -95;
  const SHIN = -97;
  const N = 24;
  const DT = 1 / 24;
  /** The knees bend toward the camera: thigh and shin at f of their length in the picture, f 1 → 0.85 → 1. */
  const bendF = (i: number): number => (i < 6 || i > 18 ? 1 : 1 - 0.15 * Math.sin(((i - 6) / 12) * Math.PI));
  const STILL: Motion = { ...BASE, n: N, dt: DT, rt: () => THIGH, rs: () => SHIN, lt: () => THIGH, ls: () => SHIN, hip: () => [0, 0] };
  /** The leg vector hip → ankle in the picture at full length (y down). */
  const V = add(dir(THIGH, 80), dir(SHIN, 70));

  /**
   * A pose whose legs are scaled by `f(i)` with both ankles held where they are
   * at f = 1, plus `lift(i, side)` px up on each ankle (the knee stays); the
   * rest of the body travels with the hip.
   */
  function legsPose(f: (i: number) => number, lift: (i: number, side: 'r' | 'l') => number = () => 0, rise: (i: number) => number = () => 0): Record<string, unknown> {
    return poseDoc(STILL, (i, j) => {
      const drop: Pt = [(1 - f(i)) * V[0], (1 - f(i)) * V[1] - rise(i)];
      for (const [name, at] of Object.entries(j)) {
        const a = at.at as Pt;
        if (name.endsWith('_ankle') || name.endsWith('_knee')) continue;
        j[name] = { ...at, at: [a[0] + drop[0], a[1] + drop[1]] };
      }
      for (const s of ['r', 'l'] as const) {
        const hip = j[`${s}_hip`]!.at as Pt;
        const knee = add(hip, dir(THIGH, 80 * f(i)));
        const ankle = add(knee, dir(SHIN, 70 * f(i)));
        j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
        j[`${s}_ankle`] = { state: 'observed', at: [ankle[0], ankle[1] - lift(i, s)], score: 0.9 };
      }
    });
  }

  interface Posed {
    hip: Pt[];
    ankle: { r: Pt[]; l: Pt[] };
    len: { [bone: string]: number[] };
  }
  /** The gated build posed by rig-c, read independently: the hip's origin, each shin's tip, each leg bone's world x-axis length over setup. */
  function posedLegs(build: string): Posed {
    const doc = loadBuild(build);
    const poses = poseRawAnimation(doc, 'dance', Array.from({ length: N - 1 }, () => DT), {}, 'animation');
    const out: Posed = { hip: [], ankle: { r: [], l: [] }, len: { leg_r0: [], leg_r1: [], leg_l0: [], leg_l1: [] } };
    for (const p of poses) {
      const b = byName(p.bones);
      out.hip.push([b.get('hip')!.worldX, b.get('hip')!.worldY]);
      for (const s of ['r', 'l'] as const) {
        const shin = b.get(`leg_${s}1`)!;
        out.ankle[s].push([shin.worldX + shin.a * 70, shin.worldY + shin.c * 70]);
      }
      for (const n of Object.keys(out.len)) out.len[n]!.push(Math.hypot(b.get(n)!.a, b.get(n)!.c));
    }
    return out;
  }
  const spread = (ps: Pt[]): number => Math.max(...ps.map((p) => Math.hypot(p[0] - ps[0]![0], p[1] - ps[0]![1])));
  /** A rig leg, hip → ankle at full length, world units. */
  const LEG = 150;

  test('knees bending toward the camera: the legs shorten, the feet stay within 0.02 leg lengths, and the hip drops by the scaled amount', () => {
    const c = setup({ pose: legsPose(bendF) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LEG-SCALE')).toHaveLength(4);
    expect(linesOf(r, 'LEG-SCALE')[0]).toContain('chain "leg_r" bone "leg_r0" (r_hip → r_knee): straight length 80.0px');
    expect(linesOf(r, 'LEG-SCALE')[0]).toContain('none under 0.8; none over 1.05');
    // Every scale and both ankles land, by the package's own check.
    const lands = linesOf(r, 'LAND');
    expect(lands.filter((l) => l.includes(' scale — '))).toHaveLength(4);
    expect(lands.filter((l) => l.includes(' ankle — '))).toHaveLength(2);
    const p = posedLegs(c.build);
    // Independently: each segment's world length is f of setup's …
    for (let i = 0; i < N; i++) for (const n of Object.keys(p.len)) expect(Math.abs(p.len[n]![i]! - bendF(i))).toBeLessThan(1e-4);
    // … the feet do not move …
    expect(spread(p.ankle.r)).toBeLessThan(0.02 * LEG);
    expect(spread(p.ankle.l)).toBeLessThan(0.02 * LEG);
    expect(spread(p.ankle.r)).toBeLessThan(0.05);
    // … and the hip drops by (1 − f) of the rig's leg, along it (80 and 70 units at −95° and −97°).
    const W: Pt = [80 * Math.cos(THIGH * RAD) + 70 * Math.cos(SHIN * RAD), 80 * Math.sin(THIGH * RAD) + 70 * Math.sin(SHIN * RAD)];
    for (let i = 0; i < N; i++) {
      const want: Pt = [p.hip[0]![0] + (1 - bendF(i)) * W[0], p.hip[0]![1] + (1 - bendF(i)) * W[1]];
      expect(Math.hypot(p.hip[i]![0] - want[0], p.hip[i]![1] - want[1])).toBeLessThan(0.05);
    }
    expect(p.hip[0]![1] - Math.min(...p.hip.map((h) => h[1]))).toBeGreaterThan(0.14 * LEG);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { options: { legScale: unknown; plantFeet: boolean }; feet: { planted: boolean; supports: unknown[]; jumps: unknown[] }; legScale: Array<{ bone: string; low: unknown[] }> };
    expect(rep.options.legScale).toEqual([0.8, 1.05]);
    expect(rep.options.plantFeet).toBe(true);
    expect(rep.feet.planted).toBe(true);
    expect(rep.feet.jumps).toEqual([]);
    expect(rep.legScale.map((l) => l.bone)).toEqual(['leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']);
    // #83: docs/REFERENCE.md's `--report` paragraph is the documented interface. Its `feet` keys are read from
    // the reference itself and must equal the written ones, so a field added or dropped without the
    // reference fails here; `gate` is documented as a string and written as one.
    const readme = readFileSync(join(import.meta.dir, '..', 'docs', 'REFERENCE.md'), 'utf8');
    const para = readme.split('\n').find((l) => l.startsWith('`--report <file>` writes all of it as JSON (`rig-pose-report/1`)'))!;
    const feetDoc = /`feet` \(([^;)]*)/.exec(para)![1]!;
    const documented = [...feetDoc.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!).sort();
    expect(Object.keys(rep.feet).sort()).toEqual(documented);
    // The report's top level: the paragraph's names outside its parentheses, and the demand lists below it.
    // A list the reference marks as present only with `place` (#93) is absent here: this map declares none.
    // Its presence on a run that does is held by the "by-hip" block below.
    const doc = documentedReport();
    expect(doc.conditional).toEqual(['byHip']);
    expect(Object.keys(rep).sort()).toEqual(doc.all.filter((k) => !doc.conditional.includes(k)));
    expect('byHip' in rep).toBe(false);
    expect(para).toContain("`gate` (rig-c's gate summary, a string)");
    expect(typeof (rep as unknown as { gate: unknown }).gate).toBe('string');
  }, SLOW);

  test('control: without the two flags the same pose keys no scale, and the hip follows the pose\'s travel with the feet sliding', () => {
    const c = setup({ pose: legsPose(bendF) });
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'LEG-SCALE')).toEqual([]);
    expect(motionOf(c.out).animations.dance!.tracks.map((t) => t.property)).not.toContain('scalex');
    const p = posedLegs(c.build);
    // The figure's legs are 1.5× the pose's (the scale is set by the trunk), and rigid: the ankles drop with the hip.
    expect(spread(p.ankle.r)).toBeGreaterThan(0.1 * LEG);
  }, SLOW);

  test('the scale is clamped at the declared limits, and the frames clamped are listed', () => {
    const c = setup({ pose: legsPose(bendF) });
    const r = retarget(c, ['--leg-scale', '0.9,1.05']);
    expect(r.status).toBe(0);
    const clamped = Array.from({ length: N }, (_, i) => i).filter((i) => bendF(i) < 0.9);
    const line = linesOf(r, 'LEG-SCALE')[0]!;
    expect(line).toContain(`${clamped.length} frame(s) under 0.9, clamped (frames ${clamped[0]}–${clamped[clamped.length - 1]})`);
    const p = posedLegs(c.build);
    for (const i of clamped) expect(Math.abs(p.len.leg_r0![i]! - 0.9)).toBeLessThan(1e-4);
  }, SLOW);

  test('mutant: the shin keyed by the unit-scale formula under a scaled thigh misses, and POSE_LANDS names it', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'retarget.ts');
      const from = 'const solvedKey = (b: string, i: number) => legPoses?.[i]!.solved.get(b);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const solvedKey = (_b: string, _i: number): { rotate: number; scale: number } | undefined => undefined;'));
      // Knees bent in the picture (the shin 20° off the thigh), so the thigh's scale turns the shin.
      const bent: Motion = { ...STILL, rs: () => THIGH - 20 };
      const c = setup({ pose: poseDoc(bent, (i, j) => {
        for (const s of ['r', 'l'] as const) {
          const hip = j[`${s}_hip`]!.at as Pt;
          const knee = add(hip, dir(THIGH, 80 * bendF(i)));
          j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
          j[`${s}_ankle`] = { state: 'observed', at: add(knee, dir(s === 'r' ? THIGH - 20 : SHIN, 70 * bendF(i))), score: 0.9 };
        }
      }) });
      const r = retarget(c, ['--leg-scale', '0.8,1.05'], join(d, 'cli.ts'));
      expect(r.status).toBe(1);
      expect(fails(r).some((l) => l.startsWith('FAIL  POSE_LANDS: bone "leg_r1" aim'))).toBe(true);
      expect(fails(r).some((l) => l.startsWith('FAIL  POSE_LANDS: bone "leg_r1" scale'))).toBe(true);
      // Control: the package itself lands the same pose.
      const ok = retarget(c, ['--leg-scale', '0.8,1.05']);
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);
      expect(linesOf(ok, 'SHEAR').find((l) => l.startsWith('SHEAR  bone "leg_r1"'))).toMatch(/art sheared up to [1-9]/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('a jump (both ankles up) releases the plant: the hip follows the pose\'s travel, and re-plants on landing', () => {
    /** Frames 10–13: the whole figure 20 px up (0.13 of its 150 px legs). */
    const rise = (i: number): number => (i >= 10 && i <= 13 ? 20 : 0);
    const c = setup({ pose: legsPose(() => 1, () => 0, rise) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): 10–13');
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { jumps: unknown; changes: Array<{ frame: number; from: string | null; to: string }> } };
    expect(rep.feet.jumps).toEqual([[10, 13]]);
    // Landing on frame 14 moves both ankles 20 px (a step's speed), so the plant is taken on 15, the first still frame.
    expect(rep.feet.changes.map((x) => x.frame)).toEqual([0, 15]);
    const p = posedLegs(c.build);
    // In the air the hip rises by the pose's 20 px × the figure scale 1.5; on the ground, before and after, the feet hold.
    expect(p.hip[11]![1] - p.hip[9]![1]).toBeCloseTo(30, 2);
    expect(spread(p.ankle.r.slice(0, 10))).toBeLessThan(0.01);
    expect(spread(p.ankle.r.slice(14))).toBeLessThan(0.01);
    expect(p.ankle.r[11]![1] - p.ankle.r[9]![1]).toBeCloseTo(30, 2);
    // Control: the same lift on one frame is under the 2 frames a jump lasts.
    const blip = setup({ pose: legsPose(() => 1, () => 0, (i) => (i === 10 ? 20 : 0)) });
    const rb = retarget(blip, ['--plant-feet']);
    expect(rb.status).toBe(0);
    expect(linesOf(rb, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): none');
  }, SLOW);

  test('#101: a raised heel during a hand-over is not a jump, a real flight is, and a mutant without the cue calls the heel a jump', () => {
    /**
     * Hand-over on frames 10–12 (150 px legs; 0.05 leg lengths = 7.5 px):
     * - Front foot `r` swings on 6–12 (20, 20, 20, 20, 18, 15, 11 px up) and lands on 13 (0 px).
     * - `mid_hip` rises 9 px (0.06 leg lengths) on 10–12.
     * - Back foot `l`:
     *   - raised heel: lifts to 12 px (0.08 leg lengths) on 10–12, holds 12 px on 13–14 when `r` lands (|dy| = 0 < 0.01), then swings on 15–17 (24 px) and lands on 18;
     *   - real flight: rises through `r`'s landing (12, 18, 24, 30, 36, 24 px on 10–15, |dy| = 0.04 leg lengths/frame on 13–14) before landing on 16.
     */
    const handOver = (flight: boolean) => {
      const rUp = (i: number): number => (i >= 6 && i <= 9 ? 20 : i === 10 ? 18 : i === 11 ? 15 : i === 12 ? 11 : 0);
      const lUp = (i: number): number =>
        flight
          ? i === 10 ? 12 : i === 11 ? 18 : i === 12 ? 24 : i === 13 ? 30 : i === 14 ? 36 : i === 15 ? 24 : 0
          : i >= 10 && i <= 14 ? 12 : i >= 15 && i <= 17 ? 24 : 0;
      const mUp = (i: number): number => (i >= 10 && i <= 12 ? 9 : 0);
      return legsPose(() => 1, (i, s) => (s === 'r' ? rUp(i) : lUp(i)) - mUp(i), mUp);
    };
    const heel = setup({ pose: handOver(false) });
    const heelRep = join(heel.dir, 'report.json');
    const rh = retarget(heel, ['--plant-feet', '--report', heelRep]);
    expect(rh.stderr).toBe('');
    expect(rh.status).toBe(0);
    expect(linesOf(rh, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): none');
    expect((JSON.parse(readFileSync(heelRep, 'utf8')) as { feet: { jumps: unknown } }).feet.jumps).toEqual([]);

    const flight = setup({ pose: handOver(true) });
    const flightRep = join(flight.dir, 'report.json');
    const rf = retarget(flight, ['--plant-feet', '--report', flightRep]);
    expect(rf.stderr).toBe('');
    expect(rf.status).toBe(0);
    expect(linesOf(rf, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): 10–12');
    expect((JSON.parse(readFileSync(flightRep, 'utf8')) as { feet: { jumps: unknown } }).feet.jumps).toEqual([[10, 12]]);

    // Planted mutant without the front-foot landing cue: calls the raised heel on 10–12 a jump.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'const jumps = runs(lifted).filter(([a, b]) => b - a + 1 >= JUMP_FRAMES && !raisedHeel(a, b));';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const jumps = runs(lifted).filter(([a, b]) => b - a + 1 >= JUMP_FRAMES);'));
      const mRep = join(heel.dir, 'mutant-report.json');
      const rm = retarget(heel, ['--plant-feet', '--report', mRep], join(d, 'cli.ts'));
      expect(rm.status).toBe(0);
      expect((JSON.parse(readFileSync(mRep, 'utf8')) as { feet: { jumps: unknown } }).feet.jumps).toEqual([[10, 12]]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#103: a jump whose scaled travel from take-off would land under the floor is carried to land on it with no flight frame below the floor; mutant without the correction dips', () => {
    /**
     * Take-off on frame 7 with legs compressed to 0.85 (hip 22.5 units lower on the floor),
     * flight on frames 8–11 with legs extended to 1.0 (rise 25, 28, 22, 10 px > 7.5 px threshold),
     * landing on frame 12 at full leg length (in-place so frame 12 plants directly).
     * Without #103, raw travel from frame 7 puts frame 11's foot > 10 units below the floor and frame 12's raw landing 22.5 units below it.
     */
    const f = (i: number): number => (i === 7 ? 0.85 : 1);
    const rise = (i: number): number => (i === 7 ? 0.15 * V[1] : i === 8 ? 25 : i === 9 ? 28 : i === 10 ? 22 : i === 11 ? 8 : 0);
    const doc = { ...legsPose(f, () => 0, rise), travel: 'in-place' };
    const c = setup({ pose: doc });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { jumps: Array<[number, number]>; floor: number; blend: { over: unknown[] } } };
    expect(rep.feet.jumps).toEqual([[8, 11]]);
    expect(rep.feet.blend.over).toEqual([]);
    const p = posedLegs(c.build);
    const floorY = rep.feet.floor;
    // Every flight frame 8–11 keeps both feet at or above the floor, and landing frame 12 sits on the floor.
    for (let i = 8; i <= 11; i++) {
      const minFoot = Math.min(p.ankle.r[i]![1], p.ankle.l[i]![1]);
      expect(minFoot - floorY).toBeGreaterThanOrEqual(-0.05);
    }
    expect(Math.abs(Math.min(p.ankle.r[12]![1], p.ankle.l[12]![1]) - floorY)).toBeLessThan(0.05);

    // Planted mutant without the #103 jump carry/clamp: frame 11's foot dips below the floor, and travel outside 8–12 is unchanged.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm103-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'const isJump = floorY !== null && feet.jumps.some(([ja, jb]) => ja <= end && jb >= startFrame);';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, 'const isJump = false;'));
      const m = setup({ pose: doc });
      const mRep = join(m.dir, 'report.json');
      const rm = retarget(m, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', mRep], join(d, 'cli.ts'));
      expect(rm.status).toBe(0);
      const mp = posedLegs(m.build);
      const dip11 = Math.min(mp.ankle.r[11]![1], mp.ankle.l[11]![1]) - floorY;
      console.log(`  mutant "without #103 jump carry": frame 11 foot is ${dip11.toFixed(2)} units relative to floor`);
      expect(dip11).toBeLessThan(-10);
      // Outside the jump and its 3-frame landing blend (0..7 and 15..23), the hip's travel is unchanged.
      const kOurs = motionOf(c.out).animations.dance!.tracks.find((t) => t.bone === 'hip' && t.property === 'translate')!.keys;
      const kMut = motionOf(m.out).animations.dance!.tracks.find((t) => t.bone === 'hip' && t.property === 'translate')!.keys;
      for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
        expect(kOurs[i]).toEqual(kMut[i]);
        expect(Math.abs(p.hip[i]![1] - mp.hip[i]![1])).toBeLessThan(1e-3);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#147: the flight carry fades over the landing blend instead of dropping at land+1; mutant cutting carry at land drops the hip on land+1', () => {
    /**
     * Take-off on frame 7 with legs compressed to 0.85, flight on frames 8–11,
     * landing on frame 12 and standing still on frames 12–15 at full leg length.
     * The flight's carry (+45 units) stays on the travel derivation across the
     * 3-frame landing blend (12, 13, 14) so the posed hip y stays continuous across
     * 12 -> 13 -> 14 -> 15 instead of dropping on frame 13 (land+1).
     */
    const f = (i: number): number => (i === 7 ? 0.85 : 1);
    const rise = (i: number): number => (i === 7 ? 0.15 * V[1] : i === 8 ? 25 : i === 9 ? 28 : i === 10 ? 22 : i === 11 ? 8 : 0);
    const doc = { ...legsPose(f, () => 0, rise), travel: 'in-place' };
    const c = setup({ pose: doc });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const p = posedLegs(c.build);
    for (const i of [13, 14, 15]) {
      expect(Math.abs(p.hip[i]![1] - p.hip[i - 1]![1])).toBeLessThan(1e-2);
    }

    // Mutant that cuts carry at i <= mode.land drops the hip on land+1 (frame 13) by > 10 units while standing still.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm147-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'Math.min(i, mode.land)';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, '(i <= mode.land ? i : mode.from)'));
      const m = setup({ pose: doc });
      const rm = retarget(m, ['--leg-scale', '0.8,1.05', '--plant-feet'], join(d, 'cli.ts'));
      expect(rm.status).toBe(0);
      const mp = posedLegs(m.build);
      const drop13 = mp.hip[13]![1] - mp.hip[12]![1];
      console.log(`  mutant "cut carry at land (#147)": frame 12->13 hip step is ${drop13.toFixed(2)} units`);
      expect(drop13).toBeLessThan(-10);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('#142: a support span ends at its ankle\'s push-off when both ankles are above their rolling floor and mid_hip is rising; mutant waiting for mid_hip drags the lifted foot down', () => {
    /**
     * Running cycle with crouch bottom on frames 2 and 12 and push-off on frames 3 and 13:
     * - Grounded support on 0–2 (`r`) and 10–12 (`l`), with legs at full length (150 px) on 0–1 / 10–11 and crouched (`f = 0.92`, ankle on floor, hip lowered by `0.08 * V[1] + 6` px via `rise = -6`) on 2 / 12.
     * - Push-off on frames 3 and 13: `f = 0.84` and `rise = 0.10 * V[1]` (~15 px), so both ankles are `15 px` (`0.10 > 0.05` leg lengths) above the floor while `mid_hip` is rising from frame 2's crouch bottom (`drop[1]` goes from `0.08 * V[1] + 6 = 18 px` on frame 2 to `0.06 * V[1] = 9 px` on frame 3, still below the `> 0.05` jump threshold).
     * - Flight on frames 4–9 and 14–19 (`f = 1`, `rise = 25 px`).
     */
    const f = (i: number): number => {
      if (i === 2 || i === 12 || i === 22) return 0.92;
      if (i === 3 || i === 13) return 0.84;
      return 1;
    };
    const rise = (i: number): number => {
      if (i === 2 || i === 12 || i === 22) return 0.08 * V[1] - 5;
      if (i === 3 || i === 13) return 0.16 * V[1] - 2;
      if ((i >= 4 && i <= 9) || (i >= 14 && i <= 19)) return 25;
      return 0;
    };
    const lift = (i: number): number => (i === 2 || i === 12 || i === 22 ? -(0.08 * V[1] - 5) : 0);
    const doc = { ...legsPose(f, lift, rise), travel: 'in-place' };
    const c = setup({ pose: doc });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as {
      feet: {
        jumps: Array<[number, number]>;
        supports: Array<{ side: string; frames: [number, number] }>;
        floor: number;
      };
    };
    expect(rep.feet.jumps).toEqual([
      [3, 9],
      [13, 19],
    ]);
    expect(rep.feet.supports.map((s) => s.frames)).toEqual([
      [0, 2],
      [10, 12],
      [20, 23],
    ]);

    const p = posedLegs(c.build);
    const floorY = rep.feet.floor;
    expect(p.ankle.r[3]![1] - floorY).toBeGreaterThan(5);
    expect(p.ankle.l[13]![1] - floorY).toBeGreaterThan(5);

    // Mutant waiting for mid_hip to cross JUMP_RISE keeps push-off frames 3 and 13 grounded, dragging the lifted ankle to the floor and pulling the hip down.
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm142-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'legs.ts');
      const from = 'for (const j of jumps) while (j[0] > 1 && up[0]![j[0] - 1] && up[1]![j[0] - 1] && midY[j[0] - 1]! < midY[j[0] - 2]!) j[0]--;';
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, ''));

      const cMut = setup({ pose: doc });
      const mRep = join(cMut.dir, 'report.json');
      const rMut = retarget(cMut, ['--leg-scale', '0.8,1.05', '--plant-feet', '--report', mRep], join(d, 'cli.ts'));
      expect(rMut.status).toBe(0);
      const repMut = JSON.parse(readFileSync(mRep, 'utf8')) as {
        feet: { jumps: Array<[number, number]> };
      };
      expect(repMut.feet.jumps).toEqual([
        [4, 9],
        [14, 19],
      ]);
      const pMut = posedLegs(cMut.build);
      const dip = p.hip[3]![1] - pMut.hip[3]![1];
      console.log(`  mutant "mid_hip start (#142)": frame 3 hipY=${pMut.hip[3]![1].toFixed(2)}u vs ours=${p.hip[3]![1].toFixed(2)}u, dragged down by ${dip.toFixed(2)}u`);
      expect(dip).toBeGreaterThan(10);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('standing while the ankles drift up the picture with depth (the hip does not lift) is not a jump', () => {
    /** Both ankles 20 px up by the last frame (0.13 leg lengths over a floor-wide rule's 0.05), 0.9 px a frame; the hip stays. */
    const depth = (i: number): number => (20 * i) / (N - 1);
    const c = setup({ pose: legsPose(() => 1, (i) => depth(i)) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // The ankles alone are above any floor taken over the sequence by more than 0.05 leg lengths on the late frames …
    expect(depth(N - 1)).toBeGreaterThan(0.05 * 150 * 2);
    // … but the body does not lift, so no jump, and no step: one support throughout.
    expect(linesOf(r, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): none');
    expect(linesOf(r, 'FEET')).toContain('FEET   supports: r 0–23');
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { jumps: unknown; steps: unknown } };
    expect(rep.feet.jumps).toEqual([]);
    expect(rep.feet.steps).toEqual([]);
  }, SLOW);

  test('a step: the supporting ankle moving > 0.03 leg lengths a frame is released, the other foot (6 px up) does not take support (#113), and it re-plants once still', () => {
    /** The right ankle (supporting: the left is 6 px up) slides 10 px left a frame on frames 8–10 (0.067 leg lengths a frame; its knee bends the way it bends at rest), then stays. */
    const slide = (i: number): number => -10 * Math.min(3, Math.max(0, i - 7));
    const stepPose = (both: boolean) => {
      const doc = legsPose(() => 1, (_, s) => (s === 'l' ? 6 : 0));
      const frames = doc.frames as Array<{ people: Array<{ joints: JointsDoc }> }>;
      frames.forEach((f, i) => {
        const j = f.people[0]!.joints;
        for (const s of both ? ['r', 'l'] : ['r']) {
          const a = j[`${s}_ankle`]!.at as Pt;
          j[`${s}_ankle`] = { ...j[`${s}_ankle`], at: [a[0] + slide(i), a[1]] };
        }
      });
      return doc;
    };
    const c = setup({ pose: stepPose(false) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // #113: the old assertion here (`r 8–11 → l supports`, `l 8–13`) was the bug — a 6 px-higher ankle took support.
    // Still on frames 11 and 12 (< 0.01): re-planted at 12, and the lower foot, it takes support there. #113: the left
    // ankle is 6 px (0.04 leg lengths) higher, so it does not take support on the step — before #113 it did (l 8–13);
    // the hip follows the pose's travel until the right foot is still.
    expect(linesOf(r, 'FEET')).toContain('FEET   steps (the supporting ankle > 0.03 leg lengths a frame; re-planted after 2 frames < 0.01): r 8–11 → the pose\'s travel, re-planted at 12');
    expect(linesOf(r, 'FEET')).toContain('FEET   supports: r 0–7, r 12–23');
    expect(linesOf(r, 'FEET')).toContain('FEET   support read from the lower ankle (a foot ≥ 0.02 leg lengths higher than the other does not take support, rig-c/pose#113): 4 frame(s) read differently from before — frames 8–11 l → none (the only foot free to take support was the higher one)');
    const p = posedLegs(c.build);
    expect(spread(p.ankle.r.slice(0, 8))).toBeLessThan(0.01);
    // Re-planted where it stepped to: held from the end of the blend on, well left of where it was (the rigid 70-unit
    // shin turned toward the 30 px the ankle slid; measured 15.9 units), not dragged back to its old anchor.
    expect(spread(p.ankle.r.slice(17))).toBeLessThan(0.01);
    expect(p.ankle.r[0]![0] - p.ankle.r[17]![0]).toBeGreaterThan(10);
    // Both feet stepping at once: nothing is planted, so the hip follows the pose's travel.
    const both = setup({ pose: stepPose(true) });
    const rb = retarget(both, ['--plant-feet']);
    expect(rb.status).toBe(0);
    expect(linesOf(rb, 'FEET').find((l) => l.startsWith('FEET   steps'))).toContain('r 8–11 → the pose\'s travel, re-planted at 12');
  }, SLOW);

  test('#92: travel "in-place" — the sliding foot is followed, not released; the loop is closed and reported; control: without it, today\'s step', () => {
    /** The right ankle (supporting: the left is 6 px up) slides 10 px left a frame on frames 8–10, then stays: a step's speed. */
    const slide = (i: number): number => -10 * Math.min(3, Math.max(0, i - 7));
    const doc = legsPose(() => 1, (_, s) => (s === 'l' ? 6 : 0));
    (doc.frames as Array<{ people: Array<{ joints: JointsDoc }> }>).forEach((f, i) => {
      const j = f.people[0]!.joints;
      const a = j.r_ankle!.at as Pt;
      j.r_ankle = { ...j.r_ankle, at: [a[0] + slide(i), a[1]] };
    });
    const c = setup({ pose: { ...doc, travel: 'in-place' } });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const feet = linesOf(r, 'FEET');
    expect(feet).toContain('FEET   supports: r 0–23');
    expect(feet.find((l) => l.startsWith('FEET   steps'))).toBeUndefined();
    expect(feet.find((l) => l.startsWith('FEET   in place (the sequence\'s travel "in-place"): each supporting foot follows its own ankle\'s picture x, scaled'))).toBeDefined();
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { steps: unknown; closure: { drift: number; frames: number } | null } };
    expect(rep.feet.steps).toEqual([]);
    expect(rep.feet.closure!.frames).toBe(N);
    const p = posedLegs(c.build);
    // Closed, as rig-c poses the build: the last frame's hip x is the first's.
    expect(Math.abs(p.hip[N - 1]![0] - p.hip[0]![0])).toBeLessThan(0.01);
    // The right ankle follows its track: 30 px left in the picture, 45 units on the rig (scale 1.5), less the closure's share.
    const moved = p.ankle.r[N - 1]![0] - p.ankle.r[0]![0];
    expect(Math.abs(moved - (-45 - rep.feet.closure!.drift))).toBeLessThan(0.01);
    // #113: the old assertion here (`r 8–11 → l supports`) was the bug — a 6 px-higher ankle took support.
    // Control: the same joints without the declaration read today's step (the left, 6 px up, not taking support: #113) and print no closure.
    const today = setup({ pose: doc });
    const rt = retarget(today, ['--plant-feet', '--report', report]);
    expect(rt.status).toBe(0);
    expect(linesOf(rt, 'FEET')).toContain('FEET   steps (the supporting ankle > 0.03 leg lengths a frame; re-planted after 2 frames < 0.01): r 8–11 → the pose\'s travel, re-planted at 12');
    expect((JSON.parse(readFileSync(report, 'utf8')) as { feet: { closure: unknown } }).feet.closure).toBeNull();
  }, SLOW);

  test('a change of support: the other ankle lower for 0.1 s takes over from landing, the hip blends in y over 3 frames, and each foot holds while it supports', () => {
    /** The left foot 6 px up (0.04 leg lengths) until frame 7, then the right one — 3 px a frame (0.02 leg lengths: not a step). */
    const lift = (i: number, s: 'r' | 'l'): number => {
      const l = i < 8 ? 6 : i === 8 ? 3 : 0;
      return s === 'l' ? l : 6 - l;
    };
    const c = setup({ pose: legsPose(() => 1, lift) });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--plant-feet', '--report', report]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // Lower (by 6 px) from frame 9; 0.1 s is reached on frame 11 (frames 9–11 last 0.125 s, 9–10 0.083 s), so it takes support from frame 9 (#102).
    expect(linesOf(r, 'FEET')).toContain('FEET   supports: r 0–8, l 9–23');
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { changes: unknown; steps: unknown } };
    expect(legacyReportRows(rep.feet.changes, ['t'])).toEqual([{ frame: 0, from: null, to: 'r' }, { frame: 9, from: 'r', to: 'l' }]);
    expect(rep.feet.steps).toEqual([]);
    const p = posedLegs(c.build);
    expect(spread(p.ankle.r.slice(0, 9))).toBeLessThan(0.01);
    expect(spread(p.ankle.l.slice(9))).toBeLessThan(0.01);
    // Control: lower on one frame only (9), short of 0.1 s, changes nothing.
    const once = (i: number): number => (i < 8 || i > 10 ? 6 : i === 9 ? 0 : 3);
    const short = setup({ pose: legsPose(() => 1, (i, s) => (s === 'l' ? once(i) : 6 - once(i))) });
    const rs = retarget(short, ['--plant-feet']);
    expect(rs.status).toBe(0);
    expect(linesOf(rs, 'FEET')).toContain('FEET   supports: r 0–23');
  }, SLOW);

  test('PIVOT: the hip\'s origin against its thigh roots\' midpoint, in units and hip widths', () => {
    const c = setup();
    const r = retarget(c);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'PIVOT')[0]).toStartWith('PIVOT  bone "hip"\'s origin is 0.00 units (0.000 hip widths) from its thigh roots\' midpoint (leg_r0 + leg_l0)');
    const off = setup({ rig: { bones: (bs) => bs.map((b) => (b.name.startsWith('leg_') && b.name.endsWith('0') ? { ...b, y: -10 } : b)) } });
    const ro = retarget(off);
    expect(ro.status).toBe(0);
    expect(linesOf(ro, 'PIVOT')[0]).toContain('is 10.00 units (0.333 hip widths)');
  }, SLOW);

  test('--leg-scale takes off or min,max with 0 < min ≤ 1 ≤ max; anything else is exit 2', () => {
    const c = setup();
    for (const v of ['0.8', '1.1,1.2', '0,1', '0.8,0.9', 'a,b']) {
      const r = retarget(c, ['--leg-scale', v]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`--leg-scale is "${v}"`);
    }
  }, SLOW);

  test('LEGS_MAP: --plant-feet with no chain ending at an ankle is refused by name', () => {
    const map = { ...baseMap(), chains: baseChains().filter((x) => x.name !== 'leg_l') };
    const c = setup({ map });
    const r = retarget(c, ['--plant-feet']);
    expect(r.status).toBe(1);
    expect(fails(r)).toContain('FAIL  LEGS_MAP: --plant-feet needs one chain ending at "l_ankle" (its last bone\'s x axis ends at the ankle); the map has none');
    // Control: the same map reads, without the flag.
    expect(retarget(c).status).toBe(0);
  }, SLOW);

  describe('#85: --plant-feet puts every support span on one floor', () => {
    /** 36 frames: three support spans of 12, the figure still within each. */
    const N85 = 36;
    const M85: Motion = { ...STILL, n: N85 };
    /**
     * The whole figure moved by `at(i)` px: frames 0–11 by `a`, 12–23 by `b`, 24–35 by `c`. Each move is ≥ 5 px
     * (0.033 leg lengths, a step: both ankles released, the hip on the pose's travel for a frame, then re-planted
     * where the picture puts it); every pair is within 6 px, under the 0.05 leg lengths (7.5 px) a jump rises.
     */
    const moved = (a: Pt, b: Pt, c: Pt) => poseDoc(M85, (i, j) => {
      const d = i < 12 ? a : i < 24 ? b : c;
      for (const [name, at] of Object.entries(j)) j[name] = { ...at, at: [(at.at as Pt)[0] + d[0], (at.at as Pt)[1] + d[1]] };
    });
    /** Three picture heights: 0, 6 px lower, 1 px lower (y down). */
    const threeHeights = () => moved([0, 0], [0, 6], [0, 1]);
    /** One height: the same moves made sideways. */
    const oneHeight = () => moved([0, 0], [6, 0], [1, 0]);
    /** Each ankle's world position on every frame of the gated build, posed by rig-c. */
    function ankles85(build: string): { r: Pt[]; l: Pt[] } {
      const poses = poseRawAnimation(loadBuild(build), 'dance', Array.from({ length: N85 - 1 }, () => DT), {}, 'animation');
      const out = { r: [] as Pt[], l: [] as Pt[] };
      for (const p of poses) {
        const b = byName(p.bones);
        for (const s of ['r', 'l'] as const) {
          const shin = b.get(`leg_${s}1`)!;
          out[s].push([shin.worldX + shin.a * 70, shin.worldY + shin.c * 70]);
        }
      }
      return out;
    }
    interface Report85 { feet: { supports: Array<{ side: 'r' | 'l'; frames: [number, number] }>; floor: number | null; shifts: Array<{ side: string; frames: number[]; shift: number }> } }
    /** Each span's supporting ankle's world y on every frame of the span, blend frames included, posed by rig-c. */
    function plantedYs(build: string, report: string): number[][] {
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
      const a = ankles85(build);
      return rep.feet.supports.map((sp) => {
        const ys: number[] = [];
        for (let i = sp.frames[0]; i <= sp.frames[1]; i++) ys.push(a[sp.side][i]![1]);
        return ys;
      });
    }
    /** Each span's supporting ankle's world x on every frame of the span, blend frames included, posed by rig-c. */
    function plantedXs(build: string, report: string): number[][] {
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
      const a = ankles85(build);
      return rep.feet.supports.map((sp) => {
        const xs: number[] = [];
        for (let i = sp.frames[0]; i <= sp.frames[1]; i++) xs.push(a[sp.side][i]![0]);
        return xs;
      });
    }
    const spreadOf = (yss: number[][]): number => Math.max(...yss.flat()) - Math.min(...yss.flat());
    /** The tolerance the landing check holds an ankle to: 0.01 units plus 1e-4 of the 150-unit leg. */
    const FLOOR_TOL = 0.01 + 1e-4 * LEG;

    /** The three-heights test against a CLI: the spans read, and their planted ankles' spread across spans, world units. */
    function threeHeightsRun(cliPath: string): { status: number; supports: string[]; spread: number; perSpan: number[] } {
      const c = setup({ pose: threeHeights() });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report], cliPath);
      if (r.status !== 0) return { status: r.status, supports: [], spread: NaN, perSpan: [] };
      const yss = plantedYs(c.build, report);
      return { status: r.status, supports: linesOf(r, 'FEET').filter((l) => l.startsWith('FEET   supports')), spread: spreadOf(yss), perSpan: yss.map((ys) => Math.max(...ys) - Math.min(...ys)) };
    }

    test('three picture heights: every span\'s supporting ankle lands on one floor, posed by rig-c; FEET and the report give the shifts', () => {
      const c = setup({ pose: threeHeights() });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      // Three spans, each starting after a step (both ankles moved ≥ 5 px), and no jump.
      expect(linesOf(r, 'FEET')).toContain('FEET   supports: r 0–11, l 13–23, r 25–35');
      expect(linesOf(r, 'FEET')).toContain('FEET   jumps (both ankles and mid_hip > 0.05 leg lengths above their rolling floor, ≥ 2 frames): none');
      // Held where the picture puts them, the spans would sit 0, 9 and 1.5 units lower (6 px and 1 px × the figure scale 1.5):
      // the floor is their median, and each shift is floor − its height.
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
      expect(rep.feet.shifts.map((x) => [x.side, x.frames])).toEqual([['r', [0, 11]], ['l', [13, 23]], ['r', [25, 35]]]);
      const shifts = rep.feet.shifts.map((x) => x.shift);
      expect(shifts[0]!).toBeCloseTo(-1.5, 3);
      expect(shifts[1]!).toBeCloseTo(7.5, 3);
      expect(shifts[2]!).toBeCloseTo(0, 3);
      // Independently: every span's supporting ankle at one world y, and that y is the report's floor.
      const yss = plantedYs(c.build, report);
      expect(spreadOf(yss)).toBeLessThan(FLOOR_TOL);
      for (const ys of yss) for (const y of ys) expect(Math.abs(y - rep.feet.floor!)).toBeLessThan(FLOOR_TOL);
      // Both ankles land where the keys put them, by the package's own check.
      expect(linesOf(r, 'LAND').filter((l) => l.includes(' ankle — '))).toHaveLength(2);
      const line = linesOf(r, 'FEET').find((l) => l.startsWith('FEET   floor:'))!;
      expect(line).toContain(`floor: world y ${rep.feet.floor!.toFixed(2)} (the median of the 3 support span(s)' planted heights)`);
      expect(line).toContain('r 0–11 −1.50 (−0.0100), l 13–23 +7.50 (+0.0500), r 25–35 +0.00 (+0.0000); range −1.50 … +7.50 units = 0.0601 leg lengths');
    }, SLOW);

    test('--floor <y> puts every span on that world y; without --plant-feet, or not a number, it is exit 2', () => {
      const c = setup({ pose: threeHeights() });
      const report = join(c.dir, 'report.json');
      const r0 = retarget(c, ['--plant-feet', '--report', report]);
      expect(r0.status).toBe(0);
      const y = (JSON.parse(readFileSync(report, 'utf8')) as Report85).feet.floor! + 10;
      const r = retarget(c, ['--plant-feet', '--floor', String(y), '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
      expect(rep.feet.floor).toBe(y);
      expect(linesOf(r, 'FEET').find((l) => l.startsWith('FEET   floor:'))).toContain('(given by --floor)');
      for (const ys of plantedYs(c.build, report)) for (const v of ys) expect(Math.abs(v - y)).toBeLessThan(FLOOR_TOL);
      const no = retarget(c, ['--floor', '0']);
      expect(no.status).toBe(2);
      expect(no.stderr).toContain('--floor is "0" without --plant-feet');
      const nan = retarget(c, ['--plant-feet', '--floor', 'low']);
      expect(nan.status).toBe(2);
      expect(nan.stderr).toContain('--floor is "low"; it must be a world y in rig units (a finite number)');
    }, SLOW);

    test('mutant: the shift forced to 0 leaves the spans where the picture puts them, and the three-heights test is red; control: one height writes the same bytes as the mutant', () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'legs.ts');
        const from = 'const placed = placeHip(feet, offset, travel, start, y, follow);';
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, 'const placed = placeHip(feet, offset, travel, start, null, follow);'));
        const mutant = threeHeightsRun(join(d, 'cli.ts'));
        const pkg = threeHeightsRun(CLI);
        console.log(`  mutant "shift forced to 0": exit ${mutant.status}, planted ankles spread ${mutant.spread.toFixed(3)} units across spans (package ${pkg.spread.toFixed(4)})`);
        expect(pkg.spread).toBeLessThan(FLOOR_TOL);
        // Red: the same spans read, each held flat, but at three heights 9 units apart.
        expect(mutant.status).toBe(0);
        expect(mutant.supports).toEqual(pkg.supports);
        for (const s of mutant.perSpan) expect(s).toBeLessThan(FLOOR_TOL);
        expect(mutant.spread >= FLOOR_TOL).toBe(true);
        expect(mutant.spread).toBeCloseTo(9, 2);
        // Control: one picture height (the same steps, made sideways) — the shifts are 0 within 1e-5 units, and the motion is
        // byte-identical to the mutant's, which is the hip as it was before the floor.
        const one = setup({ pose: oneHeight() });
        const report = join(one.dir, 'report.json');
        const r = retarget(one, ['--plant-feet', '--report', report]);
        expect(r.status).toBe(0);
        const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85;
        expect(rep.feet.shifts).toHaveLength(3);
        for (const x of rep.feet.shifts) expect(Math.abs(x.shift)).toBeLessThan(1e-5);
        const ours = readFileSync(one.out, 'utf8');
        const rm = retarget(one, ['--plant-feet'], join(d, 'cli.ts'));
        expect(rm.status).toBe(0);
        expect(readFileSync(one.out, 'utf8')).toBe(ours);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);

    test('the blend: the supporting ankle stays on the floor and on its horizontal anchor while the hip blends, its leg stretched and landing-checked; mutants: without the stretch it leaves the floor, and without the horizontal compensation an angled leg drifts sideways', () => {
      const c = setup({ pose: threeHeights() });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      // The landing after each step blends the hip over frames 13–15 and 25–27, between two derivations 9 and 7.5 units apart.
      const held = linesOf(r, 'FEET').filter((l) => l.startsWith('FEET   blend held on the floor:'));
      expect(held).toHaveLength(2);
      expect(held[0]).toStartWith('FEET   blend held on the floor: supporting foot l frames 13–15 (t=0.542–0.625s)');
      expect(held[1]).toStartWith('FEET   blend held on the floor: supporting foot r frames 25–27');
      expect(linesOf(r, 'FEET').filter((l) => l.startsWith('FEET   past the bounds'))).toEqual([]);
      // The stretched scales are scale targets: the landing check holds all four.
      expect(linesOf(r, 'LAND').filter((l) => l.includes(' scale — '))).toHaveLength(4);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as Report85 & { feet: { blend: { runs: Array<{ side: string; frames: number[] }>; over: unknown[] } } };
      expect(rep.feet.blend.runs.map((x) => [x.side, x.frames])).toEqual([['l', [13, 15]], ['r', [25, 27]]]);
      expect(rep.feet.blend.over).toEqual([]);
      for (const ys of plantedYs(c.build, report)) for (const y of ys) expect(Math.abs(y - rep.feet.floor!)).toBeLessThan(FLOOR_TOL);
      for (const xs of plantedXs(c.build, report)) expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(FLOOR_TOL);

      // Angled supporting legs (60° below horizontal: horizontal reach 75 units, vertical 130 units, k within [0.92, 1.08]):
      // stretching the chain along its bone axis scales its horizontal reach from the thigh root too, and the hip's x
      // compensation keeps the planted ankle on its horizontal anchor within FLOOR_TOL.
      const angled: Motion = { ...M85, rt: () => -60, rs: () => -60, lt: () => -120, ls: () => -120 };
      const angledPose = () => poseDoc(angled, (i, j) => {
        const d: Pt = i < 12 ? [0, 0] : i < 24 ? [0, 6] : [0, 1];
        for (const [name, at] of Object.entries(j)) j[name] = { ...at, at: [(at.at as Pt)[0] + d[0], (at.at as Pt)[1] + d[1]] };
      });
      const ca = setup({ pose: angledPose() });
      const areport = join(ca.dir, 'report.json');
      expect(retarget(ca, ['--plant-feet', '--report', areport]).status).toBe(0);
      for (const xs of plantedXs(ca.build, areport)) expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(FLOOR_TOL);

      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'retarget.ts');
        const from = '    stretchChain(supportHold.stretch);\n';
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, ''));
        const m = setup({ pose: threeHeights() });
        const mreport = join(m.dir, 'report.json');
        const rm = retarget(m, ['--plant-feet', '--report', mreport], join(d, 'cli.ts'));
        expect(rm.status).toBe(0);
        const floorY = (JSON.parse(readFileSync(mreport, 'utf8')) as Report85).feet.floor!;
        const worst = Math.max(...plantedYs(m.build, mreport).flat().map((y) => Math.abs(y - floorY)));
        console.log(`  mutant "no stretch on the blend": the supporting ankle up to ${worst.toFixed(3)} units off the floor`);
        // Red: on the first blend frame the ankle is 0.75 of the 9 units off.
        expect(worst >= FLOOR_TOL).toBe(true);
        expect(worst).toBeCloseTo(6.75, 1);

        // Second mutant: keep the stretch, remove the horizontal dx compensation on the hip.
        const fromDx = '      hip[i]![0] += dx;\n      travel[i]![0] += dx;\n';
        expect(before.split(fromDx)).toHaveLength(2);
        writeFileSync(path, before.replace(fromDx, ''));
        const ma = setup({ pose: angledPose() });
        const mareport = join(ma.dir, 'report.json');
        const rma = retarget(ma, ['--plant-feet', '--report', mareport], join(d, 'cli.ts'));
        expect(rma.status).toBe(0);
        const worstX = Math.max(...plantedXs(ma.build, mareport).map((xs) => Math.max(...xs) - Math.min(...xs)));
        console.log(`  mutant "no horizontal anchor compensation on the blend": the supporting ankle drifts ${worstX.toFixed(3)} units sideways`);
        expect(worstX).toBeGreaterThan(3);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);

    test('past the bounds: a blend the stretch cannot cover within [0.92, 1.08] is held at the bound, listed, and the rest is left to the blend', () => {
      /** Legs splayed straight 30° below the horizontal: the ankle 75 units under the root, so 7 px (10.5 units) between spans needs k past 1.08 on the first blend frame. */
      const splayed: Motion = { ...M85, rt: () => -30, rs: () => -30, lt: () => -150, ls: () => -150 };
      const pose = poseDoc(splayed, (i, j) => {
        const d: Pt = i < 12 ? [0, 0] : i < 24 ? [0, 7] : [0, 0];
        for (const [name, at] of Object.entries(j)) j[name] = { ...at, at: [(at.at as Pt)[0] + d[0], (at.at as Pt)[1] + d[1]] };
      });
      const c = setup({ pose });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, ['--plant-feet', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const past = linesOf(r, 'FEET').filter((l) => l.startsWith('FEET   past the bounds:'));
      expect(past.length).toBeGreaterThan(0);
      expect(past[0]).toMatch(/^FEET {3}past the bounds: supporting foot [rl] frame 1[3-5] \(t=[0-9.]+s\) — the floor needed k (1\.(0[89]|[1-9])|0\.([0-8]|9[01]))\d*, past \[0\.92, 1\.08\]; held at the bound, the foot left up to [0-9.]+ units from the floor$/);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { feet: { blend: { runs: Array<{ k: { min: number; max: number } }>; over: Array<{ frames: number[]; left: number }> } } };
      expect(rep.feet.blend.over.length).toBeGreaterThan(0);
      expect(rep.feet.blend.over[0]!.left).toBeGreaterThan(FLOOR_TOL);
      // Held at the bound, not forced: a run's stretch reaches the bound and goes no further.
      const ks = rep.feet.blend.runs.flatMap((x) => [x.k.min, x.k.max]);
      expect(ks.some((k) => k === 1.08 || k === 0.92)).toBe(true);
      for (const k of ks) expect(k >= 0.92 && k <= 1.08).toBe(true);
      expect(linesOf(r, 'LAND').filter((l) => l.includes(' scale — '))).toHaveLength(4);
    }, SLOW);
  });

  describe('#60: --stance plants both feet when the free ankle is within the tolerance of the floor', () => {
    /** The picture leg, hip → ankle at full length, px: FEET's leg length when most frames are unlifted. */
    const PIC = Math.hypot(V[0], V[1]);
    /** The left ankle (free: the right is lower) lifted by `legs` of FEET's leg length on frames 8–15; under half the frames, so the median leg length stays PIC. */
    const lifted = (legs: number) => legsPose(() => 1, (i, s) => (s === 'l' && i >= 8 && i <= 15 ? legs * PIC : 0));
    const FLAGS = ['--leg-scale', '0.8,1.05', '--plant-feet'];
    /** The foot's tolerance in the landing check: 0.01 units plus 1e-4 of the 150-unit leg. */
    const PLANT_TOL = 0.01 + 1e-4 * LEG;
    const LIFT = [8, 9, 10, 11, 12, 13, 14, 15];

    /** The lift test: on the lifted frames, the left ankle is where the run without --stance puts it (the pose's height kept), and above the right. */
    function liftKept(cliPath: string): { status: number; stance: string[]; worst: number; above: number } {
      const c = setup({ pose: lifted(0.15) });
      const plain = retarget(c, FLAGS);
      expect(plain.status).toBe(0);
      const before = posedLegs(c.build);
      const r = retarget(c, [...FLAGS, '--stance', '0.07'], cliPath);
      const after = posedLegs(c.build);
      let worst = 0;
      let above = Infinity;
      for (const i of LIFT) {
        worst = Math.max(worst, Math.hypot(after.ankle.l[i]![0] - before.ankle.l[i]![0], after.ankle.l[i]![1] - before.ankle.l[i]![1]));
        above = Math.min(above, after.ankle.l[i]![1] - after.ankle.r[i]![1]);
      }
      return { status: r.status, stance: stanceRuns(r), worst, above };
    }

    test('a lift of 0.15 leg lengths stays a lift: the foot keeps the pose\'s height, and STANCE lists it', () => {
      const k = liftKept(CLI);
      expect(k.status).toBe(0);
      expect(k.stance).toHaveLength(3);
      expect(k.stance[0]).toStartWith('STANCE planted both: free foot l frames 0–7 (t=0.000–0.292s)');
      // #237: the shin is clamped at 0.8 on every lifted frame, so the rig's free ankle hangs below the
      // pose's there; before #237 this line said "the pose's height kept", which was not true of any frame.
      expect(k.stance[1]).toBe('STANCE lifted: free foot l frames 8–15 (t=0.333–0.625s) — its ankle up to 0.1500 leg lengths above the supporting one in the picture, over the tolerance 0.07 leg lengths (r 10.5 / l 10.5 px) (planted again under 0.8 of it, 0.0560); the pose\'s height not kept on any of its 8 frame(s); on 8 (frames 8–15) --leg-scale\'s clamps moved the free ankle off it, up to 0.0541 leg lengths (8.1 px of FEET\'s) below the pose\'s (leg lengths: the rig\'s l leg at setup, thigh origin → ankle, 150.0 units)');
      expect(k.stance[2]).toStartWith('STANCE planted both: free foot l frames 16–23');
      expect(k.worst).toBeLessThan(1e-3);
      // The lift shows on the rig (the shin scaled 0.8 at its clamp: 0.2 of its 70 units, along a near-vertical shin).
      expect(k.above).toBeGreaterThan(10);
    }, SLOW);

    test('0.03 leg lengths is planted both: the posed foot lands on the floor within the plant tolerance, and the stretch is held by the landing check', () => {
      const c = setup({ pose: lifted(0.03) });
      const plain = retarget(c, FLAGS);
      expect(plain.status).toBe(0);
      const before = posedLegs(c.build);
      const gap = Math.max(...LIFT.map((i) => before.ankle.l[i]![1] - before.ankle.r[i]![1]));
      // Control: without --stance the free foot floats.
      expect(gap).toBeGreaterThan(1);
      const report = join(c.dir, 'report.json');
      const r = retarget(c, [...FLAGS, '--stance', '0.07', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const st = stanceRuns(r);
      expect(st).toHaveLength(1);
      expect(st[0]).toStartWith('STANCE planted both: free foot l frames 0–23 (t=0.000–0.958s) — its ankle up to 0.0300 leg lengths above the supporting one in the picture, within the tolerance 0.07 leg lengths (r 10.5 / l 10.5 px); its leg stretched by k ');
      const kmax = Number(/\(largest ([0-9.]+)\)/.exec(st[0]!)![1]);
      expect(kmax).toBeGreaterThan(1);
      expect(kmax).toBeLessThan(1.08);
      // Every scale, both ankles and the hip land, by the package's own check; the stretched scales are the targets.
      expect(linesOf(r, 'LAND').filter((l) => l.includes(' scale — '))).toHaveLength(4);
      const after = posedLegs(c.build);
      for (const i of LIFT) expect(Math.abs(after.ankle.l[i]![1] - after.ankle.r[i]![1])).toBeLessThan(PLANT_TOL);
      // The supporting foot does not move for it.
      for (let i = 0; i < N; i++) expect(Math.hypot(after.ankle.r[i]![0] - before.ankle.r[i]![0], after.ankle.r[i]![1] - before.ankle.r[i]![1])).toBeLessThan(1e-3);
      // Independently: the left thigh's world length is its leg scale times k on a lifted frame.
      expect(after.len.leg_l0![10]! / before.len.leg_l0![10]!).toBeGreaterThan(1.01);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { options: { stance: unknown }; stance: { tolerance: number; bounds: number[]; runs: Array<{ state: string; side: string; frames: number[] }>; over: unknown[] } };
      expect(rep.options.stance).toBe(0.07);
      expect(rep.stance.tolerance).toBe(0.07);
      expect(rep.stance.bounds).toEqual([0.92, 1.08]);
      expect(rep.stance.runs.map((x) => [x.state, x.side, x.frames])).toEqual([['both', 'l', [0, 23]]]);
      expect(rep.stance.over).toEqual([]);
    }, SLOW);

    test('a difference that needs k > 1.08 is reported past the bounds, held at the bound, and not forced', () => {
      const c = setup({ pose: lifted(0.15) });
      const r = retarget(c, [...FLAGS, '--stance', '0.2']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const st = stanceRuns(r);
      expect(st[0]).toContain('(largest 1.0800)');
      const over = st.filter((l) => l.startsWith('STANCE past the bounds: free foot l frames 8–15'));
      expect(over).toHaveLength(1);
      // #95: the lifted picture leg is folded, so its frames' lower bound is that fold (below 0.92); the upper stays 1.08.
      expect(over[0]).toMatch(/the floor needed k 1\.(0[89]|[1-9])\d*, past \[0\.\d{4}, 1\.08\]; held at the bound, the foot left up to [1-9][0-9.]* units from the floor/);
      const after = posedLegs(c.build);
      for (const i of LIFT) expect(after.ankle.l[i]![1] - after.ankle.r[i]![1]).toBeGreaterThan(PLANT_TOL);
    }, SLOW);

    test('--stance without --plant-feet is refused by name; anything but off or (0, 1) is exit 2', () => {
      const c = setup();
      const r = retarget(c, ['--stance', '0.07']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--stance is "0.07" without --plant-feet');
      for (const v of ['0', '1', '-0.1', 'a']) {
        const b = retarget(c, ['--plant-feet', '--stance', v]);
        expect(b.status).toBe(2);
        expect(b.stderr).toContain(`--stance is "${v}"; it must be off, or leg lengths in (0, 1)`);
      }
    }, SLOW);

    test('mutant: without the tolerance check every free leg is stretched, and the lift test is red', () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'legs.ts');
        const from = '(planted ? Math.abs(read[k]!.height) > tolerance :';
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, '(planted ? Math.abs(read[k]!.height) > Infinity :'));
        const k = liftKept(join(d, 'cli.ts'));
        const red = k.worst >= 1e-3 || !k.stance.some((l) => l.startsWith('STANCE lifted: free foot l frames 8–15'));
        console.log(`  mutant "no tolerance check": exit ${k.status}, lifted foot moved ${k.worst.toFixed(3)} units; STANCE ${k.stance.join(' | ').slice(0, 160)}`);
        expect(red).toBe(true);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  });

  describe('#94: --reduce composes with --leg-scale, --plant-feet and --stance', () => {
    /** The picture leg, hip → ankle at full length, px. */
    const PIC = Math.hypot(V[0], V[1]);
    /** Knees bending toward the camera (scaled legs, the hip planted over them) and the left, free ankle 0.03 leg lengths up on frames 8–15: --stance plants it, its leg stretched. */
    const gait = () => legsPose(bendF, (i, s) => (s === 'l' && i >= 8 && i <= 15 ? 0.03 * PIC : 0));
    const FLAGS = ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'];
    /** The landing check's foot tolerance without --reduce: 0.01 units plus 1e-4 of the 150-unit leg. */
    const PLANT_TOL = 0.01 + 1e-4 * LEG;
    /** Every key of every track of the animation. */
    const keysIn = (path: string) => motionOf(path).animations.dance!.tracks.reduce((s, t) => s + t.keys.length, 0);
    /** The free (left) ankle against the supporting (right) one on the stance frames, world y: the floor the stance plants it on. */
    const floorGap = (p: Posed) => Math.max(...Array.from({ length: N }, (_, i) => Math.abs(p.ankle.l[i]![1] - p.ankle.r[i]![1])));

    test('reduced last, on the final keys: the gate green; every bone, scale and ankle lands; the keys drop; each ankle and scale within its stated bound of the dense run', () => {
      const c = setup({ pose: gait() });
      const plain = retarget(c, FLAGS);
      expect(plain.status).toBe(0);
      expect(stanceRuns(plain)[0]).toStartWith('STANCE planted both: free foot l frames 0–23');
      const dense = posedLegs(c.build);
      const before = keysIn(c.out);
      expect(floorGap(dense)).toBeLessThan(PLANT_TOL);
      const r = retarget(c, [...FLAGS, '--reduce', '1', '--reduce-hip', '0.5']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(linesOf(r, 'GATE')[0]).toContain('green');
      const red = linesOf(r, 'REDUCE').filter((l) => !l.startsWith('REDUCE ankle drift allowed: '));
      // A rotate row per mapped bone, the hip, a scalex row per scaled bone, and the total.
      for (const b of ['leg_r0', 'leg_r1', 'leg_l0', 'leg_l1']) {
        expect(red.some((l) => l.startsWith(`REDUCE bone "${b}" rotate: 24 → `))).toBe(true);
        expect(red.some((l) => l.startsWith(`REDUCE bone "${b}" scalex: 24 → `))).toBe(true);
      }
      expect(red.some((l) => l.startsWith('REDUCE hip "hip" translate: 24 → '))).toBe(true);
      expect(red.at(-1)).toMatch(/^REDUCE rotate keys \d+ → \d+ \([0-9.]+×\) within 1°; scalex keys 96 → \d+ within 0\.00005 of the setup length$/);
      const lands = linesOf(r, 'LAND');
      expect(lands.filter((l) => l.includes(' scale — '))).toHaveLength(4);
      expect(lands.filter((l) => l.includes(' ankle — '))).toHaveLength(2);
      expect(keysIn(c.out)).toBeLessThan(before);
      const after = posedLegs(c.build);
      // Independently, posed by rig-c: every scaled bone's world length within 1e-4 of the dense run's …
      for (let i = 0; i < N; i++) for (const n of Object.keys(after.len)) expect(Math.abs(after.len[n]![i]! - dense.len[n]![i]!)).toBeLessThan(1e-4);
      // … each ankle within the stated bound of the dense run's (the hip's 0.5, plus the leg's 150 units × the largest scale × (1° + 5e-5)) …
      const bound = 0.5 + 150 * 1.08 * (RAD + 5e-5);
      for (const s of ['r', 'l'] as const) for (let i = 0; i < N; i++) expect(Math.hypot(after.ankle[s][i]![0] - dense.ankle[s][i]![0], after.ankle[s][i]![1] - dense.ankle[s][i]![1])).toBeLessThan(bound);
      // … and the planted free foot still on the supporting one's floor, within the tolerance its two ankles carry.
      expect(floorGap(after)).toBeLessThan(PLANT_TOL + 2 * bound);
    }, SLOW);

    test('the stated bound: the ankle\'s tolerance under --reduce is the plant\'s plus footReduce, printed on its LAND line', () => {
      const c = setup({ pose: gait() });
      const tolerances = (deg: string) => {
        const r = retarget(c, [...FLAGS, '--reduce', deg]);
        expect(r.status).toBe(0);
        const ankle = linesOf(r, 'LAND').filter((l) => l.includes(' ankle — '));
        expect(ankle).toHaveLength(2);
        return ankle.map((l) => Number(/the tolerance is ([0-9.]+) units$/.exec(l)![1]) - PLANT_TOL);
      };
      const a = tolerances('0.1');
      const b = tolerances('0.4');
      for (const [k, x] of a.entries()) {
        // A lever × the largest scale between the leg's 150 units and the hip-to-ankle path with its offset, …
        const lever = x / (0.1 * RAD + 5e-5);
        expect(lever).toBeGreaterThan(150);
        expect(lever).toBeLessThan(200 * 1.08);
        // … the same lever at four times the angle (the three printed digits allow 0.5 %).
        expect(Math.abs(b[k]! / (0.4 * RAD + 5e-5) / lever - 1)).toBeLessThan(5e-3);
      }
    }, SLOW);

    test('mutant: the scales reduced as they stood before the plant and the stance stretched them leave the free foot off the floor, and the run is refused naming that ankle', () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, 'src', 'run.ts');
        const from = 'const red = reduceScale(r.times, bone, r.scales.get(bone) ?? ';
        const before = readFileSync(path, 'utf8');
        expect(before.split(from)).toHaveLength(2);
        writeFileSync(path, before.replace(from, 'const red = reduceScale(r.times, bone, r.legScale.find((l) => l.bone === bone)?.scale ?? r.scales.get(bone) ?? '));
        const c = setup({ pose: gait() });
        const m = retarget(c, [...FLAGS, '--reduce', '0.1'], join(d, 'cli.ts'));
        const foot = fails(m).find((l) => l.startsWith('FAIL  POSE_LANDS: bone "leg_l1:tip" ankle'));
        const gap = foot === undefined ? 0 : Number(/worst \|reached − asked\| ([0-9.e-]+) units/.exec(foot)![1]);
        console.log(`  mutant "reduce before the plant's stretch": exit ${m.status}; ${foot ?? fails(m)[0] ?? 'no refusal'}`);
        expect(m.status).toBe(1);
        // The floor row: the free ankle off where the stance planted it by more than the plant's tolerance and the reduction's bound together.
        expect(gap).toBeGreaterThan(PLANT_TOL + 150 * 1.08 * (0.1 * RAD + 5e-5));
        // Control: the package lands the same pose with the same flags.
        const ok = retarget(c, [...FLAGS, '--reduce', '0.1']);
        expect(ok.stderr).toBe('');
        expect(ok.status).toBe(0);
        expect(floorGap(posedLegs(c.build))).toBeLessThan(PLANT_TOL + 2 * 150 * 1.08 * (0.1 * RAD + 5e-5));
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  });

  describe('#240: each reading names its remedy', () => {
    /** A copy of the package with one edit, the edit's anchor checked to occur once. */
    function mutant(file: string, from: string, to: string): { cli: string; done: () => void } {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', file);
      const before = readFileSync(path, 'utf8');
      expect(before.split(from)).toHaveLength(2);
      writeFileSync(path, before.replace(from, to));
      return { cli: join(d, 'cli.ts'), done: () => rmSync(d, { recursive: true, force: true }) };
    }

    /**
     * The stick standing, its picture proportioned as the rig (trunk 150 px against the rig's 150, legs 150 against 150,
     * hips 30 against 30), with the trunk shown at `k(i)` of its length — leaning toward the camera.
     */
    function trunkPose(k: (i: number) => number): Record<string, unknown> {
      const above = new Set(['neck', 'nose', 'r_shoulder', 'r_elbow', 'r_wrist', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_eye', 'l_eye', 'r_ear', 'l_ear']);
      return poseDoc(STILL, (i, j) => {
        const r = j.r_hip!.at as Pt;
        const l = j.l_hip!.at as Pt;
        const mid: Pt = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
        const neck = j.neck!.at as Pt;
        const want = add(mid, [(neck[0] - mid[0]) * 1.5 * k(i), (neck[1] - mid[1]) * 1.5 * k(i)]);
        const shift: Pt = [want[0] - neck[0], want[1] - neck[1]];
        for (const name of above) {
          const a = j[name]!.at as Pt;
          j[name] = { ...j[name], at: add(a, shift) };
        }
      });
    }
    const outsideLine = (r: Ran) => linesOf(r, 'SCALE').find((l) => l.startsWith('SCALE  outside both bands: '));

    test('SCALE: the segment\'s median against its 95th percentile, the leg and hip bands, the hip\'s travel; a factor outside both bands is named, one inside is not', () => {
      // Control: proportioned as the rig, nothing foreshortened — the factor lies in both bands.
      const even = setup({ pose: trunkPose(() => 1) });
      const e = retarget(even);
      expect(e.status).toBe(0);
      const es = linesOf(e, 'SCALE');
      expect(es[0]).toStartWith('SCALE  1.00000 rig units per picture px (rig 150.00 / pose median 150.00); the median is 1.000 of its 95th percentile 150.00');
      expect(es[1]).toMatch(/^SCALE  bands, rig ÷ picture at its 95th percentile – median: leg [0-9.]+–[0-9.]+ \(within\), hip 1\.00000–1\.00000 \(within\); scale\.factor 1\.00000 \(within: /);
      expect(es.some((l) => l.startsWith('SCALE  hip travel (mid_hip → bone "hip"), range: '))).toBe(true);
      expect(outsideLine(e)).toBeUndefined();
      // Planted: the trunk at 0.7 of its length on every frame from 4 — the median frame foreshortens it, and the factor follows.
      const fore = setup({ pose: trunkPose((i) => (i < 4 ? 1 : 0.7)) });
      const report = join(fore.dir, 'report.json');
      const f = retarget(fore, ['--report', report]);
      expect(f.status).toBe(0);
      const fs = linesOf(f, 'SCALE');
      expect(fs[0]).toBe('SCALE  1.42857 rig units per picture px (rig 150.00 / pose median 105.00); the median is 0.700 of its 95th percentile 150.00 — under 1, the median frame foreshortens mid_hip → neck and the factor is 1.429× the one at its longest');
      expect(fs[1]).toMatch(/ \(outside\), hip 1\.00000–1\.00000 \(outside\); scale\.factor 1\.42857 \(within: /);
      expect(outsideLine(f)).toStartWith('SCALE  outside both bands: scale.factor 1.42857 sizes the figure as neither its legs nor its hips do');
      // The report carries the same figures the lines print.
      const rep = JSON.parse(readFileSync(report, 'utf8')) as { scale: { factor: number }; scaleFit: { segment: { ratio: number }; hip: { band: { lo: number; hi: number } }; outside: boolean } };
      expect(rep.scaleFit.segment.ratio).toBeCloseTo(0.7, 9);
      expect(rep.scaleFit.hip.band.lo).toBeCloseTo(1, 9);
      expect(rep.scaleFit.outside).toBe(true);
    }, SLOW);

    test('mutant: SCALE without its remedy lines is red on the foreshortened pair', () => {
      const m = mutant('run.ts', 'export function scaleFitLines(factor: number, f: ScaleFit): string[] {\n  const out: string[] = [];', 'export function scaleFitLines(_factor: number, _f: ScaleFit): string[] {\n  const out: string[] = [];\n  if (out.length === 0) return out;');
      try {
        const r = retarget(setup({ pose: trunkPose((i) => (i < 4 ? 1 : 0.7)) }), [], m.cli);
        expect(r.status).toBe(0);
        console.log(`  mutant "SCALE without remedy": ${linesOf(r, 'SCALE').length} SCALE line(s)`);
        expect(outsideLine(r)).toBeUndefined();
        expect(linesOf(r, 'SCALE').some((l) => l.startsWith('SCALE  bands, '))).toBe(false);
      } finally {
        m.done();
      }
    }, SLOW);

    /** Knees bent in the picture (the shin 20° off the thigh), so the thigh's scale shears the shin (the #47 mutant's pose). */
    const bentPose = () => poseDoc({ ...STILL, rs: () => THIGH - 20 }, (i, j) => {
      for (const s of ['r', 'l'] as const) {
        const hip = j[`${s}_hip`]!.at as Pt;
        const knee = add(hip, dir(THIGH, 80 * bendF(i)));
        j[`${s}_knee`] = { state: 'observed', at: knee, score: 0.9 };
        j[`${s}_ankle`] = { state: 'observed', at: add(knee, dir(s === 'r' ? THIGH - 20 : SHIN, 70 * bendF(i))), score: 0.9 };
      }
    });
    const shearOf = (r: Ran, bone: string) => linesOf(r, 'SHEAR').find((l) => l.startsWith(`SHEAR  bone "${bone}":`))!;

    test('SHEAR: a bone sheared by its scaled parent names "inherit": "noScale" as the fix; a noScale bone and an unsheared one do not', () => {
      const r = retarget(setup({ pose: bentPose() }), ['--leg-scale', '0.8,1.05']);
      expect(r.status).toBe(0);
      const shin = shearOf(r, 'leg_r1');
      expect(shin).toMatch(/art sheared up to [1-9]/);
      expect(shin).toContain('; it inherits "normal" from scaled "leg_r0" — "inherit": "noScale" on bone "leg_r1" in the rig spec unshears its art and still turns it with "leg_r0"');
      // The thigh is scaled along its own x axis under an unscaled hip: no shear, so no remedy.
      expect(shearOf(r, 'leg_r0')).toMatch(/art sheared up to 0\.00° .* a reading$/);
      // Control: the fix applied — the shin inherits noScale, and its line no longer asks for it.
      const fixed = retarget(setup({ pose: bentPose(), rig: { bones: (bs) => bs.map((b) => (b.name === 'leg_r1' ? { ...b, inherit: 'noScale' } : b)) } }), ['--leg-scale', '0.8,1.05']);
      expect(fixed.status).toBe(0);
      expect(shearOf(fixed, 'leg_r1')).toMatch(/art sheared up to 0\.00° .* a reading$/);
      // A mutant without the clause is red on the sheared shin.
      const m = mutant('run.ts', "  if (x.shear.toFixed(2) === '0.00') return '';", "  if (x.shear >= 0) return '';");
      try {
        const red = retarget(setup({ pose: bentPose() }), ['--leg-scale', '0.8,1.05'], m.cli);
        expect(red.status).toBe(0);
        console.log(`  mutant "SHEAR without remedy": ${shearOf(red, 'leg_r1').slice(-60)}`);
        expect(shearOf(red, 'leg_r1')).not.toContain('"inherit": "noScale"');
      } finally {
        m.done();
      }
    }, SLOW);

    /** #94's gait: scaled legs, the hip planted over them, the free left ankle 0.03 leg lengths up on frames 8–15. */
    const gait = () => legsPose(bendF, (i, s) => (s === 'l' && i >= 8 && i <= 15 ? 0.03 * Math.hypot(V[0], V[1]) : 0));
    const GAIT_FLAGS = ['--leg-scale', '0.8,1.05', '--plant-feet', '--stance', '0.07'];
    interface DriftReport {
      landings: Array<{ bone: string; kind: string; tolerance: number }>;
      feet: { rigLeg: { r: number; l: number } };
      reduce: { ankleDrift: Array<{ bone: string; side: 'r' | 'l'; plant: number; reduce: number; units: number; legLengths: number }> };
    }
    const driftLines = (r: Ran) => linesOf(r, 'REDUCE').filter((l) => l.startsWith('REDUCE ankle drift allowed: '));

    test('--reduce: the ankle drift line prints, at the end of the run, the very allowance the landing check applied', () => {
      const c = setup({ pose: gait() });
      const report = join(c.dir, 'report.json');
      const r = retarget(c, [...GAIT_FLAGS, '--reduce', '0.4', '--reduce-hip', '0.5', '--report', report]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const rep = JSON.parse(readFileSync(report, 'utf8')) as DriftReport;
      const ankles = rep.landings.filter((l) => l.kind === 'foot');
      expect(ankles).toHaveLength(2);
      expect(rep.reduce.ankleDrift.map((d) => d.bone)).toEqual(ankles.map((l) => l.bone));
      for (const d of rep.reduce.ankleDrift) {
        // The same figure, not a recomputation: the LAND tolerance is plant + reduce, and the drift row is that sum.
        const land = ankles.find((l) => l.bone === d.bone)!;
        expect(d.units).toBe(land.tolerance);
        expect(d.plant + d.reduce).toBe(d.units);
        expect(d.legLengths).toBe(d.units / rep.feet.rigLeg[d.side]);
        // The reduction's share holds the hip's tolerance and a lever turned by the angle tolerance (#94's bound).
        expect(d.reduce).toBeGreaterThan(0.5 + 150 * (0.4 * RAD + 5e-5));
      }
      const lines = driftLines(r);
      expect(lines).toHaveLength(2);
      // At the end of the run: after every LAND, JITTER and FOLD line.
      const all = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      const at = all.indexOf(lines[0]!);
      // Only what was written follows: the build's record (#270) and the wrote lines.
      expect(all.slice(at + 2).every((l) => l.startsWith('wrote ') || l.startsWith('RECORD '))).toBe(true);
      for (const [k, d] of rep.reduce.ankleDrift.entries()) {
        expect(lines[k]).toStartWith(`REDUCE ankle drift allowed: bone "${d.bone}" ${d.units.toPrecision(3)} units = ${d.legLengths.toPrecision(3)} leg lengths on any one frame (plant ${d.plant.toPrecision(3)} + reduce ${d.reduce.toPrecision(3)})`);
        expect(lines[k]).toContain(`between two frames up to ${(2 * d.units).toPrecision(3)} units`);
      }
      // Without --reduce there is nothing allowed beyond the plant, and no line.
      const dense = retarget(c, GAIT_FLAGS);
      expect(dense.status).toBe(0);
      expect(driftLines(dense)).toEqual([]);
    }, SLOW);

    test('mutant: a drift line computed apart from the landing check (the hip\'s share left out) disagrees with it, and the control above is red', () => {
      const m = mutant('run.ts', "drift.push({ bone: l.bone, side, plant: l.tolerance, reduce: by, units: l.tolerance + by,", "drift.push({ bone: l.bone, side, plant: l.tolerance, reduce: by - (a.reduceHip ?? 0), units: l.tolerance + by - (a.reduceHip ?? 0),");
      try {
        const c = setup({ pose: gait() });
        const report = join(c.dir, 'report.json');
        const r = retarget(c, [...GAIT_FLAGS, '--reduce', '0.4', '--reduce-hip', '0.5', '--report', report], m.cli);
        expect(r.status).toBe(0);
        const rep = JSON.parse(readFileSync(report, 'utf8')) as DriftReport;
        const mismatched = rep.reduce.ankleDrift.filter((d) => d.units !== rep.landings.find((l) => l.bone === d.bone)!.tolerance);
        console.log(`  mutant "drift apart from the check": ${mismatched.length} of ${rep.reduce.ankleDrift.length} drift row(s) disagree with LAND`);
        expect(mismatched).toHaveLength(2);
      } finally {
        m.done();
      }
      const gone = mutant('run.ts', "    for (const d of drift) say(`  REDUCE ${ankleDriftLine(d)}`);", '');
      try {
        const r = retarget(setup({ pose: gait() }), [...GAIT_FLAGS, '--reduce', '0.4'], gone.cli);
        expect(r.status).toBe(0);
        expect(driftLines(r)).toEqual([]);
      } finally {
        gone.done();
      }
    }, SLOW);

    test('MAP_CHAIN_JOINTS: a three-bone leg on hip, knee and ankle is told body-18 has no toe, and which bone to leave out', () => {
      const rig = { bones: (bs: BoneSpec[]) => [...bs, { name: 'foot_r', parent: 'leg_r1', x: 70, y: 0, rotation: 80, length: 25 }] };
      const map = baseMap();
      map.chains = baseChains().map((ch) => (ch.name === 'leg_r' ? { ...ch, bones: ['leg_r0', 'leg_r1', 'foot_r'] } : ch));
      const want = 'FAIL  MAP_CHAIN_JOINTS: chain "leg_r" has 3 bone(s) and 3 joint(s); bone k carries the segment from joint k to joint k+1, so it needs 4 — body-18 has no toe past "r_ankle", so nothing aims bone "foot_r": list the chain\'s bones up to the one ending at "r_ankle" ("leg_r0", "leg_r1") and leave "foot_r" out of "bones"; it stays unkeyed and turns with its parent';
      const r = retarget(setup({ rig, map }));
      expect(r.status).toBe(1);
      expect(fails(r)).toContain(want);
      // Control: the remedy taken — the same rig and the leg's two bones — is green, and the foot is unkeyed.
      const fixedMap = baseMap();
      const c = setup({ rig, map: fixedMap });
      const ok = retarget(c);
      expect(ok.status).toBe(0);
      expect(motionOf(c.out).animations.dance!.tracks.some((t) => t.bone === 'foot_r')).toBe(false);
      // A count short of a joint that ends no limb (the arm's two bones on shoulder and elbow) is the readers' case, without the clause.
      const m = mutant('map.ts', "  if (what === undefined) return '';\n  const bone", "  if (what !== null) return '';\n  const bone");
      try {
        const red = retarget(setup({ rig, map }), [], m.cli);
        console.log(`  mutant "MAP_CHAIN_JOINTS without the toe": ${fails(red).find((l) => l.startsWith('FAIL  MAP_CHAIN_JOINTS'))?.slice(-50)}`);
        expect(fails(red)).not.toContain(want);
      } finally {
        m.done();
      }
    }, SLOW);
  });
});

// ===========================================================================

describe('#43 item 2: the idle tracks a retarget drops, --carry-idle, --merge', () => {
  // The stick's idle (1 s): a bone scale track on "neck" (a raw curve, then a named easing), an
  // attachment track on a "face" slot (its last key before the idle's end, so a loop holds it), and
  // a rotate on "sleeve_r0", which the retarget keys itself. The card's pose runs 1.875 s, so the
  // second cycle is cut inside its eased segment.
  const D = 1;
  const T = (BASE.n - 1) * BASE.dt;
  const idle = {
    duration: D,
    tracks: [
      { bone: 'neck', property: 'scaley', keys: [{ t: 0, v: [1], curve: [0.2, 1, 0.3, 1.5] }, { t: 0.5, v: [1.5], ease: 'soft' }, { t: 1, v: [1] }] },
      { slot: 'face', property: 'attachment', keys: [{ t: 0, v: 'open' }, { t: 0.6, v: 'shut' }, { t: 0.8, v: 'open' }] },
      { bone: 'sleeve_r0', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 1, v: [10] }] },
    ],
  };
  const motion = { spec: 'rigc-motion/1', archetype: 'stick', cut: 'stick', easings: { soft: [0.25, 0.1, 0.25, 1] }, animations: { idle } };
  const rig: RigOpts = {
    motion,
    extraSlots: [{ name: 'face', bone: 'neck', attachment: 'open' }],
    extra: { face: { open: { image: 'seg.png' }, shut: { image: 'seg.png' } } },
  };
  const blink = (keys: Array<{ t: number; v: number[] }>, extra: Record<string, unknown> = {}) => ({ spec: 'rig-pose-tracks/1', tracks: [{ bone: 'neck', property: 'scalex', keys, ...extra }] });
  const writeFragment = (c: Case, doc: unknown): string => {
    const f = join(c.dir, 'blink.tracks.json');
    writeFileSync(f, JSON.stringify(doc, null, 2));
    return f;
  };
  /** Each time's pose of `anim` in the kept build, by rig-c's poser. */
  const poseAt = (build: string, anim: string, t: number) => {
    const p = poseRawAnimation(loadBuild(build), anim, t === 0 ? [] : [t]);
    return p[p.length - 1]!;
  };
  const neck = (build: string, anim: string, t: number, k: 'scaleX' | 'scaleY') => poseAt(build, anim, t).bones.find((b) => b.name === 'neck')![k];
  const face = (build: string, anim: string, t: number) => poseAt(build, anim, t).slots.find((row) => row[0] === 'face')![1];

  test('IDLE-DROPPED lists the bone scale and the slot attachment tracks; the retarget\'s own bone is IDLE-KEPT-OUT; the report says the same', () => {
    const c = setup({ rig });
    const report = join(c.dir, 'report.json');
    const r = retarget(c, ['--report', report]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'IDLE')).toEqual(['IDLE   animation "idle" (1.000s, 3 track(s)) against "dance": 2 dropped (not carried; --carry-idle loops them in), 1 kept out']);
    expect(linesOf(r, 'IDLE-DROPPED')).toEqual([
      'IDLE-DROPPED bone "neck" scaley: 3 key(s) over the idle\'s 1.000s; "dance" does not key it — not carried (no --carry-idle)',
      'IDLE-DROPPED slot "face" attachment: 3 key(s) over the idle\'s 1.000s; "dance" does not key it — not carried (no --carry-idle)',
    ]);
    expect(linesOf(r, 'IDLE-KEPT-OUT')).toEqual(['IDLE-KEPT-OUT bone "sleeve_r0" rotate: "dance"\'s own bone "sleeve_r0" rotate keys it, so the idle\'s track is not carried']);
    const rep = JSON.parse(readFileSync(report, 'utf8')) as { idleDropped: Array<{ target: unknown; property: string; keys: number; duration: number; carried: unknown }>; idleKeptOut: Array<{ target: unknown }> };
    expect(rep.idleDropped.map((d) => [d.target, d.property, d.keys, d.duration, d.carried])).toEqual([[{ kind: 'bone', name: 'neck' }, 'scaley', 3, 1, null], [{ kind: 'slot', name: 'face' }, 'attachment', 3, 1, null]]);
    expect(rep.idleKeptOut.map((k) => k.target)).toEqual([{ kind: 'bone', name: 'sleeve_r0' }]);
  }, SLOW);

  test('everything off: the motion written is the plain retarget\'s, byte for byte, beside the idle', () => {
    const c = setup({ rig });
    expect(retarget(c).status).toBe(0);
    const plain = setup();
    expect(retarget(plain).status).toBe(0);
    const a = motionOf(c.out);
    const b = motionOf(plain.out);
    expect(JSON.stringify(a.animations.dance)).toBe(JSON.stringify(b.animations.dance));
    expect(readFileSync(c.out, 'utf8')).toBe(`${JSON.stringify({ ...motion, animations: { idle, dance: b.animations.dance } }, null, 2)}\n`);
  }, SLOW);

  test('--carry-idle loops both into "dance": rig-c\'s poser reads the idle at t mod 1 s in the second cycle and at the cut; the gate is green and every bone lands', () => {
    const c = setup({ rig });
    const r = retarget(c, ['--carry-idle']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'IDLE-DROPPED')).toEqual([
      'IDLE-DROPPED bone "neck" scaley: 3 key(s) over the idle\'s 1.000s; "dance" does not key it — carried: 5 key(s), 2 cycle(s), cut at 1.875s',
      'IDLE-DROPPED slot "face" attachment: 3 key(s) over the idle\'s 1.000s; "dance" does not key it — carried: 6 key(s), 2 cycle(s), cut at 1.875s',
    ]);
    expect(linesOf(r, 'GATE')[0]).toStartWith('GATE   rigc build --profile spine: green');
    expect(fails(r)).toEqual([]);
    expect(misses(c.build, BASE)).toEqual([]);
    const tracks = motionOf(c.out).animations.dance.tracks as unknown as RigcTrack[];
    const scale = tracks.find((t) => t.bone === 'neck')!;
    // The seam at 1 s is one key (the idle's last and first agree); the cut key at 1.875 s carries no ease.
    expect(scale.keys.map((k) => k.t)).toEqual([0, 0.5, 1, 1.5, T]);
    expect(scale.keys[1]!.ease).toBe('soft');
    // The segment the cut falls in: its named easing becomes the raw curve of its first part.
    expect(scale.keys[3]!.ease).toBeUndefined();
    expect(scale.keys[3]!.curve).toHaveLength(4);
    expect(Object.keys(scale.keys[4]!).sort()).toEqual(['t', 'v']);
    // The attachment's last key (0.8 s) holds to the cycle's end, and the next cycle opens at 1 s.
    expect(tracks.find((t) => t.slot === 'face')!.keys.map((k) => [k.t, k.v])).toEqual([[0, 'open'], [0.6, 'shut'], [0.8, 'open'], [1, 'open'], [1.6, 'shut'], [1.8, 'open']]);
    // Off the cut segment, the second cycle is the idle at t − 1 s.
    for (const t of [0.25, 0.75, 1.25, 1.45]) expect(Math.abs(neck(c.build, 'dance', t, 'scaleY') - neck(c.build, 'idle', t - Math.floor(t), 'scaleY'))).toBeLessThan(1e-5);
    // On it (1.5 s to the cut), against the idle's eased segment as a continuous cubic — "soft" from (0.5, 1.5) to (1, 1),
    // handles (0.625, 1.45) and (0.625, 1). rig-c draws a Bézier as Spine's polyline, so both the carried part and the
    // idle's whole segment sit off the cubic by that alone: measured, the carried ≤ 9.3e-4 and the idle's own up to
    // 2.6e-3 (at 0.875 s). The cut key itself is the cubic's value.
    const cubic = (t: number): number => {
      const bez = (p: [number, number, number, number], s: number) => (1 - s) ** 3 * p[0] + 3 * (1 - s) ** 2 * s * p[1] + 3 * (1 - s) * s * s * p[2] + s ** 3 * p[3];
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) if (bez([0.5, 0.625, 0.625, 1], (lo + hi) / 2) < t) lo = (lo + hi) / 2; else hi = (lo + hi) / 2;
      return bez([1.5, 1.45, 1, 1], lo);
    };
    for (const t of [1.6, 1.7, 1.8]) {
      expect(Math.abs(neck(c.build, 'dance', t, 'scaleY') - cubic(t - 1))).toBeLessThan(1.5e-3);
      expect(Math.abs(neck(c.build, 'idle', t - 1, 'scaleY') - cubic(t - 1))).toBeLessThan(3e-3);
    }
    expect(Math.abs(neck(c.build, 'dance', T, 'scaleY') - cubic(T - 1))).toBeLessThan(1e-5);
    for (const t of [0.3, 0.7, 0.9, 1.3, 1.65, 1.85]) expect(face(c.build, 'dance', t)).toBe(face(c.build, 'idle', t - Math.floor(t)));
    expect([0.7, 1.65].map((t) => face(c.build, 'dance', t))).toEqual(['shut', 'shut']);
    // Control: without the flag the face never shuts in "dance", and the neck keeps its setup scale.
    const off = setup({ rig });
    expect(retarget(off).status).toBe(0);
    expect(face(off.build, 'dance', 0.7)).toBe('open');
    expect(neck(off.build, 'dance', 1.25, 'scaleY')).toBeCloseTo(1, 6);
    expect(neck(c.build, 'dance', 1.25, 'scaleY')).toBeCloseTo(1.25, 4);
  }, SLOW);

  test('--merge: a blink fragment shows on its frames; a conflicting track and a late key are refused by name, nothing written', () => {
    const c = setup({ rig });
    const ok = writeFragment(c, blink([{ t: 0.5, v: [1] }, { t: 0.625, v: [0.2] }, { t: 0.75, v: [1] }]));
    const r = retarget(c, ['--merge', ok]);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'MERGE')).toEqual([`MERGE  ${ok}: bone "neck" scalex, 3 key(s) at t=0.5–0.75s`]);
    expect([0.375, 0.5, 0.5625, 0.625, 0.75, 0.875].map((t) => Number(neck(c.build, 'dance', t, 'scaleX').toFixed(4)))).toEqual([1, 1, 0.6, 0.2, 1, 1]);

    const conflict = writeFragment(c, { spec: 'rig-pose-tracks/1', tracks: [{ bone: 'sleeve_r0', property: 'rotate', keys: [{ t: 0, v: [0] }] }] });
    const rc = retarget(c, ['--merge', conflict]);
    expect(rc.status).toBe(1);
    expect(fails(rc)).toEqual([`FAIL  MERGE_CONFLICT: ${conflict} tracks[0] (bone "sleeve_r0" rotate) — "dance" already keys it: bone "sleeve_r0" rotate; a fragment adds a track where nothing keys that target and property, it never replaces one`]);

    // The carried idle keys the neck's scaley: a fragment on it conflicts with that, by name.
    const onIdle = writeFragment(c, { spec: 'rig-pose-tracks/1', tracks: [{ bone: 'neck', property: 'scale', keys: [{ t: 0.5, v: [1, 0.2] }] }] });
    const ri = retarget(c, ['--merge', onIdle, '--carry-idle']);
    expect(ri.status).toBe(1);
    expect(fails(ri)[0]).toBe(`FAIL  MERGE_CONFLICT: ${onIdle} tracks[0] (bone "neck" scale) — "dance" already keys it: bone "neck" scaley; a fragment adds a track where nothing keys that target and property, it never replaces one`);

    const late = writeFragment(c, blink([{ t: 1.5, v: [1] }, { t: 2, v: [0.2] }]));
    const rl = retarget(c, ['--merge', late]);
    expect(rl.status).toBe(1);
    expect(fails(rl)).toEqual([`FAIL  MERGE_TIME: ${late} tracks[0] (bone "neck" scalex) keys[1] at t=2s is past "dance"'s duration 1.875s; a fragment's times are absolute, from the animation's start, within [0, 1.875]`]);

    const bad = writeFragment(c, { spec: 'rig-pose-tracks/0', tracks: [] });
    const rb = retarget(c, ['--merge', bad]);
    expect(rb.status).toBe(1);
    expect(fails(rb)[0]).toStartWith(`FAIL  MERGE_SPEC: ${bad}: "spec" is the string "rig-pose-tracks/0"`);
    expect(existsSync(c.out)).toBe(true); // the first, green run's
    rmSync(c.out);
    expect(retarget(c, ['--merge', conflict]).status).toBe(1);
    expect(existsSync(c.out)).toBe(false);
  }, SLOW);

  test('rigc\'s gate judges a merged track like any other: a bone the rig does not have is red', () => {
    const c = setup({ rig });
    const f = writeFragment(c, { spec: 'rig-pose-tracks/1', tracks: [{ bone: 'nose', property: 'scaley', keys: [{ t: 0, v: [1] }] }] });
    const r = retarget(c, ['--merge', f]);
    expect(r.status).toBe(1);
    expect(fails(r)[0]).toStartWith('FAIL  RIG_GATE: rigc build --profile spine is red with "dance" in');
    expect(fails(r).join('\n')).toContain('nose');
  }, SLOW);

  test('IDLE_NAME: --idle naming an animation the motion spec lacks, and --carry-idle on a rig with no idle, are refused by name', () => {
    const c = setup({ rig });
    const r = retarget(c, ['--idle', 'breathe']);
    expect(r.status).toBe(1);
    expect(fails(r)).toEqual([`FAIL  IDLE_NAME: --idle "breathe" the rig's motion spec ${join(c.rig, 'motion.json')} has no animation "breathe" (it has idle); name the rig's idle with --idle`]);
    const bare = setup();
    const rb = retarget(bare, ['--carry-idle']);
    expect(rb.status).toBe(1);
    expect(fails(rb)[0]).toStartWith('FAIL  IDLE_NAME: --carry-idle reads the animation "idle", and the rig\'s motion spec — there is none');
    // Control: no idle and no flag is a line, not a refusal.
    const rc = retarget(bare);
    expect(rc.status).toBe(0);
    expect(linesOf(rc, 'IDLE')).toEqual(['IDLE   the rig has no motion spec; no idle read (--idle names another)']);
  }, SLOW);

  test('a rotate, scale or shear above a mapped bone is IDLE-KEPT-OUT; a translate of it is carried, and every bone lands', () => {
    // "chest_ctl" between the hip and the chest, as on @rig-c/parts rigs: its rotate would turn the chest and the arms
    // off their keys, its translate only moves them. "root" sits above the first mapped bone (the translated hip).
    const ctl: RigOpts = {
      ...rig,
      bones: (bs) => bs.flatMap((b) => (b.name === 'chest' ? [{ name: 'chest_ctl', parent: 'hip', x: 0, y: 75 }, { ...b, parent: 'chest_ctl', y: 0 }] : [b])),
      motion: { ...motion, animations: { idle: { duration: D, tracks: [
        { bone: 'chest_ctl', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 0.5, v: [8] }, { t: 1, v: [0] }] },
        { bone: 'chest_ctl', property: 'translatey', keys: [{ t: 0, v: [0] }, { t: 0.5, v: [6] }, { t: 1, v: [0] }] },
        { bone: 'root', property: 'shear', keys: [{ t: 0, v: [0, 0] }, { t: 1, v: [3, 0] }] },
        { bone: 'neck', property: 'scaley', keys: [{ t: 0, v: [1] }, { t: 0.5, v: [1.5] }, { t: 1, v: [1] }] },
      ] } } },
    };
    const c = setup({ rig: ctl });
    const r = retarget(c, ['--carry-idle']);
    expect(r.status).toBe(0);
    expect(linesOf(r, 'IDLE-KEPT-OUT')).toEqual([
      'IDLE-KEPT-OUT bone "chest_ctl" rotate: moves mapped bone(s) "chest", "sleeve_r0", "sleeve_r1", "sleeve_l0", "sleeve_l1" below it; the retarget\'s keys assume it at setup, so the idle\'s track is not carried',
      'IDLE-KEPT-OUT bone "root" shear: moves mapped bone(s) "chest", "sleeve_r0", "sleeve_r1", "sleeve_l0", "sleeve_l1", "leg_r0", "leg_r1", "leg_l0", "leg_l1", "hip" below it; the retarget\'s keys assume it at setup, so the idle\'s track is not carried',
    ]);
    expect(linesOf(r, 'IDLE-DROPPED').map((l) => l.replace(/:.*— /, ': … — '))).toEqual([
      'IDLE-DROPPED bone "chest_ctl" translatey: … — carried: 5 key(s), 2 cycle(s), cut at 1.875s',
      'IDLE-DROPPED bone "neck" scaley: … — carried: 5 key(s), 2 cycle(s), cut at 1.875s',
    ]);
    expect(fails(r)).toEqual([]);
    expect(linesOf(r, 'LAND').length).toBeGreaterThan(0);
    // The chest moves up and down with the idle, at t mod 1 s, and still points where the pose asks.
    expect(misses(c.build, BASE)).toEqual([]);
    const chestY = (anim: string, t: number) => poseAt(c.build, anim, t).bones.find((b) => b.name === 'chest')!.worldY - poseAt(c.build, anim, t).bones.find((b) => b.name === 'hip')!.worldY;
    const setupY = chestY('idle', 0);
    for (const t of [0.5, 1.25, 1.5, 1.75]) {
      const want = chestY('idle', t - Math.floor(t)) - setupY;
      expect(Math.abs(chestY('dance', t) - setupY - want)).toBeLessThan(1e-4);
    }
    expect(chestY('dance', 1.5) - setupY).toBeGreaterThan(5);
  }, SLOW);

  test('a translate above the translated hip is kept out (it would move the origin the retarget places), and the run lands', () => {
    const moved = { ...motion, animations: { idle: { duration: D, tracks: [{ bone: 'root', property: 'translatey', keys: [{ t: 0, v: [0] }, { t: 0.5, v: [20] }, { t: 1, v: [0] }] }] } } };
    const c = setup({ rig: { ...rig, motion: moved } });
    const r = retarget(c, ['--carry-idle']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'IDLE-KEPT-OUT').some((l) => l.includes('bone "root" translatey') && l.includes('moves the translated bone "hip" below it; the retarget places its origin'))).toBe(true);
    expect(misses(c.build, BASE)).toEqual([]);
  }, SLOW);

  test('loopTrack: a hold to the cycle\'s end, a setup key where the first key is late, a seam that jumps, and what it does not carry', () => {
    const tr = (keys: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): RigcTrack => ({ bone: 'b', property: 'rotate', keys, ...extra }) as unknown as RigcTrack;
    const late = loopTrack(tr([{ t: 0.2, v: [5] }, { t: 0.8, v: [9] }]), 1, 2.5, {}, () => [0]);
    if ('reason' in late) throw new Error(late.reason);
    expect(late.track.keys).toEqual([
      { t: 0.2, v: [5] }, { t: 0.8, v: [9], ease: 'stepped' },
      { t: 1, v: [0], ease: 'stepped' }, { t: 1.2, v: [5] }, { t: 1.8, v: [9], ease: 'stepped' },
      { t: 2, v: [0], ease: 'stepped' }, { t: 2.2, v: [5] }, { t: 2.5, v: [7] },
    ]);
    expect(late.cycles).toBe(3);
    const jump = loopTrack(tr([{ t: 0, v: [0] }, { t: 1, v: [4] }]), 1, 1.5, {}, () => undefined);
    if ('reason' in jump) throw new Error(jump.reason);
    expect(jump.track.keys).toEqual([{ t: 0, v: [0] }, { t: 1, v: [0] }, { t: 1.5, v: [2] }]);
    expect(jump.seams).toBe('the idle\'s last key (t=1s, [4]) is not what it shows at its start ([0]); the loop keys the start at each seam, so it jumps at t=1.000s');
    expect(loopTrack(tr([{ t: 0, v: [0] }], { lag: 0.1 }), 1, 2, {}, () => undefined)).toEqual({ reason: 'it carries "lag", which shifts its keys per track or per member; a loop is cut by key time, so it is not carried' });
    expect('reason' in loopTrack({ slot: 's', property: 'rgba', keys: [{ t: 0.5, v: [1, 1, 1, 1] }] } as RigcTrack, 1, 2, {}, () => undefined)).toBe(true);
  });
});

describe('--reduce: few keys with curves within a stated tolerance (rig-c/pose#32)', () => {
  test('every bone stays within the tolerance of the known angles on every frame, posed by rig-c; the keys drop; the hip stays dense without --reduce-hip', () => {
    const c = setup({ pose: poseDoc(SMOOTH) });
    const dense = retarget(c);
    expect(dense.status).toBe(0);
    const before = Object.keys(BONE_ANGLE).reduce((s, b) => s + keysOf(c.out, b, 'rotate').length, 0);
    expect(before).toBe(9 * 48);
    const r = retarget(c, ['--reduce', '1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const lines = linesOf(r, 'REDUCE');
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)).toContain('the hip stays dense (no --reduce-hip)');
    const after = Object.keys(BONE_ANGLE).reduce((s, b) => s + keysOf(c.out, b, 'rotate').length, 0);
    expect(after).toBeLessThan(before / 3);
    expect(lines.at(-1)).toContain(`rotate keys ${before} → ${after}`);
    expect(keysOf(c.out, 'hip', 'translate')).toHaveLength(48);
    for (const b of Object.keys(BONE_ANGLE)) {
      const keys = keysOf(c.out, b, 'rotate');
      expect(keys[0]!.t).toBe(0);
      expect(keys.at(-1)!.curve).toBeUndefined();
    }
    expect(Object.keys(BONE_ANGLE).some((b) => keysOf(c.out, b, 'rotate').some((k) => k.curve !== undefined))).toBe(true);
    const worst = worstErrors(c.build, SMOOTH);
    for (const b of Object.keys(BONE_ANGLE)) expect(worst.get(b)!).toBeLessThanOrEqual(1 + ANGLE_TOL);
    expect(worst.get('hip')!).toBeLessThanOrEqual(ORIGIN_TOL);
  }, SLOW);

  test('--reduce-hip thins the hip within its tolerance', () => {
    const c = setup({ pose: poseDoc(SMOOTH) });
    const r = retarget(c, ['--reduce', '1', '--reduce-hip', '0.5']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'REDUCE').some((l) => l.startsWith('REDUCE hip "hip" translate: 48 → '))).toBe(true);
    expect(keysOf(c.out, 'hip', 'translate').length).toBeLessThan(48);
    expect(worstErrors(c.build, SMOOTH).get('hip')!).toBeLessThanOrEqual(0.5 + ORIGIN_TOL);
  }, SLOW);

  test('control: a tolerance the reduction did not meet is caught by the independent check', () => {
    const c = setup({ pose: poseDoc(SMOOTH) });
    expect(retarget(c, ['--reduce', '3']).status).toBe(0);
    const worst = worstErrors(c.build, SMOOTH);
    expect(Math.max(...Object.keys(BONE_ANGLE).map((b) => worst.get(b)!))).toBeGreaterThan(1 + ANGLE_TOL);
  }, SLOW);

  test('refused: --reduce-hip alone (#94 lifted the refusal with --plant-feet and --leg-scale)', () => {
    const c = setup();
    const alone = retarget(c, ['--reduce-hip', '1']);
    expect(alone.status).toBe(2);
    expect(alone.stderr).toContain('--reduce-hip is given without --reduce');
    expect(existsSync(c.out)).toBe(false);
  });

  test('mutant: fitting each bone against its own dense keys (its parent\'s error ignored) piles errors down a chain, and the run is refused', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const path = join(d, 'src', 'reduce.ts');
      const before = readFileSync(path, 'utf8');
      expect(before.split(REDUCE_MUTANT.from)).toHaveLength(2);
      writeFileSync(path, before.replace(REDUCE_MUTANT.from, REDUCE_MUTANT.to));
      const c = setup({ pose: poseDoc(SMOOTH) });
      const r = retarget(c, ['--reduce', '1'], join(d, 'cli.ts'));
      const worst = r.status === 0 ? worstErrors(c.build, SMOOTH) : null;
      const red = r.status !== 0 || Object.keys(BONE_ANGLE).some((b) => worst!.get(b)! > 1 + ANGLE_TOL);
      console.log(`  mutant "reduce ignores the parent's error": exit ${r.status}${r.status !== 0 ? `, ${r.stderr.split('\n').find((l) => l.includes('POSE_LANDS')) ?? r.stderr.split('\n')[0]}` : ''}`);
      expect(red).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});

// ===========================================================================

describe('#63: the camera a scan read, carried by the sequence', () => {
  /** A camera whose s steps where it is known: rising 0.002 a frame, dropping 0.05 into frame 6 and 0.04 into frame 11, 0.03 into 14. */
  const knownS = (i: number): number => 1 + 0.002 * i - (i >= 6 ? 0.05 : 0) - (i >= 11 ? 0.04 : 0) - (i >= 14 ? 0.03 : 0);
  const camera = (n: number) => Array.from({ length: n }, (_, i) => ({ s: Number(knownS(i).toFixed(6)), tx: 1.5 * i, ty: 0 - 0.25 * i, inliers: 40 + i }));
  const withCamera = (cam: unknown): Record<string, unknown> => ({ ...poseDoc(BASE), camera: cam });

  test('a valid camera is read; CAMERA names the s range and the three fastest frame-to-frame changes', () => {
    const c = setup({ pose: withCamera(camera(BASE.n)) });
    const r = retarget(c);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(linesOf(r, 'CAMERA')).toEqual([
      'CAMERA (source not stated): the sequence carries the picture\'s camera against frame 0\'s; its joints are normalised by it (p′ = (p − t) / s): s 0.9080 (frame 14) … 1.0100 (frame 5) over 16 frames; s changes fastest at frame 5→6 (t=0.750s) −0.0480, frame 10→11 (t=1.375s) −0.0380, frame 13→14 (t=1.750s) −0.0280; fewest background inliers 40',
    ]);
  }, SLOW);

  test('the camera is read, not applied: the motion is the same bytes with it and without it', () => {
    const plain = setup();
    const carried = setup({ pose: withCamera(camera(BASE.n)) });
    const r0 = retarget(plain);
    const r1 = retarget(carried);
    expect(r0.status).toBe(0);
    expect(r1.status).toBe(0);
    expect(readFileSync(carried.out).equals(readFileSync(plain.out))).toBe(true);
    // Every line but CAMERA is the same, paths aside.
    const rest = (r: Ran, c: Case) => r.stdout.split(c.dir).join('<dir>').split('\n').filter((l) => !l.trim().startsWith('CAMERA '));
    expect(rest(r1, carried)).toEqual(rest(r0, plain));
    expect(linesOf(r0, 'CAMERA')).toEqual([]);
  }, SLOW);

  test('a malformed camera is refused by name, every problem in one run; nothing written', () => {
    const cam: unknown[] = camera(BASE.n);
    cam[1] = { s: 0, tx: 0, ty: 0, inliers: 3 };
    cam[2] = { s: -1.2, tx: 'left', ty: 0, inliers: -1 };
    cam[3] = { s: 1, tx: 0, inliers: 2.5 };
    cam[4] = { s: 1, tx: 0, ty: 0, inliers: 5, rot: 0 };
    cam[5] = [1, 0, 0, 5];
    const c = setup({ pose: withCamera(cam.slice(0, BASE.n - 1)) });
    const r = retarget(c);
    expect(r.status).toBe(1);
    const p = c.pose;
    expect(fails(r)).toEqual([
      `FAIL  POSE_CAMERA: ${p} "camera" has 15 entries and "frames" 16; it must have one per frame`,
      `FAIL  POSE_CAMERA: ${p} camera[1] "s" is number 0; the scale must be a finite number > 0`,
      `FAIL  POSE_CAMERA: ${p} camera[2] "s" is number -1.2; the scale must be a finite number > 0`,
      `FAIL  POSE_CAMERA: ${p} camera[2] "tx" is the string "left"; it must be a finite number of picture px`,
      `FAIL  POSE_CAMERA: ${p} camera[2] "inliers" is number -1; it must be an integer ≥ 0`,
      `FAIL  POSE_CAMERA: ${p} camera[3] has no "ty"; a camera entry carries s, tx, ty, inliers`,
      `FAIL  POSE_CAMERA: ${p} camera[3] "inliers" is number 2.5; it must be an integer ≥ 0`,
      `FAIL  POSE_CAMERA: ${p} camera[4] has a key this reader does not know: "rot"; the keys it reads are s, tx, ty, inliers`,
      `FAIL  POSE_CAMERA: ${p} camera[5] is an array; a camera entry is { s, tx, ty, inliers }`,
    ]);
    expect(existsSync(c.out)).toBe(false);
    // Not an array at all.
    const d = setup({ pose: withCamera({ s: 1 }) });
    const rd = retarget(d);
    expect(rd.status).toBe(1);
    expect(fails(rd)).toEqual([`FAIL  POSE_CAMERA: ${d.pose} "camera" is an object; it must be an array with one { s, tx, ty, inliers } per frame`]);
  }, SLOW);

  test('the writer round-trips a camera, and writes none when there is none', () => {
    const text = JSON.stringify(withCamera(camera(BASE.n)));
    const seq = readPoseSequence(text, 'mem');
    expect(seq.camera).toEqual(camera(BASE.n));
    const written = writePoseSequence(seq);
    expect(readPoseSequence(written, 'mem').camera).toEqual(camera(BASE.n));
    expect(writePoseSequence(readPoseSequence(written, 'mem'))).toBe(written);
    expect(Object.keys(JSON.parse(written) as object)).toEqual(['spec', 'space', 'width', 'height', 'source', 'camera', 'frames']);
    const bare = writePoseSequence(readPoseSequence(JSON.stringify(poseDoc(BASE)), 'mem'));
    expect(Object.keys(JSON.parse(bare) as object)).toEqual(['spec', 'space', 'width', 'height', 'source', 'frames']);
  });

  test('cameraSource: the CAMERA line names it, the writer keeps it, and a malformed one is refused by name', () => {
    const tail = ': the sequence carries the picture\'s camera against frame 0\'s; its joints are normalised by it (p′ = (p − t) / s): s 0.9080 (frame 14) … 1.0100 (frame 5) over 16 frames; s changes fastest at frame 5→6 (t=0.750s) −0.0480, frame 10→11 (t=1.375s) −0.0380, frame 13→14 (t=1.750s) −0.0280; fewest background inliers 40';
    for (const source of ['tracked', 'hand-labelled, 6 keys', 'hand windows, floor-snapped: 5-6 (r+l, l/r 0.4 %)']) {
      const c = setup({ pose: { ...withCamera(camera(BASE.n)), cameraSource: source } });
      const r = retarget(c);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      // A camera by hand (a file or windows snapped on the floor) fitted no feature, so the line states no inlier count.
      expect(linesOf(r, 'CAMERA')).toEqual([`CAMERA ${source}${source === 'tracked' ? tail : tail.replace('; fewest background inliers 40', '')}`]);
      const seq = readPoseSequence(readFileSync(c.pose, 'utf8'), c.pose);
      expect(seq.cameraSource).toBe(source);
      const written = writePoseSequence(seq);
      expect(Object.keys(JSON.parse(written) as object)).toEqual(['spec', 'space', 'width', 'height', 'source', 'cameraSource', 'camera', 'cleaned', 'frames']);
      expect(readPoseSequence(written, 'mem').cameraSource).toBe(source);
    }
    // Planted: a source with no camera; a source that is not a string; an empty one.
    const lone = setup({ pose: { ...poseDoc(BASE), cameraSource: 'tracked' } });
    const rl = retarget(lone);
    expect(rl.status).toBe(1);
    expect(fails(rl)).toEqual([`FAIL  POSE_CAMERA_SOURCE: ${lone.pose} has "cameraSource" "tracked" and no "camera"; it states where a camera came from, so it needs one`]);
    for (const [bad, shown] of [[3, 'number 3'], ['', 'the string ""']] as const) {
      const c = setup({ pose: { ...withCamera(camera(BASE.n)), cameraSource: bad } });
      const r = retarget(c);
      expect(r.status).toBe(1);
      expect(fails(r)).toEqual([`FAIL  POSE_CAMERA_SOURCE: ${c.pose} "cameraSource" is ${shown}; it must be a non-empty string saying where the camera came from ("tracked", "hand-labelled, N keys")`]);
      expect(existsSync(c.out)).toBe(false);
    }
  }, SLOW);

  /** Standing still, both legs straight down: --plant-feet has a floor to hold. */
  const STAND: Motion = { ...BASE, n: 24, dt: 1 / 24, rt: () => -95, rs: () => -97, lt: () => -95, ls: () => -97, hip: () => [0, 0] };
  test('--plant-feet without a camera says the floor may step with the picture; with one, or without --plant-feet, it does not', () => {
    const note = 'CAMERA none in the sequence: --plant-feet reads the picture as a fixed camera, so a zoom or a pan in the video moves the floor with it and the floor may step with the picture (tools/scan.py reads the camera, rig-c/pose#63)';
    const bare = setup({ pose: poseDoc(STAND) });
    const rb = retarget(bare, ['--plant-feet']);
    expect(rb.status).toBe(0);
    expect(linesOf(rb, 'CAMERA')).toEqual([note]);
    const off = retarget(bare);
    expect(off.status).toBe(0);
    expect(linesOf(off, 'CAMERA')).toEqual([]);
    const carried = setup({ pose: { ...poseDoc(STAND), camera: camera(STAND.n) } });
    const rc = retarget(carried, ['--plant-feet']);
    expect(rc.status).toBe(0);
    expect(linesOf(rc, 'CAMERA')).toHaveLength(1);
    expect(linesOf(rc, 'CAMERA')[0]).toStartWith('CAMERA (source not stated): the sequence carries the picture\'s camera');
  }, SLOW);
});
