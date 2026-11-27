// Travel mode check against the LOCAL restore of the 2026-11-27 backup.
// Run: npx tsx scripts/check-travel-mode.mts
// Drives the real route handlers (create -> preview -> apply -> totals -> delete) plus the live
// decision path, and asserts every row is restored. Re-runnable: the trip is always deleted.
// Side effect left behind on purpose: the 5 protected categories keep lockedFromModes=true.
import assert from 'node:assert';
import { NextRequest } from 'next/server';
import { prisma } from '../src/lib/prisma';
import { travelOverride, findActiveTripFor } from '../src/lib/travelMode';
import * as tripsRoute from '../src/app/api/trips/route';
import * as tripRoute from '../src/app/api/trips/[id]/route';
import * as previewRoute from '../src/app/api/trips/[id]/preview/route';
import * as applyRoute from '../src/app/api/trips/[id]/apply/route';
import { ingestStatementItem } from '../src/lib/monoIngest';
import { ingestTransaction } from '../src/lib/sparebankIngest';

const HOUSEHOLD = 1;
const LOCKED = ['Медицина', 'Підписки', 'Комунальні', 'Оренда', 'Кредит'];
const headers = { 'x-household-id': String(HOUSEHOLD), 'x-current-user-id': '2', 'x-session-issued-at': String(Date.now()), 'content-type': 'application/json' };
const call = (method: string, url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

const snapshot = async () => new Map((await prisma.transaction.findMany({
  select: { id: true, categoryId: true, categorySource: true, tripId: true, tripPrevCategoryId: true, tripPrevCategorySource: true, isTransfer: true, amount: true },
})).map(r => [r.id, r]));

async function deleteTrips() {
  for (const t of await prisma.trip.findMany({ where: { householdId: HOUSEHOLD, name: 'Варшава' }, select: { id: true } })) {
    await tripRoute.DELETE(call('DELETE', `/api/trips/${t.id}`), ctx(t.id));
  }
}

await deleteTrips(); // leftovers of a crashed earlier run
await prisma.category.updateMany({ where: { householdId: HOUSEHOLD, type: 'expense', name: { in: LOCKED } }, data: { lockedFromModes: true } });
const before = await snapshot();
const cat = async (name: string) => (await prisma.category.findFirstOrThrow({ where: { householdId: HOUSEHOLD, name, type: 'expense' }, select: { id: true } })).id;
let tripId: number | null = null;
const testRowIds: number[] = [];
let handEdited: number | null = null; // simulated hand edit; always put back, even when an assertion fails
// Mono ingest converts UAH -> the household currency via a cached rate; seed the cache so the
// script never reaches for the bank's public feed. Restored in `finally`.
const FX_KEY = 'fxRate:980:578';
const fxBefore = await prisma.appSetting.findUnique({ where: { key: FX_KEY } });
await prisma.appSetting.upsert({ where: { key: FX_KEY }, update: { value: JSON.stringify({ rate: 0.25, fetchedAt: Date.now() }) }, create: { key: FX_KEY, value: JSON.stringify({ rate: 0.25, fetchedAt: Date.now() }) } });

try {
  // --- create ---
  const created = await tripsRoute.POST(call('POST', '/api/trips', { name: 'Варшава', startDate: '2026-11-19', endDate: '2026-11-24', accounts: ['mono:2', 'sb:1'] }));
  assert.strictEqual(created.status, 200);
  tripId = (await created.json()).id as number;
  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
  assert.strictEqual(trip.startDate.toISOString(), '2026-11-19T00:00:00.000Z');
  assert.strictEqual(trip.endDate!.toISOString(), '2026-11-24T00:00:00.000Z');
  // validation: a foreign/unknown account, a bad date, an end before the start
  for (const bad of [{ accounts: ['mono:999'] }, { accounts: [] }, { startDate: '2026-02-30' }, { endDate: '2026-11-01' }]) {
    const r = await tripsRoute.POST(call('POST', '/api/trips', { name: 'x', startDate: '2026-11-19', endDate: '2026-11-24', accounts: ['mono:2'], ...bad }));
    assert.strictEqual(r.status, 400, `rejects ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(await prisma.trip.count({ where: { householdId: HOUSEHOLD } }), 1);

  // --- preview (SC-001) ---
  const pr = await previewRoute.GET(call('GET', `/api/trips/${tripId}/preview`), ctx(tripId));
  const cands: { id: number; date: string; merchant: string; amount: number; currentCategory: { id: number; name: string }; account: string }[] = await pr.json();
  console.table(cands.map(c => ({ id: c.id, date: c.date, merchant: c.merchant.slice(0, 32), amount: c.amount, was: c.currentCategory.name, account: c.account })));
  console.log('candidates:', cands.length);
  assert.ok(cands.length >= 24 && cands.length <= 26, `~25 candidates, got ${cands.length}`);
  const has = (s: string) => cands.some(c => c.merchant.toLowerCase().includes(s));
  for (const s of ['zabka', 'carrefour express', 'toast', 'rossmann', 'ольга м.', 'narvesen 545 gardermoen', 'pana sp. z o.o.']) assert.ok(has(s), `candidate: ${s}`);
  // Known merchants, rules, protected categories, subscriptions, jar top-ups, already-trip rows.
  for (const s of ['coop marked bal', 'joker', 'google', 'spotify', 'sygnir', 'pana comfort', 'pana rtg', 'поповнення', 'freenow', 'vodafone']) assert.ok(!has(s), `not a candidate: ${s}`);
  // those rows really exist in the window (so the exclusions above are not vacuous)
  assert.ok(await prisma.transaction.count({ where: { OR: [{ monoMerchant: { contains: 'PANA COMFORT' } }, { merchantText: { contains: 'JOKER' } }, { merchantText: { contains: 'SYGNIR' } }, { monoMerchant: { contains: 'Поповнення' } }] } }) >= 4);
  // hand-set rows and income/transfer rows are never candidates
  const candIds = new Set(cands.map(c => c.id));
  const nonWeak = await prisma.transaction.findMany({
    where: { id: { in: Array.from(candIds) }, OR: [{ categorySource: { notIn: ['mcc', 'keyword', 'llm', 'fallback', 'self-named'] } }, { categorySource: null }, { isTransfer: true }, { category: { type: { not: 'expense' } } }, { category: { lockedFromModes: true } }] },
    select: { id: true },
  });
  assert.deepStrictEqual(nonWeak, []);
  for (const id of [2724, 2714, 2757]) assert.ok(!candIds.has(id), `manual row ${id} untouched`);
  assert.ok(cands.every(c => c.account === 'Mono · Женя' || c.account === 'SpareBank · Основний'), 'pool account never appears');

  // --- apply ---
  const apply = await applyRoute.POST(call('POST', `/api/trips/${tripId}/apply`, { ids: [...candIds, 2724, 2660, 999999] }), ctx(tripId));
  assert.strictEqual((await apply.json()).count, cands.length, 'ids that do not qualify are ignored');
  const travelId = await cat('Подорожі');
  const mid = await snapshot();
  for (const c of cands) {
    const a = before.get(c.id)!, b = mid.get(c.id)!;
    assert.strictEqual(b.categoryId, travelId); assert.strictEqual(b.categorySource, 'travel'); assert.strictEqual(b.tripId, tripId);
    assert.strictEqual(b.tripPrevCategoryId, a.categoryId); assert.strictEqual(b.tripPrevCategorySource, a.categorySource);
  }
  for (const [id, a] of before) if (!candIds.has(id)) assert.deepStrictEqual(mid.get(id), a, `row ${id} not touched by apply`);
  // second apply is a no-op (the rows are already in the trip category)
  assert.strictEqual((await (await applyRoute.POST(call('POST', `/api/trips/${tripId}/apply`, { ids: [...candIds] }), ctx(tripId))).json()).count, 0);
  const expectedTotal = Math.round(cands.reduce((s, c) => s + c.amount, 0) * 100) / 100;
  const list = await (await tripsRoute.GET(call('GET', '/api/trips'))).json();
  const listed = list.trips.find((t: { id: number }) => t.id === tripId);
  assert.strictEqual(listed.total, expectedTotal); assert.strictEqual(listed.active, false);
  console.log('applied', cands.length, 'rows, total', expectedTotal);
  // Travel rows are not a "known merchant": the same preview now has nothing left to move.
  assert.strictEqual((await (await previewRoute.GET(call('GET', `/api/trips/${tripId}/preview`), ctx(tripId))).json()).length, 0);

  // --- live path: same decision function for a brand-new row ---
  const fallbackId = await cat('Незрозуміло'), foodId = await cat('Їжа'), medId = await cat('Медицина');
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  const live = (o: Partial<Parameters<typeof travelOverride>[0]> = {}) => travelOverride({
    householdId: HOUSEHOLD, account: 'mono:2', bank: 'mono', date: day('2026-11-22'), key: 'sklep nowy warszawa 77',
    guess: { categoryId: fallbackId, source: 'fallback' }, ...o,
  });
  const hit = await live();
  assert.deepStrictEqual(hit, { categoryId: travelId, tripId, prevCategoryId: fallbackId, prevSource: 'fallback' });
  assert.strictEqual(await live({ key: 'joker balestrand', guess: { categoryId: foodId, source: 'keyword' } }), null, 'known merchant');
  assert.strictEqual(await live({ account: 'mono:1' }), null, 'account not in the trip');
  assert.strictEqual(await live({ account: 'sb:2', bank: 'sparebank' }), null, 'pool account not in the trip');
  assert.strictEqual(await live({ guess: { categoryId: foodId, source: 'rule' } }), null, 'rule tier is never overridden');
  assert.strictEqual(await live({ guess: { categoryId: foodId, source: 'history-amount' } }), null);
  assert.strictEqual(await live({ guess: { categoryId: medId, source: 'mcc' } }), null, 'locked category');
  assert.strictEqual(await live({ key: 'поповнення «банка»' }), null, 'jar top-up');
  assert.strictEqual(await live({ key: '' }), null, 'no merchant text');
  assert.strictEqual(await live({ date: day('2026-11-25') }), null, 'mono after the end date');
  assert.strictEqual(await live({ date: day('2026-11-18') }), null, 'before the start date');
  assert.ok(await live({ account: 'sb:1', bank: 'sparebank', date: day('2026-11-27') }), 'sparebank books up to 3 days late');
  assert.strictEqual(await live({ account: 'sb:1', bank: 'sparebank', date: day('2026-11-28') }), null);
  assert.ok(await findActiveTripFor(HOUSEHOLD, 'sb:1', day('2026-11-27'), 'sparebank'));
  assert.strictEqual(await findActiveTripFor(HOUSEHOLD, 'mono:2', day('2026-11-27'), 'mono'), null);
  // --- the real ingest paths, new rows (webhook-shaped Mono item, SpareBank item) ---
  const monoItem = (id: string, description: string, mcc: number) => ({ id, time: Date.UTC(2026, 10, 22, 12) / 1000, description, mcc, amount: -123457, currencyCode: 980 });
  const sbItem = (text: string, amount: string, date: string) => ({ transaction_amount: { amount, currency: 'NOK' }, credit_debit_indicator: 'DBIT', booking_date: date, status: 'BOOK', remittance_information: [text] });
  const rowOf = (where: object) => prisma.transaction.findFirstOrThrow({ where, select: { id: true, categoryId: true, categorySource: true, tripId: true, tripPrevCategoryId: true, tripPrevCategorySource: true } });

  assert.strictEqual(await ingestStatementItem(2, HOUSEHOLD, monoItem('check-travel-1', 'SKLEP NOWY TEST 77', 5411)), 'created');
  const m1 = await rowOf({ monoStatementId: 'check-travel-1' }); testRowIds.push(m1.id);
  assert.deepStrictEqual(m1, { id: m1.id, categoryId: travelId, categorySource: 'travel', tripId, tripPrevCategoryId: foodId, tripPrevCategorySource: 'mcc' });
  assert.strictEqual(await ingestStatementItem(2, HOUSEHOLD, monoItem('check-travel-2', 'Joker Balestrand', 5411)), 'created');
  const m2 = await rowOf({ monoStatementId: 'check-travel-2' }); testRowIds.push(m2.id);
  assert.deepStrictEqual([m2.categorySource, m2.tripId], ['rule', null], 'known merchant keeps its own (learned) category');
  assert.strictEqual(await ingestStatementItem(1, HOUSEHOLD, monoItem('check-travel-3', 'SKLEP NOWY TEST 77', 5411)), 'created');
  const m3 = await rowOf({ monoStatementId: 'check-travel-3' }); testRowIds.push(m3.id);
  assert.deepStrictEqual([m3.categorySource, m3.tripId], ['mcc', null], 'card of a user not in the trip');

  const s1 = await ingestTransaction(2, HOUSEHOLD, sbItem('SKLEP NOWY TEST 77', '91.37', '2026-11-26'), 1, new Map());
  const s2 = await ingestTransaction(2, HOUSEHOLD, sbItem('JOKER BALESTRAN HOLMEN 11 BALESTRAND', '52.11', '2026-11-26'), 1, new Map());
  assert.strictEqual(s1.status, 'created'); assert.strictEqual(s2.status, 'created'); testRowIds.push(s1.id!, s2.id!);
  const r1 = await rowOf({ id: s1.id });
  assert.deepStrictEqual(r1, { id: s1.id, categoryId: travelId, categorySource: 'travel', tripId, tripPrevCategoryId: fallbackId, tripPrevCategorySource: 'fallback' });
  const r2 = await rowOf({ id: s2.id });
  assert.deepStrictEqual([r2.categorySource, r2.tripId], ['keyword', null]);
  // re-delivery of the same booking is a duplicate and leaves the travel row alone
  assert.strictEqual((await ingestTransaction(2, HOUSEHOLD, sbItem('SKLEP NOWY TEST 77', '91.37', '2026-11-26'), 1, new Map())).status, 'skipped_duplicate');
  assert.strictEqual((await rowOf({ id: s1.id })).categorySource, 'travel');

  // open-ended trip ("поки не вимкну") + "Завершити"
  await prisma.trip.update({ where: { id: tripId }, data: { endDate: null } });
  assert.ok(await live({ date: day('2026-12-30') }), 'open trip has no end');
  const fin = await tripRoute.PATCH(call('PATCH', `/api/trips/${tripId}`, { endDate: '2026-11-24' }), ctx(tripId));
  assert.strictEqual((await fin.json()).endDate, '2026-11-24');

  // --- a hand edit after apply survives the trip's deletion (FR-003) ---
  handEdited = cands[0].id;
  await prisma.transaction.update({ where: { id: handEdited }, data: { categoryId: foodId, categorySource: 'manual' } });
  const stillTravel = await prisma.transaction.count({ where: { tripId, categorySource: 'travel' } });

  // --- delete restores (SC-002) ---
  const del = await tripRoute.DELETE(call('DELETE', `/api/trips/${tripId}`), ctx(tripId));
  assert.strictEqual((await del.json()).restored, stillTravel);
  tripId = null;
  const after = await snapshot();
  for (const [id, a] of before) {
    if (id === handEdited) { assert.strictEqual(after.get(id)!.categorySource, 'manual'); assert.strictEqual(after.get(id)!.tripId, null); continue; }
    assert.deepStrictEqual(after.get(id), a, `row ${id} restored`);
  }
  // rows created by the ingest checks above go back to what the guess had said
  assert.deepStrictEqual(await rowOf({ id: testRowIds[0] }), { id: testRowIds[0], categoryId: foodId, categorySource: 'mcc', tripId: null, tripPrevCategoryId: null, tripPrevCategorySource: null });
  assert.deepStrictEqual(await rowOf({ id: testRowIds[3] }), { id: testRowIds[3], categoryId: fallbackId, categorySource: 'fallback', tripId: null, tripPrevCategoryId: null, tripPrevCategorySource: null });
  await prisma.transaction.deleteMany({ where: { id: { in: testRowIds } } });
  testRowIds.length = 0;
  assert.strictEqual((await snapshot()).size, before.size);
  assert.strictEqual(await prisma.trip.count({ where: { householdId: HOUSEHOLD, name: 'Варшава' } }), 0);
  console.log('OK');
} finally {
  if (handEdited !== null) await prisma.transaction.update({ where: { id: handEdited }, data: { categoryId: before.get(handEdited)!.categoryId, categorySource: before.get(handEdited)!.categorySource } });
  if (testRowIds.length) await prisma.transaction.deleteMany({ where: { id: { in: testRowIds } } });
  if (fxBefore) await prisma.appSetting.update({ where: { key: FX_KEY }, data: { value: fxBefore.value } });
  else await prisma.appSetting.deleteMany({ where: { key: FX_KEY } });
  if (tripId !== null) await tripRoute.DELETE(call('DELETE', `/api/trips/${tripId}`), ctx(tripId));
  await prisma.$disconnect();
}
