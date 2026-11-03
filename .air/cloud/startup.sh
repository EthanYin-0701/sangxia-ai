#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "Sangxia setup: $(node --version), npm $(npm --version)"
# Cache the lockfile identity so snapshot-backed tasks avoid reinstalling.
dependency_key="$(cat package-lock.json package.json; node --version; npm --version)"
dependency_key="$(printf '%s' "$dependency_key" | sha256sum | cut -d' ' -f1)"
if [[ ! -f node_modules/.air-dependencies || "$(cat node_modules/.air-dependencies)" != "$dependency_key" ]]; then
  echo "Installing locked dependencies..."
  npm ci --no-audit --no-fund
  printf '%s\n' "$dependency_key" > node_modules/.air-dependencies
fi
echo "Building Sangxia..."
npm run build

healthcheck() {
  echo "Checking types and ACP handshake, tool execution, and permissions..."
  npm run typecheck
  node scripts/smoke.mjs
  echo "Sangxia environment ready."
}

if [[ "${AIR_STARTUP_MODE:-}" == warmup ]]; then
  healthcheck
fi
