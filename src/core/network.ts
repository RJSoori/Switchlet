// Live record of every network request this page and its converter workers make, read from the
// browser's own Resource Timing data, plus any request the security policy blocked, plus bytes uploaded
// as measured by the service worker (which sees every request the page makes).
// Workers have their own timeline, so the worker reports its entries (see worker.ts / jobs.ts).
import { useSyncExternalStore } from 'react'

export interface NetEntry { url: string; via: 'page' | 'converter'; type: string; bytes: number }
export interface NetLog {
  entries: NetEntry[]
  blocked: number
  /** Body bytes of any request that could carry data, counted by the service worker. */
  uploaded: number
  /** True once the service worker controls this page, i.e. `uploaded` is a real measurement. */
  measuring: boolean
}

let log: NetLog = { entries: [], blocked: 0, uploaded: 0, measuring: false }
const listeners = new Set<() => void>()
const update = (patch: Partial<NetLog>) => { log = { ...log, ...patch }; listeners.forEach((l) => l()) }

export function recordRequests(entries: { url: string; type: string; bytes: number }[], via: NetEntry['via']) {
  if (entries.length) update({ entries: [...log.entries, ...entries.map((e) => ({ ...e, via }))] })
}

export const toNetRecord = (list: PerformanceEntryList) =>
  (list as PerformanceResourceTiming[]).map((e) => ({ url: e.name, type: e.initiatorType, bytes: e.transferSize }))

let started = false
export function startNetworkLog() {
  if (started) return
  started = true
  new PerformanceObserver((list) => recordRequests(toNetRecord(list.getEntries()), 'page')).observe({ type: 'resource', buffered: true })
  // Count blocked loads only. Inline-handler reports ("inline"/"eval") aren't requests: Chrome raises them while
  // DOMPurify parses hostile HTML in an inert document to sanitize it, before the handler is removed.
  document.addEventListener('securitypolicyviolation', (e) => {
    if (e.blockedURI !== 'inline' && e.blockedURI !== 'eval') update({ blocked: log.blocked + 1 })
  })
  const sw = navigator.serviceWorker
  if (!sw) return
  update({ measuring: !!sw.controller })
  sw.addEventListener('controllerchange', () => update({ measuring: !!sw.controller }))
  sw.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type === 'switchlet:upload' && typeof e.data.bytes === 'number') update({ uploaded: log.uploaded + e.data.bytes })
  })
}

export function isOwnOrigin(url: string) {
  try {
    return new URL(url, location.href).origin === location.origin
  } catch {
    return false
  }
}

export function useNetworkLog(): NetLog {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => log,
  )
}
