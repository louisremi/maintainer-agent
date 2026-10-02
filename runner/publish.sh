#!/usr/bin/env bash
# Pushes an agent's patch to a new branch. No model runs here; this container
# holds a push credential for ONE repository and can reach the forge's git
# hosts only (allow-list proxy).
#
#   in:  /in/changes.patch  (from the agent, untrusted; re-checked here)
#        /in/message.txt    (sanitised commit message: title, blank line, body)
#   env: GIT_REMOTE_URL, GIT_AUTH_HEADER ("Authorization: ..."), BASE_SHA,
#        BRANCH (must start with maintainer-agent/), PROTECTED_PATHS (one glob
#        per line), GIT_AUTHOR ("Name <email>")
#   out: /out/publish.json  {"branch", "commit"}
#
# Exit: 0 pushed, 2 bad input, 3 patch rejected (protected path, symlink,
# submodule, too large, does not apply), 4 push failed.
set -Eeuo pipefail
shopt -s extglob

die() { echo "publish: $2" >&2; exit "$1"; }
# Paths are fixed in the image; PUBLISH_TEST_ROOT (tests only) relocates them,
# and PUBLISH_TEST_ALLOW_FILE lets tests push to a local bare repository.
root="${PUBLISH_TEST_ROOT:-}"
in_dir="${root}/in" out_dir="${root}/out" tmp="${root:-}/tmp"
protocols=https:http url_re='^https?://[^@[:space:]]+$'
if [[ -n "${PUBLISH_TEST_ALLOW_FILE:-}" ]]; then protocols=https:http:file; url_re='^(https?|file)://[^@[:space:]]+$'; fi
: "${GIT_REMOTE_URL:?}" "${GIT_AUTH_HEADER:?}" "${BASE_SHA:?}" "${BRANCH:?}" "${GIT_AUTHOR:?}"
[[ "${BRANCH}" =~ ^maintainer-agent/[A-Za-z0-9._/-]+$ && "${BRANCH}" != *..* && "${BRANCH}" != *.lock && "${BRANCH}" != */ ]] \
  || die 2 "refusing branch ${BRANCH}"
[[ "${BASE_SHA}" =~ ^[0-9a-f]{40,64}$ ]] || die 2 "invalid BASE_SHA"
[[ "${GIT_REMOTE_URL}" =~ ${url_re} ]] || die 2 "GIT_REMOTE_URL must be an http(s) URL without credentials"
[[ "${GIT_AUTHOR}" =~ ^([^\<\>]+)\ \<([^\<\>[:space:]]+@[^\<\>[:space:]]+)\>$ ]] || die 2 "invalid GIT_AUTHOR"
author_name="${BASH_REMATCH[1]}" author_email="${BASH_REMATCH[2]}"
patch="${in_dir}/changes.patch"
[[ -f "${patch}" && ! -L "${patch}" && -s "${patch}" ]] || die 2 "no patch"
(( $(stat -c %s "${patch}") <= 1048576 )) || die 3 "rejected: patch larger than 1 MiB"
[[ -f "${in_dir}/message.txt" ]] || die 2 "no commit message"

# Every git call: no hooks, no global config, credential only as an HTTP header.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1
export GIT_ALLOW_PROTOCOL="${protocols}"
file_allow=never
[[ "${protocols}" == *file* ]] && file_allow=always
g() { git -c core.hooksPath=/dev/null -c "protocol.file.allow=${file_allow}" -c submodule.recurse=false "$@"; }
gr() { g -c "http.extraHeader=${GIT_AUTH_HEADER}" "$@"; }

# --- inspect the patch before applying it -----------------------------------------
mkdir -p "${tmp}"
files="${tmp}/files.txt"
g apply --numstat -z "${patch}" >/dev/null 2>&1 || die 3 "rejected: the patch is not a valid git diff"
# All paths named in the patch (old and new names), one per line.
grep -aE '^(diff --git|rename (from|to)|copy (from|to)) ' "${patch}" \
  | sed -E 's#^diff --git a/(.*) b/(.*)$#\1\n\2#; s#^(rename|copy) (from|to) ##' | sort -u > "${files}"
count="$(wc -l < "${files}")"
(( count > 0 )) || die 3 "rejected: the patch changes nothing"
(( count <= 200 )) || die 3 "rejected: the patch touches more than 200 files"
if grep -aqE '^(new|old|deleted) (file )?mode 120000|^index [0-9a-f]+\.\.[0-9a-f]+ 120000' "${patch}"; then
  die 3 "rejected: the patch creates or changes a symbolic link"
fi
if grep -aqE '^(new|old|deleted) (file )?mode 160000|^index [0-9a-f]+\.\.[0-9a-f]+ 160000|^Subproject commit' "${patch}"; then
  die 3 "rejected: the patch changes a submodule"
fi
# check_path <path>: refuse unsafe and protected paths.
check_path() {
  local f="$1" glob
  [[ -z "${f}" || "${f}" == /* || "/${f}/" == */../* || "${f}" == .git || "${f}" == .git/* || "${f}" == */.git/* || "${f}" == */.git ]] \
    && die 3 "rejected: unsafe path ${f}"
  while IFS= read -r glob; do
    [[ -z "${glob}" ]] && continue
    # `dir/**` protects everything below dir; other globs match like the shell.
    if [[ "${glob}" == *'/**' ]]; then
      [[ "${f}" == "${glob%/**}" || "${f}" == "${glob%/**}"/* ]] && die 3 "rejected: touches protected path ${f}"
    else
      # shellcheck disable=SC2053  # the glob is meant to match
      [[ "${f}" == ${glob} ]] && die 3 "rejected: touches protected path ${f}"
    fi
  done <<< "${PROTECTED_PATHS:-}"
  return 0
}
# First filter on the patch text; the authoritative check runs after applying.
while IFS= read -r f; do check_path "${f}"; done < "${files}"

# --- apply on a fresh clone of the base commit and push --------------------------
repo="${tmp}/repo"
g init --quiet "${repo}"
cd "${repo}"
g remote add origin "${GIT_REMOTE_URL}"
gr fetch --quiet --no-tags --depth 1 origin "${BASE_SHA}" || die 4 "could not fetch the base commit"
g checkout --quiet --detach FETCH_HEAD
g apply --index --whitespace=nowarn "${patch}" || die 3 "rejected: the patch does not apply to the base commit"
if [[ -n "$(g diff --cached --name-only --diff-filter=T)" ]]; then die 3 "rejected: the patch changes a file type"; fi
if g diff --cached --raw | awk '$2 ~ /^1[26]0000$/' | grep -q .; then die 3 "rejected: symbolic link or submodule after applying"; fi
g diff --cached --quiet && die 3 "rejected: the patch changes nothing"
# Authoritative: every path the index changes relative to the base commit,
# as git itself sees them (NUL-separated, no quoting, renames split into
# deletion + addition), whatever prefixes or header forms the patch used.
changed=0
while IFS= read -r -d '' f; do
  check_path "${f}"
  changed=$((changed + 1))
done < <(g diff --cached --no-renames --name-only -z "${BASE_SHA}")
(( changed > 0 )) || die 3 "rejected: the patch changes nothing"
(( changed <= 200 )) || die 3 "rejected: the patch touches more than 200 files"
GIT_AUTHOR_NAME="${author_name}" GIT_AUTHOR_EMAIL="${author_email}" \
GIT_COMMITTER_NAME="${author_name}" GIT_COMMITTER_EMAIL="${author_email}" \
  g commit --quiet --no-verify -F "${in_dir}/message.txt"
commit="$(g rev-parse HEAD)"
# Create-only push: the lease with an empty expected value makes the push
# fail if the branch already exists (a plain push would fast-forward it), so
# nothing is ever overwritten and history is never rewritten.
gr push --quiet --force-with-lease="refs/heads/${BRANCH}:" origin "HEAD:refs/heads/${BRANCH}" 2>"${tmp}/push.err" || { sed 's/^/publish: /' "${tmp}/push.err" >&2; die 4 "push to ${BRANCH} failed"; }
jq -n --arg branch "${BRANCH}" --arg commit "${commit}" '{branch: $branch, commit: $commit}' > "${out_dir}/publish.json"
echo "publish: pushed ${commit} to ${BRANCH}" >&2
