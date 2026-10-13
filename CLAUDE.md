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
animation in rig-c's motion format: `rotate` keys on the mapped bones and
`translate` keys on the hip, checked through rig-c's gate before anything is
written.

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
  fallback for a missing field. The one stated substitution is the card's: a
  missing or low-score joint holds the last good value, and the run lists every
  frame it held, joint by joint. A joint with no good value yet is a refusal.
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
