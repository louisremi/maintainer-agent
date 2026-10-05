import type Database from "better-sqlite3";
import type {
	ConnectionRepository,
	WatchedRepositoryRepository,
} from "../../../connections/application";
import {
	Connection,
	type ConnectionCredentials,
	type ConnectionProps,
	WatchedRepository,
} from "../../../connections/domain";
import { isPlatform, RepoRef } from "../../../shared-kernel";
import type { SecretCipher } from "../../crypto/secret-cipher";

interface ConnectionRow {
	id: string;
	platform: string;
	host: string;
	kind: string;
	display_name: string;
	owner_account: string | null;
	is_public: number;
	status: string;
	registration_state: string | null;
	credentials: string | null;
	appearance_done: number;
	created_at: string;
	updated_at: string;
}

export class SqliteConnectionRepository implements ConnectionRepository {
	constructor(
		private readonly db: Database.Database,
		private readonly cipher: SecretCipher,
	) {}

	async get(id: string) {
		const row = this.db
			.prepare("SELECT * FROM connections WHERE id = ?")
			.get(id) as ConnectionRow | undefined;
		return row ? this.toDomain(row) : null;
	}

	async findByRegistrationState(state: string) {
		const row = this.db
			.prepare("SELECT * FROM connections WHERE registration_state = ?")
			.get(state) as ConnectionRow | undefined;
		return row ? this.toDomain(row) : null;
	}

	async list() {
		const rows = this.db
			.prepare("SELECT * FROM connections ORDER BY created_at, id")
			.all() as ConnectionRow[];
		return rows.map((r) => this.toDomain(r));
	}

	async save(c: Connection) {
		const s = c.snapshot();
		this.db
			.prepare(`
      INSERT INTO connections (id, platform, host, kind, display_name, owner_account, is_public, status, registration_state, credentials, appearance_done, created_at, updated_at)
      VALUES (@id, @platform, @host, @kind, @display_name, @owner_account, @is_public, @status, @registration_state, @credentials, @appearance_done, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform, host = excluded.host, kind = excluded.kind, display_name = excluded.display_name,
        owner_account = excluded.owner_account, is_public = excluded.is_public, status = excluded.status,
        registration_state = excluded.registration_state, credentials = excluded.credentials, appearance_done = excluded.appearance_done, updated_at = excluded.updated_at
    `)
			.run({
				id: s.id,
				platform: s.platform,
				host: s.host,
				kind: s.kind,
				display_name: s.displayName,
				owner_account: s.ownerAccount,
				is_public: s.isPublic ? 1 : 0,
				status: s.status,
				registration_state: s.registrationState,
				credentials: s.credentials
					? this.cipher.encrypt(JSON.stringify(s.credentials))
					: null,
				appearance_done: s.appearanceDone ? 1 : 0,
				created_at: s.createdAt.toISOString(),
				updated_at: s.updatedAt.toISOString(),
			});
	}

	async delete(id: string) {
		this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
	}

	private toDomain(r: ConnectionRow): Connection {
		if (!isPlatform(r.platform))
			throw new Error(`stored connection ${r.id} has an unknown platform`);
		const props: ConnectionProps = {
			id: r.id,
			platform: r.platform,
			host: r.host,
			kind: r.kind as ConnectionProps["kind"],
			displayName: r.display_name,
			ownerAccount: r.owner_account,
			isPublic: r.is_public === 1,
			status: r.status as ConnectionProps["status"],
			registrationState: r.registration_state,
			credentials: r.credentials
				? (JSON.parse(
						this.cipher.decrypt(r.credentials),
					) as ConnectionCredentials)
				: null,
			appearanceDone: r.appearance_done === 1,
			createdAt: new Date(r.created_at),
			updatedAt: new Date(r.updated_at),
		};
		return Connection.restore(props);
	}
}

interface WatchedRow {
	repo_key: string;
	connection_id: string;
	enabled: number;
	contested_by: string;
	first_seen: string;
}

export class SqliteWatchedRepositoryRepository
	implements WatchedRepositoryRepository
{
	constructor(private readonly db: Database.Database) {}

	async get(repo: RepoRef) {
		const row = this.db
			.prepare("SELECT * FROM watched_repositories WHERE repo_key = ?")
			.get(repo.key) as WatchedRow | undefined;
		return row ? toWatched(row) : null;
	}

	async listByConnection(connectionId: string) {
		const rows = this.db
			.prepare(
				"SELECT * FROM watched_repositories WHERE connection_id = ? ORDER BY repo_key",
			)
			.all(connectionId) as WatchedRow[];
		return rows.map(toWatched);
	}

	async list() {
		return (
			this.db
				.prepare("SELECT * FROM watched_repositories ORDER BY repo_key")
				.all() as WatchedRow[]
		).map(toWatched);
	}

	async save(w: WatchedRepository) {
		const s = w.snapshot();
		this.db
			.prepare(`
      INSERT INTO watched_repositories (repo_key, connection_id, enabled, contested_by, first_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_key) DO UPDATE SET connection_id = excluded.connection_id, enabled = excluded.enabled, contested_by = excluded.contested_by
    `)
			.run(
				s.repo.key,
				s.connectionId,
				s.enabled ? 1 : 0,
				JSON.stringify(s.contestedBy),
				s.firstSeen.toISOString(),
			);
	}

	async delete(repo: RepoRef) {
		this.db
			.prepare("DELETE FROM watched_repositories WHERE repo_key = ?")
			.run(repo.key);
	}
}

function toWatched(r: WatchedRow): WatchedRepository {
	return WatchedRepository.restore({
		repo: RepoRef.parse(r.repo_key),
		connectionId: r.connection_id,
		enabled: r.enabled === 1,
		contestedBy: JSON.parse(r.contested_by) as string[],
		firstSeen: new Date(r.first_seen),
	});
}
