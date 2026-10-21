# CLAUDE.md

Guidance for AI-assisted sessions working on this repository. `AGENTS.md` is a
link to this file.

## What this is

`@rig-c/pose` (this repository, `rig-c/pose`; the command is `rig-pose`) puts
motion from a pose onto a rig. Its input is a rig that
[rig-c](https://github.com/rig-c/core) built (the compiled
`skeleton.model.json`, or the `rig.json` it was built from), a joint map naming
which bones carry which body joints, and a pose sequence — body-18 joint
positions over time, in picture pixels, y down. Its output is one named
animation in rig-c's motion format: `rotate` keys on the mapped bones,
`translate` keys on the hip, and `attachment` keys where the map's alternate
drawings switch in, checked through rig-c's gate before anything is written.

**0.x is the prototype.** 0.1.0 is the first release and promises nothing about
stability; the format, the command and the output may change in any 0.x release.
The card that defines 0.1.0 is rig-c/pose#1.

It sits beside the rest of the toolchain: rig-c (`rig-c`, the compiler, the
gate and the poser), `@rig-c/parts` (a rig from a painting), `@rig-c/play` (plays
a rig in the DOM). A change that belongs in rig-c or @rig-c/parts is filed
there as an issue, not made here.

## The doctrine: a tool for agents that cannot see the rig

An agent putting a dance on a rig cannot see the dance, the rig or the result. A
retarget that only reports "done" lets it ship an elbow bent backwards and be
sincere about it. rig-pose exists, like rig-c under it, to turn that silence
into named failures.

- **The messages are the UI.** Every failure names the object, the value found
  and the value required — the joint, the bone, the frame and the number:
  `POSE_ELBOW_BENDS_ONE_WAY: chain "arm_r" (r_shoulder → r_elbow → r_wrist),
  frame 41 (t=1.367s) — inner angle -23.4°; the rest pose bends +, so the key
  must stay ≥ 0`. "invalid pose" is not a message this repository writes.
  Readers collect every problem and report them all in one run.
- **Everything resolves by name, and a miss is refused by name.** A map entry
  naming a bone the rig does not have, a joint body-18 does not have, a chain
  whose bones are not parent and child — each is refused naming both sides.
- **Never invent a value.** No defaults guessed from the pose, no "reasonable"
  fallback for a missing field. Four substitutions are stated. The card's: a
  missing or low-score joint holds the last good value (before its first good
  frame, that first good value), and the run prints a `HOLD` line for every
  span it held, joint by joint. A joint the map needs that is good on no frame
  is a refusal. #22's short hold: a segment shorter in the picture than
  `--short` of its median length has its angle interpolated from the frames
  either side, and the run prints a `SHORT` line for every span (and `END-ON`
  for a run lasting ≥ 0.15 s). #15's flip guard: a segment turning more
  than `--flip` degrees in one frame is spread over the frames around the jump,
  and the run prints a `FLIP` line for every spread. And #6's range clamp: a
  bone whose rotate key leaves its chain's `range`, outside the spans of a set
  depicting that chain, is clamped at the limit, and the run prints a `RANGE`
  line for every run.
- **The rest pose is rig-c's.** Bone world transforms come from rig-c's own
  poser; this package never re-derives a setup pose, a world matrix or the
  y flip.
- **Emit only after green.** The motion file is written only after rig-c's gate
  passed with the animation in, and every check this package owns passed.
- **A gate nobody has seen fail is not a gate.** Every check has a planted
  input that must make it fire beside the control that must not. The retarget's
  own correctness is held by a synthetic pose with known angles, and by a
  mutant (a flipped sign) that must make that test red.
- **Determinism is a contract.** The same inputs write the same bytes: fixed
  key order, stable sorts, no clock, no randomness, numbers rounded once at the
  writer.
- **Numbers carry their source.** A figure in a comment, a document or a pull
  request is measured and says against what, or it is not written.

## How the pieces fit

| File | What it owns |
| --- | --- |
| `src/pose.ts` | `rig-pose-sequence/1` (the reader, the writer), its `cleaned` record, and the COCO-17 conversion |
| `src/pelvis.ts` | `rig-pose pelvis` (#288): the pelvis line read off PNG frames (rig-c's plate) — the `silhouette` and `waistband` readers, each frame read or declined (null, never guessed); the `rig-pose-pelvis-keys/1` hand override; the track written into the sequence (`pelvisTilt`, `pelvisSource`, minor 1.1) |
| `src/depth.ts` | derived depth (#281): each limb segment's ratio (drawn ÷ the larger side's 95th-percentile length) and sign from the body's table (thigh and forearm forward, the upper arm with the opposite leg, the shin by the gait — `clean --depth walk|run`), forward set by the trunk's facing; the limbs' front-to-back `layers` and the `DEPTH` line (minor 1.2's `depth` is read and written in `src/pose.ts`) |
| `src/clean.ts` | the pure `clean` (#67): spikes (0.2 trunk from a 5-frame median; edge frames untested and named), the occlusion median, the per-joint quadratic Savitzky–Golay (legs, rest; circular under loop), the floor re-pin, jitter, the `cleaned` record |
| `src/joints.ts` | the vocabulary: body-18, the virtual midpoints, COCO-17 and its mapping |
| `src/map.ts` | `rig-pose-map/1` and its resolution against the rig's bones and, for `alternates`, its slots and attachments; a chain's `range`; a set's `place: "by-hip"` and the chains it places (#93) |
| `src/retarget.ts` | the pure retarget: holds, hip travel, angles, the TURN reading, the short hold and its end-on runs, the flip guard, the hinge check, reaches, the switches, the range clamp, a wrist placed against the head (#62) or the hip (#93), keys |
| `src/legs.ts` | the legs (#47): leg segments and each side's ankle, the leg scale and its clamp, the legs' path posed through a scaled bone (the keys that land a bone under one), the supports and jumps, the hip from the supporting foot |
| `src/contacts.ts` | `--contact-keys` (#303): `rig-pose-contact-keys/1` read against the sequence (a step function, fractional frames), applied last over the supports `legs.ts` read (`contactKeysOf`), and its FEET lines |
| `src/switch.ts` | the pure attachment switches: each set's distance to the pose, the spans it shows, where each boundary is keyed (where selected, or with `--switch-at peak` the fastest frame of its window that keeps the set within 2 × tolerance, #31), the `attachment` and offset keys, the art turn and its range, the folds no switch covers |
| `src/idle.ts` | the pure idle reading (#43 item 2): which of the idle's tracks the new animation drops, keys itself (channel by channel), or must leave out because they turn a bone above a mapped one; `--carry-idle`'s loop (seams, holds, setup keys, the cut and its Bézier split); the `rig-pose-tracks/1` fragment `--merge` reads and its conflicts |
| `src/reduce.ts` | the pure key reduction (#32): each mapped bone's dense rotate keys (and the hip's translate) thinned to linear spans and raw Bézier curves on the pose's frame times, top-down so a bone's world error is its own fit error; the curve evaluated as rig-c's poser does (its 10-piece polyline). With the leg flags (#94) it runs last on the final keys: the legs' `scalex` keys are reduced within half the landing check's scale tolerance, and a bone under a scaled bone is re-solved through its reduced parent and fitted on the world aim and length it lands on |
| `src/rigc.ts` | everything that touches rig-c's CLI or the disk: the gate (`rigc build`), the folds (`rigc render --folds`), the seam render (`rigc render --seam`, #216); the built rig's slots and what moves an attachment |
| `src/seams.ts` | the pure seam projection (#216): the neighbour pairs @rig-c/parts' `parts.json` declares (`--parts`), the one-cell floor (@rig-c/parts#503's rule), `seam.json`'s spans as the report's `seams` and `seamPairs`, the `SEAM` lines |
| `src/provenance.ts` | the pure build record (#270): `retarget.json` (`rig-pose-retarget/1`) — its name (`PROVENANCE_FILE`), its fixed key order, `reference` only when given; `run.ts` hashes and writes it beside `--build` |
| `src/outdir.ts` | where every command's output goes (#239, #284): the directory a written file names, made just before the write with its `made directory` line, or refused by name (`ARG_PATH`) when a file is in the way or it cannot be written into |
| `src/verify.ts` | where the gated build actually put each bone, posed by rig-c's own poser; the posture reading (hip tilt, sway) |
| `src/run.ts` | `retarget` end to end, in the order: refuse a sequence `clean` did not write (`POSE_NOT_CLEANED`), gate the rig as it is, retarget (switches and range clamp included), reduce the keys, read the idle (and carry it, merge a fragment), gate with the animation in, measure, read folds and which no switch covers, read the seams, write (with `--build`, the build and its record) |
| `src/compare.ts` | the pure `compare` (#38): the reference against the render on one time base, per unit (head, arms, body, legs, cloth); the bars, the finding rule, the fix classes; the hands, cloth-track and retarget-report readers; #34's cloth figures ported from HQ's `metrics.py`; the lines and `rig-pose-compare/1` |
| `src/sheet.ts` | the compare sheet: reference and render skeletons side by side at each finding's worst frame, drawn with rig-c's plate (no video) |
| `src/runcompare.ts` | `compare` end to end: read every input (all refusals together), compare, print, write the report and the sheet |

- **The key formula and its assumption.** rig-c's `rotate` key adds to the
  setup rotation, and a child with the `normal` inherit mode turns with its
  parent, so `key = turn(bone) − turn(nearest mapped bone above)`. That holds
  for unit-scale, unsheared bones with no constraint pulling them; a rig outside
  it is not refused by a guess — `verify.ts` measures the landing and
  `POSE_LANDS` names the bone that missed. `--leg-scale` breaks the assumption
  on purpose: a bone under a scaled leg segment is keyed through its parent's
  posed matrix instead (`legs.ts`, `posePath`), and the landing check holds it
  to its target and its scale like any other.
- **rig-c's gate runs through its launcher** (`rig-c/bin/rigc`), which picks the
  spine-core round trip where `@esotericsoftware/spine-core` resolves (this
  repository's development dependency, as in @rig-c/parts) and rigc's own gate
  where it does not (an install of this package).

- **`compare`'s bars are grading lines.** They were fixed in rig-c/pose#38
  before any render was measured, and rig-c/exam grades against them. A change
  to a bar, the finding rule or a figure's definition is a new comment on the
  issue first, then `src/compare.ts` (`BARS`, `CLOTH`) and the README's
  "Compare" section together. A finding is not a failure: `compare` exits 0
  whenever it compared.

## Conventions

- Bun + TypeScript, ESM, `.ts` extensions in relative imports, `strict: true`,
  no `any` (`bun run lint`).
- `src/` is pure: no clock, no randomness, no network, no child processes —
  except where it calls rig-c's gate, which is named as such.
- `tools/` holds the scripts that made the demo (pose extraction with a pose
  model, the clip and the contact sheet). They are not shipped and may be
  Python; they record what they ran on.
- Public surfaces carry public material only. The demo's rig is the painting of
  rig-c/exam task 01, and its pose comes from *Carmencita* (1894), public
  domain. No private project, corpus or consumer's art enters this tree, an
  issue or the npm package.
- English only, in every tracked file.
- Conventional Commits with a scope, English subject and body. `feat` bumps the
  minor, `fix`/`perf`/`check` the patch; the hidden types (`docs`, `chore`,
  `test`, …) do not release, and CI's `ships` job refuses a landing that
  changes a packed file under one (RELEASING.md).

## Verification — run these before you call a unit finished

| Command | Checks |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit`, strict, over `cli.ts`, `src`, `test`, `scripts`, `tools` |
| `bun run lint` | one rule: `@typescript-eslint/no-explicit-any` as an error |
| `bun test` | the unit tests, each check's planted failure beside its control, the synthetic-pose retarget and its mutant |
| `npm pack --dry-run` | what the package ships; no document keeps that list by hand |

## Working with the command post

This repository is commanded by one session at a time, and a command post (HQ)
issues its work. The protocol between them lived in chat and eroded every time
a session rotated, so it is here.

- **One issue = one PR**, squash-merged. The issue is the order: decision,
  bars, what is out of scope. A message that changes an order is copied to the
  issue.
- **A feature PR is opened and reported, and merged only after HQ's sign.** A
  `release: vX.Y.Z` PR from release-please merges on the sub-commander's own
  call, and so does the cut it makes (RELEASING.md *Cutting a release*). AI
  review is HQ's: it runs at HQ's request, at most once per PR.
- **A cut is confirmed, not assumed.** After the `release` run: `npm view
  @rig-c/pose version` names the new version, an install into an empty
  directory runs, one `rig-pose retarget --build` on the exam rig from that
  install comes back green, and the report carries the editor round-trip line.
- **The report**, sent when an issue lands or stops: ① the PR and its merge SHA
  ② a verification table — command, exit code, figures ③ every claim in the
  issue that was contradicted, with the measurement ④ what was rejected, with
  the reason ⑤ `STOP` and what blocks, when blocked.
- 🚨 **Figures and names in a report or a document come from
  `git diff origin/main...HEAD` and the run's own output, read in the same turn
  as the report** — never from the session's memory of the work. Compaction
  keeps an early scratch figure at the same weight as the final code, and that
  is the measured way a report comes to describe a branch that does not exist.
- **Artefacts for HQ go to the absolute path the card names, in the private
  workspace — never under a public tree.** `git status -s` runs before every
  report, and any tracked file touched is named in it.
- **No private names on a public surface** — issues, PRs, commits, code and
  docs carry no private corpus, character, game or consumer-project name and
  no local path. A card handed down for this repository is written to that
  line too.
- **A prose cap in a card applies to prose, not to tables.** A table is the
  measurement; cutting rows to meet a word count deletes evidence.
- **A worktree is removed with the merge that ends it**, along with its local
  branch; nothing untracked is left in it.
