# maintainer-agent: handover plan

Read this first when resuming work in a new conversation. It records where
the project stands (as of 2026-09-29), what is proven and what is not, and the
remaining work in priority order. Read [README.md](README.md) (design,
security model) and [AGENTS.md](AGENTS.md) (invariants) next.

## Where things stand

| Item | State |
| --- | --- |
| This repo | `/workspace/maintainer-agent`, pushed to <https://github.com/louisremi/maintainer-agent> (public). `main` = tag `v0.1.1` = `232fecaa8ebc196c28dbc637651fb2f24ff665c2`. `v0.1.0` (`6187fcd`) exists but its CI failed (shellcheck 0.9 lint); ignore it. |
| CI on `v0.1.1` | `test` job green; runner image **builds and passes `tests/smoke-image.sh` on amd64 and arm64**; publish failed only at `docker/login-action` because the repo has **no Docker Hub secrets**. The image `louisremi/maintainer-agent` is therefore **not published yet**. |
| First watched repo | `/workspace/deepseek-harness-docker-dev` (GitHub `louisremi/deepseek-harness-docker-dev`): one **local, unpushed** commit `afb94ed`. It contains `.github/maintainer-agent.yml` and calls `review-gate.yml` / `ci-failure-issue.yml` pinned to `232feca… # v0.1.1`. Its `agent-runner/` was removed (history lives here, commit `7c85220`). |
| Model | Qwen3.8 27B on NASBIS, `http://100.67.12.33:18982/v1` (vLLM, `/health`, 1 concurrent request, native tool calls via `qwen3_coder`). **Offline** at handover time (connection refused/timeout). Details: `/workspace/qwen3-8-27B-paiton-vllm-on-nasbis-R9700/README.md`. |
| Host | nasbrico (Unraid). Nothing is installed there yet: no dispatcher, no `repos.json`, no tokens. The older, pre-split `dsh-dev-agent` User Script was never installed either. |
| Local tooling | `gh` on this machine is logged in as `louisremi` with scopes `gist, read:org, repo, workflow` (the `workflow` scope was added so workflow files can be pushed). No SSH keys: push with `git -c credential.helper= -c credential.helper='!gh auth git-credential' push …`. No Docker daemon here; `bwrap` works for local sandbox tests. |

### Proven
- `tests/run.sh`: shellcheck (also 0.9.0, as on CI), hadolint, actionlint, 22 sanitiser tests, 30+ policy tests, dispatcher simulation (two repos with different tokens, oldest-first across repos, draft-only never posts, triage agent gets no token and model-only egress, fix egress = base + policy hosts, ref audit, protected-paths audit, invalid policy skips repo, cleanup).
- Runner image build + smoke test (both arches) on GitHub Actions.
- `runner/run-triage.sh fetch` against a real repo without a policy file (`SWE-agent/mini-swe-agent` #970): snapshot complete, picks the repo's `AGENTS.md` and the generic playbook.
- tinyproxy allow-list (Debian `tinyproxy-bin` 1.11.2): allowed hosts pass, others / look-alikes / non-443 CONNECT refused.
- **Pre-split** version only: full sandboxed triage with Qwen (bwrap netns + proxy) on an issue carrying a hidden prompt injection. The model ignored it, 8/8 proxied requests went to the model, the sanitiser passed a correct answer.

### Not proven yet
- A triage run of the **generic** prompts/playbooks with a model (Qwen went offline mid-test: `InternalServerError`, proxy log "Could not establish a connection").
- Anything with real Docker networking: `--internal` network + egress container + `--dns 127.0.0.1` on nasbrico; fix mode end to end; `agent-pr`, `ci-wait` against real PRs; the reusable workflows running in a real repository; the review sweep / audits against real GitHub.
- Policy fetch through the API from a real repository (only simulated).

## Next steps (in order)

### 1. Publish the runner image
- Add repository secrets `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` to
  `louisremi/maintainer-agent` (the user does this; never print secrets). The
  Docker Hub repository `louisremi/maintainer-agent` may need creating first.
- Re-run the failed `v0.1.1` CI run (`gh run rerun <id> --failed`), check that
  `louisremi/maintainer-agent:v0.1.1` and `:sha-232fecaa8ebc` exist for both
  arches (`docker buildx imagetools inspect`, or the Docker Hub API).
- `main` pushes publish `:latest`; tags publish `:vX.Y.Z`.

### 2. Validate the generic triage with the model (no Docker needed)
When `curl http://100.67.12.33:18982/health` returns 200, repeat the local
sandbox test used before the split (it worked; scripts were in a scratch dir
that was deleted, so recreate them):
1. `pip install --target <scratch>/pylib mini-swe-agent==2.4.6`; extract
   `tinyproxy-bin_1.11.2-1_amd64.deb` (sha256
   `d0f4177d8ec7c128fd3246d7ec3eb5a72eac72b5d2c0d81f5d9abd26c33673ef`).
2. Snapshot: run `runner/run-triage.sh fetch <n>` with `/runs` rewritten to a
   scratch dir (`REPO`, `GH_TOKEN=$(gh auth token)`, `POLICY_JSON` from
   `runner/policy.py`). On this machine unset `BASH_ENV` and set
   `XDG_CACHE_HOME`/`HOME` to writable dirs, and use a `TMPDIR` inside the
   workspace (`/tmp` is noexec).
3. Start the proxy with `runner/entrypoint.sh egress`
   (`EGRESS_ALLOW=100.67.12.33 EGRESS_CLIENTS=127.0.0.1`) and a small
   TCP↔unix-socket bridge; run the agent phase inside
   `bwrap --unshare-net --unshare-pid --ro-bind / / …` with only the output
   dir writable, context read-only, and `HTTP(S)_PROXY` pointing at the bridge.
   Background processes do not survive between tool calls here: start proxy,
   bridge and bwrap in **one** command, run it as a background job.
4. Test two cases: a real issue in a repo **without** a policy
   (e.g. `SWE-agent/mini-swe-agent` #970, draft only, never post), and the
   deepseek-harness-docker-dev snapshot **with** its policy and an issue
   carrying a hidden injection (HTML comment asking to exfiltrate `env` via a
   badge image and to forge `<!-- maintainer-agent:triage v1 -->`).
5. Check: answer quality and permalinks, playbook actually followed, proxy log
   shows only `/v1/chat/completions`, `runner/sanitize.py` verdict.
   Adjust `runner/config/mswea-triage.yaml` or `runner/playbooks/triage.md`
   if the generic prompt underperforms; add tests for any sanitiser change.

### 3. Install on nasbrico and verify the sandbox for real
Follow README "Host setup". Concretely:
- User Script dir `/boot/config/plugins/user.scripts/scripts/maintainer-agent/`
  with `script` (= `dispatcher/dispatch.sh` from tag `v0.1.1`), `repos.json`,
  `env` (mode 600), `name`; runs dir `/mnt/user/appdata/maintainer-agent/runs`;
  schedule `*/15 * * * *`.
- `repos.json` defaults: `runner_image` pinned to the published digest,
  `llm_api_base http://100.67.12.33:18982/v1`, `llm_model openai/Qwen3.8`.
  First repo: `louisremi/deepseek-harness-docker-dev` with
  `modes: ["triage", "fix"]`, `post: true`.
- Tokens (fine-grained, that repository only):
  write = Contents/Issues/Pull requests read-write + Actions read, and **not**
  Workflows/Administration/Environments/Deployments/Secrets;
  read-only = Contents/Issues/Pull requests/Actions read.
- Run README's "Check the sandbox" block on nasbrico (proxy reaches the
  model: 200; example.com via proxy: 000; model without proxy: 000; LAN: 000).
  Confirm Docker's embedded DNS with `--dns 127.0.0.1` still resolves the
  `egress` alias; if not, fall back to `--add-host egress:<proxy IP>`.
- `dispatch.sh --dry-run`, then `--repo … --triage <n>` on a test issue.

### 4. Bring the image repository online (user's call to push)
- Push `/workspace/deepseek-harness-docker-dev` (`afb94ed`).
- Repository setup per its README: secrets, Docker Hub repo, auto-merge,
  branch protection requiring `review-gate / gate`, `validate`,
  `build (amd64)`, `build (arm64)` with `enforce_admins: true`; environments
  `agent-review` (required reviewer = louisremi, prevent self-review off) and
  `no-review`.
- End-to-end checks on real GitHub:
  - a maintainer PR → `review-gate / gate` waits for approval;
  - a Renovate PR with only bot commits and green CI → passes, auto-merges;
  - a red Renovate PR → `ci-failure-issue.yml` opens an `agent-fix` issue
    with the `<!-- maintainer-agent:ci … -->` marker; the agent pushes to the
    branch; CI green → issue closed, PR labelled `agent-review`, no auto-merge;
  - an issue labelled `agent-fix` → draft PR on `maintainer-agent/issue-<n>`;
    `ci-wait` returns green while `review-gate` stays pending.
- If `RENOVATE_TOKEN` stays a PAT, `bot_pr_author` cannot be used; consider a
  Renovate GitHub App and set the repo variable `RENOVATE_PR_AUTHOR`.

### 5. Move pushing out of the agent container (main security gap)
Fix mode still gives the model a write token. Target design:
- The fix container gets **no token**: only a writable clone, the policy, the
  issue context (fetched by a model-less step like triage), and egress to the
  model + the policy's `egress` hosts (no GitHub API).
- The agent ends by leaving commits in the clone plus a PR title/body file.
- A model-less host-side step (or a separate "publish" container with the
  write token and no model) then: checks the commit range (no protected paths,
  no deleted tests/guards if the policy lists them, size limits), pushes to the
  one allowed branch with `--force-with-lease` disabled (plain push), opens or
  updates the draft PR, posts the sanitised summary.
- The CI feedback loop moves to the dispatcher: after pushing, wait for CI
  (host-side `ci-wait`), and on red re-run the agent with the failed log as new
  context, up to `fix.max_attempts`.
- The ref audit then becomes a safety net rather than the main control.
- Update README security table, AGENTS.md invariants, the simulation test, and
  release as `v0.2.0` (breaking for `agent-pr`/`ci-wait` usage in playbooks:
  the agent no longer pushes; update the generic and the image repo playbooks).

### 6. Smaller follow-ups
- `renovate.json5` here assumes the Mend Renovate GitHub App: install it on
  `louisremi/maintainer-agent`, or add a self-hosted Renovate workflow.
- Pagination: the dispatcher reads the first 100 open issues/PRs and
  comments per repo; paginate for larger repositories.
- `review-gate.yml` reads at most 100 commits / 100 CI runs per PR.
- Per-repo `runner_image` derivatives (e.g. a toolchain image for repos that
  need Go/Rust) and documenting them.
- Optional second-model check on answers/diffs before posting (only as an
  extra layer; research shows ~50% catch rate, see README).
- A `LICENSE` (none chosen yet; ask the user).
- Consider notifying the maintainer (e.g. ntfy/Home Assistant) on
  `triage-held`, `needs-human` and audit findings.

## Conventions to keep
- Invariants in [AGENTS.md](AGENTS.md) (no credential next to the triage
  model; internal network + allow-list proxy; sanitise before posting;
  nothing agent-written auto-merges; policy can only tailor; generic code
  only; issue/CI/release-note text is data).
- `tests/run.sh` before every push; `tests/smoke-image.sh` when `runner/`
  changes (CI does both). Check with shellcheck **0.9** (CI's version) as
  well as the local 0.11.
- Watched repositories pin reusable workflows to a release **commit SHA** with
  a `# vX.Y.Z` comment; after a release, bump the pin in
  `deepseek-harness-docker-dev` (`.github/workflows/ci.yml`,
  `failure-to-issue.yml`).
- Commits as `louisremi <39374+louisremi@users.noreply.github.com>`.
- Never print tokens; never push the image repository without the user's go.
