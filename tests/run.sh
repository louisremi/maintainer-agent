#!/usr/bin/env bash
# Run every check that needs no Docker daemon: linters + unit tests +
# dispatcher simulation. Missing optional linters are reported, not fatal.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
failures=0
check() { local d="$1"; shift; if "$@"; then printf 'ok   %s\n' "$d"; else printf 'FAIL %s\n' "$d" >&2; failures=$((failures + 1)); fi; }
have() { command -v "$1" >/dev/null 2>&1; }

shell_files=(runner/*.sh runner/agent-pr runner/ci-wait dispatcher/dispatch.sh tests/*.sh)
if have shellcheck; then check shellcheck shellcheck -x "${shell_files[@]}"; else echo "skip shellcheck"; fi
if have hadolint; then check hadolint hadolint runner/Dockerfile; else echo "skip hadolint"; fi
if have actionlint; then check actionlint actionlint; else echo "skip actionlint"; fi
check "python compiles" python3 -m py_compile runner/sanitize.py runner/policy.py
check "sanitize.py tests" python3 tests/test_sanitize.py
check "policy.py tests" python3 tests/test_policy.py
check "dispatcher simulation" tests/dispatch-sim.sh
check "templates are valid policy" bash -c 'python3 runner/policy.py < templates/maintainer-agent.yml >/dev/null'
check "no project-specific leftovers" bash -c '! git grep -n -I -E "deepseek-harness|nasbrico|100\.67\.|Qwen|static-check\.sh|hub\.docker\.com" -- ":!README.md" ":!PLAN.md" ":!tests/run.sh" ":!dispatcher/repos.example.json"'

echo
if (( failures )); then echo "tests: ${failures} failure(s)" >&2; exit 1; fi
echo "tests: all passed"
