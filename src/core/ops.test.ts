import { describe, expect, it } from 'vitest'
import { defaultOp, fitWithin, formatTime, gifTimestamps, imageOutputName, makeStep, mediaSupport, opsFor, parseRanges, stem } from './ops'

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

describe('audio and video', () => {
  it('offers video tasks for videos and audio conversion for sound files', () => {
    expect(opsFor(['mp4'])).toEqual(['video.convert', 'video.trim', 'video.gif', 'media.audio'])
    expect(opsFor(['mp4', 'webm'])).toEqual(['video.convert', 'media.audio'])
    expect(opsFor(['mp3', 'wav'])).toEqual(['media.audio'])
    expect(defaultOp(['mov'])).toBe('video.convert')
    expect(defaultOp(['flac'])).toBe('media.audio')
    expect(makeStep('video.convert', 'webm')).toMatchObject({ settings: { container: 'webm', quality: 'keep' } })
    expect(makeStep('video.convert', 'mkv')).toMatchObject({ settings: { container: 'mp4' } })
  })

  it('works out which formats this browser can create', () => {
    const chromeLike = mediaSupport({ video: ['avc', 'vp9'], audio: ['aac', 'opus'] })
    expect(chromeLike).toEqual({ video: { mp4: true, mov: true, webm: true }, audio: { m4a: true, ogg: true, wav: true } })
    const noAac = mediaSupport({ video: ['vp8'], audio: ['opus'] })
    expect(noAac.video).toEqual({ mp4: false, mov: false, webm: true })
    expect(noAac.audio.m4a).toBe(false)
    expect(mediaSupport({ video: [], audio: [] }).audio.wav).toBe(true)
  })

  it('formats times and plans GIF frames', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(65.5)).toBe('1:05.5')
    expect(gifTimestamps(1, 2, 4)).toEqual([1, 1.25, 1.5, 1.75])
    expect(gifTimestamps(0, 120, 10)).toHaveLength(300) // capped at 30 seconds
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
