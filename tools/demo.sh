#!/usr/bin/env bash
# The README demo: a pose sequence retargeted onto a rig, then the source video
# and the rig side by side as a clip and as a contact sheet. Not shipped.
#
#   tools/demo.sh --rig <rig dir> --map <map.json> --pose <pose.json> --video <video> --out <dir> \
#                 [--name dance] [--height 480] [--sheet-times "0,1.08,…"] [-- <extra retarget flags>]
#
# Writes into --out: motion.json, report.json and run.txt (the retarget's own
# output), build/ (the gated build), render/ (rigc's frames at the pose's frame
# rate), clip.mp4 and clip.gif (video | rig), sheet.png (video | rig at the
# sheet times, 6 per row), and demo.json (what was run, on what, with which
# versions and digests).
#
# Needs bun, ffmpeg and ffprobe. The video and the rig are the caller's; this
# script copies neither into the repository.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
name=dance
height=480
times="0,1.08,2.17,3.25,4.33,5.42,6.5,7.58,8.67,9.75,10.83,11.92"
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rig) rig="$2"; shift 2 ;;
    --map) map="$2"; shift 2 ;;
    --pose) pose="$2"; shift 2 ;;
    --video) video="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --height) height="$2"; shift 2 ;;
    --sheet-times) times="$2"; shift 2 ;;
    --) shift; extra=("$@"); break ;;
    *) echo "demo.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
for v in rig map pose video out; do
  if [ -z "${!v:-}" ]; then echo "demo.sh: --$v is required" >&2; exit 2; fi
done
for tool in bun ffmpeg ffprobe; do
  command -v "$tool" > /dev/null || { echo "demo.sh: $tool is not on PATH" >&2; exit 2; }
done

mkdir -p "$out"
out="$(cd "$out" && pwd)"
rm -rf "$out/build" "$out/render" "$out/hi" "$out/vid" "$out/rig"

# 1. The retarget, gated — its own lines are the record of the run.
bun "$here/cli.ts" retarget --rig "$rig" --map "$map" --pose "$pose" --out "$out/motion.json" --name "$name" \
  --build "$out/build" --render "$out/render" --report "$out/report.json" ${extra[@]+"${extra[@]}"} | tee "$out/run.txt"

# 2. The rig at the pose's own frame rate, larger than the gate's reading.
fps=$(bun -e "const r=JSON.parse(require('fs').readFileSync('$out/report.json','utf8'));const n=r.frames,d=r.duration;console.log(n>1?Math.round((n-1)/d):12)")
bun "$here/node_modules/rig-c/bin/rigc.cjs" render --candidate "$out/build" --animation "$name" --fps "$fps" --max $((height * 2)) --out "$out/hi" > "$out/render-hi.txt"
# The set's directory is rigc's to name (\`dance@24fps\` off its default rate): read it from frames.json.
setdir="$out/hi/$(bun -e "const f=JSON.parse(require('fs').readFileSync('$out/hi/frames.json','utf8'));console.log(f.sets.find(s=>s.animation==='$name').dir)")"
frames=$(ls "$setdir"/f*.png | wc -l | tr -d ' ')

# 3. The video at the same frame rate, from its first frame — the pose's t = 0.
mkdir -p "$out/vid" "$out/rig"
ffmpeg -loglevel error -y -i "$video" -vf "fps=$fps,scale=-2:$height" -frames:v "$frames" "$out/vid/v%04d.png"
# The rig's frames flattened onto white at the same height. The white is drawn
# on a copy of each frame, not taken from a \`color\` source: a source runs on
# its own clock (25 fps by default) and overlaying onto it re-times the frames —
# measured: the rig ran visibly behind the video by 7.6 s.
ffmpeg -loglevel error -y -framerate "$fps" -i "$setdir/f%04d.png" \
  -filter_complex "[0:v]scale=-2:$height,format=rgba,split[a][b];[a]drawbox=c=white:t=fill[w];[w][b]overlay=format=auto,format=rgb24" \
  -frames:v "$frames" -start_number 0 "$out/rig/r%04d.png"

# 4. The clip: video | rig.
ffmpeg -loglevel error -y -framerate "$fps" -i "$out/vid/v%04d.png" -framerate "$fps" -start_number 0 -i "$out/rig/r%04d.png" \
  -filter_complex "[0:v][1:v]hstack=inputs=2,format=yuv420p" -c:v libx264 -crf 20 -movflags +faststart "$out/clip.mp4"
ffmpeg -loglevel error -y -i "$out/clip.mp4" \
  -filter_complex "fps=12,scale=-2:$((height * 3 / 4)):flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
  "$out/clip.gif"

# 5. The sheet: the pair at each sheet time, six to a row.
select=""
count=0
for t in ${times//,/ }; do
  i=$(bun -e "console.log(Math.round($t * $fps))")
  if [ "$i" -ge "$frames" ]; then continue; fi
  select="${select:+$select+}eq(n\\,$i)"
  count=$((count + 1))
done
rows=$(( (count + 5) / 6 ))
ffmpeg -loglevel error -y -i "$out/clip.mp4" -vf "select='$select',tile=6x$rows:padding=4:color=white" -frames:v 1 -update 1 "$out/sheet.png"

# 6. What this was.
bun -e "
const fs=require('fs'),c=require('crypto');
const sha=(p)=>c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pkg=(p)=>JSON.parse(fs.readFileSync(p,'utf8')).version;
fs.writeFileSync('$out/demo.json', JSON.stringify({
  spec: 'rig-pose-demo/1',
  rigPose: pkg('$here/package.json'), rigC: pkg('$here/node_modules/rig-c/package.json'),
  rig: '$rig', map: { path: '$map', sha256: sha('$map') }, pose: { path: '$pose', sha256: sha('$pose') },
  video: { path: '$video', sha256: sha('$video') }, animation: '$name', fps: $fps, frames: $frames,
  sheetTimes: '$times'.split(',').map(Number),
}, null, 2) + '\n');
"
echo "demo: $out/clip.mp4, $out/clip.gif, $out/sheet.png ($frames frames at $fps fps)"
