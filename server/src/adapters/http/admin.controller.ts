import { join, resolve } from "node:path";
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
import { formatIssue, type SettingsIssue } from "../../settings/domain";
import type { AdminApplication, SettingsAdminPort } from "./admin-application";
import {
	type AdminAuth,
	AdminAuthGuard,
	adminFormToken,
} from "./admin-auth.guard";
import { esc, page } from "./html";
import { TOKENS } from "./tokens";

/** Static files shipped with the server (see server/assets). */
const ASSETS_DIR = resolve(__dirname, "../../../assets");
const ADMIN_ASSETS = new Set([
	"maintainer-agent-logo.png",
	"maintainer-agent-logo-400.png",
]);

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

/** Operator pages: settings overview and editor, connections (GitHub Apps), recent jobs. */
@Controller("admin")
export class AdminController {
	private readonly csrf: string;

	constructor(
		@Inject(TOKENS.admin) private readonly app: AdminApplication,
		@Inject(TOKENS.settingsAdmin) private readonly settings: SettingsAdminPort,
		@Inject(TOKENS.adminAuth) auth: AdminAuth,
	) {
		this.csrf = adminFormToken(auth.token);
	}

	@Get()
	@UseGuards(AdminAuthGuard)
	async index(@Res() res: Response): Promise<void> {
		const settings = this.settings;
		if (settings.mode === "safe") {
			res
				.type("html")
				.send(
					page(
						"Safe mode",
						`<h1>maintainer-agent</h1>${this.safeModeBanner()}`,
					),
				);
			return;
		}
		const o = await this.app.overview();
		const restart = this.restartNote();
		const unconfigured = o.connections.flatMap((c) =>
			c.repositories.filter((r) => !r.configured),
		);
		const connections = o.connections.length
			? o.connections
					.map(
						(c) => `
        <h3>${esc(c.displayName)} <span class="muted">(${esc(c.platform)} · ${esc(c.host)}${c.ownerAccount ? ` · ${esc(c.ownerAccount)}` : ""} · <code>connections.${esc(c.id)}</code>)</span></h3>
        <p>Status: <b class="${c.status === "active" ? "ok" : "warn"}">${esc(c.status)}</b> · webhook <code>${esc(o.publicUrl)}/webhooks/${esc(c.id)}</code>
        ${c.installUrl ? ` · <a href="${esc(c.installUrl)}" rel="noreferrer">install on repositories</a>` : ""}</p>
        ${
					c.appearanceUrl
						? `<div class="notice"><b>Give the app its avatar.</b> GitHub cannot set an app's logo automatically:
          <a href="/admin/assets/maintainer-agent-logo.png" download>download the logo</a>, open the
          <a href="${esc(c.appearanceUrl)}" rel="noreferrer" target="_blank">app's settings</a>, and under
          "Display information" click <i>Upload a logo</i> → <i>Set new avatar</i> (badge background: <code>#ffffff</code>).
          <form class="inline" method="post" action="/admin/connections/${esc(c.id)}/appearance-done"><input type="hidden" name="_csrf" value="${this.csrf}"><button>Done</button></form>
          <span class="muted">(saved to settings.yml; the server restarts)</span></div>`
						: ""
				}
        ${c.status === "active" ? `<p><form class="inline" method="post" action="/admin/connections/${esc(c.id)}/resync"><input type="hidden" name="_csrf" value="${this.csrf}"><button>Resync repositories</button></form></p>` : ""}
        ${
					c.repositories.length
						? `<table><tr><th>Repository the app reaches</th><th>In settings.yml</th></tr>${c.repositories
								.map(
									(r) => `
          <tr><td>${esc(r.path)}</td>
          <td>${r.configured ? (r.enabled ? '<span class="ok">configured</span>' : '<span class="muted">configured, paused</span>') : '<span class="warn">not configured (ignored)</span>'}${r.contestedBy.length ? ` <span class="muted">also reachable via ${esc(r.contestedBy.join(", "))}</span>` : ""}</td></tr>`,
								)
								.join("")}</table>`
						: '<p class="muted">The app reaches no repository yet. Install it on some, then resync.</p>'
				}`,
					)
					.join("")
			: '<p class="muted">No connection yet. Add a GitHub App below.</p>';
		const snippet = unconfigured.length
			? `<p>The apps reach these repositories, but settings.yml does not list them, so they are ignored. To act on them, add them under <code>repositories:</code> in the <a href="/admin/settings">settings</a>:</p>
        <pre>repositories:\n${unconfigured.map((r) => `  ${esc(r.settingsKey)}: {}`).join("\n")}</pre>`
			: "";
		const missing = o.configuredRepositories.filter(
			(r) =>
				!o.connections.some((c) =>
					c.repositories.some((x) => x.settingsKey === r.key),
				),
		);
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
      ${restart}
      <p>Settings: <code>${esc(settings.path)}</code> · <a href="/admin/settings">edit settings</a>
      · model endpoints: ${o.modelAvailable ? '<b class="ok">reachable</b>' : '<b class="bad">unreachable</b> (jobs wait until they are back)'}</p>
      <h2>Repositories</h2>
      ${
				o.configuredRepositories.length
					? `<table><tr><th>settings.yml</th><th>State</th></tr>${o.configuredRepositories
							.map(
								(r) =>
									`<tr><td><code>${esc(r.key)}</code></td><td>${r.enabled ? '<span class="ok">active</span>' : '<span class="muted">paused (enabled: false)</span>'}${missing.includes(r) ? ' <span class="warn">no app reaches it yet: install an app on it</span>' : ""}</td></tr>`,
							)
							.join("")}</table>`
					: '<p class="muted">No repository configured yet: add some under <code>repositories:</code> in the <a href="/admin/settings">settings</a>.</p>'
			}
      ${snippet}
      <h2>Models</h2>
      <table><tr><th>Name</th><th>Endpoint</th><th>Model</th></tr>${o.models.map((m) => `<tr><td><code>${esc(m.name)}</code></td><td>${esc(m.apiBase)}</td><td>${esc(m.model)}</td></tr>`).join("")}</table>
      <h2>Connections</h2>${connections}
      <h2>Add a GitHub App</h2>
      <form method="post" action="/admin/github/register"><input type="hidden" name="_csrf" value="${this.csrf}"><fieldset>
        <label>GitHub host <input name="host" value="github.com" required pattern="[A-Za-z0-9.:-]+"> <span class="muted">github.com, or your GitHub Enterprise Server host</span></label>
        <label>Organization <input name="org" placeholder="leave empty for your personal account" pattern="[A-Za-z0-9-]*"></label>
        <label><input type="checkbox" name="public" value="1"> Public app (installable by other accounts; needs <code>server.allowed_accounts</code>)</label>
        <p class="muted">GitHub creates the app with the right permissions and webhook URL; you only confirm its name.
        The app is then added to settings.yml (its keys to secrets.yaml) and the server restarts.
        A private app can only be installed on the account that owns it: add one app per account.</p>
        <button>Create the app on GitHub</button>
      </fieldset></form>
      <h2>Recent jobs</h2>${jobs}`,
			),
		);
	}

	/** The raw settings.yml editor: validate, or save and restart. */
	@Get("settings")
	@UseGuards(AdminAuthGuard)
	async settingsPage(@Res() res: Response): Promise<void> {
		const text = await this.settings.text();
		res
			.type("html")
			.send(
				this.editorPage(
					text,
					this.settings.mode === "safe" ? this.settings.issues : [],
					null,
				),
			);
	}

	@Post("settings")
	@HttpCode(200)
	@UseGuards(AdminAuthGuard)
	async saveSettings(
		@Body() body: Record<string, string>,
		@Res() res: Response,
	): Promise<void> {
		const text = String(body.text ?? "").replace(/\r\n/g, "\n");
		if (body.action === "validate") {
			const r = this.settings.validate(text);
			res
				.type("html")
				.send(
					this.editorPage(
						text,
						r.ok ? [] : r.issues,
						r.ok ? "The settings are valid. Nothing was saved." : null,
					),
				);
			return;
		}
		const r = await this.settings.save(text);
		if (!r.ok) {
			res
				.status(400)
				.type("html")
				.send(this.editorPage(text, r.issues, null));
			return;
		}
		res.type("html").send(this.restartingPage("Settings saved."));
	}

	private editorPage(
		text: string,
		issues: readonly SettingsIssue[],
		ok: string | null,
	): string {
		const sources = this.settings.secretSources();
		return page(
			"Settings",
			`<p><a href="/admin">← admin</a></p>
      <h1>Settings</h1>
      <p><code>${esc(this.settings.path)}</code> · reference: <a href="https://github.com/louisremi/maintainer-agent/blob/main/docs/settings.md" rel="noreferrer" target="_blank">docs/settings.md</a>
      · schema: <a href="/settings/schema.json">schema.json</a></p>
      <p class="muted">Saving validates the file, keeps a backup in <code>backups/</code>, then restarts the server to apply it.
      Secrets are written as <code>{MA_NAME}</code> placeholders; their values live in <code>secrets.yaml</code>, Docker secrets or the environment and are never shown here.</p>
      ${ok ? `<p class="ok"><b>${esc(ok)}</b></p>` : ""}
      ${issues.length ? `<div class="notice"><b>${issues.length} problem${issues.length > 1 ? "s" : ""}:</b><ul>${issues.map((i) => `<li><code>${esc(formatIssue(i))}</code></li>`).join("")}</ul></div>` : ""}
      <form method="post" action="/admin/settings"><input type="hidden" name="_csrf" value="${this.csrf}">
        <textarea name="text" rows="40" spellcheck="false" style="width:100%;font:13px/1.45 ui-monospace,monospace;tab-size:2">${esc(text)}</textarea>
        <p><button name="action" value="validate">Validate</button>
        <button name="action" value="save" onclick="return confirm('Save and restart the server? Running jobs are interrupted and resume after the restart.')">Save and restart</button></p>
      </form>
      ${sources.length ? `<h2>Secrets in use</h2><table><tr><th>Name</th><th>From</th></tr>${sources.map((s) => `<tr><td><code>${esc(s.name)}</code></td><td>${esc(s.source)}</td></tr>`).join("")}</table>` : ""}`,
		);
	}

	private restartingPage(what: string): string {
		return page(
			"Restarting",
			`<h1>${esc(what)} Restarting…</h1><p class="muted">The page reloads when the server is back.</p>
      <script>
        const back = () => fetch('/healthz', {cache: 'no-store'}).then(r => r.ok ? location.assign('/admin') : setTimeout(back, 1000), () => setTimeout(back, 1000));
        setTimeout(back, 2500);
      </script>`,
		);
	}

	private safeModeBanner(): string {
		const issues = this.settings.issues;
		return `<div class="notice"><b>Safe mode: settings.yml is invalid.</b> No events or jobs are processed (GitHub redelivers webhooks later).
      Fix the file on the <a href="/admin/settings">settings page</a> or on disk, then restart.
      <ul>${issues.map((i) => `<li><code>${esc(formatIssue(i))}</code></li>`).join("")}</ul></div>`;
	}

	private restartNote(): string {
		return this.settings.migratedFrom !== null
			? `<div class="notice">settings.yml was migrated from schema version ${this.settings.migratedFrom} at start-up; a backup is in <code>backups/</code>.</div>`
			: "";
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

	/** Files the admin page links to (the app logo). Fixed names only. */
	@Get("assets/:name")
	@UseGuards(AdminAuthGuard)
	asset(@Param("name") name: string, @Res() res: Response): void {
		if (!ADMIN_ASSETS.has(name)) throw new HttpException("not found", 404);
		res.type("png").sendFile(join(ASSETS_DIR, name));
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
			case "appearance-done":
				await this.app.markAppearanceDone(id);
				res.type("html").send(this.restartingPage("Saved."));
				return;
			default:
				throw new HttpException("unknown action", 404);
		}
		res.redirect(303, "/admin");
	}
}
