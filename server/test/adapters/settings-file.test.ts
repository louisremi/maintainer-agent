import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecretSources } from "../../src/adapters/secrets/secret-sources";
import { FsSettingsFile } from "../../src/adapters/settings-file/fs-settings-file";
import { buildLegacyImport } from "../../src/adapters/settings-file/legacy-import";
import { YamlSettingsMigrations } from "../../src/adapters/settings-file/migrations";
import { settingsJsonSchema } from "../../src/adapters/settings-file/schema";
import { upsertSecrets } from "../../src/adapters/settings-file/secrets-file";
import { YamlSettingsParser } from "../../src/adapters/settings-file/yaml-settings-parser";
import {
	LoadSettings,
	SaveSettingsText,
	ValidateSettingsText,
} from "../../src/settings/application";
import {
	effectiveRepositorySettings,
	formatIssue,
} from "../../src/settings/domain";
import { MemoryLogger } from "../support/fakes";

const EXAMPLE = readFileSync(
	join(__dirname, "../../../docs/settings.example.yml"),
	"utf8",
);

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ma-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const secrets = (
	env: Record<string, string> = {},
	file?: Record<string, string>,
) => {
	if (file)
		writeFileSync(
			join(dir, "secrets.yaml"),
			Object.entries(file)
				.map(([k, v]) => `${k}: "${v}"`)
				.join("\n"),
		);
	return loadSecretSources({
		env,
		secretsFile: join(dir, "secrets.yaml"),
		secretsDir: join(dir, "no-such-dir"),
	});
};
const parser = (
	env: Record<string, string> = {},
	file?: Record<string, string>,
) => {
	const s = secrets(env, file);
	return new YamlSettingsParser(() => s);
};

describe("settings.yml parsing", () => {
	it("accepts the documented example", () => {
		const r = parser({ MA_ADMIN_TOKEN: "x".repeat(20) }).parse(EXAMPLE);
		expect(r.ok ? [] : r.issues.map(formatIssue)).toEqual([]);
	});

	const minimal = (extra = "") => `version: 1
server:
  public_url: https://a.example
models:
  default: { api_base: "http://m:8000/v1", model: openai/m }
${extra}`;

	it("applies defaults and maps names to the domain", () => {
		const r = parser().parse(
			minimal(
				`repositories:\n  github.com/o/r: {}\n  github.com/o/s:\n    model: big\n`,
			),
		);
		expect(r.ok).toBe(false); // unknown model "big"
		const ok = parser().parse(
			minimal(
				`repositories:\n  github.com/o/r:\n    fix: { step_limit: 500 }\n`,
			),
		);
		if (!ok.ok) throw new Error(ok.issues.map(formatIssue).join("\n"));
		expect(ok.settings.server.limits.maxStepLimit).toBe(120);
		expect(ok.settings.server.runnerImage).toBe(
			"louisremi/maintainer-agent:latest",
		);
		expect(
			effectiveRepositorySettings(ok.settings, "github.com/o/r")?.fix.stepLimit,
		).toBe(120);
	});

	it("locates errors by line and column", () => {
		const r = parser().parse(
			minimal(
				`repositories:\n  github.com/o/r:\n    fix: { step_limit: "many" }\n    color: red\n`,
			),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		const text = r.issues.map(formatIssue).join("\n");
		expect(text).toMatch(
			/line 8:\d+ repositories\.github\.com\/o\/r\.fix\.step_limit: /,
		);
		expect(text).toMatch(
			/line \d+:\d+ repositories\.github\.com\/o\/r: .*color/,
		);
	});

	it("reports YAML syntax errors with a position", () => {
		const r = parser().parse("version: 1\nserver: [\n");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues[0]?.line).toBeGreaterThan(0);
	});

	it("checks references to models and connections", () => {
		const r = parser().parse(
			minimal(
				`defaults:\n  model: { fix: nope }\nrepositories:\n  github.com/o/r: { connection: ghost }\n`,
			),
		);
		expect(r.ok ? [] : r.issues.map((i) => i.message)).toEqual([
			'unknown model "nope" (define it under models)',
			'unknown connection "ghost"',
		]);
	});

	it("rejects bad repository keys, unknown keys and GitLab connections for now", () => {
		const r = parser().parse(
			minimal(`unknown_top: 1\nrepositories:\n  octo/repo: {}\n`),
		);
		expect(r.ok).toBe(false);
		const g = parser({ MA_K: "k", MA_W: "w" }).parse(
			minimal(
				`connections:\n  lab: { platform: gitlab, host: gitlab.com, app_id: "1", app_slug: x, private_key: "{MA_K}", webhook_secret: "{MA_W}" }\n`,
			),
		);
		expect(g.ok ? [] : g.issues.map((i) => i.message)).toEqual([
			"gitlab connections are not supported yet",
		]);
	});
});

describe("secrets", () => {
	const withKey = `version: 1
server:
  public_url: https://a.example
models:
  default: { api_base: "http://m:8000/v1", model: openai/m, api_key: "{MA_LLM_KEY}" }
`;

	it("resolves placeholders, Docker secrets over environment over secrets.yaml", () => {
		mkdirSync(join(dir, "run"));
		writeFileSync(join(dir, "run", "MA_LLM_KEY"), "from-docker\n");
		writeFileSync(
			join(dir, "secrets.yaml"),
			"MA_LLM_KEY: from-file\nMA_ONLY_FILE: f\n",
		);
		const all = loadSecretSources({
			env: { MA_LLM_KEY: "from-env" },
			secretsFile: join(dir, "secrets.yaml"),
			secretsDir: join(dir, "run"),
		});
		expect(all.get("MA_LLM_KEY")).toEqual({
			value: "from-docker",
			source: "docker secrets",
		});
		expect(all.duplicates).toEqual([
			{
				name: "MA_LLM_KEY",
				used: "docker secrets",
				ignored: ["environment", "secrets.yaml"],
			},
		]);
		const noDocker = loadSecretSources({
			env: { MA_LLM_KEY: "from-env" },
			secretsFile: join(dir, "secrets.yaml"),
			secretsDir: join(dir, "none"),
		});
		const r = new YamlSettingsParser(() => noDocker).parse(withKey);
		expect(r.ok && r.settings.models.default?.apiKey).toBe("from-env");
		expect(r.ok && r.secretsUsed).toEqual(["MA_LLM_KEY"]);
		expect(noDocker.sources()).toEqual([
			{ name: "MA_LLM_KEY", source: "environment" },
			{ name: "MA_ONLY_FILE", source: "secrets.yaml" },
		]);
	});

	it("names the field of an undefined secret, and refuses placeholders outside secret fields", () => {
		const r = parser().parse(withKey);
		expect(r.ok ? [] : r.issues.map(formatIssue)).toEqual([
			"line 5:70 models.default.api_key: secret MA_LLM_KEY is not defined (Docker secret, environment variable or secrets.yaml)",
		]);
		const p = parser({ MA_X: "x" }).parse(
			withKey.replace("https://a.example", '"{MA_X}"'),
		);
		expect(p.ok ? [] : p.issues.map((i) => i.message)).toContain(
			"placeholders like {MA_NAME} are only allowed in secret fields",
		);
	});

	it("rejects badly named entries in secrets.yaml", () => {
		writeFileSync(join(dir, "secrets.yaml"), "LLM_KEY: x\n");
		expect(() =>
			loadSecretSources({
				env: {},
				secretsFile: join(dir, "secrets.yaml"),
				secretsDir: join(dir, "none"),
			}),
		).toThrow(/must start with MA_/);
	});

	it("writes secrets.yaml with mode 600, keeping other entries and comments", async () => {
		const p = join(dir, "secrets.yaml");
		writeFileSync(p, "# keep me\nMA_A: a\n");
		await upsertSecrets(p, { MA_B: "b", MA_A: "a2" });
		const text = readFileSync(p, "utf8");
		expect(text).toContain("# keep me");
		expect(text).toMatch(/MA_A: a2/);
		expect(text).toMatch(/MA_B: b/);
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});
});

describe("loading, migrating and saving", () => {
	const deps = (
		legacy = "",
		file = new FsSettingsFile(join(dir, "settings.yml")),
	) => {
		const log = new MemoryLogger();
		const migrations = new YamlSettingsMigrations(async () => legacy);
		return {
			file,
			log,
			migrations,
			parser: parser({ MA_ADMIN_TOKEN: "t".repeat(20) }),
			initialText: async () => EXAMPLE,
		};
	};

	it("creates the file from the documented defaults when missing", async () => {
		const d = deps();
		const r = await new LoadSettings(d).execute();
		expect(r.mode).toBe("normal");
		expect(readFileSync(join(dir, "settings.yml"), "utf8")).toBe(EXAMPLE);
	});

	it("migrates a file without version, keeping comments, with a backup", async () => {
		writeFileSync(
			join(dir, "settings.yml"),
			'# my notes\nserver:\n  public_url: https://a.example # inline\nmodels:\n  default: { api_base: "http://m/v1", model: openai/m }\n',
		);
		const d = deps();
		const r = await new LoadSettings(d).execute();
		expect(r.mode).toBe("normal");
		if (r.mode === "normal") expect(r.migratedFrom).toBe(0);
		const text = readFileSync(join(dir, "settings.yml"), "utf8");
		expect(text).toMatch(/^# my notes\nversion: 1\n/);
		expect(text).toContain("# inline");
		const backups = readdirSync(join(dir, "backups"));
		expect(backups).toHaveLength(1);
		expect(backups[0]).toMatch(/settings\..*\.v0\.yml$/);
		// Already current: untouched, no new backup.
		await new LoadSettings(d).execute();
		expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
	});

	it("imports the legacy configuration into an empty file", async () => {
		writeFileSync(join(dir, "settings.yml"), "");
		const d = deps(EXAMPLE);
		const r = await new LoadSettings(d).execute();
		expect(r.mode).toBe("normal");
	});

	it("goes into safe mode on invalid, read-only or too new files", async () => {
		writeFileSync(join(dir, "settings.yml"), "version: 1\nserver: {}\n");
		expect((await new LoadSettings(deps()).execute()).mode).toBe("safe");
		writeFileSync(join(dir, "settings.yml"), "version: 99\n");
		const newer = await new LoadSettings(deps()).execute();
		expect(newer.mode === "safe" && newer.issues[0]?.message).toMatch(
			/newer than this server supports/,
		);
		writeFileSync(join(dir, "settings.yml"), "server: {}\n");
		chmodSync(join(dir, "settings.yml"), 0o444);
		const ro = deps();
		ro.file.isWritable = async () => false;
		const r = await new LoadSettings(ro).execute();
		expect(r.mode === "safe" && r.issues[0]?.message).toMatch(/read-only/);
	});

	it("saves valid text atomically with a backup and requests a restart; rejects invalid text", async () => {
		const d = deps();
		await new LoadSettings(d).execute();
		const restarts: string[] = [];
		const save = new SaveSettingsText(
			d.file,
			new ValidateSettingsText(d.parser, d.migrations),
			{ requestRestart: (r) => restarts.push(r) },
			d.log,
		);
		const bad = await save.execute("version: 1\nserver: {}\n");
		expect(bad.ok).toBe(false);
		expect(readFileSync(join(dir, "settings.yml"), "utf8")).toBe(EXAMPLE);
		expect(restarts).toEqual([]);
		const next = EXAMPLE.replace(
			"max_concurrent_jobs: 1 ",
			"max_concurrent_jobs: 2 ",
		);
		expect(await save.execute(next)).toEqual({ ok: true });
		expect(readFileSync(join(dir, "settings.yml"), "utf8")).toBe(next);
		expect(restarts).toEqual(["settings saved"]);
		expect(
			readdirSync(join(dir, "backups")).some((f) => f.includes("before-edit")),
		).toBe(true);
		expect(existsSync(join(dir, "settings.yml.lock"))).toBe(false);
	});
});

describe("legacy (v0.2) import", () => {
	it("moves env and database configuration into settings and secrets", () => {
		const r = buildLegacyImport({
			env: {
				PUBLIC_URL: "https://agent.example.org",
				LLM_API_BASE: "http://evo:8731/v1",
				LLM_MODEL: "openai/halogen",
				LLM_MODEL_FIX: "openai/big",
				ADMIN_TOKEN: "admin-secret-value",
				ALLOWED_ACCOUNTS: "louisremi",
				MAX_STEP_LIMIT: "100",
				ISSUE_STEP_LIMIT: "25",
			},
			connections: [
				{
					id: "pT65bHPaztya8Sfi",
					host: "github.com",
					displayName: "ma",
					ownerAccount: null,
					appId: "77",
					appSlug: "ma-x",
					privateKey: "PEM",
					webhookSecret: "hook",
					appearanceDone: true,
				},
			],
			enabledRepositories: [
				"github:github.com/louisremi/a",
				"github:github.com/louisremi/b",
			],
		});
		expect(r.secrets).toEqual({
			MA_ADMIN_TOKEN: "admin-secret-value",
			MA_GITHUB_PT65BHPAZTYA8SFI_PRIVATE_KEY: "PEM",
			MA_GITHUB_PT65BHPAZTYA8SFI_WEBHOOK_SECRET: "hook",
		});
		expect(r.text).not.toContain("admin-secret-value");
		expect(r.text).not.toContain("PEM");
		const env = Object.fromEntries(Object.entries(r.secrets));
		const p = parser(env).parse(r.text);
		if (!p.ok) throw new Error(p.issues.map(formatIssue).join("\n"));
		expect(p.settings.connections.pT65bHPaztya8Sfi?.privateKey).toBe("PEM");
		expect(Object.keys(p.settings.repositories)).toEqual([
			"github.com/louisremi/a",
			"github.com/louisremi/b",
		]);
		const eff = effectiveRepositorySettings(
			p.settings,
			"github.com/louisremi/a",
		)!;
		expect(eff.model).toEqual({
			answer: "default",
			fix: "fix",
			review: "default",
		});
		expect(eff.answer.stepLimit).toBe(25);
		expect(p.settings.server.limits.maxStepLimit).toBe(100);
	});
});

describe("JSON Schema", () => {
	it("is generated from the same schema and marks secret fields", () => {
		const s = JSON.stringify(settingsJsonSchema());
		expect(s).toContain('"secret":true');
		expect(s).toContain("public_url");
	});
});
