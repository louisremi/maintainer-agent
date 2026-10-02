import { Clock, DeliveryLog, Logger, RepoRef } from '../../../shared-kernel';
import type { ConnectionAccess } from '../../../connections/application';
import type { ForgeEvent } from '../../../maintenance/domain';
import type { WebhookIngress } from '../forge-ingress';
import { GithubEventTranslator } from './github-event-translator';
import { verifyGithubSignature } from './webhook-signature';

/** Application operations the GitHub ingress calls (from both contexts). */
export interface GithubIngressPorts {
  connectionAccess(connectionId: string): Promise<ConnectionAccess | null>;
  handleEvent(connectionId: string, event: ForgeEvent): Promise<{ kind: 'queued'; jobId: string } | { kind: 'ignored'; reason: string }>;
  syncRepositories(input: { connectionId: string; added: ForgeEventRepos; removed: ForgeEventRepos; mode: 'delta' | 'replace' }): Promise<unknown>;
}

type ForgeEventRepos = RepoRef[];

const MAX_BODY = 5 * 1024 * 1024;

/**
 * Receives GitHub webhooks for one connection: checks the signature with that
 * connection's own secret, ignores redeliveries, translates the payload, and
 * hands it to the application.
 */
export class GithubWebhookIngress implements WebhookIngress {
  constructor(
    private readonly ports: GithubIngressPorts,
    private readonly deliveries: DeliveryLog,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async receive(input: { connectionId: string; headers: Readonly<Record<string, string | undefined>>; rawBody: Buffer }) {
    const access = await this.ports.connectionAccess(input.connectionId);
    if (!access || access.platform !== 'github') return { kind: 'unknown-connection' as const };
    if (input.rawBody.length > MAX_BODY) return { kind: 'ignored' as const, reason: 'payload too large' };
    const secret = access.credentials.secrets['webhookSecret'] ?? '';
    if (!verifyGithubSignature(secret, input.rawBody, input.headers['x-hub-signature-256'])) {
      this.log.warn('webhook with an invalid signature', { connectionId: input.connectionId });
      return { kind: 'bad-signature' as const };
    }
    const delivery = input.headers['x-github-delivery'];
    const eventName = input.headers['x-github-event'] ?? '';
    if (!delivery || !/^[A-Za-z0-9-]{1,100}$/.test(delivery)) return { kind: 'ignored' as const, reason: 'missing delivery id' };
    if (!(await this.deliveries.recordOnce(input.connectionId, delivery, this.clock.now()))) return { kind: 'duplicate' as const };

    try {
      const payload = JSON.parse(input.rawBody.toString('utf8')) as Record<string, unknown>;
      const translated = new GithubEventTranslator(access.host).translate(eventName, payload as never);
      switch (translated.kind) {
        case 'ignored':
          return { kind: 'ignored' as const, reason: translated.reason };
        case 'repositories':
          await this.ports.syncRepositories({ connectionId: input.connectionId, added: translated.added, removed: translated.removed, mode: translated.mode });
          return { kind: 'accepted' as const, detail: `repositories +${translated.added.length} -${translated.removed.length}` };
        case 'forge-event': {
          const r = await this.ports.handleEvent(input.connectionId, translated.event);
          return r.kind === 'queued' ? { kind: 'accepted' as const, detail: `job ${r.jobId}` } : { kind: 'ignored' as const, reason: r.reason };
        }
      }
    } catch (err) {
      // Let GitHub redeliver: forget this delivery and answer 5xx.
      await this.deliveries.forget(input.connectionId, delivery).catch(() => undefined);
      throw err;
    }
  }
}
