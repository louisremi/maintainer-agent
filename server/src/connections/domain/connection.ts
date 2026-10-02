import { AggregateRoot, DomainError, Platform } from '../../shared-kernel';

export type ConnectionKind = 'github-app';
export type ConnectionStatus = 'pending' | 'active' | 'disabled';

/** A manifest-flow registration must be completed within this time. */
export const REGISTRATION_TTL_MS = 60 * 60 * 1000;

/**
 * What the server needs to authenticate as this connection. Opaque to the
 * domain apart from the bot identity: the forge adapter interprets `secrets`.
 */
export interface ConnectionCredentials {
  /** Forge-side identifier of the app or bot (e.g. the GitHub App id). */
  readonly appId: string;
  /** Forge-side short name (e.g. the GitHub App slug). */
  readonly appSlug: string;
  /** Login the forge shows for actions taken by this connection. */
  readonly botLogin: string;
  /** Private key, webhook secret, client secret... */
  readonly secrets: Readonly<Record<string, string>>;
}

export interface ConnectionProps {
  id: string;
  platform: Platform;
  host: string;
  kind: ConnectionKind;
  displayName: string;
  /** Account the app is registered under; null = the operator's personal account. */
  ownerAccount: string | null;
  isPublic: boolean;
  status: ConnectionStatus;
  registrationState: string | null;
  credentials: ConnectionCredentials | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ConnectionActivated {
  readonly type = 'connections.connection-activated';
  constructor(readonly connectionId: string, readonly occurredAt: Date) {}
}

export class ConnectionDisabled {
  readonly type = 'connections.connection-disabled';
  constructor(readonly connectionId: string, readonly occurredAt: Date) {}
}

/**
 * One credentialed link between this server and a forge account, e.g. a
 * GitHub App. A server may hold many; each has its own webhook endpoint.
 */
export class Connection extends AggregateRoot {
  private constructor(private props: ConnectionProps) {
    super();
  }

  /** Begins a manifest-style registration; the forge calls back with `state`. */
  static startRegistration(input: {
    id: string;
    platform: Platform;
    host: string;
    kind: ConnectionKind;
    ownerAccount: string | null;
    isPublic: boolean;
    registrationState: string;
    now: Date;
  }): Connection {
    if (input.registrationState.length < 16) throw new DomainError('registration state is too short');
    return new Connection({
      id: input.id,
      platform: input.platform,
      host: input.host.toLowerCase(),
      kind: input.kind,
      displayName: `${input.platform} app (pending)`,
      ownerAccount: input.ownerAccount,
      isPublic: input.isPublic,
      status: 'pending',
      registrationState: input.registrationState,
      credentials: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** A connection whose credentials were provided directly (e.g. environment). */
  static registerDirectly(input: {
    id: string;
    platform: Platform;
    host: string;
    kind: ConnectionKind;
    displayName: string;
    ownerAccount: string | null;
    credentials: ConnectionCredentials;
    now: Date;
  }): Connection {
    const c = new Connection({
      id: input.id,
      platform: input.platform,
      host: input.host.toLowerCase(),
      kind: input.kind,
      displayName: input.displayName,
      ownerAccount: input.ownerAccount,
      isPublic: false,
      status: 'active',
      registrationState: null,
      credentials: input.credentials,
      createdAt: input.now,
      updatedAt: input.now,
    });
    c.record(new ConnectionActivated(c.id, input.now));
    return c;
  }

  static restore(props: ConnectionProps): Connection {
    return new Connection({ ...props });
  }

  completeRegistration(input: {
    state: string;
    credentials: ConnectionCredentials;
    displayName: string;
    ownerAccount: string | null;
    now: Date;
  }): void {
    if (this.props.status !== 'pending') throw new DomainError('connection is not awaiting registration');
    if (!this.props.registrationState || input.state !== this.props.registrationState) {
      throw new DomainError('registration state does not match');
    }
    if (this.isRegistrationExpired(input.now)) throw new DomainError('registration expired; start again');
    this.props = {
      ...this.props,
      status: 'active',
      registrationState: null,
      credentials: input.credentials,
      displayName: input.displayName,
      ownerAccount: input.ownerAccount ?? this.props.ownerAccount,
      updatedAt: input.now,
    };
    this.record(new ConnectionActivated(this.id, input.now));
  }

  /** Replaces credentials provided out of band (e.g. rotated environment values). */
  replaceCredentials(credentials: ConnectionCredentials, now: Date): void {
    if (this.props.status === 'pending') throw new DomainError('a pending connection has no credentials yet');
    this.props = { ...this.props, credentials, updatedAt: now };
  }

  disable(now: Date): void {
    if (this.props.status === 'disabled') return;
    if (this.props.status === 'pending') throw new DomainError('a pending connection cannot be disabled; remove it');
    this.props = { ...this.props, status: 'disabled', updatedAt: now };
    this.record(new ConnectionDisabled(this.id, now));
  }

  enable(now: Date): void {
    if (this.props.status !== 'disabled') return;
    this.props = { ...this.props, status: 'active', updatedAt: now };
    this.record(new ConnectionActivated(this.id, now));
  }

  isRegistrationExpired(now: Date): boolean {
    return this.props.status === 'pending' && now.getTime() - this.props.createdAt.getTime() > REGISTRATION_TTL_MS;
  }

  /** Only active connections may receive events and act on repositories. */
  get acceptsEvents(): boolean {
    return this.props.status === 'active' && this.props.credentials !== null;
  }

  get id(): string { return this.props.id; }
  get platform(): Platform { return this.props.platform; }
  get host(): string { return this.props.host; }
  get kind(): ConnectionKind { return this.props.kind; }
  get displayName(): string { return this.props.displayName; }
  get ownerAccount(): string | null { return this.props.ownerAccount; }
  get isPublic(): boolean { return this.props.isPublic; }
  get status(): ConnectionStatus { return this.props.status; }
  get registrationState(): string | null { return this.props.registrationState; }
  get credentials(): ConnectionCredentials | null { return this.props.credentials; }
  get createdAt(): Date { return this.props.createdAt; }

  snapshot(): Readonly<ConnectionProps> {
    return { ...this.props };
  }
}
