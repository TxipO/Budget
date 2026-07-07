/** @type {import('next').NextConfig} */

// Content-Security-Policy is NOT set here — it needs a fresh nonce per
// request (Next.js App Router injects dynamic inline hydration scripts
// whose content differs on every request, so only a nonce can allowlist
// them; a fixed hash here broke all client-side interactivity in
// production). See src/middleware.ts's buildCsp/withCsp for the real CSP.
const nextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Belt-and-suspenders alongside middleware's frame-ancestors —
          // older browsers that don't support CSP frame-ancestors still
          // respect X-Frame-Options, closing the clickjacking gap for them.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
