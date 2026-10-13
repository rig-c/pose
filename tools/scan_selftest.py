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

Exit 0 when the moving and still cases pass; the planted outcome is reported.
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
        for r in rows:
            print(json.dumps(r))
        ok = all(r['pass'] for r in rows if not r['case'].endswith('planted'))
        print(f"selftest: moving {'PASS' if rows[0]['pass'] else 'FAIL'}, still {'PASS' if rows[2]['pass'] else 'FAIL'} "
              f"(bars: |s'/s - 1| <= {S_TOL}, |t' - t| <= {T_TOL} px on every frame); planted, no person mask: "
              f"moving {'within' if rows[1]['pass'] else 'OUTSIDE'} the bars (worst s {rows[1]['worst_s_rel']:.4f}, t {rows[1]['worst_t_px']:.2f} px, inliers min {rows[1]['inliers_min']}), "
              f"still {'within' if rows[3]['pass'] else 'OUTSIDE'} the bars (worst s {rows[3]['worst_s_rel']:.4f}, t {rows[3]['worst_t_px']:.2f} px, inliers min {rows[3]['inliers_min']})")
        return 0 if ok else 1
    finally:
        if keep is None:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
