import { Controller, Get, HttpException, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { page } from "./html";
import { TOKENS } from "./tokens";
import type { HealthProbe } from "./webhook-ingress";

@Controller()
export class HealthController {
	constructor(@Inject(TOKENS.health) private readonly health: HealthProbe) {}

	/** Liveness: the process serves HTTP and its database works. */
	@Get("healthz")
	async healthz(): Promise<{ ok: boolean }> {
		const r = await this.health.check();
		if (!r.ok) throw new HttpException({ ok: false }, 503);
		return { ok: true };
	}

	/**
	 * Where GitHub sends the browser after the app is installed. Public and
	 * static: it reveals nothing and changes nothing (repositories arrive via
	 * the installation webhook).
	 */
	@Get("installed")
	installed(@Res() res: Response): void {
		res.type("html").send(
			page(
				"Installed",
				`<h1>maintainer-agent is installed</h1>
      <p>The repositories you selected are now watched. Manage them on this server's admin page
      (if it is not public, open it on your private network or VPN).</p>
      <p class="muted">Labels are created on each repository; new issues and pull requests are handled from now on.</p>`,
			),
		);
	}

	@Get()
	root(): string {
		return "maintainer-agent: see /admin";
	}
}
