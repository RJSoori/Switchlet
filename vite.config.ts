/// <reference types="vitest/config" />
import { readdirSync, readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
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

// Self-host pdf.js's data files at /pdfjs/ (fonts, character maps, colour profiles, image decoders).
// Leaves out the quickjs scripting sandbox (Switchlet never runs scripts embedded in PDFs) and the
// no-WASM fallbacks (every browser Switchlet supports has WebAssembly).
const PDFJS = 'node_modules/pdfjs-dist'
const pdfjsFiles = () =>
  ['cmaps', 'standard_fonts', 'iccs', 'wasm'].flatMap((dir) =>
    readdirSync(`${PDFJS}/${dir}`).filter((f) => !/^quickjs|_nowasm_fallback/.test(f)).map((f) => `${dir}/${f}`),
  )
function pdfjsAssets(): Plugin {
  return {
    name: 'switchlet:pdfjs-assets',
    configureServer(server) {
      const files = new Set(pdfjsFiles())
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const file = decodeURIComponent((req.url ?? '').split('?')[0]!.slice(1))
        if (!files.has(file)) return next()
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
        res.end(readFileSync(`${PDFJS}/${file}`))
      })
    },
    generateBundle() {
      for (const file of pdfjsFiles()) this.emitFile({ type: 'asset', fileName: `pdfjs/${file}`, source: readFileSync(`${PDFJS}/${file}`) })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  server: { headers: isolation },
  preview: { headers: previewHeaders },
  optimizeDeps: { exclude: wasmPackages },
  worker: { format: 'es' },
  build: { assetsInlineLimit: 0 },
  test: { include: ['src/**/*.test.ts'] },
})
