# Switchlet — private, in-browser file converter

**Status:** Phases 1–4 merged to `main` (Phase 4: recipes, PWA, share target, command palette; merged 2026-11-02). Phase 5 (polish and hardening) built and verified on branch `phase-5` (2026-11-02), waiting for review before merging. Local ports: dev 5180, preview 5181.
Phase 1 deviations: `@jsquash/png` dropped (OxiPNG encodes raw pixels); the privacy panel's headline number is *requests to other servers* (measured) until the Phase 4 service worker can measure upload bytes.
Phase 2 deviations: pdf.js draws pages on the main thread (its display layer needs a DOM; parsing stays in pdf.js's worker), documented in CLAUDE.md and SECURITY.md. PDF to images uses the browser's canvas encoder, not jSquash. Merge, split and reorder drop bookmarks and form fields.
Phase 3 deviations: no MP3 output (would need an extra encoder package); audio formats are M4A (AAC), Ogg (Opus) and WAV. Trim copies from the nearest keyframe when it can instead of always re-encoding. Media tasks run on a button press, not on every settings change.
Phase 4 deviations: a recipe holds one step (links with more are refused as "needs a newer version"). History records downloads (up to 3 file names plus a count, the task and the date), not failed jobs or sizes. Shared files wait behind an "Open?" prompt, because any website can post files to the share target. The precache is 5.8 MB brotli and is skipped when Data Saver is on. A pinned recipe runs only on files it fits; otherwise a notice says so.
Phase 5 deviations: Trusted Types kept (enforced, two policies). WebRTC is removed in script, not by the CSP `webrtc` directive, which no browser supports yet. Transparent videos are copied without their alpha layer before decoding, because Mediabunny's alpha workers use `blob:` URLs the CSP refuses. The first-load budget is enforced by the build (fails over 120 KB), and contrast by a unit test. The dark theme's `line` colour was lightened (#5E7068 → #61736B) to reach 3:1 on fields.

## Context
This is a new build in an empty folder, `R:\Projects\Switchlet`. The app is a file converter where nothing is ever uploaded: every conversion runs in the browser using WASM, Web Workers and the browser's built-in codecs. Privacy is the product, and the app has to show it, not just claim it. It should be fast, need no sign-up, be strictly secured, and keep people coming back with recipes, offline use and a share target.

**Decisions from planning research** (registry and docs checked 2026-11-01):
- **Video:** Mediabunny + WebCodecs instead of ffmpeg.wasm. The ffmpeg core WASM is 32.7 MB, but Cloudflare Pages allows at most 25 MiB per file. It is also GPL and hasn't been released since Apr 2025. Mediabunny is about 0.3 MB, MPL-2.0, and uses hardware-accelerated codecs.
- **PDF:** `@cantoo/pdf-lib`, a maintained fork with the same API, instead of `pdf-lib`, which hasn't had a release since 2022.
- **SheetJS:** installed from SheetJS's own tarball (`xlsx-0.20.3`), because the npm copy is stuck at 0.18.5. The lockfile pins it with an integrity hash.
- **Approved new dependencies:** `fflate` (ZIP), `marked` + `turndown` (Markdown ↔ HTML), `exifreader` (metadata report), `jsdom` (dev only), `gifenc` (GIF encoding, which comes with the Mediabunny choice).
- **Image decoding and resizing** use the browser's own `createImageBitmap` and `OffscreenCanvas`, so `@jsquash/resize` and the jSquash decoders aren't needed. jSquash is used only for encoding (MozJPEG, WebP, AVIF, PNG + OxiPNG), to get the same quality in every browser. HEIC is decoded natively where the browser supports it (Safari) and falls back to libheif-js.
- **Offline support:** a hand-written service worker of about 80 readable lines instead of Workbox. A short worker you can read yourself supports the "prove it" promise.
- **COOP/COEP headers stay.** jSquash's multithreaded AVIF encoder needs SharedArrayBuffer, and the headers also add process isolation.

> **Before Phase 1:** restart Claude Code so the Context7 and Playwright MCP servers load. They aren't available in this session. I'll check every library API with Context7 before writing code against it.

## Architecture

```
drop / paste / picker / share-target
        │
   core/detect.ts ── reads the first 4 KB: magic bytes → Kind (jpeg, heic, pdf, mp4, xlsx, csv…)
        │
   core/ops.ts ───── registry: op {id, accepts: Kind[], produces: Kind, defaults, validate, domain}
        │            UI shows only ops whose `accepts` includes the detected Kind
        │
   core/jobs.ts ──── runs a recipe (Step[]) over N files on a pool of workers
        │            progress %, ETA, cancel = worker.terminate(), errors → friendly messages
        │
   src/worker.ts ─── ONE Comlink worker entry; lazy `import('./ops/<domain>')`
        │            so heavy WASM loads only when that domain is first used
   ops/*.ts ──────── pure conversion code (image, heic, scrub, pdf, media, sheet); unit-tested in Node
```

Key simplifications:
- **Every conversion is a recipe.** A single conversion is a 1-step recipe, and batch mode runs the same recipe over N files. "Save as recipe" just stores the steps already in use, so jobs, recipes and history share one model.
- **Cancel = `worker.terminate()`.** It's the only way to stop WASM partway through. It also frees the whole WASM heap, which is the strongest available buffer wipe, and isolates crashes caused by hostile files.
- **Docs ops (Markdown ↔ HTML) run on the main thread**, because DOMPurify and turndown need a DOM. They are capped at 5 MB. CSV/JSON/XLSX processing runs in the worker.
- **State:** `useReducer` plus context. No state library, no router (the app is one screen), no component library.

## Folder structure
```
R:\Projects\Switchlet\            (git repo, package name "switchlet")
├─ CLAUDE.md  SECURITY.md  .gitignore  .npmrc (save-exact=true)
├─ index.html  vite.config.ts  tsconfig.json (strict)  package.json
├─ public/
│  ├─ _headers                 # single source of truth; vite.config applies it to `vite preview` too
│  ├─ manifest.webmanifest  icons/  fonts/ (self-hosted woff2, OFL)
│  └─ pdfjs/                   # cmaps + standard fonts, copied from pdfjs-dist by a vite build hook
├─ src/
│  ├─ main.tsx  App.tsx  styles.css
│  ├─ ui/                      # DropZone, Options, Result (before/after), Progress, PageSorter,
│  │                           # CommandPalette (<dialog>), PrivacyPanel, Recipes, History
│  ├─ core/  detect.ts  ops.ts  jobs.ts  recipes.ts  db.ts (~25-line IndexedDB wrapper)
│  ├─ ops/   image.ts  heic.ts  scrub.ts  pdf.ts  media.ts  sheet.ts  docs.ts
│  ├─ worker.ts                # Comlink expose; dynamic-imports ops by domain
│  └─ sw.ts                    # offline cache, share target, upload meter
└─ test/fixtures/              # tiny sample files (JPEG with GPS EXIF, PDF, short MP4…)
```
Tests sit next to the code they test (`src/**/*.test.ts`).

## Dependencies (exact pins via `.npmrc save-exact`; I'll re-check for patch releases at install time)
| Package | Version | Why |
|---|---|---|
| vite, @vitejs/plugin-react | 8.3.5, latest | build; module workers; `?url` WASM assets |
| react, react-dom | 19.3.1 | UI |
| typescript | 7.0.2 | strict type-check (fall back to 6.x if a tool needs the old JS API) |
| tailwindcss, @tailwindcss/vite | 4.3.3 | styling; dark mode follows the system via the media query |
| vitest (+ jsdom, dev) | 5.0.5 | unit tests |
| comlink | 4.4.2 | worker RPC |
| @jsquash/jpeg, webp, avif, png, oxipng | 1.6.0, 1.5.0, 2.1.1, 3.1.1, 2.3.0 | encoders (MozJPEG/WebP/AVIF/PNG optimise) |
| libheif-js | 1.23.5 | HEIC decode fallback (LGPL-3.0: ship license + source link) |
| exifreader | 4.52.0 | "what was removed" report across JPEG/PNG/WebP/HEIC/AVIF |
| @cantoo/pdf-lib | 2.11.1 | merge/split/reorder/images→PDF/metadata scrub/compress |
| pdfjs-dist | 6.4.299 | thumbnails, PDF→images (`isEvalSupported:false`) |
| mediabunny, gifenc | 1.65.0, 1.0.3 | MP4/MOV/WebM convert, trim, extract audio; GIF |
| xlsx (SheetJS tarball) | 0.20.3 | CSV ↔ JSON ↔ XLSX |
| marked, turndown, dompurify | 18.1.2, 7.2.4, 3.4.17 | Markdown↔HTML; sanitise all untrusted HTML |
| fflate | 0.8.3 | batch ZIP (level 0 for already-compressed outputs) |

## Security design
`public/_headers` (Cloudflare Pages; the same file is applied to `vite preview`, so tests run against the real policy):
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types default dompurify
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), display-capture=(), browsing-topics=()
  X-DNS-Prefetch-Control: off
  Strict-Transport-Security: max-age=63072000
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```
CSP exceptions, explained:
- **`'wasm-unsafe-eval'`** allows compiling WASM only; JS `eval` stays blocked.
- **`blob:` in `img-src` and `media-src`** shows previews of results that exist only in memory. Blob URLs never touch the network.
- **Nothing else.** Any further exception a library forces (for example `blob:` workers) gets added only if it's unavoidable, and is documented in SECURITY.md.

Supporting settings:
- `build.assetsInlineLimit: 0`, so no `data:` URIs appear.
- The dev server has no CSP, because Vite's hot reload injects inline scripts. Production-like checks always run against `vite preview`.

Hostile-input handling:
- **Detection:** file type comes from magic bytes; the extension is only a tiebreaker for text formats.
- **Size limits:** one constants object, initially: images 200 MB / 100 MP (header dimensions checked for PNG, JPEG, GIF and WebP); PDFs 500 MB; video 4 GB in (streamed) / 2 GB out; sheets 50 MB; MD/HTML 5 MB; batches of 200 files.
- **Crash containment:** every decoder runs in a worker. A crash or OOM is caught, the worker is terminated and respawned, and the user sees a friendly "This file looks damaged…" message.
- **Untrusted HTML:** always passed through DOMPurify and never put in an iframe. CSP `img-src` also blocks tracking pixels in user HTML.
- **SVG:** not accepted in v1.
- **Buffers and URLs:** buffers are transferred zero-copy to workers, zero-filled when Switchlet owns them, and freed by worker termination. Object URLs go through one helper that revokes them on replace, dismiss or unmount. SECURITY.md says honestly that the browser's garbage collector may keep copies we can't wipe.
- **Supply chain:** exact pins, `npm ci`, and `npm audit` every phase.

**Privacy proof panel.** A `PerformanceObserver` lists every network request since the page loaded; all should be same-origin GETs of Switchlet's own code. A `securitypolicyviolation` listener counts blocked attempts. From Phase 4, the service worker also counts the body bytes of any non-GET request, so "Bytes uploaded: 0" is a measurement, not a hard-coded number. A plain-English explainer includes "check it yourself: DevTools → Network."

## Phases
Every phase follows the same routine:
1. Work on a `phase-N` branch with small commits, one per feature.
2. Write Vitest tests for the conversion logic.
3. `npm run build && npm run preview`.
4. Use the Playwright MCP to open the app, run a real conversion and download the result.
5. Check the network log: same-origin GETs only, zero POST/PUT, no requests after the drop except Switchlet's own lazy chunks and WASM. Also check that the console has zero CSP violations and `crossOriginIsolated === true`.
6. `npm audit`.
7. Run `/security-review` and fix what it finds.
8. Summarise what changed and what's next, then **wait for you**. The branch merges to `main` after you approve.

**Phase 1: shell, drop zone, type detection, images**
- **Setup:** `git init`, scaffold (Vite + React + TS strict + Tailwind + Vitest), `.npmrc`, `CLAUDE.md` (the project rules from your brief), `SECURITY.md` (threat model), `_headers` + preview headers.
- **Design:** load the frontend-design skill and settle the visual direction. Starting idea: calm neutrals with one confident accent, an editorial display face plus a calm sans, and mono for byte counts. The final direction comes out of that skill session. Fonts self-hosted; dark mode follows the system.
- **Input:** a global drop zone (the whole window), paste (Ctrl/Cmd+V), and a file picker. The drop zone is a real button, so it works from the keyboard.
- **`detect.ts`:** a signature table covering JPEG/PNG/GIF/WebP/AVIF/HEIC (ftyp brands), PDF, MP4/MOV, WebM/MKV, WAV/MP3, ZIP→XLSX (checked by entry names), and text sniffing for CSV/JSON/MD/HTML.
- **Image ops:** convert between HEIC/PNG/JPG/WebP/AVIF, resize, and compress. A live before/after slider shows the size difference. Re-encodes are debounced and stale results dropped.
- **Image privacy scrub:** metadata is removed losslessly from JPEG, PNG and WebP. JPEG APP1/APP13/COM segments are dropped and the ICC profile is kept; PNG text, eXIf and tIME chunks are dropped; WebP EXIF and XMP chunks are dropped. HEIC and AVIF are scrubbed by re-encoding. The exifreader report lists what was removed ("GPS location: yes", camera, date, software, serial…).
- **Batch mode:** worker pool of min(4, cores−1), ZIP download via fflate.
- **Feedback:** progress with %, ETA and cancel; friendly errors that say what to do next; an `aria-live` region announces progress.
- **Privacy proof panel**, version 1.
- **Tests:** detect (byte fixtures written inline), scrub (crafted segments, report contents), resize math, settings validation, jSquash encode round-trips in Node, ZIP round-trip.

**Phase 2: PDF and document tools**
- **PDF:** merge, split (ranges or every page), reorder by dragging thumbnails (native HTML5 drag-and-drop, plus move up/down buttons for keyboard and touch), images → PDF, PDF → images (pdf.js rendering to OffscreenCanvas in the worker), and compress. Compression recompresses embedded JPEG images and uses object streams; if the result isn't smaller, Switchlet says so honestly.
- **PDF metadata scrub with report:** clears the Info dictionary and the XMP stream.
- **Error handling:** encrypted PDFs get a friendly error.
- **Docs:** Markdown ↔ HTML (marked + DOMPurify, turndown) and CSV ↔ JSON ↔ XLSX (SheetJS, with a sheet picker for multi-sheet workbooks).
- **Tests:** PDF ops on PDFs generated in the test itself (page counts and order, metadata gone), SheetJS round-trips, MD/HTML with jsdom (including XSS payloads being stripped).

**Phase 3: audio and video**
- **Conversion:** MP4 / MOV / WebM, extract audio (M4A/AAC, WebM/Opus, WAV), trim (start/end with a preview scrubber), and video → GIF (Mediabunny frame sink, then gifenc, with fps and width settings).
- **Codec checks:** capabilities are checked with `isConfigSupported` before Switchlet offers an option. Messages are specific: "Your browser can't decode HEVC — try Safari or Chrome", and Firefox falls back to Opus where it lacks AAC.
- **Large files:** input is read lazily from the file, so big files aren't loaded fully into memory.
- **Tests:** remux and trim on a tiny fixture in Node where no codec is needed. Paths that need WebCodecs are verified through Playwright.

**Phase 4: recipes, PWA, share target, command palette**
- **Recipes:** saved in IndexedDB. "Save as recipe" works from any job, and dropping a file with a recipe pinned runs it. Share links use a URL **fragment** (`#recipe=…`), which never reaches the server. Links are checked against the op registry, and an import needs your confirmation.
- **History:** local only, the last 100 jobs (filename, size, steps, date, outcome), clearable with one click.
- **Service worker:** precaches the app and every lazy chunk and WASM file in the background after the first paint (roughly 5 MB over the wire, to be measured), so Switchlet works fully offline. Hashed assets are served cache-first; `index.html` is network-first.
- **Web Share Target:** POST multipart → the service worker puts the files in Cache API → 303 redirect → the app picks them up and deletes them. This only works in Chromium on Android.
- **Command palette (Ctrl/Cmd+K):** a native `<dialog>` with shortcuts: open (Ctrl/Cmd+O), run (Enter), cancel (Esc), download (D), and help (?).
- **Upload meter:** the service worker side of the measured "Bytes uploaded" counter.
- **Tests:** recipe URL codec (including malicious and oversized payloads), recipe chain validation, history cap.

**Phase 5: polish and hardening**
- **Accessibility:** keyboard-only walkthrough, ARIA review, AA contrast check in both themes, reduced motion.
- **Copy:** error message review.
- **Size budget:** first load ≤ 120 KB gzipped (JS + CSS).
- **Extra hardening:**
  - Try Trusted Types, and keep them if nothing breaks.
  - Disable `RTCPeerConnection`, because WebRTC can bypass CSP `connect-src`.
  - Final `npm audit`.
  - Final SECURITY.md.
- **Deploy checklist:** Cloudflare Web Analytics, Rocket Loader, Email Obfuscation and Zaraz must stay **off**, because they inject scripts.

## Risks
- **WebCodecs coverage varies.** Codec support differs by browser, and Firefox Android has no WebCodecs. Switchlet detects what's available and explains clearly when something isn't. This is the trade-off accepted for speed, size and licensing.
- **PDF compression in the browser is limited.** Text-heavy PDFs will barely shrink.
- **Everything happens in RAM.** Size caps are tunable in one place; streaming to disk with the File System Access API can come later.
- **Libraries may need extra CSP exceptions.** pdf.js and the emscripten threading in jSquash AVIF might need `blob:` workers or font loading. Each will be verified in its phase, and any exception documented.
- **Licensing.** libheif-js is LGPL-3.0 and Mediabunny is MPL-2.0. Both are served as separate, unmodified modules, and their licenses are included. Not legal advice.
- **Re-encoding loses the ICC profile.** Wide-gamut photos (Display P3) are converted to sRGB.
- **TypeScript 7 is new.** If tooling breaks, fall back to TS 6.x.

## Verification (end to end)
- `npm test`: Vitest unit suites pass.
- `npm run build`: the first-load budget is checked from the build output.
- `npm run preview`, then the Playwright MCP:
  - load the app;
  - upload a fixture (HEIC → JPG, scrub, PDF merge, MP4 → GIF, CSV → XLSX);
  - download the result;
  - `browser_network_requests` shows zero non-GET requests and zero cross-origin requests;
  - `browser_console_messages` shows zero CSP violations;
  - `browser_evaluate` confirms `crossOriginIsolated`;
  - offline mode (Phase 4): reload and convert with the network off.
- The privacy panel shows 0 bytes uploaded, measured.
- `npm audit` is clean, and `/security-review` findings are fixed every phase.
