import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from '@shared/hrImport'
import { unzip, ZipLimitError } from '../export/xlsxWriter'

// Чтение таблицы для импорта: CSV (UTF-8 или Windows-1251, разделитель «;», «,» или табуляция)
// и .xlsx (первый лист). Без сторонних пакетов: .xlsx — это zip с XML, читаем общие строки и ячейки.

/**
 * lines — номер строки в файле для каждой строки данных (как в Excel), чтобы отчёт об импорте
 * ссылался на те же строки. skipped — итоговые строки вроде «Всего откликов: 46», не данные.
 */
export type Table = { headers: string[]; rows: string[][]; lines: number[]; skipped: { line: number; reason: string }[] }

export class ImportError extends Error {}

export function parseTable(file: Buffer, name: string): Table {
  if (file.length > IMPORT_MAX_BYTES) throw new ImportError('Файл больше 5 МБ. Раздели выгрузку на части')
  if (!file.length) throw new ImportError('Файл пустой')
  const isZip = file[0] === 0x50 && file[1] === 0x4b
  let rows: { line: number; cells: string[] }[]
  if (isZip) rows = readXlsx(file)
  else if (/\.xls$/i.test(name) || file.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
    throw new ImportError('Старый формат .xls не поддерживается. Открой файл в Excel и сохрани как .xlsx или .csv')
  else rows = readCsv(decodeText(file)).map((cells, i) => ({ line: i + 1, cells }))

  // Шапка — первая строка, где заполнено хотя бы две ячейки (над ней в выгрузках бывает заголовок отчёта)
  const headerAt = rows.findIndex((r) => r.cells.filter((c) => c.trim()).length >= 2)
  if (headerAt < 0) throw new ImportError('Не нашли в файле таблицу с заголовками колонок')
  const headers = rows[headerAt].cells.map((h) => h.trim())
  const skipped: Table['skipped'] = []
  const body = rows.slice(headerAt + 1).filter((r) => {
    const filled = r.cells.filter((c) => c.trim())
    if (!filled.length) return false
    // «Всего откликов: 46», «Итого» — подпись под таблицей, не кандидат
    if (filled.length === 1 && /^(всего|итого)(\s|:|$)/i.test(filled[0].trim())) {
      skipped.push({ line: r.line, reason: `итоговая строка «${filled[0].trim().slice(0, 40)}»` })
      return false
    }
    return true
  })
  if (body.length > IMPORT_MAX_ROWS) throw new ImportError(`В файле ${body.length} строк — за раз можно не больше ${IMPORT_MAX_ROWS}`)
  return { headers, rows: body.map((r) => headers.map((_, i) => (r.cells[i] ?? '').trim())), lines: body.map((r) => r.line), skipped }
}

/** UTF-8, а если байты в нём невозможны — Windows-1251 (так сохраняет русский Excel) */
function decodeText(file: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1251').decode(file)
  }
}

/** CSV по RFC 4180: кавычки, переносы строк внутри кавычек, «""» внутри значения */
export function readCsv(text: string): string[][] {
  const nl = text.search(/\r?\n/)
  const firstLine = nl < 0 ? text : text.slice(0, nl)
  const delimiter = [';', ',', '\t'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entities[e] ?? m),
  )

/** Текст из <t>…</t>, в том числе из «богатого» текста с несколькими кусками <r><t> */
const textOf = (xml: string) => unescapeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''))

/** B12 → 1 (номер колонки с нуля) */
const columnIndex = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

function readXlsx(file: Buffer): { line: number; cells: string[] }[] {
  let files: Map<string, Buffer>
  try {
    files = unzip(file)
  } catch (e) {
    if (e instanceof ZipLimitError) throw new ImportError('Файл слишком большой после распаковки — это не похоже на выгрузку откликов. Сохрани таблицу заново или загрузи CSV')
    throw new ImportError('Файл повреждён или это не таблица Excel')
  }
  const read = (path: string) => files.get(path)?.toString('utf8') ?? ''

  // Первый лист: workbook.xml → r:id → путь в workbook.xml.rels
  const workbook = read('xl/workbook.xml')
  const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1]
  const rels = read('xl/_rels/workbook.xml.rels')
  const target = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map((m) => ({ id: /\bId="([^"]+)"/.exec(m[1])?.[1], target: /\bTarget="([^"]+)"/.exec(m[1])?.[1] }))
    .find((r) => r.id === firstSheet)?.target
  const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : 'xl/worksheets/sheet1.xml'
  const sheet = read(sheetPath) || read('xl/worksheets/sheet1.xml')
  if (!sheet) throw new ImportError('В файле Excel не нашли лист с данными')

  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))

  const rows: { line: number; cells: string[] }[] = []
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const row: string[] = []
    const line = Number(/\br="(\d+)"/.exec(rowMatch[1])?.[1]) || rows.length + 1
    for (const c of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]
      const inner = c[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /\bt="(\w+)"/.exec(attrs)?.[1]
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ''
      let value = ''
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = textOf(inner)
      else if (type === 'b') value = v === '1' ? 'да' : 'нет'
      else value = unescapeXml(v)
      const at = ref ? columnIndex(ref) : row.length
      while (row.length < at) row.push('')
      row[at] = value
    }
    rows.push({ line, cells: row })
  }
  return rows
}
