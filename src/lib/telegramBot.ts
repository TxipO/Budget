// Thin wrapper around the Telegram Bot API methods needed for voice
// logging — matches this project's existing pattern of small, purpose-built
// API clients (lib/monobank.ts, lib/crypto.ts) instead of pulling in an SDK
// for a couple of HTTP calls.

import { prisma } from '@/lib/prisma';

function botApiBase(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');
  return `https://api.telegram.org/bot${token}`;
}

// Telegram webhooks deliver a file_id, never the file itself — getFile
// resolves it to a downloadable path, per contracts/telegram-webhook.md.
export async function downloadVoice(fileId: string): Promise<Buffer | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  const fileRes = await fetch(`${botApiBase()}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!fileRes.ok) return null;
  const fileData = await fileRes.json().catch(() => null);
  const filePath = fileData?.result?.file_path;
  if (typeof filePath !== 'string' || !filePath) return null;

  const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!audioRes.ok) return null;
  return Buffer.from(await audioRes.arrayBuffer());
}

// Every send is recorded in NotificationLog (the Bot API can't read back what the bot
// sent). Logging is best-effort and never throws or delays the result of the send.
export async function sendMessage(chatId: number, text: string, opts: { kind?: string; householdId?: number } = {}): Promise<void> {
  let ok = false;
  let error: string | null = null;
  try {
    const res = await fetch(`${botApiBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    ok = res.ok;
    if (!ok) error = `${res.status} ${await res.text().catch(() => '')}`;
  } catch (e) { // best-effort — a failed confirmation reply must never fail the whole webhook
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    // the bot token sits in the request URL; never let it reach the log
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (error && token) error = error.split(token).join('***');
    await prisma.notificationLog.create({
      data: { householdId: opts.householdId ?? null, chatId: String(chatId), kind: opts.kind ?? 'reply', text, ok, error: error?.slice(0, 300) ?? null },
    });
  } catch (e) { console.error('[telegramBot] NotificationLog write failed', e instanceof Error ? e.message : e); }
}

// Background alerts (cron, balance refresh) have no single "owner" to message:
// the connection's own user may have no Telegram linked while a household-mate
// does. Sends to every linked user of the household, deduped by chat id.
export async function notifyHousehold(householdId: number, text: string): Promise<void> {
  const users = await prisma.user.findMany({ where: { householdId, telegramId: { not: null } }, select: { telegramId: true } });
  for (const id of new Set(users.map(u => Number(u.telegramId)))) await sendMessage(id, text, { kind: 'alert', householdId });
}
