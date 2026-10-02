import { randomBytes, randomUUID } from 'node:crypto';
import { Clock, IdGenerator, Logger } from '../../shared-kernel';
import { SecretGenerator } from '../../connections/application';

export class SystemClock implements Clock {
  now(): Date { return new Date(); }
}

/** Time-ordered, URL-safe identifiers (sortable by creation time). */
export class TimeOrderedIds implements IdGenerator {
  next(): string {
    return `${Date.now().toString(36).padStart(9, '0')}${randomBytes(6).toString('hex')}`;
  }
}

export class UuidIds implements IdGenerator {
  next(): string { return randomUUID(); }
}

export class CryptoSecretGenerator implements SecretGenerator {
  token(bytes: number): string {
    return randomBytes(bytes).toString('base64url');
  }
}

const SECRET_KEYS = /token|secret|key|authorization|password|pem/i;

/** One JSON object per line on stdout; secret-looking fields are never printed. */
export class JsonLogger implements Logger {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {}

  private emit(level: string, message: string, fields?: Record<string, unknown>) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields ?? {})) safe[k] = SECRET_KEYS.test(k) ? '[redacted]' : v;
    this.write(JSON.stringify({ time: new Date().toISOString(), level, message, ...safe }));
  }

  info(message: string, fields?: Record<string, unknown>) { this.emit('info', message, fields); }
  warn(message: string, fields?: Record<string, unknown>) { this.emit('warn', message, fields); }
  error(message: string, fields?: Record<string, unknown>) { this.emit('error', message, fields); }
}
