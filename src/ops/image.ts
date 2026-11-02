// Image convert / resize / compress. Runs inside the worker.
// Decode and resize use the browser's own (sandboxed, hardware-accelerated) decoders;
// encoding uses jSquash so output quality is identical in every browser.
import type { Kind } from '../core/detect'
import { FORMAT_LABEL, fitWithin, type ImageSettings } from '../core/ops'
import { decodeImage, drawPixels, encodeJpeg } from './decode'
import { describeMetadata, hiddenParts, type MetadataReport } from './scrub'

export type Progress = (fraction: number, stage: string) => void

async function encode(pixels: ImageData, s: ImageSettings): Promise<ArrayBuffer> {
  const quality = Math.min(100, Math.max(1, Math.round(s.quality)))
  switch (s.format) {
    case 'jpeg': return encodeJpeg(pixels, quality)
    case 'webp': return (await import('@jsquash/webp/encode.js')).default(pixels, { quality })
    case 'avif': return (await import('@jsquash/avif/encode.js')).default(pixels, { quality, speed: 6 })
    case 'png': return (await import('@jsquash/oxipng/optimise.js')).default(pixels, { level: 2 })
  }
}

export interface ImageResult {
  data: ArrayBuffer
  width: number
  height: number
  report: MetadataReport
  /** Decoded original for formats the page can't display itself (HEIC). */
  preview?: ImageBitmap
}

export async function convertImage(input: Uint8Array<ArrayBuffer>, kind: Kind, s: ImageSettings, progress: Progress = () => {}): Promise<ImageResult> {
  const { found, orientation } = describeMetadata(input)
  const parts = hiddenParts(input, kind)
  progress(0.05, 'Reading image')
  const bitmap = await decodeImage(input, kind)
  const preview = kind === 'heic'
    ? await createImageBitmap(bitmap, { ...resizeTo(bitmap, 2048), resizeQuality: 'high' })
    : undefined

  progress(0.25, 'Resizing')
  const pixels = drawPixels(bitmap, s.maxSide, s.format === 'jpeg' ? '#fff' : undefined) // JPG has no transparency
  bitmap.close()

  progress(0.35, `Encoding ${FORMAT_LABEL[s.format]}`)
  const data = await encode(pixels, s)
  const { width, height } = pixels
  pixels.data.fill(0)
  progress(1, 'Done')

  const kept = orientation && orientation !== 1 ? ['Orientation, applied to the pixels'] : []
  const removed = parts.length ? parts : found.length ? ['all metadata (only the pixels are kept)'] : []
  return { data, width, height, report: { found, removed, kept }, preview }
}

function resizeTo(b: ImageBitmap, maxSide: number) {
  const { width, height } = fitWithin(b.width, b.height, maxSide)
  return { resizeWidth: width, resizeHeight: height }
}
