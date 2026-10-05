import "reflect-metadata";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSecretSources } from "../adapters/secrets/secret-sources";
import { YamlSettingsMigrations } from "../adapters/settings-file/migrations";
import { settingsJsonSchema } from "../adapters/settings-file/schema";
import { YamlSettingsParser } from "../adapters/settings-file/yaml-settings-parser";
import { ValidateSettingsText } from "../settings/application";
import { formatIssue } from "../settings/domain";

/**
 * Command-line tools, run without starting the server:
 *   validate-config [path]   exit 0 if valid, 1 with the problems otherwise
 *   schema [--check file] [--write file]   print / compare / write the JSON Schema
 */
export function runCli(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
): number {
	const [command, ...rest] = argv;
	const configDir = env.CONFIG_DIR ?? "/config";
	if (command === "validate-config") {
		const path = rest[0] ?? join(configDir, "settings.yml");
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			process.stderr.write(`cannot read ${path}\n`);
			return 1;
		}
		const secrets = loadSecretSources({
			env,
			secretsFile: join(resolve(path, ".."), "secrets.yaml"),
		});
		const migrations = new YamlSettingsMigrations(async () => "");
		const r = new ValidateSettingsText(
			new YamlSettingsParser(() => secrets),
			migrations,
		).execute(text);
		if (r.ok) {
			process.stdout.write(`${path}: valid (version ${migrations.current})\n`);
			return 0;
		}
		process.stderr.write(
			`${path}: invalid\n${r.issues.map((i) => `  ${formatIssue(i)}`).join("\n")}\n`,
		);
		return 1;
	}
	if (command === "schema") {
		const json = `${JSON.stringify(settingsJsonSchema(), null, "\t")}\n`;
		const check = rest.indexOf("--check");
		const write = rest.indexOf("--write");
		if (check >= 0 && rest[check + 1]) {
			const current = readFileSync(rest[check + 1] as string, "utf8");
			if (current !== json) {
				process.stderr.write(
					`${rest[check + 1]} is out of date: run pnpm schema:write\n`,
				);
				return 1;
			}
			return 0;
		}
		if (write >= 0 && rest[write + 1]) {
			writeFileSync(rest[write + 1] as string, json);
			return 0;
		}
		process.stdout.write(json);
		return 0;
	}
	process.stderr.write(
		"usage: validate-config [settings.yml] | schema [--check FILE | --write FILE]\n",
	);
	return 2;
}

if (require.main === module) {
	process.exit(runCli(process.argv.slice(2), process.env));
}
