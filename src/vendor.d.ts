// gifenc ships no types. Only the surface Switchlet uses is declared.
declare module 'gifenc' {
  type Palette = number[][]
  export function quantize(rgba: Uint8ClampedArray, maxColors: number): Palette
  export function applyPalette(rgba: Uint8ClampedArray, palette: Palette): Uint8Array
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, options: { palette: Palette; delay: number }): void
    finish(): void
    bytes(): Uint8Array
  }
}

// turndown ships no types. Only the surface Switchlet uses is declared.
declare module 'turndown' {
  interface Options {
    headingStyle?: 'setext' | 'atx'
    codeBlockStyle?: 'indented' | 'fenced'
    bulletListMarker?: '-' | '+' | '*'
  }
  export default class TurndownService {
    constructor(options?: Options)
    turndown(html: string | Node): string
  }
}

// libheif-js ships no types for its ESM bundle. Only the surface Switchlet uses is declared.
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  interface HeifImage {
    get_width(): number
    get_height(): number
    display(target: ImageData, done: (result: ImageData | null) => void): void
    free(): void
  }
  interface LibHeif {
    HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] }
  }
  const factory: () => LibHeif
  export default factory
}
