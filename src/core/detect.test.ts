import { describe, expect, it } from 'vitest'
import { detect, formatBytes, limitProblem } from './detect'

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u16 = (n: number) => [(n >>> 8) & 255, n & 255]
const ftyp = (major: string, ...compat: string[]) => bytes(u32(16 + compat.length * 4), 'ftyp', major, u32(0), ...compat)
const text = (s: string) => new TextEncoder().encode(s)

describe('detect: binary formats by magic bytes', () => {
  it('ignores a lying extension', () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32(13), 'IHDR', u32(640), u32(480))
    expect(detect(png, 'holiday.jpg')).toMatchObject({ kind: 'png', group: 'image', width: 640, height: 480 })
  })

  it('reads JPEG dimensions past an EXIF segment and fill bytes', () => {
    const app1 = [0xff, 0xe1, ...u16(12), ...bytes('Exif', [0, 0, 1, 2, 3, 4])]
    const sof0 = [0xff, 0xff, 0xc0, ...u16(17), 8, ...u16(3024), ...u16(4032), 3]
    expect(detect(bytes([0xff, 0xd8], app1, sof0, new Array(20).fill(0)), 'x')).toMatchObject({ kind: 'jpeg', width: 4032, height: 3024 })
  })

  it('stops safely on a truncated or corrupt JPEG', () => {
    const truncated = detect(bytes([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), 'x')
    expect(truncated.kind).toBe('jpeg')
    expect(truncated.width).toBeUndefined()
    expect(detect(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0x12, 0x34], new Array(20).fill(0)), 'x').width).toBeUndefined()
  })

  it('reads GIF and all three WebP header variants', () => {
    expect(detect(bytes('GIF89a', [0x20, 0x03, 0x58, 0x02]), 'x')).toMatchObject({ kind: 'gif', width: 800, height: 600 })
    const vp8x = bytes('RIFF', u32(0), 'WEBP', 'VP8X', u32(0), [0, 0, 0, 0], [0x7f, 0x07, 0], [0x37, 0x04, 0])
    expect(detect(vp8x, 'x')).toMatchObject({ kind: 'webp', width: 1920, height: 1080 })
    const vp8 = bytes('RIFF', u32(0), 'WEBP', 'VP8 ', u32(0), [0, 0, 0, 0x9d, 0x01, 0x2a], [0x80, 0x02, 0xe0, 0x01])
    expect(detect(vp8, 'x')).toMatchObject({ width: 640, height: 480 })
    // VP8L: 14-bit (w-1), 14-bit (h-1) packed little-endian after the 0x2f signature: 100x50
    const w = 99, h = 49, packed = w | (h << 14)
    const vp8l = bytes('RIFF', u32(0), 'WEBP', 'VP8L', u32(0), [0x2f, packed & 255, (packed >> 8) & 255, (packed >> 16) & 255, (packed >> 24) & 255])
    expect(detect(vp8l, 'x')).toMatchObject({ width: 100, height: 50 })
  })

  it('tells HEIC, AVIF, MP4, M4A and MOV apart by ftyp brands', () => {
    expect(detect(ftyp('heic', 'mif1', 'heic'), 'x').kind).toBe('heic')
    expect(detect(ftyp('mif1', 'avif', 'miaf'), 'x').kind).toBe('avif')
    expect(detect(ftyp('isom', 'iso2', 'mp41'), 'x').kind).toBe('mp4')
    expect(detect(ftyp('M4A ', 'isom'), 'x').kind).toBe('m4a')
    expect(detect(ftyp('isom', 'iso2', 'mp41'), 'song.m4a').kind).toBe('m4a') // generic brand: extension decides
    expect(detect(ftyp('isom', 'iso2', 'mp41'), 'clip.mp4').kind).toBe('mp4')
    expect(detect(ftyp('qt  ', 'qt  '), 'x').kind).toBe('mov')
    expect(detect(bytes(u32(8), 'moov'), 'x').kind).toBe('mov')
  })

  it('detects PDF (even with leading junk), WebM, MKV, WAV, MP3, XLSX, ZIP', () => {
    expect(detect(bytes('\r\n%PDF-1.7'), 'x').kind).toBe('pdf')
    expect(detect(bytes([0x1a, 0x45, 0xdf, 0xa3], 'B\x82\x84webm'), 'x').kind).toBe('webm')
    expect(detect(bytes([0x1a, 0x45, 0xdf, 0xa3], 'B\x82\x88matroska'), 'x').kind).toBe('mkv')
    expect(detect(bytes('RIFF', u32(0), 'WAVE'), 'x').kind).toBe('wav')
    expect(detect(bytes('ID3', [4, 0]), 'x').kind).toBe('mp3')
    expect(detect(bytes('OggS', [0, 2]), 'x').kind).toBe('ogg')
    expect(detect(bytes('fLaC', [0, 0, 0, 34]), 'x').kind).toBe('flac')
    expect(detect(bytes([0xff, 0xfb, 0x90, 0x00]), 'x').kind).toBe('mp3')
    expect(detect(bytes([0x50, 0x4b, 3, 4], new Array(26).fill(0), 'xl/workbook.xml'), 'a.xlsx').kind).toBe('xlsx')
    expect(detect(bytes([0x50, 0x4b, 3, 4], new Array(26).fill(0), 'word/document.xml'), 'a.docx').kind).toBe('zip')
  })
})

describe('detect: text formats', () => {
  it('recognises SVG (to reject it), JSON, HTML, CSV and Markdown', () => {
    expect(detect(text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">'), 'logo.png').kind).toBe('svg')
    expect(detect(text('﻿  {"a": 1}'), 'data').kind).toBe('json')
    expect(detect(text('<!DOCTYPE html><html>'), 'page').kind).toBe('html')
    expect(detect(text('name,age\nAda,36\nAlan,41\n'), 'people').kind).toBe('csv')
    expect(detect(text('# Title\n\nSome text'), 'notes.md').kind).toBe('markdown')
    expect(detect(text('just some words'), 'notes.txt').kind).toBe('text')
  })

  it('does not treat binary or invalid UTF-8 as text', () => {
    expect(detect(bytes([0x00, 0x01, 0x02, 0x03]), 'x.csv').kind).toBe('unknown')
    expect(detect(bytes([0xc3, 0x28, 0x41]), 'x.md').kind).toBe('unknown')
  })

  it('tolerates a multi-byte character cut off at the end of the head', () => {
    expect(detect(text('name,city\nZoë,Köln\nAna,Café').subarray(0, -1), 'x').kind).toBe('csv')
  })
})

describe('limits', () => {
  const img = (width: number, height: number) => ({ kind: 'png', label: 'PNG image', group: 'image', width, height }) as const
  it('accepts normal files and rejects oversized or decompression-bomb images', () => {
    expect(limitProblem(img(4000, 3000), 5_000_000)).toBeNull()
    expect(limitProblem(img(100, 100), 250_000_000)).toMatch(/250 MB.*200 MB/)
    expect(limitProblem(img(50_000, 50_000), 1_000)).toMatch(/2,500 megapixels/)
  })
  it('rejects SVG with a reason', () => {
    expect(limitProblem({ kind: 'svg', label: 'SVG image', group: 'none' }, 10)).toMatch(/scripts/)
  })
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(1)).toBe('1 byte')
    expect(formatBytes(3_200_000)).toBe('3.2 MB')
  })
})
