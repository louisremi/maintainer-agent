import type {
	ConnectionSummary,
	RegistrationForm,
} from "../../connections/application";
import type { JobSummary } from "../../maintenance/application";
import type { SettingsIssue } from "../../settings/domain";

/** A repository a connection reaches, and how settings.yml treats it. */
export interface AdminRepository {
	readonly key: string;
	readonly path: string;
	readonly contestedBy: readonly string[];
	/** Listed under `repositories` in settings.yml. */
	readonly configured: boolean;
	/** Configured and not paused. */
	readonly enabled: boolean;
	/** Its key in settings.yml (host/path). */
	readonly settingsKey: string;
}

export type AdminConnection = Omit<ConnectionSummary, "repositories"> & {
	readonly repositories: readonly AdminRepository[];
};

/** The operations the admin pages offer, implemented by the composition root. */
export interface AdminApplication {
	overview(): Promise<{
		connections: AdminConnection[];
		jobs: JobSummary[];
		modelAvailable: boolean;
		publicUrl: string;
		secretsEncrypted: boolean;
		models: { name: string; apiBase: string; model: string }[];
		configuredRepositories: { key: string; enabled: boolean }[];
	}>;
	startGithubRegistration(input: {
		host: string;
		ownerAccount: string | null;
		isPublic: boolean;
	}): Promise<RegistrationForm>;
	completeGithubRegistration(input: {
		state: string;
		code: string;
	}): Promise<{ installUrl: string }>;
	resync(
		connectionId: string,
	): Promise<{ watched: string[]; contested: string[]; released: string[] }>;
	/** Records in settings.yml that the app's logo was uploaded (restarts). */
	markAppearanceDone(connectionId: string): Promise<void>;
}

/** The settings file as the admin pages see it (implemented by the composition root). */
export interface SettingsAdminPort {
	readonly path: string;
	readonly mode: "normal" | "safe";
	readonly issues: readonly SettingsIssue[];
	readonly migratedFrom: number | null;
	text(): Promise<string>;
	validate(
		text: string,
	): { ok: true } | { ok: false; issues: readonly SettingsIssue[] };
	save(
		text: string,
	): Promise<{ ok: true } | { ok: false; issues: readonly SettingsIssue[] }>;
	secretSources(): { name: string; source: string }[];
}
