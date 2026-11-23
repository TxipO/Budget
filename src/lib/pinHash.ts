import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'crypto';

// PIN hashing. The PIN is only 4-8 digits, so no hash alone survives a DB/
// backup leak — two things make the stored value useless without the server:
//   1. scrypt (slow, memory-hard, per-row random salt), and
//   2. a PEPPER derived from AUTH_SECRET (which is never in the DB/backups):
//      scrypt's input is HMAC(pepperKey, pin), so an attacker holding only the
//      DB can't even start enumerating the 10k PINs.
// Stored format: scrypt$v1$N$r$p$<saltB64>$<hashB64>. Legacy rows are the old
// unsalted sha256 hex; verifyPin() accepts both and flags those for a re-hash.
//
// AUTH_SECRET ROTATION CAVEAT: the pepper comes from AUTH_SECRET, so rotating
// it invalidates every v2 PIN hash (sessions die too). Recovery is operator-
// side: set Household.pinHash = NULL for the household (household #1 then
// falls back to the APP_PIN env var, which is still verified via the legacy
// path) and let the user set a new PIN. Don't rotate AUTH_SECRET casually.

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;
const SALT_BYTES = 16;
// scrypt needs ~128*N*r bytes (32 MiB here); node's default maxmem is 32 MiB.
const maxmemFor = (n: number, r: number) => 256 * n * r;

// Both inputs are always fixed-length digests when this is called with hashes,
// so comparing .length first leaks nothing; it just guards timingSafeEqual,
// which throws on mismatched lengths.
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// The old scheme. Kept ONLY to verify not-yet-migrated rows and for the
// APP_PIN env fallback (pin.ts); never written to the DB any more.
export function legacyHashPin(pin: string): string {
  return createHash('sha256').update(`budget-pin:${pin}`).digest('hex');
}

function pepperedInput(pin: string): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set'); // fail closed — callers 500
  const pepperKey = createHmac('sha256', secret).update('budget-pin-pepper-v1').digest();
  return createHmac('sha256', pepperKey).update(pin).digest();
}

function derive(input: Buffer, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(input, salt, KEYLEN, { N: n, r, p, maxmem: maxmemFor(n, r) }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPinV2(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(pepperedInput(pin), salt, N, R, P);
  return `scrypt$v1$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Never throws on a malformed `stored` (a garbage DB value must read as "wrong
// PIN", not a 500); only a missing AUTH_SECRET throws, on the v2 path.
export async function verifyPin(pin: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  const no = { ok: false, needsRehash: false };
  if (/^[0-9a-f]{64}$/.test(stored)) {
    const ok = safeEqual(legacyHashPin(pin), stored);
    return { ok, needsRehash: ok };
  }
  const m = /^scrypt\$v1\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/.exec(stored);
  if (!m) return no;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const salt = Buffer.from(m[4], 'base64');
  const expected = Buffer.from(m[5], 'base64');
  // Bounds so a tampered row can't make us allocate gigabytes.
  if (!(n >= 2 && n <= 2 ** 17 && (n & (n - 1)) === 0 && r >= 1 && r <= 16 && p >= 1 && p <= 4) || salt.length < 8 || expected.length !== KEYLEN) return no;
  const input = pepperedInput(pin);
  let key: Buffer;
  try { key = await derive(input, salt, n, r, p); } catch { return no; }
  const ok = timingSafeEqual(key, expected);
  return { ok, needsRehash: ok && (n !== N || r !== R || p !== P) };
}
