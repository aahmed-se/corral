import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One build serves both worlds: `vite` for the local preview, `vite build`
// for the unpacked Chrome extension (public/ carries the manifest and
// background script into dist/).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3100,
  },
});
