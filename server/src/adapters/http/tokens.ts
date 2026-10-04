/** Dependency-injection tokens for what inbound adapters need from the application layer. */
export const TOKENS = {
	webhookIngress: Symbol("WebhookIngress"),
	admin: Symbol("AdminApplication"),
	adminAuth: Symbol("AdminAuth"),
	health: Symbol("HealthProbe"),
} as const;
