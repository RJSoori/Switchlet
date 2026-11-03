import { useCallback, useEffect, useRef, useState } from 'react'
import { CATEGORIES, CATEGORY_OF, categoryInfo, describeGroup, kindFromMime, route, type Category } from './core/categories'
import { detectFile, formatBytes, limitProblem, LIMITS } from './core/detect'
import { startNetworkLog } from './core/network'
import { defaultOp, type OpId } from './core/ops'
import { decodeRecipe, type Recipe } from './core/recipes'
import { Dialog, ImportRecipe, LibraryPanel, useLibrary } from './ui/Library'
import { Palette, ShortcutHelp, mod, type Command } from './ui/Palette'
import { Proof, useProofHeadline } from './ui/Proof'
import { DropTarget, IDLE, Workspace, type Incoming, type Item, type WorkspaceApi } from './ui/Workspace'

const SUPPORTED = 'photos (JPG, PNG, WebP, AVIF, HEIC, GIF), PDFs, video (MP4, MOV, WebM, MKV), audio (MP3, WAV, M4A, OGG, FLAC), Markdown, text, HTML, CSV, JSON and Excel files'
const UNSUPPORTED = 'unsupported'

type Status = { count: number; running: boolean }

/** What the notice says about files that weren't opened: each one named, with what to do instead. */
function rejectionNotice(files: { item: Item; problem: string | null }[]): string {
  const names = (list: typeof files) => list.map((f) => `“${f.item.file.name}”`)
  const unsupported = files.filter((f) => f.problem === UNSUPPORTED)
  const parts = files.filter((f) => f.problem !== UNSUPPORTED).map((f) => `${names([f])[0]} wasn’t opened. ${f.problem}`)
  if (unsupported.length) {
    const shown = names(unsupported.slice(0, 3)).join(', ') + (unsupported.length > 3 ? ` and ${unsupported.length - 3} more` : '')
    parts.unshift(`${shown} ${unsupported.length === 1 ? 'isn’t a kind of file' : 'aren’t kinds of file'} Switchlet can open. It works with ${SUPPORTED}.`)
  }
  return parts.join(' ')
}

let nextId = 1
let nextNonce = 1
startNetworkLog()

export function App() {
  const [category, setCategory] = useState<Category | null>(null)
  const categoryRef = useRef(category)
  categoryRef.current = category
  const [incoming, setIncoming] = useState<Partial<Record<Category, Incoming>>>({})
  /** Groups from a mixed drop that belong on other screens, waiting behind a chip. */
  const [parked, setParked] = useState<Partial<Record<Category, Item[]>>>({})
  const [status, setStatus] = useState<Partial<Record<Category, Status>>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const [announcement, setAnnouncement] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const apiRef = useRef<WorkspaceApi | null>(null)
  const proofHeadline = useProofHeadline()
  const library = useLibrary()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [importing, setImporting] = useState<Pick<Recipe, 'name' | 'steps'> | null>(null)
  const [shared, setShared] = useState<File[] | null>(null)

  const announce = useCallback((message: string) => setAnnouncement(message), [])
  const onStatus = useCallback((c: Category, s: Status) => setStatus((all) => ({ ...all, [c]: s })), [])

  const deliver = (c: Category, items: Item[], op: OpId | null, note: string) => {
    setIncoming((all) => ({ ...all, [c]: { nonce: nextNonce++, items, op, note } }))
    setParked((p) => { const { [c]: _, ...rest } = p; return rest })
    setCategory(c)
  }

  /**
   * The one way files come in: drop, paste, the file picker and the share target all land here. Types come from
   * the files' bytes; the router picks the screen (see core/categories.ts). Unsupported files open nothing.
   */
  const routeFiles = async (files: File[]) => {
    if (!files.length) return
    const accepted = files.slice(0, LIMITS.batchFiles)
    const found = await Promise.all(accepted.map(async (file) => {
      const detected = await detectFile(file)
      const problem = limitProblem(detected, file.size) ?? (CATEGORY_OF[detected.kind] ? null : UNSUPPORTED)
      return { item: { ...IDLE, id: nextId++, file, detected } as Item, problem }
    }))
    const current = categoryRef.current
    const r = route(found.map((f) => ({ kind: f.item.detected.kind, problem: f.problem })), current)
    const pickItems = (take: number[]) => take.map((i) => found[i]!.item)
    const problems = [
      r.rejected.length ? rejectionNotice(r.rejected.map((i) => found[i]!)) : '',
      files.length > accepted.length ? `Only the first ${LIMITS.batchFiles} files were added.` : '',
    ].filter(Boolean).join(' ')
    setNotice(problems || null)
    if (!r.open) return announce(problems)
    const others = r.others.map((g) => describeGroup(g.category, g.take.length))
    if (r.others.length) setParked((p) => ({ ...p, ...Object.fromEntries(r.others.map((g) => [g.category, pickItems(g.take)])) }))
    const note = [
      r.open !== current && `Opened in ${categoryInfo(r.open).label}.`,
      others.length && `Also dropped: ${others.join(', ')}, ready to open from the file strip.`,
      problems,
    ].filter(Boolean).join(' ')
    deliver(r.open, pickItems(r.take), r.op, note)
  }
  const routeRef = useRef(routeFiles)
  routeRef.current = routeFiles

  const openParked = (c: Category) => {
    const items = parked[c]
    if (!items?.length) return
    deliver(c, items, defaultOp(items.map((it) => it.detected.kind)), c !== category ? `Opened in ${categoryInfo(c).label}.` : '')
  }

  // Drop files anywhere, on any screen, or paste them. (Dragging page thumbnails carries no files, so it's ignored here.)
  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    // While dragging, browsers show only MIME types, not bytes: enough for a hint. The drop itself is routed by content.
    const hintFor = (dt: DataTransfer | null) => {
      const kinds = [...(dt?.items ?? [])].filter((i) => i.kind === 'file').map((i) => kindFromMime(i.type))
      if (!kinds.length || kinds.some((k) => k === null)) return null
      const r = route(kinds.map((kind) => ({ kind: kind!, problem: null })), categoryRef.current)
      return r.open ? `Drop to open in ${categoryInfo(r.open).label}` : null
    }
    const hide = () => { dragDepth.current = 0; setDragging(false) }
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (dragDepth.current++ === 0) setHint(hintFor(e.dataTransfer))
      setDragging(true)
    }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const leave = (e: DragEvent) => { if (hasFiles(e) && --dragDepth.current <= 0) hide() }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      hide()
      void routeRef.current([...(e.dataTransfer?.files ?? [])])
    }
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length) { e.preventDefault(); void routeRef.current(files) }
    }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && dragDepth.current) { e.stopImmediatePropagation(); hide() } }
    const listeners: [string, (e: never) => void][] = [['dragenter', enter], ['dragover', over], ['dragleave', leave], ['drop', drop], ['paste', paste], ['keydown', escape]]
    for (const [type, fn] of listeners) window.addEventListener(type, fn as EventListener, type === 'keydown')
    return () => { for (const [type, fn] of listeners) window.removeEventListener(type, fn as EventListener, type === 'keydown') }
  }, [])

  // A recipe link (#recipe=…): ask before adding it. The fragment never reaches a server.
  useEffect(() => {
    const check = () => {
      const m = location.hash.match(/^#recipe=(.*)$/)
      if (!m) return
      history.replaceState(null, '', location.pathname + location.search)
      const r = decodeRecipe(m[1]!)
      if (typeof r === 'string') setNotice(r)
      else setImporting(r)
    }
    check()
    window.addEventListener('hashchange', check)
    return () => window.removeEventListener('hashchange', check)
  }, [])

  // Files shared from another app (the Android share sheet), parked by the service worker until now, then deleted.
  // Any website can also POST files to the share target, so nothing is opened until the person confirms.
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return
    history.replaceState(null, '', '/')
    void (async () => {
      try {
        const cache = await caches.open('switchlet-shared')
        const files: File[] = []
        for (const request of await cache.keys()) {
          const res = await cache.match(request)
          if (res) files.push(new File([await res.blob()], decodeURIComponent(res.headers.get('x-file-name') ?? 'shared-file'), { type: res.headers.get('content-type') ?? '' }))
        }
        await caches.delete('switchlet-shared')
        if (files.length) setShared(files)
      } catch {
        await caches.delete('switchlet-shared').catch(() => {})
        setNotice('The shared files couldn’t be opened. Try sharing them again.')
      }
    })()
  }, [])

  const pick = () => picker.current?.click()
  const api = category ? apiRef.current : null

  // Keyboard: Ctrl/Cmd+K palette, Ctrl/Cmd+O open; plain keys only when not typing in a field or using a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (cmd && !e.altKey && (key === 'k' || key === 'o')) {
        e.preventDefault()
        if (key === 'k') setPaletteOpen(true)
        else pick()
        return
      }
      const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')
      if (cmd || e.altKey || typing || document.querySelector('dialog[open]')) return
      const active = categoryRef.current ? apiRef.current : null
      if (e.key === '?') { e.preventDefault(); setHelpOpen(true) }
      else if (key === 'd') active?.primaryDownload()
      else if (e.key === 'Escape') active?.cancelRunning()
      else if (e.key === 'Enter' && (e.target === document.body || (e.target instanceof Element && e.target.matches('[data-heading]')))) active?.runPrimary()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const commands: Command[] = [
    { id: 'open', label: 'Choose files', keys: `${mod} O`, run: pick },
    ...(api?.commands ?? []),
    ...CATEGORIES.filter((c) => c.id !== category).map((c) => ({ id: `go-${c.id}`, label: `Go to ${c.label}`, run: () => setCategory(c.id) })),
    ...(category ? [{ id: 'home', label: 'Go to the start page', run: () => setCategory(null) }] : []),
    ...library.recipes.map((r) => (library.pinned?.id === r.id
      ? { id: `unpin-${r.id}`, label: `Stop using recipe “${r.name}”`, run: () => library.pin(null) }
      : { id: `pin-${r.id}`, label: `Use recipe “${r.name}” for every drop`, run: () => library.pin(r.id) })),
    { id: 'proof', label: 'Show what leaves this device', run: () => document.getElementById('proof')?.scrollIntoView() },
    { id: 'help', label: 'Keyboard shortcuts', keys: '?', run: () => setHelpOpen(true) },
  ]

  const parkedGroups = (Object.entries(parked) as [Category, Item[]][]).filter(([, items]) => items.length)
  const chips = parkedGroups.length > 0 && parkedGroups.map(([c, items]) => (
    <button
      key={c}
      type="button"
      onClick={() => openParked(c)}
      aria-label={`Open ${describeGroup(c, items.length)} in ${categoryInfo(c).label}`}
      className="rounded-full border border-line bg-field px-3 py-1 hover:border-jade"
    >
      Open {describeGroup(c, items.length)}
    </button>
  ))

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-8">
        <button type="button" onClick={() => setCategory(null)} className="flex items-center gap-2.5 text-lg font-semibold tracking-tight" aria-label="Switchlet, start page">
          <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true"><rect width="32" height="32" rx="7" className="fill-jade" /><path d="M4 21h7M23.4 21H28M11 21l9-9" className="stroke-on-jade" strokeWidth="2.6" strokeLinecap="round" fill="none" /><circle cx="11" cy="21" r="2.2" className="fill-on-jade" /><circle cx="21" cy="21" r="2.4" className="stroke-on-jade" strokeWidth="1.4" fill="none" /></svg>
          Switchlet
        </button>
        <div className="flex items-center gap-5">
          <button type="button" onClick={() => setPaletteOpen(true)} className="hidden rounded-md border border-line px-2.5 py-1 text-sm text-muted hover:border-ink hover:text-ink sm:block">
            Commands <kbd className="ml-1">{mod} K</kbd>
          </button>
          <a href="#proof" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
            <span className="tabular-nums">{proofHeadline}</span>
          </a>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 sm:px-8 lg:grid lg:grid-cols-[11.5rem_minmax(0,1fr)] lg:gap-x-12">
        <nav aria-label="Screens" className="lg:pt-6">
          <ul className="-mx-4 flex [scrollbar-width:none] overflow-x-auto border-b border-rule px-4 lg:sticky lg:top-6 lg:mx-0 lg:flex-col lg:gap-0.5 lg:border-b-0 lg:px-0">
            {CATEGORIES.map((c) => {
              const on = c.id === category
              const s = status[c.id]
              return (
                <li key={c.id} className="shrink-0">
                  <button
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => setCategory(c.id)}
                    className={`flex w-full items-center gap-2.5 border-b-[3px] px-3 py-2.5 text-left whitespace-nowrap transition-colors lg:rounded-r-md lg:border-b-0 lg:border-l-[3px] ${on ? 'border-jade font-semibold text-ink lg:bg-field' : 'border-transparent text-muted hover:text-ink'}`}
                  >
                    <span className="lg:flex-1">{c.label}</span>
                    {s?.running && <span className="h-2 w-2 rounded-full bg-jade" aria-hidden="true" />}
                    {!!s?.count && <span className="text-sm text-muted tabular-nums" aria-hidden="true">{s.count}</span>}
                    {(s?.running || !!s?.count) && <span className="sr-only">, {s.running ? 'working' : `${s.count} ${s.count === 1 ? 'file' : 'files'}`}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <main className="min-w-0 pb-20">
          {library.pinned && (
            <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-jade px-4 py-2 text-sm">
              <span>Recipe in use: <strong className="font-semibold">{library.pinned.name}</strong>. Files you drop are converted with it.</span>
              <button type="button" onClick={() => library.pin(null)} className="text-jade underline underline-offset-4">Stop using it</button>
            </p>
          )}
          {notice && (
            <div role="status" className="mt-6 flex items-start justify-between gap-4 rounded-lg border border-line bg-field px-4 py-3">
              <p className="max-w-[75ch]">{notice}</p>
              <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-sm text-muted underline underline-offset-4 hover:text-ink">Dismiss</button>
            </div>
          )}

          {category === null && (
            <section className="pt-8 sm:pt-14">
              <h1 className="max-w-[15ch] text-[clamp(2.6rem,7.5vw,5.25rem)] leading-[1.02] font-light tracking-[-0.025em]">Convert files without uploading them.</h1>
              <p className="mt-6 max-w-[54ch] text-lg leading-relaxed text-muted">
                Switchlet converts, shrinks and cleans up photos, PDFs, videos and documents right here in your browser. Nothing you add is sent anywhere, and the counter at the bottom of this page shows it.
              </p>
              {chips && <div className="mt-6 flex flex-wrap gap-2 text-sm">{chips}</div>}
              <DropTarget what="files" detail={`Photos, PDFs, video, audio, Markdown, HTML, CSV, JSON and Excel. Up to ${LIMITS.batchFiles} at a time.`} onPick={pick} />
              <LibraryPanel library={library} />
            </section>
          )}
          {CATEGORIES.map((c) => (
            <Workspace
              key={c.id}
              category={c.id}
              active={category === c.id}
              incoming={incoming[c.id]}
              library={library}
              strip={chips}
              onPick={pick}
              announce={announce}
              apiRef={apiRef}
              onStatus={onStatus}
            />
          ))}

          <Proof />
        </main>
      </div>

      <input ref={picker} type="file" multiple hidden onChange={(e) => { void routeFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
      {dragging && (
        // Visual only: nothing in it can take focus, pointer events pass through, and Esc or leaving the window hides it.
        <div aria-hidden="true" className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-3xl border-2 border-jade bg-paper/90">
          <div className="px-6 text-center">
            <p className="text-3xl font-light">{hint ?? 'Drop to open'}</p>
            <p className="mt-3 text-muted">Files stay on this device.</p>
          </div>
        </div>
      )}
      <div aria-live="polite" className="sr-only">{announcement}</div>
      {paletteOpen && <Palette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {shared && (
        <Dialog title={shared.length === 1 ? 'Open the shared file?' : `Open ${shared.length} shared files?`} onClose={() => setShared(null)}>
          <ul className="max-h-48 overflow-auto text-muted">
            {shared.slice(0, 10).map((f, i) => <li key={i} className="truncate">{f.name}, {formatBytes(f.size)}</li>)}
          </ul>
          {shared.length > 10 && <p className="text-sm text-muted">And {shared.length - 10} more.</p>}
          <p className="mt-3 text-sm text-muted">Open them only if you just shared them with Switchlet. Websites can send files here too.</p>
          <div className="mt-6 flex gap-2">
            <button type="button" onClick={() => { const files = shared; setShared(null); void routeFiles(files) }} className="rounded-lg bg-jade px-4 py-2 font-semibold text-on-jade">Open</button>
            <button type="button" onClick={() => setShared(null)} className="rounded-lg border border-line px-4 py-2">Discard</button>
          </div>
        </Dialog>
      )}
      {importing && (
        <ImportRecipe
          recipe={importing}
          onClose={() => setImporting(null)}
          onAdd={() => {
            void library.save(importing.name, importing.steps[0]!)
            setNotice(`Added the recipe “${importing.name}”. You’ll find it under Your recipes.`)
            setImporting(null)
          }}
        />
      )}
    </div>
  )
}
