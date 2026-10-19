#!/usr/bin/env bash
# Install @rig-c/pose from <spec> into an empty directory and use it there
# (rig-c/pose#260): `rig-pose --version`, then `rig-pose retarget` on the public
# wave example, its motion held to the wave's pinned bytes and its report read.
# A package that answers --version and cannot retarget is not a package.
#
#   smoke_install.sh <spec> [expected-version]
#     <spec>  what `npm install` takes: a packed tarball, or @rig-c/pose@<version>
#
#   exit 0  installed, --version answered, the wave retargeted to the pinned bytes
#   exit 1  a step failed; the last line names which, with what it got
#   exit 2  bad invocation
set -uo pipefail
spec="${1:-}"; expected="${2:-}"
if [ -z "$spec" ]; then echo "usage: smoke_install.sh <spec> [expected-version]" >&2; exit 2; fi
here="$(cd "$(dirname "$0")/.." && pwd)"
wave="$here/examples/wave"
# The wave's motion, byte for byte, as test/retarget.test.ts pins it (test/smoke.test.ts holds the two equal).
WAVE_SHA256=bd1ca2506217c21769169b884a306ad2defabaadecb93abd0572969291aa2e59
case "$spec" in /*|@*) ;; *) spec="$PWD/$spec" ;; esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work" || exit 1
npm init -y > /dev/null
if ! npm install "$spec" > install.log 2>&1; then
  cat install.log; echo "SMOKE install: npm install $spec failed"; exit 1
fi
bin=./node_modules/.bin/rig-pose
got=$("$bin" --version) || { echo "SMOKE version: rig-pose --version exited non-zero from the install"; exit 1; }
if [ -n "$expected" ] && [ "$got" != "$expected" ]; then
  echo "SMOKE version: the installed rig-pose --version printed \"$got\"; expected $expected"; exit 1
fi

# The example is not shipped: it comes from this checkout, and only the package under test runs it.
cp -R "$wave" wave
"$bin" retarget --rig wave/rig --map wave/map.json --pose wave/pose.json --out out/motion.json --report out/report.json > retarget.out 2> retarget.err
status=$?
if [ "$status" -ne 0 ]; then
  tail -n 20 retarget.err
  echo "SMOKE retarget: rig-pose retarget on the wave exited $status from the install (first error line: $(grep -m1 -E '^(FAIL|error|Error)' retarget.err || head -n1 retarget.err))"; exit 1
fi
sha=$(shasum -a 256 out/motion.json | cut -d' ' -f1)
rigc=$(grep -m1 'RIGC ' retarget.out | sed 's/^ *//')
if [ "$sha" != "$WAVE_SHA256" ]; then
  echo "SMOKE bytes: the wave's motion from the install hashes $sha; the pinned bytes are $WAVE_SHA256 ($rigc)"; exit 1
fi
spec_read=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("out/report.json","utf8")).spec)' 2>/dev/null)
if [ "$spec_read" != "rig-pose-report/1" ]; then
  echo "SMOKE report: out/report.json reads spec \"$spec_read\"; expected rig-pose-report/1"; exit 1
fi
echo "SMOKE ok: $spec installs into an empty directory; rig-pose --version = $got; retarget on the wave = the pinned bytes ($WAVE_SHA256), report rig-pose-report/1; $rigc"
