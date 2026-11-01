import { useId, useRef, useState } from 'react'
import type { Kind } from '../core/detect'
import {
  DEFAULT_QUALITY, FORMAT_LABEL, IMAGE_FORMATS, OPS, fitWithin, makeStep,
  type ImageFormat, type ImageSettings, type OpId, type PageSize, type SheetFormat, type Step, type Strength,
} from '../core/ops'

const FORMAT_HINT: Record<ImageFormat, string> = {
  jpeg: 'Opens everywhere. Best for photos.',
  webp: 'Smaller than JPG at the same quality. Works in every modern browser.',
  avif: 'Smallest files. Slower to create, and some older apps can’t open it.',
  png: 'Lossless and supports transparency. Larger files.',
}

interface ChoiceProps<T extends string> {
  label: string
  value: T | null
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  hint?: string
}

export function Choice<T extends string>({ label, value, options, onChange, hint }: ChoiceProps<T>) {
  const id = useId()
  return (
    <div className="grid gap-2 @lg:grid-cols-[7rem_1fr] @lg:gap-x-6">
      <span id={id} className="text-muted @lg:pt-1.5">{label}</span>
      <div>
        <div role="radiogroup" aria-labelledby={id} className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <label
              key={o.value}
              className="cursor-pointer rounded-md border border-line px-3 py-1.5 select-none hover:border-ink has-checked:border-jade has-checked:bg-jade has-checked:text-on-jade has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-jade"
            >
              <input type="radio" className="sr-only" name={id} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
        {hint && <p className="mt-2 text-sm text-muted">{hint}</p>}
      </div>
    </div>
  )
}

const PRESETS = [3840, 2560, 1920, 1080, 720]

function SizeChoice({ value, dims, onChange }: { value: number | null; dims?: { width: number; height: number }; onChange: (v: number | null) => void }) {
  const longest = dims ? Math.max(dims.width, dims.height) : Infinity
  const presets = PRESETS.filter((n) => n < longest)
  const isCustom = value !== null && !presets.includes(value)
  const [custom, setCustom] = useState(isCustom ? String(value) : '')
  const [customMode, setCustomMode] = useState(isCustom)
  const selected = customMode ? 'custom' : value === null ? 'original' : String(value)
  const out = dims && value ? fitWithin(dims.width, dims.height, value) : dims
  const inputId = useId()

  const setCustomValue = (raw: string) => {
    setCustom(raw)
    const n = Number(raw)
    if (Number.isInteger(n) && n >= 16 && n <= 20_000) onChange(n)
  }

  return (
    <div>
      <Choice
        label="Size"
        value={selected}
        options={[{ value: 'original', label: 'Original' }, ...presets.map((n) => ({ value: String(n), label: `${n} px` })), { value: 'custom', label: 'Custom' }]}
        onChange={(v) => {
          setCustomMode(v === 'custom')
          if (v === 'original') onChange(null)
          else if (v === 'custom') setCustomValue(custom || String(Math.min(longest, 1600)))
          else onChange(Number(v))
        }}
        hint={out ? `Longest side. Output: ${out.width.toLocaleString('en')} × ${out.height.toLocaleString('en')} pixels.` : 'Longest side. Images are never made larger.'}
      />
      {customMode && (
        <div className="mt-3 @lg:ml-[calc(7rem+1.5rem)]">
          <label htmlFor={inputId} className="text-sm text-muted">Longest side in pixels (16–20,000)</label>
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={16}
            max={20000}
            value={custom}
            onChange={(e) => setCustomValue(e.target.value)}
            className="mt-1 block w-36 rounded-md border border-line bg-field px-3 py-1.5 tabular-nums"
          />
        </div>
      )}
    </div>
  )
}

function ImageOptions({ settings: s, onChange, dims }: { settings: ImageSettings; onChange: (s: ImageSettings) => void; dims?: { width: number; height: number } }) {
  const qualityId = useId()
  const set = (patch: Partial<ImageSettings>) => onChange({ ...s, ...patch })
  return (
    <>
      <Choice
        label="Format"
        value={s.format}
        options={IMAGE_FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
        onChange={(format) => set({ format, quality: DEFAULT_QUALITY[format] })}
        hint={`${FORMAT_HINT[s.format]} Hidden data like location is always removed.`}
      />
      <SizeChoice value={s.maxSide} dims={dims} onChange={(maxSide) => set({ maxSide })} />
      {s.format !== 'png' && (
        <div className="grid gap-2 @lg:grid-cols-[7rem_1fr] @lg:gap-x-6">
          <label htmlFor={qualityId} className="text-muted">Quality</label>
          <div>
            <div className="flex items-center gap-4">
              <input id={qualityId} type="range" min={1} max={100} value={s.quality} onChange={(e) => set({ quality: Number(e.target.value) })} className="w-full max-w-sm accent-jade" />
              <output htmlFor={qualityId} className="w-8 font-medium tabular-nums">{s.quality}</output>
            </div>
            <p className="mt-2 text-sm text-muted">Lower makes smaller files. Most photos look unchanged from about {s.format === 'avif' ? 50 : 75}.</p>
          </div>
        </div>
      )}
    </>
  )
}

function SplitOptions({ ranges, onChange }: { ranges: string; onChange: (ranges: string) => void }) {
  const [mode, setMode] = useState<'every' | 'ranges'>(ranges ? 'ranges' : 'every')
  const inputId = useId()
  return (
    <div>
      <Choice
        label="Parts"
        value={mode}
        options={[{ value: 'every', label: 'Every page' }, { value: 'ranges', label: 'Page ranges' }]}
        onChange={(m) => { setMode(m); if (m === 'every') onChange('') }}
      />
      {mode === 'ranges' && (
        <div className="mt-3 @lg:ml-[calc(7rem+1.5rem)]">
          <label htmlFor={inputId} className="text-sm text-muted">Pages for each part, separated by commas</label>
          <input
            id={inputId}
            value={ranges}
            placeholder="1-3, 5, 8-"
            onChange={(e) => onChange(e.target.value)}
            className="mt-1 block w-full max-w-xs rounded-md border border-line bg-field px-3 py-1.5"
          />
          <p className="mt-2 text-sm text-muted">“8-” means page 8 to the end.</p>
        </div>
      )}
    </div>
  )
}

const TASK_HINT: Partial<Record<OpId, string>> = {
  'image.scrub': 'Removes location, camera details and other hidden data. Every pixel stays exactly as it is.',
  'pdf.merge': 'Pages are joined in the order shown below. Use the arrows to change it.',
  'pdf.pages': 'Drag pages into a new order, or remove the ones you don’t need.',
  'pdf.split': 'Makes a separate PDF for each part.',
  'pdf.toImages': 'Saves one image per page.',
  'pdf.compress': 'Recompresses the photos inside. Text stays sharp.',
  'pdf.scrub': 'Removes the author, the app that made it, dates, leftovers from earlier edits and location data in embedded photos. The pages look exactly the same.',
}

const STRENGTH_HINT: Record<Strength, string> = {
  light: 'Hardly any visible change.',
  balanced: 'Good for sharing by email.',
  strong: 'Smallest file. Photos lose some detail.',
}

const SHEET_LABEL: Record<SheetFormat, string> = { csv: 'CSV', json: 'JSON', xlsx: 'Excel' }

export function TaskPicker({ ops, step, kind, onChange }: { ops: OpId[]; step: Step | null; kind: Kind; onChange: (s: Step) => void }) {
  if (ops.length < 2 && step) return null
  const hint = step
    ? step.op === 'doc.convert'
      ? kind === 'html' ? 'Turns this HTML page into Markdown.' : 'Turns this into an HTML page. Scripts and other unsafe HTML are removed.'
      : TASK_HINT[step.op]
    : 'Choose what to do with this file.'
  return <Choice label="Task" value={step?.op ?? null} options={ops.map((op) => ({ value: op, label: OPS[op].label }))} onChange={(op) => onChange(makeStep(op, kind))} hint={hint} />
}

export function Options(props: {
  ops: OpId[]
  step: Step | null
  kind: Kind
  onChange: (s: Step) => void
  dims?: { width: number; height: number }
  sheets?: string[]
  fileCount: number
}) {
  const { step, onChange, kind } = props
  // Remember image settings while the user tries another task and comes back.
  const lastImage = useRef<ImageSettings | null>(null)
  if (step?.op === 'image.convert') lastImage.current = step.settings
  const pickTask = (s: Step) => onChange(s.op === 'image.convert' && lastImage.current ? { ...s, settings: lastImage.current } : s)

  return (
    <div className="@container space-y-6">
      <TaskPicker ops={props.ops} step={step} kind={kind} onChange={pickTask} />
      {step?.op === 'image.convert' && <ImageOptions settings={step.settings} dims={props.dims} onChange={(settings) => onChange({ ...step, settings })} />}
      {step?.op === 'image.toPdf' && (
        <Choice<PageSize>
          label="Page size"
          value={step.settings.pageSize}
          options={[{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }, { value: 'image', label: 'Same shape as the image' }]}
          onChange={(pageSize) => onChange({ ...step, settings: { pageSize } })}
          hint={props.fileCount > 1 ? 'One page per image, in the order shown below.' : undefined}
        />
      )}
      {step?.op === 'pdf.split' && <SplitOptions ranges={step.settings.ranges} onChange={(ranges) => onChange({ ...step, settings: { ranges } })} />}
      {step?.op === 'pdf.toImages' && (
        <>
          <Choice
            label="Format"
            value={step.settings.format}
            options={[{ value: 'jpeg', label: 'JPG' }, { value: 'png', label: 'PNG' }]}
            onChange={(format) => onChange({ ...step, settings: { ...step.settings, format } })}
            hint={step.settings.format === 'png' ? 'Sharpest for text and diagrams. Larger files.' : 'Smaller files. Best for pages with photos.'}
          />
          <Choice
            label="Resolution"
            value={String(step.settings.dpi)}
            options={[{ value: '72', label: 'Screen' }, { value: '150', label: 'Standard' }, { value: '300', label: 'Print' }]}
            onChange={(dpi) => onChange({ ...step, settings: { ...step.settings, dpi: Number(dpi) } })}
            hint={`${step.settings.dpi} dots per inch.`}
          />
        </>
      )}
      {step?.op === 'pdf.compress' && (
        <Choice<Strength>
          label="Strength"
          value={step.settings.strength}
          options={[{ value: 'light', label: 'Light' }, { value: 'balanced', label: 'Balanced' }, { value: 'strong', label: 'Strong' }]}
          onChange={(strength) => onChange({ ...step, settings: { strength } })}
          hint={STRENGTH_HINT[step.settings.strength]}
        />
      )}
      {step?.op === 'sheet.convert' && (
        <>
          <Choice<SheetFormat>
            label="Convert to"
            value={step.settings.to}
            options={(['csv', 'json', 'xlsx'] as const).filter((f) => f !== kind).map((f) => ({ value: f, label: SHEET_LABEL[f] }))}
            onChange={(to) => onChange({ ...step, settings: { ...step.settings, to } })}
          />
          {props.sheets && props.sheets.length > 1 && (
            <SheetPicker sheets={props.sheets} value={step.settings.sheet ?? props.sheets[0]!} onChange={(sheet) => onChange({ ...step, settings: { ...step.settings, sheet } })} />
          )}
        </>
      )}
    </div>
  )
}

function SheetPicker({ sheets, value, onChange }: { sheets: string[]; value: string; onChange: (sheet: string) => void }) {
  const id = useId()
  return (
    <div className="grid gap-2 @lg:grid-cols-[7rem_1fr] @lg:gap-x-6">
      <label htmlFor={id} className="text-muted @lg:pt-1.5">Sheet</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="w-full max-w-xs rounded-md border border-line bg-field px-3 py-1.5">
        {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  )
}
