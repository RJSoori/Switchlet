// Command palette (Ctrl/Cmd+K) and the keyboard shortcut sheet (?). Both are native <dialog>s.
import { useId, useMemo, useState } from 'react'
import { Dialog } from './Library'

export interface Command {
  id: string
  label: string
  /** Shortcut shown on the right, e.g. "D". */
  keys?: string
  run: () => void
}

export const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands
  }, [commands, query])
  const pick = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  return (
    <Dialog title="Commands" onClose={onClose} wide>
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        aria-label="Search commands"
        placeholder="Type to search"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          if (e.key === 'Enter') { e.preventDefault(); pick(shown[active]) }
        }}
        className="w-full rounded-md border border-line bg-field px-3 py-2"
      />
      <ul id={listId} role="listbox" aria-label="Commands" className="mt-3 max-h-[50vh] overflow-auto">
        {shown.map((c, i) => (
          <li
            key={c.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(c)}
            className={`flex cursor-pointer items-center justify-between gap-4 rounded-md px-3 py-2 ${i === active ? 'bg-jade text-on-jade' : ''}`}
          >
            <span>{c.label}</span>
            {c.keys && <kbd className={`text-sm ${i === active ? '' : 'text-muted'}`}>{c.keys}</kbd>}
          </li>
        ))}
        {!shown.length && <li className="px-3 py-2 text-muted">No command matches “{query}”.</li>}
      </ul>
    </Dialog>
  )
}

const SHORTCUTS: [string, string][] = [
  [`${mod} K`, 'Open the command palette'],
  [`${mod} O`, 'Choose files'],
  [`${mod} V`, 'Paste files'],
  ['Enter', 'Run the current task'],
  ['D', 'Download the result'],
  ['Esc', 'Cancel what’s running'],
  ['?', 'Show these shortcuts'],
]

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="contents">
            <dt><kbd className="rounded border border-line px-1.5 py-0.5 text-sm">{keys}</kbd></dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm text-muted">Letter shortcuts work when you’re not typing in a field.</p>
      <button type="button" onClick={onClose} className="mt-5 rounded-lg border border-line px-4 py-2">Close</button>
    </Dialog>
  )
}
