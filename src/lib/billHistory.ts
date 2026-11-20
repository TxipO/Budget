// Nameless bill payments ("Mobilgiro m/KID, forfall i dag": no creditor name, the
// same text for rent and utilities alike) can't be categorised from their text.
// The only evidence is how the household filed the SAME text before — keyed by
// the payee's account when the bank sends it, else by amount (rent is fixed).
// Pure on purpose (no imports): testable without DB; the query lives in
// sparebankIngest.ts. Hand-set ('manual') rows count as evidence — that is the point.

export const AMOUNT_TOLERANCE = 0.5;
export const AMOUNT_WINDOW_DAYS = 120;
const DAY_MS = 86_400_000;

// Norwegian payment-instruction phrases that name a KIND of payment, not a payee.
const PAYMENT_INSTRUCTION = /mobilgiro|avtalegiro|efaktura|m\/kid|forfall i dag/i;

export interface BillPrior { categoryId: number; amount: number; date: Date; account: string | null }

// IBAN, else BBAN (other.identification); uppercase, no spaces.
export function normalizeAccount(a: { iban?: string | null; other?: { identification?: string | null } | null } | null | undefined): string | null {
  const raw = a?.iban || a?.other?.identification;
  const s = raw ? raw.replace(/\s+/g, '').toUpperCase() : '';
  return s || null;
}

// Generic = no payee name AND an explicit payment-instruction phrase. (A "same text
// already under >=2 categories" trigger was removed 2026-11: one hand correction made
// ordinary named card merchants look generic, so amount-history overrode MCC/LLM.)
export function isGenericBankText(counterparty: string, merchantText: string): boolean {
  if (counterparty.trim() || !merchantText.trim()) return false;
  return PAYMENT_INSTRUCTION.test(merchantText);
}

// "Nettgiro til: 3705.68.62367 Betalt: 09.11.26" -> '2026-11-09': the date the payer
// actually initiated the payment, which the bank's booking date may trail by days.
export function betaltDate(text: string): string | null {
  const m = text.match(/Betalt:\s*(\d{2})\.(\d{2})\.(\d{2})\b/i);
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

// priors = this household's earlier rows with the same merchantText, already
// filtered to a real category (not the fallback, not a transfer).
export function pickBillHistoryCategory(a: {
  counterparty: string; merchantText: string; account: string | null; amount: number; now: Date; priors: BillPrior[];
}): { categoryId: number; source: 'history-account' | 'history-amount' } | null {
  if (!isGenericBankText(a.counterparty, a.merchantText)) return null;
  const latest = (rows: BillPrior[]) => rows.reduce<BillPrior | null>((best, p) => (!best || p.date > best.date ? p : best), null);
  const byAccount = a.account ? latest(a.priors.filter(p => p.account === a.account)) : null;
  if (byAccount) return { categoryId: byAccount.categoryId, source: 'history-account' };
  const since = a.now.getTime() - AMOUNT_WINDOW_DAYS * DAY_MS;
  const byAmount = latest(a.priors.filter(p => p.date.getTime() >= since && Math.abs(p.amount - a.amount) <= AMOUNT_TOLERANCE));
  return byAmount ? { categoryId: byAmount.categoryId, source: 'history-amount' } : null;
}
