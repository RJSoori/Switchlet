import { describe, expect, it } from 'vitest'
import { CATEGORIES, CATEGORY_OF, describeGroup, kindFromMime, route, tasksIn, type Entry } from './categories'
import { KINDS, detect, type Kind } from './detect'
import { OPS, opsFor } from './ops'

const ok = (...kinds: Kind[]): Entry[] => kinds.map((kind) => ({ kind, problem: null }))

describe('Kind → category map', () => {
  it('covers every Kind detect() can return, and agrees with the task list', () => {
    for (const kind of KINDS) {
      expect(Object.hasOwn(CATEGORY_OF, kind), `${kind} has no category`).toBe(true)
      const home = CATEGORY_OF[kind]
      // A kind with tasks must have a home screen, and that screen must offer one of them; a kind without tasks has none.
      if (opsFor([kind]).length) expect(home && tasksIn(home, [kind]).length, `${kind} can't be opened on its screen`).toBeTruthy()
      else expect(home, `${kind} has no tasks but a category`).toBeNull()
    }
  })

  it('puts every task on at least one screen', () => {
    const onScreens = new Set(CATEGORIES.flatMap((c) => c.tasks))
    for (const op of Object.keys(OPS)) expect(onScreens.has(op as never), op).toBe(true)
  })
})

describe('route: context first', () => {
  it('keeps images dropped on PDF there, with Images to PDF selected', () => {
    expect(route(ok('jpeg', 'png'), 'pdf')).toMatchObject({ open: 'pdf', take: [0, 1], op: 'image.toPdf', others: [] })
  })

  it('sends a video dropped on Images to Video and audio', () => {
    expect(route(ok('mp4'), 'images')).toMatchObject({ open: 'media', op: 'video.convert' })
  })

  it('stays on the current screen for its own kind and picks the default task', () => {
    expect(route(ok('pdf', 'pdf'), 'pdf')).toMatchObject({ open: 'pdf', op: 'pdf.merge' })
    expect(route(ok('pdf'), 'pdf')).toMatchObject({ open: 'pdf', op: null }) // one PDF: the person chooses
  })

  it('opens the home screen from the landing page', () => {
    expect(route(ok('png'), null)).toMatchObject({ open: 'images', op: 'image.convert' })
    expect(route(ok('pdf'), null)).toMatchObject({ open: 'pdf' })
    expect(route(ok('csv'), null)).toMatchObject({ open: 'sheets', op: 'sheet.convert' })
    expect(route(ok('mp4'), null)).toMatchObject({ open: 'media', op: 'video.convert' })
  })

  it('does not keep a CSV in Docs', () => {
    expect(route(ok('csv'), 'docs').open).toBe('sheets')
  })
})

describe('route: mixed drops', () => {
  it('opens the largest group and lists the others, never mixing kinds in one job', () => {
    const r = route(ok('jpeg', 'pdf', 'png', 'heic'), null)
    expect(r).toMatchObject({ open: 'images', take: [0, 2, 3], op: 'image.convert', others: [{ category: 'pdf', take: [1] }] })
  })

  it('orders the other groups by size, then rail order', () => {
    const r = route(ok('csv', 'mp4', 'pdf', 'mp4', 'pdf', 'pdf'), null)
    expect(r.open).toBe('pdf')
    expect(r.others.map((g) => g.category)).toEqual(['media', 'sheets'])
    expect(route(ok('csv', 'pdf'), null).open).toBe('pdf') // tie: PDF comes before Sheets on the rail
  })

  it('prefers the current screen on a tie', () => {
    expect(route(ok('csv', 'pdf'), 'sheets')).toMatchObject({ open: 'sheets', others: [{ category: 'pdf' }] })
  })

  it('keeps the current kind on its screen and sends the context group home when both arrive', () => {
    // On PDF, 3 photos + 1 PDF: PDF has its own file, so the photos go to Images (the larger group opens).
    const r = route(ok('jpeg', 'jpeg', 'jpeg', 'pdf'), 'pdf')
    expect(r).toMatchObject({ open: 'images', op: 'image.convert', others: [{ category: 'pdf', take: [3] }] })
  })
})

describe('route: files that can’t be opened', () => {
  it('opens the supported files and rejects the rest', () => {
    const r = route([{ kind: 'zip', problem: null }, { kind: 'png', problem: null }], 'pdf')
    expect(r).toMatchObject({ open: 'pdf', take: [1], op: 'image.toPdf', rejected: [0] })
  })

  it('stays put when nothing can be opened', () => {
    expect(route([{ kind: 'unknown', problem: null }, { kind: 'svg', problem: null }], 'images')).toMatchObject({ open: null, take: [], rejected: [0, 1] })
  })

  it('rejects a supported kind that is over a limit', () => {
    expect(route([{ kind: 'pdf', problem: 'too big' }], null)).toMatchObject({ open: null, rejected: [0] })
  })
})

it('routes a renamed file by its content: photo.pdf that is really a JPEG opens in Images', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
  const d = detect(jpeg, 'photo.pdf')
  expect(d.kind).toBe('jpeg')
  expect(route([{ kind: d.kind, problem: null }], null).open).toBe('images')
})

it('describes groups for chips', () => {
  expect(describeGroup('pdf', 1)).toBe('1 PDF')
  expect(describeGroup('images', 3)).toBe('3 photos')
})

it('guesses a kind from a drag MIME type for the overlay hint only', () => {
  expect(kindFromMime('application/pdf')).toBe('pdf')
  expect(kindFromMime('image/x-unknown')).toBe('png')
  expect(kindFromMime('image/svg+xml')).toBe('svg')
  expect(kindFromMime('')).toBeNull()
  expect(kindFromMime('application/x-msdownload')).toBe('unknown')
})
