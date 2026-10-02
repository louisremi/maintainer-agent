import { DomainEvent } from './domain-event';

/** Current time; injected so that rules involving time are testable. */
export interface Clock {
  now(): Date;
}

/** Generates identifiers for new aggregates. */
export interface IdGenerator {
  next(): string;
}

/** Publishes domain events to in-process subscribers after state was saved. */
export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

/** Structured log output for application services. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Runs persistence work atomically. Application services keep these scopes
 * short: never around network calls or agent runs.
 */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** Remembers transport deliveries already handled, for idempotent inbound adapters. */
export interface DeliveryLog {
  /** Returns false when this delivery was seen before. */
  recordOnce(source: string, deliveryId: string, at: Date): Promise<boolean>;
  /** Forgets a delivery whose handling failed, so that a redelivery is processed. */
  forget(source: string, deliveryId: string): Promise<void>;
  prune(olderThan: Date): Promise<number>;
}
