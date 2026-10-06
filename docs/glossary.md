# Glossary (ubiquitous language)

The words used in the code, the docs and the user interface. A term means
the same thing everywhere; forge-specific words (pull request, merge request,
installation...) stay inside the forge adapters.

| Term | Meaning | In the code |
| --- | --- | --- |
| **Forge** | A hosting platform for repositories: GitHub (implemented), GitLab (later). | `Platform` |
| **Connection** | One credentialed link between this server and a forge account, e.g. one GitHub App. A server holds any number; each has its own webhook URL `/webhooks/<connection id>`. | `Connection` (Connections context) |
| **Watched repository** | A repository the server maintains, through exactly one connection (the first that reached it). | `WatchedRepository`, `ClaimPolicy` |
| **Contested repository** | A watched repository that another connection can also reach; that connection's events for it are ignored. | `WatchedRepository.contestedBy` |
| **Repository reference** | Forge, host and path of a repository (`github:github.com/owner/name`, `gitlab:host/group/sub/name`). | `RepoRef` |
| **Issue** | An issue on a watched repository. | `IssueSnapshot` |
| **Change request** | A pull request (GitHub) or merge request (GitLab). | `ChangeRequestSnapshot`, `ForgeTerms` |
| **Maintainer** | Someone with write access or more to the repository. Everyone else is "other". | `Role` |
| **Forge event** | Something that happened on a watched repository, translated into domain terms: issue opened/labelled, change request opened/labelled. | `ForgeEvent` |
| **Maintenance job** | One unit of work on one issue or change request: answer an issue, propose a fix, review a change request. | `MaintenanceJob`, `JobKind` |
| **Event triage** | The rules deciding which forge events become jobs (trust gate, opt-out, caps). Not to be confused with answering an issue. | `EventTriage` |
| **Verdict** | The issue agent's classification (question, bug, feature, other) and its answer. | `Verdict` |
| **Proposed change** | The fix agent's patch plus the title and description of the draft change request. | `ProposedChange` |
| **Review** | The review agent's summary and inline comments; posted as a comment-only review. | `Review`, `InlineComment` |
| **Placement** | Keeping only the inline comments that sit on lines of the diff (the rest goes into the summary). | `InlineCommentPlacement` |
| **Settings** | The operator's configuration, `settings.yml`: server, models, connections, defaults, repositories. Versioned and migrated on start. | `Settings` (settings context) |
| **Effective repository settings** | Built-in values → `defaults` → `repositories.<key>`, clamped to the server limits. | `effectiveRepositorySettings` |
| **Safe mode** | The server's state when `settings.yml` is invalid: admin pages only, nothing processed. | `LoadedSettings` |
| **Repository policy** | The optional `.maintainer-agent.yml` (or `.github/…`, `.gitlab/…`) a repository's maintainers write. Layered on the settings; it can only narrow them. | `RepositoryPolicy`, `RepositoryFilePolicy` |
| **Host limits** | `server.limits` in the settings: maxima nothing else can exceed (steps, attempts, comments, diff size, jobs per author). | `HostLimits`, `ServerLimits` |
| **Agent run** | One sandboxed execution of the model-driven agent; it never sees a forge credential. | `AgentRunner` |
| **Publishing** | Pushing a checked patch to a new `maintainer-agent/*` branch, without any model involved. | `ChangePublisher` |
| **Sanitising** | Neutralising agent text before it is posted (links, images, mentions, markers, secrets); *held* text is not posted. | `OutputSanitizer` |
| **Escalation** | Stopping and asking a human (`needs-human` label and a comment). | `JobEscalated` |
