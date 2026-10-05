import type {
	AppRegistrationGateway,
	CompletedRegistration,
	RegistrationForm,
} from "../../../connections/application";
import type { Connection } from "../../../connections/domain";
import { type Fetch, GithubHttp, githubHost } from "./github-http";

/** Permissions the app asks for. Never workflows, actions, administration or secrets. */
export const APP_PERMISSIONS = {
	contents: "write",
	issues: "write",
	pull_requests: "write",
	metadata: "read",
} as const;

export const APP_EVENTS = ["issues", "pull_request"] as const;

interface ManifestConversion {
	id: number;
	slug: string;
	name: string;
	pem: string;
	webhook_secret: string | null;
	client_id: string;
	client_secret: string;
	owner: { login: string; type: string } | null;
	html_url: string;
}

/**
 * GitHub's App Manifest flow: the operator's browser POSTs a manifest to
 * GitHub, GitHub creates the app and redirects back with a code that the
 * server exchanges for the app's id, private key and webhook secret. Each
 * app gets its own webhook URL, so one server can hold any number of apps.
 */
export class GithubAppRegistrationGateway implements AppRegistrationGateway {
	readonly platform = "github" as const;

	constructor(
		private readonly publicUrl: string,
		private readonly fetchImpl: Fetch = fetch,
	) {}

	manifest(connection: Connection): Record<string, unknown> {
		const base = this.publicUrl.replace(/\/+$/, "");
		return {
			name: `maintainer-agent-${connection.id.slice(0, 6).toLowerCase()}`,
			url: base,
			description:
				"Self-hosted maintainer agent: answers issues, proposes fixes as draft pull requests, reviews pull requests.",
			hook_attributes: {
				url: `${base}/webhooks/${connection.id}`,
				active: true,
			},
			redirect_url: `${base}/admin/github/callback`,
			// Public landing page after installation (the admin pages may be private).
			setup_url: `${base}/installed`,
			setup_on_update: false,
			public: connection.isPublic,
			default_permissions: APP_PERMISSIONS,
			default_events: APP_EVENTS,
		};
	}

	registrationForm(connection: Connection): RegistrationForm {
		const web = githubHost(connection.host).webUrl;
		const owner = connection.ownerAccount;
		const path = owner
			? `/organizations/${encodeURIComponent(owner)}/settings/apps/new`
			: "/settings/apps/new";
		return {
			action: `${web}${path}?state=${encodeURIComponent(connection.registrationState ?? "")}`,
			fields: { manifest: JSON.stringify(this.manifest(connection)) },
		};
	}

	async complete(
		connection: Connection,
		code: string,
	): Promise<CompletedRegistration> {
		if (!/^[A-Za-z0-9_-]{8,100}$/.test(code))
			throw new Error("invalid manifest code");
		const host = githubHost(connection.host);
		const http = new GithubHttp(host, this.fetchImpl);
		const r = await http.request<ManifestConversion>(
			"POST",
			`/app-manifests/${code}/conversions`,
			null,
		);
		if (!r.webhook_secret)
			throw new Error("GitHub did not return a webhook secret");
		return {
			credentials: {
				appId: String(r.id),
				appSlug: r.slug,
				botLogin: `${r.slug}[bot]`,
				secrets: {
					privateKey: r.pem,
					webhookSecret: r.webhook_secret,
					clientId: r.client_id,
					clientSecret: r.client_secret,
				},
			},
			displayName: r.name,
			ownerAccount: r.owner?.type === "Organization" ? r.owner.login : null,
			installUrl: `${host.webUrl}/apps/${r.slug}/installations/new`,
		};
	}

	/**
	 * The app's settings page ("Display information" holds the logo). GitHub
	 * has no API to set an app's logo, so the operator uploads it there.
	 */
	appearanceUrl(connection: Connection): string | null {
		const slug = connection.credentials?.appSlug;
		if (!slug) return null;
		const web = githubHost(connection.host).webUrl;
		const owner = connection.ownerAccount;
		return owner
			? `${web}/organizations/${encodeURIComponent(owner)}/settings/apps/${slug}`
			: `${web}/settings/apps/${slug}`;
	}

	installUrl(connection: Connection): string | null {
		const slug = connection.credentials?.appSlug;
		return slug
			? `${githubHost(connection.host).webUrl}/apps/${slug}/installations/new`
			: null;
	}
}
