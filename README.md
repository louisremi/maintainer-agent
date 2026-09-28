# maintainer-agent

A self-hosted maintainer agent for GitHub repositories. A cron job
dispatcher runs [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)
v2 against a local or remote OpenAI-compatible model and, for every
repository you point it at:

- **answers new issues** with a sandboxed, read-only investigation (one first
  answer per issue, with links to the exact lines);
- **proposes changes** as a *draft* pull request when a maintainer labels an
  issue `agent-fix`;
- optionally **repairs red CI** on dependency-bot branches or the default
  branch, for repositories that opt in with a workflow.

Nothing the agent writes is merged without a human: a required
`review-gate` check waits for a maintainer's approval.

```
cron ─► dispatch.sh (host) ── for every repo in repos.json ──────────────────────────────┐
         │  policy: .github/maintainer-agent.yml (validated, network-less)              │
         │  labels + review sweep (PRs with agent commits: auto-merge off, agent-review) │
         ├─ oldest `agent-fix` issue across repos ─► [fix <n>]  write token, egress allow-list
         │                                           ─► ref audit + protected-paths audit
         └─ else oldest new issue ─► [triage-fetch]  read-only token, no model ─► snapshot
                                   ─► [triage-agent] no token, read-only, egress = model only ─► draft
                                   ─► [sanitize]     --network none ─► post │ keep draft │ hold
```

One model job runs per tick across all repositories, so a single-GPU model
server is enough.

## Watching a repository

1. **Tokens** (fine-grained PATs, repository access = only that repository):
   - read-only: *Contents*, *Issues*, *Pull requests*, *Actions* = read.
     Enough for triage. For repositories you do not maintain, use
     `"post": false`: answers are kept as drafts on the host, never posted.
   - write (optional, for posting and `fix` mode): *Contents*, *Issues*,
     *Pull requests* = read/write, *Actions* = read. **Never** *Workflows*,
     *Administration*, *Environments*, *Deployments* or *Secrets*.
2. **Host config**: add the repository to `repos.json` (see
   [dispatcher/repos.example.json](dispatcher/repos.example.json)) and the
   token variables to the env file.
3. **Optional policy** in the repository:
   `.github/maintainer-agent.yml` ([template](templates/maintainer-agent.yml)):
   instructions to read first, repository playbooks, checks to run before a
   push, extra egress hosts for fix mode, extra links allowed in answers,
   protected paths, and the dependency bot's branches and author.
4. **For `fix` mode**, in the repository (the gate is what makes agent PRs
   safe to have):
   - add the reusable review gate to CI
     ([caller template](templates/caller-review-gate.yml)) and make
     `review-gate / gate` a **required** check, with branch protection
     enforced for administrators;
   - create the environments `agent-review` (required reviewers =
     maintainers) and `no-review` (no rules);
   - optional CI repair: add the CI-failure workflow
     ([caller template](templates/caller-ci-failure.yml)).

Pin the reusable workflows to a release commit SHA
(`uses: louisremi/maintainer-agent/.github/workflows/review-gate.yml@<sha> # v0.1.0`).

## Behaviour per repository

| | Triage | Fix |
| --- | --- | --- |
| Triggered by | new issue from OWNER/MEMBER/COLLABORATOR (≤ `max_age_days`), or a maintainer's `triage` label; `retriage` for a fresh answer | `agent-fix` label (humans), or a CI-failure issue |
| Needs | read-only token | write token + review gate |
| Output | one comment (or a host-side draft with `post: false`) | commits on `maintainer-agent/issue-<n>` / `main-fix-<n>`, or on the bot branch, and a **draft PR** |
| Gives up | after `triage.max_attempts` failed drafts | after `fix.max_attempts` runs → `needs-human` |

Labels (created automatically in repositories with a write token): `agent-fix`,
`agent-in-progress`, `needs-human`, `triage`, `retriage`, `no-triage`,
`triage-held`, `agent-review`.

Playbooks: the generic ones in [runner/playbooks/](runner/playbooks/), or the
repository's own via `playbooks:` in the policy.

## Security model

The threat: anyone can open an issue, and CI logs or upstream release notes
can carry text too. Research on LLM repair agents found that ~90% of crafted
bug reports steered the agent, and filters caught about half
([arXiv 2509.05372](https://arxiv.org/abs/2509.05372)); an issue triage bot
was turned into a supply-chain attack by a single issue title
([Clinejection](https://simonwillison.net/2026/mar/6/clinejection/)). So the
design assumes **the model will sometimes obey injected text** and limits what
that can achieve, rather than relying on the prompt. mini-swe-agent itself has
no permission system (every command is `subprocess.run` in bash), so the
container is the boundary. The layering follows GitHub's
[agentic workflows security architecture](https://github.github.com/gh-aw/introduction/architecture/)
(read-only agent, separate writer, egress firewall, output checks).

| Layer | Triage | Fix |
| --- | --- | --- |
| Who can trigger it | trust gate (maintainer issues, or `triage` label) | `agent-fix` label (maintainers) or CI failures |
| Credentials next to the model | **none** (the read-only token is used by a separate, model-less fetch container) | write PAT for that repository only, no workflows/admin/environments/deployments |
| Filesystem | read-only root; repo and snapshot mounted read-only; writes only `/tmp` and its output dir | writable clone; no host mounts except the run dir |
| Network | `--internal` Docker network + tinyproxy allow-list: **the model endpoint only**; no DNS | same; allow-list = model, GitHub, and the policy's `egress` hosts |
| LAN / VPN / other services | unreachable | unreachable |
| Output | draft; sanitised in a `--network none` container; posted by the host (or kept) | draft PR gated by `review-gate`; summary sanitised; host ref + protected-paths audits |
| Process | non-root, `cap-drop ALL`, `no-new-privileges`, pid/memory limits, no Docker socket | same |

**The sanitiser** ([runner/sanitize.py](runner/sanitize.py)) removes HTML
comments (no forged control markers), images and raw HTML (no zero-click
exfiltration through image URLs), turns links outside the repository and the
policy's `links` into inert text, neutralises `@mentions` and
`owner/repo#n` references, strips invisible Unicode, redacts
credential-shaped strings, and **holds** the answer (`triage-held`) when it is
too long or contains credentials or long base64/hex/percent-encoded blobs.

**The policy file** is only as trusted as the repository's default branch.
It can tailor behaviour, but it cannot choose the runner image, drop the
`.github/**` protection, give triage any network access, or raise the host's
step and attempt limits. It is parsed by a strict YAML-subset parser
([runner/policy.py](runner/policy.py)) in a network-less container, and an
invalid policy makes the dispatcher skip the repository.

**What is gated for review:** every PR except a pure dependency-bot bump,
enforced twice: by the `review-gate` required check (GitHub side; the agent's
token cannot approve environments or edit workflows) and by the dispatcher's
review sweep (auto-merge off, `agent-review`). After each fix run the
dispatcher compares every branch and tag with a snapshot taken before the run
and lists the files changed on the agent's branch: unexpected ref changes or
protected-path edits get auto-merge disabled, `agent-review`, and
`needs-human` on the issue.

**Known residual risks**
- **Fix mode still gives the model a write token.** Injected text (e.g. in a
  CI log, or an issue a maintainer labelled `agent-fix`) could push to other
  branches, comment, or open PRs in that repository. The review gate stops
  any of it from being merged, and the audits flag it; moving pushes to the
  host (the agent proposes a patch, the host validates and pushes it) is the
  planned next step.
- The fix allow-list includes GitHub, so an injection could post data to the
  repository itself. There is nothing secret in the container except the
  token, whose reach is that one repository.
- The review gate's "pure bot PR" test relies on commit author emails unless
  you set `bot_pr_author` (a GitHub App identity cannot be forged).
- Branch protection must apply to administrators if the PAT belongs to an
  admin: without it the token could push to the default branch directly.

## Host setup

Requirements: Linux with Docker, `bash`, `curl`, `jq` (1.6+), `flock`,
`timeout`, `comm`, `seq` (all present on Unraid), and an OpenAI-compatible
model endpoint with tool calling reachable from containers.

```bash
d=/boot/config/plugins/user.scripts/scripts/maintainer-agent   # Unraid User Scripts; any dir works
mkdir -p "$d" /mnt/user/appdata/maintainer-agent/runs
curl -fsSL https://raw.githubusercontent.com/louisremi/maintainer-agent/v0.1.0/dispatcher/dispatch.sh -o "$d/script"
curl -fsSL https://raw.githubusercontent.com/louisremi/maintainer-agent/v0.1.0/dispatcher/repos.example.json -o "$d/repos.json"
chmod +x "$d/script"; $EDITOR "$d/repos.json"
cat > "$d/env" <<'EOF'
GH_TOKEN_MYREPO=github_pat_...
GH_TOKEN_MYREPO_RO=github_pat_...
RUNS_DIR=/mnt/user/appdata/maintainer-agent/runs
EOF
chmod 600 "$d/env"
DISPATCH_ENV="$d/env" "$d/script" --dry-run
```

Schedule it every 15 minutes: in User Scripts, *Custom* `*/15 * * * *`; or a
crontab line running `DISPATCH_ENV=... script` with its output appended to a
log file.

**Check the sandbox** once. The proxy must reach the model; the agent network
must reach nothing else. `EGRESS_ALLOW` takes host names or IPs, without port.

```bash
img=louisremi/maintainer-agent:v0.1.0; model_host=10.0.0.5; model=http://10.0.0.5:8000
docker network create --internal ma-test
docker run -d --rm --name ma-egress-test --env EGRESS_ALLOW="$model_host" "$img" egress
docker network connect --alias egress ma-test ma-egress-test
t() { docker run --rm --network ma-test --dns 127.0.0.1 --entrypoint curl "$img" -sS -o /dev/null -w '%{http_code}\n' --max-time 10 "$@"; }
t -x http://egress:8888 "$model/v1/models"   # expect 200
t -x http://egress:8888 https://example.com  # expect 000 (CONNECT refused)
t "$model/v1/models"                          # expect 000 (no route without the proxy)
docker rm -f ma-egress-test; docker network rm ma-test
```

## Operating it

- One job by hand: `dispatch.sh --repo owner/name --fix 12` or `--triage 12`.
  `--dry-run` shows what the next tick would do, including which PRs the
  review sweep would gate.
- Run folders `RUNS_DIR/<owner>_<name>/{fix,triage}-<n>-<ts>/` hold the logs,
  the trajectory, the proxy log `egress.log` (allowed and refused hosts); for
  triage also `ctx/` (what the agent saw, including the resolved
  `policy.json`), the draft `out/triage-<n>.answer.md` and
  `answer.safe.md`; for fix also `policy.json` and `refs.before`/`refs.after`.
  Browse trajectories with `pipx run --spec mini-swe-agent mini-extra inspect <file>`.
- If the model endpoint is down, the dispatcher exits quietly and retries on
  the next tick.
- Repositories needing more toolchains: build `FROM louisremi/maintainer-agent`
  and set `runner_image` for that repository in `repos.json`.
- If the model's tool calls misbehave, switch to text-based parsing with
  `model_class: litellm_textbased` in the configs under `runner/config/`.

## Development

```bash
tests/run.sh    # shellcheck, hadolint, actionlint, unit tests, dispatcher simulation
docker build -t maintainer-agent:dev runner/ && tests/smoke-image.sh maintainer-agent:dev
```

See [AGENTS.md](AGENTS.md).
