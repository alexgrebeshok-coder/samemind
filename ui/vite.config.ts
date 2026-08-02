import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Build output lands in the package's dist/, which tools/ui.mjs serves (index.html + /assets/*).
// base './' keeps asset URLs relative so the SPA works from any mount path.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: { outDir: '../dist', emptyOutDir: true },
  // tools/ui.mjs DEFAULT_PORT is 7787 — keep the vite /api proxy on the same port so
  // `npm run dev` (ui/) talks to a running `samemind ui` without a second listener.
  server: { proxy: { '/api': 'http://127.0.0.1:7787' } },
});
