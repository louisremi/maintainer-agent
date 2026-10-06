# maintainer-agent: handover plan

Read this first when resuming work in a new conversation. It records where
the project stands (as of 2026-10-06), what is proven and what is not, and the
remaining work in priority order. Then read [README.md](README.md),
[AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md).

## Where things stand

| Item | State |
| --- | --- |
| Settings | **v0.3 (2026-10-06)**: all behaviour is configured in a Frigate-style versioned `settings.yml` (see [docs/settings.md](docs/settings.md)): server, named models (default + per repo/per job), GitHub App connections, defaults, and the only repositories acted on. Secrets are `{MA_*}` placeholders (Docker secrets > env > `secrets.yaml`). Migrations on start with backups; v0→v1 imports a v0.2 env + DB. Safe mode on invalid files; `/admin/settings` editor saves and restarts. The in-repo `.maintainer-agent.yml` is layered on top and can only narrow. |
| Design | v0.2 replaces the v0.1 cron dispatcher with a NestJS server (`server/`, hexagonal + DDD) that holds any number of GitHub Apps created through the App Manifest flow. Jobs: answer issues, propose fixes as draft PRs (automatic for maintainers' issues, `agent-fix` label otherwise), comment-only PR reviews. Agents never hold a forge token; a model-less `publish` container pushes checked patches. |
| This repo | `/workspace/maintainer-agent` (GitHub `louisremi/maintainer-agent`, public). v0.2 is **pushed to `main` (not tagged)**; CI green; images `louisremi/maintainer-agent:latest` and `louisremi/maintainer-agent-server:latest` (+ `sha-<commit>`) published for amd64 and arm64. `v0.1.1` (`232feca`) is the last release; its runner image is on Docker Hub. |
| google/ax | Evaluated and rejected for now: needs Kubernetes + Agent Substrate, Gemini-only, alpha (README "Why not google/ax?"). The sandbox sits behind ports to allow an AX backend later. |
| GitLab | Designed, not implemented ([docs/forges.md](docs/forges.md)). |
| Model | Since 2026-10-05: Qwen3.8 Flash Next on the **Evo-X2** (llama.cpp, tailscale `100.101.235.30`): `models.default` = `http://100.101.235.30:8731/v1`, `openai/halogen-qwen3.8-flash-next` (262k context, native tool calls verified). Reachable from agent containers through the egress proxy (verified). Previously the dual-R9700 (`http://100.123.169.10:8004/v1`, `openai/qwen3.8-flash-next`, vLLM). |
| Host | nasbrico (Unraid, `ssh 192.168.1.60`). **Server deployed 2026-10-04**, **migrated to settings.yml 2026-10-06**: Compose Manager project `MaintainerAgent` (`/mnt/user/appdata/compose-manager/maintainer-agent/`): `docker-compose.yml` (only `DATA_DIR` + `./config:/config`), `.env` (`MA_SECRETS_KEY` only; `.env.bak-v0.2` keeps the old values), `config/settings.yml`, `config/secrets.yaml` (`MA_ADMIN_TOKEN` = admin password, app key and webhook secret), `config/backups/`. Images `v0.3.0` (server in compose, runner in `server.runner_image`), `DATA_DIR=/mnt/cache/appdata/maintainer-agent` (DB backup `state.db.bak-pre-v0.3`; the DB is WAL: copy it with better-sqlite3 `.backup()`). nasbrico has no python3. Public URL `https://maintainer-agent.tail668c20.ts.net` via tsdproxy (`tailscale_funnel` label; tailnet policy `nodeAttrs` grants `funnel` to `100.104.125.25`); only webhooks, the app callback, `/installed`, `/healthz` and the settings schema answer there (`server.public_paths_only_via_host`). Admin: `http://192.168.1.60:3000/admin` (LAN) or `http://100.96.232.97:3000/admin` (tailnet). Verified: Docker access from the server, `policy` role, egress proxy (model 200, others refused). GitHub App `maintainer-agent-pt65bh` (connection `pT65bHPaztya8Sfi`, installation 168109296) created 2026-10-05, installed on deepseek-harness-docker-dev, dsh-shodh-memory, dsh-docker-adapter (all listed in settings.yml; dsh-docker-adapter has `fix.step_limit: 60` from the UI-edit test). Setup URL of that app must be changed by hand to `https://maintainer-agent.tail668c20.ts.net/installed` (GitHub API cannot). |
| First watched repo | `louisremi/deepseek-harness-docker-dev`: has a v0.1 policy (still valid), `review-gate.yml` pinned to v0.1.1, `failure-to-issue.yml` calling the removed `ci-failure-issue.yml@232feca` (keeps working at that SHA; remove it when v0.2 runs). Branch protection, `agent-review`/`no-review` environments, Renovate App already set up. |

### Proven (locally)
- `tests/run.sh`: shellcheck, hadolint, actionlint, sanitiser (37), policy (48, incl. v1 compatibility), `publish.sh` against a bare repository (23: protected paths, renames, symlinks, submodules, `.git`, traversal, size, no overwrite / fast-forward of existing branches), `run-agent.sh` with a fake `mini` (17), server typecheck, architecture rules + a test that they reject planted violations, 128 server tests (domain, application with fakes, repository contracts on memory and SQLite, GitHub adapter with a fake API and real JWTs, Docker sandbox with a fake engine, git workspace on a real bare repo, end-to-end HTTP with two apps and different webhook secrets).

### Proven on nasbrico
- Manifest flow, webhooks, labels, issue answers and a draft PR (issue #18 → PR #19) with the real model, on v0.2.
- v0.3 migration: the v0.2 import produced the right settings (app, 3 repositories, model, URL; secrets in `secrets.yaml`); a UI save restarted the server and applied the change; a new issue (#21) was queued and answered after the migration.

### Not proven yet
- A PR review and a fix from a maintainer bug issue on v0.3; the manifest flow writing a new app to settings.yml against real GitHub (covered by e2e tests only).

## Next steps (in order)

1. ~~Tag v0.3.0~~ done 2026-10-06; nasbrico runs it.
2. To upgrade later: check no job is active, change the server image tag in the compose file and `server.runner_image` in settings.yml, `docker compose -p maintainer-agent -f docker-compose.yml -f /boot/config/plugins/compose.manager/projects/MaintainerAgent/docker-compose.override.yml up -d`.
3. Verify on v0.3: a PR → comment-only review; a maintainer bug issue → draft PR; egress logs show only allowed hosts.
4. **Tune prompts** on real runs; add sanitiser tests for any change.
5. In `deepseek-harness-docker-dev`: remove `failure-to-issue.yml`, optionally re-pin `review-gate.yml`, migrate its policy to `version: 2` (or move its settings into settings.yml).

## Later
- Settings: structured forms in the UI, profiles (Frigate-style), changes applied without restart.
- GitLab adapter (docs/forges.md), with the same adapter test set as GitHub.
- CI repair (v0.1's `ci-failure-issue.yml`) as a new job kind fed by `check_run`/`workflow_run` events.
- Re-review on new commits (`synchronize`) as a policy option.
- A login session instead of Basic auth on `/admin` (POSTs already require a per-form token and refuse cross-site origins).
- Notifications (ntfy/Home Assistant) on `needs-human`.
- A `LICENSE` (ask the user).

## Conventions to keep
- Invariants in [AGENTS.md](AGENTS.md); glossary terms in code and docs.
- `tests/run.sh` before every push; linters in `.cache/` locally (`PATH="$PWD/.cache:$PATH"`). npm/pnpm here need `NPM_CONFIG_CACHE=$PWD/.cache/npm` and `--store-dir ../.cache/pnpm-store`.
- Commits as `louisremi <39374+louisremi@users.noreply.github.com>`. Push with `git -c credential.helper= -c credential.helper='!gh auth git-credential' push …`.
- Never print tokens; never push or tag without the user's go.
