// pdf.js on the main thread, loaded only when a PDF is shown or rendered. pdf.js parses the (untrusted)
// PDF in its own worker; drawing happens here because its display layer needs a DOM, and pdf.js slices
// that work into short chunks so the page stays responsive.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { JobError } from '../core/jobs'
import { stem, type OutFile, type Step, type TaskResult } from '../core/ops'
import { DecodeError, NoticeError } from '../ops/errors'

GlobalWorkerOptions.workerSrc = workerUrl

export async function openPdf(file: File): Promise<PDFDocumentProxy> {
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: '/pdfjs/cmaps/',
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
    enableXfa: false,
  })
  let locked = false
  task.onPassword = () => { locked = true; void task.destroy() } // never prompt for a password
  try {
    return await task.promise
  } catch {
    if (locked) throw new NoticeError(`“${file.name}” is password-protected, and Switchlet can’t open protected PDFs. Remove the password in the app that made it, then try again.`)
    throw new DecodeError(`“${file.name}” couldn’t be read as a PDF. It may be damaged or incomplete.`)
  }
}

/** Draw a page into a canvas at the given scale (1 = 72 dpi). */
export async function renderPage(page: PDFPageProxy, scale: number, canvas: HTMLCanvasElement): Promise<void> {
  const viewport = page.getViewport({ scale })
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  await page.render({ canvas, viewport }).promise
}

const MAX_PAGES = 500
const MAX_PIXELS = 40_000_000

export async function pdfToImages(
  file: File,
  s: Extract<Step, { op: 'pdf.toImages' }>['settings'],
  signal: AbortSignal,
  progress: (fraction: number, stage: string) => void,
): Promise<TaskResult> {
  const doc = await openPdf(file)
  const type = s.format === 'png' ? 'image/png' : 'image/jpeg'
  const ext = s.format === 'png' ? 'png' : 'jpg'
  const files: OutFile[] = []
  try {
    const count = Math.min(doc.numPages, MAX_PAGES)
    for (let n = 1; n <= count; n++) {
      if (signal.aborted) throw new JobError('cancelled', 'Cancelled')
      progress((n - 1) / count, `Rendering page ${n} of ${count}`)
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: s.dpi / 72 })
      const scale = (s.dpi / 72) * Math.min(1, Math.sqrt(MAX_PIXELS / (base.width * base.height)))
      const canvas = document.createElement('canvas')
      await renderPage(page, scale, canvas)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9))
      canvas.width = canvas.height = 0 // release the bitmap memory now
      page.cleanup()
      if (!blob) throw new Error('Canvas export failed')
      files.push({ name: `${stem(file.name)}-page-${n}.${ext}`, data: await blob.arrayBuffer(), type })
    }
    const more = doc.numPages > count ? ` Only the first ${MAX_PAGES} of ${doc.numPages} pages were saved.` : ''
    return { files, note: `${count} ${count === 1 ? 'page' : 'pages'} at ${s.dpi} dpi.${more}` }
  } finally {
    void doc.loadingTask.destroy()
  }
}
