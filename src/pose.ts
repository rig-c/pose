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
 */
import { BODY18, COCO17, COCO17_TO_BODY18, isBody18, type Body18 } from './joints.ts';
import { isObject, parseJson, Problems, refuseUnknownKeys, typeName } from './problems.ts';

export const POSE_SPEC = 'rig-pose-sequence/1';
export const POSE_SPACE = { units: 'picture-px', origin: 'top-left', y: 'down' } as const;
const STATES = ['observed', 'occluded', 'missing'] as const;
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
export interface CleanRecord {
  spec: typeof CLEAN_SPEC;
  params: { loop: boolean; legs: number; rest: number };
  /**
   * `found`: every joint the spike step replaced, by frame (index into `frames`)
   * and joint. `untested`: the frames the spike step did not test, because a
   * clip end cuts their window (none under `loop`).
   */
  spikes: { found: CleanSpike[]; untested: number[] };
  /** Mean |second difference| of y, px/f², before and after; null where no joint has three consecutive positions. */
  jitter: { before: number | null; after: number | null };
}
export interface PoseSequence {
  spec: typeof POSE_SPEC;
  space: typeof POSE_SPACE;
  width: number;
  height: number;
  source: string;
  /** Optional, only with `camera`: where it came from — "tracked", or "hand-labelled, N keys" (#63). */
  cameraSource?: string;
  /** Optional: one per frame, when a scan read the camera (#63). */
  camera?: CameraFrame[];
  /** Present once `rig-pose clean` has run on the sequence (#67). */
  cleaned?: CleanRecord;
  frames: PoseFrame[];
}

const TOP_KEYS = ['spec', 'space', 'width', 'height', 'source', 'frames'];
const OPTIONAL_KEYS = ['cameraSource', 'camera', 'cleaned'];
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
  refuseUnknownKeys(p, 'POSE_KEYS', where, doc, frames0 ? [...TOP_KEYS, ...OPTIONAL_KEYS, 'fps'] : [...TOP_KEYS, ...OPTIONAL_KEYS]);
  for (const k of TOP_KEYS) if (!(k in doc)) p.add('POSE_KEYS', `${where} has no "${k}"; a ${POSE_SPEC} document carries ${TOP_KEYS.join(', ')}`);
  if ('spec' in doc && doc.spec !== POSE_SPEC && !frames0) p.add('POSE_SPEC', `${where} "spec" is ${typeName(doc.spec)}; this reader reads "${POSE_SPEC}" (and the older name "${POSE_SPEC_FRAMES0}")`);
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
      doc.frames.forEach((f: unknown, i: number) => {
        const fw = `${where} frames[${i}]`;
        if (!isObject(f)) {
          p.add('POSE_FRAME_SHAPE', `${fw} is ${typeName(f)}; a frame is { t, people }`);
          return;
        }
        refuseUnknownKeys(p, 'POSE_KEYS', fw, f, ['t', 'people']);
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
            refuseUnknownKeys(p, 'POSE_KEYS', pw, person, ['id', 'joints']);
            if (typeof person.id !== 'string' || person.id === '') {
              p.add('POSE_PERSON_ID', `${pw} "id" is ${typeName(person.id)}; it must be a non-empty string`);
              return;
            }
            if (ids.has(person.id)) p.add('POSE_PERSON_ID', `${pw} "id" "${person.id}" appears twice in frame ${i}`);
            ids.add(person.id);
            people.push({ id: person.id, joints: readJoints(p, pw, person.joints) });
          });
        }
        frames.push({ t: typeof t === 'number' ? t : NaN, people });
      });
    }
  }
  const camera = 'camera' in doc ? readCamera(p, where, doc.camera, Array.isArray(doc.frames) ? doc.frames.length : null) : undefined;
  if ('cameraSource' in doc) {
    if (typeof doc.cameraSource !== 'string' || doc.cameraSource.trim() === '') p.add('POSE_CAMERA_SOURCE', `${where} "cameraSource" is ${typeName(doc.cameraSource)}; it must be a non-empty string saying where the camera came from ("tracked", "hand-labelled, N keys")`);
    else if (!('camera' in doc)) p.add('POSE_CAMERA_SOURCE', `${where} has "cameraSource" ${JSON.stringify(doc.cameraSource)} and no "camera"; it states where a camera came from, so it needs one`);
  }
  const cleaned = 'cleaned' in doc ? readCleaned(p, where, doc.cleaned, Array.isArray(doc.frames) ? doc.frames.length : null) : undefined;
  p.throwIfAny();
  const cameraSource = typeof doc.cameraSource === 'string' ? doc.cameraSource : undefined;
  return { spec: POSE_SPEC, space: POSE_SPACE, width: doc.width as number, height: doc.height as number, source: doc.source as string, ...(cameraSource !== undefined ? { cameraSource } : {}), ...(camera !== undefined ? { camera } : {}), ...(cleaned !== undefined ? { cleaned } : {}), frames };
}

/** `camera`: one `{ s > 0, tx, ty, inliers ≥ 0 }` per frame, as many as `frames`. */
function readCamera(p: Problems, where: string, camera: unknown, frames: number | null): CameraFrame[] {
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
    refuseUnknownKeys(p, 'POSE_CAMERA', cw, c, CAMERA_KEYS);
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

/** `cleaned`: { spec, params: { loop, legs, rest }, spikes: { found: [{ frame, joint }], untested: [frame] }, jitter: { before, after } }. */
function readCleaned(p: Problems, where: string, c: unknown, frames: number | null): CleanRecord | undefined {
  const cw = `${where} "cleaned"`;
  const shape = '{ spec, params: { loop, legs, rest }, spikes: { found: [{ frame, joint }], untested: [frame] }, jitter: { before, after } }';
  if (!isObject(c)) {
    p.add('POSE_CLEANED', `${cw} is ${typeName(c)}; it is the record rig-pose clean writes, ${shape}`);
    return undefined;
  }
  const before = p.list.length;
  refuseUnknownKeys(p, 'POSE_CLEANED', cw, c, ['spec', 'params', 'spikes', 'jitter']);
  for (const k of ['spec', 'params', 'spikes', 'jitter']) if (!(k in c)) p.add('POSE_CLEANED', `${cw} has no "${k}"; the record is ${shape}`);
  if ('spec' in c && c.spec !== CLEAN_SPEC) p.add('POSE_CLEANED', `${cw} "spec" is ${typeName(c.spec)}; this reader reads "${CLEAN_SPEC}"`);
  const window = (v: unknown) => Number.isInteger(v) && (v === 1 || ((v as number) >= 5 && (v as number) % 2 === 1));
  if ('params' in c) {
    const q = c.params;
    if (!isObject(q)) p.add('POSE_CLEANED', `${cw} "params" is ${typeName(q)}; it must be { loop, legs, rest }`);
    else {
      refuseUnknownKeys(p, 'POSE_CLEANED', `${cw} "params"`, q, ['loop', 'legs', 'rest']);
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
  if (p.list.length > before) return undefined;
  const q = c.params as { loop: boolean; legs: number; rest: number };
  const j = c.jitter as { before: number | null; after: number | null };
  return {
    spec: CLEAN_SPEC,
    params: { loop: q.loop, legs: q.legs, rest: q.rest },
    spikes: {
      found: ((c.spikes as { found: Array<{ frame: number; joint: Body18 }> }).found).map((s) => ({ frame: s.frame, joint: s.joint })),
      untested: [...(c.spikes as { untested: number[] }).untested],
    },
    jitter: { before: j.before, after: j.after },
  };
}

function readJoints(p: Problems, pw: string, joints: unknown): Partial<Record<Body18, Joint>> {
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
    refuseUnknownKeys(p, 'POSE_KEYS', jw, j, ['state', 'at', 'score']);
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
  const cleaned = c === undefined ? undefined : { spec: c.spec, params: { loop: c.params.loop, legs: c.params.legs, rest: c.params.rest }, spikes: { found: c.spikes.found.map((s) => ({ frame: s.frame, joint: s.joint })), untested: [...c.spikes.untested] }, jitter: { before: jit(c.jitter.before), after: jit(c.jitter.after) } };
  return `${JSON.stringify({ spec: seq.spec, space: seq.space, width: seq.width, height: seq.height, source: seq.source, ...(seq.cameraSource !== undefined ? { cameraSource: seq.cameraSource } : {}), ...(camera !== undefined ? { camera } : {}), ...(cleaned !== undefined ? { cleaned } : {}), frames }, null, 2)}\n`;
}
