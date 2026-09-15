'use client';
import { toast } from '@/lib/toast';

// Downloads the Excel export via fetch instead of a plain <a href download>,
// so a FAILED response can actually be read and shown.
//
// Found live 2026-09-15: api/export deliberately "fails loudly" with a
// specific, actionable Ukrainian message (e.g. «Категорій типу "Витрати"
// (14) більше, ніж рядків у шаблоні (13). Розширте шаблон Excel перед
// експортом.») — and BOTH call sites threw that message away. The dashboard
// used a plain <a download>, so a 500 silently handed the user a file
// containing the error JSON; the transactions page checked res.ok but
// replaced the body with a generic «Помилка експорту». The household's
// export had been returning 500 for an unknown stretch of time with no way
// for them to find out why. A loud failure nobody can hear is a silent one.
//
// One shared implementation rather than two, for the same reason
// guessCategoryId was extracted once: two copies of the same concept drift
// (these two had already drifted into different error handling).
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  // The route sets RFC 5987 form: attachment; filename*=UTF-8''<percent-encoded>
  const match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null; // malformed encoding — fall back to the caller's default name
  }
}

export async function downloadExport(query: string): Promise<void> {
  try {
    const res = await fetch(`/api/export${query}`);
    if (!res.ok) {
      const serverMessage = await res.json().then(j => (typeof j?.error === 'string' ? j.error : null)).catch(() => null);
      // 8s, not the default — these messages are a full sentence with
      // numbers in them and tell the user exactly what to change; the
      // standard toast duration is too short to read one.
      toast(serverMessage || 'Помилка експорту', 'error', undefined, 8000);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filenameFromDisposition(res.headers.get('Content-Disposition')) || 'Бюджет.xlsx';
    a.click();
    URL.revokeObjectURL(url);
    toast('Excel збережено');
  } catch {
    toast('Помилка з’єднання', 'error');
  }
}
