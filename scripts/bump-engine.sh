#!/usr/bin/env bash
#
# Point services/engine/requirements.txt at a different engine release.
#
# The engine used to be vendored as a byte copy kept in step by a sync script.
# Since v0.1.0 it is a real package, so "syncing" is just editing one pinned
# ref -- which is the whole reason to prefer a dependency over a copy.
#
#   ./scripts/bump-engine.sh              # bump to the latest release
#   ./scripts/bump-engine.sh v0.2.0       # bump to a specific tag
#
set -euo pipefail

REPO="jacobemerick/backcountry-water-oracle"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQ="$HERE/services/engine/requirements.txt"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
  echo "Latest release: $TARGET"
fi

CURRENT="$(grep -oE '@[^@]+$' "$REQ" | tail -1 | tr -d '@')"
if [ "$CURRENT" = "$TARGET" ]; then
  echo "Already pinned to $TARGET."
  exit 0
fi

# BSD and GNU sed disagree about -i, so rewrite via a temp file.
sed "s|@${CURRENT}\$|@${TARGET}|" "$REQ" > "$REQ.tmp" && mv "$REQ.tmp" "$REQ"
echo "  was $CURRENT"
echo "  now $TARGET"
echo
echo "Next:"
echo "  npm run engine:install    # reinstall the local venv"
echo "  npm test                  # fixtures are recorded from the engine; a"
echo "                            # contract change fails here, which is the point"
