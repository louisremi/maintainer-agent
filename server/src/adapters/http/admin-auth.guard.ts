import { createHmac, timingSafeEqual } from "node:crypto";
import {
	type CanActivate,
	type ExecutionContext,
	HttpException,
	Inject,
	Injectable,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { TOKENS } from "./tokens";

export interface AdminAuth {
	readonly token: string;
	/** The server's public origin, e.g. https://agent.example.org. */
	readonly origin: string;
}

/** HTTP Basic auth on /admin; any user name, the password is the admin token. */
@Injectable()
export class AdminAuthGuard implements CanActivate {
	constructor(@Inject(TOKENS.adminAuth) private readonly auth: AdminAuth) {}

	canActivate(context: ExecutionContext): boolean {
		const req = context.switchToHttp().getRequest<Request>();
		const header = req.headers.authorization ?? "";
		const encoded = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header)?.[1];
		if (encoded) {
			const decoded = Buffer.from(encoded, "base64").toString("utf8");
			const password = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
			const expected = Buffer.from(this.auth.token);
			if (
				password.length === expected.length &&
				timingSafeEqual(password, expected)
			) {
				if (
					req.method !== "GET" &&
					req.method !== "HEAD" &&
					!this.isFromAdminPages(req)
				) {
					// Browsers resend Basic credentials on cross-site form posts (CSRF).
					throw new HttpException("cross-origin request refused", 403);
				}
				return true;
			}
		}
		context
			.switchToHttp()
			.getResponse<Response>()
			.setHeader(
				"WWW-Authenticate",
				'Basic realm="maintainer-agent admin", charset="UTF-8"',
			);
		throw new HttpException("authentication required", 401);
	}

	/**
	 * State-changing requests must come from the admin pages themselves: they
	 * carry the form token (see {@link adminFormToken}), and a cross-site
	 * Origin, when the browser sends one, is refused. `Origin: null` (sent
	 * because the pages use `Referrer-Policy: no-referrer`) is not an origin.
	 */
	private isFromAdminPages(req: Request): boolean {
		const origin = req.headers.origin;
		if (origin && origin !== "null") {
			const allowed = new Set([
				this.auth.origin,
				`http://${req.headers.host ?? ""}`,
				`https://${req.headers.host ?? ""}`,
			]);
			if (!allowed.has(origin)) return false;
		}
		const body = (req.body ?? {}) as Record<string, unknown>;
		const given = Buffer.from(String(body._csrf ?? ""));
		const expected = Buffer.from(adminFormToken(this.auth.token));
		return given.length === expected.length && timingSafeEqual(given, expected);
	}
}

/**
 * Token embedded in every admin form. Derived from the admin password, so
 * only someone who could load the admin pages knows it; a cross-site page
 * cannot read it.
 */
export function adminFormToken(adminPassword: string): string {
	return createHmac("sha256", adminPassword)
		.update("maintainer-agent admin form")
		.digest("base64url");
}
