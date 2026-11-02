import { useEffect, useRef, useState } from 'react'
import type { Item } from '../App'
import type { Kind } from '../core/detect'
import { percent, useObjectUrl } from './hooks'
import { Downloads, JobStatus, Report } from './Outputs'

/** Formats every browser can display in an <img>. HEIC gets a decoded preview from the worker instead. */
const DISPLAYABLE = new Set<Kind>(['jpeg', 'png', 'gif', 'webp', 'avif'])

export function BitmapCanvas({ bitmap, className, label = 'Original' }: { bitmap: ImageBitmap; className: string; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  }, [bitmap])
  return <canvas ref={ref} className={className} role="img" aria-label={label} />
}

function Compare({ item }: { item: Item }) {
  const [split, setSplit] = useState(50)
  const beforeUrl = useObjectUrl(DISPLAYABLE.has(item.detected.kind) ? item.file : undefined)
  const afterUrl = useObjectUrl(item.output?.files[0]?.blob)
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

/** Single image: before/after compare, size change, download and the hidden-data report. */
export function ImageResult({ item, onCancel, onRetry, onDownload }: { item: Item; onCancel: () => void; onRetry: () => void; onDownload?: () => void }) {
  const out = item.output
  return (
    <div className="space-y-6">
      {(item.status !== 'error' || out) && <Compare item={item} />}
      <JobStatus job={item} onCancel={onCancel} onRetry={onRetry} />
      {out && <Downloads output={out} inputSize={item.file.size} zipName="switchlet.zip" onDownload={onDownload} />}
      {out && <Report report={out.report} />}
    </div>
  )
}
