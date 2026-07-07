/** @type {import('next').NextConfig} */

// 'sha256-RrXAm...' allowlists the ONE static inline script in
// src/app/layout.tsx (theme-detection FOUC guard) — its content never
// changes, so a hash is simpler and safer than a per-request nonce (which
// would force every page from static to dynamic rendering). If that inline
// script's content is ever edited, recompute the hash:
//   node -e "console.log('sha256-'+require('crypto').createHash('sha256').update(SCRIPT_TEXT,'utf8').digest('base64'))"
const THEME_SCRIPT_HASH = "'sha256-RrXAmPDj6nICY3LIze9VK1Crg6EVs7pSEfpAtJXfFsM='";

const csp = [
  "default-src 'self'",
  `script-src 'self' ${THEME_SCRIPT_HASH}`,
  // React inline `style={{}}` compiles to actual style="..." attributes,
  // which CSP's style-src also governs — 'unsafe-inline' is required here
  // since this app uses inline styles throughout, not just in <style> tags.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig = {
  async headers() {
    const headers = [
      // Belt-and-suspenders alongside frame-ancestors above — older
      // browsers that don't support CSP frame-ancestors still respect
      // X-Frame-Options, so this closes the clickjacking gap for them too.
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ];
    // CSP only in production: Next dev mode's webpack HMR bundle relies on
    // eval() for source-mapped modules, which needs 'unsafe-eval' — a hole
    // not worth opening just to let a strict CSP coexist with dev tooling.
    // localhost during `next dev` isn't the real attack surface anyway.
    if (process.env.NODE_ENV === 'production') {
      headers.push({ key: 'Content-Security-Policy', value: csp });
    }
    return [{ source: '/:path*', headers }];
  },
};

export default nextConfig;
