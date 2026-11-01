// Runs the real media operations in Node where no codec work is needed (repackaging, copying audio),
// on a 2-second H.264 + AAC clip made with Mediabunny + WebCodecs in a browser (test/fixtures/clip.mp4).
// Its tags: title "Secret trip", comment, recording date, and GPS location in a raw ©xyz atom.
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny'
import { describe, expect, it } from 'vitest'
import clipDataUrl from '../../test/fixtures/clip.mp4?inline'
import { DecodeError, NoticeError } from './errors'
import { convertVideo, describeTags, extractAudio, parseIso6709, trimVideo } from './media'

const clipBytes = Uint8Array.from(atob(clipDataUrl.split(',')[1]!), (c) => c.charCodeAt(0))
const clip = () => new File([clipBytes], 'clip.mp4', { type: 'video/mp4' })
const open = (data: ArrayBuffer) => new Input({ formats: ALL_FORMATS, source: new BufferSource(data) })
const noProgress = () => {}

describe('metadata report', () => {
  it('reads location from ISO 6709 text, as phones store it', () => {
    expect(parseIso6709('+51.5007-000.1246+015.000/')).toBe('51.5007, -0.1246')
    expect(parseIso6709('\u0000\u0013\u0015Ç-33.8688+151.2093/')).toBe('-33.8688, 151.2093')
    expect(parseIso6709('no coordinates')).toBeUndefined()
  })

  it('describes titles, dates, device and location in plain English', () => {
    const found = describeTags({
      title: 'Holiday',
      creationTime: new Date('2024-06-01T18:42:07Z'),
      raw: {
        'com.apple.quicktime.make': 'Apple',
        'com.apple.quicktime.model': 'iPhone 15 Pro',
        'com.apple.quicktime.location.ISO6709': '+51.5007-000.1246+015.000/',
        '©xyz': new TextEncoder().encode('\u0000\u0012\u0015Ç+51.5007-000.1246/'),
      },
    })
    expect(found).toEqual(expect.arrayContaining([
      { label: 'Title', detail: 'Holiday' },
      { label: 'Device', detail: 'Apple iPhone 15 Pro' },
      { label: 'Location', detail: '51.5007, -0.1246' },
    ]))
    expect(found.filter((f) => f.label === 'Location')).toHaveLength(1)
    expect(found.find((f) => f.label === 'Recorded')?.detail).toMatch(/2024/)
  })

  it('finds the tags in a real recording', async () => {
    const found = describeTags(await open(clipBytes.buffer.slice(0) as ArrayBuffer).getMetadataTags())
    expect(found).toEqual(expect.arrayContaining([
      { label: 'Title', detail: 'Secret trip' },
      { label: 'Location', detail: '51.5007, -0.1246' },
      { label: 'Comment', detail: 'shot near home' },
    ]))
  })
})

describe('repackaging without re-encoding', () => {
  it('MP4 to MOV keeps both tracks and drops every tag', async () => {
    const r = await convertVideo(clip(), { container: 'mov', maxHeight: null, quality: 'keep' }, noProgress)
    expect(r.files[0]).toMatchObject({ name: 'clip.mov', type: 'video/quicktime' })
    expect(r.report!.found.map((f) => f.label)).toEqual(expect.arrayContaining(['Title', 'Location']))
    expect(r.report!.removed).toHaveLength(1)

    const out = open(r.files[0]!.data)
    expect(await out.getPrimaryVideoTrack()).not.toBeNull()
    expect(await out.getPrimaryAudioTrack()).not.toBeNull()
    expect(await out.computeDuration()).toBeCloseTo(2, 0)
    const tags = await out.getMetadataTags()
    expect(tags.title).toBeUndefined()
    expect(tags.comment).toBeUndefined()
    expect(describeTags(tags)).toEqual([])
    expect(new TextDecoder('latin1').decode(r.files[0]!.data)).not.toContain('51.5007')
  })

  it('saves the audio track alone, as M4A', async () => {
    const r = await extractAudio(clip(), 'm4a', noProgress)
    expect(r.files[0]).toMatchObject({ name: 'clip.m4a', type: 'audio/mp4' })
    const out = open(r.files[0]!.data)
    expect(await out.getPrimaryVideoTrack()).toBeNull()
    expect((await out.getPrimaryAudioTrack())?.codec).toBe('aac')
  })
})

describe('browsers without the right codecs', () => {
  // Node has no WebCodecs, like a browser that can't decode H.264: re-encoding is impossible here.
  it('fails clearly instead of returning a "video" with only sound', async () => {
    await expect(convertVideo(clip(), { container: 'webm', maxHeight: null, quality: 'keep' }, noProgress))
      .rejects.toThrow(/can’t read the H\.264 video in this file/)
  })

  it('still trims, by copying from the nearest keyframe instead of re-encoding', async () => {
    const r = await trimVideo(clip(), 'mp4', { start: 0.5, end: 1.5 }, noProgress)
    expect(r.files[0]!.name).toBe('clip-trimmed.mp4')
    expect(r.note).toBe('0:01 long, from 0:00.5 to 0:01.5 of 0:02.')
    const out = open(r.files[0]!.data)
    expect(await (await out.getPrimaryVideoTrack())!.computeDuration()).toBeCloseTo(1, 1)
    expect(await out.getPrimaryAudioTrack()).not.toBeNull()
    expect(describeTags(await out.getMetadataTags())).toEqual([])
  })
})

describe('mistakes and odd files', () => {
  it('explains impossible trim ranges before doing any work', async () => {
    await expect(trimVideo(clip(), 'mp4', { start: 5, end: null }, noProgress)).rejects.toThrow(/after the end of the recording \(0:02\)/)
    await expect(trimVideo(clip(), 'mp4', { start: 1.5, end: 1 }, noProgress)).rejects.toThrow(NoticeError)
  })

  it('rejects files that aren’t audio or video', async () => {
    const junk = new File([new TextEncoder().encode('not a video at all')], 'x.mp4')
    await expect(convertVideo(junk, { container: 'mp4', maxHeight: null, quality: 'keep' }, noProgress)).rejects.toThrow(DecodeError)
  })
})
