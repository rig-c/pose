#!/usr/bin/env bash
# Confirm that the registry serves @rig-c/pose@<version> and that it installs
# into an empty directory and runs from there: `rig-pose --version`, then a
# retarget of the public wave to its pinned bytes (smoke_install.sh, #260).
#   exit 0  served, installed, --version printed the version, the wave retargeted
#   exit 1  served, and the install or a run failed (the last line says which)
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
echo "@rig-c/pose@$version is served"
exec bash "$(dirname "$0")/smoke_install.sh" "@rig-c/pose@$version" "$version"
