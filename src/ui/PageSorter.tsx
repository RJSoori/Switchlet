import { useEffect, useRef, useState } from 'react'
import { friendlyError } from '../core/jobs'
import { BitmapCanvas } from './Result'

const MAX_THUMBS = 300 // ponytail: later pages show a placeholder; render on scroll if huge PDFs become common
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/** Page thumbnails to drag into a new order, with buttons for keyboard and touch. `order` holds 0-based page indices. */
export function PageSorter({ file, order, onChange }: { file: File; order: number[] | null; onChange: (order: number[]) => void }) {
  const [count, setCount] = useState<number | null>(null)
  const [thumbs, setThumbs] = useState<(ImageBitmap | undefined)[]>([])
  const [error, setError] = useState<string | null>(null)
  const dragFrom = useRef<number | null>(null)

  useEffect(() => {
    let live = true
    const made: ImageBitmap[] = []
    let destroy = () => {}
    void (async () => {
      try {
        const { openPdf, renderPage } = await import('./pdfjs')
        const doc = await openPdf(file)
        destroy = () => void doc.loadingTask.destroy()
        if (!live) return destroy()
        setCount(doc.numPages)
        for (let n = 1; n <= Math.min(doc.numPages, MAX_THUMBS) && live; n++) {
          const page = await doc.getPage(n)
          const { width, height } = page.getViewport({ scale: 1 })
          const canvas = document.createElement('canvas')
          await renderPage(page, 240 / Math.max(width, height), canvas)
          page.cleanup()
          const bitmap = await createImageBitmap(canvas)
          made.push(bitmap)
          if (live) setThumbs((t) => { const next = [...t]; next[n - 1] = bitmap; return next })
        }
      } catch (e) {
        if (live) setError(friendlyError(e).message)
      }
    })()
    return () => { live = false; destroy(); made.forEach((b) => b.close()) }
  }, [file])

  if (error) return <div role="alert" className="rounded-lg border border-danger/40 p-4 text-danger">{error}</div>
  if (count === null) return <p className="text-muted" role="status">Opening the PDF…</p>

  const pages = order ?? range(count)
  const removed = range(count).filter((i) => !pages.includes(i))
  const move = (from: number, to: number) => {
    if (to < 0 || to >= pages.length || from === to) return
    const next = [...pages]
    const [page] = next.splice(from, 1)
    next.splice(to, 0, page!)
    onChange(next)
  }

  return (
    <div className="space-y-4">
      <ol className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-4" aria-label="Pages in their new order">
        {pages.map((p, pos) => (
          <li
            key={p}
            draggable
            onDragStart={() => { dragFrom.current = pos }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (dragFrom.current !== null) move(dragFrom.current, pos); dragFrom.current = null }}
            className="group cursor-grab rounded-lg border border-rule bg-field p-2 active:cursor-grabbing"
          >
            <div className="grid aspect-[3/4] place-items-center overflow-hidden rounded bg-paper">
              {thumbs[p] ? <BitmapCanvas bitmap={thumbs[p]} className="max-h-full max-w-full shadow-sm" label={`Page ${p + 1}`} /> : <span className="text-sm text-muted">Page {p + 1}</span>}
            </div>
            <div className="mt-2 flex items-center justify-between gap-1 text-sm">
              <span className="tabular-nums">Page {p + 1}</span>
              <span className="flex gap-0.5">
                <button type="button" onClick={() => move(pos, pos - 1)} disabled={pos === 0} aria-label={`Move page ${p + 1} earlier`} className="rounded px-1.5 hover:bg-rule disabled:opacity-30">←</button>
                <button type="button" onClick={() => move(pos, pos + 1)} disabled={pos === pages.length - 1} aria-label={`Move page ${p + 1} later`} className="rounded px-1.5 hover:bg-rule disabled:opacity-30">→</button>
                <button type="button" onClick={() => onChange(pages.filter((_, i) => i !== pos))} disabled={pages.length === 1} aria-label={`Remove page ${p + 1}`} className="rounded px-1.5 text-danger hover:bg-rule disabled:opacity-30">×</button>
              </span>
            </div>
          </li>
        ))}
      </ol>
      {removed.length > 0 && (
        <p className="text-muted">
          Removed: {removed.length === 1 ? 'page' : 'pages'} {removed.map((i) => i + 1).join(', ')}.{' '}
          <button type="button" onClick={() => onChange(range(count))} className="text-jade underline underline-offset-4">Restore all pages</button>
        </p>
      )}
    </div>
  )
}
