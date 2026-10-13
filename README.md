# @rig-c/pose

Puts motion from a pose onto a rig. The motion is joint positions over time: from a video, a dataset, or points placed by hand. The rig is one [rig-c](https://github.com/rig-c/core) built. A body-18 pose sequence becomes bone keys in rig-c's motion format, and the keys are checked before anything is written.

**0.x is the prototype.** The format, the command and the output can change in any release until 1.0.

Part of the rig-c toolchain: [core](https://github.com/rig-c/core) compiles and gates a rig, [parts](https://github.com/rig-c/parts) builds one from a painting, [play](https://github.com/rig-c/play) plays it, and pose moves it.

<!-- demo -->

## Try it

[`examples/wave`](examples/wave) runs with nothing else: a bones-only stick rig (no art), a 3-second wave made from joint angles (`make-pose.ts` writes it), and the map that joins them.

```sh
rig-pose retarget --rig examples/wave/rig --map examples/wave/map.json --pose examples/wave/pose.json --out wave.motion.json --build wave-build
```

It prints the gate's verdict and where every mapped bone landed, then writes `wave.motion.json` and the gated build. `rigc preview --candidate wave-build` plays it in the Spine Web Player. A rig with no art shows only its bones.

## What it does

```sh
rig-pose retarget --rig out/rig --map map.json --pose dance.pose.json --out motion.json --name dance
```

For every frame of the pose and every bone the map names, the segment that bone carries (an upper arm: shoulder → elbow) points somewhere in the picture. The bone is turned so its segment points the same way: the picture angle, flipped into rig-c's y-up world, minus the bone's angle at the rig's setup pose (read through rig-c's own poser), less the turn of the mapped bone above it — because a `rotate` key in rig-c adds to the setup rotation and a child turns with its parent. The travel of the pelvis midpoint, scaled by a length measured on both the rig and the pose, moves the hip. The result is one animation in rig-c's motion format (`rigc-motion/1`): a `rotate` track per mapped bone, a `translate` track on the hip, one key per pose frame.

Nothing is written until every check passes:

| Check | Fails with |
| --- | --- |
| rig-c's gate is green with the rig as it is, and again with the animation in (`rigc build`) | `RIG_GATE_BASE`, `RIG_GATE`, then rigc's own `FAIL` lines |
| every mapped bone **lands** on the angle the pose asks for, on every frame — the gated build is posed by rig-c's poser and measured (0.01° / 0.01 units) | `POSE_LANDS`: the bone, the worst error, the frame |
| elbows and knees bend only the way they can: at every joint inside a chain, the inner angle stays on the side of the rest pose's | `POSE_BEND_ONE_WAY`: the chain, the joint, the frame, the angle |
| every point the map needs is good on at least one frame | `POSE_POINT_NEVER_GOOD` |
| the map resolves against the rig: bones exist, chains descend, aims descend | `MAP_*`, naming both sides |

and what the run cannot decide for you it lists:

- `HOLD` — a joint missing, or scored under `--min-score`, holds its last good value; one line per span, with the frames and the reason.
- `SHORT` — a segment shorter in the picture than `--short` of its median length (with `--short <fraction>`; off by default) has its angle there interpolated, not read; one line per span, with the chain, the segment, the frames and the lowest fraction. Below.
- `END-ON` — a `SHORT` run lasting at least 0.15 s: the limb points at the camera, a pose the rig cannot draw.
- `FLIP` — a segment that turns more than `--flip` degrees in one frame (with `--flip <deg>`; off by default) is spread over the frames around the jump; one line per spread, with the chain, the segment, the jump, the frames and h. Below.
- `BEND` — with `--bends clamp`, a hinge bent the wrong way is straightened on that frame instead of refusing.
- `FOLD` — `rigc render --folds` over the new animation: every mesh that folds, and when. A reading, not a gate.
- `POSTURE` — when the map has a pelvis chain (joints `r_hip`, `l_hip`) and a `translate`: the hip line's tilt range, and the sway — the x-range of mid_hip − mid_shoulder — in rig units and in shoulder widths, the pose's beside the posed rig's. A reading, not a gate.

`--smooth <n>` smooths each joint's positions, after its holds, with a Savitzky–Golay filter: at every frame, the least-squares cubic over the *n* frames around it (clipped at the ends), read at that frame. It is centred, so it moves no motion in time, and a cubic keeps the peaks a moving average flattens. `1` (the default) is none; otherwise *n* is odd and at least 5, since a cubic through 3 points passes through all three.

**Use `--smooth 7` at 24 fps.** It was measured on a 13 s dance on a @rig-c/parts rig, read back from the gated build: the motion's timing did not move (speed cross-correlation lag 0 on the wrists, ankles and hip), the frame-to-frame second difference dropped 2.5× on the wrists, 1.7–2.1× on the ankles and 1.5× on the hip, and the hip's 95th-percentile speed fell to 0.85×. The criterion set beforehand, a 2× drop on every point, was not met on the hip. That criterion was flawed: the hip's second difference is mostly real motion, while the filter cuts white noise 4.6×. A measure that isolates noise is a later card, and the default stays off until it passes.

**The flip guard.** A pose model can put a fast sweep of a limb into one frame — under motion blur it takes the elbow or the wrist for another point — and the rig then whips the limb round between two keys. Position smoothing cannot remove a step like that. So after holds and smoothing, and before the hinge check, every segment the map aims (not a `reach`, which is aimed later from posed positions) is read frame to frame: a turn greater than `--flip <deg>` from frame k−1 to frame k is spread. For the smallest h ≥ 1 that keeps every one-frame turn at or under the threshold, frames k−h … k+h−1 are replaced by the straight line from frame k−h−1 to frame k+h, the turn's own way round. It is centred, so the step happens when the pose put it, over 2h frames, and both ends keep the pose's angles. A window that would cross the first or last frame stops there and the line says so; two windows that overlap become one. `--flip off` keeps every turn. The report lists each spread under `flips`.

The threshold was fixed by measuring first ([#15](https://github.com/rig-c/pose/issues/15)). On the 13 s dance (313 frames, RTMPose), the one-frame turns of the picture angle of 10 segments — both upper arms, forearms, thighs and shins, the eye line and the hip line, 3,120 turns — run p50 1.0°, p90 5.0°, p99 23.1°, p99.5 33.4°, p99.9 78.2°, max 148.6°. 90° is the p99.9 rounded up past a margin, and marks the 3 turns above it (0.1%): both forearms between frames 181 and 182 (148.6° and 114.4°, a motion-blurred stretch) and the left forearm between 53 and 54 (99.2°, the forearm pointing at the camera). None of them is a spike that comes back: each keeps the direction the limb was already turning, and the new angle holds — a real sweep put into one frame. Holding the last angle would be wrong a frame later, so the guard spreads the step instead. With it, on the @rig-c/parts rig #11 measured, the largest one-frame turn of any guarded bone in the gated build, posed by rig-c, is 78.2° (148.6° without it), and every bone still lands.

Re-measured with the guard on, against the guarded unsmoothed run, on #11's criteria (power above 6 Hz down ≥ 2× on every point, timing lag 0, p95 speed ≥ 0.85×): no window passes. `--smooth 7` comes closest — the left wrist's power drops 1.99× and the hip's p95 speed is 0.847× — so `--smooth` stays off by default, and so does the guard: the rule posted before the run made a default for either one depend on a window passing. **Use `--flip 90`**: with it, no bone of the gated build turns more than 90° in one frame (without it, 148.6°), and every bone still lands.

**The short hold.** A segment pointing at the camera is short in the picture, and its picture direction is then detector noise: the rig turns the bone to follow it. So after holds and smoothing, and before the flip guard, every limb segment the map aims is measured on every frame (not a `reach`, and not a line across the body from a left joint to its right twin, such as the hip line or the eye line: those shorten when the body or head turns, which is a different thing, and the cutoff below was measured on limbs only) — its picture length, between the same two points its angle is read from, over its own median length across the pose. On a frame under `--short <fraction>` its angle is not read from the pose: it is interpolated, the short way round, from the last frame at or above the cutoff to the next one, and held flat at the first or last frame of the pose. The flip guard, the hinge check and the keys all see the held angle. `--short off` (the default) reads every frame. The report lists each span under `short` (chain, bone, segment, first and last frame, the lowest fraction).

The cutoff was fixed by measuring first ([#22](https://github.com/rig-c/pose/issues/22)), over both upper arms, forearms, thighs and shins. On the 13 s dance (24 fps, 2,504 segment-frames) the fraction's 0.5th percentile is 0.51, its 5th 0.82, and 7 segment-frames (0.28%) are under 0.35; on a 16 s second sequence (30 fps, 3,936) they are 0.27 and 0.75, and 34 (0.86%). Every frame under 0.35 was looked at, and was one of two kinds:

- **end-on, lasting several frames** — the limb really points at the camera: on the second sequence the right upper arm folded across the chest (frames 395–401, 0.09–0.25), and the right thigh and shin of a knee raised at the camera (365–370, 0.16–0.34); on the dance the left upper arm with the elbow at the camera (frames 30–37, 0.27–0.35, S2 below);
- **blur collapse, lasting 1–3 frames** — a fast forearm whose elbow and wrist the detector both puts on the blurred hand (eleven spans on the second sequence).

Both have a meaningless direction; only the first is a pose the rig cannot draw. **0.35** is the smallest round value that takes in every end-on frame (the highest is 0.35, on the dance) without reaching normal motion (the 5th percentiles are 0.75 and 0.82). A run under the cutoff — spans merged across a gap of one frame — lasting **≥ 0.15 s** (3.6 frames at 24 fps, 4.5 at 30) is the end-on kind: it excludes every blur collapse above (at most 3 frames, 0.10 s at 30 fps) and keeps every end-on span (6–8 frames). The run prints it as `END-ON` and the report lists it under `endOn` (chain, bone, segment, frames, seconds, the lowest fraction): it is the list of moments that need an alternate drawing ([#6](https://github.com/rig-c/pose/issues/6)).

Re-checked on the exam01 test rig with `--short 0.35 --flip 90 --bends clamp`. On the second sequence the three spreads the flip guard made out of end-on segments are SHORT holds now, not FLIPs: right upper arm 399–400, right thigh 368–369, right shin 368–371. Of the flip guard's other spreads only one is left, the left forearm at 322–323; every other one fell on frames under the cutoff and is a SHORT hold instead. No guarded bone of the gated build turns more than 81.4° in one frame (85.1° with `--flip 90` alone), and every bone lands. `endOn` there lists the right upper arm (395–401) and the right shin (365–370). It does not list the right thigh, which is under 0.35 on one frame only (369, 0.16). The plan before the run expected the thigh too, and that expectation was wrong. On the dance `endOn` lists exactly S2's left upper arm (30–37); the three FLIPs are #15's, the largest one-frame turn is 78.2°, and every bone lands. A first implementation also held the lines across the body. It listed the eye line (head in profile) and the hip line (body side-on) as end-on, and holding the hip line narrowed the rig's hip tilt range to 39.3° against the pose's 125.2°. The cutoff was never measured on those lines, so they are excluded; with them out the rig reads 125.2° again. The default stays off: a default needs its own criterion and a third sequence.

Exit codes: `0` written, `1` refused (every reason printed, nothing written), `2` bad invocation. `rig-pose --help` has every flag.

## The pose: `rig-pose-sequence/1`

@rig-c/parts' `keypoints.json` (`spine-parts-keypoints/1`) extended to frames — the same vocabulary, one more level:

```json
{ "spec": "rig-pose-sequence/1",
  "space": { "units": "picture-px", "origin": "top-left", "y": "down" },
  "width": 1080, "height": 1920,
  "source": "what produced the file",
  "frames": [
    { "t": 0, "people": [ { "id": "a", "joints": {
        "neck":       { "state": "observed", "at": [540, 410], "score": 0.93 },
        "r_shoulder": { "state": "observed", "at": [470, 430], "score": 0.91 },
        "r_wrist":    { "state": "missing" } } } ] } ] }
```

- `t` is seconds and strictly increases; the animation's keys are at `t − t₀`.
- Joints are body-18 (`nose neck r_shoulder r_elbow r_wrist l_shoulder l_elbow l_wrist r_hip r_knee r_ankle l_hip l_knee l_ankle r_eye l_eye r_ear l_ear`); `r`/`l` are the **subject's** sides. `state` is `observed`, `occluded` or `missing`, as in the keypoints file. An unlisted joint is missing.
- Two differences from the keypoints file: the unit is `picture-px`, and `at` may lie outside the picture (a hand leaves the frame; the score says how much to believe it).
- More than one person: `--person <id>`.
- `score` is whatever the pose model gives. RTMPose's goes above 1, so `--min-score` is a cut on that model's scale, not a probability.

**From COCO-17** — the layout most pose models and datasets use — `rig-pose convert --coco in.json --out pose.json`, or `retarget --coco`. The input is `{ "format": "coco17-sequence/1", "width", "height", "source", "frames": [{ "t", "keypoints" }] }`, keypoints in COCO's order as 17 `[x, y, score]` or 51 numbers, or `null` for a frame with nobody. The mapping: COCO's `left_*`/`right_*` → body-18's `l_*`/`r_*` (both are the subject's sides), a score of 0 → `missing`, and body-18's `neck`, which COCO lacks, is the shoulders' midpoint scored the lower of the two (OpenPose's definition).

## The map: `rig-pose-map/1`

Which bones carry which joints. You write it for your rig:

```json
{ "spec": "rig-pose-map/1",
  "chains": [
    { "name": "trunk", "bones": ["chest"], "joints": ["mid_hip", "neck"], "aim": ["neck"] },
    { "name": "arm_r", "bones": ["sleeve_r0", "sleeve_r1"], "joints": ["r_shoulder", "r_elbow", "r_wrist"] },
    { "name": "leg_l", "bones": ["leg_l0", "leg_l1"], "joints": ["l_hip", "l_knee", "l_ankle"] } ],
  "translate": { "bone": "hip", "joint": "mid_hip",
                 "scale": { "pose": ["mid_hip", "neck"], "rig": ["hip", "neck"] } } }
```

- A chain's bone *k* carries the segment from joint *k* to joint *k*+1, so it lists one joint more than bones; each bone descends from the one before (a control bone between them is fine).
- `aim`, one entry per bone: `"x"` (default) — the bone's own x axis is the segment; right for a limb link @rig-c/parts turned along its limb. A point — the direction from this bone's origin to that point; right for a trunk bone, whose own axis parts leaves at 0°. `"a>b"` — the direction from point a to point b; right for a head, turned by its eye line: `{ "bones": ["head"], "joints": ["r_eye", "l_eye"], "aim": ["eye_r>eye_l"] }`, or for a pelvis, turned by its hip line: `{ "name": "pelvis", "bones": ["hip"], "joints": ["r_hip", "l_hip"], "aim": ["leg_r0>leg_l0"] }`.
- A **point** of the rig is a bone's origin (`name`), the end of its x axis (`name:tip`), or the midpoint of two of those (`"a+b"`: `"sleeve_r0+sleeve_l0"` is the shoulders' midpoint). An aim's points must be the bone itself or descend from it.
- `reach: true`, on a one-bone chain from the translated joint (a trunk from `mid_hip`): the bone is aimed from where its origin is posed — the hip moved and turned — at where the pose puts the segment's end relative to mid_hip, scaled. Without it, a tilted pelvis carries the chest's origin sideways and the trunk, parallel to the pose's, misses the shoulders. Its aim is one point, from the bone's own origin: `{ "name": "trunk", "bones": ["chest"], "joints": ["mid_hip", "mid_shoulder"], "aim": ["sleeve_r0+sleeve_l0"], "reach": true }`. The chain must descend from the translated bone.
- `bend`: every joint inside a chain is a hinge. `"rest"` (default) takes the side it may bend from the rig's rest pose and refuses a rest that is straight (under 0.5°); `"ccw"`/`"cw"` state it; `"free"` skips the check.
  ⚠️ **Seen from the front, an elbow's side is not a joint limit.** An elbow flexes toward the camera, and its picture falls on either side of the upper arm depending on how the arm is turned. On a real 13 s front-facing dance (313 frames, RTMPose), the right elbow sat on the "wrong" side of the rig's rest on 165 frames (median 23°), and the left on 200 (median 29°, up to 179° with the hands behind the head). Every one was a real elbow bend. The knees strayed at most 8.8° and 14.7°, which is pose noise around a straight leg. So for front-facing material: arms `"free"`; legs on `"rest"`, with `--bends clamp` straightening the noise.
- `mid_hip` and `mid_shoulder` are the midpoints of the two hips and the two shoulders.
- `translate.scale` is one length measured on both: two points on the rig, two points in the pose (its median over the frames where both are good). Pick a long segment that does not foreshorten much.

## Requirements

[Bun](https://bun.sh) ≥ 1.2 on `PATH` — rig-pose, like rig-c, runs its TypeScript sources directly. `rig-c` comes as a dependency. With `@esotericsoftware/spine-core` installed beside it, rig-c's gate runs the spine-core round trip; without it, rig-c's own gate, and the gate's report says which.

## What 0.2 fixes

A flat painting turned by its bones matches each limb's direction, not its depth. On a real 13 s front-facing dance, retargeted onto a @rig-c/parts rig, five moments were found where it cannot follow. They were found by measuring the pose against the rig and checked against the video:

| | t (s) | what the dancer does | why bone rotation cannot follow |
| --- | --- | --- | --- |
| S1 | 0.0–1.1 | hands clasped behind the back | depth order: the forearms go behind the body |
| S2 | 1.0–2.25 | a hand to the ear, then the forearm toward the camera | foreshortening (the upper arm at 0.27 of its length) and depth order |
| S3 | 3.7–7.5 | hands behind the head | depth order; both arm meshes fold through the whole span |
| S4 | 7.7–10.9 | hands crossed in front | which forearm is in front |
| S5 | 11.1–13.0 | an arm thrust at the camera, then a V sign | foreshortening (0.63) and the shape of the hand; the arm mesh folds |

The answer is a second drawing of the arm for each of those poses, shown in place of the bent mesh while the pose lasts. 0.2 will have rig-pose choose when to show it, key the switch in the motion, and list every fold no drawing covers ([#6](https://github.com/rig-c/pose/issues/6)).

## What 0.1.0 does not do

- **Extract poses from video.** The input is joint positions; how you get them (a pose model, a dataset, a hand) is yours.
- **Turn the body.** 2D only: a segment pointing at the camera foreshortens, and the rig cannot. The direction is matched; the length is not.
- **Plant feet** beyond what the pose gives, **hands and fingers** (no bones for them yet, rig-c/parts#171), mobile.

## Licence

MIT, see `LICENSE`.
