import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

export async function POST(req: NextRequest) {
  try {
    const pin = process.env.APP_PIN;
    if (!pin) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body.pin !== 'string' || body.pin !== pin) {
      return NextResponse.json({ error: 'Невірний PIN' }, { status: 401 });
    }

    const token = createHash('sha256').update(`budget-auth:${pin}`).digest('hex');
    const res = NextResponse.json({ ok: true });
    res.cookies.set('budget-auth', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 днів
    });
    return res;
  } catch (e) {
    console.error('[auth POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
