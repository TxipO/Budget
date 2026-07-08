import { headers } from 'next/headers';
import LoginForm from './LoginForm';

// Server Component wrapper so the CSP nonce (only readable via next/headers,
// which Client Components can't call) reaches the Telegram widget's external
// <script> tag — 'strict-dynamic' CSP trusts it by nonce, not host allowlist.
export default function LoginPage() {
  const nonce = headers().get('x-nonce') ?? undefined;
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;

  return <LoginForm nonce={nonce} botUsername={botUsername} />;
}
