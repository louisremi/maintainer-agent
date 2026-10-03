#!/usr/bin/env bash
# Smoke test of a built runner image: tools present, roles work.
#   tests/smoke-image.sh <image>
set -euo pipefail
img="${1:?usage: smoke-image.sh <image>}"
run() { docker run --rm -i --network none "$@"; }
fail() { echo "smoke: $*" >&2; exit 1; }

# One check per line, so that a failure names itself.
run --entrypoint bash "${img}" -c '
  set -u; bad=0
  chk() { if eval "$1" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; bad=1; fi; }
  chk "mini --help"; chk "hadolint --version"; chk "shellcheck --version"; chk "command -v tinyproxy"
  chk "git --version"; chk "jq --version"; chk "node --version"; chk "curl --version"
  chk "! command -v gh"; chk "[ \"\$(id -u)\" = 10001 ]"
  for f in config/mswea-issue.yaml config/mswea-fix.yaml config/mswea-review.yaml \
           playbooks/issue.md playbooks/implement.md playbooks/review.md \
           run-agent.sh publish.sh sanitize.py policy.py; do chk "test -r /opt/agent/$f"; done
  exit "$bad"' || fail "tools or files missing"

# sanitize: text and JSON modes, repository URL on any forge.
[[ "$(printf 'hello #1\n' | run --env REPO=o/r "${img}" sanitize)" == "hello #1" ]] || fail "sanitize text mode"
set +e; printf '![x](https://e.example/x?d=ghp_abcdefghijklmnopqrstuvwxyz0123456789)\n' | run --env REPO=o/r "${img}" sanitize >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" == 3 ]] || fail "sanitize should hold (3), got ${rc}"
printf '{"texts": ["see https://git.example.org/g/p/-/blob/x", "@someone"]}' \
  | run --env SANITIZE_REPO_URL=https://git.example.org/g/p "${img}" sanitize --json \
  | jq -e '.results[0].text == "see https://git.example.org/g/p/-/blob/x\n" and (.results[1].text | contains("`@someone`"))' >/dev/null \
  || fail "sanitize --json"

# policy: defaults, v1 compatibility, invalid input.
run "${img}" policy < /dev/null | jq -e '.fix.trigger == "maintainers" and (.protected_paths | index(".maintainer-agent.yml"))' >/dev/null || fail "policy defaults"
printf 'version: 1\ntriage:\n  enabled: false\n' | run "${img}" policy | jq -e '.answer.enabled == false' >/dev/null || fail "policy v1"
set +e; printf 'bogus: 1\n' | run "${img}" policy >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" == 1 ]] || fail "invalid policy should fail (1), got ${rc}"

# agents: refuse to run without a task, and with a forge credential.
set +e; run --env LLM_API_BASE=http://x --env LLM_MODEL=m "${img}" issue-agent >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" == 2 ]] || fail "issue-agent without a task must fail (2), got ${rc}"
for cred in GH_TOKEN=x GITHUB_TOKEN=x GITLAB_TOKEN=x "GIT_AUTH_HEADER=Authorization: x"; do
  set +e; run --env "${cred}" --env LLM_API_BASE=http://x --env LLM_MODEL=m "${img}" fix-agent >/dev/null 2>&1; rc=$?; set -e
  [[ "${rc}" == 2 ]] || fail "fix-agent must refuse ${cred%%=*} (2), got ${rc}"
done

# publish: refuses a branch outside maintainer-agent/ before doing anything.
set +e; run --env GIT_REMOTE_URL=https://example.org/o/r.git --env "GIT_AUTH_HEADER=Authorization: x" \
  --env BASE_SHA="$(printf 'a%.0s' {1..40})" --env BRANCH=main --env "GIT_AUTHOR=a <a@b.c>" "${img}" publish >/dev/null 2>&1; rc=$?; set -e
[[ "${rc}" == 2 ]] || fail "publish must refuse branch main (2), got ${rc}"

# Egress proxy: allowed pattern accepted, others refused (no network needed: filter only).
cid="$(docker run -d --rm --env EGRESS_ALLOW="example.com *.example.org" "${img}" egress)"
trap 'docker rm -f "${cid}" >/dev/null 2>&1' EXIT
sleep 2
code="$(docker exec "${cid}" curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 http://blocked.invalid/ || true)"
[[ "${code}" == 403 ]] || { docker logs "${cid}"; fail "proxy should refuse blocked host with 403, got ${code}"; }
echo "image smoke test passed: ${img} ($(docker run --rm "${img}" version))"
