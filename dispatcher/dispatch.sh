#!/usr/bin/env bash
# maintainer-agent host dispatcher. Runs from cron (e.g. every 15 minutes)
# and watches every repository listed in the host config. At most ONE model
# job runs per tick, across all repositories (the model may serve a single
# request at a time):
#
#   0. PER REPO      labels exist; REVIEW SWEEP: open PRs from a policy bot
#                    branch or maintainer-agent/* that carry a commit not
#                    authored by a policy bot get auto-merge disabled and
#                    `agent-review` (a human merges agent-written code).
#   1. FIX           oldest open `agent-fix` issue across repos -> `fix <n>`
#   2. TRIAGE        oldest eligible issue without a first answer:
#                      a. `triage-fetch <n>`  read-only token, no model
#                      b. `triage-agent <n>`  model, no token, egress = model only
#                      c. `sanitize`          no network; exit 3 = hold for a human
#                      d. post with the host token, or keep as a draft (post=false)
#
#   dispatch.sh [--dry-run] [--repo OWNER/NAME] [--fix N | --triage N]
#
# Configuration:
#   DISPATCH_CONFIG  repos.json (see repos.example.json); default: next to $DISPATCH_ENV
#   DISPATCH_ENV     env file with the tokens named in repos.json, and optionally
#                    RUNS_DIR, LOCK, EGRESS_BASE_ALLOW (mode 600)
#
# Every model container runs on a fresh `--internal` Docker network whose only
# way out is an allow-list proxy (tinyproxy, the `egress` role of the runner
# image). Triage may reach the model endpoint only; fix mode also GitHub and
# the repository policy's `egress` hosts.
#
# Trust gate for triage (issue text reaches the model):
#   - issues by OWNER / MEMBER / COLLABORATOR are answered automatically;
#   - anyone else's issue only after a maintainer adds the `triage` label;
#   - `retriage` forces a fresh answer (the label is removed afterwards);
#   - `no-triage` opts an issue out; bot and CI-generated issues are skipped.
#
# Needs on the host: bash, docker, curl, jq (1.6+), flock, timeout, comm, seq.
set -Eeuo pipefail

dry_run=0
only_repo=""
only_fix=""
only_triage=""
while (( $# )); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --repo) only_repo="$2"; shift ;;
    --fix) only_fix="$2"; shift ;;
    --triage) only_triage="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [[ -n "${only_fix}${only_triage}" && -z "${only_repo}" ]]; then
  echo "--fix / --triage need --repo OWNER/NAME" >&2; exit 2
fi

env_file="${DISPATCH_ENV:-/boot/config/plugins/user.scripts/scripts/maintainer-agent/env}"
if [[ -f "${env_file}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${env_file}"
  set +a
fi
config="${DISPATCH_CONFIG:-$(dirname "${env_file}")/repos.json}"
[[ -f "${config}" ]] || { echo "host config not found: ${config}" >&2; exit 2; }
jq -e '.repos | type == "array"' "${config}" >/dev/null || { echo "invalid host config: ${config}" >&2; exit 2; }
RUNS_DIR="${RUNS_DIR:-/mnt/user/appdata/maintainer-agent/runs}"
LOCK="${LOCK:-/tmp/maintainer-agent.lock}"
# Always reachable in fix mode (git, gh, API, release assets, Actions logs).
EGRESS_BASE_ALLOW="${EGRESS_BASE_ALLOW:-github.com api.github.com codeload.github.com
  objects.githubusercontent.com release-assets.githubusercontent.com raw.githubusercontent.com
  productionresultssa*.blob.core.windows.net results-receiver.actions.githubusercontent.com}"
LABELS=(
  "agent-fix|D93F0B|maintainer-agent: fix CI / implement this issue as a PR"
  "agent-in-progress|FBCA04|maintainer-agent is working on it"
  "needs-human|B60205|maintainer-agent gave up; remove to allow another round"
  "triage|5319E7|Let maintainer-agent post a first answer (outside contributors)"
  "retriage|5319E7|Ask maintainer-agent for a fresh first answer"
  "no-triage|C5DEF5|maintainer-agent never auto-answers this issue"
  "triage-held|B60205|maintainer-agent answer held by the sanitiser: review the draft"
  "agent-review|B60205|Contains agent-written code: a maintainer must review before merge"
)

log() { printf '%s dispatch: %s\n' "$(date -u +%FT%TZ)" "$*"; }

exec 9>"${LOCK}"
if ! flock -n 9; then
  log "another run holds ${LOCK}; exiting"
  exit 0
fi

# --- per-repo context (set by use_repo) -----------------------------------------
REPO="" TOKEN="" RO_TOKEN="" MODES="" POST=true RUNNER_IMAGE="" LLM_API_BASE="" LLM_MODEL=""
GIT_AUTHOR="" MAX_STEP="" MAX_ATT="" POLICY="{}" SLUG=""
repo_cfg() { jq -c --arg r "$1" '.defaults as $d | .repos[] | select(.repo == $r) | ($d + .)' "${config}"; }
use_repo() {  # use_repo OWNER/NAME -> loads host config for that repo
  local c; c="$(repo_cfg "$1")"
  [[ -n "${c}" ]] || { log "repo $1 is not in ${config}"; return 1; }
  REPO="$1"
  [[ "${REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { log "invalid repo name ${REPO}"; return 1; }
  SLUG="$(tr '/A-Z' '_a-z' <<<"${REPO}" | tr -c 'a-z0-9_.\n-' '-')"
  local tv rv
  tv="$(jq -r '.token_env // ""' <<<"${c}")"; rv="$(jq -r '.readonly_token_env // ""' <<<"${c}")"
  TOKEN="${tv:+${!tv:-}}"; RO_TOKEN="${rv:+${!rv:-}}"
  MODES="$(jq -r '(.modes // ["triage"]) | join(" ")' <<<"${c}")"
  POST="$(jq -r 'if .post == false then "false" else "true" end' <<<"${c}")"
  RUNNER_IMAGE="$(jq -r '.runner_image // "louisremi/maintainer-agent:latest"' <<<"${c}")"
  LLM_API_BASE="$(jq -r '.llm_api_base // ""' <<<"${c}")"
  LLM_MODEL="$(jq -r '.llm_model // ""' <<<"${c}")"
  GIT_AUTHOR="$(jq -r '.git_author // "maintainer-agent <maintainer-agent@users.noreply.github.com>"' <<<"${c}")"
  MAX_STEP="$(jq -r '.max_step_limit // 120' <<<"${c}")"
  MAX_ATT="$(jq -r '.max_attempts_cap // 5' <<<"${c}")"
  POLICY="$(cat "${POLICY_CACHE}/${SLUG}.json" 2>/dev/null || echo '{}')"
}
has_mode() { [[ " ${MODES} " == *" $1 "* ]]; }
# The token used for reading repo state on the host: write token if any, else read-only.
host_token() { printf '%s' "${TOKEN:-${RO_TOKEN}}"; }

api() {  # api METHOD PATH [JSON]   PATH is relative to /repos/<REPO>
  local method="$1" path="$2" data="${3:-}" tok
  tok="$(host_token)"
  local args=(--silent --show-error --fail-with-body --retry 3 -X "${method}"
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
  [[ -n "${tok}" ]] && args+=(-H "Authorization: Bearer ${tok}")
  [[ -n "${data}" ]] && args+=(-H "Content-Type: application/json" --data "${data}")
  curl "${args[@]}" "https://api.github.com/repos/${REPO}${path}"
}
graphql() {  # graphql QUERY [VARIABLES_JSON]
  curl --silent --show-error --fail-with-body --retry 3 -X POST \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    --data "$(jq -n --arg q "$1" --argjson v "${2:-{\}}" '{query: $q, variables: $v}')" \
    https://api.github.com/graphql
}
can_write() { [[ -n "${TOKEN}" ]]; }
comment() { api POST "/issues/$1/comments" "$(jq -n --arg b "$2" '{body: $b}')" >/dev/null; }
add_label() { api POST "/issues/$1/labels" "$(jq -n --arg l "$2" '{labels: [$l]}')" >/dev/null; }
remove_label() { api DELETE "/issues/$1/labels/$2" >/dev/null 2>&1 || true; }
comments_of() { api GET "/issues/$1/comments?per_page=100"; }
pol() { jq -r "$1" <<<"${POLICY}"; }

# --- sandbox plumbing -------------------------------------------------------------
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
  local proxy="ma-egress-${id}"
  net="ma-${id}"
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
# --dns 127.0.0.1: Docker's embedded resolver still answers container names
# (the `egress` alias) but forwards nothing upstream, so DNS queries cannot be
# used as an exfiltration channel. Clients reach the Internet via the proxy,
# which resolves names itself.
# shellcheck disable=SC2054  # the commas are inside NO_PROXY values
proxy_env=(--dns 127.0.0.1
           --env HTTP_PROXY=http://egress:8888 --env HTTPS_PROXY=http://egress:8888
           --env http_proxy=http://egress:8888 --env https_proxy=http://egress:8888
           --env NO_PROXY=localhost,127.0.0.1 --env no_proxy=localhost,127.0.0.1)

llm_host() { local h="${LLM_API_BASE#*://}"; h="${h%%/*}"; printf '%s' "${h%%:*}"; }
pull_runner() {
  docker pull --quiet "${RUNNER_IMAGE}" >/dev/null || log "pull failed; using the cached ${RUNNER_IMAGE}"
}
new_run_dir() {  # new_run_dir <kind> <issue>  -> prints a fresh, world-writable dir
  local d
  d="${RUNS_DIR}/${SLUG}/$1-$2-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "${d}"
  chmod 0777 "${d}"
  printf '%s\n' "${d}"
}
run_id() { printf '%s-%s-%s-%s' "${SLUG:0:30}" "$1" "$2" "$(date -u +%H%M%S)"; }

# sanitize_file <in> <out>  -> 0 ok, 3 hold, other = error. No network.
sanitize_file() {
  docker run --rm -i --network none "${hardening[@]}" --read-only --memory 256m \
    --env REPO="${REPO}" --env SANITIZE_EXTRA_LINK_PREFIXES="$(pol '.links | join(" ")')" \
    "${RUNNER_IMAGE}" sanitize < "$1" > "$2" 2> "$2.reasons"
}

# load_policy: fetch .github/maintainer-agent.yml from the default branch and
# validate it in a network-less container. Missing -> defaults; invalid -> the
# repo is skipped this tick (and an issue-free log line explains why).
load_policy() {
  local raw out rc
  raw="$(api GET "/contents/.github/maintainer-agent.yml" 2>/dev/null \
         | jq -r 'select(.encoding == "base64") | .content' | base64 -d 2>/dev/null || true)"
  set +e
  out="$(printf '%s' "${raw}" | docker run --rm -i --network none "${hardening[@]}" --read-only --memory 128m \
           --env MAX_STEP_LIMIT="${MAX_STEP}" --env MAX_ATTEMPTS_CAP="${MAX_ATT}" \
           "${RUNNER_IMAGE}" policy 2>"${POLICY_CACHE}/${SLUG}.errors")"
  rc=$?
  set -e
  if (( rc != 0 )) || ! jq -e '.version == 1' <<<"${out}" >/dev/null 2>&1; then
    log "${REPO}: invalid .github/maintainer-agent.yml, skipping this repo: $(tr '\n' ';' < "${POLICY_CACHE}/${SLUG}.errors")"
    return 1
  fi
  POLICY="$(jq -c . <<<"${out}")"
  printf '%s\n' "${POLICY}" > "${POLICY_CACHE}/${SLUG}.json"
}

ensure_labels() {
  local l name color desc
  for l in "${LABELS[@]}"; do
    IFS='|' read -r name color desc <<<"${l}"
    api POST "/labels" "$(jq -n --arg n "${name}" --arg c "${color}" --arg d "${desc}" \
      '{name: $n, color: $c, description: $d}')" >/dev/null 2>&1 || true
  done
}

# ============================ 0. REVIEW SWEEP =================================
# Agent-written code never auto-merges. Enforced here (host token, outside any
# agent container) and, independently, by the repository's `review-gate`
# required check (reusable workflow review-gate.yml).
branch_matches() {  # branch_matches <branch> <newline-separated globs>
  local g
  while IFS= read -r g; do
    [[ -n "${g}" ]] || continue
    # shellcheck disable=SC2053  # glob match on purpose
    [[ "$1" == ${g} ]] && return 0
  done <<<"$2"
  return 1
}
review_sweep() {
  local prs n head node automerge labelled bots authors
  bots="$(pol '.bot_branches[]?')"
  authors="$(pol '.bot_authors')"
  prs="$(api GET "/pulls?state=open&per_page=100" \
    | jq -r --arg repo "${REPO}" '.[] | select(.head.repo.full_name == $repo)
        | "\(.number)\t\(.head.ref)\t\(.node_id)\t\(.auto_merge != null)\t\([.labels[].name] | index("agent-review") != null)"')"
  while IFS=$'\t' read -r n head node automerge labelled; do
    [[ -n "${n}" ]] || continue
    local foreign=0
    if [[ "${head}" == maintainer-agent/* ]]; then
      foreign=1
    elif branch_matches "${head}" "${bots}"; then
      [[ "$(api GET "/pulls/${n}/commits?per_page=100" \
            | jq --argjson a "${authors}" '[.[] | select(.commit.author.email as $e | $a | index($e) | not)] | length')" != 0 ]] \
        && foreign=1
    fi
    (( foreign )) || continue
    if (( dry_run )); then
      [[ "${labelled}" == true && "${automerge}" == false ]] || log "${REPO}: dry run: would gate PR #${n} (${head}) for human review"
      continue
    fi
    if [[ "${automerge}" == true ]]; then
      graphql 'mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }' \
        "$(jq -n --arg id "${node}" '{id: $id}')" >/dev/null || log "${REPO}: could not disable auto-merge on #${n}"
      log "${REPO}: disabled auto-merge on PR #${n} (${head}): contains agent or non-bot commits"
    fi
    if [[ "${labelled}" != true ]]; then
      add_label "${n}" agent-review
      comment "${n}" "<!-- maintainer-agent:run review-gate -->
This pull request contains commits written by maintainer-agent (or by someone other than the dependency bot), so it will **not** be auto-merged. A maintainer must review the diff and approve the \`agent-review\` environment on the \`review-gate\` check (or merge by hand)."
      log "${REPO}: labelled PR #${n} (${head}) agent-review"
    fi
  done <<<"${prs}"
}

# Every branch and tag with its commit, one "ref sha" per line (sorted).
ref_snapshot() {
  { api GET "/git/matching-refs/heads/?per_page=100"; api GET "/git/matching-refs/tags/?per_page=100"; } \
    | jq -r '.[] | "\(.ref) \(.object.sha)"' | sort
}

# ============================== per-repo pass ================================
mkdir -p "${RUNS_DIR}"
POLICY_CACHE="$(mktemp -d)"; cleanup_cmds+=("rm -rf ${POLICY_CACHE}")
repos=()
while IFS= read -r r; do
  [[ -n "${r}" ]] || continue
  [[ -z "${only_repo}" || "${r}" == "${only_repo}" ]] || continue
  repos+=("${r}")
done < <(jq -r '.repos[].repo' "${config}")
(( ${#repos[@]} )) || { log "no repository to watch${only_repo:+ (${only_repo} is not in ${config})}"; exit 0; }

fix_cands=""     # "<created_at>\t<repo>\t<issue>"
triage_cands=""  # "<created_at>\t<repo>\t<issue>\t<kind>\t<assoc>"
pulled=""
for r in "${repos[@]}"; do
  use_repo "${r}" || continue
  if [[ -z "$(host_token)" ]]; then log "${REPO}: no token configured; skipping"; continue; fi
  [[ "${pulled}" == *" ${RUNNER_IMAGE} "* ]] || { pull_runner; pulled+=" ${RUNNER_IMAGE} "; }
  load_policy || continue
  if can_write && (( ! dry_run )); then ensure_labels; fi
  if can_write; then review_sweep || log "${REPO}: review sweep failed (will retry next tick)"; fi

  open_issues="$(api GET "/issues?state=open&sort=created&direction=asc&per_page=100" \
    | jq 'map(select(.pull_request == null))')" || { log "${REPO}: could not list issues"; continue; }

  if has_mode fix && [[ "$(pol '.fix.enabled')" == true ]] && can_write && [[ -z "${only_triage}" ]]; then
    fix_cands+="$(jq -r --arg only "${only_fix}" --arg repo "${REPO}" '
      .[] | ([.labels[].name]) as $l
      | select(($l | index("agent-fix")) and ($l | index("agent-in-progress") | not)
               and ($l | index("needs-human") | not))
      | select($only == "" or (.number | tostring) == $only)
      | "\(.created_at)\t\($repo)\t\(.number)"' <<<"${open_issues}")"$'\n'
  fi
  if has_mode triage && [[ "$(pol '.triage.enabled')" == true ]] && [[ -n "${RO_TOKEN}" ]] && [[ -z "${only_fix}" ]]; then
    since="$(date -u -d "-$(pol '.triage.max_age_days') days" +%FT%TZ)"
    triage_cands+="$(jq -r --arg since "${since}" --arg only "${only_triage}" --arg repo "${REPO}" '
      .[] | ([.labels[].name]) as $l
      | select($only == "" or (.number | tostring) == $only)
      | select(.user.type != "Bot")
      | select((.body // "") | contains("<!-- maintainer-agent:ci ") | not)
      | select([$l[] | select(IN("agent-fix", "agent-in-progress", "needs-human", "no-triage", "triage-held"))] | length == 0)
      | select(($l | index("triage")) or ($l | index("retriage"))
               or ((.author_association | IN("OWNER", "MEMBER", "COLLABORATOR")) and .created_at >= $since))
      | "\(.created_at)\t\($repo)\t\(.number)\t\(if ($l | index("retriage")) then "retriage" else "new" end)\t\(.author_association)"' \
      <<<"${open_issues}")"$'\n'
  elif has_mode triage && [[ -z "${RO_TOKEN}" ]]; then
    log "${REPO}: triage skipped: no read-only token (triage never runs with the write token)"
  fi
done

# --- model reachable? (the GPU may be busy with another model) ---------------
model_healthy() {
  local health="${LLM_API_BASE%/v1}/health"
  curl --silent --fail --max-time 10 "${health}" >/dev/null \
    || curl --silent --fail --max-time 10 "${LLM_API_BASE%/}/models" >/dev/null
}

# ================================ 1. FIX queue ================================
while IFS=$'\t' read -r _ r issue; do
  [[ -n "${issue}" ]] || continue
  use_repo "${r}"
  # Attempts = fix runs since the last hand-off to a human, so removing the
  # `needs-human` label grants a fresh round of max_attempts.
  max_attempts="$(pol '.fix.max_attempts')"
  attempts="$(comments_of "${issue}" | jq '
    ([to_entries[] | select((.value.body // "") | contains("<!-- maintainer-agent:run gave-up -->")) | .key] | max // -1) as $cut
    | [to_entries[] | select(.key > $cut and ((.value.body // "") | contains("<!-- maintainer-agent:run fix -->")))]
    | length')"
  log "${REPO}: fix candidate #${issue} (attempts this round: ${attempts}/${max_attempts})"
  if (( attempts >= max_attempts )); then
    log "${REPO}: #${issue} reached ${max_attempts} attempts; handing over to a human"
    if (( ! dry_run )); then
      add_label "${issue}" needs-human
      comment "${issue}" "<!-- maintainer-agent:run gave-up -->
maintainer-agent made ${max_attempts} attempts without finishing this. Labelled \`needs-human\`; remove that label to allow another round."
    fi
    continue
  fi
  if ! model_healthy; then log "model endpoint ${LLM_API_BASE} not healthy; will retry next tick"; exit 0; fi
  if (( dry_run )); then log "${REPO}: dry run: would run fix on #${issue}"; exit 0; fi

  add_label "${issue}" agent-in-progress
  # use_repo is not called again in this tick, so REPO/TOKEN still match.
  cleanup_cmds+=("remove_label ${issue} agent-in-progress")
  run_dir="$(new_run_dir fix "${issue}")"
  printf '%s\n' "${POLICY}" > "${run_dir}/policy.json"
  # Branches the run may legitimately push to: its own maintainer-agent/*
  # branches and, in ci-fix mode, the bot branch named in the CI marker.
  marker_branch="$(api GET "/issues/${issue}" | jq -r '.body // ""' \
    | grep -o '<!-- maintainer-agent:ci [^>]*-->' | head -n1 | sed -n 's/.* branch=\([^ ]*\) .*/\1/p' || true)"
  ref_snapshot > "${run_dir}/refs.before"
  id="$(run_id fix "${issue}")"
  read -r -d '' -a allow < <(printf '%s\n' "$(llm_host)" ${EGRESS_BASE_ALLOW:+"${EGRESS_BASE_ALLOW}"} && pol '.egress[]?' && printf '\0') || true
  start_egress "${id}" "${run_dir}/egress.log" "${allow[@]}"
  set +e
  GH_TOKEN="${TOKEN}" timeout --kill-after=60 5h docker run --rm \
    --name "ma-${id}" "${hardening[@]}" --memory 8g \
    --network "${net}" "${proxy_env[@]}" \
    --env GH_TOKEN --env REPO="${REPO}" --env POLICY_JSON="${POLICY}" \
    --env LLM_API_BASE="${LLM_API_BASE}" --env LLM_MODEL="${LLM_MODEL}" \
    --env GIT_AUTHOR="${GIT_AUTHOR}" --env MSWEA_STEP_LIMIT="$(pol '.fix.step_limit')" \
    --volume "${run_dir}:/runs" \
    "${RUNNER_IMAGE}" fix "${issue}"
  rc=$?
  set -e
  log "${REPO}: fix runner for #${issue} exited with ${rc}; logs in ${run_dir}"

  # Ref audit: the agent holds a write token (until pushing moves to the
  # host), so any ref it was not supposed to touch that changed during the run
  # is gated for review and reported. A bot pushing concurrently can cause a
  # false positive; that only costs a manual review.
  ref_snapshot > "${run_dir}/refs.after"
  unexpected="$(comm -13 "${run_dir}/refs.before" "${run_dir}/refs.after" | cut -d' ' -f1 \
    | grep -Ev "^refs/heads/maintainer-agent/(issue|main-fix)-${issue}$" \
    | { if [[ -n "${marker_branch}" ]]; then grep -vxF "refs/heads/${marker_branch}"; else cat; fi; } || true)"
  # A marker naming the default branch is main-fix: pushing there is never expected.
  deleted="$(comm -23 <(cut -d' ' -f1 "${run_dir}/refs.before") <(cut -d' ' -f1 "${run_dir}/refs.after") || true)"

  # Protected-paths audit on the run's branch.
  work_branch="maintainer-agent/issue-${issue}"
  if [[ -n "${marker_branch}" ]]; then
    default_branch="$(api GET "" | jq -r .default_branch)"
    if [[ "${marker_branch}" == "${default_branch}" ]]; then work_branch="maintainer-agent/main-fix-${issue}"; else work_branch="${marker_branch}"; fi
  fi
  touched_protected=""
  if grep -q "^refs/heads/${work_branch} " "${run_dir}/refs.after"; then
    default_branch="${default_branch:-$(api GET "" | jq -r .default_branch)}"
    changed="$(api GET "/compare/${default_branch}...${work_branch}?per_page=300" | jq -r '.files[]?.filename' || true)"
    while IFS= read -r f; do
      [[ -n "${f}" ]] || continue
      while IFS= read -r g; do
        [[ -n "${g}" ]] || continue
        # `dir/**` protects everything below dir/; other globs match the path.
        # shellcheck disable=SC2053
        if [[ "${g}" == *'/**' && "${f}" == "${g%/**}/"* ]] || [[ "${f}" == ${g} ]]; then
          touched_protected+="${f}"$'\n'; break
        fi
      done < <(pol '.protected_paths[]')
    done <<<"${changed}"
  fi

  if [[ -n "${unexpected}${deleted}${touched_protected}" ]]; then
    log "${REPO}: AUDIT findings for fix run on #${issue}: refs=[${unexpected//$'\n'/ }] deleted=[${deleted//$'\n'/ }] protected=[${touched_protected//$'\n'/ }]"
    for ref in ${unexpected} ${touched_protected:+refs/heads/${work_branch}}; do
      [[ "${ref}" == refs/heads/* ]] || continue
      for n in $(api GET "/pulls?state=open&head=${REPO%%/*}:${ref#refs/heads/}" | jq -r '.[].number'); do
        node="$(api GET "/pulls/${n}" | jq -r .node_id)"
        graphql 'mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }' \
          "$(jq -n --arg id "${node}" '{id: $id}')" >/dev/null 2>&1 || true
        add_label "${n}" agent-review
      done
    done
    add_label "${issue}" needs-human
    comment "${issue}" "<!-- maintainer-agent:run audit -->
**Audit:** this fix run needs a closer look before anything is merged. Auto-merge was disabled on any matching pull request and they were labelled \`agent-review\`.
\`\`\`text
${unexpected:+refs changed outside the branch of this run:
${unexpected}
}${deleted:+refs deleted:
${deleted}
}${touched_protected:+protected paths modified on ${work_branch}:
${touched_protected}}
\`\`\`
(A dependency bot pushing at the same time can also cause ref findings.)"
  fi
  review_sweep || log "${REPO}: post-run review sweep failed"
  exit 0
done < <(sort <<<"${fix_cands}")

# =============================== 2. TRIAGE queue ==============================
mkdir -p "${RUNS_DIR}/state"
while IFS=$'\t' read -r _ r issue kind assoc; do
  [[ -n "${issue}" ]] || continue
  use_repo "${r}"
  if [[ "${kind}" == new ]]; then
    answered="$(comments_of "${issue}" | jq 'map((.body // "") | contains("<!-- maintainer-agent:triage")) | any')"
    [[ "${answered}" == false ]] || continue
    [[ "${POST}" == true || ! -e "${RUNS_DIR}/state/${SLUG}-triage-${issue}.drafted" ]] || continue
  fi
  state_file="${RUNS_DIR}/state/${SLUG}-triage-${issue}.failures"
  failures="$(cat "${state_file}" 2>/dev/null || echo 0)"
  max_attempts="$(pol '.triage.max_attempts')"
  if [[ "${kind}" == new ]] && (( failures >= max_attempts )); then
    continue
  fi
  log "${REPO}: triage candidate #${issue} (${kind}, author ${assoc}, previous failures ${failures}, post=${POST})"
  if ! model_healthy; then log "model endpoint ${LLM_API_BASE} not healthy; will retry next tick"; exit 0; fi
  if (( dry_run )); then log "${REPO}: dry run: would triage #${issue}"; exit 0; fi

  fail() {
    echo $(( failures + 1 )) > "${state_file}"
    log "${REPO}: triage of #${issue}: $1; failure $(( failures + 1 ))/${max_attempts}; logs in ${run_dir}"
    exit 0
  }
  run_dir="$(new_run_dir triage "${issue}")"
  mkdir -p "${run_dir}/out"; chmod 0777 "${run_dir}/out"
  id="$(run_id triage "${issue}")"

  # a. fetch: deterministic, read-only token, no model, default network.
  set +e
  GH_TOKEN="${RO_TOKEN}" timeout --kill-after=30 10m docker run --rm \
    --name "ma-${id}-fetch" "${hardening[@]}" --memory 2g \
    --env GH_TOKEN --env REPO="${REPO}" --env POLICY_JSON="${POLICY}" \
    --volume "${run_dir}:/runs" \
    "${RUNNER_IMAGE}" triage-fetch "${issue}"
  rc=$?
  set -e
  (( rc == 0 )) || fail "context fetch failed (rc=${rc})"

  # b. agent: model only, no token, read-only root, read-only context.
  start_egress "${id}" "${run_dir}/egress.log" "$(llm_host)" || fail "egress proxy failed to start"
  set +e
  timeout --kill-after=60 1h docker run --rm \
    --name "ma-${id}" "${hardening[@]}" --memory 4g \
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
    [[ "${POST}" == true ]] && can_write && add_label "${issue}" triage-held
    rm -f "${state_file}"
    log "${REPO}: triage answer for #${issue} HELD for review ($(tr '\n' ';' < "${safe}.reasons")); draft in ${run_dir}"
    exit 0
  fi
  (( src == 0 )) && [[ -s "${safe}" ]] || fail "sanitiser failed (rc=${src})"

  # d. post with the host token, or keep as a draft.
  if [[ "${POST}" != true ]] || ! can_write; then
    touch "${RUNS_DIR}/state/${SLUG}-triage-${issue}.drafted"
    rm -f "${state_file}"
    log "${REPO}: draft answer for #${issue} kept (not posted: post=${POST}): ${safe}"
    exit 0
  fi
  comment "${issue}" "<!-- maintainer-agent:triage v1 -->
$(cat "${safe}")

---
<sub>Automated first answer drafted by [maintainer-agent](https://github.com/louisremi/maintainer-agent) (mini-swe-agent, \`${LLM_MODEL#*/}\`) from a sandboxed, read-only investigation. It may be wrong; a maintainer will follow up. Maintainers: label \`agent-fix\` to have the agent propose a change, or \`retriage\` for a fresh answer.</sub>"
  [[ "${kind}" == retriage ]] && remove_label "${issue}" retriage
  rm -f "${state_file}"
  log "${REPO}: posted first answer on #${issue}; logs in ${run_dir}"
  exit 0
done < <(sort <<<"${triage_cands}")

log "nothing to do"
