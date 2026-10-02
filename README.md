# maintainer-agent

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

1. Copy [compose.example.yaml](compose.example.yaml) to `compose.yaml` and
   set `PUBLIC_URL`, `LLM_API_BASE`, `LLM_MODEL` and `SECRETS_KEY`.
2. `docker compose up -d`, then read the admin password from the logs:
   `docker compose logs server | grep "admin password"` (it is also stored in
   `DATA_DIR/admin-token`).
3. Open `PUBLIC_URL/admin` (any user name, that password) and click
   **Create the app on GitHub**. GitHub shows the preconfigured app (name,
   permissions, webhook URL); confirm it, and you land on its installation
   page.
4. Install the app on the repositories you want. That is all a repository
   needs; an optional [policy file](#repository-policy) tailors behaviour.

**Several accounts.** A private GitHub App can only be installed on the
account that owns it. To watch your personal repositories and an
organisation's, add one app per account (enter the organisation on
`/admin`). Or create one *public* app and limit who can use your server with
`ALLOWED_ACCOUNTS` (required for public apps). Every app gets its own webhook URL and secret; a
repository reachable through two apps is handled by the first one only.

**Apps registered by hand** (or kept in a secret store): set
`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` (and
`GITHUB_APP_SLUG`); the webhook URL is `PUBLIC_URL/webhooks/env`.

## Configuration

Server settings are environment variables. A GitHub App cannot carry
settings such as the model or the server URL, so they live here; tailoring
per repository lives in the repository's policy file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | required | HTTPS URL where GitHub reaches the server. |
| `LLM_API_BASE` | required | OpenAI-compatible base URL, e.g. `http://10.0.0.5:8000/v1`. |
| `LLM_MODEL` | required | litellm model name, e.g. `openai/<served-model-id>`. |
| `LLM_API_KEY` | none | Sent to the model endpoint. The only secret agent containers see. |
| `LLM_MODEL_ISSUE`, `LLM_MODEL_FIX`, `LLM_MODEL_REVIEW` | `LLM_MODEL` | Per-job models on the same endpoint. |
| `RUNNER_IMAGE` | `louisremi/maintainer-agent:v0.2.0` | Agent image; build `FROM` it to add toolchains. |
| `DATA_DIR` | `/srv/maintainer-agent` | State database, job folders. **Same absolute path on the host and in the container.** |
| `SECRETS_KEY` | none | Encrypts app credentials at rest (AES-256-GCM). Strongly recommended. |
| `ADMIN_TOKEN` | generated | Password of `/admin`. |
| `ALLOWED_ACCOUNTS` | everyone | Space-separated `account` or `host/account` entries whose repositories the server serves. |
| `MAX_CONCURRENT_JOBS` | `1` | Agent runs in parallel (one is right for a single-GPU model server). |
| `MAX_JOBS_PER_AUTHOR_PER_DAY` | `5` | Automatic jobs per non-maintainer per day. |
| `MAX_STEP_LIMIT`, `MAX_ATTEMPTS_CAP`, `MAX_REVIEW_COMMENTS`, `MAX_DIFF_LINES` | `120`, `5`, `50`, `20000` | Host limits; policies can only lower them. |
| `ISSUE_STEP_LIMIT`, `REVIEW_STEP_LIMIT` | `30`, `40` | Agent steps for answers and reviews. |
| `JOB_RETENTION_DAYS` | `14` | Finished jobs and their logs are deleted after this. |
| `GIT_AUTHOR` | `maintainer-agent <maintainer-agent@users.noreply.github.com>` | Author of proposed commits. |
| `DOCKER_PULL` | `missing` | Pull the runner image at start (`always`, `missing`, `never`). |

## Repository policy

Optional. `.maintainer-agent.yml` at the repository root (or
`.github/maintainer-agent.yml`), read from the default branch
([template](templates/maintainer-agent.yml)):

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
| `agent-in-progress` | the agent | A fix is being prepared. |
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

- **The server** holds the app private keys and webhook secrets (encrypted
  with `SECRETS_KEY`). It mints installation tokens limited to one repository
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
- `LLM_API_KEY`, if set, is in every agent's environment (the proxy cannot
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

- `/admin` lists connections, their repositories (enable/disable each),
  repositories also reachable through another app, the model status and the
  recent jobs. **Resync** re-reads an app's installations; it also runs every
  six hours.
- If the model endpoint is down, jobs wait and resume when it is back.
- Job folders `DATA_DIR/jobs/<id>/` keep the task, the agent's output, its
  trajectory (`out/trajectory.json`, browse with
  `pipx run --spec mini-swe-agent mini-extra inspect <file>`) and the proxy
  logs (`logs/*-egress.log`: allowed and refused hosts) for
  `JOB_RETENTION_DAYS`.
- Repositories that need more toolchains: build `FROM
  louisremi/maintainer-agent` and set `RUNNER_IMAGE`.
- If the model's tool calls misbehave, switch to text-based parsing with
  `model_class: litellm_textbased` in the configs under `runner/config/`.

## Development

```bash
(cd server && pnpm install)
tests/run.sh    # shellcheck, hadolint, actionlint, runner tests, server typecheck + architecture rules + tests
docker build -t maintainer-agent:dev runner/ && tests/smoke-image.sh maintainer-agent:dev
docker build -t maintainer-agent-server:dev server/ && tests/smoke-server.sh maintainer-agent-server:dev
```

Read [docs/architecture.md](docs/architecture.md) (hexagonal architecture,
bounded contexts), [docs/glossary.md](docs/glossary.md),
[docs/forges.md](docs/forges.md) (adding GitLab) and [AGENTS.md](AGENTS.md).
