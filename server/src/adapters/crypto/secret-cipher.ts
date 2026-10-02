import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Protects credentials at rest. */
export interface SecretCipher {
  readonly encrypts: boolean;
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

const PREFIX = 'v1:';

/** AES-256-GCM with a key derived from the operator's SECRETS_KEY. */
export class AesGcmSecretCipher implements SecretCipher {
  readonly encrypts = true;
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 16) throw new Error('SECRETS_KEY must be at least 16 characters');
    this.key = createHash('sha256').update(`maintainer-agent:${secret}`).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  decrypt(stored: string): string {
    if (!stored.startsWith(PREFIX)) {
      throw new Error('stored credentials are not encrypted; they were saved without SECRETS_KEY');
    }
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/** No encryption (the database file is still mode 600). Used without SECRETS_KEY. */
export class PlaintextSecretCipher implements SecretCipher {
  readonly encrypts = false;
  encrypt(plain: string): string { return plain; }
  decrypt(stored: string): string {
    if (stored.startsWith(PREFIX)) throw new Error('stored credentials are encrypted; set SECRETS_KEY');
    return stored;
  }
}
