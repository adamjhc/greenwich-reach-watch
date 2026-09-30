import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// The Cloudflare plugin runs the Worker in workerd during `vite dev` and
// builds it alongside the page. Settings for the Worker stay in wrangler.jsonc.
const config = defineConfig({
  plugins: [cloudflare()],
  build: { target: 'es2024', sourcemap: true },
});

export default config;
