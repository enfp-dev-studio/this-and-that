#!/usr/bin/env bash
# Deploys This & That to Cloudflare: the API Worker `this-and-that-api`
# (worker/) and the web app as the static-assets Worker `this-and-that` (web/),
# both on workers.dev (see docs/deploy-cloudflare.md).
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
out=$(cd worker && $W deploy 2>&1) || { echo "$out"; exit 1; }
echo "$out" | grep -E "Uploaded|Deployed|workers\.dev" || true
worker=$(echo "$out" | grep -oE 'https://this-and-that-api\.[a-z0-9-]+\.workers\.dev' | head -1)
[ -n "$worker" ] || { echo "Couldn't find the workers.dev URL in the deploy output"; exit 1; }

echo "== Secrets (values not shown)"
printf '%s' "$(value_of MODEL_API_KEY "$ENV_FILE")" | (cd worker && $W secret put MODEL_API_KEY >/dev/null) && echo "MODEL_API_KEY set"
pass=$(value_of DEMO_PASSCODE .deploy-notes.txt)
if [ -n "$pass" ]; then
  printf '%s' "$pass" | (cd worker && $W secret put DEMO_PASSCODE >/dev/null) && echo "DEMO_PASSCODE set (it is in .deploy-notes.txt)"
else
  echo "No DEMO_PASSCODE in .deploy-notes.txt: the Worker is open to everyone"
fi
unset pass

echo "== Web app"
VITE_API_BASE="$worker" npm run build:web
web_out=$(cd web && $W deploy 2>&1) || { echo "$web_out"; exit 1; }
echo "$web_out" | grep -E "Uploaded|Deployed|workers\.dev" || true
web=$(echo "$web_out" | grep -oE 'https://this-and-that\.[a-z0-9-]+\.workers\.dev' | head -1)

echo
echo "API:  $worker"
echo "App:  ${web:-?} (it must be in ALLOWED_ORIGINS in worker/wrangler.jsonc; if not, add it and run this again)"
echo "Check: node scripts/smoke-cloudflare.mjs $worker ${web:-<app url>}"
