// Shared image decode / draw / JPEG encode for the worker. No metadata parsing here, so PDF tools
// can use it without loading ExifReader.
import { LIMITS, type Kind } from '../core/detect'
import { fitWithin } from '../core/ops'
import { DecodeError, NoticeError } from './errors'

/**
 * Decode with the browser's own decoder (falling back to libheif for HEIC).
 * Applies EXIF orientation by default, so dropping metadata never leaves a photo sideways.
 * ponytail: animated GIF/WebP become a still of the first frame.
 */
export async function decodeImage(input: Uint8Array<ArrayBuffer>, kind: Kind, options?: ImageBitmapOptions): Promise<ImageBitmap> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([input]), options)
  } catch {
    if (kind !== 'heic') throw new DecodeError('This image couldn’t be read. The file may be damaged, or it isn’t really the type its name suggests.')
    const { decodeHeic } = await import('./heic')
    bitmap = await createImageBitmap(await decodeHeic(input))
  }
  if (bitmap.width * bitmap.height > LIMITS.pixels) {
    bitmap.close()
    throw new NoticeError(`This image is ${bitmap.width} × ${bitmap.height} pixels, over the 100-megapixel limit a browser tab can safely handle. Make it smaller in another app, then try again.`)
  }
  return bitmap
}

/** Draw (and downscale) a bitmap into raw pixels. A background is painted first for formats without transparency. */
export function drawPixels(bitmap: ImageBitmap, maxSide: number | null, background?: string): ImageData {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSide)
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas unavailable')
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height) }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height)
}

export async function encodeJpeg(pixels: ImageData, quality: number): Promise<ArrayBuffer> {
  return (await import('@jsquash/jpeg/encode.js')).default(pixels, { quality: Math.min(100, Math.max(1, Math.round(quality))) })
}
