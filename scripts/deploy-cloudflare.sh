#!/usr/bin/env bash
# Deploys This & That to Cloudflare: the Worker `this-and-that-api` and the
# Pages project `this-and-that` (see docs/deploy-cloudflare.md).
#
#   scripts/deploy-cloudflare.sh
#
# Secrets go to the Worker through stdin and are never printed:
#   MODEL_API_KEY  from $ENV_FILE (default ../this-and-that/.env)
#   DEMO_PASSCODE  from .deploy-notes.txt (git-ignored), if it has a DEMO_PASSCODE= line;
#                  without one the Worker stays open to everyone.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=${ENV_FILE:-../this-and-that/.env}
CFG=worker/wrangler.jsonc
W="npx wrangler@4"

value_of() { grep -E "^$1=" "$2" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r\n'; }

$W whoami | grep -i "logged in" || { echo "Not logged in: run npx wrangler login"; exit 1; }
[ -n "$(value_of MODEL_API_KEY "$ENV_FILE")" ] || { echo "No MODEL_API_KEY in $ENV_FILE"; exit 1; }

echo "== Worker"
out=$($W deploy --config "$CFG" 2>&1) || { echo "$out"; exit 1; }
echo "$out" | grep -E "Uploaded|Deployed|workers\.dev" || true
worker=$(echo "$out" | grep -oE 'https://this-and-that-api\.[a-z0-9-]+\.workers\.dev' | head -1)
[ -n "$worker" ] || { echo "Couldn't find the workers.dev URL in the deploy output"; exit 1; }

echo "== Secrets (values not shown)"
printf '%s' "$(value_of MODEL_API_KEY "$ENV_FILE")" | $W secret put MODEL_API_KEY --config "$CFG" >/dev/null && echo "MODEL_API_KEY set"
pass=$(value_of DEMO_PASSCODE .deploy-notes.txt)
if [ -n "$pass" ]; then
  printf '%s' "$pass" | $W secret put DEMO_PASSCODE --config "$CFG" >/dev/null && echo "DEMO_PASSCODE set (it is in .deploy-notes.txt)"
else
  echo "No DEMO_PASSCODE in .deploy-notes.txt: the Worker is open to everyone"
fi
unset pass

echo "== Pages"
VITE_API_BASE="$worker" npm run build:pages
$W pages project list 2>/dev/null | grep -q "this-and-that " || $W pages project create this-and-that --production-branch main
$W pages deploy dist --project-name this-and-that --branch main --commit-dirty=true 2>&1 | grep -E "pages\.dev|Success|Uploaded" || true

echo
echo "Worker: $worker"
echo "Pages:  https://this-and-that.pages.dev (if the project got another subdomain, add it to ALLOWED_ORIGINS in $CFG and run this again)"
echo "Check:  node scripts/smoke-cloudflare.mjs $worker https://this-and-that.pages.dev"
