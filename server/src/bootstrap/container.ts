import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import {
	LEGACY_VARIABLES,
	type ServerConfig,
} from "../adapters/config/server-config";
import {
	AesGcmSecretCipher,
	PlaintextSecretCipher,
	type SecretCipher,
} from "../adapters/crypto/secret-cipher";
import { InProcessEventBus } from "../adapters/events/in-process-event-bus";
import { ConnectionBackedForgeAccess } from "../adapters/forge-access/connection-backed-forge-access";
import type { WebhookIngress } from "../adapters/forges/forge-ingress";
import {
	GithubAppClients,
	GithubAppRegistrationGateway,
	GithubDirectory,
	GithubSessionFactory,
	GithubWebhookIngress,
} from "../adapters/forges/github";
import type { AdminApplication, HealthProbe } from "../adapters/http";
import { HttpModelHealth } from "../adapters/model-health/http-model-health";
import {
	openDatabase,
	SqliteConnectionRepository,
	SqliteDeliveryLog,
	SqliteJobRepository,
	SqliteUnitOfWork,
	SqliteWatchedRepositoryRepository,
} from "../adapters/persistence/sqlite";
import {
	type ContainerEngine,
	DockerAgentRunner,
	DockerChangePublisher,
	DockerOutputSanitizer,
	DockerodeEngine,
	DockerPolicyValidator,
	DockerSandbox,
} from "../adapters/sandbox/docker";
import {
	loadSecretSources,
	type SecretLookup,
} from "../adapters/secrets/secret-sources";
import {
	hostLimits,
	SettingsRepositoryConfigurations,
	settingsKey,
} from "../adapters/settings-bridge/repository-configurations";
import {
	addConnection,
	setConnectionField,
} from "../adapters/settings-file/document-edits";
import { FsSettingsFile } from "../adapters/settings-file/fs-settings-file";
import {
	buildLegacyImport,
	hasLegacyConfiguration,
	type LegacyState,
} from "../adapters/settings-file/legacy-import";
import { YamlSettingsMigrations } from "../adapters/settings-file/migrations";
import { upsertSecrets } from "../adapters/settings-file/secrets-file";
import { YamlSettingsParser } from "../adapters/settings-file/yaml-settings-parser";
import {
	CryptoSecretGenerator,
	JsonLogger,
	SystemClock,
	TimeOrderedIds,
} from "../adapters/system/system";
import { JobWorker, type PeriodicTask } from "../adapters/worker/job-worker";
import { GitWorkspacePreparer } from "../adapters/workspace/git-workspace-preparer";
import {
	CompleteAppRegistration,
	type ConnectionsDeps,
	ConnectionsError,
	GetConnectionAccess,
	ListConnections,
	PruneExpiredRegistrations,
	ResolveRepositoryAccess,
	ResyncAllConnections,
	ResyncConnection,
	StartAppRegistration,
	SyncConfiguredConnections,
	SyncConnectionRepositories,
} from "../connections/application";
import {
	type AgentRunner,
	AnswerIssue,
	type ChangePublisher,
	HandleForgeEvent,
	ListRecentJobs,
	MaintenanceEventHandlers,
	type ModelHealth,
	type OutputSanitizer,
	type PolicyValidator,
	ProposeFix,
	PruneHistory,
	RecoverInterruptedJobs,
	RepositoryPolicies,
	ReviewChangeRequest,
	RunNextJob,
	type WorkspacePreparer,
} from "../maintenance/application";
import {
	EditSettings,
	type LoadedSettings,
	LoadSettings,
	type ProcessControl,
	SaveSettingsText,
	ValidateSettingsText,
} from "../settings/application";
import {
	type Settings,
	type SettingsIssue,
	secretName,
} from "../settings/domain";
import { AccountAllowList, type Logger, RepoRef } from "../shared-kernel";

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
	processControl?: ProcessControl;
	env?: NodeJS.ProcessEnv;
}

/** What the admin pages need about the settings file. */
export interface SettingsAdmin {
	readonly path: string;
	readonly mode: "normal" | "safe";
	readonly issues: readonly SettingsIssue[];
	readonly migratedFrom: number | null;
	text(): Promise<string>;
	validate(
		text: string,
	): { ok: true } | { ok: false; issues: readonly SettingsIssue[] };
	save(
		text: string,
	): Promise<{ ok: true } | { ok: false; issues: readonly SettingsIssue[] }>;
	/** Where each secret comes from (names and sources only). */
	secretSources(): { name: string; source: string }[];
}

export interface App {
	readonly config: ServerConfig;
	readonly settings: Settings | null;
	readonly log: Logger;
	readonly db: Database.Database;
	readonly adminToken: string | null;
	readonly publicPathsOnlyViaHost: string | null;
	readonly webhooks: WebhookIngress;
	readonly admin: AdminApplication;
	readonly settingsAdmin: SettingsAdmin;
	readonly health: HealthProbe;
	readonly worker: JobWorker;
	readonly periodic: PeriodicTask[];
	readonly runNextJob: RunNextJob | null;
	readonly secretCipher: SecretCipher;
	init(): Promise<void>;
	close(): Promise<void>;
}

/** Stops the process after the HTTP response went out; Docker restarts it. */
export class ExitProcessControl implements ProcessControl {
	private requested = false;
	constructor(
		private readonly log: Logger,
		private readonly beforeExit: () => Promise<void>,
	) {}
	requestRestart(reason: string): void {
		if (this.requested) return;
		this.requested = true;
		this.log.warn("restarting to apply new settings", { reason });
		setTimeout(() => {
			void this.beforeExit()
				.catch(() => undefined)
				.finally(() => process.exit(0));
		}, 500);
	}
}

function settingsPaths(config: ServerConfig) {
	return {
		settings: join(config.CONFIG_DIR, "settings.yml"),
		secrets: join(config.CONFIG_DIR, "secrets.yaml"),
	};
}

/** Text of a brand-new settings file: the documented example. */
async function defaultSettingsText(): Promise<string> {
	return readFile(
		resolve(__dirname, "../../assets/settings.default.yml"),
		"utf8",
	);
}

/**
 * Reads, migrates and validates settings.yml. Before v0.3 the configuration
 * lived in environment variables and the database: the first migration
 * imports it from there (the database is opened read-only for that).
 */
export async function loadServerSettings(
	config: ServerConfig,
	o: Overrides = {},
): Promise<{
	loaded: LoadedSettings;
	secrets: () => SecretLookup;
	file: FsSettingsFile;
	parser: YamlSettingsParser;
	migrations: YamlSettingsMigrations;
}> {
	const env = o.env ?? process.env;
	const log = o.logger ?? new JsonLogger();
	const paths = settingsPaths(config);
	mkdirSync(config.CONFIG_DIR, { recursive: true });
	const file = new FsSettingsFile(paths.settings);
	const secrets = () => loadSecretSources({ env, secretsFile: paths.secrets });
	const parser = new YamlSettingsParser(secrets);
	const migrations = new YamlSettingsMigrations(async () => {
		const state = legacyState(config, env, o.databaseFile);
		if (!hasLegacyConfiguration(state)) return defaultSettingsText();
		const imported = buildLegacyImport(state);
		await upsertSecrets(paths.secrets, imported.secrets);
		log.warn(
			"created settings.yml from the v0.2 environment variables and database; remove those variables from docker-compose.yml",
			{ path: paths.settings, secrets: Object.keys(imported.secrets) },
		);
		return imported.text;
	});
	const loaded = await new LoadSettings({
		file,
		migrations,
		parser,
		log,
		initialText: async () => {
			// No settings.yml yet: an upgrade from v0.2 imports its configuration.
			const state = legacyState(config, env, o.databaseFile);
			return hasLegacyConfiguration(state) ? "" : defaultSettingsText();
		},
	}).execute();
	for (const d of secrets().duplicates) {
		log.warn(
			`${d.name} is defined in more than one place, using the value from ${d.used}`,
			{ ignored: d.ignored },
		);
	}
	if (loaded.mode === "normal") {
		const stillSet = LEGACY_VARIABLES.filter((v) => env[v] !== undefined);
		if (stillSet.length)
			log.warn(
				"these environment variables are ignored since v0.3 (settings.yml replaces them)",
				{ variables: stillSet },
			);
	}
	return { loaded, secrets, file, parser, migrations };
}

function legacyState(
	config: ServerConfig,
	env: NodeJS.ProcessEnv,
	databaseFile?: string,
): LegacyState {
	const dbPath = databaseFile ?? join(config.DATA_DIR, "state.db");
	const connections: LegacyState["connections"][number][] = [];
	const enabledRepositories: string[] = [];
	if (dbPath !== ":memory:") {
		try {
			const db = openDatabase(dbPath);
			const cipher = config.secretsKey
				? new AesGcmSecretCipher(config.secretsKey)
				: new PlaintextSecretCipher();
			const repo = new SqliteConnectionRepository(db, cipher);
			const rows = db
				.prepare("SELECT id FROM connections WHERE status = 'active'")
				.all() as { id: string }[];
			for (const { id } of rows) {
				const c = repo.getSync(id);
				if (!c?.credentials) continue;
				connections.push({
					id,
					host: c.host,
					displayName: c.displayName,
					ownerAccount: c.ownerAccount,
					appId: c.credentials.appId,
					appSlug: c.credentials.appSlug,
					privateKey: c.credentials.secrets.privateKey ?? "",
					webhookSecret: c.credentials.secrets.webhookSecret ?? "",
					appearanceDone: c.appearanceDone,
				});
			}
			const repos = db
				.prepare("SELECT repo_key FROM watched_repositories WHERE enabled = 1")
				.all() as { repo_key: string }[];
			for (const r of repos) enabledRepositories.push(r.repo_key);
			db.close();
		} catch {
			// No database yet: a fresh installation.
		}
	}
	const fromEnv = { ...env };
	if (
		env.GITHUB_APP_ID &&
		env.GITHUB_PRIVATE_KEY &&
		env.GITHUB_WEBHOOK_SECRET &&
		!connections.some((c) => c.id === "env")
	) {
		connections.push({
			id: "env",
			host: env.GITHUB_HOST ?? "github.com",
			displayName: env.GITHUB_APP_SLUG ?? `GitHub App ${env.GITHUB_APP_ID}`,
			ownerAccount: null,
			appId: env.GITHUB_APP_ID,
			appSlug: env.GITHUB_APP_SLUG ?? "",
			privateKey: env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
			webhookSecret: env.GITHUB_WEBHOOK_SECRET,
			appearanceDone: false,
		});
	}
	return { env: fromEnv, connections, enabledRepositories };
}

/** The composition root: the only place that knows every adapter. */
export async function buildApp(
	config: ServerConfig,
	o: Overrides = {},
): Promise<App> {
	const log = o.logger ?? new JsonLogger();
	const env = o.env ?? process.env;
	const { loaded, secrets, file, parser, migrations } =
		await loadServerSettings(config, { ...o, logger: log, env });
	const settings = loaded.mode === "normal" ? loaded.settings : null;
	if (loaded.mode === "safe") {
		log.error(
			"settings.yml is invalid: starting in safe mode (no events or jobs are processed until it is fixed)",
			{
				path: file.path,
				issues: loaded.issues.map((i) => i.message),
			},
		);
	}

	mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(join(config.DATA_DIR, "jobs"), { recursive: true });
	const db = openDatabase(o.databaseFile ?? join(config.DATA_DIR, "state.db"));
	const uow = new SqliteUnitOfWork(db);
	const clock = new SystemClock();
	const ids = new TimeOrderedIds();
	const events = new InProcessEventBus(log);
	const secretCipher: SecretCipher = config.secretsKey
		? new AesGcmSecretCipher(config.secretsKey)
		: new PlaintextSecretCipher();
	const fetchImpl = o.fetch ?? fetch;
	const publicUrl = settings?.server.publicUrl ?? "http://localhost";
	const adminToken =
		settings?.server.adminToken ??
		(loaded.mode === "safe" ? safeModeAdminToken(env, secrets) : null);

	let worker!: JobWorker;
	let httpClose: () => Promise<void> = async () => undefined;
	const processControl =
		o.processControl ??
		new ExitProcessControl(log, async () => {
			await httpClose();
			await worker.stop();
			db.close();
		});
	const validate = new ValidateSettingsText(parser, migrations);
	const editSettings = new EditSettings(file, validate, processControl, log);
	const settingsAdmin: SettingsAdmin = {
		path: file.path,
		mode: loaded.mode,
		issues: loaded.mode === "safe" ? loaded.issues : [],
		migratedFrom: loaded.mode === "normal" ? loaded.migratedFrom : null,
		text: () => file.read(),
		validate: (text) => validate.execute(text),
		save: (text) =>
			new SaveSettingsText(file, validate, processControl, log).execute(text),
		secretSources: () => secrets().sources(),
	};

	// ---- Connections context
	const githubClients = new GithubAppClients(fetchImpl);
	const githubRegistration = new GithubAppRegistrationGateway(
		publicUrl,
		fetchImpl,
	);
	const githubDirectory = new GithubDirectory(githubClients);
	const connectionsDeps: ConnectionsDeps = {
		connections: new SqliteConnectionRepository(db, secretCipher),
		repositories: new SqliteWatchedRepositoryRepository(db),
		gateways: {
			for: (p) => {
				if (p !== "github") throw new Error(`no registration for ${p}`);
				return githubRegistration;
			},
		},
		directories: {
			for: (p) => {
				if (p !== "github") throw new Error(`no directory for ${p}`);
				return githubDirectory;
			},
		},
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

	// ---- Settings → maintenance
	const emptySettings = null;
	const configurations = settings
		? new SettingsRepositoryConfigurations(settings)
		: { for: () => emptySettings, allModels: () => [] };
	const limits = settings
		? hostLimits(settings)
		: {
				maxStepLimit: 1,
				maxAttemptsCap: 1,
				maxJobsPerAuthorPerDay: 0,
				maxReviewComments: 0,
				maxDiffLines: 100,
			};
	const runnerImage =
		settings?.server.runnerImage ?? "louisremi/maintainer-agent:latest";

	// ---- Sandbox
	const engine = o.engine ?? new DockerodeEngine();
	const sandbox = new DockerSandbox(
		engine,
		{ runnerImage, namePrefix: "ma-" },
		async (path, data) => {
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, data);
		},
	);

	// ---- Maintenance context
	const forge = new ConnectionBackedForgeAccess(
		{
			execute: (repo, via) =>
				resolveAccess.execute(
					repo,
					via,
					configurations.for(repo)?.connectionId ?? null,
				),
		},
		{ github: new GithubSessionFactory(githubClients) },
	);
	const jobs = new SqliteJobRepository(db);
	const deliveries = new SqliteDeliveryLog(db);
	const policies = new RepositoryPolicies(
		o.policyValidator ?? new DockerPolicyValidator(sandbox, limits),
		configurations,
		limits,
		log,
	);
	const modelHealth =
		o.modelHealth ??
		new HttpModelHealth(() => configurations.allModels(), fetchImpl);
	const workspaces = o.workspaces ?? new GitWorkspacePreparer(config.DATA_DIR);
	const agents =
		o.agents ??
		new DockerAgentRunner(sandbox, {
			dataDir: config.DATA_DIR,
			memoryMb: { issue: 4096, fix: 8192, review: 4096 },
			timeoutMs: {
				issue: 60 * 60_000,
				fix: 5 * 60 * 60_000,
				review: 90 * 60_000,
			},
		});
	const publisher =
		o.publisher ??
		new DockerChangePublisher(sandbox, {
			dataDir: config.DATA_DIR,
			gitAuthor:
				settings?.server.gitAuthor ??
				"maintainer-agent <maintainer-agent@users.noreply.github.com>",
		});
	const sanitizer = o.sanitizer ?? new DockerOutputSanitizer(sandbox);
	const common = { workspaces, agents, sanitizer, log };
	const runNextJob = settings
		? new RunNextJob({
				jobs,
				forge,
				policies,
				modelHealth,
				ids,
				clock,
				uow,
				events,
				log,
				maxRuns: 4,
				retryDelayMs: 5 * 60_000,
				handlers: [
					new AnswerIssue(common),
					new ProposeFix({ ...common, publisher }),
					new ReviewChangeRequest(common),
				],
			})
		: null;
	const allowList = AccountAllowList.parse(
		settings?.server.allowedAccounts ?? [],
	);
	const handleEvent = new HandleForgeEvent({
		forge,
		policies,
		jobs,
		allowList,
		limits,
		ids,
		clock,
		uow,
		events,
		log,
	});
	worker = new JobWorker(
		runNextJob ?? { execute: async () => ({ kind: "idle" as const }) },
		settings?.server.maxConcurrentJobs ?? 1,
		log,
	);

	// ---- Cross-context reactions
	const maintenanceHandlers = new MaintenanceEventHandlers(forge, jobs, log);
	events.subscribe((e) => maintenanceHandlers.handle(e));
	events.subscribe(async (e) => {
		if (e.type === "maintenance.job-queued") worker.poke();
	});

	// ---- Inbound adapters' application facades
	const webhooks: WebhookIngress = settings
		? new GithubWebhookIngress(
				{
					connectionAccess: (id) => getAccess.execute(id),
					handleEvent: (connectionId, event) =>
						handleEvent.execute({ connectionId, event }),
					syncRepositories: (input) => sync.execute(input),
				},
				deliveries,
				clock,
				log,
			)
		: {
				// Safe mode: refuse so that GitHub redelivers once the settings are fixed.
				receive: async () => {
					throw new SafeModeError();
				},
			};
	const listConnections = new ListConnections(connectionsDeps);
	const listJobs = new ListRecentJobs(jobs);
	const admin: AdminApplication = {
		overview: async () => {
			const connections = await listConnections.execute();
			return {
				connections: connections.map((c) => ({
					...c,
					repositories: c.repositories.map((r) => {
						const key = r.key.replace(/^[a-z]+:/, "");
						const configured = settings?.repositories[key] !== undefined;
						const enabled =
							configured && configurations.for(RepoRef.parse(r.key)) !== null;
						return { ...r, enabled, configured, settingsKey: key };
					}),
				})),
				jobs: await listJobs.execute(50),
				modelAvailable: settings ? await modelHealth.isAvailable() : false,
				publicUrl,
				secretsEncrypted: secretCipher.encrypts,
				models: settings
					? Object.entries(settings.models).map(([name, m]) => ({
							name,
							apiBase: m.apiBase,
							model: m.model,
						}))
					: [],
				configuredRepositories: settings
					? Object.keys(settings.repositories).map((key) => ({
							key,
							enabled: settings.repositories[key]?.enabled !== false,
						}))
					: [],
			};
		},
		startGithubRegistration: async (input) => {
			if (!settings)
				throw new ConnectionsError(
					"fix settings.yml first (safe mode)",
					"invalid",
				);
			if (input.isPublic && allowList.isUnrestricted) {
				// Anyone could install a public app and use this server's model.
				throw new ConnectionsError(
					"a public app needs server.allowed_accounts in settings.yml: set it to the accounts this server may serve",
					"invalid",
				);
			}
			return (
				await new StartAppRegistration(connectionsDeps).execute({
					platform: "github",
					...input,
				})
			).form;
		},
		completeGithubRegistration: async (input) => {
			const r = await new CompleteAppRegistration(connectionsDeps).execute(
				input,
			);
			// settings.yml is the source of truth: write the new app there, its
			// secrets to secrets.yaml, then restart to load it.
			const c = await connectionsDeps.connections.get(r.connectionId);
			const creds = c?.credentials;
			if (c && creds) {
				const privateKey = secretName("github", c.id, "private key");
				const webhookSecret = secretName("github", c.id, "webhook secret");
				await upsertSecrets(settingsPaths(config).secrets, {
					[privateKey]: creds.secrets.privateKey ?? "",
					[webhookSecret]: creds.secrets.webhookSecret ?? "",
				});
				await editSettings.execute(
					"app registered",
					(text) =>
						addConnection(text, c.id, {
							platform: c.platform,
							host: c.host,
							display_name: c.displayName,
							...(c.ownerAccount ? { owner_account: c.ownerAccount } : {}),
							app_id: creds.appId,
							app_slug: creds.appSlug,
							private_key: `{${privateKey}}`,
							webhook_secret: `{${webhookSecret}}`,
						}),
					{ restart: true },
				);
			}
			return { installUrl: r.installUrl };
		},
		resync: (connectionId) =>
			new ResyncConnection(connectionsDeps).execute({ connectionId }),
		markAppearanceDone: (connectionId) =>
			editSettings.execute(
				"app logo set",
				(text) =>
					setConnectionField(text, connectionId, "appearance_done", true),
				{ restart: true },
			),
	};
	const health: HealthProbe = {
		check: async () => {
			try {
				db.prepare("SELECT 1").get();
				return { ok: true, details: { settings: loaded.mode } };
			} catch (err) {
				return { ok: false, details: { database: (err as Error).message } };
			}
		},
	};
	const retentionMs =
		(settings?.server.jobRetentionDays ?? 14) * 24 * 60 * 60_000;
	const periodic: PeriodicTask[] = settings
		? [
				{
					name: "resync-connections",
					everyMs: 6 * 60 * 60_000,
					run: () => new ResyncAllConnections(connectionsDeps).execute(),
				},
				{
					name: "prune-registrations",
					everyMs: 30 * 60_000,
					run: () => new PruneExpiredRegistrations(connectionsDeps).execute(),
				},
				{
					name: "prune-history",
					everyMs: 6 * 60 * 60_000,
					run: () =>
						new PruneHistory(
							jobs,
							workspaces,
							deliveries,
							clock,
							retentionMs,
						).execute(),
				},
			]
		: [];

	return {
		config,
		settings,
		log,
		db,
		adminToken,
		publicPathsOnlyViaHost: settings?.server.publicPathsOnlyViaHost ?? null,
		webhooks,
		admin,
		settingsAdmin,
		health,
		worker,
		periodic,
		runNextJob,
		secretCipher,
		async init() {
			if (!settings) return;
			// The database mirrors the connections of settings.yml.
			const synced = await new SyncConfiguredConnections(
				connectionsDeps,
			).execute(
				Object.entries(settings.connections).map(([id, c]) => ({
					id,
					platform: c.platform,
					host: c.host,
					displayName: c.displayName ?? c.appSlug,
					ownerAccount: c.ownerAccount,
					appearanceDone: c.appearanceDone,
					credentials: {
						appId: c.appId,
						appSlug: c.appSlug,
						botLogin: `${c.appSlug}[bot]`,
						secrets: {
							privateKey: c.privateKey.replace(/\\n/g, "\n"),
							webhookSecret: c.webhookSecret,
						},
					},
				})),
			);
			if (synced.added.length || synced.removed.length)
				log.info("connections synchronised with settings.yml", synced);
			if (!adminToken)
				log.warn(
					"server.admin_token is not set in settings.yml: /admin is disabled",
				);
			await new RecoverInterruptedJobs(jobs, clock, log).execute();
			if (!o.engine) {
				const removed = await engine.removeManaged("ma-").catch(() => 0);
				if (removed)
					log.warn("removed leftover sandbox containers and networks", {
						count: removed,
					});
				if (settings.server.dockerPull !== "never") {
					await engine.pull(runnerImage).catch((err: Error) => {
						log.warn(
							"could not pull the runner image; using the local copy if any",
							{ image: runnerImage, reason: err.message },
						);
					});
				}
			}
		},
		async close() {
			await worker.stop();
			db.close();
		},
		set httpClose(fn: () => Promise<void>) {
			httpClose = fn;
		},
	} as App;
}

/** In safe mode the admin token may be unreadable from the broken file: use the secret directly. */
function safeModeAdminToken(
	env: NodeJS.ProcessEnv,
	secrets: () => SecretLookup,
): string | null {
	try {
		return secrets().get("MA_ADMIN_TOKEN")?.value ?? env.ADMIN_TOKEN ?? null;
	} catch {
		return env.ADMIN_TOKEN ?? null;
	}
}

export class SafeModeError extends Error {
	constructor() {
		super("the server is in safe mode: settings.yml is invalid");
		this.name = "SafeModeError";
	}
}

export { settingsKey };
