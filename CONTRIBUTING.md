# Contributing

`@rig-c/pose` (`rig-pose`) retargets body-18 pose sequences onto rigs built with [`@rig-c/core`](https://github.com/rig-c/core) and checks the resulting motion through rig-c's gate before writing anything. Read [AGENTS.md](AGENTS.md) before writing a first patch.

## Getting the code running

From a clone, with [Bun](https://bun.sh) 1.4+ and Node.js 22+ on `PATH`:

```sh
bun install --frozen-lockfile
bun cli.ts --help
bun cli.ts retarget --rig examples/wave/rig --map examples/wave/map.json --sequence examples/wave/pose.json --out <out-dir>/wave.motion.json --build <out-dir>/wave-build
```

## Before you open a pull request

Run the typecheck, linter, unit and planted-failure test suite, and pack list check from `package.json` and [AGENTS.md](AGENTS.md):

```sh
bun run typecheck
bun run lint
bun run test
npm pack --dry-run
```

CI (`.github/workflows/ci.yml`) also runs the installed-tarball smoke test and the parked-limits issue check (which queries GitHub over the network):

```sh
d=$(mktemp -d)
npm pack --pack-destination "$d" > /dev/null
bash scripts/smoke_mutants.sh "$d"/*.tgz "$(node -p 'require("./package.json").version')"
bun scripts/scope_issues.ts --closed-control 46
```

## Reporting a change

- **Issue first.** Open an issue before making a change. A defect report names what you gave `rig-pose` (the command and smallest reproducible input), what it printed verbatim including the problem code, and what you expected instead. A wrong output that passed green is a defect.
- **One issue per pull request.** Keep each pull request scoped to a single issue.
- **Conventional Commits.** Write commit messages, code, and documentation in English using [Conventional Commits](https://www.conventionalcommits.org/) with a scope (`feat(retarget):`, `fix(clean):`, `check(verify):`, `docs(readme):`). `feat` bumps the minor version and `fix`, `perf`, and `check` bump the patch; CI's `ships` job refuses changes to packed files under hidden commit types.

## Where further rules live

- [AGENTS.md](AGENTS.md) — architecture, doctrine, determinism rules, and contributor conventions.
- [RELEASING.md](RELEASING.md) — 1.x surface promises, commit types, and release workflow.
- [docs/REFERENCE.md](docs/REFERENCE.md) — full command, format, report, and refusal reference.
- [LICENSE](LICENSE) — MIT licence terms.
