import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/adapters/config/server-config";
import { signGithubPayload } from "../../src/adapters/forges/github";
import { type App, buildApp } from "../../src/bootstrap/container";
import { createHttpServer } from "../../src/bootstrap/server";
import { Verdict } from "../../src/maintenance/domain";
import { FakeGithubApi, TEST_PEM } from "../support/fake-github";
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

function basic(password: string) {
	return `Basic ${Buffer.from(`op:${password}`).toString("base64")}`;
}

describe("HTTP server (end to end, fake GitHub and sandbox)", () => {
	let dir: string;
	let app: App;
	let http: INestApplication;
	let api: FakeGithubApi;
	let agents: FakeAgents;
	let workspaces: FakeWorkspaces;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "ma-e2e-"));
		api = new FakeGithubApi();
		agents = new FakeAgents();
		workspaces = new FakeWorkspaces();
		const config = loadConfig({
			PUBLIC_URL: "https://agent.example.org",
			LLM_API_BASE: "http://model.invalid:8000/v1",
			LLM_MODEL: "openai/test",
			DATA_DIR: dir,
			ADMIN_TOKEN: ADMIN,
			SECRETS_KEY: "a-long-enough-secrets-key",
			GITHUB_APP_ID: "123",
			GITHUB_APP_SLUG: "ma-env",
			GITHUB_PRIVATE_KEY: TEST_PEM,
			GITHUB_WEBHOOK_SECRET: "env-secret",
			PUBLIC_PATHS_ONLY_VIA_HOST: "agent.example.org",
		});
		app = buildApp(config, {
			fetch: api.fetch,
			engine: {} as never,
			workspaces,
			agents,
			publisher: new FakePublisher(),
			sanitizer: new FakeSanitizer(),
			policyValidator: new FakePolicyValidator(),
			modelHealth: new FakeModelHealth(),
			logger: new MemoryLogger(),
			databaseFile: ":memory:",
		});
		await app.init();
		http = await createHttpServer(app);
		await http.init();
	});

	afterEach(async () => {
		await http.close();
		await app.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const hook = (
		connectionId: string,
		event: string,
		payload: unknown,
		secret: string,
		delivery = `d-${Math.random().toString(36).slice(2)}`,
	) => {
		const body = JSON.stringify(payload);
		return request(http.getHttpServer())
			.post(`/webhooks/${connectionId}`)
			.set("content-type", "application/json")
			.set("x-github-event", event)
			.set("x-github-delivery", delivery)
			.set("x-hub-signature-256", signGithubPayload(secret, body))
			.send(body);
	};

	it("serves a health check and protects /admin", async () => {
		await request(http.getHttpServer())
			.get("/healthz")
			.expect(200, { ok: true });
		const denied = await request(http.getHttpServer())
			.get("/admin")
			.expect(401);
		expect(denied.headers["www-authenticate"]).toMatch(/^Basic/);
		await request(http.getHttpServer())
			.get("/admin")
			.set("authorization", basic("wrong-password-xxxxx"))
			.expect(401);
		const ok = await request(http.getHttpServer())
			.get("/admin")
			.set("authorization", basic(ADMIN))
			.expect(200);
		expect(ok.text).toContain("ma-env");
		expect(ok.text).toContain("https://agent.example.org/webhooks/env");
	});

	it("rejects webhooks for unknown connections and with bad signatures", async () => {
		await hook("nope", "ping", {}, "env-secret").expect(404);
		await request(http.getHttpServer()).post("/webhooks/nope").expect(404);
		await request(http.getHttpServer()).post("/webhooks/env").expect(401);
		await hook("env", "ping", {}, "wrong-secret").expect(401);
		await hook("env", "ping", { zen: "x" }, "env-secret").expect(202);
	});

	it("watches installed repositories, answers a new issue, and ignores redeliveries", async () => {
		api
			.withInstallation("octo", "widgets")
			.on("POST", "/repos/octo/widgets/labels", { status: 201, body: {} })
			.on("GET", "/repos/octo/widgets", { body: { default_branch: "main" } })
			.on("GET", "/repos/octo/widgets/branches/main", {
				body: { commit: { sha: "a".repeat(40) } },
			})
			.on("GET", /^\/repos\/octo\/widgets\/contents\//, {
				status: 404,
				body: {},
			})
			.on("GET", "/repos/octo/widgets/issues/7", {
				body: {
					number: 7,
					title: "How?",
					body: "How do I x?",
					user: { login: "zoe" },
					author_association: "NONE",
					labels: [],
					state: "open",
				},
			})
			.on("GET", /^\/repos\/octo\/widgets\/issues\/7\/comments/, { body: [] })
			.on("POST", "/repos/octo/widgets/issues/7/comments", {
				status: 201,
				body: { html_url: "https://github.com/octo/widgets/issues/7#c" },
			});

		await hook(
			"env",
			"installation",
			{ action: "created", repositories: [{ full_name: "octo/widgets" }] },
			"env-secret",
		).expect(202);
		expect(
			api.requests.filter((r) => r.path === "/repos/octo/widgets/labels")
				.length,
		).toBeGreaterThanOrEqual(5);

		const issue = {
			action: "opened",
			repository: { full_name: "octo/widgets" },
			sender: { login: "zoe" },
			issue: {
				number: 7,
				user: { login: "zoe" },
				author_association: "NONE",
				labels: [],
			},
		};
		const first = await hook(
			"env",
			"issues",
			issue,
			"env-secret",
			"same-delivery",
		).expect(202);
		expect(first.body.status).toBe("accepted");
		await hook("env", "issues", issue, "env-secret", "same-delivery").expect(
			202,
			{ status: "duplicate" },
		);

		agents.verdicts.push({
			ok: true,
			value: Verdict.of("question", "Run `x --help`."),
		});
		const r = await app.runNextJob.execute();
		expect(r).toMatchObject({ kind: "ran", status: "succeeded" });
		const posted = api.requests.find(
			(q) =>
				q.method === "POST" &&
				q.path === "/repos/octo/widgets/issues/7/comments",
		);
		expect((posted!.body as { body: string }).body).toContain(
			"Run `x --help`.",
		);
		expect(workspaces.tasks[0]!.subject.authorRole).toBe("other");

		const page = await request(http.getHttpServer())
			.get("/admin")
			.set("authorization", basic(ADMIN))
			.expect(200);
		expect(page.text).toContain("octo/widgets");
		expect(page.text).toContain("answer-issue");
	});

	it("runs the manifest flow for a second app with its own webhook secret", async () => {
		// The admin page embeds a form token; a browser posts it back.
		const page = await request(http.getHttpServer())
			.get("/admin")
			.set("authorization", basic(ADMIN))
			.expect(200);
		const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? "";
		expect(csrf).not.toBe("");
		const post = () =>
			request(http.getHttpServer())
				.post("/admin/github/register")
				.set("authorization", basic(ADMIN))
				.type("form");
		// Without the token (a cross-site form), refused, whatever the Origin.
		await post().send({ host: "github.com" }).expect(403);
		await post()
			.set("origin", "https://agent.example.org")
			.send({ host: "github.com" })
			.expect(403);
		// With the token but from another site, refused.
		await post()
			.set("origin", "https://evil.example")
			.send({ host: "github.com", _csrf: csrf })
			.expect(403);
		const pub = await post().send({
			host: "github.com",
			public: "1",
			_csrf: csrf,
		});
		expect(pub.status).toBe(400);
		expect(pub.body.message).toMatch(/ALLOWED_ACCOUNTS/);
		// Browsers on the no-referrer admin pages send `Origin: null` (the
		// regression this covers), or a LAN/tailnet origin matching the Host.
		await post()
			.set("origin", "null")
			.send({ host: "github.com", _csrf: csrf })
			.expect(200);
		await post()
			.set("host", "100.96.232.97:3000")
			.set("origin", "http://100.96.232.97:3000")
			.send({ host: "github.com", _csrf: csrf })
			.expect(200);
		const start = await post()
			.send({ host: "github.com", org: "my-org", _csrf: csrf })
			.expect(200);
		const action = /action="([^"]+)"/
			.exec(start.text)![1]!
			.replace(/&amp;/g, "&");
		expect(action).toMatch(
			/^https:\/\/github\.com\/organizations\/my-org\/settings\/apps\/new\?state=/,
		);
		const state = decodeURIComponent(
			new URL(action).searchParams.get("state")!,
		);
		const manifest = JSON.parse(
			/name="manifest" value="([^"]+)"/
				.exec(start.text)![1]!
				.replace(/&quot;/g, '"')
				.replace(/&amp;/g, "&"),
		);
		const connectionId = manifest.hook_attributes.url.split("/").pop();

		api.on("POST", "/app-manifests/code-abc123/conversions", {
			status: 201,
			body: {
				id: 555,
				slug: "ma-org",
				name: "MA org",
				pem: TEST_PEM,
				webhook_secret: "org-secret",
				client_id: "c",
				client_secret: "s",
				owner: { login: "my-org", type: "Organization" },
				html_url: "",
			},
		});
		await request(http.getHttpServer())
			.get("/admin/github/callback")
			.query({ state: "forged-state-value", code: "code-abc123" })
			.expect(400);
		const done = await request(http.getHttpServer())
			.get("/admin/github/callback")
			.query({ state, code: "code-abc123" })
			.expect(303);
		expect(done.headers.location).toBe(
			"https://github.com/apps/ma-org/installations/new",
		);

		// Each connection verifies with its own secret.
		await hook(connectionId, "ping", {}, "org-secret").expect(202);
		await hook(connectionId, "ping", {}, "env-secret").expect(401);
		await hook("env", "ping", {}, "org-secret").expect(401);

		const raw = (
			app.db
				.prepare("SELECT credentials FROM connections WHERE id = ?")
				.get(connectionId) as { credentials: string }
		).credentials;
		expect(raw).not.toContain("org-secret");
	});

	it("only serves GitHub's routes on the public host name", async () => {
		const pub = (r: request.Test) => r.set("host", "agent.example.org");
		await pub(request(http.getHttpServer()).get("/admin")).expect(404);
		await pub(
			request(http.getHttpServer())
				.get("/admin")
				.set("authorization", basic(ADMIN)),
		).expect(404);
		await pub(
			request(http.getHttpServer())
				.post("/admin/github/register")
				.set("authorization", basic(ADMIN))
				.set("origin", "https://agent.example.org"),
		).expect(404);
		await pub(request(http.getHttpServer()).get("/")).expect(404);
		await pub(request(http.getHttpServer()).get("/healthz")).expect(200);
		await pub(
			request(http.getHttpServer()).get(
				"/admin/github/callback?state=x&code=y",
			),
		).expect(400);
		await pub(request(http.getHttpServer()).post("/webhooks/nope")).expect(404);
		await pub(request(http.getHttpServer()).post("/webhooks/env")).expect(401);
		// A forwarded public host cannot be used to reach the admin pages either.
		await request(http.getHttpServer())
			.get("/admin")
			.set("x-forwarded-host", "Agent.Example.org:443")
			.set("authorization", basic(ADMIN))
			.expect(404);
		// Other host names (LAN, tailnet) keep the admin pages.
		await request(http.getHttpServer())
			.get("/admin")
			.set("host", "192.168.1.60:3000")
			.set("authorization", basic(ADMIN))
			.expect(200);
	});
});
