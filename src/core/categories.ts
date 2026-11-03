// Categories and the drop router: which screen a set of dropped files opens, decided from their content
// (detect.ts reads magic bytes), never from the file name alone. Pure, so it's unit-tested in Node.
import type { Kind } from './detect'
import { defaultOp, opsFor, type OpId } from './ops'

export type Category = 'images' | 'pdf' | 'media' | 'docs' | 'sheets'

interface CategoryInfo {
  id: Category
  label: string
  /** "1 PDF", "3 photos" */
  noun: [one: string, many: string]
  /** What to drop here, for the empty screen ("Drop PDFs or photos anywhere on this page"). */
  drop: string
  blurb: string
  /** Tasks on this screen, in the order they're offered. A task can live on more than one screen. */
  tasks: OpId[]
}

/** In rail order. */
export const CATEGORIES: CategoryInfo[] = [
  {
    id: 'images', label: 'Images', noun: ['photo', 'photos'], drop: 'photos',
    blurb: 'Convert photos between HEIC, JPG, PNG, WebP and AVIF, make them smaller, remove hidden location and camera details, or put them in a PDF.',
    tasks: ['image.convert', 'image.scrub', 'image.toPdf'],
  },
  {
    id: 'pdf', label: 'PDF', noun: ['PDF', 'PDFs'], drop: 'PDFs or photos',
    blurb: 'Merge, split, reorder, shrink or clean up PDFs, save pages as images, or make one PDF from photos.',
    tasks: ['pdf.merge', 'pdf.pages', 'pdf.split', 'pdf.toImages', 'pdf.compress', 'pdf.scrub', 'image.toPdf'],
  },
  {
    id: 'media', label: 'Video and audio', noun: ['video or audio file', 'video and audio files'], drop: 'videos or audio',
    blurb: 'Convert or shrink videos, trim them, make a GIF, or save just the sound.',
    tasks: ['video.convert', 'video.trim', 'video.gif', 'media.audio'],
  },
  {
    id: 'docs', label: 'Docs', noun: ['document', 'documents'], drop: 'Markdown, text or HTML files',
    blurb: 'Turn Markdown or plain text into a clean HTML page, or an HTML page into Markdown.',
    tasks: ['doc.convert'],
  },
  {
    id: 'sheets', label: 'Sheets', noun: ['spreadsheet', 'spreadsheets'], drop: 'Excel, CSV or JSON files',
    blurb: 'Convert between Excel, CSV and JSON, one sheet at a time.',
    tasks: ['sheet.convert'],
  },
]

export const categoryInfo = (id: Category) => CATEGORIES.find((c) => c.id === id)!

/** A file's home screen. null: Switchlet can't open it. Typed as a full Record, and a test checks it against the task list. */
export const CATEGORY_OF: Record<Kind, Category | null> = {
  jpeg: 'images', png: 'images', gif: 'images', webp: 'images', avif: 'images', heic: 'images',
  pdf: 'pdf',
  mp4: 'media', m4a: 'media', mov: 'media', webm: 'media', mkv: 'media', wav: 'media', mp3: 'media', ogg: 'media', flac: 'media',
  markdown: 'docs', html: 'docs', text: 'docs',
  csv: 'sheets', json: 'sheets', xlsx: 'sheets',
  svg: null, zip: null, unknown: null,
}

/** "1 PDF", "3 photos" */
export function describeGroup(category: Category, count: number): string {
  const [one, many] = categoryInfo(category).noun
  return `${count} ${count === 1 ? one : many}`
}

/** Tasks on this screen that fit every one of these files. */
export const tasksIn = (category: Category, kinds: Kind[]): OpId[] => opsFor(kinds).filter((op) => categoryInfo(category).tasks.includes(op))

export interface Entry { kind: Kind; problem: string | null }
export interface Route {
  /** The screen to show, or null to stay where you are (nothing in the drop can be opened). */
  open: Category | null
  /** Indices of the files that open there. */
  take: number[]
  /** The task to preselect, or null when the person should choose (one PDF has no obvious default). */
  op: OpId | null
  /** The rest of a mixed drop, by screen, largest group first. Shown as chips; never mixed into the open job. */
  others: { category: Category; take: number[] }[]
  /** Files that can't be opened (unsupported, or over a limit). */
  rejected: number[]
}

/**
 * Where a drop goes. Files are grouped by home screen. If the current screen has a task for a group
 * (images dropped on PDF → Images to PDF), that group stays here. The largest group opens; ties prefer
 * the current screen, then rail order.
 */
export function route(entries: Entry[], current: Category | null): Route {
  const rejected: number[] = []
  const groups = new Map<Category, number[]>()
  entries.forEach((e, i) => {
    const home = e.problem ? null : CATEGORY_OF[e.kind]
    if (!home) rejected.push(i)
    else groups.set(home, [...(groups.get(home) ?? []), i])
  })
  const kindsOf = (take: number[]) => take.map((i) => entries[i]!.kind)
  const rank = (c: Category) => (c === current ? -1 : CATEGORIES.findIndex((x) => x.id === c))
  const bySize = (a: [Category, number[]], b: [Category, number[]]) => b[1].length - a[1].length || rank(a[0]) - rank(b[0])

  // Context first: the current screen keeps a group it has a task for, unless files of its own kind came too.
  let stayed = false
  if (current && !groups.has(current)) {
    const fit = [...groups].sort(bySize).find(([, take]) => tasksIn(current, kindsOf(take)).length)
    if (fit) { groups.delete(fit[0]); groups.set(current, fit[1]); stayed = true }
  }

  const sorted = [...groups].sort(bySize)
  if (!sorted.length) return { open: null, take: [], op: null, others: [], rejected }
  const [open, take] = sorted[0]!
  const kinds = kindsOf(take)
  const op = stayed && open === current ? tasksIn(open, kinds)[0]! : defaultOp(kinds)
  return { open, take, op, others: sorted.slice(1).map(([category, t]) => ({ category, take: t })), rejected }
}

/**
 * A best guess at a file's kind from the MIME type a drag exposes (browsers don't show file bytes until the drop).
 * Only used for the overlay's hint; routing always uses magic bytes after the drop. null: no useful type.
 */
export function kindFromMime(mime: string): Kind | null {
  const m = mime.toLowerCase()
  const exact: Record<string, Kind> = {
    'image/jpeg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'image/heic': 'heic', 'image/heif': 'heic', 'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'text/markdown': 'markdown', 'text/x-markdown': 'markdown', 'text/html': 'html', 'text/plain': 'text',
    'text/csv': 'csv', 'application/json': 'json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  }
  if (exact[m]) return exact[m]
  if (m.startsWith('image/')) return 'png'
  if (m.startsWith('video/')) return 'mp4'
  if (m.startsWith('audio/')) return 'mp3'
  return m ? 'unknown' : null
}
