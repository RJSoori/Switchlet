import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib'
import { describe, expect, it } from 'vitest'
import { NoticeError } from './errors'
import type { InFile } from '../core/ops'
import { compress, merge, pageLayout, reorder, scrubPdf, split } from './pdf'

/** A PDF whose page i is (100 + i) points wide, so page order can be read back from widths. */
async function makePdf(pages: number, edit?: (doc: PDFDocument) => void, compact = false): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create({ updateMetadata: !compact })
  for (let i = 0; i < pages; i++) doc.addPage([100 + i, 200])
  edit?.(doc)
  return new Uint8Array(await doc.save({ useObjectStreams: compact }))
}
const file = (bytes: Uint8Array<ArrayBuffer>, name = 'report.pdf'): InFile => ({ name, kind: 'pdf', bytes })
const widths = async (data: ArrayBuffer) => (await PDFDocument.load(data)).getPages().map((p) => p.getWidth())
const text = (data: ArrayBuffer | Uint8Array) => new TextDecoder('latin1').decode(data)

describe('merge, split, reorder', () => {
  it('merges PDFs in the order given', async () => {
    const r = await merge([file(await makePdf(2), 'a.pdf'), file(await makePdf(3), 'b.pdf')])
    expect(r.files[0]!.name).toBe('a-merged.pdf')
    expect(await widths(r.files[0]!.data)).toEqual([100, 101, 100, 101, 102])
    expect(r.note).toMatch(/5 pages from 2 PDFs/)
  })

  it('splits by ranges, or into single pages when no range is given', async () => {
    const pdf = file(await makePdf(4))
    const parts = await split(pdf, '1-2, 4')
    expect(parts.files.map((f) => f.name)).toEqual(['report-pages-1-2.pdf', 'report-page-4.pdf'])
    expect(await widths(parts.files[0]!.data)).toEqual([100, 101])
    expect((await split(pdf, '')).files).toHaveLength(4)
    await expect(split(pdf, '9')).rejects.toThrow(NoticeError)
  })

  it('reorders and removes pages', async () => {
    const r = await reorder(file(await makePdf(3)), [2, 0])
    expect(await widths(r.files[0]!.data)).toEqual([102, 100])
    expect(r.note).toBe('2 pages, 1 removed.')
    await expect(reorder(file(await makePdf(3)), [])).rejects.toThrow(/at least one page/)
    await expect(reorder(file(await makePdf(3)), [7])).rejects.toThrow(NoticeError)
  })
})

describe('remove hidden data', () => {
  it('reports and removes document details, XMP, the document ID and orphaned leftovers', async () => {
    const bytes = await makePdf(1, (doc) => {
      doc.setTitle('Quarterly plan')
      doc.setAuthor('Jane Doe')
      doc.setCreator('Word')
      const xmp = doc.context.stream('<x:xmpmeta>secret-xmp</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })
      doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp))
      doc.context.register(PDFString.of('leftover-from-old-revision'))
    })
    expect(text(bytes)).toContain('secret-xmp') // preconditions: the leftovers really are in the input
    expect(text(bytes)).toContain('leftover-from-old-revision')

    const r = await scrubPdf(file(bytes))
    expect(r.report!.found).toEqual(expect.arrayContaining([
      { label: 'Title', detail: 'Quarterly plan' },
      { label: 'Author', detail: 'Jane Doe' },
      { label: 'Made with', detail: 'Word' },
    ]))
    expect(r.report!.removed).toEqual(expect.arrayContaining(['Document details (title, author, dates, software)', 'XMP metadata', 'Leftovers from earlier edits']))

    const out = r.files[0]!.data
    expect(text(out)).not.toContain('secret-xmp')
    expect(text(out)).not.toContain('leftover-from-old-revision')
    const again = await PDFDocument.load(out, { updateMetadata: false })
    expect(again.getAuthor()).toBeUndefined()
    expect(again.getTitle()).toBeUndefined()
    expect(again.getProducer()).toBeUndefined() // pdf-lib didn't stamp itself either
    expect(again.getPageCount()).toBe(1)
  })
})

describe('honest reporting', () => {
  it('does not claim leftovers when only the removed XMP was orphaned', async () => {
    const bytes = await makePdf(1, (doc) => {
      const xmp = doc.context.stream('<x:xmpmeta/>', { Type: 'Metadata', Subtype: 'XML' })
      doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp))
    })
    const r = await scrubPdf(file(bytes))
    expect(r.report!.removed).toContain('XMP metadata')
    expect(r.report!.removed).not.toContain('Leftovers from earlier edits')
  })
})

describe('protected and odd files', () => {
  it('explains password-protected PDFs instead of failing obscurely', async () => {
    const locked = await makePdf(1, (doc) => doc.encrypt({ userPassword: 'pw', ownerPassword: 'owner' }))
    await expect(merge([file(locked, 'locked.pdf'), file(locked)])).rejects.toThrow(/locked\.pdf” is password-protected/)
    await expect(scrubPdf(file(locked))).rejects.toThrow(NoticeError)
  })

  it('says so honestly when a compact PDF has nothing to shrink', async () => {
    const r = await compress(file(await makePdf(2, undefined, true)), 'balanced')
    expect(r.files).toEqual([])
    expect(r.note).toMatch(/couldn’t make this PDF smaller.*no photos/)
  })

  it('still offers a tidier copy of a loosely saved PDF, and says why it shrank', async () => {
    const r = await compress(file(await makePdf(2)), 'balanced')
    expect(r.files).toHaveLength(1)
    expect(r.note).toMatch(/no photos to shrink, so only the file’s structure was tidied/)
  })

  it('rejects garbage with a readable error', async () => {
    const junk = file(new Uint8Array(new TextEncoder().encode('%PDF-1.7 nonsense')), 'junk.pdf')
    await expect(merge([junk, file(await makePdf(1))])).rejects.toThrow(/“junk\.pdf” couldn’t be read as a PDF/)
  })
})

describe('pageLayout', () => {
  it('turns paper landscape for wide images and centres them inside a margin', () => {
    const l = pageLayout('a4', 2000, 1000)
    expect(l.page).toEqual([841.89, 595.28])
    expect(l.width).toBeCloseTo(769.89)
    expect(l.x).toBeCloseTo(36)
    expect(l.y).toBeCloseTo((595.28 - l.height) / 2)
  })
  it('sizes the page to the image when asked', () => {
    expect(pageLayout('image', 1000, 500)).toMatchObject({ page: [842, 421], x: 0, y: 0, width: 842, height: 421 })
  })
})
