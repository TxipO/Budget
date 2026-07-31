import { createSign, createHmac } from 'crypto';
import { safeEqual } from '@/lib/pin';

// Enable Banking API client (PSD2/Berlin Group AISP) — the SpareBank 1
// equivalent of lib/monobank.ts. Unlike Monobank's simple bearer token, every
// request here is authorized with a short-lived JWT we sign ourselves using
// the app's own RSA private key (registered once in Enable Banking's control
// panel; never a per-user secret). See ENABLE_BANKING_APP_ID/
// ENABLE_BANKING_PRIVATE_KEY_B64 in .env.
const BASE = 'https://api.enablebanking.com';
const JWT_TTL_SEC = 300; // short-lived — signed fresh per request batch, not cached

// v1 supports exactly one bank — confirmed live via GET /aspsps (see
// scratch verification) that this is the exact registered name Enable
// Banking expects, not a guessed/slugified value.
export const SPAREBANK1_SOGN_OG_FJORDANE = { name: 'SpareBank 1 Sogn og Fjordane', country: 'NO' };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function getPrivateKeyPem(): string {
  const b64 = process.env.ENABLE_BANKING_PRIVATE_KEY_B64;
  if (!b64) throw new Error('ENABLE_BANKING_PRIVATE_KEY_B64 is not set');
  return Buffer.from(b64, 'base64').toString('utf8');
}

function getAppId(): string {
  const id = process.env.ENABLE_BANKING_APP_ID;
  if (!id) throw new Error('ENABLE_BANKING_APP_ID is not set');
  return id;
}

// Hand-rolled RS256 JWT — same "no extra dependency for a simple, well-defined
// crypto primitive" convention as lib/magicLink.ts's HMAC signing. A JWT is
// just base64url(header) + "." + base64url(payload), RSA-SHA256-signed.
function signJwt(): string {
  const appId = getAppId();
  const header = { typ: 'JWT', alg: 'RS256', kid: appId };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + JWT_TTL_SEC };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(getPrivateKeyPem());
  return `${signingInput}.${base64url(signature)}`;
}

export class EnableBankingError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${signJwt()}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 429) {
    // Two different things can produce a 429 here, worth telling apart:
    // Enable Banking's own gateway throttling OUR app's credentials
    // (error_name absent or something else), vs the ASPSP's own backend
    // throttling THIS specific account's data (error === 'ASPSP_RATE_LIMIT_EXCEEDED').
    // Confirmed live 2026-07-22: GET /aspsps (Enable Banking's own catalog)
    // returned 200 while GET /accounts/{uid}/transactions returned 429 with
    // error_name "RateLimitException" for the exact same request — proving
    // it was SpareBank 1's backend, not Enable Banking's gateway, and likely
    // a longer/bank-specific cooldown than a generic API rate limit.
    const body = await res.json().catch(() => null);
    if (body?.error === 'ASPSP_RATE_LIMIT_EXCEEDED') {
      throw new EnableBankingError('Банк тимчасово обмежив запити до цього рахунку — спробуйте синхронізувати пізніше (може знадобитись більше часу, ніж звичайний ліміт)', 429);
    }
    throw new EnableBankingError('Забагато запитів до Enable Banking — спробуйте пізніше', 429);
  }
  if (!res.ok) throw new EnableBankingError(`Enable Banking API помилка: ${res.status}`, res.status);
  return res.json();
}

export interface Aspsp {
  name: string;
  country: string;
}

// Country-filtered ASPSP (bank) catalog — used once, live, to find the exact
// `name` string Enable Banking expects for SpareBank 1 Sogn og Fjordane
// (their catalog uses each bank's own registered legal name, not a slug —
// never hardcode a guessed value here).
export async function listAspsps(country: string): Promise<Aspsp[]> {
  const data = await call(`/aspsps?country=${encodeURIComponent(country)}`);
  return data.aspsps ?? [];
}

export interface StartAuthResult {
  url: string;
  authorization_id: string;
}

// Kicks off the OAuth-style consent flow — the returned `url` is where the
// browser must be redirected so the PSU (account holder) authenticates
// directly with their bank (BankID etc.); we never see their bank
// credentials. `state` round-trips through the bank's redirect back to our
// callback, HMAC-signed by the caller (see api/sparebank/connect) so the
// callback can trust which user/household initiated this — Enable Banking
// itself doesn't validate `state`, it's opaque to them. psuIpAddress is
// required specifically by SpareBank 1 Sogn og Fjordane (confirmed live via
// GET /aspsps — its `required_psu_headers` lists "psu-ip-address"); pass the
// caller's real request IP, not a placeholder.
export async function startAuth(aspspName: string, country: string, redirectUrl: string, state: string, psuIpAddress: string): Promise<StartAuthResult> {
  const validUntil = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(); // 90 days — conservative; this ASPSP allows up to 180
  return call('/auth', {
    method: 'POST',
    headers: { 'psu-ip-address': psuIpAddress },
    body: JSON.stringify({
      aspsp: { name: aspspName, country },
      redirect_url: redirectUrl,
      psu_type: 'personal',
      state,
      access: { valid_until: validUntil },
    }),
  });
}

export interface SbAccount {
  uid: string;
  account_id?: { iban?: string };
  name?: string;
  currency?: string;
}

export interface SessionResult {
  session_id: string;
  accounts: SbAccount[];
  access?: { valid_until?: string };
}

// Exchanges the one-time `code` from the bank's redirect for a session_id —
// the credential that actually authorizes reading balances/transactions.
export function exchangeCode(code: string): Promise<SessionResult> {
  return call('/sessions', { method: 'POST', body: JSON.stringify({ code }) });
}

export interface SbTransaction {
  transaction_id?: string;
  entry_reference?: string;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator: 'CRDT' | 'DBIT' | 'DBDT' | string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  status?: string; // 'BOOK' = final/settled; anything else (PEND/PDNG/...) is provisional
  remittance_information?: string[];
  debtor?: { name?: string };
  creditor?: { name?: string };
}

export interface TransactionsPage {
  transactions: SbTransaction[];
  continuation_key?: string;
}

// account_uid alone authorizes the call, together with our app JWT — Enable
// Banking's model doesn't need session_id on this call (confirmed against
// their docs: the account_id/uid returned from POST /sessions is what scopes
// subsequent data calls, not a separately-passed session token).
//
// PSU HEADERS ARE CRITICAL HERE, not optional metadata. Per Enable Banking's
// FAQ (confirmed 2026-07-23 after a real account got stuck in a multi-day
// rate limit): "When at least one PSU header is included, it informs an ASPSP
// that the PSU (end-user) is actively using the application... any limitations
// imposed by the ASPSP on background transaction fetching, such as the maximum
// number of data fetches per day, do not apply." Strict Nordic banks
// (SpareBank 1 among them) cap UNATTENDED background fetches at ~4/day; an
// ATTENDED request (with a real PSU IP/user-agent) is in a different bucket
// and exempt. A manual sync is always triggered by a real person clicking a
// button with a live browser, so sending these is both legitimate and
// necessary — without them EVERY sync counted against the tiny background
// quota and burned through it in a day of testing. These headers belong on
// the DATA FETCH, not just the /auth call (a prior version only sent
// psu-ip-address on /auth, which is why sync kept getting 429'd).
//
// psu is `null` specifically for a cron-triggered unattended sync (see
// lib/sparebankSync.ts) — there is no real end-user IP for a server-side job,
// and faking one would be lying to the bank about who's present, not just a
// technicality. Passing null here is what deliberately routes that request
// into the small unattended quota bucket instead of pretending to be
// attended; it's an intentional, honest choice, not a fallback for a missing
// value.
export function getTransactions(accountUid: string, psu: { ipAddress: string; userAgent?: string } | null, opts?: { dateFrom?: string; continuationKey?: string; transactionStatus?: 'BOOK' | 'PEND' }): Promise<TransactionsPage> {
  const params = new URLSearchParams();
  if (opts?.dateFrom) params.set('date_from', opts.dateFrom);
  if (opts?.continuationKey) params.set('continuation_key', opts.continuationKey);
  if (opts?.transactionStatus) params.set('transaction_status', opts.transactionStatus);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const headers: Record<string, string> = {};
  if (psu) {
    headers['psu-ip-address'] = psu.ipAddress;
    if (psu.userAgent) headers['psu-user-agent'] = psu.userAgent;
  }
  return call(`/accounts/${accountUid}/transactions${qs}`, { headers });
}

// Explicitly closes the PSU's bank consent on disconnect, mirroring
// lib/monobank.ts's disconnect behavior (best-effort — the caller still
// clears the locally-stored session either way, same as Monobank's route
// continues even if the webhook unregister call fails).
export async function deleteSession(sessionId: string): Promise<void> {
  await call(`/sessions/${sessionId}`, { method: 'DELETE' });
}

const STATE_MAX_AGE_MS = 15 * 60 * 1000; // 15 хвилин — bank redirect round-trip should take seconds, not minutes

// Signs which (household, user) initiated a connect attempt into the OAuth
// `state` param — Enable Banking treats it as opaque and echoes it back
// verbatim on redirect, so this is the ONLY thing binding the eventual
// callback to a specific already-authenticated request. Without it, an
// attacker could complete their own bank's consent flow and then replay the
// resulting `code` against another household's callback (the code alone
// doesn't identify who the callback should credit it to). Same HMAC-signed,
// short-lived-token shape as lib/magicLink.ts, kept separate rather than
// shared since the payload and trust boundary differ (household+user pair
// here vs. a bare email there).
// fromDate (YYYY-MM-DD, optional) rides along in the same signed payload so
// the callback — which only ever sees whatever Enable Banking echoes back in
// `state` — knows whether the user asked for a historical backfill starting
// point instead of the default "connect time forward, no backfill" behavior.
// Safe to join with ':' — an ISO date string never contains one.
export function signConnectState(secret: string, householdId: string, userId: string, fromDate?: string): string {
  const issuedAt = Date.now();
  const payload = Buffer.from(`${householdId}:${userId}:${fromDate ?? ''}`).toString('base64url');
  const sig = createHmac('sha256', secret).update(`sparebank-connect:${payload}:${issuedAt}`).digest('hex');
  return `${payload}.${issuedAt}.${sig}`;
}

export function verifyConnectState(secret: string, state: string): { householdId: string; userId: string; fromDate: string | null } | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [payload, issuedAtStr, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > STATE_MAX_AGE_MS) return null;
  const expected = createHmac('sha256', secret).update(`sparebank-connect:${payload}:${issuedAt}`).digest('hex');
  if (!safeEqual(sig, expected)) return null;
  try {
    const [householdId, userId, fromDate] = Buffer.from(payload, 'base64url').toString('utf8').split(':');
    if (!householdId || !userId) return null;
    return { householdId, userId, fromDate: fromDate || null };
  } catch {
    return null;
  }
}
