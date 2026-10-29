#!/usr/bin/env bash
# The install smoke beside its planted failures (rig-c/pose#260): a smoke
# nobody has seen fail is not a smoke.
#
#   smoke_mutants.sh <packed.tgz> <version>
#
# 1. control — the tarball as packed: smoke_install.sh is green.
#    A second control installs @rig-c/core beside the tarball; both must share it.
# 2. a src module left out of the tarball: red at the --version step.
# 3. the gate's launcher resolved by a name the install does not have, in the
#    packed src/rigc.ts: --version still answers, so a --version-only check
#    passes it; the smoke is red at the retarget step.
# 4. a legacy core added beside the canonical one: red at the core graph step.
#
#   exit 0  the control is green and each mutant is red at the step named
#   exit 1  otherwise; the last line says which
set -uo pipefail
tgz="${1:-}"; version="${2:-}"
if [ -z "$tgz" ] || [ -z "$version" ]; then echo "usage: smoke_mutants.sh <packed.tgz> <version>" >&2; exit 2; fi
case "$tgz" in /*) ;; *) tgz="$PWD/$tgz" ;; esac
smoke="$(cd "$(dirname "$0")" && pwd)/smoke_install.sh"

out=$(bash "$smoke" "$tgz" "$version" 2>&1)
if [ $? -ne 0 ]; then echo "$out"; echo "MUTANTS control: the smoke is red on the tarball as packed"; exit 1; fi
echo "control: $(echo "$out" | tail -n1)"
core_range=$(node -p 'require(process.argv[1]).dependencies["@rig-c/core"]' "$(dirname "$smoke")/../package.json")
out=$(bash "$smoke" "$tgz" "$version" "@rig-c/core@$core_range" 2>&1)
if [ $? -ne 0 ]; then echo "$out"; echo "MUTANTS alongside: the canonical core and packed pose do not share one core"; exit 1; fi
echo "alongside: $(echo "$out" | tail -n1)"

work=$(mktemp -d "${TMPDIR:-/tmp}/rig-pose-smoke.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
# mutant <name> <step the smoke must go red at> <edit run inside the unpacked package/>
mutant() {
  local name="$1" step="$2" edit="$3"
  rm -rf "$work/$name"; mkdir -p "$work/$name"
  tar -xzf "$tgz" -C "$work/$name"
  (cd "$work/$name/package" && eval "$edit") || { echo "MUTANTS $name: the edit did not apply"; exit 1; }
  tar -czf "$work/$name.tgz" -C "$work/$name" package
  local got
  got=$(bash "$smoke" "$work/$name.tgz" "$version" 2>&1)
  if [ $? -eq 0 ]; then echo "$got"; echo "MUTANTS $name: survived — the smoke is green on it"; exit 1; fi
  local last; last=$(echo "$got" | tail -n1)
  case "$last" in "SMOKE $step:"*) echo "mutant \"$name\" red at $step: $last" ;; *) echo "$got"; echo "MUTANTS $name: red, but not at the $step step"; exit 1 ;; esac
}
mutant module-left-out version 'test -f src/reduce.ts && rm src/reduce.ts'
mutant launcher-unresolved retarget "grep -q \"'@rig-c/core/bin/rigc'\" src/rigc.ts && sed -i.bak \"s#'@rig-c/core/bin/rigc'#'@rig-c/core/bin/rigc-gone'#\" src/rigc.ts && rm src/rigc.ts.bak"
mutant duplicate-core core 'node -e "const fs=require(\"fs\"); const p=JSON.parse(fs.readFileSync(\"package.json\")); p.dependencies[\"rig-c\"]=p.dependencies[\"@rig-c/core\"]; fs.writeFileSync(\"package.json\",JSON.stringify(p))"'
echo "MUTANTS ok: both controls are green, and all three mutants are red at the step they must be"
