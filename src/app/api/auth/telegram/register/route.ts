import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPendingRegistration } from '@/lib/telegramAuth';
import { sessionCookieValue, SESSION_MAX_AGE_S } from '@/lib/session';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { hashPin, safeEqual, currentPinHash, registerPinFailure, clearPinFailures, pinLockoutResponse, hasPinConfigured, isPinHousehold, PIN_HOUSEHOLD_ID } from '@/lib/pin';

// Not verified in v1 (no email-sending service provisioned) — format-only,
// treats the value as a claimed identifier rather than a proven one.
function isValidEmailFormat(v: unknown): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export async function POST(req: NextRequest) {
  try {
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const body = await req.json();
    const { pendingToken, email, linkToUserId, name, pin } = body;

    if (typeof pendingToken !== 'string' || !pendingToken) return badRequest('Невалідний токен реєстрації');
    const telegramData = verifyPendingRegistration(authSecret, pendingToken);
    if (!telegramData) {
      return NextResponse.json({ error: 'Токен реєстрації недійсний або протермінований — спробуйте увійти ще раз' }, { status: 401 });
    }

    // Claiming an EXISTING account is otherwise a pre-auth account takeover:
    // /api/auth/telegram/unlinked-users publicly lists every unclaimed
    // {id, name}, and Telegram's HMAC only proves the caller owns SOME real
    // Telegram account — nothing about who they claim to be. Without this
    // check, any stranger on the internet could log in with their own
    // Telegram, pick "Паша" from the list, and receive a fully valid,
    // userId-bound session as Паша. Requiring the household PIN here closes
    // that gap the same way it gates every other entry into the app.
    if (linkToUserId !== undefined && linkToUserId !== null) {
      const blocked = await pinLockoutResponse(PIN_HOUSEHOLD_ID);
      if (blocked) return blocked;
      const stored = await currentPinHash(PIN_HOUSEHOLD_ID);
      if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });
      if (typeof pin !== 'string' || !safeEqual(hashPin(pin), stored)) {
        await registerPinFailure(PIN_HOUSEHOLD_ID);
        return NextResponse.json({ error: 'Невірний PIN' }, { status: 401 });
      }
      await clearPinFailures(PIN_HOUSEHOLD_ID);
    }

    let normalizedEmail: string | null = null;
    if (email !== undefined && email !== null && email !== '') {
      if (!isValidEmailFormat(email)) return badRequest('Невалідний email');
      normalizedEmail = email.trim().toLowerCase();
    }

    let user;
    // linkToUserId is always household #1 (enforced below) which has been
    // onboarded since the phase-A backfill; the new-account branch always
    // seeds a fresh, not-yet-onboarded household. No extra query needed.
    const onboarded = linkToUserId !== undefined && linkToUserId !== null;
    if (linkToUserId !== undefined && linkToUserId !== null) {
      // Claiming an EXISTING account (Паша/Женя logging in via Telegram for
      // the first time) — never create a new row here, or their transaction
      // history would silently split across two User rows.
      if (!isPositiveInt(Number(linkToUserId))) return badRequest("Невалідний користувач для прив'язки");
      const existing = await prisma.user.findUnique({ where: { id: Number(linkToUserId) }, select: { id: true, name: true, telegramId: true, email: true, householdId: true } });
      if (!existing) return badRequest('Користувача не знайдено');
      // The PIN just verified above only ever proves household #1's PIN —
      // linking must be restricted to household #1's own members, or knowing
      // that PIN would be enough to "link" a Telegram account onto ANY other
      // household's unlinked user and receive a session scoped to it. Found
      // live during deep-review 2026-07-11 (unlinked-users GET had the same
      // unscoped gap, fixed alongside this).
      if (!existing.householdId || !isPinHousehold(existing.householdId)) return badRequest('Користувача не знайдено');
      if (existing.telegramId) return badRequest('До цього акаунту вже прив’язано інший Telegram');

      try {
        // updateMany with telegramId: null in the WHERE, not update() by id
        // alone — closes a TOCTOU race where two concurrent requests could
        // both pass the `existing.telegramId` check above for the same
        // account and then both "succeed", the second silently overwriting
        // the first's link with no constraint violation (each sets a
        // different unique telegramId, so nothing at the DB level objects).
        const result = await prisma.user.updateMany({
          where: { id: existing.id, telegramId: null },
          data: {
            telegramId: telegramData.id,
            telegramUsername: telegramData.username ?? null,
            telegramFirstName: telegramData.first_name,
            telegramPhotoUrl: telegramData.photo_url ?? null,
            email: normalizedEmail ?? existing.email, // don't clobber an existing email with "not provided"
          },
        });
        if (result.count === 0) return badRequest('До цього акаунту вже прив’язано інший Telegram');
        user = { id: existing.id, name: existing.name, householdId: existing.householdId };
      } catch (e: any) {
        if (e?.code === 'P2002') return badRequest('Цей Telegram або email вже використовується іншим акаунтом');
        throw e;
      }
    } else {
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      if (!trimmedName) return badRequest("Вкажіть ім'я");

      try {
        // A brand-new Telegram signup with no linkToUserId is, by
        // definition, someone who isn't an existing member of household #1
        // — the multi-tenant migration's whole point is that this is a new
        // tenant, not the household's 3rd/4th person. Gets its own Household
        // (email/Telegram auth only, per project_product_direction — PIN
        // stays exclusive to household #1) seeded before the User row so the
        // user is never created without a tenant to belong to.
        //
        // Interactive transaction, not two separate creates — a P2002 on the
        // user create (concurrent double-submit racing the same telegramId)
        // used to leave an already-committed, permanently empty Household
        // row behind since nothing ever rolled it back. Found during
        // deep-review 2026-07-11.
        user = await prisma.$transaction(async (tx) => {
          const household = await tx.household.create({
            data: { name: trimmedName, authMode: 'telegram' },
            select: { id: true },
          });
          return tx.user.create({
            data: {
              name: trimmedName,
              telegramId: telegramData.id,
              telegramUsername: telegramData.username ?? null,
              telegramFirstName: telegramData.first_name,
              telegramPhotoUrl: telegramData.photo_url ?? null,
              email: normalizedEmail,
              householdId: household.id,
            },
            select: { id: true, name: true, householdId: true },
          });
        });
      } catch (e: any) {
        if (e?.code === 'P2002') return badRequest("Це ім'я, Telegram або email вже використовується");
        throw e;
      }
    }

    // Every path above must have set this — link inherits the existing
    // user's household, create just seeded a fresh one — but assert rather
    // than silently issue a session with no tenant scope if that ever stops
    // being true.
    if (!user.householdId) {
      console.error('[auth/telegram/register POST] user has no householdId', user.id);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const hasPin = await hasPinConfigured(user.householdId);
    const res = NextResponse.json({ ok: true, onboarded, user: { id: user.id, name: user.name } });
    res.cookies.set('budget-auth', sessionCookieValue(authSecret, String(user.householdId), String(user.id), hasPin), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    return res;
  } catch (e) {
    console.error('[auth/telegram/register POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
