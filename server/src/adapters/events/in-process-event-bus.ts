import { DomainEvent, EventPublisher, Logger } from '../../shared-kernel';

export type EventSubscriber = (event: DomainEvent) => Promise<void>;

/** Delivers events to subscribers in-process, after the publisher saved its state. */
export class InProcessEventBus implements EventPublisher {
  private readonly subscribers: EventSubscriber[] = [];

  constructor(private readonly log: Logger) {}

  subscribe(subscriber: EventSubscriber): void {
    this.subscribers.push(subscriber);
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const s of this.subscribers) {
        try {
          await s(event);
        } catch (err) {
          this.log.warn('event subscriber failed', { type: event.type, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
}
