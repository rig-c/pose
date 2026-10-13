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
| every mapped bone **lands** on the angle the pose asks for, on every frame — the gated build is posed by rig-c's poser and measured (0.01° / 0.01 units); with `--leg-scale`, every scaled bone's x axis on its asked scale (0.0001 of its setup length), and with either leg flag each ankle where the keys put it (0.01 units + 0.0001 × its setup distance from the hip) | `POSE_LANDS`: the bone, the worst error, the frame |
| elbows and knees bend only the way they can: at every joint inside a chain, the inner angle stays on the side of the rest pose's | `POSE_BEND_ONE_WAY`: the chain, the joint, the frame, the angle |
| every point the map needs is good on at least one frame | `POSE_POINT_NEVER_GOOD` |
| the map resolves against the rig: bones exist, chains descend, aims descend | `MAP_*`, naming both sides |

and what the run cannot decide for you it lists:

- `RIGC` — the rig-c version and entry that gated and posed the run (also `rigc` in the report): a later rig-c can change the bytes.
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
- `LEG-SCALE` — with `--leg-scale` ([below](#the-legs-foreshortening-and-planted-feet)): per leg segment, its straight length, the spread of its picture length over it, and the frames clamped at each limit.
- `PIVOT` — when the map translates a bone and has both legs: the translated bone's origin against its thigh roots' midpoint at setup, in units and hip widths — the pivot every hip turn swings the legs about.
- `FEET` — when the map has both legs: the supports and jumps read off the reference ankles (planted or not), and on the posed build, outside the jumps, the lowest ankle's vertical range and each support span's worst vertical range and horizontal drift of the supporting ankle, in leg lengths.
- `SHEAR` — with `--leg-scale`: every scaled bone and every bone under one, how far its art is sheared and how long its world axes are against setup. A reading.
- `IDLE`, `IDLE-DROPPED`, `IDLE-KEPT-OUT`, `MERGE` — the rig's idle against the new animation, and what `--carry-idle` and `--merge` put back ([below](#the-idle-what-the-retarget-drops)).
- `REDUCE` — with `--reduce` ([below](#few-keys---reduce)): per bone, its keys before and after and its largest error, with the frame; then the total.
- `TURN` — a line across the body (hips, shoulders, eyes) shorter in the picture than 0.5 of its median length, or reversed, for at least 0.15 s: the body or the head turned. A reading of the pose, made whether or not the map uses the line; it changes no key. The demand for a turned-body drawing, as `END-ON` is for a foreshortened limb.

`--report <file>` writes all of it as JSON (`rig-pose-report/1`): `options` (every figure the run used, `switchTolerance`, `switchMin`, `switchAt`, `legScale` and `plantFeet` included), `scale`, `holds`, `short`, `endOn`, `bends`, `flips`, `gate`, `landings`, `posture`, `folds`, `legScale`, `pivot`, `feet` (`planted`, `legLength`, `floor`, `supports`, `jumps`, `changes`, and the posed `reading`), `shear`, `idleDropped`, `idleKeptOut` and `merged` ([below](#the-idle-what-the-retarget-drops)), `reduce` (the tolerances and each row of `REDUCE`, [below](#few-keys---reduce)), and the demand lists:

- `switches: [{ set, chains, slots, hides, offsets, from, to, frames: [first, last], distance: { max, median }, artTurn: { <bone>: { max, median } }, moved: { on, off } }]` — one per span shown; `from` is the first frame's time, `to` the time the base art comes back (the animation's end when the span runs to it), `distance` in degrees over the frames shown, `artTurn` |wrap(target − drawn)| in degrees per bone the set has a `drawn` angle for. `moved.on` is the boundary the span starts on (null from the first frame), `moved.off` the one the base art or the next set comes back on (null to the end), each `{ frame: [selected, keyed], frames, seconds, window: [first, last], speed: { old, new } }`: signed frames and seconds, the frames it could move to, and the speed in degrees per frame on the old and the new frame. A boundary between two sets is the same entry in both.
- `uncovered: [{ slot, attachment, chains, times }]` — every entry of `folds` on the times its slot still shows that mesh, with the map's chains that move it (the deepest: the arm, not the trunk it hangs from). `rigc render --folds` reads only what the pose shows, so a mesh swapped out or hidden by a switch is not read on those frames at all; `uncovered` is the fold times less the switched ones.
- `endOn` — above, under the short hold.
- `turns: [{ line, joints, frames, seconds, minFraction, reversed }]` — `line` is `hip`, `shoulder` or `eye`.
- `range: [{ chain, bone, frames, seconds, maxOverflow, key, limits }]` — `key` is the rotate key the pose asked for on the frame of the largest overflow, before the clamp.
- `artRange: [{ set, chain, bone, frames, seconds, maxOverflow, turn, limits, clamped }]` — `turn` is the signed art turn the pose asked on that frame; `clamped` says whether the set's `turn` held the bone there.

Runs in `turns`, `range` and `artRange` merge across a gap of one frame, as `endOn` does; `seconds` runs from the first frame's key time to the end of the last frame.

`--smooth <n>` smooths each joint's positions, after its holds, with a Savitzky–Golay filter: at every frame, the least-squares cubic over the *n* frames around it (clipped at the ends), read at that frame. It is centred, so it moves no motion in time, and a cubic keeps the peaks a moving average flattens. `1` (the default) is none; otherwise *n* is odd and at least 5, since a cubic through 3 points passes through all three.

**`--smooth 7` flattens the pelvis's rebound.** Measured on HQ's dancer with `--leg-scale 0.8,1.05 --plant-feet` ([#47](https://github.com/rig-c/pose/issues/47)): the rebound — the hip's peak upward acceleration at the bottom of each bounce, rig ÷ reference, median over a window, bar ≥ 0.7 — reads 0.40–0.52 with `--smooth 7` in every configuration measured (0.461 and 0.501 in the two windows, where `--smooth 1` reads 0.648 and 0.942). So the pelvis is read at `--smooth 1`, and `--smooth 7` is not advised for it. What follows is the earlier advice, for the limbs.

**`--smooth 7` at 24 fps, for the limbs.** It was measured on a 13 s dance on a @rig-c/parts rig, read back from the gated build: the motion's timing did not move (speed cross-correlation lag 0 on the wrists, ankles and hip), the frame-to-frame second difference dropped 2.5× on the wrists, 1.7–2.1× on the ankles and 1.5× on the hip, and the hip's 95th-percentile speed fell to 0.85×. The criterion set beforehand, a 2× drop on every point, was not met on the hip. That criterion was flawed: the hip's second difference is mostly real motion, while the filter cuts white noise 4.6×. A measure that isolates noise is a later card, and the default stays off until it passes.

**The flip guard.** A pose model can put a fast sweep of a limb into one frame — under motion blur it takes the elbow or the wrist for another point — and the rig then whips the limb round between two keys. Position smoothing cannot remove a step like that. So after holds and smoothing, and before the hinge check, every segment the map aims (not a `reach`, which is aimed later from posed positions) is read frame to frame: a turn greater than `--flip <deg>` from frame k−1 to frame k is spread. For the smallest h ≥ 1 that keeps every one-frame turn at or under the threshold, frames k−h … k+h−1 are replaced by the straight line from frame k−h−1 to frame k+h, the turn's own way round. It is centred, so the step happens when the pose put it, over 2h frames, and both ends keep the pose's angles. A window that would cross the first or last frame stops there and the line says so; two windows that overlap become one. `--flip off` keeps every turn. The report lists each spread under `flips`.

The threshold was fixed by measuring first ([#15](https://github.com/rig-c/pose/issues/15)). On the 13 s dance (313 frames, RTMPose), the one-frame turns of the picture angle of 10 segments — both upper arms, forearms, thighs and shins, the eye line and the hip line, 3,120 turns — run p50 1.0°, p90 5.0°, p99 23.1°, p99.5 33.4°, p99.9 78.2°, max 148.6°. 90° is the p99.9 rounded up past a margin, and marks the 3 turns above it (0.1%): both forearms between frames 181 and 182 (148.6° and 114.4°, a motion-blurred stretch) and the left forearm between 53 and 54 (99.2°, the forearm pointing at the camera). None of them is a spike that comes back: each keeps the direction the limb was already turning, and the new angle holds — a real sweep put into one frame. Holding the last angle would be wrong a frame later, so the guard spreads the step instead. With it, on the @rig-c/parts rig #11 measured, the largest one-frame turn of any guarded bone in the gated build, posed by rig-c, is 78.2° (148.6° without it), and every bone still lands.

Re-measured with the guard on, against the guarded unsmoothed run, on #11's criteria (power above 6 Hz down ≥ 2× on every point, timing lag 0, p95 speed ≥ 0.85×): no window passes. `--smooth 7` comes closest — the left wrist's power drops 1.99× and the hip's p95 speed is 0.847× — so `--smooth` stays off by default, and so does the guard: the rule posted before the run made a default for either one depend on a window passing. **Use `--flip 90`**: with it, no bone of the gated build turns more than 90° in one frame (without it, 148.6°), and every bone still lands.

**The short hold.** A segment pointing at the camera is short in the picture, and its picture direction is then detector noise: the rig turns the bone to follow it. So after holds and smoothing, and before the flip guard, every limb segment the map aims is measured on every frame (not a `reach`, and not a line across the body from a left joint to its right twin, such as the hip line or the eye line: those shorten when the body or head turns, which is a different thing, and the cutoff below was measured on limbs only) — its picture length, between the same two points its angle is read from, over its own median length across the pose. On a frame under `--short <fraction>` its angle is not read from the pose: it is interpolated, the short way round, from the last frame at or above the cutoff to the next one, and held flat at the first or last frame of the pose. The flip guard, the hinge check and the keys all see the held angle. `--short off` (the default) reads every frame. The report lists each span under `short` (chain, bone, segment, first and last frame, the lowest fraction).

The cutoff was fixed by measuring first ([#22](https://github.com/rig-c/pose/issues/22)), over both upper arms, forearms, thighs and shins. On the 13 s dance (24 fps, 2,504 segment-frames) the fraction's 0.5th percentile is 0.51, its 5th 0.82, and 7 segment-frames (0.28%) are under 0.35; on a 16 s second sequence (30 fps, 3,936) they are 0.27 and 0.75, and 34 (0.86%). Every frame under 0.35 was looked at, and was one of two kinds:

- **end-on, lasting several frames** — the limb really points at the camera: on the second sequence the right upper arm folded across the chest (frames 395–401, 0.09–0.25), and the right thigh and shin of a knee raised at the camera (365–370, 0.16–0.34); on the dance the left upper arm with the elbow at the camera (frames 30–37, 0.27–0.35, S2 below);
- **blur collapse, lasting 1–3 frames** — a fast forearm whose elbow and wrist the detector both puts on the blurred hand (eleven spans on the second sequence).

Both have a meaningless direction; only the first is a pose the rig cannot draw. **0.35** is the smallest round value that takes in every end-on frame (the highest is 0.35, on the dance) without reaching normal motion (the 5th percentiles are 0.75 and 0.82). A run under the cutoff — spans merged across a gap of one frame — lasting **≥ 0.15 s** (3.6 frames at 24 fps, 4.5 at 30) is the end-on kind: it excludes every blur collapse above (at most 3 frames, 0.10 s at 30 fps) and keeps every end-on span (6–8 frames). The run prints it as `END-ON` and the report lists it under `endOn` (chain, bone, segment, frames, seconds, the lowest fraction): it is the list of moments that need an alternate drawing ([#6](https://github.com/rig-c/pose/issues/6)).

Re-checked on the exam01 test rig with `--short 0.35 --flip 90 --bends clamp`. On the second sequence the three spreads the flip guard made out of end-on segments are SHORT holds now, not FLIPs: right upper arm 399–400, right thigh 368–369, right shin 368–371. Of the flip guard's other spreads only one is left, the left forearm at 322–323; every other one fell on frames under the cutoff and is a SHORT hold instead. No guarded bone of the gated build turns more than 81.4° in one frame (85.1° with `--flip 90` alone), and every bone lands. `endOn` there lists the right upper arm (395–401) and the right shin (365–370). It does not list the right thigh, which is under 0.35 on one frame only (369, 0.16). The plan before the run expected the thigh too, and that expectation was wrong. On the dance `endOn` lists exactly S2's left upper arm (30–37); the three FLIPs are #15's, the largest one-frame turn is 78.2°, and every bone lands. A first implementation also held the lines across the body. It listed the eye line (head in profile) and the hip line (body side-on) as end-on, and holding the hip line narrowed the rig's hip tilt range to 39.3° against the pose's 125.2°. The cutoff was never measured on those lines, so they are excluded; with them out the rig reads 125.2° again. The default stays off: a default needs its own criterion and a third sequence.

### The legs: foreshortening and planted feet

A knee bending toward the camera is seen from the front only as a shorter leg, and a rig with rigid legs cannot lower its hip without lifting its feet ([#47](https://github.com/rig-c/pose/issues/47)). Two flags, both off by default:

**`--leg-scale <min,max>`** scales each mapped leg segment (two of one side's hip, knee and ankle) along its own x axis — a `scalex` key — by its picture length on the frame over its **straight length**, the 95th percentile of its picture length over the sequence, clamped to [min, max]. The card's range is `0.8,1.05`. A segment the map aims other than `"x"` is refused (`LEGS_MAP`). `LEG-SCALE` lists each segment's frames clamped at either limit.

rig-c's `scalex` multiplies the bone's x axis, and a child with the `normal` inherit mode takes its parent's whole world matrix. So under a thigh scaled by s, a shin at angle φ in the thigh's axes points at atan2(sin φ, s·cos φ), and is itself scaled by |(s·cos φ, sin φ)|. The rotate key `turn − turn above` assumes unit scale. A mapped bone under a scaled bone is therefore keyed through its parent's posed matrix: a `rotate` key k and a `scalex` key s' make its local matrix R(k) · L · diag(s', 1), L its setup local matrix, and k and s' are solved so its world x axis lands on its target at the scale asked. On HQ's dancer the unit-scale formula missed the shins by up to 2.4°, their length by 0.16 of setup and the ankles by 38 units; solved, every bone lands. The child's art is still sheared by its parent's scale, and a bone under it (a foot) is squashed along the shin: `SHEAR` reads both.

**`--plant-feet`** places the hip so the supporting foot stays where it took support, through the posed (and scaled) legs, instead of moving it by the pose's mid_hip travel:

- The supporting foot is the one whose reference ankle is lower in the picture. It changes only when the other ankle has been at least **0.02 leg lengths** lower for at least **0.1 s** (timed as `END-ON` runs are); a leg length is each side's median picture length hip → ankle, and the switch compares against their mean.
- The new support is held where it is on the frame it takes over, and the hip blends from the old derivation to the new over **3 frames**.
- A **jump** — both reference ankles **and** mid_hip more than **0.05** leg lengths above their **rolling floor**, the 95th-percentile picture y over ±1.0 s around the frame, for at least **2 frames** — releases the plant: the hip follows the pose's travel from where it was, and re-plants on landing (blended the same way). The body has to lift: an ankle's picture y drifts with depth, and under one floor for the whole sequence HQ's dancer standing still (frames 0–29 and 277–312, mid_hip moving 10 and 14 px) read as jumping, 152–155 of 313 frames in all.
- A **step** releases the plant too: while the supporting ankle moves more than **0.03** leg lengths a frame, the other foot takes support if it is planted (not itself released or moving), and otherwise the hip follows the pose's travel. The released ankle may support again once it has moved less than **0.01** leg lengths a frame for **2 frames**. On the dancer the plant held the supporting ankle through a real step (frames 176–181, 579 → 718 px) and threw the hip sideways.
- `FEET` lists the supports, the jumps and the steps (each with the side, its frames, who took support and where it re-planted); the report carries them under `feet` (`supports`, `jumps`, `steps`, `changes`).
- The map needs one chain ending at each ankle whose last bone is aimed `"x"` (the ankle is that bone's tip), and a `translate` the legs hang from (`LEGS_MAP`). A `range`, or a set's `turn` or `offsets`, on a bone between the hip and an ankle is refused (`LEGS_RANGE`): the plant is derived before the range clamp, and a clamp after it would move the planted foot.

Both are checked on the gated build: every scale lands, each ankle lands where the keys put it, and the hip's origin where the plant put it. The figures were fixed in #47 before the dancer was measured; the defaults stay off until they pass.

### The idle: what the retarget drops

A rig's motion spec usually has an `idle` — a blink, a breath, hair and hem sway — and the new animation keys none of it ([#43](https://github.com/rig-c/pose/issues/43), item 2). The run reads that animation (`--idle <name>` names another; naming one the spec lacks is `IDLE_NAME`) track by track against the new one, channel by channel — `translate` poses `translatex` and `translatey`, a `group` track poses each of its members, a slot's `rgba` its `rgb` and `alpha`:

- `IDLE-DROPPED` — a track the new animation keys on none of its channels, and that turns no mapped bone (below): its target, property, keys and the idle's duration. The report lists them under `idleDropped` (`target`, `members`, `property`, `keys`, `duration`, `carried`, `notCarried`).
- `IDLE-KEPT-OUT` — never carried (`idleKeptOut`), with the reason: a track the new animation keys itself, naming the track that keys it; or a `rotate`, `scale` or `shear` (any axis) of a bone **above** a mapped bone — between mapped bones, or above the first one (the map's chains and its translated bone) — naming the mapped bones below it: the retarget's keys hold every unmapped bone at its setup pose, so such a track would turn them off the angles the pose asks. A `translate` of such a bone is carried: it moves the bones under it and turns none. The exception is a translate of a bone above the **translated** bone (the hip), which is kept out because the retarget places that bone's origin. (Folding a carried parent's motion into the mapped bones' keys is a later card.) The idle's `drawOrder`, `events`, `ik`, `transform`, `deform` and `sequence` timelines are not tracks, and are listed here too.

**`--carry-idle`** (off by default: a blink keyed over a set's art may not suit it, and that is the author's call) loops every dropped track into the new animation: the idle's keys repeated every idle duration and cut at the new animation's end, with the value interpolated there.

- A key's `ease` or `curve` describes the segment to the next key, so a loop is built key by key. Where the idle's last key is at its duration and its first at 0, the two are one key at each seam (the next cycle's first; if their values differ, the line says where the loop jumps, as a player looping the idle does). Where the last key is earlier, it is keyed `stepped`, so it holds to the cycle's end as it does in the idle. Where the first key is later than 0, each later cycle opens with a stepped setup key: 0 for a bone's translate, shear and rotate, 1 for its scale, the slot's setup attachment; for any other property such a track is not carried, and the line says why.
- A raw `curve` states absolute times, so a repeated one is shifted with its key. The segment the cut falls in is split there: linear and stepped as they are, a Bézier (a raw `curve`, or a named easing turned into one as rigc does) by de Casteljau, so the part kept is the same cubic and the last key carries neither ease nor curve. rig-c draws a Bézier as Spine's polyline, so a split segment and the idle's whole one sit off the cubic, and off each other, by that alone (measured on the test's eased segment: the idle's own up to 2.6e-3, the carried part up to 9.3e-4).
- A track with `lag` or `stagger`, or whose values are per-member maps or models, is not carried, and the line says so.

Every bone still has to land with the carried tracks in. A carried translate above the translated bone moves its origin off the pose's travel, and the run refuses with `POSE_LANDS`, naming the carried tracks above the bone that missed.

On HQ's dancer (`--flip 90 --short 0.35 --bends clamp --carry-idle`) the idle has 26 tracks. Kept out: the four arm rotates, which the dance keys, and `chest_ctl` scalex, `neck` rotate and `head_ctl` rotate, which sit above the mapped chest, head and arms — carried, they missed the chest, the head and the arms by 0.16°–1.37°. Carried: the other 19, the blink (`group "eyes"` scaley) and the breath (`bone "chest_ctl"` translatey) among them. The gate is green, every bone lands (worst 0.00167°), and rig-c's poser shows the blink at every cycle (scaleY 0.12 at 2.37 s, 5.70 s, 9.08 s and 12.41 s, against the idle's at t mod 3.333 s within 8.9e-6) and the breath's chest_ctl offset (5.02 at 0.833, 4.167, 7.5, 10.833 s; 0 at 2.5, 5.833, 9.167, 12.5 s; 1.035 at the cut, 13 s).

**`--merge <file>`** merges a timed track fragment into the new animation, at absolute times from its start — blinks read off the video, for example:

```json
{ "spec": "rig-pose-tracks/1", "tracks": [ { "group": "eyes", "property": "scaley", "keys": [ { "t": 2.3, "v": [1] }, { "t": 2.37, "v": [0.12] }, { "t": 2.45, "v": [1] } ] } ] }
```

Each track is a rigc-motion track. One posing a channel the new animation (or a carried idle track, or an earlier fragment track) already keys is refused by name (`MERGE_CONFLICT`): a fragment adds a track, it never replaces one. So is a key before 0 or past the animation's duration (`MERGE_TIME`), and a file of any other shape (`MERGE_SPEC`). What the track means — its target, property and values — is rigc's to judge: its gate checks every merged track like any other (`RIG_GATE`). `MERGE` lists each track merged; the report lists them under `merged`.

### Few keys: `--reduce`

The retarget writes one key per pose frame on every mapped bone. That is faithful, but nobody can edit it by hand. **`--reduce <deg>`** (off by default) thins each mapped bone's `rotate` track to a few keys with curves, so that every bone's **world** aim stays within `deg` of the dense keys on every pose frame. **`--reduce-hip <units>`** does the same for the hip's `translate`, holding its world origin within `units`; without it, the hip stays dense.

- **Keys stay on the pose's own frame times.** Between two kept keys, the span is linear if a straight line is within the tolerance. Otherwise it gets one raw Bézier `curve`, with its handles at the span's thirds and its values fitted by least squares. The error is measured the way rig-c's poser evaluates a curve (its 10-piece polyline). A span still over the tolerance gets a key at its worst frame, and both halves are fitted again.
- **Errors do not pile up down a chain.** Bones are fitted top-down, and each bone is fitted against its dense key less the error its nearest mapped parent already carries. So a bone's world error is its own fit error.
- **Kept regardless:** the first and last frame; the frames either side of a switch boundary, on the chains the switch changes; and the first and last frame of every `FLIP` spread, `SHORT` span and `RANGE` run, on that bone.
- **The landing check holds the dense targets** with the tolerance added (0.01° + `deg`; 0.01 + `units`), and it is posed by rig-c as always.
- **On HQ's dancer** (`--smooth 7 --flip 90 --short 0.35 --bends clamp`; 313 frames, 11 mapped bones): `--reduce 1 --reduce-hip 1` takes the rotate keys from 3443 to 588 (5.86×), 296 of the spans curved, and the hip's translate keys from 313 to 96. The gate is green. rig-c's poser lands every bone within 0.9998° of the dense target (head) and the hip within 0.901 units. At 0.5° the keys drop 3.92×; at 2°, 8.38×.
- **Not combined with `--leg-scale` or `--plant-feet`.** Their keys land a bone through a scaled parent or an ankle's lever, which this tolerance does not bound (rig-c/pose#32).

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


**The older name.** `rig-c-pose-frames/0`, written by the extraction jobs this package's demos were made from, is the same file under another spec string. It has `space.units` "painting-px" and an `fps` key; each frame's `t` is the time read. It is read as it is.
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


**A stopgap window: `frames`.** A set may state `"frames": [[first, last], …]`: it shows only inside those windows, and on them it is chosen over any set within tolerance that has no window. It is for two sets whose key skeletons the angles cannot tell apart. Measured on HQ's dancer, the hands clasped behind the back and the hands low in front differ by only 2–21°, and the wrist and hand-point scores do not separate them either; the cue that might is #33's depth state. It is recorded in the map as a stopgap, not a selection rule. A window **restricts** a set; it never forces one. Where the set does not show inside its window, the run says why in a `FRAMES` line: the stretch, and whether the pose there was past the tolerance (with the largest distance), or within it but the run was dropped.

**How far a set's art may turn: `turn`.** A drawing reads right only near the angle it was painted at. A set may state, per bone with a `drawn` angle, how far its art may turn from it, `"turn": { "sleeve_r0": [-20, 20] }`. While the set shows, the bone is held within it: its target becomes drawn + clamp(wrap(target − drawn), min, max), each bone on its own world angle, so a forearm under a held upper arm keeps its own target. The landing check measures against the held angle. The overflow the pose asked for is listed as `ART-RANGE`. A `turn` on a bone the set has no `drawn` angle for is refused (`MAP_ALT_TURN`).
## Compare: the rig's render against the video

```sh
rig-pose compare --reference ref.pose.json --render render.pose.json --map map.json \
  [--retarget-report report.json] [--reference-hands ref.wholebody.json --render-hands render.wholebody.json] \
  [--cloth-reference ref.cloth.json --cloth-render render.cloth.json --cloth-windows 3.9-7.4,7.6-11.1] \
  [--report compare.json] [--sheet compare.png]
```

Polishing a retarget used to mean rendering it, having a person look, and hearing what was wrong. Most of what a person names can be measured with the same pose detector on both sides ([#38](https://github.com/rig-c/pose/issues/38)). `compare` reads two `rig-pose-sequence/1` files on one time base: the **reference** (the source video's keypoints) and the **render** (the same detector run on `rigc render` frames of the retargeted motion). It lists the differences per body unit, worst first, each with the fix it suggests. The person is then needed only for taste. The detector stays outside rig-pose, as it does for `retarget`.

The figures and bars below are fixed. They were set in [#38](https://github.com/rig-c/pose/issues/38) before any render was measured, and they are grading lines for [rig-c/exam](https://github.com/rig-c/exam). A change to one is a new comment on that issue first.

**One time base.** Both sequences have the same number of frames, and each frame's times differ by at most **1 ms**. Render the motion at the reference's rate, frame for frame. Anything else is refused (`COMPARE_FRAMES`, `COMPARE_TIMES`, with the first frames that differ). The hands files and cloth tracks are held to the same rule against the reference (`COMPARE_HANDS_FRAMES`/`_TIMES`, `COMPARE_CLOTH_FRAMES`/`_TIMES`).

**Positions are normalised per side.** A position is divided by that side's own **hip width**: the median over its frames of |r_hip − l_hip|, in picture px. Directions are compared as Spine angles of the picture segment, |wrap(render − reference)|. Every joint with a position counts, whatever its score; only hand visibility reads scores. A frame where either side lacks a point the measure needs is not measured, and it is never over the bar.

**A finding** is a run of frames over a measure's bar lasting **≥ 0.15 s**. A run is timed from the first frame's time to the end of the last frame, as `END-ON` is: 4 frames at 24 fps (0.167 s) are a finding, 3 (0.125 s) are not. Runs **one frame apart** merge, and the merged gap is not counted as over the bar. A finding's worst frame is the frame of its largest figure. Within a measure, findings are listed worst first.

| unit | measure | figure, per frame | bar | fix class |
| --- | --- | --- | --- | --- |
| head | eye-line tilt | \|direction difference\| of r_eye → l_eye | **> 15°** | not derivable |
| arms | direction, per mapped arm segment | \|direction difference\| | **> 20°** | **paint** inside a set's span, **rig** outside |
| arms | hand visibility, per hand | mean score of the hand's 21 points (or the wrist's score) on each side | reference **≥ 0.6** while render **< 0.4** | **depth** (#33) |
| body | torso length | \|mid_shoulder − mid_hip\| ÷ that side's median | the render's range **< 0.5 ×** the reference's, over the whole run | **motion** |
| body | hip vertical travel | mid_hip's y in hip widths | the same rule as torso length | **motion** |
| legs | direction, per mapped leg segment | \|direction difference\| | **> 20°** | **paint** inside a set's span, **rig** outside |
| legs | foot plant, per ankle | the ankle's speed in hip widths per frame (from the frame before) | render **> 0.05** while reference **< 0.02** | **motion** |
| cloth | lag, swing ratio, overshoot, per window | #34's three figures, on each side | outside #34's bands around the reference's figure | **rig** (physics) |

Why these bars ([#38](https://github.com/rig-c/pose/issues/38)):

- **20° for a segment's direction.** HQ's rule for a set's art is `drawn` ± 20°: the art may turn up to 20° from the angle it was painted at and still read. A bigger difference is an arm that looks different.
- **0.6 and 0.4 for a hand.** On the 13 s dance, the hands in front (S4) score 0.53–0.88 and the hands hidden behind the back (S1) score 0.41–0.57. 0.6 and 0.4 sit outside that overlap, one on each side.
- **15°** for the head's tilt, **0.05 / 0.02** hip widths per frame for a sliding foot, and **0.5 ×** of the reference's range for a missing bounce were fixed with the others before the dancer was measured.

**Units and segments.** The map says which segments are compared. An **arm** segment joins two of one side's shoulder, elbow and wrist, and a **leg** segment two of one side's hip, knee and ankle. A segment's name is `chain/bone`. Other chains, such as the trunk, the pelvis or the head, are not compared as segments. The head is measured on its eye line whatever the map says, and the body on its torso and hip. A mapped arm or leg segment whose point has a position on no frame of one side is refused (`COMPARE_JOINT_MISSING`, naming the chain, the bone, the point and the side).

**The fix class** is given only when it can be derived:

- **An arm or leg direction.** The finding's worst frame is checked against the spans in `--retarget-report` (its `switches`: each set's frames and the chains it depicts). Inside a span of a set that depicts the segment's chain, the class is **paint**: the drawing shown there is not this pose. Outside every such span it is **rig**: the art does not show the bone's direction. Without a report, a chain no set of the map depicts is **rig**. A chain some set depicts is not derivable, and the line names those sets.
- **Hand visibility** is **depth** ([#33](https://github.com/rig-c/pose/issues/33)): the hand is drawn behind something.
- **A foot slide or no bounce** is **motion**.
- **Cloth** is **rig**: the cloth is the rig's physics.
- **A head tilt** has no class in #38, so the line says it is not derivable.

**Hand visibility.** `rig-pose-sequence/1` carries body-18 only, so the hand points come from COCO-WholeBody files, one per side: `--reference-hands` and `--render-hands`. The shape is `{ "spec"?: "coco-wholebody-133", "fps"?, "width"?, "height"?, "source"?, "frames": [{ "t", "points": [[x, y, score] × 133] | null }] }`. The subject's left hand is points 91–111 and the right hand 112–132. A frame's figure is the mean score of the hand's 21 points. A `null` frame (nobody found) is not measured. Without the files, the wrist's score is read instead: an absent or `missing` wrist reads 0, as COCO's v = 0 does. The summary line then says `from wrist scores`. One of the two files without the other is refused with exit 2, because the two sides must be measured the same way.

**Body.** Each figure is read over the whole run, so the unit gives at most one finding per measure, `no bounce`, spanning every frame. Its figure is the ratio of the ranges, render ÷ reference. Its worst frame, the one the sheet draws, is the reference's frame farthest from its median. The summary line always gives both ranges.

**Cloth.** Cloth is measured only when both cloth tracks are given, with `--cloth-windows`. Without them the unit reads `not measured`. A cloth track is HQ's `rig-c-cloth-track/0`: `{ "spec": "rig-c-cloth-track/0", "subject"?, "method"?, "source"?, "fps"?, "frames_count"?, "units"?, "hipWidth": { "median", "unit": "picture px" | "rig world units" }, "origin"?, "axes"?, "skirtSwing"?, "frames": [{ "i", "t", "hip_x", "hip_y", "hip_w", "tilt_deg", "hem_mid", "hem_l", "hem_r", "hem_l_y", "hem_r_y", "hem_band_cx", "skirt_cx", "skirt_top", "skirt_bottom" }] }`, the frame keys all numbers. Every position is already divided by the subject's own median hip width, with x to the right. `hip_x` is the hips' midpoint and `hem_mid` the midpoint of the hem's leftmost and rightmost points in the lower half of the skirt ([#34](https://github.com/rig-c/pose/issues/34)'s hem); only those two and `t` are read. Any other spec, or a key outside that list, is refused (`COMPARE_CLOTH`). The three figures are #34's, as HQ's skirt criteria define them, ported from HQ's measuring script. On HQ's per-frame record of the dancer they reproduce its numbers exactly (reference A 0.958 / 2.634 / 0.061, B 0.696 / 1.409 / 0.000). Read through `rig-c-cloth-track/0`, whose values are rounded to 5 decimals, the reference's lag in A reads 0.959.

- Both signals are smoothed with a Gaussian, σ = 1 frame over ± 4 frames, ends padded, before differentiating (numpy's `gradient`).
- **lag**, in frames, hem after hip positive: the peak of the normalised cross-correlation of hip-x velocity with hem-x velocity over the window, searched over −6…+12 frames and refined by a parabola.
- **swing ratio**: per hip stroke, the hem's excursion over the hip's. A stroke runs from one hip reversal (a zero crossing of hip velocity) to the next and moves at least the stroke threshold. A wiggle under the threshold is dropped as a pair. The hem is read `round(lag)` frames after each reversal. The figure is the median over the window's strokes.
- **overshoot**: per stroke, how far the hem keeps travelling in the stroke's direction after the hips turn, within half of the next stroke (or 12 frames after the last), as a fraction of the hip stroke. The figure is the median.
- **The stroke threshold** is 0.2 *reference* hip widths: one physical size on both sides (the criteria's Revision 1), expressed in the render's own hip widths. A render track in rig world units is carried by the retarget's scale, `scale.factor` in `--retarget-report` (rig units per reference px): 0.2 × reference hip width × factor ÷ render hip width. On the dancer that is 0.2 × 128.1 × 0.54152 ÷ 92.202 = 0.1505, the criteria's own figure. Without the report it is refused (`COMPARE_CLOTH_SCALE`). A render track in picture px is carried by the torso, as the retarget scales the rig: 0.2 × (reference hip width ÷ reference torso) ÷ (render hip width ÷ render torso), each torso the sequence's median mid_hip → mid_shoulder. A reference track not in picture px is refused (`COMPARE_CLOTH_UNITS`). The `CLOTH` lines print both thresholds and how the render's was carried.
- **The bands**, per window, around the reference's own figure: lag ± 1.0 frame; swing ratio ± 25 %; overshoot ± 0.10, absolute, floored at 0. A render figure outside its band is a finding over the window's frames. A window with no stroke on one side is listed as not measured.
- A window is `t0-t1` in seconds, and windows are named A, B, … in the order given. A window's frames are `round((t − t₀) × fps)` up to the end, exclusive. A window of 12 frames or fewer is refused, since the lag search reaches 12.

**Output.** The first line gives the frames, the duration, both hip widths, and the report the spans came from. Then come one summary line per unit (`HEAD`, `ARMS`, `BODY`, `LEGS`, `CLOTH`) and one `FIND` line per finding. A summary line gives the unit's findings and, per measure, its findings, its worst figure with the subject and frame, the frames over the bar (in runs of any length), and the bar. A `FIND` line gives the unit, the measure, the subject and its points, the worst figure with both sides' readings and its frame, the frames and seconds, the frames over the bar, the bar, and the fix class with the reason. With cloth, a `CLOTH` line per window gives both sides' figures. The run ends with the number of findings.

`--report <file>` writes the same as JSON (`rig-pose-compare/1`):

- `inputs`, `frames`, `duration`, `hipWidth: { reference, render }`, `torso: { reference, render }` (medians, px);
- `rule: { findingSeconds, findingGap, timeTolerance }` and `bars` (every bar above, by name);
- `units: [{ unit, findings, notMeasured, measures: [{ measure, subjects, source, findings, overBar, notMeasured, bar, ranges? }] }]`;
- `findings: [{ unit, measure, subject, points, chain, frames: [first, last], seconds, over, worst: { frame, t, figure, reference, render }, figureUnit, bar, fix, fixWhy }]`;
- `cloth`: `null`, or `{ windows: [{ name, t, frames, reference, render, band }], stroke: { reference, render, carried } }`.

Numbers are rounded to 4 decimals, once, at the writer.

`--sheet <png>` draws the reference skeleton beside the render skeleton at each finding's worst frame, one row per finding, with the finding's own points marked in yellow. It never draws a video frame. A cloth finding is a figure over a window, with no single frame, so it has no row. When no finding has a frame, no sheet is written and the run says so.

**The control** is the reference compared with itself. It must report no finding in any unit, and every summary line says `0 findings`. On HQ's dancer (313 frames, RTMPose, with its whole-body hand points and the retarget's report) it does.

Exit codes: `0` compared, whether it found anything or not, since a finding is not a failure; `1` refused, with every reason printed; `2` bad invocation.

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
- **Plant feet** beyond what the pose gives (until `--plant-feet`, [#47](https://github.com/rig-c/pose/issues/47)), **hands and fingers** (no bones for them yet, rig-c/parts#171), mobile.

## Licence

MIT, see `LICENSE`.
