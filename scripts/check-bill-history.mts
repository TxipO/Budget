// Pure-logic check for lib/billHistory.ts. Run: node scripts/check-bill-history.mts
import assert from 'node:assert';
import { betaltDate, isGenericBankText, normalizeAccount, pickBillHistoryCategory, type BillPrior } from '../src/lib/billHistory.ts';

const TXT = 'Mobilgiro m/KID, forfall i dag';
const now = new Date('2026-11-12T00:00:00Z');
const d = (s: string) => new Date(`${s}T00:00:00Z`);

// generic-text detector
assert.ok(isGenericBankText('', TXT));
assert.ok(isGenericBankText('', 'Avtalegiro'));
assert.ok(!isGenericBankText('Sygnir AS', TXT), 'a payee name means not generic');
assert.ok(!isGenericBankText('', 'Kiwi 123 Bergen'), 'plain named merchant');
assert.ok(!isGenericBankText('', '7080004414716 JOKER BALES'), 'named card merchant stays non-generic even if hand-corrected once (2026-11 live)');
assert.ok(!isGenericBankText('', '  '));
// even with priors under 2 categories, a named merchant never takes the history tier
assert.strictEqual(pickBillHistoryCategory({ counterparty: '', merchantText: '7080004414716 JOKER BALES', account: null, amount: 89, now: new Date('2026-11-12T00:00:00Z'), priors: [
  { categoryId: 1, amount: 89, date: new Date('2026-11-01T00:00:00Z'), account: null },
  { categoryId: 2, amount: 89, date: new Date('2026-11-05T00:00:00Z'), account: null },
] }), null);

// Betalt: dd.mm.yy -> ISO date (weekday placeholder re-book match)
assert.strictEqual(betaltDate('Nettgiro til: 3705.68.62367 Betalt: 09.11.26'), '2026-11-09');
assert.strictEqual(betaltDate('Betalt:06.11.26'), '2026-11-06');
assert.strictEqual(betaltDate('Overførsel mellom egne konti i Mobilbank, forfall i dag'), null);
assert.strictEqual(betaltDate('Betalt: 9.11.26'), null);
assert.strictEqual(betaltDate(''), null);

// account normaliser
assert.strictEqual(normalizeAccount({ iban: 'no93 8601 1117 947' }), 'NO9386011117947');
assert.strictEqual(normalizeAccount({ iban: null, other: { identification: '1234.56.78901' } }), '1234.56.78901');
assert.strictEqual(normalizeAccount({}), null);
assert.strictEqual(normalizeAccount(null), null);

const priors: BillPrior[] = [
  { categoryId: 10, amount: 8890, date: d('2026-10-12'), account: null },       // rent, manual
  { categoryId: 20, amount: 1463.46, date: d('2026-10-12'), account: 'ACC-U' }, // utilities
  { categoryId: 30, amount: 1463.2, date: d('2026-09-12'), account: 'ACC-U' },  // older, same account
];
const pick = (amount: number, account: string | null, p = priors, counterparty = '', text = TXT) =>
  pickBillHistoryCategory({ counterparty, merchantText: text, account, amount, now, priors: p });

assert.deepStrictEqual(pick(8890, null), { categoryId: 10, source: 'history-amount' });
assert.deepStrictEqual(pick(8890.4, null), { categoryId: 10, source: 'history-amount' });   // within +-0.5
assert.strictEqual(pick(8891, null), null);                                                  // outside tolerance
assert.deepStrictEqual(pick(1676.11, 'ACC-U'), { categoryId: 20, source: 'history-account' }); // account wins, most recent
assert.deepStrictEqual(pick(8890, 'ACC-U'), { categoryId: 20, source: 'history-account' });  // account beats amount
assert.deepStrictEqual(pick(8890, 'ACC-OTHER'), { categoryId: 10, source: 'history-amount' }); // unknown account -> amount
assert.strictEqual(pick(166.38, null), null);                                                // nothing matches -> fall through
assert.strictEqual(pick(8890, null, priors, 'Landlord AS'), null);                           // has a name -> not our job
assert.strictEqual(pick(8890, null, [{ ...priors[0], date: d('2026-05-01') }]), null);       // amount evidence older than 120 days
assert.deepStrictEqual(pick(8890, 'ACC-X', [{ ...priors[0], date: d('2025-12-01'), account: 'ACC-X' }]), { categoryId: 10, source: 'history-account' }); // account has no age cap
console.log('ok');
