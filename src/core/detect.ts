// File type detection from content (magic bytes), never trusting the extension for binary formats.

export type Kind =
  | 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'heic'
  | 'pdf'
  | 'mp4' | 'm4a' | 'mov' | 'webm' | 'mkv' | 'wav' | 'mp3'
  | 'xlsx' | 'csv' | 'json'
  | 'markdown' | 'html' | 'text'
  | 'svg' | 'zip' | 'unknown'

export type Group = 'image' | 'pdf' | 'media' | 'sheet' | 'doc' | 'none'

export interface Detected {
  kind: Kind
  label: string
  group: Group
  width?: number
  height?: number
}

const MB = 1_000_000
export const LIMITS = {
  bytes: { image: 200 * MB, pdf: 500 * MB, media: 4000 * MB, sheet: 50 * MB, doc: 5 * MB, none: 0 } satisfies Record<Group, number>,
  pixels: 100_000_000,
  batchFiles: 200,
}

const META: Record<Kind, [label: string, group: Group]> = {
  jpeg: ['JPEG image', 'image'], png: ['PNG image', 'image'], gif: ['GIF image', 'image'],
  webp: ['WebP image', 'image'], avif: ['AVIF image', 'image'], heic: ['HEIC photo', 'image'],
  pdf: ['PDF document', 'pdf'],
  mp4: ['MP4 video', 'media'], m4a: ['M4A audio', 'media'], mov: ['MOV video', 'media'],
  webm: ['WebM video', 'media'], mkv: ['MKV video', 'media'], wav: ['WAV audio', 'media'], mp3: ['MP3 audio', 'media'],
  xlsx: ['Excel workbook', 'sheet'], csv: ['CSV table', 'sheet'], json: ['JSON data', 'sheet'],
  markdown: ['Markdown text', 'doc'], html: ['HTML page', 'doc'], text: ['Text file', 'doc'],
  svg: ['SVG image', 'none'], zip: ['ZIP archive', 'none'], unknown: ['Unknown file', 'none'],
}

/** Bytes to read from the start of a file. Large enough to reach a JPEG frame header after EXIF (APP1 ≤ 64 KB). */
export const HEAD_BYTES = 128 * 1024

export const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len))
export const be16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
export const be32 = (b: Uint8Array, i: number) => be16(b, i) * 65536 + be16(b, i + 2)
export const le16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
export const le32 = (b: Uint8Array, i: number) => le16(b, i) + le16(b, i + 2) * 65536
const le24 = (b: Uint8Array, i: number) => le16(b, i) | ((b[i + 2] ?? 0) << 16)
const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v)

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])
const MOV_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'])

function isoBrandKind(b: Uint8Array): Kind | null {
  if (ascii(b, 4, 4) !== 'ftyp') return MOV_ATOMS.has(ascii(b, 4, 4)) ? 'mov' : null
  const size = Math.min(be32(b, 0), b.length, 512)
  const brands = [ascii(b, 8, 4)]
  for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, 4))
  if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif'
  if (brands.some((x) => HEIC_BRANDS.has(x))) return 'heic'
  if (brands[0] === 'qt  ') return 'mov'
  if (brands[0] === 'M4A ' || brands[0] === 'M4B ') return 'm4a'
  return 'mp4'
}

function binaryKind(b: Uint8Array): Kind | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'gif'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav'
  if (ascii(b, 0, Math.min(b.length, 1024)).includes('%PDF-')) return 'pdf'
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return ascii(b, 0, 64).includes('webm') ? 'webm' : 'mkv'
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return ascii(b, 0, Math.min(b.length, 8192)).includes('xl/') ? 'xlsx' : 'zip'
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe6) === 0xe2)) return 'mp3'
  return isoBrandKind(b)
}

function textKind(b: Uint8Array, ext: string): Kind | null {
  if (b.includes(0)) return null
  let text: string
  try {
    // stream:true tolerates a multi-byte character cut off at the end of the head slice
    text = new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: true })
  } catch {
    return null
  }
  const start = text.replace(/^﻿/, '').trimStart().slice(0, 1024).toLowerCase()
  if (start.startsWith('<svg') || (start.startsWith('<?xml') && start.includes('<svg'))) return 'svg'
  if (ext === 'csv' || ext === 'tsv') return 'csv'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'json' || start.startsWith('{') || start.startsWith('[')) return 'json'
  if (ext === 'html' || ext === 'htm' || start.startsWith('<!doctype html') || start.startsWith('<html')) return 'html'
  if (looksLikeCsv(text)) return 'csv'
  return 'text'
}

function looksLikeCsv(text: string): boolean {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 5)
  if (lines.length < 2) return false
  return [',', '\t', ';'].some((d) => {
    const n = lines[0]!.split(d).length
    return n > 1 && lines.every((l) => l.split(d).length === n)
  })
}

/** Pixel dimensions from the header, where that is cheap and reliable. Undefined if not found. */
export function headerDimensions(b: Uint8Array, kind: Kind): { width: number; height: number } | undefined {
  switch (kind) {
    case 'png':
      return ascii(b, 12, 4) === 'IHDR' ? { width: be32(b, 16), height: be32(b, 20) } : undefined
    case 'gif':
      return { width: le16(b, 6), height: le16(b, 8) }
    case 'webp': {
      const chunk = ascii(b, 12, 4)
      if (chunk === 'VP8X') return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) }
      if (chunk === 'VP8 ') return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff }
      if (chunk === 'VP8L') {
        const [b1, b2, b3, b4] = [b[21] ?? 0, b[22] ?? 0, b[23] ?? 0, b[24] ?? 0]
        return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) }
      }
      return undefined
    }
    case 'jpeg': {
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined
        const m = b[i + 1]!
        if (m === 0xff) { i++; continue } // fill byte
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue } // standalone markers
        const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
        if (isSof) return { width: be16(b, i + 7), height: be16(b, i + 5) }
        i += 2 + be16(b, i + 2)
      }
      return undefined
    }
    default:
      return undefined
  }
}

export function detect(head: Uint8Array, name: string): Detected {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const kind = binaryKind(head) ?? textKind(head, ext) ?? 'unknown'
  const [label, group] = META[kind]
  return { kind, label, group, ...headerDimensions(head, kind) }
}

export async function detectFile(file: File): Promise<Detected> {
  return detect(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()), file.name)
}

const bytesFormat = (unit: string, digits: number) =>
  new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits })

export function formatBytes(n: number): string {
  if (n < 1000) return bytesFormat('byte', 0).format(n)
  if (n < MB) return bytesFormat('kilobyte', 0).format(n / 1000)
  if (n < 1000 * MB) return bytesFormat('megabyte', 1).format(n / MB)
  return bytesFormat('gigabyte', 2).format(n / (1000 * MB))
}

/** A user-facing reason this file can't be processed, or null if it's within limits. */
export function limitProblem(d: Detected, size: number): string | null {
  if (d.kind === 'svg') return 'SVG files aren’t supported because they can contain scripts. Export it as a PNG and drop that instead.'
  if (d.group === 'none') return null // "unsupported" is decided by the op registry, not here
  const max = LIMITS.bytes[d.group]
  if (size > max) return `This ${d.label} is ${formatBytes(size)}, over the ${formatBytes(max)} limit for this type. Try a smaller file.`
  if (d.width && d.height && d.width * d.height > LIMITS.pixels) {
    const mp = Math.round((d.width * d.height) / 1e6)
    return `This image is ${d.width.toLocaleString('en')} × ${d.height.toLocaleString('en')} pixels (${mp.toLocaleString('en')} megapixels), over the 100-megapixel limit a browser tab can safely handle.`
  }
  return null
}
