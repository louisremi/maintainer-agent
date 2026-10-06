import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/adapters/config/server-config";
import { signGithubPayload } from "../../src/adapters/forges/github";
import { type App, buildApp } from "../../src/bootstrap/container";
import { createHttpServer } from "../../src/bootstrap/server";
import { TEST_PEM } from "../support/fake-github";
import {
	FakeAgents,
	FakeModelHealth,
	FakePolicyValidator,
	FakePublisher,
	FakeSanitizer,
	FakeWorkspaces,
	MemoryLogger,
} from "../support/fakes";

const ADMIN = "admin-password-for-tests";
const basic = `Basic ${Buffer.from(`op:${ADMIN}`).toString("base64")}`;

let dir: string;
let app: App | null = null;
let http: INestApplication | null = null;
let restarts: string[] = [];

async function start(
	settings: string | null,
	env: Record<string, string> = {},
	secrets: Record<string, string> = { MA_ADMIN_TOKEN: ADMIN },
) {
	dir = mkdtempSync(join(tmpdir(), "ma-settings-e2e-"));
	if (settings !== null) writeFileSync(join(dir, "settings.yml"), settings);
	writeFileSync(
		join(dir, "secrets.yaml"),
		Object.entries(secrets)
			.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
			.join("\n"),
	);
	restarts = [];
	const config = loadConfig({ CONFIG_DIR: dir, DATA_DIR: dir });
	app = await buildApp(config, {
		env,
		engine: {} as never,
		workspaces: new FakeWorkspaces(),
		agents: new FakeAgents(),
		publisher: new FakePublisher(),
		sanitizer: new FakeSanitizer(),
		policyValidator: new FakePolicyValidator(),
		modelHealth: new FakeModelHealth(),
		logger: new MemoryLogger(),
		databaseFile: join(dir, "state.db"),
		processControl: { requestRestart: (r) => restarts.push(r) },
	});
	await app.init();
	http = await createHttpServer(app);
	await http.init();
	return http.getHttpServer();
}

afterEach(async () => {
	await http?.close();
	await app?.close();
	http = null;
	app = null;
	rmSync(dir, { recursive: true, force: true });
});

const VALID = `version: 1
server:
  public_url: https://agent.example.org
  admin_token: "{MA_ADMIN_TOKEN}"
models:
  default: { api_base: "http://model.invalid/v1", model: openai/test }
repositories:
  github.com/octo/widgets: {}
`;

const csrfOf = (html: string) =>
	/name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

describe("settings.yml at start-up", () => {
	it("creates a commented default file on a fresh installation (safe mode until edited)", async () => {
		const srv = await start(null);
		const text = readFileSync(join(dir, "settings.yml"), "utf8");
		expect(text).toMatch(/^# yaml-language-server: \$schema=/);
		// The example's placeholder model makes it valid; the admin token comes from secrets.yaml.
		expect(app?.settings?.server.publicUrl).toBe("https://agent.example.org");
		await request(srv).get("/admin").set("authorization", basic).expect(200);
	});

	it("imports a v0.2 installation from its environment variables", async () => {
		const srv = await start(
			null,
			{
				PUBLIC_URL: "https://old.example.org",
				LLM_API_BASE: "http://evo:8731/v1",
				LLM_MODEL: "openai/halogen",
				ADMIN_TOKEN: ADMIN,
				ALLOWED_ACCOUNTS: "octo",
			},
			{},
		);
		const text = readFileSync(join(dir, "settings.yml"), "utf8");
		expect(text).toContain("public_url: https://old.example.org");
		expect(text).toContain("api_base: http://evo:8731/v1");
		expect(text).toContain('admin_token: "{MA_ADMIN_TOKEN}"');
		expect(text).not.toContain(ADMIN);
		expect(readFileSync(join(dir, "secrets.yaml"), "utf8")).toContain(ADMIN);
		await request(srv).get("/admin").set("authorization", basic).expect(200);
	});

	it("starts in safe mode on an invalid file: admin and editor work, webhooks get 503, nothing runs", async () => {
		const srv = await start(
			VALID.replace("openai/test", "openai/test }\n  bad: {"),
		);
		expect(app?.settings).toBeNull();
		expect(app?.runNextJob).toBeNull();
		const page = await request(srv)
			.get("/admin")
			.set("authorization", basic)
			.expect(200);
		expect(page.text).toContain("Safe mode");
		const editor = await request(srv)
			.get("/admin/settings")
			.set("authorization", basic)
			.expect(200);
		expect(editor.text).toMatch(/line \d+/);
		const body = JSON.stringify({ zen: "x" });
		await request(srv)
			.post("/webhooks/any")
			.set("content-type", "application/json")
			.set("x-github-event", "ping")
			.set("x-github-delivery", "d1")
			.set("x-hub-signature-256", signGithubPayload("x", body))
			.send(body)
			.expect(503);
		await request(srv).get("/healthz").expect(200);
	});
});

describe("the settings editor", () => {
	it("shows the file, validates, refuses invalid text, saves valid text and restarts", async () => {
		const srv = await start(`# my comment\n${VALID}`);
		const page = await request(srv)
			.get("/admin/settings")
			.set("authorization", basic)
			.expect(200);
		expect(page.text).toContain("# my comment");
		expect(page.text).toContain("{MA_ADMIN_TOKEN}");
		expect(page.text).not.toContain(ADMIN);
		expect(page.text).toContain("MA_ADMIN_TOKEN</code></td><td>secrets.yaml");
		const csrf = csrfOf(page.text);
		const post = (text: string, action: string) =>
			request(srv)
				.post("/admin/settings")
				.set("authorization", basic)
				.type("form")
				.send({ _csrf: csrf, text, action });

		const check = await post(
			VALID.replace("{}", "{ model: big }"),
			"validate",
		).expect(200);
		expect(check.text).toContain("unknown model &quot;big&quot;");
		const bad = await post("version: 1\nserver: {}\n", "save").expect(400);
		expect(bad.text).toContain("problem");
		expect(readFileSync(join(dir, "settings.yml"), "utf8")).toContain(
			"# my comment",
		);
		expect(restarts).toEqual([]);

		const next = `# my comment\n${VALID.replace("github.com/octo/widgets: {}", "github.com/octo/widgets: { fix: { step_limit: 50 } }")}`;
		const ok = await post(next, "save").expect(200);
		expect(ok.text).toContain("Restarting");
		expect(readFileSync(join(dir, "settings.yml"), "utf8")).toBe(next);
		expect(restarts).toEqual(["settings saved"]);

		// Without the form token (cross-site), refused.
		await request(srv)
			.post("/admin/settings")
			.set("authorization", basic)
			.type("form")
			.send({ text: next, action: "save" })
			.expect(403);
	});

	it("publishes the JSON Schema", async () => {
		const srv = await start(VALID);
		const r = await request(srv).get("/settings/schema.json").expect(200);
		expect(r.body.properties.version.const).toBe(1);
	});
});

describe("repository scope", () => {
	it("lists reachable repositories that are not configured, with a snippet", async () => {
		const srv = await start(
			VALID.replace(
				"repositories:\n  github.com/octo/widgets: {}\n",
				`connections:
  me:
    app_id: "1"
    app_slug: ma-me
    private_key: "{MA_K}"
    webhook_secret: "{MA_W}"
repositories:
  github.com/octo/widgets: {}
`,
			),
			{},
			{ MA_ADMIN_TOKEN: ADMIN, MA_K: TEST_PEM, MA_W: "w" },
		);
		const db = app?.db;
		db?.prepare(
			"INSERT INTO watched_repositories (repo_key, connection_id, enabled, contested_by, first_seen) VALUES (?, 'me', 1, '[]', ?)",
		).run("github:github.com/octo/other", new Date().toISOString());
		db?.prepare(
			"INSERT INTO watched_repositories (repo_key, connection_id, enabled, contested_by, first_seen) VALUES (?, 'me', 1, '[]', ?)",
		).run("github:github.com/octo/widgets", new Date().toISOString());
		const page = await request(srv)
			.get("/admin")
			.set("authorization", basic)
			.expect(200);
		expect(page.text).toContain("not configured (ignored)");
		expect(page.text).toContain("  github.com/octo/other: {}");
		expect(page.text).toMatch(
			/octo\/widgets<\/td>\s*<td><span class="ok">configured/,
		);
	});
});
