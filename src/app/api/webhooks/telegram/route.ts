import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { downloadVoice, sendMessage } from '@/lib/telegramBot';
import { transcribe } from '@/lib/groq';
import { parseVoiceTransaction } from '@/lib/voiceParse';
import { guessCategoryId } from '@/lib/categoryGuess';
import { roundMoney } from '@/lib/validate';

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
    if (!expectedSecret || receivedSecret !== expectedSecret) {
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
      select: { id: true, name: true },
    });
    if (!user) {
      await sendMessage(senderId, 'Цей Telegram не прив’язаний до жодного акаунту. Прив’яжіть його через застосунок (Налаштування → Обліковий запис), тоді голосові повідомлення почнуть логувати транзакції.');
      return NextResponse.json({ ok: true });
    }

    const audio = await downloadVoice(voice.file_id);
    if (!audio) {
      await sendMessage(senderId, 'Не вдалося завантажити голосове повідомлення. Спробуйте ще раз.');
      return NextResponse.json({ ok: true });
    }

    const transcript = await transcribe(audio);
    if (!transcript) {
      await sendMessage(senderId, 'Не вдалося розпізнати голосове повідомлення. Спробуйте сказати чіткіше.');
      return NextResponse.json({ ok: true });
    }

    // FR-004/FR-005 — an unparseable amount or ambiguous direction asks for
    // clarification instead of guessing; no transaction is created.
    const parsed = parseVoiceTransaction(transcript);
    if (!parsed) {
      await sendMessage(senderId, `Почув: "${transcript}". Не зрозумів суму або чи це витрата/дохід — скажіть, наприклад, "потратив 200 на каву" або "отримав 15000 зарплату".`);
      return NextResponse.json({ ok: true });
    }

    const categoryId = await guessCategoryId(user.id, parsed.direction, transcript, undefined);
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
          date: day,
          categoryId,
          amount: roundMoney(parsed.amount),
          details: transcript,
          userId: user.id,
          source: 'voice',
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
