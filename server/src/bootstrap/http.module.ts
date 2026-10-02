import { DynamicModule, Module } from '@nestjs/common';
import { AdminAuthGuard, AdminController, HealthController, TOKENS, WebhooksController } from '../adapters/http';
import type { App } from './container';

/** Nest wiring of the inbound HTTP adapters to the application facades. */
@Module({})
export class HttpModule {
  static forApp(app: App): DynamicModule {
    return {
      module: HttpModule,
      controllers: [WebhooksController, AdminController, HealthController],
      providers: [
        { provide: TOKENS.webhookIngress, useValue: app.webhooks },
        { provide: TOKENS.admin, useValue: app.admin },
        { provide: TOKENS.adminAuth, useValue: { token: app.adminToken, origin: new URL(app.config.PUBLIC_URL).origin } },
        { provide: TOKENS.health, useValue: app.health },
        AdminAuthGuard,
      ],
    };
  }
}
