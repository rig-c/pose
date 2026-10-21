# The gait levers: the road to "Choosing the approach"

This is a record, not a guide. The guide is README's [Choosing the approach](https://github.com/rig-c/pose#choosing-the-approach). This page says what was tried on the walk and the run before that table was written, what each attempt measured, and where each one ended.

One section per lever, in the order tried. Every figure is quoted from the issue or pull request linked beside it. Measurements made on a private rig or reference are named as such ("a drawn frontal walk reference", "a private frontal run reference"); where a public fixture reproduces the mechanism, it is named, and where the fixture was never landed, that is said too.

## 1. Pelvis read from the drawing

**Tried** ([#288](https://github.com/rig-c/pose/issues/288), [PR #291](https://github.com/rig-c/pose/pull/291)). A detector's hips keep little of a drawn pelvis tilt, and nothing after the scan restores it. So `rig-pose pelvis` reads the pelvis line from the frames, with a `silhouette` reader for a drawn pelvis and a `waistband` reader for a covered one, and `clean` and `retarget` carry it as its own track (`pelvisTilt`).

**Measured.**

| where | figure | source |
| --- | --- | --- |
| drawn frontal walk reference, before | drawn tilt "30.5° peak-to-peak"; DWPose's hips keep "4.5°", "correlation with the drawn line +0.27, gain 0.04" | [#288](https://github.com/rig-c/pose/issues/288) |
| same, before | `retarget` "copies the cleaned hip line to the pelvis bone to 0.000° in all 14 variants measured" | [#288](https://github.com/rig-c/pose/issues/288) |
| same, silhouette reader | "30.12° vs 30.51° = 0.987×", corr "+0.998"; no-track control "0.145× / +0.279" | [#288 acceptance](https://github.com/rig-c/pose/issues/288) |
| covered run reference, waistband reader | "0/10, all declined" — "fail by refusal" | [#288 acceptance](https://github.com/rig-c/pose/issues/288) |
| public fixture `examples/walk/make-pelvis.ts`, drawn | truth "30.00°", posed "30.67°", ratio "1.02", corr "0.9997"; no track "4.51°", "0.15" | [PR #291](https://github.com/rig-c/pose/pull/291) |
| same, covered | truth "24.00°", posed "23.76°", ratio "0.99" | [PR #291](https://github.com/rig-c/pose/pull/291) |

**Outcome: kept.** The silhouette reader carries the walk. The waistband reader declined every frame of the run, which went to its own card.

## 2. The waistband reader on dithered frames

**Tried** ([#293](https://github.com/rig-c/pose/issues/293), [PR #301](https://github.com/rig-c/pose/pull/301)). The run reference is a 216-colour dithered picture, and the reader's exact colour runs never held on it. The fix is a patch test that tolerates dither, and a scan that starts above the hips when they sit on the band's edge.

**Measured.**

| where | figure | source |
| --- | --- | --- |
| public fixture, `dithered` | "24/24 (before: 0/24)", swing "0.998×", corr "0.999" | [PR #301](https://github.com/rig-c/pose/pull/301) |
| public fixture, `dithered-edge` | "24/24 (before: 0/24)", swing "0.997×", corr "0.999" | [PR #301](https://github.com/rig-c/pose/pull/301) |
| #288's undithered variants | "byte-identical … (18 hashes)" | [PR #301](https://github.com/rig-c/pose/pull/301) |

**Outcome: kept.** On the private frontal run reference the reader now read, but read the wrong line (next section).

## 3. The band's top through a thin strip

**Tried** ([#318](https://github.com/rig-c/pose/issues/318), [PR #329](https://github.com/rig-c/pose/pull/329)). The card first assumed the reader was fitting a fold below the band and asked for a refusal rule. Measurement contradicted that premise, and the card was re-scoped to read the band's top edge through a strip too thin to carry its colour.

**Measured.**

| where | figure | source |
| --- | --- | --- |
| private frontal run reference, 0.40.0 | swing "19.06° at the drawn keys against the skirt-top proxy's 6.39° (2.98×, r = +0.63)"; hip-line fallback "6.08°" | [#318](https://github.com/rig-c/pose/issues/318) |
| premise check | the fitted edge "sits 7.7 px above the hips on one key and 4.9 px below on another, against a one-patch-radius limit of 11.6 px"; the cause is "two ink lines about 4–5 px apart" | [#318](https://github.com/rig-c/pose/issues/318) |
| the declared refusal rules alone | "from 2.98× to 1.98× against the 1.5× bar, so it fails" | [#318](https://github.com/rig-c/pose/issues/318) |
| band-top reader, public fold fixture | "23/24 read, max 0.96° off" | [PR #329](https://github.com/rig-c/pose/pull/329) |
| band-top reader, thin-strip fixture | "15/24 read, max 2.20° off"; with the climb removed, "13 frames read 15–31° off" | [PR #329](https://github.com/rig-c/pose/pull/329) |
| private frontal run reference | "rig hip swing 0.665× the proxy (0.40.0: 2.982×)"; key 2 "3.72° off", re-scoped to the hip span "where key 2 is 0.00° off" | [PR #329](https://github.com/rig-c/pose/pull/329) |

The PR states that the rule "went through **seven corrections after measurements**".

**Outcome: kept,** with rule B1 kept and rule A removed ("it declined nothing under the new reader"). The overshoot was gone. So was the visible tilt, which the owner's eye check caught next.

## 4. Below the cover

**Tried** ([#342](https://github.com/rig-c/pose/issues/342), [PR #350](https://github.com/rig-c/pose/pull/350)). The owner's check on the 0.42.0 run video: the run's pelvis tilt was not visible, with a swing of "4.56°, against 20.96° in 0.40.0". A first premise, that declined keys were flattened toward zero, was wrong: they "are already filled from their neighbours". The owner then named the cause: the tilt "is hidden by the sweater". The band-top reader was measuring a hem that "hangs level whatever the pelvis does". `--mode below-cover` reads the bottomwear's lower hem and the thigh roots instead.

**Measured.**

| where | figure | source |
| --- | --- | --- |
| public `sweater` fixture | "`below-cover` reads all 24 frames within 1.5°; `waistband` reads only the level cover" | [PR #350](https://github.com/rig-c/pose/pull/350) |
| private frontal run reference | keys 2, 4, 7 and 8 "read +8.7, +0.5, −16.5 and −11.1"; retargeted swing "22.7°, against 4.56° with the band top" | [PR #350](https://github.com/rig-c/pose/pull/350) |
| rejected rule: decline foreshortened thighs | "it declined 9 of 10 keys, and ordinary walk frames on the fixtures" | [PR #350](https://github.com/rig-c/pose/pull/350) |

**Outcome: kept.** The owner's verdict on the re-rendered run: "the run pelvis movement is visible." The known limit stayed in README: a thigh drawn in front of the garment reads as its hem.

## 5. Upper-body hold and the neck sway

**Tried** ([#344](https://github.com/rig-c/pose/issues/344), [PR #348](https://github.com/rig-c/pose/pull/348)). The owner's check on the walk: the upper body swung around the pelvis instead of the pelvis swaying under it. An animation cannot reparent a bone, so on an in-place walk `retarget` keys a counter-rotation on the first spine bone and moves the trunk along the drawn neck's sideways path. The card's bar, a neck held at "≤ 25 %" of the pelvis sway, was rewritten after measuring, because the drawing's own neck sways.

**Measured** (drawn walk reference):

| | neck x p-p ÷ hip x p-p | gap to drawn 0.441 | rig neck vs drawn neck (r) | source |
| --- | --- | --- | --- | --- |
| before | 6.482 | 6.04 | 0.37 | [PR #348](https://github.com/rig-c/pose/pull/348) |
| after | 0.409 | 0.032 | 1.00 | [PR #348](https://github.com/rig-c/pose/pull/348) |

The torso angle "matches the drawn trunk angle within 0.0005° on every frame", and the run is not anchored: its drawn torso sways ("neck 1.59× mid_hip"). The public test is `test/anchor.test.ts`.

**Outcome: kept.** The owner: "the torso now holds, but the pelvis moves on its own (the waist breaks) and its angle is too big."

## 6. The walk pelvis re-measure

**Tried** ([#351](https://github.com/rig-c/pose/issues/351)). The card proposed re-reading the walk pelvis with `below-cover`, since the walk keys were "0.40.0 silhouette readings, reused as they were: 30.12° swing", and measuring the waist seam.

**Measured.** Nothing new was run. The parking comment records the reason: "The pelvis angle was measured as the reference's own (30°); the waist break is rig structure".

**Outcome: parked** in [#351](https://github.com/rig-c/pose/issues/351), to re-open "when a rig with a weighted waist exists".

## 7. The set/key disagreement gate

**Tried** ([#355](https://github.com/rig-c/pose/issues/355), [PR #356](https://github.com/rig-c/pose/pull/356)). On the run, an alternate leg set's map key disagreed with its own drawing, and selection compared key directions only, so the set won on poses it was not drawn for. The fix refuses such a key by name (`SET_KEY_DRAWN`), shows a set only within its art-turn tolerance, and holds an end-on segment at its drawn angle.

**Measured.**

| where | figure | source |
| --- | --- | --- |
| private frontal run reference | "The left leg detaches on 128/190 frames … as 3 pieces, with a 36–42 px gap at the knee and 124–139 px at the ankle" | [#355](https://github.com/rig-c/pose/issues/355) |
| same | the key's shin "at −94.3°, while its drawn shin is +46.5°, a 140.8° disagreement"; pose aimed the stub shin "131–176° away from its drawn angle" | [#355](https://github.com/rig-c/pose/issues/355) |
| public set fixture | "6/6 frames within 25° (before: 6/12, up to 35°)" | [PR #356](https://github.com/rig-c/pose/pull/356) |
| private frontal run reference, key regenerated from `drawn` | "detached frames go from 128 to 0" | [PR #356](https://github.com/rig-c/pose/pull/356) |

**Outcome: kept.** A real defect. The owner's next check: the legs stayed joined, but "only the lower leg changes angle".

## 8. The back-kick lever comparison

**Tried** ([#357](https://github.com/rig-c/pose/issues/357)). A reading round with no code change: on the run's back-kick frames, render candidate levers side by side and let the owner's eye choose.

**Measured** (private frontal run reference): the lifted shin is end-on, "picture ratio 0.05–0.4, depth sign −1".

| candidate | read | source |
| --- | --- | --- |
| (a) the fold drawing shown on those frames | "reads as the leg going back"; "a large jump where the drawing switches on and off" | [#357](https://github.com/rig-c/pose/issues/357) |
| (b) thigh foreshortening ("−20%") | "reads as a shorter or lifted leg, not as leaning back" | [#357](https://github.com/rig-c/pose/issues/357) |
| (c) both | "like (a), with the thigh change hard to see" | [#357](https://github.com/rig-c/pose/issues/357) |
| (d) the end-on hold (`--short`) | "no jump, but no kick" | [#357](https://github.com/rig-c/pose/issues/357) |

"Only a drawing of the fold gave the read."

**Outcome: parked** in [#357](https://github.com/rig-c/pose/issues/357), by the owner's direction that awkward walk and run frames are fixed with replacement frame parts, not procedural levers. Its measurements stay as the record of which frames need art.

## 9. Knee-up by foreshortening

**Tried** ([#359](https://github.com/rig-c/pose/issues/359)). A thigh swinging toward the camera keeps its screen direction, so selection by direction alone can never pick a knee-up drawing. The card proposed declaring a drawn length ratio per set and selecting on it as well.

**Measured.** Nothing. The card holds no measurement. It was parked before a run, under the same direction as #357.

**Outcome: parked** in [#359](https://github.com/rig-c/pose/issues/359), in favour of drawing that frame part.

## 10. Draw order by shin depth

**Tried** ([#358](https://github.com/rig-c/pose/issues/358)). The owner's check on a back-kick frame: the foot that went back was drawn in front. The card proposed drawing a lifted shin with depth sign −1 behind the supporting leg; the owner then simplified it to a whole-leg swap.

**Measured.** All figures are from [#358's closing comment](https://github.com/rig-c/pose/issues/358):

| where | figure |
| --- | --- |
| rebuilt private run rig (leg slots contiguous) | with and without the opt-in shin rule, "byte-identical, and the rule never fires" |
| same, frames in question | the lifted shin is a nub: "picture ratio 0.045–0.09, depth sign −1"; its keypoints "sit 15–20 px clear of the supporting leg" |
| a turned synthetic run | the rule "agreed with true depth on 0 of 3–9 firing frames at 15–30° and 6 of 18 at 40°" |

The fixtures used for these measurements, including the turned synthetic run, were built only for this card and were **not landed**. They are not in this repository.

**Outcome: closed without a change.** The crossing lives in the posed rig, not in the keypoints. The keypoint shin never crosses the supporting leg; the rig draws a full-length shin along that nub's direction, and that drawn shin is what crosses in the render. The same comment records that a shin's depth sign "says it points away from the camera, not that it is behind the other leg". No card follows; the mechanism is recorded in the issue.

## 11. The forearm order

**Tried** ([#346](https://github.com/rig-c/pose/issues/346), [PR #363](https://github.com/rig-c/pose/pull/363)). Filed from the same 0.42.0 run check as #342 and #344: "both forearms should be in front of the body, but they are drawn behind it". `--draw-order depth` keyed only the leg pair. The fix waited on the parts side: limb slots made adjacent (rig-c/parts#646) and an explicit limb layout, `layout.json` (rig-c/parts#647). Pose keys each forearm against the trunk only from a layout its map binds explicitly.

**Measured.**

| where | figure | source |
| --- | --- | --- |
| frontal run fixture | depth says in front "on 48 of 60 frames. All 48 are keyed in front, and the setup order holds on the other 12" | [PR #363](https://github.com/rig-c/pose/pull/363) |
| mutant, front rule removed | "in front on 0 frames, against 48" | [PR #363](https://github.com/rig-c/pose/pull/363) |
| truth against the generator | run frontal "27/27", run turned 40° "27/27", walk frontal "4/4", walk turned 40° "0/4" | [PR #363](https://github.com/rig-c/pose/pull/363) |
| rejected: a wrist ≥ 0 veto | fixes "15/18 → 18/18 behind", "but loses 3 frames truly in front" | [PR #363](https://github.com/rig-c/pose/pull/363) |

The public producer file is `test/fixtures/parts-layout/`.

**Outcome: kept.** A real defect. Known limit: on a single-torso rig only one forearm can be placed until rig-c/parts#657 lands.

## 12. `bind`

**Tried** ([#360](https://github.com/rig-c/pose/issues/360), [PR #362](https://github.com/rig-c/pose/pull/362)). Once replacement frame parts became the route, there was no honest way to show a set on given frames. A `frames` window only limits where a set may be picked; #357's candidate (a) "needed three fakes" and ten windows. `bind` shows a set on exactly the frames it names, explicitly or per cycle, with no key test, no art-turn gate, no switch-min, no bridging and no hysteresis.

**Measured.**

| where | figure | source |
| --- | --- | --- |
| key far from the pose | key "120° from the pose (the tolerance is 25°) shows on 5/5 bound frames and 0 outside" | [PR #362](https://github.com/rig-c/pose/pull/362) |
| mutant, bind read as a window | "the far-key bind shows 0/5 and the 1-frame bind 0/1" | [PR #362](https://github.com/rig-c/pose/pull/362) |
| maps without `bind` | "byte-identical to main across all 376 retarget-test inputs" | [PR #362](https://github.com/rig-c/pose/pull/362) |

The public test is `test/bind.test.ts`.

**Outcome: kept.** This is the mechanism the conclusion rests on.

## The conclusion

README's [Choosing the approach](https://github.com/rig-c/pose#choosing-the-approach) table ([#361](https://github.com/rig-c/pose/issues/361)) is the conclusion. It is not repeated here.

## Real defects fixed along the way

| issue | fixed by |
| --- | --- |
| [#355](https://github.com/rig-c/pose/issues/355): a set key that disagrees with its drawing won selection | [PR #356](https://github.com/rig-c/pose/pull/356) |
| [#346](https://github.com/rig-c/pose/issues/346): forearms never keyed against the trunk | [PR #363](https://github.com/rig-c/pose/pull/363) |
| [#360](https://github.com/rig-c/pose/issues/360): no way to show a set on given frames without forged keys | [PR #362](https://github.com/rig-c/pose/pull/362) |
| rig-c/parts#646 | parts side: legs contiguous |
| rig-c/parts#647 | parts side: the limb layout (layout.json) |
| rig-c/parts#657 | parts side, open |
