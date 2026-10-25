#!/usr/bin/env python3
"""Pinned public accepted-baseline replay and source-skeleton/rig presentation.

No acquisition, source video, audio, new rig repair or motion authoring. Heavy
run/compose commands belong on the project's budgeted Nova pool. Output paths
are caller-owned and must be new; no other checkout is read.
"""
from pathlib import Path
import argparse
import bisect
import concurrent.futures
import hashlib
import html
import json
import math
import re
import shutil
import statistics
import subprocess
import sys
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'docs/demos/visible-retarget/inputs.json'
PIN = 'f8d86e3045c267171180efd2ac47604511f9cb62'
MODEL = 'a94c7cbee992acaf87c0e283efc1bbd44766441f791776064e929bd59a2f0e81'
NATIVE = 'b75fc5696ac468f3ea9f58cc892d79389d66bf6ce7aeb31428f95350b9121029'
MAP = '9dca5394f6c0cf9cc72e2456b53b41adf898b963a6081d9f6f9b3c2ad6191096'
SEQUENCE = '8713172431674a57caa8d7c3f452a05bf46ec8079ca368bb4cd9df7952c2edfd'
FRAME_COUNT, FPS, SIZE = 391, 30, (600, 540)
PANELS = ((12, 54, 282, 416), (306, 54, 282, 416))
RIG_BODY_PX, RIG_GROUND_Y, SCALE_HALF_WINDOW = 188.98, 379.90, 2
EDGES = [('r_shoulder','r_elbow'),('r_elbow','r_wrist'),('l_shoulder','l_elbow'),('l_elbow','l_wrist'),('r_hip','r_knee'),('r_knee','r_ankle'),('l_hip','l_knee'),('l_knee','l_ankle'),('r_shoulder','l_shoulder'),('r_hip','l_hip'),('r_shoulder','r_hip'),('l_shoulder','l_hip'),('neck','nose'),('nose','r_eye'),('nose','l_eye'),('r_eye','r_ear'),('l_eye','l_ear')]


def require(ok, code, text):
    if not ok:
        raise ValueError(f'{code}: {text}')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def fetch(out):
    manifest = json.loads(MANIFEST.read_text())
    require(manifest['commit'] == PIN and manifest['repository'] == 'rig-c/examples', 'INPUT_PIN', 'manifest is not the accepted public baseline')
    def one(row):
        rel = Path(row['path'])
        require(rel.parts[0] == 'dancer' and not rel.is_absolute() and '..' not in rel.parts, 'INPUT_PATH', str(rel))
        path = out / rel
        if not path.exists():
            url = f'https://raw.githubusercontent.com/rig-c/examples/{PIN}/' + urllib.parse.quote(row['path'], safe='/')
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            require(hashlib.sha256(data).hexdigest() == row['sha256'], 'INPUT_HASH', row['path'])
            require(hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() == row['gitBlob'], 'INPUT_BLOB', row['path'])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        require(path.stat().st_size == row['bytes'] and digest(path) == row['sha256'], 'INPUT_HASH', row['path'])
        return row
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(one, manifest['files']))
    write_json(out / 'fetch-receipt.json', {'repository': manifest['repository'], 'commit': PIN, 'files': rows, 'scope': 'dancer/ only; every exact byte verified'})
    return out / 'dancer'


def run_command(label, args, cwd, logs):
    logs.mkdir(parents=True, exist_ok=True)
    print('PIPELINE_COMMAND', label, json.dumps(args), flush=True)
    with (logs / (label + '.txt')).open('w') as stream:
        child = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in child.stdout:
            stream.write(line)
            stream.flush()
            print(line, end='', flush=True)
        code = child.wait()
    require(code == 0, 'COMMAND_EXIT', f'{label} exited {code}; see logs/{label}.txt')


def real_reader(path):
    result = subprocess.run(['bun', str(ROOT / 'tools/visible-retarget-check.ts'), str(path)], capture_output=True, text=True)
    require(result.returncode == 0, 'POSE_READER', result.stderr.strip())
    return json.loads(result.stdout)


def source_track(seq):
    ids = sorted({p['id'] for f in seq['frames'] for p in f['people']})
    require(len(ids) == 1, 'SOURCE_PERSON', f'one person required, found {ids}')
    times = [f['t'] for f in seq['frames']]
    require(len(times) >= 2 and all(math.isfinite(t) for t in times) and all(a < b for a, b in zip(times, times[1:])), 'SOURCE_TIME', 'strict finite sample times required')
    frames = []
    for f in seq['frames']:
        person = next((p for p in f['people'] if p['id'] == ids[0]), None)
        joints = {}
        if person is not None:
            for name, j in person['joints'].items():
                if j['state'] in ('observed', 'inferred', 'occluded') and 'at' in j and 'score' in j and j['score'] >= .3:
                    joints[name] = tuple(j['at'])
        frames.append(joints)
    return times, frames


def sample(times, frames, t):
    require(times[0] <= t <= times[-1], 'SOURCE_TIME', f'{t} lies outside [{times[0]}, {times[-1]}]')
    hi = min(bisect.bisect_right(times, t), len(times) - 1)
    lo = max(0, hi - 1)
    if t == times[hi]:
        lo = hi
    elif t == times[lo]:
        hi = lo
    weight = 0 if hi == lo else (t - times[lo]) / (times[hi] - times[lo])
    joints = {n: (p[0] + (frames[hi][n][0] - p[0]) * weight, p[1] + (frames[hi][n][1] - p[1]) * weight) for n, p in frames[lo].items() if n in frames[hi]}
    return joints, {'renderTime': t, 'sourceLo': lo, 'sourceHi': hi, 'weight': weight}


def source_view(frames):
    points = [p for f in frames for p in f.values()]
    require(len(points) > 0, 'SOURCE_VIEW', 'no scored positions to frame')
    left, right = min(p[0] for p in points), max(p[0] for p in points)
    top, bottom = min(p[1] for p in points), max(p[1] for p in points)
    require(right > left and bottom > top, 'SOURCE_VIEW', 'a positive two-dimensional extent is required')
    padx, pady = (right - left) * .05, (bottom - top) * .05
    return {'x': left - padx, 'y': top - pady, 'width': right - left + 2 * padx, 'height': bottom - top + 2 * pady}


def project(point, view, panel):
    x, y, width, height = panel
    scale = min(width / view['width'], height / view['height'])
    return (x + (width - view['width'] * scale) / 2 + (point[0] - view['x']) * scale,
            y + (height - view['height'] * scale) / 2 + (point[1] - view['y']) * scale)


def body_length(joints):
    require(all(k in joints for k in ('neck', 'r_hip', 'l_hip', 'r_ankle', 'l_ankle')), 'SOURCE_SCALE', 'body scale requires scored neck, hips and ankles')
    hx, hy = (joints['r_hip'][0] + joints['l_hip'][0]) / 2, (joints['r_hip'][1] + joints['l_hip'][1]) / 2
    return (math.hypot(joints['neck'][0] - hx, joints['neck'][1] - hy) +
            (math.hypot(joints['r_hip'][0] - joints['r_ankle'][0], joints['r_hip'][1] - joints['r_ankle'][1]) +
             math.hypot(joints['l_hip'][0] - joints['l_ankle'][0], joints['l_hip'][1] - joints['l_ankle'][1])) / 2)


def smooth_series(values, half_width=SCALE_HALF_WINDOW):
    return [sum(values[max(0, i - half_width):min(len(values), i + half_width + 1)]) /
            (min(len(values), i + half_width + 1) - max(0, i - half_width))
            for i in range(len(values))]


def normalize_source_display(frames, panel=PANELS[0], half_width=SCALE_HALF_WINDOW):
    require(len(frames) > 0, 'SOURCE_SCALE', 'no sampled source frames to normalize')
    lengths = [body_length(f) for f in frames]
    grounds = [max(f['r_ankle'][1], f['l_ankle'][1]) for f in frames]
    centers = [(f['r_hip'][0] + f['l_hip'][0]) / 2 for f in frames]
    require(all(l > 0 for l in lengths), 'SOURCE_SCALE', 'positive per-frame body length required')
    ref_l, ref_g, ref_cx = statistics.median(lengths), statistics.median(grounds), statistics.median(centers)
    smooth_l, smooth_g = smooth_series(lengths, half_width), smooth_series(grounds, half_width)
    normalized = [{n: (ref_cx + (p[0] - ref_cx) * (ref_l / sl), ref_g + (p[1] - sg) * (ref_l / sl)) for n, p in f.items()}
                  for f, sl, sg in zip(frames, smooth_l, smooth_g)]
    xs = [p[0] for f in normalized for p in f.values()]
    mid_x = (min(xs) + max(xs)) / 2
    x0, y0, width, height = panel
    scale = RIG_BODY_PX / ref_l
    view = {'x': mid_x - (width / 2) / scale, 'y': ref_g - (RIG_GROUND_Y - y0) / scale, 'width': width / scale, 'height': height / scale}
    projected = [{n: project(p, view, panel) for n, p in f.items()} for f in normalized]
    require(all(x0 < p[0] < x0 + width and y0 < p[1] < y0 + height for f in projected for p in f.values()), 'SOURCE_VIEW', 'normalized source view cropped a joint')
    drawn_l = [body_length(f) for f in projected]
    require((max(drawn_l) - min(drawn_l)) / min(drawn_l) <= .05 and abs(statistics.median(drawn_l) - RIG_BODY_PX) / RIG_BODY_PX <= .05,
            'SOURCE_SCALE_BAR', 'normalized source body length exceeded the 5% bar')
    return normalized, view


def native_digest(render):
    paths = sorted(render.glob('f*.png'))
    require([p.name for p in paths] == [f'f{i:04d}.png' for i in range(FRAME_COUNT)], 'NATIVE_FRAMES', 'expected exact f0000..f0390 inventory')
    h = hashlib.sha256()
    for path in paths:
        h.update(path.read_bytes())
    require(h.hexdigest() == NATIVE, 'NATIVE_HASH', 'native PNG bytes differ from accepted v3; no correction attempted')
    return h.hexdigest()


def verify_replay(corpus, replay):
    declared = json.loads((corpus / 'declared-repairs-v3.json').read_text())
    config = json.loads((corpus / 'config.json').read_text())
    require(config['x-repairs'] == {'file': 'declared-repairs-v3.json', 'sha256': digest(corpus / 'declared-repairs-v3.json')}, 'REPAIRS_PIN', 'current config metadata does not bind v3')
    proof = json.loads((replay / 'reproduction.json').read_text())
    require(proof['version'] == 'v3' and proof['stage'] == 'render' and proof['build'] == declared['render']['build'] == proof['expectedBuild'], 'REPRODUCTION_HASH', 'accepted compiled hashes differ')
    for name, expected in declared['render']['build'].items():
        require(digest(replay / 'build' / name) == expected, 'BUILD_HASH', name)
    require(digest(replay / 'build/skeleton.model.json') == MODEL, 'MODEL_HASH', 'accepted model differs')
    for name in ('rig', 'motion'):
        row = declared['canonical'][name]
        require(digest(corpus / row['file']) == row['sha256'] == digest(replay / f'hand/v3/{name}.json'), 'CANONICAL_HASH', name)
    require(digest(corpus / 'map.json') == MAP, 'MAP_HASH', 'source map differs')
    require(digest(corpus / 'accepted/sequence.json') == SEQUENCE, 'SEQUENCE_HASH', 'source sequence differs')
    require(proof['framesSHA256'] == proof['expectedFramesSHA256'] == NATIVE, 'NATIVE_RECORD', 'accepted native record differs')
    native_digest(replay / 'render/zero-two-r3-hand@30fps')
    require(digest(replay / 'work/runtime/bun.lock') == digest(corpus / 'accepted-dance/bun.lock'), 'LOCK_HASH', 'reused runtime lock differs')
    for package, version in declared['pins'].items():
        if package == 'bun':
            found = subprocess.check_output(['bun', '--version'], text=True).strip()
        else:
            found = json.loads((replay / 'work/runtime/node_modules' / package / 'package.json').read_text())['version']
        require(found == version, 'RUNTIME_PIN', f'{package}: {found}, required {version}')
    require((replay / 'logs/build.txt').is_file(), 'GATE_LOG', 'actual accepted build log required')
    return proof


def diagnostic_render(corpus, replay, out):
    require(not out.exists(), 'OUTPUT_EXISTS', 'diagnostic output must be new')
    core = replay / 'work/runtime/node_modules/rig-c/cli.ts'
    run_command('v3-fold-render', ['bun', str(core), 'render', '--candidate', str(replay / 'build'), '--animation', 'zero-two-r3-hand', '--fps', '30', '--folds', '--viewport-from', str(corpus / 'accepted-dance/viewport.json'), '--out', str(out)], ROOT, out.parent / 'logs')
    metadata = json.loads((out / 'frames.json').read_text())
    sets = [s for s in metadata['sets'] if s['animation'] == 'zero-two-r3-hand']
    require(len(sets) == 1 and sets[0]['fps'] == FPS and sets[0]['written'] == FRAME_COUNT and sets[0]['duration'] == 13, 'RENDER_TIME', 'v3 time base differs')
    require(metadata['viewport'] == json.loads((corpus / 'accepted-dance/viewport.json').read_text())['viewport'], 'RIG_VIEW', 'fixed viewport differs')
    native_digest(out / sets[0]['dir'])
    return out / 'frames.json'


def stage_record(corpus, replay, render, diagnostic_log):
    history_path = ROOT / 'docs/demos/visible-retarget/historical-stages.json'
    history = json.loads(history_path.read_text())
    require(history['landings'] == 20 and history['allWithinTolerance'], 'HISTORICAL_LAND', 'historical pre-hand record differs')
    gate_text = (replay / 'logs/build.txt').read_text()
    summary = re.search(r'50 assertions: 23 measured \(23 passed, 0 failed\), 13 skipped, 14 not in profile "spine"', gate_text)
    require(summary is not None, 'V3_GATE', 'actual accepted v3 build did not pass recorded gate')
    gate_lines = [l for l in gate_text.splitlines() if re.match(r'^\s*(PASS|SKIP|PROF)\s', l)]
    folds = json.loads((render / 'folds.json').read_text())
    require(folds['spec'] == 'rigc-folds/1', 'FOLD_FORMAT', 'expected actual renderer fold reading')
    indices = sorted({f['index'] for mesh in folds['meshes'] if mesh['slot'] == 'shins' for f in mesh['frames']})
    require(len(indices) == 269, 'FOLD_CARD_CONTRADICTION', f'current v3 shins {len(indices)}/391 differs from card269/391; report without tuning')
    fold_lines = [l for l in diagnostic_log.read_text().splitlines() if re.match(r'^\s*\.\.\s+folds\s', l)]
    require(any('slot "shins"' in l for l in fold_lines), 'FOLD_LINES', 'actual raw shins fold line missing')
    diagnostics = ('HISTORICAL V1 PRE-HAND RETARGET — original pose targets; not newly measured v3 LAND\n' + '\n'.join(history['rawLines']) +
                   '\n\nV3 ACCEPTED CORE GATE — verified matching accepted build; reused raw build log\n' + '\n'.join(gate_lines) + '\n' + summary.group(0) +
                   '\n\nV3 FOLD — freshly measured on unchanged accepted model; NOT green\n' + '\n'.join(fold_lines) + '\n')
    require(re.search(r'/(Users|home)/', diagnostics) is None, 'PUBLIC_PATH', 'diagnostic selection retained a private path')
    result = {'historicalPreHandRetarget': {'landings': 20, 'allWithinTolerance': True, 'scope': history['scope'], 'recordSHA256': digest(history_path), 'corpusCommit': history['corpusCommit']},
              'acceptedV3Gate': {'pass': 23, 'failed': 0, 'skip': 13, 'excluded': 14, 'scope': 'Actual accepted v3 build log; reused with exact source/model/native/runtime verification', 'rawBuildLogSHA256': digest(replay / 'logs/build.txt')},
              'currentV3Fold': {'slot': 'shins', 'foldedFrames': len(indices), 'sampledFrames': FRAME_COUNT, 'indices': indices, 'scope': 'Fresh current-v3 diagnostic', 'status': 'known fold; NOT green', 'foldsSHA256': digest(render / 'folds.json')},
              'historicalV1Fold': history['historicalV1Fold'], 'historicalPosthocFootGoal': history['historicalPosthocFootGoal'],
              'notMeasured': ['Original-pose LAND after hand edits', 'New v3 foot-goal residual', 'All-rig SEAM', 'Detector-based compare'], 'loop': False, 'loopSeam': 'N/A — not a loop'}
    return result, diagnostics


def compose(corpus, replay, media, reuse_diagnostic=None):
    from PIL import Image, ImageDraw, ImageFont, __version__ as pillow_version
    require(pillow_version == '12.2.0', 'PILLOW_PIN', f'expected 12.2.0, found {pillow_version}')
    sequence_path = corpus / 'accepted/sequence.json'
    require(digest(sequence_path) == SEQUENCE, 'SEQUENCE_HASH', 'accepted source sequence changed')
    checked = real_reader(sequence_path)
    require(checked['frames'] == 313 and checked['cameraDeclared'], 'SOURCE_READER', 'expected the declared-camera 313-sample accepted sequence')
    seq = json.loads(sequence_path.read_text())
    times, frames = source_track(seq)
    require(times[0] == 0 and times[-1] == 13, 'SOURCE_TIME', 'the baseline take must cover 0..13 seconds')
    verify_replay(corpus, replay)
    if reuse_diagnostic is None:
        viewport_path = diagnostic_render(corpus, replay, media.parent / (media.name + '-diagnostic'))
    else:
        # Reuse only the exact accepted diagnostic already bound in the public record.
        expected = json.loads((ROOT / 'docs/demos/visible-retarget/record.json').read_text())
        require(expected['acceptedModelSHA256'] == MODEL and expected['acceptedNativeFramesSHA256'] == NATIVE, 'DIAGNOSTIC_PIN', 'published diagnostic belongs to a different build')
        viewport_path = reuse_diagnostic / 'frames.json'
    metadata = json.loads(viewport_path.read_text())
    sets = [s for s in metadata['sets'] if s['animation'] == 'zero-two-r3-hand']
    require(len(sets) == 1 and sets[0]['fps'] == FPS and sets[0]['written'] == FRAME_COUNT and sets[0]['duration'] == 13, 'RENDER_TIME', 'the accepted render time base changed')
    render = viewport_path.parent / sets[0]['dir']
    if reuse_diagnostic is not None:
        require(digest(render / 'folds.json') == expected['stages']['currentV3Fold']['foldsSHA256'], 'DIAGNOSTIC_HASH', 'reused fold measurement differs from the published record')
    require(digest(replay / 'build/skeleton.model.json') == MODEL, 'MODEL_HASH', 'final accepted model differs')
    require(metadata['viewport'] == json.loads((corpus / 'accepted-dance/viewport.json').read_text())['viewport'], 'RIG_VIEW', 'accepted fixed viewport differs')
    native_digest(render)
    diagnostic_log = viewport_path.parent.parent / 'logs/v3-fold-render.txt'
    stages, diagnostics = stage_record(corpus, replay, render, diagnostic_log)
    media.mkdir(parents=True)
    (media / 'diagnostics.txt').write_text(diagnostics)
    font = ImageFont.load_default(size=13)
    small = ImageFont.load_default(size=11)
    frame_dir = media / 'frames'
    frame_dir.mkdir()
    sampling = []
    raw_samples = []
    for i in range(FRAME_COUNT):
        joints, alignment = sample(times, frames, i / FPS)
        raw_samples.append(joints)
        sampling.append({'renderFrame': i, **alignment})
    display_samples, view = normalize_source_display(raw_samples, PANELS[0])
    sheet_indices = [0, 30, 90, 170, 220, 338, 374, 390]
    thumbs = []
    native = (metadata['viewport']['pixelWidth'], metadata['viewport']['pixelHeight'])
    for i, joints in enumerate(display_samples):
        canvas = Image.new('RGB', SIZE, (245, 246, 248))
        draw = ImageDraw.Draw(canvas)
        draw.text((12, 8), 'Dance retarget: source pose beside the rig', fill='#152233', font=font)
        draw.text((12, 30), 'Source pose (scale-normalized, display only)', fill='#273646', font=small)
        draw.text((306, 30), 'Rig', fill='#273646', font=small)
        for x, y, w, h in PANELS:
            draw.rectangle((x, y, x + w - 1, y + h - 1), fill=(232, 232, 232), outline='#aab0b8')
        for a, b in EDGES:
            if a in joints and b in joints:
                colour = '#cb4c37' if a.startswith('r_') else '#326eae' if a.startswith('l_') else '#53616c'
                draw.line((project(joints[a], view, PANELS[0]), project(joints[b], view, PANELS[0])), fill=colour, width=3)
        for point in joints.values():
            x, y = project(point, view, PANELS[0]); draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill='#152233')
        with Image.open(render / f'f{i:04d}.png') as rig:
            require(rig.size == native, 'RIG_FRAME_SIZE', f'frame {i} has {rig.size}, expected {native}')
            rig = rig.convert('RGB')
            x, y, w, h = PANELS[1]; k = min(w / rig.width, h / rig.height)
            rig = rig.resize((round(rig.width * k), round(rig.height * k)), Image.Resampling.LANCZOS)
            canvas.paste(rig, (x + (w - rig.width) // 2, y + (h - rig.height) // 2))
        draw = ImageDraw.Draw(canvas)
        draw.text((12, 480), f't={i/FPS:.3f}s', fill='#253444', font=font)
        canvas.save(frame_dir / f'f{i:04d}.png')
        if i == 0: canvas.save(media / 'pose-dance.png')
        if i in sheet_indices: thumbs.append(canvas.resize((300, 270), Image.Resampling.LANCZOS))
    sheet = Image.new('RGB', (1200, 540), '#ffffff')
    for j, thumb in enumerate(thumbs): sheet.paste(thumb, ((j % 4) * 300, (j // 4) * 270))
    sheet.save(media / 'contact-sheet.png')
    write_json(media / 'sampling.json', sampling)
    ffmpeg = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', str(FPS), '-start_number', '0', '-i', 'frames/f%04d.png', '-frames:v', str(FRAME_COUNT), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', '4', '-filter_threads', '1', '-movflags', '+faststart', 'pose-dance.mp4']
    run_command('encode', ffmpeg, media, media / 'logs')
    webm = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', 'pose-dance.mp4', '-an', '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-threads', '4', '-row-mt', '1', 'pose-dance.webm']
    run_command('encode-webm', webm, media, media / 'logs')
    probe = subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', 'pose-dance.mp4'], cwd=media, text=True)
    metadata_video = json.loads(probe); videos = [s for s in metadata_video['streams'] if s['codec_type'] == 'video']
    require(len(videos) == 1 and not any(s['codec_type'] == 'audio' for s in metadata_video['streams']), 'MEDIA_STREAMS', 'one silent video stream required')
    video = videos[0]
    require((video['width'], video['height']) == SIZE and int(video['nb_frames']) == FRAME_COUNT and video['avg_frame_rate'] == '30/1', 'MEDIA_TIME', 'encoded video dimensions/frame count/rate changed')
    require(abs(float(metadata_video['format']['duration']) - FRAME_COUNT / FPS) < .002, 'MEDIA_DURATION', 'encoded duration differs from inclusive 391-frame take')
    write_json(media / 'ffprobe.json', metadata_video)
    runtime = {'bun': subprocess.check_output(['bun', '--version'], text=True).strip(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'python': sys.version.split()[0]}
    for package, version in [('@rig-c/pose', '1.0.1'), ('rig-c', '2.67.2'), ('@esotericsoftware/spine-core', '4.3.13')]:
        installed = json.loads((replay / 'work/runtime/node_modules' / package / 'package.json').read_text())['version']
        require(installed == version, 'RUNTIME_PIN', f'{package}: {installed}, expected {version}')
        runtime[package] = installed
    result = {'spec': 'rig-pose-visible-retarget/1', 'runtime': runtime, 'baselineDate': '2026-10-24', 'purpose': 'Accepted v3 visible demo; site publication belongs to HQ sibling PR',
              'source': {'repository': 'rig-c/examples', 'commit': PIN, 'sequenceSHA256': SEQUENCE, 'mapSHA256': MAP, 'camera': 'Already normalized picture coordinates; never applied again', 'frames': 313, 'declaredFPS': 24},
              'acceptedModelSHA256': MODEL, 'acceptedNativeFramesSHA256': NATIVE, 'render': {'frames': FRAME_COUNT, 'fps': FPS, 'lastSampleSeconds': 13, 'encodedDurationSeconds': float(metadata_video['format']['duration']), 'viewport': metadata['viewport']},
              'presentation': {'width': SIZE[0], 'height': SIZE[1], 'sourceViewport': view, 'panels': PANELS, 'rule': 'One fixed view per panel across the whole clip. Independent picture/world views, not a shared metric space.'},
              'alignment': {'rule': 'At render time i/30, linear interpolation between actual source timestamps; exact timestamp uses itself; a joint missing/low-scored/unscored at either endpoint is omitted, not filled', 'samplingFile': 'sampling.json', 'cameraAppliedAgain': False},
              'stages': stages, 'encodeCommand': ffmpeg, 'webmCommand': webm, 'pillow': pillow_version, 'ffmpeg': subprocess.check_output(['ffmpeg','-version'], text=True).splitlines()[0],
              'media': {name: {'bytes': (media/name).stat().st_size, 'sha256': digest(media/name)} for name in ['pose-dance.mp4','pose-dance.webm','pose-dance.png','contact-sheet.png','diagnostics.txt','sampling.json']}}
    write_json(media / 'record.json', result)
    preview = '''<!doctype html><html lang="en"><meta charset="utf-8"><title>Accepted v3 visible demo</title><style>body{margin:20px;font:14px system-ui;background:#fff;color:#172636}main{width:600px}video{display:block;width:600px;height:540px}pre{white-space:pre-wrap;font-size:11px}strong{color:#8b3b14}</style><main><h1>Accepted v3 visible demo</h1><p><strong>Site handoff preview.</strong> Exact accepted v3 source; HQ owns site publication. A 13s take, not a loop; seam N/A.</p><video id="baseline" controls muted playsinline preload="metadata" width="600" height="540" poster="pose-dance.png"><source src="pose-dance.mp4" type="video/mp4"></video><p>Source skeleton beside unchanged accepted rig. Independent fixed picture/world views. Source313@24; render391@30. Historical pre-hand LAND20/20 is separate from the accepted v3 gate and fresh v3 FOLD269/391. No new original-pose LAND or foot-goal residual is claimed.</p><pre>''' + html.escape(diagnostics) + '</pre></main></html>'
    (media / 'preview.html').write_text(preview)
    print('VISIBLE_RETARGET_RECORD', json.dumps(result), flush=True)
    return result


def selftest(out):
    out.mkdir(parents=True, exist_ok=True)
    # Valid schemas go through the real reader before the compositor reads them.
    seq = {'spec':'rig-pose-sequence/1','space':{'units':'picture-px','origin':'top-left','y':'down'},'width':100,'height':200,'source':'visible-retarget synthetic timing control','camera':[{'s':1,'tx':0,'ty':0,'inliers':0} for _ in range(3)],'frames':[]}
    for i, t in enumerate([0, .5, 1]):
        seq['frames'].append({'t':t,'people':[{'id':'a','joints':{n:{'state':'observed','score':1,'at':[x+i*10,y]} for n,(x,y) in {'neck':(50,30),'r_shoulder':(30,30),'l_shoulder':(70,30),'r_hip':(40,90),'l_hip':(60,90)}.items()}}]})
    path = out/'valid.json'; write_json(path,seq); require(real_reader(path)['frames']==3,'TEST_READER','valid fixture refused')
    times, frames = source_track(seq)
    require(sample(times,frames,.25)[0]['neck'] == (55,30), 'TEST_ALIGNMENT', 'midpoint interpolation must be five px, not nearest/shifted')
    require(sample(times,frames,0)[1]['sourceLo']==0 and sample(times,frames,1)[1]['sourceLo']==2, 'TEST_ENDPOINT', 'exact endpoints must map to themselves')
    view = source_view(frames)
    for f in frames:
        for point in f.values():
            x,y=project(point,view,PANELS[0]); require(12<x<294 and 54<y<470,'TEST_VIEW','fixed source view cropped a fixture point')
    seq['frames'][1]['people'][0]['joints']['neck']={'state':'missing'};write_json(path,seq);real_reader(path)
    times,frames=source_track(seq);require('neck' not in sample(times,frames,.25)[0],'TEST_MISSING','a missing endpoint was invented')
    try: sample(times,frames,1.01)
    except ValueError as e: require(str(e).startswith('SOURCE_TIME:'),'TEST_UNKNOWN',str(e))
    else: raise ValueError('TEST_UNKNOWN: out-of-time sample silently held')
    seq['frames'][1]['t']=0;write_json(path,seq)
    refused=subprocess.run(['bun',str(ROOT/'tools/visible-retarget-check.ts'),str(path)],capture_output=True,text=True)
    require(refused.returncode != 0 and 'POSE_TIME' in refused.stderr, 'TEST_TIME_REFUSAL', 'real reader did not reject duplicate times')
    zoom_frames = [{'neck': (500, 900 - 350 * z + d), 'r_hip': (460, 900 + d), 'l_hip': (540, 900 + d), 'r_ankle': (460, 900 + 550 * z + d), 'l_ankle': (540, 900 + 550 * z + d)}
                   for z, d in [(1.0, 0), (1.01, 10), (1.02, 20), (1.03, 30), (1.04, 40)]]
    norm_zoom, zoom_view = normalize_source_display(zoom_frames, PANELS[0])
    proj_zoom = [{n: project(p, zoom_view, PANELS[0]) for n, p in f.items()} for f in norm_zoom]
    require(abs(statistics.median([body_length(f) for f in proj_zoom]) - RIG_BODY_PX) < 1e-6 and abs(statistics.median([max(f['r_ankle'][1], f['l_ankle'][1]) for f in proj_zoom]) - RIG_GROUND_Y) < 1e-6,
            'TEST_SCALE_MATCH', 'normalized fixture did not match rig body length and ground line')
    write_json(out/'selftest.json',{'realReaderValid':True,'interpolation':True,'endpoints':True,'fixedViewport':True,'missingJointNotInvented':True,'outOfTimeRefused':True,'realReaderBadTimeRefused':True,'scaleNormalizedToRig':True})
    print('VISIBLE_RETARGET_SELFTEST PASS: real-reader, alignment/endpoints, fixed view, scale normalization, missing joints, planted bad time',flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['run','fetch','selftest','compose'])
    parser.add_argument('--out',required=True)
    parser.add_argument('--source',help='Previously fetched, hash-verified source/dancer for compose')
    parser.add_argument('--replay',help='Completed accepted v3 replay for compose')
    parser.add_argument('--reuse-diagnostic', help='Read-only diagnostic render matching the published fold hash, accepted viewport/time base and native PNG digest')
    parser.add_argument('--reuse-replay',help='Read-only accepted v3 replay cache; exact canonical/build/native/runtime verification required')
    args=parser.parse_args();out=Path(args.out).resolve()
    if args.command=='selftest': selftest(out);return
    if args.command=='fetch': fetch(out);return
    require(not out.exists(),'OUTPUT_EXISTS','choose a new output path; existing evidence is preserved')
    if args.command=='compose':
        require(args.source is not None and args.replay is not None,'COMPOSE_INPUT','--source and --replay are required')
        corpus=Path(args.source).resolve();replay=Path(args.replay).resolve()
        compose(corpus,replay,out,Path(args.reuse_diagnostic).resolve() if args.reuse_diagnostic else None);return
    out.mkdir(parents=True)
    corpus=fetch(out/'source')
    checked=real_reader(corpus/'accepted/sequence.json');write_json(out/'reader-preflight.json',checked)
    if args.reuse_replay:
        replay=Path(args.reuse_replay).resolve()
    else:
        replay=out/'replay'
        run_command('accepted-reproduction',['sh',str(corpus/'build-accepted-dance.sh'),str(replay)],ROOT,out/'logs')
    verify_replay(corpus,replay)
    compose(corpus,replay,out/'media',Path(args.reuse_diagnostic).resolve() if args.reuse_diagnostic else None)


if __name__ == '__main__':
    main()
