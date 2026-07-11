import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { decrypt } from '@/lib/crypto';
import { setWebhook, getAppOrigin } from '@/lib/monobank';
import { requireHouseholdId } from '@/lib/household';

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { householdId: true, monoTokenEnc: true } });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.monoTokenEnc) return badRequest('Не підключено');

    // Best-effort: repoint Monobank's webhook at our own receiver with an
    // invalid secret, so it 404s instead of retrying forever against a URL
    // no one owns. Points at OUR route (not a third-party URL) so the
    // required "200 on GET" check Monobank does on registration passes
    // without depending on someone else's uptime. If this fails, clearing
    // monoWebhookSecret below still makes the receiver reject any further
    // push for this account — just with Monobank retrying pointlessly.
    try {
      const token = decrypt(user.monoTokenEnc);
      await setWebhook(token, `${getAppOrigin()}/api/webhooks/monobank/disconnected`);
    } catch (e) {
      console.error('[monobank/disconnect] webhook unregister failed, continuing', e);
    }

    await prisma.user.update({
      where: { id: Number(userId) },
      data: { monoTokenEnc: null, monoWebhookSecret: null, monoAccountId: null },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[monobank/disconnect POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
