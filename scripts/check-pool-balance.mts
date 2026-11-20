// Run: npx tsx scripts/check-pool-balance.mts
import assert from 'node:assert';
import { poolBalance } from '../src/lib/savingsBreakdown.ts';

const cat = { name: 'Подушка', color: '#000', icon: 'x', type: 'savings' };
const row = (amount: number, savingsWithdrawal = false, isTransfer = false, c = cat) => ({ categoryId: 1, amount, savingsWithdrawal, isTransfer, category: c });

assert.strictEqual(poolBalance([]), 0);
assert.strictEqual(poolBalance([row(1000), row(500, true)]), 500, 'deposit minus withdrawal');
assert.strictEqual(poolBalance([row(1000), row(250, false, true)]), 1000, 'excluded transfer leg is not counted');
assert.strictEqual(poolBalance([row(1000), row(99, false, false, { ...cat, type: 'expense' })]), 1000, 'non-savings category ignored');
assert.strictEqual(poolBalance([row(0.1), row(0.2)]), 0.3, 'float noise rounded');
// the 2026-11-10 live case: a withdrawal counted twice (placeholder + booked copy) leaves the app 250 under the bank
assert.strictEqual(10000 - poolBalance([row(10250), row(250, true)]), 0);
assert.strictEqual(10000 - poolBalance([row(10250), row(250, true), row(250, true)]), 250);
console.log('ok');
