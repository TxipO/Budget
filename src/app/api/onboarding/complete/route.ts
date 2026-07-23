import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidType } from '@/lib/validate';
import { requireHouseholdId, MAX_USERS } from '@/lib/household';
import { CURRENCIES } from '@/lib/currencies';
import { hashPin } from '@/lib/pin';
import { ICON_KEYS } from '@/lib/icons';
import { issueAuthCookies } from '@/lib/session';

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const PIN_FORMAT = /^\d{4,8}$/;
const MAX_CATEGORIES = 60;

interface CategoryInput { name: string; type: string; color: string; icon: string }

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const selfUserId = req.headers.get('x-current-user-id');
    if (!selfUserId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const selfName = typeof body?.selfName === 'string' ? body.selfName.trim() : '';
    const secondUserName = typeof body?.secondUserName === 'string' ? body.secondUserName.trim() : '';
    const rawCategories = Array.isArray(body?.categories) ? body.categories : [];
    const pin = typeof body?.pin === 'string' ? body.pin : '';
    // Never trust an arbitrary client-supplied string as a currency code —
    // must be one of the known codes lib/currencies.ts actually knows how to
    // format/convert, same "validate against the known set" rule as
    // isValidType below for category type.
    const currency = typeof body?.currency === 'string' ? body.currency : 'NOK';

    if (!selfName) return badRequest("Вкажіть ваше ім'я");
    if (rawCategories.length === 0) return badRequest('Додайте хоча б одну категорію');
    if (rawCategories.length > MAX_CATEGORIES) return badRequest('Забагато категорій');
    if (pin && !PIN_FORMAT.test(pin)) return badRequest('PIN — від 4 до 8 цифр');
    if (!CURRENCIES.some(c => c.code === currency)) return badRequest('Невалідна валюта');

    const categories: CategoryInput[] = [];
    for (const raw of rawCategories) {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      const type = raw?.type;
      const color = typeof raw?.color === 'string' ? raw.color : '';
      const icon = typeof raw?.icon === 'string' ? raw.icon : '';
      if (!name) return badRequest('У кожної категорії має бути назва');
      if (!isValidType(type)) return badRequest('Тип категорії має бути income, expense або savings');
      if (!HEX_COLOR.test(color)) return badRequest('Невалідний колір категорії');
      if (!ICON_KEYS.includes(icon)) return badRequest('Невалідна іконка категорії');
      categories.push({ name, type, color, icon });
    }
    // Names must be unique per (household, type) — matches Category's own
    // @@unique constraint. Catching this here gives a clear message instead
    // of a raw P2002 mid-transaction.
    const seen = new Set<string>();
    for (const c of categories) {
      const key = `${c.type}:${c.name}`;
      if (seen.has(key)) return badRequest(`Категорія "${c.name}" повторюється`);
      seen.add(key);
    }

    // Re-check at write time — a second tab, a slow double-submit, or simply
    // resubmitting an already-completed onboarding could otherwise create
    // duplicate users/categories or silently reset a household that already
    // has real data.
    const household = await prisma.household.findUnique({ where: { id: householdId }, select: { onboardedAt: true } });
    if (household?.onboardedAt) return badRequest('Онбординг вже пройдено');

    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: Number(selfUserId) }, data: { name: selfName } });

        if (secondUserName) {
          const count = await tx.user.count({ where: { householdId } });
          if (count >= MAX_USERS) throw new Error('MAX_USERS');
          await tx.user.create({ data: { name: secondUserName, householdId } });
        }

        await tx.category.createMany({
          data: categories.map(c => ({ ...c, householdId })),
        });

        if (pin) {
          await tx.household.update({ where: { id: householdId }, data: { pinHash: hashPin(pin) } });
        }

        await tx.household.update({ where: { id: householdId }, data: { onboardedAt: new Date(), currency } });
      });
    } catch (e: any) {
      if (e?.message === 'MAX_USERS') return badRequest(`Можна додати не більше ${MAX_USERS} користувачів`);
      if (e?.code === 'P2002') return badRequest("Ім'я вже використовується або категорія вже існує");
      throw e;
    }

    const res = NextResponse.json({ ok: true });
    // Reissue the session with the fresh hasPin bit if a PIN was just set,
    // so the immediate redirect home doesn't bounce straight into /lock
    // asking for a PIN that was just typed one screen ago. No-op when the
    // PIN step was skipped — nothing to reissue, the session already has
    // the correct hasPin:false from registration.
    if (pin) {
      const authSecret = process.env.AUTH_SECRET;
      if (authSecret) {
        issueAuthCookies(res, authSecret, { householdId: String(householdId), userId: selfUserId, hasPin: true, unlock: true });
      }
    }
    return res;
  } catch (e) {
    console.error('[onboarding/complete POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
