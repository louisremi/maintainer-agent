import { createHmac, timingSafeEqual } from 'node:crypto';

/** Checks GitHub's `X-Hub-Signature-256` header against the raw request body. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signGithubPayload(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
