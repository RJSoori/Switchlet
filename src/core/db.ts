// Local storage (IndexedDB) for recipes and job history. Holds settings and file names, never file contents.
// Every call can fail (private browsing, storage turned off); callers treat that as "nothing saved".
import { overflow, type HistoryEntry, type Recipe } from './recipes'

type Store = 'recipes' | 'history'
let database: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('switchlet', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('recipes', { keyPath: 'id' })
      req.result.createObjectStore('history', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((e: unknown) => {
    database = null
    throw e
  })
  return database
}

async function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}

export const listRecipes = async () => (await run<Recipe[]>('recipes', 'readonly', (s) => s.getAll())).sort((a, b) => a.createdAt - b.createdAt)
export const saveRecipe = (r: Recipe) => run('recipes', 'readwrite', (s) => s.put(r))
export const deleteRecipe = (id: string) => run('recipes', 'readwrite', (s) => s.delete(id))

export const listHistory = async () => (await run<HistoryEntry[]>('history', 'readonly', (s) => s.getAll())).sort((a, b) => b.at - a.at)
export const clearHistory = () => run('history', 'readwrite', (s) => s.clear())
export async function addHistory(entry: HistoryEntry): Promise<void> {
  await run('history', 'readwrite', (s) => s.put(entry))
  const stale = overflow(await run<HistoryEntry[]>('history', 'readonly', (s) => s.getAll()))
  for (const id of stale) await run('history', 'readwrite', (s) => s.delete(id))
}

/** The recipe applied to every drop, if any. A per-browser convenience, so plain localStorage is enough. */
export function pinnedRecipeId(): string | null {
  try {
    return localStorage.getItem('switchlet:pinned')
  } catch {
    return null
  }
}
export function setPinnedRecipeId(id: string | null): void {
  try {
    if (id) localStorage.setItem('switchlet:pinned', id)
    else localStorage.removeItem('switchlet:pinned')
  } catch {
    // Storage unavailable: the recipe just won't stay switched on after a reload.
  }
}
