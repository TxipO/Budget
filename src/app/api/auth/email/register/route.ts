import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPendingEmailRegistration } from '@/lib/magicLink';
import { issueAuthCookies } from '@/lib/session';
import { badRequest } from '@/lib/validate';
import { hasPinConfigured } from '@/lib/pin';

export async function POST(req: NextRequest) {
  try {
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const body = await req.json();
    const { pendingToken, name } = body;
    if (typeof pendingToken !== 'string' || !pendingToken) return badRequest('Невалідний токен реєстрації');
    const email = verifyPendingEmailRegistration(authSecret, pendingToken);
    if (!email) {
      return NextResponse.json({ error: 'Токен реєстрації недійсний або протермінований — спробуйте увійти ще раз' }, { status: 401 });
    }

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) return badRequest("Вкажіть ім'я");

    // Re-check at write time, not just trust the redirect that got us here —
    // a second tab, a slow double-submit, or simply re-visiting an old
    // magic-link click could otherwise race two households into existing
    // for the same now-verified email.
    const existing = await prisma.user.findFirst({
      where: { email, emailVerifiedAt: { not: null } },
      select: { id: true, householdId: true },
    });
    if (existing && existing.householdId) {
      // Existing household might itself still be mid-onboarding (e.g. they
      // closed the tab partway through) — check rather than assume "existing
      // account" always means "already onboarded".
      const household = await prisma.household.findUnique({ where: { id: existing.householdId }, select: { onboardedAt: true } });
      const hasPin = await hasPinConfigured(existing.householdId);
      const res = NextResponse.json({ ok: true, onboarded: !!household?.onboardedAt, user: { id: existing.id, name: trimmedName } });
      issueAuthCookies(res, authSecret, { householdId: String(existing.householdId), userId: String(existing.id), hasPin });
      return res;
    }

    let user;
    try {
      // A brand-new household, per project_product_direction — email signup
      // is the entry point for people who are NOT existing members of
      // household #1, never a 3rd/4th person added to it. Category list
      // starts empty; the user builds their own from Settings.
      //
      // Interactive transaction, not two separate creates — a P2002 on the
      // user create (concurrent double-submit racing the same email) used to
      // leave an already-committed, permanently empty Household row behind
      // since nothing ever rolled it back. Found during deep-review
      // 2026-07-11.
      user = await prisma.$transaction(async (tx) => {
        const household = await tx.household.create({ data: { name: trimmedName, authMode: 'email' }, select: { id: true } });
        return tx.user.create({
          data: { name: trimmedName, email, emailVerifiedAt: new Date(), householdId: household.id },
          select: { id: true, name: true, householdId: true },
        });
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return badRequest("Це ім'я або email вже використовується");
      throw e;
    }

    // Brand-new household — onboardedAt is null by construction (no default,
    // never set at create time), so this is always false here.
    const res = NextResponse.json({ ok: true, onboarded: false, user: { id: user.id, name: user.name } });
    issueAuthCookies(res, authSecret, { householdId: String(user.householdId), userId: String(user.id), hasPin: false });
    return res;
  } catch (e) {
    console.error('[auth/email/register POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
