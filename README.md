# @rig-c/pose

Puts motion from a pose onto a rig. The motion is joint positions over time: from a video, a dataset, or points placed by hand. The rig is one [rig-c](https://github.com/rig-c/core) built. A body-18 pose sequence becomes bone keys in rig-c's motion format, and the keys are checked before anything is written.

**0.x is the prototype.** The format, the command and the output can change in any release until 1.0.

Part of the rig-c toolchain: [core](https://github.com/rig-c/core) compiles and gates a rig, [parts](https://github.com/rig-c/parts) builds one from a painting, [play](https://github.com/rig-c/play) plays it, and pose moves it.

<!-- demo -->

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
- `BEND` — with `--bends clamp`, a hinge bent the wrong way is straightened on that frame instead of refusing.
- `FOLD` — `rigc render --folds` over the new animation: every mesh that folds, and when. A reading, not a gate.
- `POSTURE` — when the map has a pelvis chain (joints `r_hip`, `l_hip`) and a `translate`: the hip line's tilt range, and the sway — the x-range of mid_hip − mid_shoulder — in rig units and in shoulder widths, the pose's beside the posed rig's. A reading, not a gate.

`--smooth <n>` smooths each joint's positions, after its holds, with a Savitzky–Golay filter: at every frame, the least-squares cubic over the *n* frames around it (clipped at the ends), read at that frame. It is centred, so it moves no motion in time, and a cubic keeps the peaks a moving average flattens. `1` (the default) is none; otherwise *n* is odd and at least 5, since a cubic through 3 points passes through all three.

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

## What 0.1.0 does not do

- **Extract poses from video.** The input is joint positions; how you get them (a pose model, a dataset, a hand) is yours.
- **Turn the body.** 2D only: a segment pointing at the camera foreshortens, and the rig cannot. The direction is matched; the length is not.
- **Plant feet** beyond what the pose gives, **hands and fingers** (no bones for them yet, rig-c/parts#171), mobile.

## Licence

MIT, see `LICENSE`.
