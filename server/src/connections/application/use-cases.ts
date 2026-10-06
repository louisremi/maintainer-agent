import type {
	Clock,
	EventPublisher,
	IdGenerator,
	Logger,
	Platform,
	RepoRef,
	UnitOfWork,
} from "../../shared-kernel";
import {
	ClaimPolicy,
	Connection,
	type ConnectionCredentials,
	type ConnectionKind,
	WatchedRepository,
} from "../domain";
import {
	type ConnectionAccess,
	type ConnectionSummary,
	toAccess,
	toRepositorySummary,
} from "./dto";
import { ConnectionsError } from "./errors";
import type {
	AppRegistrationGateways,
	ConnectionRepository,
	ForgeDirectories,
	RegistrationForm,
	SecretGenerator,
	WatchedRepositoryRepository,
} from "./ports";

export interface ConnectionsDeps {
	readonly connections: ConnectionRepository;
	readonly repositories: WatchedRepositoryRepository;
	readonly gateways: AppRegistrationGateways;
	readonly directories: ForgeDirectories;
	readonly secrets: SecretGenerator;
	readonly ids: IdGenerator;
	readonly clock: Clock;
	readonly uow: UnitOfWork;
	readonly events: EventPublisher;
	readonly log: Logger;
}

const KIND_FOR: Record<Platform, ConnectionKind | null> = {
	github: "github-app",
	gitlab: null,
};

/** Starts registering a new app with a forge; returns what the browser must POST. */
export class StartAppRegistration {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(input: {
		platform: Platform;
		host: string;
		ownerAccount: string | null;
		isPublic: boolean;
	}): Promise<{ connectionId: string; form: RegistrationForm }> {
		const kind = KIND_FOR[input.platform];
		if (!kind)
			throw new ConnectionsError(
				`registering ${input.platform} apps is not supported yet`,
				"invalid",
			);
		const owner = input.ownerAccount?.trim() || null;
		if (owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
			throw new ConnectionsError(`invalid account name: ${owner}`, "invalid");
		}
		const connection = Connection.startRegistration({
			id: this.d.secrets.token(12),
			platform: input.platform,
			host: input.host,
			kind,
			ownerAccount: owner,
			isPublic: input.isPublic,
			registrationState: this.d.secrets.token(24),
			now: this.d.clock.now(),
		});
		await this.d.uow.run(() => this.d.connections.save(connection));
		this.d.log.info("app registration started", {
			connectionId: connection.id,
			platform: input.platform,
			host: connection.host,
		});
		return {
			connectionId: connection.id,
			form: this.d.gateways.for(input.platform).registrationForm(connection),
		};
	}
}

/** The forge redirected back with a temporary code: fetch and store the credentials. */
export class CompleteAppRegistration {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(input: {
		state: string;
		code: string;
	}): Promise<{ connectionId: string; installUrl: string }> {
		const connection = await this.d.connections.findByRegistrationState(
			input.state,
		);
		if (!connection)
			throw new ConnectionsError(
				"unknown or already used registration",
				"not-found",
			);
		if (connection.isRegistrationExpired(this.d.clock.now())) {
			await this.d.uow.run(() => this.d.connections.delete(connection.id));
			throw new ConnectionsError(
				"the registration expired; start again",
				"invalid",
			);
		}
		const result = await this.d.gateways
			.for(connection.platform)
			.complete(connection, input.code);
		connection.completeRegistration({
			state: input.state,
			credentials: result.credentials,
			displayName: result.displayName,
			ownerAccount: result.ownerAccount,
			now: this.d.clock.now(),
		});
		await this.d.uow.run(() => this.d.connections.save(connection));
		await this.d.events.publish(connection.pullEvents());
		this.d.log.info("app registration completed", {
			connectionId: connection.id,
			app: result.credentials.appSlug,
		});
		return { connectionId: connection.id, installUrl: result.installUrl };
	}
}

/**
 * Creates or updates a connection from credentials the operator supplies out
 * of band (environment variables), for apps registered by hand.
 */
export class RegisterConfiguredConnection {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(input: {
		id: string;
		platform: Platform;
		host: string;
		displayName: string;
		ownerAccount: string | null;
		credentials: ConnectionCredentials;
	}): Promise<void> {
		const kind = KIND_FOR[input.platform];
		if (!kind)
			throw new ConnectionsError(
				`${input.platform} connections are not supported yet`,
				"invalid",
			);
		const now = this.d.clock.now();
		const existing = await this.d.connections.get(input.id);
		const connection =
			existing ?? Connection.registerDirectly({ ...input, kind, now });
		if (existing) {
			if (
				existing.platform !== input.platform ||
				existing.host !== input.host.toLowerCase()
			) {
				throw new ConnectionsError(
					`connection ${input.id} exists for another forge`,
					"conflict",
				);
			}
			existing.replaceCredentials(input.credentials, now);
		}
		await this.d.uow.run(() => this.d.connections.save(connection));
		await this.d.events.publish(connection.pullEvents());
	}
}

/**
 * Makes the stored connections match the operator's settings (settings.yml
 * is the source of truth; the database keeps a projection the rest of the
 * server reads). Connections missing from the settings are removed, with the
 * repositories they reached; pending registrations are kept.
 */
export class SyncConfiguredConnections {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(
		configured: readonly {
			id: string;
			platform: Platform;
			host: string;
			displayName: string;
			ownerAccount: string | null;
			credentials: ConnectionCredentials;
			appearanceDone: boolean;
		}[],
	): Promise<{ added: string[]; removed: string[] }> {
		const register = new RegisterConfiguredConnection(this.d);
		const remove = new RemoveConnection(this.d);
		const ids = new Set(configured.map((c) => c.id));
		const result = { added: [] as string[], removed: [] as string[] };
		for (const c of configured) {
			const existed = (await this.d.connections.get(c.id)) !== null;
			await register.execute(c);
			if (c.appearanceDone) {
				await this.d.uow.run(async () => {
					const stored = await this.d.connections.get(c.id);
					if (stored && !stored.appearanceDone) {
						stored.markAppearanceDone(this.d.clock.now());
						await this.d.connections.save(stored);
					}
				});
			}
			if (!existed) result.added.push(c.id);
		}
		for (const c of await this.d.connections.list()) {
			if (c.status !== "pending" && !ids.has(c.id)) {
				await remove.execute({ connectionId: c.id });
				result.removed.push(c.id);
			}
		}
		return result;
	}
}

/**
 * Applies the forge's view of which repositories a connection can reach.
 * `mode: 'replace'` treats `added` as the complete list.
 */
export class SyncConnectionRepositories {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(input: {
		connectionId: string;
		added: readonly RepoRef[];
		removed: readonly RepoRef[];
		mode: "delta" | "replace";
	}): Promise<{ watched: string[]; contested: string[]; released: string[] }> {
		const connection = await this.d.connections.get(input.connectionId);
		if (!connection?.acceptsEvents)
			throw new ConnectionsError("unknown or inactive connection", "not-found");
		const now = this.d.clock.now();
		const touched: WatchedRepository[] = [];
		const deleted: WatchedRepository[] = [];
		const result = {
			watched: [] as string[],
			contested: [] as string[],
			released: [] as string[],
		};

		await this.d.uow.run(async () => {
			let removed = [...input.removed];
			if (input.mode === "replace") {
				const keep = new Set(input.added.map((r) => r.key));
				const owned = await this.d.repositories.listByConnection(connection.id);
				removed = [
					...removed,
					...owned.filter((w) => !keep.has(w.repo.key)).map((w) => w.repo),
				];
				const all = await this.d.repositories.list();
				for (const w of all) {
					if (w.contestedBy.includes(connection.id) && !keep.has(w.repo.key)) {
						w.dropContest(connection.id);
						await this.d.repositories.save(w);
					}
				}
			}
			for (const repo of input.added) {
				if (
					repo.platform !== connection.platform ||
					repo.host !== connection.host
				) {
					this.d.log.warn("ignoring repository from another forge", {
						connectionId: connection.id,
						repo: repo.key,
					});
					continue;
				}
				const existing = await this.d.repositories.get(repo);
				const decision = ClaimPolicy.decide(existing, connection.id);
				if (decision.kind === "watch") {
					const w = WatchedRepository.watch(repo, connection.id, now);
					await this.d.repositories.save(w);
					touched.push(w);
					result.watched.push(repo.key);
				} else if (decision.kind === "contested" && existing) {
					existing.noteContest(connection.id, now);
					await this.d.repositories.save(existing);
					touched.push(existing);
					result.contested.push(repo.key);
				}
			}
			for (const repo of removed) {
				const existing = await this.d.repositories.get(repo);
				if (!existing) continue;
				if (existing.connectionId === connection.id) {
					existing.release(now);
					await this.d.repositories.delete(repo);
					deleted.push(existing);
					result.released.push(repo.key);
				} else {
					existing.dropContest(connection.id);
					await this.d.repositories.save(existing);
				}
			}
		});
		await this.d.events.publish(
			[...touched, ...deleted].flatMap((w) => w.pullEvents()),
		);
		if (result.contested.length) {
			this.d.log.warn(
				"repositories already watched through another connection",
				{
					connectionId: connection.id,
					repositories: result.contested,
				},
			);
		}
		return result;
	}
}

/**
 * Re-reads from the forge every repository a connection can reach and
 * applies it, so that missed installation events heal by themselves.
 */
export class ResyncConnection {
	private readonly sync: SyncConnectionRepositories;

	constructor(private readonly d: ConnectionsDeps) {
		this.sync = new SyncConnectionRepositories(d);
	}

	async execute(input: {
		connectionId: string;
	}): Promise<{ watched: string[]; contested: string[]; released: string[] }> {
		const connection = await this.d.connections.get(input.connectionId);
		const access = connection ? toAccess(connection) : null;
		if (!access)
			throw new ConnectionsError("unknown or inactive connection", "not-found");
		const repos = await this.d.directories
			.for(access.platform)
			.listRepositories(access);
		return this.sync.execute({
			connectionId: access.connectionId,
			added: repos,
			removed: [],
			mode: "replace",
		});
	}
}

/** Resyncs every active connection; one failing connection does not stop the others. */
export class ResyncAllConnections {
	private readonly one: ResyncConnection;

	constructor(private readonly d: ConnectionsDeps) {
		this.one = new ResyncConnection(d);
	}

	async execute(): Promise<
		{ connectionId: string; ok: boolean; error?: string }[]
	> {
		const results: { connectionId: string; ok: boolean; error?: string }[] = [];
		for (const c of await this.d.connections.list()) {
			if (!c.acceptsEvents) continue;
			try {
				await this.one.execute({ connectionId: c.id });
				results.push({ connectionId: c.id, ok: true });
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.d.log.warn("could not resync connection", {
					connectionId: c.id,
					error,
				});
				results.push({ connectionId: c.id, ok: false, error });
			}
		}
		return results;
	}
}

/** The operator set the app's logo on the forge: stop reminding them. */
export class MarkAppearanceDone {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(input: { connectionId: string }): Promise<void> {
		await this.d.uow.run(async () => {
			const c = await this.d.connections.get(input.connectionId);
			if (!c) throw new ConnectionsError("unknown connection", "not-found");
			c.markAppearanceDone(this.d.clock.now());
			await this.d.connections.save(c);
		});
	}
}

export class SetConnectionEnabled {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(input: {
		connectionId: string;
		enabled: boolean;
	}): Promise<void> {
		const connection = await this.d.connections.get(input.connectionId);
		if (!connection)
			throw new ConnectionsError("unknown connection", "not-found");
		const now = this.d.clock.now();
		if (input.enabled) connection.enable(now);
		else connection.disable(now);
		await this.d.uow.run(() => this.d.connections.save(connection));
		await this.d.events.publish(connection.pullEvents());
	}
}

/** Forgets a connection and the repositories it owned (the forge-side app is not deleted). */
export class RemoveConnection {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(input: { connectionId: string }): Promise<void> {
		const connection = await this.d.connections.get(input.connectionId);
		if (!connection)
			throw new ConnectionsError("unknown connection", "not-found");
		const now = this.d.clock.now();
		const released: WatchedRepository[] = [];
		await this.d.uow.run(async () => {
			for (const w of await this.d.repositories.list()) {
				if (w.connectionId === connection.id) {
					w.release(now);
					await this.d.repositories.delete(w.repo);
					released.push(w);
				} else if (w.contestedBy.includes(connection.id)) {
					w.dropContest(connection.id);
					await this.d.repositories.save(w);
				}
			}
			await this.d.connections.delete(connection.id);
		});
		await this.d.events.publish(released.flatMap((w) => w.pullEvents()));
		this.d.log.info("connection removed", { connectionId: connection.id });
	}
}

/** Drops pending registrations that were never completed. */
export class PruneExpiredRegistrations {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(): Promise<number> {
		const now = this.d.clock.now();
		const expired = (await this.d.connections.list()).filter((c) =>
			c.isRegistrationExpired(now),
		);
		await this.d.uow.run(async () => {
			for (const c of expired) await this.d.connections.delete(c.id);
		});
		return expired.length;
	}
}

// ----------------------------------------------------------------------------- queries

export class ListConnections {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(): Promise<ConnectionSummary[]> {
		const [connections, repositories] = await Promise.all([
			this.d.connections.list(),
			this.d.repositories.list(),
		]);
		return connections.map((c) => ({
			id: c.id,
			platform: c.platform,
			host: c.host,
			displayName: c.displayName,
			ownerAccount: c.ownerAccount,
			status: c.status,
			isPublic: c.isPublic,
			createdAt: c.createdAt.toISOString(),
			appearanceUrl:
				c.acceptsEvents && !c.appearanceDone
					? this.d.gateways.for(c.platform).appearanceUrl(c)
					: null,
			installUrl: c.acceptsEvents
				? this.d.gateways.for(c.platform).installUrl(c)
				: null,
			repositories: repositories
				.filter((r) => r.connectionId === c.id)
				.map(toRepositorySummary),
		}));
	}
}

/** Credentials of an active connection, for verifying its webhooks. */
export class GetConnectionAccess {
	constructor(private readonly d: ConnectionsDeps) {}

	async execute(connectionId: string): Promise<ConnectionAccess | null> {
		const c = await this.d.connections.get(connectionId);
		return c ? toAccess(c) : null;
	}
}

/**
 * The connection through which the server acts on a repository, or null
 * when the repository is not watched, disabled, or its connection inactive.
 * `viaConnectionId` rejects events that arrived through a contending connection.
 */
export class ResolveRepositoryAccess {
	constructor(private readonly d: ConnectionsDeps) {}

	/**
	 * `preferred`: the connection the operator chose for this repository in
	 * the settings, when several can reach it.
	 */
	async execute(
		repo: RepoRef,
		viaConnectionId?: string,
		preferred?: string | null,
	): Promise<ConnectionAccess | null> {
		const watched = await this.d.repositories.get(repo);
		if (!watched) return null;
		const reachable = [watched.connectionId, ...watched.contestedBy];
		const owner =
			preferred && reachable.includes(preferred)
				? preferred
				: watched.connectionId;
		if (viaConnectionId && owner !== viaConnectionId) return null;
		const c = await this.d.connections.get(owner);
		return c ? toAccess(c) : null;
	}
}
