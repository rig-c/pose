# PR regression rows

`bun test test/gate.test.ts` runs the two public reference scans (`dancer` and
`second`) and the generated `run` row added by [#375](https://github.com/rig-c/pose/issues/375).
The run reuses #369's grounded `depthCycle('run', 'front', 10, true)` from
`examples/walk/make-depth.ts`, the wave rig and the walk map. The shared input
helper is `test/flight-fixture.ts`; there is no exam sequence, map or solve here.

The run is cleaned with `loop: true, legs: 1, rest: 1`, declared in place, and
retargeted with `--plant-feet --stance 0.07 --leg-scale 0.5,1.05 --floor 0 --flip 45`.
Its animation is called `dance`, like the other gate rows. These are generated
fixture settings, not exam settings. The existing flip guard spreads abrupt
arm turns from frontal foreshortening; the standing 45°/frame continuity
ceiling is unchanged.

The generator's `lifted` tells which foot is truly supporting on each frame,
including its short stances. `GATE_SUPPORT_FOOT_HEIGHT` checks that foot's shin
tip on the gated build, posed by rig-c, against world y = 0 within 0.01 L.
L is the mean of both setup thigh-root to shin-tip distances. The generator's
floor is `RUN_FLOOR` in y-up coordinates (picture y = `400 - RUN_FLOOR`),
translated to the explicitly requested `--floor 0`. No observed output height
is subtracted. Neither `report.feet.jumps` nor the report's selected supports
or floor choose the test frames or the expected floor. A common vertical shift
and a false report that calls every frame airborne cannot hide an error.

All three rows use the same continuity assertions and `Claim-Track` rules.
A deliberate change on this fixture uses the reference name `run`, for example
`Claim-Track: run hip.translate 3 #375`. A claim only permits the track diff;
it does not waive continuity or support height.

On PR CI, `GATE_BASE_SHA` and `GATE_HEAD_SHA` identify the base and candidate;
claims are read from `GATE_PR_BODY` and the intervening commit messages. A
requested base that cannot be resolved, archived or extracted is refused as
`GATE_BASE_UNAVAILABLE`. With no base requested, track comparison explicitly
reports `SKIP`; the candidate's continuity and support height still run.
A source-snapshot runner without Git history may instead set `GATE_BASE_CLI`
to a separate base tree's `cli.ts` (with dependencies resolvable beside it).
For that adapter, supply all claims in `GATE_PR_BODY`; commit messages are not
available. Missing paths and the candidate CLI itself are refused, never used
as a self-comparison fallback.

The run has no meshes or gesture switches. Its mesh-fold row reports `SKIP`;
the original references retain the fold and gesture coverage. This row does
not sit or grade the advanced exam and changes no exam bar. Canonical exam
validation stays private under the RC exam gate.
