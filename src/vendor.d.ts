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
