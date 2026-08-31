import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only favicon relay: the preview has no chrome `_favicon/` endpoint, and
// Google's favicon service neither sends CORS headers nor stays on one host
// (t0.gstatic.com load-balances via 301s), so the dev server fetches
// server-side — Node's fetch follows the redirects — and streams bytes back
// same-origin.
function faviconRelay(): Plugin {
  return {
    name: 'corral-favicon-relay',
    configureServer(server) {
      server.middlewares.use('/s2-favicon', (req, res) => {
        const domain = new URL(req.url ?? '', 'http://localhost').searchParams.get('domain') ?? '';
        const upstream = `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=32&url=${encodeURIComponent(`http://${domain}`)}`;
        fetch(upstream)
          .then(async (response) => {
            res.statusCode = response.status;
            res.setHeader('content-type', response.headers.get('content-type') ?? 'image/png');
            res.end(Buffer.from(await response.arrayBuffer()));
          })
          .catch(() => {
            res.statusCode = 502;
            res.end();
          });
      });
    },
  };
}

// One build serves both worlds: `vite` for the local preview, `vite build`
// for the unpacked Chrome extension (public/ carries the manifest and
// background script into dist/).
export default defineConfig({
  plugins: [react(), faviconRelay()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3100,
  },
});
