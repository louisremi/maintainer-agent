import type { Settings, SettingsIssue } from "../domain";

/** The settings file on disk. */
export interface SettingsFile {
	readonly path: string;
	exists(): Promise<boolean>;
	read(): Promise<string>;
	isWritable(): Promise<boolean>;
	/** Copies the current file to the backups folder; returns the backup path. */
	backup(label: string): Promise<string | null>;
	/** Replaces the file atomically (temp file + rename), under a lock. */
	write(text: string): Promise<void>;
	/** Runs `work` while holding the file's lock (serialises writers). */
	withLock<T>(work: () => Promise<T>): Promise<T>;
}

/** One schema migration, applied to the document text. */
export interface SettingsMigration {
	readonly from: number;
	readonly to: number;
	readonly description: string;
	migrate(text: string): Promise<string> | string;
}

export interface SettingsMigrations {
	readonly current: number;
	/** The version written in the text (0 when absent or the file is missing). */
	versionOf(text: string): number;
	steps(): readonly SettingsMigration[];
}

export type ParseResult =
	| {
			readonly ok: true;
			readonly settings: Settings;
			readonly secretsUsed: readonly string[];
	  }
	| { readonly ok: false; readonly issues: readonly SettingsIssue[] };

/** Parses and validates settings text (syntax, schema, secrets, references). */
export interface SettingsParser {
	parse(text: string): ParseResult;
}

/** Stops the process so the supervisor (Docker) restarts it with new settings. */
export interface ProcessControl {
	requestRestart(reason: string): void;
}
