import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpException,
	Inject,
	Param,
	Post,
	Query,
	Res,
	UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import type { AdminApplication } from "./admin-application";
import { AdminAuthGuard } from "./admin-auth.guard";
import { esc, page } from "./html";
import { TOKENS } from "./tokens";

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

/** Operator pages: connections (GitHub Apps), their repositories, recent jobs. */
@Controller("admin")
export class AdminController {
	constructor(@Inject(TOKENS.admin) private readonly app: AdminApplication) {}

	@Get()
	@UseGuards(AdminAuthGuard)
	async index(@Res() res: Response): Promise<void> {
		const o = await this.app.overview();
		const connections = o.connections.length
			? o.connections
					.map(
						(c) => `
        <h3>${esc(c.displayName)} <span class="muted">(${esc(c.platform)} · ${esc(c.host)}${c.ownerAccount ? ` · ${esc(c.ownerAccount)}` : ""})</span></h3>
        <p>Status: <b class="${c.status === "active" ? "ok" : "warn"}">${esc(c.status)}</b> · webhook <code>${esc(o.publicUrl)}/webhooks/${esc(c.id)}</code>
        ${c.installUrl ? ` · <a href="${esc(c.installUrl)}" rel="noreferrer">install on repositories</a>` : ""}</p>
        <p>
          ${c.status === "active" ? `<form class="inline" method="post" action="/admin/connections/${esc(c.id)}/resync"><button>Resync repositories</button></form>` : ""}
          <form class="inline" method="post" action="/admin/connections/${esc(c.id)}/${c.status === "disabled" ? "enable" : "disable"}"><button>${c.status === "disabled" ? "Enable" : "Disable"}</button></form>
          <form class="inline" method="post" action="/admin/connections/${esc(c.id)}/remove" onsubmit="return confirm('Forget this connection? The GitHub App itself is not deleted.')"><button>Remove</button></form>
        </p>
        ${
					c.repositories.length
						? `<table><tr><th>Repository</th><th>State</th><th></th></tr>${c.repositories
								.map(
									(r) => `
          <tr><td>${esc(r.path)}</td>
          <td>${r.enabled ? '<span class="ok">enabled</span>' : '<span class="muted">disabled</span>'}${r.contestedBy.length ? ` <span class="warn">also reachable via ${esc(r.contestedBy.join(", "))} (ignored there)</span>` : ""}</td>
          <td><form class="inline" method="post" action="/admin/repositories/${r.enabled ? "disable" : "enable"}"><input type="hidden" name="repo" value="${esc(r.key)}"><button>${r.enabled ? "Disable" : "Enable"}</button></form></td></tr>`,
								)
								.join("")}</table>`
						: '<p class="muted">No repositories yet. Install the app on some, then resync.</p>'
				}`,
					)
					.join("")
			: '<p class="muted">No connection yet. Add a GitHub App below.</p>';
		const jobs = o.jobs.length
			? `<table><tr><th>When</th><th>Repository</th><th>Job</th><th>Status</th><th>Outcome</th></tr>${o.jobs
					.map(
						(j) => `
          <tr><td class="muted">${esc(j.updatedAt.replace("T", " ").slice(0, 19))}</td><td>${esc(j.repo.replace(/^[a-z]+:/, ""))} #${esc(j.number)}</td>
          <td>${esc(j.kind)}<br><span class="muted">${esc(j.trigger)}</span></td><td>${esc(j.status)}</td><td>${esc(j.outcome ?? "")}</td></tr>`,
					)
					.join("")}</table>`
			: '<p class="muted">No jobs yet.</p>';
		res.type("html").send(
			page(
				"Admin",
				`
      <h1>maintainer-agent</h1>
      <p>Model endpoint: ${o.modelAvailable ? '<b class="ok">reachable</b>' : '<b class="bad">unreachable</b> (jobs wait until it is back)'}
      · credentials at rest: ${o.secretsEncrypted ? '<span class="ok">encrypted</span>' : '<span class="warn">not encrypted (set SECRETS_KEY)</span>'}</p>
      <h2>Connections</h2>${connections}
      <h2>Add a GitHub App</h2>
      <form method="post" action="/admin/github/register"><fieldset>
        <label>GitHub host <input name="host" value="github.com" required pattern="[A-Za-z0-9.:-]+"> <span class="muted">github.com, or your GitHub Enterprise Server host</span></label>
        <label>Organization <input name="org" placeholder="leave empty for your personal account" pattern="[A-Za-z0-9-]*"></label>
        <label><input type="checkbox" name="public" value="1"> Public app (installable by other accounts; restrict them with ALLOWED_ACCOUNTS)</label>
        <p class="muted">GitHub creates the app with the right permissions and webhook URL; you only confirm its name.
        A private app can only be installed on the account that owns it: add one app per account.</p>
        <button>Create the app on GitHub</button>
      </fieldset></form>
      <h2>Recent jobs</h2>${jobs}`,
			),
		);
	}

	@Post("github/register")
	@HttpCode(200)
	@UseGuards(AdminAuthGuard)
	async register(
		@Body() body: Record<string, string>,
		@Res() res: Response,
	): Promise<void> {
		const host = (body.host ?? "github.com").trim().toLowerCase();
		if (!HOST.test(host)) throw new HttpException("invalid host", 400);
		const form = await this.app.startGithubRegistration({
			host,
			ownerAccount: body.org?.trim() || null,
			isPublic: body.public === "1",
		});
		const fields = Object.entries(form.fields)
			.map(
				([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
			)
			.join("");
		res.type("html").send(
			page(
				"Redirecting to GitHub",
				`
      <p>Sending you to GitHub to create the app…</p>
      <form id="f" method="post" action="${esc(form.action)}">${fields}<button>Continue to GitHub</button></form>
      <script>document.getElementById('f').submit()</script>`,
			),
		);
	}

	/** GitHub redirects here after creating the app. Protected by the one-time `state`, not by the admin password. */
	@Get("github/callback")
	async callback(
		@Query("state") state: string | undefined,
		@Query("code") code: string | undefined,
		@Res() res: Response,
	): Promise<void> {
		if (!state || !code) throw new HttpException("missing state or code", 400);
		try {
			const r = await this.app.completeGithubRegistration({ state, code });
			res.redirect(303, r.installUrl);
		} catch (err) {
			res
				.status(400)
				.type("html")
				.send(
					page(
						"Registration failed",
						`<h1>Registration failed</h1><p>${esc((err as Error).message)}</p><p><a href="/admin">Back</a></p>`,
					),
				);
		}
	}

	@Post("connections/:id/:action")
	@UseGuards(AdminAuthGuard)
	async connectionAction(
		@Param("id") id: string,
		@Param("action") action: string,
		@Res() res: Response,
	): Promise<void> {
		switch (action) {
			case "resync":
				await this.app.resync(id);
				break;
			case "enable":
				await this.app.setConnectionEnabled(id, true);
				break;
			case "disable":
				await this.app.setConnectionEnabled(id, false);
				break;
			case "remove":
				await this.app.removeConnection(id);
				break;
			default:
				throw new HttpException("unknown action", 404);
		}
		res.redirect(303, "/admin");
	}

	@Post("repositories/:action")
	@UseGuards(AdminAuthGuard)
	async repositoryAction(
		@Param("action") action: string,
		@Body() body: Record<string, string>,
		@Res() res: Response,
	): Promise<void> {
		if (action !== "enable" && action !== "disable")
			throw new HttpException("unknown action", 404);
		await this.app.setRepositoryEnabled(
			String(body.repo ?? ""),
			action === "enable",
		);
		res.redirect(303, "/admin");
	}
}
