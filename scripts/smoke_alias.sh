#!/usr/bin/env bash
# Install an alias tarball or registry spec in an empty directory; check identity and help.
# Exit 0 = confirmed, 1 = install/identity/CLI failure, 2 = bad invocation.
set -euo pipefail
spec="${1:-}"; expected="${2:-}"
if [ -z "$spec" ] || [ -z "$expected" ]; then
  echo "usage: smoke_alias.sh <spec> <expected-version>" >&2; exit 2
fi
case "$spec" in /*|rig-pose@*) ;; *) spec="$PWD/$spec" ;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y > /dev/null
if ! npm install "$spec" > install.log 2>&1; then
  cat install.log; echo "ALIAS install: npm install $spec failed"; exit 1
fi
identity=$(node -p 'const p = require("./node_modules/rig-pose/package.json"); p.name + "@" + p.version')
if [ "$identity" != "rig-pose@$expected" ]; then
  echo "ALIAS identity: installed $identity; required rig-pose@$expected"; exit 1
fi
bin=./node_modules/.bin/rig-pose
got=$("$bin" --version)
if [ "$got" != "$expected" ]; then
  echo "ALIAS version: rig-pose --version printed $got; required $expected"; exit 1
fi
"$bin" --help > help.out
if ! grep -q 'rig-pose' help.out; then
  echo "ALIAS help: rig-pose --help did not identify the command"; exit 1
fi
echo "ALIAS ok: $identity installs into an empty directory; rig-pose --version = $got; rig-pose --help exited 0"
