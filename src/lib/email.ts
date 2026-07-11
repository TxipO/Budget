const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Budget <onboarding@resend.dev>';

// No RESEND_API_KEY configured yet (Resend account not set up) — log the
// link instead of sending, so the whole flow can be exercised end-to-end in
// dev without a real email provider. Never falls back like this once a key
// is present: a misconfigured/rejected send in production must fail loudly,
// not silently pretend it worked.
export async function sendMagicLinkEmail(to: string, link: string): Promise<void> {
  if (!RESEND_API_KEY) {
    console.log(`[email] RESEND_API_KEY not set — magic link for ${to}: ${link}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to,
      subject: 'Вхід у Бюджет',
      html: `<p>Натисніть, щоб увійти:</p><p><a href="${link}">${link}</a></p><p style="color:#888">Посилання дійсне 15 хвилин. Якщо ви не запитували вхід — просто проігноруйте цей лист.</p>`,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${text}`);
  }
}
