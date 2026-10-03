# maintainer-agent: handover plan

Read this first when resuming work in a new conversation. It records where
the project stands (as of 2026-10-03), what is proven and what is not, and the
remaining work in priority order. Then read [README.md](README.md),
[AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md).

## Where things stand

| Item | State |
| --- | --- |
| Design | v0.2 replaces the v0.1 cron dispatcher with a NestJS server (`server/`, hexagonal + DDD) that holds any number of GitHub Apps created through the App Manifest flow. Jobs: answer issues, propose fixes as draft PRs (automatic for maintainers' issues, `agent-fix` label otherwise), comment-only PR reviews. Agents never hold a forge token; a model-less `publish` container pushes checked patches. |
| This repo | `/workspace/maintainer-agent` (GitHub `louisremi/maintainer-agent`, public). v0.2 is **committed locally, not pushed, not tagged**. `v0.1.1` (`232feca`) is the last release; its runner image is on Docker Hub. |
| google/ax | Evaluated and rejected for now: needs Kubernetes + Agent Substrate, Gemini-only, alpha (README "Why not google/ax?"). The sandbox sits behind ports to allow an AX backend later. |
| GitLab | Designed, not implemented ([docs/forges.md](docs/forges.md)). |
| Model for the first deployment | The dual-R9700 machine (tailscale `100.123.169.10`): `LLM_API_BASE=http://100.123.169.10:8004/v1`, `LLM_MODEL=openai/qwen3.8-flash-next` (vLLM, 131k context). Reachable from nasbrico's Docker containers through the egress proxy (verified with the v0.1 image: proxy → model 200, everything else refused). |
| Host | nasbrico (Unraid, `ssh 192.168.1.60`). Nothing of maintainer-agent is installed (the paused v0.1 files and image were deleted on 2026-10-03). |
| First watched repo | `louisremi/deepseek-harness-docker-dev`: has a v0.1 policy (still valid), `review-gate.yml` pinned to v0.1.1, `failure-to-issue.yml` calling the removed `ci-failure-issue.yml@232feca` (keeps working at that SHA; remove it when v0.2 runs). Branch protection, `agent-review`/`no-review` environments, Renovate App already set up. |

### Proven (locally)
- `tests/run.sh`: shellcheck, hadolint, actionlint, sanitiser (37), policy (48, incl. v1 compatibility), `publish.sh` against a bare repository (23: protected paths, renames, symlinks, submodules, `.git`, traversal, size, no overwrite / fast-forward of existing branches), `run-agent.sh` with a fake `mini` (17), server typecheck, architecture rules + a test that they reject planted violations, 128 server tests (domain, application with fakes, repository contracts on memory and SQLite, GitHub adapter with a fake API and real JWTs, Docker sandbox with a fake engine, git workspace on a real bare repo, end-to-end HTTP with two apps and different webhook secrets).

### Not proven yet
- Building the two images (no Docker daemon in this workspace) and their smoke tests; CI will do it on the first push.
- Anything against real GitHub: the manifest flow, installation tokens, webhooks, draft PRs, reviews.
- Agents with the real model and the generic prompts (`runner/config/mswea-*.yaml`).
- `DockerodeEngine` against a real daemon (attach/stdin, exec, logs demuxing).

## Next steps (in order)

1. **Review and push** (user's go): push `main`; CI builds and smoke-tests both images on amd64 and arm64 and publishes `:latest`. Fix anything CI finds (likely: Docker engine details, server image build).
2. **Public HTTPS URL for nasbrico** (user's choice: Tailscale Funnel or Cloudflare Tunnel) → `PUBLIC_URL`.
3. **Deploy on nasbrico** with `compose.example.yaml`: `DATA_DIR=/mnt/user/appdata/maintainer-agent` (same path inside the container), `SECRETS_KEY`, the model above. Check `/healthz`, read the admin password from the logs.
4. **Create the GitHub App** from `/admin` for `louisremi`, install it on `deepseek-harness-docker-dev` (and a second repo to prove multi-repo). Verify in order: labels created; a question issue → answer; a maintainer bug issue → answer + draft PR + link comment; a PR → comment-only review; `DATA_DIR/jobs/*/logs/*-egress.log` show only allowed hosts.
5. **Tune prompts** on real runs (answer quality, review comment placement, fix success); add sanitiser tests for any change.
6. **Release v0.2.0**: tag, then in `deepseek-harness-docker-dev` remove `failure-to-issue.yml`, optionally re-pin `review-gate.yml`, and migrate its policy to `version: 2` (`triage` → `answer`, `playbooks.triage` → `playbooks.issue`, add a `review` playbook).

## Later
- GitLab adapter (docs/forges.md), with the same adapter test set as GitHub.
- CI repair (v0.1's `ci-failure-issue.yml`) as a new job kind fed by `check_run`/`workflow_run` events.
- Re-review on new commits (`synchronize`) as a policy option.
- A login session instead of Basic auth on `/admin` (POSTs already require a same-origin `Origin`/`Referer`).
- Notifications (ntfy/Home Assistant) on `needs-human`.
- A `LICENSE` (ask the user).

## Conventions to keep
- Invariants in [AGENTS.md](AGENTS.md); glossary terms in code and docs.
- `tests/run.sh` before every push; linters in `.cache/` locally (`PATH="$PWD/.cache:$PATH"`). npm/pnpm here need `NPM_CONFIG_CACHE=$PWD/.cache/npm` and `--store-dir ../.cache/pnpm-store`.
- Commits as `louisremi <39374+louisremi@users.noreply.github.com>`. Push with `git -c credential.helper= -c credential.helper='!gh auth git-credential' push …`.
- Never print tokens; never push or tag without the user's go.
