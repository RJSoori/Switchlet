// Runs tasks on a small pool of workers. Cancel = terminate the worker (the only way to stop WASM
// mid-flight, and it frees the whole WASM heap). Any worker that failed is terminated, never reused.
import { proxy, wrap, type Remote } from 'comlink'
import type { Task, TaskResult, WorkerApi } from '../worker'

export type JobErrorKind = 'cancelled' | 'damaged' | 'memory' | 'crash'

export class JobError extends Error {
  constructor(public kind: JobErrorKind, message: string) {
    super(message)
    this.name = 'JobError'
  }
}

/** Turn anything a worker threw into a message that says what happened and what to do next. */
export function friendlyError(e: unknown): JobError {
  if (e instanceof JobError) return e
  const err = e instanceof Error ? e : new Error(String(e))
  if (err.name === 'DecodeError') return new JobError('damaged', `${err.message} Try opening it in another app and saving a fresh copy.`)
  if (err.name === 'RangeError' || /memory|allocat|oom/i.test(err.message)) {
    return new JobError('memory', 'Your browser ran out of memory for this file. Try a smaller output size, or close other tabs and try again.')
  }
  return new JobError('crash', 'The converter stopped unexpectedly on this file. It may be damaged or unusual. Try another copy of it.')
}

interface Slot { worker: Worker; api: Remote<WorkerApi> }
const idle: Slot[] = []

function spawn(): Slot {
  const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module', name: 'switchlet-converter' })
  return { worker, api: wrap<WorkerApi>(worker) }
}

async function withWorker<T>(signal: AbortSignal | undefined, fn: (api: Remote<WorkerApi>) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new JobError('cancelled', 'Cancelled')
  const slot = idle.pop() ?? spawn()
  let onAbort = () => {}
  const stopped = new Promise<never>((_, reject) => {
    slot.worker.onerror = (ev) => { ev.preventDefault(); reject(new JobError('crash', 'The converter stopped unexpectedly. Try again, or try another copy of the file.')) }
    onAbort = () => reject(new JobError('cancelled', 'Cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  stopped.catch(() => {}) // handled via the race below
  try {
    const result = await Promise.race([fn(slot.api), stopped])
    slot.worker.onerror = null
    idle.push(slot)
    return result
  } catch (e) {
    slot.worker.terminate()
    throw friendlyError(e)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export function runTask(task: Task, opts: { signal?: AbortSignal; onProgress?: (fraction: number, stage: string) => void } = {}): Promise<TaskResult> {
  return withWorker(opts.signal, (api) => api.run(task, opts.onProgress && proxy(opts.onProgress)))
}

export async function zipBlobs(entries: { name: string; blob: Blob }[], signal?: AbortSignal): Promise<Blob> {
  const data = await withWorker(signal, (api) => api.zip(entries))
  return new Blob([data], { type: 'application/zip' })
}

/** Terminate idle workers, freeing their memory (decoded pixels, WASM heaps). Call when a job's results are dismissed. */
export function releaseWorkers() {
  for (const slot of idle.splice(0)) slot.worker.terminate()
}

export const poolSize = () => Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))

/** Run `work` over items with at most `limit` in flight. */
export async function runPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => { while (next < items.length) await work(items[next++]!) }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

/** Seconds remaining, or null while there's too little signal to estimate honestly. */
export function etaSeconds(startedAt: number, fraction: number, now = performance.now()): number | null {
  const elapsed = (now - startedAt) / 1000
  if (fraction <= 0.05 || fraction >= 1 || elapsed < 1) return null
  return Math.max(1, Math.round((elapsed * (1 - fraction)) / fraction))
}
