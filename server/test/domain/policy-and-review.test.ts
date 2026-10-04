import { describe, expect, it } from "vitest";
import {
	DEFAULT_HOST_LIMITS,
	DEFAULT_POLICY,
	DiffHunks,
	InlineCommentPlacement,
	ProposedChange,
	RepositoryPolicy,
	Review,
	Verdict,
} from "../../src/maintenance/domain";
import { DomainError } from "../../src/shared-kernel";

describe("RepositoryPolicy", () => {
	it("clamps every limit to the host limits (a policy can never widen them)", () => {
		const p = RepositoryPolicy.from(
			{
				...DEFAULT_POLICY,
				answer: { enabled: true, maxAttempts: 99 },
				fix: {
					enabled: true,
					trigger: "maintainers",
					maxAttempts: 99,
					stepLimit: 9999,
				},
				review: {
					enabled: true,
					maxComments: 9999,
					maxDiffLines: 10 ** 9,
					maxAttempts: 99,
				},
			},
			DEFAULT_HOST_LIMITS,
		);
		expect(p.fix.stepLimit).toBe(DEFAULT_HOST_LIMITS.maxStepLimit);
		expect(p.fix.maxAttempts).toBe(DEFAULT_HOST_LIMITS.maxAttemptsCap);
		expect(p.answer.maxAttempts).toBe(DEFAULT_HOST_LIMITS.maxAttemptsCap);
		expect(p.review.maxComments).toBe(DEFAULT_HOST_LIMITS.maxReviewComments);
		expect(p.review.maxDiffLines).toBe(DEFAULT_HOST_LIMITS.maxDiffLines);
	});

	it("always protects the policy files and the forge defaults", () => {
		const p = RepositoryPolicy.defaults(DEFAULT_HOST_LIMITS);
		expect(p.protectedPaths([".github/**"])).toEqual(
			expect.arrayContaining([
				".github/**",
				".maintainer-agent.yml",
				".github/maintainer-agent.yml",
				".gitlab/maintainer-agent.yml",
			]),
		);
	});

	it("rejects unsafe paths", () => {
		expect(() =>
			RepositoryPolicy.from(
				{ ...DEFAULT_POLICY, instructions: ["../etc/passwd"] },
				DEFAULT_HOST_LIMITS,
			),
		).toThrow(DomainError);
		expect(() =>
			RepositoryPolicy.from(
				{ ...DEFAULT_POLICY, protectedPaths: ["/abs"] },
				DEFAULT_HOST_LIMITS,
			),
		).toThrow(DomainError);
	});
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ export function f() {
 context 10
-old 11
+new 11
+new 12
 context 13
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone 1
-gone 2
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1,1 @@
+hello
\\ No newline at end of file
`;

describe("DiffHunks", () => {
	const h = DiffHunks.parse(DIFF);

	it("lists files and counts changed lines", () => {
		expect(h.files).toEqual(["new.md", "old.txt", "src/a.ts"]);
		expect(h.totalChangedLines).toBe(6);
	});

	it("knows which lines can carry comments on each side", () => {
		expect(h.contains("src/a.ts", 11, "RIGHT")).toBe(true);
		expect(h.contains("src/a.ts", 12, "RIGHT")).toBe(true);
		expect(h.contains("src/a.ts", 10, "RIGHT")).toBe(true);
		expect(h.contains("src/a.ts", 11, "LEFT")).toBe(true);
		expect(h.contains("src/a.ts", 20, "RIGHT")).toBe(false);
		expect(h.contains("old.txt", 2, "LEFT")).toBe(true);
		expect(h.contains("old.txt", 1, "RIGHT")).toBe(false);
		expect(h.contains("new.md", 1, "RIGHT")).toBe(true);
		expect(h.contains("missing.ts", 1, "RIGHT")).toBe(false);
	});
});

describe("InlineCommentPlacement", () => {
	const hunks = DiffHunks.parse(DIFF);

	it("keeps comments on diff lines and folds the rest into the summary", () => {
		const review = Review.of("Looks fine.", [
			{ path: "src/a.ts", line: 11, side: "RIGHT", body: "nice" },
			{ path: "src/a.ts", line: 11, side: "RIGHT", body: "duplicate position" },
			{ path: "src/a.ts", line: 99, side: "RIGHT", body: "outside   the hunk" },
			{ path: "new.md", line: 1, side: "RIGHT", body: "over the cap" },
		]);
		const placed = InlineCommentPlacement.place(review, hunks, 1);
		expect(placed.comments).toEqual([
			{ path: "src/a.ts", line: 11, side: "RIGHT", body: "nice" },
		]);
		expect(placed.unplaced).toBe(3);
		expect(placed.summary).toContain("`src/a.ts` line 99: outside the hunk");
		expect(placed.summary).toContain("`new.md` line 1: over the cap");
	});
});

describe("agent results", () => {
	it("validates verdicts, changes and reviews", () => {
		expect(Verdict.of("bug", "x").callsForChange).toBe(true);
		expect(Verdict.of("question", "x").callsForChange).toBe(false);
		expect(() => Verdict.of("bug", "   ")).toThrow(DomainError);
		expect(() => Verdict.of("nonsense" as never, "x")).toThrow(DomainError);
		expect(ProposedChange.of("p", "  fix:\n thing  ", "b").title).toBe(
			"fix: thing",
		);
		expect(() => ProposedChange.of("p", " ", "b")).toThrow(DomainError);
		expect(() =>
			Review.of("s", [{ path: "/etc/x", line: 1, side: "RIGHT", body: "b" }]),
		).toThrow(DomainError);
		expect(() =>
			Review.of("s", [{ path: "a", line: 0, side: "RIGHT", body: "b" }]),
		).toThrow(DomainError);
	});
});
