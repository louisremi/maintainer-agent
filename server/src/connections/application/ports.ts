import type { Platform, RepoRef } from "../../shared-kernel";
import type {
	Connection,
	ConnectionCredentials,
	WatchedRepository,
} from "../domain";
import type { ConnectionAccess } from "./dto";

export interface ConnectionRepository {
	get(id: string): Promise<Connection | null>;
	findByRegistrationState(state: string): Promise<Connection | null>;
	list(): Promise<Connection[]>;
	save(connection: Connection): Promise<void>;
	delete(id: string): Promise<void>;
}

export interface WatchedRepositoryRepository {
	get(repo: RepoRef): Promise<WatchedRepository | null>;
	listByConnection(connectionId: string): Promise<WatchedRepository[]>;
	list(): Promise<WatchedRepository[]>;
	save(repository: WatchedRepository): Promise<void>;
	delete(repo: RepoRef): Promise<void>;
}

/** What the operator's browser must POST to the forge to register an app. */
export interface RegistrationForm {
	readonly action: string;
	readonly fields: Readonly<Record<string, string>>;
}

export interface CompletedRegistration {
	readonly credentials: ConnectionCredentials;
	readonly displayName: string;
	readonly ownerAccount: string | null;
	/** Where the operator installs the new app on repositories. */
	readonly installUrl: string;
}

/** Forge-specific app registration (e.g. GitHub's App Manifest flow). */
export interface AppRegistrationGateway {
	readonly platform: Platform;
	registrationForm(connection: Connection): RegistrationForm;
	complete(
		connection: Connection,
		code: string,
	): Promise<CompletedRegistration>;
	installUrl(connection: Connection): string | null;
	/** Where the operator customises the app (logo...) on the forge, if anywhere. */
	appearanceUrl(connection: Connection): string | null;
}

export interface AppRegistrationGateways {
	for(platform: Platform): AppRegistrationGateway;
}

/** Unguessable random strings (registration state, identifiers). */
export interface SecretGenerator {
	token(bytes: number): string;
}

/** Asks a forge which repositories a connection can currently reach. */
export interface ForgeDirectory {
	listRepositories(access: ConnectionAccess): Promise<RepoRef[]>;
}

export interface ForgeDirectories {
	for(platform: Platform): ForgeDirectory;
}
