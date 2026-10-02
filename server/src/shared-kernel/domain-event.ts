/** Something that happened in a domain and that other parts may react to. */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
}

/** Aggregates record events; application services publish them after saving. */
export abstract class AggregateRoot {
  private pending: DomainEvent[] = [];

  protected record(event: DomainEvent): void {
    this.pending.push(event);
  }

  pullEvents(): DomainEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }
}
