"""The camera scan (rig-c/pose#63, phase 1). Not shipped.

Reads a video together with its keypoint file and writes a
`rig-pose-sequence/1` whose joints are normalised to frame 0's camera, with the
camera itself beside them:

  python3 -I tools/scan.py --video <video> --pose <pose.json> --out <scanned.pose.json>
      [--mask x0,y0,x1,y1 ...] [--person <id>] [--no-person-mask]
      [--report <scan.json>] [--plot <camera.png> [--mark a-b ...]]
  python3 -I tools/scan.py --camera-file <camera.json> --pose <pose.json> --out <scanned.pose.json>
      [--person <id>] [--plot <camera.png> [--mark a-b ...]]
  python3 -I tools/scan.py --camera-windows a-b,c-d,... --pose <pose.json> --out <scanned.pose.json>
      [--person <id>] [--min-score 0.3] [--report <windows.json>] [--plot <ankles.png> [--mark a-b ...]]

The input is a `rig-pose-sequence/1` or `rig-c-pose-frames/0` with one frame per
video frame (a different count is refused). It is left unchanged. The order is
scan -> clean -> retarget: a sequence `rig-pose clean` already wrote (it carries a
`cleaned` record) is refused by name (SCAN_AFTER_CLEAN), since clean's spike and
smoothing steps would have read the camera's steps as motion of the body.

The camera model, per frame i against frame 0: a point p0 of frame 0's picture
appears at p_i = s_i * p0 + (tx_i, ty_i) on frame i. Scale and translation only
(the card's method: no rotation). The written joints are p' = (p - t_i) / s_i;
`camera[i]` is { s, tx, ty, inliers }, where `inliers` is the number of frame 0
background features the frame-0 fit kept (frame 0 against itself: every one of
its features, the fit being the identity by definition).

The choices this tool makes, and why (fixed before any bar was measured):

- Features: pyramidal Lucas-Kanade optical flow on Shi-Tomasi corners, not ORB.
  The dancer's background is a seamless studio sweep: faint, blurry texture
  (backdrop mottling, floor scuffs) with no crisp corners. ORB's FAST detector
  and binary descriptors need contrast that is not there; LK follows weak
  gradients to a fraction of a pixel. LK assumes small motion; the frame-0 step
  below is pre-warped, so the residual it measures is small.
- Pre-blur: each grey frame is blurred with a Gaussian (sigma 1.5 px) before
  detection and tracking, so the encoder's 8 px block grid, which is fixed to
  the frame and not to the world, does not become a "feature" that reads s = 1.
- Where features may lie: outside the person's mask, a disc of `--dilate` times
  the keypoints' bounding-box height around the convex hull of every joint that
  has a position; outside each `--mask` rectangle (an overlay fixed to the
  picture, in picture px, given on the command line); and more than `--border`
  px inside the picture's edge. On frame i the mask is frame i's; a frame 0
  feature is used on frame i only when it lies outside both frames' masks.
- Fit: a RANSAC similarity without rotation (minimal sample: 2 points), a fixed
  seed, `--ransac-iters` draws, inlier threshold `--ransac-px`, then a least-
  squares refit on the inliers. Points pass a forward-backward check first (LK
  there and back lands within `--fb-px` of the start).
- Chained or direct: both, with different roles. Frame i-1 -> i is tracked
  (features detected on frame i-1) and fitted, and composed with frame i-1's
  final camera: that is only the starting guess. The value written is a direct
  registration to frame 0: frame i is warped into frame 0's picture by the
  guess, frame 0's features are tracked into the warped frame, and the
  residual similarity is fitted and composed. So frame i's error does not carry
  frame 1..i-1's: a chain would accumulate a small bias per frame into a drift
  over 300 frames, a direct registration has none, and the warp keeps LK's
  small-motion assumption on frames zoomed far from frame 0.
- A frame whose frame-0 fit keeps fewer than `--min-inliers` features is not
  given a camera: the tool refuses, naming each such frame, and writes no
  sequence (`--report` and `--plot` still show the chained guess there, marked
  by its inlier count). No value is invented.

`--camera-file <json>` skips tracking: the camera comes from a hand-written
`rig-pose-camera/1` file, { "spec", "keys": [ { "frame", "s", "tx", "ty" } ],
"note"? }, frames strictly increasing; linear between keys, held before the
first and after the last; the joints are normalised exactly as above, and
`inliers` is 0 on every frame (no feature was fitted). The output's
`cameraSource` says which: "tracked" or "hand-labelled, N keys". A malformed
file is refused by name (CAMERA_FILE).

`--camera-windows a-b,c-d,...` (rig-c/pose#82) is the third path, for a clip
whose background refuses tracking (a seamless studio sweep) and whose zooms
come in steps: the zoom windows are given by hand and each step is read off
the floor. The floor is the one background feature every full-body clip has,
and `--plant-feet` already reads it. The windows are a visual judgment (the
picture changes size over those frames, by eye) and are given; the step is not,
and is measured. A wrong window shows on `--plot`. The reading, the snap:

- The feet are the retarget's own: `bun tools/supports.ts` runs `supportsOf`
  (src/legs.ts) on the sequence's held hip and ankle series and reports each
  ankle's speed in one picture leg length (the clip median of hip -> ankle over
  both sides). A frame is planted for an ankle when it is still both ways (its
  speed from the previous frame and to the next each under `STILL_SPEED`, 0.01
  leg lengths a frame). Jump frames are not excluded: the detector reads them on
  the uncorrected picture, so they carry the camera's own steps, and an airborne
  ankle cannot hold still over three frames. A frame read inside a detector jump
  is named in cameraSource ("r 187 inside detector jump 187-193"), not refused.
- Per window a-b and per ankle: the 3 planted frames nearest the window before
  it and the 3 nearest after it, searched within 15 frames of the window and
  never past a neighbouring window; y_before and y_after are the ankle's median picture
  y over each three. An ankle reads the window only with 3 on both sides, and its
  ratio is (y_after - c_y) / (y_before - c_y), about the picture's centre
  c = (width / 2, height / 2).
- Both ankles read: the step is the mean of the two ratios, and their
  disagreement |r_r / r_l - 1| is written for the window, always (foot depth and
  the frames chosen, not camera). One reads: its ratio, and the window says which
  ankle alone. None reads: the window is refused by name (CAMERA_WINDOWS) and
  nothing is written.
- s is 1 before the first window; after each window it is the s before times
  the step, held to the next window; across a window it is linear in the frame
  index from frame a-1's s to frame b+1's. t = c (1 - s), x and y (no pan is
  read). Joints are normalised as above, and `inliers` is 0 on every frame.
- The drift between windows (a slow push-in) is held, not fitted: keying it
  from the foot's drift would count again what the steps carry, and keying it
  from the figure's size carries the body's motion. It is open.
- `cameraSource` is "hand windows, floor-snapped: a-b (r+l, l/r x.x %), c-d (r
  alone), ..." ("no window" for none); the retarget's CAMERA line prints it.
  Windows that are not integer a <= b inside the pose's frames, that overlap, do
  not increase, or leave no frame between them are refused by name
  (CAMERA_WINDOWS), every fault in one run; nothing is written.

`--no-person-mask` drops the person's mask (the planted failure of the card's
synthetic bar); `--report` writes per-frame diagnostics; `--plot` draws s, tx,
ty and the inliers against the frame, with `--mark a-b` spans shaded.

Python 3, OpenCV 4 and numpy. Deterministic: no clock, a seeded RNG.
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np

BODY18 = ['nose', 'neck', 'r_shoulder', 'r_elbow', 'r_wrist', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_hip', 'r_knee', 'r_ankle',
          'l_hip', 'l_knee', 'l_ankle', 'r_eye', 'l_eye', 'r_ear', 'l_ear']
POSE_SPEC = 'rig-pose-sequence/1'
FRAMES0 = 'rig-c-pose-frames/0'
SPACE = {'units': 'picture-px', 'origin': 'top-left', 'y': 'down'}

LK = dict(winSize=(31, 31), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 0.01))
CORNERS = dict(maxCorners=1500, qualityLevel=0.01, minDistance=10, blockSize=7)


class Refusal(Exception):
    pass


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def read_pose(path, person):
    doc = json.load(open(path))
    if doc.get('spec') not in (POSE_SPEC, FRAMES0):
        raise Refusal(f'{path} "spec" is {doc.get("spec")!r}; this tool reads "{POSE_SPEC}" or "{FRAMES0}"')
    if 'cleaned' in doc:
        # The camera comes out before the body is cleaned: a zoom step is a jump of the picture, and clean's
        # spike median and smoothing window would read it as motion of the body (rig-c/pose#80).
        raise Refusal(f'SCAN_AFTER_CLEAN: {path} already carries a "cleaned" record; the order is scan -> clean -> retarget, '
                      f'so scan the sequence clean read (the uncleaned one) and run `rig-pose clean` on what scan writes')
    if 'camera' in doc:
        raise Refusal(f'{path} already carries a "camera"; scan the unnormalised sequence')
    ids = sorted({q['id'] for f in doc['frames'] for q in f['people']})
    if person is None:
        if len(ids) != 1:
            raise Refusal(f'{path} holds {len(ids)} people ({", ".join(ids)}); name one with --person')
        person = ids[0]
    elif person not in ids:
        raise Refusal(f'--person "{person}" is not in {path}; its people are {", ".join(ids)}')
    return doc, person


def joints_of(frame, person):
    for q in frame['people']:
        if q['id'] == person:
            return q['joints']
    return {}


def points_of(joints):
    return np.array([j['at'] for j in joints.values() if 'at' in j], dtype=np.float64).reshape(-1, 2)


def usable_mask(shape, joints_xy, rects, dilate, border, person_mask):
    """255 where a background feature may lie on this frame, in its own picture px."""
    h, w = shape
    m = np.full((h, w), 255, np.uint8)
    if person_mask and len(joints_xy) >= 3:
        hull = cv2.convexHull(np.round(joints_xy).astype(np.int32))
        inside = np.full((h, w), 255, np.uint8)
        cv2.fillConvexPoly(inside, hull, 0)
        r = dilate * (joints_xy[:, 1].max() - joints_xy[:, 1].min())
        dist = cv2.distanceTransform(inside, cv2.DIST_L2, 5)
        m[dist <= r] = 0
    elif person_mask and len(joints_xy) > 0:
        raise Refusal(f'a frame has {len(joints_xy)} joint(s) with a position; the person mask needs at least 3')
    for x0, y0, x1, y1 in rects:
        m[max(0, int(math.floor(y0))):max(0, int(math.ceil(y1))), max(0, int(math.floor(x0))):max(0, int(math.ceil(x1)))] = 0
    if border > 0:
        m[:border, :] = 0
        m[-border:, :] = 0
        m[:, :border] = 0
        m[:, -border:] = 0
    return m


def fit_ls(p, q):
    """Least-squares s, t with q = s p + t."""
    pm, qm = p.mean(0), q.mean(0)
    dp, dq = p - pm, q - qm
    den = (dp * dp).sum()
    if den <= 0:
        return None
    s = (dp * dq).sum() / den
    return s, qm - s * pm


def ransac(p, q, iters, thresh, rng):
    n = len(p)
    if n < 2:
        return None, np.zeros(n, bool)
    best = np.zeros(n, bool)
    for _ in range(iters):
        i, j = rng.choice(n, 2, replace=False)
        d = p[i] - p[j]
        den = (d * d).sum()
        if den < 100.0:  # two points under 10 px apart: their scale is noise
            continue
        s = (d * (q[i] - q[j])).sum() / den
        if not s > 0:
            continue
        t = q[i] - s * p[i]
        inl = np.hypot(*(s * p + t - q).T) <= thresh
        if inl.sum() > best.sum():
            best = inl
    if best.sum() < 2:
        return None, best
    for _ in range(3):
        f = fit_ls(p[best], q[best])
        if f is None or not f[0] > 0:
            return None, best
        s, t = f
        inl = np.hypot(*(s * p + t - q).T) <= thresh
        if (inl == best).all():
            break
        best = inl
        if best.sum() < 2:
            return None, best
    return (s, t), best


def track(a, b, pts, fb_px, init=None):
    """LK a -> b and back; the points that return within fb_px, with where they went."""
    if len(pts) == 0:
        return np.zeros((0, 2)), np.zeros((0, 2))
    p0 = pts.reshape(-1, 1, 2).astype(np.float32)
    if init is None:
        p1, st1, _ = cv2.calcOpticalFlowPyrLK(a, b, p0, None, **LK)
    else:
        p1, st1, _ = cv2.calcOpticalFlowPyrLK(a, b, p0, init.reshape(-1, 1, 2).astype(np.float32).copy(), flags=cv2.OPTFLOW_USE_INITIAL_FLOW, **LK)
    pb, st2, _ = cv2.calcOpticalFlowPyrLK(b, a, p1, None, **LK)
    fb = np.hypot(*(pb - p0).reshape(-1, 2).T)
    ok = (st1.ravel() == 1) & (st2.ravel() == 1) & (fb <= fb_px)
    return p0.reshape(-1, 2)[ok].astype(np.float64), p1.reshape(-1, 2)[ok].astype(np.float64)


def inside(mask, pts):
    h, w = mask.shape
    x = np.round(pts[:, 0]).astype(int)
    y = np.round(pts[:, 1]).astype(int)
    ok = (x >= 0) & (x < w) & (y >= 0) & (y < h)
    out = np.zeros(len(pts), bool)
    out[ok] = mask[y[ok], x[ok]] > 0
    return out


def prep(frame):
    g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.GaussianBlur(g, (0, 0), 1.5)


def scan(video, frames_joints, rects, opts):
    """Per frame: (s, tx, ty, inliers, diagnostics). Raises Refusal on too few inliers."""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise Refusal(f'--video {video} does not open')
    rng = np.random.default_rng(0)
    out = []
    low = []
    g0 = m0 = feats0 = None
    prev_g = prev_m = None
    prev_cam = (1.0, np.zeros(2))
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i >= len(frames_joints):
            raise Refusal(f'--video {video} has more frames than the pose ({len(frames_joints)}); one pose frame per video frame')
        g = prep(frame)
        m = usable_mask(g.shape, points_of(frames_joints[i]), rects, opts.dilate, opts.border, not opts.no_person_mask)
        if i == 0:
            g0, m0 = g, m
            c = cv2.goodFeaturesToTrack(g0, mask=m0, **CORNERS)
            feats0 = np.zeros((0, 2)) if c is None else c.reshape(-1, 2).astype(np.float64)
            out.append((1.0, 0.0, 0.0, len(feats0), {'frame': 0, 'features0': len(feats0), 'chain': None, 'candidates': len(feats0), 'rms': 0.0}))
        else:
            # 1. The chain: frame i-1 -> i, a starting guess only.
            c = cv2.goodFeaturesToTrack(prev_g, mask=prev_m, **CORNERS)
            pa = np.zeros((0, 2)) if c is None else c.reshape(-1, 2).astype(np.float64)
            a, b = track(prev_g, g, pa, opts.fb_px)
            keep = inside(m, b)
            step, sinl = ransac(a[keep], b[keep], opts.ransac_iters, opts.ransac_px, rng)
            s0, t0 = prev_cam
            if step is not None:
                ss, st = step
                guess = (ss * s0, ss * t0 + st)
            else:
                guess = prev_cam
            # 2. Direct to frame 0: warp frame i into frame 0's picture by the guess, track frame 0's features into it.
            gs, gt = guess
            inv = np.array([[1 / gs, 0, -gt[0] / gs], [0, 1 / gs, -gt[1] / gs]])
            h, w = g.shape
            wg = cv2.warpAffine(g, inv, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            wm = cv2.warpAffine(m, inv, (w, h), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            cand = feats0[inside(wm, feats0)]
            a, b = track(g0, wg, cand, opts.fb_px)
            keep = inside(wm, b)
            res, inl = ransac(a[keep], b[keep], opts.ransac_iters, opts.ransac_px, rng)
            n_inl = int(inl.sum())
            if res is None or n_inl < opts.min_inliers:
                low.append((i, n_inl, len(cand)))
                s, t = guess
                rms = float('nan')
            else:
                rs, rt = res
                s, t = gs * rs, gs * rt + gt
                rms = float(np.sqrt(np.mean(np.sum((rs * a[keep][inl] + rt - b[keep][inl]) ** 2, 1))))
            out.append((float(s), float(t[0]), float(t[1]), n_inl, {'frame': i, 'chain': None if step is None else {'s': float(step[0]), 'inliers': int(sinl.sum()), 'tracked': int(keep.sum())},
                                                                 'candidates': int(len(cand)), 'tracked': int(keep.sum()), 'rms': rms}))
            prev_cam = (s, np.array(t))
        prev_g, prev_m = g, m
        i += 1
    cap.release()
    if i != len(frames_joints):
        raise Refusal(f'--video {video} has {i} frames and the pose {len(frames_joints)}; one pose frame per video frame')
    return out, low


def r(v, d):
    v = round(v, d)
    return 0.0 if v == 0 else v


CAMERA_SPEC = 'rig-pose-camera/1'


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def read_camera_file(path, n):
    """A hand-written camera: per frame (s, tx, ty) from the keys, linear between them, held outside."""
    try:
        doc = json.load(open(path))
    except (OSError, ValueError) as e:
        raise Refusal(f'CAMERA_FILE: --camera-file {path} does not read as JSON: {e}')
    bad = []
    if not isinstance(doc, dict):
        raise Refusal(f'CAMERA_FILE: {path} is {type(doc).__name__}; a {CAMERA_SPEC} file is an object {{ spec, keys, note? }}')
    for k in doc:
        if k not in ('spec', 'keys', 'note'):
            bad.append(f'{path} has a key this reader does not know: "{k}"; the keys it reads are spec, keys, note')
    if doc.get('spec') != CAMERA_SPEC:
        bad.append(f'{path} "spec" is {json.dumps(doc.get("spec"))}; it must be "{CAMERA_SPEC}"')
    if 'note' in doc and not isinstance(doc['note'], str):
        bad.append(f'{path} "note" is {json.dumps(doc["note"])}; it must be a string')
    keys = doc.get('keys')
    good = []
    if not isinstance(keys, list) or len(keys) == 0:
        bad.append(f'{path} "keys" is {json.dumps(keys)}; it must be a non-empty array of {{ frame, s, tx, ty }}')
        keys = []
    last = None
    for i, k in enumerate(keys):
        kw = f'{path} keys[{i}]'
        if not isinstance(k, dict):
            bad.append(f'{kw} is {json.dumps(k)}; a key is {{ frame, s, tx, ty }}')
            continue
        ok = True
        for name in k:
            if name not in ('frame', 's', 'tx', 'ty'):
                bad.append(f'{kw} has a key this reader does not know: "{name}"; a key carries frame, s, tx, ty')
                ok = False
        for name in ('frame', 's', 'tx', 'ty'):
            if name not in k:
                bad.append(f'{kw} has no "{name}"; a key carries frame, s, tx, ty')
                ok = False
        f = k.get('frame')
        if 'frame' in k:
            if not (isinstance(f, int) and not isinstance(f, bool) and 0 <= f < n):
                bad.append(f'{kw} "frame" is {json.dumps(f)}; it must be an integer frame of the pose, 0 … {n - 1}')
                ok = False
            elif last is not None and f <= last:
                bad.append(f'{kw} "frame" is {f}, not after keys[{i - 1}]\'s {last}; frames must strictly increase')
                ok = False
            if isinstance(f, int) and not isinstance(f, bool):
                last = f if last is None else max(last, f)
        if 's' in k and not (is_num(k['s']) and k['s'] > 0):
            bad.append(f'{kw} "s" is {json.dumps(k["s"])}; the scale must be a finite number > 0')
            ok = False
        for name in ('tx', 'ty'):
            if name in k and not is_num(k[name]):
                bad.append(f'{kw} "{name}" is {json.dumps(k[name])}; it must be a finite number of picture px')
                ok = False
        if ok:
            good.append((k['frame'], float(k['s']), float(k['tx']), float(k['ty'])))
    if bad:
        raise Refusal('\n'.join(f'CAMERA_FILE: {b}' for b in bad))
    fr = np.array([g[0] for g in good], np.float64)
    out = []
    for i in range(n):
        # np.interp is linear between keys and holds the end values outside them.
        v = [float(np.interp(i, fr, np.array([g[c] for g in good]))) for c in (1, 2, 3)]
        out.append((v[0], v[1], v[2], 0, {'frame': i, 'hand': True}))
    return out, len(good), doc.get('note')


def write(doc, person, cams, path, source, camera_source):
    frames = []
    for f, (s, tx, ty, _n, _d) in zip(doc['frames'], cams):
        people = []
        for q in f['people']:
            joints = {}
            for name in BODY18:
                j = q['joints'].get(name)
                if j is None:
                    continue
                o = {'state': j['state']}
                if 'at' in j:
                    o['at'] = [r((j['at'][0] - tx) / s, 2), r((j['at'][1] - ty) / s, 2)] if q['id'] == person else [r(j['at'][0], 2), r(j['at'][1], 2)]
                if 'score' in j:
                    o['score'] = r(j['score'], 4)
                joints[name] = o
            people.append({'id': q['id'], 'joints': joints})
        frames.append({'t': f['t'], 'people': people})
    out = {'spec': POSE_SPEC, 'space': SPACE, 'width': doc['width'], 'height': doc['height'], 'source': source, 'cameraSource': camera_source,
           'camera': [{'s': r(s, 6), 'tx': r(tx, 3), 'ty': r(ty, 3), 'inliers': int(n)} for s, tx, ty, n, _ in cams], 'frames': frames}
    with open(path, 'w') as fh:
        fh.write(json.dumps(out, indent=2, ensure_ascii=False) + '\n')


def plot(cams, path, marks, title):
    """s, tx, ty and inliers against the frame; marked spans shaded."""
    n = len(cams)
    W, PH, ML, MR, MT = 1500, 230, 90, 30, 50
    rows = [('s', [c[0] for c in cams]), ('tx (px)', [c[1] for c in cams]), ('ty (px)', [c[2] for c in cams]), ('inliers', [c[3] for c in cams])]
    H = MT + PH * len(rows) + 40
    im = np.full((H, W, 3), 255, np.uint8)
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(im, title, (ML, 30), font, 0.6, (30, 30, 30), 1, cv2.LINE_AA)
    px = lambda i: int(round(ML + i / max(1, n - 1) * (W - ML - MR)))
    for k, (name, ys) in enumerate(rows):
        y0, y1 = MT + k * PH + 10, MT + (k + 1) * PH - 20
        lo, hi = min(ys), max(ys)
        if name == 'inliers':
            lo = min(lo, 0)
            hi = max(hi, 30)
        if hi - lo < 1e-9:
            lo, hi = lo - 1, hi + 1
        pad = (hi - lo) * 0.08
        lo, hi = lo - pad, hi + pad
        py = lambda v: int(round(y1 - (v - lo) / (hi - lo) * (y1 - y0)))
        for a, b in marks:
            cv2.rectangle(im, (px(a), y0), (px(b), y1), (160, 226, 255), -1)
        cv2.rectangle(im, (ML, y0), (W - MR, y1), (200, 200, 200), 1)
        for frac in (0, 0.5, 1):
            v = lo + pad + frac * (hi - lo - 2 * pad)
            cv2.putText(im, f'{v:.4f}' if name == 's' else f'{v:.1f}', (5, py(v) + 4), font, 0.4, (30, 30, 30), 1, cv2.LINE_AA)
            cv2.line(im, (ML, py(v)), (W - MR, py(v)), (230, 230, 230), 1)
        if name == 'inliers':
            cv2.line(im, (ML, py(30)), (W - MR, py(30)), (60, 60, 214), 1)
        if name == 's':
            cv2.line(im, (ML, py(1)), (W - MR, py(1)), (150, 150, 150), 1)
        pts = np.array([[px(i), py(v)] for i, v in enumerate(ys)], np.int32)
        cv2.polylines(im, [pts], False, (214, 120, 52), 2, cv2.LINE_AA)
        cv2.putText(im, name, (ML + 6, y0 + 16), font, 0.5, (30, 30, 30), 1, cv2.LINE_AA)
        for i in range(0, n, 24 if n < 400 else 30):
            cv2.line(im, (px(i), y1), (px(i), y1 + 4), (30, 30, 30), 1)
            cv2.putText(im, str(i), (px(i) - 8, y1 + 16), font, 0.35, (30, 30, 30), 1, cv2.LINE_AA)
    cv2.imwrite(path, im)


# --- hand windows, floor-snapped (rig-c/pose#82) -----------------------------------------------------------------

SNAP_FRAMES = 3
SNAP_SEARCH = 15
SUPPORTS_TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'supports.ts')


def parse_windows(text, n):
    """The windows as (a, b) frame pairs, inclusive; every fault named in one Refusal."""
    if text.strip() == '':
        return []
    bad = []
    wins = []
    for k, item in enumerate(text.split(',')):
        item = item.strip()
        parts = item.split('-')
        if len(parts) != 2 or not all(p.isdigit() for p in parts):
            bad.append(f'--camera-windows item {k + 1} is {json.dumps(item)}; a window is a-b, two integer frames with a <= b')
            continue
        a, b = int(parts[0]), int(parts[1])
        ok = True
        if a > b:
            bad.append(f'window {a}-{b}: its first frame {a} is after its last {b}; a window is a-b with a <= b')
            ok = False
        for f in (a, b):
            if f >= n:
                bad.append(f'window {a}-{b}: frame {f} is outside the pose\'s frames 0 … {n - 1}')
                ok = False
        if ok and wins:
            pa, pb = wins[-1]
            if a <= pb:
                bad.append(f'window {a}-{b} does not start after window {pa}-{pb} ends (frame {pb}); windows must increase and not overlap')
                ok = False
            elif a == pb + 1:
                bad.append(f'windows {pa}-{pb} and {a}-{b} leave no frame between them; each window is read on the planted frames beside it')
                ok = False
        if ok:
            wins.append((a, b))
    if bad:
        raise Refusal('\n'.join(f'CAMERA_WINDOWS: {b}' for b in bad))
    return wins


def read_supports(pose, person, min_score, n):
    """tools/supports.ts on the pose (supportsOf's reading, the ankles' speed, planted frames); its refusal relayed by name."""
    bun = shutil.which('bun')
    if bun is None:
        raise Refusal('CAMERA_WINDOWS: bun is not on PATH; --camera-windows reads the feet with `bun tools/supports.ts`')
    p = subprocess.run([bun, SUPPORTS_TOOL, '--pose', pose, '--person', person, '--min-score', repr(min_score)], capture_output=True, text=True)
    if p.returncode != 0:
        lines = [line[len('FAIL  '):] if line.startswith('FAIL  ') else line for line in p.stderr.strip().split('\n') if line.strip()]
        raise Refusal('\n'.join(f'CAMERA_WINDOWS: tools/supports.ts refused {pose} (exit {p.returncode}): {line}' for line in lines or ['(no message)']))
    feet = json.loads(p.stdout)
    if len(feet['planted']['r']) != n:
        raise Refusal(f'CAMERA_WINDOWS: tools/supports.ts read {len(feet["planted"]["r"])} frames of {pose}, and the pose has {n}')
    return feet


def snap_windows(doc, feet, wins):
    """Per frame (s, tx, ty, 0, diagnostics) and each window's reading; a window no ankle reads is refused."""
    n = len(doc['frames'])
    cx, cy = doc['width'] / 2, doc['height'] / 2
    readings = []
    bad = []
    for k, (a, b) in enumerate(wins):
        # Searched within SNAP_SEARCH frames of the window, never past a neighbouring window.
        lo = max(wins[k - 1][1] + 1 if k > 0 else 0, a - SNAP_SEARCH)
        hi = min(wins[k + 1][0] - 1 if k + 1 < len(wins) else n - 1, b + SNAP_SEARCH)
        w = {'window': [a, b], 'sides': {}}
        for side in ('r', 'l'):
            planted = feet['planted'][side]
            before = [i for i in range(a - 1, lo - 1, -1) if planted[i]][:SNAP_FRAMES]
            after = [i for i in range(b + 1, hi + 1) if planted[i]][:SNAP_FRAMES]
            r_ = {'before': sorted(before), 'after': after}
            if len(before) == SNAP_FRAMES and len(after) == SNAP_FRAMES:
                yb = float(np.median([feet['ankle'][side][i][1] for i in before]))
                ya = float(np.median([feet['ankle'][side][i][1] for i in after]))
                r_.update({'y_before': yb, 'y_after': ya, 'ratio': (ya - cy) / (yb - cy) if yb != cy else None})
                if yb == cy:
                    r_['why'] = f'its floor before the window is the picture centre\'s y {cy:g}'
            w['sides'][side] = r_
        read = [s_ for s_ in ('r', 'l') if w['sides'][s_].get('ratio') is not None]
        if not read:
            got = '; '.join(f'{s_} has {len(w["sides"][s_]["before"])} before / {len(w["sides"][s_]["after"])} after' for s_ in ('r', 'l'))
            bad.append(f'window {a}-{b}: no ankle planted on {SNAP_FRAMES} frames on both sides (frames {lo}-{a - 1} before, {b + 1}-{hi} after); {got}')
            continue
        w['inJump'] = [(side, i, j0, j1) for side in read for i in w['sides'][side]['before'] + w['sides'][side]['after']
                       for j0, j1 in feet['jumps'] if j0 <= i <= j1]
        rr, rl = w['sides']['r'].get('ratio'), w['sides']['l'].get('ratio')
        if len(read) == 2:
            w.update({'used': 'r+l', 'step': (rr + rl) / 2, 'disagree': abs(rr / rl - 1)})
        else:
            w.update({'used': f'{read[0]} alone', 'step': rr if rr is not None else rl, 'disagree': None})
        if not w['step'] > 0:
            bad.append(f'window {a}-{b}: the step read is {w["step"]:.4f}; a scale step must be > 0 (the ankle crossed the picture centre\'s y {cy:g})')
        readings.append(w)
    if bad:
        raise Refusal('\n'.join(f'CAMERA_WINDOWS: {b}' for b in bad))
    s = [1.0] * n
    cur = 1.0
    nxt = 0
    for w in readings:
        a, b = w['window']
        for i in range(nxt, a):
            s[i] = cur
        w['s_before'] = cur
        w['s_after'] = cur * w['step']
        for i in range(a, b + 1):
            s[i] = cur + (w['s_after'] - cur) * (i - (a - 1)) / ((b + 1) - (a - 1))
        cur = w['s_after']
        nxt = b + 1
    for i in range(nxt, n):
        s[i] = cur
    cams = [(float(v), float(cx * (1 - v)), float(cy * (1 - v)), 0, {'frame': i, 'snap': True}) for i, v in enumerate(s)]
    return cams, readings


def windows_text(wins):
    return ', '.join(f'{a}-{b}' for a, b in wins) or 'no window'


def window_tag(w):
    a, b = w['window']
    dis = '' if w['disagree'] is None else f', l/r {w["disagree"] * 100:.1f} %'
    # The frames each side's medians stood on (HQ's ruling, #82): a reader sees what the step was read from.
    on = '; '.join(f'{side} {",".join(map(str, w["sides"][side]["before"]))}|{",".join(map(str, w["sides"][side]["after"]))}'
                   for side in ('r', 'l') if w['sides'][side].get('ratio') is not None)
    # A frame read inside a jump the detector found (on the uncorrected picture) is named, not refused (#82).
    inside = ', '.join(f'{side} {i} inside detector jump {j0}-{j1}' for side, i, j0, j1 in w.get('inJump', []))
    return f'{a}-{b} ({w["used"]}{dis}; {on}{"; " + inside if inside else ""})'


def windows_source(readings):
    return f'hand windows, floor-snapped: {", ".join(window_tag(w) for w in readings) or "no window"}'


def window_line(w):
    a, b = w['window']
    sides = []
    for side in ('r', 'l'):
        r_ = w['sides'][side]
        fr = f'frames {",".join(map(str, r_["before"])) or "-"} | {",".join(map(str, r_["after"])) or "-"}'
        if r_.get('ratio') is None:
            sides.append(f'{side} not read ({fr}: {r_.get("why") or f"{len(r_["before"])} before, {len(r_["after"])} after, {SNAP_FRAMES} needed on each side"})')
        else:
            sides.append(f'{side} {fr}, y {r_["y_before"]:.2f} -> {r_["y_after"]:.2f} px, ratio {r_["ratio"]:.6f}')
    dis = f'l/r {w["disagree"] * 100:.2f} %' if w['disagree'] is not None else f'{w["used"]}, no l/r disagreement read'
    return f'window {a}-{b}: {"; ".join(sides)}; step {w["step"]:.6f} ({w["used"]}), {dis}; s {w["s_before"]:.6f} -> {w["s_after"]:.6f}'


def plot_snap(feet, cams, readings, wins, marks, path, title):
    """Both ankles' picture y per frame, the windows shaded and the frames each window was read on marked."""
    n = len(cams)
    W, PH, ML, MR, MT = 1500, 520, 90, 30, 50
    H = MT + PH + 60
    im = np.full((H, W, 3), 255, np.uint8)
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(im, title, (ML, 30), font, 0.5, (30, 30, 30), 1, cv2.LINE_AA)
    px = lambda i: int(round(ML + i / max(1, n - 1) * (W - ML - MR)))
    ys = [a[1] for side in ('r', 'l') for a in feet['ankle'][side]]
    lo, hi = min(ys), max(ys)
    if hi - lo < 1e-9:
        lo, hi = lo - 1, hi + 1
    pad = (hi - lo) * 0.08
    lo, hi = lo - pad, hi + pad
    y0, y1 = MT + 10, MT + PH - 20
    # Picture y grows downward, and is drawn so: lower on the plot is lower in the picture.
    py = lambda v: int(round(y0 + (v - lo) / (hi - lo) * (y1 - y0)))
    for a, b in marks:
        cv2.rectangle(im, (px(a), y0), (px(b), y1), (200, 235, 200), -1)
    for a, b in wins:
        cv2.rectangle(im, (px(a), y0), (px(b), y1), (160, 226, 255), -1)
    cv2.rectangle(im, (ML, y0), (W - MR, y1), (200, 200, 200), 1)
    for frac in (0, 0.5, 1):
        v = lo + pad + frac * (hi - lo - 2 * pad)
        cv2.putText(im, f'{v:.1f}', (5, py(v) + 4), font, 0.4, (30, 30, 30), 1, cv2.LINE_AA)
        cv2.line(im, (ML, py(v)), (W - MR, py(v)), (230, 230, 230), 1)
    colour = {'r': (214, 120, 52), 'l': (52, 160, 52)}
    for side in ('r', 'l'):
        pts = np.array([[px(i), py(a[1])] for i, a in enumerate(feet['ankle'][side])], np.int32)
        cv2.polylines(im, [pts], False, colour[side], 1, cv2.LINE_AA)
        for i, a in enumerate(feet['ankle'][side]):
            if feet['planted'][side][i]:
                cv2.circle(im, (px(i), py(a[1])), 2, colour[side], -1, cv2.LINE_AA)
    for w in readings:
        for side in ('r', 'l'):
            r_ = w['sides'][side]
            if r_.get('ratio') is None:
                continue
            for i in r_['before'] + r_['after']:
                cv2.circle(im, (px(i), py(feet['ankle'][side][i][1])), 6, (60, 60, 214), 2, cv2.LINE_AA)
    cv2.putText(im, 'ankle y (px, down): right blue, left green, dots = planted; red rings = the frames each window was read on; orange = windows, green = --mark',
                (ML + 6, y0 + 16), font, 0.42, (30, 30, 30), 1, cv2.LINE_AA)
    for i in range(0, n, 24 if n < 400 else 30):
        cv2.line(im, (px(i), y1), (px(i), y1 + 4), (30, 30, 30), 1)
        cv2.putText(im, str(i), (px(i) - 8, y1 + 16), font, 0.35, (30, 30, 30), 1, cv2.LINE_AA)
    cv2.imwrite(path, im)


def run_windows(opts, doc, person):
    """--camera-windows end to end; returns the exit code."""
    n = len(doc['frames'])
    wins = parse_windows(opts.camera_windows, n)
    feet = read_supports(opts.pose, person, opts.min_score, n)
    cams, readings = snap_windows(doc, feet, wins)
    camera_source = windows_source(readings)
    cx, cy = doc['width'] / 2, doc['height'] / 2
    steps = '; '.join(f'{w["window"][0]}-{w["window"][1]} step {w["step"]:.6f} ({w["used"]}), s {w["s_before"]:.6f} -> {w["s_after"]:.6f}' for w in readings) or 'none'
    source = (f"{doc['source']} | camera hand windows ({windows_text(wins)}), floor-snapped by tools/scan.py (rig-c/pose#82) on "
              f"{os.path.basename(opts.pose)} (sha256 {sha(opts.pose)[:16]}), {n} frames; planted ankles (speed < {feet['stillSpeed']} leg lengths a frame, "
              f"no jump) by tools/supports.ts (src/legs.ts supportsOf, min-score {opts.min_score}); per window, each ankle's median picture y on the "
              f"{SNAP_FRAMES} planted frames nearest each side, step (y_after - c_y) / (y_before - c_y), the mean where both read: {steps}; "
              f"about the picture centre ({cx:g}, {cy:g}), s 1 before the first window, held between windows, linear across one; "
              f"t = c (1 - s); joints normalised p' = (p - t) / s; inliers 0 (no features were fitted)")
    for w in readings:
        print(window_line(w))
    ss = [c[0] for c in cams]
    if opts.report:
        with open(opts.report, 'w') as fh:
            json.dump({'source': source, 'cameraSource': camera_source, 'windows': readings,
                       'frames': [{'s': c[0], 'tx': c[1], 'ty': c[2]} for c in cams]}, fh, indent=1)
            fh.write('\n')
    if opts.plot:
        plot_snap(feet, cams, readings, wins, opts.mark, opts.plot, f'{os.path.basename(opts.pose)}: hand windows, floor-snapped ({windows_text(wins)})')
    write(doc, person, cams, opts.out, source, camera_source)
    print(f'scan: {n} frames, {len(wins)} hand window(s), floor-snapped; s {min(ss):.4f} … {max(ss):.4f}; cameraSource "{camera_source}"; wrote {opts.out}')
    return 0


def rect(s):
    v = [float(x) for x in s.split(',')]
    if len(v) != 4 or not (v[2] > v[0] and v[3] > v[1]):
        raise argparse.ArgumentTypeError(f'--mask {s!r}: it must be x0,y0,x1,y1 in picture px with x1 > x0 and y1 > y0')
    return v


def span(s):
    a, b = (int(x) for x in s.split('-'))
    return a, b


def main(argv):
    ap = argparse.ArgumentParser(description='Read the camera off the background (rig-c/pose#63).')
    ap.add_argument('--video', help='the video to track (or --camera-file)')
    ap.add_argument('--camera-file', help=f'a hand-written camera ({CAMERA_SPEC}) instead of tracking')
    ap.add_argument('--camera-windows', help='a-b,c-d,...: hand zoom windows (frames, inclusive); each step is read off the planted feet (rig-c/pose#82); "" for none')
    ap.add_argument('--min-score', type=float, default=0.3, help='with --camera-windows: a joint scored below this holds its last good value, as in the retarget (default 0.3)')
    ap.add_argument('--pose', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--person')
    ap.add_argument('--mask', type=rect, action='append', default=[], help='x0,y0,x1,y1: an overlay fixed to the picture, never background')
    ap.add_argument('--dilate', type=float, default=0.15, help="the person's mask: this times the keypoints' height around their hull (default 0.15)")
    ap.add_argument('--border', type=int, default=16, help='px from the picture edge where no feature is taken (default 16)')
    ap.add_argument('--fb-px', type=float, default=1.0, help='forward-backward check (default 1.0 px)')
    ap.add_argument('--ransac-px', type=float, default=1.0, help='RANSAC inlier threshold (default 1.0 px)')
    ap.add_argument('--ransac-iters', type=int, default=500)
    ap.add_argument('--min-inliers', type=int, default=8, help='a frame-0 fit keeping fewer is refused (default 8)')
    ap.add_argument('--no-person-mask', action='store_true', help="the planted failure: features may lie on the person")
    ap.add_argument('--report')
    ap.add_argument('--plot')
    ap.add_argument('--mark', type=span, action='append', default=[], help='a-b: a frame span shaded on --plot')
    opts = ap.parse_args(argv)
    if (opts.video is not None) + (opts.camera_file is not None) + (opts.camera_windows is not None) != 1:
        print('FAIL  SCAN_ARGS: give --video (track the camera), --camera-file (a hand-written one) or --camera-windows '
              '(hand zoom windows, each step read off the planted feet), exactly one', file=sys.stderr)
        return 2
    try:
        doc, person = read_pose(opts.pose, opts.person)
        if opts.camera_windows is not None:
            return run_windows(opts, doc, person)
        if opts.camera_file is not None:
            cams, nkeys, note = read_camera_file(opts.camera_file, len(doc['frames']))
        else:
            frames_joints = [joints_of(f, person) for f in doc['frames']]
            cams, low = scan(opts.video, frames_joints, opts.mask, opts)
    except Refusal as e:
        for line in str(e).split('\n'):
            print(f'FAIL  {line}', file=sys.stderr)
        return 1
    if opts.camera_file is not None:
        camera_source = f'hand-labelled, {nkeys} keys'
        source = (f"{doc['source']} | camera {camera_source} from {os.path.basename(opts.camera_file)} (sha256 {sha(opts.camera_file)[:16]})"
                  f"{f' ({note})' if note else ''}, applied by tools/scan.py (rig-c/pose#63) to {os.path.basename(opts.pose)} (sha256 {sha(opts.pose)[:16]}), "
                  f"{len(cams)} frames; linear between keys, held outside them; joints normalised p' = (p - t) / s; inliers 0 (no features were fitted)")
        write(doc, person, cams, opts.out, source, camera_source)
        ss = [c[0] for c in cams]
        print(f'scan: {len(cams)} frames from {nkeys} hand keys; s {min(ss):.4f} … {max(ss):.4f}; wrote {opts.out}')
        if opts.plot:
            plot(cams, opts.plot, opts.mark, f'{os.path.basename(opts.camera_file)}: hand-labelled camera, {nkeys} keys (s, tx, ty; inliers 0); shaded: {", ".join(f"{a}-{b}" for a, b in opts.mark) or "none"}')
        return 0
    setting = (f'dilate {opts.dilate}, border {opts.border}px, masks {json.dumps(opts.mask)}, fb {opts.fb_px}px, ransac {opts.ransac_px}px x {opts.ransac_iters}, '
               f'min-inliers {opts.min_inliers}{", NO PERSON MASK" if opts.no_person_mask else ""}')
    source = (f"{doc['source']} | camera read by tools/scan.py (rig-c/pose#63) on {os.path.basename(opts.video)} (sha256 {sha(opts.video)[:16]}) "
              f"and {os.path.basename(opts.pose)} (sha256 {sha(opts.pose)[:16]}), {len(cams)} frames; LK flow on background corners, "
              f"similarity (s, t) to frame 0 by RANSAC; joints normalised p' = (p - t) / s; {setting}")
    ss = [c[0] for c in cams]
    inl = [c[3] for c in cams]
    print(f'scan: {len(cams)} frames; s {min(ss):.4f} … {max(ss):.4f}; inliers min {min(inl)}, median {int(np.median(inl))}; '
          f'|t| max {max(math.hypot(c[1], c[2]) for c in cams):.2f}px')
    if opts.report:
        with open(opts.report, 'w') as fh:
            json.dump({'source': source, 'frames': [{'s': c[0], 'tx': c[1], 'ty': c[2], 'inliers': c[3], **c[4]} for c in cams]}, fh, indent=1)
            fh.write('\n')
    if opts.plot:
        plot(cams, opts.plot, opts.mark, f'{os.path.basename(opts.video)}: camera against frame 0 (s, tx, ty) and the frame-0 fit inliers; shaded: {", ".join(f"{a}-{b}" for a, b in opts.mark) or "none"}')
    if low:
        # The report and the plot above show the guess on these frames; the sequence is not written.
        for f, n, c in low:
            print(f'FAIL  SCAN_INLIERS: frame {f}: the frame-0 fit kept {n} of {c} candidate features, under --min-inliers {opts.min_inliers}; no camera is read for it, so nothing is written', file=sys.stderr)
        return 1
    write(doc, person, cams, opts.out, source, 'tracked')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
