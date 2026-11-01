// Image convert / resize / compress. Runs inside the worker.
// Decode and resize use the browser's own (sandboxed, hardware-accelerated) decoders;
// encoding uses jSquash so output quality is identical in every browser.
import { LIMITS, type Kind } from '../core/detect'
import { FORMAT_LABEL, fitWithin, type ImageSettings } from '../core/ops'
import { DecodeError, describeMetadata, type MetadataReport } from './scrub'

export type Progress = (fraction: number, stage: string) => void

async function decode(input: Uint8Array<ArrayBuffer>, kind: Kind): Promise<ImageBitmap> {
  try {
    // Applies EXIF orientation to the pixels by default, so dropping metadata never leaves a photo sideways.
    // ponytail: animated GIF/WebP become a still of the first frame.
    return await createImageBitmap(new Blob([input]))
  } catch {
    if (kind !== 'heic') throw new DecodeError('This image couldn’t be read. The file may be damaged, or it isn’t really the type its name suggests.')
  }
  const { decodeHeic } = await import('./heic')
  return createImageBitmap(await decodeHeic(input))
}

async function encode(pixels: ImageData, s: ImageSettings): Promise<ArrayBuffer> {
  const quality = Math.min(100, Math.max(1, Math.round(s.quality)))
  switch (s.format) {
    case 'jpeg': return (await import('@jsquash/jpeg/encode.js')).default(pixels, { quality })
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
  progress(0.05, 'Reading image')
  const bitmap = await decode(input, kind)
  if (bitmap.width * bitmap.height > LIMITS.pixels) {
    bitmap.close()
    throw new DecodeError(`This image is ${bitmap.width} × ${bitmap.height} pixels, over the 100-megapixel limit a browser tab can safely handle.`)
  }
  const preview = kind === 'heic' ? await createImageBitmap(bitmap, { ...resizeTo(bitmap, 2048), resizeQuality: 'high' }) : undefined

  progress(0.25, 'Resizing')
  const { width, height } = fitWithin(bitmap.width, bitmap.height, s.maxSide)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas unavailable')
  if (s.format === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height) } // JPG has no transparency
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const pixels = ctx.getImageData(0, 0, width, height)

  progress(0.35, `Encoding ${FORMAT_LABEL[s.format]}`)
  const data = await encode(pixels, s)
  pixels.data.fill(0)
  progress(1, 'Done')

  const kept = orientation && orientation !== 1 ? ['Orientation, applied to the pixels'] : []
  const removed = found.length ? ['All metadata: only the pixels were re-encoded'] : []
  return { data, width, height, report: { found, removed, kept }, preview }
}

function resizeTo(b: ImageBitmap, maxSide: number) {
  const { width, height } = fitWithin(b.width, b.height, maxSide)
  return { resizeWidth: width, resizeHeight: height }
}
