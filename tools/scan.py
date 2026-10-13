"""The camera scan (rig-c/pose#63, phase 1). Not shipped.

Reads a video together with its keypoint file and writes a
`rig-pose-sequence/1` whose joints are normalised to frame 0's camera, with the
camera itself beside them:

  python3 -I tools/scan.py --video <video> --pose <pose.json> --out <scanned.pose.json>
      [--mask x0,y0,x1,y1 ...] [--person <id>] [--no-person-mask]
      [--report <scan.json>] [--plot <camera.png> [--mark a-b ...]]
  python3 -I tools/scan.py --camera-file <camera.json> --pose <pose.json> --out <scanned.pose.json>
      [--person <id>] [--plot <camera.png> [--mark a-b ...]]

The input is a `rig-pose-sequence/1` or `rig-c-pose-frames/0` with one frame per
video frame (a different count is refused). It is left unchanged.

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
    if (opts.video is None) == (opts.camera_file is None):
        print('FAIL  SCAN_ARGS: give --video (track the camera) or --camera-file (a hand-written one), exactly one', file=sys.stderr)
        return 2
    try:
        doc, person = read_pose(opts.pose, opts.person)
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
