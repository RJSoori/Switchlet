// Recipes and recent jobs: saved in this browser only (IndexedDB), never files, never sent anywhere.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { addHistory, clearHistory, deleteRecipe, listHistory, listRecipes, pinnedRecipeId, saveRecipe, setPinnedRecipeId } from '../core/db'
import type { Step } from '../core/ops'
import { cleanName, describeStep, encodeRecipe, validateStep, type HistoryEntry, type Recipe } from '../core/recipes'

export const recipeLink = (r: Pick<Recipe, 'name' | 'steps'>) => `${location.origin}/#recipe=${encodeRecipe(r)}`

/** Recipes, history and the pinned recipe, kept in sync with storage. Storage failures leave the lists empty. */
export function useLibrary() {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [pinned, setPinned] = useState<string | null>(pinnedRecipeId)
  const reload = useCallback(() => {
    listRecipes().then(setRecipes, () => setRecipes([]))
    listHistory().then(setHistory, () => setHistory([]))
  }, [])
  useEffect(reload, [reload])

  return {
    recipes,
    history,
    pinned: recipes.find((r) => r.id === pinned) ?? null,
    async save(name: string, step: Step): Promise<Recipe> {
      const recipe: Recipe = { id: crypto.randomUUID(), name: cleanName(name) ?? describeStep(step), steps: [step], createdAt: Date.now() }
      await saveRecipe(recipe)
      reload()
      return recipe
    },
    async remove(id: string) {
      if (id === pinned) { setPinnedRecipeId(null); setPinned(null) }
      await deleteRecipe(id).catch(() => {})
      reload()
    },
    pin(id: string | null) {
      setPinnedRecipeId(id)
      setPinned(id)
    },
    async record(entry: Omit<HistoryEntry, 'id' | 'at'>) {
      await addHistory({ ...entry, id: Date.now() + Math.random(), at: Date.now() }).catch(() => {})
      reload()
    },
    async clearHistory() {
      await clearHistory().catch(() => {})
      reload()
    },
  }
}

export type Library = ReturnType<typeof useLibrary>

/** "Save as recipe" under a result: one button, then a name field prefilled with a description. */
export function SaveRecipe({ step, library }: { step: Step; library: Library }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const id = useId()
  if (!validateStep(step)) return null // e.g. a page order only fits one PDF
  if (saved) return <p className="text-sm text-muted" role="status">Saved “{saved}”. It’s under Your recipes on the start screen.</p>
  if (!open) {
    return (
      <button type="button" onClick={() => { setName(describeStep(step)); setOpen(true) }} className="text-sm text-jade underline underline-offset-4">
        Save these settings as a recipe
      </button>
    )
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void library.save(name, step).then((r) => setSaved(r.name), () => setSaved(null))
      }}
    >
      <div>
        <label htmlFor={id} className="text-sm text-muted">Recipe name</label>
        <input id={id} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus className="mt-1 block w-72 max-w-full rounded-md border border-line bg-field px-3 py-1.5" />
      </div>
      <button type="submit" className="rounded-md bg-jade px-3 py-1.5 font-semibold text-on-jade">Save recipe</button>
      <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-line px-3 py-1.5">Cancel</button>
    </form>
  )
}

const when = (t: number) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(t)

function RecipeRow({ recipe, library, pinned, onStatus }: { recipe: Recipe; library: Library; pinned: boolean; onStatus: (s: string) => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recipeLink(recipe))
      onStatus(`Link to “${recipe.name}” copied. It holds only the settings, never any files.`)
    } catch {
      onStatus(`Copy this link: ${recipeLink(recipe)}`)
    }
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{recipe.name}</p>
        <p className="text-sm text-muted">{describeStep(recipe.steps[0]!)}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          aria-pressed={pinned}
          onClick={() => library.pin(pinned ? null : recipe.id)}
          className={pinned ? 'rounded-md bg-jade px-3 py-1.5 font-semibold text-on-jade' : 'rounded-md border border-line px-3 py-1.5 hover:border-ink'}
        >
          {pinned ? 'In use' : 'Use for every drop'}
        </button>
        <button type="button" onClick={copy} className="rounded-md border border-line px-3 py-1.5 hover:border-ink">Copy link</button>
        <button type="button" onClick={() => void library.remove(recipe.id)} aria-label={`Delete recipe ${recipe.name}`} className="rounded-md border border-line px-3 py-1.5 text-danger hover:border-danger">Delete</button>
      </div>
    </li>
  )
}

/** Start-screen section: saved recipes and recent jobs. Hidden entirely until there's something to show. */
export function LibraryPanel({ library }: { library: Library }) {
  const [status, setStatus] = useState('')
  const { recipes, history } = library
  if (!recipes.length && !history.length) return null
  return (
    <div className="mt-14 grid gap-12 lg:grid-cols-2">
      {recipes.length > 0 && (
        <section aria-labelledby="recipes-title">
          <h2 id="recipes-title" className="text-xl font-medium">Your recipes</h2>
          <p className="mt-1 text-sm text-muted">Saved settings. Switch one on and every file you drop is converted with it.</p>
          <ul className="mt-3 divide-y divide-rule border-y border-rule">
            {recipes.map((r) => <RecipeRow key={r.id} recipe={r} library={library} pinned={library.pinned?.id === r.id} onStatus={setStatus} />)}
          </ul>
          <p className="mt-2 text-sm break-all text-muted" role="status">{status}</p>
        </section>
      )}
      {history.length > 0 && (
        <section aria-labelledby="history-title">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="history-title" className="text-xl font-medium">Recent</h2>
            <button type="button" onClick={() => void library.clearHistory()} className="text-sm text-jade underline underline-offset-4">Clear history</button>
          </div>
          <p className="mt-1 text-sm text-muted">File names and settings of what you downloaded, kept only in this browser.</p>
          <ul className="mt-3 divide-y divide-rule border-y border-rule">
            {history.slice(0, 8).map((h) => (
              <li key={h.id} className="py-2.5">
                <p className="truncate">{h.names.join(', ')}{h.count > h.names.length ? ` and ${h.count - h.names.length} more` : ''}</p>
                <p className="text-sm text-muted">{h.task}, {when(h.at)}</p>
              </li>
            ))}
          </ul>
          {history.length > 8 && <p className="mt-2 text-sm text-muted">And {history.length - 8} older.</p>}
        </section>
      )}
    </div>
  )
}

/** Confirm before adding a recipe from a link: it came from someone else. */
export function ImportRecipe({ recipe, onAdd, onClose }: { recipe: Pick<Recipe, 'name' | 'steps'>; onAdd: () => void; onClose: () => void }) {
  return (
    <Dialog title="Add this recipe?" onClose={onClose}>
      <p className="font-medium">{recipe.name}</p>
      <p className="text-muted">{describeStep(recipe.steps[0]!)}</p>
      <p className="mt-3 text-sm text-muted">A recipe holds settings only. It never contains files, and adding it doesn’t run anything.</p>
      <div className="mt-6 flex gap-2">
        <button type="button" onClick={onAdd} className="rounded-lg bg-jade px-4 py-2 font-semibold text-on-jade">Add recipe</button>
        <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2">Not now</button>
      </div>
    </Dialog>
  )
}

/**
 * A native modal <dialog>: focus trapping, Escape to close and the backdrop come from the browser.
 * The browser puts focus back only when it closes the dialog itself (Escape); when a button closes it,
 * the dialog is simply removed, so focus is put back here.
 */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const id = useId()
  const returnTo = useRef<HTMLElement | null>(null)
  const open = useCallback((el: HTMLDialogElement) => {
    if (!el.open) { returnTo.current = document.activeElement as HTMLElement | null; el.showModal() }
    const target = returnTo.current
    return () => queueMicrotask(() => target?.focus()) // after removal, when the page is no longer inert
  }, [])
  return (
    <dialog
      ref={open}
      onClose={onClose}
      aria-labelledby={id}
      className={`m-auto ${wide ? 'w-[min(calc(100%-2rem),36rem)]' : 'w-[min(calc(100%-2rem),28rem)]'} rounded-2xl border border-rule bg-paper p-6 text-ink backdrop:bg-ink/40`}
    >
      <h2 id={id} className="mb-3 text-xl font-medium">{title}</h2>
      {children}
    </dialog>
  )
}
