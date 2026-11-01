// The single conversion worker. Codecs and libraries load lazily per task, so the first conversion of a
// kind downloads only what it needs. The main thread terminates this worker to cancel a job or free memory.
import { expose, transfer } from 'comlink'
import type { Kind } from './core/detect'
import { FORMAT_MIME, imageOutputName, type InFile, type Step, type TaskResult } from './core/ops'
import type { Progress } from './ops/image'

/** A step plus its input files. Single-file tasks get one file; merge and images → PDF get several. */
export type Task = Step & { files: File[]; kinds: Kind[] }

const SCRUB_MIME: Partial<Record<Kind, string>> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

async function dispatch(task: Task, inputs: InFile[], progress: Progress): Promise<TaskResult> {
  const one = inputs[0]!
  switch (task.op) {
    case 'image.convert': {
      const r = await (await import('./ops/image')).convertImage(one.bytes, one.kind, task.settings, progress)
      return {
        files: [{ name: imageOutputName(one.name, one.kind, task), data: r.data, type: FORMAT_MIME[task.settings.format] }],
        width: r.width, height: r.height, report: r.report, preview: r.preview,
      }
    }
    case 'image.scrub': {
      progress(0.2, 'Removing hidden data')
      const { data, report } = (await import('./ops/scrub')).scrubImage(one.bytes, one.kind)
      return { files: [{ name: imageOutputName(one.name, one.kind, task), data: data.buffer as ArrayBuffer, type: SCRUB_MIME[one.kind]! }], report }
    }
    case 'image.toPdf': return (await import('./ops/pdf')).imagesToPdf(inputs, task.settings.pageSize, progress)
    case 'pdf.merge': return (await import('./ops/pdf')).merge(inputs, progress)
    case 'pdf.pages': return (await import('./ops/pdf')).reorder(one, task.settings.order)
    case 'pdf.split': return (await import('./ops/pdf')).split(one, task.settings.ranges, progress)
    case 'pdf.compress': return (await import('./ops/pdf')).compress(one, task.settings.strength, progress)
    case 'pdf.scrub': return (await import('./ops/pdf')).scrubPdf(one)
    case 'sheet.convert': return (await import('./ops/sheet')).convertSheet(one, task.settings.to, task.settings.sheet)
    case 'pdf.toImages': case 'doc.convert': throw new Error(`${task.op} runs on the main thread`)
  }
}

const api = {
  async run(task: Task, progress: Progress = () => {}): Promise<TaskResult> {
    const inputs: InFile[] = await Promise.all(
      task.files.map(async (f, i) => ({ name: f.name, kind: task.kinds[i]!, bytes: new Uint8Array(await f.arrayBuffer()) })),
    )
    try {
      const r = await dispatch(task, inputs, progress)
      return transfer(r, [...r.files.map((f) => f.data), ...(r.preview ? [r.preview] : [])])
    } finally {
      for (const f of inputs) f.bytes.fill(0) // best-effort wipe of this worker's copies of the files
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

// Report this worker's own network requests (code and codec downloads) to the page's privacy panel.
new PerformanceObserver((list) => {
  const entries = (list.getEntries() as PerformanceResourceTiming[]).map((e) => ({ url: e.name, type: e.initiatorType, bytes: e.transferSize }))
  self.postMessage({ type: 'switchlet:network', entries })
}).observe({ type: 'resource', buffered: true })
