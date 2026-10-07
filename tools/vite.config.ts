import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const root = fileURLToPath(new URL('../', import.meta.url));
export default defineConfig({
  root,
  cacheDir: fileURLToPath(new URL('../.generated/vite-cache', import.meta.url)),
  plugins: [react(), cloudflare({configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))})],
});
