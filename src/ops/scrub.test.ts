import { describe, expect, it } from 'vitest'
import { detect } from '../core/detect'
import { DecodeError, describeMetadata, scrubImage } from './scrub'

const str = (s: string) => [...s].map((c) => c.charCodeAt(0))
const u16 = (n: number) => [(n >> 8) & 255, n & 255]
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
const indexOf = (hay: Uint8Array, needle: number[]) =>
  hay.findIndex((_, i) => needle.every((v, j) => hay[i + j] === v))

/** APP1 with Make/Model, Orientation=6 and GPS 51.5007 N, 0.1246 W (big-endian TIFF). */
function exifApp1(): number[] {
  const make = 'Apple\0', model = 'iPhone 15 Pro\0'
  const makeAt = 8 + 54, modelAt = makeAt + make.length, gpsAt = modelAt + model.length
  const latAt = gpsAt + 54, lonAt = latAt + 24
  const entry = (tag: number, type: number, count: number, v: number[]) => [...u16(tag), ...u16(type), ...u32(count), ...v]
  const t = [
    ...str('MM'), ...u16(42), ...u32(8),
    ...u16(4),
    ...entry(0x010f, 2, make.length, u32(makeAt)),
    ...entry(0x0110, 2, model.length, u32(modelAt)),
    ...entry(0x0112, 3, 1, [0, 6, 0, 0]),
    ...entry(0x8825, 4, 1, u32(gpsAt)),
    ...u32(0),
    ...str(make), ...str(model),
    ...u16(4),
    ...entry(1, 2, 2, [...str('N'), 0, 0, 0]),
    ...entry(2, 5, 3, u32(latAt)),
    ...entry(3, 2, 2, [...str('W'), 0, 0, 0]),
    ...entry(4, 5, 3, u32(lonAt)),
    ...u32(0),
    ...u32(51), ...u32(1), ...u32(30), ...u32(1), ...u32(252), ...u32(100),
    ...u32(0), ...u32(1), ...u32(7), ...u32(1), ...u32(2856), ...u32(100),
  ]
  const payload = [...str('Exif'), 0, 0, ...t]
  return [0xff, 0xe1, ...u16(payload.length + 2), ...payload]
}

const ENTROPY = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]
function jpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, ...u16(16), ...str('JFIF'), 0, 1, 1, 0, 0, 72, 0, 72, 0, 0,
    ...exifApp1(),
    0xff, 0xe2, ...u16(18), ...str('ICC_PROFILE'), 0, 1, 1, 9, 9,
    0xff, 0xfe, ...u16(7), ...str('hello'),
    0xff, 0xdb, ...u16(4), 0, 0,
    0xff, 0xc0, ...u16(11), 8, ...u16(16), ...u16(16), 1, 1, 0x11, 0,
    0xff, 0xda, ...u16(8), 1, 1, 0, 0, 0x3f, 0,
    ...ENTROPY,
    0xff, 0xd9,
    ...new Array(64).fill(0xab), // trailing MPF-style embedded image
  ])
}

describe('JPEG scrub', () => {
  it('reports what it found in plain English', () => {
    const { found, orientation } = describeMetadata(jpeg())
    expect(found).toContainEqual({ label: 'GPS location', detail: '51.5007, -0.1246' })
    expect(found).toContainEqual({ label: 'Camera', detail: 'Apple iPhone 15 Pro' })
    expect(orientation).toBe(6)
  })

  it('removes metadata losslessly, keeping orientation, ICC and image data', () => {
    const { data, report } = scrubImage(jpeg(), 'jpeg')
    expect(report.removed).toEqual(expect.arrayContaining(['EXIF data', 'Comments', 'Extra embedded images (depth map, HDR)']))
    expect(report.kept).toEqual(['Orientation, so the photo stays upright', 'Colour profile'])

    const after = describeMetadata(data)
    expect(after.found).toEqual([])
    expect(after.orientation).toBe(6)
    expect(indexOf(data, str('ICC_PROFILE'))).toBeGreaterThan(0)
    expect(indexOf(data, str('hello'))).toBe(-1)
    expect(indexOf(data, ENTROPY)).toBeGreaterThan(0)
    expect([...data.subarray(-2)]).toEqual([0xff, 0xd9])
    expect(detect(data, 'x')).toMatchObject({ kind: 'jpeg', width: 16, height: 16 })
    // orientation block sits right after the JFIF APP0
    expect([...data.subarray(20, 22)]).toEqual([0xff, 0xe1])
  })

  it('rejects truncated segments and a missing end-of-image marker with DecodeError', () => {
    const b = jpeg()
    expect(() => scrubImage(b.subarray(0, 30), 'jpeg')).toThrow(DecodeError)
    const eoi = indexOf(b, [0xff, 0xd9])
    expect(() => scrubImage(b.subarray(0, eoi), 'jpeg')).toThrow(DecodeError)
  })

  it('removes metadata hidden between progressive scans', () => {
    const b = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc2, ...u16(11), 8, ...u16(8), ...u16(8), 1, 1, 0x11, 0,
      0xff, 0xda, ...u16(8), 1, 1, 0, 0, 0x3f, 0, 0x11, 0x22,
      ...exifApp1(), // APP1 with GPS after the first scan
      0xff, 0xfe, ...u16(8), ...str('secret'),
      0xff, 0xc4, ...u16(4), 0, 0, // tables between scans are kept
      0xff, 0xda, ...u16(8), 1, 1, 0, 0, 0x3f, 0, 0x33, 0x44,
      0xff, 0xd9,
    ])
    const { data, report } = scrubImage(b, 'jpeg')
    expect(report.removed).toEqual(expect.arrayContaining(['EXIF data', 'Comments']))
    expect(indexOf(data, str('secret'))).toBe(-1)
    expect(indexOf(data, str('Exif'))).toBe(-1)
    expect(indexOf(data, [0xff, 0xc4, 0, 4, 0, 0])).toBeGreaterThan(0)
    expect(indexOf(data, [0x33, 0x44, 0xff, 0xd9])).toBeGreaterThan(0)
  })

  it('keeps a genuine Adobe APP14 segment and drops anything else using that marker', () => {
    const adobe = [0xff, 0xee, ...u16(14), ...str('Adobe'), 0, 100, 0, 0, 0, 0, 1]
    const fake = [0xff, 0xee, ...u16(10), ...str('secret!!')]
    const b = new Uint8Array([0xff, 0xd8, ...adobe, ...fake, ...jpeg().subarray(2)])
    const { data, report } = scrubImage(b, 'jpeg')
    expect(indexOf(data, str('Adobe'))).toBeGreaterThan(0)
    expect(indexOf(data, str('secret!!'))).toBe(-1)
    expect(report.removed).toContain('Other metadata')
  })

  it('rebuilds an Adobe-prefixed APP14 that hides extra bytes', () => {
    const smuggler = [0xff, 0xee, ...u16(14 + 8), ...str('Adobe'), 0, 100, 0, 0, 0, 0, 1, ...str('hidden!!')]
    const b = new Uint8Array([0xff, 0xd8, ...smuggler, ...jpeg().subarray(2)])
    const { data, report } = scrubImage(b, 'jpeg')
    expect(indexOf(data, str('hidden!!'))).toBe(-1)
    expect(indexOf(data, [0xff, 0xee, 0, 14, ...str('Adobe'), 0, 100, 0, 0, 0, 0, 1])).toBeGreaterThan(0)
    expect(report.removed).toContain('Other metadata')
  })

  it('cuts a JFIF thumbnail but keeps the JFIF header', () => {
    const thumb = [0xff, 0xe0, ...u16(16 + 6), ...str('JFIF'), 0, 1, 1, 0, 0, 72, 0, 72, 1, 2, 9, 9, 9, 9, 9, 9]
    const b = new Uint8Array([0xff, 0xd8, ...thumb, ...jpeg().subarray(20)])
    const { data, report } = scrubImage(b, 'jpeg')
    expect(report.removed).toContain('Embedded thumbnail')
    expect([...data.subarray(2, 20)]).toEqual([0xff, 0xe0, 0, 16, ...str('JFIF'), 0, 1, 1, 0, 0, 72, 0, 72, 0, 0])
  })
})

const chunk = (type: string, data: number[]) => [...u32(data.length), ...str(type), ...data, 0, 0, 0, 0]
function png(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(1), ...u32(1), 8, 6, 0, 0, 0]),
    ...chunk('tEXt', str('Author\0Ada')),
    ...chunk('iTXt', str('XML:com.adobe.xmp\0\0\0\0\0<x/>')),
    ...chunk('tIME', [7, 232, 1, 1, 0, 0, 0]),
    ...chunk('iCCP', str('sRGB\0\0x')),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND', []),
  ])
}
const pngChunks = (b: Uint8Array) => {
  const types: string[] = []
  for (let i = 8; i < b.length; ) {
    const len = (b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!
    types.push(String.fromCharCode(...b.subarray(i + 4, i + 8)))
    i += 12 + len
  }
  return types
}

describe('PNG scrub', () => {
  it('drops text, XMP and time chunks, keeps image and colour chunks', () => {
    const { data, report } = scrubImage(png(), 'png')
    expect(pngChunks(data)).toEqual(['IHDR', 'iCCP', 'IDAT', 'IEND'])
    expect(report.removed).toEqual(expect.arrayContaining(['XMP metadata', 'Last-modified time', 'Text notes (author, software, comments, AI prompts)']))
    expect(report.kept).toEqual(['Colour profile'])
  })
  it('rejects a chunk length that runs past the end', () => {
    const b = png()
    b.set(u32(0x7fffffff), 33)
    expect(() => scrubImage(b, 'png')).toThrow(DecodeError)
  })
})

describe('WebP scrub', () => {
  const riffChunk = (type: string, data: number[]) => [...str(type), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])]
  function webp(): Uint8Array {
    const body = [
      ...str('WEBP'),
      ...riffChunk('VP8X', [0x0c | 0x10 | 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ...riffChunk('ICCP', [1, 2, 3, 4]),
      ...riffChunk('VP8L', [0x2f, 0, 0, 0, 0]),
      ...riffChunk('EXIF', [9, 9, 9]),
      ...riffChunk('XMP ', [8, 8, 8, 8, 8]),
      ...riffChunk('ZZZZ', [7]), // unknown chunk: removed by the allow-list
    ]
    return new Uint8Array([...str('RIFF'), ...le32(body.length), ...body])
  }
  it('removes EXIF/XMP chunks, clears their VP8X flags and fixes the RIFF size', () => {
    const { data, report } = scrubImage(webp(), 'webp')
    const view = new DataView(data.buffer)
    expect(view.getUint32(4, true)).toBe(data.length - 8)
    expect(data[20]).toBe(0x30) // ICC + alpha flags remain
    expect(indexOf(data, str('EXIF'))).toBe(-1)
    expect(indexOf(data, str('XMP '))).toBe(-1)
    expect(indexOf(data, str('ZZZZ'))).toBe(-1)
    expect(report.removed).toEqual(['EXIF data', 'XMP metadata', 'Other metadata'])
    expect(report.kept).toEqual(['Colour profile'])
  })
})

describe('hostile input', () => {
  it('never hangs or throws anything but DecodeError on mutated files', () => {
    let seed = 42
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) % 1_000_000) / 1_000_000
    for (const [kind, make] of [['jpeg', jpeg], ['png', png]] as const) {
      for (let n = 0; n < 300; n++) {
        const b = make()
        for (let k = 0; k < 4; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256)
        const cut = rand() < 0.3 ? b.subarray(0, Math.floor(rand() * b.length)) : b
        try {
          scrubImage(cut, kind)
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError)
        }
      }
    }
  })
})
