// Lossless metadata removal (pixels untouched) for JPEG, PNG and WebP, plus a plain-English report.
// Input is hostile: every length is bounds-checked, and malformed structure throws DecodeError.
import ExifReader from 'exifreader'
import { ascii, be16, be32, le32, type Kind } from '../core/detect'
import { DecodeError, NoticeError } from './errors'

export { DecodeError }

import type { Finding, MetadataReport } from '../core/ops'

export type { Finding, MetadataReport }

const corrupt = (what: string) => new DecodeError(`This ${what} file is damaged or incomplete.`)

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/* ---------- report (EXIF details via ExifReader) ---------- */

/** "2024:06:01 18:42:07" → "1 June 2024 at 18:42". Anything unparseable is shown as written. */
export function exifDate(raw?: string): string | undefined {
  const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/)
  if (!m) return raw
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)
  return Number.isNaN(d.getTime()) ? raw : new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(d)
}

type Tag = { description?: unknown; value?: unknown } | undefined

export function describeMetadata(input: ArrayBuffer | Uint8Array): { found: Finding[]; orientation?: number } {
  const load = () => ExifReader.load(input, { expanded: true, excludeTags: { xmp: true, icc: true, makerNotes: true } })
  let tags: ReturnType<typeof load>
  try {
    // XMP needs a DOMParser (absent in workers); its presence is reported by the segment walkers instead.
    tags = load()
  } catch {
    return { found: [] } // no metadata, or unreadable metadata: nothing to describe
  }
  const exif = (tags.exif ?? {}) as Record<string, Tag>
  const text = (...keys: string[]) => {
    for (const k of keys) {
      const v = exif[k]?.description
      if (v !== undefined && String(v).trim()) return String(v).trim().slice(0, 120)
    }
    return undefined
  }
  const found: Finding[] = []
  const add = (label: string, detail?: string) => detail && found.push({ label, detail })

  const lat = tags.gps?.Latitude, lon = tags.gps?.Longitude
  if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) {
    add('GPS location', `${lat.toFixed(4)}, ${lon.toFixed(4)}`)
  }
  const make = text('Make'), model = text('Model')
  add('Camera', make && model && !model.startsWith(make) ? `${make} ${model}` : model ?? make)
  add('Lens', text('LensModel'))
  add('Date taken', exifDate(text('DateTimeOriginal', 'DateTimeDigitized', 'DateTime')))
  add('Software', text('Software'))
  add('Device serial number', text('BodySerialNumber', 'CameraSerialNumber', 'LensSerialNumber'))
  add('Owner name', text('Artist', 'CameraOwnerName'))
  add('Copyright', text('Copyright'))
  if (tags.Thumbnail) found.push({ label: 'Embedded thumbnail', detail: 'a small copy of the original photo' })

  const o = exif.Orientation?.value
  return { found, orientation: typeof o === 'number' && o >= 1 && o <= 8 ? o : undefined }
}

/* ---------- JPEG ---------- */

/** A minimal EXIF block holding only the Orientation tag, so stripped photos stay upright. */
export function orientationApp1(orientation: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, // APP1, length 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // TIFF header, big-endian, IFD0 at 8
    0x00, 0x01, // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation SHORT = n
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ])
}

/** Segments needed to decode the image: frames (SOFn), Huffman/arithmetic/quantisation tables, restart interval, DNL, EXP. */
const isImageSegment = (m: number) => (m >= 0xc0 && m <= 0xcf && m !== 0xc8) || m === 0xdb || m === 0xdd || m === 0xdc || m === 0xdf

/** Allow-list: image segments, JFIF (rebuilt without thumbnail), ICC profile and Adobe colour transform. Everything else is removed. */
function jpegCategory(marker: number, seg: Uint8Array): string | null {
  const id = ascii(seg, 4, 29)
  if (isImageSegment(marker)) return null
  if (marker === 0xee) return id.startsWith('Adobe') && seg.length >= 16 ? null : 'Other metadata' // rebuilt in stripJpeg
  if (marker === 0xe0) return id.startsWith('JFIF\0') ? null : 'Embedded thumbnail'
  if (marker === 0xe2) return id.startsWith('ICC_PROFILE\0') ? null : id.startsWith('MPF') ? 'Extra embedded images (depth map, HDR)' : 'Other metadata'
  if (marker === 0xe1) return id.startsWith('Exif') ? 'EXIF data' : id.startsWith('http://ns.adobe.com/') ? 'XMP metadata' : 'Other metadata'
  if (marker === 0xed) return 'IPTC / Photoshop data'
  if (marker === 0xeb) return 'Content credentials (C2PA)'
  if (marker === 0xfe) return 'Comments'
  return 'Other metadata'
}

/** JFIF APP0 reduced to its 14-byte header with the thumbnail size zeroed. */
function jfifWithoutThumbnail(seg: Uint8Array): { seg: Uint8Array; hadThumbnail: boolean } {
  if (seg.length < 18) return { seg, hadThumbnail: false }
  const out = seg.slice(0, 18)
  out[2] = 0x00; out[3] = 0x10 // length 16
  const hadThumbnail = seg.length > 18 || out[16] !== 0 || out[17] !== 0
  out[16] = 0; out[17] = 0
  return { seg: out, hadThumbnail }
}

/** A canonical 16-byte Adobe APP14 carrying only the colour-transform byte the decoder needs. */
const adobeSegment = (transform: number) =>
  new Uint8Array([0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, transform])

const isRestart = (m: number) => m >= 0xd0 && m <= 0xd7

/** Index of the next marker after entropy-coded scan data (skipping stuffed 0xFF00 bytes and restart markers). */
function skipEntropy(b: Uint8Array, i: number): number {
  for (; i + 1 < b.length; i++) {
    if (b[i] === 0xff && b[i + 1] !== 0x00 && !isRestart(b[i + 1]!)) return i
  }
  throw corrupt('JPEG') // no end-of-image marker: incomplete file
}

export function stripJpeg(b: Uint8Array, orientation?: number): { data: Uint8Array; removed: string[]; kept: string[] } {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw corrupt('JPEG')
  const out: Uint8Array[] = [b.subarray(0, 2)]
  const removed = new Set<string>()
  const kept: string[] = []
  let i = 2
  while (true) {
    if (i + 2 > b.length || b[i] !== 0xff) throw corrupt('JPEG')
    const m = b[i + 1]!
    if (m === 0xff) { i++; continue } // fill byte
    if (m === 0xd9) {
      out.push(b.subarray(i, i + 2))
      if (b.length - (i + 2) > 32) removed.add('Extra embedded images (depth map, HDR)')
      break
    }
    if (isRestart(m) || m === 0x01) { out.push(b.subarray(i, i + 2)); i += 2; continue }
    if (i + 4 > b.length) throw corrupt('JPEG')
    const len = be16(b, i + 2)
    if (len < 2 || i + 2 + len > b.length) throw corrupt('JPEG')
    const seg = b.subarray(i, i + 2 + len)
    i += 2 + len
    if (m === 0xda) { // start of scan: keep its header and the compressed data that follows
      const end = skipEntropy(b, i)
      out.push(seg, b.subarray(i, end))
      i = end
      continue
    }
    const category = jpegCategory(m, seg)
    if (category) { removed.add(category); continue }
    if (m === 0xe0) {
      const jfif = jfifWithoutThumbnail(seg)
      if (jfif.hadThumbnail) removed.add('Embedded thumbnail')
      out.push(jfif.seg)
      continue
    }
    if (m === 0xee) {
      if (seg.length !== 16) removed.add('Other metadata')
      out.push(adobeSegment(seg[15]!))
      continue
    }
    if (m === 0xe2 && !kept.includes('Colour profile')) kept.push('Colour profile')
    out.push(seg)
  }
  if (orientation && orientation !== 1) {
    out.splice(out[1]?.[1] === 0xe0 ? 2 : 1, 0, orientationApp1(orientation)) // after JFIF APP0 if present
    kept.unshift('Orientation, so the photo stays upright')
  }
  return { data: concat(out), removed: [...removed], kept }
}

/* ---------- PNG ---------- */

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT'])

export function stripPng(b: Uint8Array): { data: Uint8Array; removed: string[]; kept: string[] } {
  const out: Uint8Array[] = [b.subarray(0, 8)]
  const removed = new Set<string>()
  const kept = new Set<string>()
  let i = 8
  while (true) {
    if (i + 12 > b.length) throw corrupt('PNG')
    const len = be32(b, i)
    const type = ascii(b, i + 4, 4)
    const end = i + 12 + len
    if (end > b.length) throw corrupt('PNG')
    if (PNG_KEEP.has(type)) {
      out.push(b.subarray(i, end))
      if (type === 'iCCP') kept.add('Colour profile')
    } else if (type === 'iTXt' && ascii(b, i + 8, 17) === 'XML:com.adobe.xmp') removed.add('XMP metadata')
    else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') removed.add('Text notes (author, software, comments, AI prompts)')
    else if (type === 'eXIf') removed.add('EXIF data')
    else if (type === 'tIME') removed.add('Last-modified time')
    else if (type === 'caBX') removed.add('Content credentials (C2PA)')
    else removed.add('Other metadata')
    if (type === 'IEND') break
    i = end
  }
  return { data: concat(out), removed: [...removed], kept: [...kept] }
}

/* ---------- WebP ---------- */

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'])

export function stripWebp(b: Uint8Array): { data: Uint8Array; removed: string[]; kept: string[] } {
  if (b.length < 12) throw corrupt('WebP')
  const out: Uint8Array[] = [b.slice(0, 12)]
  const removed = new Set<string>()
  const kept = new Set<string>()
  const riffEnd = Math.min(b.length, 8 + le32(b, 4))
  let i = 12
  while (i + 8 <= riffEnd) {
    const type = ascii(b, i, 4)
    const size = le32(b, i + 4)
    const end = i + 8 + size + (size & 1)
    if (i + 8 + size > b.length) throw corrupt('WebP')
    if (!WEBP_KEEP.has(type)) removed.add(type === 'EXIF' ? 'EXIF data' : type === 'XMP ' ? 'XMP metadata' : 'Other metadata')
    else {
      const chunk = b.slice(i, Math.min(end, b.length))
      if (type === 'VP8X' && size >= 1) chunk[8] = chunk[8]! & ~0x0c // clear the EXIF and XMP flags
      if (type === 'ICCP') kept.add('Colour profile')
      out.push(chunk)
    }
    i = end
  }
  const data = concat(out)
  new DataView(data.buffer).setUint32(4, data.length - 8, true) // RIFF size
  return { data, removed: [...removed], kept: [...kept] }
}

/* ---------- entry point ---------- */

export const LOSSLESS_SCRUB: Kind[] = ['jpeg', 'png', 'webp']

/**
 * The metadata parts a JPEG, PNG or WebP holds (text notes, XMP, timestamps…), for the report after a re-encode,
 * which drops them all. describeMetadata reads EXIF fields only, so a PNG with just an author note looked clean.
 */
export function hiddenParts(input: Uint8Array, kind: Kind): string[] {
  try {
    return kind === 'jpeg' ? stripJpeg(input).removed : kind === 'png' ? stripPng(input).removed : kind === 'webp' ? stripWebp(input).removed : []
  } catch {
    return [] // the browser's decoder may still read a file these strict walkers reject
  }
}

export function scrubImage(input: Uint8Array, kind: Kind): { data: Uint8Array; report: MetadataReport } {
  const { found, orientation } = describeMetadata(input)
  const stripped =
    kind === 'jpeg' ? stripJpeg(input, orientation)
    : kind === 'png' ? stripPng(input)
    : kind === 'webp' ? stripWebp(input)
    : null
  if (!stripped) throw new NoticeError('Removing hidden data without re-encoding works for JPG, PNG and WebP. For this format, choose Convert: it removes hidden data too.')
  return { data: stripped.data, report: { found, removed: stripped.removed, kept: stripped.kept } }
}
