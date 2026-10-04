import type { WatchedRepository } from "./watched-repository";

export type ClaimDecision =
	| { kind: "watch" }
	| { kind: "already-owned" }
	| { kind: "contested"; owner: string };

/**
 * A repository reachable through several connections belongs to the first
 * one that claimed it; later claims are recorded as contests and ignored, so
 * that every event is handled exactly once.
 */
export const ClaimPolicy = {
	decide(
		existing: WatchedRepository | null,
		connectionId: string,
	): ClaimDecision {
		if (!existing) return { kind: "watch" };
		if (existing.connectionId === connectionId)
			return { kind: "already-owned" };
		return { kind: "contested", owner: existing.connectionId };
	},
};
