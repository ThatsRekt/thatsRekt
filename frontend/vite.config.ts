import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
// Visualizer is a devDependency only; import unconditionally but gate
// its activation on the ANALYZE env var at runtime.
import { visualizer } from 'rollup-plugin-visualizer'

// Build config:
//   - base: '/'  absolute asset URLs. Required because the SPA uses
//                BrowserRouter (pathname routing) so the same
//                index.html is served at deep paths like
//                `/post/base/42`. With `base: './'` the browser would
//                resolve `./assets/x.js` to `/post/base/assets/x.js`
//                — broken. Pathname routing is in turn required so
//                Mesh can SSR Open Graph cards (see mesh/src/og.ts);
//                social-media crawlers don't fetch URL fragments.
//                Tradeoff: IPFS-gateway hosting is no longer trivial
//                — the site assumes hosting at the domain root with
//                SPA-fallback (nginx `try_files $uri /index.html`).
//   - sourcemaps off in prod to keep the bundle slim.
//   - emit assets into dist/.

// ---------------------------------------------------------------------------
// Prod Turnstile site-key guard
//
// Cloudflare test site keys are safe in dev/CI but must never be baked into
// a production bundle -- they bypass the CAPTCHA for every visitor.
//
// This plugin fails `pnpm build` if the build is explicitly supplied a
// known Cloudflare test site key. If VITE_TURNSTILE_SITE_KEY is absent,
// the bundle falls back to the test key at runtime (ApplyForm.tsx:43);
// for a full prod deploy you MUST pass the real site key at build time:
//
//   ARG VITE_TURNSTILE_SITE_KEY   (add to frontend/Dockerfile)
//   ENV VITE_TURNSTILE_SITE_KEY=${VITE_TURNSTILE_SITE_KEY}
//   --build-arg VITE_TURNSTILE_SITE_KEY=<real-site-key>  (in the CI pipeline)
//
// The corresponding secret key (TURNSTILE_SECRET) goes into the mesh container
// (already consumed by mesh/src/guardian.ts; guarded at boot by
// assertTurnstileSecretForProd in mesh/src/guardian.ts).
// ---------------------------------------------------------------------------

// Cloudflare-documented test site keys. These render a fake widget that
// always passes without a real verification. See:
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const CLOUDFLARE_TEST_SITE_KEYS = new Set([
  '1x00000000000000000000AA', // always-pass test site key
  '2x00000000000000000000BB', // always-block test site key
  '3x00000000000000000000FF', // challenges-always test site key
])

const prodTurnstileSiteKeyGuard = (): Plugin => ({
  name: 'prod-turnstile-site-key-guard',
  buildStart() {
    const siteKey = process.env.VITE_TURNSTILE_SITE_KEY
    if (
      process.env.NODE_ENV === 'production' &&
      siteKey !== undefined &&
      CLOUDFLARE_TEST_SITE_KEYS.has(siteKey)
    ) {
      throw new Error(
        '[vite] VITE_TURNSTILE_SITE_KEY is set to a Cloudflare test site key in a production build. ' +
        'This would bake the always-pass test key into the bundle and bypass Turnstile for every visitor. ' +
        'Set VITE_TURNSTILE_SITE_KEY to the real site key from your Cloudflare Turnstile widget.',
      )
    }
  },
})

// ---------------------------------------------------------------------------
// Bundle visualizer (ANALYZE=1 bun run build)
//
// Emits dist/stats.html — an interactive treemap showing which modules
// land in which chunks. Gated on ANALYZE so normal builds are unaffected.
// Usage: ANALYZE=1 bun run build && open dist/stats.html
// ---------------------------------------------------------------------------
const maybeVisualizer = (): Plugin | null => {
  if (!process.env.ANALYZE) return null
  return visualizer({
    filename: 'dist/stats.html',
    open: false,
    gzipSize: true,
    brotliSize: false,
    template: 'treemap',
  }) as Plugin
}

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    prodTurnstileSiteKeyGuard(),
    ...(maybeVisualizer() ? [maybeVisualizer() as Plugin] : []),
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React runtime — loaded on every page.
          react: ['react', 'react-dom', 'react-router-dom'],
          // Data-fetching layer — needed everywhere.
          query: ['@tanstack/react-query', 'graphql-request'],
          // Wallet / chain interaction — heavy but only needed for
          // the connect + vote / post flows. Deferred from main chunk
          // via this explicit split so it doesn't inflate first load.
          wagmi: ['wagmi', 'viem'],
          // Markdown rendering — pulled into a separate async chunk.
          // React.lazy in LazyMarkdown.tsx ensures this never rides
          // the homepage-critical JS path.
          markdown: ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
})
