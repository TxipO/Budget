// Run: npx tsx scripts/check-mono-rate.mts  (fetch is mocked; no network)
import assert from 'node:assert';
import { getExchangeRate } from '../src/lib/monobank.ts';

const feed = (rates: object[]) => { (globalThis as any).fetch = async () => ({ ok: true, json: async () => rates }); };
const UAH = 980, NOK = 578, USD = 840;

feed([{ currencyCodeA: NOK, currencyCodeB: UAH, rateCross: 0, rateBuy: 4.1, rateSell: 4.3 }]);
assert.strictEqual(await getExchangeRate(NOK, UAH), 4.1, 'a 0 rateCross falls through to rateBuy');
feed([{ currencyCodeA: NOK, currencyCodeB: UAH, rateCross: 0 }]);
assert.strictEqual(await getExchangeRate(NOK, UAH), null, 'only a 0 rate = no rate');
feed([{ currencyCodeA: NOK, currencyCodeB: UAH, rateCross: -1, rateBuy: NaN }]);
assert.strictEqual(await getExchangeRate(NOK, UAH), null, 'negative / NaN = no rate');
feed([{ currencyCodeA: NOK, currencyCodeB: UAH, rateCross: 4 }]);
assert.strictEqual(await getExchangeRate(UAH, NOK), 0.25, 'inverse pair');
feed([{ currencyCodeA: NOK, currencyCodeB: UAH, rateCross: 4 }, { currencyCodeA: USD, currencyCodeB: UAH, rateBuy: 0, rateSell: 40 }]);
assert.strictEqual(await getExchangeRate(USD, NOK), 10, 'triangulation via UAH skips a 0 rateBuy');
console.log('ok');
