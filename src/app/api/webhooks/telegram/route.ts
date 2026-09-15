import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { downloadVoice, sendMessage } from '@/lib/telegramBot';
import { transcribe } from '@/lib/groq';
import { getCurrencyInfo } from '@/lib/currencies';
import { extractWithLLM } from '@/lib/voiceExtract';
import { parseVoiceTransaction } from '@/lib/voiceParse';
import { guessCategoryId } from '@/lib/categoryGuess';
import { roundMoney } from '@/lib/validate';
import { safeEqual } from '@/lib/telegramAuth';

interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    voice?: { file_id: string; file_unique_id: string };
  };
}

export async function POST(req: NextRequest) {
  try {
    // Trust boundary — Telegram has no per-integration secret-path mechanism
    // the way a hand-rolled webhook URL (like Monobank's) can have, so this
    // uses Telegram's own secret_token header instead. See
    // contracts/telegram-webhook.md.
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const receivedSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (!expectedSecret || !receivedSecret || !safeEqual(receivedSecret, expectedSecret)) {
      return NextResponse.json({ ok: true }); // 200, no-op — never reveal *why* via a different status
    }

    const update: TelegramUpdate = await req.json();
    const voice = update.message?.voice;
    const senderId = update.message?.from?.id;
    if (!voice || !senderId) return NextResponse.json({ ok: true }); // not a voice message — no-op

    // Idempotency (FR-011) — a DB-backed unique constraint, not an in-memory
    // "seen" set, so it survives across serverless invocations.
    const existing = await prisma.transaction.findUnique({ where: { telegramMessageId: voice.file_unique_id } });
    if (existing) return NextResponse.json({ ok: true });

    // Unlinked-sender guard (FR-008/FR-009) runs *before* transcription — an
    // unrecognized sender can never create a transaction under anyone's
    // name, and there's no reason to spend a Groq call finding that out.
    const user = await prisma.user.findUnique({
      where: { telegramId: String(senderId) },
      select: { id: true, name: true, householdId: true },
    });
    if (!user || !user.householdId) {
      await sendMessage(senderId, 'Цей Telegram не прив’язаний до жодного акаунту. Прив’яжіть його через застосунок (Налаштування → Обліковий запис), тоді голосові повідомлення почнуть логувати транзакції.');
      return NextResponse.json({ ok: true });
    }
    const householdId = user.householdId;
    const household = await prisma.household.findUnique({ where: { id: householdId }, select: { currency: true } });
    const currencyInfo = getCurrencyInfo(household?.currency);

    const audio = await downloadVoice(voice.file_id);
    if (!audio) {
      await sendMessage(senderId, 'Не вдалося завантажити голосове повідомлення. Спробуйте ще раз.');
      return NextResponse.json({ ok: true });
    }

    const transcript = await transcribe(audio, currencyInfo);
    if (!transcript) {
      await sendMessage(senderId, 'Не вдалося розпізнати голосове повідомлення. Спробуйте сказати чіткіше.');
      return NextResponse.json({ ok: true });
    }

    // LLM extraction first (handles grammatical cases, language-mixing,
    // multi-number phrases, and free-form category naming that the
    // rule-based path kept failing on in live testing — see
    // lib/voiceExtract.ts). Falls back to the rule-based path
    // (voiceParse.ts + categoryGuess.ts) on any failure, so a Groq chat
    // outage degrades the feature instead of breaking it outright.
    const activeCategories = await prisma.category.findMany({ where: { householdId, isActive: true }, select: { name: true, type: true } });
    const expenseNames = activeCategories.filter(c => c.type === 'expense').map(c => c.name);
    const incomeNames = activeCategories.filter(c => c.type === 'income').map(c => c.name);

    let direction: 'income' | 'expense';
    let amount: number;
    let categoryId: number;
    let categorySource: string;

    const llmResult = await extractWithLLM(transcript, expenseNames, incomeNames, user.name).catch(() => null);
    if (llmResult) {
      direction = llmResult.direction;
      amount = llmResult.amount;
      const cat = activeCategories.find(c => c.name === llmResult.categoryName && c.type === llmResult.direction);
      // Belt-and-suspenders — extractWithLLM already validates the category
      // name against the list it was given, but re-resolving the id from
      // the same in-memory list (rather than trusting an id the model
      // never actually saw) means a model bug can't point at a category
      // that doesn't exist or doesn't match the direction.
      const resolved = cat ? await prisma.category.findFirst({ where: { householdId, name: cat.name, type: cat.type, isActive: true }, select: { id: true } }) : null;
      if (!resolved) {
        // Extremely unlikely given the validation above, but if it somehow
        // happens, fall through to the rule-based path rather than crash.
        ({ categoryId, source: categorySource } = await guessCategoryId(householdId, user.id, direction, transcript, undefined));
      } else {
        categoryId = resolved.id;
        categorySource = 'llm'; // extractWithLLM's own category guess, not guessCategoryId's chain
      }
    } else {
      // FR-004/FR-005 — an unparseable amount or ambiguous direction asks
      // for clarification instead of guessing; no transaction is created.
      const parsed = parseVoiceTransaction(transcript);
      if (!parsed) {
        await sendMessage(senderId, `Почув: "${transcript}". Не зрозумів суму або чи це витрата/дохід — скажіть, наприклад, "потратив 200 на каву" або "отримав 15000 зарплату".`);
        return NextResponse.json({ ok: true });
      }
      direction = parsed.direction;
      amount = parsed.amount;
      ({ categoryId, source: categorySource } = await guessCategoryId(householdId, user.id, direction, transcript, undefined));
    }

    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { name: true } });

    // Clean UTC midnight, not the exact receipt timestamp — matches the
    // Monobank webhook's convention (Date.UTC(...FullYear/Month/Date)):
    // a transaction records which day something happened, not the exact
    // minute. A raw `new Date()` here previously left messy timestamps that
    // verify-data-integrity.mjs's timezone-residue check correctly flagged
    // as the same class of bug already fixed once in this project.
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    let created;
    try {
      created = await prisma.transaction.create({
        data: {
          householdId,
          date: day,
          categoryId,
          amount: roundMoney(amount),
          details: transcript,
          userId: user.id,
          source: 'voice',
          categorySource,
          telegramMessageId: voice.file_unique_id,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return NextResponse.json({ ok: true }); // raced duplicate — a concurrent request already handled this exact voice message
      throw e;
    }

    await sendMessage(senderId, `Записано: ${created.amount} — ${category?.name ?? '?'} (${user.name})`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[webhooks/telegram POST]', e);
    // 200 even on an unexpected error — Telegram retries on non-200, and a
    // retry storm on a real bug is worse than one lost update visible in logs.
    return NextResponse.json({ ok: true });
  }
}
