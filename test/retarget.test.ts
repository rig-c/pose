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
