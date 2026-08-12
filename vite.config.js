import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, so the built site works wherever it's served from — a GitHub
  // project page at /<repo>/, a user page at /, or a custom domain — without
  // the repo name being baked in anywhere.
  base: './',
  build: {
    // the shaders runtime is one big lazy chunk by design; it only downloads
    // if someone asks for ?water=shaders
    chunkSizeWarningLimit: 3000,
  },
});
