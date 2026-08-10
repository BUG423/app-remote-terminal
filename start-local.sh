#!/usr/bin/env bash
set -euo pipefail

# Start the Agent as the current login account, preserving its HOME, PATH and
# current working directory. This script never creates users, workspaces or
# system services and never changes ownership or permissions outside the repo.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${CW_CONFIG_PATH:-${SCRIPT_DIR}/agent/config.json}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v node >/dev/null || fail "Node.js is not installed"
command -v npm >/dev/null || fail "npm is not installed"
node -e 'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 20 && major < 25 ? 0 : 1)' || \
  fail "Node.js 20-24 is required; found $(node --version)"
[[ -f "${CONFIG_PATH}" ]] || fail "missing ${CONFIG_PATH}; copy agent/config.json.example and configure it"

echo "Remote Terminal Agent"
echo "User: $(id -un) (uid=$(id -u))"
echo "HOME: ${HOME}"
echo "Working directory: ${PWD}"
echo "Node: $(node --version)"
echo "Config: ${CONFIG_PATH}"

npm ci --prefix "${SCRIPT_DIR}/agent" --no-audit --no-fund
exec env NODE_ENV=production CW_CONFIG_PATH="${CONFIG_PATH}" node "${SCRIPT_DIR}/agent/index.js"
