import { describe, expect, it } from "vitest";
import {
	AccountAllowList,
	DomainError,
	RepoRef,
} from "../../src/shared-kernel";

describe("RepoRef", () => {
	it("has a stable key and parses it back", () => {
		const r = RepoRef.of("github", "GitHub.com", "octo/widgets");
		expect(r.key).toBe("github:github.com/octo/widgets");
		expect(RepoRef.parse(r.key).equals(r)).toBe(true);
		expect(r.owner).toBe("octo");
		expect(r.name).toBe("widgets");
	});

	it("supports nested GitLab groups and hosts with ports", () => {
		const r = RepoRef.of("gitlab", "git.example.org:8443", "group/sub/project");
		expect(r.owner).toBe("group");
		expect(r.name).toBe("project");
		expect(RepoRef.parse(r.key).path).toBe("group/sub/project");
	});

	it.each(["octo", "octo/../x", "/octo/x", "octo/x y", "octo//x"])(
		"rejects path %s",
		(p) => {
			expect(() => RepoRef.of("github", "github.com", p)).toThrow(DomainError);
		},
	);

	it("rejects bad hosts and keys", () => {
		expect(() => RepoRef.of("github", "bad host", "a/b")).toThrow(DomainError);
		expect(() => RepoRef.parse("svn:host/a/b")).toThrow(DomainError);
	});
});

describe("AccountAllowList", () => {
	const gh = RepoRef.of("github", "github.com", "Octo/widgets");
	const ghes = RepoRef.of("github", "ghe.corp", "octo/widgets");

	it("allows everything when empty", () => {
		expect(AccountAllowList.parse("").allows(gh)).toBe(true);
	});

	it("matches accounts case-insensitively, optionally per host", () => {
		expect(AccountAllowList.parse("octo").allows(ghes)).toBe(true);
		const hostBound = AccountAllowList.parse("github.com/octo, other");
		expect(hostBound.allows(gh)).toBe(true);
		expect(hostBound.allows(ghes)).toBe(false);
	});
});
