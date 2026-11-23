import { merchantKey } from './merchantKey';

// Pure matcher: which stored hold-intent belongs to a just-settled statement
// item. Monobank is not guaranteed to keep a hold's statement id when it
// settles, so: id first, then merchant + amount + time.
export interface IntentLike { holdId: string; merchantText: string; amount: number; holdTime: Date }
export interface SettledLike { id: string; description: string; amount: number; time: Date }

export const MONO_TOLERANCE = 0.01; // hold and settle are FX-converted at different moments
// SpareBank: a PLN/EUR card purchase is reserved in NOK at one rate and booked at another.
export const SB_TOLERANCE = 0.03;
const SETTLE_WINDOW_MS = 10 * 24 * 3600 * 1000;
const EARLY_SLACK_MS = 3600 * 1000;

const sameText = (a: string, b: string) => {
  const ka = merchantKey(a), kb = merchantKey(b);
  return ka !== '' ? ka === kb : a.trim().toLowerCase() === b.trim().toLowerCase();
};

export function matchIntent<T extends IntentLike>(intents: T[], s: SettledLike, tolerance = MONO_TOLERANCE): T | null {
  const byId = intents.find(i => i.holdId === s.id);
  if (byId) return byId;
  const cands = intents.filter(i => {
    const dt = s.time.getTime() - i.holdTime.getTime();
    return sameText(i.merchantText, s.description)
      && Math.abs(i.amount - s.amount) <= tolerance * Math.max(i.amount, s.amount)
      && dt >= -EARLY_SLACK_MS && dt <= SETTLE_WINDOW_MS;
  });
  cands.sort((a, b) => Math.abs(a.amount - s.amount) - Math.abs(b.amount - s.amount)
    || Math.abs(s.time.getTime() - a.holdTime.getTime()) - Math.abs(s.time.getTime() - b.holdTime.getTime()));
  return cands[0] ?? null;
}
