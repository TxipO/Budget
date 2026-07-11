import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyMagicLinkToken, signPendingEmailRegistration } from '@/lib/magicLink';
import { sessionCookieValue, SESSION_MAX_AGE_S } from '@/lib/session';
import { getAppOrigin } from '@/lib/monobank';

// Clicked directly from the user's email client — a GET that redirects,
// never JSON, since there's no client-side JS driving this request.
export async function GET(req: NextRequest) {
  const origin = getAppOrigin();
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) return NextResponse.redirect(`${origin}/login?error=server_error`);

  const token = req.nextUrl.searchParams.get('token') || '';
  const email = verifyMagicLinkToken(authSecret, token);
  if (!email) return NextResponse.redirect(`${origin}/login?error=invalid_link`);

  try {
    // Only a row with a PRIOR verified magic-link login counts as "this
    // email's real account" — an unverified claim (e.g. typed into the
    // Telegram-registration email field by someone who doesn't control the
    // inbox) never grants login rights just because it matches.
    const verifiedUser = await prisma.user.findFirst({
      where: { email, emailVerifiedAt: { not: null } },
      select: { id: true, householdId: true },
    });

    if (verifiedUser && verifiedUser.householdId) {
      const res = NextResponse.redirect(`${origin}/`);
      res.cookies.set('budget-auth', sessionCookieValue(authSecret, String(verifiedUser.householdId), String(verifiedUser.id)), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_S,
      });
      return res;
    }

    // No verified owner of this email yet. Clearing any stale unverified
    // claim here — clicking this link, which only the real inbox owner
    // could receive, IS the proof of ownership; a guess typed into a form
    // somewhere else doesn't get to keep squatting on it once that proof
    // exists.
    await prisma.user.updateMany({ where: { email, emailVerifiedAt: null }, data: { email: null } });

    const pendingToken = signPendingEmailRegistration(authSecret, email);
    return NextResponse.redirect(
      `${origin}/login?mode=register-email&pendingToken=${encodeURIComponent(pendingToken)}&email=${encodeURIComponent(email)}`
    );
  } catch (e) {
    console.error('[auth/magic-link/verify GET]', e);
    return NextResponse.redirect(`${origin}/login?error=server_error`);
  }
}
