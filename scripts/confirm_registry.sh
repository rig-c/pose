#!/usr/bin/env bash
# Confirm that the registry serves @rig-c/pose@<version> and that it installs
# into an empty directory and runs from there.
#   exit 0  served, installed, `rig-pose --version` printed the version
#   exit 1  served, and the install or the run failed (the output says which)
#   exit 2  bad invocation
#   exit 3  the registry did not serve the version inside the wait — the
#           confirmation was NOT taken; re-run it
set -uo pipefail
version="${1:-}"; wait_min="${2:-15}"
if [ -z "$version" ]; then echo "usage: confirm_registry.sh <version> [wait-minutes]" >&2; exit 2; fi
deadline=$(( $(date +%s) + wait_min * 60 ))
until npm view "@rig-c/pose@$version" version > /dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "the registry did not serve @rig-c/pose@$version within $wait_min minute(s): confirmation NOT taken"
    exit 3
  fi
  sleep 20
done
work=$(mktemp -d)
cd "$work" || exit 1
npm init -y > /dev/null
if ! npm install "@rig-c/pose@$version" > install.log 2>&1; then
  cat install.log; echo "npm install @rig-c/pose@$version failed"; exit 1
fi
got=$(./node_modules/.bin/rig-pose --version) || { echo "rig-pose --version exited non-zero from the install"; exit 1; }
if [ "$got" != "$version" ]; then
  echo "the installed rig-pose --version printed \"$got\"; the published version is $version"; exit 1
fi
echo "@rig-c/pose@$version is served, installs into an empty directory and runs: rig-pose --version = $got"
