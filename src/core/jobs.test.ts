import { describe, expect, it } from 'vitest'
import { etaSeconds, friendlyError, JobError, runPool } from './jobs'

describe('friendlyError', () => {
  it('maps worker errors to actionable messages', () => {
    const damaged = Object.assign(new Error('This PNG file is damaged or incomplete.'), { name: 'DecodeError' })
    expect(friendlyError(damaged)).toMatchObject({ kind: 'damaged', message: expect.stringMatching(/damaged.*fresh copy/) })
    expect(friendlyError(new RangeError('Array buffer allocation failed')).kind).toBe('memory')
    expect(friendlyError(new Error('RuntimeError: unreachable')).kind).toBe('crash')
    expect(friendlyError(Object.assign(new Error('“a.pdf” is password-protected…'), { name: 'NoticeError' }))).toMatchObject({ kind: 'notice', message: '“a.pdf” is password-protected…' })
    expect(friendlyError(new TypeError('Failed to fetch dynamically imported module: /assets/pdf-x.js'))).toMatchObject({ kind: 'notice', message: expect.stringMatching(/updated.*Reload/) })
    expect(friendlyError(new Error('This specific encoder configuration (mp4a.40.2, 64000 bps) is not supported in this environment.'))).toMatchObject({ kind: 'notice', message: expect.stringMatching(/WAV always works/) })
    const cancelled = new JobError('cancelled', 'Cancelled')
    expect(friendlyError(cancelled)).toBe(cancelled)
  })
})

describe('etaSeconds', () => {
  it('stays silent until there is enough signal, then extrapolates', () => {
    expect(etaSeconds(0, 0.5, 500)).toBeNull() // under a second elapsed
    expect(etaSeconds(0, 0.02, 10_000)).toBeNull() // too little progress
    expect(etaSeconds(0, 0.25, 4_000)).toBe(12)
    expect(etaSeconds(0, 1, 4_000)).toBeNull()
  })
})

describe('runPool', () => {
  it('never runs more than the limit at once and finishes every item', async () => {
    let active = 0, peak = 0
    const done: number[] = []
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 5))
      done.push(n)
      active--
    })
    expect(peak).toBe(3)
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})
