"""The synthetic check of tools/pelvis.py (rig-c/pose#86, bar 5). Not shipped.

  python3 -I tools/pelvis_selftest.py [--keep <dir>] [--mutant]

Draws a dark skirt with a known tilted top edge on a light background, the
hips on a less tilted line (a detector that damps the tilt), and, on some
frames, a light hand in front of the waist. Writes the clip as an mp4 (lossy,
like the real input) and the keypoints as a cleaned rig-pose-sequence/1, runs
pelvis.py on it, and checks what it wrote.

The frames (24 fps; picture px, y down; angles in the phase-2 convention,
+ = the picture-left end lower):
  0      edge +10°, wrists away                                  -> read +10°
  1      a hand in front of the waist, r_wrist on it             -> covered -> interpolated
  2      edge +10°, wrists away (the hand moved away)            -> read +10°
  3      r_wrist on the dark skirt (behind the body)             -> read +10° (in-front test)
  4      l_wrist on the light torso inside the region, score 0.2 -> read +10° (an untrusted wrist)
  5      edge +26°                                               -> misread guard |angle| -> interpolated
  6      edge +10°                                               -> read
  7      edge -2°, 12° in one frame                              -> misread guard per frame -> interpolated
  8      edge +8°                                                -> read
  9-33   the hand in front (25 frames, > 1 s between reads)      -> covered -> held (nearer read)
  34     edge -12°                                               -> read
  35-37  the hand in front, to the clip's end                    -> covered -> held -12°

The card's bar 5: the planted wrist on a hand in front reads "covered" (no
line); with the hand and the wrist moved away the line is read again, within
ANGLE_TOL degrees. Also checked: the misread guard declines frames 5 and 7 by
name; interpolated frames take the linear interpolation of the reads either
side, held frames the nearer read; on every frame the hips are turned to that
angle about their midpoint, width kept (within the writer's 0.01 px), and
`inferred`; the record's read, interpolated, held and declined runs; the
TypeScript reader (src/pose.ts) reads the file; and the input refusals (no
cleaned record, hipsInferred already set, a frame-count mismatch, no frame
read), nothing written.

The mutant: the same clip with --no-cover-check (the cover check disabled)
must make the covered frames read through the hand, so the covered case fails.
It runs on every invocation and its failure is asserted. `--mutant` instead
runs the whole check with --no-cover-check as the tool's setting, to show the
bar going red (exit 1).

Exit 0 when every case passes. Deterministic: no clock, no randomness.
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
ROOT = os.path.dirname(HERE)
W, H = 540, 960
FPS = 24
ANGLE_TOL = 1.0
BODY18 = ['nose', 'neck', 'r_shoulder', 'r_elbow', 'r_wrist', 'l_shoulder', 'l_elbow', 'l_wrist', 'r_hip', 'r_knee', 'r_ankle',
          'l_hip', 'l_knee', 'l_ankle', 'r_eye', 'l_eye', 'r_ear', 'l_ear']
CX, EDGE_Y, HIP_Y, HIPW = 270.0, 450.0, 520.0, 80.0
HAND = (325, 448)
COVERED = 'covered: a wrist in front of the waist'


def picture(edge_deg, hand):
    """A light background and torso, a dark skirt whose top edge passes (CX, EDGE_Y) at edge_deg, a light hand."""
    img = np.full((H, W, 3), 205, np.uint8)
    a = -math.tan(math.radians(edge_deg))  # slope dy/dx: angle = atan(-a)
    top = lambda x: EDGE_Y + a * (x - CX)
    cv2.rectangle(img, (200, 250), (340, 560), (235, 235, 235), -1)
    poly = np.array([[180, top(180)], [360, top(360)], [395, 650], [145, 650]], np.float64)
    cv2.fillPoly(img, [np.round(poly).astype(np.int32)], (25, 22, 20))
    if hand:
        cv2.ellipse(img, HAND, (38, 22), 0, 0, 360, (170, 195, 230), -1)
    return img


def joints(hip_deg, wrists):
    u = (math.cos(math.radians(hip_deg)), -math.sin(math.radians(hip_deg)))
    rh = (CX - HIPW / 2 * u[0], HIP_Y - HIPW / 2 * u[1])  # picture-left end: r_hip (the person faces us)
    lh = (CX + HIPW / 2 * u[0], HIP_Y + HIPW / 2 * u[1])
    pts = {'nose': (270, 200), 'neck': (270, 260), 'r_shoulder': (220, 265), 'l_shoulder': (320, 265), 'r_elbow': (200, 380),
           'l_elbow': (340, 380), 'r_hip': rh, 'l_hip': lh, 'r_knee': (245, 700), 'l_knee': (295, 700), 'r_ankle': (245, 880),
           'l_ankle': (295, 880), 'r_eye': (262, 192), 'l_eye': (278, 192), 'r_ear': (255, 196), 'l_ear': (285, 196)}
    out = {k: {'state': 'observed', 'at': [round(v[0], 2), round(v[1], 2)], 'score': 0.9} for k, v in pts.items()}
    for name, (xy, score) in wrists.items():
        out[name] = {'state': 'observed', 'at': [float(xy[0]), float(xy[1])], 'score': score}
    return {k: out[k] for k in BODY18}


AWAY = {'r_wrist': ((150, 600), 0.9), 'l_wrist': ((390, 600), 0.9)}
ON_HAND = {**AWAY, 'r_wrist': (HAND, 0.9)}
BEHIND = {**AWAY, 'r_wrist': ((300, 540), 0.9)}
UNTRUSTED = {**AWAY, 'l_wrist': ((235, 400), 0.2)}
# (edge degrees, detector hip degrees, wrists, hand drawn)
FRAMES = ([(10.0, 3.0, AWAY, False), (10.0, 3.0, ON_HAND, True), (10.0, 3.0, AWAY, False), (10.0, 3.0, BEHIND, False),
           (10.0, 3.0, UNTRUSTED, False), (26.0, 3.0, AWAY, False), (10.0, 3.0, AWAY, False), (-2.0, 1.0, AWAY, False),
           (8.0, 2.0, AWAY, False)]
          + [(8.0, 2.0, ON_HAND, True)] * 25 + [(-12.0, -4.0, AWAY, False)] + [(-12.0, -4.0, ON_HAND, True)] * 3)
READS = {0: 10.0, 2: 10.0, 3: 10.0, 4: 10.0, 6: 10.0, 8: 8.0, 34: -12.0}
WANT_RECORD = {'read': [[0, 0], [2, 4], [6, 6], [8, 8], [34, 34]], 'interpolated': [[1, 1], [5, 5], [7, 7]], 'held': [[9, 33], [35, 37]],
               'declined': [[1, 1], [5, 5], [7, 7], [9, 33], [35, 37]]}


def sequence(cleaned=True, hips_inferred=False):
    frames = [{'t': round(i / FPS, 6), 'people': [{'id': 'a', 'joints': joints(h, w)}]} for i, (_e, h, w, _x) in enumerate(FRAMES)]
    doc = {'spec': 'rig-pose-sequence/1', 'space': {'units': 'picture-px', 'origin': 'top-left', 'y': 'down'}, 'width': W, 'height': H,
           'source': 'synthetic (tools/pelvis_selftest.py)'}
    if cleaned:
        params = {'loop': False, 'legs': 1, 'rest': 1}
        if hips_inferred:
            params['hipsInferred'] = {'by': 'declared'}
        doc['cleaned'] = {'spec': 'rig-pose-clean/1', 'params': params, 'spikes': {'found': [], 'untested': []}, 'jitter': {'before': None, 'after': None}}
    doc['frames'] = frames
    return doc


def write_clip(path, frames=FRAMES):
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'mp4v'), FPS, (W, H))
    for e, _h, _w, hand in frames:
        vw.write(picture(e, hand))
    vw.release()


def run(args):
    return subprocess.run([sys.executable, '-I', os.path.join(HERE, 'pelvis.py'), *args], capture_output=True, text=True)


def angle(p, q):
    (xa, ya), (xb, yb) = sorted([tuple(p), tuple(q)])
    return math.degrees(math.atan2(ya - yb, xb - xa))


def expected(frames):
    """Per frame: the class and the angle the fill must give, from the reads as the tool reported them."""
    reads = sorted(i for i, r in enumerate(frames) if 'angle' in r)
    out = []
    for i, r in enumerate(frames):
        if 'angle' in r:
            out.append(('read', r['angle']))
            continue
        before = max((k for k in reads if k < i), default=None)
        after = min((k for k in reads if k > i), default=None)
        if before is not None and after is not None and (after - before) / FPS <= 1.0 + 1e-9:
            u = (i - before) / (after - before)
            out.append(('interpolated', frames[before]['angle'] + u * (frames[after]['angle'] - frames[before]['angle'])))
        else:
            near = before if after is None or (before is not None and i - before <= after - i) else after
            out.append(('held', frames[near]['angle']))
    return out


def check(dir_, clip, pose, no_cover_check):
    """The bar's cases on one run; a list of failures (empty = pass)."""
    out, rep = os.path.join(dir_, 'out.json'), os.path.join(dir_, 'rep.json')
    p = run(['--video', clip, '--pose', pose, '--out', out, '--report', rep, *(['--no-cover-check'] if no_cover_check else [])])
    if p.returncode != 0:
        return [f'pelvis.py exit {p.returncode}: {p.stderr.strip()}']
    fails = []
    doc, src = json.load(open(out)), json.load(open(pose))
    frames = json.load(open(rep))['frames']
    for i, want in READS.items():
        got = frames[i].get('angle')
        if got is None:
            fails.append(f'frame {i}: no reading ({frames[i].get("why")}); the edge is {want:+.1f}°')
        elif abs(got - want) > ANGLE_TOL:
            fails.append(f'frame {i}: read {got:+.2f}°, the edge is {want:+.1f}° (|error| {abs(got - want):.2f}° > {ANGLE_TOL}°)')
    for i in [1, *range(9, 34), 35, 36, 37]:
        if 'angle' in frames[i]:
            fails.append(f'frame {i}: a hand in front with the wrist on it, yet a line was read at {frames[i]["angle"]:+.2f}° (wanted: covered, no line)')
        elif frames[i].get('why') != COVERED:
            fails.append(f'frame {i}: no line, but the reason is {frames[i].get("why")!r}, not covered')
    for i, word in ((5, 'misread guard: |angle| over 25°'), (7, 'misread guard: over 6°/frame from the previous reading')):
        if frames[i].get('why') != word:
            fails.append(f'frame {i}: wanted declined "{word}", got {frames[i].get("why") or "a reading %+.2f°" % frames[i].get("angle", float("nan"))}')
    want = expected(frames)
    for i, (cls, ang) in enumerate(want):
        if frames[i].get('class') != cls or abs(frames[i].get('written', 1e9) - ang) > 1e-4:
            fails.append(f'frame {i}: class {frames[i].get("class")} angle {frames[i].get("written")}; wanted {cls} {ang:+.3f}°')
        hips_out = doc['frames'][i]['people'][0]['joints']
        hips_in = src['frames'][i]['people'][0]['joints']
        for h in ('r_hip', 'l_hip'):
            if hips_out[h]['state'] != 'inferred':
                fails.append(f'frame {i}: {h} state {hips_out[h]["state"]}; every hip must be "inferred"')
        rh, lh = hips_out['r_hip']['at'], hips_out['l_hip']['at']
        r0, l0 = hips_in['r_hip']['at'], hips_in['l_hip']['at']
        if abs(angle(rh, lh) - ang) > 0.05:
            fails.append(f'frame {i}: the written hip line is {angle(rh, lh):+.3f}°, the frame\'s angle {ang:+.3f}° ({cls})')
        if math.dist([(rh[0] + lh[0]) / 2, (rh[1] + lh[1]) / 2], [(r0[0] + l0[0]) / 2, (r0[1] + l0[1]) / 2]) > 0.02:
            fails.append(f'frame {i}: the hip midpoint moved')
        if abs(math.dist(rh, lh) - math.dist(r0, l0)) > 0.03:
            fails.append(f'frame {i}: the hip width changed {math.dist(r0, l0):.3f} -> {math.dist(rh, lh):.3f}')
        if (lh[0] - rh[0]) * (l0[0] - r0[0]) + (lh[1] - rh[1]) * (l0[1] - r0[1]) <= 0:
            fails.append(f'frame {i}: r_hip -> l_hip reversed its sense')
    rec = doc['cleaned']['params'].get('hipsInferred') or {}
    got_rec = {k: rec.get(k) for k in ('read', 'interpolated', 'held')}
    got_rec['declined'] = [d['frames'] for d in rec.get('declined', [])]
    if rec.get('by') != 'measured' or got_rec != WANT_RECORD:
        fails.append(f'the record is {json.dumps(got_rec)}; wanted {json.dumps(WANT_RECORD)}')
    ts = subprocess.run([shutil.which('bun') or 'bun', '-e', 'import { readPoseSequence } from "./src/pose.ts"; import { readFileSync } from "node:fs";'
                         f' const s = readPoseSequence(readFileSync({json.dumps(out)}, "utf8"), "out"); console.log(JSON.stringify(s.cleaned.params.hipsInferred));'],
                        capture_output=True, text=True, cwd=ROOT)
    if ts.returncode != 0 or json.loads(ts.stdout or 'null') != rec:
        fails.append(f'src/pose.ts does not read the file back as written: exit {ts.returncode} {ts.stderr.strip()[:300]}')
    return fails


def refusals(dir_, clip):
    """The input refusals, by name, nothing written."""
    fails = []
    cases = [('PELVIS_NOT_CLEANED', sequence(cleaned=False), clip), ('PELVIS_HIPS_INFERRED', sequence(hips_inferred=True), clip)]
    short = os.path.join(dir_, 'short.mp4')
    write_clip(short, FRAMES[:-1])
    cases.append(('PELVIS_FRAMES', sequence(), short))
    hidden = os.path.join(dir_, 'hidden.mp4')
    write_clip(hidden, [(e, h, ON_HAND, True) for e, h, _w, _x in FRAMES])
    hidden_doc = sequence()
    for f in hidden_doc['frames']:
        f['people'][0]['joints']['r_wrist'] = {'state': 'observed', 'at': [float(HAND[0]), float(HAND[1])], 'score': 0.9}
    cases.append(('PELVIS_NO_READING', hidden_doc, hidden))
    for code, doc, video in cases:
        pose, out = os.path.join(dir_, f'{code}.json'), os.path.join(dir_, f'{code}.out.json')
        json.dump(doc, open(pose, 'w'))
        p = run(['--video', video, '--pose', pose, '--out', out])
        if p.returncode != 1 or f'FAIL  {code}:' not in p.stderr or os.path.exists(out):
            fails.append(f'{code}: exit {p.returncode}, stderr {p.stderr.strip()!r}, written {os.path.exists(out)}')
        else:
            print(f'  refused: {p.stderr.strip().splitlines()[0][6:110]}…')
    return fails


def main(argv):
    keep = argv[argv.index('--keep') + 1] if '--keep' in argv else None
    mutant = '--mutant' in argv
    dir_ = keep or tempfile.mkdtemp(prefix='pelvis-selftest-')
    os.makedirs(dir_, exist_ok=True)
    try:
        clip, pose = os.path.join(dir_, 'clip.mp4'), os.path.join(dir_, 'pose.json')
        write_clip(clip)
        json.dump(sequence(), open(pose, 'w'))
        fails = check(dir_, clip, pose, mutant)
        print(f'bar 5{" (MUTANT: --no-cover-check as the setting)" if mutant else ""}: {"PASS" if not fails else "FAIL"}')
        for f in fails:
            print(f'  FAIL  {f}')
        if mutant:
            return 1 if fails else 0
        planted = check(dir_, clip, pose, True)
        covered_fail = [f for f in planted if 'a hand in front with the wrist on it, yet a line was read' in f]
        print(f'planted (--no-cover-check): the covered case {"fails as it must" if covered_fail else "DOES NOT FAIL"} '
              f'({len(covered_fail)} covered frame(s) read through the hand)')
        for f in planted[:6]:
            print(f'  planted  {f}')
        rf = refusals(dir_, clip)
        for f in rf:
            print(f'  FAIL  refusal {f}')
        ok = not fails and bool(covered_fail) and not rf
        print('pelvis_selftest:', 'PASS' if ok else 'FAIL')
        return 0 if ok else 1
    finally:
        if keep is None:
            shutil.rmtree(dir_, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
