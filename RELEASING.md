# Releasing

The machinery is @rig-c/parts' (its `RELEASING.md` is the long version, with
the measurements behind each step); this file says what is the same and what
differs here.

## The loop

Every push to `main` runs [`release.yml`](.github/workflows/release.yml), which
hands the new commits to release-please:

- **Nothing releasable since the last tag** → nothing happens. `docs`, `test`,
  `ci`, `build`, `chore`, `refactor` and `style` are hidden and do not open a
  release on their own; `release-please-config.json` writes the whole
  `changelog-sections` list out, with `check` → *Instrument* visible.
- **Something releasable** → it opens or updates a pull request titled
  `release: vX.Y.Z` that bumps `package.json`, `CHANGELOG.md` and
  `.release-please-manifest.json`. `feat` bumps the minor; `fix`, `perf` and
  `check` the patch; a breaking marker bumps the minor while the package is
  pre-1.0. `Release-As: X.Y.Z` in a commit footer forces a version.
- **That pull request is merged** (squash, so the subject stays
  `release: vX.Y.Z`) → release-please tags `vX.Y.Z`, cuts the GitHub release,
  and the same run publishes and confirms.

⚠️ A shipped file can change under a hidden type: the package is the `files`
allowlist plus `package.json`, `README.md` and `LICENSE`. CI's `ships` job
refuses that landing; the remedy is a visible type or a `Release-As:` footer in
a commit message on the branch.

## Cutting a release

1. Land the work on `main` with conventional-commit subjects.
2. Read the `release: vX.Y.Z` pull request's diff — the version and the
   changelog are the review.
3. Approve its `ci` run (a run started by `GITHUB_TOKEN` lands in
   `action_required`): **Approve and run** in the Actions tab, or
   `gh api -X POST repos/rig-c/pose/actions/runs/<id>/approve`.
4. Merge it. That is the cut.
5. Watch the second `release` run: tag, release, publish, then
   `scripts/confirm_registry.sh`, which installs the published version into an
   empty directory, runs `rig-pose --version`, then retargets the public wave
   from the install and holds its motion to the pinned bytes
   (`scripts/smoke_install.sh`, rig-c/pose#260; exit 3 = the registry did not
   serve it in time; re-run with Actions → release → Run workflow).

Before any of that, every pull request's `install` job packs the branch, runs
the same smoke on the tarball, and plants two failures beside it
(`scripts/smoke_mutants.sh`): a `src` module left out of the tarball must go
red at `--version`, and the gate's launcher resolved by a name the install does
not have must go red at the retarget — a failure `--version` alone passes.

## The first publish, and trusted publishing (owner)

npm trusted publishing is configured on a package's settings page, which does
not exist until the package does. So either the first version goes up by hand
from the tagged tree —

```sh
npm whoami                       # a member of the rig-c organisation on npmjs.com
git checkout v0.1.0
bun install --frozen-lockfile
npm publish                      # runs prepublishOnly, then asks for the OTP
```

— or the owner sets up the trusted publisher first where npm allows it for a
package not yet published. Either way the form, on npmjs.com → `@rig-c/pose` →
Settings → Trusted Publisher → GitHub Actions, reads:

- Organization or user: `rig-c`
- Repository: `pose`
- Workflow filename: `release.yml`
- Environment name: *blank*

Then Settings → Publishing access → *Require two-factor authentication and
disallow tokens*. The fields are case-sensitive and not validated on save; a
typo surfaces only as a refused publish.

**One-time GitHub setting (owner):** Settings → Actions → General → Workflow
permissions → tick *Allow GitHub Actions to create and approve pull requests*,
or release-please cannot open the release pull request.

## What 1.x promises

From 1.0, the surface below is split in two ([#262](https://github.com/rig-c/pose/issues/262)):

- **promised**: kept through every 1.x release. Changing or removing it is a major release.
- **courtesy**: may change in a minor release, and the CHANGELOG says so.

### How the split was made

The split is derived from **use**, not chosen. An item is promised when a user recorded at 1.0 relies on it, and courtesy otherwise, however useful it is. The uses were read on 2026-10-19 from each repository's default branch:

- **S**: the public exam's problem sheets and graders (rig-c/exam `advanced/R1`–`R3`, edition 0.21). This covers what a sheet tells an examinee to run or read, and what `tools/grade.py` reads from a report or from stderr.
- **X n**: the exam's sittings (`advanced/results/`). *n* is how many of the fifteen sittings typed the flag in a `rig-pose` command, working from the public docs only. These are the users this tool is built for.
- **R**: rig-c/review's report reader (`src/report.ts`), which reads `rig-pose-report/1`.
- **D**: the org's own documents: rig-c.github.io (the pose page and `llms-full.txt`) and rig-c/getting-started.
- **C**: the report contract frozen by #209 (#217's gate 2), for keys a reader of the time base relies on.

No other repository in the org (core, parts, play, adapters, parts-examples, trailer) runs `rig-pose` or reads its files.

### What a promise covers

- **A command or flag**: its name, its argument form, and what it does. Its default figure is courtesy: figures are re-measured. Where a figure was read off one reference (the README says which, e.g. `--stance 0.07` off a dance), it stays the README's advice, not a promise.
- **An alias** is promised as an alias.
- **A file format** (`spec`): its name, and every field a promised reader reads.
- **A report key**: its name, its type, and the row fields listed beside it.
- **A problem code**: that code still names that failure, on a `FAIL  <CODE>: <text>` line on stderr, with exit 1. The text after the code is courtesy: messages are the interface, and they are improved.
- **A line tag** (`LAND`, `FEET`, …): that the reading it names is still printed under that tag. The text after it is courtesy.

### Exit codes, commands and formats

| item | status | use |
| --- | --- | --- |
| exit `0` written · `1` refused (every problem printed, nothing written) · `2` bad invocation | promised | S, X, D |
| `rig-pose retarget` | promised | S, X, D |
| `rig-pose clean` | promised | D |
| `rig-pose pelvis` (rig-c/pose#288) | courtesy | — |
| `rig-pose compare` | promised | S (the R3 sheet offers it) |
| `rig-pose convert` | courtesy | — |
| `rig-pose --version`, `--help` | promised | S, X |
| `rig-pose-sequence/1` (the pose) | promised | S, R, D |
| `rig-pose-sequence/1.1` (the pose with the pelvis track, `pelvisTilt` and `pelvisSource`, rig-c/pose#288) | courtesy | — |
| `rig-pose-pelvis-keys/1` (`pelvis --pelvis-keys`; fractional frames, rig-c/pose#294) | courtesy | — |
| `rig-pose-map/1` (the map) | promised | S, X, D |
| `rig-pose-report/1` (the report) | promised, as below | S, R |
| `rig-pose-camera/1` (`--camera`) | promised | S |
| `rig-pose-tracks/1` (`--merge`), `rig-pose-compare/1` (`compare --report`) | courtesy | — |
| `rig-pose-retarget/1` (`--build`'s `retarget.json`, rig-c/pose#270) | courtesy | — |

### Flags

Every flag `parseFlags` reads in `cli.ts`, once. `test/promise.test.ts` holds this table against `cli.ts`.

| command | flag | status | use | note |
| --- | --- | --- | --- | --- |
| `pelvis` | `--pose` | courtesy | — | |
| `pelvis` | `--out` | courtesy | — | |
| `pelvis` | `--frames` | courtesy | — | |
| `pelvis` | `--mode` | courtesy | — | |
| `pelvis` | `--pelvis-keys` | courtesy | — | |
| `pelvis` | `--person` | courtesy | — | |
| `clean` | `--pose` | promised | D | |
| `clean` | `--out` | promised | D | |
| `clean` | `--legs` | courtesy | — | |
| `clean` | `--rest` | courtesy | — | |
| `clean` | `--person` | courtesy | — | |
| `clean` | `--hold` | courtesy | — | |
| `clean` | `--hold-speed` | courtesy | — | |
| `clean` | `--hold-reach` | courtesy | — | |
| `clean` | `--loop` | promised | D | |
| `clean` | `--coco` | courtesy | — | |
| `clean` | `--hips-inferred` | courtesy | — | |
| `retarget` | `--rig` | promised | X 14, D | |
| `retarget` | `--map` | promised | S, X 14, D | |
| `retarget` | `--pose` | promised | X 13, D | |
| `retarget` | `--out` | promised | X 12, D | |
| `retarget` | `--name` | promised | X 10, D | |
| `retarget` | `--person` | courtesy | — | |
| `retarget` | `--base-motion` | promised | X 1 | |
| `retarget` | `--images` | courtesy | — | |
| `retarget` | `--min-score` | courtesy | — | |
| `retarget` | `--smooth` | courtesy | S | an alias kept only to say it is ignored (the sheets name it for that) |
| `retarget` | `--flip` | promised | X 2 | |
| `retarget` | `--short` | promised | X 2 | |
| `retarget` | `--bends` | promised | X 2 | |
| `retarget` | `--bend-tolerance` | courtesy | — | |
| `retarget` | `--switch-tolerance` | courtesy | — | |
| `retarget` | `--switch-min` | courtesy | — | |
| `retarget` | `--switch-at` | courtesy | — | |
| `retarget` | `--profile` | promised | D | |
| `retarget` | `--build` | promised | X 8, D | |
| `retarget` | `--reference` | courtesy | — | with `--build`: echoed into `retarget.json` (rig-c/pose#270); not `compare --reference` |
| `retarget` | `--render` | promised | X 2 | |
| `retarget` | `--parts` | courtesy | — | |
| `retarget` | `--report` | promised | S, X 13 | |
| `retarget` | `--camera` | promised | S, X 4 | |
| `retarget` | `--leg-scale` | promised | S, X 13 | |
| `retarget` | `--idle` | courtesy | — | |
| `retarget` | `--merge` | courtesy | — | |
| `retarget` | `--reduce` | promised | S, X 2 | |
| `retarget` | `--reduce-hip` | promised | X 1 | |
| `retarget` | `--stance` | promised | S, X 13 | |
| `retarget` | `--floor` | courtesy | — | |
| `retarget` | `--coco` | courtesy | — | |
| `retarget` | `--plant-feet` | promised | S, X 13 | |
| `retarget` | `--carry-idle` | promised | S, X 2 | |
| `retarget` | `--raised-by-head` | courtesy | — | |
| `retarget` | `--reduce-keep-planted` | courtesy | — | |
| `retarget` | `--verbose` | courtesy | — | |
| `retarget` | `--summary` | courtesy | — | |
| `retarget` | `--sequence` | promised | X 1 | alias of `--pose` |
| `retarget` | `--animation` | promised | X 1 | alias of `--name` |
| `convert` | `--coco` | courtesy | — | |
| `convert` | `--out` | courtesy | — | |
| `compare` | `--reference` | promised | S | |
| `compare` | `--render` | promised | S | |
| `compare` | `--map` | promised | S | |
| `compare` | `--retarget-report` | courtesy | — | |
| `compare` | `--reference-hands` | courtesy | — | |
| `compare` | `--render-hands` | courtesy | — | |
| `compare` | `--cloth-reference` | courtesy | — | |
| `compare` | `--cloth-render` | courtesy | — | |
| `compare` | `--cloth-windows` | courtesy | — | |
| `compare` | `--report` | courtesy | — | |
| `compare` | `--sheet` | courtesy | — | |

### The report's top-level keys

Every key `rig-pose-report/1` can carry, once: the keys `src/run.ts` writes, and the ones `src/report.ts` adds. The same test holds this table against both files.

| key | status | use | what is read |
| --- | --- | --- | --- |
| `spec` | promised | S, R | `"rig-pose-report/1"` |
| `rig` | promised | R | |
| `animation` | promised | R | |
| `frames` | promised | S, R | the pose frame count |
| `duration` | promised | S, R | seconds |
| `frameTimes` | promised | S, R, C | one time per frame, strictly increasing |
| `fps` | promised | R, C | the uniform clock a reader accepts in place of `frameTimes`; not written today |
| `frame0` | promised | R, C | as `fps` |
| `render` | promised | C | the renderer's sampling domain |
| `inputs` | promised | S, C | `inputs.map.{ path, sha256 }` (and `rig`, `pose`) |
| `scale` | promised | S | `scale.factor` |
| `feet` | promised | S, R | `jumps` (`[first, last]` pairs), `supports[].{ side, frames }`, `closure.{ drift, frames }` |
| `face` | promised | S | `yaw.bone`, `pitch.bone` |
| `landings` | promised | S, R | `[].{ bone, kind, worst, tolerance }` |
| `cleaned` | promised | R | `holds`, `seams` (event rows) |
| `holds` | promised | R | event rows |
| `short` | promised | R | event rows |
| `endOn` | promised | R | event rows |
| `flips` | promised | R | event rows |
| `switches` | promised | R | event rows (`from`, `to`, `slots`) |
| `uncovered` | promised | R | event rows (`times`, render domain) |
| `turns` | promised | R | event rows |
| `range` | promised | R | event rows |
| `artRange` | promised | R | event rows |
| `raised` | promised | R | event rows |
| `shear` | promised | R | event rows |
| `rigc` | courtesy | — | |
| `options` | courtesy | — | |
| `scaleFit` | courtesy | — | |
| `bends` | courtesy | — | |
| `gate` | courtesy | — | |
| `jitter` | courtesy | — | |
| `posture` | courtesy | — | |
| `folds` | courtesy | — | |
| `seams` | courtesy | — | |
| `seamPairs` | courtesy | — | |
| `reach` | courtesy | — | |
| `byHip` | courtesy | — | |
| `body` | courtesy | — | |
| `legScale` | courtesy | — | |
| `pivot` | courtesy | — | |
| `pelvis` | courtesy | — | |
| `stance` | courtesy | — | |
| `idleDropped` | courtesy | — | |
| `idleKeptOut` | courtesy | — | |
| `merged` | courtesy | — | |
| `reduce` | courtesy | — | |

An **event row**, as review reads it under #209, carries: `frame` or `frames` (an inclusive pair below `frames`), or `t`/`times` in seconds; `seconds`/`spanSeconds`; and the names `bone`, `slot`, `bones`, `joint`, `point`, `chain`, `chains`, `joints`, `side`, `set`, `attachment`, `line`. Those row fields are promised wherever a promised key carries event rows. A new key, or a new field in a row, is not a change: readers ignore what they do not read.

### Problem codes and line tags

Promised codes, with their use:

- S, D: `RIG_GATE`, `POSE_LANDS`. The grader reads them from stderr.
- D: `RIG_GATE_BASE`, `POSE_NOT_CLEANED`, `POSE_BEND_ONE_WAY`, `POSE_POINT_NEVER_GOOD`, `STANCE`.
- X: `ARG_PATH`, `MAP_BEND_SIDE`, `MAP_CHAIN_JOINTS`, `MAP_TRANSLATE_SCALE`, `RIGC`.

Every other code is courtesy. That a refusal always carries some code is promised; which code it carries is promised only for the codes above.

Promised line tags, with their use:

- S: `SCALE`, which the sheets name.
- D: `GATE`.
- X: `BODY`, `CLEAN`, `FEET`, `FOLD`, `HOLD`, `IDLE-DROPPED`, `IDLE-KEPT-OUT`, `LAND`, `LEG-SCALE`, `POSTURE`, `RIGC`, `SHEAR`, `STANCE`.

Every other tag is courtesy.

### Imports

The package promises **no importable API**. Its `exports` exposes only `package.json`, so `src/*` cannot be deep-imported. That is the same choice as rig-c/review.

Measured: no repository in the org imports `@rig-c/pose` as a module. rig-c.github.io names it in prose and in install lines; rig-c/exam pins it in each round's `package.json` and runs the bin. The `bin` is unaffected. Closing the deep imports is a breaking change, so it lands before 1.0 and not after.
