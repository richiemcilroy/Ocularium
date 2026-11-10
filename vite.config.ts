import { defineConfig } from 'vite';

export default defineConfig({
  // Reached from other machines through `tailscale serve`, which supplies HTTPS (WebGPU needs a secure page).
  server: { port: 5199, strictPort: true, host: '127.0.0.1', allowedHosts: ['.ts.net'] },
  build: { target: 'es2023', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
