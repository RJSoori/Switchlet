import type { Item } from '../App'
import { formatBytes } from '../core/detect'
import { percent, useObjectUrl } from './hooks'
import { sizeChange } from './Result'

function Row({ item }: { item: Item }) {
  const url = useObjectUrl(item.output?.blob)
  const out = item.output
  return (
    <li className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="truncate font-medium">{item.file.name}</p>
        <p className="text-sm text-muted">{item.detected.label}, {formatBytes(item.file.size)}</p>
      </div>
      <div className="text-sm sm:text-right">
        {item.problem && <p className="text-danger">{item.problem}</p>}
        {item.status === 'idle' && !item.problem && <p className="text-muted">Ready</p>}
        {item.status === 'running' && (
          <div className="flex items-center gap-3 sm:justify-end">
            <span className="text-muted">{item.stage}</span>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-rule"><span className="block h-full bg-jade" style={{ width: percent(item.progress) }} /></span>
          </div>
        )}
        {item.status === 'error' && <p className="max-w-md text-danger">{item.error}</p>}
        {item.status === 'cancelled' && <p className="text-muted">Cancelled</p>}
        {out && url && (
          <p>
            <span className="tabular-nums">{formatBytes(out.blob.size)}</span>
            <span className="text-muted">, {sizeChange(item.file.size, out.blob.size).toLowerCase()} </span>
            <a href={url} download={out.name} className="ml-2 text-jade underline underline-offset-4">Download</a>
          </p>
        )}
      </div>
    </li>
  )
}

export function BatchList({ items }: { items: Item[] }) {
  return (
    <ul className="divide-y divide-rule border-y border-rule" aria-label="Files">
      {items.map((it) => <Row key={it.id} item={it} />)}
    </ul>
  )
}
