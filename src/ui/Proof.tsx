// The privacy proof: an open switch between "this device" and "other servers", and a live, measured
// count of requests that crossed it (always 0), with the full request list one click away.
import { formatBytes } from '../core/detect'
import { isOwnOrigin, useNetworkLog } from '../core/network'

export function useRequestsElsewhere() {
  return useNetworkLog().entries.filter((e) => !isOwnOrigin(e.url)).length
}

export function Proof() {
  const { entries, blocked } = useNetworkLog()
  const elsewhere = entries.filter((e) => !isOwnOrigin(e.url))
  const own = entries.filter((e) => isOwnOrigin(e.url))

  return (
    <section id="proof" aria-labelledby="proof-title" className="mt-20 scroll-mt-8">
      <h2 id="proof-title" className="sr-only">What leaves this device</h2>
      <div className="flex justify-between text-sm text-muted" aria-hidden="true">
        <span>This device</span>
        <span>Other servers</span>
      </div>
      <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-end" aria-hidden="true">
        <span className="mb-[7.5px] h-[3px] rounded-full bg-ink" />
        <svg viewBox="0 0 76 36" className="h-9 w-[76px] overflow-visible">
          <circle cx="6" cy="27" r="5.5" className="fill-ink" />
          <line className="lever text-ink" x1="6" y1="27" x2="58" y2="5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle cx="68" cy="27" r="5" fill="none" className="stroke-line" strokeWidth="2.5" />
        </svg>
        <span className="mb-[7.5px] border-t-[3px] border-dotted border-line" />
      </div>

      <div className="mt-8 grid gap-8 sm:grid-cols-2 sm:items-end">
        <p className="max-w-[40ch] text-lg leading-relaxed">
          Your files are opened and converted here, in this browser tab. They don’t leave this device.
        </p>
        <div className="sm:text-right">
          <p className="font-mono text-7xl leading-none tabular-nums" aria-describedby="elsewhere-label">{elsewhere.length}</p>
          <p id="elsewhere-label" className="mt-3 text-muted">requests to other servers since you opened this page</p>
        </div>
      </div>

      <details className="mt-8 border-t border-rule pt-5">
        <summary className="cursor-pointer font-medium text-jade underline-offset-4 hover:underline">How Switchlet shows this</summary>
        <div className="mt-4 max-w-[68ch] space-y-3 leading-relaxed text-muted">
          <p>Switchlet is a set of files your browser downloads, like any web page. Conversions run inside your browser, on this device’s processor.</p>
          <p>The page’s security policy only allows connections to Switchlet’s own address, and that address only hands out files. There’s no upload service, so there is nowhere for a file to go.</p>
          <p>
            The number above comes from your browser’s own record of every request made by this page and its converter.
            Requests blocked by the security policy: <span className="text-ink tabular-nums">{blocked}</span>.
          </p>
          <p>To check it yourself, open your browser’s developer tools, choose Network, and convert a file.</p>
        </div>
        <h3 className="mt-6 font-medium">Requests to Switchlet itself ({own.length})</h3>
        <p className="text-sm text-muted">App code and converters, downloaded when first needed.</p>
        <ul className="mt-3 divide-y divide-rule text-sm">
          {[...elsewhere, ...own].map((e, i) => (
            <li key={i} className="flex gap-4 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono">{isOwnOrigin(e.url) ? new URL(e.url).pathname : e.url}</span>
              <span className="text-muted">{e.via === 'page' ? 'page' : 'converter'}</span>
              <span className="w-20 text-right tabular-nums text-muted">{e.bytes ? formatBytes(e.bytes) : 'cached'}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
