import {
	AggregateRoot,
	IntegrationEvents,
	type RepoRef,
} from "../../shared-kernel";

export interface WatchedRepositoryProps {
	repo: RepoRef;
	connectionId: string;
	enabled: boolean;
	/** Other connections that also reach this repository (they are ignored). */
	contestedBy: string[];
	firstSeen: Date;
}

export class RepositoryWatched {
	readonly type = IntegrationEvents.repositoryWatched;
	constructor(
		readonly repoKey: string,
		readonly connectionId: string,
		readonly occurredAt: Date,
	) {}
}

export class RepositoryUnwatched {
	readonly type = IntegrationEvents.repositoryUnwatched;
	constructor(
		readonly repoKey: string,
		readonly connectionId: string,
		readonly occurredAt: Date,
	) {}
}

export class RepositoryClaimContested {
	readonly type = "connections.repository-claim-contested";
	constructor(
		readonly repoKey: string,
		readonly ownerConnectionId: string,
		readonly contenderConnectionId: string,
		readonly occurredAt: Date,
	) {}
}

/**
 * A repository the server maintains through exactly one connection.
 * Invariant: one owning connection per repository (see {@link ClaimPolicy}).
 */
export class WatchedRepository extends AggregateRoot {
	private constructor(private props: WatchedRepositoryProps) {
		super();
	}

	static watch(
		repo: RepoRef,
		connectionId: string,
		now: Date,
	): WatchedRepository {
		const w = new WatchedRepository({
			repo,
			connectionId,
			enabled: true,
			contestedBy: [],
			firstSeen: now,
		});
		w.record(new RepositoryWatched(repo.key, connectionId, now));
		return w;
	}

	static restore(props: WatchedRepositoryProps): WatchedRepository {
		return new WatchedRepository({
			...props,
			contestedBy: [...props.contestedBy],
		});
	}

	/** Another connection can reach this repository; it is recorded, not obeyed. */
	noteContest(connectionId: string, now: Date): void {
		if (
			connectionId === this.props.connectionId ||
			this.props.contestedBy.includes(connectionId)
		)
			return;
		this.props.contestedBy = [...this.props.contestedBy, connectionId];
		this.record(
			new RepositoryClaimContested(
				this.repo.key,
				this.connectionId,
				connectionId,
				now,
			),
		);
	}

	/** A contender lost access; forget it. */
	dropContest(connectionId: string): void {
		this.props.contestedBy = this.props.contestedBy.filter(
			(c) => c !== connectionId,
		);
	}

	/** The owning connection lost access: the aggregate is about to be deleted. */
	release(now: Date): void {
		this.record(new RepositoryUnwatched(this.repo.key, this.connectionId, now));
	}

	/** Re-enabling is announced like a new watch, so per-repository setup (labels) runs again. */
	enable(now: Date): void {
		if (this.props.enabled) return;
		this.props.enabled = true;
		this.record(new RepositoryWatched(this.repo.key, this.connectionId, now));
	}
	disable(): void {
		this.props.enabled = false;
	}

	get repo(): RepoRef {
		return this.props.repo;
	}
	get connectionId(): string {
		return this.props.connectionId;
	}
	get enabled(): boolean {
		return this.props.enabled;
	}
	get contestedBy(): readonly string[] {
		return this.props.contestedBy;
	}
	get firstSeen(): Date {
		return this.props.firstSeen;
	}

	snapshot(): Readonly<WatchedRepositoryProps> {
		return { ...this.props, contestedBy: [...this.props.contestedBy] };
	}
}
