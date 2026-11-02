// Audio and video with Mediabunny on top of the browser's WebCodecs. Runs inside the worker.
// Inputs are read lazily from disk (BlobSource), so long recordings are never loaded into memory whole.
// Every output is written with no metadata tags: phone videos carry location and device details there.
import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import {
  ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, Conversion, Input, MovOutputFormat, Mp4OutputFormat, OggOutputFormat,
  Output, Quality, WavOutputFormat, WebMOutputFormat, getEncodableAudioCodecs, getEncodableVideoCodecs,
  type DiscardedTrack, type InputAudioTrack, type MetadataTags, type OutputFormat,
} from 'mediabunny'
import type { Kind } from '../core/detect'
import {
  MAX_GIF_SECONDS, formatTime, gifTimestamps, stem,
  type AudioFormat, type Clip, type Finding, type MediaCaps, type MetadataReport, type OutFile, type TaskResult, type VideoContainer, type VideoSettings,
} from '../core/ops'
import { DecodeError, NoticeError } from './errors'

export type Progress = (fraction: number, stage: string) => void

export async function capabilities(): Promise<MediaCaps> {
  const [video, audio] = await Promise.all([getEncodableVideoCodecs(), getEncodableAudioCodecs()])
  return { video, audio }
}

/** No tags at all, and no "created at" stamp of the conversion time either. */
const NO_TAGS: MetadataTags = { creationTime: null }

const VIDEO: Record<VideoContainer, { format: () => OutputFormat; type: string }> = {
  mp4: { format: () => new Mp4OutputFormat(), type: 'video/mp4' },
  webm: { format: () => new WebMOutputFormat(), type: 'video/webm' },
  mov: { format: () => new MovOutputFormat(), type: 'video/quicktime' },
}
const AUDIO: Record<AudioFormat, { format: () => OutputFormat; codec: 'aac' | 'opus' | 'pcm-s16'; type: string }> = {
  m4a: { format: () => new Mp4OutputFormat(), codec: 'aac', type: 'audio/mp4' },
  ogg: { format: () => new OggOutputFormat(), codec: 'opus', type: 'audio/ogg' },
  wav: { format: () => new WavOutputFormat(), codec: 'pcm-s16', type: 'audio/wav' },
}

const CODEC_NAME: Record<string, string> = {
  avc: 'H.264', hevc: 'HEVC (H.265)', vp8: 'VP8', vp9: 'VP9', av1: 'AV1',
  aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus',
}
const codecName = (c: string | null) => (c && CODEC_NAME[c]) ?? (c?.startsWith('pcm') ? 'uncompressed audio' : (c ?? 'unknown'))

/* ---------- metadata report ---------- */

/** "+51.5007-000.1246+015.000/" (ISO 6709, as phones store it) → "51.5007, -0.1246". */
export function parseIso6709(text: string): string | undefined {
  const m = text.match(/([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/)
  return m ? `${Number(m[1]).toFixed(4)}, ${Number(m[2]).toFixed(4)}` : undefined
}

const rawText = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : v instanceof Uint8Array ? new TextDecoder('latin1').decode(v).replace(/[^\x20-\x7e]/g, '') : undefined

/** Plain-English list of the tags a recording carries (all of them are left out of the output). */
export function describeTags(tags: MetadataTags): Finding[] {
  const found = new Map<string, string>()
  const add = (label: string, value?: string | null) => {
    const v = value?.trim()
    if (v && !found.has(label)) found.set(label, v.slice(0, 120))
  }
  add('Title', tags.title)
  add('Artist', tags.artist)
  add('Album', tags.album)
  add('Description', tags.description)
  add('Comment', tags.comment)
  const date = tags.date ?? tags.creationTime
  if (date instanceof Date && !Number.isNaN(date.getTime())) add('Recorded', new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(date))
  const device: string[] = []
  for (const [key, value] of Object.entries(tags.raw ?? {})) {
    const k = key.toLowerCase()
    const text = rawText(value)
    if (k.includes('xyz') || k.includes('location')) add('Location', (text && parseIso6709(text)) ?? 'stored in the file')
    else if (/(©mak|©mod|\.make$|\.model$)/.test(k) && text) device.push(text)
    else if (/(©swr|©too|\.software$|encoder)/.test(k)) add('Software', text)
  }
  if (device.length) add('Device', [...new Set(device)].join(' '))
  if (tags.images?.length) add('Cover art', `${tags.images.length} ${tags.images.length === 1 ? 'image' : 'images'}`)
  return [...found].map(([label, detail]) => ({ label, detail }))
}

/** Describes the input's tags and track titles, then blanks the titles (Mediabunny copies them, with no option to stop it). */
async function tagReport(input: Input): Promise<MetadataReport> {
  let found: Finding[] = []
  try {
    found = describeTags(await input.getMetadataTags())
  } catch {
    // Unreadable tags aren't copied either; nothing to describe.
  }
  for (const track of await input.getTracks()) {
    const name = (await track.getName())?.trim()
    if (name) found.push({ label: 'Track title', detail: name.slice(0, 120) })
    track.getName = async () => null
  }
  return { found, removed: found.length ? ['All metadata tags (titles, dates, location, device details)'] : [], kept: [] }
}

/**
 * FLAC and Vorbis keep their own tags (and cover art) inside the codec setup data, which a straight copy
 * carries into the new file. Always re-encode them; other audio is copied when nothing else needs to change.
 */
const TAGGED_AUDIO = new Set(['flac', 'vorbis'])
const audioOptions = (quality?: Quality) => (track: InputAudioTrack) => ({ quality, forceTranscode: TAGGED_AUDIO.has(track.codec ?? '') || undefined })

/* ---------- running a conversion ---------- */

function openInput(file: Blob): Input {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
}

function explain(discarded: DiscardedTrack[]): NoticeError {
  for (const { track, reason } of discarded) {
    const what = track.type === 'video' ? 'video' : track.type === 'audio' ? 'audio' : 'track'
    if (reason === 'undecodable_source_codec') {
      return new NoticeError(`This browser can’t read the ${codecName(track.codec)} ${what} in this file. Try Chrome, Edge or Safari, which support more formats.`)
    }
    if (reason === 'no_encodable_target_codec') return new NoticeError(`This browser can’t create ${what} in that format. Choose another format.`)
    if (reason === 'unknown_source_codec') return new NoticeError(`This file’s ${what} uses a format Switchlet doesn’t recognise.`)
  }
  return new NoticeError('This recording couldn’t be converted with these settings.')
}

const lostTracks = (c: Conversion) => c.discardedTracks.filter((d) => d.reason !== 'discarded_by_user')

/** A "video" without its picture is a failure, not a result: say why instead of returning the sound alone. */
function requireVideo(c: Conversion): void {
  const lost = lostTracks(c).filter((d) => d.track.type === 'video')
  if (lost.length) throw explain(lost)
}

/** What else was left out, in plain words (the sound, extra tracks, subtitles). */
function droppedNote(c: Conversion): string {
  const notes = new Set<string>()
  for (const { track, reason } of lostTracks(c)) {
    if (track.type === 'audio') {
      notes.add(reason === 'undecodable_source_codec'
        ? ` The sound wasn’t kept: this browser can’t read its ${codecName(track.codec)} audio.`
        : reason === 'no_encodable_target_codec' ? ' The sound wasn’t kept: this browser can’t create audio for that format.' : ' Some audio tracks weren’t kept.')
    } else if (track.type === 'subtitle') notes.add(' Subtitles weren’t kept.')
    else notes.add(' Extra tracks weren’t kept.')
  }
  return [...notes].join('')
}

async function openOrFail(file: Blob): Promise<Input> {
  const input = openInput(file)
  try {
    await input.getFormat()
  } catch {
    throw new DecodeError('This file couldn’t be read as audio or video.')
  }
  return input
}

async function execute(conversion: Conversion, progress: Progress, stage: string): Promise<void> {
  if (!conversion.isValid) throw explain(conversion.discardedTracks)
  let last = -1
  conversion.onProgress = (p) => {
    if (p - last >= 0.01 || p >= 1) { last = p; progress(Math.min(0.98, p), stage) }
  }
  await conversion.execute()
}

const resultBuffer = (output: Output) => (output.target as BufferTarget).buffer!

const NO_VIDEO = new NoticeError('This file has no video, only sound. To convert it, choose “Save the audio”.')

/** "clip.mp4" → "clip.mp4" unless that's the input's own name, then "clip-converted.mp4". */
function outName(input: string, ext: string, suffix = ''): string {
  const name = `${stem(input)}${suffix}.${ext}`
  return name.toLowerCase() === input.toLowerCase() ? `${stem(input)}-converted.${ext}` : name
}

/* ---------- tasks ---------- */

export async function convertVideo(file: File, s: VideoSettings, progress: Progress): Promise<TaskResult> {
  const input = await openOrFail(file)
  const report = await tagReport(input)
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw NO_VIDEO
  const resize = s.maxHeight && track.displayHeight > s.maxHeight ? s.maxHeight : undefined // never upscale
  const quality = s.quality === 'keep' ? undefined : new Quality(s.quality)
  const output = new Output({ format: VIDEO[s.container].format(), target: new BufferTarget() })
  const conversion = await Conversion.init({
    input, output, tags: NO_TAGS,
    video: { height: resize, quality, forceTranscode: s.quality !== 'keep' || undefined },
    audio: audioOptions(quality),
  })
  requireVideo(conversion)
  await execute(conversion, progress, s.quality === 'keep' && !resize ? 'Repackaging' : 'Converting')
  const file_: OutFile = { name: outName(file.name, s.container), data: resultBuffer(output), type: VIDEO[s.container].type }
  return { files: [file_], report, note: (resize ? `Resized to ${resize}p.` : '') + droppedNote(conversion) || undefined }
}

const containerFor = (kind: Kind): VideoContainer => (kind === 'webm' ? 'webm' : kind === 'mov' ? 'mov' : 'mp4')

async function span(input: Input, clip: Clip): Promise<{ start: number; end: number; duration: number }> {
  const duration = await input.computeDuration()
  const start = Math.max(0, clip.start)
  const end = Math.min(duration, clip.end ?? duration)
  if (start >= duration) throw new NoticeError(`The start (${formatTime(start)}) is after the end of the recording (${formatTime(duration)}).`)
  if (end <= start) throw new NoticeError('The end has to be after the start.')
  return { start, end, duration }
}

export async function trimVideo(file: File, kind: Kind, clip: Clip, progress: Progress): Promise<TaskResult> {
  const input = await openOrFail(file)
  const report = await tagReport(input)
  if (!(await input.getPrimaryVideoTrack())) throw NO_VIDEO
  const { start, end, duration } = await span(input, clip)
  const container = containerFor(kind)
  const output = new Output({ format: VIDEO[container].format(), target: new BufferTarget() })
  const conversion = await Conversion.init({ input, output, tags: NO_TAGS, trim: { start, end }, audio: audioOptions() })
  requireVideo(conversion)
  await execute(conversion, progress, 'Trimming')
  return {
    files: [{ name: `${stem(file.name)}-trimmed.${container}`, data: resultBuffer(output), type: VIDEO[container].type }],
    report,
    note: `${formatTime(end - start)} long, from ${formatTime(start)} to ${formatTime(end)} of ${formatTime(duration)}.${droppedNote(conversion)}`,
  }
}

export async function extractAudio(file: File, format: AudioFormat, progress: Progress): Promise<TaskResult> {
  const input = await openOrFail(file)
  if (!(await input.getPrimaryAudioTrack())) throw new NoticeError('This file has no sound to save.')
  const report = await tagReport(input)
  const { format: make, codec, type } = AUDIO[format]
  const output = new Output({ format: make(), target: new BufferTarget() })
  const conversion = await Conversion.init({ input, output, tags: NO_TAGS, tracks: 'primary', video: { discard: true }, audio: { codec } })
  await execute(conversion, progress, 'Saving the audio')
  return { files: [{ name: outName(file.name, format), data: resultBuffer(output), type }], report }
}

export async function makeGif(file: File, s: Clip & { fps: number; width: number }, progress: Progress): Promise<TaskResult> {
  const input = await openOrFail(file)
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new NoticeError('This file has no video to turn into a GIF.')
  if (!(await track.canDecode())) {
    throw new NoticeError(`This browser can’t read the ${codecName(track.codec)} video in this file. Try Chrome, Edge or Safari, which support more formats.`)
  }
  const { start, end } = await span(input, s)
  const times = gifTimestamps(start, end, s.fps)
  const sink = new CanvasSink(track, { width: Math.min(s.width, track.displayWidth), poolSize: 1 })
  const gif = GIFEncoder()
  const delay = Math.round(1000 / s.fps)
  let n = 0
  for await (const frame of sink.canvasesAtTimestamps(times)) {
    n++
    if (!frame) continue
    const canvas = frame.canvas as OffscreenCanvas
    const { data } = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height)
    const palette = quantize(data, 256)
    gif.writeFrame(applyPalette(data, palette), canvas.width, canvas.height, { palette, delay })
    progress(Math.min(0.98, n / times.length), `Frame ${n} of ${times.length}`)
  }
  gif.finish()
  const bytes = gif.bytes()
  const capped = end - start > MAX_GIF_SECONDS ? ` GIFs are limited to ${MAX_GIF_SECONDS} seconds, so it stops at ${formatTime(start + MAX_GIF_SECONDS)}.` : ''
  return {
    files: [{ name: `${stem(file.name)}.gif`, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type: 'image/gif' }],
    note: `${times.length} frames at ${s.fps} frames per second.${capped}`,
  }
}
