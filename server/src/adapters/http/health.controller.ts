import { Controller, Get, HttpException, Inject } from '@nestjs/common';
import { TOKENS } from './tokens';
import type { HealthProbe } from './webhook-ingress';

@Controller()
export class HealthController {
  constructor(@Inject(TOKENS.health) private readonly health: HealthProbe) {}

  /** Liveness: the process serves HTTP and its database works. */
  @Get('healthz')
  async healthz(): Promise<{ ok: boolean }> {
    const r = await this.health.check();
    if (!r.ok) throw new HttpException({ ok: false }, 503);
    return { ok: true };
  }

  @Get()
  root(): string {
    return 'maintainer-agent: see /admin';
  }
}
