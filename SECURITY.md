# Security and privacy model

Switchlet converts files entirely inside the browser tab. This document says what that protects against, what it doesn't, and how each rule is enforced.

## What we promise
- **Your files never leave your device.** No upload endpoint exists; the site is static files on Cloudflare Pages.
- **No third parties.** No analytics, ads, fonts, CDNs or scripts from anyone else. After the page loads, the only requests are for Switchlet's own code (lazily loaded converters).
- **Nothing is kept unless you ask.** Files live in memory only while a job runs. (Recipes and job history, from Phase 4, store settings and file names locally, never file contents.)

## Threats and mitigations
| Threat | Mitigation |
|---|---|
| App code (or a compromised dependency) sends file data to a server | CSP `connect-src 'self'`, `img-src`/`media-src` limited to `'self' blob:`, `form-action 'none'`, `frame-src 'none'`; the only server is a static host that stores nothing. Exact-pinned dependencies, committed lockfile, `ignore-scripts=true`, `npm audit` every phase. |
| Hostile input file exploits a decoder | Type detected from magic bytes, not the extension. Per-type size and pixel limits (`LIMITS` in `src/core/detect.ts`). All decoding runs in a Web Worker; a crash is caught, the worker is terminated, and the user gets a clear message. Browser-native decoders are used where possible (sandboxed and fuzzed by browser vendors). |
| Script injection (XSS) | No inline scripts; CSP `script-src 'self' 'wasm-unsafe-eval'`, `object-src 'none'`, `base-uri 'none'`. Untrusted HTML (Phase 2) is sanitized with DOMPurify. SVG input is not accepted. |
| Clickjacking | `frame-ancestors 'none'`. |
| Cross-origin data leaks (Spectre class) | COOP `same-origin` + COEP `require-corp` + CORP `same-origin`. |
| Leaking which file you converted via Referer or DNS prefetch | `Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off`. |
| Powerful device APIs | `Permissions-Policy` disables camera, microphone, geolocation, payment, USB, serial, HID, Bluetooth, MIDI, display capture and topics. |
| Converted data lingering in memory | Object URLs are revoked when a result is replaced or dismissed; workers are terminated after jobs, which frees their whole WASM heap. |

## CSP exceptions
- `'wasm-unsafe-eval'`: required to compile WebAssembly codecs. It does **not** allow JavaScript `eval`.
- `blob:` in `img-src` and `media-src`: previews of results that exist only in this tab's memory. Blob URLs can't be fetched by other origins and don't touch the network.

No other exceptions. Any future one must be unavoidable and documented here.

## Expected console messages
- **"Executing inline event handler violates … script-src-attr"** when converting Markdown or HTML that contains `onerror=`-style attributes. DOMPurify parses the untrusted HTML in an inert document in order to sanitize it, and Chrome checks event-handler attributes against the CSP at parse time. Nothing runs (the document is inert, the CSP blocks it anyway, and DOMPurify removes the attribute). The privacy panel counts only blocked *loads*, so these reports don't change it.

## Audio and video
- Decoding and encoding use the browser's own WebCodecs (sandboxed, often hardware) through Mediabunny, inside the worker. Files are read in chunks on demand, never loaded whole.
- Mediabunny copies an input's metadata tags by default; Switchlet always writes none (and no creation time). Phone videos keep location and device details in those tags; the report lists what was dropped.
- Two places outside the tags are handled too: per-track titles (which Mediabunny would copy, with no option to stop it) are blanked on the input, and FLAC or Vorbis audio is always re-encoded, because its codec setup data carries its own tags and cover art.
- What a browser can decode or encode varies. When a track can't be converted, Switchlet stops and says why rather than handing back a "video" that lost its picture.

## Main-thread exceptions
All decoding of untrusted files runs in Web Workers, with two narrow exceptions that need a DOM:
- **Markdown ↔ HTML:** DOMPurify and turndown, on inputs capped at 5 MB.
- **PDF page rendering** (thumbnails, PDF → images): pdf.js parses the PDF in its own worker; only drawing happens on the main thread, sliced so the page stays responsive. PDF scripting (pdf.js's quickjs sandbox) isn't shipped, and XFA forms are disabled.

## Known limits (honest list)
- **Navigation is not covered by CSP.** Malicious code could still leak data by navigating the page to another site. Defence is supply-chain hygiene: few, pinned, audited dependencies and no runtime third-party code.
- **WebRTC is not covered by `connect-src`** in all browsers. Planned for Phase 5: disable `RTCPeerConnection` at startup.
- **Memory wiping is best effort.** JavaScript can't guarantee that the garbage collector hasn't kept copies of a buffer. Worker termination is the strongest guarantee available.
- **Browser extensions** can read any page, including this one. Switchlet can't prevent that.

## Verifying it yourself
Open your browser's developer tools, go to the Network tab, and convert a file. You will see requests only for Switchlet's own files (`GET`), and none carrying your data. The privacy panel in the app shows the same measurement live.
