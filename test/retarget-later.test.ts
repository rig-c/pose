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
