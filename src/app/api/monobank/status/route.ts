import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireHouseholdId } from '@/lib/household';

// Never touches Monobank's own API (no rate-limit cost) — just reports what's
// stored locally. monoTokenEnc itself never leaves this route; only whether
// it's set.
export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // householdId filter — without it this leaked every household's member
    // names and Monobank connection status into every other household's
    // Settings page.
    const users = await prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true, monoAccountId: true, monoTokenEnc: true, monoWebhookSecret: true },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(users.map(u => ({
      userId: u.id,
      name: u.name,
      // Both, not just the token — a token without a webhookSecret means
      // Monobank has nowhere valid to push transactions (the webhook URL
      // embeds the secret), so sync is silently broken even though a token
      // is stored. Found live: exactly this state existed undetected
      // because this route only checked monoTokenEnc.
      connected: u.monoTokenEnc !== null && u.monoWebhookSecret !== null,
      accountId: u.monoAccountId,
    })));
  } catch (e) {
    console.error('[monobank/status GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
