import type { NextFunction, Request, Response } from "express";

/** Paths GitHub needs on the public URL; everything else stays private. */
const PUBLIC_ROUTES: readonly { method: string; path: RegExp }[] = [
	{ method: "POST", path: /^\/webhooks\/[A-Za-z0-9_-]{1,64}$/ },
	{ method: "GET", path: /^\/admin\/github\/callback$/ },
	{ method: "GET", path: /^\/healthz$/ },
];

/**
 * When the server is published on the internet under `publicHost` (e.g. a
 * Tailscale Funnel or a tunnel), only the routes GitHub needs answer on that
 * host name; `/admin` and the rest return 404 there and stay reachable on
 * other host names (LAN, tailnet). Both the Host header and a forwarded
 * host count, so a proxy cannot be used to reach the admin pages.
 */
export function publicHostFilter(publicHost: string) {
	const expected = publicHost.toLowerCase();
	const hostOf = (value: string | string[] | undefined) =>
		(Array.isArray(value) ? value[0] : value)
			?.split(",")[0]
			?.trim()
			.toLowerCase()
			.replace(/:\d+$/, "");
	return (req: Request, res: Response, next: NextFunction): void => {
		const hosts = [
			hostOf(req.headers.host),
			hostOf(req.headers["x-forwarded-host"]),
		];
		if (!hosts.includes(expected)) {
			next();
			return;
		}
		const path = (req.originalUrl ?? req.url).split("?")[0] ?? "";
		if (
			PUBLIC_ROUTES.some((r) => r.method === req.method && r.path.test(path))
		) {
			next();
			return;
		}
		res.status(404).json({ message: "not found" });
	};
}
