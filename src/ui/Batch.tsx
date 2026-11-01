import type { Item } from '../App'
import { formatBytes } from '../core/detect'
import { percent, useObjectUrl } from './hooks'
import { sizeChange } from './Outputs'

function Row({ item, index, onMove, reorderable, total }: { item: Item; index: number; total: number; reorderable: boolean; onMove: (from: number, to: number) => void }) {
  const out = item.output
  const only = out?.files.length === 1 ? out.files[0] : undefined
  const url = useObjectUrl(only?.blob)
  return (
    <li className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-start gap-3">
        {reorderable && (
          <span className="flex shrink-0 flex-col text-sm">
            <button type="button" onClick={() => onMove(index, index - 1)} disabled={index === 0} aria-label={`Move ${item.file.name} up`} className="rounded px-1.5 leading-tight hover:bg-rule disabled:opacity-30">↑</button>
            <button type="button" onClick={() => onMove(index, index + 1)} disabled={index === total - 1} aria-label={`Move ${item.file.name} down`} className="rounded px-1.5 leading-tight hover:bg-rule disabled:opacity-30">↓</button>
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate font-medium">{item.file.name}</p>
          <p className="text-sm text-muted">{item.detected.label}, {formatBytes(item.file.size)}</p>
        </div>
      </div>
      <div className="text-sm sm:text-right">
        {item.problem && <p className="max-w-md text-danger">{item.problem}</p>}
        {item.status === 'running' && (
          <div className="flex items-center gap-3 sm:justify-end">
            <span className="text-muted">{item.stage}</span>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-rule"><span className="block h-full bg-jade" style={{ width: percent(item.progress) }} /></span>
          </div>
        )}
        {item.status === 'error' && <p className="max-w-md text-danger">{item.error}</p>}
        {item.status === 'cancelled' && <p className="text-muted">Cancelled</p>}
        {out && !out.files.length && out.note && <p className="max-w-md text-muted">{out.note}</p>}
        {only && url && (
          <p>
            <span className="tabular-nums">{formatBytes(only.blob.size)}</span>
            <span className="text-muted">, {sizeChange(item.file.size, only.blob.size).toLowerCase()} </span>
            <a href={url} download={only.name} className="ml-2 text-jade underline underline-offset-4">Download</a>
          </p>
        )}
        {out && out.files.length > 1 && <p className="text-muted">{out.files.length} files, in the ZIP below</p>}
      </div>
    </li>
  )
}

export function BatchList({ items, reorderable, onMove }: { items: Item[]; reorderable: boolean; onMove: (from: number, to: number) => void }) {
  return (
    <ul className="divide-y divide-rule border-y border-rule" aria-label="Files">
      {items.map((it, i) => <Row key={it.id} item={it} index={i} total={items.length} reorderable={reorderable} onMove={onMove} />)}
    </ul>
  )
}
