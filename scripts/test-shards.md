# Serial files in four CI shards

`test-shards.ts plan` discovers every Bun test path in the current `test/` tree,
then follows relative runtime imports, re-exports and literal dynamic imports
through helpers with the TypeScript parser. Test files connected by those edges
share one process. In particular, `shoulderlift-cli.test.ts` imports the 17 tests
in `shoulderlift.test.ts`: separating them would register the imported tests a
second time. Type-only imports do not register tests. Existing computed imports
of generated mutant fixtures are source-hash listed; a new unresolved module load
is refused rather than silently assumed independent.

Groups are placed longest-weight-first in the least-loaded of four shards,
with path and shard-number tie breaks. Each shard passes explicit `./test/...`
paths to one serial Bun process, preserving the recorded baseline-relative
order. New paths without a recorded position follow that order, sorted by path.
A new path absent from the timing record still runs: its scheduling penalty is
the median of the measured native baseline file weights, visibly reported as
unmeasured with its scheduling policy and weight. This is a scheduling policy,
not a measured duration. No mutable Actions timing cache participates in assignment.

## Current placement: #500

The six existing CI runs used before editing are `43708544155`, `43707768341`,
`43707473445`, `42081521097`, `42080464031` and `42077138845`. No new full suite
was run to make the planning table. The two retarget source files and shared
fixture have identical source hashes across those six artifacts. Their complete
longest-shard-plus-merge readings are 273, 287, 297, 289, 300 and 295 seconds.
These are readings at different heads, not acceptance runs for this change.

For each proposed file, sum every descendant JUnit testcase duration in that
file for each of the six runs, then take the largest sum. For a shard, add those
per-file maxima and the fixed 13-second setup and 10-second merge budgets.
Nested suite aggregate times omit some descendants and are not block weights.
The planning limit is 230 seconds per shard. The fewest allowed shard count is
four, and four satisfies that limit; a fifth is unnecessary.

Both original retarget files are partitioned only at whole top-level blocks.
The block ranges below are one-based within each original file. Block names and
statement bytes are unchanged, and each original's parts concatenate in order.
Every part keeps its original fixture import and identical `afterEach` drain.
The helper remains unchanged and registers no hooks. The block containing the
wave hash stays in `retarget-later.test.ts`, so the smoke reader stays unchanged.

| File | Original block range | Tests | Worst descendant testcase s | Derived scheduling ms |
| --- | --- | ---: | ---: | ---: |
| `test/retarget.test.ts` | prefix 1-21 | 95 | 84.972555 | 52587.613969 |
| `test/retarget-2.test.ts` | prefix 22-28 | 108 | 163.605377 | 101251.708966 |
| `test/retarget-later-1.test.ts` | tail 1-21 | 63 | 106.059218 | 65637.678119 |
| `test/retarget-later.test.ts` | tail 22-40 | 53 | 150.105105 | 92896.692544 |

Only those four scheduling weights change. To express them in the existing
baseline's scheduling unit, their CI descendant maxima are divided by the
observed other-file envelope/baseline ratio: 310.625217 / 192.238 =
1.6158283022695707. The numerator is the sum of the other files' six-run maxima;
the denominator is their unchanged native baseline sum. This normalization is
a derived scheduling policy, not a runtime speedup or candidate CI result.
Unrelated scheduling weights, the original timing readings and the identity
record stay unchanged. The moved computed import receives only its identical,
already accepted generated-fixture hash at the new file path.

| Shard | Files | Sum of per-file worst descendant s | Setup s | Merge s | Planning total s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 8 | 204.289088 | 13 | 10 | 227.289088 |
| 2 | 14 | 203.826823 | 13 | 10 | 226.826823 |
| 3 | 15 | 203.723063 | 13 | 10 | 226.723063 |
| 4 | 16 | 203.528498 | 13 | 10 | 226.528498 |

These are retrospective projections from frozen inputs. Actual acceptance
requires the longest complete shard job plus the complete aggregate job below
250 seconds on two consecutive PR CI runs at the candidate head. Command,
JUnit, or script durations exclude Actions overhead and cannot replace that
measurement. Do not recut or retry a failing head silently.

## Historical source and migration record

The original baseline records one unchanged-main serial run at
`c8cca54f175250541ea3e11b82b066174169f00f`: 936 tests, 50 files, 26,003 assertions.
Native file durations sum to 484.695 seconds; Bun reported 484.70 seconds. The
monotonic command duration was 472.275 seconds. These are distinct accounting
readings, not current CI results. The original CI reference is `41289081567`,
735.69 seconds.

The #497/#498 migration extracted shared declarations once into
`test/retarget-fixture.ts` and split the original 68 blocks into a 28-block prefix
and 40-block tail. Its accepted pre-extraction block/declaration freeze and
936-identity record remain unchanged. They are one-time migration evidence,
not evergreen test requirements. `sourceBoundInputs` controls applicability;
it does not replace the accepted pre-extraction freeze.

Both migration gates and their migration-only plants use the same Python
`baseline_matches` predicate. It requires the same discovered test paths, all
`originalInputs`, and the three transformed retarget `sourceBoundInputs` hashes.
Matching inputs invoke the unchanged raw inspector and exact identity multiset;
changed inputs report preservation/reference-only status and do not run the old
migration plants. They were already reference-only on main before #500 and are
not re-armed by this change. The raw inspector and identity normalization remain
unchanged.

The amended #500 identity reference is main at
`4cab00271a53e9ff8a280c024796767d327f0808`, run `43708544155`: 942 testcases.
The PR carries a reproducible, self-contained one-time evidence script and its
command/result table. It compares each original's ordered block name/SHA-256
sequence with the concatenation of its parts, verifies the unchanged fixture
and drain hooks, and compares the full candidate JUnit identity multiset after
mapping each new file only to its own original. Its one-byte body mutation and
dropped-test plants must refuse. This PR evidence is separate from the unchanged
historical migration gates.

## Always-on gates and artifacts

`checks` keeps `bun run typecheck` and `bun run lint` once. It also runs the
source-bound preservation wrapper, production merger/planner controls, and an
independently generated source-bound plan. The required aggregate remains named
`test`. It always runs, explicitly requires both `checks` and the entire matrix
to have succeeded, and uses only Python stdlib: it does not install dependencies
or rerun tests. Workflow jobs outside the shard matrix are unchanged by #500.

Each shard uploads its selection/result, native timings, ordered observations,
JUnit and console log even after failure. The merger independently discovers
current test paths and requires exact assignment once, source hashes, head and
plan agreement, successful results, complete observed files in order and complete
JUnit accounting without failures/skips. Omitted, duplicated, unknown, failed,
cancelled, stale and missing results remain failures. A discovered zero-test
file remains required, including the imported shoulder file.

Production controls exercise positive merging and unknown new files, and plant
omitted/duplicate/unknown assignment, failed and missing results, observed-file
omission/duplication/unknown/order, and cancelled prerequisites. The two-new-file
planner control uses actual source inputs and confirms the two original retarget
paths remain on separate shards. Empty shards never invoke Bun without paths.
The merged artifact retains the before/after table and current test count;
synthetic control artifacts are labelled and are not after measurements.
