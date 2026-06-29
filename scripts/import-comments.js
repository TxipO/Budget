// node scripts/import-comments.js [path/to/Budget.xlsx]
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { spawnSync } = require('child_process');
const dbPath  = path.resolve(__dirname, '../prisma/budget.db');
process.env.DATABASE_URL = `file:${dbPath}`;
const { PrismaClient } = require('@prisma/client');
const XLSX = require('xlsx');

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const JAN_COL = 4; // January = Excel col E (absolute 0-indexed: A=0,B=1,C=2,D=3,E=4)

function cleanName(raw) {
  if (raw && String(raw).includes('пчола')) return 'Женя';
  return String(raw).trim();
}

// Extract a zip entry to a temp file (preserves UTF-8 correctly)
function extractZipEntry(zipPath, entryName) {
  const tmpFile = path.join(os.tmpdir(), 'xlsx_entry_' + Date.now() + '.xml');
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
    `$z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}');`,
    `$e = $z.Entries | Where-Object { $_.FullName -eq '${entryName}' };`,
    "if (-not $e) { $z.Dispose(); exit 1 }",
    "$s = $e.Open();",
    "$r = New-Object System.IO.StreamReader($s, [System.Text.Encoding]::UTF8);",
    "$c = $r.ReadToEnd();",
    "$r.Dispose(); $z.Dispose();",
    `[System.IO.File]::WriteAllText('${tmpFile.replace(/\\/g, '\\\\')}', $c, [System.Text.Encoding]::UTF8);`,
  ].join(' ');

  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (r.status !== 0 || !fs.existsSync(tmpFile)) return null;
  const content = fs.readFileSync(tmpFile, 'utf8');
  fs.unlinkSync(tmpFile);
  return content;
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Parse threaded comments: <x18tc:threadedComment ref="J30" ...><x18tc:text>...</x18tc:text>
function parseThreadedComments(xml) {
  const out = [];
  const re = /threadedComment[^>]+ref="([^"]+)"[\s\S]*?<[^>]*?:text[^>]*>([\s\S]*?)<\/[^>]*?:text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = m[2]
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
      .replace(/\r\n/g,'\n').replace(/\r/g,'\n').trim();
    if (text) out.push({ ref: m[1], text });
  }
  return out;
}

// Parse classic Notes: collect all <t> text inside a <comment>
function parseClassicNotes(xml) {
  const out = [];
  // Skip entries that are threaded-comment placeholders
  const commentRe = /<comment\b[^>]+ref="([^"]+)"[\s\S]*?<\/comment>/g;
  let cm;
  while ((cm = commentRe.exec(xml)) !== null) {
    const ref   = cm[1];
    const block = cm[0];
    // Collect all text from <t> tags
    const tRe = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
    let tm, parts = [];
    while ((tm = tRe.exec(block)) !== null) {
      const t = tm[1]
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&quot;/g,'"').replace(/&apos;/g,"'");
      if (t.trim()) parts.push(t.trim());
    }
    const text = parts.join(' ').trim();
    // Skip the Excel compatibility warning for threaded comments
    if (!text || text.startsWith('[Threaded comment]') || text.includes('go.microsoft.com')) continue;
    out.push({ ref, text });
  }
  return out;
}

async function main() {
  const xlsxPath = process.argv[2] || path.join(os.homedir(), 'Downloads', 'Budget.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    console.error(`Файл не знайдено: ${xlsxPath}`); process.exit(1);
  }
  console.log(`Читаємо: ${xlsxPath}\n`);

  // 1. Parse comments
  const tcXml    = extractZipEntry(xlsxPath, 'xl/threadedComments/threadedComment1.xml');
  const notesXml = extractZipEntry(xlsxPath, 'xl/comments1.xml');

  const tcComments    = tcXml    ? parseThreadedComments(tcXml)  : [];
  const notesComments = notesXml ? parseClassicNotes(notesXml)   : [];

  // Merge: threaded comments take priority; skip cells already covered by threaded
  const tcRefs = new Set(tcComments.map(c => c.ref));
  const merged = [...tcComments, ...notesComments.filter(c => !tcRefs.has(c.ref))];

  console.log(`Threaded comments: ${tcComments.length}`);
  console.log(`Classic notes:     ${notesComments.length} (після фільтрації дублів: ${merged.length - tcComments.length})`);
  console.log(`Всього:            ${merged.length}\n`);

  // 2. Row→category map
  const wb   = XLSX.readFile(xlsxPath);
  const ws   = wb.Sheets['Планування'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const rowToCat = new Map();
  let section = null;
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i]?.[0];
    if (!cell) continue;
    const s = String(cell).trim();
    if (s === 'Дохід')      { section = 'income';  continue; }
    if (s === 'Витрати')    { section = 'expense'; continue; }
    if (s === 'Збереження') { section = 'savings'; continue; }
    if (!section || /^(Сума|Встановіть|Буде|Накоп)/.test(s)) continue;
    rowToCat.set(i, { name: cleanName(s), type: section });
  }

  // 3. Save
  const mn = ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'];
  let saved = 0, skipped = 0;

  for (const { ref, text } of merged) {
    const match = ref.match(/^([A-Z]+)(\d+)$/i);
    if (!match) { skipped++; continue; }

    const colIdx = colToIndex(match[1].toUpperCase());
    const rowIdx = parseInt(match[2]) - 1;
    const month  = colIdx - JAN_COL + 1;

    if (month < 1 || month > 12) { skipped++; continue; }

    const catInfo = rowToCat.get(rowIdx);
    if (!catInfo) { skipped++; continue; }

    const cat = await prisma.category.findFirst({ where: { name: catInfo.name, type: catInfo.type } });
    if (!cat) {
      console.log(`  [skip] ${ref}: категорія "${catInfo.name}" не в БД`);
      skipped++; continue;
    }

    await (prisma.monthlyPlan).upsert({
      where:  { year_month_categoryId: { year: 2026, month, categoryId: cat.id } },
      update: { notes: text },
      create: { year: 2026, month, categoryId: cat.id, plannedAmount: 0, notes: text },
    });
    console.log(`  ✓ [${mn[month-1]}] ${catInfo.name}: "${text.replace(/\n/g,' | ')}"`);
    saved++;
  }
  console.log(`\nГотово: збережено ${saved}, пропущено ${skipped}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
