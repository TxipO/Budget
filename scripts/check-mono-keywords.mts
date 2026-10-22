// Quick check for the 'bet' keyword anchoring in guessCategoryByKeyword. Run: npx tsx scripts/check-mono-keywords.ts
import assert from 'node:assert';
import { guessCategoryByKeyword } from '../src/lib/monobank';

for (const t of ['betaling', 'abetong', 'alphabet', 'Betaling kort']) assert.notStrictEqual(guessCategoryByKeyword(t), 'Залежності', t);
for (const t of ['bet365', 'bet ', 'BET', 'Parimatch', 'казино Вулкан', 'bet-at-home']) assert.strictEqual(guessCategoryByKeyword(t), 'Залежності', t);
console.log('ok');
