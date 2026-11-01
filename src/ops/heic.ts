// HEIC fallback decoder (libheif, LGPL-3.0), loaded only when the browser can't decode HEIC itself.
// ponytail: the ESM bundle embeds its WASM as base64 (~30% larger download than a separate .wasm);
// switch to libheif.js + libheif.wasm if HEIC decode size starts to matter.
import factory from 'libheif-js/libheif-wasm/libheif-bundle.mjs'
import { DecodeError } from './errors'

let lib: ReturnType<typeof factory> | undefined

export async function decodeHeic(input: Uint8Array): Promise<ImageData> {
  lib ??= factory()
  const images = new lib.HeifDecoder().decode(input)
  const image = images[0]
  if (!image) throw new DecodeError('This HEIC file has no image in it, or it is damaged.')
  try {
    const target = new ImageData(image.get_width(), image.get_height())
    return await new Promise<ImageData>((resolve, reject) =>
      image.display(target, (result) => (result ? resolve(result) : reject(new DecodeError('This HEIC photo couldn’t be decoded. It may be damaged.')))),
    )
  } finally {
    for (const img of images) img.free()
  }
}
