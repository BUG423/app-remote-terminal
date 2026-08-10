#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-$((30000 + RANDOM % 20000))}"
TEST_ROOT="$(mktemp -d /tmp/remote-terminal-tests.XXXXXX)"
WORKSPACE_ROOT="${TEST_ROOT}/workspace"
SERVER_CONFIG_PATH="${TEST_ROOT}/server.json"
AGENT_CONFIG_PATH="${TEST_ROOT}/agent.json"
BROWSER_TOKEN="${CW_BROWSER_TOKEN:-$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")}"
AGENT_TOKEN="${CW_AGENT_TOKEN:-$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")}"

SERVER_PID=""
AGENT_PID=""

cleanup() {
  if [[ -n "${AGENT_PID}" ]]; then
    kill "${AGENT_PID}" 2>/dev/null || true
    wait "${AGENT_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  if [[ "${TEST_ROOT}" == /tmp/remote-terminal-tests.* ]]; then rm -rf "${TEST_ROOT}"; fi
}
trap cleanup EXIT INT TERM

cd "${ROOT}"
mkdir -m 0700 -p "${WORKSPACE_ROOT}"

cat > "${SERVER_CONFIG_PATH}" <<JSON
{
  "port": ${PORT},
  "bindHost": "127.0.0.1",
  "useTLS": false,
  "devices": {
    "server-e2e-agent": {
      "name": "server-e2e-agent",
      "browserToken": "${BROWSER_TOKEN}",
      "agentToken": "${AGENT_TOKEN}"
    }
  }
}
JSON

CURRENT_AGENT_USER="$(id -un)"
CURRENT_AGENT_UID="$(id -u)"
CURRENT_AGENT_HOME="$(node -p 'require("os").userInfo().homedir')"
cat > "${AGENT_CONFIG_PATH}" <<JSON
{
  "agentToken": "${AGENT_TOKEN}",
  "serverUrl": "ws://127.0.0.1:${PORT}",
  "requiredUser": "${CURRENT_AGENT_USER}",
  "requiredUid": ${CURRENT_AGENT_UID},
  "requiredHome": "${CURRENT_AGENT_HOME}",
  "requiredWorkingDirectory": "${WORKSPACE_ROOT}"
}
JSON
chmod 600 "${SERVER_CONFIG_PATH}" "${AGENT_CONFIG_PATH}"

echo "== npm test =="
npm test

echo "== start real Relay + Agent =="
NODE_ENV=production CW_CONFIG_PATH="${SERVER_CONFIG_PATH}" node server/index.js > "${TEST_ROOT}/server.log" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:${PORT}/health"

(
  cd "${WORKSPACE_ROOT}"
  exec env NODE_ENV=production CW_CONFIG_PATH="${AGENT_CONFIG_PATH}" node "${ROOT}/agent/index.js"
) > "${TEST_ROOT}/agent.log" 2>&1 &
AGENT_PID="$!"
sleep 3

echo "== real PTY e2e =="
TARGET="ws://127.0.0.1:${PORT}" \
REMOTE_TERMINAL_BROWSER_TOKEN="${BROWSER_TOKEN}" \
WORKSPACE_ROOT="${WORKSPACE_ROOT}" \
node tests/e2e.js

echo "== protocol security =="
TARGET="ws://127.0.0.1:${PORT}" \
REMOTE_TERMINAL_BROWSER_TOKEN="${BROWSER_TOKEN}" \
REMOTE_TERMINAL_AGENT_TOKEN="${AGENT_TOKEN}" \
node tests/security.js

echo "== real Relay restart recovery =="
node tests/relay-restart.test.js

echo "== port cleanup check =="
cleanup
SERVER_PID=""
AGENT_PID=""
sleep 1
if ss -ltnp | grep -E ":${PORT}\\b"; then
  echo "❌ port ${PORT} still listening after cleanup"
  exit 1
fi
echo "✅ server test processes cleaned"
