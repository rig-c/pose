/**
 * The pose sequence: `rig-pose-sequence/1`.
 *
 * It is @rig-c/parts' `spine-parts-keypoints/1` (one picture's joints) extended
 * to frames, with the same vocabulary — `space`, `width`/`height`, `source`,
 * `people[].id`, `people[].joints.<body-18 name>.{state, at, score}` — and one
 * new level, `frames[]`, each carrying its time `t` in seconds:
 *
 *   { "spec": "rig-pose-sequence/1",
 *     "space": { "units": "picture-px", "origin": "top-left", "y": "down" },
 *     "width": 1080, "height": 1920,
 *     "source": "what produced the file",
 *     "frames": [ { "t": 0, "people": [ { "id": "a", "joints": {
 *         "neck": { "state": "observed", "at": [540, 400], "score": 0.93 } } } ] } ] }
 *
 * Differences from the keypoints file, each a consequence of what a sequence
 * is: the unit is `picture-px` (a video frame is not a painting), and `at` may
 * lie outside the picture (a dancer's hand leaves the frame; a pose model
 * places it anyway, and its score says how much to believe it).
 *
 * The minor (rig-c/pose#288): `rig-pose-sequence/1.1` adds the pelvis track —
 * a per-frame `pelvisTilt` and the sequence's `pelvisSource` (`rig-pose
 * pelvis`). The writer writes the minor the content needs: a sequence with the
 * track is "rig-pose-sequence/1.1", every other one "rig-pose-sequence/1", so
 * a sequence without it stays readable by a reader of /1. The spec string is
 * the version the file records of what wrote it: a file of a minor newer than
 * this reader's is read, and each key it does not know is refused naming the
 * minor the file says it was written as.
 *
 * `rig-pose-sequence/1.2` (rig-c/pose#281) adds derived depth: a per-frame
 * `depth`, one `{ ratio, sign, source }` per limb segment, written by `clean
 * --depth walk|run` (`source: "derived"`) or by a 3D detector (`"measured"`,
 * read and never written here). A minor includes the keys of the minors before
 * it, so a sequence with depth is "/1.2" whether or not it also carries the
 * pelvis track; one with the track and no depth stays "/1.1".
 */
import { BODY18, COCO17, COCO17_TO_BODY18, isBody18, type Body18 } from './joints.ts';
import { isObject, parseJson, Problems, refuseUnknownKeys, refuseUnknownKeys as refuseKeys, typeName } from './problems.ts';

export const POSE_SPEC = 'rig-pose-sequence/1';
/** The minor with the pelvis track (rig-c/pose#288). */
export const POSE_SPEC_PELVIS = 'rig-pose-sequence/1.1';
/** The minor with derived depth (rig-c/pose#281), and the newest minor this reader reads. */
export const POSE_SPEC_DEPTH = 'rig-pose-sequence/1.2';
const POSE_MINOR = 2;
/**
 * The limb segments a frame's `depth` names (rig-c/pose#281), each from its
 * proximal joint to its distal one: the sign is + when the distal joint is
 * nearer the camera than the proximal one.
 */
export const DEPTH_SEGMENTS = {
  r_upper_arm: ['r_shoulder', 'r_elbow'],
  r_forearm: ['r_elbow', 'r_wrist'],
  r_thigh: ['r_hip', 'r_knee'],
  r_shin: ['r_knee', 'r_ankle'],
  l_upper_arm: ['l_shoulder', 'l_elbow'],
  l_forearm: ['l_elbow', 'l_wrist'],
  l_thigh: ['l_hip', 'l_knee'],
  l_shin: ['l_knee', 'l_ankle'],
} as const satisfies Record<string, readonly [Body18, Body18]>;
export type DepthSegment = keyof typeof DEPTH_SEGMENTS;
export const DEPTH_SEGMENT_NAMES = Object.keys(DEPTH_SEGMENTS) as DepthSegment[];
/** Where a segment's depth came from: read off the picture's 2D lengths (`clean --depth`), or a 3D detector's. */
export const DEPTH_SOURCES = ['derived', 'measured'] as const;
export type DepthSource = (typeof DEPTH_SOURCES)[number];
/**
 * One segment's depth on one frame (rig-c/pose#281): `ratio` its drawn length ÷
 * its rest length; `sign` +1 when its distal joint is nearer the camera than its
 * proximal one, −1 farther, 0 flat (or not decided); `source` as above.
 */
export interface SegmentDepth {
  ratio: number;
  sign: -1 | 0 | 1;
  source: DepthSource;
}
export type FrameDepth = Partial<Record<DepthSegment, SegmentDepth>>;
/** The gait `clean --depth` was told the clip is (rig-c/pose#336): the signs are the same for both; it decides the joint `--draw-order depth` orders the legs by. */
export const DEPTH_GAITS = ['walk', 'run'] as const;
export type DepthGait = (typeof DEPTH_GAITS)[number];
/**
 * Where a sequence's `pelvisTilt` came from (rig-c/pose#288): `silhouette` — the
 * straight edge of the drawn figure across the hips; `waistband` — the top edge
 * of a garment covering them; `below-cover` — the cues under a garment hanging
 * over the waistband (rig-c/pose#342); `keys` — a hand file (`--pelvis-keys`).
 */
export const PELVIS_SOURCES = ['silhouette', 'waistband', 'below-cover', 'keys'] as const;
export type PelvisSource = (typeof PELVIS_SOURCES)[number];
export const POSE_SPACE = { units: 'picture-px', origin: 'top-left', y: 'down' } as const;
/**
 * `inferred` (rig-c/pose#63): a position the detector supplied but did not see
 * — it carries `at` like `observed`, and retarget keys it the same; what it
 * changes is what a reading may claim from it (POSTURE does not read a hip tilt
 * off inferred hips).
 */
const STATES = ['observed', 'occluded', 'missing', 'inferred'] as const;
export type JointState = (typeof STATES)[number];

export interface Joint {
  state: JointState;
  at?: [number, number];
  score?: number;
}
export interface Person {
  id: string;
  joints: Partial<Record<Body18, Joint>>;
}
export interface PoseFrame {
  t: number;
  people: Person[];
  /**
   * rig-c/pose#288, minor 1.1: the pelvis line on this frame, read off the picture —
   * Spine degrees (counter-clockwise, y up) of the direction from the figure's
   * right hip to its left hip, the angle `pictureAngle(r_hip, l_hip)` gives the
   * hip keypoints (about 0 for a figure facing the camera, about ±180 facing
   * away); null where the reading declined the frame. Present on every frame of
   * a sequence with a `pelvisSource`, on none of one without.
   */
  pelvisTilt?: number | null;
  /**
   * rig-c/pose#281, minor 1.2: each limb segment's depth on this frame (a segment
   * whose joints are not both placed on the frame is not named). Present on every
   * frame of a sequence with depth, on none of one without.
   */
  depth?: FrameDepth;
}
/**
 * The picture's camera on one frame against frame 0's (rig-c/pose#63), as
 * `tools/scan.py` reads it off the background: a point p₀ of frame 0's picture
 * appears at `s · p₀ + (tx, ty)` on this frame. The joints of a sequence that
 * carries a camera are already normalised by it, `p′ = (p − t) / s`. `inliers`
 * is the number of background features the fit kept.
 */
export interface CameraFrame {
  s: number;
  tx: number;
  ty: number;
  inliers: number;
}
/**
 * The record `rig-pose clean` writes into the sequence it cleaned (#67), and
 * the one thing `retarget` requires of a sequence: the step is the record, not
 * a fixed amount of smoothing (windows of 1 are a cleaned sequence too).
 */
export const CLEAN_SPEC = 'rig-pose-clean/1';
export interface CleanSpike {
  frame: number;
  joint: Body18;
}
/**
 * Who said the hips are `inferred` (#63): `declared` — the person running
 * `rig-pose clean --hips-inferred` said so; `measured` (#86) — a tool read the
 * pelvis line off the picture (`tools/pelvis.py`, after clean) and turned the
 * hip pair to a measured angle on every frame. The exact shape:
 *
 *   { by: "measured", method: string, fit?: { frames, gain, corr },
 *     read: Run[], interpolated: Run[], scaled?: Run[], held: Run[], unmeasured?: Run[],
 *     declined: Array<{ frames: Run, why: string }> }      Run = [first, last]
 *
 * `method` names the reading. Runs are integer frame indices inside the
 * sequence, first ≤ last, increasing and not overlapping within each list.
 * Every frame of the sequence is in exactly one of `read` (the frame's own
 * reading), `interpolated` (a declined frame between two reads close in time,
 * the angle interpolated), `scaled` (#106: a longer declined run taking the
 * detector hip line scaled by `fit.gain`), `held` (the earlier read carried to
 * the end of its run; at the clip's start, the later read) and `unmeasured`
 * (#106: a longer declined run when `fit.corr` < 0.9). `declined` lists, with
 * the reason, exactly the non-read frames. Anything else is refused by name
 * (POSE_CLEANED).
 */
export type Run = [number, number];
export interface PelvisFit {
  frames: number;
  gain: number | null;
  corr: number | null;
}
export type HipsInferred =
  | { by: 'declared' }
  | {
      by: 'measured';
      method: string;
      fit?: PelvisFit;
      read: Run[];
      interpolated: Run[];
      scaled?: Run[];
      held: Run[];
      unmeasured?: Run[];
      declined: Array<{ frames: Run; why: string }>;
    };

/** A copy of the record, in the writer's key order. */
export function copyHipsInferred(h: HipsInferred): HipsInferred {
  const runs = (rs: Run[]): Run[] => rs.map(([a, b]) => [a, b]);
  if (h.by === 'declared') return { by: 'declared' };
  return {
    by: 'measured',
    method: h.method,
    ...(h.fit !== undefined ? { fit: { frames: h.fit.frames, gain: h.fit.gain, corr: h.fit.corr } } : {}),
    read: runs(h.read),
    interpolated: runs(h.interpolated),
    ...(h.scaled !== undefined ? { scaled: runs(h.scaled) } : {}),
    held: runs(h.held),
    ...(h.unmeasured !== undefined ? { unmeasured: runs(h.unmeasured) } : {}),
    declined: h.declined.map((d) => ({ frames: [d.frames[0], d.frames[1]], why: d.why })),
  };
}

/** The frames a `measured` record gives an angle on (read, interpolated, scaled, held), as a set; null for any other record or none. */
export function measuredFrames(h: HipsInferred | undefined): Set<number> | null {
  if (h === undefined || h.by !== 'measured') return null;
  const out = new Set<number>();
  for (const rs of [h.read, h.interpolated, h.scaled ?? [], h.held]) for (const [a, b] of rs) for (let f = a; f <= b; f++) out.add(f);
  return out;
}

/** The stillness hold's figures (#91): speed in trunk lengths per frame, reach in trunk lengths, the shortest hold in seconds, the blend in frames. */
export interface HoldParams {
  speed: number;
  reach: number;
  minSeconds: number;
  blend: number;
}
/**
 * One stillness hold of one joint: its frames (inclusive), and the joint's
 * jitter inside them before and after, px/f². `after` is 0 on a hold held at
 * its median throughout; on a hold that carries a seam's cross-fade it is the
 * ramp's own curvature, expected and not noise (the lines print "ramp").
 */
export interface CleanHold {
  joint: Body18;
  frames: [number, number];
  excursion?: [number, number];
  jitter: { before: number | null; after: number | null };
}
/**
 * A run of frames (`frames`, inside a region the holds cover) on which a joint
 * has a position and no hold, with the test it fails there: `speed` (its
 * largest median speed, trunk lengths a frame; null where its speed is not
 * known on some frame), `reach` (its largest distance from its median over the
 * run, trunk lengths), `short` (it passes both and the run lasts under the
 * minimum; the figure is its seconds), or `span` (it passes all three and its
 * spans broke elsewhere; the figure is its reach).
 */
/** Two holds of one joint meeting (back to back, or a gap of under 6 frames): the second's first frame, the step between their medians in trunk lengths, and the gap in frames (cross-faded). */
export interface CleanSeam {
  joint: Body18;
  frame: number;
  step: number;
  gap: number;
}
export interface CleanUnheld {
  joint: Body18;
  frames: [number, number];
  test: 'speed' | 'reach' | 'short' | 'span';
  value: number | null;
}
/** rig-c/pose#288: clean smoothed the sequence's `pelvisTilt` as its own track, over the legs' window (`loop` as the record's). */
export interface PelvisParams {
  window: number;
}
/** rig-c/pose#281: clean derived each frame's `depth` (`source: "derived"`) for this gait. */
export interface DepthParams {
  gait: DepthGait;
}
export interface CleanRecord {
  spec: typeof CLEAN_SPEC;
  /**
   * `hipsInferred` is present only when clean marked the hips (`--hips-inferred`).
   * `hold` (#91): the stillness hold's figures, or "off"; absent in a record
   * written before #91.
   */
  params: { loop: boolean; legs: number; rest: number; hipsInferred?: HipsInferred; hold?: HoldParams | 'off'; pelvis?: PelvisParams; depth?: DepthParams };
  /**
   * `found`: every joint the spike step replaced, by frame (index into `frames`)
   * and joint. `untested`: the frames the spike step did not test, because a
   * clip end cuts their window (none under `loop`).
   */
  spikes: { found: CleanSpike[]; untested: number[] };
  /** Mean |second difference| of y, px/f², before and after; null where no joint has three consecutive positions. */
  jitter: { before: number | null; after: number | null };
  /** The stillness holds (#91), per joint; present, with `unheld`, exactly when `params.hold` is an object. */
  holds?: CleanHold[];
  unheld?: CleanUnheld[];
  seams?: CleanSeam[];
}
export interface PoseSequence {
  spec: typeof POSE_SPEC;
  space: typeof POSE_SPACE;
  width: number;
  height: number;
  source: string;
  /** Optional, only with `camera`: where it came from — "tracked", "hand-labelled, N keys" (#63), or "hand windows, floor-snapped: …" (#82). */
  cameraSource?: string;
  /** Optional: one per frame, when a scan read the camera (#63). */
  camera?: CameraFrame[];
  /** Present once `rig-pose clean` has run on the sequence (#67). */
  cleaned?: CleanRecord;
  /**
   * Optional (rig-c/pose#92): the clip's frame of reference. "in-place" — a
   * gait filmed without the figure travelling (a treadmill or reel walk, a
   * loop) — is the one value; `clean --loop` writes it, and it may be written
   * by hand. Absent: the figure's travel in the picture is its travel.
   */
  travel?: Travel;
  /** rig-c/pose#288, minor 1.1: where every frame's `pelvisTilt` came from; present exactly when the frames carry it. */
  pelvisSource?: PelvisSource;
  frames: PoseFrame[];
}

/** The one value of a sequence's `travel` (rig-c/pose#92). */
export const TRAVEL_IN_PLACE = 'in-place';
export type Travel = typeof TRAVEL_IN_PLACE;

const TOP_KEYS = ['spec', 'space', 'width', 'height', 'source', 'frames'];
const OPTIONAL_KEYS = ['cameraSource', 'camera', 'cleaned', 'travel'];
const CAMERA_KEYS = ['s', 'tx', 'ty', 'inliers'];

/**
 * The older name the same file went by: `rig-c-pose-frames/0`, written by the
 * extraction jobs this package's own demos were made from. It is this format
 * under another spec string, with `space.units` "painting-px" and an `fps` key
 * (the time is in each frame's `t`, which wins). It is read as it is; nothing
 * else about it differs.
 */
export const POSE_SPEC_FRAMES0 = 'rig-c-pose-frames/0';
const FRAMES0_SPACE = { units: 'painting-px', origin: 'top-left', y: 'down' } as const;

/** Read and check a pose sequence; every problem is collected and thrown once. */
export function readPoseSequence(text: string, where: string): PoseSequence {
  const doc = parseJson(text, where, 'POSE_JSON');
  const p = new Problems();
  if (!isObject(doc)) {
    p.add('POSE_SHAPE', `${where} is ${typeName(doc)}; a ${POSE_SPEC} document is an object`);
    p.throwIfAny();
    throw new Error('unreachable');
  }
  const frames0 = doc.spec === POSE_SPEC_FRAMES0;
  // rig-c/pose#288: the minor the file says it was written as; a newer one is read, and what it adds is refused naming it.
  const minor = frames0 ? 0 : minorOf(doc.spec);
  const note = minor !== null && minor > POSE_MINOR ? `; the file says it was written as ${JSON.stringify(doc.spec)}, a newer minor than this reader's "${POSE_SPEC_DEPTH}" — read it with a rig-pose that reads that minor` : '';
  const pelvisKnown = minor !== null && minor >= 1;
  // rig-c/pose#281: depth is minor 2's.
  const depthKnown = minor !== null && minor >= 2;
  /** A key of a later minor in a file that says an earlier one: one line naming the minor, not an unknown key. */
  const minorKey = (key: string, on: string) => (key === 'depth'
    ? p.add('POSE_SPEC', `${on} carries "depth", a key of "${POSE_SPEC_DEPTH}", and the file says ${JSON.stringify(doc.spec)}; a sequence carrying depth is written as "${POSE_SPEC_DEPTH}" (rig-pose clean --depth)`)
    : p.add('POSE_SPEC', `${on} carries ${JSON.stringify(key)}, a key of "${POSE_SPEC_PELVIS}", and the file says ${JSON.stringify(doc.spec)}; a sequence carrying the pelvis track is written as "${POSE_SPEC_PELVIS}" (rig-pose pelvis)`));
  const without = (o: Record<string, unknown>, key: string) => (pelvisKnown || !(key in o) ? o : Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)));
  const withoutDepth = (o: Record<string, unknown>) => (depthKnown || !('depth' in o) ? o : Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'depth')));
  if (!pelvisKnown && 'pelvisSource' in doc) minorKey('pelvisSource', where);
  refuseUnknownKeys(p, 'POSE_KEYS', where, without(doc, 'pelvisSource'), frames0 ? [...TOP_KEYS, ...OPTIONAL_KEYS, 'fps'] : [...TOP_KEYS, ...OPTIONAL_KEYS, ...(pelvisKnown ? ['pelvisSource'] : [])], note);
  for (const k of TOP_KEYS) if (!(k in doc)) p.add('POSE_KEYS', `${where} has no "${k}"; a ${POSE_SPEC} document carries ${TOP_KEYS.join(', ')}`);
  if ('spec' in doc && minor === null) p.add('POSE_SPEC', `${where} "spec" is ${typeName(doc.spec)}; this reader reads "${POSE_SPEC}" and its minors ("${POSE_SPEC_PELVIS}", "${POSE_SPEC_DEPTH}"; a newer minor is read, and a key it adds is refused naming it), and the older name "${POSE_SPEC_FRAMES0}"`);
  const space = frames0 ? FRAMES0_SPACE : POSE_SPACE;
  if ('space' in doc && JSON.stringify(doc.space) !== JSON.stringify(space)) {
    p.add('POSE_SPACE', `${where} "space" is ${JSON.stringify(doc.space)}; for "${frames0 ? POSE_SPEC_FRAMES0 : POSE_SPEC}" it must be exactly ${JSON.stringify(space)}`);
  }
  if (frames0 && 'fps' in doc && !(typeof doc.fps === 'number' && Number.isFinite(doc.fps) && doc.fps > 0)) p.add('POSE_FPS', `${where} "fps" is ${typeName(doc.fps)}; it must be a positive number (each frame's "t" is the time read)`);
  for (const k of ['width', 'height'] as const) {
    if (k in doc && !(Number.isInteger(doc[k]) && (doc[k] as number) > 0)) p.add('POSE_SIZE', `${where} "${k}" is ${typeName(doc[k])}; it must be a positive integer (picture pixels)`);
  }
  if ('source' in doc && (typeof doc.source !== 'string' || doc.source.trim() === '')) p.add('POSE_SOURCE', `${where} "source" is ${typeName(doc.source)}; it must say what produced the file`);
  const frames: PoseFrame[] = [];
  if ('frames' in doc) {
    if (!Array.isArray(doc.frames) || doc.frames.length === 0) {
      p.add('POSE_FRAMES', `${where} "frames" is ${typeName(doc.frames)}; it must be a non-empty array`);
    } else {
      let lastT = -Infinity;
      const minorFrames: number[] = [];
      const depthFrames: number[] = [];
      doc.frames.forEach((f: unknown, i: number) => {
        const fw = `${where} frames[${i}]`;
        if (!isObject(f)) {
          p.add('POSE_FRAME_SHAPE', `${fw} is ${typeName(f)}; a frame is { t, people }`);
          return;
        }
        if (!pelvisKnown && 'pelvisTilt' in f) minorFrames.push(i);
        if (!depthKnown && 'depth' in f) depthFrames.push(i);
        refuseUnknownKeys(p, 'POSE_KEYS', fw, withoutDepth(without(f, 'pelvisTilt')), [...(pelvisKnown ? ['t', 'people', 'pelvisTilt'] : ['t', 'people']), ...(depthKnown ? ['depth'] : [])], note);
        const depth = depthKnown && 'depth' in f ? readDepth(p, fw, f.depth) : undefined;
        let pelvisTilt: number | null | undefined;
        if (pelvisKnown && 'pelvisTilt' in f) {
          const v = f.pelvisTilt;
          if (v === null || (typeof v === 'number' && Number.isFinite(v) && v > -180 && v <= 180)) pelvisTilt = v;
          else p.add('POSE_PELVIS', `${fw} "pelvisTilt" is ${typeName(v)}; it must be Spine degrees in (-180, 180] (the direction r_hip → l_hip, counter-clockwise, y up), or null where the reading declined the frame`);
        }
        const t = f.t;
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
          p.add('POSE_TIME', `${fw} "t" is ${typeName(t)}; it must be a finite number of seconds ≥ 0`);
        } else if (t <= lastT) {
          p.add('POSE_TIME', `${fw} "t" is ${t}s, not after frame ${i - 1}'s ${lastT}s; times must strictly increase`);
        }
        if (typeof t === 'number' && Number.isFinite(t)) lastT = Math.max(lastT, t);
        const people: Person[] = [];
        if (!Array.isArray(f.people)) {
          p.add('POSE_PEOPLE', `${fw} "people" is ${typeName(f.people)}; it must be an array (empty when nobody was found)`);
        } else {
          const ids = new Set<string>();
          f.people.forEach((person: unknown, j: number) => {
            const pw = `${fw} people[${j}]`;
            if (!isObject(person)) {
              p.add('POSE_PERSON_SHAPE', `${pw} is ${typeName(person)}; a person is { id, joints }`);
              return;
            }
            refuseUnknownKeys(p, 'POSE_KEYS', pw, person, ['id', 'joints'], note);
            if (typeof person.id !== 'string' || person.id === '') {
              p.add('POSE_PERSON_ID', `${pw} "id" is ${typeName(person.id)}; it must be a non-empty string`);
              return;
            }
            if (ids.has(person.id)) p.add('POSE_PERSON_ID', `${pw} "id" "${person.id}" appears twice in frame ${i}`);
            ids.add(person.id);
            people.push({ id: person.id, joints: readJoints(p, pw, person.joints, note) });
          });
        }
        frames.push({ t: typeof t === 'number' ? t : NaN, people, ...(pelvisTilt !== undefined ? { pelvisTilt } : {}), ...(depth !== undefined ? { depth } : {}) });
      });
      const framesText = (fs: number[]) => `${where} ${fs.length === 1 ? `frames[${fs[0]}]` : `${fs.length} frames (${fs[0]}–${fs[fs.length - 1]})`}`;
      if (minorFrames.length > 0) minorKey('pelvisTilt', framesText(minorFrames));
      if (depthFrames.length > 0) minorKey('depth', framesText(depthFrames));
    }
  }
  let pelvisSource: PelvisSource | undefined;
  if (pelvisKnown && 'pelvisSource' in doc) {
    if (typeof doc.pelvisSource === 'string' && (PELVIS_SOURCES as readonly string[]).includes(doc.pelvisSource)) pelvisSource = doc.pelvisSource as PelvisSource;
    else p.add('POSE_PELVIS', `${where} "pelvisSource" is ${typeName(doc.pelvisSource)}; it must be one of ${PELVIS_SOURCES.map((x) => `"${x}"`).join(', ')} (where every frame's "pelvisTilt" came from)`);
  }
  if (pelvisKnown && Array.isArray(doc.frames)) {
    const carry = doc.frames.map((f: unknown) => isObject(f) && 'pelvisTilt' in f);
    const lacking = carry.flatMap((c: boolean, i: number) => (c ? [] : [i]));
    if ('pelvisSource' in doc && lacking.length > 0) p.add('POSE_PELVIS', `${where} has "pelvisSource" and frame(s) ${spansText(lacking)} carry no "pelvisTilt"; with a pelvis track every frame carries one (null where the reading declined it)`);
    if (!('pelvisSource' in doc) && lacking.length < carry.length) p.add('POSE_PELVIS', `${where} has "pelvisTilt" on ${carry.length - lacking.length} frame(s) and no "pelvisSource"; a pelvis track says where it came from (${PELVIS_SOURCES.join(', ')})`);
    if ('pelvisSource' in doc) {
      const ids = [...new Set(frames.flatMap((f) => f.people.map((q) => q.id)))].sort();
      if (ids.length > 1) p.add('POSE_PELVIS', `${where} carries a pelvis track and ${ids.length} people (${ids.join(', ')}); the track is one figure's, so the sequence holds one person (rig-pose pelvis --person writes only that one)`);
    }
  }
  if (depthKnown && Array.isArray(doc.frames)) {
    const carry = doc.frames.map((f: unknown) => isObject(f) && 'depth' in f);
    const lacking = carry.flatMap((c: boolean, i: number) => (c ? [] : [i]));
    if (lacking.length > 0 && lacking.length < carry.length) p.add('POSE_DEPTH', `${where} has "depth" on ${carry.length - lacking.length} frame(s) and none on frame(s) ${spansText(lacking)}; a sequence with depth carries it on every frame (an empty object where no segment is placed)`);
    if (lacking.length < carry.length) {
      const ids = [...new Set(frames.flatMap((f) => f.people.map((q) => q.id)))].sort();
      if (ids.length > 1) p.add('POSE_DEPTH', `${where} carries depth and ${ids.length} people (${ids.join(', ')}); the depth is one figure's, so the sequence holds one person (rig-pose clean writes only the one it cleaned)`);
    }
  }
  const camera = 'camera' in doc ? readCamera(p, where, doc.camera, Array.isArray(doc.frames) ? doc.frames.length : null, note) : undefined;
  if ('cameraSource' in doc) {
    if (typeof doc.cameraSource !== 'string' || doc.cameraSource.trim() === '') p.add('POSE_CAMERA_SOURCE', `${where} "cameraSource" is ${typeName(doc.cameraSource)}; it must be a non-empty string saying where the camera came from ("tracked", "hand-labelled, N keys")`);
    else if (!('camera' in doc)) p.add('POSE_CAMERA_SOURCE', `${where} has "cameraSource" ${JSON.stringify(doc.cameraSource)} and no "camera"; it states where a camera came from, so it needs one`);
  }
  if ('travel' in doc && doc.travel !== TRAVEL_IN_PLACE) p.add('POSE_TRAVEL', `${where} "travel" is ${typeName(doc.travel)}; the one value is "${TRAVEL_IN_PLACE}" (a gait filmed without the figure travelling), and without the key the picture's travel is the figure's`);
  const cleaned = 'cleaned' in doc ? readCleaned(p, where, doc.cleaned, Array.isArray(doc.frames) ? doc.frames.length : null, pelvisKnown, note, depthKnown) : undefined;
  if (depthKnown) {
    // rig-c/pose#281: "derived" depth is clean's, and clean records the gait it read it for; "measured" is a 3D detector's.
    const sources = new Set(frames.flatMap((f) => Object.values(f.depth ?? {}).map((d) => d.source)));
    const recorded = isObject(doc.cleaned) && isObject(doc.cleaned.params) && 'depth' in doc.cleaned.params;
    if (sources.size > 1) p.add('POSE_DEPTH', `${where} carries "derived" and "measured" depth together; a sequence's depth comes from one source — clean --depth derives it, a 3D detector measures it`);
    else if (sources.has('derived') && !recorded) p.add('POSE_DEPTH', `${where} carries "derived" depth and ${'cleaned' in doc ? 'its "cleaned" record has no "params" "depth"' : 'no "cleaned" record'}; derived depth is written by rig-pose clean --depth walk|run, which records the gait it was read for`);
    if (recorded && cleaned !== undefined && frames.some((f) => f.depth === undefined || Object.values(f.depth).some((d) => d.source !== 'derived'))) p.add('POSE_DEPTH', `${where} "cleaned" "params" has "depth" and the frames do not all carry derived depth; the record says clean derived it on every frame`);
  }
  if (cleaned !== undefined && pelvisKnown) {
    const hasPelvis = isObject(doc.cleaned) && isObject(doc.cleaned.params) && 'pelvis' in doc.cleaned.params;
    if ('pelvisSource' in doc && !hasPelvis) p.add('POSE_PELVIS', `${where} carries a pelvis track and its "cleaned" record has no "params" "pelvis"; clean smooths the track and records it, so the track was added after clean — run rig-pose pelvis before rig-pose clean`);
    if (!('pelvisSource' in doc) && hasPelvis) p.add('POSE_PELVIS', `${where} "cleaned" "params" has "pelvis" and the sequence no "pelvisSource"; the record says clean smoothed a pelvis track the frames do not carry`);
  }
  p.throwIfAny();
  const cameraSource = typeof doc.cameraSource === 'string' ? doc.cameraSource : undefined;
  return { spec: POSE_SPEC, space: POSE_SPACE, width: doc.width as number, height: doc.height as number, source: doc.source as string, ...(cameraSource !== undefined ? { cameraSource } : {}), ...(camera !== undefined ? { camera } : {}), ...(cleaned !== undefined ? { cleaned } : {}), ...(doc.travel === TRAVEL_IN_PLACE ? { travel: TRAVEL_IN_PLACE } : {}), ...(pelvisSource !== undefined ? { pelvisSource } : {}), frames };
}

/** rig-c/pose#281: a frame's `depth` — `{ "<segment>": { ratio, sign, source } }`, every part refused by name. */
function readDepth(p: Problems, fw: string, d: unknown): FrameDepth | undefined {
  const dw = `${fw} "depth"`;
  if (!isObject(d)) {
    p.add('POSE_DEPTH', `${dw} is ${typeName(d)}; it must be an object keyed by limb segment (${DEPTH_SEGMENT_NAMES.join(', ')}), each { ratio, sign, source }`);
    return undefined;
  }
  const out: FrameDepth = {};
  for (const [name, v] of Object.entries(d)) {
    const sw = `${dw} "${name}"`;
    if (!(DEPTH_SEGMENT_NAMES as readonly string[]).includes(name)) {
      p.add('POSE_DEPTH', `${dw} names ${JSON.stringify(name)}; the segments are ${DEPTH_SEGMENT_NAMES.join(', ')}`);
      continue;
    }
    if (!isObject(v)) {
      p.add('POSE_DEPTH', `${sw} is ${typeName(v)}; it must be { ratio, sign, source }`);
      continue;
    }
    refuseUnknownKeys(p, 'POSE_DEPTH', sw, v, ['ratio', 'sign', 'source']);
    let ok = true;
    for (const k of ['ratio', 'sign', 'source']) if (!(k in v)) {
      p.add('POSE_DEPTH', `${sw} has no "${k}"; a segment's depth is { ratio, sign, source }`);
      ok = false;
    }
    if ('ratio' in v && !(typeof v.ratio === 'number' && Number.isFinite(v.ratio) && v.ratio >= 0)) {
      p.add('POSE_DEPTH', `${sw} "ratio" is ${typeName(v.ratio)}; it must be a finite number ≥ 0 (the segment's drawn length ÷ its rest length)`);
      ok = false;
    }
    if ('sign' in v && v.sign !== -1 && v.sign !== 0 && v.sign !== 1) {
      p.add('POSE_DEPTH', `${sw} "sign" is ${typeName(v.sign)}; it must be 1 (the distal joint nearer the camera), -1 (farther) or 0 (flat, or not decided)`);
      ok = false;
    }
    if ('source' in v && !(typeof v.source === 'string' && (DEPTH_SOURCES as readonly string[]).includes(v.source))) {
      p.add('POSE_DEPTH', `${sw} "source" is ${typeName(v.source)}; it must be "derived" (clean --depth, from the picture's lengths) or "measured" (a 3D detector)`);
      ok = false;
    }
    if (ok) out[name as DepthSegment] = { ratio: v.ratio as number, sign: v.sign as -1 | 0 | 1, source: v.source as DepthSource };
  }
  return out;
}

/** The minor a sequence's spec names: 0 for "rig-pose-sequence/1", N for "rig-pose-sequence/1.N"; null for anything else. */
function minorOf(spec: unknown): number | null {
  if (spec === POSE_SPEC) return 0;
  const m = typeof spec === 'string' ? /^rig-pose-sequence\/1\.([1-9]\d{0,5})$/.exec(spec) : null;
  return m === null ? null : Number(m[1]);
}

/** Frame indices as runs: "3, 5–9". */
function spansText(fs: readonly number[]): string {
  const out: Array<[number, number]> = [];
  for (const f of fs) {
    const last = out[out.length - 1];
    if (last !== undefined && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/** `camera`: one `{ s > 0, tx, ty, inliers ≥ 0 }` per frame, as many as `frames`. */
function readCamera(p: Problems, where: string, camera: unknown, frames: number | null, note: string): CameraFrame[] {
  const out: CameraFrame[] = [];
  if (!Array.isArray(camera)) {
    p.add('POSE_CAMERA', `${where} "camera" is ${typeName(camera)}; it must be an array with one { s, tx, ty, inliers } per frame`);
    return out;
  }
  if (frames !== null && camera.length !== frames) p.add('POSE_CAMERA', `${where} "camera" has ${camera.length} entr${camera.length === 1 ? 'y' : 'ies'} and "frames" ${frames}; it must have one per frame`);
  camera.forEach((c: unknown, i: number) => {
    const cw = `${where} camera[${i}]`;
    if (!isObject(c)) {
      p.add('POSE_CAMERA', `${cw} is ${typeName(c)}; a camera entry is { s, tx, ty, inliers }`);
      return;
    }
    refuseUnknownKeys(p, 'POSE_CAMERA', cw, c, CAMERA_KEYS, note);
    let ok = true;
    for (const k of CAMERA_KEYS) if (!(k in c)) {
      p.add('POSE_CAMERA', `${cw} has no "${k}"; a camera entry carries ${CAMERA_KEYS.join(', ')}`);
      ok = false;
    }
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if ('s' in c && !(finite(c.s) && c.s > 0)) {
      p.add('POSE_CAMERA', `${cw} "s" is ${typeName(c.s)}; the scale must be a finite number > 0`);
      ok = false;
    }
    for (const k of ['tx', 'ty'] as const) if (k in c && !finite(c[k])) {
      p.add('POSE_CAMERA', `${cw} "${k}" is ${typeName(c[k])}; it must be a finite number of picture px`);
      ok = false;
    }
    if ('inliers' in c && !(Number.isInteger(c.inliers) && (c.inliers as number) >= 0)) {
      p.add('POSE_CAMERA', `${cw} "inliers" is ${typeName(c.inliers)}; it must be an integer ≥ 0`);
      ok = false;
    }
    if (ok) out.push({ s: c.s as number, tx: c.tx as number, ty: c.ty as number, inliers: c.inliers as number });
  });
  return out;
}

/** `cleaned`: { spec, params: { loop, legs, rest, hipsInferred?, hold? }, spikes: { found: [{ frame, joint }], untested: [frame] }, jitter: { before, after }, holds?, unheld?, seams? }. */
function readCleaned(p: Problems, where: string, c: unknown, frames: number | null, pelvisKnown: boolean, note: string, depthKnown: boolean): CleanRecord | undefined {
  const refuseUnknownKeys = (q: Problems, code: string, w: string, o: Record<string, unknown>, known: readonly string[]) => refuseKeys(q, code, w, o, known, note);
  const cw = `${where} "cleaned"`;
  const shape = '{ spec, params: { loop, legs, rest, hipsInferred?, hold? }, spikes: { found: [{ frame, joint }], untested: [frame] }, jitter: { before, after }, holds?, unheld?, seams? }';
  if (!isObject(c)) {
    p.add('POSE_CLEANED', `${cw} is ${typeName(c)}; it is the record rig-pose clean writes, ${shape}`);
    return undefined;
  }
  const before = p.list.length;
  refuseUnknownKeys(p, 'POSE_CLEANED', cw, c, ['spec', 'params', 'spikes', 'jitter', 'holds', 'unheld', 'seams']);
  for (const k of ['spec', 'params', 'spikes', 'jitter']) if (!(k in c)) p.add('POSE_CLEANED', `${cw} has no "${k}"; the record is ${shape}`);
  if ('spec' in c && c.spec !== CLEAN_SPEC) p.add('POSE_CLEANED', `${cw} "spec" is ${typeName(c.spec)}; this reader reads "${CLEAN_SPEC}"`);
  const window = (v: unknown) => Number.isInteger(v) && (v === 1 || ((v as number) >= 5 && (v as number) % 2 === 1));
  if ('params' in c) {
    const q = c.params;
    if (!isObject(q)) p.add('POSE_CLEANED', `${cw} "params" is ${typeName(q)}; it must be { loop, legs, rest, hipsInferred?, hold? }`);
    else {
      refuseUnknownKeys(p, 'POSE_CLEANED', `${cw} "params"`, q, ['loop', 'legs', 'rest', 'hipsInferred', 'hold', ...(pelvisKnown ? ['pelvis'] : []), ...(depthKnown ? ['depth'] : [])]);
      if (depthKnown && 'depth' in q) {
        const v = q.depth;
        const vw = `${cw} "params" "depth"`;
        if (!isObject(v)) p.add('POSE_CLEANED', `${vw} is ${typeName(v)}; it must be { gait } (rig-c/pose#281: the gait clean --depth read the depth for)`);
        else {
          refuseUnknownKeys(p, 'POSE_CLEANED', vw, v, ['gait']);
          if (!(typeof v.gait === 'string' && (DEPTH_GAITS as readonly string[]).includes(v.gait))) p.add('POSE_CLEANED', `${vw} "gait" is ${typeName(v.gait)}; it must be ${DEPTH_GAITS.map((g) => `"${g}"`).join(' or ')}`);
        }
      }
      if (pelvisKnown && 'pelvis' in q) {
        const v = q.pelvis;
        const vw = `${cw} "params" "pelvis"`;
        if (!isObject(v)) p.add('POSE_CLEANED', `${vw} is ${typeName(v)}; it must be { window } (rig-c/pose#288: the window clean smoothed the pelvis track over)`);
        else {
          refuseUnknownKeys(p, 'POSE_CLEANED', vw, v, ['window']);
          if (!window(v.window)) p.add('POSE_CLEANED', `${vw} "window" is ${typeName(v.window)}; it must be 1 (none) or an odd whole number ≥ 5`);
        }
      }
      if ('hold' in q) {
        const h = q.hold;
        const hw = `${cw} "params" "hold"`;
        if (h === 'off') {
          for (const k of ['holds', 'unheld', 'seams']) if (k in c) p.add('POSE_CLEANED', `${cw} has "${k}" with "params" "hold" "off"; a record lists holds only when the hold ran`);
        } else if (!isObject(h)) p.add('POSE_CLEANED', `${hw} is ${typeName(h)}; it must be "off" or { speed, reach, minSeconds, blend }`);
        else {
          refuseUnknownKeys(p, 'POSE_CLEANED', hw, h, ['speed', 'reach', 'minSeconds', 'blend']);
          for (const k of ['speed', 'reach', 'minSeconds'] as const) if (!(typeof h[k] === 'number' && Number.isFinite(h[k]) && h[k] > 0)) p.add('POSE_CLEANED', `${hw} "${k}" is ${typeName(h[k])}; it must be a number > 0 (${k === 'minSeconds' ? 'seconds' : k === 'speed' ? 'trunk lengths per frame' : 'trunk lengths'})`);
          if (!(Number.isInteger(h.blend) && (h.blend as number) >= 0)) p.add('POSE_CLEANED', `${hw} "blend" is ${typeName(h.blend)}; it must be a whole number of frames ≥ 0`);
          for (const k of ['holds', 'unheld', 'seams']) if (!(k in c)) p.add('POSE_CLEANED', `${cw} has "params" "hold" and no "${k}"; a record whose hold ran lists its holds, the joints it did not hold and its seams (an empty array when none)`);
        }
      } else for (const k of ['holds', 'unheld', 'seams']) if (k in c) p.add('POSE_CLEANED', `${cw} has "${k}" and no "params" "hold"; the holds' figures are recorded in "params" "hold"`);
      if ('hipsInferred' in q) readHipsInferred(p, `${cw} "params" "hipsInferred"`, q.hipsInferred, frames, note);
      if (typeof q.loop !== 'boolean') p.add('POSE_CLEANED', `${cw} "params" "loop" is ${typeName(q.loop)}; it must be true or false`);
      for (const k of ['legs', 'rest'] as const) if (!window(q[k])) p.add('POSE_CLEANED', `${cw} "params" "${k}" is ${typeName(q[k])}; it must be 1 (none) or an odd whole number ≥ 5`);
    }
  }
  const frameOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (frames === null || (v as number) < frames);
  const frameRange = `[0, ${frames === null ? 'the frame count' : frames - 1}]`;
  if ('spikes' in c) {
    const k = c.spikes;
    if (!isObject(k)) p.add('POSE_CLEANED', `${cw} "spikes" is ${typeName(k)}; it must be { found: [{ frame, joint }], untested: [frame] }`);
    else {
      refuseUnknownKeys(p, 'POSE_CLEANED', `${cw} "spikes"`, k, ['found', 'untested']);
      if (!Array.isArray(k.found)) p.add('POSE_CLEANED', `${cw} "spikes" "found" is ${typeName(k.found)}; it must be an array of { frame, joint }`);
      else k.found.forEach((s: unknown, i: number) => {
        const sw = `${cw} spikes.found[${i}]`;
        if (!isObject(s)) {
          p.add('POSE_CLEANED', `${sw} is ${typeName(s)}; a spike is { frame, joint }`);
          return;
        }
        refuseUnknownKeys(p, 'POSE_CLEANED', sw, s, ['frame', 'joint']);
        if (!frameOk(s.frame)) p.add('POSE_CLEANED', `${sw} "frame" is ${typeName(s.frame)}; it must be a frame index in ${frameRange}`);
        if (typeof s.joint !== 'string' || !isBody18(s.joint)) p.add('POSE_CLEANED', `${sw} "joint" is ${typeName(s.joint)}; it must be a body-18 joint: ${BODY18.join(', ')}`);
      });
      if (!Array.isArray(k.untested)) p.add('POSE_CLEANED', `${cw} "spikes" "untested" is ${typeName(k.untested)}; it must be an array of frame indices`);
      else k.untested.forEach((f: unknown, i: number) => {
        if (!frameOk(f)) p.add('POSE_CLEANED', `${cw} spikes.untested[${i}] is ${typeName(f)}; it must be a frame index in ${frameRange}`);
      });
    }
  }
  if ('jitter' in c) {
    const j = c.jitter;
    if (!isObject(j)) p.add('POSE_CLEANED', `${cw} "jitter" is ${typeName(j)}; it must be { before, after }`);
    else {
      refuseUnknownKeys(p, 'POSE_CLEANED', `${cw} "jitter"`, j, ['before', 'after']);
      for (const k of ['before', 'after'] as const) {
        const v = j[k];
        if (!(v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0))) p.add('POSE_CLEANED', `${cw} "jitter" "${k}" is ${typeName(v)}; it must be px/f² ≥ 0, or null (not measured)`);
      }
    }
  }
  if ('holds' in c) {
    const hs = c.holds;
    if (!Array.isArray(hs)) p.add('POSE_CLEANED', `${cw} "holds" is ${typeName(hs)}; it must be an array of { joint, frames: [first, last], jitter: { before, after } }`);
    else hs.forEach((h: unknown, i: number) => {
      const hw = `${cw} holds[${i}]`;
      if (!isObject(h)) {
        p.add('POSE_CLEANED', `${hw} is ${typeName(h)}; a hold is { joint, frames: [first, last], jitter: { before, after } }`);
        return;
      }
      refuseUnknownKeys(p, 'POSE_CLEANED', hw, h, ['joint', 'frames', 'excursion', 'jitter']);
      if (typeof h.joint !== 'string' || !isBody18(h.joint)) p.add('POSE_CLEANED', `${hw} "joint" is ${typeName(h.joint)}; it must be a body-18 joint: ${BODY18.join(', ')}`);
      const f = h.frames;
      const fOk = Array.isArray(f) && f.length === 2 && frameOk(f[0]) && frameOk(f[1]) && (f[0] as number) <= (f[1] as number);
      if (!fOk) p.add('POSE_CLEANED', `${hw} "frames" is ${typeName(f)}; it must be [first, last], frame indices in ${frameRange}, first ≤ last`);
      if ('excursion' in h) {
        const ex = h.excursion;
        const exOk = Array.isArray(ex) && ex.length === 2 && frameOk(ex[0]) && frameOk(ex[1]) && (ex[0] as number) <= (ex[1] as number) && (!fOk || ((f[0] as number) < (ex[0] as number) && (ex[1] as number) < (f[1] as number)));
        if (!exOk) p.add('POSE_CLEANED', `${hw} "excursion" is ${typeName(ex)}; it must be [first, last], frame indices strictly inside "frames", first ≤ last`);
      }
      const j = h.jitter;
      if (!isObject(j)) p.add('POSE_CLEANED', `${hw} "jitter" is ${typeName(j)}; it must be { before, after }`);
      else {
        refuseUnknownKeys(p, 'POSE_CLEANED', `${hw} "jitter"`, j, ['before', 'after']);
        for (const k of ['before', 'after'] as const) {
          const v = j[k];
          if (!(v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0))) p.add('POSE_CLEANED', `${hw} "jitter" "${k}" is ${typeName(v)}; it must be px/f² ≥ 0, or null (not measured)`);
        }
      }
    });
  }
  if ('unheld' in c) {
    const us = c.unheld;
    if (!Array.isArray(us)) p.add('POSE_CLEANED', `${cw} "unheld" is ${typeName(us)}; it must be an array of { joint, frames: [first, last], test, value }`);
    else us.forEach((u: unknown, i: number) => {
      const uw = `${cw} unheld[${i}]`;
      if (!isObject(u)) {
        p.add('POSE_CLEANED', `${uw} is ${typeName(u)}; an unheld joint is { joint, frames: [first, last], test, value }`);
        return;
      }
      refuseUnknownKeys(p, 'POSE_CLEANED', uw, u, ['joint', 'frames', 'test', 'value']);
      if (typeof u.joint !== 'string' || !isBody18(u.joint)) p.add('POSE_CLEANED', `${uw} "joint" is ${typeName(u.joint)}; it must be a body-18 joint: ${BODY18.join(', ')}`);
      const f = u.frames;
      if (!(Array.isArray(f) && f.length === 2 && frameOk(f[0]) && frameOk(f[1]) && (f[0] as number) <= (f[1] as number))) p.add('POSE_CLEANED', `${uw} "frames" is ${typeName(f)}; it must be [first, last], frame indices in ${frameRange}, first ≤ last`);
      if (u.test !== 'speed' && u.test !== 'reach' && u.test !== 'short' && u.test !== 'span') p.add('POSE_CLEANED', `${uw} "test" is ${typeName(u.test)}; it must be "speed", "reach", "short" or "span"`);
      const v = u.value;
      const ok = typeof v === 'number' && Number.isFinite(v) && v >= 0;
      if (!(ok || (v === null && u.test === 'speed'))) p.add('POSE_CLEANED', `${uw} "value" is ${typeName(v)}; it must be a figure ≥ 0 (trunk lengths, or seconds for "short"), or null for a speed not known`);
    });
  }
  if ('seams' in c) {
    const ss = c.seams;
    if (!Array.isArray(ss)) p.add('POSE_CLEANED', `${cw} "seams" is ${typeName(ss)}; it must be an array of { joint, frame, step, gap }`);
    else ss.forEach((x: unknown, i: number) => {
      const sw = `${cw} seams[${i}]`;
      if (!isObject(x)) {
        p.add('POSE_CLEANED', `${sw} is ${typeName(x)}; a seam is { joint, frame, step, gap }`);
        return;
      }
      refuseUnknownKeys(p, 'POSE_CLEANED', sw, x, ['joint', 'frame', 'step', 'gap']);
      if (!(Number.isInteger(x.gap) && (x.gap as number) >= 0)) p.add('POSE_CLEANED', `${sw} "gap" is ${typeName(x.gap)}; it must be a whole number of frames ≥ 0`);
      if (typeof x.joint !== 'string' || !isBody18(x.joint)) p.add('POSE_CLEANED', `${sw} "joint" is ${typeName(x.joint)}; it must be a body-18 joint: ${BODY18.join(', ')}`);
      if (!frameOk(x.frame)) p.add('POSE_CLEANED', `${sw} "frame" is ${typeName(x.frame)}; it must be a frame index in ${frameRange}`);
      if (!(typeof x.step === 'number' && Number.isFinite(x.step) && x.step >= 0)) p.add('POSE_CLEANED', `${sw} "step" is ${typeName(x.step)}; it must be trunk lengths ≥ 0`);
    });
  }
  if (p.list.length > before) return undefined;
  const q = c.params as { loop: boolean; legs: number; rest: number; hipsInferred?: HipsInferred; hold?: HoldParams | 'off'; pelvis?: PelvisParams; depth?: DepthParams };
  const j = c.jitter as { before: number | null; after: number | null };
  return {
    spec: CLEAN_SPEC,
    params: { loop: q.loop, legs: q.legs, rest: q.rest, ...(q.hipsInferred !== undefined ? { hipsInferred: copyHipsInferred(q.hipsInferred) } : {}), ...(q.hold !== undefined ? { hold: holdParamsOf(q.hold) } : {}), ...(pelvisKnown && q.pelvis !== undefined ? { pelvis: { window: q.pelvis.window } } : {}), ...(depthKnown && q.depth !== undefined ? { depth: { gait: q.depth.gait } } : {}) },
    spikes: {
      found: ((c.spikes as { found: Array<{ frame: number; joint: Body18 }> }).found).map((s) => ({ frame: s.frame, joint: s.joint })),
      untested: [...(c.spikes as { untested: number[] }).untested],
    },
    jitter: { before: j.before, after: j.after },
    ...('holds' in c ? { holds: (c.holds as CleanHold[]).map(copyHold) } : {}),
    ...('unheld' in c ? { unheld: (c.unheld as CleanUnheld[]).map(copyUnheld) } : {}),
    ...('seams' in c ? { seams: (c.seams as CleanSeam[]).map((x) => ({ joint: x.joint, frame: x.frame, step: x.step, gap: x.gap })) } : {}),
  };
}

/** `hipsInferred`: { by: "declared" } or the measured record (the shape at `HipsInferred`), refused by name otherwise. */
function readHipsInferred(p: Problems, hw: string, h: unknown, frames: number | null, note: string): void {
  const refuseUnknownKeys = (q: Problems, code: string, w: string, o: Record<string, unknown>, known: readonly string[]) => refuseKeys(q, code, w, o, known, note);
  const measuredShape = '{ by: "measured", method, read, interpolated, held: [[first, last]], declined: [{ frames: [first, last], why }] }';
  if (!isObject(h)) {
    p.add('POSE_CLEANED', `${hw} is ${typeName(h)}; it must be { by: "declared" } or ${measuredShape}`);
    return;
  }
  if (h.by === 'declared') {
    refuseUnknownKeys(p, 'POSE_CLEANED', hw, h, ['by']);
    return;
  }
  if (h.by !== 'measured') {
    refuseUnknownKeys(p, 'POSE_CLEANED', hw, h, ['by']);
    p.add('POSE_CLEANED', `${hw} "by" is ${typeName(h.by)}; this reader reads "declared" (the person running rig-pose clean --hips-inferred said so) or "measured" (a tool read the pelvis line off the picture, tools/pelvis.py)`);
    return;
  }
  const before = p.list.length;
  const REQ_CLASSES = ['read', 'interpolated', 'held'] as const;
  const ALL_CLASSES = ['read', 'interpolated', 'scaled', 'held', 'unmeasured'] as const;
  refuseUnknownKeys(p, 'POSE_CLEANED', hw, h, ['by', 'method', 'fit', ...ALL_CLASSES, 'declined']);
  for (const k of ['method', ...REQ_CLASSES, 'declined']) if (!(k in h)) p.add('POSE_CLEANED', `${hw} has no "${k}"; a measured record is ${measuredShape}`);
  if ('method' in h && !(typeof h.method === 'string' && h.method.trim() !== '')) p.add('POSE_CLEANED', `${hw} "method" is ${typeName(h.method)}; it must be a non-empty string naming the reading`);
  if ('fit' in h) {
    const f = h.fit;
    const fw = `${hw} "fit"`;
    if (!isObject(f)) p.add('POSE_CLEANED', `${fw} is ${typeName(f)}; it must be { frames, gain, corr }`);
    else {
      refuseUnknownKeys(p, 'POSE_CLEANED', fw, f, ['frames', 'gain', 'corr']);
      if (!(Number.isInteger(f.frames) && (f.frames as number) >= 0)) p.add('POSE_CLEANED', `${fw} "frames" is ${typeName(f.frames)}; it must be a whole number of frames ≥ 0`);
      if (!(f.gain === null || (typeof f.gain === 'number' && Number.isFinite(f.gain)))) p.add('POSE_CLEANED', `${fw} "gain" is ${typeName(f.gain)}; it must be a finite number or null`);
      if (!(f.corr === null || (typeof f.corr === 'number' && Number.isFinite(f.corr) && f.corr >= -1 && f.corr <= 1))) p.add('POSE_CLEANED', `${fw} "corr" is ${typeName(f.corr)}; it must be a correlation in [-1, 1] or null`);
    }
  }
  const range = `[0, ${frames === null ? 'the frame count' : frames - 1}]`;
  /** A run [first, last], or null after naming what is wrong with it. */
  const run = (v: unknown, rw: string): Run | null => {
    if (!(Array.isArray(v) && v.length === 2)) {
      p.add('POSE_CLEANED', `${rw} is ${typeName(v)}; a run is [first, last], two frame indices`);
      return null;
    }
    let ok = true;
    v.forEach((f: unknown, k: number) => {
      if (!(Number.isInteger(f) && (f as number) >= 0 && (frames === null || (f as number) < frames))) {
        p.add('POSE_CLEANED', `${rw}[${k}] is ${typeName(f)}; it must be a frame index in ${range}`);
        ok = false;
      }
    });
    if (!ok) return null;
    const [a, b] = v as Run;
    if (a > b) {
      p.add('POSE_CLEANED', `${rw} is [${a}, ${b}]; a run's first frame must not come after its last`);
      return null;
    }
    return [a, b];
  };
  type Named = { r: Run; w: string };
  /** Runs in order and apart: each starts after the previous one ends. */
  const ordered = (rs: Named[], what: string) => {
    for (let k = 1; k < rs.length; k++) {
      const prev = rs[k - 1]!;
      const cur = rs[k]!;
      if (cur.r[0] <= prev.r[1]) p.add('POSE_CLEANED', `${cur.w} [${cur.r[0]}, ${cur.r[1]}] starts at or before the end of ${prev.w} [${prev.r[0]}, ${prev.r[1]}]; ${what} runs must increase and not overlap`);
    }
  };
  const classes: Record<(typeof ALL_CLASSES)[number], Named[]> = { read: [], interpolated: [], scaled: [], held: [], unmeasured: [] };
  for (const c of ALL_CLASSES) {
    if (!(c in h)) continue;
    const list = h[c];
    if (!Array.isArray(list)) {
      p.add('POSE_CLEANED', `${hw} "${c}" is ${typeName(list)}; it must be an array of runs [first, last]`);
      continue;
    }
    list.forEach((v: unknown, k: number) => {
      const w = `${hw} ${c}[${k}]`;
      const r = run(v, w);
      if (r !== null) classes[c].push({ r, w });
    });
    ordered(classes[c], c);
  }
  const declined: Named[] = [];
  if ('declined' in h) {
    if (!Array.isArray(h.declined)) p.add('POSE_CLEANED', `${hw} "declined" is ${typeName(h.declined)}; it must be an array of { frames: [first, last], why }`);
    else h.declined.forEach((d: unknown, k: number) => {
      const w = `${hw} declined[${k}]`;
      if (!isObject(d)) {
        p.add('POSE_CLEANED', `${w} is ${typeName(d)}; a declined run is { frames: [first, last], why }`);
        return;
      }
      refuseUnknownKeys(p, 'POSE_CLEANED', w, d, ['frames', 'why']);
      if (!('why' in d)) p.add('POSE_CLEANED', `${w} has no "why"; a declined run says why, a non-empty string`);
      else if (!(typeof d.why === 'string' && d.why.trim() !== '')) p.add('POSE_CLEANED', `${w} "why" is ${typeName(d.why)}; a declined run says why, a non-empty string`);
      if (!('frames' in d)) {
        p.add('POSE_CLEANED', `${w} has no "frames"; a declined run is { frames: [first, last], why }`);
        return;
      }
      const r = run(d.frames, `${w} "frames"`);
      if (r !== null) declined.push({ r, w: `${w} "frames"` });
    });
    ordered(declined, 'declined');
  }
  const has106 = 'scaled' in h || 'unmeasured' in h || 'fit' in h;
  const classListLabel = has106 ? 'read, interpolated, scaled, held and unmeasured' : 'read, interpolated and held';
  const filledLabel = has106 ? 'interpolated, scaled, held or unmeasured' : 'interpolated or held';
  // Across lists: the classes are disjoint, they cover every frame, and declined is exactly the non-read classes.
  for (let x = 0; x < ALL_CLASSES.length; x++) {
    for (let y = x + 1; y < ALL_CLASSES.length; y++) {
      for (const a of classes[ALL_CLASSES[x]!]) {
        for (const b of classes[ALL_CLASSES[y]!]) {
          if (a.r[0] <= b.r[1] && b.r[0] <= a.r[1]) p.add('POSE_CLEANED', `${a.w} [${a.r[0]}, ${a.r[1]}] and ${b.w} [${b.r[0]}, ${b.r[1]}] share frame(s) ${Math.max(a.r[0], b.r[0])}–${Math.min(a.r[1], b.r[1])}; a frame is one of ${classListLabel}`);
        }
      }
    }
  }
  if (p.list.length > before) return;
  const set = (rs: Named[]) => {
    const out = new Set<number>();
    for (const { r } of rs) for (let f = r[0]; f <= r[1]; f++) out.add(f);
    return out;
  };
  const spans = (fs: number[]) => {
    const out: Run[] = [];
    for (const f of fs) {
      const last = out[out.length - 1];
      if (last !== undefined && f === last[1] + 1) last[1] = f;
      else out.push([f, f]);
    }
    return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  };
  const read = set(classes.read);
  const nonRead = set([...classes.interpolated, ...classes.scaled, ...classes.held, ...classes.unmeasured]);
  const dec = set(declined);
  if (frames !== null) {
    const none = Array.from({ length: frames }, (_, f) => f).filter((f) => !read.has(f) && !nonRead.has(f));
    if (none.length > 0) p.add('POSE_CLEANED', `${hw}: frame(s) ${spans(none)} are in none of ${classListLabel}; every frame of the sequence is one of them`);
  }
  const both = [...dec].filter((f) => read.has(f)).sort((a, b) => a - b);
  if (both.length > 0) p.add('POSE_CLEANED', `${hw}: frame(s) ${spans(both)} are both read and declined; a frame is read or declined, not both`);
  const unfilled = [...dec].filter((f) => !read.has(f) && !nonRead.has(f)).sort((a, b) => a - b);
  if (unfilled.length > 0) p.add('POSE_CLEANED', `${hw}: frame(s) ${spans(unfilled)} are declined but neither ${filledLabel}; a declined frame takes one of them`);
  const undeclared = [...nonRead].filter((f) => !dec.has(f)).sort((a, b) => a - b);
  if (undeclared.length > 0) p.add('POSE_CLEANED', `${hw}: frame(s) ${spans(undeclared)} are ${filledLabel} but not declined; only a frame the reading declined is filled, and "declined" says why`);
}
const holdParamsOf = (h: HoldParams | 'off'): HoldParams | 'off' => (h === 'off' ? 'off' : { speed: h.speed, reach: h.reach, minSeconds: h.minSeconds, blend: h.blend });
const copyHold = (h: CleanHold): CleanHold => ({ joint: h.joint, frames: [h.frames[0], h.frames[1]], ...(h.excursion !== undefined ? { excursion: [h.excursion[0], h.excursion[1]] as [number, number] } : {}), jitter: { before: h.jitter.before, after: h.jitter.after } });
const copyUnheld = (u: CleanUnheld): CleanUnheld => ({ joint: u.joint, frames: [u.frames[0], u.frames[1]], test: u.test, value: u.value });

function readJoints(p: Problems, pw: string, joints: unknown, note: string): Partial<Record<Body18, Joint>> {
  const out: Partial<Record<Body18, Joint>> = {};
  if (!isObject(joints)) {
    p.add('POSE_JOINTS', `${pw} "joints" is ${typeName(joints)}; it must be an object keyed by body-18 joint names`);
    return out;
  }
  for (const [name, j] of Object.entries(joints)) {
    const jw = `${pw} joint "${name}"`;
    if (!isBody18(name)) {
      p.add('POSE_JOINT_NAME', `${pw} names joint "${name}", which body-18 does not have; the joints are ${BODY18.join(', ')}`);
      continue;
    }
    if (!isObject(j)) {
      p.add('POSE_JOINT_SHAPE', `${jw} is ${typeName(j)}; a joint is { state, at?, score? }`);
      continue;
    }
    refuseUnknownKeys(p, 'POSE_KEYS', jw, j, ['state', 'at', 'score'], note);
    const state = j.state;
    if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) {
      p.add('POSE_JOINT_STATE', `${jw} "state" is ${typeName(state)}; it must be one of ${STATES.join(', ')}`);
      continue;
    }
    const joint: Joint = { state: state as JointState };
    if ('at' in j) {
      const at = j.at;
      if (state === 'missing') {
        p.add('POSE_JOINT_AT', `${jw} is "missing" and carries "at"; a missing joint has no position`);
      } else if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        p.add('POSE_JOINT_AT', `${jw} "at" is ${typeName(at)}; it must be [x, y] in picture pixels`);
      } else {
        joint.at = [at[0] as number, at[1] as number];
      }
    } else if (state === 'observed') {
      p.add('POSE_JOINT_AT', `${jw} is "observed" and has no "at"; an observed joint has a position`);
    } else if (state === 'inferred') {
      p.add('POSE_JOINT_AT', `${jw} is "inferred" and has no "at"; an inferred joint is a position the detector supplied but did not see, so it has one`);
    }
    if ('score' in j) {
      if (typeof j.score !== 'number' || !Number.isFinite(j.score)) p.add('POSE_JOINT_SCORE', `${jw} "score" is ${typeName(j.score)}; it must be a finite number`);
      else joint.score = j.score;
    }
    out[name] = joint;
  }
  return out;
}

/**
 * The one person the retarget follows: `wanted` when given, else the only id
 * the sequence contains. Frames where that person is absent carry no joints.
 */
export function personTrack(seq: PoseSequence, wanted: string | undefined, where: string): Array<Partial<Record<Body18, Joint>>> {
  const ids = [...new Set(seq.frames.flatMap((f) => f.people.map((q) => q.id)))].sort();
  const p = new Problems();
  let id = wanted;
  if (id === undefined) {
    if (ids.length === 1) id = ids[0];
    else if (ids.length === 0) p.add('POSE_PERSON', `${where} has no person on any of its ${seq.frames.length} frames`);
    else p.add('POSE_PERSON', `${where} holds ${ids.length} people (${ids.join(', ')}); name the one to follow with --person`);
  } else if (!ids.includes(id)) {
    p.add('POSE_PERSON', `--person "${id}" is not in ${where}; its people are ${ids.join(', ') || '(none)'}`);
  }
  p.throwIfAny();
  return seq.frames.map((f) => f.people.find((q) => q.id === id)?.joints ?? {});
}

// --- COCO-17 -------------------------------------------------------------

export const COCO_SPEC = 'coco17-sequence/1';

/**
 * Convert a COCO-17 sequence to a pose sequence. The input is the common shape
 * of a pose model's per-frame output:
 *
 *   { "format": "coco17-sequence/1", "width": W, "height": H, "source": "…",
 *     "frames": [ { "t": 0, "keypoints": [[x, y, score] × 17] | [x, y, s × 17 flat] | null } ] }
 *
 * in COCO's standard joint order (`COCO17`). A keypoint whose score is 0 is
 * missing (COCO's `v = 0`); every other keypoint is observed with its score —
 * the retarget, not the conversion, decides what score is good enough. `neck`
 * is the shoulders' midpoint (`COCO17_TO_BODY18`). A `null` frame is a frame
 * with nobody in it. The one person is written with id "a".
 */
export function convertCoco17(text: string, where: string): PoseSequence {
  const doc = parseJson(text, where, 'COCO_JSON');
  const p = new Problems();
  if (!isObject(doc)) {
    p.add('COCO_SHAPE', `${where} is ${typeName(doc)}; a ${COCO_SPEC} document is an object`);
    p.throwIfAny();
    throw new Error('unreachable');
  }
  refuseUnknownKeys(p, 'COCO_KEYS', where, doc, ['format', 'width', 'height', 'source', 'frames', 'joints', 'fps', 'model']);
  if (doc.format !== COCO_SPEC) p.add('COCO_SPEC', `${where} "format" is ${typeName(doc.format)}; this reader reads "${COCO_SPEC}"`);
  if ('joints' in doc && JSON.stringify(doc.joints) !== JSON.stringify(COCO17)) {
    p.add('COCO_ORDER', `${where} "joints" is ${JSON.stringify(doc.joints)}; this reader reads COCO's standard order ${JSON.stringify(COCO17)}`);
  }
  for (const k of ['width', 'height'] as const) {
    if (!(Number.isInteger(doc[k]) && (doc[k] as number) > 0)) p.add('COCO_SIZE', `${where} "${k}" is ${typeName(doc[k])}; it must be a positive integer (picture pixels)`);
  }
  const source = typeof doc.source === 'string' ? doc.source : isObject(doc.source) ? JSON.stringify(doc.source) : '';
  if (source === '') p.add('COCO_SOURCE', `${where} "source" is ${typeName(doc.source)}; it must say what produced the file`);
  const frames: PoseFrame[] = [];
  if (!Array.isArray(doc.frames) || doc.frames.length === 0) {
    p.add('COCO_FRAMES', `${where} "frames" is ${typeName(doc.frames)}; it must be a non-empty array`);
  } else {
    doc.frames.forEach((f: unknown, i: number) => {
      const fw = `${where} frames[${i}]`;
      if (!isObject(f)) {
        p.add('COCO_FRAME_SHAPE', `${fw} is ${typeName(f)}; a frame is { t, keypoints }`);
        return;
      }
      if (typeof f.t !== 'number' || !Number.isFinite(f.t)) {
        p.add('COCO_TIME', `${fw} "t" is ${typeName(f.t)}; it must be seconds`);
        return;
      }
      if (f.keypoints === null) {
        frames.push({ t: f.t, people: [] });
        return;
      }
      const triples = cocoTriples(f.keypoints);
      if (triples === null) {
        p.add('COCO_KEYPOINTS', `${fw} "keypoints" is ${typeName(f.keypoints)}; it must be 17 [x, y, score] triples, 51 numbers, or null`);
        return;
      }
      const joints: Partial<Record<Body18, Joint>> = {};
      COCO17.forEach((name, k) => {
        const [x, y, s] = triples[k] as [number, number, number];
        joints[COCO17_TO_BODY18[name]] = s === 0 ? { state: 'missing' } : { state: 'observed', at: [x, y], score: s };
      });
      const ls = joints.l_shoulder;
      const rs = joints.r_shoulder;
      if (ls?.at !== undefined && rs?.at !== undefined) {
        joints.neck = {
          state: 'observed',
          at: [(ls.at[0] + rs.at[0]) / 2, (ls.at[1] + rs.at[1]) / 2],
          score: Math.min(ls.score ?? 1, rs.score ?? 1),
        };
      } else {
        joints.neck = { state: 'missing' };
      }
      frames.push({ t: f.t, people: [{ id: 'a', joints: sortedJoints(joints) }] });
    });
  }
  p.throwIfAny();
  return { spec: POSE_SPEC, space: POSE_SPACE, width: doc.width as number, height: doc.height as number, source: `converted from COCO-17 (${COCO_SPEC}): ${source}`, frames };
}

function cocoTriples(k: unknown): Array<[number, number, number]> | null {
  if (!Array.isArray(k)) return null;
  const nums = (a: unknown[]): a is number[] => a.every((v) => typeof v === 'number' && Number.isFinite(v));
  if (k.length === 51 && nums(k)) return Array.from({ length: 17 }, (_, i) => [k[3 * i], k[3 * i + 1], k[3 * i + 2]] as [number, number, number]);
  if (k.length === 17 && k.every((t) => Array.isArray(t) && t.length === 3 && nums(t))) return k as Array<[number, number, number]>;
  return null;
}

/** Joints in body-18 order, so a written file's key order is fixed. */
export function sortedJoints(j: Partial<Record<Body18, Joint>>): Partial<Record<Body18, Joint>> {
  const out: Partial<Record<Body18, Joint>> = {};
  for (const n of BODY18) {
    const v = j[n];
    if (v !== undefined) out[n] = v;
  }
  return out;
}

/** A pose sequence as JSON text, in a fixed key order. */
export function writePoseSequence(seq: PoseSequence): string {
  const round = (v: number, d: number) => Number(v.toFixed(d));
  const frames = seq.frames.map((f) => ({
    t: f.t,
    ...(f.pelvisTilt !== undefined ? { pelvisTilt: f.pelvisTilt === null ? null : round(f.pelvisTilt, 3) } : {}),
    // rig-c/pose#281: the segments in DEPTH_SEGMENTS' order, each { ratio, sign, source }.
    ...(f.depth !== undefined ? { depth: Object.fromEntries(DEPTH_SEGMENT_NAMES.filter((k) => f.depth![k] !== undefined).map((k) => [k, { ratio: round(f.depth![k]!.ratio, 3), sign: f.depth![k]!.sign, source: f.depth![k]!.source }])) } : {}),
    people: f.people.map((q) => ({
      id: q.id,
      joints: Object.fromEntries(
        Object.entries(sortedJoints(q.joints)).map(([n, j]) => [
          n,
          {
            state: j.state,
            ...(j.at !== undefined ? { at: [round(j.at[0], 2), round(j.at[1], 2)] } : {}),
            ...(j.score !== undefined ? { score: round(j.score, 4) } : {}),
          },
        ]),
      ),
    })),
  }));
  const camera = seq.camera?.map((c) => ({ s: round(c.s, 6), tx: round(c.tx, 3), ty: round(c.ty, 3), inliers: c.inliers }));
  const c = seq.cleaned;
  const jit = (v: number | null) => (v === null ? null : round(v, 4));
  const cleaned = c === undefined ? undefined : {
    spec: c.spec,
    params: { loop: c.params.loop, legs: c.params.legs, rest: c.params.rest, ...(c.params.hipsInferred !== undefined ? { hipsInferred: copyHipsInferred(c.params.hipsInferred) } : {}), ...(c.params.hold !== undefined ? { hold: holdParamsOf(c.params.hold) } : {}), ...(c.params.pelvis !== undefined ? { pelvis: { window: c.params.pelvis.window } } : {}), ...(c.params.depth !== undefined ? { depth: { gait: c.params.depth.gait } } : {}) },
    spikes: { found: c.spikes.found.map((s) => ({ frame: s.frame, joint: s.joint })), untested: [...c.spikes.untested] },
    jitter: { before: jit(c.jitter.before), after: jit(c.jitter.after) },
    ...(c.holds !== undefined ? { holds: c.holds.map((h) => ({ joint: h.joint, frames: [h.frames[0], h.frames[1]], ...(h.excursion !== undefined ? { excursion: [h.excursion[0], h.excursion[1]] } : {}), jitter: { before: jit(h.jitter.before), after: jit(h.jitter.after) } })) } : {}),
    ...(c.seams !== undefined ? { seams: c.seams.map((x) => ({ joint: x.joint, frame: x.frame, step: round(x.step, 4), gap: x.gap })) } : {}),
    ...(c.unheld !== undefined ? { unheld: c.unheld.map((u) => ({ joint: u.joint, frames: [u.frames[0], u.frames[1]], test: u.test, value: u.value === null ? null : round(u.value, 4) })) } : {}),
  };
  // rig-c/pose#288, #281: the minor the content needs — /1.2 with depth (it includes 1.1's keys), /1.1 with a pelvis track, /1 otherwise.
  const spec = seq.frames.some((f) => f.depth !== undefined) ? POSE_SPEC_DEPTH : seq.pelvisSource !== undefined ? POSE_SPEC_PELVIS : seq.spec;
  return `${JSON.stringify({ spec, space: seq.space, width: seq.width, height: seq.height, source: seq.source, ...(seq.cameraSource !== undefined ? { cameraSource: seq.cameraSource } : {}), ...(camera !== undefined ? { camera } : {}), ...(cleaned !== undefined ? { cleaned } : {}), ...(seq.travel !== undefined ? { travel: seq.travel } : {}), ...(seq.pelvisSource !== undefined ? { pelvisSource: seq.pelvisSource } : {}), frames }, null, 2)}\n`;
}
