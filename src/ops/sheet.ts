// CSV ↔ JSON ↔ XLSX with SheetJS. Runs inside the worker.
import * as XLSX from 'xlsx'
import { stem, type InFile, type SheetFormat, type TaskResult } from '../core/ops'
import { DecodeError, NoticeError } from './errors'

const TYPE: Record<SheetFormat, string> = {
  csv: 'text/csv',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Nested values become JSON text so they survive in a cell instead of turning into "[object Object]". */
const flatCell = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

function readWorkbook(f: InFile): XLSX.WorkBook {
  const text = () => new TextDecoder('utf-8').decode(f.bytes)
  if (f.kind === 'json') {
    let data: unknown
    try {
      data = JSON.parse(text())
    } catch {
      throw new NoticeError('This JSON file has a syntax error, so it can’t become a table. Check it in a text editor, then try again.')
    }
    const listHint = 'To become a table, the JSON must be a list of rows, like [{"name": "Ada", "age": 36}, …].'
    if (!Array.isArray(data) || !data.length) throw new NoticeError(listHint)
    const ws = data.every(Array.isArray)
      ? XLSX.utils.aoa_to_sheet(data.map((row: unknown[]) => row.map(flatCell)))
      : data.every(isRecord)
        ? XLSX.utils.json_to_sheet(data.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, flatCell(v)]))))
        : null
    if (!ws) throw new NoticeError(listHint)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    return wb
  }
  try {
    return f.kind === 'csv' ? XLSX.read(text(), { type: 'string', dense: true }) : XLSX.read(f.bytes, { type: 'array', dense: true })
  } catch {
    throw new DecodeError('This spreadsheet couldn’t be read. It may be damaged, or saved in a format Switchlet doesn’t support.')
  }
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N}_ -]+/gu, '-').trim() || 'sheet'
const encode = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

export function convertSheet(f: InFile, to: SheetFormat, sheetName: string | null): TaskResult {
  const wb = readWorkbook(f)
  const sheets = wb.SheetNames
  const sheet = sheetName && sheets.includes(sheetName) ? sheetName : sheets[0]
  const ws = sheet ? wb.Sheets[sheet] : undefined
  if (!sheet || !ws) throw new NoticeError('This workbook has no sheets to convert.')

  const base = sheets.length > 1 ? `${stem(f.name)}-${safeName(sheet)}` : stem(f.name)
  const csv = XLSX.utils.sheet_to_csv(ws)
  let data: ArrayBuffer
  let preview = csv
  if (to === 'csv') data = encode(csv)
  else if (to === 'json') {
    preview = JSON.stringify(XLSX.utils.sheet_to_json(ws, { defval: null }), null, 2)
    data = encode(preview)
  } else {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, ws, sheet.slice(0, 31))
    data = XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer
  }
  const rows = csv ? csv.split('\n').length - 1 : 0
  return {
    files: [{ name: `${base}.${to}`, data, type: TYPE[to] }],
    sheets: sheets.length > 1 ? sheets : undefined,
    previewText: preview.slice(0, 3000),
    note: `${rows} ${rows === 1 ? 'row' : 'rows'}${sheets.length > 1 ? ` from the sheet “${sheet}”` : ''}.`,
  }
}
