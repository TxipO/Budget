import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidDate, isPositiveInt, isPositiveNumber, roundMoney } from '@/lib/validate';
import { normalizeMerchantKey } from '@/lib/monobank';
import { requireHouseholdId, isOwnedCategory, isOwnedUser } from '@/lib/household';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const body = await req.json();

    if (!isValidDate(body.date))                   return badRequest('Невалідна дата');
    if (!isPositiveInt(Number(body.categoryId)))   return badRequest('Невалідна категорія');
    if (!isPositiveNumber(Number(body.amount)))    return badRequest('Сума має бути більше 0');
    if (body.savingsWithdrawal !== undefined && typeof body.savingsWithdrawal !== 'boolean') return badRequest('Невалідне значення напрямку');
    if (body.isTransfer !== undefined && typeof body.isTransfer !== 'boolean') return badRequest('Невалідне значення виключення з балансу');

    const newCategoryId = parseInt(body.categoryId);

    // Read the pre-update row so we can tell whether this is a Monobank- or
    // voice-sourced transaction getting its category corrected — that's the
    // signal MonoCategoryRule learns from (never Claude's own guess), so a
    // repeat merchant/phrase is never re-guessed after being fixed once.
    // Fetched before the update, not after, so we compare against the
    // category that was actually wrong. Also doubles as the household
    // ownership check — a bare update({ where: { id } }) would let one
    // household edit another's transaction just by guessing its id.
    const before = await prisma.transaction.findUnique({
      where: { id },
      select: { source: true, monoMerchant: true, details: true, userId: true, categoryId: true, householdId: true },
    });
    if (!before || before.householdId !== householdId) {
      return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    }
    if (!(await isOwnedCategory(householdId, newCategoryId))) return badRequest('Невалідна категорія');
    if (body.userId && !(await isOwnedUser(householdId, parseInt(body.userId)))) return badRequest('Невалідний користувач');

    // Truncate to a clean UTC calendar-day boundary — see the matching
    // comment in transactions/route.ts POST. Found during deep-review
    // 2026-07-11.
    const parsedDate = new Date(body.date);
    const truncatedDate = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()));

    // Voice transcripts rarely repeat verbatim, so this rarely hits tier 1
    // of guessCategoryId on a *future* message the way a real merchant name
    // does — but per spec.md's US1 acceptance criteria, a voice correction
    // must still reach the same learning mechanism, not be silently
    // excluded. Previously gated on source === 'mono' only, so a voice
    // correction here never ran at all. sparebank uses `details` too — it's
    // set to the exact same text (remittance info or counterparty name)
    // that lib/sparebankIngest.ts derives merchantKey from for a future
    // sync of the same merchant, same shape as the voice case. Found while
    // investigating why the first SpareBank 1 sync left almost everything
    // in "Незрозуміло": correcting one manually would never have helped
    // the next 34 JOKER BALESTRAND rows without this.
    //
    // Computed BEFORE the update below (not after, like before this Ф1a
    // change) so the primary row's own categorySource can be set in the
    // same write, and so the retroactive-sibling pass has everything it
    // needs without an extra round-trip.
    const correctionKey = before.source === 'mono' ? before.monoMerchant
      : (before.source === 'voice' || before.source === 'sparebank') ? before.details
      : null;
    // trim() guard — an all-whitespace correctionKey would normalize to '',
    // and every future step here keys off that '' string. A learned rule
    // for merchantKey '' would be harmless on its own (nothing legitimate
    // ever looks up an empty key), but the retroactive-sibling scan below
    // would then match every OTHER row that also happens to have blank/
    // whitespace-only details under the same old category — a real way to
    // silently mass-recategorize unrelated rows. Reject it at the source
    // instead of trusting downstream matching to stay narrow.
    const merchantKey = correctionKey && before.userId && newCategoryId !== before.categoryId
      ? normalizeMerchantKey(correctionKey) : null;
    const shouldLearnRule = merchantKey !== null && merchantKey !== '';

    const tx = await prisma.transaction.update({
      where: { id },
      data: {
        date:       truncatedDate,
        categoryId: newCategoryId,
        amount:     roundMoney(parseFloat(body.amount)),
        details:    body.details || '',
        userId:     body.userId ? parseInt(body.userId) : null,
        savingsWithdrawal: body.savingsWithdrawal === true,
        // Manual "не рахувати в загальний баланс" toggle — see the create
        // route's matching comment and Transaction.isTransfer's schema
        // comment. Editable both ways: turning it back off un-hides a row
        // that was flagged by mistake, no separate "undo" flow needed.
        isTransfer: body.isTransfer === true,
        // As of this write, this row's category IS explained by a learned
        // rule for its merchant (the upsert below makes that literally
        // true) — record that instead of leaving whatever categorySource
        // it had before the correction (often null/stale).
        ...(shouldLearnRule ? { categorySource: 'rule' } : {}),
      },
      include: { category: true, user: { select: { id: true, name: true } } },
    });

    // Ф1a (classification overhaul, 2026-09-15): one correction now fixes
    // every OTHER row of the same merchant still sitting under the OLD
    // category, not just this one row + a rule for the future. Found live
    // 2026-09-15 — the Stbar case: 16 identically-worded rows, 15 wrong,
    // one manual fix only ever repaired the one row it was made on; the
    // other 14 needed a second manual pass the next day. Deliberately
    // narrow: same household, same user (rules are per-user), and only
    // rows CURRENTLY under the exact OLD category being corrected away
    // from — never touches a row already sitting under some other
    // (possibly also-wrong, possibly intentionally different) category.
    // merchantKey isn't a stored column, so this reads a bounded candidate
    // set by the columns that ARE indexed (household+user+category) and
    // computes/matches merchantKey in JS, exactly like the rule lookup
    // above and categoryGuess.ts's own tier 1 — exact match only, never a
    // substring/brand guess (that's Ф1b, a deliberately separate, lower-
    // confidence tier, not this).
    let retroactiveCount = 0;
    if (shouldLearnRule) {
      await prisma.monoCategoryRule.upsert({
        where: { userId_merchantKey: { userId: before.userId!, merchantKey: merchantKey! } },
        update: { categoryId: newCategoryId, hitCount: { increment: 1 } },
        create: { userId: before.userId!, merchantKey: merchantKey!, categoryId: newCategoryId, hitCount: 1 },
      });

      const candidates = await prisma.transaction.findMany({
        where: { householdId, userId: before.userId!, categoryId: before.categoryId, id: { not: id }, source: { in: ['mono', 'sparebank', 'voice'] } },
        select: { id: true, source: true, monoMerchant: true, details: true },
      });
      const siblingIds = candidates
        .filter(c => {
          const key = c.source === 'mono' ? c.monoMerchant : c.details;
          return !!key && normalizeMerchantKey(key) === merchantKey;
        })
        .map(c => c.id);
      if (siblingIds.length > 0) {
        await prisma.transaction.updateMany({
          where: { id: { in: siblingIds } },
          data: { categoryId: newCategoryId, categorySource: 'rule' },
        });
        retroactiveCount = siblingIds.length;
      }
    }

    return NextResponse.json({ ...tx, retroactiveCount });
  } catch (e: any) {
    if (e?.code === 'P2025') return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    console.error('[transactions/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const owned = await prisma.transaction.findUnique({ where: { id }, select: { householdId: true } });
    if (!owned || owned.householdId !== householdId) {
      return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    }
    // possibleDuplicateOf is a plain Int, not a real FK relation (deliberately —
    // see Ф5), so Postgres won't clean up references to this row on its own.
    // Clear them first so deleting the "original" of a flagged pair never
    // leaves the flagged row pointing at a transaction that no longer exists.
    await prisma.transaction.updateMany({ where: { possibleDuplicateOf: id }, data: { possibleDuplicateOf: null } });
    await prisma.transaction.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 'P2025') return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    console.error('[transactions/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
