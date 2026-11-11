import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { getClientInfoCached, MonobankError } from '@/lib/monobank';
import { MONO_CCY_NAMES } from '@/lib/monoIngest';
import { requireHouseholdId } from '@/lib/household';

// Lists the cards/accounts behind the stored token so the user can pick which one
// is tracked (settings picker). Never returns the token or a full PAN.
export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = Number(req.nextUrl.searchParams.get('userId'));
    if (!Number.isInteger(userId) || userId <= 0) return NextResponse.json({ error: 'Невалідний користувач' }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { householdId: true, monoTokenEnc: true, monoAccountId: true } });
    if (!user || user.householdId !== householdId) return NextResponse.json({ error: 'Користувача не знайдено' }, { status: 400 });
    if (!user.monoTokenEnc) return NextResponse.json({ error: 'Не підключено' }, { status: 400 });

    try {
      const info = await getClientInfoCached(userId, decrypt(user.monoTokenEnc));
      return NextResponse.json((info.accounts ?? []).map(a => ({
        id: a.id,
        type: a.type,
        currency: MONO_CCY_NAMES[a.currencyCode] ?? String(a.currencyCode),
        maskedPan: a.maskedPan?.[0]?.slice(-4) ?? null,
        balance: Math.round(a.balance) / 100,
        isCurrent: a.id === user.monoAccountId,
      })));
    } catch (e) {
      if (e instanceof MonobankError) {
        return NextResponse.json({ error: e.status === 429 ? 'Monobank обмежує запити — спробуйте за хвилину' : e.message }, { status: e.status === 429 ? 429 : 400 });
      }
      throw e;
    }
  } catch (e) {
    console.error('[monobank/accounts GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
