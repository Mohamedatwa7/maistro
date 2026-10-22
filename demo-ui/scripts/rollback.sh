#!/usr/bin/env bash
# Roll production back to an earlier deployment (Phase 12, RUNBOOK.md "Bad deploy").
#   bash demo-ui/scripts/rollback.sh <deployment-url>
# <deployment-url> is a previous production deployment (`vercel ls --prod` lists them, newest first). The script
# reads the revision that deployment reports, promotes it, then waits until BOTH hosts answer that revision and
# serve the same page as the deployment itself. It changes nothing in git: the next release.sh run moves forward again.
set -euo pipefail
URL="${1:?usage: rollback.sh <deployment-url>}"
cd "$(dirname "$0")/.."
REV=$(curl -s "$URL/api/health" | sed -n 's/.*"revision":"\([^"]*\)".*/\1/p')
[ -n "$REV" ] || { echo "ROLLBACK STOPPED: $URL/api/health reports no revision (is it a Maistro deployment? protected?)"; exit 1; }
PAGE=$(curl -s "$URL/" | sha256sum | cut -c1-64)
echo "rolling back to $URL (revision $REV)"
vercel promote "$URL" --yes > /dev/null 2>&1 || { echo "ROLLBACK STOPPED: vercel promote failed"; exit 1; }
for HOST in https://maistro-demo.vercel.app https://www.ma1stro.com; do
  OK=""
  for i in $(seq 1 18); do
    H=$(curl -s "$HOST/api/health")
    if echo "$H" | grep -q "\"revision\":\"$REV\"" && [ "$(curl -s "$HOST/" | sha256sum | cut -c1-64)" = "$PAGE" ]; then OK=1; break; fi
    sleep 10
  done
  [ -n "$OK" ] || { echo "ROLLBACK STOPPED: $HOST did not converge on $REV within 3 min"; exit 1; }
done
echo "ROLLED BACK to $REV on both hosts at $(date -u +%H:%M) UTC — main in git is unchanged; fix forward with release.sh"
