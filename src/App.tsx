import { useCallback, useEffect, useRef, useState } from 'react'
import { detectFile, formatBytes, limitProblem, LIMITS, type Detected } from './core/detect'
import { etaSeconds, friendlyError, poolSize, releaseWorkers, runPool, runTask, zipBlobs } from './core/jobs'
import { startNetworkLog } from './core/network'
import { LOSSLESS_SCRUB, defaultStep, opsFor, outputMime, outputName, type Step } from './core/ops'
import type { MetadataReport } from './ops/scrub'
import { BatchList } from './ui/Batch'
import { download, pasteShortcut, percent } from './ui/hooks'
import { Options } from './ui/Options'
import { Proof, useRequestsElsewhere } from './ui/Proof'
import { SingleResult } from './ui/Result'

export interface Output { blob: Blob; name: string; width?: number; height?: number; report?: MetadataReport; preview?: ImageBitmap }

export interface Item {
  id: number
  file: File
  detected: Detected
  problem: string | null
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  stage: string
  startedAt?: number
  output?: Output
  error?: string
}

const unsupported = (d: Detected) =>
  `Switchlet can’t convert ${d.kind === 'unknown' ? 'this kind of file' : `${d.label}s`} yet. Right now it works with photos and images: JPG, PNG, WebP, AVIF, HEIC and GIF.`

let nextId = 1
startNetworkLog()

export function App() {
  const [items, setItems] = useState<Item[]>([])
  const [step, setStep] = useState<Step | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [batch, setBatch] = useState<{ running: boolean; startedAt: number } | null>(null)
  const [runNonce, setRunNonce] = useState(0)
  const session = useRef(0)
  const batchCtrl = useRef<AbortController | null>(null)
  const singleCtrl = useRef<AbortController | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const elsewhere = useRequestsElsewhere()

  const patch = useCallback((id: number, p: Partial<Item>) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it))), [])

  const clear = useCallback(() => {
    batchCtrl.current?.abort()
    singleCtrl.current?.abort()
    releaseWorkers() // frees decoded pixels and WASM memory
    setItems((old) => { old.forEach((it) => it.output?.preview?.close()); return [] })
    setStep(null)
    setBatch(null)
    setNotice(null)
  }, [])

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    clear()
    const current = ++session.current
    const accepted = files.slice(0, LIMITS.batchFiles)
    const next = await Promise.all(
      accepted.map(async (file): Promise<Item> => {
        const detected = await detectFile(file)
        const problem = limitProblem(detected, file.size) ?? (opsFor(detected.kind).length ? null : unsupported(detected))
        return { id: nextId++, file, detected, problem, status: 'idle', progress: 0, stage: '' }
      }),
    )
    if (current !== session.current) return // a newer drop replaced this one
    const usable = next.filter((it) => !it.problem)
    setItems(next)
    setStep(usable[0] ? defaultStep(usable[0].detected.kind) : null)
    setNotice(files.length > accepted.length ? `Only the first ${LIMITS.batchFiles} files were added.` : null)
    setAnnouncement(next.length === 1 ? `Added ${next[0]!.file.name}.` : `Added ${next.length} files, ${usable.length} can be converted.`)
  }, [clear])

  const convert = useCallback(async (item: Item, s: Step, signal: AbortSignal, quietCancel: boolean) => {
    const startedAt = performance.now()
    patch(item.id, { status: 'running', progress: 0, stage: 'Starting', error: undefined, startedAt })
    try {
      const r = await runTask({ ...s, file: item.file, kind: item.detected.kind }, {
        signal,
        onProgress: (progress, stage) => { if (!signal.aborted) patch(item.id, { progress, stage }) },
      })
      if (signal.aborted) { r.preview?.close(); return }
      const output: Output = {
        blob: new Blob([r.data], { type: outputMime(item.detected.kind, s) }),
        name: outputName(item.file.name, item.detected.kind, s),
        width: r.width, height: r.height, report: r.report, preview: r.preview,
      }
      setItems((list) => list.map((it) => {
        if (it.id !== item.id) return it
        it.output?.preview?.close()
        return { ...it, status: 'done', progress: 1, output }
      }))
      return output
    } catch (e) {
      const err = friendlyError(e)
      if (err.kind === 'cancelled') { if (!quietCancel) patch(item.id, { status: 'cancelled' }) }
      else patch(item.id, { status: 'error', error: err.message })
    }
  }, [patch])

  // Single file: convert live as settings change (debounced); a newer run cancels the older one.
  const single = items.length === 1 && !items[0]!.problem ? items[0]! : null
  const stepKey = JSON.stringify(step)
  useEffect(() => {
    if (!single || !step) return
    const ctrl = new AbortController()
    singleCtrl.current = ctrl
    const timer = setTimeout(async () => {
      const out = await convert(single, step, ctrl.signal, true)
      if (out) setAnnouncement(`${out.name} is ready, ${formatBytes(out.blob.size)}.`)
    }, 250)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [single?.id, stepKey, runNonce, convert]) // rerun only when the file, settings or retry change

  // Batch: changing settings invalidates earlier results.
  useEffect(() => {
    if (items.length < 2) return
    setItems((list) => list.map((it) => (it.output || it.status !== 'idle' ? { ...it, status: 'idle', output: undefined, error: undefined, progress: 0 } : it)))
    setBatch(null)
  }, [stepKey])

  const usable = items.filter((it) => !it.problem)

  const convertAll = async () => {
    if (!step) return
    const ctrl = new AbortController()
    batchCtrl.current = ctrl
    setBatch({ running: true, startedAt: performance.now() })
    setAnnouncement(`Converting ${usable.length} files.`)
    await runPool(usable, poolSize(), (it) => convert(it, step, ctrl.signal, false).then(() => {}))
    releaseWorkers()
    setBatch((b) => b && { ...b, running: false })
    setAnnouncement(ctrl.signal.aborted ? 'Conversion cancelled.' : 'All files converted.')
  }

  const downloadZip = async () => {
    const done = items.filter((it) => it.output)
    const zip = await zipBlobs(done.map((it) => ({ name: it.output!.name, blob: it.output!.blob })))
    releaseWorkers()
    download(zip, `switchlet-${done.length}-files.zip`)
  }

  // Drop files anywhere on the page, or paste them.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDragging(true) }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false) } }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      void addFiles([...(e.dataTransfer?.files ?? [])])
    }
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length) { e.preventDefault(); void addFiles(files) }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [addFiles])

  const pick = () => picker.current?.click()
  const canScrub = usable.length > 0 && usable.every((it) => LOSSLESS_SCRUB.has(it.detected.kind))
  const doneCount = items.filter((it) => it.status === 'done').length
  const batchProgress = usable.length ? usable.reduce((n, it) => n + (it.status === 'done' ? 1 : it.status === 'running' ? it.progress : 0), 0) / usable.length : 0
  const batchEta = batch?.running ? etaSeconds(batch.startedAt, batchProgress) : null
  const zipSize = items.reduce((n, it) => n + (it.output?.blob.size ?? 0), 0)

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-5 sm:px-8">
        <button type="button" onClick={clear} className="flex items-center gap-2.5 text-lg font-semibold tracking-tight" aria-label="Switchlet, start over">
          <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true"><rect width="32" height="32" rx="7" className="fill-jade" /><path d="M4 21h7M21 21h7M11 21l9-9" className="stroke-on-jade" strokeWidth="2.6" strokeLinecap="round" fill="none" /><circle cx="11" cy="21" r="2.2" className="fill-on-jade" /><circle cx="21" cy="21" r="2.2" className="stroke-on-jade" strokeWidth="2" fill="none" /></svg>
          Switchlet
        </button>
        <a href="#proof" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
          <span className="tabular-nums">{elsewhere}</span> requests to other servers
        </a>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-20 sm:px-8">
        {items.length === 0 ? (
          <section className="pt-8 sm:pt-14">
            <h1 className="max-w-[15ch] text-[clamp(2.6rem,7.5vw,5.25rem)] leading-[1.02] font-light tracking-[-0.025em]">Convert files without uploading them.</h1>
            <p className="mt-6 max-w-[54ch] text-lg leading-relaxed text-muted">
              Switchlet converts, shrinks and cleans up photos right here in your browser. Nothing you add is sent anywhere, and the counter at the bottom of this page shows it.
            </p>
            <button
              type="button"
              onClick={pick}
              className="mt-10 grid w-full gap-2 rounded-2xl border-[1.5px] border-line bg-field px-6 py-12 text-left transition-colors hover:border-jade sm:px-10 sm:py-16"
            >
              <span className="text-2xl font-medium sm:text-3xl">Drop photos anywhere on this page</span>
              <span className="text-muted">
                or <span className="font-medium text-jade underline underline-offset-4">choose files</span>, or paste with {pasteShortcut}
              </span>
              <span className="mt-4 text-sm text-muted">JPG, PNG, WebP, AVIF, HEIC and GIF. Up to {LIMITS.batchFiles} at a time.</span>
            </button>
          </section>
        ) : (
          <section className="pt-6" aria-label="Your files">
            <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-rule pb-4">
              <h1 className="min-w-0 text-2xl font-medium">
                {items.length === 1 ? (
                  <>
                    <span className="block truncate">{items[0]!.file.name}</span>
                    <span className="block text-base font-normal text-muted">
                      {items[0]!.detected.label}
                      {items[0]!.detected.width ? `, ${items[0]!.detected.width} × ${items[0]!.detected.height}` : ''}, {formatBytes(items[0]!.file.size)}
                    </span>
                  </>
                ) : (
                  `${items.length} files`
                )}
              </h1>
              <button type="button" onClick={pick} className="rounded-md border border-line px-3 py-1.5 hover:border-ink">Choose other files</button>
            </div>
            {notice && <p className="mt-4 text-muted">{notice}</p>}

            {single && step ? (
              <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
                <Options step={step} onChange={setStep} canScrub={canScrub} dims={single.detected.width ? { width: single.detected.width, height: single.detected.height! } : single.output?.width ? { width: single.output.width, height: single.output.height! } : undefined} />
                <SingleResult item={single} onCancel={() => { singleCtrl.current?.abort(); patch(single.id, { status: 'cancelled' }) }} onRetry={() => setRunNonce((n) => n + 1)} />
              </div>
            ) : items.length === 1 ? (
              <div role="alert" className="mt-8 max-w-[60ch] space-y-4">
                <p className="text-lg">{items[0]!.problem}</p>
                <button type="button" onClick={pick} className="rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade">Choose another file</button>
              </div>
            ) : (
              <div className="mt-8 space-y-8">
                {step && <Options step={step} onChange={setStep} canScrub={canScrub} />}
                <div className="flex flex-wrap items-center gap-4">
                  {batch?.running ? (
                    <>
                      <div className="min-w-48 flex-1" role="status">
                        <p>
                          {doneCount} of {usable.length} done, <span className="tabular-nums">{percent(batchProgress)}</span>
                          {batchEta !== null && <span className="text-muted">, about {batchEta} s left</span>}
                        </p>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-rule"><div className="h-full bg-jade" style={{ width: percent(batchProgress) }} /></div>
                      </div>
                      <button type="button" onClick={() => batchCtrl.current?.abort()} className="rounded-md border border-line px-4 py-2 hover:border-ink">Cancel</button>
                    </>
                  ) : (
                    usable.length > 0 && step && (
                      <button type="button" onClick={convertAll} className="rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade hover:brightness-110">
                        {doneCount ? `Convert ${usable.length} files again` : `Convert ${usable.length} ${usable.length === 1 ? 'file' : 'files'}`}
                      </button>
                    )
                  )}
                  {!batch?.running && doneCount > 0 && (
                    <button type="button" onClick={downloadZip} className="rounded-lg border border-jade px-5 py-3 font-semibold text-jade hover:bg-jade hover:text-on-jade">
                      Download all as ZIP ({formatBytes(zipSize)})
                    </button>
                  )}
                </div>
                <BatchList items={items} />
              </div>
            )}
          </section>
        )}

        <Proof />
      </main>

      <input ref={picker} type="file" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-3xl border-2 border-jade bg-paper/90">
          <p className="text-3xl font-light">Drop to convert on this device</p>
        </div>
      )}
      <div aria-live="polite" className="sr-only">{announcement}</div>
    </div>
  )
}
