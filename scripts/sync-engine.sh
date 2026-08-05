#!/usr/bin/env bash
#
# Re-vendor services/engine/forecast.py from the upstream oracle repo.
#
# The engine is vendored rather than ported: it is ~700 lines of dependency-free
# stdlib numerics, and a TypeScript port would mean maintaining two
# implementations of an empirical-Bayes shrinkage estimator that will drift.
# Vendoring keeps one source of truth and makes the version explicit.
#
#   ./scripts/sync-engine.sh                 # sync to upstream origin/main
#   ./scripts/sync-engine.sh <ref>           # sync to a specific ref/SHA
#   UPSTREAM=/path/to/repo ./scripts/sync-engine.sh
#
set -euo pipefail

UPSTREAM="${UPSTREAM:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/backcountry-water-oracle}"
REF="${1:-origin/main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$UPSTREAM/.git" ]; then
  echo "[error] upstream repo not found at $UPSTREAM" >&2
  echo "        clone it, or set UPSTREAM=/path/to/backcountry-water-oracle" >&2
  exit 1
fi

git -C "$UPSTREAM" fetch origin --quiet
SHA="$(git -C "$UPSTREAM" rev-parse "$REF")"
PREV="$(cat "$HERE/services/engine/PINNED_COMMIT" 2>/dev/null || echo none)"

git -C "$UPSTREAM" show "$REF:forecast.py" > "$HERE/services/engine/forecast.py"
git -C "$UPSTREAM" show "$REF:LICENSE"     > "$HERE/services/engine/LICENSE"
printf '%s\n' "$SHA" > "$HERE/services/engine/PINNED_COMMIT"

echo "services/engine/forecast.py"
echo "  was $PREV"
echo "  now $SHA"

if [ "$PREV" != "$SHA" ] && [ "$PREV" != "none" ]; then
  echo
  echo "Changes pulled in:"
  git -C "$UPSTREAM" log --oneline "$PREV..$SHA" -- forecast.py | sed 's/^/  /'
  echo
  echo "Run 'npm test' -- the JSON contract fixtures will catch a shape change."
fi
