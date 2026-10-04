import type {
	ConnectionRepository,
	WatchedRepositoryRepository,
} from "../../src/connections/application";
import { Connection, WatchedRepository } from "../../src/connections/domain";
import type { MaintenanceJobRepository } from "../../src/maintenance/application";
import { MaintenanceJob } from "../../src/maintenance/domain";
import type { RepoRef } from "../../src/shared-kernel";

/** In-memory adapters; they pass the same contract suites as the SQLite ones. */
export class MemoryConnectionRepository implements ConnectionRepository {
	private readonly rows = new Map<string, Connection>();
	async get(id: string) {
		const c = this.rows.get(id);
		return c ? Connection.restore(c.snapshot() as never) : null;
	}
	async findByRegistrationState(state: string) {
		for (const c of this.rows.values())
			if (c.registrationState === state)
				return Connection.restore(c.snapshot() as never);
		return null;
	}
	async list() {
		return [...this.rows.values()]
			.map((c) => Connection.restore(c.snapshot() as never))
			.sort(
				(a, b) =>
					a.createdAt.getTime() - b.createdAt.getTime() ||
					a.id.localeCompare(b.id),
			);
	}
	async save(c: Connection) {
		this.rows.set(c.id, Connection.restore(c.snapshot() as never));
	}
	async delete(id: string) {
		this.rows.delete(id);
	}
}

export class MemoryWatchedRepositoryRepository
	implements WatchedRepositoryRepository
{
	private readonly rows = new Map<string, WatchedRepository>();
	private copy(w: WatchedRepository) {
		return WatchedRepository.restore(w.snapshot() as never);
	}
	async get(repo: RepoRef) {
		const w = this.rows.get(repo.key);
		return w ? this.copy(w) : null;
	}
	async listByConnection(id: string) {
		return (await this.list()).filter((w) => w.connectionId === id);
	}
	async list() {
		return [...this.rows.values()]
			.map((w) => this.copy(w))
			.sort((a, b) => a.repo.key.localeCompare(b.repo.key));
	}
	async save(w: WatchedRepository) {
		this.rows.set(w.repo.key, this.copy(w));
	}
	async delete(repo: RepoRef) {
		this.rows.delete(repo.key);
	}
}

export class MemoryJobRepository implements MaintenanceJobRepository {
	private readonly rows = new Map<string, MaintenanceJob>();
	private copy(j: MaintenanceJob) {
		return MaintenanceJob.restore(j.snapshot() as never);
	}
	private all() {
		return [...this.rows.values()].sort(
			(a, b) =>
				a.createdAt.getTime() - b.createdAt.getTime() ||
				a.id.localeCompare(b.id),
		);
	}
	async get(id: string) {
		const j = this.rows.get(id);
		return j ? this.copy(j) : null;
	}
	async save(j: MaintenanceJob) {
		this.rows.set(j.id, this.copy(j));
	}
	async claimNext(now: Date) {
		const j = this.all().find(
			(x) => x.status === "queued" && x.notBefore <= now,
		);
		if (!j) return null;
		const c = this.copy(j);
		c.start(now);
		await this.save(c);
		return this.copy(c);
	}
	async listActive(repo: RepoRef) {
		return this.all()
			.filter((j) => j.isActive && j.repo.equals(repo))
			.map((j) => this.copy(j));
	}
	async listByStatus(status: MaintenanceJob["status"]) {
		return this.all()
			.filter((j) => j.status === status)
			.map((j) => this.copy(j));
	}
	async countTriggeredBy(login: string, since: Date) {
		return this.all().filter(
			(j) =>
				j.trigger.actorLogin === login &&
				j.createdAt >= since &&
				!j.trigger.cause.startsWith("job:"),
		).length;
	}
	async listRecent(limit: number) {
		return this.all()
			.reverse()
			.slice(0, limit)
			.map((j) => this.copy(j));
	}
	async deleteFinishedBefore(before: Date) {
		const ids: string[] = [];
		for (const j of this.all())
			if (!j.isActive && j.updatedAt < before) {
				this.rows.delete(j.id);
				ids.push(j.id);
			}
		return ids;
	}
}
