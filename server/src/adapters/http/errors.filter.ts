import {
	type ArgumentsHost,
	Catch,
	type ExceptionFilter,
	HttpException,
} from "@nestjs/common";
import type { Response } from "express";
import type { Logger } from "../../shared-kernel";

/** Maps application errors to HTTP statuses and keeps internal details out of responses. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
	constructor(private readonly log: Logger) {}

	catch(exception: unknown, host: ArgumentsHost): void {
		const res = host.switchToHttp().getResponse<Response>();
		if (exception instanceof HttpException) {
			const body = exception.getResponse();
			res
				.status(exception.getStatus())
				.json(typeof body === "string" ? { message: body } : body);
			return;
		}
		const e = exception as { name?: string; code?: string; message?: string };
		if (e?.name === "ConnectionsError") {
			const status =
				e.code === "not-found" ? 404 : e.code === "conflict" ? 409 : 400;
			res.status(status).json({ message: e.message });
			return;
		}
		if (e?.name === "SafeModeError") {
			// GitHub redelivers on 5xx once the settings are fixed.
			res.status(503).json({ message: e.message });
			return;
		}
		if (e?.name === "DomainError") {
			res.status(400).json({ message: e.message });
			return;
		}
		this.log.error("request failed", {
			reason: e?.message ?? String(exception),
		});
		res.status(500).json({ message: "internal error" });
	}
}
