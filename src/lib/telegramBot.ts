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

export async function sendMessage(chatId: number, text: string): Promise<void> {
  await fetch(`${botApiBase()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {}); // best-effort — a failed confirmation reply must never fail the whole webhook
}

// Background alerts (cron, balance refresh) have no single "owner" to message:
// the connection's own user may have no Telegram linked while a household-mate
// does. Sends to every linked user of the household, deduped by chat id.
export async function notifyHousehold(householdId: number, text: string): Promise<void> {
  const users = await prisma.user.findMany({ where: { householdId, telegramId: { not: null } }, select: { telegramId: true } });
  for (const id of new Set(users.map(u => Number(u.telegramId)))) await sendMessage(id, text);
}
