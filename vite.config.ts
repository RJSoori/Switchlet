/// <reference types="vitest/config" />
import { readdirSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// vercel.json is the single source of truth for security headers (Vercel serves them).
// Apply its all-paths rule to `vite preview` so local checks run under the real CSP / COOP / COEP.
type HeaderRule = { source: string; headers: { key: string; value: string }[] }
const rules = (JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: HeaderRule[] }).headers
const previewHeaders = Object.fromEntries(rules.find((r) => r.source === '/(.*)')!.headers.map((h) => [h.key, h.value]))

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

// The service worker is built from src/sw.ts to a stable /sw.js. After every other file is emitted, its
// placeholders get the full precache list (everything the app can ever load, so it works offline) and a
// version derived from those (content-hashed) names.
function serviceWorker(): Plugin {
  return {
    name: 'switchlet:service-worker',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const sw = bundle['sw.js']
        if (!sw || sw.type !== 'chunk') return
        const publicFiles = readdirSync('public', { recursive: true, withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => `${d.parentPath.replace(/\\/g, '/').replace(/^public\/?/, '')}/${d.name}`.replace(/^\//, ''))
        const files = ['/', ...[...Object.keys(bundle), ...publicFiles].filter((f) => f !== 'sw.js' && !f.endsWith('.map')).map((f) => `/${f}`)].sort()
        let hash = 2166136261 // FNV-1a over the file list
        for (const ch of files.join('\n')) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0
        sw.code = sw.code.replace('__PRECACHE__', JSON.stringify(files)).replace('__VERSION__', JSON.stringify(hash.toString(36)))
      },
    },
  }
}

// First-load budget: the JS and CSS that index.html loads must stay within 120 KB gzipped, or the build fails.
function firstLoadBudget(): Plugin {
  const BUDGET = 120_000 // kB as Vite reports them
  return {
    name: 'switchlet:first-load-budget',
    apply: 'build',
    closeBundle() {
      const html = readFileSync('dist/index.html', 'utf8')
      const files = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!)
      const bytes = files.reduce((n, f) => n + gzipSync(readFileSync(`dist/${f}`)).length, 0)
      const kb = `${(bytes / 1000).toFixed(1)} KB`
      if (bytes > BUDGET) throw new Error(`First load is ${kb} gzipped, over the 120 KB budget (${files.join(', ')})`)
      console.log(`First load: ${kb} gzipped (budget 120 KB)`)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets(), serviceWorker(), firstLoadBudget()],
  // Fixed local ports, clear of Vite's defaults (5173/4173) and of other local projects on 5174/5175;
  // strictPort fails loudly instead of drifting, so checks never hit another app. Vite's defaults keep
  // both servers loopback-only (host 'localhost', localhost-only CORS, allowedHosts []); don't loosen them.
  server: { port: 5180, strictPort: true, headers: isolation },
  preview: { port: 5181, strictPort: true, headers: previewHeaders },
  optimizeDeps: { exclude: wasmPackages },
  worker: { format: 'es' },
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { index: 'index.html', sw: 'src/sw.ts' },
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
})
