#!/usr/bin/env bash
# Rebuild the compiled test fixtures with Tweego.
#
# One-time setup: download tweego-2.1.1-linux-x64.zip from
#   https://www.motoslave.net/tweego/
# extract it into the repo's .tools/ directory and chmod +x .tools/tweego.
set -euo pipefail
cd "$(dirname "$0")"

TWEEGO=../../.tools/tweego
if [[ ! -x "$TWEEGO" ]]; then
  echo "error: Tweego not found at .tools/tweego" >&2
  echo "Download tweego-2.1.1-linux-x64.zip from https://www.motoslave.net/tweego/" >&2
  echo "extract it into .tools/ and run: chmod +x .tools/tweego" >&2
  exit 1
fi

mkdir -p compiled
"$TWEEGO" -f sugarcube-2 -o compiled/sugarcube.html sugarcube.twee
"$TWEEGO" -f harlowe-3  -o compiled/harlowe.html  harlowe.twee
"$TWEEGO" -f snowman-2  -o compiled/snowman.html  snowman.twee
"$TWEEGO" -f chapbook-1 -o compiled/chapbook.html chapbook.twee
echo "Fixtures rebuilt in test/fixtures/compiled/"
