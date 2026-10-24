import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

// Запись .xlsx без сторонних пакетов. Нам нужна только запись таблиц: шапка, ширина колонок,
// закреплённые строки, автофильтр, даты, проценты, жирный шрифт и заливки. Файл — zip с XML внутри,
// его открывают Excel, LibreOffice и Яндекс Документы.

export type CellValue = string | number | boolean | Date | null | undefined

export type CellStyle = {
  bold?: boolean
  /** ARGB, например FFFFFFFF */
  color?: string
  size?: number
  /** Сплошная заливка, ARGB */
  fill?: string
  /** Формат числа или даты: 'dd.mm.yyyy hh:mm', '0%' */
  numFmt?: string
  wrap?: boolean
  valign?: 'top' | 'center'
}

export type SheetRow = {
  cells: CellValue[]
  /** Стиль всей строки; стиль ячейки дополняет его */
  style?: CellStyle
  cellStyles?: (CellStyle | undefined)[]
  height?: number
}

export type SheetSpec = {
  name: string
  /** Ширина колонок в символах */
  widths: number[]
  rows: SheetRow[]
  /** Сколько верхних строк закрепить */
  freezeRows?: number
  /** Строка шапки (с 1) для автофильтра; фильтр охватывает её и всё, что ниже */
  filterRow?: number
  /** Последняя строка автофильтра (с 1), если ниже таблицы идут другие блоки */
  filterLastRow?: number
  /** Сколько колонок охватывает автофильтр; по умолчанию — все */
  filterCols?: number
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006'

/** Экранирует текст для XML и убирает управляющие символы, которые XML запрещает */
const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 1 → A, 27 → AA */
export function columnName(n: number): string {
  let s = ''
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Дата Excel — число дней от начала его отсчёта (25 569 дней до начала отсчёта Unix). Часовой пояс Excel не хранит, поэтому берём время как есть по UTC */
const excelSerial = (d: Date) => d.getTime() / 86_400_000 + 25_569

/** Названия листов: до 31 символа, без []:*?/\ */
const sheetName = (s: string) => s.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Лист'

class Styles {
  private fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>']
  private fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
  private numFmts: string[] = []
  private xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
  private byKey = new Map<string, number>([['{}', 0]])

  private index(list: string[], xml: string) {
    const i = list.indexOf(xml)
    return i >= 0 ? i : list.push(xml) - 1
  }

  id(style: CellStyle | undefined): number {
    if (!style) return 0
    const key = JSON.stringify(style, Object.keys(style).sort())
    const known = this.byKey.get(key)
    if (known !== undefined) return known

    const font =
      style.bold || style.color || style.size
        ? this.index(
            this.fonts,
            `<font>${style.bold ? '<b/>' : ''}<sz val="${style.size ?? 11}"/>${style.color ? `<color rgb="${style.color}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`,
          )
        : 0
    const fill = style.fill
      ? this.index(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${style.fill}"/><bgColor indexed="64"/></patternFill></fill>`)
      : 0
    const numFmt = style.numFmt ? 164 + this.index(this.numFmts, style.numFmt) : 0
    const align = style.wrap || style.valign ? `<alignment${style.valign ? ` vertical="${style.valign}"` : ''}${style.wrap ? ' wrapText="1"' : ''}/>` : ''
    const attrs = [
      `numFmtId="${numFmt}"`,
      `fontId="${font}"`,
      `fillId="${fill}"`,
      'borderId="0"',
      'xfId="0"',
      numFmt ? 'applyNumberFormat="1"' : '',
      font ? 'applyFont="1"' : '',
      fill ? 'applyFill="1"' : '',
      align ? 'applyAlignment="1"' : '',
    ].filter(Boolean)
    const id = this.xfs.push(align ? `<xf ${attrs.join(' ')}>${align}</xf>` : `<xf ${attrs.join(' ')}/>`) - 1
    this.byKey.set(key, id)
    return id
  }

  xml() {
    const numFmts = this.numFmts.length
      ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>`
      : ''
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}">${numFmts}` +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    )
  }
}

class SharedStrings {
  private list: string[] = []
  private ids = new Map<string, number>()
  count = 0

  id(s: string) {
    this.count++
    let i = this.ids.get(s)
    if (i === undefined) {
      i = this.list.push(s) - 1
      this.ids.set(s, i)
    }
    return i
  }

  xml() {
    const items = this.list.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="${this.count}" uniqueCount="${this.list.length}">${items}</sst>`
  }
}

function sheetXml(sheet: SheetSpec, styles: Styles, strings: SharedStrings) {
  const width = Math.max(sheet.widths.length, ...sheet.rows.map((r) => r.cells.length), 1)
  const rows = sheet.rows
    .map((row, ri) => {
      const r = ri + 1
      const cells = row.cells
        .map((value, ci) => {
          const ref = `${columnName(ci + 1)}${r}`
          const own = row.cellStyles?.[ci]
          const s = styles.id(row.style || own ? { ...row.style, ...own } : undefined)
          const sAttr = s ? ` s="${s}"` : ''
          if (value === null || value === undefined || value === '') return s ? `<c r="${ref}"${sAttr}/>` : ''
          if (value instanceof Date) {
            if (Number.isNaN(value.getTime())) return ''
            return `<c r="${ref}"${sAttr}><v>${excelSerial(value)}</v></c>`
          }
          if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"${sAttr}><v>${value}</v></c>` : ''
          if (typeof value === 'boolean') return `<c r="${ref}"${sAttr} t="b"><v>${value ? 1 : 0}</v></c>`
          return `<c r="${ref}"${sAttr} t="s"><v>${strings.id(value)}</v></c>`
        })
        .join('')
      const height = row.height ? ` ht="${row.height}" customHeight="1"` : ''
      return `<row r="${r}"${height}>${cells}</row>`
    })
    .join('')

  const freeze = sheet.freezeRows
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.freezeRows + 1}" sqref="A${sheet.freezeRows + 1}"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
  const cols = sheet.widths.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const last = Math.max(sheet.rows.length, 1)
  const filter = sheet.filterRow ? `<autoFilter ref="${filterRef(sheet, width)}"/>` : ''
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${REL}">` +
    `<dimension ref="A1:${columnName(width)}${last}"/>${freeze}<sheetFormatPr defaultRowHeight="15"/>${cols}` +
    `<sheetData>${rows}</sheetData>${filter}</worksheet>`
  )
}

const filterRef = (sheet: SheetSpec, width: number) =>
  `${columnName(1)}${sheet.filterRow}:${columnName(sheet.filterCols ?? width)}${Math.max(sheet.filterLastRow ?? sheet.rows.length, sheet.filterRow ?? 1)}`

/** Собирает книгу из листов и возвращает байты .xlsx */
export function writeXlsx(sheets: SheetSpec[], meta: { creator?: string } = {}): Buffer {
  const styles = new Styles()
  const strings = new SharedStrings()
  const names = sheets.map((s) => sheetName(s.name))
  const sheetFiles = sheets.map((s) => sheetXml(s, styles, strings))

  const width = (s: SheetSpec) => Math.max(s.widths.length, ...s.rows.map((r) => r.cells.length), 1)
  const quoted = (n: string) => `'${n.replace(/'/g, "''")}'`
  const absolute = (ref: string) => ref.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')
  const defined = sheets
    .map((s, i) =>
      s.filterRow
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(quoted(names[i]))}!${absolute(filterRef(s, width(s)))}</definedName>`
        : '',
    )
    .join('')

  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${PKG}/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>',
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
        `<Relationship Id="rId2" Type="${PKG}/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        '</Relationships>',
    ],
    [
      'docProps/core.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="${PKG}/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<dc:creator>${esc(meta.creator ?? '')}</dc:creator></cp:coreProperties>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>` +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        `</sheets>${defined ? `<definedNames>${defined}</definedNames>` : ''}</workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId${sheets.length + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
        '</Relationships>',
    ],
    ...sheetFiles.map((xml, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
    // Стили и строки собираются по ходу записи листов, поэтому идут последними
    ['xl/styles.xml', styles.xml()],
    ['xl/sharedStrings.xml', strings.xml()],
  ]
  return zip(files.map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })))
}

/** Zip без шифрования: deflate для каждого файла, имена в UTF-8 */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  // Время в zip — самое раннее, какое допускает формат: содержимое от времени выгрузки не зависит
  const dosTime = 0
  const dosDate = (0 << 9) | (1 << 5) | 1

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const packed = deflateRawSync(data, { level: 6 })
    const crc = crc32(data)

    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // имена в UTF-8
    head.writeUInt16LE(8, 8) // deflate
    head.writeUInt16LE(dosTime, 10)
    head.writeUInt16LE(dosDate, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBytes.length, 26)
    head.writeUInt16LE(0, 28)
    local.push(head, nameBytes, packed)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt16LE(dosTime, 12)
    dir.writeUInt16LE(dosDate, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBytes.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBytes)

    offset += head.length + nameBytes.length + packed.length
  }

  const dirSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dirSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

/** Архив больше допустимого: слишком много файлов или распаковка вышла бы за лимит («zip-бомба») */
export class ZipLimitError extends Error {}

/**
 * Читает файлы из zip: наши выгрузки в тестах и таблицы, которые HR загружает при импорте.
 * Загруженному файлу не верим: число файлов и объём после распаковки ограничены, распаковка
 * останавливается на лимите — архив в 5 МБ не раздуется в гигабайты памяти сервера
 */
export function unzip(file: Buffer, limits: { maxEntries?: number; maxTotal?: number } = {}): Map<string, Buffer> {
  const maxEntries = limits.maxEntries ?? 1000
  const maxTotal = limits.maxTotal ?? 64 * 1024 * 1024
  const out = new Map<string, Buffer>()
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('Не zip-файл')
  const count = file.readUInt16LE(end + 10)
  if (count > maxEntries) throw new ZipLimitError(`В архиве ${count} файлов — больше ${maxEntries}`)
  let total = 0
  let p = file.readUInt32LE(end + 16)
  for (let i = 0; i < count; i++) {
    const method = file.readUInt16LE(p + 10)
    const size = file.readUInt32LE(p + 20)
    const nameLen = file.readUInt16LE(p + 28)
    const extraLen = file.readUInt16LE(p + 30)
    const commentLen = file.readUInt16LE(p + 32)
    const at = file.readUInt32LE(p + 42)
    const name = file.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const start = at + 30 + file.readUInt16LE(at + 26) + file.readUInt16LE(at + 28)
    const raw = file.subarray(start, start + size)
    const left = maxTotal - total
    let data: Buffer
    if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, left) })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw new ZipLimitError(`После распаковки больше ${Math.round(maxTotal / 1048576)} МБ`)
        throw e
      }
    } else if (method === 0) data = Buffer.from(raw)
    else throw new Error(`Неизвестный способ сжатия: ${method}`)
    if (data.length > left) throw new ZipLimitError(`После распаковки больше ${Math.round(maxTotal / 1048576)} МБ`)
    total += data.length
    out.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** Собрать zip из готовых файлов — для тестов импорта */
export const zipFiles = (entries: { name: string; data: Buffer }[]) => zip(entries)
