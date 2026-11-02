import { useCallback, useEffect, useRef, useState } from 'react'
import { detectFile, formatBytes, limitProblem, LIMITS, type Detected } from './core/detect'
import { etaSeconds, friendlyError, mediaCapabilities, poolSize, releaseWorkers, runPool, runStep, zipBlobs } from './core/jobs'
import { startNetworkLog } from './core/network'
import { OPS, defaultOp, makeStep, opsFor, stem, type MediaCaps, type OpId, type Step, type TaskResult } from './core/ops'
import { BatchList } from './ui/Batch'
import { download, pasteShortcut, percent } from './ui/hooks'
import { Options } from './ui/Options'
import { JobResult } from './ui/Outputs'
import { PageSorter } from './ui/PageSorter'
import { Proof, useProofHeadline } from './ui/Proof'
import { MediaStage, RunMedia } from './ui/MediaStage'
import { ImageResult } from './ui/Result'

export type Output = Omit<TaskResult, 'files'> & { files: { blob: Blob; name: string }[] }

export interface Job {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  stage: string
  startedAt?: number
  output?: Output
  error?: string
}

export interface Item extends Job {
  id: number
  file: File
  detected: Detected
  problem: string | null
}

const IDLE: Job = { status: 'idle', progress: 0, stage: '' }
const SUPPORTED = 'photos (JPG, PNG, WebP, AVIF, HEIC, GIF), PDFs, video (MP4, MOV, WebM, MKV), audio (MP3, WAV, M4A, OGG, FLAC), Markdown, HTML, CSV, JSON and Excel files'
const unsupported = (d: Detected) => `${d.kind === 'unknown' ? 'This kind of file' : `${d.label}s`} can’t be converted yet. Switchlet works with ${SUPPORTED}.`
/** Tasks whose output is the same kind of file, where "X kB to Y kB, 40% smaller" means something. */
const SAME_KIND = new Set<OpId>(['pdf.compress', 'pdf.scrub', 'pdf.pages', 'video.convert'])
const MEDIA_OPS = new Set<OpId>(['video.convert', 'video.trim', 'video.gif', 'media.audio'])
const VERB: Partial<Record<OpId, string>> = { 'image.scrub': 'Clean', 'pdf.scrub': 'Clean', 'pdf.split': 'Split', 'pdf.compress': 'Shrink' }

const toOutput = (r: TaskResult): Output => ({
  ...r,
  files: r.files.map((f) => ({ name: f.name, blob: new Blob([f.data], { type: f.type }) })),
})

let nextId = 1
startNetworkLog()

export function App() {
  const [items, setItems] = useState<Item[]>([])
  const [step, setStep] = useState<Step | null>(null)
  const [combo, setCombo] = useState<Job>(IDLE)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [batch, setBatch] = useState<{ running: boolean; startedAt: number } | null>(null)
  const [runNonce, setRunNonce] = useState(0)
  const [caps, setCaps] = useState<MediaCaps>()
  /** Settings of the last on-demand (audio/video) run, to tell when the result no longer matches them. */
  const [ranKey, setRanKey] = useState<string | null>(null)
  const session = useRef(0)
  const batchCtrl = useRef<AbortController | null>(null)
  const singleCtrl = useRef<AbortController | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const proofHeadline = useProofHeadline()

  const patch = useCallback((id: number, p: Partial<Item>) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it))), [])

  const clear = useCallback(() => {
    batchCtrl.current?.abort()
    singleCtrl.current?.abort()
    releaseWorkers() // frees decoded pixels and WASM memory
    setItems((old) => { old.forEach((it) => it.output?.preview?.close()); return [] })
    setStep(null)
    setCombo(IDLE)
    setBatch(null)
    setNotice(null)
    setRanKey(null)
  }, [])

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    clear()
    const current = ++session.current
    const accepted = files.slice(0, LIMITS.batchFiles)
    const next = await Promise.all(
      accepted.map(async (file): Promise<Item> => {
        const detected = await detectFile(file)
        const problem = limitProblem(detected, file.size) ?? (opsFor([detected.kind]).length ? null : unsupported(detected))
        return { ...IDLE, id: nextId++, file, detected, problem }
      }),
    )
    if (current !== session.current) return // a newer drop replaced this one
    const kinds = next.filter((it) => !it.problem).map((it) => it.detected.kind)
    const op = defaultOp(kinds)
    setItems(next)
    setStep(op ? makeStep(op, kinds[0]!) : null)
    const mixed = kinds.length > 1 && !opsFor(kinds).length
    setNotice(
      mixed ? 'These files are different kinds. Switchlet works on one kind at a time: drop just the photos, just the PDFs, or just the documents.'
      : files.length > accepted.length ? `Only the first ${LIMITS.batchFiles} files were added.`
      : null,
    )
    setAnnouncement(next.length === 1 ? `Added ${next[0]!.file.name}.` : `Added ${next.length} files, ${kinds.length} can be converted.`)
  }, [clear])

  const convertItem = useCallback(async (item: Item, s: Step, signal: AbortSignal, quietCancel: boolean) => {
    patch(item.id, { status: 'running', progress: 0, stage: 'Starting', error: undefined, startedAt: performance.now() })
    try {
      const r = await runStep(s, [item.file], [item.detected.kind], {
        signal,
        onProgress: (progress, stage) => { if (!signal.aborted) patch(item.id, { progress, stage }) },
      })
      if (signal.aborted) { r.preview?.close(); return }
      const output = toOutput(r)
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

  const usable = items.filter((it) => !it.problem)
  const ops = opsFor(usable.map((it) => it.detected.kind))
  const single = items.length === 1 && usable.length === 1 ? usable[0]! : null
  const combines = !!step && !!OPS[step.op].combines && usable.length > 1
  const stepKey = JSON.stringify(step)

  // Audio/video: ask the worker once which formats this browser can create, to grey out the rest.
  const hasMedia = usable.some((it) => it.detected.group === 'media')
  useEffect(() => {
    if (hasMedia && !caps) mediaCapabilities().then(setCaps, () => {})
  }, [hasMedia, caps])

  // Audio/video on a single file: runs when the user presses the button (encoding is heavy).
  const runSingle = () => {
    if (!single || !step) return
    singleCtrl.current?.abort()
    const ctrl = new AbortController()
    singleCtrl.current = ctrl
    setRanKey(stepKey)
    void convertItem(single, step, ctrl.signal, false).then((out) => {
      if (out) setAnnouncement(out.files[0] ? `${out.files[0].name} is ready, ${formatBytes(out.files[0].blob.size)}.` : out.note ?? 'Done.')
    })
  }

  // Single file: run live as settings change (debounced); a newer run cancels the older one.
  useEffect(() => {
    if (!single || !step) return
    if (OPS[step.op].manual) return
    if (step.op === 'pdf.pages' && !step.settings.order) return // nothing to save until a page moves
    const ctrl = new AbortController()
    singleCtrl.current = ctrl
    const timer = setTimeout(async () => {
      const out = await convertItem(single, step, ctrl.signal, true)
      if (out) setAnnouncement(out.files.length === 1 ? `${out.files[0]!.name} is ready, ${formatBytes(out.files[0]!.blob.size)}.` : out.files.length ? `${out.files.length} files are ready.` : out.note ?? 'Done.')
    }, 250)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [single?.id, stepKey, runNonce, convertItem]) // rerun only when the file, settings or retry change

  // Several files: changing the task or its settings invalidates earlier results.
  useEffect(() => {
    if (items.length < 2) return
    setItems((list) => list.map((it) => (it.output || it.status !== 'idle' ? { ...it, ...IDLE, output: undefined, error: undefined } : it)))
    setCombo(IDLE)
    setBatch(null)
  }, [stepKey])

  const runAll = async () => {
    if (!step) return
    const ctrl = new AbortController()
    batchCtrl.current = ctrl
    if (combines) {
      setCombo({ ...IDLE, status: 'running', stage: 'Starting', startedAt: performance.now() })
      try {
        const r = await runStep(step, usable.map((it) => it.file), usable.map((it) => it.detected.kind), {
          signal: ctrl.signal,
          onProgress: (progress, stage) => setCombo((c) => ({ ...c, progress, stage })),
        })
        setCombo({ ...IDLE, status: 'done', progress: 1, output: toOutput(r) })
        setAnnouncement(`${r.files[0]?.name ?? 'Your file'} is ready.`)
      } catch (e) {
        const err = friendlyError(e)
        setCombo({ ...IDLE, status: err.kind === 'cancelled' ? 'cancelled' : 'error', error: err.message })
      }
      releaseWorkers()
      return
    }
    setBatch({ running: true, startedAt: performance.now() })
    setAnnouncement(`Working on ${usable.length} files.`)
    // AVIF and PNG encoders already use every core; main-thread tasks share one thread. One at a time for those.
    const oneAtATime = !!OPS[step.op].main || !!OPS[step.op].manual || (step.op === 'image.convert' && (step.settings.format === 'avif' || step.settings.format === 'png'))
    await runPool(usable, oneAtATime ? 1 : poolSize(), (it) => convertItem(it, step, ctrl.signal, false).then(() => {}))
    releaseWorkers()
    setBatch((b) => b && { ...b, running: false })
    setAnnouncement(ctrl.signal.aborted ? 'Cancelled.' : 'All files are done.')
  }

  const allFiles = items.flatMap((it) => it.output?.files ?? [])
  const downloadZip = async () => {
    download(await zipBlobs(allFiles), `switchlet-${allFiles.length}-files.zip`)
    releaseWorkers()
  }

  const moveItem = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return
    setItems((list) => { const next = [...list]; const [it] = next.splice(from, 1); next.splice(to, 0, it!); return next })
    setCombo(IDLE)
  }

  // Drop files anywhere on the page, or paste them. (Dragging page thumbnails carries no files, so it's ignored here.)
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
  const kind = usable[0]?.detected.kind ?? 'unknown'
  const doneCount = items.filter((it) => it.status === 'done').length
  const batchProgress = usable.length ? usable.reduce((n, it) => n + (it.status === 'done' ? 1 : it.status === 'running' ? it.progress : 0), 0) / usable.length : 0
  const batchEta = batch?.running ? etaSeconds(batch.startedAt, batchProgress) : null
  const options = (
    <Options
      ops={ops}
      step={step}
      kind={kind}
      onChange={setStep}
      fileCount={usable.length}
      caps={caps}
      sheets={single?.output?.sheets}
      dims={single?.detected.width ? { width: single.detected.width, height: single.detected.height! } : single?.output?.width ? { width: single.output.width, height: single.output.height! } : undefined}
    />
  )
  const cancelSingle = () => { singleCtrl.current?.abort(); if (single) patch(single.id, { status: 'cancelled' }) }
  const retrySingle = () => setRunNonce((n) => n + 1)
  const runLabel = !step ? '' : step.op === 'pdf.merge' ? `Merge ${usable.length} PDFs` : step.op === 'image.toPdf' ? `Make a PDF from ${usable.length} images` : `${VERB[step.op] ?? 'Convert'} ${usable.length} files`

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-5 sm:px-8">
        <button type="button" onClick={clear} className="flex items-center gap-2.5 text-lg font-semibold tracking-tight" aria-label="Switchlet, start over">
          <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true"><rect width="32" height="32" rx="7" className="fill-jade" /><path d="M4 21h7M23.4 21H28M11 21l9-9" className="stroke-on-jade" strokeWidth="2.6" strokeLinecap="round" fill="none" /><circle cx="11" cy="21" r="2.2" className="fill-on-jade" /><circle cx="21" cy="21" r="2.4" className="stroke-on-jade" strokeWidth="1.4" fill="none" /></svg>
          Switchlet
        </button>
        <a href="#proof" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
          <span className="tabular-nums">{proofHeadline}</span>
        </a>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-20 sm:px-8">
        {items.length === 0 ? (
          <section className="pt-8 sm:pt-14">
            <h1 className="max-w-[15ch] text-[clamp(2.6rem,7.5vw,5.25rem)] leading-[1.02] font-light tracking-[-0.025em]">Convert files without uploading them.</h1>
            <p className="mt-6 max-w-[54ch] text-lg leading-relaxed text-muted">
              Switchlet converts, shrinks and cleans up photos, PDFs, videos and documents right here in your browser. Nothing you add is sent anywhere, and the counter at the bottom of this page shows it.
            </p>
            <button
              type="button"
              onClick={pick}
              className="mt-10 grid w-full gap-2 rounded-2xl border-[1.5px] border-line bg-field px-6 py-12 text-left transition-colors hover:border-jade sm:px-10 sm:py-16"
            >
              <span className="text-2xl font-medium sm:text-3xl">Drop files anywhere on this page</span>
              <span className="text-muted">
                or <span className="font-medium text-jade underline underline-offset-4">choose files</span>, or paste with {pasteShortcut}
              </span>
              <span className="mt-4 max-w-[60ch] text-sm text-muted">Photos, PDFs, video, audio, Markdown, HTML, CSV, JSON and Excel. Up to {LIMITS.batchFiles} at a time.</span>
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
            {notice && <p className="mt-4 max-w-[70ch] text-muted">{notice}</p>}

            {single && !step ? (
              <div className="mt-8 max-w-3xl">{options}</div>
            ) : single && step && MEDIA_OPS.has(step.op) ? (
              // Phones read top to bottom: player, options, then the button and result. Desktop keeps options at the side.
              <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-x-10">
                <div className="min-w-0 lg:col-start-1">
                  <MediaStage
                    item={single}
                    step={step}
                    onClip={(clip) => {
                      if (step.op === 'video.trim') setStep({ ...step, settings: clip })
                      else if (step.op === 'video.gif') setStep({ ...step, settings: { ...step.settings, ...clip } })
                    }}
                  />
                </div>
                <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">{options}</div>
                <div className="min-w-0 space-y-6 lg:col-start-1">
                  <RunMedia item={single} step={step} stale={ranKey !== stepKey} onRun={runSingle} />
                  <JobResult
                    job={single}
                    inputSize={SAME_KIND.has(step.op) ? single.file.size : undefined}
                    zipName={`${stem(single.file.name)}.zip`}
                    onCancel={cancelSingle}
                    onRetry={runSingle}
                  />
                </div>
              </div>
            ) : single && step ? (
              <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                <div className="min-w-0 space-y-8">
                  {step.op === 'image.convert' || step.op === 'image.scrub' ? (
                    <ImageResult item={single} onCancel={cancelSingle} onRetry={retrySingle} />
                  ) : (
                    <>
                      {step.op === 'pdf.pages' && (
                        <PageSorter file={single.file} order={step.settings.order} onChange={(order) => setStep({ ...step, settings: { order } })} />
                      )}
                      <JobResult
                        job={single}
                        inputSize={SAME_KIND.has(step.op) ? single.file.size : undefined}
                        zipName={`${stem(single.file.name)}.zip`}
                        onCancel={cancelSingle}
                        onRetry={retrySingle}
                      />
                    </>
                  )}
                </div>
                {options}
              </div>
            ) : items.length === 1 ? (
              <div role="alert" className="mt-8 max-w-[60ch] space-y-4">
                <p className="text-lg">{items[0]!.problem}</p>
                <button type="button" onClick={pick} className="rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade">Choose another file</button>
              </div>
            ) : (
              <div className="mt-8 space-y-8">
                {ops.length > 0 && options}
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
                    step && ops.length > 0 && combo.status !== 'running' && (
                      <button
                        type="button"
                        onClick={runAll}
                        className={doneCount || combo.output ? 'rounded-lg border border-line px-5 py-3 font-semibold hover:border-ink' : 'rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade hover:brightness-110'}
                      >
                        {doneCount || combo.output ? `${runLabel} again` : runLabel}
                      </button>
                    )
                  )}
                  {!combines && !batch?.running && allFiles.length > 1 && (
                    <button type="button" onClick={downloadZip} className="rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade hover:brightness-110">
                      Download all as ZIP ({formatBytes(allFiles.reduce((n, f) => n + f.blob.size, 0))})
                    </button>
                  )}
                </div>
                {combines && combo.status !== 'idle' && (
                  <JobResult job={combo} zipName="switchlet.zip" onCancel={() => batchCtrl.current?.abort()} onRetry={runAll} />
                )}
                <BatchList items={items} reorderable={combines} onMove={moveItem} />
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
