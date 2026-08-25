#!/usr/bin/env bash
#
# Re-record the engine contract fixtures from the pinned engine.
#
# The fixtures are real `water-forecast --json` output, never hand-written: a
# hand-written fixture only encodes what we already believed, which is exactly
# how `notes` came to be typed as string[] when the engine emits objects.
#
# Their CSV inputs are committed beside them, so recording needs the engine and
# nothing else -- no database, no network beyond the precipitation the engine
# caches. Run this after ./scripts/bump-engine.sh, then `npm test`: a contract
# change shows up as a failing assertion rather than as a production 500.
#
#   ./scripts/record-fixtures.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$HERE/services/engine/.venv/bin/water-forecast"
FIXTURES="$HERE/test/fixtures"

# Frozen so a re-record is a diff of engine behaviour, not of today's date.
ASOF="2026-08-05"

if [ ! -x "$CLI" ]; then
  echo "Engine not installed. Run: npm run engine:install" >&2
  exit 1
fi

# --radar none matches services/engine/app.py, which disables the MRMS
# cross-check on this host. Fixtures must describe what we actually serve.
for name in engine-three-sources engine-with-notes; do
  echo "recording $name"
  "$CLI" "$FIXTURES/$name.csv" --json --asof="$ASOF" --radar=none > "$FIXTURES/$name.json"
done

echo
echo "Recorded at engine $("$CLI" --version)"
echo "Next: npm test"
