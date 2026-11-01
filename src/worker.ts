// The single conversion worker. Codecs load lazily per domain, so the first conversion of a kind
// downloads only what it needs. The main thread terminates this worker to cancel a job or free memory.
import { expose, transfer } from 'comlink'
import type { Kind } from './core/detect'
import type { Step } from './core/ops'
import type { Progress } from './ops/image'
import type { MetadataReport } from './ops/scrub'

export type Task = Step & { file: Blob; kind: Kind }

export interface TaskResult {
  data: ArrayBuffer
  width?: number
  height?: number
  report?: MetadataReport
  preview?: ImageBitmap
}

const api = {
  async run(task: Task, progress?: Progress): Promise<TaskResult> {
    const input = new Uint8Array(await task.file.arrayBuffer())
    try {
      switch (task.op) {
        case 'image.convert': {
          const r = await (await import('./ops/image')).convertImage(input, task.kind, task.settings, progress)
          return transfer(r, r.preview ? [r.data, r.preview] : [r.data])
        }
        case 'image.scrub': {
          progress?.(0.2, 'Removing hidden data')
          const { data, report } = (await import('./ops/scrub')).scrubImage(input, task.kind)
          return transfer({ data: data.buffer as ArrayBuffer, report }, [data.buffer as ArrayBuffer])
        }
      }
    } finally {
      input.fill(0) // best-effort wipe of this worker's copy of the file
    }
  },

  async zip(entries: { name: string; blob: Blob }[]): Promise<ArrayBuffer> {
    const { zipFiles } = await import('./ops/zip')
    const files = await Promise.all(entries.map(async (e) => ({ name: e.name, data: new Uint8Array(await e.blob.arrayBuffer()) })))
    const zipped = zipFiles(files)
    for (const f of files) f.data.fill(0)
    return transfer(zipped.buffer as ArrayBuffer, [zipped.buffer as ArrayBuffer])
  },
}

export type WorkerApi = typeof api
expose(api)

// Report this worker's own network requests (codec downloads) to the page's privacy panel.
new PerformanceObserver((list) => {
  const entries = (list.getEntries() as PerformanceResourceTiming[]).map((e) => ({ url: e.name, type: e.initiatorType, bytes: e.transferSize }))
  self.postMessage({ type: 'switchlet:network', entries })
}).observe({ type: 'resource', buffered: true })
