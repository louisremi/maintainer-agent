import type { Logger } from "../../shared-kernel";
import type { Settings, SettingsIssue } from "../domain";
import type {
	ProcessControl,
	SettingsFile,
	SettingsMigrations,
	SettingsParser,
} from "./ports";

export type LoadedSettings =
	| {
			readonly mode: "normal";
			readonly settings: Settings;
			readonly text: string;
			readonly migratedFrom: number | null;
	  }
	/**
	 * Safe mode (as in Frigate): the file is invalid. The server only serves
	 * the admin pages and the editor; no events or jobs are processed.
	 */
	| {
			readonly mode: "safe";
			readonly issues: readonly SettingsIssue[];
			readonly text: string;
	  };

export interface SettingsDeps {
	readonly file: SettingsFile;
	readonly migrations: SettingsMigrations;
	readonly parser: SettingsParser;
	readonly log: Logger;
	/** Text of a new settings file when none exists (documented defaults). */
	readonly initialText: () => Promise<string>;
}

/**
 * Reads settings.yml, creates it when missing, applies pending schema
 * migrations (each step backed up and written), then validates.
 */
export class LoadSettings {
	constructor(private readonly d: SettingsDeps) {}

	async execute(): Promise<LoadedSettings> {
		const { file, migrations, log } = this.d;
		let text: string;
		if (!(await file.exists())) {
			text = await this.d.initialText();
			await file.withLock(() => file.write(text));
			log.warn("no settings file found; created one", { path: file.path });
		} else {
			text = await file.read();
		}

		const from = migrations.versionOf(text);
		let migratedFrom: number | null = null;
		if (from > migrations.current) {
			return {
				mode: "safe",
				text,
				issues: [
					{
						path: ["version"],
						message: `version ${from} is newer than this server supports (${migrations.current}); upgrade the server`,
					},
				],
			};
		}
		if (from < migrations.current) {
			if (!(await file.isWritable())) {
				return {
					mode: "safe",
					text,
					issues: [
						{
							path: ["version"],
							message: `the settings file needs migrating from version ${from} to ${migrations.current} but is read-only`,
						},
					],
				};
			}
			text = await file.withLock(async () => {
				let current = await file.read();
				const backup = await file.backup(`v${from}`);
				log.info("migrating settings", {
					path: file.path,
					from,
					to: migrations.current,
					backup,
				});
				for (const step of migrations.steps()) {
					if (step.from < migrations.versionOf(current)) continue;
					current = await step.migrate(current);
					await file.write(current);
					log.info("settings migration applied", {
						from: step.from,
						to: step.to,
						description: step.description,
					});
				}
				return current;
			});
			migratedFrom = from;
		}

		const parsed = this.d.parser.parse(text);
		if (!parsed.ok) return { mode: "safe", text, issues: parsed.issues };
		return { mode: "normal", settings: parsed.settings, text, migratedFrom };
	}
}

/** Checks text as if it were saved (used by the editor and the CLI). */
export class ValidateSettingsText {
	constructor(
		private readonly parser: SettingsParser,
		private readonly migrations: SettingsMigrations,
	) {}

	execute(
		text: string,
	): { ok: true } | { ok: false; issues: readonly SettingsIssue[] } {
		const v = this.migrations.versionOf(text);
		if (v !== this.migrations.current) {
			return {
				ok: false,
				issues: [
					{
						path: ["version"],
						message: `version must be ${this.migrations.current} (found ${v || "none"})`,
					},
				],
			};
		}
		const r = this.parser.parse(text);
		return r.ok ? { ok: true } : { ok: false, issues: r.issues };
	}
}

/**
 * Saves new settings text from the editor: validates it, backs up the
 * current file, writes atomically, then restarts the server so the new
 * settings apply (Frigate's "save and restart").
 */
export class SaveSettingsText {
	constructor(
		private readonly file: SettingsFile,
		private readonly validate: ValidateSettingsText,
		private readonly process: ProcessControl,
		private readonly log: Logger,
	) {}

	async execute(
		text: string,
	): Promise<{ ok: true } | { ok: false; issues: readonly SettingsIssue[] }> {
		const check = this.validate.execute(text);
		if (!check.ok) return check;
		if (!(await this.file.isWritable())) {
			return {
				ok: false,
				issues: [{ path: [], message: `${this.file.path} is read-only` }],
			};
		}
		await this.file.withLock(async () => {
			await this.file.backup("before-edit");
			await this.file.write(text.endsWith("\n") ? text : `${text}\n`);
		});
		this.log.info("settings saved; restarting", { path: this.file.path });
		this.process.requestRestart("settings saved");
		return { ok: true };
	}
}

/**
 * Applies a change to the settings document programmatically (e.g. the app
 * registration adds a connection) and restarts. `edit` gets the current text
 * and returns the new text; the result must still validate.
 */
export class EditSettings {
	constructor(
		private readonly file: SettingsFile,
		private readonly validate: ValidateSettingsText,
		private readonly process: ProcessControl,
		private readonly log: Logger,
	) {}

	async execute(
		reason: string,
		edit: (text: string) => string,
		opts: { restart: boolean },
	): Promise<void> {
		await this.file.withLock(async () => {
			const current = await this.file.read();
			const next = edit(current);
			const check = this.validate.execute(next);
			if (!check.ok) {
				throw new Error(
					`the edited settings would be invalid: ${check.issues.map((i) => i.message).join("; ")}`,
				);
			}
			await this.file.backup("before-edit");
			await this.file.write(next);
		});
		this.log.info("settings edited", { reason, path: this.file.path });
		if (opts.restart) this.process.requestRestart(reason);
	}
}
