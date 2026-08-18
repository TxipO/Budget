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
// 1. A content gate (looksLikeTransferIntermediary) — MCC 6012 (Monobank's
//    own "financial institutions / quasi-cash" code, exactly what a
//    card-to-card transfer service reports) or a known intermediary name in
//    the description. Without this gate, amount+date alone on two
//    unrelated same-day transactions would be a real false-positive risk
//    given how many transactions this household makes.
// 2. Amount + date alignment on the OTHER bank source, opposite direction,
//    same user, isTransfer:false — see findCrossBankTransferMatch below for
//    the actual tolerance/window.
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

// mcc undefined for every SpareBank item (Enable Banking's SbTransaction has
// no MCC-equivalent field) — the keyword check is the only gate available
// on that side. Extend the keyword list only once a new intermediary is
// actually seen live, same convention as monobank.ts's own keyword lists.
export function looksLikeTransferIntermediary(text: string, mcc?: number): boolean {
  if (mcc === 6012) return true;
  return TRANSFER_INTERMEDIARY_KEYWORDS.test(text);
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
// week" — combined with the content gate above, coincidental false
// positives would need an unrelated transaction to ALSO name a known
// transfer service, which real purchases essentially never do.
const CROSS_BANK_AMOUNT_TOLERANCE = 0.12;

export async function findCrossBankTransferMatch(
  userId: number,
  excludeSource: 'mono' | 'sparebank',
  txType: 'income' | 'expense',
  amount: number,
  date: Date,
): Promise<number | null> {
  const oppositeType = txType === 'income' ? 'expense' : 'income';
  const windowStart = new Date(date.getTime() - CROSS_BANK_WINDOW_DAYS * 24 * 3600 * 1000);
  const windowEnd = new Date(date.getTime() + CROSS_BANK_WINDOW_DAYS * 24 * 3600 * 1000);
  const lo = amount * (1 - CROSS_BANK_AMOUNT_TOLERANCE);
  const hi = amount * (1 + CROSS_BANK_AMOUNT_TOLERANCE);
  const match = await prisma.transaction.findFirst({
    where: {
      userId,
      source: excludeSource === 'mono' ? 'sparebank' : 'mono',
      isTransfer: false,
      amount: { gte: lo, lte: hi },
      date: { gte: windowStart, lte: windowEnd },
      category: { type: oppositeType },
    },
    select: { id: true },
  });
  return match?.id ?? null;
}
