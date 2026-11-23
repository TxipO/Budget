// Run: npx tsx scripts/check-pin-hash.mts
import assert from 'node:assert';
import { hashPinV2, verifyPin, legacyHashPin } from '../src/lib/pinHash.ts';

process.env.AUTH_SECRET = 'test-secret-one';

const t0 = Date.now();
const h = await hashPinV2('1234');
const hashMs = Date.now() - t0;
assert.match(h, /^scrypt\$v1\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
assert.notStrictEqual(await hashPinV2('1234'), h, 'random salt: same PIN hashes differently');

assert.deepStrictEqual(await verifyPin('1234', h), { ok: true, needsRehash: false });
assert.deepStrictEqual(await verifyPin('1235', h), { ok: false, needsRehash: false });
assert.deepStrictEqual(await verifyPin('', h), { ok: false, needsRehash: false });

// legacy sha256 hex: accepted, flagged for re-hash; wrong PIN rejected
const legacy = legacyHashPin('1234');
assert.deepStrictEqual(await verifyPin('1234', legacy), { ok: true, needsRehash: true });
assert.deepStrictEqual(await verifyPin('0000', legacy), { ok: false, needsRehash: false });

// malformed / hostile stored values: rejected, never thrown
for (const bad of ['', 'garbage', 'scrypt$v1$', 'scrypt$v2$32768$8$1$AAAA$AAAA', 'scrypt$v1$32768$8$1$AAAA$AAAA',
  'scrypt$v1$3$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA', 'scrypt$v1$999999999$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(43) + '=', h.slice(0, -4), legacy.toUpperCase()]) {
  assert.deepStrictEqual(await verifyPin('1234', bad), { ok: false, needsRehash: false }, `rejects ${bad.slice(0, 30)}`);
}

// pepper: a hash made under another AUTH_SECRET must not verify (leak of DB alone is useless)
process.env.AUTH_SECRET = 'test-secret-two';
assert.strictEqual((await verifyPin('1234', h)).ok, false, 'different AUTH_SECRET -> v2 hash invalid');
// ...but legacy still works without depending on the secret
assert.strictEqual((await verifyPin('1234', legacy)).ok, true);

// fail closed with no secret
delete process.env.AUTH_SECRET;
await assert.rejects(hashPinV2('1234'));
await assert.rejects(verifyPin('1234', h));

console.log(`ok (one hash ~${hashMs}ms incl. warmup)`);
