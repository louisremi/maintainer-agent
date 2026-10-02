import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { AccountAllowList, Logger } from '../shared-kernel';
import {
  CompleteAppRegistration,
  ConnectionsDeps,
  ConnectionsError,
  GetConnectionAccess,
  ListConnections,
  PruneExpiredRegistrations,
  RegisterConfiguredConnection,
  RemoveConnection,
  ResolveRepositoryAccess,
  ResyncAllConnections,
  ResyncConnection,
  SetConnectionEnabled,
  SetRepositoryEnabled,
  StartAppRegistration,
  SyncConnectionRepositories,
} from '../connections/application';
import {
  AnswerIssue,
  ChangePublisher,
  HandleForgeEvent,
  ListRecentJobs,
  MaintenanceEventHandlers,
  OutputSanitizer,
  PolicyValidator,
  ProposeFix,
  PruneHistory,
  RecoverInterruptedJobs,
  RepositoryPolicies,
  ReviewChangeRequest,
  RunNextJob,
  AgentRunner,
  WorkspacePreparer,
  ModelHealth,
} from '../maintenance/application';
import { HostLimits } from '../maintenance/domain';
import { ServerConfig } from '../adapters/config/server-config';
import { AesGcmSecretCipher, PlaintextSecretCipher, SecretCipher } from '../adapters/crypto/secret-cipher';
import { InProcessEventBus } from '../adapters/events/in-process-event-bus';
import { ConnectionBackedForgeAccess } from '../adapters/forge-access/connection-backed-forge-access';
import {
  GithubAppClients,
  GithubAppRegistrationGateway,
  GithubDirectory,
  GithubSessionFactory,
  GithubWebhookIngress,
} from '../adapters/forges/github';
import type { WebhookIngress } from '../adapters/forges/forge-ingress';
import type { AdminApplication, HealthProbe } from '../adapters/http';
import { HttpModelHealth, StaticModelCatalog } from '../adapters/model-health/http-model-health';
import {
  openDatabase,
  SqliteConnectionRepository,
  SqliteDeliveryLog,
  SqliteJobRepository,
  SqliteUnitOfWork,
  SqliteWatchedRepositoryRepository,
} from '../adapters/persistence/sqlite';
import {
  ContainerEngine,
  DockerAgentRunner,
  DockerChangePublisher,
  DockerodeEngine,
  DockerOutputSanitizer,
  DockerPolicyValidator,
  DockerSandbox,
} from '../adapters/sandbox/docker';
import { CryptoSecretGenerator, JsonLogger, SystemClock, TimeOrderedIds } from '../adapters/system/system';
import { JobWorker, PeriodicTask } from '../adapters/worker/job-worker';
import { GitWorkspacePreparer } from '../adapters/workspace/git-workspace-preparer';

/** Adapters a test (or another deployment) may replace. */
export interface Overrides {
  fetch?: typeof fetch;
  engine?: ContainerEngine;
  workspaces?: WorkspacePreparer;
  agents?: AgentRunner;
  publisher?: ChangePublisher;
  sanitizer?: OutputSanitizer;
  policyValidator?: PolicyValidator;
  modelHealth?: ModelHealth;
  logger?: Logger;
  databaseFile?: string;
}

export interface App {
  readonly config: ServerConfig;
  readonly log: Logger;
  readonly db: Database.Database;
  readonly adminToken: string;
  readonly webhooks: WebhookIngress;
  readonly admin: AdminApplication;
  readonly health: HealthProbe;
  readonly worker: JobWorker;
  readonly periodic: PeriodicTask[];
  readonly runNextJob: RunNextJob;
  readonly secretCipher: SecretCipher;
  /** Start-up work: env connection, crash recovery, leftover containers. */
  init(): Promise<void>;
  close(): Promise<void>;
}

/** Reads or creates the admin token (printed once on first start). */
function adminToken(config: ServerConfig, log: Logger): string {
  if (config.ADMIN_TOKEN) return config.ADMIN_TOKEN;
  const file = join(config.DATA_DIR, 'admin-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = new CryptoSecretGenerator().token(24);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  log.warn('generated an admin token; open /admin with any user name and this password (also stored in DATA_DIR/admin-token)', { adminPassword: token, file });
  // The logger redacts *token* fields; print the value itself once, plainly.
  process.stdout.write(`\n  maintainer-agent admin password: ${token}\n\n`);
  return token;
}

/** The composition root: the only place that knows every adapter. */
export function buildApp(config: ServerConfig, o: Overrides = {}): App {
  const log = o.logger ?? new JsonLogger();
  mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(join(config.DATA_DIR, 'jobs'), { recursive: true });
  const db = openDatabase(o.databaseFile ?? join(config.DATA_DIR, 'state.db'));
  const uow = new SqliteUnitOfWork(db);
  const clock = new SystemClock();
  const ids = new TimeOrderedIds();
  const events = new InProcessEventBus(log);
  const secretCipher: SecretCipher = config.SECRETS_KEY ? new AesGcmSecretCipher(config.SECRETS_KEY) : new PlaintextSecretCipher();
  const fetchImpl = o.fetch ?? fetch;

  const limits: HostLimits = {
    maxStepLimit: config.MAX_STEP_LIMIT,
    maxAttemptsCap: config.MAX_ATTEMPTS_CAP,
    maxJobsPerAuthorPerDay: config.MAX_JOBS_PER_AUTHOR_PER_DAY,
    maxReviewComments: config.MAX_REVIEW_COMMENTS,
    maxDiffLines: config.MAX_DIFF_LINES,
  };

  // ---- Connections context
  const githubClients = new GithubAppClients(fetchImpl);
  const githubRegistration = new GithubAppRegistrationGateway(config.PUBLIC_URL, fetchImpl);
  const githubDirectory = new GithubDirectory(githubClients);
  const connectionsDeps: ConnectionsDeps = {
    connections: new SqliteConnectionRepository(db, secretCipher),
    repositories: new SqliteWatchedRepositoryRepository(db),
    gateways: { for: (p) => { if (p !== 'github') throw new Error(`no registration for ${p}`); return githubRegistration; } },
    directories: { for: (p) => { if (p !== 'github') throw new Error(`no directory for ${p}`); return githubDirectory; } },
    secrets: new CryptoSecretGenerator(),
    ids,
    clock,
    uow,
    events,
    log,
  };
  const resolveAccess = new ResolveRepositoryAccess(connectionsDeps);
  const sync = new SyncConnectionRepositories(connectionsDeps);
  const getAccess = new GetConnectionAccess(connectionsDeps);

  // ---- Sandbox
  const engine = o.engine ?? new DockerodeEngine();
  const sandbox = new DockerSandbox(engine, { runnerImage: config.RUNNER_IMAGE, namePrefix: 'ma-' }, async (path, data) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, data);
  });

  // ---- Maintenance context
  const forge = new ConnectionBackedForgeAccess(resolveAccess, { github: new GithubSessionFactory(githubClients) });
  const jobs = new SqliteJobRepository(db);
  const deliveries = new SqliteDeliveryLog(db);
  const policies = new RepositoryPolicies(o.policyValidator ?? new DockerPolicyValidator(sandbox, limits), limits, log);
  const models = new StaticModelCatalog(
    { apiBase: config.LLM_API_BASE, model: config.LLM_MODEL },
    {
      ...(config.LLM_MODEL_ISSUE ? { 'answer-issue': config.LLM_MODEL_ISSUE } : {}),
      ...(config.LLM_MODEL_FIX ? { 'propose-fix': config.LLM_MODEL_FIX } : {}),
      ...(config.LLM_MODEL_REVIEW ? { 'review-change-request': config.LLM_MODEL_REVIEW } : {}),
    },
  );
  const modelHealth = o.modelHealth ?? new HttpModelHealth(models.all(), config.LLM_API_KEY ?? null, fetchImpl);
  const workspaces = o.workspaces ?? new GitWorkspacePreparer(config.DATA_DIR);
  const agents = o.agents ?? new DockerAgentRunner(sandbox, {
    dataDir: config.DATA_DIR,
    modelEnv: config.LLM_API_KEY ? { LLM_API_KEY: config.LLM_API_KEY } : {},
    memoryMb: { issue: 4096, fix: 8192, review: 4096 },
    timeoutMs: { issue: 60 * 60_000, fix: 5 * 60 * 60_000, review: 90 * 60_000 },
  });
  const publisher = o.publisher ?? new DockerChangePublisher(sandbox, { dataDir: config.DATA_DIR, gitAuthor: config.GIT_AUTHOR });
  const sanitizer = o.sanitizer ?? new DockerOutputSanitizer(sandbox);
  const common = { workspaces, agents, sanitizer, models, log };
  const runNextJob = new RunNextJob({
    jobs, forge, policies, modelHealth, ids, clock, uow, events, log,
    maxRuns: 4,
    retryDelayMs: 5 * 60_000,
    handlers: [
      new AnswerIssue({ ...common, stepLimit: config.ISSUE_STEP_LIMIT }),
      new ProposeFix({ ...common, publisher }),
      new ReviewChangeRequest({ ...common, stepLimit: config.REVIEW_STEP_LIMIT }),
    ],
  });
  const handleEvent = new HandleForgeEvent({
    forge, policies, jobs, allowList: AccountAllowList.parse(config.ALLOWED_ACCOUNTS), limits, ids, clock, uow, events, log,
  });
  const worker = new JobWorker(runNextJob, config.MAX_CONCURRENT_JOBS, log);

  // ---- Cross-context reactions
  const maintenanceHandlers = new MaintenanceEventHandlers(forge, log);
  events.subscribe((e) => maintenanceHandlers.handle(e));
  events.subscribe(async (e) => { if (e.type === 'maintenance.job-queued') worker.poke(); });

  // ---- Inbound adapters' application facades
  const webhooks = new GithubWebhookIngress(
    {
      connectionAccess: (id) => getAccess.execute(id),
      handleEvent: (connectionId, event) => handleEvent.execute({ connectionId, event }),
      syncRepositories: (input) => sync.execute(input),
    },
    deliveries,
    clock,
    log,
  );
  const listConnections = new ListConnections(connectionsDeps);
  const listJobs = new ListRecentJobs(jobs);
  const admin: AdminApplication = {
    overview: async () => ({
      connections: await listConnections.execute(),
      jobs: await listJobs.execute(50),
      modelAvailable: await modelHealth.isAvailable(),
      publicUrl: config.PUBLIC_URL,
      secretsEncrypted: secretCipher.encrypts,
    }),
    startGithubRegistration: async (input) => {
      if (input.isPublic && AccountAllowList.parse(config.ALLOWED_ACCOUNTS).isUnrestricted) {
        // Anyone could install a public app and use this server's model.
        throw new ConnectionsError('a public app needs ALLOWED_ACCOUNTS: set it to the accounts this server may serve', 'invalid');
      }
      return (await new StartAppRegistration(connectionsDeps).execute({ platform: 'github', ...input })).form;
    },
    completeGithubRegistration: async (input) => {
      const r = await new CompleteAppRegistration(connectionsDeps).execute(input);
      return { installUrl: r.installUrl };
    },
    resync: (connectionId) => new ResyncConnection(connectionsDeps).execute({ connectionId }),
    setRepositoryEnabled: (repoKey, enabled) => new SetRepositoryEnabled(connectionsDeps).execute({ repoKey, enabled }),
    setConnectionEnabled: (connectionId, enabled) => new SetConnectionEnabled(connectionsDeps).execute({ connectionId, enabled }),
    removeConnection: (connectionId) => new RemoveConnection(connectionsDeps).execute({ connectionId }),
  };
  const health: HealthProbe = {
    check: async () => {
      try {
        db.prepare('SELECT 1').get();
        return { ok: true, details: {} };
      } catch (err) {
        return { ok: false, details: { database: (err as Error).message } };
      }
    },
  };
  const retentionMs = config.JOB_RETENTION_DAYS * 24 * 60 * 60_000;
  const periodic: PeriodicTask[] = [
    { name: 'resync-connections', everyMs: 6 * 60 * 60_000, run: () => new ResyncAllConnections(connectionsDeps).execute() },
    { name: 'prune-registrations', everyMs: 30 * 60_000, run: () => new PruneExpiredRegistrations(connectionsDeps).execute() },
    { name: 'prune-history', everyMs: 6 * 60 * 60_000, run: () => new PruneHistory(jobs, workspaces, deliveries, clock, retentionMs).execute() },
  ];

  const token = adminToken(config, log);

  return {
    config, log, db, adminToken: token, webhooks, admin, health, worker, periodic, runNextJob, secretCipher,
    async init() {
      if (!secretCipher.encrypts) log.warn('SECRETS_KEY is not set: app credentials are stored unencrypted (the database file is still mode 600)');
      if (config.GITHUB_APP_ID && config.GITHUB_PRIVATE_KEY && config.GITHUB_WEBHOOK_SECRET) {
        await new RegisterConfiguredConnection(connectionsDeps).execute({
          id: 'env',
          platform: 'github',
          host: config.GITHUB_HOST,
          displayName: config.GITHUB_APP_SLUG ?? `GitHub App ${config.GITHUB_APP_ID}`,
          ownerAccount: null,
          credentials: {
            appId: config.GITHUB_APP_ID,
            appSlug: config.GITHUB_APP_SLUG ?? '',
            botLogin: config.GITHUB_APP_SLUG ? `${config.GITHUB_APP_SLUG}[bot]` : '',
            secrets: { privateKey: config.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'), webhookSecret: config.GITHUB_WEBHOOK_SECRET },
          },
        });
        log.info('GitHub App from the environment registered as connection "env"', { webhook: `${config.PUBLIC_URL}/webhooks/env` });
      }
      await new RecoverInterruptedJobs(jobs, clock, log).execute();
      if (!o.engine) {
        const removed = await engine.removeManaged('ma-').catch(() => 0);
        if (removed) log.warn('removed leftover sandbox containers and networks', { count: removed });
        if (config.DOCKER_PULL !== 'never') {
          await engine.pull(config.RUNNER_IMAGE).catch((err: Error) => {
            log.warn('could not pull the runner image; using the local copy if any', { image: config.RUNNER_IMAGE, reason: err.message });
          });
        }
      }
    },
    async close() {
      await worker.stop();
      db.close();
    },
  };
}
