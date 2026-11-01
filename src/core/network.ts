// Live record of every network request this page and its converter workers make, read from the
// browser's own Resource Timing data, plus any request the security policy blocked.
// Workers have their own timeline, so the worker reports its entries (see worker.ts / jobs.ts).
import { useSyncExternalStore } from 'react'

export interface NetEntry { url: string; via: 'page' | 'converter'; type: string; bytes: number }
export interface NetLog { entries: NetEntry[]; blocked: number }

let log: NetLog = { entries: [], blocked: 0 }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function recordRequests(entries: { url: string; type: string; bytes: number }[], via: NetEntry['via']) {
  if (!entries.length) return
  log = { ...log, entries: [...log.entries, ...entries.map((e) => ({ ...e, via }))] }
  emit()
}

export const toNetRecord = (list: PerformanceEntryList) =>
  (list as PerformanceResourceTiming[]).map((e) => ({ url: e.name, type: e.initiatorType, bytes: e.transferSize }))

let started = false
export function startNetworkLog() {
  if (started) return
  started = true
  new PerformanceObserver((list) => recordRequests(toNetRecord(list.getEntries()), 'page')).observe({ type: 'resource', buffered: true })
  document.addEventListener('securitypolicyviolation', () => { log = { ...log, blocked: log.blocked + 1 }; emit() })
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
