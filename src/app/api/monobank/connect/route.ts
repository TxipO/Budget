import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt, isValidDate } from '@/lib/validate';
import { encrypt } from '@/lib/crypto';
import { getClientInfo, setWebhook, getStatement, getAppOrigin, MonobankError } from '@/lib/monobank';
import { ingestStatementItem, MonoStatementItem } from '@/lib/monoIngest';
import { requireHouseholdId } from '@/lib/household';

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId, token, syncFromDate } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');
    if (typeof token !== 'string' || !token.trim()) return badRequest("Токен обов'язковий");
    const trimmedToken = token.trim();

    // Optional historical-backfill start date — default behavior (no date)
    // is unchanged: webhook-forward-only until the user clicks
    // "Синхронізувати". Monobank's statement endpoint rejects a single call
    // spanning more than 31 days (confirmed against their API docs — same
    // reason monobank/sync's own LOOKBACK_DAYS caps at 30), and there's no
    // benefit to accepting an older date anyway: a plain "Синхронізувати"
    // click right after connecting already covers the full 30-day window
    // for free, so a date beyond that range can't actually pull in anything
    // a normal sync click wouldn't.
    const MAX_BACKFILL_DAYS = 30;
    let fromDate: string | undefined;
    if (syncFromDate !== undefined && syncFromDate !== '') {
      if (typeof syncFromDate !== 'string' || !isValidDate(syncFromDate)) return badRequest('Невалідна дата початку синхронізації');
      const parsed = new Date(syncFromDate).getTime();
      const earliestAllowed = Date.now() - MAX_BACKFILL_DAYS * 24 * 3600 * 1000;
      if (parsed > Date.now()) return badRequest('Дата не може бути в майбутньому');
      if (parsed < earliestAllowed) return badRequest(`Monobank дозволяє синхронізацію не більше ніж за ${MAX_BACKFILL_DAYS} днів за один запит`);
      fromDate = syncFromDate;
    }

    // Ownership check — without it, any authenticated household could connect
    // a Monobank token to another household's user by guessing their id.
    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, householdId: true } });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');

    let clientInfo;
    try {
      clientInfo = await getClientInfo(trimmedToken);
    } catch (e) {
      if (e instanceof MonobankError) return NextResponse.json({ error: e.message }, { status: e.status === 429 ? 429 : 400 });
      throw e;
    }

    // "black" is Monobank's primary UAH card type; fall back to whatever the
    // token's first account is (e.g. FOP/business tokens use other types).
    const account = clientInfo.accounts.find(a => a.type === 'black') ?? clientInfo.accounts[0];
    if (!account) return badRequest('У цього токена немає жодного рахунку');

    // Generated before persisting anything — if webhook registration below
    // fails, nothing gets written to the DB, so a failed connect attempt
    // never leaves a half-connected user behind.
    const webhookSecret = randomBytes(24).toString('hex');
    const webhookUrl = `${getAppOrigin()}/api/webhooks/monobank/${webhookSecret}`;

    try {
      await setWebhook(trimmedToken, webhookUrl);
    } catch (e) {
      if (e instanceof MonobankError) {
        return NextResponse.json({ error: `Не вдалося зареєструвати webhook: ${e.message}` }, { status: e.status === 429 ? 429 : 400 });
      }
      throw e;
    }

    await prisma.user.update({
      where: { id: Number(userId) },
      data: {
        monoTokenEnc: encrypt(trimmedToken),
        monoWebhookSecret: webhookSecret,
        monoAccountId: account.id,
      },
    });

    // A chosen start date means the user wants that history pulled in NOW,
    // not after a separate manual "Синхронізувати" click. The connection
    // itself is already saved above — a failed backfill here must not
    // undo that or block the response.
    let backfill: { created: number; checked: number } | undefined;
    if (fromDate) {
      try {
        const from = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000);
        const to = Math.floor(Date.now() / 1000);
        const items: MonoStatementItem[] = await getStatement(trimmedToken, account.id, from, to);
        let created = 0;
        for (const item of items) {
          // Same per-item isolation as monobank/sync — one bad item (e.g. a
          // currency with no exchange rate available) must never hide every
          // other transaction in the same backfill behind it.
          try {
            const result = await ingestStatementItem(Number(userId), householdId, item);
            if (result === 'created') created++;
          } catch (e) {
            console.error('[monobank/connect] backfill item failed, continuing with the rest', item.id, e);
          }
        }
        backfill = { created, checked: items.length };
      } catch (e) {
        console.error('[monobank/connect] initial backfill failed, connection still saved', e instanceof MonobankError ? e.message : e);
      }
    }

    return NextResponse.json({ ok: true, accountType: account.type, currencyCode: account.currencyCode, backfill });
  } catch (e) {
    console.error('[monobank/connect POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
