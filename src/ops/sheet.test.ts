import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import type { InFile } from '../core/ops'
import { DecodeError, NoticeError } from './errors'
import { convertSheet } from './sheet'

const textFile = (s: string, kind: 'csv' | 'json', name = `people.${kind}`): InFile => ({ name, kind, bytes: new TextEncoder().encode(s) as Uint8Array<ArrayBuffer> })
const read = (data: ArrayBuffer) => new TextDecoder().decode(data)

describe('sheets', () => {
  it('turns CSV into JSON rows with typed values', () => {
    const r = convertSheet(textFile('name,age\nAda,36\nAlan,41\n', 'csv'), 'json', null)
    expect(r.files[0]!.name).toBe('people.json')
    expect(JSON.parse(read(r.files[0]!.data))).toEqual([{ name: 'Ada', age: 36 }, { name: 'Alan', age: 41 }])
    expect(r.note).toBe('2 rows.')
  })

  it('round-trips CSV through XLSX', () => {
    const xlsx = convertSheet(textFile('city,pop\nKöln,1084831\n', 'csv'), 'xlsx', null).files[0]!
    expect(xlsx.name).toBe('people.xlsx')
    const back = convertSheet({ name: 'people.xlsx', kind: 'xlsx', bytes: new Uint8Array(xlsx.data) }, 'csv', null)
    expect(read(back.files[0]!.data).trim()).toBe('city,pop\nKöln,1084831')
  })

  it('turns a JSON list into CSV, keeping nested values as JSON text', () => {
    const r = convertSheet(textFile('[{"a":1,"b":{"c":2}},{"a":3,"b":null}]', 'json'), 'csv', null)
    expect(read(r.files[0]!.data).trim()).toBe('a,b\n1,"{""c"":2}"\n3,')
  })

  it('explains JSON that cannot become a table', () => {
    expect(() => convertSheet(textFile('{"broken": ', 'json'), 'csv', null)).toThrow(/syntax error/)
    expect(() => convertSheet(textFile('{"a": 1}', 'json'), 'csv', null)).toThrow(NoticeError)
    expect(() => convertSheet(textFile('[1, 2]', 'json'), 'csv', null)).toThrow(/list of rows/)
  })

  it('lets the user pick a sheet from a workbook with several', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x'], [1]]), 'First')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['y'], [2]]), 'Q3 sales & more')
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    const r = convertSheet({ name: 'book.xlsx', kind: 'xlsx', bytes }, 'csv', 'Q3 sales & more')
    expect(r.sheets).toEqual(['First', 'Q3 sales & more'])
    expect(r.files[0]!.name).toBe('book-Q3 sales - more.csv')
    expect(read(r.files[0]!.data).trim()).toBe('y\n2')
    expect(convertSheet({ name: 'book.xlsx', kind: 'xlsx', bytes }, 'csv', 'missing').files[0]!.name).toBe('book-First.csv')
  })

  it('rejects a damaged workbook', () => {
    const junk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode('xl/ garbage')])
    expect(() => convertSheet({ name: 'bad.xlsx', kind: 'xlsx', bytes: junk }, 'csv', null)).toThrow(DecodeError)
  })
})
