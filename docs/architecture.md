# Architecture

maintainer-agent's server follows **hexagonal architecture** (ports and
adapters) with **domain-driven design**. The domain and application layers
are plain TypeScript; NestJS, the GitHub API, SQLite, Docker and git live in
adapters at the edge. The rules below are enforced by
[dependency-cruiser](../server/.dependency-cruiser.cjs) (`pnpm arch`), and
[tests/arch-violation.sh](../tests/arch-violation.sh) proves that they fail
on violations.

```
                    ┌──────────────────────── adapters (inbound) ─────────────────────────┐
  GitHub ─webhook─► │ http/webhooks.controller ─► forges/github/github-webhook-ingress     │
  operator ───────► │ http/admin.controller                    worker/job-worker (loop)   │
                    └──────────────┬──────────────────────────────────┬───────────────────┘
                                   ▼                                  ▼
          ┌──────── Connections context ────────┐   ┌──────── Maintenance context (core) ───────┐
          │ application: StartAppRegistration,  │   │ application: HandleForgeEvent, RunNextJob, │
          │   CompleteAppRegistration, Sync…,   │   │   AnswerIssue, ProposeFix,                 │
          │   ResolveRepositoryAccess           │   │   ReviewChangeRequest, RepositoryPolicies  │
          │ domain: Connection, WatchedRepo,    │   │ domain: MaintenanceJob, EventTriage,       │
          │   ClaimPolicy                       │   │   RepositoryPolicy, Verdict, Review, …     │
          └──────────────┬──────────────────────┘   └───────────────┬───────────────────────────┘
                         │ ports                                    │ ports
                    ┌────▼────────────────── adapters (outbound) ───▼─────────────────────────┐
                    │ persistence/sqlite   forges/github (registration, sessions, directory)  │
                    │ crypto   events      forge-access (bridges the two contexts)            │
                    │ sandbox/docker (agents, publisher, sanitiser, policy validator, egress) │
                    │ workspace (git clones)   model-health   system (clock, ids, logger)     │
                    └─────────────────────────────────────────────────────────────────────────┘
                                         bootstrap/ = composition root (Nest modules, main.ts)
```

## Layers

| Layer | Location | May import | Contains |
| --- | --- | --- | --- |
| Shared kernel | `src/shared-kernel/` | nothing | `RepoRef`, `Actor`/`Role`, `Platform`, `DomainEvent`/`AggregateRoot`, `AccountAllowList`, the integration-event shapes, and the `Clock`, `IdGenerator`, `UnitOfWork`, `EventPublisher`, `DeliveryLog`, `Logger` ports |
| Domain | `src/<context>/domain/` | its own domain, the shared kernel | aggregates, value objects, domain services, domain events; no I/O |
| Application | `src/<context>/application/` | its own domain and application, the shared kernel | use cases, ports (interfaces), DTOs |
| Adapters | `src/adapters/<technology>/` | application layers, public domain types, npm, Node | implementations of ports; inbound HTTP and worker |
| Composition root | `src/bootstrap/` | everything | the only place that knows every adapter |

No layer below the adapters imports npm packages or Node built-ins.

## Bounded contexts

**Connections** (supporting): which forge accounts the server is connected to
and which repositories each one reaches.
- `Connection` aggregate: `pending → active ⇄ disabled`. Created by a
  manifest-style registration (`startRegistration` / `completeRegistration`,
  checked against a one-time `state` that expires after an hour) or from
  credentials in the environment (`registerDirectly`).
- `WatchedRepository` aggregate. Invariant: one owning connection per
  repository; `ClaimPolicy` gives a repository to the first connection that
  reaches it and records later ones as contenders.
- Ports: `ConnectionRepository`, `WatchedRepositoryRepository`,
  `AppRegistrationGateway(s)`, `ForgeDirectory(ies)`, `SecretGenerator`.

**Maintenance** (core domain): what to do about forge events, and doing it.
- `MaintenanceJob` aggregate: `queued → running → succeeded | failed |
  needs-human`, with infrastructure retries (`retryLater`, exponential
  back-off) separate from agent attempts (`agentFailed`, bounded by the
  repository policy).
- Domain services: `EventTriage` (the trust gate, pure), `FixEligibility`,
  `DuplicateJobPolicy`, `InlineCommentPlacement` with `DiffHunks`.
- Value objects: `RepositoryPolicy` (clamped to `HostLimits`), `Verdict`,
  `ProposedChange`, `Review`, `ForgeEvent`.
- Ports: `MaintenanceJobRepository`, `ForgeAccess`/`ForgeSession`,
  `PolicyValidator`, `WorkspacePreparer`, `AgentRunner`, `ChangePublisher`,
  `OutputSanitizer`, `ModelCatalog`, `ModelHealth`.

The contexts never import each other. They meet in two places:
- `adapters/forge-access/connection-backed-forge-access.ts` implements
  Maintenance's `ForgeAccess` by asking Connections which credentials own a
  repository, then asking a forge adapter for a session;
- integration events: Connections publishes `connections.repository-watched`
  (shape in the shared kernel), Maintenance reacts by creating its labels.

## Flows

**Webhook → job.** `WebhooksController` → `GithubWebhookIngress` (verifies the
signature with that connection's secret, records the delivery once,
`GithubEventTranslator` turns the payload into a `ForgeEvent` or a repository
list) → `HandleForgeEvent` (loads the policy, resolves the label actor's role,
`EventTriage`, `DuplicateJobPolicy`, saves a queued job) → `JobQueued`.

**Job → result.** `JobWorker` → `RunNextJob` (only while the model is
reachable; claims the oldest due job, loads the policy again, picks the
handler) → `AnswerIssue` | `ProposeFix` | `ReviewChangeRequest` → a
`JobResult` (`succeeded` with an optional follow-up job, `agent-failed`,
`transient`, `escalate`) applied to the aggregate → events published after
the save (`JobEscalated` → `needs-human` label and comment).

## Units of work and events

`UnitOfWork.run` wraps persistence only (SQLite `BEGIN IMMEDIATE`, nested
calls join, concurrent ones are serialised); use cases never hold it across
network calls or agent runs. Aggregates record events; use cases publish them
after saving (`InProcessEventBus`). A message broker could replace the bus
behind `EventPublisher` without touching the core.

## Adding a forge

See [forges.md](forges.md): a forge is new adapters (registration or
connection gateway, directory, session factory, event translator, webhook
ingress) and a line in the composition root. Domain, application and runner
do not change.

## Adding an agent backend

`AgentRunner`, `ChangePublisher`, `OutputSanitizer` and `PolicyValidator`
are ports. The Docker implementations share `DockerSandbox`; another backend
(e.g. Kubernetes, or [google/ax](https://github.com/google/ax) once it
supports OpenAI-compatible models) implements the same ports and keeps the
same isolation contract: no forge credential next to the model, egress
limited to the model (plus policy hosts for fixes), outputs read back as
untrusted.
