import { useId, useRef, useState } from 'react'
import { DEFAULT_QUALITY, FORMAT_LABEL, IMAGE_FORMATS, fitWithin, type ImageFormat, type ImageSettings, type Step } from '../core/ops'

const FORMAT_HINT: Record<ImageFormat, string> = {
  jpeg: 'Opens everywhere. Best for photos.',
  webp: 'Smaller than JPG at the same quality. Works in every modern browser.',
  avif: 'Smallest files. Slower to create, and some older apps can’t open it.',
  png: 'Lossless and supports transparency. Larger files.',
}

interface ChoiceProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  hint?: string
}

function Choice<T extends string>({ label, value, options, onChange, hint }: ChoiceProps<T>) {
  const id = useId()
  return (
    <div className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:gap-x-6">
      <span id={id} className="pt-1.5 text-muted">{label}</span>
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
        <div className="mt-3 sm:ml-[calc(7rem+1.5rem)]">
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

export function Options({ step, onChange, canScrub, dims }: { step: Step; onChange: (s: Step) => void; canScrub: boolean; dims?: { width: number; height: number } }) {
  // Remember convert settings while the user flips to "remove hidden data only" and back.
  const last = useRef<ImageSettings>({ format: 'jpeg', quality: DEFAULT_QUALITY.jpeg, maxSide: null })
  if (step.op === 'image.convert') last.current = step.settings
  const s = last.current
  const convert = (patch: Partial<ImageSettings>) => onChange({ op: 'image.convert', settings: { ...s, ...patch } })
  const qualityId = useId()

  return (
    <div className="space-y-6">
      {canScrub && (
        <Choice
          label="Task"
          value={step.op}
          options={[{ value: 'image.convert', label: 'Convert or shrink' }, { value: 'image.scrub', label: 'Only remove hidden data' }]}
          onChange={(op) => (op === 'image.scrub' ? onChange({ op }) : convert({}))}
          hint={step.op === 'image.scrub' ? 'Removes location, camera details and other hidden data. Every pixel stays exactly as it is.' : undefined}
        />
      )}
      {step.op === 'image.convert' && (
        <>
          <Choice
            label="Format"
            value={s.format}
            options={IMAGE_FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
            onChange={(format) => convert({ format, quality: DEFAULT_QUALITY[format] })}
            hint={`${FORMAT_HINT[s.format]} Hidden data like location is always removed.`}
          />
          <SizeChoice value={s.maxSide} dims={dims} onChange={(maxSide) => convert({ maxSide })} />
          {s.format !== 'png' && (
            <div className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:gap-x-6">
              <label htmlFor={qualityId} className="text-muted">Quality</label>
              <div>
                <div className="flex items-center gap-4">
                  <input id={qualityId} type="range" min={1} max={100} value={s.quality} onChange={(e) => convert({ quality: Number(e.target.value) })} className="w-full max-w-sm accent-jade" />
                  <output htmlFor={qualityId} className="w-8 font-medium tabular-nums">{s.quality}</output>
                </div>
                <p className="mt-2 text-sm text-muted">Lower makes smaller files. Most photos look unchanged from about {s.format === 'avif' ? 50 : 75}.</p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
