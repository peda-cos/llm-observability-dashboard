#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export NEXT_TELEMETRY_DISABLED=1
export CI=1

node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 24) { console.error(`Node >= 24 required, found ${process.versions.node}`); process.exit(1); }'

npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
