import { useEffect, useRef, useState } from 'react'
import type { Job, Output } from '../App'
import { formatBytes } from '../core/detect'
import { etaSeconds, zipBlobs } from '../core/jobs'
import type { MetadataReport } from '../core/ops'
import { download, percent, useObjectUrl } from './hooks'

export function sizeChange(before: number, after: number): string {
  const delta = after / before - 1
  if (Math.abs(delta) < 0.005) return 'About the same size'
  return delta < 0 ? `${percent(-delta)} smaller` : `${percent(delta)} larger than the original`
}

const primary = 'inline-flex items-center rounded-lg bg-jade px-5 py-3 font-semibold text-on-jade hover:brightness-110'

/** Progress, error and cancelled states for a job, with cancel and retry. */
export function JobStatus({ job, onCancel, onRetry }: { job: Job; onCancel: () => void; onRetry: () => void }) {
  const eta = job.startedAt !== undefined ? etaSeconds(job.startedAt, job.progress) : null
  if (job.status === 'running') {
    return (
      <div className="space-y-2" role="status">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p>
            {job.stage}… <span className="tabular-nums">{percent(job.progress)}</span>
            {eta !== null && <span className="text-muted"> about {eta} s left</span>}
          </p>
          <button type="button" onClick={onCancel} className="rounded-md border border-line px-3 py-1 hover:border-ink">Cancel</button>
        </div>
        <div className="h-1.5 max-w-md overflow-hidden rounded-full bg-rule"><div className="h-full bg-jade transition-[width]" style={{ width: percent(job.progress) }} /></div>
      </div>
    )
  }
  if (job.status === 'error') {
    return <div role="alert" className="rounded-lg border border-danger/40 p-4"><p className="text-danger">{job.error}</p></div>
  }
  if (job.status === 'cancelled') {
    return (
      <p>
        Cancelled.{' '}
        <button type="button" onClick={onRetry} className="text-jade underline underline-offset-4">Run it again</button>
      </p>
    )
  }
  return null
}

function FileLink({ file }: { file: { blob: Blob; name: string } }) {
  const url = useObjectUrl(file.blob)
  return (
    <li className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="shrink-0 text-sm text-muted tabular-nums">{formatBytes(file.blob.size)}</span>
      {url && <a href={url} download={file.name} className="shrink-0 text-jade underline underline-offset-4">Download</a>}
    </li>
  )
}

function SingleDownload({ file, inputSize }: { file: { blob: Blob; name: string }; inputSize?: number }) {
  const url = useObjectUrl(file.blob)
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div>
        {inputSize !== undefined ? (
          <>
            <p className="text-2xl tabular-nums">
              {formatBytes(inputSize)} <span className="text-muted">to</span> <strong className="font-semibold">{formatBytes(file.blob.size)}</strong>
            </p>
            <p className="text-muted">{sizeChange(inputSize, file.blob.size)}</p>
          </>
        ) : (
          <p className="text-2xl tabular-nums">{formatBytes(file.blob.size)}</p>
        )}
      </div>
      {url && <a href={url} download={file.name} className={primary}>Download {file.name}</a>}
    </div>
  )
}

const SHOWN = 50

export function Downloads({ output, inputSize, zipName }: { output: Output; inputSize?: number; zipName: string }) {
  const [zipping, setZipping] = useState(false)
  const { files } = output
  if (!files.length) return null
  if (files.length === 1) return <SingleDownload file={files[0]!} inputSize={inputSize} />
  const total = files.reduce((n, f) => n + f.blob.size, 0)
  const saveZip = async () => {
    setZipping(true)
    try {
      download(await zipBlobs(files), zipName)
    } finally {
      setZipping(false)
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <p className="text-2xl tabular-nums">{files.length} files, <span className="text-muted">{formatBytes(total)}</span></p>
        <button type="button" onClick={saveZip} disabled={zipping} className={`${primary} disabled:opacity-60`}>
          {zipping ? 'Making ZIP…' : 'Download all as ZIP'}
        </button>
      </div>
      <ul className="divide-y divide-rule border-y border-rule">
        {files.slice(0, SHOWN).map((f) => <FileLink key={f.name} file={f} />)}
      </ul>
      {files.length > SHOWN && <p className="text-sm text-muted">And {files.length - SHOWN} more in the ZIP.</p>}
    </div>
  )
}

export function Report({ report }: { report?: MetadataReport }) {
  if (!report) return null
  if (!report.found.length && !report.removed.length) {
    return (
      <section>
        <p className="text-muted">No hidden data found in this file.</p>
        {report.kept.length > 0 && <p className="mt-1 text-sm text-muted">Kept: {report.kept.join('; ')}.</p>}
      </section>
    )
  }
  return (
    <section aria-labelledby="report-title">
      <h3 id="report-title" className="font-medium">Hidden data removed from the new copy</h3>
      {report.found.length > 0 && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          {report.found.map((f, i) => (
            <div key={i} className="contents">
              <dt className="text-muted">{f.label}</dt>
              <dd className="break-words">{f.detail}</dd>
            </div>
          ))}
        </dl>
      )}
      {report.removed.length > 0 && <p className="mt-3 text-sm text-muted">Removed: {report.removed.join(', ')}.</p>}
      {report.kept.length > 0 && <p className="mt-1 text-sm text-muted">Kept: {report.kept.join('; ')}.</p>}
    </section>
  )
}

/** Sanitized HTML (see ops/docs previewFragment), inserted as DOM nodes rather than an HTML string. */
function HtmlPreview({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    void import('../ops/docs').then(({ previewFragment }) => {
      if (live) ref.current?.replaceChildren(previewFragment(html))
    })
    return () => { live = false }
  }, [html])
  return <div ref={ref} className="doc-preview max-h-[32rem] overflow-auto rounded-xl border border-rule bg-field p-6" />
}

export function Previews({ output }: { output: Output }) {
  return (
    <>
      {output.previewHtml && (
        <section aria-label="Preview">
          <h3 className="mb-2 text-sm text-muted">Preview (images and styles from other sites aren’t loaded)</h3>
          <HtmlPreview html={output.previewHtml} />
        </section>
      )}
      {output.previewText && (
        <section aria-label="Preview">
          <h3 className="mb-2 text-sm text-muted">Start of the new file</h3>
          <pre className="max-h-80 overflow-auto rounded-xl border border-rule bg-field p-4 font-mono text-sm whitespace-pre-wrap">{output.previewText}</pre>
        </section>
      )}
    </>
  )
}

/** A player (or image) for a single audio, video or GIF result, so it can be checked before downloading. */
function OutputPreview({ file }: { file: { blob: Blob; name: string } }) {
  const url = useObjectUrl(file.blob)
  const type = file.blob.type
  if (!url) return null
  if (type.startsWith('video/')) return <video src={url} controls className="max-h-[50vh] w-full rounded-xl border border-rule" aria-label={`Preview of ${file.name}`} />
  if (type.startsWith('audio/')) return <audio src={url} controls className="w-full" aria-label={`Preview of ${file.name}`} />
  if (type === 'image/gif') return <img src={url} alt={`Preview of ${file.name}`} className="max-h-[50vh] rounded-xl border border-rule" />
  return null
}

/** The result area for every task except single-image conversions (which have the before/after view). */
export function JobResult({ job, inputSize, zipName, onCancel, onRetry }: { job: Job; inputSize?: number; zipName: string; onCancel: () => void; onRetry: () => void }) {
  const out = job.output
  return (
    <div className="space-y-6">
      <JobStatus job={job} onCancel={onCancel} onRetry={onRetry} />
      {out && (
        <div className={`space-y-6 transition-opacity ${job.status === 'running' ? 'opacity-60' : ''}`}>
          {out.note && <p className="text-muted">{out.note}</p>}
          <Downloads output={out} inputSize={out.files.length === 1 ? inputSize : undefined} zipName={zipName} />
          {out.files.length === 1 && <OutputPreview file={out.files[0]!} />}
          <Report report={out.report} />
          <Previews output={out} />
        </div>
      )}
    </div>
  )
}
