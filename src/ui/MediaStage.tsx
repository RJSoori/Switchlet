import { useEffect, useId, useRef, useState } from 'react'
import type { Item } from '../App'
import { AUDIO_KINDS, formatTime, type Clip, type Step } from '../core/ops'
import { useObjectUrl } from './hooks'

const RUN_LABEL: Record<string, string> = { 'video.convert': 'Convert video', 'video.trim': 'Trim video', 'video.gif': 'Make GIF' }

/** The button that runs an audio/video task (they never run on every settings change). */
export function RunMedia({ item, step, onRun, stale }: { item: Item; step: Step; onRun: () => void; stale: boolean }) {
  const isAudio = AUDIO_KINDS.includes(item.detected.kind)
  const label = step.op === 'media.audio' ? (isAudio ? 'Convert audio' : 'Save the audio') : RUN_LABEL[step.op] ?? 'Convert'
  const running = item.status === 'running'
  // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => { if (!running) onRun() }}
        aria-disabled={running}
        className={stale ? 'rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade hover:brightness-110 aria-disabled:opacity-60' : 'rounded-lg border border-line px-5 py-3 font-semibold hover:border-ink aria-disabled:opacity-60'}
      >
        {item.output && !stale ? `${label} again` : label}
      </button>
      {item.output && stale && item.status !== 'running' && <p className="text-sm text-muted">Settings changed since the last run.</p>}
    </div>
  )
}

/** The dropped recording in a native player, with start/end controls for trim and GIF. */
export function MediaStage({ item, step, onClip }: { item: Item; step: Step; onClip: (clip: Clip) => void }) {
  const url = useObjectUrl(item.file)
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [unplayable, setUnplayable] = useState(false)
  const isAudio = AUDIO_KINDS.includes(item.detected.kind)
  const clip = step.op === 'video.trim' || step.op === 'video.gif' ? step.settings : null

  const playerProps = {
    ref: player,
    src: url,
    controls: true,
    preload: 'metadata' as const,
    onLoadedMetadata: () => setDuration(Number.isFinite(player.current?.duration) ? player.current!.duration : null),
    onError: () => setUnplayable(true),
  }

  return (
    <div className="space-y-5">
      {isAudio ? (
        <audio {...playerProps} className="w-full" aria-label={`Preview of ${item.file.name}`} />
      ) : (
        <video {...playerProps} className="max-h-[60vh] w-full rounded-xl border border-rule bg-ink/5" aria-label={`Preview of ${item.file.name}`} />
      )}
      {unplayable && <p className="text-sm text-muted">This browser can’t preview the file, but it may still be able to convert it.</p>}
      {clip && <ClipControls clip={clip} duration={duration} onChange={onClip} current={() => player.current?.currentTime ?? 0} />}
    </div>
  )
}

function ClipControls({ clip, duration, onChange, current }: { clip: Clip; duration: number | null; onChange: (c: Clip) => void; current: () => number }) {
  const end = clip.end ?? duration ?? 0
  const round = (n: number) => Math.round(n * 10) / 10
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="sr-only">Part of the recording to use</legend>
      <TimeField label="Start" value={clip.start} max={duration} onChange={(start) => onChange({ ...clip, start })} onNow={() => onChange({ ...clip, start: round(current()) })} />
      <TimeField label="End" value={end} max={duration} onChange={(e) => onChange({ ...clip, end: duration !== null && e >= duration ? null : e })} onNow={() => onChange({ ...clip, end: round(current()) })} />
      <p className="text-sm text-muted sm:col-span-2" aria-live="polite">
        {duration !== null && `Keeps ${formatTime(Math.max(0, end - clip.start))} of ${formatTime(duration)}. Play the recording and use “Set to now” to mark a point.`}
      </p>
    </fieldset>
  )
}

function TimeField({ label, value, max, onChange, onNow }: { label: string; value: number; max: number | null; onChange: (v: number) => void; onNow: () => void }) {
  const id = useId()
  const shown = (v: number) => String(Math.round(v * 100) / 100)
  const [text, setText] = useState(shown(value))
  useEffect(() => setText(shown(value)), [value])
  return (
    <div>
      <label htmlFor={id} className="text-muted">{label} <span className="text-sm">(seconds)</span></label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          max={max ?? undefined}
          step={0.1}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            const n = Number(e.target.value)
            if (e.target.value !== '' && Number.isFinite(n) && n >= 0) onChange(n)
          }}
          className="w-28 rounded-md border border-line bg-field px-3 py-1.5 tabular-nums"
        />
        <span className="w-14 text-sm text-muted tabular-nums">{formatTime(value)}</span>
        <button type="button" onClick={onNow} className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-ink">Set to now</button>
      </div>
    </div>
  )
}
