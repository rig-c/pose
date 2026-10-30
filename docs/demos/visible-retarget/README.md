# Source skeleton beside an accepted rig

This recipe shows the accepted v3 Zero Two dance on the public dancer beside
its source skeleton at **600×540**. It consumes existing accepted art and
motion, authoring no pose, rig, repair or key. This is a **13-second take, not
a loop**; the GIF repeats playback of that take. HQ owns site publication in a separate sibling PR; this delivery
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

Each panel keeps one fixed view for the whole take: a scale-normalized source
viewport for the left panel (`Source pose (scale-normalized, display only)`),
and the accepted world viewport for the rig (`Rig`). Because the source
sequence's camera normalization removes camera translation but not camera zoom,
`compose` normalizes the displayed source skeleton per frame (display only; the
source sequence, retarget, rig and captured rig frames are unchanged) using the
body-length measure
`L_body = |neck - mid_hip| + 0.5 * (|r_hip - r_ankle| + |l_hip - l_ankle|)`
(with `mid_hip = 0.5 * (r_hip + l_hip)`) and lower-ankle ground anchor
`max(r_ankle.y, l_ankle.y)`, both smoothed over time with a 5-frame centered
moving average (`±2` frames at 30 fps) and scaled around the take-median hip
center and smoothed ground line. The fixed source viewport maps the take-median
body length to the rig's posed median `L_body` (`188.98 px`) and the ground
anchor to the rig's lower ankle bone (`y = 379.90 px`), keeping per-frame drawn
`L_body` variation at `3.05%` (`(max - min) / median`; `3.12%` `(max - min) / min`,
`0.00%` smoothed). Both time bases include 0 and 13 seconds; 391/30 encoded
seconds is 13.033333… because the final sample is displayed for one frame.
The MP4/WebM presentation has no loop attribute or loop-seam claim. The README
GIF separately repeats playback of the take.

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

All 391 frames retain byte-identical right-panel (`Rig`) pixels
(`e5b4b859b5c420dd014a1d6db2aae7eeece0707f9b3097762e8635a69bb41914`), while
the left panel draws the constant-scale source skeleton (#421). Every sampling
byte, diagnostic byte and non-viewport/non-media record field remains exact.
The title, panel labels and timestamp are the only text in the video pixels;
version, non-loop and diagnostic details remain in this documentation and
records. The native target stays
`b75fc5696ac468f3ea9f58cc892d79389d66bf6ce7aeb31428f95350b9121029`.
MP4 is 727,843 bytes, SHA-256
`4d63d9cab7f38c72851b29317e8a633fa9e29ab536e3c9fb2b6d3b3e7a269268`;
WebM is 570,358 bytes, SHA-256
`fab211560303caec9ba4fc08eec3bfde6ef31af2a65fb4c4b93a200c10e51861`.
GIF is 3,537,444 bytes, SHA-256
`d3a9f1b256fea6546372021b663bd067a3c8efd27218d2754d73c457b8c6f4cf`.
Its 196 frames use 60/70 ms GIF delays (13.07 seconds per playback), retain
600×540 pixels, and repeat indefinitely. The first declared encoding met the
5,000,000-byte cap; no reduced-width or lower-palette alternative was needed.

| Added media verification | Bytes | Frames / playback | Result |
| --- | ---: | --- | --- |
| README GIF | 3,537,444 | 196 / 13.07 s; loops playback | Within 5 MB; input/output hashes recorded |

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

## Animated README hero

The hero uses the committed **v3** take. Public dancer v4 was accepted in
[examples#71](https://github.com/rig-c/examples/issues/71#issuecomment-6395384506),
separately from the producer. Its replay writes `render-receipt.json`; the
current `compose --replay` reader requires `reproduction.json`, version `v3`,
and the exact v3 compiled/native hashes above. The real reader refused the
public v4 receipt layout before composition. Supporting v4 needs a separate
recipe update; this presentation does not relabel v3 or change the site's video.

The GIF input is the existing recipe's `pose-dance.mp4`, verified against
[record.json](record.json). Before encoding, the settings were fixed at
**15 fps, 600 px wide, 128 palette colours**, a full-clip palette, Bayer dither
(scale 5), and rectangle difference mode. Run in the Nova pool from the
recipe's media output directory (FFmpeg/ffprobe required):

```sh
ffprobe -v error -show_streams -show_format -of json pose-dance.mp4
ffmpeg -hide_banner -loglevel error -y -threads 4 -filter_complex_threads 1 \
  -i pose-dance.mp4 \
  -filter_complex 'fps=15,scale=600:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle' \
  -an -loop 0 pose-dance.gif
```

The take is not a motion loop. `-loop 0` repeats the GIF's playback, including
the visible end-to-start cut; it does not repair the take's seam. Input/output
SHA-256 and the recorded command are in [files.sha256.json](files.sha256.json);
[verification.json](verification.json) records the GIF and local README check.
Actual GitHub branch rendering remains HQ's check after push.

The local rendered README was checked on the Nova pool in Firefox 157.0
(Playwright 1.64.1), at 600×540 displayed pixels. Captured GIF frames
6 → 62 → 191 → 11 confirm motion and the playback restart; browser
warning/error logs were empty. The README capture and the native extrema/diff
were inspected for figure, joint-line and label legibility. Existing folds
remain disclosed. Five earlier validation-packet failures (bootstrap, Chromium
capture and a private fractional-CSS assertion) are recorded separately in
`verification.json`; they are not passes. No full suite was repeated for this
docs/assets change. GitHub branch animation and CI remain HQ's landing checks.
