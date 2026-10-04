/**
 * Contract between the HTTP webhook endpoint and forge adapters. Each forge
 * (GitHub now, GitLab later) implements it with its own signature scheme and
 * payload translation.
 */
export type WebhookReceipt =
	| { readonly kind: "unknown-connection" }
	| { readonly kind: "bad-signature" }
	| { readonly kind: "duplicate" }
	| { readonly kind: "accepted"; readonly detail: string }
	| { readonly kind: "ignored"; readonly reason: string };

export interface WebhookIngress {
	/** Throws for unexpected failures (the forge then redelivers on 5xx). */
	receive(input: {
		connectionId: string;
		headers: Readonly<Record<string, string | undefined>>;
		rawBody: Buffer;
	}): Promise<WebhookReceipt>;
}
