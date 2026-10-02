/** A request the application cannot honour (unknown id, wrong state...). */
export class ConnectionsError extends Error {
  constructor(message: string, readonly code: 'not-found' | 'invalid' | 'conflict') {
    super(message);
    this.name = 'ConnectionsError';
  }
}
