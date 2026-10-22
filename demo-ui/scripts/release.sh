#!/usr/bin/env bash
# Release gate: tests → commit → push → CI green → fast-forward main → deploy → verify.
# Stops at the first failure. Usage: demo-ui/scripts/release.sh <commit-message-file> <paths...>
# Stop conditions: the local suite is not 'fail 0'; no CI run appears for the pushed SHA; that
# run is not green; the production deploy fails; /api/health is not ok; the served / differs
# from demo-ui/index.html. Nothing reaches main or production unless every earlier step passed.
set -euo pipefail
MSG="$1"; shift
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT/demo-ui"
OUT=$(mktemp)
timeout 290 npm test > "$OUT" 2>&1 || true
grep -E "^ℹ (tests|pass|fail)" "$OUT"
grep -q "^ℹ fail 0" "$OUT" || { echo "RELEASE STOPPED: test suite red"; grep -E "^✖" "$OUT" | head -5; exit 1; }
cd "$ROOT"
git add "$@"
git -c user.name="Mohamedatwa7" -c user.email="186195188+Mohamedatwa7@users.noreply.github.com" commit -q -F "$MSG"
git push -q origin rebuild/phase-0-recon
SHA=$(git rev-parse HEAD)
for i in $(seq 1 30); do RID=$(gh run list --branch rebuild/phase-0-recon --commit "$SHA" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true); [ -n "$RID" ] && break; sleep 4; done
[ -n "${RID:-}" ] || { echo "RELEASE STOPPED: no CI run found for $SHA"; exit 1; }
gh run watch "$RID" --exit-status > /dev/null 2>&1 || { echo "RELEASE STOPPED: CI red on $SHA (run $RID)"; exit 1; }
echo "CI green ($RID)"
git branch -f main rebuild/phase-0-recon && git push -q origin main
cd demo-ui
vercel deploy --prod --yes > /dev/null 2>&1 || { echo "RELEASE STOPPED: deploy failed"; exit 1; }
curl -s https://maistro-demo.vercel.app/api/health | grep -q '"ok":true' || { echo "RELEASE STOPPED: health not ok"; exit 1; }
[ "$(curl -s https://maistro-demo.vercel.app/ | sha256sum | cut -c1-64)" = "$(sha256sum index.html | cut -c1-64)" ] || { echo "RELEASE STOPPED: served page differs"; exit 1; }
echo "RELEASED $(git log --oneline -1) at $(date -u +%H:%M) UTC"
