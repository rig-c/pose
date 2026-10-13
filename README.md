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

For every frame of the pose and every bone the map names, the segment that bone carries (an upper arm: shoulder → elbow) points somewhere in the picture. The bone is turned so its segment points the same way: the picture angle, flipped into rig-c's y-up world, minus the bone's angle at the rig's setup pose (read through rig-c's own poser), less the turn of the mapped bone above it — because a `rotate` key in rig-c adds to the setup rotation and a child turns with its parent. The travel of the pelvis midpoint, scaled by a length measured on both the rig and the pose, moves the hip. The result is one animation in rig-c's motion format (`rigc-motion/1`): a `rotate` track per mapped bone, a `translate` track on the hip, one key per pose frame — and, when the map lists alternate drawings, an `attachment` track per slot they switch (and a `translate` track per bone a set offsets).

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
- `SWITCH` — with `alternates` in the map ([below](#alternate-drawings-alternates)): each span on which a set of alternate drawings shows, its slots, its frames, how far the pose was from the set's key skeleton, how far each bone with a `drawn` angle was turned from it, and where each of its boundaries was moved to (`moved`, [below](#alternate-drawings-alternates)).
- `UNCOVERED` — with `alternates` in the map: every fold on a frame where no switch took the folding mesh off screen. This is the list of poses still to paint.
- `RANGE` — a chain's `range` ([below](#a-joints-range-range)): a bone whose rotate key the pose asks past its range, outside every span of a set depicting its chain, is clamped at the limit; one line per run, with the frames, the seconds and the largest overflow. The demand for an alternate.
- `ART-RANGE` — inside a set's span: a bone with a `drawn` angle in the set, turned from it past its limits — the set's `turn` for that bone (held at the limit) or, without one, its chain's `range` (the bone follows the pose). Listed as the pose asked it either way: the demand for another drawing of that set.
- `TURN` — a line across the body (hips, shoulders, eyes) shorter in the picture than 0.5 of its median length, or reversed, for at least 0.15 s: the body or the head turned. A reading of the pose, made whether or not the map uses the line; it changes no key. The demand for a turned-body drawing, as `END-ON` is for a foreshortened limb.

`--report <file>` writes all of it as JSON (`rig-pose-report/1`): `options` (every figure the run used, `switchTolerance`, `switchMin` and `switchAt` included), `scale`, `holds`, `short`, `endOn`, `bends`, `flips`, `gate`, `landings`, `posture`, `folds`, and the demand lists:

- `switches: [{ set, chains, slots, hides, offsets, from, to, frames: [first, last], distance: { max, median }, artTurn: { <bone>: { max, median } }, moved: { on, off } }]` — one per span shown; `from` is the first frame's time, `to` the time the base art comes back (the animation's end when the span runs to it), `distance` in degrees over the frames shown, `artTurn` |wrap(target − drawn)| in degrees per bone the set has a `drawn` angle for. `moved.on` is the boundary the span starts on (null from the first frame), `moved.off` the one the base art or the next set comes back on (null to the end), each `{ frame: [selected, keyed], frames, seconds, window: [first, last], speed: { old, new } }`: signed frames and seconds, the frames it could move to, and the speed in degrees per frame on the old and the new frame. A boundary between two sets is the same entry in both.
- `uncovered: [{ slot, attachment, chains, times }]` — every entry of `folds` on the times its slot still shows that mesh, with the map's chains that move it (the deepest: the arm, not the trunk it hangs from). `rigc render --folds` reads only what the pose shows, so a mesh swapped out or hidden by a switch is not read on those frames at all; `uncovered` is the fold times less the switched ones.
- `endOn` — above, under the short hold.
- `turns: [{ line, joints, frames, seconds, minFraction, reversed }]` — `line` is `hip`, `shoulder` or `eye`.
- `range: [{ chain, bone, frames, seconds, maxOverflow, key, limits }]` — `key` is the rotate key the pose asked for on the frame of the largest overflow, before the clamp.
- `artRange: [{ set, chain, bone, frames, seconds, maxOverflow, turn, limits, clamped }]` — `turn` is the signed art turn the pose asked on that frame; `clamped` says whether the set's `turn` held the bone there.

Runs in `turns`, `range` and `artRange` merge across a gap of one frame, as `endOn` does; `seconds` runs from the first frame's key time to the end of the last frame.

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

### A joint's range: `range`

A rig whose limbs are cut at the joints reads well only within some range of each joint's angle. A chain may state it per bone, in rotate-key degrees (the key, relative to the bone's setup rotation and to the turn of the mapped bone above it):

```json
{ "name": "arm_r", "bones": ["sleeve_r0", "sleeve_r1"], "joints": ["r_shoulder", "r_elbow", "r_wrist"],
  "range": { "sleeve_r0": [-10, 5], "sleeve_r1": [-10, 10] } }
```

Outside every span of a set depicting that chain, a key past its range is clamped at the limit: the bone's target becomes the clamped world angle, and the bones below are keyed from it as usual, so they still point where the pose puts them. Bones are clamped parents first, and a `reach` below a clamped bone is aimed again from where the clamped bones put its origin. The landing check measures against the clamped targets. Every overflow is listed as `RANGE` demand. A key on its limit to within 0.001° (the writer's rounding of a key; the rest angles come from rig-c's float32 model) does not count. Inside a set's span the bone is not clamped: the set's art was painted for that pose. Its `drawn` angle, if the set gives one, is read against the range instead (`ART-RANGE`). Each name is refused if it is not a bone of the chain (`MAP_RANGE`), as is a range that is not `[min, max]` with min ≤ max.

### Alternate drawings: `alternates`

Bone rotation cannot carry every pose: an arm behind the head, a forearm toward the camera, hands crossed in front of the body. The answer is a different drawing for that pose, swapped in. One key pose repaints every slot it moves (both arms, and the torso when the pose pulls it), so an alternate is a **set** of slots switched together. The map says which sets the rig has and the pose each was painted from; the run decides when each shows:

```json
"alternates": [
  { "name": "K1_hands_behind_head",
    "slots":   { "upperarm_r_under": "K1_upperarm_r", "forearm_r_back": "K1_forearm_r", "topwear": "K1_topwear" },
    "hides":   ["upperarm_r", "forearm_r"],
    "chains":  ["arm_r", "arm_l"],
    "pose":    { "r_shoulder": [450, 640], "r_elbow": [350, 500], "r_wrist": [510, 480],
                 "l_shoulder": [610, 640], "l_elbow": [720, 500], "l_wrist": [560, 480] },
    "drawn":   { "sleeve_r0": 117.8, "sleeve_r1": 30.4 },
    "offsets": { "sleeve_r1": [4, -2] } } ]
```

- `slots`: what each slot of the set shows while it shows; each attachment must be in that slot under some skin of the rig, as rig-c built it. `hides`: the slots that are empty while it shows. A slot's place in the draw order is the rig's own, so a drawing that must sit in front of the torso is an attachment in a slot that is: a switch is attachment keys only, and no draw-order key is written.
- `chains`: the map's chains whose pose the set depicts; it is selected by them. `pose`: the key skeleton the art was painted from, body-18 (or `mid_hip`/`mid_shoulder`) in picture px, y down, any scale and place — only its directions are read; every joint the listed chains use must be in it.
- `drawn` (optional): each bone's world angle (Spine degrees) as painted. It changes no key: while a set shows, a bone is keyed to the pose as always, and the art turns with it. What it gives is a figure: the art turn, how far each bone is from the angle its art was painted at (`artTurn`, and `ART-RANGE` past the bone's range).
- `offsets` (optional): a translate per bone, in its parent's axes, held while the set shows and 0 elsewhere (stepped keys), so the joints as painted are the pivots. A bone `translate` already keys (the hip) cannot take one.
- Each name resolves against the built rig and the map, and a miss is refused by name, listing what exists: `MAP_ALT_SLOT`, `MAP_ALT_ATTACHMENT`, `MAP_ALT_HIDES`, `MAP_ALT_CHAIN`, `MAP_ALT_JOINT`, `MAP_ALT_POSE`, `MAP_ALT_DRAWN` and `MAP_ALT_OFFSET` (a bone that is not a bone of the set's chains).

**When one shows.** Per frame and per set, the distance is the largest difference, in degrees, between a segment of its chains as the retarget asked for it (after holds, smoothing, the short hold, the flip guard and the hinge check; before any range clamp) and the same segment in its key skeleton. On each frame the nearest set within `--switch-tolerance` (default 25°) shows, ties going to the map's order; a run of one set shorter than `--switch-min` (default 0.25 s) is dropped and the base art shows there. Both figures were fixed before a run ([#6](https://github.com/rig-c/pose/issues/6)). Sets compete only with those they share a slot (shown or hidden) or an offset bone with, so a drawing of each arm can show at once; two that compete never overlap.

**Where a switch is keyed: `--switch-at`.** By default (`first`) a boundary — the frame a set starts showing on, and the frame the base art or the next set comes back on — is where the selection above puts it: the first frame within the tolerance, often a frame where the arm is slowing into the pose, so the change of drawing can be seen on a nearly still arm. `--switch-at peak` moves each boundary to the frame within ±`--switch-min`/2 (±3 frames at 24 fps with the default 0.25 s) where the chains it changes turn fastest, so the cut lands in motion ([#31](https://github.com/rig-c/pose/issues/31)). The speed on a frame is the largest |angular speed| in degrees per frame, a central difference of the target world angles (one-sided on the first and last frame), over every segment of the leaving set's and the arriving set's chains; it is read on the same targets as the distance, before the range clamp and any set's `turn`, which depend on where the spans are. The window is clipped so every span keeps `--switch-min`, a gap between two spans of one set keeps it too (the bridging holds), no boundary reaches its neighbour, and a set with `frames` shows only inside them. In it, a frame qualifies only if the set the move newly shows is within **2 × `--switch-tolerance`** of its key skeleton on every frame it newly shows it on; the boundary goes to the fastest qualifying frame, and stays when none qualifies. A tie goes to the frame nearest the original, then the earlier. A boundary between two sets moves once.

The bound exists because speed alone rewarded showing art far from its pose. Unbounded, on HQ's dancer, the peak sat mid-swing: the largest distance over the frames a set showed rose from 25° to 135° (K2), 24° to 64° (K4), 21° to 59° (K1) and 21° to 38° (K3), the sets' `turn` held the arms hard against the pose (`ART-RANGE` runs 24 → 36), and the rig snapped to a hands-low drawing two frames before the arms came down. Bounded, every set stays within 50° (the largest is 43°, K4) and the median speed at the boundaries still rises from 9.7 to 14.2°/frame, but `ART-RANGE` runs still rise, 24 → 31 (K4 1 → 3, K1 6 → 8, K2 6 → 7, K3 2 → 4). That is why `first` is the default and `peak` an option ([#31](https://github.com/rig-c/pose/issues/31), round 2).

Either way the `SWITCH` line ends with `moved on …, off …`: each boundary's old and new frame (the same under `first`), the frames and seconds it moved, the speed on both and its window, and the report carries the same under `moved`.

**What is written.** An `attachment` track per slot whose picture changes: the set's attachment (or `null` for a hidden slot) where a span starts, and the slot's setup attachment, as the compiled model states it, where it ends. A direct switch from one set to another puts the first set's slots back to setup on the second's first frame, so an extra slot that is empty at setup goes empty. A switch onto frame *i* is keyed halfway between frames *i*−1 and *i*: a stepped key on the frame's own time fires a frame late wherever a player's accumulated time lands just below it (rig-c's docs/AUTHORING.md §4.5), and halfway both the pose's times and a renderer's `i / fps` see it on frame *i*. Before the first key a slot shows its setup attachment, so no key is written at 0 unless a span starts there. Offsets are `translate` keys at the same times, `stepped`. rig-c's gate checks these keys like any other.

**TURN.** The cutoff was measured on the three lines across the body before it was fixed ([#6](https://github.com/rig-c/pose/issues/6)): on the 13 s front-facing dance their picture length never drops under 0.81 of its median and none reverses; on a second sequence the hip line falls to 0.17 at frames 465–491 (side-on) and the eye line to 0.22 at 26–58 (head in profile), and 3 frames reverse. 0.5 lies between. A line is reversed when it points more than 90° from the subject's right joint to the left (front-facing, it points at 0°). The lines are read after holds and smoothing, held and smoothed as the map's points are even where the map does not use them; a line whose points are good on no frame is named as not measured.


**A stopgap window: `frames`.** A set may state `"frames": [[first, last], …]`: it shows only inside those windows, and on them it is chosen over any set within tolerance that has no window. It is for two sets whose key skeletons the angles cannot tell apart. Measured on HQ's dancer, the hands clasped behind the back and the hands low in front differ by only 2–21°, and the wrist and hand-point scores do not separate them either; the cue that might is #33's depth state. It is recorded in the map as a stopgap, not a selection rule.

**How far a set's art may turn: `turn`.** A drawing reads right only near the angle it was painted at. A set may state, per bone with a `drawn` angle, how far its art may turn from it, `"turn": { "sleeve_r0": [-20, 20] }`. While the set shows, the bone is held within it: its target becomes drawn + clamp(wrap(target − drawn), min, max), each bone on its own world angle, so a forearm under a held upper arm keeps its own target. The landing check measures against the held angle. The overflow the pose asked for is listed as `ART-RANGE`. A `turn` on a bone the set has no `drawn` angle for is refused (`MAP_ALT_TURN`).
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

The answer is a second drawing of the arm for each of those poses, shown in place of the bent mesh while the pose lasts. rig-pose chooses when to show it, keys the switch in the motion, and lists every fold no drawing covers ([#6](https://github.com/rig-c/pose/issues/6), [above](#alternate-drawings-alternates)).

## What 0.1.0 does not do

- **Extract poses from video.** The input is joint positions; how you get them (a pose model, a dataset, a hand) is yours.
- **Turn the body.** 2D only: a segment pointing at the camera foreshortens, and the rig cannot. The direction is matched; the length is not.
- **Plant feet** beyond what the pose gives, **hands and fingers** (no bones for them yet, rig-c/parts#171), mobile.

## Licence

MIT, see `LICENSE`.
