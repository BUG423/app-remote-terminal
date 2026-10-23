#!/usr/bin/env bash
set -euo pipefail

# Safely update an existing server checkout from GitHub and reload only the
# relay process. This script deliberately does not upload config.json, alter
# firewall rules, install system packages, or replace systemd configuration.

SERVER_HOST="${SERVER_HOST:-}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_SSH_PORT="${SERVER_SSH_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/remote-terminal}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
REMOTE_CONFIG_PATH="${REMOTE_CONFIG_PATH:-/etc/remote-terminal/server.json}"
SERVER_SERVICE="${SERVER_SERVICE:-remote-terminal-server.service}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ -n "${SERVER_HOST}" ]] || fail "set SERVER_HOST"
[[ "${SERVER_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "invalid SERVER_USER"
[[ "${SERVER_SSH_PORT}" =~ ^[0-9]+$ ]] || fail "invalid SERVER_SSH_PORT"
(( SERVER_SSH_PORT >= 1 && SERVER_SSH_PORT <= 65535 )) || fail "SERVER_SSH_PORT out of range"
[[ "${REMOTE_DIR}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "REMOTE_DIR must be a simple absolute path"
[[ ! "${REMOTE_DIR}" =~ ^/(|root|home|opt|usr|var)$ ]] || fail "REMOTE_DIR is too broad"
[[ "${DEPLOY_BRANCH}" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "invalid DEPLOY_BRANCH"
[[ "${REMOTE_CONFIG_PATH}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "REMOTE_CONFIG_PATH must be a simple absolute path"
[[ "${SERVER_SERVICE}" =~ ^[A-Za-z0-9_.@-]+$ ]] || fail "invalid SERVER_SERVICE"

SSH=(ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -p "${SERVER_SSH_PORT}")
TARGET="${SERVER_USER}@${SERVER_HOST}"

echo "Updating ${TARGET}:${REMOTE_DIR} from origin/${DEPLOY_BRANCH}"

"${SSH[@]}" "${TARGET}" bash -s -- \
  "${REMOTE_DIR}" "${DEPLOY_BRANCH}" "${REMOTE_CONFIG_PATH}" "${SERVER_SERVICE}" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_DIR="$1"
DEPLOY_BRANCH="$2"
REMOTE_CONFIG_PATH="$3"
SERVER_SERVICE="$4"

[[ -d "${REMOTE_DIR}/.git" ]] || {
  echo "ERROR: ${REMOTE_DIR} is not an existing Git checkout" >&2
  exit 1
}
[[ -f "${REMOTE_CONFIG_PATH}" ]] || {
  echo "ERROR: ${REMOTE_CONFIG_PATH} is missing; create it on the server" >&2
  exit 1
}
command -v node >/dev/null || { echo "ERROR: node is not installed" >&2; exit 1; }
command -v npm >/dev/null || { echo "ERROR: npm is not installed" >&2; exit 1; }
command -v curl >/dev/null || { echo "ERROR: curl is not installed" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "ERROR: systemd is required" >&2; exit 1; }
systemctl cat "${SERVER_SERVICE}" >/dev/null 2>&1 || {
  echo "ERROR: ${SERVER_SERVICE} is not installed" >&2
  exit 1
}

cd "${REMOTE_DIR}"
CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
[[ "${CURRENT_BRANCH}" == "${DEPLOY_BRANCH}" ]] || {
  echo "ERROR: expected branch ${DEPLOY_BRANCH}, found ${CURRENT_BRANCH:-detached HEAD}" >&2
  exit 1
}

git diff --quiet && git diff --cached --quiet || {
  echo "ERROR: server checkout has uncommitted changes" >&2
  exit 1
}
git fetch --prune origin "${DEPLOY_BRANCH}"
git merge --ff-only "origin/${DEPLOY_BRANCH}"

cd server
npm ci --omit=dev --no-audit --no-fund

systemctl restart "${SERVER_SERVICE}"
systemctl is-active --quiet "${SERVER_SERVICE}" || {
  systemctl status "${SERVER_SERVICE}" --no-pager >&2 || true
  exit 1
}

PORT="$(node -e "const c=require(process.argv[1]); process.stdout.write(String(c.port || 3002))" "${REMOTE_CONFIG_PATH}")"
BIND_HOST="$(node -e "const c=require(process.argv[1]); process.stdout.write(String(c.bindHost || '127.0.0.1'))" "${REMOTE_CONFIG_PATH}")"
USE_TLS="$(node -e "const c=require(process.argv[1]); process.stdout.write(c.useTLS === true ? '1' : '0')" "${REMOTE_CONFIG_PATH}")"
HEALTH_HOST="${BIND_HOST}"
[[ "${HEALTH_HOST}" == "0.0.0.0" ]] && HEALTH_HOST="127.0.0.1"
[[ "${HEALTH_HOST}" == "::" ]] && HEALTH_HOST="[::1]"
HEALTH_SCHEME="http"
CURL_HEALTH=(curl --fail --silent --connect-timeout 2 --max-time 3)
if [[ "${USE_TLS}" == "1" ]]; then
  HEALTH_SCHEME="https"
  # 仅对本机回环健康检查跳过域名匹配；公网证书由独立监控严格校验。
  CURL_HEALTH+=(--insecure)
fi
HEALTH_URL="${HEALTH_SCHEME}://${HEALTH_HOST}:${PORT}/health"
HEALTH_OK=0
for attempt in {1..15}; do
  if HEALTH_RESPONSE="$("${CURL_HEALTH[@]}" "${HEALTH_URL}" 2>/dev/null)"; then
    printf '%s\n' "${HEALTH_RESPONSE}"
    HEALTH_OK=1
    break
  fi
  sleep 1
done
[[ "${HEALTH_OK}" == "1" ]] || {
  echo "ERROR: health check failed after 15 seconds: ${HEALTH_URL}" >&2
  "${CURL_HEALTH[@]}" --show-error "${HEALTH_URL}" >&2 || true
  exit 1
}
REMOTE_SCRIPT

echo "Server update completed"
