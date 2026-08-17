import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyTelegramAuth, signPendingRegistration } from '@/lib/telegramAuth';
import { issueAuthCookies } from '@/lib/session';
import { hasPinConfigured } from '@/lib/pin';

export async function POST(req: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const authSecret = process.env.AUTH_SECRET;
    if (!botToken || !authSecret) {
      return NextResponse.json({ error: 'Telegram-автентифікацію не налаштовано' }, { status: 500 });
    }

    const body = await req.json();
    const verified = verifyTelegramAuth(body, botToken);
    if (!verified) return NextResponse.json({ error: 'Недійсний підпис Telegram' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { telegramId: verified.id },
      select: { id: true, householdId: true, household: { select: { onboardedAt: true } } },
    });

    if (!user) {
      // First-time login — don't auto-create a row here. It might be a
      // genuinely new account, or it might be Паша/Женя logging in via
      // Telegram for the first time and needing to link to their EXISTING
      // account (auto-creating would silently split their transaction
      // history across two User rows). The registration-complete step
      // decides which.
      return NextResponse.json({
        ok: true,
        needsRegistration: true,
        pendingToken: signPendingRegistration(authSecret, verified),
        telegramFirstName: verified.first_name,
        telegramUsername: verified.username ?? null,
      });
    }

    // Every User row gets a householdId at creation from this point forward
    // (backfilled for everything that predates it) — null here means a data
    // inconsistency, not a normal case, so fail loudly rather than issue a
    // session with no tenant scope.
    if (!user.householdId) {
      console.error('[auth/telegram POST] user has no householdId', user.id);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Covers the edge case of someone who registered via Telegram, closed
    // the tab mid-onboarding, and comes back later — telegramId is already
    // set from registration, so this route (not .../register) is what they
    // hit on their next login.
    const res = NextResponse.json({ ok: true, needsRegistration: false, onboarded: !!user.household?.onboardedAt });
    // Telegram identity alone never bypasses a configured PIN lock (P4) —
    // if hasPin is true here, middleware.ts sends them to /lock next.
    const hasPin = await hasPinConfigured(user.householdId);
    issueAuthCookies(res, authSecret, { householdId: String(user.householdId), userId: String(user.id), hasPin });
    return res;
  } catch (e) {
    console.error('[auth/telegram POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
