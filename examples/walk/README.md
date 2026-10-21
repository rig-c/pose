# The walk

A runnable loop with no art and no video, on the wave's stick figure:

- `pose.json`: one walk cycle in place at 24 fps, written by `make-walk.ts` from joint angles and passed through `rig-pose clean` with `--loop` (legs 5, rest 7, the stillness hold off), so it carries the `cleaned` record `retarget` requires and is declared `"travel": "in-place"` (`bun examples/walk/make-walk.ts` writes it again);
- `map.json`: the wave's map. The hinges are `"bend": "free"`, the legs have no `range`;
- the rig is the wave's (`examples/wave/rig`): the figure has the same bone lengths;
- `make-pelvis.ts` ([#288](https://github.com/rig-c/pose/issues/288)): the same cycle with a drawn pelvis tilt, −15·sin φ (30° peak to peak), drawn as line-art PNG frames with rig-c's plate, beside hip keypoints that keep 0.15 of it, as a detector's do. Three variants: `drawn` (the pelvis an outlined trapezoid along the tilt), `covered` (a garment band whose top edge turns 12·cos φ, its hem level) and `masked` (the pelvis painted out). `bun examples/walk/make-pelvis.ts <out-dir> [drawn|covered|masked]` writes the frames and the sequence (before clean); `test/pelvis.test.ts` writes them into a temporary folder. `walkCycle` takes the tilt as an option, so without it `pose.json` is unchanged.
- `make-depth.ts` ([#281](https://github.com/rig-c/pose/issues/281)): the same proportions made in 3D from joint angles — a run in place (3 strides of 20 frames, the swinging shin kicked back to 0.41 of its length), a walk (2 strides of 24, the lifted foot forward) — and drawn by a camera in front of the figure, behind it or beside it, so the generator knows every joint's true depth: per frame each limb segment's true sign and the limbs' true front-to-back order, the table `clean --depth` and the report's `layers` are held to. `bun examples/walk/make-depth.ts <out-dir>` writes `run.json`, `walk.json` and `side.json` (before clean); `test/depth.test.ts` writes them into a temporary folder.

```sh
rig-pose retarget --rig examples/wave/rig --map examples/walk/map.json --sequence examples/walk/pose.json --out walk.motion.json --name walk --plant-feet --leg-scale 0.8,1.05 --build walk-build
```

`--leg-scale 0.8,1.05` keys the swinging leg's foreshortening as a `scalex` on its thigh and shin; without it the rig's legs keep their full length and only turn. The range clamps no frame here: the thigh's picture length ÷ straight bottoms out at 0.850 at mid-swing and the shin's at 0.970, both inside it, so the last LEG-SCALE line adds `no frame clamped on any leg segment: the range [0.8, 1.05] holds the picture's whole spread, picture length ÷ straight 0.850 … 1.000 over the 4 segment(s)`. A floor above 0.850 clamps the thigh at mid-swing: `--leg-scale 0.9,1.05` clamps 5 frames on each (frames 16–20 right, 4–8 left).

## The cycle

One stride, right foot strike to the next, is 24 frames (1 s). Frame i is drawn at the phase φ = 2π·i/24, and every joint is a function of φ alone (sines and cosines of φ and 2φ). Frame 24 would be frame 0 again, so it is not written: the file holds frames 0–23, and the last runs into the first.

The figure faces the camera, so a leg swinging forward is drawn foreshortened (shorter in the picture) rather than turned. Angles are in degrees, counter-clockwise, y up; the figure is 330 px from nose to ankle on a 400 × 600 picture. The right leg swings for φ in [π, 2π] and the left for φ in [0, π]; on its swing half a leg's weight is w = sin² φ, and 0 on its supporting half.

| Part | Motion |
| --- | --- |
| Swing foreshortening | the swinging thigh is drawn 80·(1 − 0.15·w) px and its shin 70·(1 − 0.03·w) px: down to 0.85 and 0.97 of their length at mid-swing, the supporting leg at full length. The swinging ankle rises up to 15.4 px above the supporting one |
| Thighs | both −90 + 4·sin φ: as the swinging leg turns out, the supporting one turns in under the body, so in the picture both tilt the same way |
| Knees | the swinging shin turns outward from its thigh by 8·w; the supporting knee is straight, so a knee bends one way only |
| Pelvis | mid_hip x fixed at 200 (in place); y 400 + 3·cos 2φ, lowest at each foot strike |
| Trunk | leans 2·sin φ toward the supporting foot; the neck is 150 px from mid_hip along it |
| Head | nose, eyes and ears fixed on the neck, upright: no nod |
| Arms | both upper arms −10·sin φ from the wave's resting −100° (right) and −80° (left), against the legs; the forearms the same swing 3 frames later, so an elbow bends 20° ± 7.7° |

## Tuning

The constants above were judged on a limb-cut rig seen from the front, one cycle drawn beside the stick figure. What reads as a walk there is the stride in *length* (the swinging segments foreshortened, the foot lifted), not in planar angle: a shin turned out from its thigh reads as a small sideways kick once the thighs are visible, so keep the shin within about 3° of its thigh and let the stride live in the foreshortening — both segments toward 0.85 of their length, the lift around 20 px. The 8·w knee turn and the 0.97 shin here are the skirted-rig values; retune them on the rig the clip is made on, from its picture.

## The loop, as data

Every joint's step from frame 23 to frame 0 is no larger than its largest step between two frames inside the cycle: at most 1.000 of it (the left elbow, whose seam step equals its largest) and 0.27–0.98 for every other joint, the same before and after `clean`. Retargeted onto the wave's rig with the command above, each rotate key's step from its last key to its first is likewise at most its largest step between neighbouring keys (1.000 of it at most), each `scalex` key's step from last to first is at most 0.30 of its largest step between neighbouring keys, and the hip's x on the last frame is the first's.

The motion holds 24 keys per track, `t` 0 to 0.958333 s, and its `duration` is 0.958333 s: the last key is frame 23, not a repeat of frame 0.
