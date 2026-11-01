// PDF tools. Run inside the worker with @cantoo/pdf-lib.
// Every document is loaded with updateMetadata:false (pdf-lib never stamps itself as Producer), and
// unreachable objects are dropped before saving, so leftovers from earlier edits of a file never
// travel into the new copy.
import {
  EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFObject,
} from '@cantoo/pdf-lib'
import type { Kind } from '../core/detect'
import { parseRanges, stem, type Finding, type OutFile, type PageSize, type Strength, type TaskResult } from '../core/ops'
import { decodeImage, drawPixels, encodeJpeg } from './decode'
import { DecodeError, NoticeError } from './errors'

export type Progress = (fraction: number, stage: string) => void
export interface InFile { name: string; kind: Kind; bytes: Uint8Array<ArrayBuffer> }

const PDF_TYPE = 'application/pdf'

async function open(f: InFile): Promise<PDFDocument> {
  const unreadable = () => new DecodeError(`“${f.name}” couldn’t be read as a PDF. It may be damaged or incomplete.`)
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(f.bytes, { updateMetadata: false })
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      throw new NoticeError(`“${f.name}” is password-protected, and Switchlet can’t open protected PDFs. Remove the password in the app that made it, then try again.`)
    }
    throw unreadable()
  }
  // pdf-lib is lenient: garbage can "load" as a document with no page tree and fail later.
  try {
    if (doc.getPageCount() > 0) return doc
  } catch { /* fall through */ }
  throw unreadable()
}

const create = () => PDFDocument.create({ updateMetadata: false })

/** Remove every object not reachable from the trailer (old revisions, orphaned metadata). Returns how many were dropped. */
export function dropUnreachable(doc: PDFDocument): number {
  const ctx = doc.context
  const seen = new Set<string>()
  const stack: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter((o): o is PDFObject => !!o)
  while (stack.length) {
    const o = stack.pop()!
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue
      seen.add(o.tag)
      const target = ctx.lookup(o)
      if (target) stack.push(target)
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v)
    } else if (o instanceof PDFArray) {
      stack.push(...o.asArray())
    } else if (o instanceof PDFStream) {
      for (const [, v] of o.dict.entries()) stack.push(v)
    }
  }
  let dropped = 0
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) { ctx.delete(ref); dropped++ }
  return dropped
}

async function save(doc: PDFDocument): Promise<ArrayBuffer> {
  dropUnreachable(doc)
  const bytes = await doc.save({ useObjectStreams: true, updateFieldAppearances: false, addDefaultPage: false })
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function pick(src: PDFDocument, indices: number[]): Promise<ArrayBuffer> {
  const out = await create()
  for (const page of await out.copyPages(src, indices)) out.addPage(page)
  return save(out)
}

const pdfFile = (name: string, data: ArrayBuffer): OutFile => ({ name, data, type: PDF_TYPE })

/* ---------- merge, split, reorder ---------- */

export async function merge(files: InFile[], progress: Progress = () => {}): Promise<TaskResult> {
  const out = await create()
  for (const [i, f] of files.entries()) {
    progress(i / files.length, `Adding ${f.name}`)
    const src = await open(f)
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page)
  }
  progress(0.95, 'Saving')
  return {
    files: [pdfFile(`${stem(files[0]!.name)}-merged.pdf`, await save(out))],
    note: `${out.getPageCount()} pages from ${files.length} PDFs. Bookmarks and form fields from the originals aren’t kept.`,
  }
}

export async function split(f: InFile, ranges: string, progress: Progress = () => {}): Promise<TaskResult> {
  const src = await open(f)
  const groups = parseRanges(ranges, src.getPageCount())
  if (typeof groups === 'string') throw new NoticeError(groups)
  const files: OutFile[] = []
  for (const [i, g] of groups.entries()) {
    progress(i / groups.length, `Making part ${i + 1} of ${groups.length}`)
    const label = g.length === 1 ? `page-${g[0]! + 1}` : `pages-${g[0]! + 1}-${g.at(-1)! + 1}`
    files.push(pdfFile(`${stem(f.name)}-${label}.pdf`, await pick(src, g)))
  }
  return { files }
}

export async function reorder(f: InFile, order: number[] | null): Promise<TaskResult> {
  const src = await open(f)
  const count = src.getPageCount()
  const indices = order ?? src.getPageIndices()
  if (!indices.length) throw new NoticeError('Keep at least one page.')
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) throw new NoticeError('That page order doesn’t match this PDF. Pick the pages again.')
  const removed = count - new Set(indices).size
  return {
    files: [pdfFile(`${stem(f.name)}-edited.pdf`, await pick(src, indices))],
    note: `${indices.length} ${indices.length === 1 ? 'page' : 'pages'}${removed > 0 ? `, ${removed} removed` : ''}.`,
  }
}

/* ---------- images → PDF ---------- */

const PAGE: Record<Exclude<PageSize, 'image'>, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] }

/** Page size and image placement in PDF points. Paper pages turn landscape for landscape images and keep a 36pt margin. */
export function pageLayout(size: PageSize, w: number, h: number) {
  if (size === 'image') {
    const s = 842 / Math.max(w, h) // longest side as long as A4's
    return { page: [w * s, h * s] as [number, number], x: 0, y: 0, width: w * s, height: h * s }
  }
  const [short, long] = PAGE[size]
  const [pw, ph] = w > h ? [long, short] : [short, long]
  const margin = 36
  const s = Math.min((pw - 2 * margin) / w, (ph - 2 * margin) / h)
  const [width, height] = [w * s, h * s]
  return { page: [pw, ph] as [number, number], x: (pw - width) / 2, y: (ph - height) / 2, width, height }
}

export async function imagesToPdf(files: InFile[], size: PageSize, progress: Progress = () => {}): Promise<TaskResult> {
  const out = await create()
  for (const [i, f] of files.entries()) {
    progress(i / files.length, `Adding ${f.name}`)
    const bitmap = await decodeImage(f.bytes, f.kind)
    // Re-encoding keeps orientation right and leaves every bit of the photo's metadata behind.
    const pixels = drawPixels(bitmap, null, '#fff')
    bitmap.close()
    const image = await out.embedJpg(await encodeJpeg(pixels, 90))
    const layout = pageLayout(size, pixels.width, pixels.height)
    pixels.data.fill(0)
    out.addPage(layout.page).drawImage(image, layout)
  }
  progress(0.95, 'Saving')
  const name = files.length === 1 ? `${stem(files[0]!.name)}.pdf` : `${stem(files[0]!.name)}-and-${files.length - 1}-more.pdf`
  return { files: [pdfFile(name, await save(out))] }
}

/* ---------- shrink ---------- */

const STRENGTH: Record<Strength, { quality: number; maxSide: number }> = {
  light: { quality: 82, maxSide: 3000 },
  balanced: { quality: 70, maxSide: 2000 },
  strong: { quality: 50, maxSide: 1400 },
}

const name = (n: string) => PDFName.of(n)

/** Baseline 8-bit RGB JPEG images we can safely re-encode. CMYK, grey, masks and inverted images are left alone. */
function isPlainRgbJpeg(doc: PDFDocument, o: PDFObject): o is PDFRawStream {
  if (!(o instanceof PDFRawStream)) return false
  const d = o.dict
  if (d.get(name('Subtype')) !== name('Image') || d.has(name('Decode')) || d.has(name('ImageMask'))) return false
  const filter = d.get(name('Filter'))
  const onlyDct = filter === name('DCTDecode') || (filter instanceof PDFArray && filter.size() === 1 && filter.get(0) === name('DCTDecode'))
  if (!onlyDct || d.get(name('BitsPerComponent'))?.toString() !== '8') return false
  const cs = d.lookup(name('ColorSpace'))
  if (cs === name('DeviceRGB')) return true
  if (cs instanceof PDFArray && cs.get(0) === name('ICCBased')) {
    const profile = doc.context.lookup(cs.get(1))
    return profile instanceof PDFStream && profile.dict.get(name('N'))?.toString() === '3'
  }
  return false
}

export async function compress(f: InFile, strength: Strength, progress: Progress = () => {}): Promise<TaskResult> {
  const doc = await open(f)
  const { quality, maxSide } = STRENGTH[strength]
  const images = doc.context.enumerateIndirectObjects().filter(([, o]) => isPlainRgbJpeg(doc, o)) as [PDFRef, PDFRawStream][]
  let changed = 0
  for (const [i, [ref, stream]] of images.entries()) {
    progress(0.05 + (0.85 * i) / images.length, `Shrinking image ${i + 1} of ${images.length}`)
    try {
      // PDF viewers ignore EXIF orientation inside embedded JPEGs, so decode without applying it.
      const bitmap = await createImageBitmap(new Blob([stream.contents as Uint8Array<ArrayBuffer>]), { imageOrientation: 'none' })
      const pixels = drawPixels(bitmap, maxSide)
      bitmap.close()
      const jpeg = new Uint8Array(await encodeJpeg(pixels, quality))
      if (jpeg.length < stream.contents.length * 0.9) {
        const dict = stream.dict.clone(doc.context)
        dict.set(name('Width'), PDFNumber.of(pixels.width))
        dict.set(name('Height'), PDFNumber.of(pixels.height))
        dict.set(name('Length'), PDFNumber.of(jpeg.length))
        doc.context.assign(ref, PDFRawStream.of(dict, jpeg))
        changed++
      }
      pixels.data.fill(0)
    } catch {
      // An image the browser can't decode stays exactly as it was.
    }
  }
  progress(0.95, 'Saving')
  const data = await save(doc)
  const what = images.length ? `It has ${images.length} ${images.length === 1 ? 'photo' : 'photos'} Switchlet can shrink.` : 'It has no photos Switchlet can shrink; text-only PDFs rarely get smaller.'
  if (data.byteLength >= f.bytes.length) return { files: [], note: `Switchlet couldn’t make this PDF smaller. ${what}` }
  const note = changed
    ? `Recompressed ${changed} of ${images.length} ${images.length === 1 ? 'photo' : 'photos'}.`
    : images.length
      ? 'The photos were already compact, so only the file’s structure was tidied.'
      : 'There were no photos to shrink, so only the file’s structure was tidied.'
  return { files: [pdfFile(`${stem(f.name)}-smaller.pdf`, data)], note }
}

/* ---------- remove hidden data ---------- */

const dateText = (d?: Date) =>
  d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(d) : undefined

const HIDDEN_KEYS: [string, string][] = [
  ['Metadata', 'XMP metadata'],
  ['PieceInfo', 'Private editing data from the app that made it'],
  ['Thumb', 'Page thumbnails'],
]

export async function scrubPdf(f: InFile): Promise<TaskResult> {
  const doc = await open(f)
  const found: Finding[] = []
  const add = (label: string, value: unknown) => {
    const text = typeof value === 'string' ? value.trim() : value instanceof Date ? dateText(value) : undefined
    if (text) found.push({ label, detail: text.slice(0, 120) })
  }
  add('Title', doc.getTitle())
  add('Author', doc.getAuthor())
  add('Subject', doc.getSubject())
  add('Keywords', doc.getKeywords())
  add('Made with', doc.getCreator())
  add('PDF software', doc.getProducer())
  add('Created', doc.getCreationDate())
  add('Last changed', doc.getModificationDate())

  const removed = new Set<string>()
  const ctx = doc.context
  if (ctx.trailerInfo.Info) { ctx.trailerInfo.Info = undefined; removed.add('Document details (title, author, dates, software)') }
  if (ctx.trailerInfo.ID) { ctx.trailerInfo.ID = undefined; removed.add('Document ID, which can link copies of a file') }
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const dict = o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : null
    for (const [key, label] of HIDDEN_KEYS) if (dict?.has(name(key))) { dict.delete(name(key)); removed.add(label) }
  }
  if (dropUnreachable(doc) > 0) removed.add('Leftovers from earlier edits')
  const data = await save(doc)
  return { files: [pdfFile(`${stem(f.name)}-clean.pdf`, data)], report: { found, removed: [...removed], kept: [] } }
}
