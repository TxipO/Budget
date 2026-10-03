import { prisma } from '@/lib/prisma';

// Cross-BANK same-person transfer detection — a third variant alongside
// SpareBank's own-account matching (findTransferCounterpartAccountId in
// sparebankIngest.ts) and Monobank's inter-person matching
// (findMonoTransferMatch in monoIngest.ts). Neither of those can see this
// case: both are scoped to ONE bank's own accounts. This one is for the
// household's real pattern of moving money from a Norwegian SpareBank
// account to a Ukrainian Monobank account via a card-to-card intermediary
// (confirmed live 2026-08-16/17: Paysend) — the intermediary settles as an
// ordinary-looking card payment on the SpareBank side and an ordinary-
// looking incoming transfer on the Monobank side, with NO shared account
// id, reference, or counterparty name to match on structurally the way the
// other two mechanisms do.
//
// Two signals stand in for that missing structural link, and BOTH are
// required before this ever fires:
// 1. A content gate on EACH leg (2026-10 tightening — it used to be checked
//    only on whichever leg happened to be ingesting, so the other leg could
//    be ANY row of a similar amount; real near-miss: an Airbnb booking #1040
//    (1380 kr) sat inside the window of the Paysend pair #1029/#1023):
//    - SpareBank leg: a known intermediary keyword (Paysend/Wise/...) in its
//      text. Enable Banking has no MCC, so the keyword is the only signal.
//    - Monobank leg: MCC 6012 (card-to-card / quasi-cash) AND either an
//      intermediary keyword or a sender name that is the user's OWN name.
//      MCC 6012 alone is NOT enough: 22 of the household's mono rows carry it
//      and all but the user's own top-ups are ordinary "Від: <stranger>" P2P.
//      "Own name" is LEARNED, not compared with User.name: the app's
//      User.name is a Cyrillic nickname ("Женя") while the bank prints the
//      legal Latin name ("Від: Romanenko, Yevheniia"), so no string rule can
//      relate them. Instead a sender counts as the user's own once ANY of
//      this user's MCC-6012 mono rows from that exact sender is already an
//      isTransfer row (a prior matched pair or a hand flag) — see
//      ownMonoSenders. The very first top-up of a brand-new user therefore
//      needs a keyword or a hand flag; every later one matches by itself.
// 2. Amount + date alignment on the OTHER bank source, opposite direction,
//    same user, isTransfer:false, never a hand-edited ('manual') row — see
//    findCrossBankTransferMatch below. Among several qualifying rows the
//    choice is deterministic: closest amount ratio, then closest date, then
//    lowest id (it used to be an unordered findFirst).
//
// Deliberately does NOT touch either side's category when it fires — unlike
// the other two mechanisms, which reclassify both legs into a shared
// "Переказ між рахунками"/pool category. Here, each side already resolved
// to its own meaningful label (the receiving side to the household member's
// own personal-income category via categoryGuess.ts's self-named-category
// tier, the sending side to whatever the user taught, e.g. "Враховано
// деінде" — literally "accounted for elsewhere", the exact category the
// user built by hand for this before this detector existed). Overwriting
// either would fight the user's own correction instead of completing it —
// the only thing actually missing was isTransfer:true, which is what kept
// "Враховано деінде" from doing what its name already promised.
const TRANSFER_INTERMEDIARY_KEYWORDS = /paysend|\bwise\b|transferwise|revolut|western union|moneygram|payoneer|transfergo/i;

// Prisma's `not: 'manual'` silently drops NULL categorySource rows too (SQL
// three-valued logic), so "anything but manual" has to spell the NULL out.
// Every automatic writer must exclude a hand-edited row from the rows it may
// flip or rewrite — AND it into the where: `AND: [NOT_MANUAL]`.
export const NOT_MANUAL = { OR: [{ categorySource: null }, { categorySource: { not: 'manual' } }] };

export function hasIntermediaryKeyword(text: string): boolean {
  return TRANSFER_INTERMEDIARY_KEYWORDS.test(text);
}

// SpareBank-leg gate (see header). Kept under its old name for the ingest
// call site; there is no MCC parameter any more — the MCC rule is a
// mono-only concept and lives in looksLikeMonoTransferLeg.
export function looksLikeTransferIntermediary(text: string): boolean {
  return hasIntermediaryKeyword(text);
}

const normSender = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Senders (normalized monoMerchant) that are provably this user's OWN name —
// see the header. Reads only isTransfer rows, so a not-yet-paired candidate
// can never vouch for itself.
async function ownMonoSenders(userId: number): Promise<Set<string>> {
  const rows = await prisma.transaction.findMany({
    where: { userId, source: 'mono', monoMcc: 6012, isTransfer: true, monoMerchant: { not: null } },
    select: { monoMerchant: true },
  });
  return new Set(rows.map(r => normSender(r.monoMerchant)));
}

// Monobank-leg gate for the row currently being ingested (see header).
export async function looksLikeMonoTransferLeg(userId: number, description: string, mcc?: number): Promise<boolean> {
  if (mcc !== 6012) return false;
  if (hasIntermediaryKeyword(description)) return true;
  return (await ownMonoSenders(userId)).has(normSender(description));
}

// Wider than either in-bank mechanism's window (2-3 days) — this crosses two
// real national banking systems plus an intermediary's own processing, not
// just one bank's internal settlement lag. Confirmed live: the Paysend pair
// landed one calendar day apart (16.08 SpareBank debit, 17.08... — actually
// the reverse, 16.08 Monobank credit / 17.08 SpareBank debit — order isn't
// guaranteed either direction, hence a symmetric window).
const CROSS_BANK_WINDOW_DAYS = 5;

// Unlike the in-bank mechanisms (exact-amount match, since both legs are the
// literal same currency movement inside one bank), an intermediary applies
// its OWN FX spread/fee — the two legs are never expected to match exactly.
// Confirmed live: 1650 kr out (SpareBank) vs 1585.56 kr in (Monobank, itself
// already converted from the 7549.63 UAH Monobank actually received) — a
// ~4% gap. 12% leaves real margin above that for a worse-priced transfer
// (fixed fees bite harder on smaller amounts) while still requiring a
// genuine order-of-magnitude match, not just "some income happened that
// week" — combined with the per-leg content gates above, coincidental false
// positives would need an unrelated transaction to ALSO carry the signals.
const CROSS_BANK_AMOUNT_TOLERANCE = 0.12;

const DAY_MS = 24 * 3600 * 1000;

// ingestSource = the leg being ingested NOW (already passed its own gate in
// the caller); the partner is on the other bank and must pass THAT bank's
// gate here.
export async function findCrossBankTransferMatch(
  userId: number,
  ingestSource: 'mono' | 'sparebank',
  txType: 'income' | 'expense',
  amount: number,
  date: Date,
): Promise<number | null> {
  const oppositeType = txType === 'income' ? 'expense' : 'income';
  const partnerIsMono = ingestSource === 'sparebank';
  const candidates = await prisma.transaction.findMany({
    where: {
      userId,
      source: partnerIsMono ? 'mono' : 'sparebank',
      ...(partnerIsMono ? { monoMcc: 6012 } : {}),
      isTransfer: false,
      AND: [NOT_MANUAL],
      amount: { gte: amount * (1 - CROSS_BANK_AMOUNT_TOLERANCE), lte: amount * (1 + CROSS_BANK_AMOUNT_TOLERANCE) },
      date: { gte: new Date(date.getTime() - CROSS_BANK_WINDOW_DAYS * DAY_MS), lte: new Date(date.getTime() + CROSS_BANK_WINDOW_DAYS * DAY_MS) },
      category: { type: oppositeType },
    },
    select: { id: true, amount: true, date: true, details: true, monoMerchant: true, sbCounterparty: true },
  });
  if (candidates.length === 0) return null;
  const own = partnerIsMono ? await ownMonoSenders(userId) : null;
  const qualifying = candidates.filter(c => partnerIsMono
    ? hasIntermediaryKeyword(`${c.monoMerchant ?? ''} ${c.details}`) || own!.has(normSender(c.monoMerchant))
    : hasIntermediaryKeyword(`${c.details} ${c.sbCounterparty ?? ''}`));
  if (qualifying.length === 0) return null;
  const ratio = (c: { amount: number }) => Math.abs(Math.log(c.amount / amount));
  qualifying.sort((a, b) => ratio(a) - ratio(b)
    || Math.abs(a.date.getTime() - date.getTime()) - Math.abs(b.date.getTime() - date.getTime())
    || a.id - b.id);
  return qualifying[0].id;
}

// Fourth variant, same family as the two above — a same-BANK, same-person
// internal transfer whose account numbers never arrive at all. Confirmed
// live 2026-09-05/2026-09-15: a 5 kr Женя pair
// (findTransferCounterpartAccountId's own structural match, in
// sparebankIngest.ts) sat with creditor_account/debtor_account both empty
// for 10+ days — past RECONCILIATION_OVERLAP_DAYS, past every future
// re-fetch window, so unlike the "enriches later" case that fix already
// handles, this one was never going to resolve on its own. SpareBank 1 does
// give ONE piece of structural information even then, in plain Norwegian
// text: "Overførsel mellom egne konti i Mobilbank, forfall i dag" ("transfer
// between own accounts in Mobile bank, due today") — this project's own
// prior fix for cross-bank transfers already treats exactly this shape of
// signal (a content gate standing in for a missing account-number link) as
// good enough to act on; account-number matching being unavailable here
// too is not a reason to hold this case to a stricter standard than that
// one already meets.
const SAME_BANK_TRANSFER_PLACEHOLDER = /overførsel mellom egne konti/i;

export function looksLikeUnresolvedInternalTransfer(text: string): boolean {
  return SAME_BANK_TRANSFER_PLACEHOLDER.test(text);
}

// Same window as sparebankIngest.ts's own MIRROR_WINDOW_DAYS (same-bank
// settlement lag), not CROSS_BANK_WINDOW_DAYS's wider tolerance — this never
// leaves SpareBank 1's own rails. Amount matches EXACTLY (no FX tolerance
// band like the cross-bank case): the only reason this match is needed at
// all is a missing account number, not a currency conversion or fee.
//
// Deliberately does NOT filter by opposite category.type the way
// findCrossBankTransferMatch does — the whole reason this pair is stuck is
// that at least one leg may already carry a category the CRDT/DBIT
// direction wouldn't predict (confirmed live: one leg partially resolved
// through the pool-mapping branch before account resolution regressed,
// landing it under a "savings"-typed category despite being an
// "expense"-shaped debit). The placeholder text match IS the safety gate
// here — a rare, bank-generated, transfer-specific string, not a word that
// could appear on an unrelated real purchase.
const SAME_BANK_TRANSFER_WINDOW_DAYS = 3;

export interface UnresolvedInternalMatch {
  siblingId: number;
  // Which legs to flip to isTransfer. Never both when one of them is the
  // counted savings-pool leg (2026-10, found live on the 5 kr pair #992/#994:
  // flipping BOTH made a real pool withdrawal vanish). A pair must end with
  // exactly one counted pool leg, the same shape the account-resolved path
  // (findSavingsTransferMirror) produces.
  flipSelf: boolean;
  flipSibling: boolean;
}

// selfCategoryId: the category the row being ingested resolved to — decides
// whether IT is the counted pool leg. A "pool leg" is a row filed under a
// category some SparebankAccount of this user is mapped to
// (SparebankAccount.categoryId), the same explicit fact the account-resolved
// path uses. Never matches a 'manual' sibling.
export async function findUnresolvedInternalTransferMatch(
  userId: number,
  amount: number,
  date: Date,
  selfCategoryId: number,
  excludeId?: number,
): Promise<UnresolvedInternalMatch | null> {
  const windowStart = new Date(date.getTime() - SAME_BANK_TRANSFER_WINDOW_DAYS * DAY_MS);
  const windowEnd = new Date(date.getTime() + SAME_BANK_TRANSFER_WINDOW_DAYS * DAY_MS);
  const candidates = await prisma.transaction.findMany({
    where: {
      userId,
      source: 'sparebank',
      isTransfer: false,
      AND: [NOT_MANUAL],
      amount,
      date: { gte: windowStart, lte: windowEnd },
      details: { contains: 'Overførsel mellom egne konti', mode: 'insensitive' },
      ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, date: true, categoryId: true },
  });
  if (candidates.length === 0) return null;
  // Deterministic: closest date, then lowest id (was an unordered findFirst).
  candidates.sort((a, b) => Math.abs(a.date.getTime() - date.getTime()) - Math.abs(b.date.getTime() - date.getTime()) || a.id - b.id);
  const sibling = candidates[0];

  const poolRows = await prisma.sparebankAccount.findMany({ where: { userId, categoryId: { not: null } }, select: { categoryId: true } });
  const poolIds = new Set(poolRows.map(r => r.categoryId));
  const siblingIsPool = poolIds.has(sibling.categoryId);
  const selfIsPool = poolIds.has(selfCategoryId);
  // The pool leg stays counted. Both in a pool (odd setup): the already-
  // stored sibling stays counted, the later leg is the excluded one — same
  // "second leg to sync is excluded" rule as the account-resolved path.
  return {
    siblingId: sibling.id,
    flipSelf: !(selfIsPool && !siblingIsPool),
    flipSibling: !siblingIsPool,
  };
}
