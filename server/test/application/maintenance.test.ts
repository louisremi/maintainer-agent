import { describe, expect, it } from "vitest";
import { Labels, Markers, Review } from "../../src/maintenance/domain";
import { issueOpened, REPO } from "../support/builders";
import { maintenanceHarness } from "../support/maintenance-harness";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 keep
+added
 keep
`;

describe("answering issues", () => {
	it("posts one sanitised answer to a question", async () => {
		const h = maintenanceHarness();
		h.addIssue(7, { role: "other", author: "zoe" });
		h.verdict("question", "Use the `--force` flag.");
		expect(
			await h.send(
				issueOpened({
					authorRole: "other",
					actor: { login: "zoe", isBot: false },
				}),
			),
		).toMatchObject({ kind: "queued" });
		const [r] = await h.drain();
		expect(r).toMatchObject({ status: "succeeded" });
		const comments = h.state.comments.get(7)!;
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toContain(Markers.answer);
		expect(comments[0]!.body).toContain("Use the `--force` flag.");
		expect(h.sanitizer.calls).toEqual([["Use the `--force` flag."]]);
		expect(h.agents.calls[0]).toMatchObject({ mode: "issue", extraEgress: [] });
		expect(h.workspaces.released).toEqual(["job-1"]);
	});

	it("writes a task that names the playbook, the subject and the permalink base", async () => {
		const h = maintenanceHarness();
		h.addIssue(7, { title: "Crash on start", body: "Steps..." });
		h.verdict("question");
		await h.send(issueOpened());
		await h.drain();
		const task = h.workspaces.tasks[0]!;
		expect(task).toMatchObject({
			version: 2,
			mode: "issue",
			repository: {
				path: "octo/widgets",
				webUrl: "https://github.com/octo/widgets",
				permalinkBase: `https://github.com/octo/widgets/blob/${"a".repeat(40)}`,
			},
			subject: {
				kind: "issue",
				number: 7,
				reference: "#7",
				title: "Crash on start",
				body: "Steps...",
			},
			terms: { changeRequest: "pull request" },
		});
		expect(task.policy.protectedPaths).toContain(".github/**");
	});

	it("opens a draft change request for a maintainer bug report and links it on the issue", async () => {
		const h = maintenanceHarness();
		h.addIssue(7);
		h.verdict("bug");
		h.change();
		await h.send(issueOpened());
		const results = await h.drain();
		expect(results.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
		const [answer, link] = h.state.comments.get(7)!;
		expect(answer!.body).toContain("preparing a draft pull request");
		expect(link!.body).toContain(
			"I opened a draft pull request for this: #101",
		);
		expect(h.state.openedChangeRequests[0]).toMatchObject({
			head: "maintainer-agent/issue-7",
			base: "main",
			title: "fix: handle empty input",
		});
		expect(h.state.openedChangeRequests[0]!.body).toContain("Fixes #7");
		expect(h.publisher.calls[0]!.git.authorization).toBe("Basic push-token");
		expect(h.publisher.calls[0]!.protectedPaths).toEqual(
			expect.arrayContaining([".github/**", ".maintainer-agent.yml"]),
		);
		// The fix agent gets the analysis of the answer job and no forge credential.
		expect(h.workspaces.tasks[1]!.priorAnalysis).toBe("Analysis of the bug.");
		expect(JSON.stringify(h.workspaces.tasks)).not.toContain("token");
		expect(h.state.labels.get(7)?.has(Labels.inProgress)).toBe(false);
	});

	it("only suggests the agent-fix label for outsiders", async () => {
		const h = maintenanceHarness();
		h.addIssue(7, { role: "other", author: "zoe" });
		h.verdict("feature");
		await h.send(
			issueOpened({
				authorRole: "other",
				actor: { login: "zoe", isBot: false },
			}),
		);
		const results = await h.drain();
		expect(results).toHaveLength(1);
		expect(h.state.comments.get(7)![0]!.body).toContain(
			"add the `agent-fix` label",
		);
		expect(h.state.openedChangeRequests).toHaveLength(0);
	});

	it("proposes a fix when a maintainer adds agent-fix, picking a free branch name", async () => {
		const h = maintenanceHarness();
		h.addIssue(7, { role: "other", author: "zoe" });
		h.state.roles.set("bob", "maintainer");
		h.state.branches.add("maintainer-agent/issue-7");
		h.change();
		const ev = {
			type: "issue-labeled",
			repo: REPO,
			number: 7,
			actor: { login: "bob", isBot: false },
			labels: ["agent-fix"],
			label: "agent-fix",
		} as const;
		expect(await h.send(ev)).toMatchObject({ kind: "queued" });
		expect(await h.send(ev)).toMatchObject({ kind: "ignored" });
		await h.drain();
		expect(h.state.openedChangeRequests[0]!.head).toBe(
			"maintainer-agent/issue-7-2",
		);
	});

	it("escalates when the issue was edited after a maintainer approved it", async () => {
		const h = maintenanceHarness();
		h.addIssue(7, { role: "other", author: "zoe", body: "edited later" });
		h.state.roles.set("bob", "maintainer");
		h.change();
		await h.send({
			type: "issue-labeled",
			repo: REPO,
			number: 7,
			actor: { login: "bob", isBot: false },
			labels: ["agent-fix"],
			label: "agent-fix",
			subjectFingerprint: "fp:original",
		});
		const [r] = await h.drain();
		expect(r!.status).toBe("needs-human");
		expect(h.agents.calls).toHaveLength(0);
		expect(h.state.comments.get(7)!.at(-1)!.body).toContain(
			"edited after agent-fix was added",
		);
	});

	it("ignores agent-fix added by a non-maintainer", async () => {
		const h = maintenanceHarness();
		h.addIssue(7);
		const r = await h.send({
			type: "issue-labeled",
			repo: REPO,
			number: 7,
			actor: { login: "mallory", isBot: false },
			labels: ["agent-fix"],
			label: "agent-fix",
		});
		expect(r).toEqual({
			kind: "ignored",
			reason: "agent-fix was not added by a maintainer",
		});
	});

	it("holds answers the sanitiser flags and asks a human", async () => {
		const h = maintenanceHarness();
		h.addIssue(7);
		h.verdict("question", "HOLD this");
		await h.send(issueOpened());
		const [r] = await h.drain();
		expect(r!.status).toBe("needs-human");
		const comments = h.state.comments.get(7)!;
		expect(comments.some((c) => c.body.includes("HOLD this"))).toBe(false);
		expect(comments.at(-1)!.body).toContain(
			"could not finish this automatically",
		);
		expect(h.state.labels.get(7)?.has(Labels.needsHuman)).toBe(true);
	});

	it("does not answer twice", async () => {
		const h = maintenanceHarness();
		h.addIssue(7);
		h.state.comments.set(7, [
			{
				authorLogin: "ma-test[bot]",
				authorRole: "other",
				body: `${Markers.answer}\nold`,
				createdAt: "x",
				isOwn: true,
			},
		]);
		await h.send(issueOpened());
		const [r] = await h.drain();
		expect(r!.status).toBe("succeeded");
		expect(h.agents.calls).toHaveLength(0);
	});
});

describe("failures and retries", () => {
	it("retries agent failures up to the policy limit, then escalates a fix", async () => {
		const h = maintenanceHarness();
		h.addIssue(7);
		h.state.roles.set("bob", "maintainer");
		h.agents.changes.push(
			{ ok: false, reason: "no patch", transient: false },
			{ ok: false, reason: "no patch", transient: false },
		);
		await h.send({
			type: "issue-labeled",
			repo: REPO,
			number: 7,
			actor: { login: "bob", isBot: false },
			labels: ["agent-fix"],
			label: "agent-fix",
		});
		const results = await h.drain();
		expect(results.map((r) => r.status)).toEqual(["queued", "needs-human"]);
		expect(h.state.labels.get(7)?.has(Labels.needsHuman)).toBe(true);
	});

	it("backs off on transient failures and keeps jobs while the model is down", async () => {
		const h = maintenanceHarness();
		h.addIssue(7);
		h.agents.verdicts.push({
			ok: false,
			reason: "model unreachable",
			transient: true,
		});
		h.verdict("question");
		await h.send(issueOpened());
		expect((await h.drain()).map((r) => r.status)).toEqual(["queued"]);
		expect(await h.run.execute()).toEqual({ kind: "idle" });
		h.clock.advance(1000);
		h.health.available = false;
		expect(await h.run.execute()).toEqual({ kind: "model-unavailable" });
		h.health.available = true;
		expect((await h.drain()).map((r) => r.status)).toEqual(["succeeded"]);
	});

	it("escalates a change the publisher rejects", async () => {
		const h = maintenanceHarness();
		h.addIssue(7);
		h.verdict("bug");
		h.change();
		h.publisher.outcome = {
			ok: false,
			reason: "touches protected path .github/workflows/ci.yml",
			transient: false,
		};
		await h.send(issueOpened());
		const results = await h.drain();
		expect(results.map((r) => r.status)).toEqual(["succeeded", "needs-human"]);
		expect(h.state.openedChangeRequests).toHaveLength(0);
	});

	it("drops jobs whose repository has an invalid policy", async () => {
		const h = maintenanceHarness();
		h.state.files.set(".github/maintainer-agent.yml", "bogus: 1");
		h.validator.result = { ok: false, errors: ["unknown keys: bogus"] };
		h.addIssue(7);
		expect(await h.send(issueOpened())).toEqual({
			kind: "ignored",
			reason: "invalid policy in .github/maintainer-agent.yml",
		});
	});

	it("requeues work that crashes unexpectedly", async () => {
		const h = maintenanceHarness();
		h.addIssue(7);
		h.agents.verdicts.push(() => {
			throw new Error("docker exploded");
		});
		await h.send(issueOpened());
		const [r] = await h.drain();
		expect(r!.status).toBe("queued");
		expect(h.log.lines.some((l) => l.message === "job crashed")).toBe(true);
	});
});

describe("reviewing change requests", () => {
	function withPr(h: ReturnType<typeof maintenanceHarness>, draft = false) {
		h.state.changeRequests.set(9, {
			number: 9,
			title: "Add thing",
			body: "Adds it.",
			authorLogin: "carol",
			authorRole: "other",
			isOpen: true,
			isDraft: draft,
			baseBranch: "main",
			baseSha: "b".repeat(40),
			headSha: "h".repeat(40),
			headFetchRef: "refs/pull/9/head",
		});
		h.workspaces.diff = DIFF;
	}
	const opened = {
		type: "change-request-opened",
		repo: REPO,
		number: 9,
		actor: { login: "carol", isBot: false },
		labels: [],
		authorRole: "other",
		isDraft: false,
	} as const;

	it("posts a comment-only review with placed inline comments", async () => {
		const h = maintenanceHarness();
		withPr(h);
		h.review(
			Review.of("Small and clear.", [
				{ path: "src/a.ts", line: 2, side: "RIGHT", body: "Consider a test." },
				{ path: "src/a.ts", line: 50, side: "RIGHT", body: "Not in the diff." },
			]),
		);
		await h.send(opened);
		const [r] = await h.drain();
		expect(r!.status).toBe("succeeded");
		const review = h.state.reviews[0]!;
		expect(review.headSha).toBe("h".repeat(40));
		expect(review.comments).toEqual([
			{ path: "src/a.ts", line: 2, side: "RIGHT", body: "Consider a test." },
		]);
		expect(review.summary).toContain(Markers.review);
		expect(review.summary).toContain("Not in the diff.");
		expect(h.workspaces.prepared[0]!.head).toEqual({
			fetchRef: "refs/pull/9/head",
			sha: "h".repeat(40),
		});
		expect(h.workspaces.tasks[0]!.review).toMatchObject({
			summaryOnly: false,
			changedLines: 1,
		});
	});

	it("skips drafts and the agent's own change requests", async () => {
		const h = maintenanceHarness();
		withPr(h, true);
		expect(await h.send({ ...opened, isDraft: true })).toMatchObject({
			kind: "ignored",
		});
		expect(
			await h.send({
				...opened,
				actor: { login: "ma-test[bot]", isBot: true },
			}),
		).toMatchObject({ kind: "ignored" });
	});

	it("reviews again when a maintainer adds agent-rereview, and removes the label", async () => {
		const h = maintenanceHarness();
		withPr(h);
		h.state.roles.set("bob", "maintainer");
		h.state.labels.set(9, new Set(["agent-rereview"]));
		h.review(Review.of("Still good.", []));
		await h.send({
			type: "change-request-labeled",
			repo: REPO,
			number: 9,
			actor: { login: "bob", isBot: false },
			labels: ["agent-rereview"],
			label: "agent-rereview",
			isDraft: false,
		});
		await h.drain();
		expect(h.state.reviews).toHaveLength(1);
		expect(h.state.labels.get(9)?.has("agent-rereview")).toBe(false);
	});

	it("caps the number of automatic jobs per outsider per day", async () => {
		const h = maintenanceHarness();
		withPr(h);
		for (let i = 0; i < 5; i++) {
			await h.send({ ...opened, number: 20 + i });
		}
		expect(await h.send(opened)).toEqual({
			kind: "ignored",
			reason: "daily job limit reached for this author",
		});
	});
});

describe("events across contexts", () => {
	it("creates the labels when a repository starts being watched", async () => {
		const h = maintenanceHarness();
		await h.events.publish([
			{
				type: "connections.repository-watched",
				repoKey: REPO.key,
				connectionId: "c1",
				occurredAt: new Date(),
			} as never,
		]);
		expect(h.state.ensuredLabels).toEqual(
			expect.arrayContaining(["agent-fix", "no-agent", "needs-human"]),
		);
	});

	it("ignores events from a connection that does not own the repository", async () => {
		const h = maintenanceHarness();
		const r = await h.handle.execute({
			connectionId: "c2",
			event: issueOpened(),
		});
		expect(r).toMatchObject({
			kind: "ignored",
			reason: expect.stringMatching(/not watched through this connection/),
		});
	});

	it("ignores accounts outside the server allow-list", async () => {
		const h = maintenanceHarness({ allowList: "someone-else" });
		expect(await h.send(issueOpened())).toEqual({
			kind: "ignored",
			reason: "account not allowed on this server",
		});
	});
});
