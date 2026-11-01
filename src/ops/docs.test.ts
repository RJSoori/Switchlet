// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, markdownToHtml, previewFragment } from './docs'

const hostile = [
  '# Title',
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(2)">',
  '[click](javascript:alert(3))',
  '<iframe src="https://evil.example"></iframe>',
  '<svg><script>alert(4)</script></svg>',
].join('\n\n')

describe('Markdown to HTML', () => {
  it('produces a complete, sanitized document', () => {
    const { document, body } = markdownToHtml(hostile, 'notes <draft>')
    expect(document).toMatch(/^<!doctype html>/)
    expect(document).toContain('<title>notes &#60;draft&#62;</title>')
    expect(body).toContain('<h1>Title</h1>')
    for (const bad of ['<script', 'onerror', 'javascript:', '<iframe', '<svg']) expect(body).not.toContain(bad)
  })

  it('supports GitHub-style tables', () => {
    expect(markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |', 't').body).toContain('<table>')
  })
})

describe('HTML to Markdown', () => {
  it('converts structure and drops scripts and styles', () => {
    const md = htmlToMarkdown('<h1>T</h1><p>Hi <b>there</b></p><ul><li>a</li></ul><script>bad()</script><style>p{}</style>')
    expect(md).toContain('# T')
    expect(md).toContain('**there**')
    expect(md).toMatch(/-\s+a/)
    expect(md).not.toContain('bad()')
    expect(md).not.toContain('p{}')
  })
})

describe('preview inside Switchlet', () => {
  it('never loads remote images, styles or forms, and opens links in a new tab', () => {
    const frag = previewFragment('<p style="color:red" id="x">Hi</p><img src="https://tracker.example/p.gif" alt="logo"><style>body{display:none}</style><form action="https://x"><input></form><a href="https://example.com">site</a>')
    const div = document.createElement('div')
    div.append(frag)
    expect(div.querySelector('img, style, form, input')).toBeNull()
    expect(div.textContent).toContain('[Image: logo]')
    expect(div.querySelector('p')!.getAttribute('style')).toBeNull()
    expect(div.querySelector('p')!.id).toBe('')
    const a = div.querySelector('a')!
    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noopener noreferrer')
  })
})
