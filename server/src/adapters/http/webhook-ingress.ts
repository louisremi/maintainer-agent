export type { WebhookIngress, WebhookReceipt } from "../forges/forge-ingress";

export interface HealthProbe {
	check(): Promise<{ ok: boolean; details: Record<string, unknown> }>;
}
