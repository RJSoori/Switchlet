// Runs the real media operations in Node where no codec work is needed (repackaging, copying audio),
// on a 2-second H.264 + AAC clip made with Mediabunny + WebCodecs in a browser (test/fixtures/clip.mp4).
// Its tags: title "Secret trip", comment, recording date, and GPS location in a raw ©xyz atom.
import {
  ALL_FORMATS, BufferSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MkvOutputFormat, Mp4OutputFormat, Output,
} from 'mediabunny'
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

/** Re-mux the fixture's real packets into a new file, with extras the converter must not carry over. */
async function remux(format: 'mp4' | 'mkv', opts: { trackName?: string; flacComment?: string }): Promise<File> {
  const src = open(clipBytes.buffer.slice(0) as ArrayBuffer)
  const video = (await src.getPrimaryVideoTrack())!
  const out = new Output({ format: format === 'mp4' ? new Mp4OutputFormat() : new MkvOutputFormat(), target: new BufferTarget() })
  const vs = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(vs, { name: opts.trackName })
  const as = new EncodedAudioPacketSource(opts.flacComment ? 'flac' : 'aac')
  out.addAudioTrack(as, { name: opts.trackName })
  await out.start()
  let first = true
  for await (const p of new EncodedPacketSink(video).packets()) {
    await vs.add(p, first ? { decoderConfig: await video.getDecoderConfig() ?? undefined } : undefined)
    first = false
  }
  if (opts.flacComment) {
    await as.add(new EncodedPacket(new Uint8Array(64), 'key', 0, 0.1), {
      decoderConfig: { codec: 'flac', sampleRate: 48000, numberOfChannels: 2, description: flacHeader(opts.flacComment) },
    })
  } else {
    const audio = (await src.getPrimaryAudioTrack())!
    first = true
    for await (const p of new EncodedPacketSink(audio).packets()) {
      await as.add(p, first ? { decoderConfig: await audio.getDecoderConfig() ?? undefined } : undefined)
      first = false
    }
  }
  await out.finalize()
  return new File([(out.target as BufferTarget).buffer!], `clip.${format}`)
}

/** "fLaC" + STREAMINFO (48 kHz, stereo, 16-bit) + a VORBIS_COMMENT block holding one comment. */
function flacHeader(comment: string): Uint8Array {
  const text = new TextEncoder()
  const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
  const streaminfo = [0x10, 0x00, 0x10, 0x00, 0, 0, 0, 0, 0, 0, 0x0b, 0xb8, 0x02, 0xf0, 0, 0, 0, 0, ...new Array(16).fill(0)]
  const vendor = text.encode('test')
  const c = text.encode(comment)
  const body = [...le32(vendor.length), ...vendor, ...le32(1), ...le32(c.length), ...c]
  return new Uint8Array([...text.encode('fLaC'), 0x00, 0, 0, 34, ...streaminfo, 0x84, 0, (body.length >> 8) & 255, body.length & 255, ...body])
}

describe('metadata hidden outside the tags', () => {
  it('reports and removes track titles, which Mediabunny would otherwise copy', async () => {
    const r = await convertVideo(await remux('mp4', { trackName: 'Interview with Jane Doe' }), { container: 'mov', maxHeight: null, quality: 'keep' }, noProgress)
    expect(r.report!.found).toContainEqual({ label: 'Track title', detail: 'Interview with Jane Doe' })
    const out = open(r.files[0]!.data)
    for (const t of await out.getTracks()) expect(await t.getName()).toBeNull()
    expect(new TextDecoder('latin1').decode(r.files[0]!.data)).not.toContain('Jane Doe')
  })

  it('never copies FLAC audio as-is, because its setup data carries its own tags', async () => {
    const mkv = await remux('mkv', { flacComment: 'TITLE=Secret song by Jane' })
    expect(new TextDecoder('latin1').decode(await mkv.arrayBuffer())).toContain('Secret song') // precondition
    for (const r of [
      await convertVideo(mkv, { container: 'mp4', maxHeight: null, quality: 'keep' }, noProgress),
      await trimVideo(mkv, 'mkv', { start: 0, end: 1 }, noProgress),
    ]) {
      expect(new TextDecoder('latin1').decode(r.files[0]!.data)).not.toContain('Secret song')
    }
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
