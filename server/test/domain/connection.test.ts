import { describe, expect, it } from "vitest";
import {
	ClaimPolicy,
	Connection,
	REGISTRATION_TTL_MS,
	WatchedRepository,
} from "../../src/connections/domain";
import { DomainError, RepoRef } from "../../src/shared-kernel";
import { T0 } from "../support/builders";

const creds = {
	appId: "1",
	appSlug: "ma-test",
	botLogin: "ma-test[bot]",
	secrets: { privateKey: "k", webhookSecret: "s" },
};

function pending() {
	return Connection.startRegistration({
		id: "c1",
		platform: "github",
		host: "github.com",
		kind: "github-app",
		ownerAccount: null,
		isPublic: false,
		registrationState: "x".repeat(32),
		now: T0,
	});
}

describe("Connection", () => {
	it("becomes active when the registration completes with the right state", () => {
		const c = pending();
		expect(c.acceptsEvents).toBe(false);
		c.completeRegistration({
			state: "x".repeat(32),
			credentials: creds,
			displayName: "ma-test",
			ownerAccount: "octo",
			now: T0,
		});
		expect(c.status).toBe("active");
		expect(c.acceptsEvents).toBe(true);
		expect(c.registrationState).toBeNull();
		expect(c.ownerAccount).toBe("octo");
		expect(c.pullEvents().map((e) => e.type)).toEqual([
			"connections.connection-activated",
		]);
	});

	it("rejects a wrong state, a second completion, and an expired registration", () => {
		const c = pending();
		expect(() =>
			c.completeRegistration({
				state: "y".repeat(32),
				credentials: creds,
				displayName: "x",
				ownerAccount: null,
				now: T0,
			}),
		).toThrow(DomainError);
		const late = new Date(T0.getTime() + REGISTRATION_TTL_MS + 1);
		expect(c.isRegistrationExpired(late)).toBe(true);
		expect(() =>
			c.completeRegistration({
				state: "x".repeat(32),
				credentials: creds,
				displayName: "x",
				ownerAccount: null,
				now: late,
			}),
		).toThrow(/expired/);
		c.completeRegistration({
			state: "x".repeat(32),
			credentials: creds,
			displayName: "x",
			ownerAccount: null,
			now: T0,
		});
		expect(() =>
			c.completeRegistration({
				state: "x".repeat(32),
				credentials: creds,
				displayName: "x",
				ownerAccount: null,
				now: T0,
			}),
		).toThrow(DomainError);
	});

	it("requires an unguessable state", () => {
		expect(() =>
			Connection.startRegistration({
				id: "c",
				platform: "github",
				host: "github.com",
				kind: "github-app",
				ownerAccount: null,
				isPublic: false,
				registrationState: "short",
				now: T0,
			}),
		).toThrow(DomainError);
	});

	it("can be disabled and enabled; disabled connections accept no events", () => {
		const c = Connection.registerDirectly({
			id: "env",
			platform: "github",
			host: "github.com",
			kind: "github-app",
			displayName: "env",
			ownerAccount: null,
			credentials: creds,
			now: T0,
		});
		c.disable(T0);
		expect(c.acceptsEvents).toBe(false);
		c.enable(T0);
		expect(c.acceptsEvents).toBe(true);
	});
});

describe("ClaimPolicy and WatchedRepository", () => {
	const repo = RepoRef.of("github", "github.com", "octo/widgets");

	it("gives a repository to the first connection and records later contenders", () => {
		expect(ClaimPolicy.decide(null, "c1")).toEqual({ kind: "watch" });
		const w = WatchedRepository.watch(repo, "c1", T0);
		expect(ClaimPolicy.decide(w, "c1")).toEqual({ kind: "already-owned" });
		expect(ClaimPolicy.decide(w, "c2")).toEqual({
			kind: "contested",
			owner: "c1",
		});
		w.noteContest("c2", T0);
		w.noteContest("c2", T0);
		expect(w.contestedBy).toEqual(["c2"]);
		expect(w.pullEvents().map((e) => e.type)).toEqual([
			"connections.repository-watched",
			"connections.repository-claim-contested",
		]);
		w.dropContest("c2");
		expect(w.contestedBy).toEqual([]);
	});
});
