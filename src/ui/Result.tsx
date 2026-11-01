import { useEffect, useRef, useState } from 'react'
import type { Item } from '../App'
import { formatBytes, type Kind } from '../core/detect'
import { etaSeconds } from '../core/jobs'
import type { MetadataReport } from '../ops/scrub'
import { percent, useObjectUrl } from './hooks'

/** Formats every browser can display in an <img>. HEIC gets a decoded preview from the worker instead. */
const DISPLAYABLE = new Set<Kind>(['jpeg', 'png', 'gif', 'webp', 'avif'])

function BitmapCanvas({ bitmap, className }: { bitmap: ImageBitmap; className: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  }, [bitmap])
  return <canvas ref={ref} className={className} role="img" aria-label="Original" />
}

function Compare({ item }: { item: Item }) {
  const [split, setSplit] = useState(50)
  const beforeUrl = useObjectUrl(DISPLAYABLE.has(item.detected.kind) ? item.file : undefined)
  const afterUrl = useObjectUrl(item.output?.blob)
  const w = item.output?.width ?? item.detected.width
  const h = item.output?.height ?? item.detected.height
  const img = 'absolute inset-0 h-full w-full object-contain'
  const running = item.status === 'running'

  return (
    <div
      className="relative max-h-[70vh] overflow-hidden rounded-xl border border-rule bg-field has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-jade"
      style={{ aspectRatio: w && h ? `${w} / ${h}` : '4 / 3' }}
    >
      {beforeUrl ? <img src={beforeUrl} alt="Original" className={img} /> : item.output?.preview && <BitmapCanvas bitmap={item.output.preview} className={img} />}
      {afterUrl && (
        <>
          <img src={afterUrl} alt="Converted" className={`${img} transition-opacity ${running ? 'opacity-60' : ''}`} style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
          <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-paper shadow-[0_0_0_1px_var(--color-line)]" style={{ left: `${split}%` }} />
          <span className="pointer-events-none absolute top-3 left-3 rounded bg-paper/90 px-2 py-0.5 text-sm">Original</span>
          <span className="pointer-events-none absolute top-3 right-3 rounded bg-paper/90 px-2 py-0.5 text-sm">Converted</span>
          <input
            type="range"
            min={0}
            max={100}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label="Compare original and converted. Move left to see more of the converted image."
            className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
          />
        </>
      )}
      {running && (
        <div className="absolute inset-x-0 top-0 h-1 bg-rule">
          <div className="h-full bg-jade transition-[width]" style={{ width: percent(item.progress) }} />
        </div>
      )}
    </div>
  )
}

export function Report({ report }: { report?: MetadataReport }) {
  if (!report) return null
  if (!report.found.length && !report.removed.length) return <p className="text-muted">No hidden data found in this file.</p>
  return (
    <section aria-labelledby="report-title">
      <h3 id="report-title" className="font-medium">Hidden data removed from the new copy</h3>
      {report.found.length > 0 && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          {report.found.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-muted">{f.label}</dt>
              <dd className="break-words">{f.detail}</dd>
            </div>
          ))}
        </dl>
      )}
      {report.removed.length > 0 && <p className="mt-3 text-sm text-muted">Removed: {report.removed.join(', ')}.</p>}
      {report.kept.length > 0 && <p className="mt-1 text-sm text-muted">Kept: {report.kept.join('; ')}.</p>}
    </section>
  )
}

export function sizeChange(before: number, after: number): string {
  const delta = after / before - 1
  if (Math.abs(delta) < 0.005) return 'About the same size'
  return delta < 0 ? `${percent(-delta)} smaller` : `${percent(delta)} larger than the original`
}

export function SingleResult({ item, onCancel, onRetry }: { item: Item; onCancel: () => void; onRetry: () => void }) {
  const out = item.output
  const url = useObjectUrl(out?.blob)
  const eta = item.startedAt !== undefined ? etaSeconds(item.startedAt, item.progress) : null

  return (
    <div className="space-y-6">
      {(item.status !== 'error' || out) && <Compare item={item} />}

      {item.status === 'running' && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="status">
          <p>
            {item.stage}… <span className="tabular-nums">{percent(item.progress)}</span>
            {eta !== null && <span className="text-muted"> about {eta} s left</span>}
          </p>
          <button type="button" onClick={onCancel} className="rounded-md border border-line px-3 py-1 hover:border-ink">Cancel</button>
        </div>
      )}
      {item.status === 'error' && (
        <div role="alert" className="rounded-lg border border-danger/40 p-4">
          <p className="text-danger">{item.error}</p>
        </div>
      )}
      {item.status === 'cancelled' && (
        <p>
          Conversion cancelled.{' '}
          <button type="button" onClick={onRetry} className="text-jade underline underline-offset-4">Run it again</button>
        </p>
      )}

      {out && url && (
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-2xl tabular-nums">
              {formatBytes(item.file.size)} <span className="text-muted">to</span> <strong className="font-semibold">{formatBytes(out.blob.size)}</strong>
            </p>
            <p className="text-muted">{sizeChange(item.file.size, out.blob.size)}</p>
          </div>
          <a
            href={url}
            download={out.name}
            className="inline-flex items-center rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade hover:brightness-110"
          >
            Download {out.name}
          </a>
        </div>
      )}
      {out && <Report report={out.report} />}
    </div>
  )
}
