// WCAG AA contrast for every text/background pair the UI uses, in both themes, read from styles.css.
// @ts-expect-error -- no @types/node in this project; Vitest runs this file in Node (it empties CSS imports, ?raw too).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css: string = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]))
const light = tokens(css.slice(css.indexOf('@theme'), css.indexOf('@media (prefers-color-scheme: dark)')))
const dark = tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)')))

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

// [foreground, background, minimum]: 4.5 for text, 3 for control boundaries and focus rings.
const PAIRS: [string, string, number][] = [
  ['ink', 'paper', 4.5], ['ink', 'field', 4.5],
  ['muted', 'paper', 4.5], ['muted', 'field', 4.5],
  ['jade', 'paper', 4.5], ['jade', 'field', 4.5],
  ['on-jade', 'jade', 4.5],
  ['danger', 'paper', 4.5], ['danger', 'field', 4.5],
  ['line', 'paper', 3], ['line', 'field', 3],
]

describe.each([['light', light], ['dark', dark]] as const)('%s theme', (_, theme) => {
  it.each(PAIRS)('%s on %s ≥ %s:1', (fg, bg, min) => {
    expect(theme[fg] && theme[bg], `missing token ${fg} or ${bg}`).toBeTruthy()
    expect(ratio(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(min)
  })
})
