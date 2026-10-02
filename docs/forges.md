# Forges

A *forge* is a hosting platform. GitHub is implemented; the design keeps
GitLab (and others) a matter of new adapters only. Nothing outside
`server/src/adapters/forges/<name>/` and the composition root may know a
forge's vocabulary (pull requests, installations, author associations...).

## The contract

A forge implementation provides:

| Piece | Port / contract | GitHub implementation |
| --- | --- | --- |
| Registering a connection | `AppRegistrationGateway` (Connections) | `GithubAppRegistrationGateway`: App Manifest flow |
| Listing reachable repositories | `ForgeDirectory` (Connections) | `GithubDirectory`: every installation's repositories |
| Acting on one repository | `ForgeSession` (Maintenance), opened by a `ForgeSessionFactory` | `GithubForgeSession` with installation tokens limited to one repository and the permissions of each step |
| Receiving events | `WebhookIngress` (`adapters/forges/forge-ingress.ts`) | `GithubWebhookIngress`: `X-Hub-Signature-256` with the connection's secret, `X-GitHub-Delivery` dedupe |
| Translating events | anti-corruption layer producing `ForgeEvent`s | `GithubEventTranslator` |
| Words | `ForgeTerms` | "pull request", "PR", `#n` |
| Automation paths | `ForgeSession.protectedPaths` | `.github/**` |

A `ForgeSession` must:
- return snapshots in domain terms (`Role` is `maintainer` for write access
  or more);
- never expose a credential except through `gitAccess(scope)`, which returns
  an `Authorization` header value for git over HTTPS and the hosts a git
  client needs (for the publisher's egress allow-list);
- open change requests as **drafts** and post reviews that only comment.

The [GitHub adapter tests](../server/test/adapters/github.test.ts) show the
behaviour each piece needs; a new forge should get the same set.

## GitHub

- **One app per account.** A private GitHub App can only be installed on the
  account that owns it. Watch repositories of several accounts by adding one
  app per account from `/admin`, or one public app restricted with
  `ALLOWED_ACCOUNTS`.
- **GitHub Enterprise Server** works the same way (enter its host on
  `/admin`); the API is `https://<host>/api/v3`. Not tested against a real
  GHES yet.
- **Permissions:** contents, issues and pull requests: write; metadata: read.
  Never workflows, actions, administration, environments or secrets. The
  agent's pushes therefore cannot change workflow files; `.github/**` is also
  rejected by the publisher.
- **Events:** `issues` and `pull_request` (plus `installation` and
  `installation_repositories`, which every app receives).
- **Tokens:** installation tokens are minted per repository and scope:
  `read` (contents read), `write-issues` (issues and pull requests write, used
  in the server process only), `push` (contents write, given only to the
  publisher container).

## GitLab (design notes, not implemented)

GitLab has no equivalent of GitHub Apps with installations, so a GitLab
connection is configured rather than registered:

- **Connection:** the operator enters the host, a bot credential (a group or
  project access token with `api` scope, role Developer) and the projects or
  groups to watch on `/admin`. A `GitlabConnectionGateway` validates the token
  and registers a project webhook (Issues, Merge request and Note events) on
  each project, pointing to `/webhooks/<connection id>` with a generated
  secret token. Group webhooks would avoid per-project hooks but require a
  paid tier; to be checked.
- **Directory:** the projects the token can reach as Developer or more,
  intersected with the operator's selection.
- **Ingress:** verify `X-Gitlab-Token` with a constant-time comparison; dedupe
  on `X-Gitlab-Event-UUID`.
- **Translator:** `issue` hooks (`action: open`, label changes from
  `changes.labels`) and `merge_request` hooks (`open`, draft →
  ready, label changes) become the same `ForgeEvent`s. Author roles come from
  the member access level (Developer = 30 and above → maintainer).
- **Session:** `ForgeTerms` = "merge request", "MR", `!n`; draft merge
  requests (`draft: true`); inline review comments are MR discussions with a
  `position` (`base_sha`, `start_sha`, `head_sha`, `new_path`/`new_line` or
  `old_path`/`old_line`) plus one overall note; git over HTTPS with
  `Authorization: Basic base64(oauth2:<token>)`; protected paths
  `.gitlab-ci.yml`, `.gitlab/**`; head commits fetched from
  `refs/merge-requests/<iid>/head`.
- **Residual risk:** GitLab tokens cannot be narrowed per job. The token stays
  in the server and in the publisher container, never in an agent container;
  use a dedicated bot account, protect the default branch, and restrict the
  bot to pushing `maintainer-agent/*` with push rules.
- `RepoRef` already supports nested groups (`group/sub/project`) and
  `RepositoryPolicy` already looks for `.gitlab/maintainer-agent.yml`.
