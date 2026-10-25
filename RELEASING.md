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
   serve it in time; re-run the confirmation alone, which publishes nothing,
   with `gh workflow run release.yml -f version=X.Y.Z`).

Before any of that, every pull request's `install` job packs the branch, runs
the same smoke on the tarball, and plants two failures beside it
(`scripts/smoke_mutants.sh`): a `src` module left out of the tarball must go
red at `--version`, and the gate's launcher resolved by a name the install does
not have must go red at the retarget — a failure `--version` alone passes.

### When the tag is cut but the publish did not land

a release-please failure after the tag leaves a version unpublished; the next cut carries it, or the tag is republished by dispatch.

It happens when the run that merged the release pull request gets as far as
the tag and the GitHub release and then stops before the publish lands (on
another package of the toolchain, `npm publish --provenance` once failed on a
transient signing-service error). Re-running that run cannot recover:
release-please no longer reports `release_created` for a tag it has already
cut, so every step after it is skipped and the registry keeps serving the
previous version. A publish by hand would lose provenance, and the trusted
publisher names `release.yml`.

Dispatch when the GitHub release `vX.Y.Z` exists and
`npm view @rig-c/pose@X.Y.Z version` serves nothing:

```sh
gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z
```

`--ref vX.Y.Z` puts the run itself on the tag. npm's provenance reads the run's
`GITHUB_REF` and `GITHUB_SHA`, which the later checkout of the tag does not
change, so without it the published package would claim the default branch's
head as its source. `--ref` also runs the tag's own `release.yml`, so only a tag
whose `release.yml` carries the `tag` dispatch input can be recovered this way:
v0.40.0 and later. A tag up to v0.39.0 is carried by the next cut instead.

The `release` job then skips release-please (a dispatch never cuts a tag or a
release) and its *Resolve the tag to publish* step checks the tag; every step
after it is the push path's own (checkout of the tag, the gate in
`prepublishOnly`, `npm publish --provenance`, the registry confirmation), run
under the same condition, from the same file. Then confirm the cut as after any
release. The resolve step refuses, each as one `::error::` line naming its
rule:

| refusal | when |
| --- | --- |
| `RELEASE_DISPATCH_INPUT` | the dispatch gave both `tag` and `version`, or neither |
| `RELEASE_TAG_FORM` | the tag is not `vX.Y.Z` (or `vX.Y.Z-<prerelease>`) |
| `RELEASE_TAG_UNRELEASED` | the tag has no GitHub release: only a tag release-please cut is published |
| `RELEASE_REF_NOT_TAG` | the run is not on the tag: its `GITHUB_REF` is not `refs/tags/<tag>` (dispatched without `--ref`), or its `GITHUB_SHA` is not the tag's commit |
| `RELEASE_ALREADY_PUBLISHED` | the registry already serves that version of `@rig-c/pose` |
| `RELEASE_TAG_BELOW_LATEST` | the version is below the registry's `latest` for `@rig-c/pose` (a prerelease is below its release) |

**Two inputs, one per dispatch.** `tag` publishes a cut tag; `version` re-runs
a confirmation. Both are optional, because GitHub refuses a dispatch that omits
a required input; an omitted string input reads as empty. The `confirm` job
runs only on a dispatch with `version` and no `tag`; any other dispatch runs the
`release` job, where the resolve step publishes a `tag` alone and refuses the
rest.

**Below latest.** `npm publish` refuses to put `latest` on a version lower than
the highest one published unless a `--tag` is given, and the publish step
passes `--tag` only for a prerelease. So once a later version is out, the
dispatch refuses the older tag by name before anything is checked out or
published; it is never attempted silently. Such a version goes out, if at all,
under a dist-tag, with a `--tag` variant of this dispatch, which is a follow-up
and not in this workflow. The comparison is semver order computed in `node`,
not `sort -V`, which sorts `1.0.0-rc.1` after `1.0.0`.

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

- **A command or flag**: its name, its argument form, and what it does. Its default figure is courtesy: figures are re-measured. Where a figure was read off one reference (`docs/REFERENCE.md` says which, e.g. `--stance 0.07` off a dance), it stays the reference's advice, not a promise.
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
| `rig-pose pelvis --mode below-cover` (the cues under a cover: hem, thigh roots, an uncovered band; `pelvisSource` "below-cover", the `CUES` and `HIPS-SIGN` lines, rig-c/pose#342) | courtesy | — |
| `rig-pose compare` | promised | S (the R3 sheet offers it) |
| `rig-pose convert` | courtesy | — |
| `rig-pose cloth` (rig-c/pose#34) | courtesy | — |
| `rig-pose --version`, `--help` | promised | S, X |
| `rig-pose-sequence/1` (the pose) | promised | S, R, D |
| `rig-pose-sequence/1.1` (the pose with the pelvis track, `pelvisTilt` and `pelvisSource`, rig-c/pose#288) | courtesy | — |
| `rig-pose-sequence/1.2` (the pose with per-segment `depth`, `clean --depth`, rig-c/pose#281) | courtesy | — |
| `rig-pose-pelvis-keys/1` (`pelvis --pelvis-keys`; fractional frames, rig-c/pose#294) | courtesy | — |
| `rig-pose-contact-keys/1` (`retarget --contact-keys`; fractional frames, rig-c/pose#303) | courtesy | — |
| `rig-pose-map/1` (the map) | promised | S, X, D |
| the map's `layout` (each limb-layout group's depth source, read with `--draw-order depth`, rig-c/pose#346) | courtesy | — |
| `rig-parts-layout/1` (`layout.json` beside `rig.json`, from @rig-c/parts; read with `--draw-order depth`, rig-c/pose#346) | courtesy | — |
| `rig-pose-map/1` set field `bind` (a set shown on exactly its bound frames, explicit or cycle-relative; rig-c/pose#360) | courtesy | — |
| `rig-pose-report/1` (the report) | promised, as below | S, R |
| `rig-pose-camera/1` (`--camera`) | promised | S |
| `rig-pose-tracks/1` (`--merge`), `rig-pose-compare/1` (`compare --report`), `rig-c-cloth-track/0` (`cloth --out`, `compare --cloth-reference`/`--cloth-render`, rig-c/pose#34) | courtesy | — |
| `rig-pose-retarget/1` (`--build`'s `retarget.json`, rig-c/pose#270) | courtesy | — |
| `rig-pose-shoulder-lift/1` (`retarget --shoulder-lift`, #408), every configuration field documented in docs/REFERENCE.md | courtesy | No recorded promised reader |
| `rig-pose-figure-scale/1` (`clean`'s `<out>.figure-scale.json`, rig-c/pose#404): `spec`, `inputSHA256`, `sequenceSHA256`, `person`, `cameraDeclared`, and `figureScale` with `source`, `method`, `minScore`, `threshold`, `referencePx`, `scale`, `minFrame`, `maxFrame`, `variation` | courtesy | No recorded promised reader; a separate diagnostic, never a field in the strict pose/cleaned format |

### Flags

Every flag `parseFlags` reads in `cli.ts`, once. `test/promise.test.ts` holds this table against `cli.ts`. The runtime control in `test/surface.test.ts` also runs root `--help` and every command's `--help`, reads Usage and flag declarations (including paired declarations), and requires a classification by command and name. Global `--help` and `--version` use the promised row above.

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
| `clean` | `--depth` | courtesy | — | |
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
| `retarget` | `--draw-order` | courtesy | — | (rig-c/pose#304) |
| `retarget` | `--contact-keys` | courtesy | — | (rig-c/pose#303) |
| `retarget` | `--shoulder-lift` | courtesy | — | Supplied calibration file; #408 |
| `retarget` | `--cloth-track` | courtesy | — | (rig-c/pose#34) |
| `retarget` | `--cloth-windows` | courtesy | — | (rig-c/pose#34) |
| `retarget` | `--skirt-slots` | courtesy | — | (rig-c/pose#34) |
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
| `cloth` | `--rig` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--map` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--skirt-slots` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--animation` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--fps` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--frames` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--pose` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--person` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--alpha-min` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--windows` | courtesy | — | (rig-c/pose#34) |
| `cloth` | `--out` | courtesy | — | (rig-c/pose#34) |

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
| `switches` | promised | R | event rows (`from`, `to`, `slots`); the `endOnHeld` field is courtesy (rig-c/pose#355), and so is `bound` (rig-c/pose#360) |
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
| `switchRuns` | courtesy | — | (rig-c/pose#279; `turned`, rig-c/pose#355) |
| `switchBinds` | courtesy | — | only when the map binds a set (rig-c/pose#360) |
| `drawOrder` | courtesy | — | (rig-c/pose#304; `layout` and `groups`, the forearms against the trunk, rig-c/pose#346) |
| `shoulderLift` | courtesy | — | Only with --shoulder-lift; supplied inputs, signed frame readings and independent world landing (#408) |
| `clothFit` | courtesy | — | only with `--cloth-track` (rig-c/pose#34) |
| `contactKeys` | courtesy | — | only with `--contact-keys` (rig-c/pose#303) |
| `reach` | courtesy | — | |
| `reachOrigin` | courtesy | — | only when the map has a `reach` chain (rig-c/pose#282) |
| `byHip` | courtesy | — | |
| `body` | courtesy | — | |
| `legScale` | courtesy | — | |
| `pivot` | courtesy | — | |
| `pelvis` | courtesy | — | |
| `layers` | courtesy | — | only when the sequence carries depth (rig-c/pose#281) |
| `stance` | courtesy | — | |
| `idleDropped` | courtesy | — | |
| `idleKeptOut` | courtesy | — | |
| `merged` | courtesy | — | |
| `reduce` | courtesy | — | `held` only when a parent was held, `unsmoothed` only when a trunk smoothing was not kept (rig-c/pose#320) |

An **event row**, as review reads it under #209, carries: `frame` or `frames` (an inclusive pair below `frames`), or `t`/`times` in seconds; `seconds`/`spanSeconds`; and the names `bone`, `slot`, `bones`, `joint`, `point`, `chain`, `chains`, `joints`, `side`, `set`, `attachment`, `line`. Those row fields are promised wherever a promised key carries event rows. A new key, or a new field in a row, is not a change: readers ignore what they do not read.

### The report's nested fields

The runtime control in `test/surface.ts` reads every object field in all reports
emitted by the regression test (#208's two references and #375's generated run).
Paths use `.` for an object
field and `[]` for every array row (including later rows, not just the first).
Array indices and scalar array entries are data, not field names. A `*` below
means one record key, such as a slot name; it never covers an undocumented child.
A null value or empty array still declares its containing field, but exposes no
children to this run. A help-only unlisted flag makes the help control exit 1,
and an unlisted nested field planted in emitted reports makes the regression
control exit 1; each names the item, beside the restored green control.
The static audit in `test/promise.test.ts` remains the
coverage for top-level optional keys absent from these fixtures.

The classification follows #262, not the runtime value: previously promised
reader fields and event coordinates stay promised. The other nested fields are
courtesy because no promised reader was recorded for them. Listing a parent as
promised does not promote its entire subtree. New fields still require an
explicit classification. Report consumers ignore fields they do not read; this
is not permission to add keys to strict input formats. The pose reader
continues to refuse unknown root and `cleaned` keys. #404 adds an external
figure-scale sidecar so an older reader can still consume the unchanged pose.
The generated run exercises leg scaling, stance, and foot blending: their
internal readings remain courtesy, while the existing event targets and frame/time
coordinates on flips and shear remain promised.

| field | status | use |
| --- | --- | --- |
| `artRange[].bone`, `artRange[].chain`, `artRange[].frames`, `artRange[].seconds` | promised | R |
| `artRange[].set`, `artRange[].spanSeconds`, `artRange[].times` | promised | R |
| `artRange[].clamped`, `artRange[].limits`, `artRange[].maxOverflow`, `artRange[].turn` | courtesy | No recorded promised reader |
| `body.framesOver45`, `body.over45`, `body.read`, `body.read.opening` | courtesy | No recorded promised reader |
| `body.read.opening.max`, `body.read.opening.min`, `body.read.opening.range`, `body.read.yaw` | courtesy | No recorded promised reader |
| `body.read.yaw.max`, `body.read.yaw.min`, `body.read.yaw.range`, `body.standing` | courtesy | No recorded promised reader |
| `body.standing.hip`, `body.standing.shoulder` | courtesy | No recorded promised reader |
| `cleaned.jitter`, `cleaned.jitter.after`, `cleaned.jitter.before`, `cleaned.params` | courtesy | No recorded promised reader |
| `cleaned.params.legs`, `cleaned.params.loop`, `cleaned.params.rest`, `cleaned.spec` | courtesy | No recorded promised reader |
| `cleaned.spikes`, `cleaned.spikes.found`, `cleaned.spikes.found[].bone`, `cleaned.spikes.found[].bones` | courtesy | No recorded promised reader |
| `cleaned.spikes.found[].frame`, `cleaned.spikes.found[].joint`, `cleaned.spikes.found[].t`, `cleaned.spikes.untested` | courtesy | No recorded promised reader |
| `face.pitch`, `face.pitch.bone` | promised | S |
| `face.ears`, `face.pitch.corr`, `face.pitch.knee`, `face.pitch.limits` | courtesy | No recorded promised reader |
| `face.pitch.mapped`, `face.pitch.mapped.max`, `face.pitch.mapped.min`, `face.pitch.mapped.range` | courtesy | No recorded promised reader |
| `face.pitch.read`, `face.pitch.read.max`, `face.pitch.read.min`, `face.pitch.read.range` | courtesy | No recorded promised reader |
| `face.pitch.scale`, `face.read`, `face.read.pitch`, `face.read.pitch.max` | courtesy | No recorded promised reader |
| `face.read.pitch.min`, `face.read.pitch.range`, `face.read.yaw`, `face.read.yaw.max` | courtesy | No recorded promised reader |
| `face.read.yaw.min`, `face.read.yaw.range` | courtesy | No recorded promised reader |
| `feet.closure`, `feet.closure.drift`, `feet.closure.frames`, `feet.jumps` | promised | S, R |
| `feet.supports`, `feet.supports[].frames`, `feet.supports[].side`, `feet.supports[].times` | promised | S, R |
| `feet.blend`, `feet.changes`, `feet.changes[].frame`, `feet.changes[].from` | courtesy | No recorded promised reader |
| `feet.changes[].t`, `feet.changes[].to`, `feet.floor`, `feet.jumpEvents` | courtesy | No recorded promised reader |
| `feet.legLength`, `feet.legLength.l`, `feet.legLength.r`, `feet.planted` | courtesy | No recorded promised reader |
| `feet.reading`, `feet.reading.legLength`, `feet.reading.legLength.l`, `feet.reading.legLength.r` | courtesy | No recorded promised reader |
| `feet.reading.lowest`, `feet.reading.lowest.frames`, `feet.reading.lowest.legs`, `feet.reading.lowest.range` | courtesy | No recorded promised reader |
| `feet.reading.plants`, `feet.reading.plants[].frames`, `feet.reading.plants[].horizontal`, `feet.reading.plants[].horizontalLegs` | courtesy | No recorded promised reader |
| `feet.reading.plants[].side`, `feet.reading.plants[].times`, `feet.reading.plants[].vertical`, `feet.reading.plants[].verticalLegs` | courtesy | No recorded promised reader |
| `feet.rigLeg`, `feet.rigLeg.l`, `feet.rigLeg.r`, `feet.segments` | courtesy | No recorded promised reader |
| `feet.segments[].bone`, `feet.segments[].chain`, `feet.segments[].joints`, `feet.segments[].ratio` | courtesy | No recorded promised reader |
| `feet.segments[].ratio.max`, `feet.segments[].ratio.median`, `feet.segments[].ratio.min`, `feet.segments[].straight` | courtesy | No recorded promised reader |
| `feet.shifts`, `feet.steps`, `feet.straight`, `feet.straight.l` | courtesy | No recorded promised reader |
| `feet.straight.r` | courtesy | No recorded promised reader |
| `inputs.map.path` | promised | C |
| `inputs.map`, `inputs.map.sha256`, `inputs.pose`, `inputs.pose.path` | promised | C |
| `inputs.pose.sha256`, `inputs.rig`, `inputs.rig.path`, `inputs.rig.sha256` | promised | C |
| `jitter[].against`, `jitter[].bone`, `jitter[].chain`, `jitter[].joints` | courtesy | No recorded promised reader |
| `jitter[].pair`, `jitter[].ratio`, `jitter[].reach`, `jitter[].rig` | courtesy | No recorded promised reader |
| `jitter[].triples` | courtesy | No recorded promised reader |
| `landings[].bone`, `landings[].frame`, `landings[].kind`, `landings[].t` | promised | S, R |
| `landings[].tolerance`, `landings[].worst` | promised | S, R |
| `options.bendTolerance`, `options.bends`, `options.carryIdle`, `options.flip` | courtesy | No recorded promised reader |
| `options.floor`, `options.idle`, `options.legScale`, `options.merge` | courtesy | No recorded promised reader |
| `options.minScore`, `options.plantFeet`, `options.profile`, `options.raisedByHead` | courtesy | No recorded promised reader |
| `options.reduce`, `options.reduceHip`, `options.short`, `options.stance` | courtesy | No recorded promised reader |
| `options.switchAt`, `options.switchMin`, `options.switchTolerance` | courtesy | No recorded promised reader |
| `pivot.bone`, `pivot.distance`, `pivot.hipWidths`, `pivot.offset` | courtesy | No recorded promised reader |
| `pivot.roots` | courtesy | No recorded promised reader |
| `raised[].bones`, `raised[].chain`, `raised[].frames`, `raised[].seconds` | promised | R |
| `raised[].set`, `raised[].spanSeconds`, `raised[].times` | promised | R |
| `raised[].after`, `raised[].before`, `raised[].eyes`, `raised[].eyes.reference` | courtesy | No recorded promised reader |
| `raised[].eyes.rig`, `raised[].placed`, `raised[].reach`, `raised[].reach.farthest` | courtesy | No recorded promised reader |
| `raised[].reach.max`, `raised[].reach.min`, `raised[].reference`, `raised[].short` | courtesy | No recorded promised reader |
| `raised[].short[].frames`, `raised[].short[].how`, `raised[].short[].shortfall`, `raised[].short[].shortfall.max` | courtesy | No recorded promised reader |
| `raised[].short[].shortfall.median`, `raised[].short[].times`, `raised[].upperHeld`, `raised[].worst` | courtesy | No recorded promised reader |
| `raised[].worst.after`, `raised[].worst.before`, `raised[].worst.placed` | courtesy | No recorded promised reader |
| `range[].bone`, `range[].chain`, `range[].frames`, `range[].seconds` | promised | R |
| `range[].spanSeconds`, `range[].times` | promised | R |
| `range[].key`, `range[].limits`, `range[].maxOverflow` | courtesy | No recorded promised reader |
| `render.fps`, `render.frames` | promised | C |
| `rigc.entry`, `rigc.version` | courtesy | No recorded promised reader |
| `scale.factor` | promised | S |
| `scale.pose`, `scale.rig` | courtesy | No recorded promised reader |
| `scaleFit.hip`, `scaleFit.hip.band`, `scaleFit.hip.band.hi`, `scaleFit.hip.band.lo` | courtesy | No recorded promised reader |
| `scaleFit.hip.median`, `scaleFit.hip.rig`, `scaleFit.hip.straight`, `scaleFit.hip.within` | courtesy | No recorded promised reader |
| `scaleFit.leg`, `scaleFit.leg.band`, `scaleFit.leg.band.hi`, `scaleFit.leg.band.lo` | courtesy | No recorded promised reader |
| `scaleFit.leg.median`, `scaleFit.leg.median.l`, `scaleFit.leg.median.r`, `scaleFit.leg.rig` | courtesy | No recorded promised reader |
| `scaleFit.leg.rig.l`, `scaleFit.leg.rig.r`, `scaleFit.leg.straight`, `scaleFit.leg.straight.l` | courtesy | No recorded promised reader |
| `scaleFit.leg.straight.r`, `scaleFit.leg.within`, `scaleFit.outside`, `scaleFit.segment` | courtesy | No recorded promised reader |
| `scaleFit.segment.joints`, `scaleFit.segment.median`, `scaleFit.segment.ratio`, `scaleFit.segment.straight` | courtesy | No recorded promised reader |
| `scaleFit.travel`, `scaleFit.travel.bone`, `scaleFit.travel.joint`, `scaleFit.travel.pose` | courtesy | No recorded promised reader |
| `scaleFit.travel.pose.hips`, `scaleFit.travel.pose.legs`, `scaleFit.travel.pose.x`, `scaleFit.travel.pose.y` | courtesy | No recorded promised reader |
| `scaleFit.travel.rig`, `scaleFit.travel.rig.hips`, `scaleFit.travel.rig.legs`, `scaleFit.travel.rig.x` | courtesy | No recorded promised reader |
| `scaleFit.travel.rig.y` | courtesy | No recorded promised reader |
| `short[].bone`, `short[].chain`, `short[].frames`, `short[].joints` | promised | R |
| `short[].times` | promised | R |
| `short[].asked`, `short[].minFraction`, `short[].step` | courtesy | No recorded promised reader |
| `switchRuns[].nearest`, `switchRuns[].nearest[].count`, `switchRuns[].nearest[].frames`, `switchRuns[].nearest[].seconds` | courtesy | No recorded promised reader |
| `switchRuns[].nearest[].spanSeconds`, `switchRuns[].nearest[].times`, `switchRuns[].set`, `switchRuns[].suppressed` | courtesy | No recorded promised reader |
| `switchRuns[].turned` | courtesy | No recorded promised reader |
| `switches[].chains`, `switches[].frames`, `switches[].from`, `switches[].set` | promised | R |
| `switches[].slots`, `switches[].slots.*`, `switches[].times`, `switches[].to` | promised | R |
| `switches[].artTurn`, `switches[].artTurn.*`, `switches[].artTurn.*.max`, `switches[].artTurn.*.median` | courtesy | No recorded promised reader |
| `switches[].distance`, `switches[].distance.max`, `switches[].distance.median`, `switches[].hides` | courtesy | No recorded promised reader |
| `switches[].moved`, `switches[].moved.off`, `switches[].moved.off.frame`, `switches[].moved.off.frames` | courtesy | No recorded promised reader |
| `switches[].moved.off.seconds`, `switches[].moved.off.speed`, `switches[].moved.off.speed.new`, `switches[].moved.off.speed.old` | courtesy | No recorded promised reader |
| `switches[].moved.off.window`, `switches[].moved.on`, `switches[].moved.on.frame`, `switches[].moved.on.frames` | courtesy | No recorded promised reader |
| `switches[].moved.on.seconds`, `switches[].moved.on.speed`, `switches[].moved.on.speed.new`, `switches[].moved.on.speed.old` | courtesy | No recorded promised reader |
| `switches[].moved.on.window`, `switches[].offsets`, `switches[].offsets.*` | courtesy | No recorded promised reader |
| `feet.blend.bounds`, `feet.blend.over`, `feet.blend.runs`, `feet.blend.runs[].frames` | courtesy | No recorded promised reader |
| `feet.blend.runs[].k`, `feet.blend.runs[].k.max`, `feet.blend.runs[].k.min`, `feet.blend.runs[].side` | courtesy | No recorded promised reader |
| `feet.blend.runs[].times`, `feet.jumpEvents[].frames`, `feet.jumpEvents[].times`, `feet.shifts[].frames` | courtesy | No recorded promised reader |
| `feet.shifts[].shift`, `feet.shifts[].side`, `feet.shifts[].times` | courtesy | No recorded promised reader |
| `flips[].bone`, `flips[].chain`, `flips[].frames`, `flips[].joints` | promised | R |
| `flips[].times` | promised | R |
| `flips[].clipped`, `flips[].h`, `flips[].jump`, `flips[].step` | courtesy | No recorded promised reader |
| `flips[].turns`, `flips[].turns[].frame`, `flips[].turns[].jump`, `flips[].turns[].t` | courtesy | No recorded promised reader |
| `legScale[].bone`, `legScale[].chain`, `legScale[].clamped`, `legScale[].clamped[].asked` | courtesy | No recorded promised reader |
| `legScale[].clamped[].asked.max`, `legScale[].clamped[].asked.min`, `legScale[].clamped[].frames`, `legScale[].clamped[].limit` | courtesy | No recorded promised reader |
| `legScale[].clamped[].times`, `legScale[].free`, `legScale[].free.above`, `legScale[].free.below` | courtesy | No recorded promised reader |
| `legScale[].free.below.legLengths`, `legScale[].free.below.units`, `legScale[].free.count`, `legScale[].free.frames` | courtesy | No recorded promised reader |
| `legScale[].free.side`, `legScale[].high`, `legScale[].joints`, `legScale[].limits` | courtesy | No recorded promised reader |
| `legScale[].low`, `legScale[].ratio`, `legScale[].ratio.max`, `legScale[].ratio.median` | courtesy | No recorded promised reader |
| `legScale[].ratio.min`, `legScale[].straight` | courtesy | No recorded promised reader |
| `shear[].bone`, `shear[].frame`, `shear[].t` | promised | R |
| `shear[].shear`, `shear[].x`, `shear[].y` | courtesy | No recorded promised reader |
| `stance.bounds`, `stance.minSeconds`, `stance.over`, `stance.release` | courtesy | No recorded promised reader |
| `stance.runs`, `stance.runs[].frames`, `stance.runs[].k`, `stance.runs[].maxHeight` | courtesy | No recorded promised reader |
| `stance.runs[].moved`, `stance.runs[].moved.above`, `stance.runs[].moved.below`, `stance.runs[].moved.below.legLengths` | courtesy | No recorded promised reader |
| `stance.runs[].moved.below.units`, `stance.runs[].moved.count`, `stance.runs[].moved.frames`, `stance.runs[].moved.side` | courtesy | No recorded promised reader |
| `stance.runs[].side`, `stance.runs[].state`, `stance.runs[].times`, `stance.tolerance` | courtesy | No recorded promised reader |
| `options.shoulderLift` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.axis` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration.cameraToPainting` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration.cameraToPainting.absoluteError` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration.cameraToPainting.source` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration.cameraToPainting.value` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration.paintingToRig` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration.paintingToRig.absoluteError` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration.paintingToRig.source` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.calibration.paintingToRig.value` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.camera` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.camera.domain` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.camera.mode` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.camera.residualPx` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.camera.source` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.evidence` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].frame` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].paintingPx` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].sequencePx` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].sourceBoundUnits` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].sourceTime` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].states` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].states.l_ear` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].states.l_hip` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].states.l_shoulder` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].states.r_ear` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].states.r_hip` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].states.r_shoulder` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].t` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].toleranceUnits` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.frames[].worldUnits` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.configuration` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.configuration.path` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.configuration.sha256` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.painting` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.painting.path` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.painting.sha256` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.rest` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.rest.path` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.inputs.rest.sha256` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.landing` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.landing.bone` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.landing.frame` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.landing.t` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.landing.tolerance` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.landing.worst` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.method` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.q0` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.sampleIndices` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.states` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.states[].l_ear` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.states[].l_hip` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.states[].l_shoulder` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.states[].r_ear` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.states[].r_hip` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.rest.states[].r_shoulder` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.sampling` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.sampling.pointErrorPx` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.sampling.resolutionPx` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.status` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.bone` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.ears` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.ears.l` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.ears.r` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.hips` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.hips.l` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.hips.r` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.idle` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.shoulders` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.shoulders.l` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `shoulderLift.target.shoulders.r` | courtesy | Supplied opt-in reading; no recorded promised reader (#408) |
| `cleaned.holds` | promised | Existing #209 clean event identity/time contract; exposed by the #408 control |
| `cleaned.holds[].bone` | promised | Existing #209 clean event identity/time contract; exposed by the #408 control |
| `cleaned.holds[].frames` | promised | Existing #209 clean event identity/time contract; exposed by the #408 control |
| `cleaned.holds[].jitter` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.holds[].jitter.after` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.holds[].jitter.before` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.holds[].joint` | promised | Existing #209 clean event identity/time contract; exposed by the #408 control |
| `cleaned.holds[].times` | promised | Existing #209 clean event identity/time contract; exposed by the #408 control |
| `cleaned.params.hold` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.params.hold.blend` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.params.hold.minSeconds` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.params.hold.reach` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.params.hold.speed` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.seams` | promised | Existing #209 clean event identity/time contract; exposed by the #408 control |
| `cleaned.unheld` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.unheld[].bone` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.unheld[].frames` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.unheld[].joint` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.unheld[].test` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.unheld[].times` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `cleaned.unheld[].value` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].carried` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].carried.cycles` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].carried.keys` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].carried.seams` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].duration` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].keys` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].members` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].notCarried` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].property` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].target` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].target.kind` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `idleDropped[].target.name` | courtesy | Existing internal clean/idle diagnostic; no recorded promised reader |
| `options.clothTrack`, `options.clothWindows`, `options.skirtSlots` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.candidate`, `clothFit.checks`, `clothFit.constraints`, `clothFit.constraints.*` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.constraints.*.bone`, `clothFit.constraints.*.damping`, `clothFit.constraints.*.inertia`, `clothFit.constraints.*.link` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.constraints.*.mass`, `clothFit.constraints.*.mix`, `clothFit.constraints.*.strength`, `clothFit.evaluated` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.family`, `clothFit.foldFree`, `clothFit.folds`, `clothFit.folds.frames` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.folds.worstTriangles`, `clothFit.maxLinkDeg`, `clothFit.passes`, `clothFit.score` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.slots`, `clothFit.windows`, `clothFit.windows.*`, `clothFit.windows.*.bands` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.windows.*.bands.lag`, `clothFit.windows.*.bands.overshoot`, `clothFit.windows.*.bands.swingRatio`, `clothFit.windows.*.fitted` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.windows.*.fitted.lag`, `clothFit.windows.*.fitted.overshoot`, `clothFit.windows.*.fitted.swingRatio`, `clothFit.windows.*.frames` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.windows.*.pass`, `clothFit.windows.*.pass.lag`, `clothFit.windows.*.pass.overshoot`, `clothFit.windows.*.pass.swingRatio` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.windows.*.reference`, `clothFit.windows.*.reference.lag`, `clothFit.windows.*.reference.overshoot`, `clothFit.windows.*.reference.swingRatio` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |
| `clothFit.windows.*.t` | courtesy | Opt-in physics fit; no recorded promised reader (#34) |

### Problem codes and line tags

Promised codes, with their use:

- S, D: `RIG_GATE`, `POSE_LANDS`. The grader reads them from stderr.
- D: `RIG_GATE_BASE`, `POSE_NOT_CLEANED`, `POSE_BEND_ONE_WAY`, `POSE_POINT_NEVER_GOOD`, `STANCE`.
- X: `ARG_PATH`, `MAP_BEND_SIDE`, `MAP_CHAIN_JOINTS`, `MAP_TRANSLATE_SCALE`, `RIGC`.

The #408 codes `SHOULDER_LIFT_CONFIG`, `SHOULDER_LIFT_INPUT`, `SHOULDER_LIFT_CALIBRATION`, `SHOULDER_LIFT_JOINT`, `SHOULDER_LIFT_LOOP`, `SHOULDER_LIFT_RIG`, `SHOULDER_LIFT_COMPOSITION` and `SHOULDER_LIFT_LANDS` are courtesy. They refuse a requested reading as unknown; no successful zero replaces missing evidence. Optional `rig-pose-retarget/1` input `inputs.shoulderLift` and its `configuration`, `rest`, `painting` path/sha256 identities are courtesy. Existing input and exit promises remain unchanged.

Every other code is courtesy (`CLOTH_SLOT`, `CLOTH_ANIMATION`, `CLOTH_HIP`, `CLOTH_FRAMES`, `CLOTH_EMPTY_FRAME`, `CLOTH_WINDOW`, `CLOTH_FIT_SLOTS`, `CLOTH_FIT_CONSTRAINTS`, `CLOTH_FIT_WINDOWS`, `CLOTH_FIT_FOLDS`, rig-c/pose#34; `FIGURE_SCALE_RECORD` (#404, malformed external figure-scale record), `SET_KEY_DRAWN`, rig-c/pose#355; `MAP_ALT_BIND`, `SET_BIND_FRAMES` and `SET_BIND_OVERLAP`, rig-c/pose#360; and rig-c/pose#346's `MAP_LAYOUT`, `LAYOUT_JSON`, `LAYOUT_SPEC`, `LAYOUT_SHAPE`, `LAYOUT_RIG_SHA`, `LAYOUT_SETS_SHA`, `LAYOUT_SETUP`, `LAYOUT_ADJACENCY`, `LAYOUT_MISSING`, `LAYOUT_UNBOUND`, `LAYOUT_BINDING_UNKNOWN` and `LAYOUT_BINDING_BONES`, among them). That a refusal always carries some code is promised; which code it carries is promised only for the codes above.

Promised line tags, with their use:

- S: `SCALE`, which the sheets name.
- D: `GATE`.
- X: `BODY`, `CLEAN`, `FEET`, `FOLD`, `HOLD`, `IDLE-DROPPED`, `IDLE-KEPT-OUT`, `LAND`, `LEG-SCALE`, `POSTURE`, `RIGC`, `SHEAR`, `STANCE`.

The #408 `SHOULDER-LIFT` tag is courtesy and explicitly labels evidence `SUPPLIED`.

Every other tag is courtesy (`CLOTH`, rig-c/pose#34; `FIGURE-SCALE` and `CAMERA_UNDECLARED` (#404, an advisory warning, never a refusal), `SWITCH-TURN`, rig-c/pose#355, and `SWITCH-BIND`, rig-c/pose#360, among them).

### Imports

The package promises **no importable API**. Its `exports` exposes only `package.json`, so `src/*` cannot be deep-imported. That is the same choice as rig-c/review.

Measured: no repository in the org imports `@rig-c/pose` as a module. rig-c.github.io names it in prose and in install lines; rig-c/exam pins it in each round's `package.json` and runs the bin. The `bin` is unaffected. Closing the deep imports is a breaking change, so it lands before 1.0 and not after.
