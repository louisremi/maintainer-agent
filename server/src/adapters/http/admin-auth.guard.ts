import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { TOKENS } from './tokens';

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
    const header = req.headers.authorization ?? '';
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header);
    if (m) {
      const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
      const password = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
      const expected = Buffer.from(this.auth.token);
      if (password.length === expected.length && timingSafeEqual(password, expected)) {
        if (req.method !== 'GET' && req.method !== 'HEAD' && !this.sameOrigin(req)) {
          // Browsers resend Basic credentials on cross-site form posts (CSRF).
          throw new HttpException('cross-origin request refused', 403);
        }
        return true;
      }
    }
    context.switchToHttp().getResponse<Response>().setHeader('WWW-Authenticate', 'Basic realm="maintainer-agent admin", charset="UTF-8"');
    throw new HttpException('authentication required', 401);
  }

  /** State-changing requests must come from the admin pages themselves. */
  private sameOrigin(req: Request): boolean {
    const allowed = new Set([this.auth.origin, `http://${req.headers.host ?? ''}`, `https://${req.headers.host ?? ''}`]);
    const origin = req.headers.origin;
    if (origin) return allowed.has(origin);
    const referer = req.headers.referer;
    if (referer) {
      try { return allowed.has(new URL(referer).origin); } catch { return false; }
    }
    return false;
  }
}
