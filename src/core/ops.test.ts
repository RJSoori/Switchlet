import { describe, expect, it } from 'vitest'
import { defaultOp, fitWithin, imageOutputName, makeStep, opsFor, parseRanges, stem } from './ops'

describe('fitWithin', () => {
  it('scales the longest side down, keeping the aspect ratio', () => {
    expect(fitWithin(4032, 3024, 1080)).toEqual({ width: 1080, height: 810 })
    expect(fitWithin(3024, 4032, 1080)).toEqual({ width: 810, height: 1080 })
  })
  it('never upscales, and never rounds a side to zero', () => {
    expect(fitWithin(800, 600, 1080)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(800, 600, null)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(10_000, 1, 100)).toEqual({ width: 100, height: 1 })
  })
})

describe('op registry', () => {
  it('offers only tasks that fit every dropped file', () => {
    expect(opsFor(['jpeg'])).toEqual(['image.convert', 'image.scrub', 'image.toPdf'])
    expect(opsFor(['heic', 'jpeg'])).toEqual(['image.convert', 'image.toPdf'])
    expect(opsFor(['pdf'])).toEqual(['pdf.pages', 'pdf.split', 'pdf.toImages', 'pdf.compress', 'pdf.scrub'])
    expect(opsFor(['pdf', 'pdf'])).toEqual(['pdf.merge', 'pdf.split', 'pdf.toImages', 'pdf.compress', 'pdf.scrub'])
    expect(opsFor(['pdf', 'jpeg'])).toEqual([])
    expect(opsFor(['markdown', 'html'])).toEqual(['doc.convert'])
    expect(opsFor(['zip'])).toEqual([])
  })
  it('preselects a task only when one is obvious', () => {
    expect(defaultOp(['heic'])).toBe('image.convert')
    expect(defaultOp(['pdf'])).toBeNull()
    expect(defaultOp(['pdf', 'pdf'])).toBe('pdf.merge')
    expect(defaultOp(['csv'])).toBe('sheet.convert')
    expect(defaultOp(['markdown'])).toBe('doc.convert')
  })
  it('builds sensible default steps', () => {
    expect(makeStep('image.convert', 'heic')).toEqual({ op: 'image.convert', settings: { format: 'jpeg', quality: 80, maxSide: null } })
    expect(makeStep('image.convert', 'webp')).toMatchObject({ settings: { format: 'webp' } })
    expect(makeStep('sheet.convert', 'xlsx')).toEqual({ op: 'sheet.convert', settings: { to: 'csv', sheet: null } })
    expect(makeStep('sheet.convert', 'csv')).toMatchObject({ settings: { to: 'xlsx' } })
    expect(makeStep('pdf.merge', 'pdf')).toEqual({ op: 'pdf.merge' })
  })
  it('names image outputs after the input', () => {
    const toWebp = { op: 'image.convert', settings: { format: 'webp', quality: 80, maxSide: null } } as const
    expect(imageOutputName('IMG_0001.HEIC', 'heic', toWebp)).toBe('IMG_0001.webp')
    expect(imageOutputName('my.photo.jpeg', 'jpeg', { op: 'image.scrub' })).toBe('my.photo-clean.jpg')
    expect(stem('.hidden')).toBe('.hidden')
    expect(stem('report.final.pdf')).toBe('report.final')
  })
})

describe('parseRanges', () => {
  it('splits every page when empty', () => {
    expect(parseRanges('', 3)).toEqual([[0], [1], [2]])
  })
  it('understands single pages, ranges and open-ended ranges', () => {
    expect(parseRanges('1-3, 5, 7-', 8)).toEqual([[0, 1, 2], [4], [6, 7]])
    expect(parseRanges(' -2 ,4', 5)).toEqual([[0, 1], [3]])
  })
  it('explains mistakes instead of guessing', () => {
    expect(parseRanges('2-9', 5)).toMatch(/pages 1 to 5/)
    expect(parseRanges('0', 5)).toMatch(/out of range/)
    expect(parseRanges('4-2', 5)).toMatch(/low to high, like 2-4/)
    expect(parseRanges('two', 5)).toMatch(/isn’t a page or range/)
    expect(parseRanges('-', 5)).toMatch(/isn’t a page or range/)
  })
})
