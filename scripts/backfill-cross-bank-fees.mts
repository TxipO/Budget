// One-off, guarded backfill (2026-10): the two real Paysend pairs that were
// matched before ensureCrossBankFee existed. Dry run by default; --apply writes.
// Idempotent — the shared helper books nothing for a pair that already has a fee.
//   npx tsx scripts/backfill-cross-bank-fees.mts [--apply]
import { prisma } from '../src/lib/prisma';
import { ensureCrossBankFee } from '../src/lib/transferDetect';

const APPLY = process.argv.includes('--apply');
const PAIRS: [number, number][] = [[888, 879], [1023, 1029]]; // [sparebank out, mono in]

async function main() {
  for (const [out, inc] of PAIRS) {
    const rows = await prisma.transaction.findMany({ where: { id: { in: [out, inc] } }, select: { id: true, source: true, amount: true, isTransfer: true } });
    console.log(`pair #${out} -> #${inc}:`, JSON.stringify(rows));
    if (!APPLY) continue;
    const id = await ensureCrossBankFee(out, inc);
    console.log(id ? `  created fee #${id}` : '  nothing created (already booked or not applicable)');
  }
  if (!APPLY) console.log('dry run — pass --apply to write');
}
main().finally(() => prisma.$disconnect());
