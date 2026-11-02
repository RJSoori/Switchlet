import { describe, expect, it } from 'vitest'
import { makeStep, type Step } from './ops'
import { MAX_LINK_LENGTH, cleanName, decodeRecipe, describeStep, encodeRecipe, overflow, validateStep } from './recipes'

const heicToJpg: Step = { op: 'image.convert', settings: { format: 'jpeg', quality: 80, maxSide: 1080 } }
const raw = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('recipe links', () => {
  it('round-trip a recipe, including non-ASCII names', () => {
    const encoded = encodeRecipe({ name: 'Fotos für Oma 📷', steps: [heicToJpg] })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/) // safe in a URL fragment
    expect(decodeRecipe(encoded)).toEqual({ name: 'Fotos für Oma 📷', steps: [heicToJpg] })
  })

  it('round-trips a default step of every recipe-able task', () => {
    for (const op of ['image.convert', 'image.scrub', 'image.toPdf', 'pdf.merge', 'pdf.split', 'pdf.toImages', 'pdf.compress', 'pdf.scrub',
      'doc.convert', 'sheet.convert', 'video.convert', 'video.trim', 'video.gif', 'media.audio'] as const) {
      const step = makeStep(op, op.startsWith('image') ? 'heic' : op.startsWith('pdf') ? 'pdf' : op === 'sheet.convert' ? 'csv' : 'mp4')
      expect(decodeRecipe(encodeRecipe({ name: op, steps: [step] })), op).toEqual({ name: op, steps: [step] })
    }
  })

  it('rejects broken, oversized and tampered links with a readable reason', () => {
    expect(decodeRecipe('not base64!')).toMatch(/broken/)
    expect(decodeRecipe('A'.repeat(MAX_LINK_LENGTH + 1))).toMatch(/too long/)
    expect(decodeRecipe(raw({ v: 1, name: 'x', steps: [{ op: 'image.convert', settings: { format: 'gif', quality: 80, maxSide: null } }] }))).toMatch(/doesn’t recognise/)
    expect(decodeRecipe(raw({ v: 1, name: 'x', steps: [{ op: '__proto__' }] }))).toMatch(/doesn’t recognise/)
    expect(decodeRecipe(raw({ v: 1, name: 'x', steps: [{ op: 'pdf.pages', settings: { order: [0] } }] }))).toMatch(/doesn’t recognise/)
    expect(decodeRecipe(raw({ v: 2, name: 'x', steps: [] }))).toMatch(/broken/)
    expect(decodeRecipe(raw({ v: 1, name: '', steps: [heicToJpg] }))).toMatch(/broken/)
    expect(decodeRecipe(raw({ v: 1, name: 'x', steps: [heicToJpg, heicToJpg] }))).toMatch(/newer version/)
  })

  it('drops unknown keys and file-specific values instead of passing them through', () => {
    const step = validateStep({ op: 'sheet.convert', settings: { to: 'csv', sheet: 'Salaries', evil: '<script>' }, extra: 1 })
    expect(step).toEqual({ op: 'sheet.convert', settings: { to: 'csv', sheet: null } })
    expect(validateStep({ op: 'image.convert', settings: { format: 'jpeg', quality: 80.6, maxSide: null, onload: 'x' } }))
      .toEqual({ op: 'image.convert', settings: { format: 'jpeg', quality: 81, maxSide: null } })
  })

  it('checks numbers and ranges', () => {
    expect(validateStep({ op: 'image.convert', settings: { format: 'jpeg', quality: 0, maxSide: null } })).toBeNull()
    expect(validateStep({ op: 'image.convert', settings: { format: 'jpeg', quality: 80, maxSide: 1e9 } })).toBeNull()
    expect(validateStep({ op: 'video.trim', settings: { start: 5, end: 2 } })).toBeNull()
    expect(validateStep({ op: 'video.trim', settings: { start: -1, end: null } })).toBeNull()
    expect(validateStep({ op: 'video.gif', settings: { start: 0, end: null, fps: 60, width: 480 } })).toBeNull()
    expect(validateStep({ op: 'pdf.split', settings: { ranges: '1-3; DROP TABLE' } })).toBeNull()
    expect(validateStep({ op: 'pdf.toImages', settings: { format: 'jpeg', dpi: 151 } })).toBeNull()
  })

  it('cleans names: no control or bidi-override characters, at most 80 characters', () => {
    expect(cleanName('  Holiday‮ gpj.exe \u0007 ')).toBe('Holiday gpj.exe')
    expect(cleanName('x'.repeat(200))).toHaveLength(80)
    expect(cleanName(42)).toBeNull()
  })
})

describe('descriptions', () => {
  it('describes steps in plain words', () => {
    expect(describeStep(heicToJpg)).toBe('Photos to JPG, 1080 px, quality 80')
    expect(describeStep({ op: 'video.trim', settings: { start: 0, end: 10 } })).toBe('Trim video, 0:00 to 0:10')
    expect(describeStep({ op: 'pdf.split', settings: { ranges: '' } })).toBe('Split PDF into single pages')
  })
})

describe('history', () => {
  it('keeps only the newest entries', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: i, at: 1000 + i }))
    expect(overflow(entries, 3).sort()).toEqual([0, 1])
    expect(overflow(entries, 10)).toEqual([])
  })
})
