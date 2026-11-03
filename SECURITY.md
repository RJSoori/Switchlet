# Security and privacy model

Switchlet converts files entirely inside the browser tab. This document says what that protects against, what it doesn't, and how each rule is enforced.

## What we promise
- **Your files never leave your device.** No upload endpoint exists; the site is static files on Vercel.
- **No third parties.** No analytics, ads, fonts, CDNs or scripts from anyone else. After the page loads, the only requests are for Switchlet's own code (lazily loaded converters).
- **Nothing is kept unless you ask.** Files live in memory only while a job runs. Recipes and history store settings and file names in this browser only, never file contents.

## Threats and mitigations
| Threat | Mitigation |
|---|---|
| App code (or a compromised dependency) sends file data to a server | CSP `connect-src 'self'`, `img-src`/`media-src` limited to `'self' blob:`, `form-action 'none'`, `frame-src 'none'`; the only server is a static host that stores nothing. Exact-pinned dependencies, committed lockfile, `ignore-scripts=true`, `npm audit` every phase. |
| Hostile input file exploits a decoder | Type detected from magic bytes, not the extension. Per-type size and pixel limits (`LIMITS` in `src/core/detect.ts`). All decoding runs in a Web Worker; a crash is caught, the worker is terminated, and the user gets a clear message. Browser-native decoders are used where possible (sandboxed and fuzzed by browser vendors). |
| Script injection (XSS) | No inline scripts; CSP `script-src 'self' 'wasm-unsafe-eval'`, `object-src 'none'`, `base-uri 'none'`. Trusted Types (below) refuse strings at every DOM injection point. Untrusted HTML is sanitized with DOMPurify. SVG input is not accepted. |
| Data sent over WebRTC, which `connect-src` doesn't cover in every browser | `RTCPeerConnection` is removed before any other code runs (`src/harden.ts`). |
| Clickjacking | `frame-ancestors 'none'`. |
| Cross-origin data leaks (Spectre class) | COOP `same-origin` + COEP `require-corp` + CORP `same-origin`. |
| Leaking which file you converted via Referer or DNS prefetch | `Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off`. |
| Powerful device APIs | `Permissions-Policy` disables camera, microphone, geolocation, payment, USB, serial, HID, Bluetooth, MIDI, display capture and topics. |
| Converted data lingering in memory | Object URLs are revoked when a result is replaced or dismissed; workers are terminated after jobs, which frees their whole WASM heap. |

## CSP exceptions
- `'wasm-unsafe-eval'`: required to compile WebAssembly codecs. It does **not** allow JavaScript `eval`.
- `blob:` in `img-src` and `media-src`: previews of results that exist only in this tab's memory. Blob URLs can't be fetched by other origins and don't touch the network.

No other exceptions. Any future one must be unavoidable and documented here.

## Trusted Types
The CSP adds `require-trusted-types-for 'script'; trusted-types default dompurify`. The browser then refuses plain strings wherever text becomes code or markup (`innerHTML`, `eval`, script and worker URLs…), so a DOM-injection bug in Switchlet or a library fails instead of running. Two policies may create those values:
- **`default`** (`src/harden.ts`, loaded first on the page and in the converter worker): accepts script URLs on Switchlet's own address only (its workers, pdf.js's worker, the service worker), and the empty string as HTML, which libraries parse to test whether the browser can parse HTML. Everything else is refused.
- **`dompurify`**: DOMPurify's own policy, used to parse untrusted HTML into an inert document so it can be sanitized.

Switchlet's own code never builds HTML from strings: previews are inserted as DOM nodes, and turndown is given DOMPurify's sanitized DOM rather than a string. Trusted Types is Baseline (Chrome, Edge, Firefox 148, Safari 26); older browsers simply ignore it. The privacy panel doesn't count Trusted Types reports, since they're refused code, not requests.

## Expected console messages
- **"Executing inline event handler violates … script-src"** and **"Applying inline style violates … style-src"** when converting Markdown or HTML that contains `onerror=`-style attributes or `<style>` blocks. DOMPurify parses the untrusted HTML in an inert document in order to sanitize it, and Chrome checks those against the CSP at parse time. Nothing runs or applies (the document is inert, the CSP blocks it anyway, and DOMPurify removes them). The privacy panel counts only blocked *loads*, so these reports don't change it.

## Audio and video
- Decoding and encoding use the browser's own WebCodecs (sandboxed, often hardware) through Mediabunny, inside the worker. Files are read in chunks on demand, never loaded whole.
- Mediabunny copies an input's metadata tags by default; Switchlet always writes none (and no creation time). Phone videos keep location and device details in those tags; the report lists what was dropped.
- Two places outside the tags are handled too: per-track titles (which Mediabunny would copy, with no option to stop it) are blanked on the input, and FLAC or Vorbis audio is always re-encoded, because its codec setup data carries its own tags and cover art.
- What a browser can decode or encode varies. When a track can't be converted, Switchlet stops and says why rather than handing back a "video" that lost its picture.
- **Transparent video** (VP8/VP9 or HEVC with an alpha layer): Mediabunny decodes the alpha layer in helper workers it builds from `blob:` URLs, which `worker-src 'self'` refuses, even when the alpha is about to be discarded. Allowing `blob:` workers would let any script run code built from strings, so instead Switchlet first copies such a file without its alpha layer (no decoding, held in memory) and converts, trims or makes a GIF from that copy.

## Service worker, recipes and shared files
- **Offline copy.** `src/sw.ts` (short on purpose, no Workbox) caches only the build-time list of Switchlet's own files at install and serves them cache-first; pages are network-first with the cached `/` as the offline fallback, headers included, so CSP, COOP and COEP still apply offline. It never stores a response it fetched at runtime, so nothing can be planted in the app cache. `/sw.js` is served `no-cache`, so a new deploy reaches people on their next visit.
- **Upload meter.** Every non-GET request from Switchlet's pages and workers passes through the service worker, which counts its body bytes and reports them to the privacy panel. POST navigations aren't counted: Switchlet's pages can't submit forms (`form-action 'none'`), so one can only come from another site, and counting it would let any site inflate the meter.
- **Share target.** On Android, files shared to Switchlet arrive as a POST that the service worker parks in a separate cache (`switchlet-shared`), never served to any page or request. The page reads them and deletes the cache at once. Any website can post files to the same address, so the page asks "Open the shared files?" with their names and sizes before anything is decoded or a pinned recipe runs. After that, the usual hostile-file rules apply.
- **Recipe links** live in the URL fragment (`#recipe=…`), which browsers never send to a server. A link longer than 2000 characters is refused. Decoding rebuilds each step from an allow-list of tasks and values and drops everything else, including file-specific values such as page orders and sheet names. Names lose control, bidi and invisible characters and are capped at 80 characters. Adding a recipe needs confirmation, and adding one never runs it.
- **Storage.** IndexedDB holds recipes (a name and settings) and history (up to 3 file names, a count, the task and the date, last 100 entries, cleared with one click). localStorage holds the id of the pinned recipe. None of it holds file contents.

## Main-thread exceptions
All decoding of untrusted files runs in Web Workers, with two narrow exceptions that need a DOM:
- **Markdown ↔ HTML:** DOMPurify and turndown, on inputs capped at 5 MB.
- **PDF page rendering** (thumbnails, PDF → images): pdf.js parses the PDF in its own worker; only drawing happens on the main thread, sliced so the page stays responsive. PDF scripting (pdf.js's quickjs sandbox) isn't shipped, and XFA forms are disabled.

## Known limits (honest list)
- **Navigation is not covered by CSP.** Malicious code could still leak data by navigating the page to another site. Defence is supply-chain hygiene: few, pinned, audited dependencies and no runtime third-party code.
- **WebRTC is not covered by `connect-src`** in all browsers. Switchlet removes `RTCPeerConnection` at startup, which stops any library from using it by accident or design, but a script set on it could still find a fresh copy in a new same-origin frame or window. The CSP `webrtc 'block'` directive would close that; no browser supports it yet, and Chrome logs a warning for unknown directives, so it isn't sent.
- **Memory wiping is best effort.** JavaScript can't guarantee that the garbage collector hasn't kept copies of a buffer. Worker termination is the strongest guarantee available.
- **Browser extensions** can read any page, including this one. Switchlet can't prevent that.

## Deploying (Vercel checklist)
The guarantees above hold only if the host serves the files unchanged. Security headers live in `vercel.json` (the only copy; `vite preview` applies the same all-paths rule locally). Build: framework preset Vite, `npm run build`, output `dist`, Node 24. On the Vercel project, keep these **off**, because each injects scripts or serves pages Switchlet didn't write (and the CSP would block them, breaking the page and the "0 requests" count):
- Vercel Toolbar and Comments: on by default for preview deployments. Turn them off in Project → Settings (or the team settings).
- Web Analytics and Speed Insights: never enable them (they'd also need a package Switchlet doesn't ship).
- Firewall challenges: Attack Challenge Mode, and Bot Protection set to Challenge (they serve a challenge page with Vercel's script).

Then check the live site: response headers match `vercel.json`, `crossOriginIsolated` is `true` in the console, the Network tab shows only same-origin `GET`s, and the console shows no CSP or Trusted Types errors.

## Verifying it yourself
Open your browser's developer tools, go to the Network tab, and convert a file. You will see requests only for Switchlet's own files (`GET`), and none carrying your data. The privacy panel in the app shows the same measurement live.
