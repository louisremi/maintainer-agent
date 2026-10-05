import { describe, expect, it } from "vitest";
import {
	BUILT_IN_LIMITS,
	effectiveRepositorySettings,
	mergeLayers,
	placeholderName,
	referencedModelNames,
	type Settings,
	secretName,
} from "../../src/settings/domain";

const base: Settings = {
	version: 1,
	server: {
		publicUrl: "https://a.example",
		publicPathsOnlyViaHost: null,
		adminToken: null,
		allowedAccounts: [],
		runnerImage: "img",
		dockerPull: "missing",
		maxConcurrentJobs: 1,
		jobRetentionDays: 14,
		gitAuthor: "a <a@b.c>",
		limits: BUILT_IN_LIMITS,
	},
	models: {
		default: { apiBase: "http://m/v1", model: "openai/m", apiKey: null },
		big: { apiBase: "http://b/v1", model: "openai/b", apiKey: null },
	},
	connections: {},
	defaults: {},
	repositories: {},
};

describe("mergeLayers (Frigate-style overrides)", () => {
	it("merges maps per key, replaces lists and scalars, inherits absent keys", () => {
		const merged = mergeLayers(
			{
				fix: { enabled: true, stepLimit: 80 },
				egress: ["a", "b"],
				links: ["x"],
			},
			{ fix: { stepLimit: 100 }, egress: ["c"] },
		);
		expect(merged).toEqual({
			fix: { enabled: true, stepLimit: 100 },
			egress: ["c"],
			links: ["x"],
		});
	});
});

describe("effectiveRepositorySettings", () => {
	it("is null for repositories that are not listed", () => {
		expect(effectiveRepositorySettings(base, "github.com/o/r")).toBeNull();
	});

	it("layers built-ins, defaults and the repository entry", () => {
		const s: Settings = {
			...base,
			defaults: {
				fix: { trigger: "label" },
				egress: ["registry.npmjs.org"],
				model: "default",
			},
			repositories: {
				"github.com/o/r": { fix: { stepLimit: 100 }, model: { fix: "big" } },
				"github.com/o/empty": {},
			},
		};
		const r = effectiveRepositorySettings(s, "github.com/o/r")!;
		expect(r.fix).toEqual({
			enabled: true,
			trigger: "label",
			maxAttempts: 2,
			stepLimit: 100,
		});
		expect(r.egress).toEqual(["registry.npmjs.org"]);
		expect(r.model).toEqual({
			answer: "default",
			fix: "big",
			review: "default",
		});
		const e = effectiveRepositorySettings(s, "github.com/o/empty")!;
		expect(e.enabled).toBe(true);
		expect(e.fix.stepLimit).toBe(80);
	});

	it("clamps every value to server.limits", () => {
		const s: Settings = {
			...base,
			server: {
				...base.server,
				limits: {
					...BUILT_IN_LIMITS,
					maxStepLimit: 60,
					maxAttempts: 3,
					maxReviewComments: 5,
				},
			},
			repositories: {
				"github.com/o/r": {
					fix: { stepLimit: 999, maxAttempts: 99 },
					review: { maxComments: 50 },
				},
			},
		};
		const r = effectiveRepositorySettings(s, "github.com/o/r")!;
		expect(r.fix.stepLimit).toBe(60);
		expect(r.fix.maxAttempts).toBe(3);
		expect(r.review.maxComments).toBe(5);
	});

	it("collects model references for validation", () => {
		const s: Settings = {
			...base,
			defaults: { model: "default" },
			repositories: { "github.com/o/r": { model: { review: "missing" } } },
		};
		expect(referencedModelNames(s)).toEqual([
			{ name: "default", path: ["defaults", "model"] },
			{
				name: "missing",
				path: ["repositories", "github.com/o/r", "model", "review"],
			},
		]);
	});
});

describe("secret placeholders", () => {
	it("recognises whole-value placeholders only", () => {
		expect(placeholderName("{MA_LLM_KEY}")).toBe("MA_LLM_KEY");
		expect(placeholderName(" {MA_X} ")).toBe("MA_X");
		expect(placeholderName("prefix {MA_X}")).toBeNull();
		expect(placeholderName("{OTHER}")).toBeNull();
	});

	it("derives names", () => {
		expect(secretName("github", "pT65bH", "private key")).toBe(
			"MA_GITHUB_PT65BH_PRIVATE_KEY",
		);
	});
});
