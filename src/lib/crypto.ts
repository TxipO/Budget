import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// Encrypts secrets that must be recoverable (Monobank personal API tokens) —
// separate from auth.ts's one-way hashing, which is for values we only ever
// compare, never need back in plaintext. MONO_TOKEN_KEY is a dedicated
// secret so a leak of AUTH_SECRET (session signing) can't also decrypt
// stored bank tokens, and vice versa.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM's recommended nonce size

function getKey(): Buffer {
  const hex = process.env.MONO_TOKEN_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('MONO_TOKEN_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

// Output layout: <iv:12b><authTag:16b><ciphertext> — all hex-encoded into
// one string so it fits a single DB column.
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('hex');
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const buf = Buffer.from(encoded, 'hex');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = buf.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
