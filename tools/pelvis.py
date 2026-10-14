"""The pelvis line from the skirt's top edge (rig-c/pose#86, method B'). Not shipped.

  python3 -I tools/pelvis.py --video <video> --pose <cleaned.pose.json> --out <out.pose.json>
      [--person <id>] [--report <pelvis.json>] [--sheet <sheet.png> [--sheet-frames a,b,...]]

Under a skirt the pose model still places the hips, but where it puts them is
its guess, and it damps the hip line's tilt. Where the skirt's top edge is
visible it is the line the eye reads as the pelvis. This tool reads that edge
on every frame of the video and writes the sequence back with the hip pair
turned to it.

The order is scan -> clean -> pelvis -> retarget. The input is a
`rig-pose-sequence/1` that `rig-pose clean` wrote (it carries a `cleaned`
record), with one frame per video frame. Refused by name, nothing written:

- PELVIS_NOT_CLEANED: the sequence has no `cleaned` record;
- PELVIS_HIPS_INFERRED: its record already says who marked the hips
  (`cleaned.params.hipsInferred` is set);
- PELVIS_FRAMES: the video and the sequence have different frame counts;
- PELVIS_PERSON: the person is not named and the sequence holds several, or
  the one named is not in it.

What it writes: the same sequence, every other joint and every frame time as
read, with r_hip and l_hip `inferred` on every frame where they have a
position, and turned about their midpoint to the frame's angle: the midpoint
and the hip width are kept, the hips stay on their own sides (r_hip -> l_hip
keeps its sense), and only the line's angle changes. A declined frame never
falls back to the detector's hip line (the value known wrong under a skirt):

- read: the frame's own reading;
- interpolated: a declined frame between two read frames at most
  FILL_MAX_GAP_S apart (by the frames' times) takes the linear interpolation,
  in time, of their angles;
- held: any other declined frame (a longer gap, or a run to the clip's end)
  carries the earlier read to the end of its run, and the next read starts
  the new value; a run at the clip's start, with no earlier read, holds the
  later read. The written angle never switches where nothing was read.

A clip with no read frame is refused (PELVIS_NO_READING), nothing written.
`cleaned.params.hipsInferred` becomes { by: "measured", method, read,
interpolated, held: [[first, last], ...], declined: [{ frames: [first, last],
why }] }: every frame is in exactly one of read, interpolated and held, and the
declined runs cover exactly the interpolated and held frames, each run with a
reason shared by every frame of it.

A sequence carrying a `camera` (tools/scan.py) holds its joints normalised,
p' = (p - t) / s. The video is the raw picture, so joints are mapped to it
(p = s p' + t) before they are used there. The camera is a scale and a
translation (no rotation), so the line's angle is the same in both spaces and
the hips are turned in the sequence's own space.

The angle convention (phase 2 of rig-c/pose#63): a line's picture angle is
degrees(atan2(yL - yR, xR - xL)), L the end with the smaller x, picture y down;
positive = the picture-left end is lower; range (-90, 90].

The reading, per frame (method B' v2: phase 2's method B with the changes
rig-c/pose#86 settled):

1. Region. hipw = |l_hip - r_hip|, mid = (r_hip + l_hip) / 2, trunk =
   |neck - mid| (the frame's own). x from min(hip x) - ROI_HALF_WIDTH_PAST_HIPS
   hipw to max(hip x) + the same; y from mid.y - ROI_UP_TRUNK trunk to mid.y +
   ROI_DOWN_TRUNK trunk; clipped to the picture. The trunk, not the hip width,
   sets the height, so a waist high above the hips is inside it.
2. The waist covered: a wrist with a position and a score >= WRIST_MIN_SCORE
   (the retarget's --min-score default) inside the region covers the waist
   only when it is in front of it: the median V over a WRIST_PATCH_PX square at
   the wrist is >= WRIST_FRONT_V (not skirt-dark). A skirt-dark wrist is behind
   the body, and the waist is read beside it. No line is ever read through a
   hand in front.
3. Mask, as B: HSV V < DARK_V; open 3x3; the largest connected component;
   close 7x7; open with a 21x21 ellipse; the largest connected component.
4. Top edge: for each region column holding mask pixels, the smallest mask row.
5. The waistband: the edge is smoothed by a FLAT_MEDIAN_COLS-column median;
   a column is flat where |d(edge)/dx| <= FLAT_SLOPE; flat columns form runs,
   split at a non-flat column or a gap over FLAT_GAP_PX; runs shorter than
   FLAT_MIN_HIPW hip widths are dropped; the run highest in the picture
   (smallest median row) is the waistband. A flaring skirt's sides are steep and
   are not the pelvis line; a fit over every column pulls toward level.
6. Fit, as B, on the waistband's raw edge: least squares y = a x + b; one
   rejection pass dropping |residual| > 3 max(1.4826 MAD, 1 px); refit; angle =
   degrees(atan(-a)).
7. Confidence floor: no reading when the fit kept under MIN_KEPT_SHARE of the
   waistband's columns, or the kept points' 1.4826 MAD about the line is over
   MAX_SPREAD_HIPW hipw. B's refusals stay (hipw < 1 px; an empty mask; under
   10 columns; over half the columns on the region's top row).
8. Misread guard (v2.1), over the clip in frame order: a reading with |angle| >
   GUARD_MAX_ABS_DEG is declined. Any other reading is declined as a misread
   only when it is more than GUARD_MAX_DEG_PER_FRAME degrees per frame from BOTH
   the previous read (the last one the guard accepted) and the next read (the
   next frame passing every other test). A reading within the bound of its
   next read is motion, not a misread; a lone outlier is far from both. Every
   decline is printed with the value it read (MISREAD).

The parameters were fixed before the run that scored them (rig-c/pose#86).

`--no-cover-check` drops step 2 and `--one-neighbour-guard` tests step 8 against
the previous read only (the planted failures of tools/pelvis_selftest.py).
`--report` writes per frame: the region, the wrists tested, the waistband run,
the columns, the spread, the reading or the reason, the class and the angle
written. `--sheet` draws the listed frames with the region and the line
(default: up to 12 frames spread evenly).

Python 3, OpenCV 4 and numpy. Deterministic: no clock, no randomness.
"""
import argparse
import json
import math
import sys

import cv2
import numpy as np

BODY18 = ['nose', 'neck', 'r_shoulder', 'r_elbow', 'r_wrist', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_hip', 'r_knee', 'r_ankle',
          'l_hip', 'l_knee', 'l_ankle', 'r_eye', 'l_eye', 'r_ear', 'l_ear']
POSE_SPEC = 'rig-pose-sequence/1'
METHOD = "B' v2.2 skirt waistband (rig-c/pose#86)"

PARAMS = {
    'ROI_UP_TRUNK': 0.55,
    'ROI_DOWN_TRUNK': 0.15,
    'ROI_HALF_WIDTH_PAST_HIPS': 0.6,
    'DARK_V': 70,
    'WRIST_MIN_SCORE': 0.3,
    'WRIST_PATCH_PX': 25,
    'WRIST_FRONT_V': 70,
    'FLAT_SLOPE': 0.7,
    'FLAT_MEDIAN_COLS': 9,
    'FLAT_GAP_PX': 1.5,
    'FLAT_MIN_HIPW': 0.5,
    'MIN_KEPT_SHARE': 0.6,
    'MAX_SPREAD_HIPW': 0.17,
    'GUARD_MAX_ABS_DEG': 25.0,
    'GUARD_MAX_DEG_PER_FRAME': 6.0,
    'FILL_MAX_GAP_S': 1.0,
}

WHY_COVERED = 'covered: a wrist in front of the waist'
# Frame times are written to the microsecond: a gap within it of FILL_MAX_GAP_S counts as inside it.
TIME_EPS = 1e-6


class Refusal(Exception):
    pass


def picture_angle(p, q):
    """The phase-2 convention: atan2(yL - yR, xR - xL), L the end with the smaller x; degrees, (-90, 90]."""
    (xa, ya), (xb, yb) = sorted([(float(p[0]), float(p[1])), (float(q[0]), float(q[1]))])
    a = math.degrees(math.atan2(ya - yb, xb - xa))
    return 90.0 if a == -90.0 else a


def read_frame(img, J, P=PARAMS, cover_check=True):
    """One frame. J: joint name -> (xy in picture px, score or None). Returns a dict with 'angle' or 'why'.
    cover_check=False is the planted failure of the self-test (--no-cover-check): no wrist is tested."""
    for name in ('r_hip', 'l_hip', 'neck'):
        if name not in J:
            return {'why': f'no {name} position'}
    rh, lh, nk = (np.asarray(J[n][0], float) for n in ('r_hip', 'l_hip', 'neck'))
    hipw = float(np.linalg.norm(lh - rh))
    mid = (rh + lh) / 2
    trunk = float(np.linalg.norm(nk - mid))
    if hipw < 1:
        return {'why': 'hip width under 1 px'}
    hh, ww = img.shape[:2]
    x0 = int(max(0, min(rh[0], lh[0]) - P['ROI_HALF_WIDTH_PAST_HIPS'] * hipw))
    x1 = int(min(ww, max(rh[0], lh[0]) + P['ROI_HALF_WIDTH_PAST_HIPS'] * hipw))
    y0 = int(max(0, mid[1] - P['ROI_UP_TRUNK'] * trunk))
    y1 = int(min(hh, mid[1] + P['ROI_DOWN_TRUNK'] * trunk))
    out = {'roi': [x0, y0, x1, y1], 'hipw': hipw, 'trunk': trunk}
    if y1 - y0 < 2 or x1 - x0 < 2:
        return {**out, 'why': 'empty region of interest'}
    # The wrist test: a trusted wrist inside the region covers the waist only when it is in front of it,
    # i.e. the picture under it is not skirt-dark (a skirt-dark wrist is behind the body).
    covered, behind = [], []
    for w in ('r_wrist', 'l_wrist'):
        if w in J and J[w][1] is not None and J[w][1] >= P['WRIST_MIN_SCORE']:
            x, y = J[w][0]
            if x0 <= x <= x1 and y0 <= y <= y1:
                px, py, h = int(x), int(y), P['WRIST_PATCH_PX'] // 2
                patch = img[max(0, py - h):py + h + 1, max(0, px - h):px + h + 1]
                v = float(np.median(cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)[..., 2]))
                (covered if v >= P['WRIST_FRONT_V'] else behind).append([w, v])
    if covered:
        out['wrists'] = covered
    if behind:
        out['wristsBehind'] = behind
    if covered and cover_check:
        return {**out, 'why': WHY_COVERED}
    hsv = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    dark = (hsv[..., 2] < P['DARK_V']).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark)
    if n < 2:
        return {**out, 'why': 'no dark pixels in the region'}
    m = (lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(m)
    if n2 < 2:
        return {**out, 'why': 'no dark region left after opening'}
    m = lab2 == 1 + int(np.argmax(st2[1:, cv2.CC_STAT_AREA]))
    xs, ys = [], []
    for c in range(m.shape[1]):
        col = np.nonzero(m[:, c])[0]
        if len(col):
            xs.append(x0 + c)
            ys.append(y0 + int(col[0]))
    xs, ys = np.array(xs, float), np.array(ys, float)
    if len(xs) < 10:
        return {**out, 'why': 'under 10 top-edge columns'}
    if np.mean(ys == y0) > 0.5:
        return {**out, 'why': "the top edge is the region's top row on over half the columns"}
    # The waistband: the flat run of the edge highest in the picture (the flaring sides are steep).
    k = P['FLAT_MEDIAN_COLS'] // 2
    sm = np.array([np.median(ys[max(0, i - k):i + k + 1]) for i in range(len(ys))])
    flat = np.abs(np.gradient(sm, xs)) <= P['FLAT_SLOPE'] if len(xs) > 1 else np.ones(len(xs), bool)
    spans, i = [], 0
    while i < len(xs):
        if not flat[i]:
            i += 1
            continue
        e = i
        while e + 1 < len(xs) and flat[e + 1] and xs[e + 1] - xs[e] <= P['FLAT_GAP_PX']:
            e += 1
        spans.append((i, e))
        i = e + 1
    spans = [(a, b) for a, b in spans if xs[b] - xs[a] >= P['FLAT_MIN_HIPW'] * hipw]
    if not spans:
        return {**out, 'why': 'no flat edge run of half a hip width'}
    a0, a1 = min(spans, key=lambda q: (float(np.median(ys[q[0]:q[1] + 1])), q[0]))
    xs, ys = xs[a0:a1 + 1], ys[a0:a1 + 1]
    out['run'] = [float(xs[0]), float(xs[-1])]
    if len(xs) < 10:
        return {**out, 'why': 'under 10 top-edge columns'}
    a, b = np.polyfit(xs, ys, 1)
    r = ys - (a * xs + b)
    mad = 1.4826 * np.median(np.abs(r - np.median(r)))
    keep = np.abs(r) <= 3 * max(mad, 1.0)
    if keep.sum() < 10:
        return {**out, 'why': 'under 10 top-edge columns after rejection'}
    a, b = np.polyfit(xs[keep], ys[keep], 1)
    r2_ = ys[keep] - (a * xs[keep] + b)
    spread = float(1.4826 * np.median(np.abs(r2_ - np.median(r2_))))
    share = float(keep.sum() / len(xs))
    xa, xb = float(xs[keep].min()), float(xs[keep].max())
    out.update({'cols': int(len(xs)), 'kept': int(keep.sum()), 'share': share, 'spread': spread, 'spreadHipw': spread / hipw,
                'line': [[xa, float(a * xa + b)], [xb, float(a * xb + b)]]})
    if share < P['MIN_KEPT_SHARE']:
        return {**out, 'why': 'edge confidence under the floor: too few columns kept by the fit'}
    if spread > P['MAX_SPREAD_HIPW'] * hipw:
        return {**out, 'why': 'edge confidence under the floor: the edge spreads too far about the line'}
    return {**out, 'angle': math.degrees(math.atan(-a))}


def guard(results, P=PARAMS, two_neighbour=True):
    """The misread guard (v2.1), in frame order; mutates `results`.

    A reading with |angle| over GUARD_MAX_ABS_DEG is declined. The others are candidates. A candidate is
    declined as a misread only when it is more than GUARD_MAX_DEG_PER_FRAME degrees per frame (|difference| /
    frames between) from BOTH the previous read (the last earlier candidate the guard accepted) AND the next
    read (the next later candidate, accepted or not): a reading within the bound of its next read is motion.
    A candidate with no previous or no next read cannot be far from both and is kept.
    two_neighbour=False is the planted failure of the self-test (--one-neighbour-guard): the previous read
    alone decides, as v2 did."""
    for r in results:
        if 'angle' in r and abs(r['angle']) > P['GUARD_MAX_ABS_DEG']:
            r['misread'] = r.pop('angle')
            r['why'] = f"misread guard: |angle| over {P['GUARD_MAX_ABS_DEG']:g}°"
    cand = [i for i, r in enumerate(results) if 'angle' in r]
    lim = P['GUARD_MAX_DEG_PER_FRAME']
    angle = {i: results[i]['angle'] for i in cand}
    prev = None
    for k, i in enumerate(cand):
        nxt = cand[k + 1] if k + 1 < len(cand) else None
        far_prev = prev is not None and abs(angle[i] - angle[prev]) / (i - prev) > lim
        far_next = nxt is not None and abs(angle[i] - angle[nxt]) / (nxt - i) > lim
        if far_prev and (far_next or not two_neighbour):
            r = results[i]
            r['misread'] = r.pop('angle')
            r['why'] = (f'misread guard: over {lim:g}°/frame from both the previous and the next reading' if two_neighbour
                        else f'misread guard: over {lim:g}°/frame from the previous reading')
        else:
            prev = i
    return results


def fill(times, results, P=PARAMS):
    """Per frame: ('read' | 'interpolated' | 'held', angle). Declined frames between two reads at most
    FILL_MAX_GAP_S apart take the linear interpolation in time; others carry the earlier read to the end of
    their run (a run at the clip's start, with no earlier read, holds the later read), so the written angle
    changes only at a read. Raises Refusal when no frame was read."""
    reads = [i for i, r in enumerate(results) if 'angle' in r]
    if not reads:
        raise Refusal('PELVIS_NO_READING: no frame gave a reading; there is no measured angle to interpolate or hold, so nothing is written')
    out, k = [], 0
    for i, r in enumerate(results):
        if 'angle' in r:
            out.append(('read', r['angle']))
            continue
        while k < len(reads) and reads[k] < i:
            k += 1
        before = reads[k - 1] if k > 0 else None
        after = reads[k] if k < len(reads) else None
        if before is not None and after is not None and times[after] - times[before] <= P['FILL_MAX_GAP_S'] + TIME_EPS:
            u = (times[i] - times[before]) / (times[after] - times[before])
            out.append(('interpolated', results[before]['angle'] + u * (results[after]['angle'] - results[before]['angle'])))
        else:
            out.append(('held', results[before if before is not None else after]['angle']))
    return out


def read_pose(path, person):
    """The cleaned sequence and the person to read; every refusal of the input together."""
    try:
        doc = json.load(open(path))
    except (OSError, ValueError) as e:
        raise Refusal(f'PELVIS_POSE: --pose {path} does not read as JSON ({e})')
    bad = []
    if not isinstance(doc, dict) or doc.get('spec') != POSE_SPEC:
        raise Refusal(f'PELVIS_POSE: {path} "spec" is {json.dumps(doc.get("spec") if isinstance(doc, dict) else doc)}; this tool reads "{POSE_SPEC}"')
    c = doc.get('cleaned')
    if not isinstance(c, dict):
        bad.append(f'PELVIS_NOT_CLEANED: {path} has no "cleaned" record; the order is scan -> clean -> pelvis -> retarget, '
                   f'so run `rig-pose clean` on it first and give this tool what clean wrote')
    elif isinstance(c.get('params'), dict) and 'hipsInferred' in c['params']:
        bad.append(f'PELVIS_HIPS_INFERRED: {path} "cleaned" "params" "hipsInferred" is {json.dumps(c["params"]["hipsInferred"])}; '
                   f'the hips are already marked, and this tool writes that record itself; give it the sequence clean wrote without --hips-inferred')
    ids = sorted({q['id'] for f in doc.get('frames', []) for q in f.get('people', [])})
    if person is None:
        if len(ids) != 1:
            bad.append(f'PELVIS_PERSON: {path} holds {len(ids)} people ({", ".join(ids) or "none"}); name one with --person')
    elif person not in ids:
        bad.append(f'PELVIS_PERSON: --person "{person}" is not in {path}; its people are {", ".join(ids) or "none"}')
    if bad:
        raise Refusal('\n'.join(bad))
    return doc, person if person is not None else ids[0]


def person_joints(frame, person):
    for q in frame['people']:
        if q['id'] == person:
            return q['joints']
    return None


def picture_joints(joints, cam):
    """Joint -> (xy in the video's picture px, score or None), for joints with a position."""
    s, tx, ty = (cam['s'], cam['tx'], cam['ty']) if cam is not None else (1.0, 0.0, 0.0)
    return {k: ((v['at'][0] * s + tx, v['at'][1] * s + ty), v.get('score')) for k, v in joints.items() if 'at' in v}


def turned(rh, lh, angle):
    """The hip pair turned about its midpoint to the picture angle; midpoint, width and the r -> l sense kept."""
    m = ((rh[0] + lh[0]) / 2, (rh[1] + lh[1]) / 2)
    d = (lh[0] - rh[0], lh[1] - rh[1])
    half = math.hypot(*d) / 2
    u = (math.cos(math.radians(angle)), -math.sin(math.radians(angle)))
    if d[0] * u[0] + d[1] * u[1] < 0:
        u = (-u[0], -u[1])
    return [m[0] - half * u[0], m[1] - half * u[1]], [m[0] + half * u[0], m[1] + half * u[1]]


def r2(v):
    v = round(v, 2)
    return 0 if v == 0 else v


def runs(frames):
    """Sorted frame indices -> [[first, last], ...] of consecutive runs."""
    out = []
    for f in frames:
        if out and f == out[-1][1] + 1:
            out[-1][1] = f
        else:
            out.append([f, f])
    return out


def measure(video, doc, person, keep=None, cover_check=True):
    """Per frame, the reading. keep: frame indices whose picture is returned too (the sheet)."""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise Refusal(f'PELVIS_VIDEO: --video {video} does not open')
    frames, cams = doc['frames'], doc.get('camera')
    results, pictures, i = [], {}, 0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        if i < len(frames):
            joints = person_joints(frames[i], person)
            if joints is None:
                results.append({'why': f'person "{person}" absent'})
            else:
                results.append(read_frame(img, picture_joints(joints, cams[i] if cams is not None else None), PARAMS, cover_check))
            if keep is not None and i in keep:
                pictures[i] = img
        i += 1
    cap.release()
    if i != len(frames):
        raise Refusal(f'PELVIS_FRAMES: --video {video} has {i} frames and the sequence {len(frames)}; one sequence frame per video frame')
    return results, pictures


def apply(doc, person, results, classes, method=METHOD):
    """The sequence written back: hips inferred everywhere, turned to the frame's angle (read, interpolated
    or held); the record."""
    groups = {'read': [], 'interpolated': [], 'held': []}
    declined = []
    for i, (f, r, (cls, ang)) in enumerate(zip(doc['frames'], results, classes)):
        groups[cls].append(i)
        if 'angle' not in r:
            declined.append((i, r['why']))
        joints = person_joints(f, person)
        if joints is None:
            continue
        if 'at' in joints.get('r_hip', {}) and 'at' in joints.get('l_hip', {}):
            # The angle is the same in the normalised space (scale and translation only), so turn there.
            nr, nl = turned(joints['r_hip']['at'], joints['l_hip']['at'], ang)
            joints['r_hip']['at'] = [r2(nr[0]), r2(nr[1])]
            joints['l_hip']['at'] = [r2(nl[0]), r2(nl[1])]
        for h in ('r_hip', 'l_hip'):
            if h in joints and 'at' in joints[h]:
                joints[h]['state'] = 'inferred'
    dec = []
    for i, why in declined:
        if dec and dec[-1]['why'] == why and dec[-1]['frames'][1] == i - 1:
            dec[-1]['frames'][1] = i
        else:
            dec.append({'frames': [i, i], 'why': why})
    rec = {'by': 'measured', 'method': method, 'read': runs(groups['read']), 'interpolated': runs(groups['interpolated']),
           'held': runs(groups['held']), 'declined': dec}
    doc['cleaned']['params']['hipsInferred'] = rec
    return rec, {k: len(v) for k, v in groups.items()}


def sheet(path, pictures, results, doc, person, which):
    tiles = []
    cams = doc.get('camera')
    for i in which:
        img = pictures[i].copy()
        r = results[i]
        joints = person_joints(doc['frames'][i], person) or {}
        J = picture_joints(joints, cams[i] if cams is not None else None)
        if 'roi' in r:
            x0, y0, x1, y1 = r['roi']
            cv2.rectangle(img, (x0, y0), (x1, y1), (255, 0, 0), 3)
        if 'band' in r:
            b = [int(v) for v in r['band']]
            cv2.rectangle(img, (b[0], b[1]), (b[2], b[3]), (0, 200, 255), 3)
        if 'line' in r:
            p, q = (tuple(int(round(v)) for v in pt) for pt in r['line'])
            cv2.line(img, p, q, (0, 200, 0) if 'angle' in r else (0, 0, 255), 4)
        for w in ('r_wrist', 'l_wrist'):
            if w in J:
                cv2.circle(img, tuple(int(v) for v in J[w][0]), 12, (0, 0, 255), -1)
        if 'r_hip' in J and 'l_hip' in J:
            cx = int((J['r_hip'][0][0] + J['l_hip'][0][0]) / 2)
            cy = int((J['r_hip'][0][1] + J['l_hip'][0][1]) / 2)
        else:
            cx, cy = img.shape[1] // 2, img.shape[0] // 2
        h, w = img.shape[:2]
        crop = img[max(0, cy - 500):min(h, cy + 300), max(0, cx - 400):min(w, cx + 400)]
        crop = cv2.resize(crop, (400, 400))
        cv2.putText(crop, f'{i}: ' + (f"{r['angle']:+.1f} deg" if 'angle' in r else r['why'][:34]), (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
        tiles.append(crop)
    if not tiles:
        return
    while len(tiles) % 4:
        tiles.append(np.zeros_like(tiles[0]))
    cv2.imwrite(path, np.vstack([np.hstack(tiles[k:k + 4]) for k in range(0, len(tiles), 4)]))


def frames_list(s):
    return [int(x) for x in s.split(',') if x != '']


def main(argv):
    ap = argparse.ArgumentParser(description="The pelvis line from the skirt's top edge (rig-c/pose#86).")
    ap.add_argument('--video', required=True)
    ap.add_argument('--pose', required=True, help='a sequence rig-pose clean wrote')
    ap.add_argument('--out', required=True)
    ap.add_argument('--person')
    ap.add_argument('--report', help='per-frame readings as JSON')
    ap.add_argument('--sheet', help='a PNG of frames with the region, the band and the line')
    ap.add_argument('--sheet-frames', type=frames_list, help='a,b,...: the frames on --sheet (default: 12 spread evenly)')
    ap.add_argument('--one-neighbour-guard', action='store_true', help="the planted failure: the misread guard tests the previous reading only (v2's rule)")
    ap.add_argument('--no-cover-check', action='store_true', help="the planted failure: a wrist in the waist band is not tested (the self-test's mutant)")
    opts = ap.parse_args(argv)
    try:
        doc, person = read_pose(opts.pose, opts.person)
        n = len(doc['frames'])
        which = opts.sheet_frames if opts.sheet_frames is not None else sorted({round(k * (n - 1) / 11) for k in range(12)} if n > 0 else set())
        bad = [f for f in which if not 0 <= f < n]
        if opts.sheet and bad:
            raise Refusal(f'PELVIS_SHEET: --sheet-frames {", ".join(map(str, bad))} not in the sequence (frames 0 … {n - 1})')
        results, pictures = measure(opts.video, doc, person, set(which) if opts.sheet else None, not opts.no_cover_check)
        guard(results, PARAMS, not opts.one_neighbour_guard)
        classes = fill([f['t'] for f in doc['frames']], results)
    except Refusal as e:
        for line in str(e).split('\n'):
            print(f'FAIL  {line}', file=sys.stderr)
        return 1
    planted = (', NO COVER CHECK (planted failure)' if opts.no_cover_check else '') + (', ONE-NEIGHBOUR GUARD (planted failure)' if opts.one_neighbour_guard else '')
    rec, count = apply(doc, person, results, classes, METHOD + planted)
    with open(opts.out, 'w') as fh:
        fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
    spans = lambda rs: ', '.join(f'{a}-{b}' if a != b else str(a) for a, b in rs) or 'none'
    print(f'pelvis: {n} frame(s) of person "{person}"; {METHOD}{"; NO COVER CHECK" if opts.no_cover_check else ""}')
    print(f'  READ     {count["read"]} frame(s): {spans(rec["read"])}')
    for d in rec['declined']:
        a, b = d['frames']
        print(f'  DECLINED frame(s) {a}-{b}: {d["why"]}' if a != b else f'  DECLINED frame {a}: {d["why"]}')
    for i, r in enumerate(results):
        if 'misread' in r:
            print(f'  MISREAD  frame {i}: read {r["misread"]:+.1f}°, declined ({r["why"]})')
    print(f'  INTERPOLATED {count["interpolated"]} declined frame(s) between reads at most {PARAMS["FILL_MAX_GAP_S"]:g} s apart: {spans(rec["interpolated"])}')
    print(f'  HELD     {count["held"]} declined frame(s) carrying the earlier read (the later one at the clip\'s start): {spans(rec["held"])}')
    print('  INFERRED r_hip and l_hip on every frame where they have a position, turned about their midpoint to the frame\'s angle (read, interpolated or held), midpoint and width kept')
    print(f'  wrote {opts.out}')
    if opts.report:
        with open(opts.report, 'w') as fh:
            json.dump({'method': METHOD, 'params': PARAMS, 'frames': [{'frame': i, **r, 'class': c, 'written': a} for i, (r, (c, a)) in enumerate(zip(results, classes))]}, fh, indent=1)
            fh.write('\n')
    if opts.sheet:
        sheet(opts.sheet, pictures, results, doc, person, which)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
