import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { UnitOfWork } from "../../../shared-kernel";

const MIGRATIONS: readonly string[] = [
	// 1: initial schema
	`
  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    host TEXT NOT NULL,
    kind TEXT NOT NULL,
    display_name TEXT NOT NULL,
    owner_account TEXT,
    is_public INTEGER NOT NULL,
    status TEXT NOT NULL,
    registration_state TEXT UNIQUE,
    credentials TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE watched_repositories (
    repo_key TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    contested_by TEXT NOT NULL,
    first_seen TEXT NOT NULL
  );
  CREATE INDEX watched_repositories_connection ON watched_repositories(connection_id);
  CREATE TABLE deliveries (
    source TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (source, delivery_id)
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    number INTEGER NOT NULL,
    trigger_cause TEXT NOT NULL,
    trigger_actor TEXT NOT NULL,
    context TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    agent_failures INTEGER NOT NULL,
    not_before TEXT NOT NULL,
    outcome TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_due ON jobs(status, not_before, created_at);
  CREATE INDEX jobs_repo ON jobs(repo_key, status);
  CREATE INDEX jobs_actor ON jobs(trigger_actor, created_at);
  CREATE UNIQUE INDEX jobs_one_active ON jobs(repo_key, kind, number) WHERE status IN ('queued', 'running');
  `,
	// 2: the operator confirmed the app's logo was set
	`ALTER TABLE connections ADD COLUMN appearance_done INTEGER NOT NULL DEFAULT 0;`,
];

/** Opens (and migrates) the state database. The file is readable by its owner only. */
export function openDatabase(file: string): Database.Database {
	const isNew = file !== ":memory:" && !existsSync(file);
	const db = new Database(file);
	if (isNew) chmodSync(file, 0o600);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	migrate(db);
	return db;
}

export function migrate(db: Database.Database): void {
	const current = db.pragma("user_version", { simple: true }) as number;
	MIGRATIONS.slice(current).forEach((sql, i) => {
		db.transaction(() => {
			db.exec(sql);
			db.pragma(`user_version = ${current + i + 1}`);
		})();
	});
}

/**
 * Transactions for async application code. better-sqlite3 is synchronous, so
 * a transaction is opened with BEGIN IMMEDIATE and closed after the async
 * work; nested `run` calls join the outer transaction. Use cases keep these
 * scopes free of network calls.
 */
export class SqliteUnitOfWork implements UnitOfWork {
	private readonly scope = new AsyncLocalStorage<true>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly db: Database.Database) {}

	run<T>(work: () => Promise<T>): Promise<T> {
		if (this.scope.getStore()) return work();
		const next = this.queue.then(() =>
			this.scope.run(true, () => this.transaction(work)),
		);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async transaction<T>(work: () => Promise<T>): Promise<T> {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = await work();
			this.db.exec("COMMIT");
			return result;
		} catch (err) {
			if (this.db.inTransaction) this.db.exec("ROLLBACK");
			throw err;
		}
	}
}
