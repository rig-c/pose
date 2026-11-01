---
name: rig-pose
description: Clean and retarget a body-18 (or COCO-17) pose sequence onto a rig built by rig-c or @rig-c/parts — bone rotate keys, hip translate keys, leg foreshortening, alternate-drawing switches and skirt-physics fitting — with rig-pose, which gates the result through rigc and verifies every bone's world landing before writing. Use for any request to put a walk, run, dance or video motion onto a 2D rig, to run or read rig-pose clean, pelvis, retarget, compare, cloth, convert or extract, or to write or fix a rig-pose-map/1 or rig-pose-sequence/1 file. Not for extracting keypoints from video, authoring key-pose animations by hand (that is the rigc-motion skill), or rigging a painting into parts (that is the rig-parts skill).
license: MIT
compatibility: Requires Bun 1.4 or later. The canonical npm package is @rig-c/pose (npm i -D @rig-c/pose, or bun add -d @rig-c/pose; rig-pose is the convenience install name); the command it installs is rig-pose, and @rig-c/core (rigc) comes as a dependency.
---

# rig-pose — pose retargeting for agents

Load this when the request puts **joint motion over time onto an existing rig**:
a body-18 (or COCO-17) pose sequence in picture pixels (`y` down), a joint map
(`rig-pose-map/1`) naming the rig's bone chains, and one animation in rig-c's
motion format coming back. Every rule below is owned by
[docs/REFERENCE.md](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md);
this file says when to open it and what it will not do for you.

## Non-negotiables

- **Clean before retarget, and never bypass the gate.** `retarget` refuses an
  uncleaned sequence (`POSE_NOT_CLEANED`), gates the rig with the animation in
  through `rigc`, verifies every mapped bone's world landing (`POSE_LANDS`), and
  writes nothing on a red gate — [REFERENCE.md](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#what-it-does).
- **Everything resolves by name, and no value is invented.** A missing bone,
  slot, attachment, joint or non-parent-child chain is refused by name (`MAP_*`,
  `POSE_*`); the only substitutions are the four stated ones (`HOLD`, `SHORT`,
  `FLIP`, `RANGE`), each printed on its own line — [REFERENCE.md](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#what-it-does).
- **The messages and the report are the instructions.** Every `FAIL  <CODE>:`
  line names the chain, bone, frame and angle, and the report
  (`rig-pose-report/1`) records holds, short/end-on runs, flips, uncovered folds
  and seams that call for an alternate drawing or flag adjustment — [REFERENCE.md](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#what-it-does).
- **Match the approach to the figure and the motion.** A mannequin or SD figure
  takes a full retarget; intense motion (run, dance) on a designed character
  needs replacement or frame parts placed with `alternates` and `bind`, not one
  drawing bent through large angles — [REFERENCE.md](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#choosing-the-approach).

## The loop

```sh
# Optional before clean: read pelvis tilt off drawn PNG frames or hand keys
rig-pose pelvis --pose raw.scan.json --frames frames/ --out pelvis.scan.json [--mode silhouette|waistband|below-cover]
rig-pose pelvis --pose raw.scan.json --pelvis-keys pelvis.keys.json --out pelvis.scan.json

# 1. Clean detector shake (writes <out>.figure-scale.json beside <out>; --coco converts COCO-17 first)
rig-pose clean --pose raw.scan.json --out clean.pose.json [--loop] [--depth walk|run] [--coco]

# 2. Retarget onto the rig and gate through rigc
rig-pose retarget --rig out/rig --map map.json --sequence clean.pose.json --out motion.json --animation dance [--build build-dir] [--report report.json]

# 3. Compare source and rendered pose sequences (or cloth tracks) on one time base
rig-pose compare --reference clean.pose.json --render render.pose.json --map map.json [--retarget-report report.json] [--report compare.json] [--sheet compare.png]
```

Other commands: `rig-pose convert --coco <in.json> --out <pose.json>` converts
COCO-17 without cleaning; `rig-pose cloth` measures a `rig-c-cloth-track/0`
from `--rig` or `--frames` + `--pose`; `rig-pose extract --model <skeleton.model.json> --map <extract-map.json> --animation <name> --fps <n> [--loop] --out <pose.json>`
reads observed body-18 landmarks from a compiled rig (`rig-pose-extract-map/1`). `rig-pose <command> --help`
prints the installed flag table.

## What this will not do

- Extract poses from video or track the camera (the input is joint positions;
  `clean` warns `CAMERA_UNDECLARED` when figure-scale spread exceeds 10% without
  a declared `camera`) — [What it does not do](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#what-it-does-not-do).
- Turn a 2D drawing in 3D or read crossing depth from pixels (depth comes from
  segment foreshortening via `clean --depth walk|run`; turns past what
  `--leg-scale` can show switch to `alternates`).
- Key blinks, mouth shapes, hands or fingers (combine with the `rigc-face` skill
  or `retarget --merge`).

## Read, in this order

1. [docs/REFERENCE.md](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md) —
   [choosing the approach](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#choosing-the-approach),
   [what the rig needs](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#what-the-rig-needs),
   [`clean`](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#clean-first-rig-pose-clean),
   [`pelvis`](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#the-pelvis-track-rig-pose-pelvis),
   [derived depth](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#derived-depth-clean---depth),
   [`retarget` and its flags](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#what-it-does),
   [the pose format](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#the-pose-rig-pose-sequence1),
   [the map and `alternates`](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#the-map-rig-pose-map1),
   [`compare` and its bars](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#compare-the-rigs-render-against-the-video),
   [`cloth`](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#measuring-a-cloth-track-rig-pose-cloth) and
   [`extract`](https://github.com/rig-c/pose/blob/main/docs/REFERENCE.md#extract-from-a-compiled-rig).
2. [RELEASING.md](https://github.com/rig-c/pose/blob/main/RELEASING.md#what-1x-promises) —
   promised versus courtesy commands, flags, formats, report fields and problem codes.
3. [docs/JOURNEY-gait.md](https://github.com/rig-c/pose/blob/main/docs/JOURNEY-gait.md) —
   the gait measurements behind the figure-versus-motion table.

`docs/` and `RELEASING.md` live in the GitHub repository and are not packed into
`node_modules/@rig-c/pose`; use the links above, and run `rig-pose --help` (or
`rig-pose <command> --help`) for the installed version's flags on disk.
