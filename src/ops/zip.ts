// Batch download as one ZIP. Runs in the worker. Store-only (level 0): images are already compressed.
// zipSync, not fflate's async zip: the async API spawns blob: workers, which our CSP forbids.
import { zipSync, type Zippable } from 'fflate'

/** Safe, unique entry names: no paths or control characters, duplicates numbered like a file manager would. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map((raw) => {
    const clean = raw.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '').trim() || 'file'
    const dot = clean.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, '']
    let name = clean
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`
    seen.add(name.toLowerCase())
    return name
  })
}

export function zipFiles(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const files: Zippable = {}
  uniqueNames(entries.map((e) => e.name)).forEach((name, i) => { files[name] = [entries[i]!.data, { level: 0 }] })
  return zipSync(files)
}
