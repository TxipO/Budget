// Full logical backup of the production Postgres (read-only: findMany only).
// Usage: node scripts/backup-db.mjs   (run by scripts/backup-db.ps1 / BudgetDbBackup task)
//
// Output: backups/budget-YYYYMMDD-HHmm.json.gz (+ copy in %USERPROFILE%\OneDrive\BudgetBackups)
//   { meta: { createdAt, prismaVersion, schemaHash, counts, redacted }, data: { model: rows[] } }
//
// Secrets (token/secret/hash/enc columns, AppSetting rows whose key looks secret) are
// replaced with null and listed in meta.redacted, so an offsite copy can't be used to
// forge webhooks. After a restore, reconnect Monobank / SpareBank and set the PIN again.
//
// RESTORE: create an empty DB (`prisma db push`), gunzip + JSON.parse, then insert
// data[model] rows with prisma.<model>.createMany in FK order:
//   household, user, category, householdLockout, sparebankAccount, monoCategoryRule,
//   transaction, monthlyPlan, appSetting, authLockout, magicLinkRequest.
// Dates are ISO strings (wrap in new Date), BigInt columns are strings (wrap in BigInt()).
// After inserting explicit ids, reset each @id sequence: SELECT setval(pg_get_serial_sequence(..), max(id)).
import { PrismaClient, Prisma } from '@prisma/client';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root); // Prisma resolves .env relative to cwd

const SECRET_COL = /(enc|secret|hash|token)$/i;
const SECRET_SETTING = /hash|secret|token|session|^pin|enc$/i;
const KEEP_LOCAL = 30, KEEP_ONEDRIVE = 90;

const prisma = new PrismaClient();
const models = Prisma.dmmf.datamodel.models; // every model, so new ones aren't silently missed

function jsonReplacer(_k, v) { return typeof v === 'bigint' ? v.toString() : v; }

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function prune(dir, keep) {
  const files = readdirSync(dir).filter((f) => /^budget-.*\.json\.gz$/.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) unlinkSync(join(dir, f));
}

async function main() {
  const data = {}, counts = {}, redacted = [];
  for (const m of models) {
    const delegate = prisma[m.name[0].toLowerCase() + m.name.slice(1)];
    const rows = await delegate.findMany();
    const secretCols = m.fields.filter((f) => f.kind === 'scalar' && SECRET_COL.test(f.name)).map((f) => f.name);
    for (const c of secretCols) redacted.push(`${m.name}.${c}`);
    for (const r of rows) {
      for (const c of secretCols) r[c] = null;
      if (m.name === 'AppSetting' && SECRET_SETTING.test(r.key)) { r.value = null; redacted.push(`AppSetting[${r.key}].value`); }
    }
    data[m.name] = rows;
    counts[m.name] = rows.length;
  }
  const schemaHash = createHash('sha256').update(readFileSync('prisma/schema.prisma')).digest('hex').slice(0, 16);
  const meta = { createdAt: new Date().toISOString(), prismaVersion: Prisma.prismaVersion.client, schemaHash, counts, redacted };
  const gz = gzipSync(Buffer.from(JSON.stringify({ meta, data }, jsonReplacer)));

  const name = `budget-${stamp()}.json.gz`;
  const localDir = join(root, 'backups');
  mkdirSync(localDir, { recursive: true });
  const localFile = join(localDir, name);
  writeFileSync(localFile, gz);

  // Verify by re-reading what is actually on disk.
  const back = JSON.parse(gunzipSync(readFileSync(localFile)).toString());
  for (const m of models) {
    if (back.data[m.name]?.length !== counts[m.name]) throw new Error(`verify failed: ${m.name} ${back.data[m.name]?.length} != ${counts[m.name]}`);
  }

  const oneDriveRoot = join(homedir(), 'OneDrive');
  let offsite = 'skipped (no OneDrive)';
  if (existsSync(oneDriveRoot)) {
    const od = join(oneDriveRoot, 'BudgetBackups');
    mkdirSync(od, { recursive: true });
    copyFileSync(localFile, join(od, name));
    if (statSync(join(od, name)).size !== gz.length) throw new Error('OneDrive copy size mismatch');
    prune(od, KEEP_ONEDRIVE);
    offsite = 'OneDrive';
  }
  prune(localDir, KEEP_LOCAL);

  console.log(`[backup] ${name} ${gz.length} bytes -> local + ${offsite}`);
  console.log(`[backup] counts ${JSON.stringify(counts)}`);
  console.log(`[backup] redacted ${redacted.join(', ')}`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error('[backup] FAILED:', e?.message ?? e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
