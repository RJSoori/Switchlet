// What Switchlet can do with each kind of file. Main-thread safe: no codecs imported here.
import type { Kind } from './detect'

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif'

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

export const IMAGE_FORMATS: ImageFormat[] = ['jpeg', 'webp', 'avif', 'png']
export const FORMAT_EXT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' }
export const FORMAT_LABEL: Record<ImageFormat, string> = { jpeg: 'JPG', png: 'PNG', webp: 'WebP', avif: 'AVIF' }
export const FORMAT_MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' }
export const DEFAULT_QUALITY: Record<ImageFormat, number> = { jpeg: 80, png: 100, webp: 80, avif: 55 }

const IMAGE_KINDS = new Set<Kind>(['jpeg', 'png', 'gif', 'webp', 'avif', 'heic'])
/** Formats whose metadata can be removed without touching the pixels. */
export const LOSSLESS_SCRUB = new Set<Kind>(['jpeg', 'png', 'webp'])
const KIND_MIME: Partial<Record<Kind, string>> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

export function opsFor(kind: Kind): Step['op'][] {
  if (!IMAGE_KINDS.has(kind)) return []
  return LOSSLESS_SCRUB.has(kind) ? ['image.convert', 'image.scrub'] : ['image.convert']
}

/** Sensible starting settings: keep web formats as they are, turn HEIC/GIF into a portable JPG. */
export function defaultStep(kind: Kind): Step | null {
  if (!IMAGE_KINDS.has(kind)) return null
  const format: ImageFormat = kind === 'png' || kind === 'webp' || kind === 'avif' ? kind : 'jpeg'
  return { op: 'image.convert', settings: { format, quality: DEFAULT_QUALITY[format], maxSide: null } }
}

export function fitWithin(width: number, height: number, maxSide: number | null) {
  const longest = Math.max(width, height)
  if (!maxSide || longest <= maxSide) return { width, height }
  const scale = maxSide / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

const stem = (name: string) => name.replace(/(?<=.)\.[^./\\]*$/, '') || 'file'

export function outputName(name: string, kind: Kind, step: Step): string {
  if (step.op === 'image.scrub') return `${stem(name)}-clean.${kind === 'jpeg' ? 'jpg' : kind}`
  return `${stem(name)}.${FORMAT_EXT[step.settings.format]}`
}

export function outputMime(kind: Kind, step: Step): string {
  return step.op === 'image.scrub' ? (KIND_MIME[kind] ?? 'application/octet-stream') : FORMAT_MIME[step.settings.format]
}
