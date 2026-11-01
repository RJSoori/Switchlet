// Markdown ↔ HTML. Runs on the main thread because DOMPurify and turndown need a DOM; inputs are
// capped at 5 MB (LIMITS.bytes.doc), and these conversions take milliseconds.
// Every HTML string is sanitized with DOMPurify before anything else touches it.
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import TurndownService from 'turndown'
import type { Kind } from '../core/detect'
import { stem, type TaskResult } from '../core/ops'

const HTML_ONLY = { USE_PROFILES: { html: true } }

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function markdownToHtml(markdown: string, title: string): { document: string; body: string } {
  const body = DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }), HTML_ONLY)
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>
`
  return { document, body }
}

export function htmlToMarkdown(html: string): string {
  const clean = DOMPurify.sanitize(html, { ...HTML_ONLY, FORBID_TAGS: ['style'] })
  return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' }).turndown(clean)
}

/**
 * HTML for display inside Switchlet: no styles, forms, media or remote images (an image would be a
 * request to someone else's server, and the security policy blocks it anyway), and links open in a new tab.
 */
export function previewFragment(html: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, {
    ...HTML_ONLY,
    FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'track', 'picture', 'dialog'],
    FORBID_ATTR: ['style', 'class', 'id', 'background'],
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  })
  for (const img of fragment.querySelectorAll('img')) {
    img.replaceWith(fragment.ownerDocument.createTextNode(`[Image${img.alt ? `: ${img.alt}` : ''}]`))
  }
  for (const a of fragment.querySelectorAll('a')) {
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  }
  return fragment
}

const encode = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

export async function convertDoc(file: File, kind: Kind): Promise<TaskResult> {
  const text = await file.text()
  if (kind === 'html') {
    const markdown = htmlToMarkdown(text)
    return { files: [{ name: `${stem(file.name)}.md`, data: encode(markdown), type: 'text/markdown' }], previewText: markdown.slice(0, 3000) }
  }
  const { document, body } = markdownToHtml(text, stem(file.name))
  return {
    files: [{ name: `${stem(file.name)}.html`, data: encode(document), type: 'text/html' }],
    previewHtml: body,
    note: 'Scripts and other unsafe HTML were removed.',
  }
}
