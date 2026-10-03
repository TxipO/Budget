import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidDate, isPositiveInt, isPositiveNumber, roundMoney } from '@/lib/validate';
import { merchantKeyOf, findSweepSiblings } from '@/lib/sweepSiblings';
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
      select: { source: true, monoMerchant: true, details: true, userId: true, categoryId: true, householdId: true, isTransfer: true, savingsWithdrawal: true },
    });
    if (!before || before.householdId !== householdId) {
      return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    }
    if (!(await isOwnedCategory(householdId, newCategoryId))) return badRequest('Невалідна категорія');
    // Owner of a bank-synced row is a fact about the bank account, not
    // something to edit: body.userId is IGNORED for mono/sparebank rows and the
    // stored owner kept. Root cause of repeated wrong-user attribution
    // (proven): the transactions page used to open the edit form without the
    // row's userId, so the form pre-filled the LOGGED-IN person and this PUT
    // saved it. Still editable for manual/voice/import rows.
    const isBankRow = before.source === 'mono' || before.source === 'sparebank';
    if (!isBankRow && body.userId && !(await isOwnedUser(householdId, parseInt(body.userId)))) return badRequest('Невалідний користувач');

    // Truncate to a clean UTC calendar-day boundary — see the matching
    // comment in transactions/route.ts POST. Found during deep-review
    // 2026-07-11.
    const parsedDate = new Date(body.date);
    const truncatedDate = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()));

    // scope (2026-09-29): a category change is a ONE-OFF exception unless the
    // caller says otherwise. Before this, every correction of a synced row
    // unconditionally re-taught the merchant's rule AND swept every sibling
    // row along — so logging one gift bought where you usually buy coffee
    // flipped all the coffee to "Подарунки" (found live: NORSK REISELIVS).
    // 'merchant' = the old behavior (learn the rule + sweep siblings), now
    // only on request; anything else (incl. omitted) = just this row.
    // TransactionForm asks the user via GET .../sweep-preview and always
    // sends an explicit scope.
    if (body.scope !== undefined && body.scope !== 'one' && body.scope !== 'merchant') return badRequest('Невалідний режим застосування');
    const scope: 'one' | 'merchant' = body.scope === 'merchant' ? 'merchant' : 'one';
    const categoryChanged = newCategoryId !== before.categoryId;

    // Voice/sparebank/mono key derivation (and the blank-key guard) live in
    // lib/sweepSiblings.ts — see merchantKeyOf. Computed BEFORE the update
    // so the primary row's own categorySource can be set in the same write.
    const merchantKey = before.userId && categoryChanged ? merchantKeyOf(before) : null;
    const shouldLearnRule = scope === 'merchant' && merchantKey !== null;

    // Any hand edit of a bank-sourced row (mono/sparebank/voice) that the
    // automation could otherwise silently undo on the next sync or match —
    // transfer flag, savings direction or text — marks the row 'manual'
    // (like a one-off category change already did), so reconciliation, the
    // transfer matchers and merchant sweeps all leave it alone. 'rule' only
    // when the SOLE change is a category change learned for the merchant.
    const isBankSourced = before.source === 'mono' || before.source === 'sparebank' || before.source === 'voice';
    const newDetails = body.details || '';
    const newIsTransfer = body.isTransfer === true;
    const newSavingsWithdrawal = body.savingsWithdrawal === true;
    const handEditedFlagsOrText = isBankSourced &&
      (newIsTransfer !== before.isTransfer || newSavingsWithdrawal !== before.savingsWithdrawal || newDetails !== before.details);
    const markManual = handEditedFlagsOrText || (categoryChanged && !shouldLearnRule);

    const tx = await prisma.transaction.update({
      where: { id },
      data: {
        date:       truncatedDate,
        categoryId: newCategoryId,
        amount:     roundMoney(parseFloat(body.amount)),
        details:    newDetails,
        ...(isBankRow ? {} : { userId: body.userId ? parseInt(body.userId) : null }),
        savingsWithdrawal: newSavingsWithdrawal,
        // Manual "не рахувати в загальний баланс" toggle — see the create
        // route's matching comment and Transaction.isTransfer's schema
        // comment. Editable both ways: turning it back off un-hides a row
        // that was flagged by mistake, no separate "undo" flow needed.
        isTransfer: newIsTransfer,
        // As of this write, this row's category IS explained by a learned
        // rule for its merchant (the upsert below makes that literally
        // true) — record that instead of leaving whatever categorySource
        // it had before the correction (often null/stale). A one-off
        // change is 'manual' instead: findSweepSiblings never sweeps those,
        // so a later "apply to all" can't flip the exception back.
        ...(markManual ? { categorySource: 'manual' } : shouldLearnRule ? { categorySource: 'rule' } : {}),
      },
      include: { category: true, user: { select: { id: true, name: true } } },
    });

    // Ф1a (classification overhaul, 2026-09-15) — now only when scope ===
    // 'merchant' (see above): a correction fixes
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
    let siblingIds: number[] = [];
    let ruleBefore: { categoryId: number; hitCount: number } | null = null;
    if (shouldLearnRule) {
      // Captured so revert-sweep can put the rule back exactly as it was.
      ruleBefore = await prisma.monoCategoryRule.findUnique({
        where: { userId_merchantKey: { userId: before.userId!, merchantKey: merchantKey! } },
        select: { categoryId: true, hitCount: true },
      });
      await prisma.monoCategoryRule.upsert({
        where: { userId_merchantKey: { userId: before.userId!, merchantKey: merchantKey! } },
        update: { categoryId: newCategoryId, hitCount: { increment: 1 } },
        create: { userId: before.userId!, merchantKey: merchantKey!, categoryId: newCategoryId, hitCount: 1 },
      });

      siblingIds = await findSweepSiblings({
        householdId, userId: before.userId!, categoryId: before.categoryId, merchantKey: merchantKey!, excludeId: id,
      });
      if (siblingIds.length > 0) {
        await prisma.transaction.updateMany({
          where: { id: { in: siblingIds } },
          data: { categoryId: newCategoryId, categorySource: 'rule' },
        });
      }
    }

    return NextResponse.json({
      ...tx,
      retroactiveCount: siblingIds.length,
      // Everything revert-sweep needs to undo the sweep (not the primary
      // row's own edit) — null when nothing was swept.
      sweep: siblingIds.length > 0
        ? { sweptIds: siblingIds, fromCategoryId: before.categoryId, toCategoryId: newCategoryId, ruleBefore }
        : null,
    });
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
