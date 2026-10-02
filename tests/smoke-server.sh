#!/usr/bin/env bash
# Smoke test of a built server image: starts it without Docker access or a
# model, checks the health endpoint and that /admin needs the admin token.
#   tests/smoke-server.sh <image>
set -euo pipefail
img="${1:?usage: smoke-server.sh <image>}"
fail() { echo "smoke: $*" >&2; [[ -n "${cid:-}" ]] && docker logs "${cid}" >&2; exit 1; }
cid="$(docker run -d --rm -p 127.0.0.1::3000 \
  -e PUBLIC_URL=https://agent.example.org -e LLM_API_BASE=http://model.invalid/v1 -e LLM_MODEL=openai/test \
  -e ADMIN_TOKEN=smoke-test-admin-token -e DOCKER_PULL=never -e DATA_DIR=/tmp/ma \
  "${img}")"
trap 'docker rm -f "${cid}" >/dev/null 2>&1' EXIT
port="$(docker port "${cid}" 3000/tcp | head -n1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:${port}/healthz" >/dev/null && break
  sleep 1
done
[[ "$(curl -s "http://127.0.0.1:${port}/healthz")" == '{"ok":true}' ]] || fail "healthz"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/admin")" == 401 ]] || fail "/admin must need the token"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -u op:smoke-test-admin-token "http://127.0.0.1:${port}/admin")" == 200 ]] || fail "/admin with the token"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${port}/webhooks/unknown")" == 404 ]] || fail "unknown webhook"
echo "server smoke test passed: ${img}"
