# <img src="docs/assets/maintainer-agent-logo.svg" alt="" width="40" align="absmiddle"> maintainer-agent

A self-hosted maintainer agent for your repositories. Run one server, connect
it to GitHub with a GitHub App it creates for you, install the app on the
repositories you want, and point it at your own OpenAI-compatible model.
Then, on every installed repository:

- a **new issue** gets one first answer: questions are answered, bug reports
  and feature requests get an analysis with links to the exact lines;
- for a **bug report or feature request** the agent also proposes a change as
  a **draft pull request** and links it on the issue: automatically for issues
  opened by maintainers, after a maintainer adds the `agent-fix` label for
  everyone else;
- a **new pull request** gets a **review**: a summary and inline comments.
  The agent only comments; it never approves, requests changes or merges.

The agent is [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) v2
running in hardened Docker containers. It reads the whole repository, the
issue or pull request, and the repository's own instructions (`AGENTS.md`,
`CONTRIBUTING.md`, `README.md`).

```
GitHub ──webhooks──► maintainer-agent server (one container) ─── SQLite job queue
  ▲  App per account     │ holds the app keys; mints tokens for one repository at a time
  │                      ├─► [issue | fix | review agent]  model only, NO token,
  │                      │       internal network + allow-list proxy
  │                      ├─► [sanitize]   no network: links, images, mentions, secrets
  │                      ├─► [publish]    fix only: no model, push token, git hosts only
  └──── comment / draft PR / review ◄────┘
```

## Quick start

Requirements: a Linux host with Docker, an HTTPS URL GitHub can reach (a
reverse proxy, Cloudflare Tunnel, Tailscale Funnel...), and an
OpenAI-compatible endpoint with tool calling (vLLM, llama.cpp server,
Ollama, LM Studio, a hosted API...) reachable from Docker containers.

1. Copy [compose.example.yaml](compose.example.yaml) to `compose.yaml`, and
   [docs/settings.example.yml](docs/settings.example.yml) to
   `config/settings.yml`. Set `server.public_url`, your model endpoint(s)
   under `models`, and the repositories to maintain under `repositories`.
2. Put the secrets in `config/secrets.yaml` (mode 600): `MA_ADMIN_TOKEN`
   (the `/admin` password) and any model API key. Set `MA_SECRETS_KEY` in the
   container environment.
3. Check the files, then start:
   `docker compose run --rm server validate-config && docker compose up -d`.
4. Open `/admin` (any user name, the admin token) and click **Create the app
   on GitHub**. GitHub shows the preconfigured app (name, permissions,
   webhook URL); confirm it. The server adds the app to `settings.yml` (its
   keys to `secrets.yaml`), restarts, and sends you to the app's
   installation page.
5. Install the app on the repositories listed in `settings.yml`. Done.
6. Optional: give the app its avatar. GitHub has no API for this, so
   `/admin` shows a reminder with the logo to download and a link to the
   app's settings.

Steps 1–3 can be done by an LLM: see [docs/llm-setup.md](docs/llm-setup.md).

**Several accounts.** A private GitHub App can only be installed on the
account that owns it. To watch your personal repositories and an
organisation's, add one app per account (enter the organisation on
`/admin`). Or create one *public* app and limit who can use your server with
`server.allowed_accounts` (required for public apps). Every app gets its own
webhook URL and secret.

## Configuration

Everything is in **`settings.yml`** (reference: [docs/settings.md](docs/settings.md)),
inspired by [Frigate](https://docs.frigate.video/configuration/)'s file-based
configuration:

- one versioned file: older files are migrated on start, with a backup;
- server settings, named model endpoints, GitHub Apps, defaults for every
  repository, and the repositories to maintain, each able to override the
  defaults (including its model, per job);
- secrets as `{MA_NAME}` placeholders resolved from Docker secrets, the
  environment or `secrets.yaml`, so the file can be generated and shared;
- a JSON Schema for editors and `validate-config` for CI;
- edited on disk or in `/admin/settings`; saving restarts the server; an
  invalid file starts it in safe mode.

The environment only holds bootstrap values: `CONFIG_DIR` (default
`/config`), `DATA_DIR` (default `/srv/maintainer-agent`, **same absolute path
on the host and in the container**), `PORT` (default 3000) and
`MA_SECRETS_KEY`. Upgrading from v0.2: on first start the server writes
`settings.yml` from the old environment variables and database; remove those
variables afterwards (the logs list them).

## Repository policy

The operator configures each repository in `settings.yml`. A repository's
maintainers can also add a policy file, `.maintainer-agent.yml` at the
repository root (or `.github/maintainer-agent.yml`), read from the default
branch ([template](templates/maintainer-agent.yml)). It can only **narrow**
what `settings.yml` allows (lower limits, switch features off, require the
label, add checks and protected paths; add egress hosts only if
`allow_repository_egress` is true):

- `instructions`: files the agent reads first;
- `playbooks`: the repository's own `issue`, `implement` and `review`
  playbooks instead of the [generic ones](runner/playbooks/);
- `checks`: commands the fix agent runs to verify a change;
- `egress`: extra hosts the fix agent may reach (package registries...);
- `links`: extra URL prefixes allowed as links in posted text;
- `protected_paths`: files a proposed change must never touch;
- `answer`, `fix` (`trigger: maintainers | label`), `review`: switches and
  limits.

The file is validated strictly in a container without network; an invalid
file makes the server ignore the repository until it is fixed. A version 1
file (maintainer-agent v0.1) is still accepted.

## Labels

Created on every installed repository:

| Label | Who adds it | Effect |
| --- | --- | --- |
| `agent-fix` | a maintainer | Propose a change for this issue. |
| `agent-rereview` | a maintainer | Review this pull request again (removed afterwards). |
| `no-agent` | anyone with triage access | Never act on this issue or pull request automatically. |
| `agent-in-progress` | the agent | The agent is working on it: set as soon as an issue or pull request is picked up, removed when done. |
| `agent-drafting-pr-in-progress` | the agent | A draft pull request is being prepared for this issue. |
| `needs-human` | the agent | It gave up, or its output was held back; see its comment. |

## Security model

Anyone can open an issue or a pull request, and their text reaches the model.
Research on LLM repair agents found that most crafted bug reports steered the
agent and filters caught about half
([arXiv 2509.05372](https://arxiv.org/abs/2509.05372)); an issue triage bot
was turned into a supply-chain attack by a single issue title
([Clinejection](https://simonwillison.net/2026/mar/6/clinejection/)). So the
design assumes **the model will sometimes obey injected text** and limits
what that can achieve. mini-swe-agent has no permission system (every command
is `subprocess.run` in bash), so the container is the boundary. The layering
follows GitHub's
[agentic workflows security architecture](https://github.github.com/gh-aw/introduction/architecture/)
(read-only agent, separate writer, egress firewall, output checks).

| | Issue and review agents | Fix agent | Publisher |
| --- | --- | --- | --- |
| Model | yes | yes | **no** |
| Forge credential | **none** | **none** | push token for one repository (contents: write) |
| Filesystem | read-only root and checkout; writes `/tmp` and its output dir | writable checkout; output dir | fresh clone in `/tmp`; read-only patch |
| Network | `--internal` network + allow-list proxy (only usable from that network; CONNECT to port 443 only): **the model endpoint only**; no DNS | model + the policy's `egress` hosts (wildcards cannot cover a whole TLD) | the forge's git hosts only |
| Output | JSON read back with `lstat` checks, size limits and a schema; text sanitised without network | a patch, re-checked by the publisher | one new `maintainer-agent/*` branch |
| Process | non-root, `cap-drop ALL`, `no-new-privileges`, pid/memory limits, init, no Docker socket | same | same |

- **The server** holds the app private keys and webhook secrets (in
  `secrets.yaml`, mode 600, or Docker secrets; never in `settings.yml`, never
  shown by the admin pages). It mints installation tokens limited to one repository
  and the permissions each step needs. It clones repositories itself before
  any agent runs and never runs git again on a directory an agent could
  write.
- **Who can make the agent act:** anyone gets one answer per issue and one
  review per pull request (capped per author per day; bots, the agent itself
  and `no-agent` items are ignored). Only maintainers can make it write code:
  their own issues, or the `agent-fix` label added by someone with write
  access (checked through the API). If the issue is edited after the label
  was added, the agent stops and asks for the label again.
- **Trusted instructions come from the default branch.** The repository's
  `AGENTS.md`/playbooks are read from the base commit, never from a pull
  request's head, so a contributor cannot rewrite the reviewer's
  instructions.
- **The publisher** applies the patch to a fresh clone of the base commit,
  checks the paths git actually changed (whatever the patch headers say), and
  refuses changes to protected paths (the forge's automation files such as
  `.github/**`, the policy files, the policy's `protected_paths`), symbolic
  links, submodules, `.git`, path traversal, more than 200 files or 1 MiB. It
  creates a new branch and never updates an existing one.
- **The sanitiser** ([runner/sanitize.py](runner/sanitize.py)) removes HTML
  comments (no forged markers), images and raw HTML (no zero-click
  exfiltration through image URLs), turns links outside the repository and
  the policy's `links` into inert text, neutralises `@mentions` and
  cross-repository references, strips invisible Unicode, redacts
  credential-shaped strings, and **holds** text that is too long or contains
  credentials or long encoded blobs; held output is not posted and the issue
  gets `needs-human`.
- **Nothing is merged by the agent.** Changes arrive as draft pull requests
  for a maintainer to review. For an extra guarantee, require the optional
  [review gate](.github/workflows/review-gate.yml) check
  ([caller template](templates/caller-review-gate.yml)).
- **The policy file** is only as trusted as the default branch. It can tailor
  behaviour but not raise host limits, give the issue or review agents any
  network, or unprotect the policy files and the forge's automation paths.

**Known residual risks**
- The server reaches the Docker socket, which is equivalent to root on the
  host. Run it on a dedicated host or VM, or with rootless Docker.
- A model's `api_key`, if set, is in its agents' environment (the proxy cannot
  inject it). Agents can only send it to the model endpoint and, for fixes,
  the policy's hosts; use a key that only grants model access.
- The fix agent's egress includes the policy's hosts (package registries);
  injected text could send repository content there. The repository content
  is what the agent is meant to see; no credential is in that container.
- A proposed change can still be wrong or malicious in subtle ways. It is a
  draft for a human to review, like any outside contribution.
- The admin pages use HTTP Basic authentication; put the server behind HTTPS
  and do not expose `/admin` more widely than needed.

## Why not google/ax?

[google/ax](https://github.com/google/ax) (Agent Executor) is a declarative
runtime for sandboxed agent tasks at cluster scale. It was evaluated as a
replacement for the Docker sandbox and rejected for now: it requires
Kubernetes with Agent Substrate (not a single container), supports only
Google's Gemini models (no OpenAI-compatible endpoint, so no self-hosted
models), and is alpha with breaking changes announced. The sandbox sits
behind ports (`AgentRunner`, `ChangePublisher`...), so an AX backend can be
added later; see [docs/architecture.md](docs/architecture.md).

## Operating it

- `/admin` shows the configured repositories, the model endpoints, the
  connections with the repositories each reaches (and those not configured,
  with a snippet to add them), and the recent jobs. **Resync** re-reads an
  app's installations; it also runs every six hours. `/admin/settings` edits
  `settings.yml`.
- If the model endpoint is down, jobs wait and resume when it is back.
- Job folders `DATA_DIR/jobs/<id>/` keep the task, the agent's output, its
  trajectory (`out/trajectory.json`, browse with
  `pipx run --spec mini-swe-agent mini-extra inspect <file>`) and the proxy
  logs (`logs/*-egress.log`: allowed and refused hosts) for
  `server.job_retention_days`.
- Repositories that need more toolchains: build `FROM
  louisremi/maintainer-agent` and set `server.runner_image`.
- If the model's tool calls misbehave, switch to text-based parsing with
  `model_class: litellm_textbased` in the configs under `runner/config/`.

## Development

```bash
(cd server && pnpm install)   # also installs the git hooks (lefthook.yml)
(cd server && pnpm fix)       # Biome: format and apply safe lint fixes
tests/run.sh    # shellcheck, hadolint, actionlint, runner tests, server Biome + typecheck + architecture rules + tests
docker build -t maintainer-agent:dev runner/ && tests/smoke-image.sh maintainer-agent:dev
docker build -t maintainer-agent-server:dev server/ && tests/smoke-server.sh maintainer-agent-server:dev
```

Read [docs/architecture.md](docs/architecture.md) (hexagonal architecture,
bounded contexts), [docs/glossary.md](docs/glossary.md),
[docs/forges.md](docs/forges.md) (adding GitLab) and [AGENTS.md](AGENTS.md).
