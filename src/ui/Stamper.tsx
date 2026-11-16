// The page editor for "Add text, image or signature": one PDF page with the things placed on it, which can be
// dragged, resized and removed. Positions are kept in PDF points from the page's top-left corner, so what is
// shown here is exactly where ops/pdf.ts draws. Nothing is stored: a drawn signature lives only in this tab's memory.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { friendlyError } from '../core/jobs'
import { MAX_STAMPS, MAX_STAMP_TEXT, type Stamp } from '../core/ops'
import { useObjectUrl } from './hooks'
import { Dialog } from './Library'
import { BitmapCanvas } from './Result'

type Point = { x: number; y: number }
type Box = Point & { width: number; height: number }
interface View { page: number; bitmap: ImageBitmap; width: number; height: number }

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const percent = (fraction: number) => `${fraction * 100}%`
/** Selection marks sit on the (nearly always white) page, so they keep one colour in both themes, with a white edge for dark pages. */
const MARK = '#0B7A57'
const tool = 'rounded-md border border-line px-3 py-1.5 hover:border-ink aria-disabled:opacity-40 aria-disabled:hover:border-line'

/** Keep an item on the page: pictures whole, text from where it starts. */
const onPage = (s: Stamp, v: View): Stamp =>
  'text' in s
    ? { ...s, x: clamp(s.x, 0, v.width - 8), y: clamp(s.y, 8, v.height) }
    : { ...s, x: clamp(s.x, 0, Math.max(0, v.width - s.width)), y: clamp(s.y, 0, Math.max(0, v.height - s.height)) }

/** A picture's natural size, read by the browser's own image decoder (the one that also shows it on the page). */
function pictureSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    const done = (size: { width: number; height: number } | null) => { URL.revokeObjectURL(url); resolve(size) }
    img.onload = () => done(img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : null)
    img.onerror = () => done(null)
    img.src = url
  })
}

function Picture({ file, stamp }: { file: File | undefined; stamp: Extract<Stamp, { image: number }> }) {
  const url = useObjectUrl(file)
  return <image href={url} x={stamp.x} y={stamp.y} width={stamp.width} height={stamp.height} preserveAspectRatio="none" />
}

interface Props {
  file: File
  stamps: Stamp[]
  /** Pictures that can be placed, in the order stamps refer to them. New ones are put on the page being shown. */
  images: File[]
  onChange: (stamps: Stamp[]) => void
  onAddImage: (file: File) => void
  /** Opens the file picker. A picture chosen (or dropped, or pasted) while this editor is open arrives in `images`. */
  onPick: () => void
  announce: (message: string) => void
}

export function Stamper({ file, stamps, images, onChange, onAddImage, onPick, announce }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageNo, setPageNo] = useState(0)
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [signing, setSigning] = useState(false)
  /** The stamp being dragged, shown in place of the saved one until the pointer is let go. */
  const [drag, setDrag] = useState<{ index: number; stamp: Stamp } | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  const grab = useRef<{ index: number; resize: boolean; from: Point; start: Stamp; box: Box | null; now: Stamp | null } | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const selectedEl = useRef<SVGGElement>(null)
  const textField = useRef<HTMLInputElement>(null)
  const firstTool = useRef<HTMLButtonElement>(null)
  const focusText = useRef(false)
  const hintId = useId()
  const latest = useRef(stamps)
  latest.current = stamps
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    let live = true
    let destroy = () => {}
    void (async () => {
      try {
        const opened = await (await import('./pdfjs')).openPdf(file)
        destroy = () => void opened.loadingTask.destroy()
        if (!live) return destroy()
        setDoc(opened)
      } catch (e) {
        if (live) setError(friendlyError(e).message)
      }
    })()
    return () => { live = false; destroy(); viewRef.current?.bitmap.close() }
  }, [file])

  useEffect(() => {
    if (!doc) return
    let live = true
    void (async () => {
      try {
        const page = await doc.getPage(pageNo + 1)
        const { width, height } = page.getViewport({ scale: 1 })
        const canvas = document.createElement('canvas')
        await (await import('./pdfjs')).renderPage(page, Math.min(3, 1600 / Math.max(width, height)), canvas)
        page.cleanup()
        const bitmap = await createImageBitmap(canvas)
        canvas.width = canvas.height = 0 // release the bitmap memory now
        if (!live) return bitmap.close()
        viewRef.current?.bitmap.close()
        setView({ page: pageNo, bitmap, width, height })
      } catch (e) {
        if (live) setError(friendlyError(e).message)
      }
    })()
    return () => { live = false }
  }, [doc, pageNo])

  /** A place for something new: the middle of the part of the page that's on screen, nudged so new things don't hide each other. */
  const spot = (v: View, width: number, height: number): Point => {
    const r = svg.current?.getBoundingClientRect()
    const top = r ? Math.max(r.top, 0) : 0
    const bottom = r ? Math.min(r.bottom, innerHeight) : 0
    const middle = r && bottom > top ? (((top + bottom) / 2 - r.top) * v.height) / r.height : v.height / 2
    const nudge = (latest.current.length % 6) * 8
    return { x: v.width / 2 - width / 2 + nudge, y: middle - height / 2 + nudge }
  }
  const full = () => {
    if (latest.current.length < MAX_STAMPS) return false
    setProblem(`A PDF can take up to ${MAX_STAMPS} added items. Remove one to add another.`)
    return true
  }

  // Pictures that arrive while the editor is open (chosen, dropped, pasted or drawn) go on the page being shown.
  const placed = useRef(images.length)
  useEffect(() => {
    if (!view || placed.current >= images.length) return
    const first = placed.current
    placed.current = images.length
    void (async () => {
      const added: Stamp[] = []
      const unreadable: string[] = []
      for (let i = first; i < images.length && latest.current.length + added.length < MAX_STAMPS; i++) {
        const size = await pictureSize(images[i]!)
        if (!size) { unreadable.push(`“${images[i]!.name}”`); continue }
        const fit = Math.min((view.width * 0.35) / size.width, (view.height * 0.25) / size.height)
        const [width, height] = [size.width * fit, size.height * fit]
        const at = spot(view, width, height)
        added.push(onPage({ page: view.page, x: at.x + added.length * 8, y: at.y + added.length * 8, image: i, width, height }, view))
      }
      setProblem(unreadable.length ? `${unreadable.join(', ')} couldn’t be shown as ${unreadable.length === 1 ? 'a picture' : 'pictures'}, so ${unreadable.length === 1 ? 'it wasn’t' : 'they weren’t'} added. Try saving a fresh copy as PNG or JPG.` : null)
      if (!added.length) return
      onChange([...latest.current, ...added])
      setSelected(latest.current.length + added.length - 1)
      announce(`${added.length === 1 ? `${images[first]!.name} is` : `${added.length} pictures are`} on page ${view.page + 1}. Drag to move, or use the arrow keys.`)
    })()
  }, [images.length, view])

  const shown = drag && selected === drag.index ? drag.stamp : selected !== null ? stamps[selected] : undefined
  const current = shown && view && shown.page === view.page ? shown : undefined
  useLayoutEffect(() => {
    const b = current ? selectedEl.current?.getBBox() : null
    setBox(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null)
  }, [current, view])
  useEffect(() => {
    if (focusText.current && current && 'text' in current) { focusText.current = false; textField.current?.focus() }
  }, [current])

  if (error) return <div role="alert" className="rounded-lg border border-danger/40 p-4 text-danger">{error}</div>
  if (!doc || !view) return <p className="text-muted" role="status">Opening the PDF…</p>

  const moved = (s: Stamp, dx: number, dy: number) => onPage({ ...s, x: s.x + dx, y: s.y + dy }, view)
  const scaled = (s: Stamp, by: number): Stamp => {
    if ('text' in s) return { ...s, size: clamp(s.size * by, 4, 200) }
    const k = clamp(by, 8 / s.width, Math.min(view.width / s.width, view.height / s.height)) // never larger than the page
    return onPage({ ...s, width: s.width * k, height: s.height * k }, view)
  }
  const change = (index: number, stamp: Stamp) => onChange(stamps.map((s, i) => (i === index ? stamp : s)))
  const remove = (index: number) => {
    onChange(stamps.filter((_, i) => i !== index))
    setSelected(null)
    firstTool.current?.focus()
    announce('Removed.')
  }
  const addText = () => {
    if (full()) return
    onChange([...stamps, onPage({ page: view.page, ...spot(view, 90, 0), text: '', size: 14 }, view)])
    setSelected(stamps.length)
    focusText.current = true
    announce(`Text added to page ${view.page + 1}. Type what it should say.`)
  }

  const toPage = (e: PointerEvent): Point => {
    const r = svg.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * view.width) / r.width, y: ((e.clientY - r.top) * view.height) / r.height }
  }
  const startDrag = (e: PointerEvent, index: number, resize: boolean) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelected(index)
    grab.current = { index, resize, from: toPage(e), start: stamps[index]!, box, now: null }
  }
  const moveDrag = (e: PointerEvent) => {
    const g = grab.current
    if (!g) return
    const p = toPage(e)
    g.now = g.resize && g.box ? scaled(g.start, Math.max(0.05, (g.box.width + p.x - g.from.x) / g.box.width)) : moved(g.start, p.x - g.from.x, p.y - g.from.y)
    setDrag({ index: g.index, stamp: g.now })
  }
  const endDrag = () => {
    const g = grab.current
    grab.current = null
    setDrag(null)
    if (g?.now) change(g.index, g.now) // saved once, when the pointer is let go
  }
  const onKey = (e: KeyboardEvent, index: number) => {
    const s = stamps[index]!
    const by = e.shiftKey ? 10 : 1
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }
    const arrow = arrows[e.key]
    if (arrow) change(index, moved(s, ...arrow))
    else if (e.key === '+' || e.key === '=') change(index, scaled(s, 1.1))
    else if (e.key === '-') change(index, scaled(s, 1 / 1.1))
    else if (e.key === 'Delete' || e.key === 'Backspace') remove(index)
    else return
    e.preventDefault()
  }
  const describe = (s: Stamp) => ('text' in s ? (s.text.trim() ? `Text: ${s.text.trim()}` : 'Empty text') : `Picture: ${images[s.image]?.name ?? 'image'}`)
  const turnPage = (to: number) => { if (to >= 0 && to < doc.numPages) { setPageNo(to); setSelected(null) } }

  const here = stamps.filter((s) => s.page === view.page).length
  const sel = selected !== null ? stamps[selected] : undefined

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap gap-2">
          <button ref={firstTool} type="button" onClick={addText} className={tool}>Add text</button>
          <button type="button" onClick={() => { if (!full()) onPick() }} className={tool}>Add image</button>
          <button type="button" onClick={() => { if (!full()) setSigning(true) }} className={tool}>Draw signature</button>
        </div>
        {doc.numPages > 1 && (
          <div className="flex items-center gap-2 tabular-nums">
            <button type="button" onClick={() => turnPage(pageNo - 1)} aria-disabled={pageNo === 0} aria-label="Previous page" className={tool}>←</button>
            <span aria-live="polite">Page {pageNo + 1} of {doc.numPages}</span>
            <button type="button" onClick={() => turnPage(pageNo + 1)} aria-disabled={pageNo === doc.numPages - 1} aria-label="Next page" className={tool}>→</button>
          </div>
        )}
      </div>

      {/* Always one line tall, so the page below never jumps when something is selected mid-drag. */}
      <div className="flex h-10 items-center gap-2">
        {!sel ? (
          <p className="truncate text-sm text-muted">{stamps.length ? 'Select something on the page to change it.' : 'Add text, an image or your signature, then drag it into place.'}</p>
        ) : (
          <>
            {'text' in sel ? (
              <input
                ref={textField}
                value={sel.text}
                maxLength={MAX_STAMP_TEXT}
                placeholder="Type your text"
                aria-label="Text on the page"
                onChange={(e) => change(selected!, { ...sel, text: e.target.value })}
                className="min-w-0 flex-1 rounded-md border border-line bg-field px-3 py-1.5"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-muted">{images[sel.image]?.name}</span>
            )}
            <button type="button" onClick={() => change(selected!, scaled(sel, 1 / 1.1))} aria-label="Make it smaller" className={tool}>−</button>
            <button type="button" onClick={() => change(selected!, scaled(sel, 1.1))} aria-label="Make it larger" className={tool}>+</button>
            <button type="button" onClick={() => remove(selected!)} className={`${tool} text-danger`}>Remove</button>
          </>
        )}
      </div>
      {problem && <p role="status" className="text-sm text-danger">{problem}</p>}

      <div className="overflow-clip rounded-xl border border-rule bg-field p-3 sm:p-5">
        <div
          className="relative mx-auto shadow-[0_1px_4px_rgb(0_0_0/0.22)]"
          style={{ aspectRatio: `${view.width} / ${view.height}`, maxWidth: `calc(85vh * ${view.width / view.height})` }}
        >
          <BitmapCanvas bitmap={view.bitmap} className={`block h-full w-full transition-opacity ${view.page === pageNo ? '' : 'opacity-50'}`} label={`Page ${view.page + 1}`} />
          <svg
            ref={svg}
            viewBox={`0 0 ${view.width} ${view.height}`}
            role="group"
            aria-label={`Added to page ${view.page + 1}`}
            className="absolute inset-0 h-full w-full"
            onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null) }}
          >
            {stamps.map((saved, i) => {
              const s = drag?.index === i ? drag.stamp : saved
              if (s.page !== view.page) return null
              return (
                <g
                  key={i}
                  ref={i === selected ? selectedEl : undefined}
                  tabIndex={0}
                  role="button"
                  aria-pressed={i === selected}
                  aria-label={describe(s)}
                  aria-describedby={hintId}
                  className="cursor-move touch-none select-none focus:outline-none"
                  onFocus={() => setSelected(i)}
                  onKeyDown={(e) => onKey(e, i)}
                  onPointerDown={(e) => startDrag(e, i, false)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  {'text' in s ? (
                    <text x={s.x} y={s.y} fontSize={s.size} fontFamily="Helvetica, Arial, sans-serif" fill={s.text.trim() ? '#000' : '#6B6B6B'}>
                      {s.text.trim() ? s.text : 'Type your text'}
                    </text>
                  ) : (
                    <Picture file={images[s.image]} stamp={s} />
                  )}
                </g>
              )
            })}
          </svg>
          {box && (
            <div
              className="pointer-events-none absolute"
              style={{ left: percent(box.x / view.width), top: percent(box.y / view.height), width: percent(box.width / view.width), height: percent(box.height / view.height) }}
            >
              <div className="absolute -inset-1 border border-dashed shadow-[0_0_0_1px_#fff]" style={{ borderColor: MARK }} />
              <span
                aria-hidden="true"
                className="pointer-events-auto absolute -right-3 -bottom-3 h-6 w-6 cursor-nwse-resize touch-none rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]"
                style={{ background: MARK }}
                onPointerDown={(e) => { if (selected !== null) startDrag(e, selected, true) }}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            </div>
          )}
        </div>
      </div>

      <p id={hintId} className="max-w-[70ch] text-sm text-muted">
        {stamps.length > 0 && `${stamps.length} added, ${here} on this page. `}
        Drag to move, and pull the round handle to resize. With the keyboard: the arrow keys move the selected item (hold Shift for bigger steps), + and − resize it, and Delete removes it.
      </p>

      {signing && <SignaturePad onClose={() => setSigning(false)} onDone={(signature) => { setSigning(false); onAddImage(signature) }} />}
    </div>
  )
}

const INK = '#10204A'

/** Draw a signature with a mouse, finger or pen. It becomes a see-through picture, trimmed to the ink. */
function SignaturePad({ onDone, onClose }: { onDone: (file: File) => void; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const pen = useRef<{ from: Point; last: Point } | null>(null)
  /** Left, top, right, bottom of everything drawn so far, in canvas pixels. */
  const inked = useRef<[number, number, number, number] | null>(null)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const scale = Math.min(3, window.devicePixelRatio || 1)
    c.width = Math.round(c.clientWidth * scale)
    c.height = Math.round(c.clientHeight * scale)
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.strokeStyle = ctx.fillStyle = INK
    ctx.lineWidth = 2.4 * scale
    ctx.lineCap = ctx.lineJoin = 'round'
  }, [])

  const at = (c: HTMLCanvasElement, e: { clientX: number; clientY: number }): Point => {
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }
  }
  const grow = (p: Point) => {
    const b = inked.current
    inked.current = b ? [Math.min(b[0], p.x), Math.min(b[1], p.y), Math.max(b[2], p.x), Math.max(b[3], p.y)] : [p.x, p.y, p.x, p.y]
  }
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget
    const ctx = c.getContext('2d')
    if (!ctx) return
    c.setPointerCapture(e.pointerId)
    const p = at(c, e)
    pen.current = { from: p, last: p }
    ctx.beginPath()
    ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2) // a tap leaves a dot
    ctx.fill()
    grow(p)
    setEmpty(false)
  }
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget
    const ctx = c.getContext('2d')
    const stroke = pen.current
    if (!stroke || !ctx) return
    // Browsers merge fast pointer movements; the merged points keep quick strokes round instead of angular.
    for (const ev of e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]) {
      const p = at(c, ev)
      const mid: Point = { x: (stroke.last.x + p.x) / 2, y: (stroke.last.y + p.y) / 2 }
      ctx.beginPath()
      ctx.moveTo(stroke.from.x, stroke.from.y)
      ctx.quadraticCurveTo(stroke.last.x, stroke.last.y, mid.x, mid.y)
      ctx.stroke()
      stroke.from = mid
      stroke.last = p
      grow(p)
    }
  }
  const clear = () => {
    const c = canvas.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    inked.current = null
    setEmpty(true)
  }
  const place = () => {
    const c = canvas.current
    const b = inked.current
    const ctx = c?.getContext('2d')
    if (!c || !b || !ctx) return
    const pad = ctx.lineWidth
    const x = Math.max(0, Math.floor(b[0] - pad)), y = Math.max(0, Math.floor(b[1] - pad))
    const width = Math.min(c.width, Math.ceil(b[2] + pad)) - x, height = Math.min(c.height, Math.ceil(b[3] + pad)) - y
    const trimmed = document.createElement('canvas')
    trimmed.width = width
    trimmed.height = height
    trimmed.getContext('2d')?.drawImage(c, x, y, width, height, 0, 0, width, height)
    trimmed.toBlob((blob) => { if (blob) onDone(new File([blob], 'signature.png', { type: 'image/png' })) }, 'image/png')
  }

  return (
    <Dialog title="Draw your signature" onClose={onClose} wide>
      <div className="relative">
        <canvas
          ref={canvas}
          role="img"
          aria-label="Signature area. Draw with a mouse, finger or pen."
          className="block h-48 w-full cursor-crosshair touch-none rounded-lg border border-line bg-white"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={() => { pen.current = null }}
          onPointerCancel={() => { pen.current = null }}
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-6 bottom-12 border-b border-[#B9C0BC]" />
      </div>
      <p className="mt-3 text-sm text-muted">
        This puts a picture of your signature on the page. It isn’t a certified digital signature. Can’t draw here? Photograph or scan your signature and use Add image.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={() => { if (!empty) place() }} aria-disabled={empty} className="rounded-lg bg-jade px-4 py-2 font-semibold text-on-jade aria-disabled:opacity-50">Place signature</button>
        <button type="button" onClick={clear} className="rounded-lg border border-line px-4 py-2 hover:border-ink">Clear</button>
        <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2 hover:border-ink">Cancel</button>
      </div>
    </Dialog>
  )
}
