import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { encrypt } from '@/lib/crypto';
import { getClientInfo, setWebhook, getAppOrigin, MonobankError } from '@/lib/monobank';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, token } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');
    if (typeof token !== 'string' || !token.trim()) return badRequest("Токен обов'язковий");
    const trimmedToken = token.trim();

    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
    if (!user) return badRequest('Користувача не знайдено');

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

    return NextResponse.json({ ok: true, accountType: account.type, currencyCode: account.currencyCode });
  } catch (e) {
    console.error('[monobank/connect POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
