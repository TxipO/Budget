// Print the last N (default 30) outgoing Telegram bot messages from NotificationLog.
// The Bot API can't read back sent messages, so this is the only history. Usage: node scripts/notifications.mjs [N]
import { PrismaClient } from '@prisma/client';

try { process.loadEnvFile('.env'); } catch { /* DATABASE_URL may already be set */ }
const prisma = new PrismaClient();
const n = Number(process.argv[2]) || 30;
const rows = await prisma.notificationLog.findMany({ orderBy: { createdAt: 'desc' }, take: n });
for (const r of rows.reverse()) {
  const chat = r.chatId ? `…${r.chatId.slice(-4)}` : '-';
  console.log(`${r.createdAt.toISOString()} ${r.kind} ${r.ok ? 'ok' : 'FAIL'} ${chat} ${r.text.replace(/\n/g, ' | ')}${r.error ? ` [${r.error}]` : ''}`);
}
await prisma.$disconnect();
