// Lossless metadata removal (pixels untouched) for JPEG, PNG and WebP, plus a plain-English report.
// Input is hostile: every length is bounds-checked, and malformed structure throws DecodeError.
import ExifReader from 'exifreader'
import { ascii, be16, be32, le32, type Kind } from '../core/detect'

export interface Finding { label: string; detail?: string }
export interface MetadataReport {
  found: Finding[] // human-readable details we could read (GPS, camera…)
  removed: string[] // categories of data that were removed
  kept: string[] // what was deliberately kept, and why it's harmless
}

export class DecodeError extends Error {
  override name = 'DecodeError'
}

const corrupt = (what: string) => new DecodeError(`This ${what} file is damaged or incomplete.`)

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/* ---------- report (EXIF details via ExifReader) ---------- */

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
      if (v !== undefined && String(v).trim()) return String(v).trim()
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
  add('Date taken', text('DateTimeOriginal', 'DateTimeDigitized', 'DateTime'))
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

function jpegCategory(marker: number, seg: Uint8Array): string | null {
  const id = ascii(seg, 4, 29)
  if (marker === 0xe0) return id.startsWith('JFXX') ? 'Embedded thumbnail' : null // keep JFIF
  if (marker === 0xee) return null // Adobe: colour transform, needed to decode correctly
  if (marker === 0xe2) return id.startsWith('ICC_PROFILE') ? null : id.startsWith('MPF') ? 'Extra embedded images (depth map, HDR)' : 'Other metadata'
  if (marker === 0xe1) return id.startsWith('Exif') ? 'EXIF data' : id.startsWith('http://ns.adobe.com/') ? 'XMP metadata' : 'Other metadata'
  if (marker === 0xed) return 'IPTC / Photoshop data'
  if (marker === 0xeb) return 'Content credentials (C2PA)'
  if (marker === 0xfe) return 'Comments'
  if (marker >= 0xe3 && marker <= 0xef) return 'Other metadata'
  return null // frame, table and restart segments: image data, always kept
}

const isStandalone = (m: number) => m === 0x01 || (m >= 0xd0 && m <= 0xd8)

/** Offset just past EOI, walking scans and their entropy-coded data. Truncated files keep everything. */
function jpegEnd(b: Uint8Array, i: number): number {
  while (i + 4 <= b.length) {
    i += 2 + be16(b, i + 2) // skip this segment (SOS header, or tables between progressive scans)
    while (i + 1 < b.length) {
      const next = b[i + 1]!
      if (b[i] === 0xff && next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) break
      i++
    }
    if (i + 1 >= b.length) return b.length
    if (b[i + 1] === 0xd9) return i + 2
  }
  return b.length
}

export function stripJpeg(b: Uint8Array, orientation?: number): { data: Uint8Array; removed: string[]; kept: string[] } {
  const out: Uint8Array[] = [b.subarray(0, 2)]
  const removed = new Set<string>()
  const kept: string[] = []
  let i = 2
  while (true) {
    if (i + 2 > b.length || b[i] !== 0xff) throw corrupt('JPEG')
    const m = b[i + 1]!
    if (m === 0xff) { i++; continue }
    if (m === 0xd9) { out.push(b.subarray(i, i + 2)); break }
    if (isStandalone(m)) { out.push(b.subarray(i, i + 2)); i += 2; continue }
    if (i + 4 > b.length) throw corrupt('JPEG')
    if (m === 0xda) {
      const end = jpegEnd(b, i)
      out.push(b.subarray(i, end))
      if (b.length - end > 32) removed.add('Extra embedded images (depth map, HDR)')
      break
    }
    const len = be16(b, i + 2)
    if (len < 2 || i + 2 + len > b.length) throw corrupt('JPEG')
    const seg = b.subarray(i, i + 2 + len)
    const category = jpegCategory(m, seg)
    if (category) removed.add(category)
    else {
      out.push(seg)
      if (m === 0xe2 && ascii(seg, 4, 11) === 'ICC_PROFILE' && !kept.includes('Colour profile')) kept.push('Colour profile')
    }
    i += 2 + len
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
    if (type === 'EXIF') removed.add('EXIF data')
    else if (type === 'XMP ') removed.add('XMP metadata')
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

export function scrubImage(input: Uint8Array, kind: Kind): { data: Uint8Array; report: MetadataReport } {
  const { found, orientation } = describeMetadata(input)
  const stripped =
    kind === 'jpeg' ? stripJpeg(input, orientation)
    : kind === 'png' ? stripPng(input)
    : kind === 'webp' ? stripWebp(input)
    : null
  if (!stripped) throw new DecodeError(`Removing metadata without re-encoding isn't available for this format.`)
  return { data: stripped.data, report: { found, removed: stripped.removed, kept: stripped.kept } }
}
