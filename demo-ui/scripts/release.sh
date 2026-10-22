#!/usr/bin/env bash
# Release gate: tests → commit → push → CI green → fast-forward main → deploy → verify.
# Stops at the first failure. Usage: demo-ui/scripts/release.sh <commit-message-file> <paths...>
# Stop conditions: the local suite is not 'fail 0'; no CI run appears for the pushed SHA; that
# run is not green; the production deploy fails; /api/health is not ok; the served / differs
# from demo-ui/index.html; main is not a fast-forward; demo-ui has uncommitted/untracked files
# before the deploy; either host (maistro-demo.vercel.app, www.ma1stro.com) does not report the
# released SHA as its revision. Nothing reaches main or production unless every earlier step passed.
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
# main moves only by fast-forward (a plain push refuses anything else; never --force)
git push -q origin rebuild/phase-0-recon:main || { echo "RELEASE STOPPED: main is not a fast-forward of the branch"; exit 1; }
git branch -f main rebuild/phase-0-recon
cd demo-ui
# vercel deploys the working tree: it must be exactly the SHA CI tested
DIRTY=$(git status --porcelain . | grep -v '\.vercel' || true)
[ -z "$DIRTY" ] || { echo "RELEASE STOPPED: demo-ui has uncommitted or untracked files:"; echo "$DIRTY"; exit 1; }
SHORT=${SHA:0:7}
vercel deploy --prod --yes --env MAISTRO_REVISION="$SHA" > /dev/null 2>&1 || { echo "RELEASE STOPPED: deploy failed"; exit 1; }
for HOST in https://maistro-demo.vercel.app https://www.ma1stro.com; do
  H=$(curl -s "$HOST/api/health")
  echo "$H" | grep -q '"ok":true' || { echo "RELEASE STOPPED: $HOST health not ok"; exit 1; }
  echo "$H" | grep -q "\"revision\":\"$SHORT\"" || { echo "RELEASE STOPPED: $HOST answers revision $(echo "$H" | grep -o '"revision":[^,]*'), expected $SHORT"; exit 1; }
  [ "$(curl -s "$HOST/" | sha256sum | cut -c1-64)" = "$(sha256sum index.html | cut -c1-64)" ] || { echo "RELEASE STOPPED: $HOST serves a page that differs from index.html"; exit 1; }
done
echo "RELEASED $(git log --oneline -1) at $(date -u +%H:%M) UTC"
