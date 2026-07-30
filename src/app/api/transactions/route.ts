import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidDate, isPositiveInt, isPositiveNumber, roundMoney } from '@/lib/validate';
import { requireHouseholdId, isOwnedCategory, isOwnedUser } from '@/lib/household';

export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { searchParams } = req.nextUrl;
    const year  = searchParams.get('year');
    const month = searchParams.get('month');
    const type  = searchParams.get('type');
    const limitParam = searchParams.get('limit');

    const where: Record<string, unknown> = { householdId };
    let take: number | undefined;

    if (year && month) {
      const y = parseInt(year), m = parseInt(month);
      if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12)
        return badRequest('Невалідний рік або місяць');
      where.date = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
    } else if (year) {
      const y = parseInt(year);
      if (!Number.isFinite(y)) return badRequest('Невалідний рік');
      where.date = { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) };
      const lim = limitParam ? parseInt(limitParam) : 500;
      take = Number.isFinite(lim) && lim > 0 ? lim : 500;
    } else {
      const lim = limitParam ? parseInt(limitParam) : 100;
      take = Number.isFinite(lim) && lim > 0 ? lim : 100;
    }

    if (type) {
      where.category = { type };
    }

    const txs = await prisma.transaction.findMany({
      where,
      include: { category: true, user: { select: { id: true, name: true } } },
      // date alone ties for every transaction on the same calendar day (it's
      // truncated to UTC midnight/noon), so createdAt breaks the tie with
      // the order transactions were actually entered.
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      ...(take !== undefined ? { take } : {}),
    });
    return NextResponse.json(txs);
  } catch (e) {
    console.error('[transactions GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { date, categoryId, amount, details, userId, savingsWithdrawal } = body;

    if (!isValidDate(date))                  return badRequest('Невалідна дата');
    if (!isPositiveInt(Number(categoryId)))  return badRequest('Невалідна категорія');
    if (!isPositiveNumber(Number(amount)))   return badRequest('Сума має бути більше 0');
    if (savingsWithdrawal !== undefined && typeof savingsWithdrawal !== 'boolean') return badRequest('Невалідне значення напрямку');

    // Without this, a request could reference another household's category
    // (or user) by id — the created row itself would still only be visible
    // within this household's own queries (household is set below,
    // independent of what the client sent), but it would silently link to
    // and expose a foreign category's name/type via this transaction's own
    // `include: category`.
    if (!(await isOwnedCategory(householdId, parseInt(categoryId)))) return badRequest('Невалідна категорія');
    if (userId && !(await isOwnedUser(householdId, parseInt(userId)))) return badRequest('Невалідний користувач');

    // Truncate to a clean UTC calendar-day boundary, matching every other
    // writer (monoIngest.ts, the voice webhook, import, recurring/apply) —
    // the UI's <input type="date"> always sends a bare YYYY-MM-DD (read as
    // UTC midnight already), but this route is also a plain JSON API; a
    // caller sending a full ISO timestamp with a time/offset would otherwise
    // store a non-midnight date, breaking the timezone-residue invariant
    // verify-data-integrity.mjs checks and potentially landing the
    // transaction in the wrong month. Found during deep-review 2026-07-11.
    const parsedDate = new Date(date);
    const truncatedDate = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()));

    const tx = await prisma.transaction.create({
      data: {
        date:       truncatedDate,
        categoryId: parseInt(categoryId),
        amount:     roundMoney(parseFloat(amount)),
        details:    details || '',
        userId:     userId ? parseInt(userId) : null,
        householdId,
        // Ignored by every reader unless the category is type "savings"
        // (see Transaction.savingsWithdrawal's schema comment) — harmless
        // to always store whatever the client sent (default false).
        savingsWithdrawal: savingsWithdrawal === true,
      },
      include: { category: true, user: { select: { id: true, name: true } } },
    });
    return NextResponse.json(tx, { status: 201 });
  } catch (e) {
    console.error('[transactions POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
