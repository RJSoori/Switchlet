// What Switchlet can do with each kind of file. Main-thread safe: no codecs or libraries imported here.
import type { Kind } from './detect'

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif'
export type PageSize = 'image' | 'a4' | 'letter'
export type SheetFormat = 'csv' | 'json' | 'xlsx'
export type Strength = 'light' | 'balanced' | 'strong'
export type VideoContainer = 'mp4' | 'webm' | 'mov'
export type AudioFormat = 'm4a' | 'ogg' | 'wav'
/** 'keep' copies the streams untouched when the container allows it (fast, no quality loss). */
export type MediaQuality = 'keep' | 'high' | 'medium' | 'low'

export interface VideoSettings {
  container: VideoContainer
  /** Largest output height in pixels; null keeps the original size. */
  maxHeight: number | null
  quality: MediaQuality
}
/** A stretch of a recording, in seconds. A null end means "to the end". */
export interface Clip { start: number; end: number | null }

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
  | { op: 'video.convert'; settings: VideoSettings }
  | { op: 'video.trim'; settings: Clip }
  | { op: 'video.gif'; settings: Clip & { fps: number; width: number } }
  | { op: 'media.audio'; settings: { format: AudioFormat } }

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
  /** Preselected when a file is dropped (and, unless `manual`, run straight away). */
  auto?: true
  /** Heavy work (audio and video): runs only when the user presses the button, never on every settings change. */
  manual?: true
}

const IMAGES: Kind[] = ['jpeg', 'png', 'gif', 'webp', 'avif', 'heic']
export const VIDEO_KINDS: Kind[] = ['mp4', 'mov', 'webm', 'mkv']
export const AUDIO_KINDS: Kind[] = ['mp3', 'wav', 'm4a', 'ogg', 'flac']

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
  'video.convert': { label: 'Convert or shrink', accepts: VIDEO_KINDS, auto: true, manual: true },
  'video.trim': { label: 'Trim', accepts: VIDEO_KINDS, maxFiles: 1, manual: true },
  'video.gif': { label: 'Make a GIF', accepts: VIDEO_KINDS, maxFiles: 1, manual: true },
  'media.audio': { label: 'Save the audio', accepts: [...VIDEO_KINDS, ...AUDIO_KINDS], auto: true, manual: true },
}

/* ---------- audio and video ---------- */

export const VIDEO_LABEL: Record<VideoContainer, string> = { mp4: 'MP4', webm: 'WebM', mov: 'MOV' }
export const AUDIO_LABEL: Record<AudioFormat, string> = { m4a: 'M4A (AAC)', ogg: 'Ogg (Opus)', wav: 'WAV' }
export const MAX_GIF_SECONDS = 30

/** Codecs this browser can encode, as reported by WebCodecs in the worker. */
export interface MediaCaps { video: string[]; audio: string[] }

/** Which output formats this browser can create. MP4/MOV take H.264, HEVC, VP9 or AV1; WebM takes VP8, VP9 or AV1. */
export function mediaSupport(caps: MediaCaps): { video: Record<VideoContainer, boolean>; audio: Record<AudioFormat, boolean> } {
  const any = (list: string[], wanted: string[]) => wanted.some((c) => list.includes(c))
  const isobmff = any(caps.video, ['avc', 'hevc', 'vp9', 'av1'])
  return {
    video: { mp4: isobmff, mov: isobmff, webm: any(caps.video, ['vp9', 'vp8', 'av1']) },
    audio: { m4a: caps.audio.includes('aac'), ogg: caps.audio.includes('opus'), wav: true },
  }
}

/** "65.5" → "1:05.5"; whole seconds drop the decimal ("1:05"). */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  const secs = Number.isInteger(Math.round(rest * 10) / 10) ? String(Math.round(rest)).padStart(2, '0') : rest.toFixed(1).padStart(4, '0')
  return `${m}:${secs}`
}

/** Frame times for a GIF: every 1/fps seconds from start, capped at MAX_GIF_SECONDS. */
export function gifTimestamps(start: number, end: number, fps: number): number[] {
  const stop = Math.min(end, start + MAX_GIF_SECONDS)
  const count = Math.max(1, Math.floor((stop - start) * fps))
  return Array.from({ length: count }, (_, i) => start + i / fps)
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
    case 'video.convert': return { op, settings: { container: kind === 'webm' ? 'webm' : kind === 'mov' ? 'mov' : 'mp4', maxHeight: null, quality: 'keep' } }
    case 'video.trim': return { op, settings: { start: 0, end: null } }
    case 'video.gif': return { op, settings: { start: 0, end: null, fps: 10, width: 480 } }
    case 'media.audio': return { op, settings: { format: 'm4a' } }
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
