/** Whether a person may decide what happens in a repository. */
export type Role = "maintainer" | "other";

/** Someone acting on a forge: a person or a bot account. */
export interface Actor {
	readonly login: string;
	readonly isBot: boolean;
}
