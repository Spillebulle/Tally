import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    // Dev server talks to the backend running on 8080.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // The rating marks are never inlined. Most are small enough that Vite
    // would base64 them into the main bundle by default — about 49 kB of
    // marks on every page load, for a picker most sessions never open. As
    // separate files they are fetched only when a certificate is shown, and
    // cached thereafter. Everything else keeps the default threshold.
    assetsInlineLimit: (filePath) =>
      filePath.includes('assets/ratings/') ? false : undefined,
  },
})
