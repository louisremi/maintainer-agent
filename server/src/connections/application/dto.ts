import type { Platform } from "../../shared-kernel";
import type {
	Connection,
	ConnectionCredentials,
	ConnectionStatus,
	WatchedRepository,
} from "../domain";

export interface ConnectionSummary {
	readonly id: string;
	readonly platform: Platform;
	readonly host: string;
	readonly displayName: string;
	readonly ownerAccount: string | null;
	readonly status: ConnectionStatus;
	readonly isPublic: boolean;
	readonly createdAt: string;
	readonly installUrl: string | null;
	readonly repositories: readonly WatchedRepositorySummary[];
}

export interface WatchedRepositorySummary {
	readonly key: string;
	readonly path: string;
	readonly enabled: boolean;
	readonly contestedBy: readonly string[];
}

/** Everything a forge adapter needs to act as a connection. */
export interface ConnectionAccess {
	readonly connectionId: string;
	readonly platform: Platform;
	readonly host: string;
	readonly credentials: ConnectionCredentials;
}

export function toRepositorySummary(
	r: WatchedRepository,
): WatchedRepositorySummary {
	return {
		key: r.repo.key,
		path: r.repo.path,
		enabled: r.enabled,
		contestedBy: [...r.contestedBy],
	};
}

export function toAccess(c: Connection): ConnectionAccess | null {
	if (!c.acceptsEvents || !c.credentials) return null;
	return {
		connectionId: c.id,
		platform: c.platform,
		host: c.host,
		credentials: c.credentials,
	};
}
