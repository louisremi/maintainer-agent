import { Controller, HttpCode, HttpException, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { TOKENS } from './tokens';
import type { WebhookIngress } from './webhook-ingress';

type RawRequest = Request & { rawBody?: Buffer };

/** `POST /webhooks/:connectionId`: one endpoint per connection (per GitHub App). */
@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(TOKENS.webhookIngress) private readonly ingress: WebhookIngress) {}

  @Post(':connectionId')
  @HttpCode(202)
  async receive(@Param('connectionId') connectionId: string, @Req() req: RawRequest): Promise<{ status: string; detail?: string }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(connectionId)) throw new HttpException({ status: 'unknown connection' }, 404);
    if (!req.rawBody) throw new HttpException({ status: 'raw body unavailable' }, 400);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const r = await this.ingress.receive({ connectionId, headers, rawBody: req.rawBody });
    switch (r.kind) {
      case 'unknown-connection': throw new HttpException({ status: 'unknown connection' }, 404);
      case 'bad-signature': throw new HttpException({ status: 'invalid signature' }, 401);
      case 'duplicate': return { status: 'duplicate' };
      case 'accepted': return { status: 'accepted', detail: r.detail };
      case 'ignored': return { status: 'ignored', detail: r.reason };
    }
  }
}
