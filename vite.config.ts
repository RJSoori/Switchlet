/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// public/_headers is the single source of truth for security headers (Cloudflare Pages reads it).
// Apply its `/*` block to `vite preview` so local checks run under the real CSP / COOP / COEP.
const previewHeaders: Record<string, string> = {}
let block = ''
for (const line of readFileSync('public/_headers', 'utf8').split(/\r?\n/)) {
  if (!line.trim() || line.trim().startsWith('#')) continue
  if (!/^\s/.test(line)) { block = line.trim(); continue }
  const i = line.indexOf(':')
  if (block === '/*' && i > 0) previewHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim()
}

// Dev server: no CSP (Vite's HMR injects inline scripts), but keep cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

const wasmPackages = ['@jsquash/jpeg', '@jsquash/webp', '@jsquash/avif', '@jsquash/oxipng', 'libheif-js']

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { headers: isolation },
  preview: { headers: previewHeaders },
  optimizeDeps: { exclude: wasmPackages },
  worker: { format: 'es' },
  build: { assetsInlineLimit: 0 },
  test: { include: ['src/**/*.test.ts'] },
})
