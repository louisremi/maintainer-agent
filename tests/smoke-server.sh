#!/usr/bin/env bash
# Smoke test of a built server image, without Docker access or a model:
# validate-config, start-up from a settings folder, health, /admin
# protection, safe mode on a broken file.
#   tests/smoke-server.sh <image>
set -euo pipefail
img="${1:?usage: smoke-server.sh <image>}"
here="$(cd "$(dirname "$0")" && pwd)"
cid=""
fail() { echo "smoke: $*" >&2; [[ -n "${cid}" ]] && docker logs "${cid}" >&2; exit 1; }
cfg="$(mktemp -d)"
trap '[[ -n "${cid}" ]] && docker rm -f "${cid}" >/dev/null 2>&1; rm -rf "${cfg}"' EXIT
sed 's/^  max_concurrent_jobs: 1 /  docker_pull: never
  max_concurrent_jobs: 1 /' "${here}/../docs/settings.example.yml" > "${cfg}/settings.yml"
printf 'MA_ADMIN_TOKEN: smoke-test-admin-token\n' > "${cfg}/secrets.yaml"
chmod -R a+rwX "${cfg}"

# validate-config: 0 for the example, 1 (with a line number) for a broken file.
docker run --rm -v "${cfg}:/config" "${img}" validate-config >/dev/null || fail "example settings must validate"
cp "${cfg}/settings.yml" "${cfg}/broken.yml"
printf 'repositories:\n  not-a-repo-key: {}\n' >> "${cfg}/broken.yml"
set +e; out="$(docker run --rm -v "${cfg}:/config" "${img}" validate-config /config/broken.yml 2>&1)"; rc=$?; set -e
[[ "${rc}" == 1 && "${out}" == *line* ]] || fail "broken settings must fail with a position (rc=${rc}): ${out}"
docker run --rm "${img}" schema | grep -q '"public_url"' || fail "schema command"

start() {
  cid="$(docker run -d --rm -p 127.0.0.1::3000 -e DATA_DIR=/tmp/ma -v "${cfg}:/config" "${img}")"
  port="$(docker port "${cid}" 3000/tcp | head -n1 | sed 's/.*://')"
  for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:${port}/healthz" >/dev/null && return; sleep 1; done
  fail "server did not start"
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

start
[[ "$(code "http://127.0.0.1:${port}/admin")" == 401 ]] || fail "/admin must need the token"
[[ "$(code -u op:smoke-test-admin-token "http://127.0.0.1:${port}/admin")" == 200 ]] || fail "/admin with the token"
[[ "$(code -u op:smoke-test-admin-token "http://127.0.0.1:${port}/admin/settings")" == 200 ]] || fail "settings editor"
[[ "$(code "http://127.0.0.1:${port}/settings/schema.json")" == 200 ]] || fail "schema endpoint"
[[ "$(code -X POST "http://127.0.0.1:${port}/webhooks/unknown")" == 404 ]] || fail "unknown webhook"
[[ "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' -u op:smoke-test-admin-token "http://127.0.0.1:${port}/admin/assets/maintainer-agent-logo.png")" == "200 image/png" ]] || fail "logo asset"
docker rm -f "${cid}" >/dev/null; cid=""

# Safe mode: a broken settings.yml still serves /admin, refuses webhooks with 503.
cp "${cfg}/broken.yml" "${cfg}/settings.yml"
start
[[ "$(code -u op:smoke-test-admin-token "http://127.0.0.1:${port}/admin")" == 200 ]] || fail "/admin in safe mode"
curl -s -u op:smoke-test-admin-token "http://127.0.0.1:${port}/admin" | grep -q "Safe mode" || fail "safe mode banner"
[[ "$(code -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:${port}/webhooks/any")" == 503 ]] || fail "webhooks in safe mode"
echo "server smoke test passed: ${img}"
