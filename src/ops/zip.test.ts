import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { uniqueNames, zipFiles } from './zip'

describe('zip', () => {
  it('makes entry names unique (case-insensitively) and path-free', () => {
    expect(uniqueNames(['a.jpg', 'A.jpg', 'a.jpg', '../../etc/passwd', 'x\u0000y.png', '', '...'])).toEqual([
      'a.jpg', 'A (2).jpg', 'a (3).jpg', '_.._etc_passwd', 'x_y.png', 'file', 'file (2)',
    ])
  })
  it('round-trips file contents', () => {
    const zipped = zipFiles([
      { name: 'one.jpg', data: new Uint8Array([1, 2, 3]) },
      { name: 'one.jpg', data: new Uint8Array([4, 5]) },
    ])
    const out = unzipSync(zipped)
    expect(Object.keys(out)).toEqual(['one.jpg', 'one (2).jpg'])
    expect([...out['one (2).jpg']!]).toEqual([4, 5])
  })
})
