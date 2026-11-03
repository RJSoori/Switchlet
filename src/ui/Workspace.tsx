// One category's working area: its files, task, settings, jobs and results. Every category keeps its own
// workspace mounted (hidden when not shown), so a job keeps running while the person looks at another screen.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { categoryInfo, tasksIn, type Category } from '../core/categories'
import { formatBytes, LIMITS, type Detected } from '../core/detect'
import { etaSeconds, friendlyError, mediaCapabilities, poolSize, releaseWorkers, runPool, runStep, zipBlobs } from '../core/jobs'
import { OPS, defaultOp, makeStep, stem, type MediaCaps, type OpId, type Step, type TaskResult } from '../core/ops'
import { describeStep, type Recipe } from '../core/recipes'
import { BatchList } from './Batch'
import { download, pasteShortcut, percent } from './hooks'
import { SaveRecipe, type Library } from './Library'
import { MediaStage, RunMedia } from './MediaStage'
import { Options } from './Options'
import { JobResult } from './Outputs'
import { PageSorter } from './PageSorter'
import type { Command } from './Palette'
import { ImageResult } from './Result'

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
}

/** Files the router sent here. A new nonce means a new delivery. */
export interface Incoming { nonce: number; items: Item[]; op: OpId | null; note?: string }

/** What the page shell needs from the workspace on screen: palette commands and keyboard actions. */
export interface WorkspaceApi { commands: Command[]; runPrimary: () => void; primaryDownload: () => void; cancelRunning: () => void }

export const IDLE: Job = { status: 'idle', progress: 0, stage: '' }
/** Tasks whose output is the same kind of file, where "X kB to Y kB, 40% smaller" means something. */
const SAME_KIND = new Set<OpId>(['pdf.compress', 'pdf.scrub', 'pdf.pages', 'video.convert'])
const MEDIA_OPS = new Set<OpId>(['video.convert', 'video.trim', 'video.gif', 'media.audio'])
const VERB: Partial<Record<OpId, string>> = { 'image.scrub': 'Clean', 'pdf.scrub': 'Clean', 'pdf.split': 'Split', 'pdf.compress': 'Shrink' }

const toOutput = (r: TaskResult): Output => ({
  ...r,
  files: r.files.map((f) => ({ name: f.name, blob: new Blob([f.data], { type: f.type }) })),
})

/** The big "drop or choose" target on the landing page and on an empty category. */
export function DropTarget({ what, detail, onPick }: { what: string; detail: string; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="mt-10 grid w-full gap-2 rounded-2xl border-[1.5px] border-line bg-field px-6 py-12 text-left transition-colors hover:border-jade sm:px-10 sm:py-16"
    >
      <span className="text-2xl font-medium sm:text-3xl">Drop {what} anywhere on this page</span>
      <span className="text-muted">
        or <span className="font-medium text-jade underline underline-offset-4">choose files</span>, or paste with {pasteShortcut}
      </span>
      <span className="mt-4 max-w-[60ch] text-sm text-muted">{detail}</span>
    </button>
  )
}

interface Props {
  category: Category
  active: boolean
  incoming: Incoming | undefined
  library: Library
  /** Chips for files from the same drop that belong on other screens. */
  strip: ReactNode
  onPick: () => void
  announce: (message: string) => void
  apiRef: RefObject<WorkspaceApi | null>
  onStatus: (category: Category, status: { count: number; running: boolean }) => void
}

export function Workspace({ category, active, incoming, library, strip, onPick, announce, apiRef, onStatus }: Props) {
  const info = categoryInfo(category)
  const [items, setItems] = useState<Item[]>([])
  const [step, setStep] = useState<Step | null>(null)
  const [combo, setCombo] = useState<Job>(IDLE)
  const [notice, setNotice] = useState<string | null>(null)
  const [batch, setBatch] = useState<{ running: boolean; startedAt: number } | null>(null)
  const [runNonce, setRunNonce] = useState(0)
  const [caps, setCaps] = useState<MediaCaps>()
  /** Settings of the last on-demand (audio/video) run, to tell when the result no longer matches them. */
  const [ranKey, setRanKey] = useState<string | null>(null)
  /** Files dropped here while a job was running; they open when it finishes. */
  const [queued, setQueued] = useState<Incoming | null>(null)
  const batchCtrl = useRef<AbortController | null>(null)
  const singleCtrl = useRef<AbortController | null>(null)
  const root = useRef<HTMLElement>(null)
  /** After files are added, focus moves to their heading (the button that was focused is gone). */
  const heading = useRef<HTMLHeadingElement>(null)
  const [landed, setLanded] = useState(0)
  useEffect(() => { if (landed) heading.current?.focus() }, [landed])
  const pinnedRef = useRef<Recipe | null>(null)
  pinnedRef.current = library.pinned
  const [autoRun, setAutoRun] = useState(false)

  const patch = useCallback((id: number, p: Partial<Item>) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it))), [])

  const clear = useCallback(() => {
    batchCtrl.current?.abort()
    singleCtrl.current?.abort()
    releaseWorkers() // frees decoded pixels and WASM memory (idle workers only, so other screens' jobs keep going)
    setItems((old) => { old.forEach((it) => it.output?.preview?.close()); return [] })
    setStep(null)
    setCombo(IDLE)
    setBatch(null)
    setNotice(null)
    setRanKey(null)
  }, [])

  const load = (inc: Incoming) => {
    clear()
    const kinds = inc.items.map((it) => it.detected.kind)
    // A recipe that's switched on is used whenever this screen can run it on these files, and runs straight away.
    const recipe = pinnedRef.current
    const recipeStep = recipe && tasksIn(category, kinds).includes(recipe.steps[0]!.op) ? recipe.steps[0]! : null
    setItems(inc.items)
    setStep(recipeStep ?? (inc.op ? makeStep(inc.op, kinds[0]!) : null))
    if (recipeStep) setAutoRun(true)
    if (active) setLanded((n) => n + 1)
    const note = recipe && !recipeStep ? `Your recipe “${recipe.name}” doesn’t fit these files, so nothing ran on its own. Choose a task below.` : null
    setNotice(note)
    const added = inc.items.length === 1 ? `Added ${inc.items[0]!.file.name}.` : `Added ${inc.items.length} files.`
    announce([inc.note, added, note].filter(Boolean).join(' '))
  }

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

  const kinds = items.map((it) => it.detected.kind)
  const ops = tasksIn(category, kinds)
  const single = items.length === 1 ? items[0]! : null
  const combines = !!step && !!OPS[step.op].combines && items.length > 1
  const stepKey = JSON.stringify(step)
  const running = items.some((it) => it.status === 'running') || combo.status === 'running' || !!batch?.running

  // Files dropped here mid-job wait in the strip and open when the job finishes; otherwise they open now.
  const lastNonce = useRef(0)
  useEffect(() => {
    if (!incoming || incoming.nonce === lastNonce.current) return
    lastNonce.current = incoming.nonce
    if (!running) return load(incoming)
    setQueued((q) => {
      if (!q) return incoming
      const all = [...q.items, ...incoming.items]
      const allKinds = all.map((it) => it.detected.kind)
      return { ...incoming, items: all, op: incoming.op && tasksIn(category, allKinds).includes(incoming.op) ? incoming.op : defaultOp(allKinds) }
    })
    announce(`${incoming.note ?? ''} ${incoming.items.length === 1 ? 'This file opens' : 'These files open'} when the current job finishes.`.trim())
  }, [incoming])
  useEffect(() => {
    if (running || !queued) return
    setQueued(null)
    load(queued)
  }, [running, queued])

  useEffect(() => onStatus(category, { count: items.length, running }), [items.length, running])

  // A hidden screen keeps its jobs running but stops playing sound or video.
  useEffect(() => {
    if (!active) root.current?.querySelectorAll<HTMLMediaElement>('video, audio').forEach((m) => m.pause())
  }, [active])

  // Audio/video: ask the worker once which formats this browser can create, to grey out the rest.
  const hasMedia = items.some((it) => it.detected.group === 'media')
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
    announce('Started. Press Escape to cancel.')
    void convertItem(single, step, ctrl.signal, false).then((out) => {
      if (out) announce(out.files[0] ? `${out.files[0].name} is ready, ${formatBytes(out.files[0].blob.size)}.` : out.note ?? 'Done.')
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
      if (out) announce(out.files.length === 1 ? `${out.files[0]!.name} is ready, ${formatBytes(out.files[0]!.blob.size)}.` : out.files.length ? `${out.files.length} files are ready.` : out.note ?? 'Done.')
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
        const r = await runStep(step, items.map((it) => it.file), kinds, {
          signal: ctrl.signal,
          onProgress: (progress, stage) => setCombo((c) => ({ ...c, progress, stage })),
        })
        setCombo({ ...IDLE, status: 'done', progress: 1, output: toOutput(r) })
        announce(`${r.files[0]?.name ?? 'Your file'} is ready.`)
      } catch (e) {
        const err = friendlyError(e)
        setCombo({ ...IDLE, status: err.kind === 'cancelled' ? 'cancelled' : 'error', error: err.message })
      }
      releaseWorkers()
      return
    }
    setBatch({ running: true, startedAt: performance.now() })
    announce(`Working on ${items.length} files.`)
    // AVIF and PNG encoders already use every core; main-thread tasks share one thread. One at a time for those.
    const oneAtATime = !!OPS[step.op].main || !!OPS[step.op].manual || (step.op === 'image.convert' && (step.settings.format === 'avif' || step.settings.format === 'png'))
    await runPool(items, oneAtATime ? 1 : poolSize(), (it) => convertItem(it, step, ctrl.signal, false).then(() => {}))
    releaseWorkers()
    setBatch((b) => b && { ...b, running: false })
    announce(ctrl.signal.aborted ? 'Cancelled.' : 'All files are done.')
  }

  // A switched-on recipe runs as soon as its files are in (single photos, PDFs and documents already run live).
  useEffect(() => {
    if (!autoRun || !step) return
    setAutoRun(false)
    if (single && OPS[step.op].manual) runSingle()
    else if (!single && items.length > 1) void runAll()
  }, [autoRun, stepKey])

  /** History records what was downloaded: file names and settings, never contents. */
  const recordDownload = (sources: File[]) => {
    if (step) void library.record({ names: sources.slice(0, 3).map((f) => f.name), count: sources.length, task: describeStep(step), outcome: 'done' })
  }

  const allFiles = items.flatMap((it) => it.output?.files ?? [])
  const downloadZip = async () => {
    download(await zipBlobs(allFiles), `switchlet-${allFiles.length}-files.zip`)
    recordDownload(items.filter((it) => it.output).map((it) => it.file))
    releaseWorkers()
  }

  const moveItem = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return
    setItems((list) => { const next = [...list]; const [it] = next.splice(from, 1); next.splice(to, 0, it!); return next })
    setCombo(IDLE)
  }

  const kind = kinds[0] ?? 'unknown'
  const doneCount = items.filter((it) => it.status === 'done').length
  const batchProgress = items.length ? items.reduce((n, it) => n + (it.status === 'done' ? 1 : it.status === 'running' ? it.progress : 0), 0) / items.length : 0
  const batchEta = batch?.running ? etaSeconds(batch.startedAt, batchProgress) : null
  const options = (
    <Options
      ops={ops}
      step={step}
      kind={kind}
      onChange={setStep}
      fileCount={items.length}
      caps={caps}
      sheets={single?.output?.sheets}
      dims={single?.detected.width ? { width: single.detected.width, height: single.detected.height! } : single?.output?.width ? { width: single.output.width, height: single.output.height! } : undefined}
    />
  )
  const cancelSingle = () => { singleCtrl.current?.abort(); if (single) patch(single.id, { status: 'cancelled' }) }
  const retrySingle = () => setRunNonce((n) => n + 1)
  const cancelRunning = () => {
    if (batch?.running || combo.status === 'running') batchCtrl.current?.abort()
    if (single?.status === 'running') cancelSingle()
  }
  const runPrimary = () => {
    if (!step || running) return
    if (single) { if (OPS[step.op].manual) runSingle() } else if (items.length > 1) void runAll()
  }
  const primaryDownload = () => root.current?.querySelector<HTMLElement>('[data-primary-download]')?.click()

  const runLabel = !step ? '' : step.op === 'pdf.merge' ? `Merge ${items.length} PDFs` : step.op === 'image.toPdf' ? `Make a PDF from ${items.length} images` : `${VERB[step.op] ?? 'Convert'} ${items.length} files`
  const hasResult = !!(single?.output?.files.length || allFiles.length || combo.output?.files.length)
  const commands: Command[] = [
    ...(items.length ? [{ id: 'clear', label: `Start over in ${info.label}`, run: () => { setQueued(null); clear() } }] : []),
    ...(step && !running && (single ? OPS[step.op].manual : items.length > 1) ? [{ id: 'run', label: single ? 'Run the task' : runLabel, keys: 'Enter', run: runPrimary }] : []),
    ...(hasResult ? [{ id: 'download', label: 'Download the result', keys: 'D', run: primaryDownload }] : []),
    ...(running ? [{ id: 'cancel', label: 'Cancel', keys: 'Esc', run: cancelRunning }] : []),
    ...ops.map((op) => ({ id: `task-${op}`, label: `Task: ${OPS[op].label}`, run: () => setStep(makeStep(op, kind)) })),
  ]
  useEffect(() => { if (active) apiRef.current = { commands, runPrimary, primaryDownload, cancelRunning } })

  const fileStrip = (queued || strip) && (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
      {queued && (
        <span className="rounded-full border border-dashed border-line px-3 py-1 text-muted">
          {queued.items.length === 1 ? `${queued.items[0]!.file.name} opens` : `${queued.items.length} more files open`} when this job finishes
        </span>
      )}
      {strip}
    </div>
  )

  return (
    <section ref={root} hidden={!active} aria-label={info.label} className="pt-6">
      {items.length === 0 ? (
        <div className="pt-2 sm:pt-8">
          <h1 ref={heading} tabIndex={-1} data-heading className="text-[clamp(2.2rem,5vw,3.5rem)] leading-[1.05] font-light tracking-[-0.02em] focus:outline-none">{info.label}</h1>
          <p className="mt-4 max-w-[58ch] text-lg leading-relaxed text-muted">{info.blurb}</p>
          {fileStrip}
          <DropTarget what={info.drop} detail={`Up to ${LIMITS.batchFiles} at a time. Other kinds of file open on their own screen.`} onPick={onPick} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-rule pb-4">
            <h1 ref={heading} tabIndex={-1} data-heading className="min-w-0 text-2xl font-medium focus:outline-none">
              {single ? (
                <>
                  <span className="block truncate">{single.file.name}</span>
                  <span className="block text-base font-normal text-muted">
                    {single.detected.label}
                    {single.detected.width ? `, ${single.detected.width} × ${single.detected.height}` : ''}, {formatBytes(single.file.size)}
                  </span>
                </>
              ) : (
                `${items.length} files`
              )}
            </h1>
            <button type="button" onClick={onPick} className="rounded-md border border-line px-3 py-1.5 hover:border-ink">Choose other files</button>
          </div>
          {fileStrip}
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
                  onDownload={() => recordDownload([single.file])}
                />
                {single.output && <SaveRecipe key={stepKey} step={step} library={library} />}
              </div>
            </div>
          ) : single && step ? (
            <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
              <div className="min-w-0 space-y-8">
                {step.op === 'image.convert' || step.op === 'image.scrub' ? (
                  <ImageResult item={single} onCancel={cancelSingle} onRetry={retrySingle} onDownload={() => recordDownload([single.file])} />
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
                      onDownload={() => recordDownload([single.file])}
                    />
                  </>
                )}
                {single.output && <SaveRecipe key={stepKey} step={step} library={library} />}
              </div>
              {options}
            </div>
          ) : (
            <div className="mt-8 space-y-8">
              {ops.length > 0 && options}
              <div className="flex flex-wrap items-center gap-4">
                {batch?.running ? (
                  <>
                    <div className="min-w-48 flex-1">
                      <p>
                        {doneCount} of {items.length} done, <span className="tabular-nums">{percent(batchProgress)}</span>
                        {batchEta !== null && <span className="text-muted">, about {batchEta} s left</span>}
                      </p>
                      <div role="progressbar" aria-label={`${doneCount} of ${items.length} files done`} aria-valuenow={Math.round(batchProgress * 100)} className="mt-2 h-1.5 overflow-hidden rounded-full bg-rule">
                        <div className="h-full bg-jade" style={{ width: percent(batchProgress) }} />
                      </div>
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
                  <button type="button" onClick={downloadZip} data-primary-download className="rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade hover:brightness-110">
                    Download all as ZIP ({formatBytes(allFiles.reduce((n, f) => n + f.blob.size, 0))})
                  </button>
                )}
              </div>
              {combines && combo.status !== 'idle' && (
                <JobResult job={combo} zipName="switchlet.zip" onCancel={() => batchCtrl.current?.abort()} onRetry={runAll} onDownload={() => recordDownload(items.map((it) => it.file))} />
              )}
              {step && (doneCount > 0 || combo.output) && <SaveRecipe key={stepKey} step={step} library={library} />}
              <BatchList items={items} reorderable={combines} onMove={moveItem} onDownload={(it) => recordDownload([it.file])} />
            </div>
          )}
        </>
      )}
    </section>
  )
}
