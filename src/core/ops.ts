// What Switchlet can do with each kind of file. Main-thread safe: no codecs or libraries imported here.
import type { Kind } from './detect'

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif'
export type PageSize = 'image' | 'a4' | 'letter'
export type SheetFormat = 'csv' | 'json' | 'xlsx'
export type Strength = 'light' | 'balanced' | 'strong'

export interface ImageSettings {
  format: ImageFormat
  /** 1–100. Ignored for PNG, which is always lossless. */
  quality: number
  /** Longest side in pixels; null keeps the original size. Never upscales. */
  maxSide: number | null
}

/** One step of a recipe. A single conversion is a one-step recipe. */
export type Step =
  | { op: 'image.convert'; settings: ImageSettings }
  | { op: 'image.scrub' }
  | { op: 'image.toPdf'; settings: { pageSize: PageSize } }
  | { op: 'pdf.merge' }
  | { op: 'pdf.pages'; settings: { order: number[] | null } }
  | { op: 'pdf.split'; settings: { ranges: string } }
  | { op: 'pdf.toImages'; settings: { format: 'png' | 'jpeg'; dpi: number } }
  | { op: 'pdf.compress'; settings: { strength: Strength } }
  | { op: 'pdf.scrub' }
  | { op: 'doc.convert' }
  | { op: 'sheet.convert'; settings: { to: SheetFormat; sheet: string | null } }

export type OpId = Step['op']

export interface InFile { name: string; kind: Kind; bytes: Uint8Array<ArrayBuffer> }
export interface OutFile { name: string; data: ArrayBuffer; type: string }
export interface Finding { label: string; detail?: string }
export interface MetadataReport {
  found: Finding[] // human-readable details we could read (GPS, author…)
  removed: string[] // categories of data that were removed
  kept: string[] // what was deliberately kept, and why it's harmless
}
/** What a task hands back. Most fields are optional and depend on the task. */
export interface TaskResult {
  files: OutFile[]
  report?: MetadataReport
  /** A plain-English remark about the result ("Recompressed 4 of 6 images"). */
  note?: string
  width?: number
  height?: number
  /** Decoded original for formats the page can't display itself (HEIC). */
  preview?: ImageBitmap
  /** Sheet names of a workbook, so the user can pick one. */
  sheets?: string[]
  /** Text shown under the result (start of a CSV, JSON or Markdown output). */
  previewText?: string
  /** Sanitized HTML body shown under a Markdown → HTML result. */
  previewHtml?: string
}

interface OpInfo {
  label: string
  accepts: Kind[]
  /** One output made from all the files (merge, images → PDF). */
  combines?: true
  minFiles?: number
  maxFiles?: number
  /** Runs on the main thread. doc.convert needs a DOM; pdf.toImages uses pdf.js's display layer (parsing stays in pdf.js's worker). */
  main?: true
  /** Converts on its own as soon as a single file is dropped. Other tasks wait for the user to pick them. */
  auto?: true
}

const IMAGES: Kind[] = ['jpeg', 'png', 'gif', 'webp', 'avif', 'heic']

export const OPS: Record<OpId, OpInfo> = {
  'image.convert': { label: 'Convert or shrink', accepts: IMAGES, auto: true },
  'image.scrub': { label: 'Only remove hidden data', accepts: ['jpeg', 'png', 'webp'] },
  'image.toPdf': { label: 'Make a PDF', accepts: IMAGES, combines: true },
  'pdf.merge': { label: 'Merge into one PDF', accepts: ['pdf'], combines: true, minFiles: 2 },
  'pdf.pages': { label: 'Reorder or remove pages', accepts: ['pdf'], maxFiles: 1 },
  'pdf.split': { label: 'Split into parts', accepts: ['pdf'] },
  'pdf.toImages': { label: 'Save pages as images', accepts: ['pdf'], main: true },
  'pdf.compress': { label: 'Shrink', accepts: ['pdf'] },
  'pdf.scrub': { label: 'Remove hidden data', accepts: ['pdf'] },
  'doc.convert': { label: 'Convert', accepts: ['markdown', 'text', 'html'], main: true, auto: true },
  'sheet.convert': { label: 'Convert', accepts: ['csv', 'json', 'xlsx'], auto: true },
}

/** Tasks that fit every one of these files (a mixed drop of photos and PDFs has none). */
export function opsFor(kinds: Kind[]): OpId[] {
  if (!kinds.length) return []
  return (Object.keys(OPS) as OpId[]).filter((id) => {
    const o = OPS[id]
    return kinds.every((k) => o.accepts.includes(k)) && kinds.length >= (o.minFiles ?? 1) && kinds.length <= (o.maxFiles ?? Infinity)
  })
}

/** The task to preselect, or null when the user should choose (a single PDF has no obvious default). */
export function defaultOp(kinds: Kind[]): OpId | null {
  const ops = opsFor(kinds)
  if (ops.includes('pdf.merge')) return 'pdf.merge'
  return ops.find((id) => OPS[id].auto) ?? null
}

export const IMAGE_FORMATS: ImageFormat[] = ['jpeg', 'webp', 'avif', 'png']
export const FORMAT_EXT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' }
export const FORMAT_LABEL: Record<ImageFormat, string> = { jpeg: 'JPG', png: 'PNG', webp: 'WebP', avif: 'AVIF' }
export const FORMAT_MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' }
export const DEFAULT_QUALITY: Record<ImageFormat, number> = { jpeg: 80, png: 100, webp: 80, avif: 55 }
/** Formats whose metadata can be removed without touching the pixels. */
export const LOSSLESS_SCRUB = new Set<Kind>(OPS['image.scrub'].accepts)

export function makeStep(op: OpId, kind: Kind): Step {
  switch (op) {
    case 'image.convert': {
      const format: ImageFormat = kind === 'png' || kind === 'webp' || kind === 'avif' ? kind : 'jpeg'
      return { op, settings: { format, quality: DEFAULT_QUALITY[format], maxSide: null } }
    }
    case 'image.toPdf': return { op, settings: { pageSize: 'a4' } }
    case 'pdf.pages': return { op, settings: { order: null } }
    case 'pdf.split': return { op, settings: { ranges: '' } }
    case 'pdf.toImages': return { op, settings: { format: 'jpeg', dpi: 150 } }
    case 'pdf.compress': return { op, settings: { strength: 'balanced' } }
    case 'sheet.convert': return { op, settings: { to: kind === 'xlsx' ? 'csv' : 'xlsx', sheet: null } }
    case 'image.scrub': case 'pdf.merge': case 'pdf.scrub': case 'doc.convert': return { op }
  }
}

export function fitWithin(width: number, height: number, maxSide: number | null) {
  const longest = Math.max(width, height)
  if (!maxSide || longest <= maxSide) return { width, height }
  const scale = maxSide / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** File name without its extension ("my.photo.jpeg" → "my.photo", ".hidden" stays). */
export const stem = (name: string) => name.replace(/(?<=.)\.[^./\\]*$/, '') || 'file'

export function imageOutputName(name: string, kind: Kind, step: Extract<Step, { op: 'image.convert' | 'image.scrub' }>): string {
  if (step.op === 'image.scrub') return `${stem(name)}-clean.${kind === 'jpeg' ? 'jpg' : kind}`
  return `${stem(name)}.${FORMAT_EXT[step.settings.format]}`
}

/**
 * Page ranges like "1-3, 5, 8-" (1-based, "8-" means 8 to the end) into 0-based index groups.
 * Empty input means every page on its own. Returns an error message instead of throwing.
 */
export function parseRanges(input: string, pageCount: number): number[][] | string {
  if (!input.trim()) return Array.from({ length: pageCount }, (_, i) => [i])
  const groups: number[][] = []
  for (const part of input.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)?\s*(-)?\s*(\d+)?$/)
    if (!m || (!m[1] && !m[3])) return `“${part}” isn’t a page or range. Use numbers like 2 or 4-7.`
    const from = m[1] ? Number(m[1]) : 1
    const to = m[2] ? (m[3] ? Number(m[3]) : pageCount) : from
    if (from < 1 || to > pageCount) return `This PDF has pages 1 to ${pageCount}, so “${part}” is out of range.`
    if (from > to) return `Write “${part}” from low to high, like ${to}-${from}.`
    groups.push(Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i))
  }
  return groups
}
