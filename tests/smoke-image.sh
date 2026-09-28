#!/usr/bin/env bash
# Smoke test of a built runner image: tools present, roles work.
#   tests/smoke-image.sh <image>
set -euo pipefail
img="${1:?usage: smoke-image.sh <image>}"
run() { docker run --rm -i --network none "$@"; }
run --entrypoint bash "${img}" -c 'mini --help >/dev/null && gh --version >/dev/null && hadolint --version >/dev/null \
  && shellcheck --version >/dev/null && tinyproxy -v && git --version && jq --version && node --version \
  && command -v agent-pr ci-wait && [ "$(id -u)" = 10001 ]'
[[ "$(printf 'hello #1\n' | run --env REPO=o/r "${img}" sanitize)" == "hello #1" ]]
set +e; printf '![x](https://e.example/x?d=ghp_abcdefghijklmnopqrstuvwxyz0123456789)\n' | run --env REPO=o/r "${img}" sanitize >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" == 3 ]] || { echo "sanitize should hold (3), got ${rc}"; exit 1; }
run "${img}" policy < /dev/null | jq -e '.version == 1 and (.protected_paths | index(".github/**"))' >/dev/null
set +e; printf 'bogus: 1\n' | run "${img}" policy >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" == 1 ]] || { echo "invalid policy should fail (1), got ${rc}"; exit 1; }
set +e; run "${img}" triage-agent 1 >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" != 0 ]] || { echo "triage-agent without context must fail"; exit 1; }
set +e; run --env REPO=o/r --env GH_TOKEN=x --env LLM_API_BASE=http://x --env LLM_MODEL=m "${img}" triage-agent 1 >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" == 2 ]] || { echo "triage-agent must refuse a token (2), got ${rc}"; exit 1; }
# Egress proxy: allowed pattern accepted, others refused (no network needed: filter only).
cid="$(docker run -d --rm --env EGRESS_ALLOW="example.com *.example.org" "${img}" egress)"
trap 'docker rm -f "${cid}" >/dev/null 2>&1' EXIT
sleep 2
code="$(docker exec "${cid}" curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 http://blocked.invalid/ || true)"
[[ "${code}" == 403 ]] || { echo "proxy should refuse blocked host with 403, got ${code}"; docker logs "${cid}"; exit 1; }
echo "image smoke test passed: ${img} ($(docker run --rm "${img}" version))"
