import { describe, expect, it } from "vitest";
import {
	AesGcmSecretCipher,
	PlaintextSecretCipher,
} from "../../src/adapters/crypto/secret-cipher";
import {
	openDatabase,
	SqliteConnectionRepository,
	SqliteDeliveryLog,
	SqliteJobRepository,
	SqliteUnitOfWork,
	SqliteWatchedRepositoryRepository,
} from "../../src/adapters/persistence/sqlite";
import type {
	ConnectionRepository,
	WatchedRepositoryRepository,
} from "../../src/connections/application";
import { Connection, WatchedRepository } from "../../src/connections/domain";
import type { MaintenanceJobRepository } from "../../src/maintenance/application";
import { MaintenanceJob } from "../../src/maintenance/domain";
import { type DeliveryLog, RepoRef } from "../../src/shared-kernel";
import { REPO, T0 } from "../support/builders";
import { MemoryDeliveryLog } from "../support/fakes";
import {
	MemoryConnectionRepository,
	MemoryJobRepository,
	MemoryWatchedRepositoryRepository,
} from "../support/memory-repositories";

interface Impl {
	connections: ConnectionRepository;
	repositories: WatchedRepositoryRepository;
	jobs: MaintenanceJobRepository;
	deliveries: DeliveryLog;
}

const implementations: [string, () => Impl][] = [
	[
		"memory",
		() => ({
			connections: new MemoryConnectionRepository(),
			repositories: new MemoryWatchedRepositoryRepository(),
			jobs: new MemoryJobRepository(),
			deliveries: new MemoryDeliveryLog(),
		}),
	],
	[
		"sqlite",
		() => {
			const db = openDatabase(":memory:");
			return {
				connections: new SqliteConnectionRepository(
					db,
					new AesGcmSecretCipher("a-long-enough-test-key"),
				),
				repositories: new SqliteWatchedRepositoryRepository(db),
				jobs: new SqliteJobRepository(db),
				deliveries: new SqliteDeliveryLog(db),
			};
		},
	],
];

const creds = {
	appId: "7",
	appSlug: "ma",
	botLogin: "ma[bot]",
	secrets: { privateKey: "-----BEGIN-----", webhookSecret: "w" },
};
const later = (ms: number) => new Date(T0.getTime() + ms);
const job = (
	id: string,
	over: Partial<{
		number: number;
		kind: MaintenanceJob["kind"];
		actor: string;
		at: Date;
		repo: RepoRef;
		cause: string;
	}> = {},
) =>
	MaintenanceJob.queue({
		id,
		repo: over.repo ?? REPO,
		kind: over.kind ?? "answer-issue",
		number: over.number ?? 1,
		trigger: {
			cause: over.cause ?? "issue-opened",
			actorLogin: over.actor ?? "alice",
		},
		now: over.at ?? T0,
	});

describe.each(implementations)("repository contracts: %s", (_, make) => {
	it("stores connections with their credentials and finds them by registration state", async () => {
		const { connections } = make();
		const c = Connection.startRegistration({
			id: "c1",
			platform: "github",
			host: "github.com",
			kind: "github-app",
			ownerAccount: "org",
			isPublic: true,
			registrationState: "s".repeat(24),
			now: T0,
		});
		await connections.save(c);
		expect(
			(await connections.findByRegistrationState("s".repeat(24)))!.id,
		).toBe("c1");
		c.completeRegistration({
			state: "s".repeat(24),
			credentials: creds,
			displayName: "ma",
			ownerAccount: "org",
			now: later(1),
		});
		await connections.save(c);
		c.markAppearanceDone(later(2));
		await connections.save(c);
		const back = (await connections.get("c1"))!;
		expect(back.appearanceDone).toBe(true);
		expect(back.status).toBe("active");
		expect(back.credentials).toEqual(creds);
		expect(back.isPublic).toBe(true);
		expect(
			await connections.findByRegistrationState("s".repeat(24)),
		).toBeNull();
		await connections.save(
			Connection.registerDirectly({
				id: "c0",
				platform: "github",
				host: "ghe.corp",
				kind: "github-app",
				displayName: "x",
				ownerAccount: null,
				credentials: creds,
				now: later(5),
			}),
		);
		expect((await connections.list()).map((x) => x.id)).toEqual(["c1", "c0"]);
		await connections.delete("c1");
		expect(await connections.get("c1")).toBeNull();
	});

	it("stores watched repositories and their contests", async () => {
		const { repositories } = make();
		const w = WatchedRepository.watch(REPO, "c1", T0);
		w.noteContest("c2", T0);
		w.disable();
		await repositories.save(w);
		const back = (await repositories.get(REPO))!;
		expect(back.contestedBy).toEqual(["c2"]);
		expect(back.enabled).toBe(false);
		expect(
			(await repositories.listByConnection("c1")).map((x) => x.repo.key),
		).toEqual([REPO.key]);
		expect(await repositories.listByConnection("c2")).toEqual([]);
		await repositories.delete(REPO);
		expect(await repositories.list()).toEqual([]);
	});

	it("claims the oldest due job and marks it running", async () => {
		const { jobs } = make();
		await jobs.save(job("b", { number: 2, at: later(10) }));
		await jobs.save(job("a", { number: 1, at: later(5) }));
		expect(await jobs.claimNext(T0)).toBeNull();
		const first = (await jobs.claimNext(later(20)))!;
		expect(first.id).toBe("a");
		expect(first.status).toBe("running");
		expect((await jobs.get("a"))!.status).toBe("running");
		expect((await jobs.claimNext(later(20)))!.id).toBe("b");
		expect(await jobs.claimNext(later(20))).toBeNull();
		expect((await jobs.listByStatus("running")).map((j) => j.id)).toEqual([
			"a",
			"b",
		]);
	});

	it("round-trips every job field", async () => {
		const { jobs } = make();
		const j = MaintenanceJob.queue({
			id: "x",
			repo: REPO,
			kind: "propose-fix",
			number: 4,
			trigger: { cause: "job:y", actorLogin: "bob" },
			context: { analysis: "a" },
			now: T0,
		});
		await jobs.save(j);
		const c = (await jobs.claimNext(T0))!;
		c.agentFailed("nothing", 3, later(1));
		await jobs.save(c);
		const back = (await jobs.get("x"))!;
		expect(back.snapshot()).toEqual(c.snapshot());
	});

	it("lists active jobs per repository and counts what an author triggered", async () => {
		const { jobs } = make();
		const other = RepoRef.of("github", "github.com", "octo/other");
		await jobs.save(job("1", { actor: "zoe", at: T0 }));
		await jobs.save(job("2", { actor: "zoe", number: 2, at: later(1) }));
		await jobs.save(
			job("3", { actor: "zoe", number: 3, repo: other, at: later(2) }),
		);
		await jobs.save(
			job("4", {
				actor: "zoe",
				number: 4,
				cause: "job:1",
				kind: "propose-fix",
				at: later(3),
			}),
		);
		expect((await jobs.listActive(REPO)).map((j) => j.id)).toEqual([
			"1",
			"2",
			"4",
		]);
		expect(await jobs.countTriggeredBy("zoe", T0)).toBe(3);
		expect(await jobs.countTriggeredBy("zoe", later(2))).toBe(1);
		expect((await jobs.listRecent(2)).map((j) => j.id)).toEqual(["4", "3"]);
	});

	it("deletes finished jobs older than a date", async () => {
		const { jobs } = make();
		await jobs.save(job("done"));
		await jobs.save(job("open", { number: 2 }));
		const d = (await jobs.claimNext(T0))!;
		d.succeed("ok", T0);
		await jobs.save(d);
		expect(await jobs.deleteFinishedBefore(later(1))).toEqual(["done"]);
		expect((await jobs.listRecent(10)).map((j) => j.id)).toEqual(["open"]);
	});

	it("records each delivery once per source", async () => {
		const { deliveries } = make();
		expect(await deliveries.recordOnce("c1", "d1", T0)).toBe(true);
		expect(await deliveries.recordOnce("c1", "d1", T0)).toBe(false);
		expect(await deliveries.recordOnce("c2", "d1", T0)).toBe(true);
		await deliveries.forget("c1", "d1");
		expect(await deliveries.recordOnce("c1", "d1", later(10))).toBe(true);
		expect(await deliveries.prune(later(5))).toBe(1);
	});
});

describe("SQLite specifics", () => {
	it("keeps at most one active job per subject at the database level", () => {
		const db = openDatabase(":memory:");
		const repo = new SqliteJobRepository(db);
		return (async () => {
			await repo.save(job("a"));
			await expect(repo.save(job("b"))).rejects.toThrow(/UNIQUE/);
		})();
	});

	it("rolls back a unit of work that fails, and serialises concurrent ones", async () => {
		const db = openDatabase(":memory:");
		const repo = new SqliteJobRepository(db);
		const uow = new SqliteUnitOfWork(db);
		await expect(
			uow.run(async () => {
				await repo.save(job("a"));
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await repo.get("a")).toBeNull();
		const order: string[] = [];
		await Promise.all([
			uow.run(async () => {
				order.push("1-start");
				await new Promise((r) => setTimeout(r, 10));
				await repo.save(job("x", { number: 5 }));
				order.push("1-end");
			}),
			uow.run(async () => {
				order.push("2-start");
				await repo.save(job("y", { number: 6 }));
				order.push("2-end");
			}),
		]);
		expect(order).toEqual(["1-start", "1-end", "2-start", "2-end"]);
		expect(await uow.run(() => uow.run(async () => "nested"))).toBe("nested");
	});

	it("encrypts credentials at rest and refuses to mix modes", async () => {
		const db = openDatabase(":memory:");
		const c = Connection.registerDirectly({
			id: "c",
			platform: "github",
			host: "github.com",
			kind: "github-app",
			displayName: "x",
			ownerAccount: null,
			credentials: creds,
			now: T0,
		});
		await new SqliteConnectionRepository(
			db,
			new AesGcmSecretCipher("a-long-enough-test-key"),
		).save(c);
		const raw = (
			db.prepare("SELECT credentials FROM connections").get() as {
				credentials: string;
			}
		).credentials;
		expect(raw).not.toContain("BEGIN");
		expect(raw.startsWith("v1:")).toBe(true);
		await expect(
			new SqliteConnectionRepository(
				db,
				new AesGcmSecretCipher("another-long-test-key"),
			).get("c"),
		).rejects.toThrow();
		await expect(
			new SqliteConnectionRepository(db, new PlaintextSecretCipher()).get("c"),
		).rejects.toThrow(/set SECRETS_KEY/);
	});
});
