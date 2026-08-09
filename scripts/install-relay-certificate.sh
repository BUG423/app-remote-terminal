#!/usr/bin/env bash
set -euo pipefail

# 将 Let's Encrypt 证书原子复制到低权限 Relay 可读、其他账户不可读的位置。
# 手工初始化：sudo scripts/install-relay-certificate.sh terminal.example.com
# Certbot deploy hook：直接执行本脚本；Certbot 会提供 RENEWED_LINEAGE。

[[ "${EUID}" == "0" ]] || {
  echo "ERROR: certificate installation must run as root" >&2
  exit 1
}

SERVICE_GROUP="remote-terminal-server"
TARGET_DIR="/etc/remote-terminal/tls"
SERVICE_UNIT="remote-terminal-server.service"

if [[ -n "${RENEWED_LINEAGE:-}" ]]; then
  SOURCE_DIR="${RENEWED_LINEAGE}"
else
  CERT_NAME="${1:-}"
  [[ "${CERT_NAME}" =~ ^[A-Za-z0-9.-]+$ ]] || {
    echo "ERROR: pass a valid Certbot certificate name" >&2
    exit 1
  }
  SOURCE_DIR="/etc/letsencrypt/live/${CERT_NAME}"
fi

[[ -r "${SOURCE_DIR}/fullchain.pem" && -r "${SOURCE_DIR}/privkey.pem" ]] || {
  echo "ERROR: certificate lineage is incomplete: ${SOURCE_DIR}" >&2
  exit 1
}
CERT_SOURCE="$(realpath -e "${SOURCE_DIR}/fullchain.pem")"
KEY_SOURCE="$(realpath -e "${SOURCE_DIR}/privkey.pem")"
[[ "${CERT_SOURCE}" == /etc/letsencrypt/archive/* && "${KEY_SOURCE}" == /etc/letsencrypt/archive/* ]] || {
  echo "ERROR: certificate source is outside /etc/letsencrypt/archive" >&2
  exit 1
}
getent group "${SERVICE_GROUP}" >/dev/null || {
  echo "ERROR: group ${SERVICE_GROUP} does not exist" >&2
  exit 1
}

install -d -o root -g "${SERVICE_GROUP}" -m 0750 "${TARGET_DIR}"
CERT_TMP="$(mktemp "${TARGET_DIR}/.fullchain.pem.XXXXXX")"
KEY_TMP="$(mktemp "${TARGET_DIR}/.privkey.pem.XXXXXX")"
cleanup() { rm -f "${CERT_TMP}" "${KEY_TMP}"; }
trap cleanup EXIT

install -o root -g "${SERVICE_GROUP}" -m 0640 "${CERT_SOURCE}" "${CERT_TMP}"
install -o root -g "${SERVICE_GROUP}" -m 0640 "${KEY_SOURCE}" "${KEY_TMP}"
mv -f "${CERT_TMP}" "${TARGET_DIR}/fullchain.pem"
mv -f "${KEY_TMP}" "${TARGET_DIR}/privkey.pem"
trap - EXIT

if systemctl cat "${SERVICE_UNIT}" >/dev/null 2>&1; then
  systemctl try-restart "${SERVICE_UNIT}"
fi

echo "Relay certificate installed in ${TARGET_DIR}"
