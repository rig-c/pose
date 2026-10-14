"""The synthetic check of tools/scan.py (rig-c/pose#63, phase 1, bar 5). Not shipped.

  python3 -I tools/scan_selftest.py [--keep <dir>]

Renders a textured background through a known camera, with a textured blob (the
"person", its keypoints on its outline) moving over it, writes the clip as an
mp4 (lossy, like the real input) and the keypoints as a rig-pose-sequence/1,
runs scan.py on it, and compares the camera read with the one rendered.

The card's bar, posted before building:
- moving: a 5 % zoom step and a 20 px pan are recovered within 0.5 % (|s'/s - 1|)
  and 2 px (|t' - t|) on every frame;
- still (the control): a still background reads s = 1, t = 0, within the same;
- planted: the same clips with --no-person-mask. The card says it fails the
  inlier bar or is shown to drift; which one happens is printed, not asserted.

The camera script (p_i = s p0 + t, picture px, y down; a zoom is about the
picture's centre c, so its t is c (1 - s)):
  frames 0-9    s 1.00, no pan
  frames 10-19  s 0.95 (a 5 % zoom-out step at frame 10)
  frames 20-29  s 0.95, plus a 20 px pan right (step at frame 20)
  frames 30-39  s 1.00, plus a 20 px pan up (zoom back in and pan, both at 30)

The hand-written camera (`--camera-file`, rig-pose-camera/1):
- hand keys equal to the moving case's truth (at frames 0, 9, 10, 19, 20, 29,
  30, 39, so linear interpolation is the truth on every frame) reproduce the
  tracker's normalisation within the same 0.5 % and 2 px, camera and joints;
  the outputs' cameraSource are "tracked" and "hand-labelled, 8 keys";
- a malformed file (wrong spec, frames not increasing, s <= 0, a missing ty, an
  unknown key) is refused by name, every fault in one run, and nothing written.

The order (rig-c/pose#80), scan -> clean -> retarget:
- the control: the moving case's scanned output goes through `rig-pose clean`
  (exit 0, the written sequence carries both `camera` and `cleaned`);
- the refusal: the raw sequence cleaned first and then scanned (with the hand
  keys) is refused by name (SCAN_AFTER_CLEAN), and nothing is written.

The hand windows, floor-snapped (`--camera-windows`, rig-c/pose#82), on a
synthetic standing figure (60 frames, both feet on the floor, each lifted in
turn so each side supports, a small sway), its zoom about the picture centre
linear across the window 26-33 and held either side:
- bar 4: an 8 % step is recovered within 0.5 % of s and 2 px of t on every
  frame; the control (no step, the same window given) reads s within 0.5 % of 1;
  the planted failure, the step scanned with the window at 8-15, must fail that
  bar;
- bar 5, always reported: the left ankle stepping 6 % where the camera steps
  8 % (a foot changing depth) puts its l/r disagreement, over 1 %, in
  cameraSource with its value; the 8 % step case, both ankles read, shows about
  0 %;
- bar 3: the raw wave (examples/wave/make-pose.ts's construction before its
  clean, ported here) scanned with no window writes s = 1, t = 0 exactly and
  the input's joints; cleaned and retargeted onto examples/wave, it writes a
  motion file byte-identical to the unscanned sequence's;
- malformed windows (a > b, out of range, not a-b, overlapping, adjacent) are
  refused by name in one run, a window no ankle is planted on 3 frames on both
  sides of is refused, --camera-windows with --camera-file is refused (SCAN_ARGS), and
  nothing is written.

Exit 0 when the moving, still, hand, malformed, order and hand-window cases pass
(the wrong window failing its bar); the no-person-mask planted outcome is reported.
Deterministic: seeded RNGs, no clock.
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 540, 960
N = 40
FPS = 24
MARGIN = 120
BODY18 = ['nose', 'neck', 'r_shoulder', 'r_elbow', 'r_wrist', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_hip', 'r_knee', 'r_ankle',
          'l_hip', 'l_knee', 'l_ankle', 'r_eye', 'l_eye', 'r_ear', 'l_ear']
S_TOL = 0.005
T_TOL = 2.0


def texture(h, w, rng, amp, scales=(3, 9, 27, 81)):
    out = np.zeros((h, w), np.float64)
    for sc in scales:
        n = rng.standard_normal((h // sc + 2, w // sc + 2))
        out += cv2.resize(n, (w, h), interpolation=cv2.INTER_CUBIC)
    out = (out - out.mean()) / out.std()
    return out * amp


def camera_moving(i):
    c = np.array([W / 2, H / 2])
    s = 1.0 if i < 10 or i >= 30 else 0.95
    pan = np.array([0.0, 0.0])
    if i >= 20:
        pan += [20.0, 0.0]
    if i >= 30:
        pan += [0.0, -20.0]
    return s, c * (1 - s) + pan


def camera_still(_i):
    return 1.0, np.zeros(2)


def render(dir_, name, cam):
    rng = np.random.default_rng(7)
    world = np.clip(150 + texture(H + 2 * MARGIN, W + 2 * MARGIN, rng, 25), 0, 255)
    world = cv2.cvtColor(world.astype(np.uint8), cv2.COLOR_GRAY2BGR)
    blob_tex = np.clip(128 + texture(400, 200, np.random.default_rng(11), 70, scales=(2, 5, 13)), 0, 255).astype(np.uint8)
    noise_rng = np.random.default_rng(13)
    path = os.path.join(dir_, f'{name}.mp4')
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'mp4v'), FPS, (W, H))
    frames = []
    truth = []
    for i in range(N):
        s, t = cam(i)
        A = np.array([[s, 0, t[0] - s * MARGIN], [0, s, t[1] - s * MARGIN]])
        f = cv2.warpAffine(world, A, (W, H), flags=cv2.INTER_LINEAR)
        # The person: a textured ellipse, moving and growing in the picture (not with the camera).
        cx, cy = 140 + 7 * i, 480 + 20 * math.sin(i / 4)
        ax, ay = 70 * (1 + 0.005 * i), 190 * (1 + 0.005 * i)
        m = np.zeros((H, W), np.uint8)
        cv2.ellipse(m, (int(round(cx)), int(round(cy))), (int(round(ax)), int(round(ay))), 0, 0, 360, 255, -1)
        tex = cv2.resize(blob_tex, (W, H))
        tex = np.roll(tex, (i * 5, i * 3), (0, 1))
        f[m > 0] = cv2.cvtColor(tex, cv2.COLOR_GRAY2BGR)[m > 0]
        f = np.clip(f.astype(np.float64) + noise_rng.normal(0, 2.0, f.shape), 0, 255).astype(np.uint8)
        vw.write(f)
        joints = {}
        for k, name_ in enumerate(BODY18):
            a = 2 * math.pi * k / len(BODY18)
            joints[name_] = {'state': 'observed', 'at': [round(cx + 0.9 * ax * math.cos(a), 2), round(cy + 0.9 * ay * math.sin(a), 2)], 'score': 0.9}
        frames.append({'t': round(i / FPS, 6), 'people': [{'id': 'a', 'joints': joints}]})
        truth.append((s, t.tolist()))
    vw.release()
    pose = os.path.join(dir_, f'{name}.pose.json')
    json.dump({'spec': 'rig-pose-sequence/1', 'space': {'units': 'picture-px', 'origin': 'top-left', 'y': 'down'}, 'width': W, 'height': H,
               'source': 'synthetic, tools/scan_selftest.py', 'frames': frames}, open(pose, 'w'))
    return path, pose, truth


def run(dir_, name, video, pose, truth, extra):
    out = os.path.join(dir_, f'{name}.out.json')
    rep = os.path.join(dir_, f'{name}.report.json')
    p = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'scan.py'), '--video', video, '--pose', pose, '--out', out, '--report', rep, *extra], capture_output=True, text=True)
    frames = json.load(open(rep))['frames']
    es = [abs(f['s'] / tr[0] - 1) for f, tr in zip(frames, truth)]
    et = [math.hypot(f['tx'] - tr[1][0], f['ty'] - tr[1][1]) for f, tr in zip(frames, truth)]
    inl = [f['inliers'] for f in frames]
    ws, wt = int(np.argmax(es)), int(np.argmax(et))
    return {
        'case': name, 'flags': extra, 'exit': p.returncode, 'stderr': p.stderr.strip().split('\n')[:3] if p.stderr.strip() else [],
        'worst_s_rel': es[ws], 'worst_s_frame': ws, 'worst_s_read': frames[ws]['s'], 'worst_s_true': truth[ws][0],
        'worst_t_px': et[wt], 'worst_t_frame': wt, 'worst_t_read': [frames[wt]['tx'], frames[wt]['ty']], 'worst_t_true': truth[wt][1],
        'inliers_min': min(inl[1:]), 'inliers_median': float(np.median(inl[1:])),
        'pass': p.returncode == 0 and max(es) <= S_TOL and max(et) <= T_TOL,
    }


def scan_hand(dir_, name, pose, keys, extra_top=None):
    cam = os.path.join(dir_, f'{name}.camera.json')
    doc = {'spec': 'rig-pose-camera/1', 'keys': keys, 'note': 'selftest'}
    doc.update(extra_top or {})
    json.dump(doc, open(cam, 'w'))
    out = os.path.join(dir_, f'{name}.out.json')
    p = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'scan.py'), '--camera-file', cam, '--pose', pose, '--out', out], capture_output=True, text=True)
    return p, out


def hand_vs_tracked(dir_, pose, truth):
    stops = [0, 9, 10, 19, 20, 29, 30, 39]
    keys = [{'frame': i, 's': truth[i][0], 'tx': truth[i][1][0], 'ty': truth[i][1][1]} for i in stops]
    p, out = scan_hand(dir_, 'hand', pose, keys)
    if p.returncode != 0:
        return {'case': 'hand', 'exit': p.returncode, 'stderr': p.stderr.strip().split('\n')[:3], 'pass': False}
    hand = json.load(open(out))
    tracked = json.load(open(os.path.join(dir_, 'moving.out.json')))
    es = max(abs(h['s'] / t['s'] - 1) for h, t in zip(hand['camera'], tracked['camera']))
    et = max(math.hypot(h['tx'] - t['tx'], h['ty'] - t['ty']) for h, t in zip(hand['camera'], tracked['camera']))
    ej = 0.0
    for fh, ft in zip(hand['frames'], tracked['frames']):
        for n, j in fh['people'][0]['joints'].items():
            k = ft['people'][0]['joints'][n]
            ej = max(ej, math.hypot(j['at'][0] - k['at'][0], j['at'][1] - k['at'][1]))
    src = (hand.get('cameraSource'), tracked.get('cameraSource'))
    return {'case': 'hand', 'exit': 0, 'cameraSource': src, 'worst_s_rel_vs_tracked': es, 'worst_t_px_vs_tracked': et, 'worst_joint_px_vs_tracked': ej,
            'pass': es <= S_TOL and et <= T_TOL and ej <= T_TOL and src == ('hand-labelled, 8 keys', 'tracked')}


MALFORMED_WANT = [
    '"spec" is "rig-pose-camera/0"; it must be "rig-pose-camera/1"',
    'keys[1] "frame" is 3, not after keys[0]\'s 5; frames must strictly increase',
    'keys[2] "s" is 0; the scale must be a finite number > 0',
    'keys[3] has no "ty"; a key carries frame, s, tx, ty',
    'keys[4] has a key this reader does not know: "rot"; a key carries frame, s, tx, ty',
]


def malformed(dir_, pose):
    keys = [{'frame': 5, 's': 1, 'tx': 0, 'ty': 0}, {'frame': 3, 's': 1, 'tx': 0, 'ty': 0}, {'frame': 8, 's': 0, 'tx': 0, 'ty': 0},
            {'frame': 9, 's': 1, 'tx': 0}, {'frame': 10, 's': 1, 'tx': 0, 'ty': 0, 'rot': 0}]
    p, out = scan_hand(dir_, 'malformed', pose, keys, {'spec': 'rig-pose-camera/0'})
    fails = [line for line in p.stderr.strip().split('\n') if line.startswith('FAIL  CAMERA_FILE: ')]
    named = all(any(w in f for f in fails) for w in MALFORMED_WANT)
    return {'case': 'malformed', 'exit': p.returncode, 'fails': len(fails), 'all named': named, 'written': os.path.exists(out),
            'pass': p.returncode == 1 and named and len(fails) == len(MALFORMED_WANT) and not os.path.exists(out)}


def clean(src, out):
    cli = os.path.join(HERE, '..', 'cli.ts')
    return subprocess.run([shutil.which('bun') or 'bun', cli, 'clean', '--pose', src, '--out', out], capture_output=True, text=True)


def order(dir_, pose, truth):
    scanned = os.path.join(dir_, 'moving.out.json')
    ok_out = os.path.join(dir_, 'scan-then-clean.json')
    c = clean(scanned, ok_out)
    kept = c.returncode == 0 and all(k in json.load(open(ok_out)) for k in ('camera', 'cleaned'))
    cleaned_raw = os.path.join(dir_, 'raw.cleaned.json')
    c0 = clean(pose, cleaned_raw)
    keys = [{'frame': i, 's': truth[i][0], 'tx': truth[i][1][0], 'ty': truth[i][1][1]} for i in (0, 39)]
    p, out = scan_hand(dir_, 'clean-then-scan', cleaned_raw, keys) if c0.returncode == 0 else (None, None)
    fails = [line for line in p.stderr.strip().split('\n') if line.startswith('FAIL  SCAN_AFTER_CLEAN: ')] if p else []
    refused = p is not None and p.returncode == 1 and len(fails) == 1 and 'scan -> clean -> retarget' in fails[0] and not os.path.exists(out)
    return {'case': 'order', 'scan_then_clean_exit': c.returncode, 'scan_then_clean_kept_camera_and_cleaned': kept,
            'clean_raw_exit': c0.returncode, 'clean_then_scan_exit': p.returncode if p else None, 'refusal': fails,
            'written': bool(out) and os.path.exists(out), 'pass': kept and refused,
            'stderr': [] if c.returncode == 0 and c0.returncode == 0 else (c.stderr + c0.stderr).strip().split('\n')[:3]}


# --- hand windows, floor-snapped (rig-c/pose#82) -----------------------------------------------------------------

WN = 60
WINDOW = (26, 33)
WRONG_WINDOW = (8, 15)
FLOOR = 850.0
LIFT = 30.0  # the unweighted foot's heel raise, px at its top: one foot lifted at a time, so each side supports in turn


def lift(i):
    """(right, left) lift in world px: half-periods of 7 frames, the left lifted first, ramps of 10 px a frame.
    Short enough that each foot stands still on 3 frames within the snap's 15-frame search on either side of a window."""
    p = i % 14
    q = p % 7
    v = min(q, 6 - q) * LIFT / 3
    return (0.0, v) if p < 7 else (v, 0.0)


def ramp(i, a, b, end):
    """1 up to frame a-1, `end` from frame b+1, linear in the frame index between (the zoom inside the window)."""
    if i <= a - 1:
        return 1.0
    if i >= b + 1:
        return end
    return 1.0 + (end - 1.0) * (i - (a - 1)) / ((b + 1) - (a - 1))


def standing(dir_, name, step, left_step=None, window=WINDOW):
    """A standing figure, both feet on the floor in turn, under a zoom about the centre across `window`.
    `left_step` scales the left ankle's y about the centre by a different step (a foot changing depth, not the camera)."""
    c = np.array([W / 2, H / 2])
    frames, truth = [], []
    for i in range(WN):
        sway = 6 * math.sin(2 * math.pi * i / 20)
        lr, ll = lift(i)
        world = {
            'nose': (270 + sway, 262), 'r_eye': (262 + sway, 255), 'l_eye': (278 + sway, 255), 'r_ear': (252 + sway, 260), 'l_ear': (288 + sway, 260),
            'neck': (270 + sway, 300), 'r_shoulder': (230 + sway, 312), 'l_shoulder': (310 + sway, 312),
            'r_elbow': (222 + sway, 400), 'l_elbow': (318 + sway, 400), 'r_wrist': (226 + sway, 480), 'l_wrist': (314 + sway, 480),
            'r_hip': (250 + sway, 520), 'l_hip': (290 + sway, 520), 'r_knee': (248 + sway / 2, 685), 'l_knee': (292 + sway / 2, 685),
            'r_ankle': (246, FLOOR - lr), 'l_ankle': (294, FLOOR - ll),
        }
        s = ramp(i, window[0], window[1], step)
        sl = ramp(i, window[0], window[1], left_step if left_step is not None else step)
        joints = {}
        for name_ in BODY18:
            x, y = world[name_]
            px = c[0] + s * (x - c[0])
            py = c[1] + (sl if name_ == 'l_ankle' else s) * (y - c[1])
            joints[name_] = {'state': 'observed', 'at': [round(px, 2), round(py, 2)], 'score': 0.9}
        frames.append({'t': round(i / FPS, 6), 'people': [{'id': 'a', 'joints': joints}]})
        truth.append((s, (c * (1 - s)).tolist()))
    pose = os.path.join(dir_, f'{name}.pose.json')
    json.dump({'spec': 'rig-pose-sequence/1', 'space': {'units': 'picture-px', 'origin': 'top-left', 'y': 'down'}, 'width': W, 'height': H,
               'source': 'synthetic standing figure, tools/scan_selftest.py', 'frames': frames}, open(pose, 'w'))
    return pose, truth


def scan_windows(dir_, name, pose, windows, extra=()):
    out = os.path.join(dir_, f'{name}.out.json')
    rep = os.path.join(dir_, f'{name}.report.json')
    p = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'scan.py'), '--camera-windows', windows, '--pose', pose, '--out', out, '--report', rep, *extra],
                       capture_output=True, text=True)
    return p, out, rep


def windows_case(dir_, name, pose, truth, windows, want_pass=True):
    p, out, rep = scan_windows(dir_, name, pose, windows)
    if p.returncode != 0:
        return {'case': name, 'windows': windows, 'exit': p.returncode, 'stderr': p.stderr.strip().split('\n')[:4], 'pass': False}
    got = json.load(open(out))
    es = [abs(c['s'] / tr[0] - 1) for c, tr in zip(got['camera'], truth)]
    et = [math.hypot(c['tx'] - tr[1][0], c['ty'] - tr[1][1]) for c, tr in zip(got['camera'], truth)]
    ws, wt = int(np.argmax(es)), int(np.argmax(et))
    rp = json.load(open(rep))
    return {'case': name, 'windows': windows, 'exit': 0, 'cameraSource': got['cameraSource'],
            'worst_s_rel': es[ws], 'worst_s_frame': ws, 'worst_s_read': got['camera'][ws]['s'], 'worst_s_true': truth[ws][0],
            'worst_t_px': et[wt], 'worst_t_frame': wt, 'inliers_max': max(c['inliers'] for c in got['camera']),
            'windows_read': [{**{k: w[k] for k in ('window', 'used', 'step', 'disagree', 's_before', 's_after')},
                              'sides': {sd: {k: v for k, v in r_.items() if k in ('before', 'after', 'y_before', 'y_after', 'ratio')} for sd, r_ in w['sides'].items()}}
                             for w in rp['windows']],
            'stdout': p.stdout.strip().split('\n'),
            'pass': max(es) <= S_TOL and max(et) <= T_TOL}


def wave_raw(path):
    """examples/wave/make-pose.ts's sequence before its `clean` (the same construction, ported): a raw fixed-camera clip with legs."""
    fps, rad = 24, math.pi / 180
    dir_ = lambda deg, ln: (ln * math.cos(deg * rad), -ln * math.sin(deg * rad))
    add = lambda a, b: (a[0] + b[0], a[1] + b[1])
    frames = []
    for i in range(fps * 3 + 1):
        t = i / fps
        rise = min(1, t)
        sway = 6 * math.sin(2 * math.pi * 0.75 * t)
        mid = (200 + sway, 400)
        neck = add(mid, dir_(90 - sway / 4, 150))
        rsh, lsh = add(neck, (-30, 10)), add(neck, (30, 10))
        upper = -100 + rise * 150
        fore = upper + 20 + rise * (30 + (35 * math.sin(2 * math.pi * 1.5 * (t - 1)) if t > 1 else 0))
        rel, lel = add(rsh, dir_(upper, 70)), add(lsh, dir_(-80, 70))
        nose = add(neck, (0, -30))
        j = {'nose': nose, 'neck': neck, 'r_shoulder': rsh, 'r_elbow': rel, 'r_wrist': add(rel, dir_(fore, 60)), 'l_shoulder': lsh, 'l_elbow': lel,
             'l_wrist': add(lel, dir_(-100, 60)), 'r_hip': add(mid, (-15, 0)), 'r_knee': add(mid, (-22, 80)), 'r_ankle': add(mid, (-26, 150)),
             'l_hip': add(mid, (15, 0)), 'l_knee': add(mid, (22, 80)), 'l_ankle': add(mid, (26, 150)), 'r_eye': add(nose, (-6, -5)), 'l_eye': add(nose, (6, -5))}
        joints = {k: {'state': 'observed', 'at': [round(v[0], 2), round(v[1], 2)], 'score': 1} for k, v in j.items()}
        frames.append({'t': round(t, 6), 'people': [{'id': 'a', 'joints': joints}]})
    json.dump({'spec': 'rig-pose-sequence/1', 'space': {'units': 'picture-px', 'origin': 'top-left', 'y': 'down'}, 'width': 400, 'height': 600,
               'source': 'examples/wave/make-pose.ts construction before clean, ported in tools/scan_selftest.py', 'frames': frames}, open(path, 'w'))


def retarget(pose, out):
    cli = os.path.join(HERE, '..', 'cli.ts')
    wave = os.path.join(HERE, '..', 'examples', 'wave')
    return subprocess.run([shutil.which('bun') or 'bun', cli, 'retarget', '--rig', os.path.join(wave, 'rig'), '--map', os.path.join(wave, 'map.json'),
                           '--pose', pose, '--out', out], capture_output=True, text=True)


def held_out(dir_):
    """Bar 3: a fixed-camera clip, no window: s = 1, t = 0 exactly, the joints the input's, and the same motion file."""
    raw = os.path.join(dir_, 'wave.raw.json')
    wave_raw(raw)
    p, out, _ = scan_windows(dir_, 'wave-scanned', raw, '')
    if p.returncode != 0:
        return {'case': 'held-out', 'exit': p.returncode, 'stderr': p.stderr.strip().split('\n')[:4], 'pass': False}
    got, inp = json.load(open(out)), json.load(open(raw))
    exact = all(c['s'] == 1 and c['tx'] == 0 and c['ty'] == 0 for c in got['camera'])
    dj = 0.0
    for fo, fi in zip(got['frames'], inp['frames']):
        for n_, j in fi['people'][0]['joints'].items():
            k = fo['people'][0]['joints'][n_]['at']
            dj = max(dj, abs(round(k[0], 2) - round(j['at'][0], 2)), abs(round(k[1], 2) - round(j['at'][1], 2)))
    runs = {}
    for name, src in (('scanned', out), ('unscanned', raw)):
        cl = os.path.join(dir_, f'wave-{name}.cleaned.json')
        c = clean(src, cl)
        mo = os.path.join(dir_, f'wave-{name}.motion.json')
        r_ = retarget(cl, mo) if c.returncode == 0 else None
        runs[name] = {'clean_exit': c.returncode, 'retarget_exit': r_.returncode if r_ else None, 'motion': mo,
                      'stdout': r_.stdout.strip().split('\n') if r_ else [], 'stderr': (c.stderr + (r_.stderr if r_ else '')).strip().split('\n')[:3]}
    ok_runs = all(v['clean_exit'] == 0 and v['retarget_exit'] == 0 for v in runs.values())
    same = ok_runs and open(runs['scanned']['motion'], 'rb').read() == open(runs['unscanned']['motion'], 'rb').read()
    a, b = runs['scanned']['stdout'], runs['unscanned']['stdout']
    differ = [line for line in a if line not in b] + [line for line in b if line not in a]
    return {'case': 'held-out', 'exit': 0, 'cameraSource': got['cameraSource'], 'camera_exact_identity': exact, 'worst_joint_diff_2dp': dj,
            'clean_retarget': {k: {kk: v[kk] for kk in ('clean_exit', 'retarget_exit', 'stderr')} for k, v in runs.items()},
            'motion_bytes_identical': same, 'motion_bytes': os.path.getsize(runs['scanned']['motion']) if ok_runs else None,
            'retarget_stdout_lines_differing': differ,
            'pass': exact and dj == 0 and same and got['cameraSource'] == 'hand windows, floor-snapped: no window'}


WINDOWS_WANT = [
    'window 30-20: its first frame 30 is after its last 20',
    "window 10-70: frame 70 is outside the pose's frames 0 … 59",
    '--camera-windows item 3 is "5-x"',
    'window 15-25 does not start after window 12-18 ends (frame 18)',
    'windows 12-18 and 19-22 leave no frame between them',
]


def windows_refused(dir_, pose):
    p, out, _ = scan_windows(dir_, 'windows-malformed', pose, '30-20,10-70,5-x,12-18,15-25,19-22')
    fails = [line for line in p.stderr.strip().split('\n') if line.startswith('FAIL  CAMERA_WINDOWS: ')]
    named = all(any(w in f for f in fails) for w in WINDOWS_WANT)
    p2, out2, _ = scan_windows(dir_, 'windows-unplanted', pose, '2-30')
    fails2 = [line for line in p2.stderr.strip().split('\n') if line.startswith('FAIL  CAMERA_WINDOWS: ')]
    short = len(fails2) == 1 and 'window 2-30: no ankle planted on 3 frames on both sides' in fails2[0]
    cam = os.path.join(dir_, 'any.camera.json')
    json.dump({'spec': 'rig-pose-camera/1', 'keys': [{'frame': 0, 's': 1, 'tx': 0, 'ty': 0}]}, open(cam, 'w'))
    p3, out3, _ = scan_windows(dir_, 'windows-with-file', pose, '26-33', ['--camera-file', cam])
    both = p3.returncode == 2 and 'FAIL  SCAN_ARGS: ' in p3.stderr and '--camera-windows' in p3.stderr
    return {'case': 'windows-refused', 'malformed_exit': p.returncode, 'malformed_fails': fails, 'malformed_all_named': named, 'malformed_written': os.path.exists(out),
            'unplanted_exit': p2.returncode, 'unplanted_fails': fails2, 'unplanted_written': os.path.exists(out2), 'with_camera_file_exit': p3.returncode,
            'with_camera_file_stderr': p3.stderr.strip(), 'with_camera_file_written': os.path.exists(out3),
            'pass': (p.returncode == 1 and named and len(fails) == len(WINDOWS_WANT) and not os.path.exists(out)
                     and p2.returncode == 1 and short and not os.path.exists(out2) and both and not os.path.exists(out3))}


def windows_cases(dir_):
    """#82's bars 3, 4 and 5 (the snap), the planted wrong window, and the refusals."""
    step_pose, step_truth = standing(dir_, 'stand-step', 1.08)
    flat_pose, flat_truth = standing(dir_, 'stand-flat', 1.0)
    depth_pose, depth_truth = standing(dir_, 'stand-depth', 1.08, left_step=1.06)
    w = f'{WINDOW[0]}-{WINDOW[1]}'
    step = windows_case(dir_, 'windows-step', step_pose, step_truth, w)
    flat = windows_case(dir_, 'windows-control', flat_pose, flat_truth, w)
    wrong = windows_case(dir_, 'windows-planted-wrong', step_pose, step_truth, f'{WRONG_WINDOW[0]}-{WRONG_WINDOW[1]}')
    depth = windows_case(dir_, 'windows-depth', depth_pose, depth_truth, w)
    # Bar 5, always reported: the depth case's l/r disagreement over 1 % on the CAMERA line with its value, the step case's about 0.
    dis = lambda r_: r_['windows_read'][0]['disagree'] if r_.get('exit') == 0 and r_['windows_read'][0]['used'] == 'r+l' else None
    sd, dd = dis(step), dis(depth)
    # The source also names the frames each side's medians stood on (r before|after; l before|after).
    on = lambda r_: '; '.join(f'{x} {",".join(map(str, r_["windows_read"][0]["sides"][x]["before"]))}|{",".join(map(str, r_["windows_read"][0]["sides"][x]["after"]))}' for x in ('r', 'l'))
    step['bar5_about_zero'] = sd is not None and sd < 0.001 and step['cameraSource'] == f'hand windows, floor-snapped: {w} (r+l, l/r {sd * 100:.1f} %; {on(step)})'
    depth['bar5_named'] = dd is not None and dd > 0.01 and depth['cameraSource'] == f'hand windows, floor-snapped: {w} (r+l, l/r {dd * 100:.1f} %; {on(depth)})'
    held = held_out(dir_)
    refused = windows_refused(dir_, step_pose)
    ok = step['pass'] and step['bar5_about_zero'] and flat['pass'] and not wrong['pass'] and depth['bar5_named'] and held['pass'] and refused['pass']
    return [step, flat, wrong, depth, held, refused], ok


def main(argv):
    keep = argv[argv.index('--keep') + 1] if '--keep' in argv else None
    d = keep or tempfile.mkdtemp(prefix='scan-selftest-')
    os.makedirs(d, exist_ok=True)
    try:
        rows = []
        for name, cam in (('moving', camera_moving), ('still', camera_still)):
            video, pose, truth = render(d, name, cam)
            rows.append(run(d, name, video, pose, truth, []))
            rows.append(run(d, f'{name}-planted', video, pose, truth, ['--no-person-mask']))
            if name == 'moving':
                hand = hand_vs_tracked(d, pose, truth)
                bad = malformed(d, pose)
                order_ = order(d, pose, truth)
        for r in rows:
            print(json.dumps(r))
        print(json.dumps(hand))
        print(json.dumps(bad))
        print(json.dumps(order_))
        win_rows, win_ok = windows_cases(d)
        for r in win_rows:
            print(json.dumps(r))
        ok = all(r['pass'] for r in rows if not r['case'].endswith('planted')) and hand['pass'] and bad['pass'] and order_['pass'] and win_ok
        print(f"selftest: moving {'PASS' if rows[0]['pass'] else 'FAIL'}, still {'PASS' if rows[2]['pass'] else 'FAIL'} "
              f"(bars: |s'/s - 1| <= {S_TOL}, |t' - t| <= {T_TOL} px on every frame); planted, no person mask: "
              f"moving {'within' if rows[1]['pass'] else 'OUTSIDE'} the bars (worst s {rows[1]['worst_s_rel']:.4f}, t {rows[1]['worst_t_px']:.2f} px, inliers min {rows[1]['inliers_min']}), "
              f"still {'within' if rows[3]['pass'] else 'OUTSIDE'} the bars (worst s {rows[3]['worst_s_rel']:.4f}, t {rows[3]['worst_t_px']:.2f} px, inliers min {rows[3]['inliers_min']}); "
              f"hand keys = truth {'PASS' if hand['pass'] else 'FAIL'}; malformed camera file refused {'PASS' if bad['pass'] else 'FAIL'}; "
              f"scan -> clean kept, clean -> scan refused {'PASS' if order_['pass'] else 'FAIL'}")
        st, fl, wr, dp, ho, rf = win_rows
        print(f"selftest (#82, hand windows): step {'PASS' if st['pass'] else 'FAIL'} (worst s {st.get('worst_s_rel', float('nan')):.2e}, t {st.get('worst_t_px', float('nan')):.2e} px); "
              f"control {'PASS' if fl['pass'] else 'FAIL'} (worst |s - 1| {fl.get('worst_s_rel', float('nan')):.2e}); "
              f"planted wrong window {'FIRES' if not wr['pass'] else 'DOES NOT FIRE'} (worst s {wr.get('worst_s_rel', float('nan')):.4f} at frame {wr.get('worst_s_frame')}); "
              f"bar 5: depth case l/r {dp['windows_read'][0]['disagree'] * 100 if dp.get('bar5_named') else float('nan'):.2f} % named {'PASS' if dp.get('bar5_named') else 'FAIL'}, "
              f"step case l/r {st['windows_read'][0]['disagree'] * 100 if st.get('bar5_about_zero') else float('nan'):.2f} % {'PASS' if st.get('bar5_about_zero') else 'FAIL'}; "
              f"bar 3 held out {'PASS' if ho['pass'] else 'FAIL'} (motion byte-identical {ho.get('motion_bytes_identical')}); "
              f"CAMERA_WINDOWS refusals {'PASS' if rf['pass'] else 'FAIL'}")
        return 0 if ok else 1
    finally:
        if keep is None:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
