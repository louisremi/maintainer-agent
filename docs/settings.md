# Settings (`settings.yml`)

All of maintainer-agent's behaviour is configured in one YAML file,
`settings.yml`, in the folder mounted at `/config`. The idea, borrowed from
[Frigate](https://docs.frigate.video/configuration/), is that a person or an
LLM can write `docker-compose.yml`, `settings.yml` and `secrets.yaml` for any
number of repositories; installing the GitHub App on them is then the only
manual step.

- Example: [settings.example.yml](settings.example.yml) (also what the server
  writes on a fresh installation).
- JSON Schema: [settings.schema.json](settings.schema.json), also served at
  `/settings/schema.json`. Editors with the YAML language server (VS Code…)
  validate and complete the file through the `# yaml-language-server:
  $schema=…` line at its top.
- Writing the files with an LLM: [llm-setup.md](llm-setup.md).

## Files

```
/config                      CONFIG_DIR (mount it read-write)
  settings.yml               the configuration (versioned, see below)
  secrets.yaml               optional: MA_NAME: value  (mode 600)
  backups/                   copies made before each migration and each save (last 20)
/srv/maintainer-agent        DATA_DIR: state.db (jobs, deliveries), job folders
```

The container's environment only says where things are: `CONFIG_DIR`
(default `/config`), `DATA_DIR` (default `/srv/maintainer-agent`, mounted at
the same path on the host), `PORT` (default 3000), plus secrets (below).

## Applying changes

Settings are read when the server starts. Changing them means restarting it:

- **From `/admin/settings`**: the editor shows the file as written.
  **Validate** checks it without saving. **Save and restart** validates it,
  keeps a backup in `backups/`, writes it atomically, and restarts the server
  (the process exits and Docker's `restart: unless-stopped` starts it again).
  Running jobs are interrupted and resume after the restart.
- **On disk**: edit the file, then `docker compose restart`.

A few actions also write to the file and restart: registering a GitHub App
(adds it under `connections`, its keys to `secrets.yaml`) and confirming its
logo was uploaded.

## Validation and safe mode

```bash
docker run --rm -v ./config:/config louisremi/maintainer-agent-server validate-config
# exit 0: valid; exit 1: the problems, with line:column
```

Validation checks the YAML syntax, the schema (types, allowed values, unknown
keys), the secrets (every placeholder must resolve) and the references
(model and connection names). Errors are reported with their line and
column.

If the file is invalid when the server starts, it starts in **safe mode**:
`/admin` and the editor work and show the problems, webhooks are answered
with 503 (so GitHub delivers them again later), and no job runs. Fix the
file and restart.

## Versions and migrations

`version` is the schema version of the file. When the server starts with an
older file, it copies it to `backups/settings.<time>.v<N>.yml`, applies the
migrations one version at a time (keeping your comments where it can) and
writes the result. A file newer than the server, or a read-only file that
needs migrating, starts the server in safe mode.

| From | To | Change |
| --- | --- | --- |
| none | 1 | Creates `settings.yml`. When upgrading from v0.2, imports the configuration from the environment variables (`PUBLIC_URL`, `LLM_*`, `MAX_*`, `ALLOWED_ACCOUNTS`, `GITHUB_*`…) and the database (GitHub Apps and enabled repositories); secrets go to `secrets.yaml`. Those variables can then be removed. A file without `version` is stamped `version: 1`. |

## Secrets

Fields marked *secret* below take a placeholder: the whole value is
`{MA_NAME}` (quoted in YAML). Placeholders anywhere else are errors, so
`settings.yml` holds no secret and can be shared or generated. Values come
from, in order of precedence (the first that defines a name wins, and a
warning names the source used when several do):

1. Docker secrets: a file named `MA_NAME` in `/run/secrets` (or
   `$CREDENTIALS_DIRECTORY`);
2. the container's environment: `MA_NAME=…`;
3. `secrets.yaml` next to `settings.yml`: a flat map `MA_NAME: value`, names
   starting with `MA_`. The admin pages never show or edit it; they list which
   secrets are in use and where they come from.

An undefined placeholder is a validation error naming the field.

## Layering (defaults and repositories)

Values under `defaults` apply to every repository; an entry under
`repositories.<key>` overrides them **per key**:

- maps merge: `fix: { step_limit: 100 }` keeps the default `fix.enabled`,
  `fix.trigger`…;
- lists replace: a repository's `egress: [pypi.org]` replaces the default
  list, it does not add to it;
- an absent key inherits; to go back to the default, delete the key (writing
  the same value as the default still overrides it).

Every resulting limit is then clamped to `server.limits`.

A repository can also carry its own policy file (`.maintainer-agent.yml` or
`.github/maintainer-agent.yml` on its default branch), written by its
maintainers. It is applied last and can only **narrow** what `settings.yml`
allows: switch features off, lower limits, require the `agent-fix` label,
add checks, links and protected paths, and add egress hosts only when
`allow_repository_egress` is true. It can never switch on what the settings
switched off nor raise a limit.

## Reference

### Top level

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | required | Schema version. |
| `server` | map | required | Server settings (below). |
| `models` | map of name → model | required | Named model endpoints. `default` is required. |
| `connections` | map of id → connection | `{}` | GitHub Apps. The id is the webhook path `/webhooks/<id>`. |
| `defaults` | repository settings | `{}` | Applied to every repository. |
| `repositories` | map of `host/owner/name` → repository settings | `{}` | The repositories the server acts on. Others are ignored (and listed on `/admin` with a snippet to add them). |

### `server`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `public_url` | URL | required | HTTPS URL where GitHub reaches the server. |
| `public_paths_only_via_host` | host | none | Host name of `public_url` on which only webhooks, the app registration callback, `/healthz` and the schema answer; use `/admin` through another address (LAN, VPN). |
| `admin_token` | *secret* | none | Password of `/admin` (any user name). Without it, `/admin` is disabled. |
| `allowed_accounts` | list | `[]` (any) | Accounts (`name` or `host/name`) whose repositories the server serves. Required to create a public app. |
| `runner_image` | string | `louisremi/maintainer-agent:latest` | Image of the agent containers. |
| `docker_pull` | `always` \| `missing` \| `never` | `missing` | Pull the runner image at start. |
| `max_concurrent_jobs` | int | `1` | Agent runs in parallel. |
| `job_retention_days` | int | `14` | Finished jobs and their files are deleted after this. |
| `git_author` | `Name <email>` | `maintainer-agent <maintainer-agent@users.noreply.github.com>` | Author of proposed commits. |
| `limits.max_step_limit` | int | `120` | Most agent steps any job may take. |
| `limits.max_attempts` | int | `5` | Most agent attempts per job. |
| `limits.max_jobs_per_author_per_day` | int | `5` | Automatic jobs per non-maintainer per day. |
| `limits.max_review_comments` | int | `50` | Most inline comments per review. |
| `limits.max_diff_lines` | int | `20000` | Largest diff reviewed line by line. |

### `models.<name>`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `api_base` | URL | required | OpenAI-compatible base URL, e.g. `http://10.0.0.5:8000/v1`. Must be reachable from Docker containers. |
| `model` | string | required | litellm model name, e.g. `openai/<served-model-id>`. |
| `api_key` | *secret* | none | Sent to the endpoint; the only secret agent containers see. |

### `connections.<id>`

Written by `/admin` → **Create the app on GitHub**; you rarely edit them.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `platform` | `github` | `github` | `gitlab` is reserved for a later version. |
| `host` | host | `github.com` | Or a GitHub Enterprise Server host. |
| `display_name` | string | app slug | Shown on `/admin`. |
| `owner_account` | string | none | Organisation the app is registered under. |
| `app_id` | string | required | GitHub App id. |
| `app_slug` | string | required | GitHub App slug. |
| `private_key` | *secret* | required | GitHub App private key (PEM). |
| `webhook_secret` | *secret* | required | GitHub App webhook secret. |
| `appearance_done` | bool | `false` | The app's logo was uploaded (hides the reminder). |

### Repository settings (`defaults` and `repositories.<host/owner/name>`)

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | `false` keeps the entry but pauses the repository. |
| `connection` | id | the one that reaches it | Which connection to act through, when several reach the repository. |
| `model` | name, or `{answer, fix, review}` | `default` | Model for every job, or per job. |
| `answer.enabled` | bool | `true` | Answer new issues. |
| `answer.max_attempts`, `answer.step_limit` | int | `2`, `30` | |
| `fix.enabled` | bool | `true` | Propose draft pull requests for bugs and features. |
| `fix.trigger` | `maintainers` \| `label` | `maintainers` | `maintainers`: automatic for maintainers' issues, `agent-fix` label for others. `label`: always the label. |
| `fix.max_attempts`, `fix.step_limit` | int | `2`, `80` | |
| `review.enabled` | bool | `true` | Review new pull requests (comment only). |
| `review.max_comments` | int | `20` | Inline comments per review. |
| `review.max_diff_lines` | int | `5000` | Larger changes get a summary only. |
| `review.max_attempts`, `review.step_limit` | int | `2`, `40` | |
| `instructions` | list of paths | first of `AGENTS.md`, `CONTRIBUTING.md`, `README.md` | Files the agent reads first (from the default branch). |
| `playbooks.issue`, `playbooks.implement`, `playbooks.review` | path | generic playbooks | Repository playbooks. |
| `checks` | list of commands | `[]` | Commands the fix agent runs to verify a change. |
| `egress` | list of hosts | `[]` | Extra hosts the fix agent may reach (e.g. `registry.npmjs.org`). A `*` may appear in the first label only, followed by at least two plain labels. |
| `links` | list of https prefixes | `[]` | Extra URL prefixes allowed as links in posted text (links to the repository always are). |
| `protected_paths` | list of globs | `[]` | Paths a change must never touch, on top of the forge's automation files and the policy files. |
| `allow_repository_egress` | bool | `true` | Whether the repository's own policy file may add egress hosts. |
