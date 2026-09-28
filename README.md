# Issue agent (Nasbrico)

A cron job on **nasbrico** runs [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) v2
on **Qwen3.8 27B** (vLLM on NASBIS, `http://100.67.12.33:18982/v1`) against this
repository's issues. It runs one job at a time, because the model serves a
single request. There are two modes:

| Mode | Picks up | Token next to the model | Network next to the model | Output |
| --- | --- | --- | --- | --- |
| **fix** (priority) | open issues labelled `agent-fix` | write (contents, issues, PRs), **no workflows** | allow-list: model, GitHub, package registries | commits on a branch, a PR (**human review**), a result comment |
| **triage** | new issues without a first answer (trust gate below) | **none** | **model endpoint only** | one first-answer comment, sanitised and posted by the host |

```
cron ─► dispatch.sh ─┬─ review sweep: PRs with non-Renovate commits → auto-merge off, `agent-review`
                     ├─ agent-fix issue? ─► [fix <n>] ─► run-issue.sh ─► mini (mswea.yaml)
                     │                        internal network ─► egress proxy (allow-list)
                     │                      ─► ref audit (unexpected branch/tag changes → needs-human)
                     └─ else new issue?  ─► [triage-fetch <n>]  read-only token, no model ─► ctx/ snapshot
                                          ─► [triage-agent <n>]  no token, read-only, egress = model only ─► draft
                                          ─► [sanitize]          --network none ─► ok: post │ suspicious: `triage-held`
```

### Fix mode: three cases

| Issue | Created by | Agent works on | PR |
| --- | --- | --- | --- |
| CI failed on a Renovate branch | `failure-to-issue.yml` (hidden marker) | the existing `renovate/*` branch | existing Renovate PR; auto-merge resumes when green |
| CI failed on `main` | `failure-to-issue.yml` | new `agent/main-fix-<n>` | opened by `agent-pr` after the first push |
| Any issue a maintainer labels `agent-fix` | a human | new `agent/issue-<n>` | opened by `agent-pr` after the first push, `Closes #<n>` |

In every case the result waits for you: the required `review-gate` check
holds any PR that is not a pure Renovate bump until you approve the
`agent-review` environment ("Review deployments" on the PR's checks). A
Renovate PR whose CI once failed stays gated even after it goes green.

A PR is never opened empty: the `agent-pr` helper refuses until the branch
has a commit. Maintainer comments on the issue are passed to the agent as
authoritative instructions. An earlier triage answer is passed as a hint.

Attempts are counted from the `<!-- agent-run: fix -->` comments. After
`MAX_ATTEMPTS` (default 2) the issue gets `needs-human`. Removing that label
starts a fresh round.

### Triage mode and the trust gate

The repository is public and issue text goes straight into the model's
prompt, so the dispatcher only triages:

- issues opened by the **owner, members or collaborators** (GitHub's
  `author_association`) in the last `TRIAGE_MAX_AGE_DAYS` (14);
- **anyone else's issue only after a maintainer adds the `triage` label.**
  Only people with triage/write access can apply labels.

It never triages bot issues (such as the Renovate dashboard, which also gets
`no-triage`), CI-failure issues, issues labelled `agent-fix`, `needs-human`
or `no-triage`, or issues that already have an answer. Each issue is answered
once; label it `retriage` for a fresh answer. After `TRIAGE_MAX_ATTEMPTS`
failed drafts it stops trying.

If the sanitiser finds the draft suspicious, nothing is posted and the issue
gets **`triage-held`**: read `answer.safe.md`, `answer.safe.md.reasons` and
the trajectory in the run directory, then either post by hand or remove the
label to let it try again.

The playbooks the agent reads are
[docs/agent/triage.md](../docs/agent/triage.md) and
[docs/agent/implement-issue.md](../docs/agent/implement-issue.md).

## Files

| File | Where it runs | Role |
| --- | --- | --- |
| `Dockerfile` | build once, pull on nasbrico | Python 3.13 + mini-swe-agent (pinned) + gh + hadolint + shellcheck + node/npm + tinyproxy |
| `entrypoint.sh` | container | roles: `fix`, `triage-fetch`, `triage-agent`, `sanitize`, `egress` |
| `run-issue.sh`, `mswea.yaml` | container | fix mode |
| `run-triage.sh`, `mswea-triage.yaml` | container | triage: `fetch` and `agent` phases |
| `sanitize.py` (+ `tests/`) | container | cleans agent Markdown before it is posted; exit 3 = hold |
| `agent-pr` | container, on PATH | opens the PR once the branch has commits (never auto-merged) |
| `dispatch.sh` | nasbrico host, cron | queues, trust gate, sandboxes, review sweep, ref audit, posting |

## Security model

The threat: anyone can open an issue, and CI logs or upstream release notes
can carry text too. Research on LLM repair agents found that ~90% of crafted
bug reports steered the agent, and filters caught about half
([arXiv 2509.05372](https://arxiv.org/abs/2509.05372)); the Cline triage bot
was turned into a supply-chain attack by a single issue title
([Clinejection](https://simonwillison.net/2026/mar/6/clinejection/)). So the
design assumes **the model will sometimes obey injected text** and limits what
that can achieve, rather than relying on the prompt. mini-swe-agent itself has
no permission system (every command is `subprocess.run` in bash), so the
container is the boundary.

| Layer | Triage | Fix |
| --- | --- | --- |
| Who can trigger it | trust gate (maintainer issues, or `triage` label) | `agent-fix` label (maintainers only) or CI failures |
| Credentials next to the model | **none** (the read-only token is used by a separate, model-less fetch container) | write PAT, no workflows/admin/environments/deployments |
| Filesystem | read-only root; repo and context snapshot mounted read-only; writes only `/tmp` and its output dir | writable clone; no host mounts except the run dir |
| Network | `--internal` Docker network + tinyproxy allow-list: **the model endpoint only**; no DNS | same, allow-list = model, GitHub, npm/PyPI, Docker Hub, release-binary hosts (`EGRESS_FIX_ALLOW`) |
| LAN / tailnet / Unraid services | unreachable (only the model host is allowed) | unreachable (idem) |
| Output | draft only; sanitised in a `--network none` container; posted by the host | PRs gated by `review-gate` (human approval); summary sanitised; host ref audit after each run |
| Process | non-root, `cap-drop ALL`, `no-new-privileges`, pid/memory limits, no Docker socket | idem |

What the sanitiser does (`sanitize.py`): removes HTML comments (no forged
control markers), images and raw HTML (no zero-click exfiltration through
image URLs), turns links outside this repository into inert text,
neutralises `@mentions` and `owner/repo#n` references, strips invisible
Unicode, redacts credential-shaped strings, and **holds** the answer
(`triage-held`) when it is long or contains credentials or long
base64/hex/percent-encoded blobs.

What is gated for review: every PR except a pure Renovate bump, enforced
twice: by the `review-gate` required check (GitHub side, the agent's token
cannot approve environments or edit workflows) and by the dispatcher's review
sweep (turns auto-merge off and labels `agent-review`). After each fix run the
dispatcher compares all branches and tags with a snapshot taken before the
run; changes outside the run's own branch get auto-merge disabled,
`agent-review`, and `needs-human` on the issue.

Tokens, both fine-grained and scoped to this repository only:
- `GH_TOKEN` (fix mode and the host): *Contents*, *Issues*, *Pull requests*
  read/write, *Actions* read. **Not** *Workflows*, *Administration*,
  *Environments*, *Deployments* or *Secrets*: GitHub then rejects pushes to
  `.github/workflows/`, and the token cannot approve the `review-gate`
  environment or change branch protection.
- `GH_TOKEN_READONLY` (triage fetch): *Contents*, *Issues*, *Pull requests*,
  *Actions* read only. Triage is disabled without it; it never falls back to
  the write token, and the model never sees it.

Known residual risks:
- **Fix mode still gives the model a write token.** Injected text (e.g. in a
  CI log or an issue a maintainer labelled `agent-fix`) could push to other
  branches, comment, or open PRs. The review gate stops any of it from being
  merged or published, and the ref audit flags it, but only moving pushes to
  the host removes it (planned next step: the agent proposes a patch, the
  host validates and pushes it).
- The fix allow-list includes GitHub, so a determined injection could post
  data *to this repository* (e.g. a comment). There is nothing secret for it
  to read except the token itself, whose reach is this public repository.
- Branch protection must apply to administrators (`enforce_admins`): the
  PAT is yours, so without it the token could push to `main` directly.

## One-time setup

1. **Build and push the runner image** (from a machine with Docker, e.g. nasbrico):
   ```bash
   docker buildx build --platform linux/amd64 -t louisremi/deepseek-harness-dev-agent:latest --push agent-runner/
   ```
2. **Create the two tokens** at <https://github.com/settings/personal-access-tokens/new>:
   repository access *only* `louisremi/deepseek-harness-docker-dev`;
   permissions as listed under *Security model*. Also do the repository
   setup in the main [README](../README.md) (`review-gate` required check,
   `enforce_admins`, the `agent-review` environment).
3. **Install the dispatcher** with the Unraid *User Scripts* plugin:
   ```bash
   d=/boot/config/plugins/user.scripts/scripts/dsh-dev-agent
   mkdir -p "$d" /mnt/user/appdata/dsh-dev-agent/runs
   curl -fsSL https://raw.githubusercontent.com/louisremi/deepseek-harness-docker-dev/main/agent-runner/dispatch.sh -o "$d/script"
   chmod +x "$d/script"
   cat > "$d/env" <<'EOF'
   GH_TOKEN=github_pat_WRITE_TOKEN
   GH_TOKEN_READONLY=github_pat_READONLY_TOKEN
   REPO=louisremi/deepseek-harness-docker-dev
   RUNNER_IMAGE=louisremi/deepseek-harness-dev-agent:latest
   RUNS_DIR=/mnt/user/appdata/dsh-dev-agent/runs
   LLM_API_BASE=http://100.67.12.33:18982/v1
   LLM_MODEL=openai/Qwen3.8
   MAX_ATTEMPTS=2
   TRIAGE_ENABLED=true
   TRIAGE_MAX_AGE_DAYS=14
   EOF
   chmod 600 "$d/env"
   echo "dsh-dev-agent" > "$d/name"
   ```
   In the User Scripts UI, set the schedule to *Custom* `*/15 * * * *`.
   Without the plugin, add a root crontab line:
   `*/15 * * * * DISPATCH_ENV=/boot/config/plugins/user.scripts/scripts/dsh-dev-agent/env /boot/config/plugins/user.scripts/scripts/dsh-dev-agent/script >> /var/log/dsh-dev-agent.log 2>&1`
4. **Check the sandbox** on nasbrico (the proxy must reach the model; the
   agent network must reach nothing else):
   ```bash
   img=louisremi/deepseek-harness-dev-agent:latest
   docker network create --internal dsh-agent-test
   docker run -d --rm --name dsh-egress-test --env EGRESS_ALLOW=100.67.12.33 "$img" egress
   docker network connect --alias egress dsh-agent-test dsh-egress-test
   t() { docker run --rm --network dsh-agent-test --dns 127.0.0.1 --entrypoint curl "$img" -sS -o /dev/null -w '%{http_code}\n' --max-time 10 "$@"; }
   t -x http://egress:8888 http://100.67.12.33:18982/v1/models   # expect 200
   t -x http://egress:8888 https://example.com                    # expect 000 (CONNECT refused)
   t http://100.67.12.33:18982/v1/models                          # expect 000 (no route without the proxy)
   t http://192.168.1.1/                                          # expect 000 (no LAN)
   docker rm -f dsh-egress-test; docker network rm dsh-agent-test
   ```
5. **Dry run:** `DISPATCH_ENV=... dispatch.sh --dry-run` shows what the next
   tick would do, including which PRs the review sweep would gate.
6. The host needs `docker`, `curl`, `jq`, `flock`, `timeout`, `comm` and
   `seq` (all present on Unraid). `python3` is no longer needed on the host:
   the sanitiser runs in the runner image.

## Operating it

- Run one job by hand: `dispatch.sh --fix 12` or `dispatch.sh --triage 12`.
  A `--triage` run on an outside contributor's issue is an explicit maintainer
  decision, but the trust gate still applies (add the `triage` label).
- Per-run directories: `/mnt/user/appdata/dsh-dev-agent/runs/{fix,triage}-<n>-<ts>/`
  hold the logs, the trajectory, for triage `ctx/` (what the agent saw),
  `out/…answer.md` (draft) and `answer.safe.md` (what was or would be
  posted), and for fix `refs.before`/`refs.after`. Browse trajectories with
  `pipx run --spec mini-swe-agent mini-extra inspect <file>`.
- Labels you use as a maintainer: `triage`, `retriage`, `no-triage`,
  `agent-fix`, removing `needs-human` or `triage-held`. `agent-review` on a
  PR means: read the diff, then approve the `agent-review` deployment and merge.
- If a fix run needs another host (a new release-binary source), add it to
  `EGRESS_FIX_ALLOW` in the env file; the proxy log shows refused hosts
  (`docker logs` is gone after the run, so rerun by hand with `--fix N`).
- If the model endpoint is down (GPU busy with another model), the dispatcher
  exits quietly and retries on the next tick.
- If Qwen's tool calls misbehave, switch to text-based parsing by adding
  `-c model.model_class=litellm_textbased` in `run-issue.sh`. The v2 default
  prompt then expects ```` ```mswea_bash_command ```` blocks.
