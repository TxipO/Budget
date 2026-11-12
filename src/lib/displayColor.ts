// Saturated, mutually distinct hues for categories whose stored colour is a
// grey/slate (or too dark to read on the dark ground). Display only — the
// stored colour is never changed. Picked by category id so the same category
// keeps the same hue in the donut, the plan bars and the transaction chips.
const VIVID = ['#F97316', '#8B7CF6', '#38BDF8', '#F472B6', '#FBBF24', '#2DD4BF', '#A3E635', '#FB7185'];

// The uncategorised fallback (categoryGuess.ts) must stay grey, not get a hue.
const FALLBACK_NAME = 'незрозуміло';

export function displayColor(hex: string | null | undefined, seed: number, name?: string): string {
  if (name?.trim().toLowerCase() === FALLBACK_NAME) return '#6B7280';
  const fallback = VIVID[Math.abs(seed) % VIVID.length];
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 510;
  const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  return s < 0.3 || l < 0.25 ? fallback : '#' + m[1].toUpperCase();
}
