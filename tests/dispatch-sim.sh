#!/usr/bin/env bash
# Simulation of dispatcher/dispatch.sh with fake `docker` and `curl`: no
# network, no Docker. Asserts which containers would run with which
# arguments, what would be posted, and that sandboxes are cleaned up.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "${here}")"
work="$(mktemp -d)"; trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/bin" "${work}/runs"
export FAKELOG="${work}/calls.log" SAN="${root}/runner/sanitize.py" POL="${root}/runner/policy.py" STATE="${work}"

# ------------------------------------------------------------------ fake docker
cat > "${work}/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "DOCKER $*" >> "$FAKELOG"
role=""; vols=(); envs=()
for a in "$@"; do case "$a" in triage-fetch|triage-agent|sanitize|egress|fix|policy) role="$a";; esac; done
prev=""; for a in "$@"; do [[ "$prev" == --volume ]] && vols+=("$a"); [[ "$prev" == --env ]] && envs+=("$a"); prev="$a"; done
for e in "${envs[@]}"; do [[ "$e" == *=* ]] && export "${e?}"; done
case "$1:$role" in
  run:policy) exec python3 "$POL" ;;
  run:sanitize) exec python3 "$SAN" ;;
  run:triage-fetch) h="${vols[0]%%:*}"; mkdir -p "$h/ctx/repo/.git"; echo task > "$h/ctx/task.md" ;;
  run:triage-agent) for v in "${vols[@]}"; do [[ "$v" == *:/runs ]] && o="${v%%:*}"; done
                    cat "$STATE/draft" > "$o/triage-${!#}.answer.md" ;;
  run:fix) touch "$STATE/after" ;;
esac
exit 0
FAKE
# ------------------------------------------------------------------ fake curl
cat > "${work}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${*: -1}"; method=GET; auth=none; prev=""
for a in "$@"; do [[ "$prev" == -X ]] && method="$a"; [[ "$a" == "Authorization: Bearer "* ]] && auth="${a#Authorization: Bearer }"; prev="$a"; done
echo "CURL ${method} ${url} token=${auth}" >> "$FAKELOG"
repo="$(sed -n 's#https://api.github.com/repos/\([^/]*/[^/?]*\).*#\1#p' <<<"$url")"
case "$url" in
  */health) exit 0 ;;
  */contents/.github/maintainer-agent.yml)
    [[ "$repo" == acme/app ]] || exit 22
    printf '{"encoding":"base64","content":"%s"}' "$(base64 -w0 < "$STATE/policy-acme.yml")" ;;
  */pulls\?state=open\&head=*) echo '[{"number":11}]' ;;
  */pulls\?state=open*)
    [[ "$repo" == acme/app ]] && echo '[{"number":5,"head":{"ref":"renovate/foo","repo":{"full_name":"acme/app"}},"node_id":"N5","auto_merge":{},"labels":[]},
      {"number":6,"head":{"ref":"renovate/bar","repo":{"full_name":"acme/app"}},"node_id":"N6","auto_merge":{},"labels":[]},
      {"number":8,"head":{"ref":"feature","repo":{"full_name":"acme/app"}},"node_id":"N8","auto_merge":{},"labels":[]}]' || echo '[]' ;;
  */pulls/5/commits*) echo '[{"commit":{"author":{"email":"bot@renovate"}}},{"commit":{"author":{"email":"agent@x"}}}]' ;;
  */pulls/6/commits*) echo '[{"commit":{"author":{"email":"bot@renovate"}}}]' ;;
  */pulls/11) echo '{"node_id":"N11"}' ;;
  */git/matching-refs/heads/*)
    if [[ -f "$STATE/after" ]]; then echo '[{"ref":"refs/heads/main","object":{"sha":"bbb"}},{"ref":"refs/heads/maintainer-agent/issue-9","object":{"sha":"ddd"}}]'
    else echo '[{"ref":"refs/heads/main","object":{"sha":"aaa"}}]'; fi ;;
  */git/matching-refs/tags/*) echo '[]' ;;
  */compare/*) echo '{"files":[{"filename":"src/app.py"},{"filename":".github/workflows/ci.yml"}]}' ;;
  */issues\?state=open*) cat "$STATE/issues-${repo//\//_}.json" 2>/dev/null || echo '[]' ;;
  */issues/*/comments\?*) echo '[]' ;;
  */issues/9) echo '{"body":"do it"}' ;;
  https://api.github.com/repos/*/*) [[ "$method" == GET && "$url" =~ /repos/[^/]+/[^/]+$ ]] && echo '{"default_branch":"main"}' || echo '{}' ;;
  https://api.github.com/graphql) echo '{}' ;;
  *) echo '{}' ;;
esac
FAKE
chmod +x "${work}/bin/"*
export PATH="${work}/bin:${PATH}"

cat > "${work}/policy-acme.yml" <<'P'
bot_branches: [renovate/*]
bot_authors: [bot@renovate]
egress: [registry.npmjs.org]
links: [https://docs.acme.example/]
P
cat > "${work}/repos.json" <<'J'
{"defaults": {"runner_image": "img:test", "llm_api_base": "http://10.0.0.5:8000/v1", "llm_model": "openai/m"},
 "repos": [
  {"repo": "acme/app", "token_env": "TOK_ACME", "readonly_token_env": "TOK_ACME_RO", "modes": ["triage", "fix"]},
  {"repo": "other/lib", "readonly_token_env": "TOK_PUBLIC_RO", "modes": ["triage"], "post": false}]}
J
cat > "${work}/env" <<E
TOK_ACME=w-acme
TOK_ACME_RO=r-acme
TOK_PUBLIC_RO=r-public
RUNS_DIR=${work}/runs
LOCK=${work}/lock
E
issue() {  # issue <number> <created_at> <assoc> [labels...]
  local n="$1" c="$2" a="$3"; shift 3
  jq -cn --argjson n "$n" --arg c "$c" --arg a "$a" --args '{number:$n, created_at:$c, author_association:$a,
    user:{type:"User"}, body:"text", labels:($ARGS.positional | map({name: .}))}' "$@"
}
dispatch() { DISPATCH_ENV="${work}/env" DISPATCH_CONFIG="${work}/repos.json" bash "${root}/dispatcher/dispatch.sh" "$@"; }
fail() { echo "FAIL: $*" >&2; echo "--- calls:" >&2; cat "$FAKELOG" >&2; exit 1; }

# ---------------------------------------------------------------- 1. triage, oldest across repos, draft mode
: > "$FAKELOG"; rm -f "${work}/after"
jq -s . <(issue 7 2998-06-01T00:00:00Z OWNER) > "${work}/issues-acme_app.json"
jq -s . <(issue 3 2998-01-01T00:00:00Z OWNER) > "${work}/issues-other_lib.json"
printf '**Summary** fine, see #3 and [docs](https://docs.acme.example/x).\n' > "${work}/draft"
out="$(dispatch 2>&1)"
grep -q "other/lib: draft answer for #3 kept" <<<"$out" || fail "oldest issue (other/lib #3) should be drafted, not posted: $out"
grep -q "POST .*other/lib/issues/3/comments" "$FAKELOG" && fail "draft-only repo must not be commented on"
grep -q "triage-fetch 3" "$FAKELOG" || fail "fetch container not started"
grep -E "DOCKER run .*ma-other_lib-triage-3-[0-9]+-fetch .*--env GH_TOKEN " "$FAKELOG" >/dev/null || fail "fetch must get the token by name"
grep -E "DOCKER run .*triage-agent 3" "$FAKELOG" | grep -q -- "--env GH_TOKEN" && fail "triage agent must not get a token"
grep -E "DOCKER run .*triage-agent 3" "$FAKELOG" | grep -q -- "--read-only" || fail "triage agent must be read-only"
grep -E "DOCKER run -d .*EGRESS_ALLOW=10.0.0.5 .* egress" "$FAKELOG" >/dev/null || fail "triage egress must be the model host only"
grep -q "DOCKER network rm ma-other_lib-triage-3" "$FAKELOG" || fail "network not cleaned up"
grep -q "token=r-public" "$FAKELOG" || fail "public repo must be read with its read-only token"
grep -q "token=w-acme" "$FAKELOG" || fail "acme must be read with its write token"
grep -q "POST .*acme/app/issues/5/labels" "$FAKELOG" || fail "review sweep must gate PR #5 (agent commit on bot branch)"
grep -q "POST .*acme/app/issues/6/labels" "$FAKELOG" && fail "pure bot PR #6 must not be gated"
grep -q "POST .*acme/app/issues/8/labels" "$FAKELOG" && fail "non-bot, non-agent PR #8 is not the sweep's business"
echo "ok   triage: oldest across repos, draft-only never posts, sandbox args, review sweep"

# second tick: other/lib #3 already drafted -> acme #7 is posted, with policy links allowed
: > "$FAKELOG"
out="$(dispatch 2>&1)"
grep -q "acme/app: posted first answer on #7" <<<"$out" || fail "acme #7 should be posted: $out"
grep -q "POST https://api.github.com/repos/acme/app/issues/7/comments token=w-acme" "$FAKELOG" || fail "post must use the write token"
echo "ok   triage: drafted issues are not re-run; posting uses the host write token"

# held answer
: > "$FAKELOG"; rm -rf "${work}/runs/state"
printf 'x ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' > "${work}/draft"
echo '[]' > "${work}/issues-other_lib.json"
out="$(dispatch 2>&1)"
grep -q "HELD for review" <<<"$out" || fail "credential-shaped answer must be held: $out"
grep -q "POST .*acme/app/issues/7/comments" "$FAKELOG" && fail "held answer must not be posted"
grep -q "POST .*acme/app/issues/7/labels" "$FAKELOG" || fail "held answer must label triage-held"
echo "ok   triage: suspicious answer held and labelled"

# ---------------------------------------------------------------- 2. fix with audits
: > "$FAKELOG"; rm -f "${work}/after"
jq -s . <(issue 9 2998-01-01T00:00:00Z OWNER agent-fix) > "${work}/issues-acme_app.json"
out="$(dispatch 2>&1)"
grep -q "acme/app: fix candidate #9" <<<"$out" || fail "fix candidate expected: $out"
grep -E "DOCKER run -d .*EGRESS_ALLOW=10.0.0.5 github.com .*registry.npmjs.org img:test egress" "$FAKELOG" >/dev/null || fail "fix egress must include base hosts and policy egress"
grep -E "DOCKER run .* fix 9" "$FAKELOG" | grep -q -- "--network ma-acme_app-fix-9" || fail "fix must run on its internal network"
grep -q "refs/heads/main" <<<"$out" || fail "push to main must be reported by the ref audit: $out"
grep -q "protected=\[.github/workflows/ci.yml" <<<"$out" || fail "protected path change must be reported: $out"
grep -q "POST .*acme/app/issues/9/labels" "$FAKELOG" || fail "issue must get needs-human"
grep -q "DELETE .*acme/app/issues/9/labels/agent-in-progress" "$FAKELOG" || fail "agent-in-progress must be removed on exit"
grep -q "DOCKER network rm ma-acme_app-fix-9" "$FAKELOG" || fail "fix network not cleaned up"
echo "ok   fix: egress = base + policy, ref audit, protected-paths audit, cleanup"

# ---------------------------------------------------------------- 3. invalid policy skips the repo
: > "$FAKELOG"
printf 'egres: [typo.com]\n' > "${work}/policy-acme.yml"
out="$(dispatch --repo acme/app 2>&1)"
grep -q "invalid .github/maintainer-agent.yml, skipping" <<<"$out" || fail "invalid policy must skip the repo: $out"
grep -q "fix 9" "$FAKELOG" && fail "no job may run for a repo with an invalid policy"
echo "ok   invalid policy: repo skipped"

# ---------------------------------------------------------------- 4. flags
dispatch --fix 9 >/dev/null 2>&1 && fail "--fix without --repo must be refused"
echo "ok   flags"
echo "dispatcher simulation: all passed"
