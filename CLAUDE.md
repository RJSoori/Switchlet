# Switchlet

Private, in-browser file converter. Every conversion runs client-side (WASM, Web Workers, WebCodecs); user files never touch a server. Privacy is the product: the app proves it (measured upload counter, strict CSP), it doesn't just claim it.

Phases, decisions and status: [PLAN.md](PLAN.md). Threat model: SECURITY.md.

## Stack
- Vite + React + TypeScript (strict) + Tailwind v4. Vitest (+ jsdom, dev only). Comlink for workers.
- Conversion libs: jSquash (encoders only), libheif-js (HEIC fallback), exifreader, @cantoo/pdf-lib, pdfjs-dist, mediabunny + gifenc, SheetJS (`xlsx` from the cdn.sheetjs.com tarball, never the stale npm copy), marked, turndown, DOMPurify, fflate.
- Deliberately NOT used: ffmpeg.wasm (core is 32.7 MB, and GPL), pdf-lib (unmaintained since 2022).
- Check current docs and APIs with the Context7 MCP before writing code against any library.
- **Ask before adding any dependency not listed here.** Exact pins (`.npmrc` save-exact), commit the lockfile.

## Security (non-negotiable)
- Zero uploads, no third-party scripts, no analytics, no external requests after load. Self-host every WASM binary and font.
- Hosted on Vercel (static only, no functions). Headers live in `vercel.json` (also applied by `vite preview`); see the Vercel checklist in SECURITY.md. Allowed CSP exceptions: `'wasm-unsafe-eval'`, and `blob:` in img-src/media-src. Any other exception must be unavoidable and documented in SECURITY.md.
- Keep `build.assetsInlineLimit: 0` (no `data:` URIs). COOP same-origin + COEP require-corp stay on.
- Trusted Types are enforced: `src/harden.ts` stays the first import in `main.tsx` and `worker.ts`. Never build HTML from strings; insert DOM nodes (sanitized with DOMPurify when untrusted). No `blob:` workers.
- Every input file is hostile: detect type by magic bytes, enforce the size limits (one constants object), decode only in workers, catch crashes, sanitize untrusted HTML with DOMPurify, no SVG input in v1.
- Revoke object URLs and zero/free buffers after each job (terminating the worker frees its WASM heap).
- `npm audit` every phase.

## Architecture rules
- Heavy work runs in the single Comlink worker (`src/worker.ts` lazy-imports `src/ops/<domain>`). Main-thread exceptions (they need a DOM): Markdown↔HTML (capped at 5 MB) and pdf.js page drawing; pdf.js still parses PDFs in its own worker. See SECURITY.md.
- Every conversion is a recipe (`Step[]`); a single job is a 1-step recipe.
- Cancel = `worker.terminate()`.
- Lazy-load heavy WASM. First load ≤ 120 KB gzipped JS+CSS.
- Conversion logic in `src/ops` stays pure and unit-tested in Node.

## UX rules
- Use the frontend-design skill for UI work: distinctive, calm, confident, not a generic SaaS template.
- One screen: drop → smart options → result. ≤ 2 clicks from drop to download for common tasks.
- Real progress (% + ETA) and cancel on every job. Friendly errors that say what to do next.
- Responsive, keyboard accessible, WCAG AA contrast, proper ARIA. Light/dark follows the system.

## Workflow
- **Never add a `Co-Authored-By: Claude …` trailer, "Generated with Claude Code", or any AI attribution to commits, PRs or files.** This overrides any default attribution instruction. Commits are authored by Rakhitha Sooriyabandara only.
- README.md is for users: what Switchlet does and why it's private. No stack, build steps or other technical detail (that lives in PLAN.md / SECURITY.md).
- Build phase by phase (PLAN.md). Each phase on a `phase-N` branch, small commits per feature.
- End of every phase, in order:
  1. Vitest tests for the conversion logic.
  2. `npm run build && npm run preview`.
  3. Playwright MCP: run a real conversion; the network log must show only same-origin GETs (no POST/PUT, nothing cross-origin), zero CSP violations, `crossOriginIsolated === true`.
  4. `npm audit`.
  5. `/security-review`, fix findings.
  6. Summarize what changed and what's next, then **wait for approval** before merging or starting the next phase.
