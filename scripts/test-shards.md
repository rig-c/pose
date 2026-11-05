# Serial files in three CI shards

`test-shards.ts plan` discovers every Bun test path in the current `test/` tree,
then follows relative runtime imports, re-exports and literal dynamic imports
through helpers with the TypeScript parser. Test files connected by those edges
share one process. In particular, `shoulderlift-cli.test.ts` imports the 17 tests
in `shoulderlift.test.ts`: separating them would register the imported tests a
second time. Type-only imports do not register tests. Existing computed imports
of generated mutant fixtures are source-hash listed; a new unresolved module load
is refused rather than silently assumed independent.

Groups are placed longest-weight-first in the least-loaded of three shards,
with path and shard-number tie breaks. Each shard passes explicit `./test/...`
paths to **one serial Bun process**, preserving the recorded baseline-relative
order. A new path absent from the timing record still runs: its scheduling
penalty is the largest recorded weight, visibly reported as unmeasured. This is
a scheduling policy, not a measured duration. No mutable Actions timing cache
participates in assignment.

## Source and timing record

The baseline metadata records one unchanged-main serial run at
`c8cca54f175250541ea3e11b82b066174169f00f`: 936 tests, 50 files, 26,003 assertions.
Native file durations sum to 484.695 s; Bun reported 484.70 s. The enclosing
monotonic command duration was 472.275 s. The native and monotonic accounting
are different readings; neither is a new CI result. The issue's CI reference
is run 41289081567, 735.69 s.

The former retarget file's 68 whole blocks were split at `--raised-by-head (#62)`:
28 blocks / 203 tests remain, 40 blocks / 116 tests are in `retarget-later`.
Shared declarations moved once into non-test `retarget-fixture.ts`, still under
`test/`, so `import.meta.dir`, ROOT, CLI, RIGC and MUTANTS retain their meanings.
The fixture registers no hooks. Each test file retains the identical original
`afterEach` drain of the imported `made` ledger. Test bodies and names are frozen
by whole-block SHA-256; declarations may differ only by the added `export`.

The two derived retarget scheduling weights are 150.360798 and 149.631838 s:
each measured testcase-time sum plus the entire original file's 7.536636 s
native residual. These are **derived**, not after measurements. Three LPT shards
weigh 164.074798, 164.078838 and 164.078 s. Applying the planning factor 1.52 gives
a longest 249.400 s before setup/merge overhead. Actual CI must decide the bar.

## Gates and artifacts

`checks` keeps `bun run typecheck` and `bun run lint` once, unchanged. It also
checks preservation, runs planted controls through the production merger and
preservation CLI, and independently creates the source-bound plan. The required
aggregate job is still named **test**. It always runs, explicitly requires both
`checks` and the entire matrix to have succeeded, and uses only Python stdlib:
it does not install dependencies or rerun tests. Other workflow jobs are unchanged.

Each shard uploads its selection/result, native timings, ordered file observations,
JUnit and console log even after failure. The merger discovers the current test
paths independently, requires an exact assignment multiset and matching source
hashes/head/plan, successful results and complete observed files. Missing,
failed, cancelled, omitted, duplicated and unknown artifacts/files are red.
A discovered zero-test timing row remains required (the imported shoulder file).

For the source-bound preservation change, the merger requires all 936 baseline
JUnit identities as a multiset, normalizing only `retarget-later` back to its
original file. Equal counts with different names fail. Baseline counts are data,
not an evergreen constant: added files or other changed source inputs make the
old identities reference-only; all current files and all JUnit cases are still
counted. Intentional later changes to the frozen retarget blocks/declarations
require updating their preservation record, like updating a snapshot.

The merged artifact contains the complete before/after per-file table and exact
count. The original retarget before row describes the unsplit file; the sibling
has no independent before measurement. Synthetic control artifacts are labelled
as such and never published as after measurements.

Acceptance uses **longest complete shard job plus complete aggregate job** from
Actions, against 735.69 s and the 300 s target. Command/script durations in the
artifact exclude Actions setup/upload and cannot replace that measurement.
Two consecutive green runs on the exact PR head remain required. If the complete
job measure exceeds 300 s, stop for HQ; do not silently recut or retry a flake.
