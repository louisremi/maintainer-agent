#!/usr/bin/env bash
# Host-side dispatcher for the repository's issue agent. Runs on nasbrico from
# cron (Unraid User Scripts, "*/15 * * * *") and starts at most ONE model job
# per tick, because the model serves a single concurrent request:
#
#   0. REVIEW SWEEP  every tick: any open renovate/* or agent/* PR that carries
#                    a commit not authored by Renovate gets `agent-review` and
#                    loses auto-merge (a human merges agent-written code).
#   1. FIX           oldest open issue labelled `agent-fix`  -> `fix <n>`
#   2. TRIAGE        oldest eligible issue without a first answer:
#                      a. `triage-fetch <n>`  read-only token, no model
#                      b. `triage-agent <n>`  model, no token, egress = model only
#                      c. `sanitize`          no network; exit 3 = hold for a human
#                      d. post with the host token
#
#   dispatch.sh [--dry-run] [--fix N | --triage N]
#
# Network: every model container runs on a fresh `--internal` Docker network
# whose only way out is an allow-list proxy (tinyproxy, `egress` role of the
# runner image). Triage allows the model endpoint only; fix mode also allows
# GitHub and the package registries its checks need (EGRESS_FIX_ALLOW).
#
# Triage trust gate (the repository is public and issue text reaches the model):
#   - issues by OWNER / MEMBER / COLLABORATOR are answered automatically;
#   - anyone else's issue only after a maintainer adds the `triage` label;
#   - `retriage` forces a fresh answer (the label is removed afterwards);
#   - `no-triage` opts an issue out; bot and CI-generated issues are skipped.
#
# Configuration ($DISPATCH_ENV, default
# /boot/config/plugins/user.scripts/scripts/dsh-dev-agent/env, mode 600):
#   GH_TOKEN=github_pat_...          fix + host token: contents, issues, pull
#                                    requests read/write; actions read; NO workflows,
#                                    administration, environments or deployments
#   GH_TOKEN_READONLY=github_pat_... triage fetch token: contents, issues, pull
#                                    requests, actions READ only (triage is off without it)
#   REPO=louisremi/deepseek-harness-docker-dev
#   RUNNER_IMAGE=louisremi/deepseek-harness-dev-agent:latest
#   RUNS_DIR=/mnt/user/appdata/dsh-dev-agent/runs
#   LLM_API_BASE=http://100.67.12.33:18982/v1
#   LLM_MODEL=openai/Qwen3.8
#   MAX_ATTEMPTS=2          fix runs per round before `needs-human`
#   TRIAGE_ENABLED=true
#   TRIAGE_MAX_AGE_DAYS=14  maintainer issues older than this are not auto-answered
#   TRIAGE_MAX_ATTEMPTS=2   failed drafting attempts per issue before giving up
#   EGRESS_FIX_ALLOW="..."  override the fix-mode host allow-list (see below)
#   RENOVATE_AUTHOR_EMAIL=29139614+renovate[bot]@users.noreply.github.com
#
# Needs on the host: docker, curl, jq (1.6+), flock, timeout.
set -Eeuo pipefail

dry_run=0
only_fix=""
only_triage=""
while (( $# )); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --fix) only_fix="$2"; shift ;;
    --triage) only_triage="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

env_file="${DISPATCH_ENV:-/boot/config/plugins/user.scripts/scripts/dsh-dev-agent/env}"
if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${env_file}"
  set +a
fi
: "${GH_TOKEN:?GH_TOKEN not set (see ${env_file})}"
REPO="${REPO:-louisremi/deepseek-harness-docker-dev}"
RUNNER_IMAGE="${RUNNER_IMAGE:-louisremi/deepseek-harness-dev-agent:latest}"
RUNS_DIR="${RUNS_DIR:-/mnt/user/appdata/dsh-dev-agent/runs}"
LLM_API_BASE="${LLM_API_BASE:-http://100.67.12.33:18982/v1}"
LLM_MODEL="${LLM_MODEL:-openai/Qwen3.8}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-2}"
TRIAGE_ENABLED="${TRIAGE_ENABLED:-true}"
TRIAGE_MAX_AGE_DAYS="${TRIAGE_MAX_AGE_DAYS:-14}"
TRIAGE_MAX_ATTEMPTS="${TRIAGE_MAX_ATTEMPTS:-2}"
RENOVATE_AUTHOR_EMAIL="${RENOVATE_AUTHOR_EMAIL:-29139614+renovate[bot]@users.noreply.github.com}"
LOCK="${LOCK:-/tmp/dsh-dev-agent.lock}"
STATE_DIR="${RUNS_DIR}/state"

# Host of the model endpoint (the only destination triage may reach).
llm_host="${LLM_API_BASE#*://}"; llm_host="${llm_host%%/*}"; llm_host="${llm_host%%:*}"
# Fix mode: git/gh, the registries `scripts/static-check.sh --online` resolves
# against, and the release-binary hosts `scripts/refresh-checksums.py` hashes.
EGRESS_FIX_ALLOW="${EGRESS_FIX_ALLOW:-github.com api.github.com codeload.github.com
  objects.githubusercontent.com release-assets.githubusercontent.com raw.githubusercontent.com
  productionresultssa*.blob.core.windows.net results-receiver.actions.githubusercontent.com
  registry.npmjs.org pypi.org files.pythonhosted.org
  hub.docker.com registry-1.docker.io auth.docker.io
  cursor.com downloads.cursor.com}"

log() { printf '%s dispatch: %s\n' "$(date -u +%FT%TZ)" "$*"; }

exec 9>"${LOCK}"
if ! flock -n 9; then
  log "another run holds ${LOCK}; exiting"
  exit 0
fi

api() {  # api METHOD PATH [JSON]   PATH is relative to /repos/<REPO>
  local method="$1" path="$2" data="${3:-}"
  local args=(--silent --show-error --fail-with-body --retry 3 -X "${method}"
    -H "Authorization: Bearer ${GH_TOKEN}"
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28")
  [[ -n "${data}" ]] && args+=(-H "Content-Type: application/json" --data "${data}")
  curl "${args[@]}" "https://api.github.com/repos/${REPO}${path}"
}
graphql() {  # graphql QUERY [VARIABLES_JSON]
  curl --silent --show-error --fail-with-body --retry 3 -X POST \
    -H "Authorization: Bearer ${GH_TOKEN}" -H "Content-Type: application/json" \
    --data "$(jq -n --arg q "$1" --argjson v "${2:-{\}}" '{query: $q, variables: $v}')" \
    https://api.github.com/graphql
}
comment() { api POST "/issues/$1/comments" "$(jq -n --arg b "$2" '{body: $b}')" >/dev/null; }
add_label() { api POST "/issues/$1/labels" "$(jq -n --arg l "$2" '{labels: [$l]}')" >/dev/null; }
remove_label() { api DELETE "/issues/$1/labels/$2" >/dev/null 2>&1 || true; }
comments_of() { api GET "/issues/$1/comments?per_page=100"; }

# --- sandbox plumbing ---------------------------------------------------------
cleanup_cmds=()
cleanup() {
  local c
  for c in "${cleanup_cmds[@]}"; do eval "${c}" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

hardening=(--init --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 2048)

# start_egress <run-id> <log-file> <allowed hosts...>  -> sets $net. Not called
# in $(...): it registers cleanup commands, which a subshell would lose.
# The network is --internal (no route out, no LAN, no tailnet); the proxy is
# the only container on it that also sits on the default bridge.
start_egress() {
  local id="$1" logf="$2"; shift 2
  local proxy="dsh-agent-egress-${id}"
  net="dsh-agent-${id}"
  docker network create --internal "${net}" >/dev/null
  cleanup_cmds+=("docker network rm ${net}")
  docker run -d --rm --name "${proxy}" "${hardening[@]}" --read-only --tmpfs /tmp \
    --memory 256m --env EGRESS_ALLOW="$*" \
    "${RUNNER_IMAGE}" egress >/dev/null
  # On exit: keep the proxy log (allowed and refused hosts) in the run dir.
  cleanup_cmds=("docker logs ${proxy} > '${logf}' 2>&1" "docker rm -f ${proxy}" "${cleanup_cmds[@]}")
  docker network connect --alias egress "${net}" "${proxy}"
  local i
  for i in $(seq 1 20); do
    docker exec "${proxy}" bash -c '</dev/tcp/127.0.0.1/8888' >/dev/null 2>&1 && break
    (( i < 20 )) || { log "egress proxy did not start"; return 1; }
    sleep 0.5
  done
}

# Every branch and tag with its commit, one "ref sha" per line (sorted).
ref_snapshot() {
  { api GET "/git/matching-refs/heads/?per_page=100"; api GET "/git/matching-refs/tags/?per_page=100"; } \
    | jq -r '.[] | "\(.ref) \(.object.sha)"' | sort
}
# --dns 127.0.0.1: Docker's embedded resolver still answers container names
# (the `egress` alias) but forwards nothing upstream, so DNS queries cannot be
# used as an exfiltration channel. Clients reach the Internet via the proxy,
# which resolves names itself.
# shellcheck disable=SC2054  # the commas are inside NO_PROXY values
proxy_env=(--dns 127.0.0.1
           --env HTTP_PROXY=http://egress:8888 --env HTTPS_PROXY=http://egress:8888
           --env http_proxy=http://egress:8888 --env https_proxy=http://egress:8888
           --env NO_PROXY=localhost,127.0.0.1 --env no_proxy=localhost,127.0.0.1)

pull_runner() {
  docker pull --quiet "${RUNNER_IMAGE}" >/dev/null || log "pull failed; using the cached ${RUNNER_IMAGE}"
}
new_run_dir() {  # new_run_dir <kind> <issue>  -> prints a fresh, world-writable dir
  local d
  d="${RUNS_DIR}/$1-$2-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "${d}"
  chmod 0777 "${d}"
  printf '%s\n' "${d}"
}
run_id() { printf '%s-%s-%s' "$1" "$2" "$(date -u +%H%M%S)"; }

# sanitize_file <in> <out>  -> 0 ok, 3 hold, other = error. No network.
sanitize_file() {
  docker run --rm -i --network none "${hardening[@]}" --read-only --memory 256m \
    --env REPO="${REPO}" "${RUNNER_IMAGE}" sanitize < "$1" > "$2" 2> "$2.reasons"
}

# ============================ 0. REVIEW SWEEP =================================
# Agent-written code never auto-merges. Enforced here (host token, outside any
# agent container) and, independently, by the `review-gate` required check.
review_sweep() {
  local prs n head
  prs="$(api GET "/pulls?state=open&per_page=100" \
    | jq -r '.[] | select(.head.ref | test("^(renovate|agent)/")) | "\(.number)\t\(.head.ref)\t\(.node_id)\t\(.auto_merge != null)\t\([.labels[].name] | index("agent-review") != null)"')"
  while IFS=$'\t' read -r n head node automerge labelled; do
    [[ -n "${n}" ]] || continue
    local foreign=0
    if [[ "${head}" == agent/* ]]; then
      foreign=1
    elif [[ "$(api GET "/pulls/${n}/commits?per_page=100" \
               | jq --arg r "${RENOVATE_AUTHOR_EMAIL}" '[.[] | select(.commit.author.email != $r)] | length')" != 0 ]]; then
      foreign=1
    fi
    (( foreign )) || continue
    if (( dry_run )); then
      [[ "${labelled}" == true && "${automerge}" == false ]] || log "dry run: would gate PR #${n} (${head}) for human review"
      continue
    fi
    if [[ "${automerge}" == true ]]; then
      graphql 'mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }' \
        "$(jq -n --arg id "${node}" '{id: $id}')" >/dev/null || log "could not disable auto-merge on #${n}"
      log "disabled auto-merge on PR #${n} (${head}): contains non-Renovate commits"
    fi
    if [[ "${labelled}" != true ]]; then
      add_label "${n}" agent-review
      comment "${n}" "<!-- agent-run: review-gate -->
This pull request contains commits written by the repair agent (or another non-Renovate author), so it will **not** be auto-merged. A maintainer must review the diff and approve the \`agent-review\` environment on the \`review-gate\` check (or merge by hand)."
      log "labelled PR #${n} (${head}) agent-review"
    fi
  done <<<"${prs}"
}
review_sweep || log "review sweep failed (will retry next tick)"

# --- model reachable? (the GPU may be busy with another model) ---------------
health="${LLM_API_BASE%/v1}/health"
if ! curl --silent --fail --max-time 10 "${health}" >/dev/null; then
  log "model endpoint ${health} not healthy; will retry next tick"
  exit 0
fi

open_issues="$(api GET "/issues?state=open&sort=created&direction=asc&per_page=100" \
  | jq 'map(select(.pull_request == null))')"

# ================================ 1. FIX queue ================================
fix_candidates=""
if [[ -z "${only_triage}" ]]; then
  fix_candidates="$(jq -r --arg only "${only_fix}" '
    map(([.labels[].name]) as $l
        | select(($l | index("agent-fix")) and ($l | index("agent-in-progress") | not)
                 and ($l | index("needs-human") | not))
        | select($only == "" or (.number | tostring) == $only))
    | .[].number' <<<"${open_issues}")"
fi

for issue in ${fix_candidates}; do
  # Attempts = fix runs since the last hand-off to a human, so removing the
  # `needs-human` label grants a fresh round of MAX_ATTEMPTS.
  attempts="$(comments_of "${issue}" | jq '
    ([to_entries[] | select((.value.body // "") | contains("<!-- agent-run: gave-up -->")) | .key] | max // -1) as $cut
    | [to_entries[] | select(.key > $cut and ((.value.body // "") | contains("<!-- agent-run: fix -->")))]
    | length')"
  log "fix candidate #${issue} (attempts this round: ${attempts})"
  if (( attempts >= MAX_ATTEMPTS )); then
    log "#${issue} reached ${MAX_ATTEMPTS} attempts; handing over to a human"
    if (( ! dry_run )); then
      add_label "${issue}" needs-human
      comment "${issue}" "<!-- agent-run: gave-up -->
The repair agent made ${MAX_ATTEMPTS} attempts without finishing this. Labelled \`needs-human\`; remove that label to allow another round."
    fi
    continue
  fi
  if (( dry_run )); then log "dry run: would run fix on #${issue}"; exit 0; fi

  add_label "${issue}" agent-in-progress
  cleanup_cmds+=("remove_label ${issue} agent-in-progress")
  pull_runner
  run_dir="$(new_run_dir fix "${issue}")"
  # Branches the run may legitimately push to: its own agent/* branches and,
  # in ci-fix mode, the branch named in the CI marker.
  marker_branch="$(jq -r --argjson n "${issue}" '.[] | select(.number == $n) | .body // ""' <<<"${open_issues}" \
    | grep -o '<!-- agent: [^>]*-->' | head -n1 | sed -n 's/.* branch=\([^ ]*\) .*/\1/p' || true)"
  ref_snapshot > "${run_dir}/refs.before"
  id="$(run_id fix "${issue}")"
  # shellcheck disable=SC2086  # the allow-list is a word list on purpose
  start_egress "${id}" "${run_dir}/egress.log" "${llm_host}" ${EGRESS_FIX_ALLOW}
  set +e
  GH_TOKEN="${GH_TOKEN}" timeout --kill-after=60 5h docker run --rm \
    --name "dsh-agent-${id}" "${hardening[@]}" --memory 8g \
    --network "${net}" "${proxy_env[@]}" \
    --env GH_TOKEN --env REPO="${REPO}" \
    --env LLM_API_BASE="${LLM_API_BASE}" --env LLM_MODEL="${LLM_MODEL}" \
    --volume "${run_dir}:/runs" \
    "${RUNNER_IMAGE}" fix "${issue}"
  rc=$?
  set -e
  log "fix runner for #${issue} exited with ${rc}; logs in ${run_dir}"

  # Ref audit: the agent holds a write token (until fix mode moves pushing to
  # the host), so any ref it was not supposed to touch that changed during
  # the run is gated for review and reported. Renovate pushing concurrently
  # can cause a false positive; that only costs a manual review.
  ref_snapshot > "${run_dir}/refs.after"
  unexpected="$(comm -13 "${run_dir}/refs.before" "${run_dir}/refs.after" | cut -d' ' -f1 \
    | grep -Ev "^refs/heads/agent/(issue|main-fix)-${issue}$" \
    | { if [[ -n "${marker_branch}" && "${marker_branch}" != main ]]; then grep -vx "refs/heads/${marker_branch}"; else cat; fi; } || true)"
  deleted="$(comm -23 <(cut -d' ' -f1 "${run_dir}/refs.before") <(cut -d' ' -f1 "${run_dir}/refs.after") || true)"
  if [[ -n "${unexpected}${deleted}" ]]; then
    log "UNEXPECTED ref changes during fix run on #${issue}: ${unexpected//$'\n'/ } ${deleted:+deleted: ${deleted//$'\n'/ }}"
    for ref in ${unexpected}; do
      head="${ref#refs/heads/}"
      [[ "${ref}" == refs/heads/* ]] || continue
      for n in $(api GET "/pulls?state=open&head=${REPO%%/*}:${head}" | jq -r '.[].number'); do
        node="$(api GET "/pulls/${n}" | jq -r .node_id)"
        graphql 'mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }' \
          "$(jq -n --arg id "${node}" '{id: $id}')" >/dev/null 2>&1 || true
        add_label "${n}" agent-review
      done
    done
    add_label "${issue}" needs-human
    comment "${issue}" "<!-- agent-run: ref-audit -->
**Ref audit:** during this fix run, refs outside the run's own branches changed. Auto-merge was disabled on any matching pull request and they were labelled \`agent-review\`. Please check them before merging:
\`\`\`text
${unexpected:-}${deleted:+
deleted:
${deleted}}
\`\`\`
(Renovate pushing at the same time can also cause this.)"
  fi
  review_sweep || log "post-run review sweep failed"
  exit 0
done

# =============================== 2. TRIAGE queue ==============================
if [[ "${TRIAGE_ENABLED}" != true && -z "${only_triage}" ]]; then
  log "no fix work; triage disabled"
  exit 0
fi
if [[ -z "${GH_TOKEN_READONLY:-}" ]]; then
  log "no fix work; triage skipped: GH_TOKEN_READONLY not set (triage never runs with the write token)"
  exit 0
fi
mkdir -p "${STATE_DIR}"

since="$(date -u -d "-${TRIAGE_MAX_AGE_DAYS} days" +%FT%TZ)"
triage_candidates="$(jq -r --arg since "${since}" --arg only "${only_triage}" '
  map(([.labels[].name]) as $l
      | select($only == "" or (.number | tostring) == $only)
      | select(.user.type != "Bot")
      | select((.body // "") | contains("<!-- agent: ") | not)
      | select([$l[] | select(IN("agent-fix", "agent-in-progress", "needs-human", "no-triage", "triage-held"))] | length == 0)
      | select(($l | index("triage")) or ($l | index("retriage"))
               or ((.author_association | IN("OWNER", "MEMBER", "COLLABORATOR")) and .created_at >= $since))
      | "\(.number)\t\(if ($l | index("retriage")) then "retriage" else "new" end)\t\(.author_association)")
  | .[]' <<<"${open_issues}")"

while IFS=$'\t' read -r issue kind assoc; do
  [[ -n "${issue}" ]] || continue
  if [[ "${kind}" == new ]]; then
    answered="$(comments_of "${issue}" | jq 'map((.body // "") | contains("<!-- agent-triage")) | any')"
    [[ "${answered}" == false ]] || continue
  fi
  state_file="${STATE_DIR}/triage-${issue}.failures"
  failures="$(cat "${state_file}" 2>/dev/null || echo 0)"
  if [[ "${kind}" == new ]] && (( failures >= TRIAGE_MAX_ATTEMPTS )); then
    continue
  fi
  log "triage candidate #${issue} (${kind}, author ${assoc}, previous failures ${failures})"
  if (( dry_run )); then log "dry run: would triage #${issue}"; exit 0; fi

  fail() {
    echo $(( failures + 1 )) > "${state_file}"
    log "triage of #${issue}: $1; failure $(( failures + 1 ))/${TRIAGE_MAX_ATTEMPTS}; logs in ${run_dir}"
    exit 0
  }
  pull_runner
  run_dir="$(new_run_dir triage "${issue}")"
  mkdir -p "${run_dir}/out"; chmod 0777 "${run_dir}/out"
  id="$(run_id triage "${issue}")"

  # a. fetch: deterministic, read-only token, no model, default network.
  set +e
  GH_TOKEN="${GH_TOKEN_READONLY}" timeout --kill-after=30 10m docker run --rm \
    --name "dsh-agent-${id}-fetch" "${hardening[@]}" --memory 2g \
    --env GH_TOKEN --env REPO="${REPO}" \
    --volume "${run_dir}:/runs" \
    "${RUNNER_IMAGE}" triage-fetch "${issue}"
  rc=$?
  set -e
  (( rc == 0 )) || fail "context fetch failed (rc=${rc})"

  # b. agent: model only, no token, read-only root, read-only context.
  start_egress "${id}" "${run_dir}/egress.log" "${llm_host}" || fail "egress proxy failed to start"
  set +e
  timeout --kill-after=60 1h docker run --rm \
    --name "dsh-agent-${id}" "${hardening[@]}" --memory 4g \
    --read-only --tmpfs /tmp:rw,exec,mode=1777,size=512m \
    --tmpfs /home/agent:rw,uid=10001,gid=10001,mode=0700,size=64m \
    --network "${net}" "${proxy_env[@]}" \
    --env REPO="${REPO}" --env LLM_API_BASE="${LLM_API_BASE}" --env LLM_MODEL="${LLM_MODEL}" \
    --volume "${run_dir}/ctx:/work/context:ro" \
    --volume "${run_dir}/ctx/repo:/work/repo:ro" \
    --volume "${run_dir}/out:/runs" \
    "${RUNNER_IMAGE}" triage-agent "${issue}"
  rc=$?
  set -e
  draft="${run_dir}/out/triage-${issue}.answer.md"
  (( rc == 0 )) && [[ -s "${draft}" ]] || fail "no answer produced (rc=${rc})"

  # c. sanitise (no network); exit 3 = suspicious, hold for a human.
  safe="${run_dir}/answer.safe.md"
  set +e; sanitize_file "${draft}" "${safe}"; src=$?; set -e
  if (( src == 3 )); then
    add_label "${issue}" triage-held
    rm -f "${state_file}"
    log "triage answer for #${issue} HELD for review ($(tr '\n' ';' < "${safe}.reasons")); draft in ${run_dir}"
    exit 0
  fi
  (( src == 0 )) && [[ -s "${safe}" ]] || fail "sanitiser failed (rc=${src})"

  # d. post with the host token.
  comment "${issue}" "<!-- agent-triage v1 -->
$(cat "${safe}")

---
<sub>Automated first answer drafted by this repository's issue agent (mini-swe-agent, \`${LLM_MODEL#*/}\`) from a sandboxed, read-only investigation. It may be wrong; a maintainer will follow up. Maintainers: label \`agent-fix\` to have the agent implement a change, or \`retriage\` for a fresh answer.</sub>"
  [[ "${kind}" == retriage ]] && remove_label "${issue}" retriage
  rm -f "${state_file}"
  log "posted first answer on #${issue}; logs in ${run_dir}"
  exit 0
done <<<"${triage_candidates}"

log "nothing to do"
