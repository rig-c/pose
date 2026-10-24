# Source skeleton beside an accepted rig

This recipe shows the accepted v3 Zero Two dance on the public dancer beside
its source skeleton at **600×540**. It consumes existing accepted art and
motion, authoring no pose, rig, repair or key. This is a **13-second take, not
a loop**. HQ owns site publication in a separate sibling PR; this delivery
preserves the site's swing assets and Play consumer.

![Source skeleton and accepted v3 rig](pose-dance.png)

## Committed source and pins

The only inputs are public [dancer/ at f8d86e3045c267171180efd2ac47604511f9cb62](https://github.com/rig-c/examples/tree/f8d86e3045c267171180efd2ac47604511f9cb62/dancer).
[inputs.json](inputs.json) lists all 209 files with exact SHA-256, byte counts
and Git blob IDs. The [committed source pose](https://github.com/rig-c/examples/blob/f8d86e3045c267171180efd2ac47604511f9cb62/dancer/accepted/sequence.json)
is `8713172431674a57caa8d7c3f452a05bf46ec8079ca368bb4cd9df7952c2edfd`;
the [map](https://github.com/rig-c/examples/blob/f8d86e3045c267171180efd2ac47604511f9cb62/dancer/map.json)
is `9dca5394f6c0cf9cc72e2456b53b41adf898b963a6081d9f6f9b3c2ad6191096`.
The source has 313 samples at 24 fps, already camera-normalized in picture
pixels. Inferred hips and camera declaration remain source provenance. No
acquisition, detector, footage, audio or picture-in-picture pixels are used.
Origin and generated-part provenance are in the pinned public corpus.

The accepted model is `a94c7cbee992acaf87c0e283efc1bbd44766441f791776064e929bd59a2f0e81`.
The 391 native RGBA PNG file bytes, concatenated f0000..f0390 without
separators, must hash to `b75fc5696ac468f3ea9f58cc892d79389d66bf6ce7aeb31428f95350b9121029`.
The recipe checks all three compiled digests, canonical rig/motion, source
sequence/map, runtime lock/packages and native digest before composition.
Mismatch stops without value changes. The corpus lock pins core 2.67.2,
spine-core 4.3.13, parts 1.60.0, pose 1.0.1 and play 1.16.0. Bun 1.4.2 and
Pillow 12.2.0 are the recipe pins. No retarget or generation runs.

## Commands

From this repository root, with Python 3.12, Bun 1.4.2, Node 24,
FFmpeg/ffprobe and Pillow 12.2.0, use the approved Nova pool with an aggregate
6 GiB/four-CPU limit including installation and children:

```sh
python3 -m pip install -r tools/visible-retarget.requirements.txt
python3 tools/visible-retarget.py selftest --out demo-selftest
python3 tools/visible-retarget.py run --out demo-v3
```

All output directories must be new. The default fetches the public corpus,
exercises the actual pose reader, invokes its unchanged default
`build-accepted-dance.sh`, then reads a fresh core `render --folds` diagnostic
at 30 fps with the accepted viewport. The diagnostic native digest is checked
too. Output includes MP4, WebM, poster, contact sheet, sampling, stage
diagnostics, ffprobe and a controlled preview. No other checkout is needed.

Incremental `run --reuse-replay <completed-v3-output>` may reuse an immutable
accepted replay only after the same exact canonical/build/native/runtime
checks. `compose --source <source/dancer> --replay <completed-v3-output> --out
<new-media-dir>` uses those checks too. The optional cache is never modified
and is not required by the default public recipe. To recompose pixel copy only,
`compose --reuse-diagnostic <completed-diagnostic-dir>` can reuse the already
measured v3 diagnostic: its published fold hash, accepted native PNG digest,
time base and viewport are verified before use. It does not rerun the native
render or change the recorded measurement stage. Large native frames and
runtime stay remote; only final small media and records need recovery.

## Timing and views

At render time `i/30`, source joints interpolate between actual bounding
timestamps. An exact timestamp reads only that frame; a joint missing,
unscored or below 0.3 at either endpoint is omitted. Real-reader fixtures
plant interpolation, endpoint, missing-joint and invalid-time cases.
`sampling.json` records every pair and weight.

Each panel keeps one view for the whole take: full scored-joint bounds with
5% padding for the source, accepted world viewport for the rig. These
independent picture/world views compare timing, not geometric error. Camera
normalization is never reapplied. Both time bases include 0 and 13 seconds;
391/30 encoded seconds is 13.033333… because the final sample is displayed for
one frame. There is no loop attribute or loop-seam claim.

## Stage provenance and limits

- **Historical v1 pre-hand LAND 20/20:** exact old lines are
  [committed separately](historical-stages.json), with old corpus/run and raw
  log/report hashes. They precede the intentional foot-goal edit and are not
  called freshly measured v3 LAND.
- **Accepted v3 gate 23 PASS / 0 FAIL / 13 SKIP / 14 excluded:** actual build
  log bound to verified source/model. Reuse is explicit; skips and exclusions
  are not passes.
- **Current v3 FOLD diagnostic:** measured on the accepted hand-passed build.
  Shins 269/391 is a diagnostic, not a gate. A contradiction is reported, not tuned away. The
  preview prints the verbatim raw fold line beside the other stage records.
- Old v1 foot-goal residual and FOLD 269/391 remain historical fields. New v3
  original-pose LAND, foot-goal residual, all-rig SEAM and same-detector
  compare remain unmeasured. No art or motion is changed for the presentation.

The final record/stills and browser validation carry their actual source and
output hashes after verification. This pose PR references #274; the site's
consumer is separately owned and is not claimed landed here.

## Completed validation

[record.json](record.json), [verification.json](verification.json),
[diagnostics.txt](diagnostics.txt) and [sampling.json](sampling.json) bind the
accepted v3 measurement and the later pixel-copy repair. Original typecheck,
lint, package dry run, reader controls and v3 pipeline exited 0. The accepted
hand-passed v3 FOLD269/391 is a diagnostic, not a gate. This repair reuses that
immutable diagnostic and native PNG digest; it performs no native render,
build, retarget, generation or hand work.

All 391 frames retain byte-identical figure-panel pixels. Every non-media
record field, sampling byte and diagnostic byte remains exact. The title,
panel labels and timestamp are the only text in the video pixels; version,
non-loop and diagnostic details remain in this documentation and records.
The native target stays `b75fc5696ac468f3ea9f58cc892d79389d66bf6ce7aeb31428f95350b9121029`.
MP4 is 793,736 bytes, SHA-256
`e71f26c35edd370a54e41eb718273b01d875118ff1c89d07914657e3a2c82eb8`;
WebM is 603,729 bytes, SHA-256
`bffcfa985f9a87286d232ec7e9130431b0060f960e760e14ac1e47f0204a8137`.
Small media are handed to the separate site sibling; no unlanded site URL is
claimed. [Revised contact sheet](contact-sheet.png).

Actual revised-media browser verification measured 600×540 CSS pixels,
playback 0.010050→4.493015 seconds, then ended/paused at
13.033333 seconds. Loop and autoplay were false; no media error or
warning/error logs occurred. Both figures and revised labels were readable;
the owned tab and server were closed. The source sampling remains byte-exact.

A private preflight wrapper used the wrong relative fixture path and failed
with ENOENT; submission proceeded before that wrapper was corrected. The
earlier actual reader/selftest had passed. The corrected absolute-path dry
run passed after submission; this ordering exception is retained separately
from the successful Nova and browser measurements in verification.json. This
violated the mandatory dry-run-before-first-Nova-submission rule; the private
final checkpoint records it prominently in CLOSE RETRO.

The first pixel-copy repair attempt failed before encoding because the cache
fold path was resolved at the diagnostic root. A local regression reproduced
that failure and passed after resolving the actual metadata set directory.
The absolute-path dry run and parent coordination gate passed before the
second repair submission, which completed composition and encoding. Both
attempts and their exact chronology remain in verification.json.

The original measured pipeline and diagnostic argument lists are in
verification.json (`actualPipelineCommand`, `actualDiagnosticCommand`). Named
workspace/cache placeholders replace only private path prefixes; flags and
values are unchanged. The later actual composition command and reuse proof
are recorded in `pixelCopyRepair`. The default public command needs no cache.
