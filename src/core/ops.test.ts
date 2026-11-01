import { describe, expect, it } from 'vitest'
import { defaultStep, fitWithin, opsFor, outputMime, outputName } from './ops'

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

describe('ops registry', () => {
  it('offers lossless scrub only where pixels can stay untouched', () => {
    expect(opsFor('jpeg')).toEqual(['image.convert', 'image.scrub'])
    expect(opsFor('heic')).toEqual(['image.convert'])
    expect(opsFor('pdf')).toEqual([])
  })
  it('turns HEIC and GIF into JPG by default, keeps web formats', () => {
    expect(defaultStep('heic')).toEqual({ op: 'image.convert', settings: { format: 'jpeg', quality: 80, maxSide: null } })
    expect(defaultStep('gif')?.op).toBe('image.convert')
    expect(defaultStep('webp')).toMatchObject({ settings: { format: 'webp' } })
    expect(defaultStep('csv')).toBeNull()
  })
  it('names outputs after the input', () => {
    const toWebp = { op: 'image.convert', settings: { format: 'webp', quality: 80, maxSide: null } } as const
    expect(outputName('IMG_0001.HEIC', 'heic', toWebp)).toBe('IMG_0001.webp')
    expect(outputName('my.photo.jpeg', 'jpeg', { op: 'image.scrub' })).toBe('my.photo-clean.jpg')
    expect(outputName('.hidden', 'png', toWebp)).toBe('.hidden.webp')
    expect(outputMime('png', { op: 'image.scrub' })).toBe('image/png')
    expect(outputMime('heic', toWebp)).toBe('image/webp')
  })
})
