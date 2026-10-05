import { createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	appJwt,
	GithubAppClients,
	GithubAppRegistrationGateway,
	GithubDirectory,
	GithubEventTranslator,
	GithubForgeSession,
	githubHost,
	signGithubPayload,
	verifyGithubSignature,
} from "../../src/adapters/forges/github";
import { Connection } from "../../src/connections/domain";
import { RepoRef } from "../../src/shared-kernel";
import { T0 } from "../support/builders";
import {
	FakeGithubApi,
	TEST_PEM,
	TEST_PUBLIC_PEM,
} from "../support/fake-github";

const access = (host = "github.com") => ({
	connectionId: "c1",
	platform: "github" as const,
	host,
	credentials: {
		appId: "123",
		appSlug: "ma-test",
		botLogin: "ma-test[bot]",
		secrets: { privateKey: TEST_PEM, webhookSecret: "whsec" },
	},
});
const REPO = RepoRef.of("github", "github.com", "octo/widgets");

function session(api: FakeGithubApi, host = "github.com") {
	const repo = RepoRef.of("github", host, "octo/widgets");
	return new GithubForgeSession(
		repo,
		new GithubAppClients(api.fetch).for(access(host)),
	);
}

describe("GitHub webhook signatures", () => {
	it("accepts the right signature only", () => {
		const body = Buffer.from('{"a":1}');
		const sig = signGithubPayload("s3cret", body);
		expect(verifyGithubSignature("s3cret", body, sig)).toBe(true);
		expect(verifyGithubSignature("other", body, sig)).toBe(false);
		expect(verifyGithubSignature("s3cret", Buffer.from('{"a":2}'), sig)).toBe(
			false,
		);
		expect(verifyGithubSignature("s3cret", body, undefined)).toBe(false);
		expect(verifyGithubSignature("s3cret", body, "sha1=abc")).toBe(false);
		expect(verifyGithubSignature("", body, sig)).toBe(false);
	});
});

describe("GitHub App JWT", () => {
	it("is an RS256 token issued by the app, valid for under 10 minutes", () => {
		const jwt = appJwt("123", TEST_PEM, T0.getTime());
		const [h, p, s] = jwt.split(".");
		expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
			alg: "RS256",
			typ: "JWT",
		});
		const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
		expect(claims.iss).toBe("123");
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
		expect(
			createVerify("RSA-SHA256")
				.update(`${h}.${p}`)
				.verify(TEST_PUBLIC_PEM, Buffer.from(s!, "base64url")),
		).toBe(true);
	});
});

describe("GitHub hosts", () => {
	it("knows github.com and GitHub Enterprise Server URLs", () => {
		expect(githubHost("github.com").apiUrl).toBe("https://api.github.com");
		expect(githubHost("GHE.corp").apiUrl).toBe("https://ghe.corp/api/v3");
		expect(githubHost("ghe.corp:8443").egressHosts).toEqual(["ghe.corp"]);
	});
});

describe("GitHub App manifest flow", () => {
	const pending = (owner: string | null = null) =>
		Connection.startRegistration({
			id: "AbCdEf123456",
			platform: "github",
			host: "github.com",
			kind: "github-app",
			ownerAccount: owner,
			isPublic: false,
			registrationState: "st".repeat(16),
			now: T0,
		});

	it("builds a manifest with a per-connection webhook URL and minimal permissions", () => {
		const gw = new GithubAppRegistrationGateway("https://agent.example.org/");
		const form = gw.registrationForm(pending());
		expect(form.action).toBe(
			`https://github.com/settings/apps/new?state=${"st".repeat(16)}`,
		);
		const m = JSON.parse(form.fields.manifest!);
		expect(m.hook_attributes.url).toBe(
			"https://agent.example.org/webhooks/AbCdEf123456",
		);
		expect(m.setup_url).toBe("https://agent.example.org/installed");
		expect(m.redirect_url).toBe(
			"https://agent.example.org/admin/github/callback",
		);
		expect(m.default_permissions).toEqual({
			contents: "write",
			issues: "write",
			pull_requests: "write",
			metadata: "read",
		});
		expect(m.default_permissions).not.toHaveProperty("workflows");
		expect(m.default_events).toEqual(["issues", "pull_request"]);
		expect(m.public).toBe(false);
		expect(gw.registrationForm(pending("my-org")).action).toMatch(
			/^https:\/\/github\.com\/organizations\/my-org\/settings\/apps\/new\?state=/,
		);
	});

	it("exchanges the code for the app credentials", async () => {
		const api = new FakeGithubApi().on(
			"POST",
			"/app-manifests/code12345/conversions",
			{
				status: 201,
				body: {
					id: 777,
					slug: "ma-xyz",
					name: "MA xyz",
					pem: "PEM",
					webhook_secret: "hook",
					client_id: "cid",
					client_secret: "cs",
					owner: { login: "my-org", type: "Organization" },
					html_url: "x",
				},
			},
		);
		const gw = new GithubAppRegistrationGateway(
			"https://agent.example.org",
			api.fetch,
		);
		const r = await gw.complete(pending(), "code12345");
		expect(r.credentials).toMatchObject({
			appId: "777",
			appSlug: "ma-xyz",
			botLogin: "ma-xyz[bot]",
			secrets: { privateKey: "PEM", webhookSecret: "hook" },
		});
		expect(r.ownerAccount).toBe("my-org");
		expect(r.installUrl).toBe(
			"https://github.com/apps/ma-xyz/installations/new",
		);
		expect(api.requests[0]!.auth).toBeNull();
		await expect(gw.complete(pending(), "../../x")).rejects.toThrow(
			/invalid manifest code/,
		);
	});
});

describe("GitHub forge session", () => {
	it("mints tokens limited to one repository and the permissions of each step", async () => {
		const api = new FakeGithubApi()
			.withInstallation("octo", "widgets")
			.on("POST", "/repos/octo/widgets/issues/7/comments", {
				status: 201,
				body: { html_url: "https://github.com/octo/widgets/issues/7#c1" },
			});
		const s = session(api);
		await s.comment(7, "hello");
		const git = await s.gitAccess("push");
		const mints = api.requests.filter((r) => r.path.endsWith("/access_tokens"));
		expect(mints.map((m) => m.body)).toEqual([
			{
				repositories: ["widgets"],
				permissions: {
					contents: "read",
					issues: "write",
					pull_requests: "write",
					metadata: "read",
				},
			},
			{
				repositories: ["widgets"],
				permissions: { contents: "write", metadata: "read" },
			},
		]);
		expect(mints.every((m) => m.auth?.startsWith("Bearer "))).toBe(true);
		expect(
			api.requests.find((r) => r.path.endsWith("/comments"))!.auth,
		).toMatch(/^token ghs_test1/);
		expect(
			Buffer.from(
				git.authorization!.replace("Basic ", ""),
				"base64",
			).toString(),
		).toMatch(/^x-access-token:ghs_test2/);
		expect(git.remoteUrl).toBe("https://github.com/octo/widgets.git");
		expect(git.egressHosts).toContain("github.com");
		// Tokens are cached per scope.
		await s.comment(7, "again");
		expect(
			api.requests.filter((r) => r.path.endsWith("/access_tokens")),
		).toHaveLength(2);
	});

	it("maps issues, comments and pull requests to snapshots", async () => {
		const api = new FakeGithubApi()
			.withInstallation("octo", "widgets")
			.on("GET", "/repos/octo/widgets/issues/7", {
				body: {
					number: 7,
					title: "Bug",
					body: null,
					user: { login: "zoe" },
					author_association: "NONE",
					labels: [{ name: "bug" }],
					state: "open",
				},
			})
			.on("GET", "/repos/octo/widgets/issues/8", {
				body: {
					number: 8,
					title: "PR",
					pull_request: {},
					labels: [],
					state: "open",
					author_association: "OWNER",
				},
			})
			.on("GET", /^\/repos\/octo\/widgets\/issues\/7\/comments/, {
				body: [
					{
						user: { login: "octo" },
						author_association: "OWNER",
						body: "hi",
						created_at: "2026-01-01T00:00:00Z",
					},
					{
						user: { login: "ma-test[bot]" },
						author_association: "NONE",
						body: "answer",
						created_at: "2026-01-02T00:00:00Z",
					},
				],
			})
			.on("GET", "/repos/octo/widgets/pulls/9", {
				body: {
					number: 9,
					title: "T",
					body: "B",
					user: { login: "carol" },
					author_association: "CONTRIBUTOR",
					state: "open",
					draft: true,
					base: { ref: "main", sha: "b1" },
					head: { sha: "h1" },
				},
			})
			.on("GET", "/repos/octo/widgets/pulls/404", {
				status: 404,
				body: { message: "Not Found" },
			});
		const s = session(api);
		expect(await s.getIssue(7)).toEqual({
			number: 7,
			title: "Bug",
			body: "",
			authorLogin: "zoe",
			authorRole: "other",
			labels: ["bug"],
			isOpen: true,
			fingerprint: "e3b0c44298fc1c149afbf4c8996fb924",
		});
		expect(await s.getIssue(8)).toBeNull();
		const comments = await s.listIssueComments(7, 50);
		expect(comments.map((c) => [c.authorRole, c.isOwn])).toEqual([
			["maintainer", false],
			["other", true],
		]);
		expect(await s.getChangeRequest(9)).toMatchObject({
			isDraft: true,
			baseSha: "b1",
			headSha: "h1",
			headFetchRef: "refs/pull/9/head",
			authorRole: "other",
		});
		expect(await s.getChangeRequest(404)).toBeNull();
	});

	it("resolves roles from repository permissions", async () => {
		const api = new FakeGithubApi()
			.withInstallation("octo", "widgets")
			.on("GET", "/repos/octo/widgets/collaborators/bob/permission", {
				body: { permission: "write", role_name: "write" },
			})
			.on("GET", "/repos/octo/widgets/collaborators/tri/permission", {
				body: { permission: "read", role_name: "triage" },
			})
			.on("GET", "/repos/octo/widgets/collaborators/zoe/permission", {
				status: 404,
				body: {},
			});
		const s = session(api);
		expect(await s.roleOf("bob")).toBe("maintainer");
		expect(await s.roleOf("tri")).toBe("other");
		expect(await s.roleOf("zoe")).toBe("other");
	});

	it("reads policy files, creates labels idempotently, opens drafts and comment-only reviews", async () => {
		const api = new FakeGithubApi()
			.withInstallation("octo", "widgets")
			.on(
				"GET",
				/^\/repos\/octo\/widgets\/contents\/\.github\/maintainer-agent\.yml\?ref=main$/,
				{
					body: {
						type: "file",
						encoding: "base64",
						content: Buffer.from("version: 1\n").toString("base64"),
						size: 11,
					},
				},
			)
			.on("GET", /^\/repos\/octo\/widgets\/contents\/\.maintainer-agent\.yml/, {
				status: 404,
				body: {},
			})
			.on("POST", "/repos/octo/widgets/labels", (r) =>
				(r.body as { name: string }).name === "agent-fix"
					? { status: 422, body: { message: "already_exists" } }
					: { status: 201, body: {} },
			)
			.on("POST", "/repos/octo/widgets/pulls", {
				status: 201,
				body: {
					number: 12,
					html_url: "https://github.com/octo/widgets/pull/12",
				},
			})
			.on("POST", "/repos/octo/widgets/pulls/12/reviews", {
				body: { html_url: "https://github.com/octo/widgets/pull/12#r" },
			});
		const s = session(api);
		expect(await s.readFile(".github/maintainer-agent.yml", "main")).toBe(
			"version: 1\n",
		);
		expect(await s.readFile(".maintainer-agent.yml", "main")).toBeNull();
		await s.ensureLabels([
			{ name: "agent-fix", color: "D93F0B", description: "x" },
			{ name: "no-agent", color: "C5DEF5", description: "y" },
		]);
		expect(
			await s.openDraftChangeRequest({
				head: "maintainer-agent/issue-7",
				base: "main",
				title: "t",
				body: "b",
			}),
		).toEqual({ number: 12, url: "https://github.com/octo/widgets/pull/12" });
		expect(
			api.requests.find((r) => r.path === "/repos/octo/widgets/pulls")!.body,
		).toMatchObject({ draft: true });
		await s.postReview(12, {
			headSha: "h1",
			summary: "S",
			comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "c" }],
		});
		expect(api.requests.find((r) => r.path.endsWith("/reviews"))!.body).toEqual(
			{
				commit_id: "h1",
				event: "COMMENT",
				body: "S",
				comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "c" }],
			},
		);
	});

	it("uses the GitHub Enterprise Server API of the connection", async () => {
		const api = new FakeGithubApi("https://ghe.corp/api/v3")
			.withInstallation("octo", "widgets")
			.on("GET", "/repos/octo/widgets", { body: { default_branch: "trunk" } })
			.on("GET", "/repos/octo/widgets/branches/trunk", {
				body: { commit: { sha: "abc" } },
			});
		const s = session(api, "ghe.corp");
		expect(await s.getDefaultBranch()).toEqual({ name: "trunk", sha: "abc" });
		expect(s.webUrl).toBe("https://ghe.corp/octo/widgets");
		expect(
			api.requests.every((r) => r.url.startsWith("https://ghe.corp/api/v3/")),
		).toBe(true);
	});
});

describe("GitHub directory", () => {
	it("lists every repository of every installation", async () => {
		const api = new FakeGithubApi()
			.on("GET", /^\/app\/installations\?/, { body: [{ id: 1 }, { id: 2 }] })
			.on("POST", "/app/installations/1/access_tokens", {
				status: 201,
				body: { token: "t1", expires_at: "x" },
			})
			.on("POST", "/app/installations/2/access_tokens", {
				status: 201,
				body: { token: "t2", expires_at: "x" },
			})
			.on("GET", /^\/installation\/repositories/, (r) => ({
				body: {
					repositories:
						r.auth === "token t1"
							? [{ full_name: "me/a" }]
							: [{ full_name: "org/b" }],
				},
			}));
		const repos = await new GithubDirectory(
			new GithubAppClients(api.fetch),
		).listRepositories(access());
		expect(repos.map((r) => r.key)).toEqual([
			"github:github.com/me/a",
			"github:github.com/org/b",
		]);
	});
});

describe("GitHub event translator", () => {
	const t = new GithubEventTranslator("github.com");
	const repository = { full_name: "octo/widgets" };

	it("translates issues and pull requests into domain events", () => {
		expect(
			t.translate("issues", {
				action: "opened",
				repository,
				sender: { login: "zoe" },
				issue: {
					number: 7,
					user: { login: "zoe" },
					author_association: "NONE",
					labels: [],
				},
			}),
		).toEqual({
			kind: "forge-event",
			event: {
				type: "issue-opened",
				repo: REPO,
				number: 7,
				actor: { login: "zoe", isBot: false },
				labels: [],
				authorRole: "other",
			},
		});
		expect(
			t.translate("issues", {
				action: "labeled",
				repository,
				sender: { login: "bob" },
				label: { name: "agent-fix" },
				issue: { number: 7, labels: [{ name: "agent-fix" }] },
			}),
		).toMatchObject({
			event: {
				type: "issue-labeled",
				label: "agent-fix",
				actor: { login: "bob" },
			},
		});
		expect(
			t.translate("pull_request", {
				action: "ready_for_review",
				repository,
				sender: { login: "carol" },
				pull_request: {
					number: 9,
					user: { login: "carol" },
					author_association: "MEMBER",
					draft: false,
				},
			}),
		).toMatchObject({
			event: {
				type: "change-request-opened",
				number: 9,
				authorRole: "maintainer",
				isDraft: false,
			},
		});
		expect(
			t.translate("pull_request", {
				action: "opened",
				repository,
				sender: { login: "renovate[bot]", type: "Bot" },
				pull_request: {
					number: 10,
					user: { login: "renovate[bot]", type: "Bot" },
				},
			}),
		).toMatchObject({
			event: { actor: { isBot: true } },
		});
	});

	it("translates installation changes into repository lists", () => {
		expect(
			t.translate("installation", {
				action: "created",
				repositories: [{ full_name: "me/a" }],
			}),
		).toEqual({
			kind: "repositories",
			added: [RepoRef.of("github", "github.com", "me/a")],
			removed: [],
			mode: "delta",
		});
		expect(
			t.translate("installation", {
				action: "deleted",
				repositories: [{ full_name: "me/a" }],
			}),
		).toMatchObject({ removed: [expect.anything()] });
		expect(
			t.translate("installation_repositories", {
				action: "added",
				repositories_added: [{ full_name: "me/b" }],
				repositories_removed: [{ full_name: "me/c" }],
			}),
		).toMatchObject({
			added: [expect.anything()],
			removed: [expect.anything()],
		});
	});

	it("ignores what the server does not use", () => {
		expect(t.translate("push", {})).toMatchObject({ kind: "ignored" });
		expect(
			t.translate("pull_request", {
				action: "reopened",
				repository,
				sender: { login: "x" },
				pull_request: { number: 9 },
			}),
		).toMatchObject({ kind: "ignored" });
		expect(
			t.translate("issues", {
				action: "closed",
				repository,
				sender: { login: "x" },
				issue: { number: 1 },
			}),
		).toMatchObject({ kind: "ignored" });
		expect(
			t.translate("issues", {
				action: "opened",
				repository,
				sender: { login: "x" },
				issue: { number: 1, pull_request: {} },
			}),
		).toMatchObject({ kind: "ignored" });
		expect(
			t.translate("issues", {
				action: "opened",
				repository: { full_name: "../../etc" },
				sender: { login: "x" },
				issue: { number: 1 },
			}),
		).toMatchObject({ kind: "ignored" });
	});
});
