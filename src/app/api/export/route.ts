import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import path from 'path';
import { readFile } from 'fs/promises';

const TYPE_UA: Record<string, string> = {
  income:  'Дохід',
  expense: 'Витрати',
  savings: 'Збереження',
};

const DATE_FMT = '[$-FC22]d\\ mmmm\\ yyyy" р."';

// ── Column mapping for Планування ─────────────────────────────────────────
// 2026: cols E-Q  (indices 5-17), 2027: S-AE (19-31), etc. step=14
const YEARS = [2026, 2027, 2028, 2029, 2030];

function monthCol(year: number, month: number): number {
  return 5 + (year - 2026) * 14 + (month - 1); // 1-based col index
}
function sumCol(year: number): number {
  return 5 + (year - 2026) * 14 + 12; // 13th col in block (sum)
}

// Section layout in Планування
const SECTIONS = [
  { type: 'income',  headerRow: 10, dataStart: 11, dataEnd: 20, sumRow: 21 },
  { type: 'expense', headerRow: 23, dataStart: 24, dataEnd: 36, sumRow: 37 },
  { type: 'savings', headerRow: 39, dataStart: 40, dataEnd: 49, sumRow: 50 },
] as const;

export async function GET(req: NextRequest) {
  try {
  const { searchParams } = req.nextUrl;
  const filterYear  = searchParams.get('year')  ? parseInt(searchParams.get('year')!)  : null;
  const filterMonth = searchParams.get('month') ? parseInt(searchParams.get('month')!) : null;

  // ── Fetch all data ──────────────────────────────────────────────────────
  const [categories, allTxs, allPlans] = await Promise.all([
    prisma.category.findMany({ orderBy: { id: 'asc' } }),
    prisma.transaction.findMany({
      include: { category: true, user: true },
      orderBy: { date: 'asc' },
    }),
    prisma.monthlyPlan.findMany({ where: { notes: { not: '' } } }),
  ]);

  // actuals[catId][year][month] = total
  const actuals: Record<number, Record<number, Record<number, number>>> = {};
  for (const tx of allTxs) {
    const d = new Date(tx.date);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const c = tx.categoryId;
    actuals[c] ??= {};
    actuals[c][y] ??= {};
    actuals[c][y][m] = (actuals[c][y][m] ?? 0) + tx.amount;
  }

  function getActual(catId: number, year: number, month: number): number {
    return actuals[catId]?.[year]?.[month] ?? 0;
  }
  function getCatYearTotal(catId: number, year: number): number {
    return Object.values(actuals[catId]?.[year] ?? {}).reduce((s, v) => s + v, 0);
  }

  // ── Build tx details index: (catId, year, month) → ["amount - detail", …] ─
  // Source of truth for Планування comments = real transactions with details
  const txDetails: Record<string, string[]> = {};
  for (const tx of allTxs) {
    const det = (tx.details ?? '').trim();
    if (!det || det === '[імпорт]') continue;
    const d = new Date(tx.date);
    const key = `${tx.categoryId}:${d.getFullYear()}:${d.getMonth() + 1}`;
    txDetails[key] ??= [];
    txDetails[key].push(`${Math.round(tx.amount)} - ${det}`);
  }

  // ── Also keep manual plan notes as fallback for cells with no tx details ─
  const planNotes: Record<string, string> = {};
  for (const p of allPlans) {
    planNotes[`${p.categoryId}:${p.year}:${p.month}`] = p.notes;
  }

  // Convert 1-based column number to Excel letter(s): 1→A, 26→Z, 27→AA …
  function colLetter(n: number): string {
    let s = '';
    while (n > 0) { s = String.fromCharCode(64 + (n % 26 || 26)) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // Build comments1.xml and vmlDrawing1.vml
  // Priority: tx details (auto) → manual plan notes (fallback)
  function buildComments(): { commentsXml: string; vmlXml: string } {
    const esc = (t: string) => t
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const commentEls: string[] = [];
    const vmlShapes: string[] = [];
    let shapeId = 1025;

    for (const section of SECTIONS) {
      const cats = categories.filter(c => c.type === section.type);
      for (let i = 0; i < cats.length; i++) {
        const cat = cats[i];
        const rowNum = section.dataStart + i;
        for (const year of YEARS) {
          for (let m = 1; m <= 12; m++) {
            const key = `${cat.id}:${year}:${m}`;
            // Combine both tx details (auto) and manual plan notes (fallback/addendum)
            const allNotes: string[] = [];
            if (txDetails[key]) allNotes.push(...txDetails[key]);
            if (planNotes[key]) allNotes.push(planNotes[key]);
            const note = allNotes.join('\n');
            if (!note) continue;
            const col = colLetter(monthCol(year, m));
            const ref = `${col}${rowNum}`;
            commentEls.push(
              `<comment authorId="0" ref="${ref}"><text><t xml:space="preserve">${esc(note)}</t></text></comment>`
            );
            // Minimal VML comment shape (hidden by default, positioned near cell)
            vmlShapes.push(
              `<v:shape id="_x0000_s${shapeId}" type="#_x0000_t202" style="position:absolute;margin-left:50pt;margin-top:5pt;width:100pt;height:50pt;z-index:1;visibility:hidden" fillcolor="#FFFFCC" o:insetmode="auto"><v:fill color2="#FFFFCC"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"/></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>0,0,0,0,2,0,4,4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${rowNum - 1}</x:Row><x:Column>${monthCol(year, m) - 1}</x:Column></x:ClientData></v:shape>`
            );
            shapeId++;
          }
        }
      }
    }

    const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author></author></authors><commentList>${commentEls.join('')}</commentList></comments>`;

    const vmlXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:pvml="urn:schemas-microsoft-com:office:powerpoint"><o:shapelayout v:ext="edit"><o:idmap data="1" v:ext="edit"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202.0" path="m,l,21600,l21600,21600l,21600xe"><v:stroke joinstyle="miter"/><v:path o:connecttype="rect"/></v:shapetype>${vmlShapes.join('')}</xml>`;

    return { commentsXml, vmlXml };
  }

  // ── Load template ───────────────────────────────────────────────────────
  const templatePath = path.join(process.cwd(), 'src', 'templates', 'Budget_template.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);

  // ═══════════════════════════════════════════════════════════════════════
  // ЛИСТ «ПЛАНУВАННЯ»
  // ═══════════════════════════════════════════════════════════════════════
  const wsPlan = wb.getWorksheet('Планування')!;

  // Write ONLY category names + month data cells.
  // Sum rows (21, 37, 50), row 7, row 8, and sum columns (Q, AE, AS, BG, BU)
  // already have live =SUM() / formula chains in the template — DON'T overwrite them.
  for (const section of SECTIONS) {
    const cats = categories.filter(c => c.type === section.type);

    for (let i = 0; i < section.dataEnd - section.dataStart + 1; i++) {
      const rowNum = section.dataStart + i;
      const cat = cats[i];

      if (cat) {
        wsPlan.getCell(rowNum, 3).value = cat.name;
      }

      for (const year of YEARS) {
        for (let m = 1; m <= 12; m++) {
          const val = cat ? getActual(cat.id, year, m) : null;
          wsPlan.getCell(rowNum, monthCol(year, m)).value = val || null;
        }
        // sumCol(year) has =SUM(E{row}:P{row}) formula in template — leave it
      }
    }
    // section.sumRow has =SUM() formulas — leave them
  }
  // Rows 7 and 8 have formula chains — leave them

  // ═══════════════════════════════════════════════════════════════════════
  // ЛИСТ «ВЕДЕННЯ»
  // ═══════════════════════════════════════════════════════════════════════
  const wsVed = wb.getWorksheet('Ведення')!;

  // Filter transactions for Ведення sheet
  const txsForVed = filterYear ? allTxs.filter(tx => {
    const d = new Date(tx.date);
    if (d.getFullYear() !== filterYear) return false;
    if (filterMonth && d.getMonth() + 1 !== filterMonth) return false;
    return true;
  }) : allTxs;

  // Clear existing data rows (12..1000)
  for (let r = 12; r <= 1000; r++) {
    const row = wsVed.getRow(r);
    let hasContent = false;
    for (const col of ['C','D','E','F','G','H']) {
      const cell = row.getCell(col);
      if (cell.value !== null && cell.value !== undefined && cell.value !== '') {
        hasContent = true;
        cell.value = null;
      }
    }
    if (!hasContent && r > txsForVed.length + 12) break;
  }

  // Fill with transactions
  txsForVed.forEach((tx, idx) => {
    const rn = 12 + idx;
    const row = wsVed.getRow(rn);

    const dateCell = row.getCell('C');
    dateCell.value  = new Date(tx.date);
    dateCell.numFmt = DATE_FMT;
    if (!dateCell.font?.name) {
      dateCell.font      = { name: 'Arial Narrow', size: 10, color: { argb: 'FF000000' } };
      dateCell.alignment = { horizontal: 'left', vertical: 'middle' };
    }

    const noFill: ExcelJS.Fill = { type: 'pattern', pattern: 'none' };

    const typeCell = row.getCell('D');
    typeCell.value = TYPE_UA[tx.category.type] ?? tx.category.type;
    typeCell.fill  = noFill;

    const catCell = row.getCell('E');
    catCell.value = tx.category.name;
    catCell.fill  = noFill;

    const amtCell = row.getCell('F');
    amtCell.value = tx.amount;
    amtCell.fill  = noFill;

    const detCell = row.getCell('G');
    const det = (tx.details ?? '') === '[імпорт]' ? '' : (tx.details ?? '');
    detCell.value = det || null;
    detCell.fill  = noFill;

    const whoCell = row.getCell('H');
    whoCell.value = tx.user?.name || null;
  });

  // ── Generate output ─────────────────────────────────────────────────────
  const rawBuffer = await wb.xlsx.writeBuffer();

  // Fix ExcelJS bugs via XML post-processing
  const zip = await JSZip.loadAsync(rawBuffer);

  // Restore empty drawing containers that ExcelJS strips (drawing1/2/3.xml, rels, refs)
  {
    const tmplBuf = await readFile(templatePath);
    const tmplZip = await JSZip.loadAsync(tmplBuf);
    const REL_NS  = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const DRW_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';

    for (const df of ['xl/drawings/drawing1.xml', 'xl/drawings/drawing2.xml', 'xl/drawings/drawing3.xml']) {
      const f = tmplZip.files[df];
      if (f) zip.file(df, await f.async('nodebuffer'));
    }

    // sheet1 (Планування): add drawing1.xml as rId6 to existing rels
    const s1rels = zip.files['xl/worksheets/_rels/sheet1.xml.rels'];
    if (s1rels) {
      let relsXml = await s1rels.async('string');
      relsXml = relsXml.replace(
        '</Relationships>',
        `<Relationship Id="rId6" Type="${DRW_TYPE}" Target="../drawings/drawing1.xml"/></Relationships>`
      );
      zip.file('xl/worksheets/_rels/sheet1.xml.rels', relsXml);
    }

    // sheet2 (Налаштування) and sheet3 (Ведення): create rels with single drawing ref
    for (const [sf, df] of [['sheet2.xml.rels','drawing2.xml'], ['sheet3.xml.rels','drawing3.xml']]) {
      const relsContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${DRW_TYPE}" Target="../drawings/${df}"/></Relationships>`;
      zip.file(`xl/worksheets/_rels/${sf}`, relsContent);
    }

    // Replace comments1.xml and vmlDrawing1.vml with DB notes
    const { commentsXml, vmlXml } = buildComments();
    zip.file('xl/comments1.xml', commentsXml);
    zip.file('xl/drawings/vmlDrawing1.vml', vmlXml);
  }

  // Pass 1: fix styles.xml and record new no-alignment style index for Ведення rows 18+
  let vedNoAlignStyleIdx = -1;
  {
    const stylesFile = zip.files['xl/styles.xml'];
    if (stylesFile) {
      let xml = await stylesFile.async('string');
      xml = xml
        .replace(/_\(\* \(#,##0\);/g, '_(* \\(#,##0\\);') // restore \( escape in numFmt
        .replace(/ wrapText="0"/g, '');                    // ExcelJS writes False, orig omits

      // Append a no-alignment variant of the empty-row data style (s=67 has wrong alignment).
      // Template s=80 (rows 18+) has fontId=20, fillId=0, no alignment.
      // ExcelJS remaps it to s=67 which has horizontal='left' — fix by adding a clean style.
      const countMatch = xml.match(/<cellXfs count="(\d+)"/);
      if (countMatch) {
        const oldCount = parseInt(countMatch[1]);
        vedNoAlignStyleIdx = oldCount; // new style appended at this index
        const newXf = `<xf numFmtId="0" fontId="20" fillId="0" borderId="0" xfId="0" applyFont="1"/>`;
        xml = xml
          .replace(`<cellXfs count="${oldCount}"`, `<cellXfs count="${oldCount + 1}"`)
          .replace('</cellXfs>', newXf + '</cellXfs>');
      }
      zip.file('xl/styles.xml', xml);
    }
  }

  // Pass 2: fix worksheet XMLs
  for (const [fname, file] of Object.entries(zip.files)) {
    if (!fname.startsWith('xl/worksheets/') || !fname.endsWith('.xml')) continue;
    let xml = await file.async('string');
    xml = xml
      .replace(/ operator="notContainsBlanks"/g, '') // invalid CF operator attr
      .replace(/ zoomScale="100"/g, '')              // ExcelJS adds explicit 100, orig omits
      // pageMargins: ExcelJS writes footer="0" header="0" but original has 0.0
      .replace(/(<pageMargins\b[^>]*\bfooter=)"0"/g,  '$1"0.0"')
      .replace(/(<pageMargins\b[^>]*\bheader=)"0"/g,  '$1"0.0"');

    // Fix Ведення (sheet3): cells D-G in rows 18+ got s=67 (has horizontal='left')
    // but template rows 18+ have no alignment — replace with clean no-alignment style.
    if (fname === 'xl/worksheets/sheet3.xml' && vedNoAlignStyleIdx >= 0) {
      xml = xml.replace(
        /(<c r="[DEFG](?:1[89]|[2-9]\d|\d{3,})"[^>]*)\bs="67"/g,
        `$1s="${vedNoAlignStyleIdx}"`
      );
      // Remove extra DV rule ExcelJS adds for D100:D200 (duplicate of D12:D200)
      xml = xml.replace(
        /<dataValidation\b[^>]*sqref="D100:D200"[^>]*>[\s\S]*?<\/dataValidation>\s*/g, ''
      );
      // Date DV formula: ExcelJS strips .0 from 1.0
      xml = xml.replace(
        /(<dataValidation[^>]*type="date"[^>]*>[\s\S]*?<formula1>)1(<\/formula1>)/g,
        '$11.0$2'
      );
    }

    // Fix Налаштування (sheet2): ExcelJS converts float 2026.0 → int 2026 for E7.
    // Original stores the starting year as a float; preserve the decimal point.
    if (fname === 'xl/worksheets/sheet2.xml') {
      xml = xml.replace(
        /(<c r="E7"[^>]*>)<v>(\d+)<\/v>/g,
        (_m, tag, val) => `${tag}<v>${val}.0</v>`
      );
      // Restore <drawing> ref that ExcelJS strips
      xml = xml.replace('</worksheet>', '<drawing r:id="rId1"/></worksheet>');
    }

    // Restore <drawing> ref in sheet1 (Планування) before <legacyDrawing>
    // Also fix ExcelJS attribute order: pane before activeCell — original has activeCell first
    if (fname === 'xl/worksheets/sheet1.xml') {
      xml = xml.replace('<legacyDrawing ', '<drawing r:id="rId6"/><legacyDrawing ');
      xml = xml.replace(
        /<selection pane="([^"]+)" activeCell="([^"]+)" sqref="([^"]+)"\/>/g,
        '<selection activeCell="$2" sqref="$3" pane="$1"/>'
      );
    }

    // Restore <drawing> ref in sheet3 (Ведення) before </worksheet>
    if (fname === 'xl/worksheets/sheet3.xml') {
      xml = xml.replace('</worksheet>', '<drawing r:id="rId1"/></worksheet>');
    }

    zip.file(fname, xml);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const MONTH_NAMES = ['Січень','Лютий','Березень','Квітень','Травень','Червень',
                       'Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
  const filename = filterYear
    ? filterMonth
      ? `Бюджет_${MONTH_NAMES[filterMonth - 1]}_${filterYear}.xlsx`
      : `Бюджет_${filterYear}.xlsx`
    : 'Бюджет_повний.xlsx';

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
  } catch (e) {
    console.error('[export GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
