import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { signMagicLinkToken } from '@/lib/magicLink';
import { sendMagicLinkEmail } from '@/lib/email';
import { getAppOrigin } from '@/lib/monobank';
import { badRequest } from '@/lib/validate';

function isValidEmailFormat(v: unknown): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

const MAX_PER_EMAIL = 3;
const EMAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 10;
const IP_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const body = await req.json();
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isValidEmailFormat(email)) return badRequest('Невалідний email');

    // No household exists yet to hang a lockout row off of (HouseholdLockout
    // needs one) — a plain table keyed by email/ip is the whole point of
    // MagicLinkRequest.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const [emailCount, ipCount] = await Promise.all([
      prisma.magicLinkRequest.count({ where: { email, createdAt: { gte: new Date(Date.now() - EMAIL_WINDOW_MS) } } }),
      prisma.magicLinkRequest.count({ where: { ip, createdAt: { gte: new Date(Date.now() - IP_WINDOW_MS) } } }),
    ]);
    if (emailCount < MAX_PER_EMAIL && ipCount < MAX_PER_IP) {
      await prisma.magicLinkRequest.create({ data: { email, ip } });
      const token = signMagicLinkToken(authSecret, email);
      const link = `${getAppOrigin()}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
      await sendMagicLinkEmail(email, link);
    }

    // Same response whether the email matched an existing account, was
    // rate-limited, or never existed at all — never reveal which, here.
    // Only the real inbox owner ever learns more, by receiving the email.
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[auth/magic-link/request POST]', e);
    return NextResponse.json({ error: 'Не вдалося надіслати листа, спробуйте пізніше' }, { status: 500 });
  }
}
