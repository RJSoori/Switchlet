// Recipes: saved settings that can be re-run with one drop, and shared as a link that holds only the
// settings (in the URL fragment, which browsers never send to a server). Links are untrusted input:
// every step is rebuilt from an allow-list of tasks and values, never copied through.
import {
  AUDIO_LABEL, FORMAT_LABEL, IMAGE_FORMATS, OPS, VIDEO_LABEL, formatTime,
  type AudioFormat, type MediaQuality, type OpId, type PageSize, type SheetFormat, type Step, type Strength, type VideoContainer,
} from './ops'

export interface Recipe {
  id: string
  name: string
  /** One step for now; chains of steps can come later without changing stored recipes. */
  steps: Step[]
  createdAt: number
}

export const MAX_LINK_LENGTH = 2000
export const MAX_NAME_LENGTH = 80

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const oneOf = <T>(v: unknown, list: readonly T[]): v is T => list.includes(v as T)
const inRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

/** A clip from a recipe link: start/end in seconds, end after start, at most a day. */
function clip(s: Obj): { start: number; end: number | null } | null {
  if (!inRange(s.start, 0, 86_400)) return null
  if (s.end === null) return { start: s.start, end: null }
  return inRange(s.end, 0, 86_400) && s.end > s.start ? { start: s.start, end: s.end } : null
}

/** Rebuild a step from untrusted data, or null if anything doesn't match what Switchlet would create itself. */
export function validateStep(raw: unknown): Step | null {
  if (!isObj(raw) || typeof raw.op !== 'string' || !Object.hasOwn(OPS, raw.op)) return null
  const op = raw.op as OpId
  const s = isObj(raw.settings) ? raw.settings : {}
  switch (op) {
    case 'image.scrub': case 'pdf.merge': case 'pdf.scrub': case 'doc.convert':
      return { op }
    case 'image.convert':
      if (!oneOf(s.format, IMAGE_FORMATS) || !inRange(s.quality, 1, 100)) return null
      if (s.maxSide !== null && !(Number.isInteger(s.maxSide) && inRange(s.maxSide, 16, 20_000))) return null
      return { op, settings: { format: s.format, quality: Math.round(s.quality), maxSide: s.maxSide as number | null } }
    case 'image.toPdf':
      return oneOf(s.pageSize, ['image', 'a4', 'letter'] as PageSize[]) ? { op, settings: { pageSize: s.pageSize } } : null
    case 'pdf.split':
      return typeof s.ranges === 'string' && s.ranges.length <= 200 && /^[\d\s,-]*$/.test(s.ranges) ? { op, settings: { ranges: s.ranges } } : null
    case 'pdf.toImages':
      return oneOf(s.format, ['png', 'jpeg'] as const) && oneOf(s.dpi, [72, 150, 300]) ? { op, settings: { format: s.format, dpi: s.dpi } } : null
    case 'pdf.compress':
      return oneOf(s.strength, ['light', 'balanced', 'strong'] as Strength[]) ? { op, settings: { strength: s.strength } } : null
    case 'sheet.convert':
      // The sheet name belongs to one workbook, so it never travels in a recipe.
      return oneOf(s.to, ['csv', 'json', 'xlsx'] as SheetFormat[]) ? { op, settings: { to: s.to, sheet: null } } : null
    case 'video.convert':
      if (!oneOf(s.container, ['mp4', 'webm', 'mov'] as VideoContainer[]) || !oneOf(s.quality, ['keep', 'high', 'medium', 'low'] as MediaQuality[])) return null
      if (s.maxHeight !== null && !oneOf(s.maxHeight, [1080, 720, 480])) return null
      return { op, settings: { container: s.container, maxHeight: s.maxHeight as number | null, quality: s.quality } }
    case 'video.trim': {
      const c = clip(s)
      return c ? { op, settings: c } : null
    }
    case 'video.gif': {
      const c = clip(s)
      return c && oneOf(s.fps, [10, 15]) && oneOf(s.width, [320, 480, 640]) ? { op, settings: { ...c, fps: s.fps, width: s.width } } : null
    }
    case 'media.audio':
      return oneOf(s.format, ['m4a', 'ogg', 'wav'] as AudioFormat[]) ? { op, settings: { format: s.format } } : null
    case 'pdf.pages':
      return null // a page order only makes sense for one particular PDF
  }
}

/** Names are shown as text only; still, keep them short and free of control characters. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim().slice(0, MAX_NAME_LENGTH)
  return name || null
}

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

/** The part after "#recipe=". Holds only the name and settings, never anything about a file. */
export function encodeRecipe(r: Pick<Recipe, 'name' | 'steps'>): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify({ v: 1, name: r.name, steps: r.steps })))
}

/** Parse a shared recipe. Returns a plain-English reason instead of throwing. */
export function decodeRecipe(encoded: string): Pick<Recipe, 'name' | 'steps'> | string {
  const broken = 'This recipe link is broken or incomplete. Ask for the link again.'
  if (encoded.length > MAX_LINK_LENGTH) return 'This recipe link is too long to be one Switchlet made.'
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return broken
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(encoded)))
  } catch {
    return broken
  }
  if (!isObj(data) || data.v !== 1 || !Array.isArray(data.steps)) return broken
  const name = cleanName(data.name)
  if (!name) return broken
  if (data.steps.length !== 1) return 'This recipe needs a newer version of Switchlet.'
  const step = validateStep(data.steps[0])
  if (!step) return 'This recipe has settings Switchlet doesn’t recognise, so it wasn’t added.'
  return { name, steps: [step] }
}

/** Short, plain description of a step, for recipe names, history and the command palette. */
export function describeStep(step: Step): string {
  switch (step.op) {
    case 'image.convert': {
      const s = step.settings
      return [`Photos to ${FORMAT_LABEL[s.format]}`, s.maxSide ? `${s.maxSide} px` : '', s.format === 'png' ? '' : `quality ${s.quality}`].filter(Boolean).join(', ')
    }
    case 'image.toPdf': return `Photos to one PDF (${step.settings.pageSize === 'image' ? 'image-sized pages' : step.settings.pageSize === 'a4' ? 'A4' : 'US Letter'})`
    case 'pdf.split': return step.settings.ranges ? `Split PDF: ${step.settings.ranges}` : 'Split PDF into single pages'
    case 'pdf.toImages': return `PDF pages to ${step.settings.format === 'png' ? 'PNG' : 'JPG'}, ${step.settings.dpi} dpi`
    case 'pdf.compress': return `Shrink PDF (${step.settings.strength})`
    case 'sheet.convert': return `Spreadsheet to ${step.settings.to === 'xlsx' ? 'Excel' : step.settings.to.toUpperCase()}`
    case 'video.convert': {
      const s = step.settings
      return [`Video to ${VIDEO_LABEL[s.container]}`, s.maxHeight ? `${s.maxHeight}p` : '', s.quality === 'keep' ? '' : `${s.quality} quality`].filter(Boolean).join(', ')
    }
    case 'video.trim': return `Trim video, ${formatTime(step.settings.start)} to ${step.settings.end === null ? 'end' : formatTime(step.settings.end)}`
    case 'video.gif': return `GIF, ${step.settings.width} px, ${step.settings.fps} fps`
    case 'media.audio': return `Audio to ${AUDIO_LABEL[step.settings.format]}`
    case 'image.scrub': return 'Remove hidden data from photos'
    case 'pdf.scrub': return 'Remove hidden data from PDFs'
    case 'pdf.merge': return 'Merge PDFs'
    case 'pdf.pages': return 'Reorder PDF pages'
    case 'doc.convert': return 'Markdown and HTML conversion'
  }
}

/* ---------- history ---------- */

export interface HistoryEntry {
  id: number
  at: number
  /** File names only (the first few), never contents. */
  names: string[]
  count: number
  task: string
  outcome: 'done' | 'error' | 'cancelled'
}

export const MAX_HISTORY = 100

/** Ids to delete so only the newest MAX_HISTORY entries remain. */
export function overflow(entries: Pick<HistoryEntry, 'id' | 'at'>[], max = MAX_HISTORY): number[] {
  return [...entries].sort((a, b) => b.at - a.at).slice(max).map((e) => e.id)
}
