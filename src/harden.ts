// Runs before any other code, on the page and in the converter worker (both import it first).

// Trusted Types: the security policy (`require-trusted-types-for 'script'`) makes the browser refuse plain
// strings wherever text becomes code or markup: script URLs, innerHTML, eval and the like. This default
// policy lets through only what Switchlet needs:
//  - script URLs on Switchlet's own address (its workers, pdf.js's worker, the service worker);
//  - the empty string as HTML, which libraries parse to test whether the browser can parse HTML (turndown does).
// Everything else is refused. Sanitizing untrusted HTML goes through DOMPurify's own policy ('dompurify').
type Rules = { createScriptURL: (url: string) => string | null; createHTML: (html: string) => string | null }
const tt = (self as unknown as { trustedTypes?: { defaultPolicy: unknown; createPolicy(name: string, rules: Rules): unknown } }).trustedTypes
if (tt && !tt.defaultPolicy) {
  tt.createPolicy('default', {
    createScriptURL: (url) => (new URL(url, self.location.href).origin === self.location.origin ? url : null),
    createHTML: (html) => (html === '' ? '' : null),
  })
}

// WebRTC can open connections that `connect-src` doesn't cover in every browser. Switchlet never uses it.
// ponytail: a script set on using WebRTC could still reach it through a new same-origin frame or window; the CSP
// `webrtc 'block'` directive closes that once browsers support it (none do yet, and Chrome warns about it).
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
  if (name in self) Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false })
}
