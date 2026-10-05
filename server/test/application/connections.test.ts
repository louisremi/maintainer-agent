import { describe, expect, it } from "vitest";
import {
	type AppRegistrationGateway,
	CompleteAppRegistration,
	type ConnectionsDeps,
	GetConnectionAccess,
	ListConnections,
	PruneExpiredRegistrations,
	RegisterConfiguredConnection,
	RemoveConnection,
	ResolveRepositoryAccess,
	ResyncAllConnections,
	ResyncConnection,
	SetRepositoryEnabled,
	StartAppRegistration,
	SyncConnectionRepositories,
} from "../../src/connections/application";
import {
	type Connection,
	REGISTRATION_TTL_MS,
} from "../../src/connections/domain";
import { RepoRef } from "../../src/shared-kernel";
import { T0 } from "../support/builders";
import {
	DirectUnitOfWork,
	FixedClock,
	MemoryLogger,
	RecordingPublisher,
	SequentialIds,
} from "../support/fakes";
import {
	MemoryConnectionRepository,
	MemoryWatchedRepositoryRepository,
} from "../support/memory-repositories";

const gh = (path: string, host = "github.com") =>
	RepoRef.of("github", host, path);

function harness() {
	const clock = new FixedClock(T0);
	let n = 0;
	const gateway: AppRegistrationGateway & { completed: string[] } = {
		platform: "github",
		completed: [],
		registrationForm: (c: Connection) => ({
			action: `https://${c.host}/settings/apps/new?state=${c.registrationState}`,
			fields: { manifest: "{}" },
		}),
		complete: async (c: Connection, code: string) => {
			gateway.completed.push(code);
			return {
				credentials: {
					appId: `app-${c.id}`,
					appSlug: `slug-${c.id}`,
					botLogin: `slug-${c.id}[bot]`,
					secrets: { webhookSecret: `secret-${c.id}`, privateKey: "pem" },
				},
				displayName: `slug-${c.id}`,
				ownerAccount: "octo",
				installUrl: `https://github.com/apps/slug-${c.id}/installations/new`,
			};
		},
		appearanceUrl: (c: Connection) =>
			`https://github.com/settings/apps/${c.credentials?.appSlug}`,
		installUrl: (c: Connection) =>
			`https://github.com/apps/${c.credentials?.appSlug}/installations/new`,
	};
	const events = new RecordingPublisher();
	const directory = new Map<string, RepoRef[]>();
	const deps: ConnectionsDeps = {
		connections: new MemoryConnectionRepository(),
		repositories: new MemoryWatchedRepositoryRepository(),
		gateways: { for: () => gateway },
		directories: {
			for: () => ({
				listRepositories: async (a: { connectionId: string }) =>
					directory.get(a.connectionId) ?? [],
			}),
		},
		secrets: { token: (bytes: number) => `tok${++n}`.padEnd(bytes, "x") },
		ids: new SequentialIds("c"),
		clock,
		uow: new DirectUnitOfWork(),
		events,
		log: new MemoryLogger(),
	};
	async function registered(): Promise<string> {
		const { connectionId } = await new StartAppRegistration(deps).execute({
			platform: "github",
			host: "github.com",
			ownerAccount: null,
			isPublic: false,
		});
		const c = await deps.connections.get(connectionId);
		await new CompleteAppRegistration(deps).execute({
			state: c!.registrationState!,
			code: "code",
		});
		return connectionId;
	}
	return {
		deps,
		clock,
		gateway,
		events,
		registered,
		directory,
		sync: new SyncConnectionRepositories(deps),
		resolve: new ResolveRepositoryAccess(deps),
	};
}

describe("app registration (manifest flow)", () => {
	it("registers a pending connection, then activates it with the forge credentials", async () => {
		const h = harness();
		const start = await new StartAppRegistration(h.deps).execute({
			platform: "github",
			host: "GitHub.com",
			ownerAccount: "my-org",
			isPublic: false,
		});
		expect(start.form.action).toMatch(
			/^https:\/\/github\.com\/settings\/apps\/new\?state=/,
		);
		const pending = await h.deps.connections.get(start.connectionId);
		expect(pending!.status).toBe("pending");
		expect(
			await new GetConnectionAccess(h.deps).execute(start.connectionId),
		).toBeNull();

		const done = await new CompleteAppRegistration(h.deps).execute({
			state: pending!.registrationState!,
			code: "abc",
		});
		expect(done.installUrl).toContain("/installations/new");
		const access = await new GetConnectionAccess(h.deps).execute(
			start.connectionId,
		);
		expect(access).toMatchObject({ platform: "github", host: "github.com" });
		expect(access!.credentials.secrets.webhookSecret).toBe(
			`secret-${start.connectionId}`,
		);
		expect(h.events.events.map((e) => e.type)).toContain(
			"connections.connection-activated",
		);
	});

	it("rejects unknown, reused and expired registrations", async () => {
		const h = harness();
		await expect(
			new CompleteAppRegistration(h.deps).execute({ state: "nope", code: "x" }),
		).rejects.toMatchObject({ code: "not-found" });
		const { connectionId } = await new StartAppRegistration(h.deps).execute({
			platform: "github",
			host: "github.com",
			ownerAccount: null,
			isPublic: false,
		});
		const state = (await h.deps.connections.get(connectionId))!
			.registrationState!;
		h.clock.advance(REGISTRATION_TTL_MS + 1);
		await expect(
			new CompleteAppRegistration(h.deps).execute({ state, code: "x" }),
		).rejects.toMatchObject({ code: "invalid" });
		expect(await h.deps.connections.get(connectionId)).toBeNull();
		expect(h.gateway.completed).toEqual([]);
	});

	it("rejects unsupported forges and bad account names", async () => {
		const h = harness();
		await expect(
			new StartAppRegistration(h.deps).execute({
				platform: "gitlab",
				host: "gitlab.com",
				ownerAccount: null,
				isPublic: false,
			}),
		).rejects.toThrow(/not supported/);
		await expect(
			new StartAppRegistration(h.deps).execute({
				platform: "github",
				host: "github.com",
				ownerAccount: "bad/name",
				isPublic: false,
			}),
		).rejects.toThrow(/invalid account/);
	});

	it("prunes registrations that were never completed", async () => {
		const h = harness();
		await new StartAppRegistration(h.deps).execute({
			platform: "github",
			host: "github.com",
			ownerAccount: null,
			isPublic: false,
		});
		await h.registered();
		h.clock.advance(REGISTRATION_TTL_MS + 1);
		expect(await new PruneExpiredRegistrations(h.deps).execute()).toBe(1);
		expect(await h.deps.connections.list()).toHaveLength(1);
	});

	it("creates and updates a connection from configured credentials", async () => {
		const h = harness();
		const creds = {
			appId: "42",
			appSlug: "mine",
			botLogin: "mine[bot]",
			secrets: { webhookSecret: "a", privateKey: "p" },
		};
		const register = new RegisterConfiguredConnection(h.deps);
		await register.execute({
			id: "env",
			platform: "github",
			host: "github.com",
			displayName: "mine",
			ownerAccount: null,
			credentials: creds,
		});
		await register.execute({
			id: "env",
			platform: "github",
			host: "github.com",
			displayName: "mine",
			ownerAccount: null,
			credentials: {
				...creds,
				secrets: { webhookSecret: "b", privateKey: "p" },
			},
		});
		const access = await new GetConnectionAccess(h.deps).execute("env");
		expect(access!.credentials.secrets.webhookSecret).toBe("b");
		await expect(
			register.execute({
				id: "env",
				platform: "github",
				host: "ghe.corp",
				displayName: "x",
				ownerAccount: null,
				credentials: creds,
			}),
		).rejects.toMatchObject({ code: "conflict" });
	});
});

describe("several apps watching repositories", () => {
	it("lets each connection watch its repositories and resolves access per repository", async () => {
		const h = harness();
		const personal = await h.registered();
		const org = await h.registered();
		await h.sync.execute({
			connectionId: personal,
			added: [gh("me/a"), gh("me/b")],
			removed: [],
			mode: "delta",
		});
		await h.sync.execute({
			connectionId: org,
			added: [gh("org/c")],
			removed: [],
			mode: "delta",
		});

		expect((await h.resolve.execute(gh("me/a")))!.connectionId).toBe(personal);
		expect((await h.resolve.execute(gh("org/c")))!.connectionId).toBe(org);
		expect(await h.resolve.execute(gh("org/c"), personal)).toBeNull();
		expect(await h.resolve.execute(gh("nobody/x"))).toBeNull();

		const list = await new ListConnections(h.deps).execute();
		expect(list.map((c) => c.repositories.map((r) => r.path))).toEqual([
			["me/a", "me/b"],
			["org/c"],
		]);
		expect(
			h.events.events.filter(
				(e) => e.type === "connections.repository-watched",
			),
		).toHaveLength(3);
	});

	it("keeps the first owner when two connections reach the same repository", async () => {
		const h = harness();
		const first = await h.registered();
		const second = await h.registered();
		await h.sync.execute({
			connectionId: first,
			added: [gh("shared/r")],
			removed: [],
			mode: "delta",
		});
		const r = await h.sync.execute({
			connectionId: second,
			added: [gh("shared/r")],
			removed: [],
			mode: "delta",
		});
		expect(r.contested).toEqual(["github:github.com/shared/r"]);
		expect((await h.resolve.execute(gh("shared/r")))!.connectionId).toBe(first);
		expect(await h.resolve.execute(gh("shared/r"), second)).toBeNull();

		// The owner loses access: the repository is released (a later sync of the contender claims it).
		await h.sync.execute({
			connectionId: first,
			added: [],
			removed: [gh("shared/r")],
			mode: "delta",
		});
		expect(await h.resolve.execute(gh("shared/r"))).toBeNull();
		await h.sync.execute({
			connectionId: second,
			added: [gh("shared/r")],
			removed: [],
			mode: "replace",
		});
		expect((await h.resolve.execute(gh("shared/r")))!.connectionId).toBe(
			second,
		);
	});

	it("replaces the full list on a resync and ignores repositories of another forge", async () => {
		const h = harness();
		const c = await h.registered();
		await h.sync.execute({
			connectionId: c,
			added: [gh("me/a"), gh("me/b")],
			removed: [],
			mode: "delta",
		});
		const r = await h.sync.execute({
			connectionId: c,
			added: [gh("me/b"), gh("me/x", "ghe.corp")],
			removed: [],
			mode: "replace",
		});
		expect(r.released).toEqual(["github:github.com/me/a"]);
		expect(r.watched).toEqual([]);
		expect((await h.deps.repositories.list()).map((w) => w.repo.path)).toEqual([
			"me/b",
		]);
	});

	it("resyncs from the forge directory, healing missed events", async () => {
		const h = harness();
		const c = await h.registered();
		const broken = await h.registered();
		h.directory.set(c, [gh("me/a"), gh("me/b")]);
		await new ResyncConnection(h.deps).execute({ connectionId: c });
		h.directory.set(c, [gh("me/b")]);
		const deps = {
			...h.deps,
			directories: {
				for: () => ({
					listRepositories: async (a: { connectionId: string }) => {
						if (a.connectionId === broken) throw new Error("app was deleted");
						return h.directory.get(a.connectionId) ?? [];
					},
				}),
			},
		};
		const results = await new ResyncAllConnections(deps).execute();
		expect(results).toEqual([
			{ connectionId: c, ok: true },
			{ connectionId: broken, ok: false, error: "app was deleted" },
		]);
		expect((await h.deps.repositories.list()).map((w) => w.repo.path)).toEqual([
			"me/b",
		]);
	});

	it("can disable a repository and remove a connection with its repositories", async () => {
		const h = harness();
		const c = await h.registered();
		const other = await h.registered();
		await h.sync.execute({
			connectionId: c,
			added: [gh("me/a")],
			removed: [],
			mode: "delta",
		});
		await h.sync.execute({
			connectionId: other,
			added: [gh("me/a")],
			removed: [],
			mode: "delta",
		});
		await new SetRepositoryEnabled(h.deps).execute({
			repoKey: gh("me/a").key,
			enabled: false,
		});
		expect(await h.resolve.execute(gh("me/a"))).toBeNull();
		const before = h.events.events.length;
		await new SetRepositoryEnabled(h.deps).execute({
			repoKey: gh("me/a").key,
			enabled: true,
		});
		// Re-enabling announces the repository again (labels are set up).
		expect(h.events.events.slice(before).map((e) => e.type)).toEqual([
			"connections.repository-watched",
		]);
		expect(await h.resolve.execute(gh("me/a"))).not.toBeNull();

		await new RemoveConnection(h.deps).execute({ connectionId: c });
		expect(await h.deps.connections.get(c)).toBeNull();
		expect(await h.deps.repositories.list()).toEqual([]);
		expect(h.events.events.map((e) => e.type)).toContain(
			"connections.repository-unwatched",
		);
	});
});
