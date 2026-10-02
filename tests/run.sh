#!/usr/bin/env bash
# Run every check that needs no Docker daemon: linters, runner unit tests and
# the server's typecheck, architecture rules and tests. Missing optional
# linters are reported, not fatal.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
failures=0
# check <description> <command...>: output is shown only when the command fails.
check() {
  local d="$1" log; shift
  log="$("$@" 2>&1)" && { printf 'ok   %s\n' "$d"; return; }
  printf '%s\nFAIL %s\n' "${log}" "$d" >&2
  failures=$((failures + 1))
}
have() { command -v "$1" >/dev/null 2>&1; }

shell_files=(runner/*.sh tests/*.sh)
if have shellcheck; then check shellcheck shellcheck -x "${shell_files[@]}"; else echo "skip shellcheck"; fi
if have hadolint; then check hadolint hadolint runner/Dockerfile server/Dockerfile; else echo "skip hadolint"; fi
if have actionlint; then check actionlint actionlint; else echo "skip actionlint"; fi
check "python compiles" python3 -m py_compile runner/sanitize.py runner/policy.py
check "sanitize.py tests" python3 tests/test_sanitize.py
check "policy.py tests" python3 tests/test_policy.py
check "publish.sh tests" tests/test-publish.sh
check "run-agent.sh tests" tests/test-run-agent.sh
check "templates are valid policy" bash -c 'python3 runner/policy.py < templates/maintainer-agent.yml >/dev/null'
check "no project-specific leftovers" bash -c '! git grep -n -I -E "deepseek-harness|nasbrico|100\.67\.|100\.123\.|Qwen|qwen3|static-check\.sh|hub\.docker\.com" -- ":!README.md" ":!PLAN.md" ":!tests/run.sh" ":!server/pnpm-lock.yaml"'

if [[ -d server/node_modules ]] || { have pnpm && (cd server && pnpm install --frozen-lockfile >/dev/null); }; then
  check "server typecheck" bash -c 'cd server && pnpm -s typecheck'
  check "server architecture rules" bash -c 'cd server && pnpm -s arch >/dev/null'
  check "server architecture rules catch violations" tests/arch-violation.sh
  check "server tests" bash -c 'cd server && pnpm -s test >/dev/null'
else
  echo "skip server (run pnpm install in server/)"
fi

echo
if (( failures )); then echo "tests: ${failures} failure(s)" >&2; exit 1; fi
echo "tests: all passed"
