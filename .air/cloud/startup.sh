#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Use the CI-supported Node 24 runtime, persisting it for fresh agent shells.
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  echo 'Installing Node.js 24 in the user tool cache...'
  npm install --prefix "$HOME/.local/share/air-node" node@24 --no-audit --no-fund
  export PATH="$HOME/.local/share/air-node/node_modules/node/bin:$PATH"
fi
mkdir -p "$HOME/.config/air"
printf 'export PATH="$HOME/.local/share/air-node/node_modules/node/bin:$PATH"\n' > "$HOME/.config/air/sangxia-env.sh"
profile_file="$HOME/.profile"
for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -f "$candidate" ]; then profile_file="$candidate"; break; fi
done
for shell_file in "$profile_file" "$HOME/.bashrc"; do
  touch "$shell_file"
  if ! grep -q '# air-sangxia-env' "$shell_file"; then
    printf '\n. "$HOME/.config/air/sangxia-env.sh" # air-sangxia-env\n' >> "$shell_file"
  fi
done

# Reuse snapshot dependencies unless the lockfile or runtime changed.
fingerprint="$(sha256sum package-lock.json package.json) $(node --version)"
if [ ! -d node_modules ] || [ ! -f node_modules/.air-fingerprint ] || [ "$(cat node_modules/.air-fingerprint)" != "$fingerprint" ]; then
  echo 'Installing locked development dependencies...'
  npm ci --no-audit --no-fund
  printf '%s' "$fingerprint" > node_modules/.air-fingerprint
fi
echo 'Building Sangxia...'
npm run build

healthcheck() {
  echo 'Checking TypeScript and the offline ACP handshake, tools, and permissions...'
  npm run typecheck
  node scripts/smoke.mjs
  echo 'Sangxia environment is ready.'
}
if [ "${AIR_STARTUP_MODE:-task}" = warmup ]; then
  healthcheck
fi
