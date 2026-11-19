// Pure-logic check for lib/holdMatch.ts. Run: npx tsx scripts/check-hold-match.mts
import assert from 'node:assert';
import { matchIntent, type IntentLike } from '../src/lib/holdMatch';

const H = new Date('2026-11-18T10:00:00Z');
const h = (days: number) => new Date(H.getTime() + days * 86400000);
const mk = (holdId: string, merchantText: string, amount: number, holdTime = H): IntentLike => ({ holdId, merchantText, amount, holdTime });
const settled = (id: string, description: string, amount: number, time: Date) => ({ id, description, amount, time });

const a = mk('h1', 'Balestrand Ho', 508);
const b = mk('h2', 'Steam', 120);

// same id wins even if everything else differs
assert.strictEqual(matchIntent([a, b], settled('h2', 'Anything', 1, h(30))), b);
// new id: merchant + amount + time
assert.strictEqual(matchIntent([a, b], settled('x', 'Balestrand Ho', 508, h(1))), a);
assert.strictEqual(matchIntent([a, b], settled('x', 'BALESTRAND  HO', 508, h(1))), a, 'normalised text');
assert.strictEqual(matchIntent([a, b], settled('x', 'Balestrand Ho', 512, h(1))), a, 'within 1%');
assert.strictEqual(matchIntent([a, b], settled('x', 'Balestrand Ho', 520, h(1))), null, 'beyond 1%');
assert.strictEqual(matchIntent([a, b], settled('x', 'Joker Balestrand', 508, h(1))), null, 'other merchant');
assert.strictEqual(matchIntent([a, b], settled('x', 'Balestrand Ho', 508, h(11))), null, 'settled after 10 days');
assert.strictEqual(matchIntent([a, b], settled('x', 'Balestrand Ho', 508, h(10))), a, 'exactly 10 days');
assert.strictEqual(matchIntent([a, b], settled('x', 'Balestrand Ho', 508, h(-1))), null, 'before the hold');
// two holds of the same merchant: closest amount wins
const a2 = mk('h3', 'Balestrand Ho', 500);
assert.strictEqual(matchIntent([a, a2], settled('x', 'Balestrand Ho', 501, h(1))), a2);
// empty key (text is only noise) falls back to raw equality, never matches everything
assert.strictEqual(matchIntent([mk('h4', '12345678', 50)], settled('x', '87654321', 50, h(1))), null);
assert.strictEqual(matchIntent([], settled('x', 'Steam', 1, h(1))), null);
console.log('check-hold-match: ok');
