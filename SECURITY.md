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

## Known limits (honest list)
- **Navigation is not covered by CSP.** Malicious code could still leak data by navigating the page to another site. Defence is supply-chain hygiene: few, pinned, audited dependencies and no runtime third-party code.
- **WebRTC is not covered by `connect-src`** in all browsers. Planned for Phase 5: disable `RTCPeerConnection` at startup.
- **Memory wiping is best effort.** JavaScript can't guarantee that the garbage collector hasn't kept copies of a buffer. Worker termination is the strongest guarantee available.
- **Browser extensions** can read any page, including this one. Switchlet can't prevent that.

## Verifying it yourself
Open your browser's developer tools, go to the Network tab, and convert a file. You will see requests only for Switchlet's own files (`GET`), and none carrying your data. The privacy panel in the app shows the same measurement live.
