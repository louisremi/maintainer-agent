import type { DomainEvent } from "./domain-event";

/**
 * Events one bounded context publishes for others. Contexts depend on these
 * shapes only, never on each other's domain classes.
 */
export const IntegrationEvents = {
	repositoryWatched: "connections.repository-watched",
	repositoryUnwatched: "connections.repository-unwatched",
} as const;

export interface RepositoryWatchedEvent extends DomainEvent {
	readonly type: typeof IntegrationEvents.repositoryWatched;
	readonly repoKey: string;
	readonly connectionId: string;
}

export function isRepositoryWatched(
	e: DomainEvent,
): e is RepositoryWatchedEvent {
	return e.type === IntegrationEvents.repositoryWatched;
}
