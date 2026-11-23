// Run: npx tsx scripts/check-session-revocation.mts
import assert from 'node:assert';
import { isSessionRevoked as rev } from '../src/lib/sessionRevocation.ts';

const T = 1_000_000;
// never revoked
assert.strictEqual(rev(T, null, 'shared'), false);
assert.strictEqual(rev(T, null, { validAfter: null }), false);
// household stamp: older dies, newer/equal survives (equal = cookie re-issued in the same ms)
assert.strictEqual(rev(T - 1, T, 'shared'), true);
assert.strictEqual(rev(T, T, 'shared'), false);
assert.strictEqual(rev(T + 1, T, 'shared'), false);
// household stamp applies to user sessions too
assert.strictEqual(rev(T - 1, T, { validAfter: null }), true);
// user stamp: only that user's older sessions die; household stamp absent
assert.strictEqual(rev(T - 1, null, { validAfter: T }), true);
assert.strictEqual(rev(T, null, { validAfter: T }), false);
// a user stamp does not touch shared (PIN) sessions — they carry no user
assert.strictEqual(rev(T - 1, null, 'shared'), false);
// user row deleted -> dead regardless of stamps
assert.strictEqual(rev(T + 999, null, null), true);
assert.strictEqual(rev(T + 999, T, null), true);
// household stamp newer than user stamp: the stricter one wins
assert.strictEqual(rev(T, T + 5, { validAfter: T - 5 }), true);
console.log('ok');
